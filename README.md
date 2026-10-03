# Taroting

A free, open-source, ultra-lightweight, fully-offline desktop video editor.

**Taroting is 100% free and open source** — every feature, forever. No account, no sign-up, no tiers, no trial, no watermark, no strings attached. Released under the [GPL-3.0](LICENSE): download it, use it, study it, and modify it however you like.

Taroting launches in a fraction of a second, stays out of your way, and does the essentials — import, trim, split, arrange, composite, animate, adjust audio, export — without a project account, a cloud round-trip, or a background updater. It is built as a native [Tauri 2](https://tauri.app) (Rust) shell around vanilla TypeScript, with [FFmpeg](https://ffmpeg.org) bundled as a sidecar for all media work. No UI framework, no runtime JS dependencies beyond the Tauri API bindings, no telemetry, no network calls — ever.

> **Status: early development.** Feature-complete for its scope but not yet code-signed.
>
> **Platforms:** Windows is supported today; Linux and macOS support is planned.

## Highlights

**Editing**
- Frame-accurate timeline: cut, trim, split, move, and ripple-delete clips
- Snap-to-cut, frame stepping, and playhead seeking
- Resizable timeline panel — drag the divider above the transport; the height persists
- Unlimited undo/redo, autosave, and portable `.trt` project files (plain JSON — your original media is never modified)
- Home screen project management: rename, duplicate, delete, multi-select, sort

**Layers, keyframes, and markers**
- Unlimited video layers with z-stacked compositing
- Keyframe animation for position, scale, and opacity (diamond toggles in the inspector, auto-keying while you adjust)
- Timeline markers (`M` key) in six colors — drag to move, click to seek

**Canvas manipulation**
- Move, scale, and crop clips directly on the preview canvas: drag to move, corner handles to scale, double-click for Google-Slides-style crop mode
- Fit / fill / center helpers and snap guides for alignment

**Playback & appearance**
- Fullscreen theater playback with auto-hiding controls
- Monitor volume for preview listening — never baked into clips or exports
- Three built-in looks plus fully custom theme colours (Settings → Appearance), used exactly as picked

**Generators**
- Text (at any size) and solid-color generated media, placed like any other clip

**Export**
- MP4 / MOV / WebM / AVI / GIF containers
- H.264 / H.265 / AV1 codecs, with hardware encoding (NVENC / QSV / AMF) when available
- Layers, keyframes, and text render faithfully in the export
- Project canvas presets (16:9, 9:16, 4:3, 1:1, 21:9) or a fully custom size

**Audio**
- Volume, mute, fade in/out, normalize, detach/restore, waveforms

**Image projects**
- Start blank (**New project → Image project**) or from your pictures (**Open**, then choose Image project)
- Pen with pressure, pencil, highlighter, eraser, lines, boxes, ellipses and arrows, and a ruler to draw along
- Exposure, brightness, contrast, highlights, shadows, saturation, hue, warmth and tint, previewed live
- Layers of photos, drawings, text and solid colour — move, scale, rotate, flip, crop and fade each one
- The canvas has its own controls: crop, resize, rotate, flip, and a transparent, white, black or chosen-colour background
- Export to PNG, JPEG or WebP, or copy the picture to the clipboard

**OS integration**
- `.trt` files open on double-click, straight into the project
- Videos, photos and music gain **Open with → Taroting** in Explorer's right-click menu, and Taroting is listed in Windows Settings → Apps → Default apps. **Taroting never changes which app opens your files unless you choose it** there yourself — double-clicking a video, photo or song keeps opening whatever it opened before
- A file opened with Taroting shows in a lightweight viewer (the arrows move through the folder in the same order as the File Explorer window you opened it from, or in name order when no Explorer window shows it) or, if you prefer, opens straight into a temporary project — choose in Settings
- Single-instance: opening a file focuses the already-running app
- Bin-first import — dropped media lands in the bin, then drag to the timeline or double-click to place at the playhead
- Right-click menus on clips, media, and home-screen project cards

**Import formats:** MP4, M4V, MOV, MKV, AVI, WebM, WMV, MTS/M2TS, 3GP, MPG/MPEG, GIF, MP3, WAV, FLAC, AAC, M4A, OGG, and PNG/JPEG/WebP/BMP. Drag and drop anywhere.

## Screenshots

<!-- TODO: drop screenshots into docs/screenshots/ and uncomment.
<img src="docs/screenshots/editor.png" alt="Taroting editor" width="800">
-->

## Download

Grab the latest build from the [**Releases**](../../releases) page. Two ways to run it:

- **Portable ZIP** — unzip the `Taroting-vX.Y-portable` folder anywhere and double-click `Taroting.exe`. Nothing is installed; keep `ffmpeg.exe` and `ffprobe.exe` alongside it (they do all media processing). Delete the folder to remove it.
- **Installer** (`Taroting_X.Y.Z_x64-setup.exe`) — installs per-user (no admin rights), adds a Start-menu entry, makes `.trt` projects open with Taroting, and offers Taroting under **Open with** (and in Default apps) for video, image and audio files — without changing which app currently opens them.

The app is not code-signed yet, so Windows SmartScreen may warn on first launch — choose **More info → Run anyway**.

## Performance

Performance is the project's #1 veto criterion: a release may not regress the previous release's cold start or idle RAM. On the reference machine (Windows 11, NVMe, WebView2 Evergreen):

| Metric | v0.9.0 |
|---|---|
| Start → window, first launch of a new build (incl. Defender scan) | ~0.13 s |
| Start → window (warm) | under 0.05 s |
| Idle RAM, home screen (app + WebView2) | ~364 MB |

Every feature runs entirely on your hardware and adds zero resource overhead when unused: unlimited layers, keyframes, markers, generators, and canvas manipulation sit idle for free. Memory only grows when you actually load and decode video (a single H.264 clip in the preview adds ~130 MB for the WebView2 media decoder, which is released when no video element is active). See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for the full method and numbers.

## Building from source

**Prerequisites**

- [Node.js](https://nodejs.org) 24+ and npm
- [Rust](https://rustup.rs) stable (MSVC toolchain)

**Build**

```sh
npm install
npm run fetch-ffmpeg   # downloads the pinned ffmpeg/ffprobe into src-tauri/binaries/
npm run tauri dev      # run in development
npm run tauri build    # produce the NSIS installer + portable exe
```

The FFmpeg sidecars are **not** committed to the repo (they are large GPL binaries). `npm run fetch-ffmpeg` downloads one pinned build — gyan.dev `ffmpeg 8.1.1-full_build`, dated 2026-05-04 — checks the archive and both binaries against SHA-256 digests recorded in the script, confirms the encoder coverage the exporter needs, and installs them in `src-tauri/binaries/` using Tauri's target-triple naming convention. Every release ships that exact build; any mismatch aborts the run and leaves an existing install untouched. `npm run fixtures` generates synthetic test media.

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

Uninstalling (from Settings, or via the installer's uninstaller) removes the app, the `.trt` association, its **Open with** entries and its Default apps listing, and offers a **Delete the application data** checkbox — tick it to also clear your settings and cache, leave it to keep them for a future install. Either way it **keeps your projects** in `Documents\Taroting`. Nothing else is left on the system — every registry entry it created is removed, apart from one small key that remembers the install folder (ticking **Delete the application data** removes that too); other apps' entries are left exactly as they were, and there are no background services. If you had chosen Taroting as the default for a file type, Windows simply asks which app to use the next time you open one.

Installing a new version over an old one keeps your settings, recent projects and cache.

## License

[GPL-3.0-or-later](LICENSE). The bundled FFmpeg is a GPL build by [gyan.dev](https://www.gyan.dev/ffmpeg/builds/); redistributing Taroting binaries therefore carries FFmpeg's GPL obligations, including a source offer for the FFmpeg build.
