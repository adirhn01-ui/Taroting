# Taroting 0.9.0

Two new ways to use Taroting: a lightweight viewer that steps through the
files in a folder, and image projects for drawing on, adjusting and exporting
photos. Plus Windows integration that offers Taroting for every file it opens
without ever taking over your default apps, and a long list of fixes found by
a full review of the app. Free and open source, as always.

## New: the folder viewer

- **Open a photo, clip, GIF or song from File Explorer and it shows on its
  own**, in a viewer with arrows (or ← →) to move through the rest of its
  folder in File Explorer's own name order. Hidden, system and non-media files
  are skipped. Photos, GIFs and videos step together; music steps through
  music. Holding an arrow key flies through the folder and only loads the file
  you stop on.
- **Videos play directly** when they can. Files that only need a quick
  container change are converted in the background in seconds; heavy formats
  show a "Prepare preview" button instead of starting a long conversion nobody
  asked for. 4K plays directly.
- **The "…" menu opens the file as a project** — a photo as an image project,
  a clip as a video project — and leaving that project returns you to the same
  file in the viewer. "Show in folder" is there too.
- **Settings → Opening files** chooses where a file opened from File Explorer
  lands: the viewer, or straight into a temporary project in the editor (what
  Quick view used to do). Whichever way Quick view was set carries over.
- **Opening a file from File Explorer skips the home screen** and goes
  straight to the viewer or the editor. Measured: a video reaches the viewer
  about 46 ms sooner than it would have through the home screen; opening
  Taroting on its own is unchanged.

## New: image projects

Start one with **New image** on the home screen (a blank canvas at a size of
your choice) or open a photo as a project from the viewer.

- **Drawing:** a pen that follows pressure, a pencil with grain, a highlighter
  that sits under your ink, an eraser that removes whole strokes or rubs out
  pixels, lines, boxes, ellipses and arrows, and a ruler to draw along.
  Colours come from the app's own picker and eyedropper, with your recent ink
  colours kept.
- **Photos:** exposure, brightness, contrast, highlights, shadows, saturation,
  hue, warmth and tint, previewed live and exported exactly as shown.
- **Layers:** photos, drawings, text and solid colours — reorder, hide,
  rename, duplicate, delete, move, scale, rotate, flip, set the opacity of and
  crop each one.
- **The whole image** can be cropped, rotated, flipped and resized, on a
  transparent, white, black or chosen-colour background.
- **Export** to PNG, JPEG or WebP (WebP at 100 is lossless) at any quality and
  size, or copy the image to the clipboard. The source photo is never
  overwritten, and exported files carry no location or camera details.
- **Big photos are never refused:** the editor works on a lighter copy and
  exports from the original.
- The image editor loads only when an image project is opened, so video
  projects start exactly as quickly as before. Undo covers everything, and
  memory stays small however long a drawing gets.

An image project is saved as a `.trt` file like any other project. Taroting
0.8.x and older cannot open image projects; video projects open everywhere as
before.

## Windows integration

- **"Open with → Taroting"** now appears for videos, GIFs, photos and music,
  listed as Taroting video, Taroting image and Taroting audio.
- **Taroting never changes which app opens your files.** Earlier versions
  registered themselves as the default for ten media types, which only held
  on a PC where you had never chosen an app. 0.9.0 claims no media default at
  all: a double-click opens whatever you chose, until you choose Taroting
  (right-click → Open with → Choose another app → Always).
- **Taroting is listed in Settings → Apps → Default apps**, so you can make it
  the default for its file types in one place if you want to. Listing it
  changes nothing by itself.
- **Upgrading cleans up** the file types earlier versions claimed, handing
  each back to the app it had before when that app is still installed. Other
  apps' entries are never touched, and uninstalling removes exactly what
  Taroting added.
- A project double-clicked from a Windows user folder whose name contains a
  space now opens, instead of landing on the home screen.

## Keep, close and temporary projects

- **Keep** a temporary project at any time with the button next to its
  Temporary badge; it becomes an ordinary project in your library.
- **Closing the window asks first when that would lose something:** an edited
  temporary project offers Keep or Discard, a running export asks before
  stopping, and a save that has not landed is never skipped silently. An
  unedited temporary project just goes. If the window ever stops responding, a
  second close a few seconds later still closes it.
- Closing the window while cropping or previewing a colour no longer saves the
  crop or colour you never applied.

## Fixes

- **Waveforms and preview copies appear as soon as they are ready.** A file
  that needed one when it was first added showed "Preparing" until the
  project was reopened — the app and its background worker named the job
  differently. They now agree, and a test pins it.
- **Phone photos stand upright** in the editor and in their exports, whatever
  their format. JPEG, PNG and WebP carry their orientation differently, and
  the preview and the export now read it the same way, file by file.
- **Audio and video no longer drift apart in long exports.** A clip whose
  video ends a few frames before its sound used to pull every later clip
  earlier than its audio; each clip now keeps its exact place.
- **A crop 1 pixel wide or tall no longer fails the export**; crops are held
  to the same minimum in the preview and the export, and a crop hanging off
  the edge of its clip exports exactly as it previews.
- **Export refuses what it cannot write** — an unknown format or codec, a
  picture that cannot loop — with a clear message instead of an ffmpeg error,
  and it can never overwrite one of the project's own source files.
- **Replacing an export works on drives** where Windows cannot resolve a
  file's full path.
- **Ctrl+Y redoes**, alongside Ctrl+Shift+Z. Keyboard shortcuts now belong to
  the screen they act on, a new default never takes a chord you already bound
  yourself, and keyboard layouts that use AltGr keep their characters.
- **Dialogs close with the editor that opened them**: a relink, Add text or
  Add solid dialog left open when the editor is closed from outside no longer
  stays over the next screen.
- **The colour picker holds the keyboard while it is open**: shortcuts no
  longer act behind it, and Escape cancels the colour instead of keeping it.
- **The list of recent projects can no longer lose an update** when a save and
  a home-screen picture land at the same moment.
- **A second launch no longer deletes a Quick view project that is still
  open.**
- **More file types open:** M4V, WMV, MTS, M2TS, 3GP, MPG and MPEG video,
  M4A and OGG audio, and WebP and BMP pictures.
- Renaming or duplicating a file that is not really a project, or opening
  a crafted one, no longer closes the app; a project too large to reopen is
  refused before it is saved.
- The cache is trimmed back under its limit at startup and whenever you lower
  the limit in Settings.

---

**SmartScreen:** Windows may show "Windows protected your PC" for a newly
downloaded installer until it builds a reputation for the new version. Choose
"More info → Run anyway", or use the portable build.
