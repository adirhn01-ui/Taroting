//! Where a video's keyframes are, read from an MP4/MOV's sample tables — no
//! ffmpeg, no decoding, one read of the `moov` box.
//!
//! WHY: the viewer's seek bar. Chromium's `<video>` decodes every seek from
//! the keyframe before its target. On a long-GOP recording (OBS writes one
//! keyframe every ~4 s by default) a seek to the end of a GOP decodes ~250
//! frames first: measured on a 69 Mbps 1080p60 OBS clip in WebView2 154, a
//! seek late in a GOP took 593-1364 ms (median 1278), a seek that lands ON a
//! keyframe 3-48 ms (median 15). So while the user drags fast across such a
//! file, the viewer shows the keyframe at or before the cursor — a picture of
//! where they are, at once — and the exact frame when the drag rests or ends.
//!
//! Read like `damage.rs` reads the same tables (whose box helpers it uses):
//! an untrusted file in a `panic = "abort"` build, every count checked
//! against its box, every sum checked, `None` for anything that does not add
//! up — which only means the viewer seeks exactly, as it always did.

use std::fs::File;
use std::path::Path;

use serde::Serialize;

use super::damage::{
    be32, be64, child, children, counted, descend, read_moov, single_edit_media_time, table, Reader,
    MAX_SAMPLES,
};
use super::source::source_file;
use crate::error::Result;

/// The first video track's keyframes, in presentation seconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeIndex {
    /// Every sample is a keyframe (no `stss` box): any seek decodes one frame,
    /// and `times` is empty — there is nothing to snap to.
    pub all_sync: bool,
    /// Ascending, deduplicated, each >= 0.
    pub times: Vec<f64>,
    /// The track's presentation length in seconds: its samples' total
    /// duration less the edit list's start (the B-frame delay it takes out).
    pub duration: f64,
    /// The file's length in bytes. Over `duration`, the overall bit rate the
    /// viewer weighs with the keyframe gap to call a file heavy.
    pub bytes: u64,
}

/// The keyframes of `path`'s first video track, or `None` when it is not an
/// MP4/MOV this reads (fragmented, no video track, an edit list other than
/// one edit or a leading empty edit and one edit — a splice, say — or
/// anything malformed).
pub fn keyframe_index(path: &Path) -> Option<KeyframeIndex> {
    let file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut reader = Reader::new(file, len);
    let moov = read_moov(&mut reader)?;
    index_of(&moov, len)
}

