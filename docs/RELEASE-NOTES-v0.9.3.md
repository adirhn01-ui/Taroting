# Taroting 0.9.3

PDFs arrive: read them in the viewer, mark them up, fill in their forms and
export a new copy. Also: clip volume up to 500%, a reset button for each
shortcut, and thumbnails for recordings with a damaged start.

## PDF viewer

- **Opens like everything else.** Double-click a PDF (Taroting appears in
  Explorer's "Open with"; it never makes itself the default PDF app), or step
  to one in the viewer with `<` and `>` — PDFs in a folder step among PDFs.
- **Reading.** Pages scroll in one strip with a thumbnail rail on the left, a
  page scrubber in place of the seek bar, zoom (buttons, Ctrl+wheel, fit width,
  fit page), Find (Ctrl+F), and text you can select and copy.
- **Protected PDFs** ask for their password; links to websites are shown, not
  opened (Taroting stays offline).

## PDF projects

- **Mark up:** highlight, pen, pencil, marker, eraser, shapes, text boxes
  (right-to-left text included), whiteout, pictures, saved signatures and a
  ruler — the image editor's own ink, so a stroke looks the same everywhere.
- **Pages:** reorder by dragging, rotate, duplicate, delete, insert blank
  pages, and merge in pages from other PDFs.
- **Fill forms:** a switch turns the PDF's own fields on — type, tick and
  pick, Tab to the next field.
- **Export** writes a new file and never touches the original: all pages or a
  range, marks kept as real annotations or drawn into the page, fields kept
  fillable or flattened — or one page as a PNG/JPEG.
- **From Home:** New project → PDF project, or open/drop PDFs (several become
  one project).

**Known limits:** the PDF's own text can't be edited (cover it with whiteout
and type on top); XFA forms can't be filled; Arabic text boxes export as a
picture of the text; protected PDFs are read-only.

## Also in 0.9.3

- **Clip volume to 500%.** The slider's left half is 0–100%, the right half
  100–500%, so everyday levels stay easy to set; type any value in the box.
- **Reset one shortcut.** Settings → Shortcuts shows ↺ on each changed row;
  one click puts that shortcut back.
- **Damaged recordings get a thumbnail.** A recording whose first seconds are
  scrambled had no picture on Home or in the editor: the thumbnail tried two
  positions inside the damaged part and gave up. It now tries once more where
  the clean video starts.
