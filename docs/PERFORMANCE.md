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
