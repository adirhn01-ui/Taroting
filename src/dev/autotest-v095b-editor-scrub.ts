// 0.9.5 E2E blocks: the VIDEO EDITOR's scrub copy (src/editor/scrub/**).
// DEV-only: imported lazily by autotest.ts, never part of a release bundle.
//
// NOTHING under src/editor is imported statically here except types (erased),
// so loading this file loads no lazy chunk as a side effect. The scrub copy's
// timing constants are read from its own module (a dynamic import of
// precheck.ts, which has no side effects) once the blocks start.
//
// Fixtures: counter_audio_h264.mp4 (a burnt-in frame counter, keyframes 1 s
// apart, ~1 Mbit/s: light on its own) is forced heavy through the editor's DEV
// `forceHeavy` + `forceOnly`, so its copy is made by the REAL job (the
// autotest cache is not the user's, and the viewer's scrub block usually made
// it already). direct_h264.mp4 is left light. The canvas is 1600x900, not the
// fixtures' 1280x720, so no layer fits at 1.
//
// Every pointer event is dispatched where a hand's would land: the timeline
// canvas's ruler band (pointerId 1, the mouse's), or the theater's seek bar.
// A held pointer rests once the playhead has stayed within one frame
// (restTolerance) for REST_MS, however much it trembles inside that frame. So
// a position is held for a check by alternating between it and a point two
// frames on, one move every REST_MS / 2: each move restarts the rest wait and
// costs each copy one seek, and every check compares the copy with the source
// time of the position held at that moment (the engine's time), so the two
// alternating positions (two frames apart, more than the one frame a check
// allows) can never be taken for each other.
// editor-scrub-rests-while-held sends the tremor itself, first below the
// same-position distance and then between it and one frame, and proves the
// rest then comes while the pointer is still down.
//
// Every block ends with the pointer released, playback paused and theater
// left; the last block parks on Home and deletes every project written.
// Waits poll every animation frame or 20 ms with their own short deadline and a
// message naming what they waited for and what was there instead.

import { ipc, mediaUrl } from "../core/ipc";
import { navigate } from "../core/nav";
import { createProject, uid } from "../core/project";
import { currentSession } from "../core/session";
import type { Clip, ClipKeyframes, ClipTransform, MediaRef, ProjectFile, Track } from "../core/types";
import type { EditorScrubDev, EditorScrubSnapshot } from "../editor/scrub/editor-scrub";
import type { Scheduler } from "../editor/playback/scheduler";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { DevHook } from "./autotest";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type EditorScrubCtx = Wave1Ctx;

/** What the editor publishes on window while mounted (editor.ts, DEV). */
type EdHook = DevHook & {
  scheduler: Scheduler;
  timeline: { xOf(t: number): number; fit(): void };
  editorScrub: EditorScrubDev;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await frame();
};

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

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  const copy = el instanceof HTMLElement && el.dataset["scrubCopy"] !== undefined ? "[scrub copy]" : "";
  return `${el.tagName.toLowerCase()}${cls}${copy}`;
}

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

const AUDIO = { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false };
const IDENTITY: ClipTransform = { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 };

function clipOf(m: MediaRef, start: number, srcIn: number, srcOut: number, speed: number, transform: ClipTransform = IDENTITY, keyframes?: ClipKeyframes): Clip {
  return {
    id: uid(),
    mediaId: m.id,
    timelineStart: start,
    srcIn,
    srcOut,
    speed,
    transform,
    ...(keyframes ? { keyframes } : {}),
    audio: { ...AUDIO },
  };
}

const videoTrack = (name: string, clips: Clip[]): Track => ({ id: uid(), kind: "video", name, muted: false, clips });

function project(name: string, media: MediaRef[], tracks: Track[]): ProjectFile {
  const p = createProject(name);
  return { ...p, media, timeline: { ...p.timeline, width: 1600, height: 900, tracks } };
}

/* ---------------- pictures ---------------- */

/** Mean luma over 4x4 blocks of a 64x48 draw. */
function signature(el: HTMLVideoElement): number[] {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 48;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (g === null) throw new Error("no 2D context for a frame signature");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(el, 0, 0, 64, 48);
  const d = g.getImageData(0, 0, 64, 48).data;
  const out: number[] = [];
  for (let by = 0; by < 48; by += 4) {
    for (let bx = 0; bx < 64; bx += 4) {
      let s = 0;
      for (let y = by; y < by + 4; y++) {
        for (let x = bx; x < bx + 4; x++) {
          const i = (y * 64 + x) * 4;
          s += 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
        }
      }
      out.push(s / 16);
    }
  }
  return out;
}

const distance = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / Math.max(1, a.length);

/** The frame `url` shows at `t`, through a CORS-clean probe <video>. */
async function probeAt(url: string, t: number): Promise<number[]> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.preload = "auto";
  Object.assign(v.style, { position: "fixed", left: "0", top: "0", width: "64px", height: "48px", opacity: "0", pointerEvents: "none" });
  document.body.appendChild(v);
  try {
    v.src = url;
    await until(() => v.error !== null || v.readyState >= 1, 4_000, () => "a probe <video> to load");
    if (v.error) throw new Error(`a probe <video> could not load ${url}: error ${v.error.code}`);
    v.currentTime = t;
    await until(
      () => v.error !== null || (!v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.05),
      3_000,
      () => `a probe <video> to settle at ${f3(t)} s (at ${f3(v.currentTime)}, readyState ${v.readyState})`,
    );
    await frames(2);
    return signature(v);
  } finally {
    v.removeAttribute("src");
    v.load();
    v.remove();
  }
}

/* ---------------- the real elements' writes ---------------- */

/** Log every currentTime / playbackRate / src write and every play / pause on
 *  the scheduler's own elements (instance-level, removed by the returned
 *  function). */
