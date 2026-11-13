# Performance record

Performance is the project's #1 veto criterion: a release may not regress the
previous release's cold start or idle RAM. Numbers below are for the release
build on the reference machine (Windows 11, NVMe, WebView2 Evergreen).

## Method

Same procedure for every release:

- **Cold start → window**: `Start-Process <exe>` and poll `MainWindowTitle`
  every 25 ms until it is non-empty; elapsed stopwatch time is the number.
  The first-ever launch of a new binary includes the Windows Defender scan;
  both first-launch and warm numbers are recorded.
- **Idle RAM**: after ~6 s of idle on the home screen, sum the working sets of
  `taroting.exe` plus every `msedgewebview2.exe` process whose command line
  references Taroting.

## v0.6.0 (2026-07-03)

| Metric | v0.5.0 baseline | v0.6.0 | Verdict |
|---|---|---|---|
| Cold start → window (first launch, Defender scan) | ~1.2 s | 1.25 s | parity |
| Cold start → window (warm) | — (not recorded) | 0.17 s | — |
| Idle RAM, home screen (app + WebView2) | ~353 MB | 358 MB (26 + 332, 6 procs) | parity (+1.4%) |

Context (not part of the gate): with a plain single-layer, keyframe-less
project open (one H.264 clip loaded in the preview `<video>`), total RAM
measured 489 MB — the extra ~130 MB is the WebView2 media decoder process
that exists only while a video element is active.

v0.6 adds unlimited layers, keyframes, markers, generators, canvas
manipulation and OS integration; every feature adds zero resource overhead when
unused — the idle and single-layer numbers match v0.5 within measurement noise.

## v0.7.2 (2026-07-25)

| Metric | v0.6.0 | v0.7.2 | Verdict |
|---|---|---|---|
| Start → window (warm, best of 4) | 0.17 s | 0.047 s | no regression |
| Start → window (warm, median of 4) | — | 0.048 s | — |
| Idle RAM, home screen (app + WebView2) | 358 MB (26 + 332, 6 procs) | 368 MB (28 + 340, 6 procs) | parity (+2.8%) |

v0.7.2 is a dependency + optimization release with no new features. Two changes
should reduce steady-state work rather than start-up:

- the timeline canvas no longer runs a permanent `requestAnimationFrame` pump —
  it schedules a frame on demand, so an idle or paused editor renders nothing;
- `syncLayerCount` no longer detaches and re-attaches every layer set on each
  seek, which was rebuilding the `<video>` elements' layout and compositing
  state on every scrub pointermove.

Neither shows up in the two numbers above (both are measured at rest on the home
screen, before a project is open); they matter during scrub/drag gestures and at
idle. Idle RAM is unchanged within noise, which is the result the veto asks for.

**Measurement caveat, recorded so the next release does not over-read this
table:** the warm figures were taken on an already-warm machine with WebView2
caches populated, and no true first-ever-launch number was captured for v0.7.2 —
the binary had already been touched by the build and by Defender before timing.
The v0.6.0 first-launch figure (1.25 s, including a cold Defender scan) is
therefore **not** comparable to anything in this row, and the warm improvement
from 0.17 s should be read as "well within baseline", not as a change earned by
this release. To get a comparable cold number, time a freshly downloaded binary
on a machine that has never seen it.

## v0.9.0 — method additions

v0.9.0 adds the folder viewer, which is the first screen a media file opened
from Explorer lands on. The two measurements above cannot see it: "start →
window" stops at the first non-empty title, before any route work, and "idle
RAM" is taken on the home screen. These are added, on the same machine and the
release exe, and the tables are filled by that run.

