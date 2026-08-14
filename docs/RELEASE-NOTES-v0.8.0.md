# Taroting 0.8.0

Everything since 0.7.4: a resizable timeline, text at any size, custom themes
that stay yours on every screen, sideways phone videos righting themselves,
exports that land every clip exactly where the preview shows it, and several
dozen precision fixes across editing, saving, uninstalling and diagnostics.
Free and open source, as always.

## New

- **Resize the timeline.** Drag the divider above the transport bar to give the
  timeline as much or as little of the window as you like — from a slim strip to
  most of the screen. The height is remembered between sessions. Projects with
  many layers finally have room to breathe.
- **Text at any size.** Long or huge text is no longer shrunk to fit or refused.
  Type what you want at the size you want; if it's bigger than the canvas it
  simply extends past it, which is exactly what you need for a title that starts
  enormous and animates down.
- **Your theme colours, on every screen.** Settings → Appearance used to render
  in a fixed palette of its own for every custom theme, as insurance against a
  theme that hides everything. It now shows your own colours like the rest of
  the app, and switches to the fixed palette only while the card is measurably
  illegible — its primary ink under 1.5:1 contrast against any surface it
  paints on, including hovered and pressed states. The moment your picks are
  readable, they are what you see. The threshold was calibrated on real
  palettes: themes that are merely muted or unusual keep their colours; every
  theme that actually hides the way out still gets one.
- **Colour swatches look like the colour they name.** The chips in Settings →
  Appearance and in the colour picker read darker and duller than the pick,
  because their border was drawn inside the chip and covered about a third of
  its pixels — measured on screen, a dark chip averaged out to exactly the
  panel colour behind it. The hairline now sits outside the chip, so every
  pixel of it is your colour.

## Sideways videos fix themselves

Phone footage records which way up it was shot. Taroting used to probe a
video's coded size — the sensor's own orientation — so a portrait clip was
believed to be landscape: with a crop or an opacity fade the export failed
outright, and otherwise the picture was stretched. Three changes close this
end to end:

- New imports read the rotation metadata and record the size the video
  displays at.
- Projects saved by older versions still hold the transposed numbers, so
  0.8.0 re-checks those clips the first time such a project opens, corrects
  them, and — when the sideways clip was the only visual media and the canvas
  matched its old size — turns the canvas with it.
- The export pipeline applies its scaling and centring after the rotation,
  not before, so a corrected portrait clip exports at its real proportions.
  (Measured during the fix: a 90-degree clip previously exported 802×802
  where the preview showed 802×1428.)

A project saved by 0.8.0 records that this repair has happened, and an older
Taroting may decline to open it. Opening old projects in 0.8.0 always works.

## Exports land exactly where the preview shows them

- **Off-centre clips exported at the wrong position whenever the export
  resolution differed from the project canvas.** A clip's offset is authored
  in canvas pixels but was applied in output pixels, so exporting a 1920×1080
  project at 720p put a clip authored at x=307 a hundred pixels off; 4K put
  it three hundred off. Centred clips were unaffected, which is how it went
  unseen. Fixed in both the static and the keyframed path, and the
  preview-vs-export parity table now carries an export-resolution axis so a
  regression of this shape cannot pass it again.
- **H.265 in MP4 and MOV is now tagged `hvc1`**, which is the tag Apple's
  media stack requires — QuickTime, Safari, Finder previews and Photos now
  play these files instead of showing nothing.
- **Two container/codec pairings are withdrawn.** AVI with H.265 produced a
  file that reported success but carried a null codec identifier nothing can
  decode — not even the app that wrote it. MOV with AV1 cannot be muxed at
  all. Neither is offered any more; a project already set to one is moved to
  a working codec when it opens.
- **An image clip with a changed speed exported at the wrong length** — its
  trim was applied once in timeline seconds and again in source seconds.
- **A hand-edited project with clips out of order exported only part of the
  timeline** — the duration trusted the last clip in file order rather than
  the furthest end.
- **Extreme shapes export correctly.** A fitted dimension below 1.5 px used
  to round to 0, which ffmpeg reads as "keep the input size" — so a clip over
  ~1280 times wider than tall came out at the wrong geometry. And the mask
  that renders an animated opacity fade hit an internal scaler limit around
  110,000 px of width; its scaling now runs in two stages, raising the
  workable width to roughly 878,000 px.
- **Turning hardware acceleration off in Settings no longer rewrites each
  project's own export preference** — two separate code paths were writing
  the global toggle into the project file.
- **Auto-numbering an export filename stops instead of overwriting.** After a
  thousand taken candidates, the old code silently reused a name that existed.
  The numbering also had two implementations that disagreed; one remains.
- **A failed export publish no longer deletes the encode it just produced** —
  or the previous export sitting at the same path.

## Nothing gets lost

- **Edits made while an autosave was in flight were dropped on leaving the
  editor.** The save that was already running snapshotted the project before
  the edit landed, and the editor treated its completion as "everything is
  saved".
