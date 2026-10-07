# Taroting 0.9.2

Two fixes: a partly damaged video now plays instead of being refused, and
the viewer's seek bar works the way the editor's does.

## Damaged videos play instead of failing

- **What went wrong.** The preview uses WebView2's built-in player, which
  stops at the first frame it cannot decode (`PIPELINE_ERROR_DECODE`). On
  that error Taroting marked the whole file as failed, even when only part
  of it was damaged. The report behind this was an NVIDIA Instant Replay
  recording whose first minute was scrambled when it was saved.
- **It plays at once.** Taroting reads the file's frame headers (no
  decoding, a fraction of a second), finds where the sound part starts, and
  plays a lossless copy from there right away, with the sound from the start.
- **The damaged part is repaired in the background.** ffmpeg decodes the
  file again, covering damaged frames instead of stopping, and the result
  replaces the instant copy where you are, without a press.
- **You always know the file is damaged.** The editor's media bin says
  Damaged, the viewer shows a "Damaged video" pill and shades the damaged
  range on the seek bar, and the damaged section is covered until the repair
  lands.
- **Fake headers are ignored.** For H.264 in a standard MP4 (`avc1`), the
  repair and the export read the file with in-band SPS/PPS/SEI removed
  (`filter_units=remove_types=6|7|8`), so scrambled data can no longer
  re-size the picture or turn it sideways.

## The viewer's seek bar follows the pointer

- **What went wrong.** The viewer drew its seek bar from the video's
  position, which only moves when a seek finishes. While you dragged, each
  new seek replaced the one still decoding, so the knob trailed the pointer.
- **Now it seeks like the editor's fullscreen seek bar:** the knob and the
  clock are where you put them at once, and the picture follows.
- **Next and Previous load at once** (a 250 ms wait is gone). Clicking or
  holding the key through a folder still loads only the file you stop on.
- **The controls fade after 1 second** of a still mouse while a video plays
  (was 2.5), and never while the pointer rests on them.
- **Dragging hard on a damaged video** no longer drops the viewer into a
  "repairing" card: a read error mid-seek reloads the video where you were.

**Known limit:** a damaged file the player does not report as an error (it
just stays black) is not detected yet.