- **Explorer launch → viewer on file**: `Start-Process <exe> -ArgumentList
  '"<file>"'` and poll `MainWindowTitle` every 25 ms until it CONTAINS the
  file's name. The viewer sets the title to `<name> — Taroting` as soon as it
  mounts on that file, before the file is probed or decoded — so this times
  the open route and the viewer's mount, not just the window; the first
  decoded frame is NOT included. Cold (no instance running) and warm (the same
  measurement against a running instance — the single-instance hand-off plus
  the viewer's in-place swap).
- **Warm swap**: with the viewer already showing a file, open a second file
  from Explorer and time until the title names it.
- **Viewer idle RAM**: the same sum as "Idle RAM" (the app plus its WebView2
  processes), ~6 s after the viewer settles, in three states: a still shown; a
  paused 1080p H.264 clip; and 10 s after flipping through 20 photos of
  24–48 MP (the memory must come back, not accumulate).
- **Viewer idle CPU**: total CPU time of the same processes across 30 s of
  idle, once on a still and once on a paused video. The viewer runs no
  animation loop, so both should be indistinguishable from the home screen.
- **Home idle RAM** is re-measured unchanged — the viewer chunk is lazy and
  must add nothing until a file is opened.
- **Cache growth**: the preview cache size before and after the viewer run, so
  clips that had to be remuxed or prepared show up as what they wrote.

| Metric | v0.8.1 | v0.9.0 | Verdict |
|---|---|---|---|
| Start → window (warm) | 38.4 ms | 31.0 ms | parity (median of 14 each; see note) |
| Idle RAM, home screen (app + WebView2) | 360.7 MB | 363.6 MB | parity (+0.8%, median of 3) |
| Explorer launch → viewer on file, cold (title names the file) | — | 248 ms | — |
| Explorer launch → viewer on file, warm | — | 31.6 ms | — |
| Warm swap (second open while viewing) | — | 31.1 ms | — |

| Viewer state | RAM (app + WebView2) | 30 s idle CPU |
|---|---|---|
| Still shown | 374.0 MB | 0.05 s |
| A 720p H.264 clip playing (it autoplays; not paused) | 460.8 MB | 1.71 s |
| After 20 photos of 24 MP, +10 s | 385.5 MB (peak 406.1 MB) | — |
| Home screen, for comparison | 363.6 MB | 0.17 s (0.8.1: 0.11 s) |

| Cache | Before | After | Note |
|---|---|---|---|
| Preview cache size | 0.06 MB | 0.06 MB | the clip plays direct; nothing prepared |

Measured 2026-09-30 on the reference machine: the v0.8.1 portable from the
release folder against the 0.9.0 release exe, one scripted session, launches
interleaved 0.8.1 / 0.9.0 / 0.9.0 / 0.8.1. First launch of each binary: 119 ms
and 127 ms (the 0.9.0 exe was new to Defender). Notes on the method:

- "Window" is now a VISIBLE, non-minimized window of the process titled
  "Taroting" (or naming the file), found by enumerating the process's
  windows. `MainWindowTitle` alone can report the single-instance plugin's
  hidden `com.taroting.app-siw` window, which exists before the real one.
- The poll sleeps 20 ms and Windows timers tick at ~15.6 ms, so every
  window-level time here lands on 31 or 46 ms: the start and warm numbers
  mean "under ~50 ms", and a difference between them is not a real one. The
  cold viewer launch (248 ms) is well above that floor.
- Warm = an instance already on Home; the Explorer launch hands the file over
  and exits. The 24 MP photos were generated for the run (testsrc2, 6000×4000
  JPEG) and opened one after another into the running viewer the same way,
  so they are loaded and replaced as a user flipping through them would.

## v0.9.0 — opening a file without Home first (A/B)

From v0.9.0, a file opened from Explorer (a video, photo, song or `.trt`)
goes straight to where it belongs — the viewer, or the editor — instead of
mounting the home screen first and navigating away from it. A plain launch
takes exactly the old path. Both claims are checked, not assumed: this is an
A/B of two builds of the same release, not a release-over-release row. A
`.trt` launch and an editor-mode file launch skip Home whatever the timing
shows (a product decision); what the timing decides is the viewer-mode launch.

- **Binaries**: A = the release exe built just before the change, B = the
  release exe with it. Each sits in its own folder with `ffmpeg.exe`,
  `ffprobe.exe` and, from the shared FFmpeg build on, the FFmpeg libraries
  (`avcodec-62.dll` and the rest) beside it. Same machine, same session,
  same files.
- **Pre-flight** (the run refuses to start otherwise): no `taroting.exe` is
  running from ANY path. An installed copy shares the single-instance
  identity, so a test launch would be handed to that window — timing nothing
  and disturbing whatever is open there. `%APPDATA%\Taroting\settings.json`
  and the recents file are backed up first and restored at the end, verified
  byte for byte. Viewer mode is `"openWith": "viewer"` in settings.json,
  editor mode `"openWith": "editor"` (UTF-8, no BOM); A and B read the key
  identically.
- **Timing**: a stopwatch started immediately before `Start-Process -PassThru`,
  then `MainWindowTitle` polled every 25 ms until the stop condition below.
  - **M1 — plain launch**: no argument; stop at the first non-empty title.
  - **M2 — viewer-mode file launch**: `-ArgumentList '"<file>"'`; stop when the
    title CONTAINS the file's name. Two files: a 1080p H.264 `.mp4` and a
    12 MP `.jpg`.
  - The title stops the clock before the first decoded frame; what is timed is
    start-up plus the route to the file's screen.
- **M3 — editor-mode launches, by eye (not timed)**: in the same session, with
  B only, launch the same `.mp4` in editor mode (a temporary project) and a
  `.trt` (a copy made for the run, never a real project). Pass: the editor
  appears without Home showing first. A is the build from before the change
  and still shows Home first on these launches — that is the difference being
  checked, not a failure of A.
- **Order**: each iteration runs A, B, B, A (ABBA, so drift over the session
  falls on both), N = 9 iterations per timed measure (M1, M2). Each launch is closed by its
  tracked PID, and the next one waits (at most 10 s) until no
  `msedgewebview2.exe` whose command line holds `com.taroting.app` remains.
  Each binary's very first launch includes the Defender scan and is recorded
  separately, never in the medians. Editor-mode runs leave temporary projects
  behind; at the end the temporary-projects folder is empty, or holds only
  the last editor-mode run's file. Every launch clears that folder, so
  anything in it before the run was scratch the next launch would have
  removed anyway.
- **Decision** (tolerance T = max(10 ms, 5% of A's median)):
  - M1: |median B − median A| ≤ T. The change is not reached on a plain
    launch, so a miss can only be noise — rerun M1 with N = 15.
  - M2: median B ≤ median A + T. B is expected to be faster (no home
    screen, no recents or thumbnail work competing with the open).
  - A miss on M2 reverts the no-Home-first opening for viewer-mode launches;
    editor-mode and `.trt` launches skip Home regardless. The fix that finds
    the file in the launch arguments (an install path with a space in it) is
    kept either way.
  - M3 must pass by eye; a miss there is a defect to fix, not a revert.
    Whether the home screen still flashes up first on a viewer-mode launch
    is judged by eye too; the title cannot show it.

| Measure | Launch | A median | B median | B − A | T | Verdict |
|---|---|---|---|---|---|---|
| M1 | Plain launch | 43.3 ms | 44.2 ms | +0.9 ms | 10 ms | Unchanged |
| M2 | 720p H.264 `.mp4` (30 s clip), viewer mode | 295.0 ms | 249.3 ms | −45.7 ms | 14.8 ms | Faster — ships |
| M2 | 12 MP `.jpg`, viewer mode | — | — | — | — | Not measured in the 2026-09-29 run |

Measured 2026-09-29 on the reference machine: N = 9 rounds of A B B A (18
launches per binary per measure), owner settings restored byte for byte
afterwards.

| Measure | Launch (B only, by eye) | Editor without Home first? |
|---|---|---|
| M3 | 1080p H.264 `.mp4`, editor mode | |
| M3 | `.trt` | |

| Binary | First launch (incl. Defender scan) |
|---|---|
| A | 168 ms |
| B | 120 ms |

## v0.9.1 to v0.9.5 (2026-11-12)

No rows were recorded for 0.9.1 through 0.9.4 when they shipped. All six
builds from 0.9.0 to 0.9.5 were measured in one scripted session on the
reference machine, four minutes after a restart: the 0.9.0 to 0.9.4 portable
builds from their release folders and the 0.9.5 release exe, each with
`ffmpeg.exe` and `ffprobe.exe` beside it. WebView2 runtime 157.0.4341.46.

Method, where it differs from the sections above:

- **Window** is the first visible, non-minimized, titled top-level window of
  the process, found by enumerating its windows every 2 ms. Windows timers
  still tick at about 15.6 ms, so window-level times land on multiples of
  that: "15 ms" means "within one tick", and 233 against 248 ms is one tick.
- **Every launch is closed the way a user closes it** (`WM_CLOSE` to that
  window), never ended by its process id. Since 0.9.1 an instance that is
  ended from outside leaves a marker, and the next launch reports that
  Taroting closed unexpectedly: a run that ended its launches would both
  disturb the next measurement and leave that notice for the user. No launch
  in this run had to be ended; no marker was left.
- **Order**: every round runs all builds, and the order is reversed each
  round, so drift over the session falls on all of them alike.
- **Test files have no sound track**: a 1080p30 H.264 clip (20 s, 5 Mbit/s),
  a 12 MP JPEG, and a silent stream copy of a 65 s 1080p60 screen recording
  at 63 Mbit/s with a keyframe every 4.17 s.
- Settings and recents were backed up first and compared afterwards: byte
  for byte unchanged. The cache gained only the scrub copies the run made.

| Metric | 0.9.0 | 0.9.1 | 0.9.2 | 0.9.3 | 0.9.4 | 0.9.5 | Verdict |
|---|---|---|---|---|---|---|---|
| Start → window, warm (median of 9) | 15.9 ms | 15.4 ms | 15.3 ms | 15.5 ms | 15.4 ms | 15.6 ms | parity (one tick) |
| Idle RAM, home screen (median of 3) | 358.2 MB | 357.6 MB | 360.3 MB | 361.0 MB | 358.2 MB | 358.6 MB | parity |
| Idle CPU, home screen, 10 s | 0.02 s | 0.05 s | 0.02 s | 0.03 s | 0.02 s | 0.00 s | parity |
| Explorer launch → viewer on file, cold (median of 5) | 232.9 ms | 232.8 ms | 232.6 ms | 232.8 ms | 232.7 ms | see below | parity |
| File handed to a running instance (median of 3) | 30.6 ms | 30.5 ms | 30.7 ms | 30.5 ms | 30.7 ms | 30.6 ms | parity |
| Viewer RAM, a 12 MP still (two runs) | 380.5 / 379.0 | 378.5 / 378.7 | 378.8 / 378.5 | 382.8 / 379.5 | 387.7 / 379.8 | 380.6 / 384.0 | parity |
| Viewer RAM, the 1080p clip playing (two runs) | 424.7 / 427.1 | 425.5 / 422.0 | 424.3 / 425.7 | 424.3 / 426.5 | 431.5 / 419.7 | 418.2 / 421.6 | parity |

The 0.9.5 column is the release exe as fixed (see the next section). Its home
RAM, viewer RAM and cold viewer launch were measured in a second pass twenty
minutes later against 0.9.4 again, where 0.9.4 read 358.5 MB on Home,
380.1 / 379.6 MB on the still, 421.7 / 421.9 MB on the clip, and 247.5 ms for
the cold viewer launch against 0.9.5's 247.8 ms (both one tick later than in
the first pass: the machine, not the builds).

First launch of each binary since the restart, recorded apart from the
medians: 0.9.5 61 ms (the very first launch after boot), 0.9.4 46 ms, and
108 to 110 ms for 0.9.0 to 0.9.3.

Five releases that added the PDF viewer and editor, the font library and the
viewer's scrubbing leave start-up and memory where 0.9.0 had them.

## v0.9.5 — a start-up regression caught by this run, and its guard

The first 0.9.5 build measured heavier than every earlier build on every
screen, by a small and steady amount:

| Metric | 0.9.4 | 0.9.5, first build | 0.9.5, fixed |
|---|---|---|---|
| Idle RAM, home screen | 358.2 MB | 367.4 MB | 358.6 MB |
| Explorer launch → viewer on file, cold | 232.7 ms | 248.7 ms | parity with 0.9.4 in the same pass |
| Viewer RAM, a 12 MP still | 387.7 / 379.8 MB | 395.3 / 395.0 MB | 380.6 / 384.0 MB |
| Viewer RAM, the 1080p clip playing | 431.5 / 419.7 MB | 436.6 / 435.4 MB | 418.2 / 421.6 MB |

The defect was ours, in how the app was bundled, and no source file was
wrong. 0.9.5 gave pdf-lib a second lazy importer (an image project exported
as a PDF, beside the PDF export). The bundler then made a shared chunk for
pdf-lib and placed its own small module-namespace helper in the same file.
Every chunk that uses that helper, the start-up chunks and the viewer's among
them, imported it statically, and so loaded and evaluated 420 kB of PDF
writer for nothing: start-up went from 106 kB of script to 526 kB.

The fix gives pdf-lib a chunk of its own (`vite.config.ts`). The guard is
`scripts/check-boot.mjs`, run at the end of `npm run build`: it follows the
static imports of the built entry chunk and of the viewer chunk and fails the
build when either loads more than its budget (135 kB at start-up, measured
106 kB; 60 kB more for the viewer, measured 40 kB) or any single chunk over
150 kB. It fails on the first 0.9.5 build and passes on the fixed one. A
source-level import test could not have seen this: the imports were right
and the built files were not.

## v0.9.5 — the viewer's scrub copy

New in 0.9.5: for a heavy clip the viewer makes a small all-keyframe copy in
the background and shows it while the seek bar is dragged. A clip is heavy
when its keyframes are two seconds or more apart and it runs at 20 Mbit/s or
more; every other file, and every other screen, does none of this work. The
only new work for a light clip is one read of the file's keyframe index
(sample tables, no decoding, off the UI thread) once it has stayed on screen
for a second.

Measured on the 65 s, 63 Mbit/s recording, playing in the viewer:

| | 0.9.4 | 0.9.5 |
|---|---|---|
| Making the copy | — | starts 2 s after the clip is shown, takes about 5 s, 8.0 s of CPU at below-normal priority |
| The copy on disk | — | 30.5 MB in the preview cache (counted and trimmed with it) |
| RAM, 3 s after the title names the file | 511 / 520 MB | 527 / 528 MB |
| RAM, peak over the first 30 s | 551 / 559 MB | 556 / 556 MB |
| App + WebView CPU over those 30 s | 5.2 / 6.0 s | 4.8 / 4.8 s |

The 0.9.5 figures are from the fixed build with the copy already made, so its
second `<video>` is loaded from the start: it adds on the order of 10 MB
early on and nothing measurable at the peak. The job itself is one `ffmpeg`
process on its own queue, so it never delays a thumbnail, a remux or a
repair.