- **Two settings changed in quick succession could save out of order**, so
  the earlier snapshot could land on disk last and drop the later change.
  Writes are now serialized and each write carries the merged state at the
  moment it starts. A write that fails also says so — the screen paints the
  new value before the disk confirms, so a silent failure previously looked
  identical to a saved one until the next launch.
- **A settings file or recents index that was merely unreadable at start-up
  is no longer overwritten.** The backend now distinguishes "the file is
  unreadable" from "there is no file"; the frontend refuses to write over an
  answer it does not understand, and a restore from the automatic backup is
  reported when it happens.
- **Renaming a project could overwrite a different project** when two names
  differed only by characters that Windows' filesystem keeps apart but
  Unicode case-folding merges. Name identity now comes from the filesystem
  itself.
- **A confirmation dialog could outlive the screen that opened it**, so its
  Delete could still fire against a screen the user had already left.
- **Cancelling really cancels, on every path.** Escape during a canvas drag,
  scale or crop reverts the edit and ends the gesture; a pointer withdrawn by
  the system (alt-tab, a system gesture) cancels instead of committing the
  half-finished drag; closing a project mid-crop reverts the live edit
  instead of stranding a state that no Ctrl+Z could reach. The timeline's
  drags got the same treatment earlier in the wave; the canvas overlay now
  matches it exactly.
- **Undoing during a marker drag restored the marker to its mid-drag
  position.** A marker drag now previews without writing to the shared
  project and commits once, on release — so a foreign edit's undo snapshot
  can never capture a marker in flight, and each drag is one history entry.
- **A corrupt or hand-edited project file can no longer take the app down.**
  A speed of zero or infinity sent an audio calculation into a loop that grew
  until the process died; durations, frame rates with zero denominators,
  non-finite positions, fades and gains are all repaired on read; a timeline
  with no video track no longer crashes import.

## Editing, tightened

- **Smoother while media prepares.** A running import republished its
  progress ten times a second, and every publication rebuilt the entire media
  list and re-activated the playback scheduler — during playback, this
  competed with the frame clock. Progress now repaints exactly two values on
  the row that changed; the list rebuilds only when something structural
  changes.
- **Every layer is reachable.** The layer stack now scrolls (anything below
  the third layer used to be drawn into pixels that did not exist — clips
  there could not be selected, moved or deleted), timeline drags auto-scroll
  at the panel's edge, and dragging media from the bin now auto-scrolls the
  same way, so a lane out of view is a valid drop target.
- **The drag preview tells the truth.** The drop ghost used to draw wherever
  the pointer was while the actual drop ran placement rules that could move
  the clip somewhere else entirely — on a dense track, a clip dropped at 12
  seconds could land at 300. The preview now runs the same placement the
  commit will.
- **Right-clicking empty timeline space clears the selection**, matching
  left-click, so a context menu always refers to what is under the pointer.
  The one-pixel row where the ruler meets the first lane now hit-tests as
  what is painted there.
