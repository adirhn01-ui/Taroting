// Which output pages come from which source page, in the shape pdf.js's
// `extractPages` wants. Pure: no pdf.js, no I/O.
//
// pdf.js reads an entry's `includePages` as a SET walked in source order and
// gives the k-th of those pages the slot `pageIndices[k]`. So one entry can
// place any number of distinct pages of one source in any order: sort the
// pages, carry their slots along. A page used twice needs a second entry
// (entry k holds the k-th use of each page). Measured on a 300-page reverse:
// one entry per source 118 ms, one entry per page 1443 ms — every entry that
// carries document bytes is parsed again in the worker, and a source parsed N
// times also merges its outline and form fields N times.
//
// Slots must be dense (pdf.js throws on a gap), so blank pages are left out of
// the numbering here and inserted afterwards with pdf-lib.

import type { PdfPage } from "../../core/types";
import { PdfExportError } from "./errors";

export interface PlannedEntry {
  /** PdfSource.id */
  src: string;
  /** ascending, distinct source page indices (0-based) */
  includePages: number[];
  /** the extractPages slot of each include, same order */
  pageIndices: number[];
}

export interface ExtractPlan {
  /** the output pages after `range`, in order */
  pages: PdfPage[];
  /** PdfSource.id of the primary document (the first source used), or null
   *  when every output page is blank */
  primary: string | null;
  entries: PlannedEntry[];
  /** for each output page: its extractPages slot, or -1 for a blank page */
  slotOf: number[];
}

/** Clamp-free validation of a 1-based inclusive range against `count` pages. */
export function checkRange(range: [number, number] | undefined, count: number): [number, number] {
  if (count === 0) throw new PdfExportError("empty", "The document has no pages to export.");
  if (!range) return [1, count];
  const [from, to] = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count || from > to) {
    throw new PdfExportError("range", `Choose pages between 1 and ${count}.`);
  }
  return [from, to];
}

export function planExtract(all: readonly PdfPage[], range?: [number, number]): ExtractPlan {
  const [from, to] = checkRange(range, all.length);
  const pages = all.slice(from - 1, to);
  const slotOf: number[] = [];
  let primary: string | null = null;
  // per source: per use-level: page → slot
  const bySrc = new Map<string, Map<number, number>[]>();
  const order: string[] = [];
  let slot = 0;
  for (const p of pages) {
    if (p.src === null) {
      slotOf.push(-1);
      continue;
    }
    if (primary === null) primary = p.src;
    let levels = bySrc.get(p.src);
    if (!levels) {
      levels = [];
      bySrc.set(p.src, levels);
      order.push(p.src);
    }
    let level = levels.find((m) => !m.has(p.page));
    if (!level) {
      level = new Map();
      levels.push(level);
    }
    level.set(p.page, slot);
    slotOf.push(slot);
    slot++;
  }
  const entries: PlannedEntry[] = [];
  for (const src of order) {
    for (const level of bySrc.get(src)!) {
      const inc = [...level.keys()].sort((a, b) => a - b);
      entries.push({ src, includePages: inc, pageIndices: inc.map((i) => level.get(i)!) });
    }
  }
  return { pages, primary, entries, slotOf };
}
