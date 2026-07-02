//! Background job system. Every long-running ffmpeg invocation flows through
//! here: queued into a lane (export=1, background=2, thumb=1 workers),
//! progress parsed from `-progress pipe:1` and emitted as throttled events,
//! cancellation kills the process and removes partial output.

pub mod ffmpeg;
pub mod progress;

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
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
    Filmstrip,
    Thumbnail,
    Scan,
    Export,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Background,
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

/// Run ffmpeg on the CURRENT thread (call from a lane worker), streaming
/// throttled progress events. The caller finishes the job afterwards with
/// `complete_job` / `fail_job`. `handle.set_output` should point at the file
/// ffmpeg writes so cancellation can clean it up.
pub fn execute_ffmpeg(
    app: &AppHandle,
    handle: &JobHandle,
    args: Vec<std::ffi::OsString>,
    total_secs: Option<f64>,
) -> std::result::Result<(), JobFailure> {
    if handle.is_canceled() {
        return Err(JobFailure::new("canceled"));
    }

    let mut cmd = ffmpeg::command("ffmpeg").map_err(|e| JobFailure::new(e.to_string()))?;
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| JobFailure::new(format!("failed to start ffmpeg: {e}")))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    handle.attach_child(child);

    // stderr tail collector
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail_writer = Arc::clone(&tail);
    let stderr_thread = std::thread::spawn(move || {
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

/// Run quick, bounded work on a lane and wait for its result (used for
/// thumbnails where the caller needs the path synchronously).
pub fn run_blocking_on_lane<T: Send + 'static>(
    jobs: &Jobs,
    lane: Lane,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (tx, rx) = mpsc::channel();
    jobs.submit(
        lane,
        Box::new(move || {
            let _ = tx.send(work());
        }),
    );
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| AppError::Ffmpeg("job timed out".into()))?
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn cancel_job(jobs: tauri::State<'_, Arc<Jobs>>, id: JobId) -> bool {
    jobs.cancel(id)
}
