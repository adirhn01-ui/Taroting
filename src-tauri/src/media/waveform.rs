//! Waveform peak extraction: decode the first audio stream to 8kHz mono
//! s16 PCM via ffmpeg, bucket into per-10ms min/max pairs (i8), and store as
//! a small binary `.pk` file the frontend draws at any zoom level.
//!
//! Format: "TPK1" magic · u32le pairsPerSec · u32le pairCount · [i8 min, i8 max]×

use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::cache::{Cache, CacheKind, MediaKey};
use crate::error::{AppError, Result};
use crate::jobs::{self, JobId, JobKind, Jobs, Lane};
use crate::media::playability::{job_tmp_suffix, Inflight};

pub const SAMPLE_RATE: u32 = 8000;
pub const PAIRS_PER_SEC: u32 = 100;
const SAMPLES_PER_PAIR: usize = (SAMPLE_RATE / PAIRS_PER_SEC) as usize; // 80

/// Bucket raw s16 samples into (min, max) pairs, downscaled to i8.
pub fn bucket_s16(samples: &[i16], per_bucket: usize) -> Vec<(i8, i8)> {
    let mut out = Vec::with_capacity(samples.len() / per_bucket + 1);
    for chunk in samples.chunks(per_bucket) {
        let mut lo = i16::MAX;
        let mut hi = i16::MIN;
        for &s in chunk {
            lo = lo.min(s);
            hi = hi.max(s);
        }
        out.push(((lo >> 8) as i8, (hi >> 8) as i8));
    }
    out
}

fn write_pk(path: &std::path::Path, pairs: &[(i8, i8)]) -> Result<()> {
    let mut buf = Vec::with_capacity(12 + pairs.len() * 2);
    buf.extend_from_slice(b"TPK1");
    buf.extend_from_slice(&PAIRS_PER_SEC.to_le_bytes());
    buf.extend_from_slice(&(pairs.len() as u32).to_le_bytes());
    for &(lo, hi) in pairs {
        buf.push(lo as u8);
        buf.push(hi as u8);
    }
    let mut f = std::fs::File::create(path)?;
    f.write_all(&buf)?;
    Ok(())
}

/// Capacity hint for the pairs buffer, clamped to 24 h of audio.
///
/// `duration` arrives unvalidated from the `.trt` via the frontend, and this is
/// ONLY a hint — the Vec grows on demand, so a low guess costs a few reallocs
/// while a high one is fatal: `duration = 1e12` asked for 200 GB ("memory
/// allocation of 200000000000032 bytes failed") and `1e17` overflowed capacity
/// outright. Under `panic = "abort"` that killed the app just for OPENING a
/// project, since the timeline requests waveforms as it draws.
fn pairs_capacity_hint(duration: f64) -> usize {
    const MAX_PAIRS: f64 = 24.0 * 3600.0 * PAIRS_PER_SEC as f64;
    // NaN.max(0.0) == 0.0, so a NaN duration lands on an empty hint.
    (duration.max(0.0) * PAIRS_PER_SEC as f64).min(MAX_PAIRS) as usize
}

