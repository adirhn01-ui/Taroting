// The damaged-video E2E blocks' plumbing (DEV harness only; autotest.ts is
// its one importer): which cache file a repair copy is, the plan recorder,
// and the hold on the full repair's job:done. Kept apart from autotest.ts so
// vitest can drive it with fakes — autotest.ts pulls in the editor and only
// loads inside the app. Type imports only, for the same reason.

import type { CodecHints, PlaybackPlan, RepairNote, UpgradeJob } from "../core/ipc";
import type { MediaRef } from "../core/types";

export const lastName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);

/* The cache names, as the backend's one table for repair outputs writes them
 * (`repair_target` in src-tauri/src/media/playability.rs). */

/** The instant copy: a stream copy from the first clean keyframe. */
export const isQuickCopy = (p: string): boolean => /\.quick\.mp4$/i.test(p);
/** A FULL repair of either recipe — `.repairh.mp4` decoded with the in-band
 *  SPS/PPS/SEI removed, `.repair.mp4` with them kept. For what must catch ANY
 *  full copy: the guards against one arriving early, the hold, the cleanup. */
export const isFullCopy = (p: string): boolean => /\.repairh?\.mp4$/i.test(p);
/** The full repair that drops the in-band headers: the only one the damaged
 *  fixture may get (its garbage parses as an SPS and an orientation SEI, so a
 *  copy that kept them comes out resized and turned). */
export const isHeaderFreeCopy = (p: string): boolean => /\.repairh\.mp4$/i.test(p);

/** Every cache file a repair of one source can leave, from its full copy's
 *  path: both full-repair recipes in proxy\ and the instant copy in remux\,
 *  all named by the source's one hash. */
export function repairFamily(full: string): string[] {
  const sep = Math.max(full.lastIndexOf("\\"), full.lastIndexOf("/"));
  const dir = full.slice(0, sep);
  const root = dir.slice(0, Math.max(dir.lastIndexOf("\\"), dir.lastIndexOf("/")));
  const hash = full.slice(sep + 1).split(".")[0] ?? "";
  if (!/^[0-9a-f]{16}$/i.test(hash) || root === "") return [full];
  return [`${dir}\\${hash}.repairh.mp4`, `${dir}\\${hash}.repair.mp4`, `${root}\\remux\\${hash}.quick.mp4`];
}

export interface PlanCall {
  repair: boolean;
  /** "direct" / "ready <file>" / "pending <file>" / "threw …" once answered. */
  answer: string;
  note: RepairNote | undefined;
  /** What the answer names: the ready path or the pending output. */
  file: string | null;
  upgrade: UpgradeJob | undefined;
  /** performance.now() when it was asked for, and when its answer reached
   *  the caller (null until then, or when it threw): what the page did in
   *  between was before it knew what the plan would be. */
  at: number;
  answeredAt: number | null;
}

type PlanFn = (media: MediaRef, hints: CodecHints, forceProxyLarge: boolean, repair?: boolean) => Promise<PlaybackPlan>;

/** Every planPlayback `target` is asked for a file `subject` names, through
 *  the shared `ipc` object both the media manager and the viewer's loader call
 *  it on (the way open-during-editor-mount holds ipc.loadProject). Other files
 *  pass straight through unrecorded. `beforeRepair` runs as a REPAIR plan for
 *  the subject is CALLED, before the backend has started anything: the full
 *  repair is spawned inside that call, and its job:done travels on a channel
 *  of its own — on a 4 s fixture it can land before the answer that names it
 *  (the app's own orphan caches exist for exactly that), so a hold installed
 *  on the answer can be too late. `restore` puts the real one back. */
export function recordPlans(
  target: { planPlayback: PlanFn },
  subject: (path: string) => boolean,
  beforeRepair: () => void,
): { calls: PlanCall[]; restore(): void } {
  const real = target.planPlayback;
  const calls: PlanCall[] = [];
  target.planPlayback = async (media, hints, forceProxyLarge, repair = false) => {
    if (!subject(media.path)) return real(media, hints, forceProxyLarge, repair);
    const call: PlanCall = {
      repair,
      answer: "…unanswered",
      note: undefined,
      file: null,
      upgrade: undefined,
      at: performance.now(),
      answeredAt: null,
    };
    calls.push(call);
    if (repair) beforeRepair();
    try {
      const plan = await real(media, hints, forceProxyLarge, repair);
      if (plan.mode === "direct") {
        call.answer = "direct";
      } else {
        const file = plan.mode === "ready" ? plan.path : plan.output;
        call.file = file;
        call.answer = `${plan.mode} ${lastName(file)}`;
        call.note = plan.repair;
        call.upgrade = plan.upgrade;
      }
      call.answeredAt = performance.now();
      return plan;
    } catch (e) {
      call.answer = `threw ${String(e)}`;
      throw e;
    }
  };
  return {
    calls,
    restore: () => {
      target.planPlayback = real;
    },
  };
}