function logMainWrites(els: readonly HTMLVideoElement[]): { log: string[]; stop(): void } {
  const log: string[] = [];
  const proto = HTMLMediaElement.prototype;
  const props = ["currentTime", "playbackRate", "src"] as const;
  els.forEach((el, i) => {
    for (const p of props) {
      const d = Object.getOwnPropertyDescriptor(proto, p)!;
      Object.defineProperty(el, p, {
        configurable: true,
        get(this: HTMLVideoElement) {
          return d.get!.call(this);
        },
        set(this: HTMLVideoElement, v: unknown) {
          log.push(`${i} ${p}=${typeof v === "number" ? v.toFixed(4) : String(v).slice(-40)}`);
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
    stop(): void {
      for (const el of els) {
        for (const p of [...props, "play", "pause"]) delete (el as unknown as Record<string, unknown>)[p];
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

export async function runEditorScrubBlocks(ctx: EditorScrubCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  /** REST_MS, CATCHUP_MAX_MS, SAME_POSITION_S and restTolerance, as the module has them. */
  const sc = await import("../editor/scrub/precheck");
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
      console.error("editor scrub autotest: cleanup did not finish", e);
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
        return d && d !== prev && $(".editor:not(.imged)") && $("#media-list") && d.editorScrub ? d : null;
      },
      8_000,
      () => `the video editor on "${name}" with its scrub seam — on screen: ${onScreen()}`,
    );
    await until(
      () => p.media.every((m) => dev.media.status.get()[m.id]?.state === "ready"),
      8_000,
      () => `every media ready — ${JSON.stringify(dev.media.status.get())}`,
    );
    dev.engine.pause();
    dev.timeline.fit();
    await frames(2);
    return dev;
  };

  const probe = async (path: string): Promise<MediaRef> => ({ id: uid(), ...(await ipc.probeMedia(path)) });

  /* ---------------- the ruler ---------------- */

  const tlCanvas = (): HTMLCanvasElement => {
    const c = $<HTMLCanvasElement>(".timeline-canvas");
    if (!rendered(c)) throw new Error("no painted .timeline-canvas");
    return c as HTMLCanvasElement;
  };
  /** A pointer event on the ruler band at timeline time `t`. */
  const ruler = (dev: EdHook, type: string, t: number): void => {
    const c = tlCanvas();
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

  /* ---------------- the stage ---------------- */

  /** Layer `i`'s shown real element, found from the stage alone (the i-th
   *  layer set's video slot that is displayed and holds a src), never from
   *  the copy: so "the copy sits beside it" is something to prove. */
  const shownMain = (i: number): HTMLVideoElement | null => {
    const set = $$(".preview__canvas > .stage-layer-set")[i];
    if (!set) return null;
    for (const v of Array.from(set.querySelectorAll<HTMLVideoElement>("video.stage-layer__media"))) {
      const pos = v.closest<HTMLElement>(".stage-layer__pos");
      if (pos !== null && pos.style.display !== "none" && v.hasAttribute("src")) return v;
    }
    return null;
  };

  /** Layer `i`'s copy and the real element it stands in for. */
  const pair = (dev: EdHook, i: number): { copy: HTMLVideoElement | null; main: HTMLVideoElement | null } => ({
    copy: dev.editorScrub.copy(i),
    main: shownMain(i),
  });

  const shown = (c: HTMLVideoElement | null): boolean => c !== null && c.style.display === "block" && rendered(c);

  const snap = (dev: EdHook): EditorScrubSnapshot => dev.editorScrub.snapshot();
  const fileOf = (s: EditorScrubSnapshot, name: string) => s.files.find((f) => isNamed(f.file, name));

  /** Wait until the counter's copy is ready (made by the real job). */
  const copyReady = async (dev: EdHook): Promise<number> => {
    const t0 = performance.now();
    await until(
      () => {
        const f = fileOf(snap(dev), "counter_audio_h264.mp4");
        if (f?.state === "failed") throw new Error(`the counter's copy failed: ${f.reason ?? "?"}`);
        return f?.state === "ready";
      },
      15_000,
      () => `the counter's scrub copy to be ready — ${JSON.stringify(snap(dev).files)}`,
    );
    return Math.round(performance.now() - t0);
  };

  /** Where a hold answered: when the rest wait was last started (read before
   *  the move that started it), the ruler time last sent, and the engine's
   *  time at the answer. */
  type Held = { restarted: number; pos: number; at: number };

  /** Hold the ruler around `t` until `ok(at)` answers null, `at` being the
   *  engine's time at that check; its last answer names what was missing. The
   *  caller has just moved to `t` (at `movedAt`, read before that move). Every
   *  REST_MS / 2 the hold moves once, alternating between `t` + 2 frames and
   *  `t` (each move restarts the rest wait), and `ok` is not asked on the
   *  frame of a move. */
  const holdRuler = async (dev: EdHook, t: number, ok: (at: number) => string | null, capMs = 2_000, movedAt = performance.now()): Promise<Held> => {
    const step = 2 * shared!.tol;
    const start = performance.now();
    let restarted = movedAt;
    let pos = t;
    for (;;) {
      await frame();
      if (performance.now() - start > capMs) throw new Error(`held around ${f3(t)} s for ${capMs} ms: ${ok(dev.engine.time) ?? "(it answered only on a move frame)"}`);
      if (performance.now() - restarted >= sc.REST_MS / 2) {
        restarted = performance.now();
        pos = pos === t ? t + step : t;
        ruler(dev, "pointermove", pos);
        continue;
      }
      const at = dev.engine.time;
      if (ok(at) === null) return { restarted, pos, at };
    }
  };

  /* ---------------- the shared project ---------------- */

  // Three video tracks, topmost first:
  //  0: the counter, start 2.0, in 3.0, speed 1.5, offset (+180, -60), crop
  //     {100, 40, 900, 600}, scale keyframes 0.6 → 0.9 and opacity 0.8 → 0.5
  //     (source seconds 4 → 14): heavy (forced).
  //  1: direct_h264, in 1.7, scaled to 0.35 and moved to the lower left:
  //     light, covering a corner of the layer below.
  //  2: the counter again, unmodified, from 0: heavy (the same file).
  /** `tol`: the module's rest tolerance for this project's frame rate (s). */
  type Shared = { dev: EdHook; counter: MediaRef; direct: MediaRef; tol: number };
  let shared: Shared | null = null;
  const sharedProject = async (): Promise<Shared> => {
    const live = shared !== null && hook() === shared.dev && $(".editor:not(.imged)") !== null;
    if (live) return shared!;
    await backHome();
    await needFixtures();
    const counter = await probe(COUNTER);
    const direct = await probe(DIRECT);
    const top = clipOf(
      counter,
      2.0,
      3.0,
      20,
      1.5,
      { ...IDENTITY, x: 180, y: -60, crop: { x: 100, y: 40, w: 900, h: 600 }, opacity: 0.8 },
      {
        scale: [
          { t: 4, v: 0.6 },
          { t: 14, v: 0.9 },
        ],
        opacity: [
          { t: 4, v: 0.8 },
          { t: 14, v: 0.5 },
        ],
      },
    );
    const mid = clipOf(direct, 0, 1.7, 25, 1, { ...IDENTITY, scale: 0.35, x: -500, y: 250 });
    const bottom = clipOf(counter, 0, 0, 20, 1);
    const p = project("Editor scrub", [counter, direct], [videoTrack("Top", [top]), videoTrack("Light", [mid]), videoTrack("Bottom", [bottom])]);
    const dev = await mount(p, "Editor scrub");
    dev.editorScrub.forceOnly = counter.path;
    dev.editorScrub.forceHeavy = true;
    const tol = sc.restTolerance(p.timeline.fps);
    assert(tol > sc.SAME_POSITION_S, `the rest tolerance ${f3(tol)} s at ${p.timeline.fps.num}/${p.timeline.fps.den} fps is not above the same-position distance`);
    shared = { dev, counter, direct, tol };
    return shared;
  };

  /** Top layer's source time at timeline `t` (start 2.0, in 3.0, speed 1.5). */
  const topSrc = (t: number): number => 3.0 + (t - 2.0) * 1.5;

  /** Release whatever is held, pause, leave theater. Never throws. */
  const settle = async (dev: EdHook | undefined, heldAt: number | null): Promise<void> => {
    try {
      if (dev && heldAt !== null) ruler(dev, "pointerup", heldAt);
    } catch {
      /* the canvas is gone */
    }
    try {
      dev?.engine.pause();
      if ($(".editor__preview.theater")) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await sleep(60);
      }
    } catch {
      /* nothing to settle */
    }
  };

  try {
    /* ============================================================ */
    /* (a) a light project: nothing at all                           */
    /* ============================================================ */
    await test("editor-scrub-light-idle", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      try {
        await backHome();
        await needFixtures();
        const direct = await probe(DIRECT);
        const p = project("Editor scrub light", [direct], [videoTrack("V", [clipOf(direct, 0, 1.7, 25, 1)])]);
        dev = await mount(p, "Editor scrub light");
        const s0 = snap(dev);
        assert(!s0.listening && !s0.ticking, `a light project installed listeners: ${JSON.stringify(s0)}`);
        ruler(dev, "pointerdown", 2.1);
        held = 2.1;
        for (const t of [3.4, 5.9, 4.2]) {
          ruler(dev, "pointermove", t);
          await frames(2);
        }
        ruler(dev, "pointerup", 4.2);
        held = null;
        assert(Math.abs(dev.engine.time - 4.2) < 0.05, `the ruler drag did not move the playhead (at ${f3(dev.engine.time)} s) — the timeline did not take the synthetic pointer`);
        await sleep(1_500);
        const s = snap(dev);
        const layers = $$(".preview__canvas > .stage-layer-set").length;
        const vids = $$(".stage-layer__crop video").length;
        assert(
          !s.listening && !s.ticking && s.indexCalls === 0 && s.planCalls === 0 && s.cancels === 0 && s.files.length === 0 && s.layers.length === 0,
          `a light project did scrub-copy work: ${JSON.stringify(s)}`,
        );
        assert(vids === 2 * layers, `${vids} <video> in the stage's crop boxes for ${layers} layer(s): a copy element exists`);
        return `drag + 1.5 s paused dwell on a light clip: no listener, no tick, 0 index reads, 0 plans, ${vids} videos for ${layers} layer(s) — ${ms(t0)}`;
      } finally {
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (b) the copy follows the pointer on every heavy layer         */
    /* ============================================================ */
    await test("editor-scrub-copy", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      let overlay: HTMLElement | null = null;
      try {
        const sh = await sharedProject();
        dev = sh.dev;
        // Queried after the mount: every editor mounts its own overlay.
        overlay = $<HTMLElement>(".stage-overlay");
        dev.engine.seek(2.6);
        const jobMs = await copyReady(dev);

        const positions = [3.1, 4.37, 8.9, 6.2, 11.45, 5.05];
        ruler(dev, "pointerdown", 2.6);
        held = 2.6;
        assert(Math.abs(dev.engine.time - 2.6) < 0.05, `the press did not seek (at ${f3(dev.engine.time)} s)`);
        const follow: string[] = [];
        const opacities: number[] = [];
        const widths: number[] = [];
        let sigBottom: number[] = [];
        let sigBottomOther: number[] = [];
        let tLast = 0;
        let tOther = 0;
        for (let k = 0; k < positions.length; k++) {
          const want = positions[k]!;
          ruler(dev, "pointermove", want);
          held = want;
          // Every check compares against the position held at that moment.
          const h = await holdRuler(dev, want, (at) => {
            for (const [i, s] of [
              [0, topSrc(at)],
              [2, at],
            ] as const) {
              const { copy } = pair(dev!, i);
              if (!shown(copy)) return `layer ${i}'s copy is not shown (${JSON.stringify(snap(dev!).layers)})`;
              if (copy!.seeking || Math.abs(copy!.currentTime - s) > 1 / 30) return `layer ${i}'s copy is at ${f3(copy!.currentTime)} s, not ${f3(s)} (held at ${f3(at)} s)`;
            }
            return null;
          });
          // No move between the answer and the reads below (no await).
          held = h.pos;
          const t = h.at;
          const s2 = t;
          for (const i of [0, 2]) {
            const { copy, main } = pair(dev, i);
            assert(copy !== null && main !== null, `layer ${i} has no copy / real element pair`);
            const a = copy!.getBoundingClientRect();
            const b = main!.getBoundingClientRect();
            const off = Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
            assert(off <= 0.5, `at ${f3(t)} s layer ${i}'s copy box is ${off.toFixed(2)} px off its real element's`);
            assert(copy!.parentElement === main!.parentElement && main!.parentElement?.classList.contains("stage-layer__crop") === true, `layer ${i}'s copy is not in the crop box of the layer's shown real element`);
            assert(copy!.closest(".stage-layer-set") === $$(".preview__canvas > .stage-layer-set")[i], `layer ${i}'s copy is in another layer's set`);
            const rot = main!.closest<HTMLElement>(".stage-layer__rot");
            assert(rot !== null && copy!.closest(".stage-layer__rot") === rot, `layer ${i}'s copy is outside its layer's opacity box`);
            if (i === 0) {
              opacities.push(Number(getComputedStyle(rot!).opacity));
              widths.push(b.width);
            }
          }
          assert($$("video[data-scrub-copy]").length === 2, `${$$("video[data-scrub-copy]").length} copy elements, want 2 (the light layer has none)`);
          follow.push(`${f3(t)}→${f3(pair(dev, 0).copy!.currentTime)}/${f3(pair(dev, 2).copy!.currentTime)}`);
          if (k === positions.length - 2) {
            sigBottomOther = signature(pair(dev, 2).copy!);
            tOther = s2;
          }
          if (k === positions.length - 1) {
            sigBottom = signature(pair(dev, 2).copy!);
            tLast = s2;
          }
        }
        const distinct = new Set(opacities.map((o) => o.toFixed(3))).size;
        assert(distinct >= 3 && new Set(widths.map((w) => w.toFixed(1))).size >= 3, `the keyframed scale/opacity did not change across the held positions (opacity ${opacities.join(", ")}, width ${widths.join(", ")})`);

        // Paint order: the overlay takes the pointer; under it, the light layer
        // covers the heavy one in its corner, and elsewhere the copy paints.
        const canvas = $<HTMLElement>(".preview__canvas")!;
        const cb = canvas.getBoundingClientRect();
        const at = (x: number, y: number): [number, number] => [cb.left + (x * cb.width) / 1600, cb.top + (y * cb.height) / 900];
        const [ox, oy] = at(1500, 800);
        assert(overlay !== null && document.elementFromPoint(ox, oy) === overlay, `the overlay does not take the pointer: ${describeEl(document.elementFromPoint(ox, oy))}`);
        // For the probe only: the overlay and the layer sets (full-canvas,
        // transparent, hit-testable boxes) step aside, and every picture (the
        // real elements and the copies) takes the pointer; paint order then
        // decides each hit. Restored below.
        const copies = $$<HTMLVideoElement>("video[data-scrub-copy]");
        const sets = $$<HTMLElement>(".preview__canvas > .stage-layer-set");
        const pictures = [...$$<HTMLVideoElement>(".preview__canvas video.stage-layer__media"), ...copies];
        const savedPe = new Map<HTMLElement, string>();
        for (const el of [overlay!, ...sets, ...pictures]) savedPe.set(el, el.style.pointerEvents);
        overlay!.style.pointerEvents = "none";
        for (const el of sets) el.style.pointerEvents = "none";
        for (const el of pictures) el.style.pointerEvents = "auto";
        try {
          const onlyBottom = document.elementFromPoint(ox, oy);
          assert(onlyBottom === pair(dev, 2).copy, `where only the bottom heavy layer shows, the top element is ${describeEl(onlyBottom)}, not its copy`);
          const [lx, ly] = at(150, 800);
          const light = document.elementFromPoint(lx, ly);
          const lightMain = $$(".preview__canvas > .stage-layer-set")[1]?.querySelector("video.stage-layer__media:not([style*='display: none'])");
          assert(light instanceof HTMLVideoElement && light.dataset["scrubCopy"] === undefined && light.closest(".stage-layer-set") === $$(".preview__canvas > .stage-layer-set")[1], `under the light layer the top element is ${describeEl(light)}, not the light layer's own element (${describeEl(lightMain ?? null)})`);
          const [tx, ty] = at(980, 390);
          const topHit = document.elementFromPoint(tx, ty);
          assert(topHit === pair(dev, 0).copy, `in the top layer's box the top element is ${describeEl(topHit)}, not its copy`);
        } finally {
          for (const [el, v] of savedPe) el.style.pointerEvents = v;
        }

        // The bottom copy's picture is the file's frame at its time.
        const own = await probeAt(mediaUrl(sh.counter.path), tLast);
        const other = await probeAt(mediaUrl(sh.counter.path), tOther);
        const dOwn = distance(sigBottom, own);
        const dCross = distance(sigBottom, other);
        const dOwn2 = distance(sigBottomOther, other);
        const dCross2 = distance(sigBottomOther, own);
        const said = `copy at ${f3(tLast)} s: ${dOwn.toFixed(2)} from the file there, ${dCross.toFixed(2)} from ${f3(tOther)} s; copy at ${f3(tOther)} s: ${dOwn2.toFixed(2)} / ${dCross2.toFixed(2)}`;
        assert(distance(own, other) > 2, `the file's frames at the two times are only ${distance(own, other).toFixed(2)} apart (${said})`);
        assert(dOwn < 6 && dOwn2 < 6, `a copy's picture is far from the file's frame at its time (${said})`);
        assert(dOwn + 1 < dCross && dOwn2 + 1 < dCross2, `the copy does not show the pointer's frame (${said})`);

        // Release: each copy hides only once its real element is at the frame.
        const tRel = dev.engine.time;
        ruler(dev, "pointerup", held ?? positions[positions.length - 1]!);
        held = null;
        const relStart = performance.now();
        const hidden = new Set<number>();
        while (hidden.size < 2) {
          await frame();
          for (const [i, s] of [
            [0, topSrc(tRel)],
            [2, tRel],
          ] as const) {
            if (hidden.has(i)) continue;
            const { copy, main } = pair(dev, i);
            if (shown(copy)) continue;
            hidden.add(i);
            const at0 = main!.currentTime;
            assert(
              !main!.seeking && main!.readyState >= 2 && Math.abs(at0 - s) <= 0.011,
              `layer ${i}'s copy hid before its real element was at ${f3(s)} s (at ${f3(at0)}, seeking ${String(main!.seeking)}, readyState ${main!.readyState})`,
            );
          }
          if (performance.now() - relStart > 4_500) throw new Error(`the copies did not hide after the release: ${JSON.stringify(snap(dev).layers)}`);
        }
        const s = snap(dev);
        assert(s.indexCalls === 1 && s.planCalls === 1, `two clips of one file on two tracks read ${s.indexCalls} index(es) and asked ${s.planCalls} plan(s)`);

        // A frame step after the drag shows the real file.
        const before = dev.engine.time;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        // One frame on: to the centre of the next 1/30 s frame.
        assert(dev.engine.time > before && dev.engine.time < before + 2 / 30, `ArrowRight moved the playhead ${f3(dev.engine.time - before)} s, not one frame`);
        await frames(6);
        assert(!shown(pair(dev, 0).copy) && !shown(pair(dev, 2).copy), "a copy showed after a frame step");
        const stepped = topSrc(dev.engine.time);
        await until(() => {
          const m = pair(dev!, 0).main!;
          return !m.seeking && Math.abs(m.currentTime - stepped) < 0.011;
        }, 2_000, () => `the top layer's real element at ${f3(stepped)} s after the step (at ${f3(pair(dev!, 0).main!.currentTime)})`);

        // Space mid-drag: playback lets go of every copy.
        ruler(dev, "pointerdown", 7.3);
        held = 7.3;
        ruler(dev, "pointermove", 9.6);
        held = 9.6;
        const hs = await holdRuler(dev, 9.6, () => (shown(pair(dev!, 0).copy) ? null : "the top copy is not shown before Space"));
        held = hs.pos;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
        await until(() => dev!.engine.playing, 1_000, () => "Space to start playback");
        await frames(3);
        const unloaded = $$<HTMLVideoElement>("video[data-scrub-copy]").every((c) => !c.hasAttribute("src") && !shown(c));
        assert(unloaded, `a copy kept its file or showed while playing: ${JSON.stringify(snap(dev).layers)}`);
        ruler(dev, "pointerup", hs.pos);
        held = null;
        dev.engine.pause();

        // A drag that starts while playing is today's drag.
        dev.engine.seek(4.0);
        dev.engine.play();
        await until(() => dev!.engine.playing, 1_000, () => "playback to start");
        ruler(dev, "pointerdown", 4.5);
        held = 4.5;
        for (const t of [6.1, 8.25, 5.4]) {
          ruler(dev, "pointermove", t);
          for (let n = 0; n < 6; n++) {
            await frame();
            assert(!shown(pair(dev, 0).copy) && !shown(pair(dev, 2).copy), `a copy showed in a drag that began while playing (at ${f3(dev.engine.time)} s)`);
          }
        }
        ruler(dev, "pointerup", 5.4);
        held = null;
        dev.engine.pause();
        return `copy ready in ${jobMs} ms; ${positions.length} held positions (${follow.join(", ")}), boxes within 0.5 px, crop and opacity boxes shared, paint order overlay > top copy / light element / bottom copy; ${said}; release hid each copy at its real element's frame; step, Space and a playing drag show the real file — ${ms(t0)}`;
      } finally {
        if (overlay) overlay.style.pointerEvents = "";
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (b2) a held pointer's tremor rests without a release          */
    /* ============================================================ */
    await test("editor-scrub-rests-while-held", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      try {
        const sh = await sharedProject();
        dev = sh.dev;
        await copyReady(dev);
        /** The picture painted at canvas point (x, y) of the 1600x900 canvas:
         *  the overlay and the layer sets step aside and every picture takes
         *  the pointer for the probe only, so paint order decides the hit. */
        const pictureAt = (x: number, y: number): Element | null => {
          const canvas = $<HTMLElement>(".preview__canvas")!;
          const cb = canvas.getBoundingClientRect();
          const overlay = $<HTMLElement>(".stage-overlay");
          const sets = $$<HTMLElement>(".preview__canvas > .stage-layer-set");
          const pictures = [...$$<HTMLVideoElement>(".preview__canvas video.stage-layer__media"), ...$$<HTMLVideoElement>("video[data-scrub-copy]")];
          const saved = new Map<HTMLElement, string>();
          for (const el of [...(overlay ? [overlay] : []), ...sets, ...pictures]) saved.set(el, el.style.pointerEvents);
          try {
            if (overlay) overlay.style.pointerEvents = "none";
            for (const el of sets) el.style.pointerEvents = "none";
            for (const el of pictures) el.style.pointerEvents = "auto";
            return document.elementFromPoint(cb.left + (x * cb.width) / 1600, cb.top + (y * cb.height) / 900);
          } finally {
            for (const [el, v] of saved) el.style.pointerEvents = v;
          }
        };
        // The top layer's centre: the canvas centre moved by its offset (+180, -60).
        const CX = 980;
        const CY = 390;
        // Tremor A: below the same-position distance on both heavy layers (the
        // top one runs at speed 1.5), so neither the copy nor a real element
        // seeks for it; far below one frame, so it never restarts the rest.
        const TREMOR = sc.SAME_POSITION_S / 2 / 1.5;
        // Tremor B: above the same-position distance on both heavy layers (the
        // copies and the real elements seek for every move) and within one
        // frame (it never restarts the rest): where a one-pixel tremor of a
        // real hand lands at fit zoom.
        const AMP = 0.6 * sh.tol;
        assert(AMP > sc.SAME_POSITION_S && AMP <= sh.tol, `the second tremor ${f3(AMP)} s is not between the same-position distance ${f3(sc.SAME_POSITION_S)} s and one frame ${f3(sh.tol)} s`);
        /** Tremor B moves once every this many frames. */
        const AMP_EVERY = 3;
        /** Once tremor B stops, the copy must give way within this long. */
        const capB = sc.REST_MS + 1_000;
        const ok = (at: number): string | null => {
          const { copy } = pair(dev!, 0);
          if (!shown(copy)) return `the top copy is not shown (${JSON.stringify(snap(dev!).layers)})`;
          if (copy!.seeking || Math.abs(copy!.currentTime - topSrc(at)) > sh.tol) return `the top copy is at ${f3(copy!.currentTime)} s, not ${f3(topSrc(at))} (held at ${f3(at)} s)`;
          return null;
        };
        const t = 7.7;

        ruler(dev, "pointerdown", 4.0);
        held = 4.0;
        const movedAt = performance.now();
        ruler(dev, "pointermove", t);
        held = t;
        assert(Math.abs(dev.engine.time - t) < 0.05, `the ruler move did not seek (at ${f3(dev.engine.time)} s)`);
        const h = await holdRuler(dev, t, ok, 2_000, movedAt);
        held = h.pos;
        const tHeld = h.at;
        const upHit = pictureAt(CX, CY);
        assert(upHit === pair(dev, 0).copy, `with the copy up, the top layer's centre paints ${describeEl(upHit)}, not the copy`);

        // Tremble below the same-position distance every animation frame, never let go.
        const times = new Set<number>();
        const cap = sc.REST_MS + sc.CATCHUP_MAX_MS + 500;
        let n = 0;
        let hidAt = 0;
        for (;;) {
          await frame();
          ruler(dev, "pointermove", n++ % 2 === 0 ? h.pos + TREMOR : h.pos);
          times.add(dev.engine.time);
          if (!shown(pair(dev, 0).copy)) {
            hidAt = performance.now();
            break;
          }
          if (performance.now() - h.restarted > cap) {
            throw new Error(`the top copy stayed up ${cap} ms under a held tremor of ${f3(TREMOR)} s (playhead times ${[...times].map(f3).join(", ")}; ${JSON.stringify(snap(dev).layers)})`);
          }
        }
        const spread = Math.max(...times) - Math.min(...times);
        assert(times.size >= 2, `the tremor did not move the playhead (only ${[...times].map(f3).join(", ")}): the sub-pixel clientX was not taken`);
        assert(spread < sh.tol, `the tremor spread ${f3(spread)} s, not within one frame (${f3(sh.tol)} s)`);
        const waited = hidAt - h.restarted;
        // 2 ms: a timer may fire up to a millisecond before performance.now says.
        assert(waited >= sc.REST_MS - 2, `the copy gave way ${waited.toFixed(0)} ms after the rest wait started, before REST_MS (${sc.REST_MS} ms)`);
        const main = pair(dev, 0).main;
        const asked = topSrc(dev.engine.time);
        assert(
          main !== null && !main.seeking && main.readyState >= 2 && Math.abs(main.currentTime - asked) <= sh.tol,
          `the top copy gave way but its real element is not at ${f3(asked)} s (at ${main ? f3(main.currentTime) : "none"}, seeking ${String(main?.seeking)}, readyState ${main?.readyState ?? -1})`,
        );
        const mainA = main!.currentTime;
        const downHit = pictureAt(CX, CY);
        assert(downHit === main, `after the rest the top layer's centre paints ${describeEl(downHit)}, not its real element`);

        // A move of five frames brings the copy back, still held, no other move.
        const t2 = h.pos + 5 * sh.tol;
        const backAt = performance.now();
        ruler(dev, "pointermove", t2);
        held = t2;
        const tBack = dev.engine.time;
        await until(
          () => ok(tBack) === null,
          1_000,
          () => `the top copy back at ${f3(topSrc(tBack))} s after a five-frame move: ${ok(tBack) ?? "?"}`,
        );
        const backMs = Math.round(performance.now() - backAt);
        const againHit = pictureAt(CX, CY);
        assert(againHit === pair(dev, 0).copy, `after the five-frame move the top layer's centre paints ${describeEl(againHit)}, not the copy`);

        // Tremor B. First a held position with the copy up and a rest wait
        // started less than REST_MS / 2 ago (the hold restarts it as needed),
        // then a move within one frame of it every AMP_EVERY frames.
        const hB = await holdRuler(dev, t2, ok, 2_000, backAt);
        held = hB.pos;
        const timesB = new Set<number>([dev.engine.time]);
        // Every move of tremor B re-seeks the real element, so it cannot
        // settle while the tremor goes on: the copy stays up (the frame asked
        // for, soft) rather than uncover a real element that is mid-seek.
        // What must hold on every frame: whatever paints is the asked frame.
        const WINDOW_MS = sc.REST_MS + 250;
        const startB = performance.now();
        let nB = 0;
        let lastMoveAt = hB.restarted;
        let hidDuring = false;
        for (let f = 1; performance.now() - startB < WINDOW_MS; f++) {
          await frame();
          const { copy, main: m } = pair(dev, 0);
          if (!shown(copy)) {
            hidDuring = true;
            const want = topSrc(dev.engine.time);
            if (m === null || m.readyState < 2 || Math.abs(m.currentTime - want) > 2 * sh.tol) {
              throw new Error(
                `under tremor B the copy gave way over a real element that is not at the asked frame (asked ${f3(want)} s, real element at ${m ? f3(m.currentTime) : "none"}, readyState ${m?.readyState ?? -1})`,
              );
            }
          }
          if (f % AMP_EVERY === 0) {
            ruler(dev, "pointermove", nB++ % 2 === 0 ? hB.pos + AMP : hB.pos);
            lastMoveAt = performance.now();
            timesB.add(dev.engine.time);
          }
        }
        const spreadB = Math.max(...timesB) - Math.min(...timesB);
        assert(timesB.size >= 2, `tremor B did not move the playhead (only ${[...timesB].map(f3).join(", ")})`);
        assert(spreadB > sc.SAME_POSITION_S && spreadB <= sh.tol, `tremor B spread ${f3(spreadB)} s, not between the same-position distance and one frame (${f3(sh.tol)} s)`);
        // The hand goes still, the button stays down: the real element lands
        // and the copy gives way.
        const askedB = topSrc(dev.engine.time);
        const mainB = await until(
          () => {
            const { copy, main: m } = pair(dev!, 0);
            return !shown(copy) && m !== null && !m.seeking && m.readyState >= 2 ? m : null;
          },
          capB,
          () => {
            const m = pair(dev!, 0).main;
            return `the top copy to give way once tremor B stopped (copy shown ${String(shown(pair(dev!, 0).copy))}; real element at ${m ? f3(m.currentTime) : "none"}, seeking ${String(m?.seeking)}; ${JSON.stringify(snap(dev!).layers)})`;
          },
        );
        const stillMs = performance.now() - lastMoveAt;
        // The rest wait began REST_MS after the hold, during the tremor. Had a
        // tremor move restarted it, the copy could not give way during the
        // tremor, nor sooner than REST_MS after the last move.
        assert(
          hidDuring || stillMs < sc.REST_MS - 2,
          `the copy gave way ${stillMs.toFixed(0)} ms after tremor B's last move: a move within one frame restarted the rest wait (REST_MS ${sc.REST_MS} ms)`,
        );
        assert(Math.abs(mainB.currentTime - askedB) <= sh.tol, `after tremor B the copy gave way but its real element is at ${f3(mainB.currentTime)} s, not within one frame of ${f3(askedB)} s`);
        const downHitB = pictureAt(CX, CY);
        assert(downHitB === mainB, `after the rest under tremor B the top layer's centre paints ${describeEl(downHitB)}, not its real element`);
        return `held at ${f3(tHeld)} s; tremor A (${f3(TREMOR)} s, ${n} moves, spread ${f3(spread)} s): the copy gave way ${waited.toFixed(0)} ms after the rest wait began (REST_MS ${sc.REST_MS}), real element at ${f3(mainA)} for ${f3(asked)}; a five-frame move brought it back in ${backMs} ms; tremor B (${f3(AMP)} s every ${AMP_EVERY} frames for ${WINDOW_MS} ms, ${nB} moves, spread ${f3(spreadB)} s): ${hidDuring ? "gave way during the tremor" : `gave way ${stillMs.toFixed(0)} ms after its last move`}, real element at ${f3(mainB.currentTime)} for ${f3(askedB)}; never released — ${ms(t0)}`;
      } finally {
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (c) the real elements get identical writes                    */
    /* ============================================================ */
    await test("editor-scrub-main-writes-identical", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      let logger: { log: string[]; stop(): void } | null = null;
      try {
        const sh = await sharedProject();
        dev = sh.dev;
        await copyReady(dev);
        const positions = [3.6, 7.15, 10.2];
        /** ~170 ms at the harness's 240 Hz: a keyframe-only copy lands well inside it. */
        const HOLD_FRAMES = 40;
        const els = dev.scheduler.videoElements();
        // A held position alternates with a point two frames on, one move every
        // STEP_EVERY frames (each move restarts the rest wait): STEP_EVERY is
        // fixed from the measured frame rate once, before the runs, so all
        // three runs send the identical event sequence and a move comes about
        // every REST_MS / 2.
        const step = 2 * sh.tol;
        const f0 = performance.now();
        await frames(10);
        const frameMs = (performance.now() - f0) / 10;
        const STEP_EVERY = Math.max(2, Math.floor(sc.REST_MS / 2 / Math.max(1, frameMs)));
        /** One scripted drag: same start, same positions, same frame counts. */
        /** Per position, how many frames of the last run had the top copy shown. */
        let shownFrames: number[] = [];
        const run = async (withCopy: boolean): Promise<string[]> => {
          shownFrames = [];
          dev!.engine.seek(2.8);
          await until(() => els.every((e) => !e.seeking), 2_000, () => "the real elements to settle before a run");
          if (withCopy) {
            // The paused dwell loads the ready copy ahead (as in the app), so
            // the held positions do not wait for a cold load.
            await until(() => snap(dev!).layers.find((l) => l.idx === 0)?.loaded === true, 3_000, () => `the top copy preloaded by the dwell — ${JSON.stringify(snap(dev!).layers)}`);
          }
          await frames(2);
          logger = logMainWrites(els);
          try {
            ruler(dev!, "pointerdown", 2.8);
            held = 2.8;
            // The same moves in every run (one every STEP_EVERY-th frame,
            // alternating between the position and two frames on), so every
            // run makes the same seeks: the logs compare 1:1. The copy is
            // looked at on every frame of every run (reads only), and a ready
            // run must have shown it on some frame at every position.
            let pos = 2.8;
            for (const t of positions) {
              pos = t;
              ruler(dev!, "pointermove", pos);
              held = pos;
              let up = 0;
              for (let n = 0; n < HOLD_FRAMES; n++) {
                await frame();
                if (shown(pair(dev!, 0).copy)) up++;
                if ((n + 1) % STEP_EVERY === 0) {
                  pos = pos === t ? t + step : t;
                  ruler(dev!, "pointermove", pos);
                  held = pos;
                }
              }
              shownFrames.push(up);
              if (withCopy) {
                assert(up > 0, `the top copy was shown on no frame of ${HOLD_FRAMES} held around ${f3(t)} s — ${JSON.stringify(snap(dev!).layers)}`);
              } else {
                assert(up === 0, `the top copy was shown on ${up} frames held around ${f3(t)} s in a run without a ready copy`);
              }
            }
            ruler(dev!, "pointerup", pos);
            held = null;
            await frames(4);
            return [...logger.log];
          } finally {
            logger.stop();
            logger = null;
          }
        };
        dev.editorScrub.disabled = true;
        const off = await run(false);
        assert(!snap(dev).listening && !snap(dev).ticking, "disabled left listeners installed");
        dev.editorScrub.disabled = false;
        dev.editorScrub.forceHeavy = false;
        const light = await run(false);
        dev.editorScrub.forceHeavy = true;
        await copyReady(dev);
        const ready = await run(true);
        assert(off.some((e) => /currentTime=/.test(e)), "the scripted drag seeked no real element — it did not scrub");
        assert(firstDiff(off, light) === "equal", `disabled vs enabled-not-heavy: ${firstDiff(off, light)}`);
        assert(firstDiff(off, ready) === "equal", `disabled vs a shown ready copy: ${firstDiff(off, ready)}`);
        return `three drags over ${positions.length} positions (disabled; enabled, not heavy; a ready copy shown on ${shownFrames.join("/")} of ${HOLD_FRAMES} frames, a move every ${STEP_EVERY}): ${off.length} writes each, equal entry for entry — ${ms(t0)}`;
      } finally {
        (logger as { stop(): void } | null)?.stop();
        if (dev) {
          dev.editorScrub.disabled = false;
          dev.editorScrub.forceHeavy = true;
        }
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (d) the fullscreen seek bar                                   */
    /* ============================================================ */
    await test("editor-scrub-theater", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let seekEl: HTMLElement | null = null;
      let pressed = false;
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
      try {
        const sh = await sharedProject();
        dev = sh.dev;
        await copyReady(dev);
        $<HTMLButtonElement>("#tr-fullscreen")!.click();
        await until(() => $(".editor__preview.theater"), 1_000, () => "theater to open");
        seekEl = await until(() => {
          const s = $(".theater-bar [data-el='seek']");
          return rendered(s) ? s : null;
        }, 1_000, () => "a painted theater seek bar");
        fire("pointerdown", 0.12);
        pressed = true;
        const said: string[] = [];
        // Held as on the ruler: alternating with a point two frames on, one
        // move every REST_MS / 2 (the bar seeks frac * duration), never
        // checked on the frame of a move, and checked against the time held
        // at that moment.
        const stepFrac = (2 * sh.tol) / dev.engine.duration();
        let last = 0.12;
        for (const frac of [0.21, 0.39, 0.3]) {
          let restarted = performance.now();
          last = frac;
          fire("pointermove", last);
          const start = performance.now();
          let t = dev.engine.time;
          for (;;) {
            await frame();
            if (performance.now() - start > 2_000) {
              const c = pair(dev, 0).copy;
              throw new Error(`the top copy never showed ${f3(topSrc(dev.engine.time))} s on the theater bar (copy at ${f3(c?.currentTime ?? -1)}, shown ${String(shown(c))}; ${JSON.stringify(snap(dev).layers)})`);
            }
            if (performance.now() - restarted >= sc.REST_MS / 2) {
              restarted = performance.now();
              last = last === frac ? frac + stepFrac : frac;
              fire("pointermove", last);
              continue;
            }
            t = dev.engine.time;
            const { copy } = pair(dev, 0);
            if (shown(copy) && !copy!.seeking && Math.abs(copy!.currentTime - topSrc(t)) <= 1 / 30) break;
          }
          const { copy, main } = pair(dev, 0);
          const a = copy!.getBoundingClientRect();
          const b = main!.getBoundingClientRect();
          const off = Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
          assert(off <= 0.5, `in theater the copy box is ${off.toFixed(2)} px off its real element's`);
          said.push(`${f3(t)}→${f3(copy!.currentTime)}`);
        }
        fire("pointerup", last);
        pressed = false;
        await until(() => !shown(pair(dev!, 0).copy) || null, 4_500, () => "the copy to hide after the theater release");
        return `theater bar drag: ${said.join(", ")}, boxes within 0.5 px, hidden after release — ${ms(t0)}`;
      } finally {
        if (pressed) fire("pointerup", 0.3);
        await settle(dev, null);
      }
    });

    /* ============================================================ */
    /* (e) a failed copy is silent and per file                      */
    /* ============================================================ */
    await test("editor-scrub-fail", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      let held: number | null = null;
      try {
        const sh = await sharedProject();
        dev = sh.dev;
        const toasts = (): number => $$(".toast-host > *").length;
        const toastsBefore = toasts();
        // Force the light layer's file only; its next plan is refused.
        dev.editorScrub.forceOnly = sh.direct.path;
        dev.editorScrub.failNextPlan("refused by the test");
        dev.engine.seek(3.0);
        ruler(dev, "pointerdown", 3.0);
        held = 3.0;
        ruler(dev, "pointerup", 3.0);
        held = null;
        const f = await until(
          () => {
            const x = fileOf(snap(dev!), "direct_h264.mp4");
            return x?.state === "failed" ? x : null;
          },
          3_000,
          () => `direct_h264's copy to fail — ${JSON.stringify(snap(dev!).files)}`,
        );
        assert(f.reason === "no copy: refused by the test", `the failure reason is "${f.reason ?? ""}"`);
        const plans = snap(dev).planCalls;
        ruler(dev, "pointerdown", 3.2);
        held = 3.2;
        for (const t of [4.1, 6.6, 5.3]) {
          ruler(dev, "pointermove", t);
          held = t;
          await frames(8);
          assert(pair(dev, 1).copy === null || !shown(pair(dev, 1).copy), "a failed file showed a copy");
        }
        ruler(dev, "pointerup", 5.3);
        held = null;
        await sleep(200);
        assert(toasts() === toastsBefore, `a failure raised a toast (${toasts()} vs ${toastsBefore})`);
        assert(snap(dev).planCalls === plans, "a failed file was planned again");
        assert(pair(dev, 1).copy === null || pair(dev, 1).copy!.hasAttribute("src") === false, "a failed file's copy holds a src");

        // I13: after the failure the real elements get exactly the writes they
        // get with the module disabled (the same scripted drag, fixed counts).
        const els = dev.scheduler.videoElements();
        const scripted = async (): Promise<string[]> => {
          dev!.engine.seek(3.2);
          await until(() => els.every((e) => !e.seeking), 2_000, () => "the real elements to settle before a scripted drag");
          await frames(2);
          const lg = logMainWrites(els);
          try {
            ruler(dev!, "pointerdown", 3.2);
            held = 3.2;
            for (const t of [4.1, 6.6, 5.3]) {
              ruler(dev!, "pointermove", t);
              held = t;
              for (let n = 0; n < 8; n++) {
                await frame();
                ruler(dev!, "pointermove", t);
              }
            }
            ruler(dev!, "pointerup", 5.3);
            held = null;
            await frames(4);
            return [...lg.log];
          } finally {
            lg.stop();
          }
        };
        dev.editorScrub.disabled = true;
        const offLog = await scripted();
        dev.editorScrub.disabled = false;
        assert(snap(dev).listening, "the module is not active for the failed file's drag");
        const failedLog = await scripted();
        assert(offLog.some((e) => /currentTime=/.test(e)), "the scripted drag seeked no real element");
        assert(firstDiff(offLog, failedLog) === "equal", `disabled vs a failed copy: ${firstDiff(offLog, failedLog)}`);
        return `failNextPlan → "${f.reason ?? ""}", no toast, a further drag shows no copy and plans nothing, ${offLog.length} real-element writes equal to the disabled drag's — ${ms(t0)}`;
      } finally {
        if (dev) {
          dev.editorScrub.disabled = false;
          dev.editorScrub.forceOnly = shared?.counter.path ?? null;
        }
        await settle(dev, held);
      }
    });

    /* ============================================================ */
    /* (f) letting go: a removed media and leaving the editor cancel */
    /* ============================================================ */
    await test("editor-scrub-lifecycle", async () => {
      const t0 = performance.now();
      let dev: EdHook | undefined;
      const realPlan = ipc.planScrub;
      const realCancel = ipc.cancelJob;
      const cancelled: number[] = [];
      let nextJob = 2_000_000_001;
      try {
        await backHome();
        shared = null;
        await needFixtures();
        const direct = await probe(DIRECT);
        const counter = await probe(COUNTER);
        // Every plan answers "being made" with a job id the backend never
        // issued, so the job never ends; cancels are recorded, not sent.
        ipc.planScrub = async () => ({ mode: "pending", jobId: nextJob++ });
        ipc.cancelJob = async (id: number) => {
          cancelled.push(id);
          return true;
        };
        const p = project("Editor scrub lifecycle", [direct, counter], [
          videoTrack("A", [clipOf(direct, 0, 1.7, 12, 1)]),
          videoTrack("B", [clipOf(counter, 0, 0.5, 12, 1)]),
        ]);
        dev = await mount(p, "Editor scrub lifecycle");
        dev.editorScrub.forceOnly = null;
        dev.editorScrub.forceHeavy = true;
        dev.engine.seek(1.0);
        ruler(dev, "pointerdown", 1.0);
        ruler(dev, "pointerup", 1.0);
        const making = await until(
          () => snap(dev!).files.find((f) => f.state === "making") ?? null,
          3_000,
          () => `a copy being made — ${JSON.stringify(snap(dev!).files)}`,
        );
        const removed = p.media.find((m) => isNamed(m.path, isNamed(making.file, "direct_h264.mp4") ? "direct_h264.mp4" : "counter_audio_h264.mp4"))!;
        dev.session.commit((cur) => ({
          ...cur,
          media: cur.media.filter((m) => m.id !== removed.id),
          timeline: {
            ...cur.timeline,
            tracks: cur.timeline.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.mediaId !== removed.id) })),
          },
        }));
        await until(() => cancelled.length >= 1, 2_000, () => `the job of the removed media to be cancelled — ${JSON.stringify(snap(dev!))}`);
        assert(cancelled.length === 1 && cancelled[0] === making.jobId, `cancels ${JSON.stringify(cancelled)}, want exactly [${String(making.jobId)}]`);
        assert(snap(dev).cancels === 1, `the module counted ${snap(dev).cancels} cancels`);
        const second = await until(
          () => snap(dev!).files.find((f) => f.state === "making" && f.jobId !== making.jobId) ?? null,
          3_000,
          () => `the other file's copy being made — ${JSON.stringify(snap(dev!).files)}`,
        );
        // The module's own hook outlives the editor: it is asked after leaving.
        const gone = dev.editorScrub;
        await backHome();
        await until(() => cancelled.length >= 2, 2_000, () => `leaving the editor to cancel job ${String(second.jobId)} — cancels ${JSON.stringify(cancelled)}`);
        assert(cancelled.length === 2 && cancelled[1] === second.jobId, `cancels ${JSON.stringify(cancelled)} after leaving, want [${String(making.jobId)}, ${String(second.jobId)}]`);
        const after = gone.snapshot();
        assert(
          !after.listening && !after.ticking && after.files.length === 0 && after.layers.length === 0,
          `leaving the editor left the scrub copy holding something: ${JSON.stringify(after)}`,
        );
        return `removed media → its job cancelled once (${String(making.jobId)}); the next file planned; leaving the editor cancelled ${String(second.jobId)}; no listener, record or copy left — ${ms(t0)}`;
      } finally {
        ipc.planScrub = realPlan;
        ipc.cancelJob = realCancel;
        await settle(dev, null);
      }
    });
  } finally {
    shared = null;
    await backHome();
    for (const p of paths) await ipc.deleteProject(p).catch(() => {});
  }
}
