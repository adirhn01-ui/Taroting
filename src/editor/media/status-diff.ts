// What a `media.status` publication actually changed — and therefore how much
// of the media bin has to be rebuilt in answer to it.
//
// The manager republishes the WHOLE status map for every job event, and ffmpeg
// progress is throttled to 100 ms per running job, so one proxy or remux drives
// its subscriber ~10 times a second for as long as it runs. The editor used to
// answer every one of those with a full `innerHTML` rebuild of the bin — every
// row destroyed and re-created, every thumbnail <img> re-decoded — plus an
// `engine.refresh()`, which re-activates the whole scheduler. None of that is
// earned by a number moving from 41% to 42%, and all of it lands while the user
// is editing or playing back.
//
// Three answers, told apart by what the rest of the editor can actually see:
//
//  - "structural" — a media id appeared or went away, a status changed KIND, or
//    a field something else reads changed: the url behind a ready media (a
//    relink re-points it at another file), the message a failed row shows in its
//    title, the job a preparing media is waiting on. The markup is wrong, and
//    "preparing → ready" is exactly the case where the current frame may have
//    just become playable.
//  - "progress" — same ids, same kinds, only a preparing ratio moved. Nothing
//    changed but the bar width and its label, both of which are written directly
//    rather than re-emitted as markup.
//  - "none" — a fresh object saying precisely what the last one said. ffmpeg
//    repeats a ratio often enough to be worth the branch, and the store cannot
//    filter these itself: every publication is a new object by construction.
//
// Pure and DOM-free, so the decision is testable on its own. It needs no state
// either — the store already hands each subscriber the previously notified
// snapshot — so nothing here is allocated, and nothing is paid for at all in a
// session where no job ever runs.

import type { MediaState } from "./media";

export type StatusChange = "none" | "progress" | "structural";

export function statusChange(
  prev: Record<string, MediaState>,
  next: Record<string, MediaState>,
): StatusChange {
  let verdict: StatusChange = "none";
  for (const id in next) {
    const a = prev[id];
    const b = next[id]!;
    // A media that was not there before is structural whatever it says.
    if (a === undefined) return "structural";
    if (a === b) continue;
    switch (b.state) {
      case "checking":
        if (a.state !== "checking") return "structural";
        break;
      case "ready":
        // url/sourcePath move when a relink re-points a media at another file:
        // whatever is holding the old one has to be re-pointed too.
        if (a.state !== "ready" || a.url !== b.url || a.sourcePath !== b.sourcePath) {
          return "structural";
        }
        break;
      case "preparing":
        // A NEW job id under an unchanged "preparing" is a re-plan — the media
        // is waiting on a different file now, which is not progress.
        if (a.state !== "preparing" || a.jobId !== b.jobId) return "structural";
        if (a.ratio !== b.ratio) verdict = "progress";
        break;
      case "failed":
        // The message is rendered into the row's title attribute.
        if (a.state !== "failed" || a.message !== b.message) return "structural";
        break;
    }
  }
  // Everything `next` carries has been accounted for; a media that has GONE is
  // only visible from the other side. Walked rather than compared through
  // Object.keys, which would allocate two arrays ten times a second.
  for (const id in prev) {
    if (next[id] === undefined) return "structural";
  }
  return verdict;
}
