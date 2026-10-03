# Taroting 0.9.1

A quality release. It began with a bug report: a project with a video was
open, a video was opened from File Explorer at the same moment, and Taroting
closed itself without a word (the second try worked). Tracing it found a
mistake in how Taroting was built, explained below, and turned into a full
review of 0.9.0; this release is what that review found and fixed. There are
no new features; everything here makes Taroting steadier, lighter while it
works, and safer with your work. Free and open source, as always.

## If Taroting ever closes unexpectedly

- **It now leaves a note.** If Taroting closes on its own, the next launch
  says "Taroting closed unexpectedly last time." and **Settings →
  Diagnostics** holds the details, ready to copy, with your folder and file
  names taken out. The note is a small text file in
  `%LOCALAPPDATA%\Taroting`; nothing is ever sent anywhere.
- **A blank window recovers by itself.** If the page inside the window stops
  working, Taroting reloads it and tells you; if the display engine behind it
  stops, Taroting restarts once. Edits made since the last autosave may be
  lost in either case, and the notice says so.
- **If the display engine cannot start at all, Taroting says so** instead of
  running invisibly, where it also stopped every later launch from opening.
- **Closing Taroting stops its background work.** A conversion or export
  still running when the app closed, or crashed, used to carry on in the
  background, using the processor and holding the file. It now stops with
  the app, and background work runs at a lower priority so the window stays
  responsive while it runs.

## The window no longer waits on slow work

Taroting is meant to run well on any PC. The most likely cause of the report
was a mistake that broke that promise, and the mistake was ours, not the
computer's.

- **Slow work ran on the window's own thread.** A window has one thread that
  draws it and answers clicks, and anything slow belongs somewhere else.
  Taroting ran a lot of slow work there anyway: opening a project with video
  (which checks every video file), making the project pictures on the home
  screen, saving, reading settings and recent projects, cache clean-up,
  starting an export and reading media for the preview. While any of it ran,
  the window could not draw or respond, on any machine, for as long as the
  work took: a picture for a large video could hold it for many seconds. A
  file opened from File Explorer at that moment had to wait on that same
  thread, which is the situation in the report. All of this work now runs in
  the background, and the window stays free to answer.
- **One stuck file can no longer hold up the rest.** Every background step
  has a time limit, a thumbnail that hangs no longer blocks the ones after
  it, and preview copies have a queue of their own, so quick jobs such as
  waveforms are not stuck behind a long conversion.
- **A second launch from File Explorer is passed over safely**: no crash on
  an unusual file name, and no endless wait while the first window is busy.
- **The editor does less while you work.** Autosave no longer redraws the
  panels, the media bin and the side panel no longer rebuild on every step of
  a canvas drag, playback allocates less per frame, and an editor with
  nothing to save stops waking up to check.

## Export

- **The bottom video track stays in step with its sound.** It drifted a
  little later at every cut, so long edits fell visibly out of sync.
- **Surround (5.1) audio** keeps every channel with its clip; only the front
  left and right channels used to be moved.
- **GIF export no longer holds every frame in memory.** GIFs are made in two
  passes, so a long GIF no longer runs out of memory (GIF export takes a
  little longer).
- **A hardware export that fails is redone on the processor**, and the
  result says so. H.264 hardware encoders stop at 4096 pixels, so wider
  exports use the processor from the start.
- **Text the export font cannot draw** (emoji, and some scripts) is pointed
  out in the export dialog, because the preview borrows missing characters
  from other fonts and the export cannot.
- **A project with very many clips** gets a clear message instead of a
  cryptic failure when it would not fit on one ffmpeg command line.
- **A file named like the export plus `.part`** (a download in progress, for
  example) is never overwritten or deleted; the export asks for another name.
- Exporting text works when the path of Windows' temporary folder contains
  an apostrophe, and the export folder must be a full path to a folder that
  exists before it is remembered.

## Your work and your data

