# Taroting 0.7.4

Custom theme colours, a fix for an installer problem that could lose your
settings, and a faster start-up. Free and open source, as always.

## New

- **Custom theme colours.** Settings → Appearance now has a **Custom** option.
  Choosing it opens a panel with three colours:
  - **Background** — the app background. Panels, inputs, borders and the ruler
    all follow it, so one pick reshapes the whole surface.
  - **Accent** — buttons, selection, focus rings, clips and waveforms.
  - **Text** — every label, value and caption.

  Each opens a proper picker: a saturation/brightness field, hue and brightness
  sliders, a hex box that takes `#rgb`, `#rrggbb` or bare hex, a dozen presets
  chosen to suit that particular role, and a screen colour picker for grabbing a
  colour from anywhere on your display.

  **Your colours are used exactly as you pick them** — nothing is adjusted,
  second-guessed or quietly corrected. Whether the interface builds itself light
  or dark is worked out from the background you chose, so there is no separate
  switch to get wrong.

  If you do pick three colours that leave the app unreadable, **Settings →
  Appearance always stays legible**, along with the colour picker it opens, so
  you can see what you are doing and get back. That one panel keeps a fixed
  palette of its own for exactly that reason.

## Please read this before upgrading from 0.7.3

Upgrading runs the uninstaller **that is already on your machine**, so the fix
below cannot protect this one upgrade — the 0.7.3 uninstaller still does the old
thing. When the installer shows the **Already Installed** screen, choose
**Do not uninstall** and your settings, recent projects and cache come through
untouched. (Or use the portable build, which never runs an installer at all.)

From 0.7.4 onward this stops mattering: every later upgrade is protected
whichever option you pick. **Your projects in `Documents\Taroting` are never at
risk either way** — no version of the installer has ever touched them.

## Fixed

- **Upgrading no longer risks your settings.** When you ran a new installer over
  an existing install, the default option on the "Already Installed" screen ran
  the old uninstaller, which cleared your settings, recent projects and cache —
  even though you never asked it to. Removing your data is now tied to the
  **Delete the application data** checkbox on the uninstaller, where it belongs.
  Upgrading keeps everything, whichever option you pick (see the note above for
  the one upgrade this cannot retroactively fix).
- **Uninstalling now asks first.** Uninstalling removes the app and its file
  associations; your settings and cache are kept unless you tick **Delete the
  application data**. Projects are always kept.
- **Audio no longer goes missing on projects with several audio tracks.** With
  four or more, a track that started partway through could stay silent for its
  whole length, because a slot it needed had been taken to pre-load a different
  track. Audible clips now come first. The exported file was always correct —
  this only affected what you heard while editing.
- **Export settings added by a newer version are no longer discarded** when an
  older-looking save rewrites them.
- **A dropped file could be handled twice** after leaving and returning to a
  project, which could act on the wrong screen.
- **Failed thumbnails and waveforms are now recorded** under Settings →
  Diagnostics instead of vanishing silently, so "why is this thumbnail missing"
  has an answer. Nothing new interrupts you.

## Improved

- **Faster start-up and a snappier home screen.** Opening a project used to
  rewrite its cache index once per item — about sixty separate writes for a
  twenty-clip project, each blocking the others. That is now a single write.
  The home screen used to re-read and rewrite its project list once per card
  when filling in missing thumbnails; it now does it in small batches, cutting
  the file activity on a full screen of projects by roughly ten times.
- **Export opens faster.** Taroting checked your graphics card's encoders on
  every export, re-running the same detection each time. It now remembers the
  result for the session.
- **The version is shown in Settings → About**, selectable so you can copy it
  into a bug report.

## About the installer

Windows Defender was blocking the 0.7.2 and 0.7.3 installers as
`Trojan:Win32/Wacatac.B!ml`. It was a false positive, and it only ever affected
the installer — the app itself, the bundled FFmpeg and the portable build all
scan clean in every version.

The cause was the compression used inside the installer, not anything the
program does: the packed archive looked statistically suspicious to Defender's
machine-learning check, which never sees past the wrapper to the (clean)
contents. Switching to a different compression method fixes it. The installer is
about 35 MB larger as a result, which is a fair trade.

This build was verified by downloading it back from this page and scanning it
the way Windows treats a real download. If you already have a copy Windows
refuses to open, re-download it from here.

## Downloads

- **`Taroting-v0.7.4-portable-win64.zip`** — unzip and run `Taroting.exe`; no installation.
- **`Taroting_0.7.4_x64-setup.exe`** — per-user install with Start-menu entry, desktop shortcut, and `.trt`/media file associations. No admin rights needed. Windows SmartScreen may warn because the app is not code-signed — choose "More info" → "Run anyway".