/** A job:done's payload as the backend sends it (`DoneEvent` in
 *  src-tauri/src/jobs/mod.rs); a playback job's output is `{ path: <its
 *  final file> }` (`ensure_prepared`). Read loosely: it comes off the wire. */
export interface DonePayload {
  id?: unknown;
  output?: { path?: unknown } | null;
}

/** The file a job:done says its job wrote, or null for one that names none. */
export const doneOutputPath = (p: DonePayload | null | undefined): string | null =>
  typeof p?.output?.path === "string" ? p.output.path : null;

/** The full repair's job:done, whoever's job it is: keyed on what it WROTE,
 *  so the hold can be in place before any answer has said which id it has. */
export const holdsFullRepair = (p: DonePayload): boolean => {
  const path = doneOutputPath(p);
  return path !== null && isFullCopy(path);
};

/** Tauri 2.11.5's JS-side event registry: `window[<this>][event]` maps each
 *  listener to the callback id that `__TAURI_INTERNALS__.callbacks` — a live
 *  Map its core.js exposes "for debugging" — runs for it (src/event/mod.rs,
 *  scripts/core.js). A DEV-harness dependency on purpose: the editor's media
 *  manager and the viewer's loader subscribe through closures over `listen`
 *  with no seam of their own, and a Tauri upgrade that renames either makes
 *  holdJobDone fail loudly rather than hold nothing. */
export const TAURI_EVENT_LISTENERS = "__internal_unstable_listeners_object_id__";

export interface JobDoneHold {
  /** The jobs whose job:done was held, each once, in arrival order. */
  readonly heldIds: readonly number[];
  /** job:done deliveries held so far (one per listener). */
  readonly held: number;
  /** Stop holding and hand over what was held, in order, through the
   *  original callbacks of the listeners still registered. Idempotent. */
  release(): void;
}

/** Hold every `job:done` whose payload passes `holds`, from every listener
 *  `host` (the page's window) has now, until `release()`. Progress and failure
 *  events pass straight through, and so does every other done. Both app
 *  listeners exist before they plan (the manager's init and the loader's
 *  `await listening` subscribe first), so a hold made as the plan is called
 *  covers them. Answers the hold, or why there is none. */
export function holdJobDone(host: object, holds: (payload: DonePayload) => boolean): JobDoneHold | string {
  const w = host as Record<string, unknown> & { __TAURI_INTERNALS__?: { callbacks?: unknown } };
  const callbacks = w.__TAURI_INTERNALS__?.callbacks;
  const registry = w[TAURI_EVENT_LISTENERS] as Record<string, Record<string, { handlerId?: unknown } | undefined> | undefined> | undefined;
  const listeners = registry?.["job:done"];
  if (!(callbacks instanceof Map) || listeners === undefined) {
    return `Tauri's event internals are not where 2.11.5 keeps them (callbacks ${callbacks instanceof Map ? "found" : "missing"}, window.${TAURI_EVENT_LISTENERS}["job:done"] ${listeners === undefined ? "missing" : "found"})`;
  }
  const map = callbacks as Map<number, (data: unknown) => unknown>;
  const wrapped = new Map<number, { orig: (data: unknown) => unknown; mine: (data: unknown) => unknown }>();
  const queue: Array<{ id: number; data: unknown }> = [];
  const heldIds: number[] = [];
  let released = false;
  // The registry's entries are defined non-enumerable (defineProperty).
  for (const key of Object.getOwnPropertyNames(listeners)) {
    const id = listeners[key]?.handlerId;
    if (typeof id !== "number" || wrapped.has(id)) continue;
    const orig = map.get(id);
    if (orig === undefined) continue;
    const mine = (data: unknown): unknown => {
      const payload = (data as { payload?: DonePayload } | null)?.payload;
      if (!released && payload !== undefined && payload !== null && holds(payload)) {
        queue.push({ id, data });
        if (typeof payload.id === "number" && !heldIds.includes(payload.id)) heldIds.push(payload.id);
        return undefined;
      }
      return orig(data);
    };
    map.set(id, mine);
    wrapped.set(id, { orig, mine });
  }
  if (wrapped.size === 0) return "no job:done listener is registered to hold";
  return {
    heldIds,
    get held() {
      return queue.length;
    },
    release() {
      if (released) return;
      released = true;
      for (const [id, { orig, mine }] of wrapped) if (map.get(id) === mine) map.set(id, orig);
      for (const { id, data } of queue.splice(0)) {
        const entry = wrapped.get(id);
        if (entry !== undefined && map.get(id) === entry.orig) entry.orig(data);
      }
    },
  };
}
