//! Locating and spawning the bundled ffmpeg/ffprobe sidecars.
//!
//! Every sidecar child starts through [`spawn_owned`] (directly, or through
//! [`output_owned`], [`run`] and [`run_with_deadline`], which are built on it).
//! That is what makes a child end with the app: see `spawn_owned`.

use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{AppError, Result};

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const HOST_TRIPLE: &str = "x86_64-pc-windows-msvc";

/// Resolve a sidecar binary. In dev builds they live in `src-tauri/binaries/`
/// with a target-triple suffix (Tauri's externalBin convention); in release
/// bundles Tauri places them next to the app exe under their plain name.
pub fn sidecar_path(name: &str) -> Result<PathBuf> {
    if cfg!(debug_assertions) {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{name}-{HOST_TRIPLE}.exe"));
        if p.is_file() {
            Ok(p)
        } else {
            Err(AppError::Ffmpeg(format!(
                "{name} sidecar missing at {} — run `npm run fetch-ffmpeg`",
                p.display()
            )))
        }
    } else {
        let exe = std::env::current_exe()?;
        let dir = exe
            .parent()
            .ok_or_else(|| AppError::Ffmpeg("cannot resolve app directory".into()))?;
        Ok(dir.join(format!("{name}.exe")))
    }
}

/// A Command for a sidecar, configured to never flash a console window.
pub fn command(name: &str) -> Result<Command> {
    let mut cmd = Command::new(sidecar_path(name)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Start `cmd` with the child's life tied to the app's.
///
/// The child joins one job object shared by every sidecar, created on the
/// first spawn and never closed. The app holds the job's only handle, so the
/// handle closes when the app process ends in ANY way — the window closing,
/// `process::exit`, a `panic = "abort"`, a native fault, Task Manager — and
/// the job's kill-on-close limit then ends every child still in it. Before
/// this, a proxy or an export kept encoding at full CPU after the window was
/// gone, holding its source open and finishing into a partial file that
/// nothing would ever rename.
///
/// The app process itself is never put in the job, and only sidecars come
/// here: the uninstaller `os.rs` starts must outlive the app by design.
///
/// Joining can fail (a job that could not be created, a process the OS will
/// not nest); the child then runs exactly as it did before the job existed,
/// which beats refusing the work.
pub fn spawn_owned(cmd: &mut Command) -> io::Result<Child> {
    let child = cmd.spawn()?;
    #[cfg(windows)]
    job::assign(&child);
    Ok(child)
}

/// `Command::output`, through [`spawn_owned`]: stdin from nowhere, stdout and
/// stderr captured. Those three are SET here (std offers no way to ask what a
/// caller chose), so any stdio already configured on `cmd` is replaced.
///
/// No deadline: a child that never exits blocks the caller forever. Anything
/// that can meet a hung or hostile input belongs on [`run_with_deadline`].
pub fn output_owned(cmd: &mut Command) -> io::Result<Output> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    spawn_owned(cmd)?.wait_with_output()
}

/// Run a sidecar to completion, capturing output. For quick, bounded work
/// (probing, version checks) — long-running jobs go through the job system.
pub fn run(name: &str, args: &[&str]) -> Result<Output> {
    let mut cmd = command(name)?;
    cmd.args(args);
    Ok(output_owned(&mut cmd)?)
}

/// A deadline longer than this is this. It only keeps `Instant + Duration`
/// from overflowing (a panic, so an abort in release) on an absurd value.
const MAX_DEADLINE: Duration = Duration::from_secs(24 * 3600);

/// How often a platform without a wait-with-timeout checks on the child.
#[cfg(not(windows))]
const POLL: Duration = Duration::from_millis(50);

/// [`output_owned`] with a deadline: `Ok(None)` when the child was still
/// running `deadline` after it started — it has then been killed and reaped.
/// Callers treat `None` as "the probe failed".
///
/// The clock starts at the spawn, not when the caller decided to run it, so
/// time spent queued behind other work never eats into it.
///
/// Both pipes are drained on their own threads while this one waits. Waiting
/// with full pipes and nobody reading deadlocks: a child that writes more
/// than the pipe holds (ffprobe's JSON, `ffmpeg -version`, a long stderr)
/// blocks on the write and never exits, and the deadline would kill a probe
/// that was merely talkative.
///
/// The wait itself is the OS's (`WaitForSingleObject` on the process with the
/// time left), so a child that finishes is noticed at once — a 50 ms probe
/// costs 50 ms, not a poll interval on top. Other platforms poll `try_wait`.
// The probes, thumbnails and the export's encoder checks move onto it in
// this same release; until they do, only the tests call it. Drop the allow
// then.
#[allow(dead_code)]
pub fn run_with_deadline(mut cmd: Command, deadline: Duration) -> io::Result<Option<Output>> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn_owned(&mut cmd)?;
    let until = Instant::now() + deadline.min(MAX_DEADLINE);

    let stdout = match drain(child.stdout.take(), "sidecar-stdout") {
        Ok(d) => d,
        Err(e) => {
            stop(&mut child);
            return Err(e);
        }
    };
    let stderr = match drain(child.stderr.take(), "sidecar-stderr") {
        Ok(d) => d,
        Err(e) => {
            // The stdout reader ends once the child is gone and its pipe closes.
            stop(&mut child);
            collect(stdout);
            return Err(e);
        }
    };
    let status = wait_until(&mut child, until);
    if status.is_err() {
        stop(&mut child);
    }
    // Both readers finish now: the child has exited or been killed, so its
    // ends of the pipes are closed.
    let (stdout, stderr) = (collect(stdout), collect(stderr));
    Ok(status?.map(|status| Output { status, stdout, stderr }))
}

