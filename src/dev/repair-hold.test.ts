// The damaged-video E2E's plumbing, driven with fakes: the in-app blocks can
// only fail loudly when it is wrong, never say why, and the race the hold
// exists for cannot be produced on demand in the app.

import { describe, expect, it } from "vitest";
import type { CodecHints, PlaybackPlan } from "../core/ipc";
import type { MediaRef } from "../core/types";
import {
  holdJobDone,
  holdsFullRepair,
  isFullCopy,
  isHeaderFreeCopy,
  isQuickCopy,
  recordPlans,
  repairFamily,
  TAURI_EVENT_LISTENERS,
  type DonePayload,
  type JobDoneHold,
} from "./repair-hold";

const RAW = "C:\\fixtures\\damaged_h264.mp4";
const HASH = "0123456789abcdef";
const QUICK = `C:\\cache\\remux\\${HASH}.quick.mp4`;
const FULL = `C:\\cache\\proxy\\${HASH}.repairh.mp4`;
const HINTS: CodecHints = { hevc: false, av1: true };
const media = (path: string): MediaRef => ({ path }) as MediaRef;

/** A page's event plumbing as Tauri 2.11.5 lays it out: callbacks by id in a
 *  live Map, and per event a registry whose NON-enumerable entries name each
 *  listener's callback id. `emit` looks each callback up at delivery time, as
 *  the real runtime does — which is what lets a hold swap it. */
function fakePage() {
  const callbacks = new Map<number, (data: unknown) => unknown>();
  const doneListeners: Record<string, { handlerId: number }> = {};
  const host = { __TAURI_INTERNALS__: { callbacks }, [TAURI_EVENT_LISTENERS]: { "job:done": doneListeners } };
  let next = 1;
  /** An app listener; answers the ids it was handed, in order. */
  const listen = (): number[] => {
    const got: number[] = [];
    const id = next++;
    callbacks.set(id, (data) => got.push((data as { payload: { id: number } }).payload.id));
    Object.defineProperty(doneListeners, String(id), { value: { handlerId: id }, enumerable: false });
    return got;
  };
  const emit = (payload: DonePayload): void => {
    for (const key of Object.getOwnPropertyNames(doneListeners)) {
      callbacks.get(doneListeners[key]!.handlerId)?.({ event: "job:done", id: 0, payload });
    }
  };
  return { host, listen, emit };
}

const done = (id: number, path: string): DonePayload => ({ id, output: { path } });
const asHold = (h: JobDoneHold | string | null): JobDoneHold => {
  if (h === null || typeof h === "string") throw new Error(`no hold: ${String(h)}`);
  return h;
};

describe("repair copy names", () => {
  // The backend's one table (playability.rs repair_target): the header-free
  // full repair moved from .repairps.mp4 to .repairh.mp4 when its recipe
  // changed. A predicate still on the old name would see no full repair at
  // all — the hold would hold nothing and every "ready on the full repair"
  // wait would time out.
  it.each([
    [FULL, { full: true, headerFree: true, quick: false }],
    [`C:\\cache\\proxy\\${HASH}.repair.mp4`, { full: true, headerFree: false, quick: false }],
    [`C:\\cache\\proxy\\${HASH}.repairps.mp4`, { full: false, headerFree: false, quick: false }],
    [QUICK, { full: false, headerFree: false, quick: true }],
    [`C:\\cache\\proxy\\${HASH}.mp4`, { full: false, headerFree: false, quick: false }],
    [RAW, { full: false, headerFree: false, quick: false }],
  ])("%s", (path, want) => {
    expect({ full: isFullCopy(path), headerFree: isHeaderFreeCopy(path), quick: isQuickCopy(path) }).toEqual(want);
  });

  it("a cleanup removes every copy a repair of one source can leave, under today's names", () => {
    expect(repairFamily(FULL)).toEqual([FULL, `C:\\cache\\proxy\\${HASH}.repair.mp4`, QUICK]);
  });
});

