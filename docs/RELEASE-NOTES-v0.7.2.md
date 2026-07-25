# Taroting 0.7.2

A tune-up release. There are no new features by design — Taroting behaves
exactly as it did in 0.7.1, but the machinery underneath is newer, leaner and
faster. Free and open source, as always.

## Fixed

- **A malformed project file can no longer take the app down.** A `.trt` project
  is meant to be shareable, so it has to be treated as untrusted input. A text or
  solid generator carrying a hand-edited colour value could crash Taroting
  outright the moment you pressed Export, and a colour's transparency portion was
  not being validated the way the rest of it was. Both are now checked before the
  value is used. Nothing about normal projects changes — colours picked in the
  app were always valid.

## Improved

- **The editor does nothing while it is doing nothing.** The timeline used to
  keep a render loop running every display frame for the entire session, even
  with playback paused and the window untouched. It now draws only when
  something actually changes, so an idle or paused project draws zero frames.
- **Smoother scrubbing and dragging.** Moving the playhead used to tear down and
  rebuild every video layer on each mouse movement, which forced the rendering
  engine to reconstruct each layer's layout and compositing state. That work now
  happens only when the number of layers genuinely changes. Timeline hit-testing
  and lane geometry were also made allocation-light, so hovering, scrubbing and
  dragging create far less short-lived garbage for the collector to clean up.
- **Calmer exports.** Export progress no longer pushes a taskbar update roughly
  ten times a second for a bar that only has a hundred positions.
- **Refreshed foundations.** The entire toolchain moved up a major version —
  TypeScript, Vite, Vitest, and the full Rust dependency graph are all on their
  current releases. The production bundle came out slightly smaller as a result,
  and the development feedback loop is several times quicker, which is what keeps
  Taroting easy to keep fast.
- **Dead code removed** across the playback, preview, timeline and export
  modules — unreachable branches, unused exports and vestigial parameters that
  were still being shipped.

## Downloads

- **`Taroting-v0.7.2-portable-win64.zip`** — unzip and run `Taroting.exe`; no installation.
- **`Taroting_0.7.2_x64-setup.exe`** — per-user install with Start-menu entry, desktop shortcut, and `.trt`/media file associations. No admin rights needed. Windows SmartScreen may warn because the app is not yet code-signed — choose "More info" → "Run anyway".
