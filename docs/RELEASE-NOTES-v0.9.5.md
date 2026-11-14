# Taroting 0.9.5

Dragging through heavy recordings now keeps the picture moving, in the viewer
and in the editor. Also: a Text tool in the image editor, pictures as PDF
pages, PDF pages as pictures, and a much smaller download.

## Viewer

### Dragging through heavy recordings, frame by frame

- **Frame by frame.** In a high-bit-rate recording whose keyframes are seconds
  apart, dragging the seek bar now follows the pointer frame by frame. When
  the pointer stops or you let go, the real frame is shown.
- **How.** A couple of seconds after a heavy recording opens, Taroting starts
  making a small copy of it in the background, with every frame a keyframe.
  While you drag, the picture comes from that copy. Until the copy is ready,
  and for every other video, dragging works as it did in 0.9.4.
- **Where the copy is kept.** In the cache (Settings → Cache). Clear cache
  removes it, and it is made again the next time it is needed. Your original
  file is never changed.

### Right-click menu

- **Right-click the picture** for the same menu as the "…" button (Open as
  project and the rest). In a PDF with text selected, the menu starts with
  Copy.

## Video editor

### Dragging the playhead over heavy recordings

- **The picture keeps up with the playhead.** While you drag over a heavy MP4
  or MOV recording, the picture now updates as you go: the nearest keyframe
  while you move fast, the exact frame when you slow down, stop or let go.
- **Always the real video.** What you see is the recording itself at full
  quality. Clicks, arrow keys, playback and other videos work as before.

## Image editor

- **Text tool (T).** Click on the canvas and type in place, in the text's own
  font and colour. Double-click a text on the canvas to edit it again. To crop
  a text layer, use its Crop button.
- **Style part of a text.** Select some of the text and change its font,
  size, colour, bold or italic: only the selection changes. Ctrl+B and Ctrl+I
  work on a selection too.
- **Export as PDF.** An image project can be exported as a one-page PDF. At
  quality 100 the picture is lossless; below that it is stored as a JPEG at
  that quality.

## PDF projects

- **Pictures become pages.** In the pages panel, Insert → Pictures adds
  pictures as pages, with a choice of page size: Picture size, A4 or Letter.
  A4 and Letter fit the picture on the page and centre it.
- **Start from pictures.** On Home, New project → PDF project, Open and
  dropping files all accept PDFs and pictures together. The pages follow the
  files' name order.
- **Change a picture page's size later.** The page's menu in the pages panel
  has Page size. Whatever you drew over the picture stays in place on it.
- **Moved pictures.** A picture page whose file has moved shows a placeholder
  with "Relink picture" so you can find the file again.
- **Pages as pictures.** Export → Image now offers This page, All pages or
  Page range. All pages and Page range write PNG or JPEG files into a folder
  you choose, one per page.
- **Arabic text boxes export as real text.** They used to be exported as a
  picture of the text. Now they are exported as text you can select, search
  and copy, as long as the font has Arabic shaping. Other fonts still export
  the box as a picture.

## Smaller download

- **The installer is 90.9 MB instead of 157.5 MB**, and the installed app
  takes about 258 MB instead of 462 MB. The installer is
  `Taroting_0.9.5_x64-setup.exe`. The portable build is
  `Taroting-v0.9.5-portable-win64.zip` (101.6 MB, down from 178.7 MB).
- **Why.** FFmpeg's libraries were carried twice, once inside `ffmpeg.exe` and
  once inside `ffprobe.exe`. They now ship once, as separate library files.
  It is the same FFmpeg 8.1.1, and everything Taroting makes with it was
  compared and is identical.
- **Portable build: keep the files together.** The portable folder now has
  several FFmpeg files next to `Taroting.exe`. Move or copy the whole folder,
  not just the exe. If a file is missing, Taroting says so and doesn't fail
  silently.

## Fixes

- **A sound file that can't be played is marked.** A sound file the player
  refuses used to stay silent with nothing to say why. It is now marked Failed
  in the media bin, and the tooltip gives the reason.
- **A damaged recording could wait for its repair forever in the viewer.**
  When the quick copy of a damaged recording turned out to be unreadable, the
  viewer took that for "the repair isn't ready yet" and kept waiting. It now
  tells the two apart: it recovers, or it says it can't show the file.
- **Clipped last line in exported PDF text boxes.** In a text box that mixed
  fonts or sizes, the exported PDF could cut off the last line. The screen and
  the export measured the lines from different sources. They now measure
  them the same way, and the text stays inside the box. This mistake had been
  there since 0.9.4.

**Known limits:** the frame-by-frame copy and the editor's new dragging are
for MP4 and MOV recordings; heavy MKV, WebM and AVI files drag as before. A
recording longer than 15 minutes gets no copy in the viewer and drags as it
did in 0.9.4. Styling part of a text is not available for right-to-left text
yet.
