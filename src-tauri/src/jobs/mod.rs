//! Background job system. Every long-running ffmpeg invocation flows through
//! here: queued into a lane (export=1, transcode=1, background=2, thumb=1
//! workers), progress parsed from `-progress pipe:1` and emitted as throttled
//! events, cancellation kills the process and removes partial output.

pub mod ffmpeg;
pub mod progress;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};

pub type JobId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Remux,
    Proxy,
    Waveform,
    Export,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// Seconds-long work: remuxes, waveforms.
    Background,
    /// Full re-encodes (proxies): minutes each on a slow CPU. Their own single
    /// worker, so a backlog of them — and they keep running after the editor
    /// that asked for them closes — never holds up a remux or a waveform
    /// queued behind it on `Background`.
    Transcode,
    Thumb,
    Export,
}

type Work = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
pub struct JobHandle {
    pub id: JobId,
    pub kind: JobKind,
    pub canceled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    /// partial output to delete when the job fails or is canceled
    output: Arc<Mutex<Option<PathBuf>>>,
}

impl JobHandle {
    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::Relaxed)
    }
    pub fn set_output(&self, path: PathBuf) {
        *self.output.lock().unwrap() = Some(path);
    }
    /// Stop treating the output as disposable.
    ///
    /// `fail_job` deletes whatever `set_output` last named, which is right while
    /// ffmpeg is still writing a partial file and catastrophic the moment it
    /// isn't: an export whose encode SUCCEEDED owns a complete video at that
    /// path, and a failure to publish it must not take the finished encode down
    /// with it. Call this as soon as the file stops being partial.
    pub fn clear_output(&self) {
        *self.output.lock().unwrap() = None;
    }
    fn attach_child(&self, child: Child) {
        *self.child.lock().unwrap() = Some(child);
    }
    fn take_child(&self) -> Option<Child> {
        self.child.lock().unwrap().take()
    }
    fn cleanup_output(&self) {
        if let Some(path) = self.output.lock().unwrap().take() {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

pub struct Jobs {
    next_id: AtomicU64,
    registry: Arc<Mutex<HashMap<JobId, JobHandle>>>,
    background_tx: mpsc::Sender<Work>,
    transcode_tx: mpsc::Sender<Work>,
    thumb_tx: mpsc::Sender<Work>,
    export_tx: mpsc::Sender<Work>,
}

fn spawn_workers(count: usize, name: &str) -> mpsc::Sender<Work> {
    let (tx, rx) = mpsc::channel::<Work>();
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..count {
        let rx = Arc::clone(&rx);
        std::thread::Builder::new()
            .name(format!("jobs-{name}-{i}"))
            .spawn(move || loop {
                let work = rx.lock().unwrap().recv();
                match work {
                    Ok(work) => work(),
                    Err(_) => break,
                }
            })
            .expect("failed to spawn job worker");
    }
    tx
}

impl Default for Jobs {
    fn default() -> Self {
        Jobs {
            next_id: AtomicU64::new(1),
            registry: Arc::new(Mutex::new(HashMap::new())),
            background_tx: spawn_workers(2, "bg"),
            transcode_tx: spawn_workers(1, "transcode"),
            thumb_tx: spawn_workers(1, "thumb"),
            export_tx: spawn_workers(1, "export"),
        }
    }
}

impl Jobs {
    pub fn allocate(&self, kind: JobKind) -> JobHandle {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let handle = JobHandle {
            id,
            kind,
            canceled: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            output: Arc::new(Mutex::new(None)),
        };
        self.registry.lock().unwrap().insert(id, handle.clone());
        handle
    }

    pub fn submit(&self, lane: Lane, work: Work) {
        let tx = match lane {
            Lane::Background => &self.background_tx,
            Lane::Transcode => &self.transcode_tx,
            Lane::Thumb => &self.thumb_tx,
            Lane::Export => &self.export_tx,
        };
        // Workers live for the app's lifetime; send only fails at shutdown.
        let _ = tx.send(work);
    }

    pub fn cancel(&self, id: JobId) -> bool {
        let handle = self.registry.lock().unwrap().get(&id).cloned();
        match handle {
            Some(h) => {
                h.canceled.store(true, Ordering::Relaxed);
                if let Some(mut child) = h.take_child() {
                    let _ = child.kill();
                }
                true
            }
            None => false,
        }
    }

    pub fn finish(&self, id: JobId) {
        self.registry.lock().unwrap().remove(&id);
    }

    /// True while `id` is registered AND has been told to stop.
    ///
    /// A canceled job stays registered until its worker reaches `fail_job`,
    /// which for a QUEUED one can be long after the cancel — it has to wait for
    /// a lane to dequeue it first. That window is where the preparation
    /// registry used to hand the dead id to the next request for the same
    /// file, which then waited on a job that could only ever fail. Unknown and
    /// finished ids are `false`: nothing is left to stop, and a finished job
    /// has already released anything it held.
    pub fn is_canceled(&self, id: JobId) -> bool {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .is_some_and(JobHandle::is_canceled)
    }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: JobId,
    pub kind: JobKind,
    /// 0..1 when the total duration is known
    pub ratio: Option<f64>,
    pub out_time_ms: u64,
    pub fps: f64,
    pub speed: f64,
    pub eta_sec: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    pub id: JobId,
    pub kind: JobKind,
    pub output: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FailedEvent {
    pub id: JobId,
    pub kind: JobKind,
    pub canceled: bool,
    pub message: String,
    pub log_tail: Vec<String>,
}

pub fn emit_progress(app: &AppHandle, ev: &ProgressEvent) {
    let _ = app.emit("job:progress", ev);
}

/// Emit done + unregister. Terminal.
pub fn complete_job(app: &AppHandle, jobs: &Jobs, handle: &JobHandle, output: serde_json::Value) {
    let _ = app.emit(
        "job:done",
        DoneEvent {
            id: handle.id,
            kind: handle.kind,
            output,
        },
    );
    jobs.finish(handle.id);
}

/// Delete partial output, emit failed + unregister. Terminal.
pub fn fail_job(
    app: &AppHandle,
    jobs: &Jobs,
    handle: &JobHandle,
    message: String,
    log_tail: Vec<String>,
) {
    handle.cleanup_output();
    let _ = app.emit(
        "job:failed",
        FailedEvent {
            id: handle.id,
            kind: handle.kind,
            canceled: handle.is_canceled(),
            message,
            log_tail,
        },
    );
    jobs.finish(handle.id);
}

/* ------------------------------------------------------------------ */
/* ffmpeg execution with progress                                      */
/* ------------------------------------------------------------------ */

const STDERR_TAIL: usize = 50;

#[derive(Debug)]
pub struct JobFailure {
    pub message: String,
    pub log_tail: Vec<String>,
}

impl JobFailure {
    fn new(message: impl Into<String>) -> Self {
        JobFailure {
            message: message.into(),
            log_tail: Vec::new(),
        }
    }
}

/// `BELOW_NORMAL_PRIORITY_CLASS`: see `job_command`.
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

/// The ffmpeg a job runs: `args`, stdout/stderr piped for the progress parser
/// and the log tail, run in `cwd` when one is given (a relative name in
/// `args` — a drawtext `textfile=` — then resolves there).
///
/// Below normal priority, and only here: exports, proxies and remuxes are
/// long and nobody is waiting on any single frame of them, while the window
/// beside them is — on a two- or four-core PC an encode at normal priority
/// competes on equal terms with the renderer, and playback and the progress
/// bar stutter. The thumbnail, waveform, normalize and encoder-probe children
/// keep `ffmpeg::command`'s normal priority: someone is waiting on each.
fn job_command(args: &[OsString], cwd: Option<&Path>) -> Result<Command> {
    let mut cmd = ffmpeg::command("ffmpeg")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `creation_flags` replaces, so the no-console flag is restated.
        cmd.creation_flags(ffmpeg::CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    Ok(cmd)
}

/// Run ffmpeg on the CURRENT thread (call from a lane worker), streaming
/// throttled progress events. The caller finishes the job afterwards with
/// `complete_job` / `fail_job`. `handle.set_output` should point at the file
/// ffmpeg writes so cancellation can clean it up. `cwd` is the folder ffmpeg
/// runs in (`None`: the app's own).
pub fn execute_ffmpeg(
    app: &AppHandle,
    handle: &JobHandle,
    args: Vec<OsString>,
    total_secs: Option<f64>,
    cwd: Option<&Path>,
) -> std::result::Result<(), JobFailure> {
    if handle.is_canceled() {
        return Err(JobFailure::new("canceled"));
    }

    let mut cmd = job_command(&args, cwd).map_err(|e| JobFailure::new(e.to_string()))?;
    let mut child = ffmpeg::spawn_owned(&mut cmd)
        .map_err(|e| JobFailure::new(format!("failed to start ffmpeg: {e}")))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    handle.attach_child(child);

    // Re-check: a cancel landing between the check above and this attach found
    // no child to kill, so ffmpeg ran the whole export at 100% CPU with no way
    // to stop it. Now that the child is reachable, honor that cancel.
    if handle.is_canceled() {
        if let Some(mut c) = handle.take_child() {
            let _ = c.kill();
        }
        return Err(JobFailure::new("canceled"));
    }

    // stderr tail collector. `thread::Builder`, not the plain spawn: that one
    // panics when the OS refuses a thread, and under `panic = "abort"` a
    // refused thread would end the app instead of failing one job.
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail_writer = Arc::clone(&tail);
    let reader = std::thread::Builder::new()
        .name("ffmpeg-stderr".into())
        .spawn(move || {
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                    let mut t = tail_writer.lock().unwrap();
                    if t.len() >= STDERR_TAIL {
                        t.remove(0);
                    }
                    t.push(line);
                }
            }
        });
    let stderr_thread = match reader {
        Ok(t) => t,
        Err(_) => {
            // Nobody would read its stderr, so ffmpeg would block on a full
            // pipe; stop it rather than leave it hanging on the lane.
            if let Some(mut c) = handle.take_child() {
                let _ = c.kill();
                let _ = c.wait();
            }
            return Err(JobFailure::new("could not start a worker thread"));
        }
    };

    // stdout progress parser (this thread)
    if let Some(stdout) = stdout {
        let mut state = progress::Progress::default();
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let started = Instant::now();
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            if progress::parse_line(&line, &mut state) {
                let now = Instant::now();
                if now.duration_since(last_emit) >= Duration::from_millis(100) || state.end {
                    last_emit = now;
                    let out_secs = state.out_time_us.unwrap_or(0) as f64 / 1_000_000.0;
                    let ratio = total_secs
                        .filter(|t| *t > 0.0)
                        .map(|t| (out_secs / t).clamp(0.0, 1.0));
                    let eta = match (ratio, state.speed) {
                        (Some(_), Some(s)) if s > 0.01 => {
                            total_secs.map(|t| ((t - out_secs) / s).max(0.0))
                        }
                        (Some(r), None) if r > 0.02 => {
                            let elapsed = started.elapsed().as_secs_f64();
                            Some((elapsed / r - elapsed).max(0.0))
                        }
                        _ => None,
                    };
                    emit_progress(
                        app,
                        &ProgressEvent {
                            id: handle.id,
                            kind: handle.kind,
                            ratio,
                            out_time_ms: (out_secs * 1000.0) as u64,
                            fps: state.fps.unwrap_or(0.0),
                            speed: state.speed.unwrap_or(0.0),
                            eta_sec: eta,
                        },
                    );
                }
            }
        }
    }

    let status = match handle.take_child() {
        Some(mut child) => child
            .wait()
            .map_err(|e| JobFailure::new(format!("wait failed: {e}")))?,
        // cancel() raced us and killed/took the child
        None => {
            let _ = stderr_thread.join();
            return Err(JobFailure::new("canceled"));
        }
    };
    let _ = stderr_thread.join();

    if handle.is_canceled() {
        return Err(JobFailure::new("canceled"));
    }
    if !status.success() {
        let log_tail = tail.lock().unwrap().clone();
        return Err(JobFailure {
            message: format!("ffmpeg exited with {status}"),
            log_tail,
        });
    }
    Ok(())
}

/// How long `run_blocking_on_lane` waits for work once it has STARTED.
const LANE_RESULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Run quick, bounded work on a lane and wait for its result (used for
/// thumbnails where the caller needs the path synchronously).
///
/// The timeout counts from the moment a worker picks the work up, not from
/// the submit: on a one-worker lane every request queued behind others used
/// to have their run time charged to its own deadline, so one slow file made
/// the whole queue behind it time out. The wait for a worker is unbounded;
/// what bounds it is that every piece of work on the lane is bounded itself.
///
/// `work` receives `abandoned`, set when the caller has given up on it. The
/// work is then still running (or about to start its expensive part), and
/// nobody will read its result: check the flag before each costly step —
/// above all before starting ffmpeg — and return early when it is set.
pub fn run_blocking_on_lane<T: Send + 'static>(
    jobs: &Jobs,
    lane: Lane,
    work: impl FnOnce(Arc<AtomicBool>) -> Result<T> + Send + 'static,
) -> Result<T> {
    run_blocking_on_lane_within(jobs, lane, LANE_RESULT_TIMEOUT, work)
}

/// `run_blocking_on_lane` with the timeout as a parameter, so a test can
/// exercise both outcomes in milliseconds.
fn run_blocking_on_lane_within<T: Send + 'static>(
    jobs: &Jobs,
    lane: Lane,
    timeout: Duration,
    work: impl FnOnce(Arc<AtomicBool>) -> Result<T> + Send + 'static,
) -> Result<T> {
    let abandoned = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&abandoned);
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (tx, rx) = mpsc::channel();
    jobs.submit(
        lane,
        Box::new(move || {
            let _ = started_tx.send(());
            let _ = tx.send(work(flag));
        }),
    );
    // Both senders live in the boxed work, so a lane that drops it unrun (only
    // at shutdown) ends both waits with an error instead of hanging them.
    started_rx
        .recv()
        .map_err(|_| AppError::Ffmpeg("job was dropped before it started".into()))?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            abandoned.store(true, Ordering::Relaxed);
            Err(AppError::Ffmpeg("job timed out".into()))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AppError::Ffmpeg("job stopped without a result".into()))
        }
    }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn cancel_job(jobs: tauri::State<'_, Arc<Jobs>>, id: JobId) -> bool {
    jobs.cancel(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cleanup_output` is the failure path's eraser, and `clear_output` is the
    /// only thing standing between it and a finished export. Both halves are
    /// pinned here: a genuinely partial file still gets cleaned up, and a file
    /// that has been released no longer does.
    #[test]
    fn clearing_the_output_target_spares_a_finished_file() {
        let jobs = Jobs::default();
        let dir = std::env::temp_dir().join(format!(
            "taroting-jobs-cleanup-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // ffmpeg died mid-write: the partial output is garbage and must go.
        let partial = dir.join("aborted.mp4.part");
        std::fs::write(&partial, b"half an encode").unwrap();
        let handle = jobs.allocate(JobKind::Export);
        handle.set_output(partial.clone());
        handle.cleanup_output();
        assert!(!partial.exists(), "a partial output must still be cleaned up");

        // ffmpeg finished and only the publish failed: the file is the user's
        // completed video, so the same failure path must leave it alone.
        let finished = dir.join("finished.mp4.part");
        std::fs::write(&finished, b"a complete encode").unwrap();
        let handle = jobs.allocate(JobKind::Export);
        handle.set_output(finished.clone());
        handle.clear_output();
        handle.cleanup_output();
        assert!(
            finished.exists(),
            "a completed encode must survive the failure path"
        );
        assert_eq!(std::fs::read(&finished).unwrap(), b"a complete encode");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Canceled means "registered and told to stop": a live job is not, and
    /// once a canceled job finishes it is unknown again — nothing left to stop.
    #[test]
    fn is_canceled_tracks_the_registry() {
        let jobs = Jobs::default();
        let live = jobs.allocate(JobKind::Proxy);
        let doomed = jobs.allocate(JobKind::Waveform);
        assert!(!jobs.is_canceled(live.id));
        assert!(!jobs.is_canceled(9_999), "an id never allocated");

        assert!(jobs.cancel(doomed.id));
        assert!(jobs.is_canceled(doomed.id));
        assert!(!jobs.is_canceled(live.id), "cancel is per job");

        jobs.finish(doomed.id);
        assert!(!jobs.is_canceled(doomed.id), "a finished job is unknown");
    }

    /// A job canceled while QUEUED is replaced at once, and only later
    /// dequeued — where `execute_ffmpeg` bails on the cancel and `fail_job`
    /// deletes the job's output. Both jobs prepare into the SAME cache file,
    /// so their partial names come from `job_tmp_suffix`; with one shared
    /// `.tmp` the dead job's cleanup erased the successor's half-written file.
    #[test]
    fn canceled_queued_job_does_not_delete_the_successors_tmp() {
        use crate::media::playability::job_tmp_suffix;
        let jobs = Jobs::default();
        let dir = std::env::temp_dir().join(format!(
            "taroting-jobs-tmp-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tmp_for = |h: &JobHandle| dir.join(format!("0123456789abcdef{}", job_tmp_suffix(".mp4", h.id)));

        let dead = jobs.allocate(JobKind::Remux);
        let successor = jobs.allocate(JobKind::Remux);
        dead.set_output(tmp_for(&dead));
        successor.set_output(tmp_for(&successor));
        std::fs::write(tmp_for(&successor), b"successor, half written").unwrap();

        jobs.cancel(dead.id);
        dead.cleanup_output();
        assert_eq!(
            std::fs::read(tmp_for(&successor)).unwrap(),
            b"successor, half written",
            "the canceled job must delete only its own partial file"
        );

        // The dead job's own partial file still goes when it had one.
        std::fs::write(tmp_for(&dead), b"dead").unwrap();
        dead.set_output(tmp_for(&dead));
        dead.cleanup_output();
        assert!(!tmp_for(&dead).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two transcodes waiting on the test: the lane's ONE worker runs the first
    /// and holds the second back, and a Background job still completes while
    /// both wait. Routed onto Background's two workers instead, the pair would
    /// occupy both, the second would start at once, and the Background job
    /// would wait behind them — which is why this takes two, not one.
    #[test]
    fn a_transcode_backlog_never_holds_up_background_work() {
        use std::sync::RwLock;
        let jobs = Jobs::default();
        let gate = Arc::new(RwLock::new(()));
        let hold = gate.write().unwrap();
        let (started_tx, started_rx) = mpsc::channel::<u32>();
        for n in 0..2u32 {
            let gate = Arc::clone(&gate);
            let started = started_tx.clone();
            jobs.submit(
                Lane::Transcode,
                Box::new(move || {
                    let _ = started.send(n);
                    // Blocks until the test lets go of the write lock.
                    drop(gate.read());
                }),
            );
        }
        let first = started_rx.recv_timeout(Duration::from_secs(5));
        let second_early = started_rx.recv_timeout(Duration::from_millis(300));
        let (bg_tx, bg_rx) = mpsc::channel();
        jobs.submit(Lane::Background, Box::new(move || {
            let _ = bg_tx.send(());
        }));
        let background = bg_rx.recv_timeout(Duration::from_secs(5));
        drop(hold);

        assert_eq!(first, Ok(0));
        assert!(second_early.is_err(), "Transcode must have exactly one worker");
        assert!(background.is_ok(), "a Background job must not wait behind transcodes");
        assert_eq!(started_rx.recv_timeout(Duration::from_secs(5)), Ok(1));
    }

    /// The lane's timeout starts when a worker picks the work up. Queued
    /// behind 700 ms of other work, a 50 ms job under a 300 ms timeout
    /// succeeds; counted from the submit it timed out before it even began.
    /// And work nobody gave up on never sees `abandoned`.
    #[test]
    fn the_lane_timeout_starts_when_the_work_does() {
        let jobs = Jobs::default();
        jobs.submit(Lane::Thumb, Box::new(|| std::thread::sleep(Duration::from_millis(700))));
        let result = run_blocking_on_lane_within(&jobs, Lane::Thumb, Duration::from_millis(300), |abandoned| {
            std::thread::sleep(Duration::from_millis(50));
            Ok(abandoned.load(Ordering::Relaxed))
        });
        assert!(matches!(result, Ok(false)), "{result:?}");
    }

    /// Work that overruns the timeout: the caller gets "timed out", and the
    /// work — still running, its result now unwanted — finds `abandoned` set
    /// the next time it looks, which is its cue to skip the ffmpeg it was
    /// about to start.
    #[test]
    fn an_overrun_is_abandoned_and_the_work_can_tell() {
        let jobs = Jobs::default();
        let (seen_tx, seen_rx) = mpsc::channel();
        let result: Result<()> = run_blocking_on_lane_within(&jobs, Lane::Thumb, Duration::from_millis(100), move |abandoned| {
            std::thread::sleep(Duration::from_millis(400));
            let _ = seen_tx.send(abandoned.load(Ordering::Relaxed));
            Ok(())
        });
        assert!(matches!(&result, Err(AppError::Ffmpeg(m)) if m.contains("timed out")), "{result:?}");
        assert_eq!(seen_rx.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    /// A job's ffmpeg runs below normal priority, in the folder it was given:
    /// a RELATIVE input that exists only there decodes. A child of a
    /// below-normal parent is below normal by inheritance — as it is whenever
    /// this suite itself runs at low priority — which would hide a missing
    /// flag, so the spawn happens with this process at normal priority,
    /// restored straight after.
    #[cfg(windows)]
    #[test]
    fn a_job_runs_below_normal_priority_in_the_folder_it_is_given() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, GetPriorityClass, SetPriorityClass,
            BELOW_NORMAL_PRIORITY_CLASS as OS_BELOW_NORMAL, NORMAL_PRIORITY_CLASS,
        };

        let dir = std::env::temp_dir().join(format!(
            "taroting jobs cwd-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tone = dir.join("tone.wav");
        let made = ffmpeg::run(
            "ffmpeg",
            &["-y", "-f", "lavfi", "-i", "sine=duration=1", tone.to_str().unwrap()],
        )
        .unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));

        let args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-re", "-i", "tone.wav", "-f", "null", "-"]
            .iter()
            .map(OsString::from)
            .collect();
        let mut cmd = job_command(&args, Some(&dir)).unwrap();
        // SAFETY: the pseudo-handle of this process; plain FFI.
        let me = unsafe { GetCurrentProcess() };
        let was = unsafe { GetPriorityClass(me) };
        unsafe { SetPriorityClass(me, NORMAL_PRIORITY_CLASS) };
        let spawned = ffmpeg::spawn_owned(&mut cmd);
        unsafe { SetPriorityClass(me, was) };
        let child = spawned.unwrap();
        // SAFETY: the live child's own handle, borrowed for the call.
        let class = unsafe { GetPriorityClass(child.as_raw_handle()) };
        let out = child.wait_with_output().unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(class, OS_BELOW_NORMAL, "a job's ffmpeg must run below normal priority");
        assert!(
            out.status.success(),
            "the relative input must resolve in the given folder: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The plain thread spawn panics when the OS refuses a thread, and under
    /// `panic = "abort"` that ends the app. Every thread the sidecar helpers
    /// start goes through `thread::Builder`, whose refusal is an error the
    /// caller handles; pinned over the code before each test module.
    #[test]
    fn no_sidecar_helper_can_abort_on_a_refused_thread() {
        for (file, code) in [("jobs/mod.rs", include_str!("mod.rs")), ("jobs/ffmpeg.rs", include_str!("ffmpeg.rs"))] {
            let production: String = code.split("#[cfg(test)]").next().unwrap().split_whitespace().collect();
            assert!(!production.contains("thread::spawn("), "{file} starts a thread that can panic");
            assert!(production.contains("thread::Builder::new()"), "{file}: the pin no longer sees its threads");
        }
    }
}