/// `keyframe_index` over a `moov` body of a `bytes`-long file, so the tests
/// build one in memory.
fn index_of(moov: &[u8], bytes: u64) -> Option<KeyframeIndex> {
    let top = children(moov)?;
    // A fragmented file's samples live in `moof` boxes this does not read.
    if super::fragmented::has_mvex(top.iter().map(|(t, _)| t)) {
        return None;
    }
    // The FIRST video track: the one the WebView shows.
    let trak = top.into_iter().filter(|(t, _)| t == b"trak").map(|(_, b)| b).find(|trak| {
        descend(trak, &[b"mdia", b"hdlr"]).and_then(|h| h.get(8..12)) == Some(b"vide".as_slice())
    })?;
    let mdia = child(trak, b"mdia")?;
    let mdhd = child(mdia, b"mdhd")?;
    let timescale = match mdhd.first()? {
        0 => be32(mdhd, 12)?,
        1 => be32(mdhd, 20)?,
        _ => return None,
    };
    if timescale == 0 {
        return None;
    }
    let stbl = descend(mdia, &[b"minf", b"stbl"])?;
    let sample_count = be32(child(stbl, b"stsz").or_else(|| child(stbl, b"stz2"))?, 8)?;
    if sample_count == 0 || u64::from(sample_count) > MAX_SAMPLES {
        return None;
    }
    let (_, _, stts) = table(child(stbl, b"stts")?, 8)?;
    if counted(stts)? != u64::from(sample_count) {
        return None;
    }
    let ctts = match child(stbl, b"ctts") {
        None => None,
        Some(b) => {
            let (version, _, entries) = table(b, 8)?;
            if counted(entries)? != u64::from(sample_count) {
                return None;
            }
            Some((entries, version >= 1))
        }
    };
    // Where the track's own time starts, in its timescale: the edit's media
    // time, less a leading empty edit's delay (see `edit_start`).
    let media_time = match descend(trak, &[b"edts", b"elst"]) {
        None => 0,
        Some(elst) => match single_edit_media_time(elst) {
            Some(t) => t,
            None => {
                let mvhd = child(moov, b"mvhd")?;
                let movie_timescale = match mvhd.first()? {
                    0 => be32(mvhd, 12)?,
                    1 => be32(mvhd, 20)?,
                    _ => return None,
                };
                let (delay, t) = delayed_edit(elst, movie_timescale, timescale)?;
                t.checked_sub(delay)?
            }
        },
    };
    // Every sample's duration summed (`stts`), less the edit's start.
    let total = stts.chunks_exact(8).try_fold(0u64, |sum, r| {
        sum.checked_add(u64::from(be32(r, 0)?).checked_mul(u64::from(be32(r, 4)?))?)
    })?;
    let shown = i64::try_from(total).ok()?.checked_sub(media_time)?.max(0);
    let duration = shown as f64 / f64::from(timescale);
    let Some(stss) = child(stbl, b"stss") else {
        return Some(KeyframeIndex { all_sync: true, times: Vec::new(), duration, bytes });
    };
    let (_, _, sync) = table(stss, 4)?;
    let sync_count = sync_entries(sync, sample_count)?;
    if sync_count == sample_count as usize {
        // Every sample listed (strictly ascending inside the track forces
        // 1..=n): all-sync, as with no `stss` — no times to ship over IPC.
        let in_order = sync.chunks_exact(4).zip(1u32..).all(|(e, n)| be32(e, 0) == Some(n));
        return in_order.then(|| KeyframeIndex { all_sync: true, times: Vec::new(), duration, bytes });
    }

    // One pass over the samples' decode times (`stts`) and composition
    // offsets (`ctts`), picking out the sync samples (1-based, strictly
    // ascending, inside the track — anything else is not a table to trust).
    let mut times = Vec::with_capacity(sync_count);
    let mut stts_runs = stts.chunks_exact(8);
    let (mut run_left, mut run_delta) = (0u64, 0u64);
    let mut ctts_runs = ctts.map(|(e, _)| e.chunks_exact(8));
    let signed = ctts.is_some_and(|(_, s)| s);
    let (mut off_left, mut off_value) = (0u64, 0i64);
    let mut dts = 0u64;
    let mut sample = 0u32; // 0-based index of the sample `dts` belongs to
    let mut previous = 0u32;
    for e in sync.chunks_exact(4) {
        let number = be32(e, 0)?;
        if number <= previous || number > sample_count {
            return None;
        }
        previous = number;
        let k = number - 1;
        // Advance the decode clock and the composition run to sample k.
        while sample < k {
            if run_left == 0 {
                let r = stts_runs.next()?;
                run_left = u64::from(be32(r, 0)?);
                run_delta = u64::from(be32(r, 4)?);
                continue;
            }
            let step = run_left.min(u64::from(k - sample));
            dts = dts.checked_add(step.checked_mul(run_delta)?)?;
            run_left -= step;
            if let Some(runs) = ctts_runs.as_mut() {
                let mut left = step;
                while left > 0 {
                    if off_left == 0 {
                        let r = runs.next()?;
                        off_left = u64::from(be32(r, 0)?);
                        off_value = offset_of(be32(r, 4)?, signed)?;
                        continue;
                    }
                    let s = off_left.min(left);
                    off_left -= s;
                    left -= s;
                }
            }
            sample = sample.checked_add(u32::try_from(step).ok()?)?;
        }
        // Sample k's own composition offset: the run it sits in.
        let mut offset = 0i64;
        if let Some(runs) = ctts_runs.as_mut() {
            while off_left == 0 {
                let r = runs.next()?;
                off_left = u64::from(be32(r, 0)?);
                off_value = offset_of(be32(r, 4)?, signed)?;
            }
            offset = off_value;
        }
        let pts = i64::try_from(dts).ok()?.checked_add(offset)?.checked_sub(media_time)?;
        let seconds = pts as f64 / f64::from(timescale);
        if !seconds.is_finite() {
            return None;
        }
        // A keyframe before the edit's start (a negative pts) shows at 0.
        times.push(seconds.max(0.0));
    }
    times.sort_by(f64::total_cmp);
    times.dedup();
    Some(KeyframeIndex { all_sync: false, times, duration, bytes })
}