/// Decode + bucket the whole stream (runs on a worker thread). Emits progress
/// through the job system using the known duration.
fn extract(
    app: &AppHandle,
    handle: &jobs::JobHandle,
    src: &str,
    duration: f64,
    dst: &std::path::Path,
) -> Result<()> {
    // Same guard `execute_ffmpeg` has: a job canceled while still QUEUED must
    // not even start ffmpeg (closing the editor cancels every waveform job, so
    // this is the normal path, not an edge one).
    if handle.is_canceled() {
        return Err(AppError::Ffmpeg("canceled".into()));
    }
    let mut cmd = jobs::ffmpeg::command("ffmpeg")?;
    cmd.args([
        "-v", "error",
        "-i", src,
        "-map", "a:0",
        "-ac", "1",
        "-ar", &SAMPLE_RATE.to_string(),
        "-f", "s16le",
        "-",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .stdin(Stdio::null());

    let mut child = jobs::ffmpeg::spawn_owned(&mut cmd)?;
    let mut stdout = child.stdout.take().expect("piped stdout");

    let mut pairs: Vec<(i8, i8)> = Vec::with_capacity(pairs_capacity_hint(duration) + 16);

    let mut carry: Vec<i16> = Vec::with_capacity(SAMPLES_PER_PAIR);
    let mut buf = [0u8; 65536];
    let mut last_emit = std::time::Instant::now();

    loop {
        if handle.is_canceled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Ffmpeg("canceled".into()));
        }
        let n = stdout.read(&mut buf)?;
        if n == 0 {
            break;
        }
        // bytes → i16 samples (LE), keeping a carry for odd byte counts is
        // unnecessary: ffmpeg writes whole samples; n is always even here.
        for pair in buf[..n].chunks_exact(2) {
            carry.push(i16::from_le_bytes([pair[0], pair[1]]));
            if carry.len() == SAMPLES_PER_PAIR {
                let b = bucket_s16(&carry, SAMPLES_PER_PAIR);
                pairs.extend_from_slice(&b);
                carry.clear();
            }
        }
        if last_emit.elapsed().as_millis() >= 150 && duration > 0.0 {
            last_emit = std::time::Instant::now();
            let done_secs = pairs.len() as f64 / PAIRS_PER_SEC as f64;
            jobs::emit_progress(
                app,
                &jobs::ProgressEvent {
                    id: handle.id,
                    kind: handle.kind,
                    ratio: Some((done_secs / duration).clamp(0.0, 1.0)),
                    out_time_ms: (done_secs * 1000.0) as u64,
                    fps: 0.0,
                    speed: 0.0,
                    eta_sec: None,
                },
            );
        }
    }
    if !carry.is_empty() {
        pairs.extend_from_slice(&bucket_s16(&carry, SAMPLES_PER_PAIR));
    }

    let status = child.wait()?;
    // A cancel that lands during the last read makes the loop exit on EOF with
    // the kill already sent; without this the truncated peaks would be written
    // and renamed over the final `.pk`, and the job completed as if it were live.
    if handle.is_canceled() {
        return Err(AppError::Ffmpeg("canceled".into()));
    }
    if !status.success() {
        return Err(AppError::Ffmpeg(format!("waveform decode failed ({status})")));
    }
    write_pk(dst, &pairs)
}

/// Field names: see `PlaybackPlan` (media/playability.rs).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "state")]
pub enum WaveformResult {
    Ready { path: String },
    Pending { job_id: JobId, output: String },
    /// media has no audio stream
    None,
}

