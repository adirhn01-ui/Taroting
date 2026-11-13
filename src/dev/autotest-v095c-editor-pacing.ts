// E2E blocks: the VIDEO EDITOR's seek pacing for heavy clips
// (src/editor/playback/seek-pacing.ts). DEV-only: imported lazily by
// autotest.ts, never part of a release bundle.
//
// Nothing under src/editor is imported statically here except types (erased);
// the pacing constants are read from seek-pacing.ts (no side effects) by a
// dynamic import once the blocks start.
//
// Fixtures: counter_audio_h264.mp4 (20 s, 30 fps, a keyframe every second, a
// sound track; light on its own) is forced heavy through the DEV seam
// (`forceHeavy` + `forceOnly`), so "fast" means more than one source second
// per wall second. direct_h264.mp4 is left light. The canvas is 1600x900, not
// the fixtures' 1280x720. The counter's clip starts at 0.5 with srcIn 0.8 and
// speed 1.25, so timeline and source times never coincide.
//
// Every pointer event is dispatched where a hand's would land: the timeline
// canvas's ruler band (pointerId 1), or the theater's seek bar. Every wait
// polls every 20 ms with its own deadline and names what it waited for and
// what it saw instead. No wait is counted in frames, and nothing depends on
// focus. Every block releases the pointer, pauses, leaves theater and resets
// the seam's flags in `finally`; the last one parks on Home and deletes every
// project written.

import { ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { createProject, uid } from "../core/project";
import { currentSession } from "../core/session";
import type { Clip, MediaRef, ProjectFile, Track } from "../core/types";
import type { Scheduler } from "../editor/playback/scheduler";
import type { PacingDev } from "../editor/playback/seek-pacing";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { DevHook } from "./autotest";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type EditorPacingCtx = Wave1Ctx;

/** What the editor publishes on window while mounted (editor.ts, DEV). */
type EdHook = DevHook & {
  scheduler: Scheduler;
  timeline: { xOf(t: number): number; fit(): void };
  seekPacing: PacingDev;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll every 20 ms; `what` is evaluated only on timeout. */
async function until<T>(get: () => T | null | undefined | false, ms: number, what: () => string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what()}`);
    await sleep(20);
  }
}

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E | null => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E[] => Array.from(root.querySelectorAll<E>(sel));
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
const f3 = (n: number): string => n.toFixed(3);
const isNamed = (path: string, name: string): boolean => path.replace(/\//g, "\\").toLowerCase().endsWith(`\\${name.toLowerCase()}`);

function rendered(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
}

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

const AUDIO = { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false };

function clipOf(m: MediaRef, start: number, srcIn: number, srcOut: number, speed: number): Clip {
  return {
    id: uid(),
    mediaId: m.id,
    timelineStart: start,
    srcIn,
    srcOut,
    speed,
    transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
    audio: { ...AUDIO },
  };
}

const videoTrack = (name: string, clips: Clip[]): Track => ({ id: uid(), kind: "video", name, muted: false, clips });

function project(name: string, media: MediaRef[], tracks: Track[]): ProjectFile {
  const p = createProject(name);
  return { ...p, media, timeline: { ...p.timeline, width: 1600, height: 900, tracks } };
}

/** The counter clip's mapping (timeline start, srcIn, speed). */
const C_START = 0.5;
const C_IN = 0.8;
const C_SPEED = 1.25;
const counterSrc = (t: number): number => C_IN + (t - C_START) * C_SPEED;

/* ---------------- write logging on the scheduler's own elements ---------------- */

/** Log every currentTime / playbackRate / src / muted / volume write and every
 *  play / pause on `els` (instance-level, removed by stop()). Entry: "<i> <what>".
 *  `seekingAt` holds, for every currentTime write in order, whether that
 *  element was still seeking when it was written (a write that cancels a seek). */
function logWrites(els: readonly HTMLVideoElement[]): { log: string[]; seekingAt: boolean[]; stop(): void } {
  const log: string[] = [];
  const seekingAt: boolean[] = [];
  const proto = HTMLMediaElement.prototype;
  const props = ["currentTime", "playbackRate", "src", "muted", "volume"] as const;
  els.forEach((el, i) => {
    for (const p of props) {
      const d = Object.getOwnPropertyDescriptor(proto, p)!;
      Object.defineProperty(el, p, {
        configurable: true,
        get(this: HTMLVideoElement) {
          return d.get!.call(this);
        },
        set(this: HTMLVideoElement, v: unknown) {
          if (p === "currentTime") seekingAt.push(this.seeking);
          log.push(`${i} ${p}=${typeof v === "number" ? String(v) : String(v).slice(-40)}`);
          d.set!.call(this, v);
        },
      });
    }
    Object.defineProperty(el, "play", {
      configurable: true,
      value(this: HTMLVideoElement) {
        log.push(`${i} play`);
        return proto.play.call(this);
      },
    });
    Object.defineProperty(el, "pause", {
      configurable: true,
      value(this: HTMLVideoElement) {
        log.push(`${i} pause`);
        proto.pause.call(this);
      },
    });
  });
  return {
    log,
    seekingAt,
    stop(): void {
      for (const el of els) {
        for (const p of [...props, "play", "pause"]) delete (el as unknown as Record<string, unknown>)[p];
      }
    },
  };
}

/** Count the live "seeked" listeners on `els` (instance-level). */
function countSeeked(els: readonly HTMLVideoElement[]): { live(): number; stop(): void } {
  const live = new Set<unknown>();
  const proto = EventTarget.prototype;
  for (const el of els) {
    Object.defineProperty(el, "addEventListener", {
      configurable: true,
      value(this: HTMLVideoElement, type: string, fn: EventListenerOrEventListenerObject, o?: unknown) {
        if (type === "seeked") live.add(fn);
        return proto.addEventListener.call(this, type, fn, o as AddEventListenerOptions);
      },
    });
    Object.defineProperty(el, "removeEventListener", {
      configurable: true,
      value(this: HTMLVideoElement, type: string, fn: EventListenerOrEventListenerObject, o?: unknown) {
        if (type === "seeked") live.delete(fn);
        return proto.removeEventListener.call(this, type, fn, o as EventListenerOptions);
      },
    });
  }
  return {
    live: () => live.size,
    stop(): void {
      for (const el of els) {
        delete (el as unknown as Record<string, unknown>)["addEventListener"];
        delete (el as unknown as Record<string, unknown>)["removeEventListener"];
      }
    },
  };
}

function firstDiff(a: readonly string[], b: readonly string[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `entry ${i}: "${a[i] ?? "(none)"}" vs "${b[i] ?? "(none)"}"`;
  return "equal";
}

/* ================================================================== */

export async function runEditorPacingBlocks(ctx: EditorPacingCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const sp = await import("../editor/playback/seek-pacing");
  const COUNTER = `${fixturesDir}\\counter_audio_h264.mp4`;
  const DIRECT = `${fixturesDir}\\direct_h264.mp4`;
  const paths: string[] = [];

  const hook = (): EdHook | undefined => (window as unknown as { __tarotingDev?: EdHook }).__tarotingDev;

  const needFixtures = async (): Promise<void> => {
    for (const p of [COUNTER, DIRECT]) assert(await ipc.pathExists(p), `fixture ${p} is missing — run npm run fixtures`);
  };

  /** Close dialogs, discard the temp session, park on Home. Never throws. */
  const backHome = async (): Promise<void> => {
    try {
      closeMenu();
      for (const b of $$(".modal-backdrop")) {
        const out = b.querySelector<HTMLElement>('[data-act="cancel"], [data-cancel], [data-close], [data-close-btn]');
        if (out) out.click();
        else b.remove();
      }
      const s = currentSession.get();
      if (s && s.temp.get()) await discardTempSession(s);
      navigate({ view: "home" });
      await until(() => $(".home") && !$(".editor") && !$("#vw") && !$(".settings"), 5_000, () => `Home (${onScreen()})`);
    } catch (e) {
      console.error("editor pacing autotest: cleanup did not finish", e);
    }
  };

  /** Save `p` as a temp .trt in the autotest root and open the video editor
   *  on it, every media ready to play. */
  const mount = async (p: ProjectFile, name: string): Promise<EdHook> => {
    const path = await ipc.tempProjectPath(name);
    assert(/taroting-autotest/i.test(path), `the temp project path ${path} is not inside the autotest root — refusing to write there`);
    paths.push(path);
    await ipc.saveProject(path, p);
    const prev = hook();
    navigate({ view: "editor", projectPath: path, temp: true });
    const dev = await until(
      () => {
        const d = hook();
        return d && d !== prev && $(".editor:not(.imged)") && $("#media-list") && d.seekPacing ? d : null;
      },
      8_000,
      () => `the video editor on "${name}" with its seek pacing seam — on screen: ${onScreen()}`,
    );
    await until(
      () => p.media.every((m) => dev.media.status.get()[m.id]?.state === "ready"),
      8_000,
      () => `every media ready — ${JSON.stringify(dev.media.status.get())}`,
    );
    dev.engine.pause();
    dev.timeline.fit();
    await sleep(40);
    return dev;
  };

  const probe = async (path: string): Promise<MediaRef> => ({ id: uid(), ...(await ipc.probeMedia(path)) });

  /** A pointer event on the ruler band at timeline time `t`. */
  const ruler = (dev: EdHook, type: string, t: number): void => {
    const c = $<HTMLCanvasElement>(".timeline-canvas");
    if (!rendered(c)) throw new Error("no painted .timeline-canvas");
    const r = c.getBoundingClientRect();
    const x = r.left + dev.timeline.xOf(t);
    assert(x > r.left && x < r.right - 2, `timeline time ${f3(t)} s is off the canvas (x ${x.toFixed(0)}, canvas ${r.left.toFixed(0)}..${r.right.toFixed(0)})`);
    c.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: r.top + 12,
      }),
    );
  };

  /** What a block's cleanup could not undo; the next block refuses to start
   *  on it (so a failure is named where it happened, not where it shows). */
  let leftover: string | null = null;
  const noLeftover = (): void => {
    const l = leftover;
    leftover = null;
    assert(l === null, `the previous block could not clean up: ${l}`);
  };

  /** Release whatever is held, pause, leave theater, reset the seam. Never
   *  throws: what it cannot undo goes to `leftover`. */
  const settle = async (dev: EdHook | undefined, heldAt: number | null): Promise<void> => {
    const problems: string[] = [];
    try {
      if (dev && heldAt !== null) ruler(dev, "pointerup", heldAt);
    } catch {
      /* the canvas is gone (theater): the release below stands in for it */
    }
    try {
      dev?.engine.pause();
      if ($(".editor__preview.theater")) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await until(() => !$(".editor__preview.theater"), 1_000, () => "theater to close").catch(() => {
          problems.push("theater did not close on Escape");
        });
      }
      if (dev) {
        // a gesture whose pointerup never arrived still has its release
        // listeners: end it the way a pointerup would
        if (dev.seekPacing.snapshot().listeningEnd) dev.seekPacing.release();
        dev.seekPacing.disabled = false;
        dev.seekPacing.forceHeavy = false;
        dev.seekPacing.forceOnly = null;
        const s = dev.seekPacing.snapshot();
        if (s.listeningEnd || s.holding) problems.push(`pacing still engaged: ${JSON.stringify(s)}`);
      }
    } catch (e) {
      problems.push(String(e));
    }
    if (problems.length > 0) leftover = problems.join("; ");
  };

  /** Force the counter heavy, ask its index once with a press, and wait for
   *  the answer. Returns the played file and its keyframes. */
  const primeCounter = async (dev: EdHook, counter: MediaRef, at: number): Promise<{ file: string; keys: number[] }> => {
    const pd = dev.seekPacing;
    pd.forceHeavy = true;
    pd.forceOnly = "counter_audio_h264.mp4";
    const st = dev.media.status.get()[counter.id];
    assert(st?.state === "ready", `the counter is not ready: ${JSON.stringify(st)}`);
    const file = st?.state === "ready" ? st.sourcePath : "";
    assert(isNamed(file, "counter_audio_h264.mp4"), `the counter plays from ${file}, not the fixture: forceOnly would not match`);
    ruler(dev, "pointerdown", at);
    ruler(dev, "pointerup", at);
    await until(
      () => pd.snapshot().indexed.find((e) => e.file === file && e.done),
      3_000,
      () => `the counter's keyframe index — ${JSON.stringify(pd.snapshot().indexed)}`,
    );
    const ix = await ipc.keyframeTimes(file);
    assert(ix !== null && ix.times.length > 5, `the counter's keyframe index is ${JSON.stringify(ix)}`);
    const entry = pd.snapshot().indexed.find((e) => e.file === file)!;
    assert(entry.forced, `the counter's index does not make it heavy even forced: ${JSON.stringify(entry)}`);
    return { file, keys: ix!.times };
  };

  /** The counter's shown element (single-track project). */
  const counterEl = (dev: EdHook): Promise<HTMLVideoElement> =>
    until(
      () => dev.scheduler.activeVideo(),
      2_000,
      () => `an active video on the stage (playhead ${f3(dev.engine.time)} s, ${dev.scheduler.visibleClipsAt(dev.engine.time).length} clip(s) under it, playing ${String(dev.engine.playing)})`,
    );

  /** Wait until `el` has settled on the exact source time of the playhead. */
  const settledExact = async (dev: EdHook, el: HTMLVideoElement, capMs: number, what: string): Promise<number> => {
    const t0 = performance.now();
    await until(
      () => !el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - counterSrc(dev.engine.time)) <= 0.01,
      capMs,
      () => `${what}: the element exact at ${f3(counterSrc(dev.engine.time))} s (at ${f3(el.currentTime)}, seeking ${String(el.seeking)}, readyState ${el.readyState})`,
    );
    return Math.round(performance.now() - t0);
  };

  /** The pacer is at rest: nothing dragged, in flight, timed or listened to. */
  const clean = (dev: EdHook, what: string): void => {
    const s = dev.seekPacing.snapshot();
    const busy = s.pacers.filter((p) => p.dragging || p.held || p.flight !== "none" || p.restArmed || p.listening || p.want !== null);
    assert(!s.listeningEnd && s.engaged === 0 && !s.holding && busy.length === 0, `${what}: pacing state left behind — ${JSON.stringify(s)}`);
  };

  let p2: { dev: EdHook; counter: MediaRef } | null = null;
  /** The single-track counter project, mounted once and reused. */
  const counterProject = async (): Promise<{ dev: EdHook; counter: MediaRef }> => {
    noLeftover();
    if (p2 !== null && hook() === p2.dev && $(".editor:not(.imged)") !== null) return p2;
    await backHome();
    await needFixtures();
    const counter = await probe(COUNTER);
    const p = project("Editor pacing", [counter], [videoTrack("V", [clipOf(counter, C_START, C_IN, 19, C_SPEED)])]);
    const dev = await mount(p, "Editor pacing");
    p2 = { dev, counter };
    return p2;
  };

  try {
    /* ============================================================ */
    /* (1) a light layer writes exactly what it wrote without pacing */
    /* ============================================================ */
    await test("editor-pacing-light-identical", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      try {
        await backHome();
        await needFixtures();
        const direct = await probe(DIRECT);
        const counter = await probe(COUNTER);
        const p = project("Editor pacing two", [direct, counter], [
          videoTrack("Top", [clipOf(direct, 0, 1.7, 25, 1)]),
          videoTrack("Bottom", [clipOf(counter, C_START, C_IN, 19, C_SPEED)]),
        ]);
        dev = await mount(p, "Editor pacing two");
        await primeCounter(dev, counter, 2.3);
        const d = dev;
        const els = d.scheduler.videoElements();
        const burst = async (disabled: boolean): Promise<{ log: string[]; keyAimed: number }> => {
          d.seekPacing.disabled = disabled;
          d.engine.seek(2.3);
          await until(() => els.every((e) => !e.seeking), 2_000, () => "every element settled before the burst");
          d.seekPacing.resetCounters();
          const w = logWrites(els);
          try {
            ruler(d, "pointerdown", 2.3);
            held = 2.3;
            for (let i = 1; i <= 25; i++) {
              await sleep(8);
              held = 2.3 + (i * (9.7 - 2.3)) / 25;
              ruler(d, "pointermove", held);
            }
            ruler(d, "pointerup", held);
            held = null;
            d.engine.seek(2.3);
            await until(() => els.every((e) => !e.seeking), 3_000, () => `every element settled after the burst (${els.map((e) => String(e.seeking)).join(",")})`);
            return { log: [...w.log], keyAimed: d.seekPacing.counters.keyAimed };
          } finally {
            w.stop();
          }
        };
        const off = await burst(true);
        const on = await burst(false);
        // elements 0 and 1 are the top (light) layer's A/B pair. The audio
        // graph sets volume and muted once, when it first takes an element,
        // at a moment of its own: those two are not the scheduler's writes.
        const top = (log: string[]) =>
          log.filter((e) => (e.startsWith("0 ") || e.startsWith("1 ")) && !/^\d+ (volume|muted)=/.test(e));
        assert(top(off.log).length > 25, `the top layer logged only ${top(off.log).length} writes: the burst did not reach it`);
        assert(firstDiff(top(on.log), top(off.log)) === "equal", `the light top layer's writes changed with pacing on: ${firstDiff(top(on.log), top(off.log))}`);
        const ix = d.seekPacing.snapshot().indexed;
        assert(ix.some((e) => isNamed(e.file, "counter_audio_h264.mp4")), `the counter was never indexed: ${JSON.stringify(ix)}`);
        assert(!ix.some((e) => isNamed(e.file, "direct_h264.mp4")), `the light file was indexed: ${JSON.stringify(ix)}`);
        assert(off.keyAimed === 0 && on.keyAimed > 0, `keyframe seeks: off ${off.keyAimed}, on ${on.keyAimed} (want 0, then > 0)`);
        return `top layer ${top(on.log).length} writes identical on/off; heavy layer ${on.keyAimed} keyframe seeks on, 0 off — ${ms(t0)}`;
      } finally {
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (2) a paused heavy drag shows pictures, then rests exact      */
    /* ============================================================ */
    await test("editor-pacing-heavy-drag-rest", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      let stopFrames = false;
      try {
        const sh = await counterProject();
        dev = sh.dev;
        const d = dev;
        const { keys } = await primeCounter(d, sh.counter, 1.4);
        d.engine.seek(1.4);
        const el = await counterEl(d);
        await settledExact(d, el, 2_000, "before the drag");
        const presented: number[] = [];
        const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
          presented.push(meta.mediaTime);
          if (!stopFrames) el.requestVideoFrameCallback(onFrame);
        };
        el.requestVideoFrameCallback(onFrame);
        d.seekPacing.resetCounters();
        const w = logWrites([el]);
        const asked: number[] = [];
        let duringDrag: number[] = [];
        // a pointer position is a whole or fractional CSS pixel: one and a half
        // of them is how far the playhead may sit from the time asked
        const pxPerS = d.timeline.xOf(1) - d.timeline.xOf(0);
        const tol = Math.max(0.002, 1.5 / pxPerS);
        try {
          ruler(d, "pointerdown", 1.4);
          held = 1.4;
          for (let i = 1; i <= 30; i++) {
            await sleep(8);
            held = 1.4 + (i * (14.6 - 1.4)) / 30;
            ruler(d, "pointermove", held);
            asked.push(counterSrc(d.engine.time));
            assert(Math.abs(d.engine.time - held) < tol, `move ${i}: the playhead is at ${f3(d.engine.time)} s, the pointer asked ${f3(held)} s`);
          }
          duringDrag = [...presented];
        } finally {
          w.stop();
        }
        const c = { ...d.seekPacing.counters };
        const distinct = new Set(duringDrag.map((m) => m.toFixed(3))).size;
        assert(distinct >= 2, `only ${distinct} distinct picture(s) were presented during the drag: ${duringDrag.map(f3).join(", ")}`);
        assert(c.keyAimed >= 2, `only ${c.keyAimed} keyframe seek(s) during a fast drag: ${JSON.stringify(c)}`);
        assert(c.issued < 30, `${c.issued} seeks were issued for 30 moves: the pacing did not hold one in flight`);
        // seeks actually LANDED during the drag (a seek superseded before it
        // lands shows nothing on a heavy file), and real keyframe pictures
        // were presented, not only pictures an exact seek happened to reach
        assert(c.landed >= 2, `only ${c.landed} paced seek(s) landed during the drag: ${JSON.stringify(c)}`);
        const keyShown = new Set(duringDrag.filter((m) => keys.some((k) => Math.abs(k - m) <= 1 / 60)).map((m) => m.toFixed(3))).size;
        assert(keyShown >= 2, `only ${keyShown} keyframe picture(s) were presented during the drag: ${duringDrag.map(f3).join(", ")}`);
        // a write made while the element was still seeking cancels that seek:
        // only a keyframe superseding an exact seek may do that
        const cancelling = w.seekingAt.filter((s) => s).length;
        assert(cancelling <= c.superseded, `${cancelling} write(s) cancelled a seek in flight, but only ${c.superseded} supersession(s) were counted: ${JSON.stringify(c)}`);
        const seeks = w.log.filter((e) => e.startsWith("0 currentTime=")).map((e) => Number(e.slice("0 currentTime=".length)));
        for (const s of seeks) {
          const ok = keys.some((k) => Math.abs(k - s) < 1e-6) || asked.some((a) => Math.abs(a - s) < 1e-6) || Math.abs(s - counterSrc(1.4)) < 1e-6;
          assert(ok, `a write to ${f3(s)} s during the drag is neither a keyframe of the index nor an asked time`);
        }
        // hold still at a mid-GOP position: the exact frame lands
        const restMs = await settledExact(d, el, sp.REST_MS + 1_500, "after the pointer rested");
        await sleep(60);
        const want = counterSrc(d.engine.time);
        const last = presented.at(-1) ?? Number.NaN;
        assert(Math.abs(last - want) <= 1 / 30 + 1e-3, `the last presented picture is at ${f3(last)} s, the exact frame is ${f3(want)} s`);
        ruler(d, "pointerup", held);
        held = null;
        clean(d, "after the release");
        return `30 moves: ${distinct} pictures, ${c.keyAimed} keyframe / ${c.exact} exact of ${c.issued} seeks; exact frame ${restMs} ms after the last move — ${ms(t0)}`;
      } finally {
        stopFrames = true;
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (3) the release in theater writes the exact frame at once     */
    /* ============================================================ */
    await test("editor-pacing-release-exact", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let seekEl: HTMLElement | null = null;
      const fire = (type: string, frac: number): void => {
        if (seekEl === null) return;
        const b = seekEl.getBoundingClientRect();
        seekEl.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: b.left + b.width * frac,
            clientY: b.top + b.height / 2,
          }),
        );
      };
      let pressedAt: number | null = null;
      try {
        const sh = await counterProject();
        dev = sh.dev;
        const d = dev;
        await primeCounter(d, sh.counter, 2);
        $<HTMLButtonElement>("#tr-fullscreen")!.click();
        await until(() => $(".editor__preview.theater"), 1_000, () => "theater to open");
        seekEl = await until(() => {
          const s = $(".theater-bar [data-el='seek']");
          return rendered(s) ? s : null;
        }, 1_000, () => "a painted theater seek bar");
        const el = await counterEl(d);
        fire("pointerdown", 0.1);
        pressedAt = 0.1;
        for (let i = 1; i <= 12; i++) {
          await sleep(8);
          pressedAt = 0.1 + i * 0.06;
          fire("pointermove", pressedAt);
        }
        const before = { ...d.seekPacing.counters };
        fire("pointerup", pressedAt);
        pressedAt = null;
        const after = { ...d.seekPacing.counters };
        assert(after.releases === before.releases + 1, `the release was not seen: releases ${before.releases} → ${after.releases}`);
        assert(after.exact === before.exact + 1, `the release issued ${after.exact - before.exact} exact seek(s), want 1`);
        const took = await settledExact(d, el, 400, "after the theater release");
        clean(d, "after the theater release");
        return `theater bar: ${before.keyAimed} keyframe seeks, release exact in ${took} ms — ${ms(t0)}`;
      } finally {
        if (pressedAt !== null) fire("pointerup", pressedAt);
        await settle(dev, null);
      }
    });

    /* ============================================================ */
    /* (4) cancel, refresh, pause/play mid-drag leave nothing behind */
    /* ============================================================ */
    await test("editor-pacing-guards", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      let counted: { live(): number; stop(): void } | null = null;
      try {
        const sh = await counterProject();
        dev = sh.dev;
        const d = dev;
        await primeCounter(d, sh.counter, 3);
        const els = d.scheduler.videoElements();
        counted = countSeeked(els);
        const el = await counterEl(d);
        const fast = async (from: number, to: number, n: number): Promise<void> => {
          for (let i = 1; i <= n; i++) {
            await sleep(8);
            held = from + (i * (to - from)) / n;
            ruler(d, "pointermove", held);
          }
        };
        // (a) Escape mid-drag puts the playhead back where the press found it
        d.engine.seek(3);
        await settledExact(d, el, 2_000, "(a) before the press");
        ruler(d, "pointerdown", 6);
        held = 6;
        await fast(6, 11, 8);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        assert(Math.abs(d.engine.time - 3) < 1e-6, `(a) Escape left the playhead at ${f3(d.engine.time)} s, not the 3 s it was at before the press`);
        assert(!d.seekPacing.snapshot().listeningEnd, "(a) the release listeners outlived the cancel");
        ruler(d, "pointerup", held);
        held = null;
        await settledExact(d, el, 2_000, "(a) after Escape");
        // (b) a refresh mid-drag makes one exact write, then the drag goes on
        ruler(d, "pointerdown", 4);
        held = 4;
        await fast(4, 8, 6);
        const w = logWrites([el]);
        let refreshWrites: string[] = [];
        try {
          d.engine.refresh();
          refreshWrites = w.log.filter((e) => e.startsWith("0 currentTime="));
        } finally {
          w.stop();
        }
        // today's exact seek: the element is on (or already going to) the
        // playhead's source time right after the refresh, whether it took a write or not
        assert(
          Math.abs(el.currentTime - counterSrc(d.engine.time)) <= 0.01,
          `(b) after the refresh the element is at ${f3(el.currentTime)} s, not the playhead's ${f3(counterSrc(d.engine.time))} s`,
        );
        assert(refreshWrites.length <= 1, `(b) the refresh wrote ${refreshWrites.length} seeks: ${refreshWrites.join(", ")}`);
        const k0 = d.seekPacing.counters.keyAimed;
        await fast(8, 12, 6);
        assert(d.seekPacing.counters.keyAimed > k0, "(b) the drag was not paced again after the refresh");
        ruler(d, "pointerup", held);
        held = null;
        await settledExact(d, el, 2_000, "(b) after the release");
        // (c) pause / play / pause in the middle of a drag
        ruler(d, "pointerdown", 5);
        held = 5;
        await fast(5, 7, 4);
        d.engine.pause();
        d.engine.play();
        await fast(7, 9, 4);
        d.engine.pause();
        await fast(9, 10, 3);
        ruler(d, "pointerup", held);
        held = null;
        await settledExact(d, el, 2_000, "(c) after the final release");
        await sleep(sp.REST_MS + 50);
        assert(counted.live() === 0, `${counted.live()} "seeked" listener(s) left on the scheduler's elements`);
        clean(d, "after the guards");
        return `Escape, refresh (${refreshWrites.length} write), pause/play/pause mid-drag: exact at the end, no listener left — ${ms(t0)}`;
      } finally {
        counted?.stop();
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (5) a playing drag holds the element to the engine's clock    */
    /* ============================================================ */
    await test("editor-pacing-playing-drag", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      try {
        const sh = await counterProject();
        dev = sh.dev;
        const d = dev;
        await primeCounter(d, sh.counter, 2);
        await d.audioGraph.devEnsureRunning();
        d.audioGraph.devMasterAnalyser();
        d.engine.seek(2);
        d.engine.play();
        await until(() => d.engine.playing && d.scheduler.masterClockTime() !== null, 1_500, () => "the counter playing as the clock");
        ruler(d, "pointerdown", 3);
        held = 3;
        for (let i = 1; i <= 20; i++) {
          await sleep(8);
          held = 3 + i * 0.25;
          ruler(d, "pointermove", held);
          const s = d.seekPacing.snapshot();
          assert(s.holding, `move ${i}: the playing drag does not hold the element (${JSON.stringify(s.pacers)})`);
          assert(d.scheduler.masterClockTime() === null, `move ${i}: the held element is still the clock (${f3(d.scheduler.masterClockTime() ?? -1)})`);
        }
        ruler(d, "pointerup", held);
        held = null;
        const t1 = d.engine.time;
        let prev = t1;
        let back = 0;
        let clockAfter = -1;
        const start = performance.now();
        while (performance.now() - start < 600) {
          await sleep(20);
          const now = d.engine.time;
          back = Math.max(back, prev - now);
          prev = now;
          if (clockAfter < 0 && d.scheduler.masterClockTime() !== null) clockAfter = Math.round(performance.now() - start);
        }
        if (clockAfter < 0) {
          await until(() => d.scheduler.masterClockTime() !== null, 500, () => `the element to be the clock again about 1 s after the release (${JSON.stringify(d.seekPacing.snapshot().pacers)})`);
          clockAfter = Math.round(performance.now() - start);
        }
        assert(d.engine.playing, "playback stopped after the playing drag");
        assert(d.engine.time > t1, `the playhead did not advance after the release (${f3(t1)} → ${f3(d.engine.time)})`);
        assert(back <= 0.15, `the playhead stepped back ${f3(back)} s after the release`);
        d.engine.pause();
        const el = await counterEl(d);
        await settledExact(d, el, 2_000, "after the pause");
        clean(d, "after the playing drag");
        return `held through 20 moves while playing; clock back ${clockAfter} ms after release, worst step back ${f3(back)} s — ${ms(t0)}`;
      } finally {
        await settle(dev, held);
      }
    });
  } finally {
    p2 = null;
    await backHome();
    for (const p of paths) await ipc.deleteProject(p).catch(() => {});
  }
}
