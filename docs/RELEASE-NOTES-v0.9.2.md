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

**Known limit:** a damaged file the player does not report as an error (it
just stays black) is not detected yet.

## Viewer fixes

- **Seek bar lag.** While you dragged, the knob trailed the pointer: it was
  redrawn only when a seek finished, and each new seek replaced the one in
  progress. It now follows the pointer as in the editor's fullscreen player,
  and the picture follows each completed seek.
- **Delay on Next/Previous.** A video waited 250 ms before it started
  loading. It now loads on the press; a burst of presses still loads only
  the last file.
- **Controls stayed up too long.** During playback they stayed on screen for
  2.5 s after the mouse stopped. Now it's 1 s, and they stay while the
  pointer is over them.
- **"Repairing" card while seeking.** Rapid seeking in a damaged video could
  cause a read error (`MEDIA_ERR_NETWORK`) that was handled as an
  undecodable file, replacing playback with a "repairing" card. The video
  now reloads where you were.
