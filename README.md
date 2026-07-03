# Taroting

A free, open-source, ultra-lightweight, fully-offline desktop video editor for Windows.

**Taroting is 100% free and open source** — every feature, forever. No account, no sign-up, no tiers, no trial, no watermark, no strings attached. Released under the [GPL-3.0](LICENSE): download it, use it, study it, and modify it however you like.

Taroting launches in a fraction of a second, stays out of your way, and does the essentials — import, trim, split, arrange, composite, animate, adjust audio, export — without a project account, a cloud round-trip, or a background updater. It is built as a native [Tauri 2](https://tauri.app) (Rust) shell around vanilla TypeScript, with [FFmpeg](https://ffmpeg.org) bundled as a sidecar for all media work. No UI framework, no runtime JS dependencies beyond the Tauri API bindings, no telemetry, no network calls — ever.

> **Status: early development.** Feature-complete for its scope but not yet code-signed; expect a Windows SmartScreen prompt on first run.

## Highlights

**Editing**
- Frame-accurate timeline: cut, trim, split, move, and ripple-delete clips
- Snap-to-cut, frame stepping, and playhead seeking
- Unlimited undo/redo, autosave, and portable `.trt` project files (plain JSON — your original media is never modified)

**Layers, keyframes, and markers**
- Unlimited video layers with z-stacked compositing
- Keyframe animation for position, scale, and opacity (diamond toggles in the inspector, auto-keying while you adjust)
- Timeline markers (`M` key) in six colors — drag to move, click to seek

**Canvas manipulation**
- Move, scale, and crop clips directly on the preview canvas: drag to move, corner handles to scale, double-click for Google-Slides-style crop mode
- Fit / fill / center helpers and snap guides for alignment

**Generators**
- Text and solid-color generated media, placed like any other clip

**Export**
- MP4 / MOV / WebM / AVI / GIF containers
- H.264 / H.265 / AV1 codecs, with hardware encoding (NVENC / QSV / AMF) when available
- Layers, keyframes, and text render faithfully in the export
- Project canvas presets (16:9, 9:16, 4:3, 1:1, 21:9) or a fully custom size

**Audio**
- Volume, mute, fade in/out, normalize, detach/restore, waveforms

**OS integration**
- `.trt` files open on double-click; "Open with Taroting" on media files
- Single-instance: opening a file focuses the already-running app
- Bin-first import — dropped media lands in the bin, then drag to the timeline or double-click to place at the playhead
- Right-click menus on clips, media, and home-screen project cards

**Import formats:** MP4, MOV, MKV, AVI, WebM, GIF, MP3, WAV, FLAC, AAC, and PNG/JPEG. Drag and drop anywhere.

## Screenshots

<!-- TODO: drop screenshots into docs/screenshots/ and uncomment.
<img src="docs/screenshots/editor.png" alt="Taroting editor" width="800">
-->

## Download

Grab the latest build from the [**Releases**](../../releases) page. Two ways to run it:

- **Portable ZIP** — unzip the `Taroting-vX.Y-portable` folder anywhere and double-click `Taroting.exe`. Nothing is installed; keep `ffmpeg.exe` and `ffprobe.exe` alongside it (they do all media processing). Delete the folder to remove it.
- **Installer** (`Taroting_X.Y.Z_x64-setup.exe`) — installs per-user (no admin rights), adds a Start-menu entry, and registers file associations so `.trt` projects and media files open with Taroting.

The app is not code-signed yet, so Windows SmartScreen may warn on first launch — choose **More info → Run anyway**.

## Performance

Performance is the project's #1 veto criterion: a release may not regress the previous release's cold start or idle RAM. On the reference machine (Windows 11, NVMe, WebView2 Evergreen):

| Metric | v0.6.0 |
|---|---|
| Cold start → window (first launch, incl. Defender scan) | ~1.25 s |
| Cold start → window (warm) | ~0.17 s |
| Idle RAM, home screen (app + WebView2) | ~358 MB |

Every feature runs entirely on your hardware and adds zero resource overhead when unused: unlimited layers, keyframes, markers, generators, and canvas manipulation sit idle for free. Memory only grows when you actually load and decode video (a single H.264 clip in the preview adds ~130 MB for the WebView2 media decoder, which is released when no video element is active). See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for the full method and numbers.

## Building from source

**Prerequisites**

- [Node.js](https://nodejs.org) 24+ and npm
- [Rust](https://rustup.rs) stable (MSVC toolchain)
- FFmpeg + ffprobe on your `PATH` — e.g. `winget install Gyan.FFmpeg`

**Build**

```sh
npm install
npm run fetch-ffmpeg   # copies ffmpeg/ffprobe from PATH into src-tauri/binaries/
npm run tauri dev      # run in development
npm run tauri build    # produce the NSIS installer + portable exe
```

The FFmpeg sidecars are **not** committed to the repo (they are large GPL binaries); `npm run fetch-ffmpeg` places them in `src-tauri/binaries/` using Tauri's target-triple naming convention and verifies the build's encoder coverage. `npm run fixtures` generates synthetic test media.

**Tests**

```sh
npm test               # TypeScript/domain unit tests (Vitest)
cargo test             # Rust tests (run from src-tauri/)
```

For the in-app end-to-end harness, launch dev with `TAROTING_AUTOTEST=1`. It builds a project from the synthetic fixtures, exercises real editor behavior (seeking, stepping, split/undo, keyframes, markers, export) against the actual video elements, and writes results to `%TEMP%\taroting-autotest-report.json`.

## Where your data lives

| What | Location |
|---|---|
| Projects | `Documents\Taroting\*.trt` (plain JSON; originals never touched) |
| Settings | `%APPDATA%\Taroting` |
| Cache | `%LOCALAPPDATA%\Taroting\cache` (safe to clear from Settings) |

Uninstalling (from Settings, or via the installer's uninstaller) removes the app and its cache/settings but **keeps your projects** in `Documents\Taroting`. Nothing else is left on the system — no registry cruft beyond the file associations it created, no background services.

## License

[GPL-3.0-or-later](LICENSE). The bundled FFmpeg is a GPL build by [gyan.dev](https://www.gyan.dev/ffmpeg/builds/); redistributing Taroting binaries therefore carries FFmpeg's GPL obligations, including a source offer for the FFmpeg build.
