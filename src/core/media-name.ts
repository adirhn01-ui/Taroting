// What a media entry is called wherever the editor names it: the bin row, the
// drag ghost, the timeline clip and the inspector header. ONE rule, so a clip
// reads the same in all four.
//
// A generated element (text, solid, drawing) has no file. Its MediaRef.path is
// a label stamped ONCE, when it was created, and naming it through fileStem had
// two faults: an edited text kept the label of the text it started as, and
// fileStem cut the label at its last dot or slash, so "Text — www.site.com"
// read "Text — www.site". A generated element is therefore named from its
// generator, every time; only a real file is named by its path.
//
// Lives in core, not beside the generator dialogs, so the timeline and the
// inspector can name a clip without importing a dialog module (and its CSS).

import { fileStem } from "./format";
import type { MediaRef } from "./types";

/** First ~24 chars of the text, single line, ellipsised: "Text — Title". The
 *  label a new text element is created with, and the name it is shown by. */
export function textLabel(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  const short = single.length > 24 ? single.slice(0, 24) + "…" : single;
  return `Text — ${short || "Title"}`;
}

/** Text names by generator object. textLabel walks the whole text, and the
 *  timeline names every visible clip on every repaint, so a long text would
 *  otherwise be re-scanned per clip per frame. A generator is never edited in
 *  place (an edit replaces the MediaRef and its generator — updateMedia), so
 *  its identity is a sound key, and a dropped one is collected with it. */
const textNames = new WeakMap<object, string>();

/** The name shown for a media entry: a text element by its text, a solid by
 *  its colour, a drawing as "Drawing", and a file by its name without the
 *  extension. */
export function mediaDisplayName(m: MediaRef): string {
  const g = m.generator;
  if (!g) return fileStem(m.path);
  if (g.type === "solid") return `Solid ${g.color}`;
  if (g.type === "drawing") return "Drawing";
  let name = textNames.get(g);
  if (name === undefined) {
    name = textLabel(g.text);
    textNames.set(g, name);
  }
  return name;
}
