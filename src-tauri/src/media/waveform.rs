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

/// Decode + bucket the whole stream (runs on a worker thread). Emits progress
/// through the job system using the known duration.
fn extract(
    app: &AppHandle,
    handle: &jobs::JobHandle,
    src: &str,
    duration: f64,
    dst: &std::path::Path,
) -> Result<()> {
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

    let mut child = cmd.spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");

    let total_pairs_hint = (duration * PAIRS_PER_SEC as f64) as usize;
    let mut pairs: Vec<(i8, i8)> = Vec::with_capacity(total_pairs_hint + 16);

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
    if !status.success() {
        return Err(AppError::Ffmpeg(format!("waveform decode failed ({status})")));
    }
    write_pk(dst, &pairs)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
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
    let tmp_path = cache.file_path(CacheKind::Waveform, &hash, ".pk.tmp");

    let handle = jobs.allocate(JobKind::Waveform);
    let job_id = handle.id;
    let app_clone = app.clone();
    let jobs_arc = Arc::clone(&jobs);
    let cache_arc = Arc::clone(&cache);
    let src = key.path.clone();
    let final_clone = final_path.clone();

    jobs.submit(
        Lane::Background,
        Box::new(move || {
            handle.set_output(tmp_path.clone());
            match extract(&app_clone, &handle, &src, duration, &tmp_path) {
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