#[tauri::command]
pub fn ensure_waveform(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    cache: State<'_, Arc<Cache>>,
    inflight: State<'_, Inflight>,
    key: MediaKey,
    duration: f64,
    has_audio: bool,
) -> Result<WaveformResult> {
    if !has_audio {
        return Ok(WaveformResult::None);
    }
    let hash = key.hash();
    if let Some(existing) = cache.existing_file(CacheKind::Waveform, &hash, ".pk") {
        return Ok(WaveformResult::Ready {
            path: existing.to_string_lossy().into_owned(),
        });
    }
    cache.ensure_kind_dir(CacheKind::Waveform)?;
    let final_path = cache.file_path(CacheKind::Waveform, &hash, ".pk");

    // Two clips on the same media — or one project opened while its previous
    // mount is still tearing down — used to start two decodes of the SAME file
    // writing the SAME `.pk`, then race each other's rename onto it. The
    // timeline requests a waveform per audio clip as it draws, so duplicates are
    // the normal case on the project-open path, not an edge one. `plan_playback`
    // has guarded its own outputs this way since v0.6; this is the sibling call
    // site that was missed, and it shares the same registry because the map is
    // keyed by the absolute output path — a waveform's `.pk` can never collide
    // with a remux's or proxy's `.mp4`. Both claim sites use the same
    // `Inflight::claim`/`release` pair, so a canceled decode is replaced here
    // exactly as a canceled remux is there.
    let (job_id, handle) = match inflight.claim(&jobs, &final_path, || {
        let h = jobs.allocate(JobKind::Waveform);
        (h.id, h)
    }) {
        Ok(claimed) => claimed,
        Err(existing) => {
            return Ok(WaveformResult::Pending {
                job_id: existing,
                output: final_path.to_string_lossy().into_owned(),
            })
        }
    };
    // Per job, never a shared `.pk.tmp`: see `job_tmp_suffix`.
    let tmp_path = cache.file_path(CacheKind::Waveform, &hash, &job_tmp_suffix(".pk", job_id));

    let app_clone = app.clone();
    let jobs_arc = Arc::clone(&jobs);
    let cache_arc = Arc::clone(&cache);
    let inflight_arc = Inflight::clone(&inflight);
    let src = key.path.clone();
    let final_clone = final_path.clone();

    jobs.submit(
        Lane::Background,
        Box::new(move || {
            handle.set_output(tmp_path.clone());
            let extracted = extract(&app_clone, &handle, &src, duration, &tmp_path);
            // Released before the rename, exactly as `ensure_prepared` does: the
            // decode is what must not be duplicated, and a request arriving
            // during the rename either finds the finished file or starts a fresh
            // job, both of which are correct.
            inflight_arc.release(&final_clone, handle.id);
            match extracted {
                Ok(()) => {
                    if std::fs::rename(&tmp_path, &final_clone).is_ok() {
                        cache_arc.mark_used(&final_clone);
                        jobs::complete_job(
                            &app_clone,
                            &jobs_arc,
                            &handle,
                            serde_json::json!({ "path": final_clone.to_string_lossy() }),
                        );
                    } else {
                        jobs::fail_job(&app_clone, &jobs_arc, &handle, "finalize failed".into(), Vec::new());
                    }
                }
                Err(e) => {
                    jobs::fail_job(&app_clone, &jobs_arc, &handle, e.to_string(), Vec::new());
                }
            }
        }),
    );

    Ok(WaveformResult::Pending {
        job_id,
        output: final_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_min_max_correctly() {
        // two buckets of 4: [-32768..32767] extremes preserved (scaled to i8)
        let samples: Vec<i16> = vec![0, -32768, 100, 200, 300, 32767, -100, 5];
        let pairs = bucket_s16(&samples, 4);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (-128, 0)); // min -32768>>8 = -128, max 200>>8 = 0
        assert_eq!(pairs[1], ((-100_i16 >> 8) as i8, 127)); // max 32767>>8 = 127
    }

    #[test]
    fn handles_partial_tail_bucket() {
        let samples: Vec<i16> = vec![1000; 10];
        let pairs = bucket_s16(&samples, 4);
        assert_eq!(pairs.len(), 3); // 4+4+2
        let expected = ((1000_i16 >> 8) as i8, (1000_i16 >> 8) as i8);
        assert!(pairs.iter().all(|&p| p == expected));
    }

    #[test]
    fn capacity_hint_is_clamped_for_absurd_durations() {
        // 24 h is the ceiling; the hint is only a hint, the Vec still grows.
        const MAX: usize = 24 * 3600 * PAIRS_PER_SEC as usize; // 8_640_000

        // Sane durations are exact.
        assert_eq!(pairs_capacity_hint(0.0), 0);
        assert_eq!(pairs_capacity_hint(10.0), 1000);
        assert_eq!(pairs_capacity_hint(3600.0), 360_000);

        // A crafted `.trt` used to abort the process here: 1e12 asked for 200 GB
        // and 1e17 overflowed capacity outright.
        assert_eq!(pairs_capacity_hint(1e12), MAX);
        assert_eq!(pairs_capacity_hint(1e17), MAX);
        assert_eq!(pairs_capacity_hint(f64::MAX), MAX);
        assert_eq!(pairs_capacity_hint(f64::INFINITY), MAX);

        // Nonsense durations degrade to an empty hint, never a negative/huge cast.
        assert_eq!(pairs_capacity_hint(-1.0), 0);
        assert_eq!(pairs_capacity_hint(f64::NEG_INFINITY), 0);
        assert_eq!(pairs_capacity_hint(f64::NAN), 0);

        // And the buffer that hint feeds is actually allocatable.
        let v: Vec<(i8, i8)> = Vec::with_capacity(pairs_capacity_hint(f64::MAX) + 16);
        assert!(v.capacity() >= MAX);
    }

    /// The de-duplication `plan_playback` had and this path did not.
    ///
    /// Every value differs on every axis it could be confused with: the two
    /// outputs differ, the three job ids differ from each other and from the
    /// allocation counts, and the payload the allocator returns is checked
    /// separately from the id, so a helper that returned the wrong half of the
    /// pair cannot pass.
    #[test]
    fn a_second_request_for_the_same_waveform_joins_the_running_job() {
        // Moved with the helpers onto `Inflight`; same assertions. None of these
        // ids is registered with `jobs`, so none reads as canceled: they model
        // live jobs, the case this test has always pinned.
        use std::path::PathBuf;
        let jobs = Jobs::default();
        let inflight = Inflight::default();
        let pk = PathBuf::from(r"C:\cache\waveform\1122334455667788.pk");
        let other = PathBuf::from(r"C:\cache\waveform\99aabbccddeeff00.pk");

        /// A stand-in for `jobs.allocate` that counts how often it actually runs.
        fn allocator<'a>(
            calls: &'a std::cell::Cell<u32>,
            id: JobId,
            tag: &'static str,
        ) -> impl FnOnce() -> (JobId, &'static str) + 'a {
            move || {
                calls.set(calls.get() + 1);
                (id, tag)
            }
        }
        let allocations = std::cell::Cell::new(0u32);
        let allocate = |id, tag| allocator(&allocations, id, tag);

        // First request wins the slot and gets its own handle back.
        let first = inflight.claim(&jobs, &pk, allocate(41, "handle-41")).expect("slot was free");
        assert_eq!(first, (41, "handle-41"));
        assert_eq!(allocations.get(), 1);

        // The duplicate the timeline fires while drawing the second clip of the
        // same media joins job 41 instead of starting a second decode onto the
        // same file — and must NOT allocate a handle it would then drop.
        let dup = inflight.claim(&jobs, &pk, allocate(77, "handle-77")).expect_err("must join");
        assert_eq!(dup, 41, "the joiner must be told the RUNNING job's id");
        assert_eq!(
            allocations.get(),
            1,
            "a joined request must not allocate a job handle it then discards"
        );

        // A different media is a different output: it must still get its own job.
        let second = inflight.claim(&jobs, &other, allocate(77, "handle-77")).expect("distinct output");
        assert_eq!(second, (77, "handle-77"));
        assert_eq!(allocations.get(), 2);

        // Once the decode finishes the slot frees, so a later request (a cache
        // miss after eviction, say) starts a fresh job rather than joining a
        // dead one.
        inflight.release(&pk, 41);
        let again = inflight.claim(&jobs, &pk, allocate(93, "handle-93")).expect("slot released");
        assert_eq!(again, (93, "handle-93"));
        assert_eq!(allocations.get(), 3);
    }

    /// `extract` needs an `AppHandle`, so its cancel guards are pinned in the
    /// source, over the code before the test module (the needles appear as
    /// literals here too). Order matters: the first guard must precede the spawn,
    /// the second must sit between `wait` and the `.pk` write.
    #[test]
    fn extract_honours_cancel_before_spawn_and_before_writing() {
        let code = include_str!("waveform.rs").split("#[cfg(test)]").next().unwrap();
        let body_start = code.find("fn extract(").expect("extract exists");
        let end = code[body_start..].find("pub enum WaveformResult").expect("extract ends");
        // Whitespace-free, so the check survives a reformat and any line endings.
        let body: String = code[body_start..body_start + end].split_whitespace().collect();
        let guard = "ifhandle.is_canceled(){returnErr(AppError::Ffmpeg(\"canceled\".into()));}";
        let spawn = body.find("spawn_owned(&mutcmd)").expect("spawns ffmpeg");
        let first = body.find(guard).expect("a guard exists");
        assert!(first < spawn, "a canceled queued job must not start ffmpeg");
        let wait = body.find("child.wait()?").expect("waits for ffmpeg");
        let write = body.find("write_pk(dst").expect("writes the peaks");
        let after_wait = body[wait..].find(guard).map(|i| i + wait).expect("guard after wait");
        assert!(after_wait < write, "a canceled job must not write or rename its peaks");
    }

    #[test]
    fn pk_header_layout() {
        let dir = std::env::temp_dir().join("taroting-pk-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("test.pk");
        write_pk(&f, &[(-5, 7), (0, 127)]).unwrap();
        let bytes = std::fs::read(&f).unwrap();
        assert_eq!(&bytes[0..4], b"TPK1");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), PAIRS_PER_SEC);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 2);
        assert_eq!(bytes[12] as i8, -5);
        assert_eq!(bytes[13] as i8, 7);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
