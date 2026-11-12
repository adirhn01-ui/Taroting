# Taroting 0.9.4

Use any font: the ones installed on your PC and ones you import. Also: style
just the selected words in a PDF text box, hide the side panels in the PDF and
image editors, and smoother dragging through large recordings in the viewer.

## Fonts

- **Fonts from your PC.** Text used to be limited to six fonts. It can now use
  any font installed on your PC, in video projects, image projects and PDF
  text boxes.
- **Find a font quickly.** The font list has a search box and shows each font
  the way it looks.
- **Import your own.** Settings → Fonts → Import fonts takes `.ttf` and
  `.otf` files. Taroting keeps its own copy, so the font stays available even
  if the original file is moved.
- **A page for your imported fonts.** Settings → Fonts → View lists them with
  a sample, the date added and the size. Search, sort by name, date or size,
  and remove one font or several at once.
- **Projects on another PC.** If a project uses a font that PC doesn't have,
  the text shows in Segoe UI, a notice names the missing font, and the project
  keeps the font's name, so it comes back as soon as the font is installed or
  imported.
- **PDF export respects font licences.** A font whose licence doesn't allow
  embedding can't go into a PDF; the export names the font so you can pick
  another.

## PDF text boxes: style part of the text

- **Select, then style.** While typing in a text box, select some of the text
  and change its font, size, colour, bold or italic: only the selection
  changes. Ctrl+B and Ctrl+I work on a selection too.
- **The whole box, as before.** With the box selected but not open for typing,
  the same controls style all of its text.
- Undo and redo step through these changes while the box is open, and the
  exported PDF keeps every style.

## More room to work

- **PDF editor:** hide the pages panel (F4) and the properties panel
  (Shift+F4), or use the two buttons beside the view controls.
- **Image editor:** the same for the layers panel (F4) and the properties
  panel (Shift+F4).
- The panels stay the way you left them until you close Taroting. Both
  shortcuts can be changed in Settings.

## Viewer: dragging through large recordings

- **What went wrong.** While you dragged the seek bar, Taroting asked the
  player for the exact frame under the pointer on every move. In a
  high-bit-rate recording whose keyframes are seconds apart, each of those
  requests decodes up to several seconds of video, so the picture fell behind
  the pointer.
- **What it does now.** Taroting reads where the file's keyframes are (no
  decoding). During a fast drag it shows the nearest
  keyframe, which appears at once; when you slow down or let go, it lands on
  the exact frame. Other videos, and the editor, work as before.

## Fixes

- **A failed seek no longer breaks the video in the viewer.** Dragging fast
  through a playing recording could make the player fail a seek. Taroting
  reloaded the video, but our recovery was wrong: it could put the video at
  the end instead of where you were, dropped the position you were dragging
  to, forgot that the video was playing, and after two failures showed "Can't
  show this file" for a healthy file. It now returns to where you were, goes
  on playing if it was playing, and keeps following your drag. This mistake
  had been there since 0.9.2.
- **Recordings saved in fragments (fragmented MP4).** These are the files in
  which that seek failed: an MP4 written as many small pieces, the way some
  screen recorders save them. The first time you open one, Taroting now makes
  a re-packed copy (the same video and sound, not re-encoded; a short
  "preparing" while it is made) and plays that, in the viewer and in projects.
  Export, thumbnails and waveforms still read your original file, which is
  never changed. The copy lives in the cache.
- **Wrapped right-to-left text in an exported PDF.** A text box or a
  multi-line form field whose Hebrew or Arabic paragraph wrapped onto several
  lines exported the whole paragraph on every line. Each line now exports its
  own text. This was a mistake in 0.9.3's export.
- **No build-machine paths in the app.** `Taroting.exe` carried the folder
  paths of the computer it was built on. They are no longer in the file.
- **Publisher name.** Windows' installed-apps list now shows the publisher as
  "adirhn".

**Known limits:** styling part of the text is for PDF text boxes; text in
video and image projects has one style per text. A PDF project with styled
selections opens in 0.9.3 with all its text, in the box's base style. Fonts
with a `.ttc` file can be used when installed on the PC, but can't be imported.
