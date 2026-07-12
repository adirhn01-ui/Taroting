# Taroting 0.7.1

An audio fix. Free and open source, as always.

## Fixed

- **Video audio now plays reliably.** Two related problems are fixed: some videos with a perfectly good audio track played silently in Taroting (while playing fine in other players), and — the one you'd hit most — **audio could cut out and stay muted after jumping around the timeline** (clicking the ruler or dragging the playhead to a new frame). Both came down to the audio mixer not re-syncing a video's volume envelope after its position changed. Playback audio is now covered by an automated test that measures the actual audio signal across seeks and scrubs, so this class of bug can't ship silently again.

## Downloads

- **`Taroting-v0.7.1-portable-win64.zip`** — unzip and run `Taroting.exe`; no installation.
- **`Taroting_0.7.1_x64-setup.exe`** — per-user install with Start-menu entry, desktop shortcut, and `.trt`/media file associations. No admin rights needed. Windows SmartScreen may warn because the app is not yet code-signed — choose "More info" → "Run anyway".