/// A pipe being read to the end on its own thread (`None`: there was no pipe).
type Drain = Option<JoinHandle<Vec<u8>>>;

/// Start reading `pipe` to its end on a named thread. A thread the OS refuses
/// is an error for the caller to handle — `thread::Builder`, because the
/// plain spawn panics on that refusal, and a panic aborts the app.
fn drain<R: Read + Send + 'static>(pipe: Option<R>, name: &str) -> io::Result<Drain> {
    let Some(mut pipe) = pipe else {
        return Ok(None);
    };
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
        .map(Some)
}

fn collect(d: Drain) -> Vec<u8> {
    d.and_then(|h| h.join().ok()).unwrap_or_default()
}

/// Kill and reap. Both results are ignored: the child may already be gone.
fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The child's exit status, or `None` once `until` has passed — the child is
/// then stopped before this returns.
#[cfg(windows)]
fn wait_until(child: &mut Child, until: Instant) -> io::Result<Option<ExitStatus>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    loop {
        let left = until.saturating_duration_since(Instant::now());
        // Rounded UP to whole milliseconds, so a sub-millisecond remainder is
        // still waited out rather than spun on; MAX_DEADLINE keeps it far
        // below INFINITE (u32::MAX).
        let ms = u32::try_from(left.as_nanos().div_ceil(1_000_000)).unwrap_or(u32::MAX - 1);
        // SAFETY: the handle is the live child's own, borrowed for this call.
        match unsafe { WaitForSingleObject(child.as_raw_handle(), ms) } {
            WAIT_OBJECT_0 => return child.wait().map(Some),
            // A timed wait may wake a clock tick early; only a deadline that
            // has really passed kills.
            WAIT_TIMEOUT if Instant::now() < until => continue,
            WAIT_TIMEOUT => {
                stop(child);
                return Ok(None);
            }
            _ => return Err(io::Error::last_os_error()),
        }
    }
}

#[cfg(not(windows))]
fn wait_until(child: &mut Child, until: Instant) -> io::Result<Option<ExitStatus>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let now = Instant::now();
        if now >= until {
            stop(child);
            return Ok(None);
        }
        std::thread::sleep((until - now).min(POLL));
    }
}