/// An edit list of exactly two edits, a leading EMPTY one (media_time -1)
/// and then one ordinary edit: the track's presentation starts `delay` late.
/// Returns (delay in the TRACK's timescale, the second edit's media_time).
/// `None` for any other list (one edit is `single_edit_media_time`'s).
///
/// WHY: ffmpeg writes this when a stream starts after the others — the
/// defragmented copy of a fragmented recording whose video starts one
/// B-frame delay after its audio (`playability::Decision::Defragment`) does —
/// and its demuxer, which the WebView plays MP4 through, adds the delay to
/// every pts: the empty edit's duration in the MOVIE's timescale (`mvhd`),
/// rescaled to the track's and rounded to nearest (`av_rescale`). Measured
/// on that copy: 66 movie ticks at 1000 become 1014 at 15360, the keyframes
/// ffprobe lists at 0.066016 + 7 k s. The viewer's pacer seeks ONTO these
/// times, so they must be the engine's own to the tick.
fn delayed_edit(elst: &[u8], movie_timescale: u32, track_timescale: u32) -> Option<(i64, i64)> {
    let version = *elst.first()?;
    let width = if version == 1 { 20 } else { 12 };
    let (_, count, entries) = table(elst, width)?;
    if count != 2 || movie_timescale == 0 {
        return None;
    }
    let edit = |e: &[u8]| -> Option<(u64, i64)> {
        Some(if version == 1 {
            (be64(e, 0)?, i64::from_be_bytes(e.get(8..16)?.try_into().ok()?))
        } else {
            (u64::from(be32(e, 0)?), i64::from(be32(e, 4)? as i32))
        })
    };
    let (empty, empty_time) = edit(entries.get(..width)?)?;
    let (_, media_time) = edit(entries.get(width..)?)?;
    if empty_time != -1 || media_time < 0 {
        return None;
    }
    let (movie, track) = (u128::from(movie_timescale), u128::from(track_timescale));
    let delay = (u128::from(empty) * track + movie / 2) / movie;
    Some((i64::try_from(delay).ok()?, media_time))
}

/// How many entries a `stss` body holds, or `None` when it lists more than
/// the track has samples: strictly ascending numbers inside the track cannot
/// outnumber them, and the count sizes an allocation made before any entry is
/// checked (a 64 MiB `moov` that is all `stss` would otherwise reserve
/// ~128 MB only to be refused).
fn sync_entries(sync: &[u8], sample_count: u32) -> Option<usize> {
    let n = sync.len() / 4;
    (n <= usize::try_from(sample_count).ok()?).then_some(n)
}

/// A `ctts` offset as ffmpeg reads it: signed in every version. Past i32 a
/// v0 (unsigned) offset means something else to the standard than to
/// ffmpeg, and no real offset is that large: not an answer (as `damage.rs`).
fn offset_of(raw: u32, signed: bool) -> Option<i64> {
    if !signed && raw > i32::MAX as u32 {
        return None;
    }
    Some(i64::from(raw as i32))
}

