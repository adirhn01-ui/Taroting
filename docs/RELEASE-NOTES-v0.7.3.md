# Taroting 0.7.3

A correctness release. Several ways to lose work are gone, exports involving
text are fixed, and when something does go wrong you can finally copy the error
out. Free and open source, as always.

## Fixed

- **Exporting a project with a text or solid overlay that fades no longer
  fails.** If a generator had an opacity keyframe, the export died with a raw
  ffmpeg error. Fixing it uncovered a second problem in the same area: text was
  being squeezed into a thin strip at the top of its box instead of filling it,
  and a fading overlay came out as a translucent black rectangle rather than
  keeping its transparency. **Text now renders the way the selection box in the
  editor has always shown it, and the editor preview and the exported file
  finally agree.** Projects containing text will look different from 0.7.2 —
  they will look correct. Solid overlays are unchanged.
- **A save that fails no longer loses the project.** Saving writes a new file and
  then swaps it in. If that swap was interrupted — a backup tool or antivirus
  holding the file, or the machine losing power — the project could disappear
  entirely even though a complete copy was sitting right next to it. Saving is
  now safe in both directions, and Taroting restores from that copy on its own.
- **One damaged project can no longer empty your home screen.** A project file
  with an out-of-range length made the recent-projects list unreadable, and every
  other project's card silently vanished. Your files were always still on disk;
  now the list survives, and a project that only exists as a backup copy stays
  reachable instead of disappearing.
- **Settings survive a damaged settings file.** A corrupt or hand-edited value
  used to reset everything — theme, autosave, folders, shortcuts — and then
  overwrite the good copy. Values are now checked as they are read, and the
  backup copy is used when the main one is unreadable.
- **Relinking an image no longer makes its clips disappear.** Because images have
  no duration, relinking one shrank its clips to nothing with no warning.
  Relinking also now updates the replacement's real size, kind and audio, so a
  file of a different shape is no longer stretched to the old one's proportions.
- **Text export works for every Windows account name.** If your account name
  contained an apostrophe, every export of every project containing text failed.
- **Opening a file from Explorer no longer discards a quick-view project.** It
  now asks whether to keep the temporary project first, like the Back button
  already did.
- **Slow-motion clips keep their keyframes in order.** At 0.25× and 0.5×,
  keyframes placed close together could overwrite each other and end up out of
  sequence, which produced wrong animation on export.
- **Normalize refuses a silent selection** instead of applying an enormous gain
  that later turned into distorted audio.
- **Keyboard shortcuts no longer fire behind an open dialog.** Pressing Delete
  with the export window open could delete the selected clip without showing it.
- Cancelling an export now always stops ffmpeg, a damaged project file can no
  longer close the app on open, and a few other crashes on unusual files are
  fixed.

## Improved

- **You can copy an error now.** The failed-export view shows its details
  expanded, selectable and copyable, with **Copy details** and **Save report**.
  The report gathers the app and ffmpeg versions, the export settings, what
  ffmpeg was asked to do and what it said, and a description of the project's
  shape — enough to reproduce a problem. File names, folders, the project name
  and the words in your text overlays are replaced with placeholders, media
  details like size and codec are kept because those are what reproduce a bug,
  and the whole report is shown to you before it goes anywhere. Nothing is ever
  sent anywhere: Taroting has no network access, and you decide whether to share.
- **Error messages no longer vanish for good.** A notification with more behind
  it now offers **Details**, and Settings gained a Diagnostics section listing
  this session's errors and offering the same report when nothing has failed.

## Downloads

- **`Taroting-v0.7.3-portable-win64.zip`** — unzip and run `Taroting.exe`; no installation.
- **`Taroting_0.7.3_x64-setup.exe`** — per-user install with Start-menu entry, desktop shortcut, and `.trt`/media file associations. No admin rights needed. Windows SmartScreen may warn because the app is not yet code-signed — choose "More info" → "Run anyway".