/// The job object every sidecar child joins (see [`spawn_owned`]).
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The shared job's handle, as an address (a raw pointer cannot sit in a
    /// static); 0 when it could not be created. Decided once, on the first
    /// sidecar spawn, and never closed: closing it is the app ending.
    static JOB: OnceLock<usize> = OnceLock::new();

    /// A new job that ends every process in it when its last handle closes.
    ///
    /// Null security attributes make the handle NOT inheritable, and that is
    /// load-bearing: std starts children with handle inheritance on (it is how
    /// their pipes reach them), so an inheritable job handle would be copied
    /// into every ffmpeg — and the job would then close only when the last of
    /// THEM exited, which is never while one of them is the orphan.
    pub(super) fn new_kill_on_close_job() -> Option<HANDLE> {
        // SAFETY: plain FFI; both pointers may be null by contract.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        // SAFETY: an all-zero limit struct is valid ("no limits").
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is the struct this information class names, and lives
        // for the call.
        let set = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            // A job without the limit would only hold children, never end them.
            // SAFETY: our own handle, closed once.
            unsafe { CloseHandle(job) };
            return None;
        }
        Some(job)
    }

    /// The shared job, created on first use.
    pub(super) fn owned_job() -> Option<HANDLE> {
        let addr = *JOB.get_or_init(|| new_kill_on_close_job().map_or(0, |h| h as usize));
        (addr != 0).then_some(addr as HANDLE)
    }

    /// Put `child` in the shared job. A failure leaves it running unowned.
    pub(super) fn assign(child: &Child) {
        if let Some(job) = owned_job() {
            // SAFETY: both handles are live: the job is never closed, and the
            // child's handle is borrowed from `child` for the call.
            unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawns_ffmpeg_sidecar() {
        let out = run("ffmpeg", &["-version"]).expect("ffmpeg must spawn");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("ffmpeg version"), "unexpected: {stdout}");
    }

    #[test]
    fn spawns_ffprobe_sidecar() {
        let out = run("ffprobe", &["-version"]).expect("ffprobe must spawn");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("ffprobe version"), "unexpected: {stdout}");
    }

    fn ffmpeg(args: &[&str]) -> Command {
        let mut cmd = command("ffmpeg").unwrap();
        cmd.args(args);
        cmd
    }

    /// A child that writes far more than a pipe holds on BOTH streams and then
    /// exits must come back whole, well inside its deadline. Waiting without
    /// reading would leave it blocked on a full pipe until the deadline killed
    /// it: `None`, after 30 s. 10 s of 48 kHz mono s16 is exactly 960,000
    /// bytes of stdout; `ashowinfo` writes a line per audio frame to stderr.
    #[test]
    fn run_with_deadline_drains_a_child_that_outgrows_its_pipes() {
        let cmd = ffmpeg(&[
            "-hide_banner",
            "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=48000:duration=10",
            "-af", "ashowinfo",
            "-ac", "1",
            "-f", "s16le",
            "-",
        ]);
        let started = Instant::now();
        let out = run_with_deadline(cmd, Duration::from_secs(30))
            .expect("ffmpeg starts")
            .expect("a child that exits on its own is not killed");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(out.stdout.len(), 960_000);
        assert!(out.stderr.len() > 64 * 1024, "stderr was only {} bytes", out.stderr.len());
        assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    }

    /// A child still running at its deadline — one that has already written
    /// more than a pipe holds, then keeps going at real time for a minute — is
    /// killed and reaped, and the caller is back just after the deadline.
    #[test]
    fn run_with_deadline_kills_a_child_still_running_at_the_deadline() {
        let cmd = ffmpeg(&[
            "-hide_banner",
            "-loglevel", "error",
            "-re",
            "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=48000:duration=60",
            "-ac", "1",
            "-f", "s16le",
            "-",
        ]);
        let deadline = Duration::from_millis(1500);
        let started = Instant::now();
        let out = run_with_deadline(cmd, deadline).expect("ffmpeg starts");
        let took = started.elapsed();
        assert!(out.is_none(), "a child running past its deadline must be killed");
        assert!(took >= deadline, "returned before the deadline: {took:?}");
        assert!(took < deadline + Duration::from_secs(5), "returned long after the deadline: {took:?}");
    }

    /// A deadline of zero still runs the child (the clock starts at the spawn)
    /// and an absurd one does not overflow the clock.
    #[test]
    fn run_with_deadline_survives_extreme_deadlines() {
        let out = run_with_deadline(ffmpeg(&["-version"]), Duration::MAX)
            .unwrap()
            .expect("finishes long before a day");
        assert!(String::from_utf8_lossy(&out.stdout).contains("ffmpeg version"));
        // Zero: either it finished inside the first wait or it was killed;
        // both are answers, neither may hang or panic.
        let _ = run_with_deadline(ffmpeg(&["-version"]), Duration::ZERO).unwrap();
    }

    /// The job every sidecar joins: a child started through `spawn_owned` is
    /// in it, the job ends its processes when its handle closes, and that
    /// handle is not inheritable (an inherited copy in each ffmpeg would keep
    /// the job open for as long as any of them ran).
    #[cfg(windows)]
    #[test]
    fn a_sidecar_joins_the_kill_on_close_job() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::System::JobObjects::{
            IsProcessInJob, JobObjectExtendedLimitInformation, QueryInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let mut child = spawn_owned(&mut ffmpeg(&[
            "-hide_banner", "-loglevel", "error", "-re",
            "-f", "lavfi", "-i", "sine=duration=30", "-f", "null", "-",
        ]))
        .unwrap();
        let job = job::owned_job().expect("the shared job exists");

        let mut in_job = 0;
        // SAFETY: live handles, an out-pointer to a local.
        let asked = unsafe { IsProcessInJob(child.as_raw_handle(), job, &mut in_job) };
        let _ = child.kill();
        let _ = child.wait();
        assert_ne!(asked, 0, "{}", io::Error::last_os_error());
        assert_ne!(in_job, 0, "a spawn_owned child must be in the shared job");

        // SAFETY: an all-zero struct is a valid out-buffer for this class.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(queried, 0, "{}", io::Error::last_os_error());
        assert_ne!(info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0);

        let mut flags = 0u32;
        // SAFETY: the shared job's handle, an out-pointer to a local.
        assert_ne!(unsafe { GetHandleInformation(job, &mut flags) }, 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0, "the job handle must not be inheritable");
    }

    /// What the limit is FOR, end to end: closing the last handle of a job
    /// built exactly like the shared one ends the ffmpeg in it (that close is
    /// what the app's exit does to the shared job). The child would otherwise
    /// play on for 30 s.
    #[cfg(windows)]
    #[test]
    fn closing_the_job_ends_the_children_in_it() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let job = job::new_kill_on_close_job().expect("a job can be created");
        let mut child = ffmpeg(&[
            "-hide_banner", "-loglevel", "error", "-re",
            "-f", "lavfi", "-i", "sine=duration=30", "-f", "null", "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
        // SAFETY: both handles are live for the call.
        let assigned = unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) };
        // SAFETY: our own handle, closed once.
        unsafe { CloseHandle(job) };

        let deadline = Instant::now() + Duration::from_secs(10);
        let ended = loop {
            match child.try_wait().unwrap() {
                Some(_) => break true,
                None if Instant::now() >= deadline => break false,
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        if !ended {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_ne!(assigned, 0, "{}", io::Error::last_os_error());
        assert!(ended, "closing the job must end the process in it");
    }
}
