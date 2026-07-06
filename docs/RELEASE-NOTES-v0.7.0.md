# Taroting 0.7.0

Four new features. Free and open source, as always.

## New

- **Volume control** — a speaker button with a slider in the transport bar and in fullscreen playback. It adjusts your listening level only (per-clip audio and exports are untouched), remembers your last level, and click-to-mute restores the previous volume.
- **Select projects on the home screen** — enter Select mode, pick as many projects as you want, and delete them together after a clear confirmation. Esc leaves the mode; Select all respects your current search filter.
- **Quick view from File Explorer** (Settings, off by default) — with it on, media opened from File Explorer becomes a *temporary* project so you can use Taroting as a quick viewer without filling your library. When you leave the editor, Taroting asks whether to keep the project or discard it — nothing is saved unless you choose to keep it.
- **Delete layers** — right-click a lane to remove it. Empty layers delete instantly; layers with clips ask first. Fully undoable with Ctrl+Z.

## Fixed

- Home-screen covers now appear for projects whose topmost layer is empty (the cover is taken from the earliest clip across all video layers).

## Downloads

- **`Taroting-v0.7.0-portable-win64.zip`** — unzip and run `Taroting.exe`; no installation.
- **`Taroting_0.7.0_x64-setup.exe`** — per-user install with Start-menu entry, desktop shortcut, and `.trt`/media file associations. No admin rights needed. Windows SmartScreen may warn because the app is not yet code-signed — choose "More info" → "Run anyway".
