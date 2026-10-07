// What the editor says about a DAMAGED video, and how much of the bin a
// change to `MediaManager.damage` owes a repaint.
//
// The words live here, pure and DOM-free, so the three places that use them —
// the "This video is damaged" notice, the bin row's tooltip and the stage's
// "Damaged section" scrim — say the same thing, and each wording is pinned by
// a test rather than by reading editor.ts. Nothing here runs for a healthy
// project: every caller first finds a damage record, and an empty map has none.

import { formatDuration } from "../../core/format";
import type { DamageState } from "./media";

/**
 * The unreadable range as the user reads it: "0:00-1:00" (the plain hyphen
 * of the agreed wording, which the viewer and the E2E use too). The end is
 * FLOORED to the whole second, the way a player's clock shows it — 60.6 s of
 * damage reads "1:00" (it is still showing 1:00 there), where rounding would
 * claim "1:01", a second that plays.
 */
export function damageRange(until: number): string {
  return `${formatDuration(0)}-${formatDuration(Math.floor(until))}`;
}

/** "40%" from a progress ratio, as the bin's Preparing label rounds it. */
function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Where the repair stands, lower-case, for the middle of a sentence. */
function phaseText(d: DamageState): string {
  switch (d.phase) {
    case "repairing":
      return d.ratio === null ? "repairing" : `repairing ${percent(d.ratio)}`;
    case "recovered":
      return "recovered";
    case "unrecovered":
      return "couldn't be recovered";
  }
}

function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The bin row's "Damaged" tooltip: "0:00–1:00 couldn't be read · repairing
 * 40%", "… · recovered", "… · couldn't be recovered". Without a known range
 * it is the phase alone, in sentence case ("Repairing 40%").
 */
export function damageTooltip(d: DamageState): string {
  const phase = phaseText(d);
  return d.until === null ? capitalized(phase) : `${damageRange(d.until)} couldn't be read · ${phase}`;
}

/**
 * The stage's text while the playhead is inside the damaged range. On the
 * instant copy (repairing, or unrecovered when its full repair failed) the
 * picture is covered: "Damaged section · repairing 40%". Once the full copy
 * plays (recovered) it is only the label "Damaged section" over the
 * recovered picture — the user always knows why it looks the way it does.
 */
export function damageStageText(d: DamageState): string {
  return d.phase === "recovered" ? "Damaged section" : `Damaged section · ${phaseText(d)}`;
}

/** What the "This video is damaged" notice says: the message, then the
 *  detail as its quieter second line. */
export interface DamageNotice {
  message: string;
  detail: string;
}

/**
 * The notice for a media first found damaged (`MediaManager`'s `onDamaged`),
 * or null when none is owed. `quick`: an instant copy plays everything after
 * the damage now. The detail says what can't be read and what Taroting is
 * doing about it.
 *
 * Only while a repair has to RUN ("repairing"): that is news — the picture
 * is about to change under the user, and they should know why. A reopen
 * that finds the recovered copy in the cache ("recovered") has nothing new
 * to say; a toast there would greet every open of the project and every
 * return from Settings with the same old fact, which the bin's "Damaged" and
 * the stage's "Damaged section" already say quietly for as long as the media
 * is shown.
 */
export function damageNotice(d: DamageState, quick: boolean): DamageNotice | null {
  if (d.phase !== "repairing") return null;
  const range = d.until === null ? "" : `${damageRange(d.until)} can't be read. `;
  const rest =
    quick && d.until !== null
      ? "The rest plays now; Taroting repairs the damaged part in the background."
      : "Taroting is repairing it in the background.";
  return { message: "This video is damaged", detail: range + rest };
}

export type DamageChange = "none" | "progress" | "structural";

/**
 * What a `damage` publication changed, for the bin — `statusChange`'s
 * sibling (media/status-diff.ts), on the same three answers:
 *
 *  - "structural" — a record appeared or went away, or its phase or range
 *    changed: the row's label, tooltip or bar are wrong as markup.
 *  - "progress" — only a repairing ratio moved: the bar width and the
 *    tooltip's percentage are written in place, with no row rebuilt (a full
 *    repair reports ~10 times a second for as long as it runs).
 *  - "none" — a fresh object saying what the last one said.
 *
 * Walked with `for…in` rather than through Object.keys, so a progress tick
 * allocates nothing here.
 */
export function damageChange(
  prev: Record<string, DamageState>,
  next: Record<string, DamageState>,
): DamageChange {
  let verdict: DamageChange = "none";
  for (const id in next) {
    const a = prev[id];
    const b = next[id]!;
    if (a === undefined) return "structural";
    if (a === b) continue;
    if (a.phase !== b.phase || a.until !== b.until) return "structural";
    if (a.ratio !== b.ratio) verdict = "progress";
  }
  for (const id in prev) {
    if (next[id] === undefined) return "structural";
  }
  return verdict;
}