/// The keyframes of a media file for the viewer's seek bar; `None` when they
/// cannot be read (see `keyframe_index`) — the viewer then seeks exactly.
/// Async with the read on the blocking pool: it opens a file and reads its
/// `moov` (up to 64 MiB on a day-long recording), never on the UI thread.
#[tauri::command]
pub async fn keyframe_times(path: String) -> Result<Option<KeyframeIndex>> {
    let file = source_file(&path)?.to_path_buf();
    Ok(tauri::async_runtime::spawn_blocking(move || keyframe_index(&file)).await.unwrap_or(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }
    fn full(typ: &[u8; 4], version: u8, rest: &[u8]) -> Vec<u8> {
        let mut b = vec![version, 0, 0, 0];
        b.extend_from_slice(rest);
        bx(typ, &b)
    }
    fn u32s(v: &[u32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_be_bytes()).collect()
    }
    fn counted_table(typ: &[u8; 4], version: u8, rows: &[(u32, u32)]) -> Vec<u8> {
        let mut b = u32s(&[rows.len() as u32]);
        for &(c, d) in rows {
            b.extend(u32s(&[c, d]));
        }
        full(typ, version, &b)
    }

    struct Track {
        handler: &'static [u8; 4],
        timescale: u32,
        samples: u32,
        stts: Vec<(u32, u32)>,
        ctts: Option<(u8, Vec<(u32, u32)>)>,
        stss: Option<Vec<u32>>,
        elst: Option<Vec<(u32, i32)>>,
    }

    impl Track {
        /// 600 samples at 60 fps (timescale 15360, 256 per frame), a keyframe
        /// every 250 — three keyframes at 0, 250 and 500 — and B-frame style
        /// offsets of 512 everywhere with an edit list of 512 taking them back
        /// out, as libx264 + the mp4 muxer write it.
        fn obs() -> Self {
            Track {
                handler: b"vide",
                timescale: 15360,
                samples: 600,
                stts: vec![(600, 256)],
                ctts: Some((0, vec![(600, 512)])),
                stss: Some(vec![1, 251, 501]),
                elst: Some(vec![(10_000, 512)]),
            }
        }

        fn moov(&self) -> Vec<u8> {
            let mdhd = full(b"mdhd", 0, &[u32s(&[0, 0, self.timescale, 0]), vec![0; 4]].concat());
            let hdlr = full(b"hdlr", 0, &[u32s(&[0]), self.handler.to_vec(), vec![0; 13]].concat());
            let mut stbl = full(b"stsz", 0, &u32s(&[0, self.samples]));
            stbl.extend(counted_table(b"stts", 0, &self.stts));
            if let Some((v, rows)) = &self.ctts {
                stbl.extend(counted_table(b"ctts", *v, rows));
            }
            if let Some(sync) = &self.stss {
                stbl.extend(full(b"stss", 0, &[u32s(&[sync.len() as u32]), u32s(sync)].concat()));
            }
            let minf = bx(b"minf", &bx(b"stbl", &stbl));
            let mdia = bx(b"mdia", &[mdhd, hdlr, minf].concat());
            let mut trak = Vec::new();
            if let Some(edits) = &self.elst {
                let mut b = u32s(&[edits.len() as u32]);
                for &(dur, mt) in edits {
                    b.extend(u32s(&[dur, mt as u32, 0x0001_0000]));
                }
                trak.extend(bx(b"edts", &full(b"elst", 0, &b)));
            }
            trak.extend(mdia);
            // The movie header first, as muxers write it: timescale 1000, the
            // one an empty edit's duration is counted in.
            let mvhd = full(b"mvhd", 0, &[u32s(&[0, 0, 1000, 0]), vec![0; 80]].concat());
            [mvhd, bx(b"trak", &trak)].concat()
        }
    }

    fn index(t: &Track) -> Option<KeyframeIndex> {
        index_of(&t.moov(), 1)
    }

    #[test]
    fn reads_the_keyframes_of_a_long_gop_recording() {
        // 250 frames at 60 fps = 4.1667 s: the OBS default the viewer measured.
        let got = index(&Track::obs()).expect("a well-formed track");
        assert!(!got.all_sync);
        assert_eq!(got.times.len(), 3);
        for (t, want) in got.times.iter().zip([0.0, 250.0 / 60.0, 500.0 / 60.0]) {
            assert!((t - want).abs() < 1e-9, "{t} vs {want}");
        }
    }

    #[test]
    fn walks_runs_of_different_durations_and_offsets() {
        // Variable frame durations and offsets that DIFFER per run, so a
        // walker that reads the wrong run, or the run of the wrong sample,
        // lands on a different time for each keyframe.
        let t = Track {
            handler: b"vide",
            timescale: 1000,
            samples: 10,
            stts: vec![(3, 10), (4, 20), (3, 30)],
            ctts: Some((1, vec![(2, 5), (5, 7), (3, (-4i32) as u32)])),
            stss: Some(vec![1, 3, 6, 9]),
            elst: None,
        };
        // dts (the sum of the deltas before each sample):
        //   0 10 20 30 50 70 90 110 140 170
        // offsets: 5 5 7 7 7 7 7 -4 -4 -4
        // keyframes are samples 0, 2, 5, 8: 0+5, 20+7, 70+7, 140-4.
        let got = index(&t).unwrap();
        assert_eq!(got.times, vec![0.005, 0.027, 0.077, 0.136]);
    }

    #[test]
    fn a_file_whose_every_sample_is_a_keyframe_has_nothing_to_snap_to() {
        let got = index(&Track { stss: None, ..Track::obs() }).unwrap();
        let want = KeyframeIndex { all_sync: true, times: vec![], duration: (153_600.0 - 512.0) / 15_360.0, bytes: 1 };
        assert_eq!(got, want);
    }

    #[test]
    fn a_sync_table_listing_every_sample_is_all_sync() {
        // 7 samples of 300 at 9000, all listed: the same answer as no `stss`,
        // not seven times over IPC.
        let every = Track {
            timescale: 9000,
            samples: 7,
            stts: vec![(7, 300)],
            ctts: None,
            stss: Some(vec![1, 2, 3, 4, 5, 6, 7]),
            elst: None,
            ..Track::obs()
        };
        let want = KeyframeIndex { all_sync: true, times: vec![], duration: 2100.0 / 9000.0, bytes: 1 };
        assert_eq!(index(&every), Some(want));
        // One short of every sample is a real keyframe list.
        let most = Track { stss: Some(vec![1, 2, 3, 5, 6, 7]), ..every };
        assert!(!index(&most).unwrap().all_sync);
    }

    #[test]
    fn a_sync_table_listing_every_sample_out_of_order_is_refused() {
        let t = Track {
            timescale: 9000,
            samples: 4,
            stts: vec![(4, 300)],
            ctts: None,
            stss: Some(vec![1, 3, 2, 4]),
            elst: None,
            ..Track::obs()
        };
        assert_eq!(index(&t), None);
    }

    #[test]
    fn a_sync_table_longer_than_the_track_is_refused_before_it_is_sized() {
        // 6 entries for 5 samples: refused by its length alone.
        assert_eq!(sync_entries(&u32s(&[1, 2, 3, 4, 5, 6]), 5), None);
        // 5 entries for 5 samples is a size to reserve.
        assert_eq!(sync_entries(&u32s(&[1, 2, 3, 4, 5]), 5), Some(5));
        // And the whole read refuses such a track.
        let t = Track { samples: 5, stts: vec![(5, 256)], ctts: None, stss: Some(vec![1, 2, 3, 4, 5, 6]), elst: None, ..Track::obs() };
        assert_eq!(index(&t), None);
    }

    #[test]
    fn no_answer_for_what_it_cannot_trust() {
        let cases: Vec<(&str, Track)> = vec![
            ("not a video track", Track { handler: b"soun", ..Track::obs() }),
            ("zero timescale", Track { timescale: 0, ..Track::obs() }),
            ("stts short of the samples", Track { stts: vec![(599, 256)], ..Track::obs() }),
            ("ctts short of the samples", Track { ctts: Some((0, vec![(10, 512)])), ..Track::obs() }),
            ("sync numbers out of order", Track { stss: Some(vec![1, 501, 251]), ..Track::obs() }),
            ("a sync number repeated", Track { stss: Some(vec![1, 251, 251]), ..Track::obs() }),
            ("a sync number past the last sample", Track { stss: Some(vec![1, 601]), ..Track::obs() }),
            ("sync number 0", Track { stss: Some(vec![0, 251]), ..Track::obs() }),
            ("an empty edit alone", Track { elst: Some(vec![(500, -1)]), ..Track::obs() }),
            ("two empty edits", Track { elst: Some(vec![(500, -1), (500, -1), (10_000, 0)]), ..Track::obs() }),
            ("an empty edit after an edit", Track { elst: Some(vec![(10_000, 0), (500, -1)]), ..Track::obs() }),
            ("an empty edit before a splice", Track { elst: Some(vec![(500, -1), (500, 0), (500, 1000)]), ..Track::obs() }),
            ("a splice", Track { elst: Some(vec![(500, 0), (500, 1000)]), ..Track::obs() }),
            ("a v0 offset past i32", Track { ctts: Some((0, vec![(600, 0x8000_0000)])), ..Track::obs() }),
        ];
        for (what, t) in cases {
            assert_eq!(index(&t), None, "{what}");
        }
    }

    /// A leading empty edit delays the whole track, as ffmpeg's demuxer
    /// plays it: the empty duration in the movie's timescale (1000 here),
    /// rescaled to the track's (15360) and rounded to nearest — 66 ticks are
    /// 1013.76, so 1014 — then the second edit's media time taken out. The
    /// numbers are the defragmented fixture's own (see
    /// `the_delayed_copy_matches_ffprobe`). Without the movie header there
    /// is no timescale to read the delay in: no answer.
    #[test]
    fn a_leading_empty_edit_delays_every_keyframe() {
        let t = Track { elst: Some(vec![(66, -1), (40_000, 1024)]), ..Track::obs() };
        let got = index(&t).expect("an empty edit then an edit is read");
        let at = |k: u32| (1014.0 + f64::from(k) * 256.0 + 512.0 - 1024.0) / 15360.0;
        assert_eq!(got.times.len(), 3);
        for (g, k) in got.times.iter().zip([0, 250, 500]) {
            assert!((g - at(k)).abs() < 1e-12, "{:?}", got.times);
        }
        assert!((got.duration - (153_600.0 - 1024.0 + 1014.0) / 15_360.0).abs() < 1e-12, "{}", got.duration);
        // The same list without its empty edit: 1014 ticks earlier.
        let plain = index(&Track { elst: Some(vec![(40_000, 1024)]), ..Track::obs() }).unwrap();
        assert!((got.times[1] - plain.times[1] - 1014.0 / 15360.0).abs() < 1e-12);
        // The rounding: 1.5 ticks rounds up, 1.4 down (track at 3 per movie 2).
        assert_eq!(delayed_edit(&elst(&[(1, -1), (10, 0)]), 2, 3), Some((2, 0)));
        assert_eq!(delayed_edit(&elst(&[(7, -1), (10, 5)]), 5, 1), Some((1, 5)));
        assert_eq!(delayed_edit(&elst(&[(1, -1), (10, 0)]), 0, 3), None, "no movie timescale");
        assert_eq!(delayed_edit(&elst(&[(1, -1), (10, -1)]), 2, 3), None, "two empty edits");
        // No movie header: refused.
        let moov = t.moov();
        let no_mvhd = &moov[full(b"mvhd", 0, &[u32s(&[0, 0, 1000, 0]), vec![0; 80]].concat()).len()..];
        assert_eq!(index_of(no_mvhd, 1), None);
    }

    fn elst(edits: &[(u32, i32)]) -> Vec<u8> {
        let mut b = vec![0, 0, 0, 0];
        b.extend(u32s(&[edits.len() as u32]));
        for &(dur, mt) in edits {
            b.extend(u32s(&[dur, mt as u32, 0x0001_0000]));
        }
        b
    }

    /// The defragmented copy of a real fragmented recording (video one
    /// B-frame delay after its audio, so ffmpeg writes a leading empty edit):
    /// its keyframes are read, and they are ffprobe's own to the millisecond.
    #[test]
    fn the_delayed_copy_matches_ffprobe() {
        use crate::jobs::ffmpeg;
        let dir = std::env::temp_dir().join(format!("taroting-keyframes-delay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (frag, copy) = (dir.join("frag.mp4"), dir.join("copy.mp4"));
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4.3"])
            .args(["-f", "lavfi", "-i", "sine=duration=4.3"])
            .args(["-c:v", "libx264", "-preset", "veryfast", "-bf", "3", "-g", "40", "-keyint_min", "40", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-shortest", "-movflags", "frag_keyframe+empty_moov+default_base_moof"])
            .arg(&frag)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args(crate::media::prepare::remux_args(&frag, &copy, true))
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let probe = ffmpeg::command("ffprobe")
            .unwrap()
            .args(["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey"])
            .args(["-show_entries", "frame=pts_time", "-of", "csv=p=0"])
            .arg(&copy)
            .output()
            .unwrap();
        let want: Vec<f64> = String::from_utf8_lossy(&probe.stdout)
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(',').parse().ok())
            .collect();
        let got = keyframe_index(&copy);
        let original = keyframe_index(&frag);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(original, None, "the fragmented original is not read");
        let got = got.expect("the copy is read");
        assert!(want.len() >= 3 && want[0] > 0.01, "ffprobe listed {want:?}: the fixture must carry a delay");
        assert_eq!(got.times.len(), want.len(), "{:?} vs ffprobe {want:?}", got.times);
        for (g, w) in got.times.iter().zip(&want) {
            assert!((g - w).abs() < 1e-3, "{:?} vs ffprobe {want:?}", got.times);
        }
    }

    #[test]
    fn a_fragmented_file_is_not_read() {
        let mut moov = Track::obs().moov();
        moov.extend(bx(b"mvex", &[]));
        assert_eq!(index_of(&moov, 1), None);
    }

    #[test]
    fn a_keyframe_before_the_edit_shows_at_zero() {
        // An edit starting later than the first keyframe's pts.
        let got = index(&Track { elst: Some(vec![(10_000, 1024)]), ..Track::obs() }).unwrap();
        assert_eq!(got.times[0], 0.0);
        assert!((got.times[1] - (250.0 * 256.0 + 512.0 - 1024.0) / 15360.0).abs() < 1e-9);
    }

    #[test]
    fn the_length_is_the_samples_less_the_edit_start() {
        // 300 frames of 1001 at 30000 (29.97 fps) with a 2002-tick edit
        // start: 9.9433 s. Without the edit taken out, 10.01.
        let t = Track {
            timescale: 30_000,
            samples: 300,
            stts: vec![(300, 1001)],
            ctts: Some((0, vec![(300, 2002)])),
            stss: Some(vec![1, 121, 241]),
            elst: Some(vec![(10_000, 2002)]),
            ..Track::obs()
        };
        let got = index(&t).unwrap();
        assert!((got.duration - (300.0 * 1001.0 - 2002.0) / 30_000.0).abs() < 1e-12, "{}", got.duration);
    }

    #[test]
    fn the_size_is_the_whole_file() {
        // ftyp + moov + an mdat of an odd length: the size is all three, not
        // the moov alone.
        let dir = std::env::temp_dir().join(format!("taroting-keyframes-size-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sized.mp4");
        let moov = bx(b"moov", &Track::obs().moov());
        let ftyp = bx(b"ftyp", b"isom\0\0\x02\0");
        let mdat = bx(b"mdat", &vec![0x5a; 12_345]);
        std::fs::write(&file, [ftyp.clone(), moov.clone(), mdat.clone()].concat()).unwrap();
        let got = keyframe_index(&file);
        let _ = std::fs::remove_dir_all(&dir);
        let got = got.expect("a plain MP4 is read");
        assert_eq!(got.bytes, (ftyp.len() + moov.len() + mdat.len()) as u64);
        assert_eq!(got.bytes, 16 + moov.len() as u64 + 12_353);
    }

    /// The answer for a REAL file equals ffprobe's own keyframe list: libx264
    /// with B-frames (so `ctts` and the edit list that takes the B-frame delay
    /// back out are both there), a GOP of 25 at 30 fps that is neither a whole
    /// second nor a divisor of the length, and a scene cut forced off-grid.
    #[test]
    fn matches_ffprobe_on_a_real_encode() {
        use crate::jobs::ffmpeg;
        let dir = std::env::temp_dir().join(format!("taroting-keyframes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("gop25.mp4");
        let out = ffmpeg::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4.3"])
            .args(["-c:v", "libx264", "-preset", "veryfast", "-bf", "2", "-g", "25", "-keyint_min", "25"])
            .args(["-force_key_frames", "1.9", "-pix_fmt", "yuv420p"])
            .arg(&file)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let probe = ffmpeg::command("ffprobe")
            .unwrap()
            .args(["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey"])
            .args(["-show_entries", "frame=pts_time", "-of", "csv=p=0"])
            .arg(&file)
            .output()
            .unwrap();
        let want: Vec<f64> = String::from_utf8_lossy(&probe.stdout)
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(',').parse().ok())
            .collect();
        let got = keyframe_index(&file).expect("a plain MP4 is read");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!got.all_sync);
        assert!(want.len() >= 5, "ffprobe listed {want:?}");
        assert_eq!(got.times.len(), want.len(), "{:?} vs ffprobe {want:?}", got.times);
        for (g, w) in got.times.iter().zip(&want) {
            assert!((g - w).abs() < 1e-3, "{:?} vs ffprobe {want:?}", got.times);
        }
    }

    #[test]
    fn the_command_refuses_a_path_that_is_not_a_file() {
        assert!(tauri::async_runtime::block_on(keyframe_times("relative.mp4".into())).is_err());
        assert!(tauri::async_runtime::block_on(keyframe_times(String::new())).is_err());
    }

    #[test]
    fn the_command_runs_off_the_ui_thread() {
        // Project rule: anything that touches the disk is async.
        let code = include_str!("keyframes.rs");
        assert!(code.contains("pub async fn keyframe_times("));
        assert!(code.contains("spawn_blocking(move || keyframe_index(&file))"));
    }
}