- **A temporary project you edited survives a crash or a sign-out.** The
  startup clean-up used to delete it; now the home screen offers to
  **Recover** it.
- **Leaving a project while its save is failing asks first** (Back, Ctrl+W,
  the gear, an open from File Explorer, closing the window) instead of
  dropping the edits.
- **Ctrl+R, Ctrl+P and the other browser shortcuts are blocked** whatever the
  keyboard layout or Caps Lock; one of them could reload the app mid-edit.
- **Files picked for Import, Replace media or Locate after their project was
  closed** (another file opened from File Explorer while the picker was up)
  are refused with a message, never added to a project nobody is looking at.
- **Typed text is kept** when you click another clip or layer while a field
  in the side panel still has it, and a number typed there gets its own undo
  step.
- **Backups are never overwritten**: new, renamed and duplicated projects no
  longer take the name of a project that survives only as its backup, and
  such a project can now be deleted and renamed from its card.
- **Saving reports success correctly** when only the recent-projects list
  failed to update.
- **A shared project can no longer make Taroting go online.** Media in a
  project is read only from files on a drive or on a share in your local
  network (a NAS keeps working), and the window cannot navigate away or open
  web links.
- **Diagnostic reports hide more**: folder and file names with spaces, network
  paths and account names with spaces are now removed too.

## Editor and playback

- **Audio fades play as they export**: a clip that only fades out is no
  longer silent until the fade starts, and fades no longer begin early.
- **Stacked video layers stay in sync** during playback, and playback no
  longer stops silently when a clip's file ends before its out-point.
- **A file the preview cannot play says so** instead of showing "Ready" over
  a black picture; missing files are marked missing, and relinking refreshes
  the waveform and thumbnail.
- **A canvas drag is dropped when fullscreen playback starts**, instead of
  going on editing the project out of sight.
- **Crop handles stop at the frame edge** instead of pushing the opposite
  edge, and the crop view shows proxied clips.
- **Replace media keeps keyframes and crop where they were.**
- Preview copies of video with an odd height work, and media whose file
  reports no length imports at its real length.
- A pasted clip is selected, Space on the project name no longer also starts
  playback, Shift+wheel pans the timeline, and the timecode is right for very
  slow frame rates.

## Image projects

- **Export and Copy wait until a crop is applied** instead of exporting the
  unapplied crop.
- **Photos land on whole pixels**, so exports are no longer slightly soft
  after Add photo or a canvas resize.
- **Drawing tools skip layers at 0% opacity**, where ink would be invisible.
- **A drawing too large to duplicate says so** instead of making every later
  save fail.
- Photo layers are called "Photo" everywhere, adjustment sliders stay smooth
  on big photos, and Space activates a focused button instead of panning.

## Home, Settings and the viewer

- **Names sort naturally** on the home screen: Clip 2 before Clip 10.
- Enter on a card's "…" button opens its menu, and Enter on Cancel in the
  Duplicate dialog cancels.
- **Uninstall** opens with Cancel focused and can no longer start two
  uninstallers; its text now matches what the uninstaller does.
- **Settings keeps the keyboard focus** where it was after each change, and
  **Reset to defaults** for shortcuts asks once more before wiping them.
- A shortcut on the `+` key can be bound again, and a fractional cache limit
  no longer turns off cache trimming.
- **Menus and messages show in fullscreen**, including the viewer's "…" menu.
- Messages are announced to screen readers.

## A correction to the 0.9.0 notes

The 0.9.0 notes said that "if the window ever stops responding, a second
close a few seconds later still closes it." That holds for the page inside
the window: if it stops answering, a second close a few seconds later still
closes the window. If Windows itself reports Taroting as not responding, use
the close option Windows offers. That state came from the mistake above, slow
work on the window's own thread, and 0.9.1 removes it.

---

**SmartScreen:** Windows may show "Windows protected your PC" for a newly
downloaded installer until it builds a reputation for the new version. Choose
"More info → Run anyway", or use the portable build.
