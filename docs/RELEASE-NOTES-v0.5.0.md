# Taroting v0.5.0

The first packaged build of Taroting — an ultra-lightweight, fully-offline desktop video editor for Windows. Native Tauri 2 (Rust) shell, vanilla TypeScript, FFmpeg for all media work. No account, no cloud, no telemetry.

## What it does

- **Import** MP4, MOV, MKV, AVI, WebM, GIF, MP3, WAV, FLAC, AAC, and PNG/JPEG — drag and drop anywhere.
- **Edit** on a frame-accurate timeline: cut, trim, split, move, and ripple-delete clips, with snap-to-cut.
- **Transform** per clip: crop, rotate, flip, scale, position, opacity, speed.
- **Audio**: volume, mute, fade in/out, normalize, detach/remove, waveforms.
- **Export** to MP4 / MOV / WebM / AVI / GIF with H.264 / H.265 / AV1, using hardware encoding (NVENC / QSV / AMF) when available.
- Unlimited undo, autosave, and portable `.trt` project files (plain JSON — originals never touched).

## Keyboard shortcuts

`Space` play/pause · `S` split · `Del` delete · `Shift+Del` ripple delete · arrows step frames · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Ctrl+E` export · `Ctrl+mouse wheel` zoom timeline. All rebindable in Settings.

## Where your data lives

- Projects: `Documents\Taroting\*.trt`
- Settings: `%APPDATA%\Taroting`
- Cache: `%LOCALAPPDATA%\Taroting\cache` (safe to clear from Settings)

## Install

The app is not code-signed yet, so Windows SmartScreen may warn on first launch — choose **More info → Run anyway**.

- **Portable** — open the `Taroting-v0.5-portable` folder and double-click `Taroting.exe`. Keep `ffmpeg.exe` and `ffprobe.exe` next to it.
- **Installer** — run `Taroting_0.5.0_x64-setup.exe` (per-user, adds a Start-menu entry, no admin rights needed).

License: GPL-3.0 (bundled FFmpeg is a GPL build by gyan.dev).

## Downloads

- `Taroting-v0.5-portable.zip` — unzip and run, no installation
- `Taroting_0.5.0_x64-setup.exe` — installer
