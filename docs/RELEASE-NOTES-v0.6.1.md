# Taroting 0.6.1

A stability and consistency release: a full-codebase audit of v0.6.0, with every confirmed finding fixed and adversarially re-verified.

## Fixed

- **Playhead could freeze mid-playback** — seeking or editing while playing could race an internal play/pause token and silently pause the master video while the transport still showed "playing". The token now distinguishes a real pause from a routine re-activation.
- **Single-keyframe animations now export correctly** — a property with exactly one keyframe (what you get the moment you toggle animation on) was exported with its old static value instead of the keyframe value. Export now matches the preview for every keyframe count.
- **Relinking to a shorter file** can no longer collapse clips to zero length or point past the end of the new source — in/out points are clamped sanely.
- **Replacing a media file with same-size content** is now detected on project load (previously the old cached preview/waveform/thumbnails were served silently).
- **Click-to-select on the canvas** no longer micro-nudges the clip or creates an empty undo entry — gestures only start after a small drag threshold, matching the timeline.
- **Odd-dimension GIF as the first import** no longer sets an odd canvas size (which exported 1 px smaller than shown).
- **Renaming a project to its own name** no longer appends a spurious " (2)" to the filename.
- **App icon is now consistent everywhere in Windows** — the executable previously kept an old embedded icon due to a build-caching quirk; Explorer, the taskbar, shortcuts, and the in-app brand mark now all show the same accent-blue mark.

## Downloads

- **`Taroting-v0.6.1-portable-win64.zip`** — unzip and run `Taroting.exe`; no installation.
- **`Taroting_0.6.1_x64-setup.exe`** — per-user install with Start-menu entry, desktop shortcut, and `.trt`/media file associations. No admin rights needed. Windows SmartScreen may warn because the app is not yet code-signed — choose "More info" → "Run anyway".