- **Keyboard control is exact.** Shortcuts no longer fire behind an open
  context menu (Delete could previously remove a clip on another lane while
  the menu's own delete then applied as well). Letter and Ctrl shortcuts work
  on non-Latin keyboard layouts. A slider reached by keyboard can no longer
  freeze the inspector. Tab cannot leave an open dialog: delete
  confirmations, the relink dialog and the export dialog place focus inside
  themselves when they open and after every view change — destructive
  confirmations place it on Cancel — and menus return focus to the control
  that opened them.
- **Duplicated imports resolve.** Importing the same file twice left one bin
  entry stuck on "Preparing" forever; every waiter on a shared job is now
  woken. Removing media from the bin also releases its waveforms and
  bookkeeping instead of keeping them for the session.
- **Audio recovers from scrubbing.** An audio clip on its own track could
  fall silent for the rest of its run after a scrub, because its fade
  envelope never re-armed. (This finishes the class of fixes started in
  0.7.1 for embedded video audio.)
- **Fullscreen playback.** The control bar's auto-hide now works on every
  theater session, not only the first (a state flag survived from the
  previous session and suppressed the hide timer). Exiting in the first
  instant after entering can no longer leave the window fullscreen with no
  controls — the fullscreen request's completion is now checked against
  whether theater still wants it. And the "Preparing preview" notice paints
  above the video layers; it used to stack beneath them on multi-layer
  projects, which hid the one message explaining a black preview.

## The mechanics, for the record

Changes where the interesting part is how, not what:

- **Inline styles do not exist in the packaged app.** The shipped
  Content-Security-Policy attaches a nonce to the app's stylesheet, and per
  CSP Level 3 that makes the policy nonce-only — a `style="…"` attribute
  cannot carry a nonce, so every one of them was silently dropped in the
  packaged build (and only there; development serves unrewritten HTML, which
  is why no dev run could see it). Nine interface elements painted through
  attributes — among them the theme swatches, the import progress bar and the
  export progress bar — now paint through the CSSOM, which the policy does
  not gate.
- **Uninstall launches the uninstaller directly.** Settings → Uninstall used
  to locate the uninstall command by spawning `reg.exe` about twenty times to
  enumerate the registry, decoding its console-codepage output as UTF-8, and
  executing the resulting string through `cmd /C` — on the interface thread.
  Each spawn opened a console window; the decode mangled profile paths
  containing non-ASCII characters (the launch then failed with no error,
  because launching `cmd` itself succeeds); and registry data was being
  interpreted as a shell command line. All of it is replaced by one direct,
  windowless spawn of the `uninstall.exe` that installs next to the app, off
  the interface thread. The uninstaller's own "Delete the application data"
  checkbox remains the only thing that removes settings and caches — the
  launch is deliberately not silent, because that checkbox is where the
  choice lives. Projects are untouched by every path, as always.
- **Diagnostics redaction handles every legal account name.** The patterns
  that replace profile paths with `<user>` and file paths with `<file N>`
  tokens treated an apostrophe as the end of a path — but `O'Brien` is a
  legal Windows account name, so everything after the quote passed through
  unredacted. Both patterns now match through apostrophes (and hand a
  filtergraph's closing quote back to the filtergraph). Every surface that
  offers text for copying — the failed-export report, toast details, the
  recent-errors list — routes through one shared redactor per dump, so the
  same file reads as the same token throughout. The diagnostics report now
  also records the three custom-theme colours: a legibility report without
  them is unreproducible.
- **Start-up handles hostile input.** A command-line argument whose name is
  not valid Unicode (possible on NTFS) aborted the process before the window
  existed; it is now read losslessly and a genuinely undecodable path is
  skipped rather than rewritten into a name that does not exist. An empty
  `APPDATA` or `LOCALAPPDATA` environment variable no longer resolves to a
  relative path — which would have written settings into whatever folder the
  app was launched from.
- **Derived files know their recipe.** The media cache keyed proxies,
  waveforms and thumbnails by source identity alone; a future build that
  changes how they are derived would have kept serving files made the old
  way. Cache keys now include a recipe version. (Bumping it is what
  invalidates; this release's bump re-derives existing caches once.)
- **Duplicate media no longer race a shared file.** Two clips of the same
  source each started a waveform decode writing the same output path — two
  renames racing onto one file on the project-open path. Waveform jobs now
  join an already-running job for the same output, the same way playback
  preparation always has.
- **The bundled FFmpeg is pinned.** `fetch-ffmpeg` downloads one recorded
  gyan.dev build by exact URL and verifies SHA-256 digests twice — the
  archive before unpacking, each binary before install — so every release
  ships a known build and a mismatch aborts without touching an existing
  install. The encoder check is a hard failure and now covers the full list
  the exporter uses (it was missing libopus and libmp3lame). The installer
  also carries publisher metadata now, which antivirus machine-learning
  verdicts weigh.

## Faster, all measured

- The export estimate sent the entire project over IPC to compute four
  numbers — 783 KB and 1.5 ms of main thread per keystroke on a large
  project. It sends five values now.
- Opening a project ran a full cache scan per finished preparation job,
  about forty of them. It runs one.
- A media drag forced two whole-tree layouts per mouse move for two
  rectangles that cannot change during the drag; they are read once per drag.
- The timeline rebuilt every waveform path and keyframe marker every frame;
  it no longer rebuilds what did not change.
- The media list's ten-rebuilds-per-second during imports (above) is also
  simply gone.
- Refreshing during playback — which importing media triggered several times
  a second — used to seek the playing video backwards each time, a dropped
  frame and an audio glitch per occurrence.
- Holding an arrow key in the colour picker queued a settings write per key
  repeat, roughly thirty per second. It writes once per gesture.

## The test suites

Since 0.7.4 the suites grew from 593 / 153 / 31 to **968 vitest / 211 cargo /
35 end-to-end blocks**, and the growth is the meaningful kind: rotation
direction is verified from decoded pixels (a bounding box cannot tell 90° from
270° — four coloured quadrants can), every hardware encoder present on the
build machine is exercised through the real export pipeline and its output
geometry measured, an AVI export is decoded back and must identify as the
codec that was asked for, and the preview-export parity table gained the
export-resolution axis that would have caught this release's geometry bug
years earlier. Every new test was deliberately broken once and watched to
fail before being trusted; several tests that passed regardless of the code
under test were found this way and replaced.

---

**Compatibility:** a project saved by 0.8.0 records its media-orientation
repair (`schema: 2`); 0.7.x may decline to open one. Opening any older project
in 0.8.0 works and upgrades it in place.

**SmartScreen:** Windows may show "Windows protected your PC" for a newly
downloaded installer until it builds a reputation for the new version. Choose
"More info → Run anyway", or use the portable build.