describe("holdJobDone", () => {
  it("holds only the full repair's done, then hands it over once, in order, through every listener", () => {
    const page = fakePage();
    const a = page.listen();
    const b = page.listen();
    const hold = asHold(holdJobDone(page.host, holdsFullRepair));
    page.emit(done(42, QUICK));
    page.emit(done(41, FULL));
    page.emit({ id: 43, output: null });
    expect(a).toEqual([42, 43]);
    expect(b).toEqual([42, 43]);
    expect(hold.heldIds).toEqual([41]);
    expect(hold.held).toBe(2);
    hold.release();
    hold.release();
    expect(a).toEqual([42, 43, 41]);
    expect(b).toEqual([42, 43, 41]);
    // Released for good: a later full repair passes straight through.
    page.emit(done(44, FULL));
    expect(a).toEqual([42, 43, 41, 44]);
    expect(hold.heldIds).toEqual([41]);
  });

  it("says why when Tauri keeps its internals elsewhere, rather than hold nothing", () => {
    expect(holdJobDone({}, holdsFullRepair)).toMatch(/callbacks missing/);
    const page = fakePage();
    expect(holdJobDone(page.host, holdsFullRepair)).toBe("no job:done listener is registered to hold");
  });
});

describe("recordPlans", () => {
  /** A backend whose full repair (job 41) finishes BEFORE the repair plan's
   *  answer naming it reaches the page — events and invoke answers travel
   *  separate channels, and on the 4 s fixture the repair takes ~130 ms. */
  function racingBackend(page: ReturnType<typeof fakePage>) {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    const backend = {
      /** When the full repair's done reached the page. */
      emittedAt: -1,
      planPlayback: async (_m: MediaRef, _h: CodecHints, _f: boolean, repair = false): Promise<PlaybackPlan> => {
        if (!repair) return { mode: "direct", path: RAW };
        await tick();
        page.emit(done(41, FULL));
        backend.emittedAt = performance.now();
        await tick();
        return {
          mode: "pending",
          jobId: 42,
          output: QUICK,
          repair: { dropsHeaders: true, damagedUntil: 2, quick: true },
          upgrade: { jobId: 41, output: FULL },
        };
      },
    };
    return backend;
  }

  it("has the hold in place when the repair plan is CALLED, so a done that beats the answer is held", async () => {
    const page = fakePage();
    const app = page.listen();
    const backend = racingBackend(page);
    let hold: JobDoneHold | string | null = null;
    const rec = recordPlans(backend, (p) => p === RAW, () => {
      hold ??= holdJobDone(page.host, holdsFullRepair);
    });
    const plan = await backend.planPlayback(media(RAW), HINTS, false, true);
    expect(app).toEqual([]);
    const h = asHold(hold);
    expect(h.heldIds).toEqual([plan.mode === "pending" ? plan.upgrade?.jobId : -1]);
    h.release();
    expect(app).toEqual([41]);
    expect(rec.calls.map((c) => [c.repair, c.answer, c.upgrade?.jobId])).toEqual([[true, `pending ${HASH}.quick.mp4`, 41]]);
    rec.restore();
  });

  // The viewer block splits the card's texts at this moment: before it the
  // page did not yet know an instant copy was coming.
  it("dates the answer when it reaches the caller, after what the page saw while it waited", async () => {
    const page = fakePage();
    page.listen();
    const backend = racingBackend(page);
    const rec = recordPlans(backend, (p) => p === RAW, () => {});
    const pending = backend.planPlayback(media(RAW), HINTS, false, true);
    expect(rec.calls[0]?.answeredAt).toBeNull();
    await pending;
    const call = rec.calls[0]!;
    expect(backend.emittedAt).toBeGreaterThan(call.at);
    expect(call.answeredAt).not.toBeNull();
    expect(call.answeredAt!).toBeGreaterThanOrEqual(backend.emittedAt);
    rec.restore();
  });

  it("arms nothing for a plain plan or another file's repair, and passes those through unrecorded", async () => {
    const page = fakePage();
    page.listen();
    const backend = racingBackend(page);
    const real = backend.planPlayback;
    let armed = 0;
    const rec = recordPlans(backend, (p) => p === RAW, () => armed++);
    await backend.planPlayback(media(RAW), HINTS, false, false);
    await backend.planPlayback(media("C:\\fixtures\\other.mp4"), HINTS, false, true);
    expect(armed).toBe(0);
    expect(rec.calls.map((c) => [c.repair, c.answer])).toEqual([[false, "direct"]]);
    rec.restore();
    expect(backend.planPlayback).toBe(real);
  });
});
