# Taroting v0.6.0

A big step up from v0.5: unlimited layers, keyframe animation, timeline markers, on-canvas manipulation, generators, and deeper Windows integration — all pay-for-use, with idle cold-start and RAM at parity with v0.5 (see [`docs/PERFORMANCE.md`](PERFORMANCE.md)).

## New in 0.6

- **Unlimited video layers** with z-stacked compositing.
- **Keyframe animation** for position, scale, and opacity — diamond toggles in the inspector, auto-keying while you adjust.
- **Timeline markers** (`M` key): six colors, drag to move, click to seek.
- **Direct canvas manipulation**: drag to move, corner handles to scale, and double-click for Google-Slides-style crop mode.
- **Generators**: text and solid-color generated media, placed like any other clip.
- **Bin-first import workflow** — dropped media lands in the bin first; drag to the timeline or double-click to place at the playhead. Includes a media relink dialog.
- **Right-click menus** on clips, media, and home-screen project cards.
- **OS integration**: `.trt` files open on double-click, "Open with Taroting" on media files, and single-instance behavior (opening a file focuses the running app).
- **Export upgrades**: layers, keyframes, and text now render in the export; project canvas presets (16:9, 9:16, 4:3, 1:1, 21:9) or a fully custom size.
- **Uninstall from Settings** — the uninstaller removes app data but keeps your projects in `Documents\Taroting`.

## Fixes and hardening

- **Modal z-order**: dialogs now render above all editor chrome, including the preview canvas and inspector.
- **Cursor-pause bug**: fixed spurious pauses when moving the cursor during playback.
- **Snap guides**: alignment guides on the canvas now show and snap reliably.
- **Fit / fill / center**: canvas fit, fill, and center helpers corrected.
- **Uninstall hardening**: cleaner removal of app data and cache while preserving user projects.

## Keyboard shortcuts

`Space` play/pause · `S` split · `M` marker · `Del` delete · `Shift+Del` ripple delete · arrows step frames or nudge the selected clip on the canvas · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Ctrl+E` export · `Ctrl+mouse wheel` zoom timeline. All rebindable in Settings.

## Where your data lives

- Projects: `Documents\Taroting\*.trt`
- Settings: `%APPDATA%\Taroting`
- Cache: `%LOCALAPPDATA%\Taroting\cache` (safe to clear from Settings)

## Install

The app is not code-signed yet, so Windows SmartScreen may warn on first launch — choose **More info → Run anyway**.

- **Portable** — open the `Taroting-v0.6-portable` folder and double-click `Taroting.exe`. Keep `ffmpeg.exe` and `ffprobe.exe` next to it.
- **Installer** — run `Taroting_0.6.0_x64-setup.exe` (per-user, adds a Start-menu entry and file associations, no admin rights needed).

License: GPL-3.0 (bundled FFmpeg is a GPL build by gyan.dev).

## Downloads

- `Taroting-v0.6-portable.zip` — unzip and run, no installation
- `Taroting_0.6.0_x64-setup.exe` — installer
