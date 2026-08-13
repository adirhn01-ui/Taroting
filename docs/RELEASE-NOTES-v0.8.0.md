# Taroting 0.8.0

A resizable timeline, text at any size, sideways phone videos righting
themselves, exports that play everywhere they should, and a long list of small
things that now behave exactly the way you'd expect. Free and open source, as
always.

## New

- **Resize the timeline.** Drag the divider above the transport bar to give the
  timeline as much or as little of the window as you like — from a slim strip to
  most of the screen. The height is remembered between sessions. Projects with
  many layers finally have room to breathe.
- **Text at any size.** Long or huge text is no longer shrunk to fit or refused.
  Type what you want at the size you want; if it's bigger than the canvas it
  simply extends past it, which is exactly what you need for a title that starts
  enormous and animates down.
- **Colour swatches look like the colour they name.** The little chips in
  Settings → Appearance and in the colour picker used to read darker and duller
  than the pick, because a quarter of each chip was its own border. The ring now
  sits outside the chip, so every pixel of it is your colour.

## Sideways videos fix themselves

Phone footage records which way up it was shot, and older versions of Taroting
sometimes recorded the raw sensor size instead — leaving a portrait clip lying
on its side in a landscape canvas, letterboxed into a stripe. Projects like that
now repair themselves the first time you open them in 0.8.0: the clip stands up,
and if it was the only thing in the project the canvas turns with it.

One note on sharing: a project saved by 0.8.0 records that this repair has
happened, and an older Taroting may decline to open it. Opening old projects in
0.8.0 always works.

## Exports you can trust further

- **HEVC that Apple devices actually play.** H.265 exports in MP4 and MOV are
  now tagged the way QuickTime, Safari and Photos require, so a file you send to
  an iPhone user plays instead of showing a black frame.
- **Two broken combinations removed.** AVI with H.265 produced a file that
  reported success and then played nowhere — not even in the app that made it.
  MOV with AV1 cannot be produced at all. Neither is offered any more, and a
  project already set to one is quietly moved to a working choice.
- **Unusual projects export at full length.** A hand-edited project file with
  clips out of order used to export only part of the timeline.
- **Extreme shapes behave.** Very wide, very short clips (think a scrolling
  ticker over a thousand times wider than tall) no longer come out at the wrong
  size, and very wide text with an animated fade no longer fails partway
  through the export.
- **Your hardware choice stays yours.** Turning hardware acceleration off in
  Settings no longer silently rewrites each project's own export preference.

## Editing feels tighter

- **Smoother while media prepares.** While a freshly imported clip is being
  readied, the media list used to rebuild itself ten times a second — enough to
  make playback stutter on modest machines. Now only the progress bar moves.
- **Drag from the bin to any layer.** Dragging media onto the timeline now
  scrolls the layer stack when you hold the drag at its edge, so a lane that is
  scrolled out of view can be reached instead of being undroppable.
- **Escape means never mind — everywhere.** Cancelling a drag, a scale, a crop
  or a marker move (with Escape, or when the system interrupts the pointer) now
  puts things back exactly as they were, instead of quietly keeping the
  half-finished edit. Undo history stays clean through all of it.
- **Right-clicking empty space deselects**, matching what left-clicking does, so
  the menu you open always refers to what's under your pointer.
- **Removing media really removes it** — the app no longer keeps its waveforms
  and bookkeeping in memory for the rest of the session.
- **Fullscreen playback polish.** The control bar's auto-hide works every time
  you re-enter theater mode, not just the first; leaving fullscreen the instant
  after entering it can no longer strand the window fullscreen with no
  controls; and the "Preparing preview" notice now shows above your layers
  instead of hiding behind them on multi-layer projects.

## Quieter, safer, more careful

- **Uninstalling is clean.** Settings → Uninstall no longer flashes a series of
  console windows or freezes the app for a second first — and it now works on
  Windows accounts with accented or non-English names. As before, the
  uninstaller itself asks whether to remove your settings; your projects are
  never touched.
- **Keyboard focus stays where it belongs.** Delete confirmations, the relink
  dialog and the export dialog keep Tab inside them (previously you could tab
  into — and activate — controls hidden behind them). Menus hand focus back to
  where you were when they close.
- **What you copy is what you meant to share.** Every place that offers error
  details for copying now removes folder paths and your account name first —
  including account names with apostrophes, which slipped through before. The
  diagnostics report also records your custom theme colours, so an
  "I can't read Settings" report is reproducible.
- **Settings never lose a race.** Two preferences changed in quick succession
  could occasionally save in the wrong order and drop one. Holding an arrow key
  in the colour picker no longer writes the settings file thirty times a
  second, either.
- **Rarer things.** Opening the app via a file with an unusual name can no
  longer make it exit silently; duplicated media no longer computes its
  waveform twice in parallel; and an empty environment variable can no longer
  send the app's data to the wrong folder.

## For the curious

The automated test suites grew from 873 + 198 + 33 checks to 967 + 211 + 35
across this release, including the first tests that verify rotation direction
from actual pixels, hardware-encoder output geometry, and that an AVI export
decodes back as the codec it claims. Every new test was deliberately broken
once to prove it can fail.

---

**SmartScreen note:** Windows may show "Windows protected your PC" for a newly
downloaded installer until it builds a reputation for the new version. Choose
"More info → Run anyway", or use the portable build.
