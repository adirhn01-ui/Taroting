//! Locating and spawning the bundled ffmpeg/ffprobe sidecars.

use std::path::PathBuf;
use std::process::{Command, Output};

use crate::error::{AppError, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// Run a sidecar to completion, capturing output. For quick, bounded work
/// (probing, version checks) — long-running jobs go through the job system.
pub fn run(name: &str, args: &[&str]) -> Result<Output> {
    let out = command(name)?.args(args).output()?;
    Ok(out)
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
}
