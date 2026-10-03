//! Filesystem locations. Everything Taroting writes lives in exactly three
//! places: %APPDATA%\Taroting (settings, recents), %LOCALAPPDATA%\Taroting\cache
//! (regenerable proxies/waveforms/thumbnails), and user-chosen project/export
//! paths. Nothing else is ever touched.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::{AppError, Result};

fn env_dir(var: &str) -> Result<PathBuf> {
    dir_from_env(var, std::env::var_os(var))
}

/// The whole decision, split out from the environment read so it can be tested
/// without mutating process-global state.
///
/// An EMPTY value must fail exactly like a missing one, and is the more
/// dangerous of the two: `PathBuf::from("").join("Taroting")` is the RELATIVE
/// path `Taroting`, which resolves against the process CWD. For a launch from
/// Explorer's open-with that CWD is the folder holding the double-clicked file,
/// so settings, recents and the whole media cache would be created inside the
/// user's own directories — and a second launch from elsewhere would not find
/// them again.
fn dir_from_env(var: &str, value: Option<OsString>) -> Result<PathBuf> {
    value
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AppError::BadInput(format!("environment variable {var} is not set")))
}

/// Under the in-app E2E harness (debug build + TAROTING_AUTOTEST=1) every
/// location that holds the OWNER's data is redirected into a private scratch
/// root, so a test run can never touch their settings, recents, projects or
/// temporary projects. The cache has a redirect of its own (`cache_dir_for`),
/// because this root is wiped at every autotest start. A normal or shipped run
/// never takes this branch (`autotest_mode` is false in release builds).
fn autotest_redirect(leaf: &str) -> Option<PathBuf> {
    crate::debug::autotest_mode().then(|| crate::debug::autotest_root().join(leaf))
}

/// %APPDATA%\Taroting — settings.json, recents.json
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = autotest_redirect("appdata") {
        return Ok(dir);
    }
    Ok(env_dir("APPDATA")?.join("Taroting"))
}

/// %LOCALAPPDATA%\Taroting\cache — regenerable derived files
pub fn cache_dir() -> Result<PathBuf> {
    cache_dir_for(
        crate::debug::autotest_mode(),
        std::env::var_os("LOCALAPPDATA"),
        std::env::temp_dir(),
    )
}

/// `cache_dir`'s decision, split from the environment reads so both branches
/// are testable without touching process-global state.
///
/// Under autotest the cache moves to `%TEMP%\taroting-autotest-cache\cache`.
/// Left in the owner's cache, every E2E run (which starts from factory
/// settings, so a 2 GB limit) LRU-trimmed their proxies down to 2 GB and left
/// its fixture entries among them. It is NOT inside `autotest_root`, which is
/// wiped at every autotest start: the cache is regenerable and keyed by file
/// identity, so keeping it across runs is what spares each run re-deriving
/// every fixture proxy against the suite's time cap.
///
/// The extra `cache` level is load-bearing: `diagnostics.rs` derives the app
/// root as this directory's PARENT, and that parent must be a folder of ours,
/// never `%TEMP%` itself.
fn cache_dir_for(autotest: bool, local_app_data: Option<OsString>, temp: PathBuf) -> Result<PathBuf> {
    if autotest {
        return Ok(temp.join("taroting-autotest-cache").join("cache"));
    }
    Ok(dir_from_env("LOCALAPPDATA", local_app_data)?
        .join("Taroting")
        .join("cache"))
}

/// %LOCALAPPDATA%\Taroting — the app's local root. Holds the crash note
/// (`crash.rs`: last-crash.txt, written as the process dies, shown once on the
/// next launch). Redirected under autotest like every owner-data location: an
/// E2E run that writes a synthetic note must never leave one for the owner's
/// next launch to show.
pub fn app_local_dir() -> Result<PathBuf> {
    if let Some(dir) = autotest_redirect("localappdata") {
        return Ok(dir);
    }
    Ok(env_dir("LOCALAPPDATA")?.join("Taroting"))
}

