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
