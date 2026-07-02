# Taroting

An ultra-lightweight, offline desktop video editor for Windows. The video-editing equivalent of Notepad++ or SumatraPDF: it launches instantly, stays out of your way, and does the essentials — trim, split, arrange, adjust audio, export — exceptionally fast.

> **Status: early development.** Not yet ready for daily use.

## Philosophy

- **Instant.** Opens in well under a second. Every interaction responds immediately.
- **Local.** No accounts, no cloud, no telemetry, no AI, no network calls — ever.
- **Non-destructive.** Your original media files are never modified.
- **Small.** A handful of megabytes of app code, minimal RAM, minimal dependencies.
- **Calm.** A quiet, modern interface. No clutter, no nested menus, no floating windows.

## Features (v1 scope)

- Single video track + multiple audio tracks
- Trim, split, move, ripple delete, snap-to-cut, frame-accurate seeking
- Crop, rotate, flip, scale, position, opacity, speed
- Volume, mute, fade in/out, normalize, detach/replace audio, waveforms
- Import: MP4, MOV, MKV, AVI, WebM, GIF, MP3, WAV, FLAC, AAC, PNG/JPEG sequences
- Export: MP4 / MOV / WebM / AVI / GIF · H.264 / H.265 / AV1 · hardware encoding (NVENC/QSV/AMF)
- Unlimited undo, autosave, portable project files (`.trt`)

## Building from source

Prerequisites: [Node.js](https://nodejs.org) ≥ 20, [Rust](https://rustup.rs) (MSVC toolchain), FFmpeg on PATH (e.g. `winget install Gyan.FFmpeg`).

```
npm install
npm run fetch-ffmpeg   # copies ffmpeg/ffprobe sidecars into src-tauri/binaries
npm run tauri dev      # run in development
npm run tauri build    # build installer + portable exe
```

## Tech

Tauri 2 (Rust) · vanilla TypeScript · FFmpeg. No UI framework, no runtime dependencies beyond the Tauri API bindings.

## License

[GPL-3.0](LICENSE). Bundled FFmpeg builds are GPL; see THIRD_PARTY_LICENSES (added before first release) for notices and source offers.