/// %LOCALAPPDATA%\Taroting\tmp-projects — scratch projects for the quick-view
/// (open-with) flow. Files here are never in recents and are wiped when the
/// primary instance starts; choosing Keep in the editor's keep/discard prompt
/// writes the project permanently to Documents.
pub fn temp_projects_dir() -> Result<PathBuf> {
    if let Some(dir) = autotest_redirect("tmp-projects") {
        return Ok(dir);
    }
    Ok(env_dir("LOCALAPPDATA")?
        .join("Taroting")
        .join("tmp-projects"))
}

/// Default folder for new projects: Documents\Taroting
pub fn default_projects_dir() -> Result<PathBuf> {
    if let Some(dir) = autotest_redirect("documents") {
        return Ok(dir);
    }
    Ok(env_dir("USERPROFILE")?.join("Documents").join("Taroting"))
}

pub fn ensure_dir(p: &PathBuf) -> Result<()> {
    std::fs::create_dir_all(p)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_set_variable_gives_an_absolute_base() {
        let dir = dir_from_env("APPDATA", Some(OsString::from(r"C:\Users\x\AppData\Roaming")))
            .expect("a real value must be accepted");
        assert!(dir.join("Taroting").is_absolute());
    }

    /// An empty value is rejected like a missing one. Without this the joined
    /// path is the RELATIVE "Taroting", i.e. app data written into whatever
    /// directory the process happens to have been started in.
    #[test]
    fn an_empty_variable_is_rejected_like_a_missing_one() {
        for value in [None, Some(OsString::new())] {
            let err = dir_from_env("APPDATA", value).expect_err("must not yield a path");
            assert!(
                matches!(&err, AppError::BadInput(m) if m.contains("APPDATA")),
                "unexpected error: {err}"
            );
        }
        // The failure that matters is the shape of what would have been built.
        assert!(!PathBuf::from("").join("Taroting").is_absolute());
    }

    /// The E2E's cache is its own: nowhere under the owner's %LOCALAPPDATA%
    /// (or a trim at the run's factory 2 GB limit evicts their proxies), and
    /// not under the autotest root, which every run wipes. The local and temp
    /// values differ in every component, so a branch that used the wrong one
    /// cannot pass.
    #[test]
    fn the_autotest_cache_is_a_persistent_folder_of_its_own() {
        let local = OsString::from(r"C:\Users\owner\AppData\Local");
        let temp = PathBuf::from(r"D:\scratch\tmp");

        let owner = cache_dir_for(false, Some(local.clone()), temp.clone()).unwrap();
        assert_eq!(owner, PathBuf::from(r"C:\Users\owner\AppData\Local\Taroting\cache"));

        let e2e = cache_dir_for(true, Some(local.clone()), temp.clone()).unwrap();
        assert!(
            !e2e.starts_with(PathBuf::from(&local)),
            "the E2E must not use the owner's cache: {e2e:?}"
        );
        assert!(e2e.starts_with(&temp), "{e2e:?}");
        assert!(
            !e2e.starts_with(temp.join("taroting-autotest")),
            "inside the wiped autotest root the cache would be rebuilt every run: {e2e:?}"
        );
        // diagnostics.rs takes the cache's parent as the app root: that must be
        // a folder of ours, not the temp directory itself.
        let parent = e2e.parent().unwrap();
        assert_ne!(parent, temp.as_path());
        assert!(parent.starts_with(&temp), "{parent:?}");
    }

    /// The redirect never needs LOCALAPPDATA, and the normal path still refuses
    /// a missing or empty one exactly as every other location does.
    #[test]
    fn the_cache_dir_reads_local_app_data_only_outside_autotest() {
        let temp = PathBuf::from(r"D:\scratch\tmp");
        assert!(cache_dir_for(true, None, temp.clone()).is_ok());
        for value in [None, Some(OsString::new())] {
            let err = cache_dir_for(false, value, temp.clone()).expect_err("must not yield a path");
            assert!(
                matches!(&err, AppError::BadInput(m) if m.contains("LOCALAPPDATA")),
                "unexpected error: {err}"
            );
        }
    }
}
