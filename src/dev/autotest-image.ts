// Image-project E2E blocks (v0.9 image mode). DEV-only: imported lazily by
// autotest.ts, never part of a release bundle.
//
// NOTHING under src/image is imported statically here. The image editor is a
// lazy chunk that nothing prefetches, and this module is loaded before its
// first block runs: a static import would load that chunk as a side effect of
// the harness. Every image module a block drives is reached with
// `await import(...)` inside the block (type-only imports are erased). The
// "nothing loaded it early" check itself lives in autotest-viewer.ts's
// viewer-photo-canvas block, which opens the run's first image project.
//
// What a block asserts is what is ON SCREEN or ON DISK: stage pixels read back
// from the editor's own canvas, the element hit at a point, decoded pixels of
// an exported file, the size ffprobe reads — never a class or a state field
// alone. Fixture values differ on every axis (a 641x361 canvas, four quadrant
// colours that share no channel with a neighbour, a 97x61 alpha still), so a
// transposed size, a swapped quadrant or a dropped alpha channel cannot land on
// a matching number.
//
// Each block mounts its own project and ends on Home with every file it
// created deleted and every setting, spy and wrapper it installed put back.
// Waits poll at 20 ms and every timeout names what was on screen, so a red run
// finishes inside the harness's 90 s cap and says why without a rerun.

import { invoke } from "@tauri-apps/api/core";
import { errorDetail, ipc, mediaUrl } from "../core/ipc";
import { createBlankImageProject, createPhotoImageProject } from "../core/image-project";
import { navigate } from "../core/nav";
import { isTempProjectPath } from "../core/open-media";
import { createProject, importMediaAsClip } from "../core/project";
import {
  currentSession,
  leaveBlockedReason,
  settingsStore,
  updateSettings,
  type ProjectSession,
} from "../core/session";
import { normalizeChord } from "../core/shortcuts";
import type { Store } from "../core/store";
import { DEFAULT_SHORTCUTS } from "../core/types";
import type { ActionId, MediaInfo, ProjectFile, Stroke } from "../core/types";
import type { ImageEditorCtx, ViewController } from "../image/context";
import type { Layer } from "../image/layers";
import type { PreviewResources } from "../image/render";
import type { ToolState } from "../image/tool-state";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { Wave1Ctx } from "./autotest-wave1";

/** Delete a file a block wrote that is NOT a project — an export, a card
 *  picture, a scratch copy. `deleteProject` takes only a `.trt` (anything else
 *  is refused, so a compromised page cannot delete a user's files through it);
 *  `debug_remove_test_file` exists only under the harness and deletes only
 *  inside the run's scratch root and the derived-file cache. */
const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

/** Same harness surface as the Wave 1 and viewer blocks. */
export type ImageCtx = Wave1Ctx;

/** What the image editor publishes on window while it is mounted
 *  (image-editor.ts, DEV only). The video editor's __tarotingDev is never set
 *  by it. */
interface ImageDev {
  session: ProjectSession;
  tools: Store<ToolState>;
  view: ViewController;
  selection: Store<string | null>;
  res: PreviewResources;
  canvas: HTMLCanvasElement;
  mode: Store<"idle" | "crop-image" | "crop-layer">;
  ctx: ImageEditorCtx;
  renderNow(): void;
  /** a FUNCTION: the layers of the project as it is now, top first */
  layers(): readonly Layer[];
}

/** What the viewer publishes on window while it is mounted. */
interface ViewerDev {
  path(): string;
}

type CloseFlow = (destroy: () => Promise<void>) => Promise<"closed" | "stayed">;
type Rgb = readonly [number, number, number];

const HOLD = "An export is running.";
// The fixture's colours (scripts/make-fixtures.mjs, "image projects").
const GRID_TL: Rgb = [224, 64, 32];
const GRID_BR: Rgb = [32, 192, 96];
const GRID_BG: Rgb = [32, 64, 128];
const ALPHA_RGB: Rgb = [48, 80, 160];
/** A solid shares no channel value with any grid quadrant. */
const SOLID_HEX = "#a0f0c8";
const SOLID_RGB: Rgb = [160, 240, 200];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The page's own rAF, taken before any block wraps window.requestAnimationFrame,
 *  so the harness's frame waits are never counted as the editor's. */
const pageRaf = window.requestAnimationFrame.bind(window);
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => pageRaf(() => r()));
};

/** Poll every 20 ms. `what` is evaluated only on timeout, so the message says
 *  what was on screen then, not when the wait began. */
async function until<T>(get: () => T | null | undefined | false, ms: number, what: () => string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what()}`);
    await sleep(20);
  }
}

const $ = <E extends Element = HTMLElement>(sel: string): E | null => document.querySelector<E>(sel);
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const text = (sel: string): string => ($(sel)?.textContent ?? "").trim();
const norm = (p: string): string => p.replace(/\//g, "\\").toLowerCase();
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
const fmt = (c: readonly number[]): string => `(${c.slice(0, 3).join(",")})`;
/** Largest per-channel difference over r, g, b. */
const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));

/** Laid out AND painted: a box, no display:none ancestor, not visibility:hidden. */
function rendered(el: Element | null): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.isConnected &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden"
  );
}

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  // A toast in the way says which one, so a stray message can be traced.
  const toast = el.closest(".toast");
  const said = toast ? ` ("${(toast.textContent ?? "").trim().slice(0, 120)}")` : "";
  return `${el.tagName.toLowerCase()}${cls}${said}`;
}

/** The element painted at the centre of `el`, and whether it is `el` (or inside it). */
function hitsItself(el: HTMLElement): { ok: boolean; hit: string } {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: hit === el || (hit !== null && el.contains(hit)), hit: describeEl(hit) };
}

function imageDev(): ImageDev | undefined {
  return (window as unknown as { __tarotingImageDev?: ImageDev }).__tarotingImageDev;
}
function viewerDev(): ViewerDev | undefined {
  return (window as unknown as { __tarotingViewerDev?: ViewerDev }).__tarotingViewerDev;
}

function onScreen(): string {
  const scr = $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".home") ? "home" : "?";
  const dlg = $(".modal-backdrop") ? `dialog "${text(".modal-backdrop .modal__header")}"` : "no dialog";
  return `${scr}, ${dlg}`;
}

/** The stage pixel over canvas point (x, y), read back from the editor's own
 *  canvas at the current view. Null when that point is off the stage. */
function stagePx(dev: ImageDev, x: number, y: number): Rgb | null {
  const v = dev.view.store.get();
  const dx = Math.floor(v.panX + (x + 0.5) * v.zoom);
  const dy = Math.floor(v.panY + (y + 0.5) * v.zoom);
  if (dx < 0 || dy < 0 || dx >= dev.canvas.width || dy >= dev.canvas.height) return null;
  const d = dev.canvas.getContext("2d")!.getImageData(dx, dy, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

/** Wait until the stage shows `want` (± tol) over canvas point (x, y). */
function stageShows(dev: ImageDev, x: number, y: number, want: Rgb, tol: number, what: string): Promise<Rgb> {
  return until(
    () => {
      const got = stagePx(dev, x, y);
      return got && dist(got, want) <= tol ? got : null;
    },
    1_500,
    () => `${what}: the stage at canvas (${x},${y}) shows ${fmt(stagePx(dev, x, y) ?? [])}, not ${fmt(want)} ±${tol}`,
  );
}

/** Pixels of an encoded image, decoded the way the webview decodes it. */
async function pixelsOf(blob: Blob): Promise<{ w: number; h: number; at(x: number, y: number): number[] }> {
  const bmp = await createImageBitmap(blob);
  try {
    const w = bmp.width;
    const h = bmp.height;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    return { w, h, at: (x, y) => Array.from(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)) };
  } finally {
    bmp.close();
  }
}

/** A file's bytes through the asset protocol, never from the HTTP cache (the
 *  same name is rewritten by every run). */
async function fileBlob(path: string): Promise<Blob> {
  const res = await fetch(mediaUrl(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`reading ${baseName(path)} back failed: HTTP ${res.status}`);
  return res.blob();
}

/** A keydown for a stored chord ("Ctrl+Shift+Z"), as a keyboard sends it. */
function chordEvent(stored: string): KeyboardEvent {
  const parts = normalizeChord(stored).split("+");
  const key = parts[parts.length - 1] ?? "";
  const shift = parts.includes("Shift");
  const single = key.length === 1;
  return new KeyboardEvent("keydown", {
    key: single ? (shift ? key.toUpperCase() : key.toLowerCase()) : key === "Space" ? " " : key,
    code: single ? (/[A-Z]/i.test(key) ? `Key${key.toUpperCase()}` : /[0-9]/.test(key) ? `Digit${key}` : "") : key,
    ctrlKey: parts.includes("Ctrl"),
    altKey: parts.includes("Alt"),
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
}

/** The live binding for `action` (the Shortcuts card can change it). */
function chordFor(action: ActionId): string {
  const stored = (settingsStore.get().shortcuts as Partial<Record<ActionId, string>>)[action];
  return typeof stored === "string" && stored !== "" ? stored : DEFAULT_SHORTCUTS[action];
}

function pointer(
  type: string,
  x: number,
  y: number,
  o: { id: number; kind: "pen" | "mouse"; buttons: number; button: number; pressure?: number },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerId: o.id,
    pointerType: o.kind,
    pressure: o.pressure ?? (o.buttons ? 0.5 : 0),
    button: o.button,
    buttons: o.buttons,
    isPrimary: true,
  });
}

/** Count history entries pushed on `session` from now on (the stacks are
 *  private; every commit and commitFrom goes through push). */
function countPushes(session: ProjectSession): { readonly n: number; restore(): void } {
  const h = session.history;
  const orig = h.push;
  let n = 0;
  h.push = function (this: typeof h, before: ProjectFile): void {
    n++;
    orig.call(this, before);
  };
  return {
    get n() {
      return n;
    },
    restore() {
      h.push = orig;
    },
  };
}

/** Settle `p` or notice a dialog, whichever comes first, without leaving a
 *  losing promise behind to reject into the harness's errors list later. */
async function settleOrModal<T>(p: Promise<T>, capMs: number): Promise<{ value: T } | { modal: HTMLElement } | { timedOut: true }> {
  const st: { done: boolean; value?: T; failed: boolean; err?: unknown } = { done: false, failed: false };
  p.then(
    (v) => {
      st.done = true;
      st.value = v;
    },
    (e: unknown) => {
      st.failed = true;
      st.err = e;
    },
  );
  const start = performance.now();
  for (;;) {
    if (st.done) return { value: st.value as T };
    if (st.failed) throw st.err;
    const m = $(".modal-backdrop");
    if (m) return { modal: m };
    if (performance.now() - start > capMs) return { timedOut: true };
    await sleep(20);
  }
}

/** The strokes of a drawing layer, flattened. */
function strokesOf(l: Layer | undefined): readonly Stroke[] {
  const g = l?.media.generator;
  return g?.type === "drawing" ? g.chunks.flat() : [];
}
function chunkSizes(l: Layer | undefined): number[] {
  const g = l?.media.generator;
  return g?.type === "drawing" ? g.chunks.map((c) => c.length) : [];
}

export async function runImageBlocks(ctx: ImageCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const fx = (name: string): string => `${fixturesDir}\\${name}`;
  const GRID = "image_grid_641x361.png";
  const ALPHA = "image_alpha_97x61.png";

  const FIXTURES = [
    GRID, ALPHA, "photo_o6.jpg", "photo_o6.webp", "photo_o6_early.png", "photo_o6_late.png", "viewer\\IMG_7.JPG",
  ];
  const present = await Promise.all(FIXTURES.map((f) => ipc.pathExists(fx(f)).catch(() => false)));
  const missing = FIXTURES.filter((_, i) => !present[i]);
  const needFixtures = (): void =>
    assert(missing.length === 0, `image fixtures missing (${missing.join(", ")}) — run npm run fixtures`);

  /** Every image project any block creates: no Home thumbnail backfill may
   *  ever be asked about one (checked in image-home-cards). */
  const imagePaths = new Set<string>();
  /** Every path Home's backfill asked refresh_recent_thumbs about, all run long. */
  const backfilled: string[] = [];
  const realRefresh = ipc.refreshRecentThumbs;
  ipc.refreshRecentThumbs = (paths: string[]) => {
    backfilled.push(...paths);
    return realRefresh(paths);
  };

  /** Scratch output: the autotest root (wiped at the start of every run),
   *  never the repo and never the owner's folders. */
  let outDir = "";
  const scratchDir = async (): Promise<string> => {
    if (outDir) return outDir;
    const tmp = (await ipc.tempProjectsDir()).replace(/[\\/]+$/, "");
    const dir = dirName(tmp);
    assert(
      /taroting-autotest/i.test(dir),
      `the scratch folder ${dir} is not inside the autotest root (taroting-autotest) — refusing to write test output there`,
    );
    outDir = dir;
    return dir;
  };

  const probe = async (path: string): Promise<MediaInfo> => {
    const info = await ipc.probeMedia(path).catch((e: unknown) => {
      throw new Error(`probing ${baseName(path)} failed: ${errorDetail(e).message}`);
    });
    assert(info.kind === "image", `${baseName(path)} probed as ${info.kind}, not a still`);
    return info;
  };

  /** Save `project` as a temp .trt and open it the way routeOpenPath opens a
   *  .trt in the temp dir; resolves once the image editor has mounted. */
  const mountImage = async (project: ProjectFile, name: string, paths: string[]): Promise<ImageDev> => {
    const path = await ipc.tempProjectPath(name);
    paths.push(path);
    imagePaths.add(norm(path));
    await ipc.saveProject(path, project);
    const prev = imageDev();
    navigate({ view: "editor", projectPath: path, temp: true });
    return until(
      () => {
        const d = imageDev();
        return d && d !== prev && $(".imged") && $("#ed-save") ? d : null;
      },
      8_000,
      () => `the image editor on "${name}" — on screen: ${onScreen()}`,
    );
  };

  /** The photo layer's pixels have decoded, and the stage has painted them. */
  const photoReady = async (dev: ImageDev): Promise<Layer> => {
    const photo = dev.layers().find((l) => l.kind === "photo");
    assert(photo !== undefined, `the project has no photo layer (${dev.layers().map((l) => l.kind).join(", ") || "no layers"})`);
    const st = await until(
      () => {
        const s = dev.res.status(photo!.trackId);
        return s.state !== "loading" ? s : null;
      },
      4_000,
      () => `the photo ${baseName(photo!.media.path)} to decode`,
    );
    assert(st.state === "ready", `the photo ${baseName(photo!.media.path)} failed to load: ${st.message ?? "no message"}`);
    // The stage's size is settled by its first ResizeObserver pass; two frames
    // later the view is final and a synchronous paint shows the photo.
    await frames(2);
    dev.renderNow();
    return photo!;
  };

  /** The one teardown every block ends with: dismiss whatever it left open,
   *  discard a temp project, park on Home, delete what it wrote. Never throws —
   *  a cleanup failure must not mask the block's own result. */
  const leave = async (paths: readonly string[]): Promise<void> => {
    try {
      closeMenu();
      for (const b of Array.from(document.querySelectorAll<HTMLElement>(".modal-backdrop"))) {
        const out = b.querySelector<HTMLElement>('[data-act="cancel"], [data-cancel], [data-close], [data-close-btn]');
        if (out) out.click();
        else b.remove();
      }
      const s = currentSession.get();
      // Discarded FIRST, so the editor's teardown has nothing to flush into
      // the scratch file; navigate() itself goes past the leave gate.
      if (s && s.temp.get()) await discardTempSession(s);
      navigate({ view: "home" });
      await until(() => $(".home") && !$(".editor") && !$("#vw"), 5_000, () => `Home (${onScreen()})`);
    } catch (e) {
      console.error("image autotest: cleanup did not finish", e);
    }
    for (const p of paths) if (p) await ipc.deleteProject(p).catch(() => {});
  };

  const waitGone = async (path: string, what: string): Promise<void> => {
    const start = performance.now();
    while (await ipc.pathExists(path)) {
      if (performance.now() - start > 2_000) throw new Error(`${what}: ${path}`);
      await sleep(30);
    }
  };

  /** Click one button of the dialog that is up now. */
  const answerDialog = async (act: "keep" | "discard" | "cancel"): Promise<void> => {
    const btn = await until(
      () => $<HTMLButtonElement>(`.modal-backdrop [data-act="${act}"]`),
      3_000,
      () => `a Keep/Discard dialog with a "${act}" button (${onScreen()})`,
    );
    btn.click();
  };

  try {
    /* ---------------------------------------------------------------- */

    await test("image-still-decode-parity", async () => {
      // DRIFT ALARM, the renderer's half of the exif-orientation-* blocks: the
      // image editor decodes a still with its own decoder (`decodeStill`,
      // imageOrientation "from-image") and draws it into the box its MediaRef
      // records. The two must agree for all four orientation-6 fixtures, or the
      // stage and the export would disagree with the stored project about the
      // photo's shape. If a WebView2 update starts or stops turning one of
      // these, this goes red naming the file — not the app's code.
      const t0 = performance.now();
      needFixtures();
      const { decodeStill, fetchPhoto } = await import("../image/render/photos");
      const ROWS = [
        ["photo_o6.jpg", 36, 64],
        ["photo_o6.webp", 64, 36],
        ["photo_o6_early.png", 36, 64],
        ["photo_o6_late.png", 64, 36],
      ] as const;
      const seen: string[] = [];
      for (const [name, w, h] of ROWS) {
        const info = await probe(fx(name));
        const stored = `${info.width}x${info.height}`;
        assert(
          stored === `${w}x${h}`,
          `${name}: the probe stored ${stored}, not ${w}x${h} — the backend's per-file orientation rule changed (see the exif-orientation-* blocks)`,
        );
        const blob = await fetchPhoto(fx(name));
        assert(blob !== null, `${name}: the renderer's own fetch (fetchPhoto) read nothing`);
        const bmp = await decodeStill(blob!);
        const decoded = `${bmp.width}x${bmp.height}`;
        bmp.close();
        assert(
          decoded === stored,
          `DRIFT: ${name} decodes ${decoded} through the image editor's decoder but its MediaRef stores ${stored} — WebView2 changed how it orients this file; preview and export would disagree`,
        );
        seen.push(`${name} ${decoded}`);
      }
      return `decodeStill (from-image, no resize) == stored size: ${seen.join(", ")} — ${ms(t0)}`;
    });

    await test("image-open-dispatch", async () => {
      // An image project opens in the image editor and NOTHING of the video
      // editor is built: no __tarotingDev, no AudioContext, no timeline. The
      // canvas is the photo's exact odd size (the video path even-rounds).
      const t0 = performance.now();
      const paths: string[] = [];
      const w = window as unknown as { __tarotingDev?: unknown; AudioContext: typeof AudioContext };
      const prevHook = w.__tarotingDev;
      const RealAC = window.AudioContext;
      let constructed = 0;
      try {
        needFixtures();
        const info = await probe(fx(GRID));
        assert(info.width === 641 && info.height === 361, `fixture drifted: ${GRID} probes ${info.width}x${info.height}`);
        w.__tarotingDev = undefined;
        w.AudioContext = new Proxy(RealAC, {
          construct(target, args, newTarget) {
            constructed++;
            return Reflect.construct(target, args, newTarget) as object;
          },
        });
        const dev = await mountImage(createPhotoImageProject("Autotest image grid", info), "Autotest image dispatch", paths);
        await photoReady(dev);
        assert(rendered($(".imged")), ".imged is not rendered");
        assert($(".timeline-panel") === null, "a .timeline-panel is on screen: the video editor was built for an image project");
        assert(w.__tarotingDev === undefined, "__tarotingDev was published: the video editor's mount ran");
        assert(constructed === 0, `${constructed} AudioContext(s) were constructed opening an image project`);
        const p = dev.session.project;
        assert(p.kind === "image" && p.schema === 3, `the mounted project is kind ${String(p.kind)} schema ${p.schema}`);
        assert(
          p.timeline.width === 641 && p.timeline.height === 361,
          `the canvas is ${p.timeline.width}x${p.timeline.height}, not the photo's 641x361 (a video canvas would be even-rounded to 642x362)`,
        );
        const stage = $("#imged-stage")!;
        const r = stage.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        assert(hit === $("#imged-canvas"), `the stage centre hits ${describeEl(hit)}, not #imged-canvas`);
        assert(rendered($("#ed-home")), "#ed-home has no client rects");
        return `image project → .imged, no timeline, no __tarotingDev, 0 AudioContexts, canvas 641x361, stage centre hits #imged-canvas, #ed-home rendered — ${ms(t0)}`;
      } finally {
        w.AudioContext = RealAC;
        w.__tarotingDev = prevHook;
        await leave(paths);
      }
    });

    await test("image-exif-dims", async () => {
      // photo_o6.jpg is CODED 64x36 with EXIF orientation 6; WebView2 turns a
      // JPEG, so the project's canvas and the photo are 36x64 upright. The stage
      // is compared with the webview's own upright decode at every point whose
      // 3x3 neighbourhood is flat (so the stage's resampling cannot move it), and
      // those points are shown to tell the two orientations apart.
      const t0 = performance.now();
      const paths: string[] = [];
      try {
        needFixtures();
        const info = await probe(fx("photo_o6.jpg"));
        assert(info.width === 36 && info.height === 64, `the probe stored ${info.width}x${info.height}, not 36x64`);
        const dev = await mountImage(createPhotoImageProject("Autotest image o6", info), "Autotest image o6", paths);
        const tl = dev.session.project.timeline;
        assert(tl.width === 36 && tl.height === 64, `the project canvas is ${tl.width}x${tl.height}, not 36x64`);
        const photo = await photoReady(dev);
        const nat = dev.res.status(photo.trackId).natural;
        assert(nat?.w === 36 && nat.h === 64, `the renderer decoded the photo at ${nat ? `${nat.w}x${nat.h}` : "no size"}, not 36x64`);

        const up = await createImageBitmap(await fileBlob(fx("photo_o6.jpg")), { imageOrientation: "from-image" });
        assert(up.width === 36 && up.height === 64, `the reference decode is ${up.width}x${up.height}`);
        const oc = new OffscreenCanvas(36, 64);
        const og = oc.getContext("2d")!;
        og.drawImage(up, 0, 0);
        up.close();
        const U = og.getImageData(0, 0, 36, 64).data;
        const at = (x: number, y: number): Rgb => [U[(y * 36 + x) * 4]!, U[(y * 36 + x) * 4 + 1]!, U[(y * 36 + x) * 4 + 2]!];
        const flat = (x: number, y: number): boolean => {
          const c = at(x, y);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dist(at(x + dx, y + dy), c) > 10) return false;
          return true;
        };
        // The whole stage in one read (a readback per point would cost seconds).
        const v = dev.view.store.get();
        const SW = dev.canvas.width;
        const SH = dev.canvas.height;
        const S = dev.canvas.getContext("2d")!.getImageData(0, 0, SW, SH).data;
        const stageAt = (x: number, y: number): Rgb | null => {
          const dx = Math.floor(v.panX + (x + 0.5) * v.zoom);
          const dy = Math.floor(v.panY + (y + 0.5) * v.zoom);
          if (dx < 0 || dy < 0 || dx >= SW || dy >= SH) return null;
          const i = (dy * SW + dx) * 4;
          return [S[i]!, S[i + 1]!, S[i + 2]!];
        };
        let checked = 0;
        let bad = 0;
        let distinct = 0;
        let first = "";
        for (let y = 1; y < 63; y++) {
          for (let x = 1; x < 35; x++) {
            if (!flat(x, y)) continue;
            const got = stageAt(x, y);
            if (!got) continue;
            checked++;
            const want = at(x, y);
            if (dist(got, want) > 12) {
              bad++;
              if (!first) first = `(${x},${y}) stage ${fmt(got)} vs upright ${fmt(want)}`;
            }
            // Where a renderer that ignored the tag would put the same canvas
            // point: the coded 64x36 frame squeezed into the 36x64 box. Coded
            // (cx, cy) is upright (35 - cy, cx) under orientation 6.
            const cx = Math.min(63, Math.floor(((x + 0.5) * 64) / 36));
            const cy = Math.min(35, Math.floor(((y + 0.5) * 36) / 64));
            if (dist(at(35 - cy, cx), want) > 40) distinct++;
          }
        }
        assert(checked >= 40, `only ${checked} flat points on the stage to compare — the fixture or the view changed`);
        assert(
          distinct * 3 >= checked,
          `only ${distinct} of ${checked} points differ between the upright and the unturned photo: the check cannot tell orientations apart`,
        );
        assert(bad === 0, `${bad} of ${checked} stage points do not match the upright decode (±12); first: ${first}`);
        const p18 = stageAt(18, 5);
        return `canvas 36x64, decoded 36x64; stage == upright decode at ${checked}/${checked} flat points (${distinct} of them differ from the unturned photo); (18,5) stage ${fmt(p18 ?? [])} vs ${fmt(at(18, 5))} — ${ms(t0)}`;
      } finally {
        await leave(paths);
      }
    });

    await test("image-pen-undo-redo", async () => {
      // A pen stroke drawn with synthetic pen events along a zigzag (so the
      // release's simplification keeps its points) lands as ONE stroke on a new
      // drawing layer above the photo, visibly; the undo chord takes it back to
      // the pixel, the redo chord brings it back; and an idle editor then asks
      // for no animation frame at all. The rAF wrapper goes on BEFORE the
      // mount: the editor looks window.requestAnimationFrame up at call time.
      const t0 = performance.now();
      const paths: string[] = [];
      const realRaf = window.requestAnimationFrame;
      let rafCalls = 0;
      window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
        realRaf.call(window, (t: number) => {
          rafCalls++;
          cb(t);
        });
      try {
        needFixtures();
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest image pen", info), "Autotest image pen", paths);
        const photo = await photoReady(dev);
        const penBtn = $<HTMLButtonElement>('#imged-tools [data-tool="pen"]');
        assert(rendered(penBtn), 'the pen button [data-tool="pen"] is not rendered');
        penBtn!.click();
        const surface = await until(() => $(".imged-ink"), 1_000, () => `the ink surface after choosing the pen (tool ${dev.tools.get().tool})`);

        // A region of the TL quadrant (flat 224,64,32) around the whole stroke.
        const v0 = dev.view.store.get();
        const g2 = dev.canvas.getContext("2d")!;
        const rx = Math.max(0, Math.floor(v0.panX + 30 * v0.zoom));
        const ry = Math.max(0, Math.floor(v0.panY + 20 * v0.zoom));
        const rw = Math.min(dev.canvas.width, Math.ceil(v0.panX + 290 * v0.zoom)) - rx;
        const rh = Math.min(dev.canvas.height, Math.ceil(v0.panY + 165 * v0.zoom)) - ry;
        assert(rw > 20 && rh > 20, `the stroke region is ${rw}x${rh} device px — the stage is too small to draw on`);
        const before = g2.getImageData(rx, ry, rw, rh).data;
        const changed = (tol: number): number => {
          const now = g2.getImageData(rx, ry, rw, rh).data;
          let n = 0;
          for (let i = 0; i < now.length; i += 4) {
            if (dist([now[i]!, now[i + 1]!, now[i + 2]!], [before[i]!, before[i + 1]!, before[i + 2]!]) > tol) n++;
          }
          return n;
        };

        const ZIG: [number, number][] = [[60, 40], [95, 140], [130, 40], [165, 140], [200, 40], [235, 140], [270, 40]];
        const at = ZIG.map(([x, y]) => dev.view.canvasToClient(x, y));
        const pen = { id: 41, kind: "pen" as const, pressure: 0.8 };
        surface.dispatchEvent(pointer("pointerdown", at[0]!.x, at[0]!.y, { ...pen, buttons: 1, button: 0 }));
        for (let i = 1; i < at.length; i++) {
          surface.dispatchEvent(pointer("pointermove", at[i]!.x, at[i]!.y, { ...pen, buttons: 1, button: -1 }));
        }
        const last = at[at.length - 1]!;
        surface.dispatchEvent(pointer("pointerup", last.x, last.y, { ...pen, buttons: 0, button: 0 }));

        const layers = dev.layers();
        assert(layers.length === 2, `after the stroke the project has ${layers.length} layer(s), expected the photo + a new drawing`);
        const drawing = layers[0]!;
        assert(
          drawing.kind === "drawing" && layers[1]!.trackId === photo.trackId,
          `the layers are [${layers.map((l) => l.kind).join(", ")}] top first — the drawing must sit ABOVE the photo`,
        );
        const strokes = strokesOf(drawing);
        assert(strokes.length === 1, `the drawing holds ${strokes.length} strokes, expected 1`);
        const s0 = strokes[0]!;
        assert(s0.t === "pen" && "p" in s0, `the stroke is a ${s0.t}, not a pen stroke`);
        const { decodePoints } = await import("../image/strokes");
        const pts = decodePoints((s0 as { p: string }).p);
        assert(pts !== null, "the committed stroke's points do not decode");
        const n = pts!.length / 3;
        // Six moves plus the landing and the lift: without the coalesced-event
        // fallback only the first point would survive.
        assert(n >= 6, `the stroke kept ${n} point(s) (points=${n}); a zigzag of 7 samples must keep at least 6`);
        const m = Math.floor(n / 2);
        const mid: [number, number] = [Math.round(pts![m * 3]!), Math.round(pts![m * 3 + 1]!)];
        const markedMid = await until(
          () => {
            const c = stagePx(dev, mid[0], mid[1]);
            return c && dist(c, GRID_TL) > 60 ? c : null;
          },
          1_500,
          () => `the stroke's midpoint (${mid.join(",")}) to change on the stage (shows ${fmt(stagePx(dev, mid[0], mid[1]) ?? [])})`,
        );
        const inked = changed(60);
        assert(inked >= 30, `only ${inked} stage pixels changed under the stroke`);
        assert(dev.session.history.canUndo && !$<HTMLButtonElement>("#imged-undo")!.disabled, "Undo is not available after the stroke");

        const undo = chordEvent(chordFor("undo"));
        window.dispatchEvent(undo);
        assert(undo.defaultPrevented, `the undo chord ${chordFor("undo")} was not claimed by the image editor`);
        assert(
          dev.layers().length === 1 && dev.layers()[0]!.trackId === photo.trackId,
          `after undo the layers are [${dev.layers().map((l) => l.kind).join(", ")}], expected the photo alone`,
        );
        await until(() => changed(2) === 0, 1_500, () => `every stroke pixel back within ±2 after undo (${changed(2)} still differ)`);

        const redo = chordEvent(chordFor("redoAlt"));
        window.dispatchEvent(redo);
        assert(redo.defaultPrevented, `the redo chord ${chordFor("redoAlt")} was not claimed by the image editor`);
        const back = dev.layers()[0];
        assert(
          back?.trackId === drawing.trackId && strokesOf(back).length === 1,
          `after redo the top layer is ${back ? `${back.kind} with ${strokesOf(back).length} strokes` : "missing"}, not the drawing with its stroke`,
        );
        await stageShows(dev, mid[0], mid[1], [markedMid[0], markedMid[1], markedMid[2]], 2, "the stroke after redo");

        // Idle: once the one-off follow-ups (a sharper decode, a drawing
        // repaint) have run, an editor nobody touches paints nothing.
        const framesSeen = rafCalls;
        assert(framesSeen > 0, "the rAF wrapper saw no frame at all — it is not on the editor's render path, so the idle count below would mean nothing");
        let lastCount = rafCalls;
        let quietSince = performance.now();
        const settleStart = performance.now();
        while (performance.now() - quietSince < 250) {
          if (performance.now() - settleStart > 2_000) {
            throw new Error(`the image editor never went quiet: ${rafCalls - framesSeen} frames in 2 s after the redo`);
          }
          await sleep(25);
          if (rafCalls !== lastCount) {
            lastCount = rafCalls;
            quietSince = performance.now();
          }
        }
        const idle0 = rafCalls;
        await sleep(400);
        const idle = rafCalls - idle0;
        assert(idle === 0, `${idle} animation frame(s) ran in 400 ms of an idle image editor`);
        return `pen zigzag → 1 stroke, points=${n}, on a new drawing layer above the photo; ${inked} stage px inked; ${chordFor("undo")} → gone, pixels restored ±2; ${chordFor("redoAlt")} → back; ${framesSeen} frames while working, 0 in 400 ms idle — ${ms(t0)}`;
      } finally {
        window.requestAnimationFrame = realRaf;
        await leave(paths);
      }
    });

    await test("image-chunks-linear", async () => {
      // 600 strokes committed one at a time: the drawing is chunked 256/256/88,
      // each commit shares every full chunk with the snapshot before it (that is
      // what keeps unlimited undo linear), and all 600 survive save → reload.
      const t0 = performance.now();
      const paths: string[] = [];
      try {
        const dev = await mountImage(
          createBlankImageProject("Autotest image strokes", 300, 200, "transparent"),
          "Autotest image strokes",
          paths,
        );
        const { addDrawingLayer, appendStrokeTo, findLayer } = await import("../image/layers");
        const { encodePoints } = await import("../image/strokes");
        const s = dev.session;
        const made: { id: string | null } = { id: null };
        s.commit((p) => {
          const r = addDrawingLayer(p);
          made.id = r.trackId;
          return r.project;
        });
        const id = made.id;
        assert(id !== null, "no drawing layer was added");
        let prev: ProjectFile = s.project;
        for (let i = 0; i < 600; i++) {
          const x = 10 + (i % 280);
          const y = 10 + ((i * 7) % 180);
          const stroke: Stroke = { t: "pen", c: "#1a2b3c", w: 3, o: 1, p: encodePoints(new Float32Array([x, y, 0.5, x + 5, y + 3, 0.7])) };
          prev = s.project;
          s.commit((p) => appendStrokeTo(p, id!, stroke));
        }
        const cur = findLayer(s.project, id!);
        const was = findLayer(prev, id!);
        const sizes = chunkSizes(cur);
        assert(sizes.join("/") === "256/256/88", `600 strokes are chunked ${sizes.join("/")}, not 256/256/88`);
        const chunksOf = (l: Layer | undefined): readonly Stroke[][] => {
          const g = l?.media.generator;
          return g?.type === "drawing" ? g.chunks : [];
        };
        const a = chunksOf(was);
        const b = chunksOf(cur);
        assert(a[0] === b[0] && a[1] === b[1], "the last commit copied a full chunk instead of sharing it with the previous snapshot");
        assert(a[2] !== b[2], "the last commit did not copy the chunk it appended to (snapshots would share a mutated array)");
        await s.save();
        const loaded = await ipc.loadProject(s.path);
        const drawing = loaded.project.media.find((m) => m.generator?.type === "drawing");
        const g = drawing?.generator;
        const reloaded = g?.type === "drawing" ? g.chunks.map((c) => c.length) : [];
        const total = reloaded.reduce((x, y) => x + y, 0);
        assert(total === 600, `after save → reload the drawing holds ${total} strokes (${reloaded.join("/")}), not 600`);
        return `600 commits → chunks 256/256/88, chunks[0] and [1] shared with the previous snapshot, last one copied; save → reload: ${reloaded.join("/")} = ${total} — ${ms(t0)}`;
      } finally {
        await leave(paths);
      }
    });

    await test("image-background-buttons", async () => {
      // The inspector's Background buttons (nothing selected) set
      // project.image.background, one undo step each, and the stage repaints on
      // its own: a checker (two squares, one square apart, differ), then white,
      // then black, then the checker again.
      const t0 = performance.now();
      const paths: string[] = [];
      let spy: { readonly n: number; restore(): void } | null = null;
      try {
        const dev = await mountImage(
          createBlankImageProject("Autotest image background", 300, 200, "transparent"),
          "Autotest image background",
          paths,
        );
        await frames(2);
        dev.renderNow();
        spy = countPushes(dev.session);
        const v = dev.view.store.get();
        const side = Math.max(1, Math.round(8 * v.dpr));
        const ax = Math.round(v.panX) + Math.floor(side / 2);
        const ay = Math.round(v.panY) + Math.floor(side / 2);
        const g2 = dev.canvas.getContext("2d")!;
        const px = (x: number): Rgb => {
          const d = g2.getImageData(x, ay, 1, 1).data;
          return [d[0]!, d[1]!, d[2]!];
        };
        const pair = (): [Rgb, Rgb] => [px(ax), px(ax + side)];
        const CHECKERS: [Rgb, Rgb][] = [
          [[0x2b, 0x2b, 0x2b], [0x3a, 0x3a, 0x3a]],
          [[0xe8, 0xe8, 0xe8], [0xff, 0xff, 0xff]],
        ];
        const isChecker = ([a, b]: [Rgb, Rgb]): boolean => CHECKERS.some(([p, q]) => dist(a, p) <= 1 && dist(b, q) <= 1);
        const button = (label: string): HTMLButtonElement | null =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("#imged-inspector .imged-insp-bg button")).find(
            (b) => b.textContent?.trim() === label,
          ) ?? null;
        await until(() => button("White"), 2_000, () => "the inspector's Background buttons (nothing selected)");
        assert(isChecker(pair()), `a transparent background shows ${pair().map(fmt).join(" / ")}, not the checker`);

        const steps: string[] = [];
        for (const [label, stored, want] of [
          ["White", "#ffffff", [255, 255, 255]],
          ["Black", "#000000", [0, 0, 0]],
          ["Transparent", "transparent", null],
        ] as const) {
          const b = button(label);
          assert(rendered(b), `the "${label}" background button is not rendered`);
          const n0 = spy.n;
          b!.click();
          assert(
            dev.session.project.image?.background === stored,
            `"${label}" set the background to ${String(dev.session.project.image?.background)}, not ${stored}`,
          );
          assert(spy.n - n0 === 1, `"${label}" pushed ${spy.n - n0} history entries, expected 1`);
          await until(
            () => (want === null ? isChecker(pair()) : dist(pair()[0], want) === 0 && dist(pair()[1], want) === 0),
            1_500,
            () => `the stage to show ${want === null ? "the checker" : fmt(want)} after "${label}" (shows ${pair().map(fmt).join(" / ")})`,
          );
          await until(() => button(label)?.getAttribute("aria-pressed") === "true", 1_000, () => `"${label}" to read pressed`);
          steps.push(`${label} → ${pair().map(fmt).join("/")}`);
        }
        return `checker → ${steps.join(", ")}; one history entry per button — ${ms(t0)}`;
      } finally {
        spy?.restore();
        await leave(paths);
      }
    });

    await test("image-adjust-parity", async () => {
      // Brightness +40, contrast −20, warmth +30 through the inspector's own
      // sliders: each drag is live while the pointer is down and lands as ONE
      // history entry on release. The stage pixel over canvas (100, 60), the
      // exported pixel there and the adjust plan applied to the fixture colour
      // all agree to ±2.
      const t0 = performance.now();
      const paths: string[] = [];
      let spy: { readonly n: number; restore(): void } | null = null;
      try {
        needFixtures();
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest image adjust", info), "Autotest image adjust", paths);
        const photo = await photoReady(dev);
        await stageShows(dev, 100, 60, GRID_TL, 1, "the unadjusted photo");
        if (dev.selection.get() !== photo.trackId) dev.selection.set(photo.trackId);
        const sliderFor = (label: string): HTMLInputElement | null => {
          for (const f of Array.from(document.querySelectorAll<HTMLElement>("#imged-inspector .insp-field"))) {
            if (f.querySelector(":scope > label")?.textContent?.trim() === label) {
              return f.querySelector<HTMLInputElement>('input.slider[type="range"]');
            }
          }
          return null;
        };
        await until(() => sliderFor("Brightness"), 2_000, () => "the photo's Adjust sliders in the inspector");
        spy = countPushes(dev.session);
        const adjustNow = (): Record<string, number> =>
          (dev.layers().find((l) => l.trackId === photo.trackId)?.clip.adjust ?? {}) as unknown as Record<string, number>;
        const drag = (label: string, key: string, values: readonly number[]): string => {
          const r = sliderFor(label);
          assert(rendered(r) && !r.disabled, `the ${label} slider is not rendered or is disabled`);
          const n0 = spy!.n;
          r!.dispatchEvent(pointer("pointerdown", 0, 0, { id: 71, kind: "mouse", buttons: 1, button: 0 }));
          for (const v of values) {
            r!.value = String(v);
            r!.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const want = values[values.length - 1]!;
          const live = adjustNow()[key];
          assert(live === want, `${label} is ${String(live)} mid-drag, not the live ${want}`);
          assert(spy!.n === n0, `${label}: the drag wrote ${spy!.n - n0} history entries before the release`);
          r!.dispatchEvent(pointer("pointerup", 0, 0, { id: 71, kind: "mouse", buttons: 0, button: 0 }));
          r!.dispatchEvent(new Event("change", { bubbles: true }));
          assert(spy!.n - n0 === 1, `one ${label} drag pushed ${spy!.n - n0} history entries, expected exactly 1`);
          return `${label} ${want}`;
        };
        const done = [
          drag("Brightness", "brightness", [12, 27, 40]),
          drag("Contrast", "contrast", [-7, -20]),
          drag("Warmth", "warmth", [15, 30]),
        ];
        const adj = dev.layers().find((l) => l.trackId === photo.trackId)?.clip.adjust;
        assert(
          adj?.brightness === 40 && adj.contrast === -20 && adj.warmth === 30 && adj.exposure === 0 && adj.hue === 0,
          `the stored adjust is ${JSON.stringify(adj)}`,
        );
        const { applyAdjustPlan, buildAdjustPlan } = await import("../image/adjust/plan");
        const px = new Uint8ClampedArray([...GRID_TL, 255]);
        applyAdjustPlan(px, buildAdjustPlan(adj!));
        const want: Rgb = [px[0]!, px[1]!, px[2]!];
        // Anti-coincidence: an adjust that did nothing would pass everything below.
        assert(dist(want, GRID_TL) > 10, `the adjust plan moves ${fmt(GRID_TL)} only to ${fmt(want)} — the settings cannot be told from none`);
        const onStage = await stageShows(dev, 100, 60, want, 2, "the adjusted photo");
        const { renderImageExport } = await import("../image/render/export");
        const blob = await renderImageExport(
          dev.session.project,
          { format: "png", quality: 92, outW: 641, outH: 361 },
          new AbortController().signal,
          () => {},
        );
        const out = await pixelsOf(blob);
        const exported = out.at(100, 60);
        assert(dist(exported, want) <= 2, `the exported pixel at (100,60) is ${fmt(exported)}, the plan says ${fmt(want)}`);
        assert(dist(exported, onStage) <= 2, `stage ${fmt(onStage)} and export ${fmt(exported)} differ by more than 2`);
        return `${done.join(", ")}: one history entry per drag, live mid-drag; (100,60) plan ${fmt(want)} / stage ${fmt(onStage)} / export ${fmt(exported)} (from ${fmt(GRID_TL)}) — ${ms(t0)}`;
      } finally {
        spy?.restore();
        await leave(paths);
      }
    });

    await test("image-canvas-vs-layer", async () => {
      // Canvas controls and layer controls say which is which. The tool row's
      // button reads "Canvas" and wears no crop glyph (the owner read the old
      // "Image" + crop icon as "crop the layer I selected"); with nothing
      // selected the inspector is headed "Canvas" and its Crop canvas opens
      // the canvas crop, whose bar says so; the layer inspector's own Crop
      // button opens the on-canvas LAYER crop (the double-click mode), whose
      // bar says "Crop layer"; and every slider row shows its value once, in a
      // number field wide enough for the row's widest number.
      const t0 = performance.now();
      const paths: string[] = [];
      const cancelCrops = (): void => {
        for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".imged-cropbar button"))) {
          if (b.textContent?.trim() === "Cancel" && rendered(b)) b.click();
        }
      };
      try {
        needFixtures();
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest image canvas", info), "Autotest image canvas", paths);
        const photo = await photoReady(dev);
        const { IMG_ICON_PATHS } = await import("../image/icons");

        // The tool row.
        const menuBtn = $<HTMLButtonElement>("#imged-menu");
        assert(rendered(menuBtn), "#imged-menu is not rendered");
        const label = menuBtn!.textContent?.trim() ?? "";
        assert(label === "Canvas", `the tool row's canvas button reads "${label}", not "Canvas"`);
        const hitBtn = hitsItself(menuBtn!);
        assert(hitBtn.ok, `the Canvas button's centre hits ${hitBtn.hit}`);
        const cropDs = new Set(Array.from(IMG_ICON_PATHS.crop.matchAll(/ d="([^"]+)"/g), (m) => m[1]!));
        const btnDs = Array.from(menuBtn!.querySelectorAll("svg path"), (p) => p.getAttribute("d") ?? "");
        assert(btnDs.length > 0, "the Canvas button has no icon");
        assert(!btnDs.some((d) => cropDs.has(d)), "the Canvas button still wears the crop icon");

        // Nothing selected: the Canvas panel, and its canvas crop.
        dev.selection.set(null);
        const head = await until(
          () => {
            const h = $("#imged-inspector .insp-header__name");
            return rendered(h) && h.textContent?.trim() === "Canvas" ? h : null;
          },
          2_000,
          () => `the inspector headed "Canvas" with nothing selected (it reads "${text("#imged-inspector .insp-header__name")}")`,
        );
        assert(rendered($("#imged-inspector .imged-insp-hint")), "the Canvas panel's hint is not rendered");
        const canvasCrop = Array.from(document.querySelectorAll<HTMLButtonElement>("#imged-inspector button")).find(
          (b) => b.textContent?.trim() === "Crop canvas",
        );
        assert(rendered(canvasCrop ?? null), "the Canvas panel has no rendered Crop canvas button");
        canvasCrop!.click();
        assert(dev.mode.get() === "crop-image", `Crop canvas left the stage in mode ${dev.mode.get()}, not crop-image`);
        const canvasLabel = $(".imged-crop .imged-cropbar__label");
        assert(rendered(canvasLabel) && canvasLabel.textContent === "Crop canvas", `the canvas crop's bar label is ${describeEl(canvasLabel)} "${canvasLabel?.textContent ?? ""}"`);
        cancelCrops();
        await until(() => dev.mode.get() === "idle", 1_000, () => `the canvas crop to close (mode ${dev.mode.get()})`);

        // The photo selected: one value per slider row.
        dev.selection.set(photo.trackId);
        const fieldFor = (name: string): HTMLElement | null =>
          Array.from(document.querySelectorAll<HTMLElement>("#imged-inspector .insp-field")).find(
            (f) => f.querySelector(":scope > label")?.textContent?.trim() === name,
          ) ?? null;
        await until(() => fieldFor("Opacity") && fieldFor("Hue"), 2_000, () => "the photo's Opacity and Adjust rows in the inspector");
        assert(head.isConnected === false, "the Canvas header is still in the inspector with the photo selected");
        const probeCtx = new OffscreenCanvas(1, 1).getContext("2d")!;
        const rows = ["Opacity", "Exposure", "Brightness", "Contrast", "Highlights", "Shadows", "Saturation", "Warmth", "Tint", "Hue"];
        let tightest = Infinity;
        for (const name of rows) {
          const f = fieldFor(name);
          assert(f !== null, `no "${name}" row in the inspector`);
          const vals = Array.from(f!.querySelectorAll(".insp-slider__value, .insp-slider input[type=number]")).filter(rendered);
          assert(vals.length === 1, `the ${name} row shows ${vals.length} value elements (${vals.map(describeEl).join(", ")}), not exactly one`);
          const num = vals[0] as HTMLInputElement;
          assert(num instanceof HTMLInputElement && num.type === "number", `the ${name} row's one value is ${describeEl(num)}, not its number field`);
          const cs = getComputedStyle(num);
          probeCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const room = num.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const widest = name === "Hue" ? ["-180", "180"] : name === "Opacity" ? ["100"] : ["-100", "100"];
          const was = num.value;
          try {
            for (const s of widest) {
              const need = probeCtx.measureText(s).width;
              assert(need <= room, `the ${name} field has ${room.toFixed(1)} px for its text; "${s}" needs ${need.toFixed(1)} px`);
              tightest = Math.min(tightest, room - need);
              // Shown, not only measured: the field must not scroll it.
              num.value = s;
              assert(num.scrollWidth <= num.clientWidth, `the ${name} field scrolls "${s}" (scrollWidth ${num.scrollWidth} > ${num.clientWidth})`);
            }
          } finally {
            num.value = was;
          }
        }

        // The layer's own Crop button opens the on-canvas layer crop.
        const cropBtn = $<HTMLButtonElement>('#imged-inspector button[aria-label="Crop layer"]');
        assert(rendered(cropBtn), "the layer inspector has no rendered Crop button");
        const reset = $<HTMLButtonElement>('#imged-inspector button[aria-label="Reset crop"]');
        assert(rendered(reset) && reset.disabled, "the crop's Reset is missing or enabled on an uncropped photo");
        const before = dev.session.project;
        // From a DRAWING tool: the select overlay is display:none there, and a
        // crop bar measured while hidden was parked off the stage.
        dev.tools.set({ ...dev.tools.get(), tool: "pen" });
        await sleep(0);
        cropBtn!.click();
        assert(dev.mode.get() === "crop-layer", `the Crop button left the stage in mode ${dev.mode.get()}, not crop-layer`);
        assert(dev.tools.get().tool === "select", `the Crop button left the ${dev.tools.get().tool} tool on, not select`);
        const layerBar = await until(
          () => Array.from(document.querySelectorAll<HTMLElement>(".imged-select__cropbar")).find(rendered),
          1_000,
          () => "the layer crop's bar to render",
        );
        const layerLabel = layerBar.querySelector(".imged-cropbar__label");
        assert(rendered(layerLabel) && layerLabel.textContent === "Crop layer", `the layer crop's bar label reads "${layerLabel?.textContent ?? ""}"`);
        const barHit = hitsItself(layerBar);
        assert(barHit.ok, `the layer crop's bar centre hits ${barHit.hit}`);
        const stageBox = $("#imged-stage")!.getBoundingClientRect();
        const barBox = layerBar.getBoundingClientRect();
        assert(
          barBox.left >= stageBox.left - 0.5 && barBox.right <= stageBox.right + 0.5 && barBox.top >= stageBox.top - 0.5 && barBox.bottom <= stageBox.bottom + 0.5,
          `the layer crop's bar (${barBox.left.toFixed(0)},${barBox.top.toFixed(0)} ${barBox.width.toFixed(0)}×${barBox.height.toFixed(0)}) is not inside the stage (${stageBox.left.toFixed(0)},${stageBox.top.toFixed(0)} ${stageBox.width.toFixed(0)}×${stageBox.height.toFixed(0)})`,
        );
        cancelCrops();
        await until(() => dev.mode.get() === "idle", 1_000, () => `the layer crop to close (mode ${dev.mode.get()})`);
        assert(dev.session.project === before, "cancelling the untouched layer crop changed the project");
        return `tool row "Canvas" (no crop glyph); nothing selected → "Canvas" panel, Crop canvas → crop-image with a "Crop canvas" bar; ${rows.length} slider rows × 1 value each, ≥${tightest.toFixed(1)} px spare for the widest number; Crop → crop-layer with a "Crop layer" bar — ${ms(t0)}`;
      } finally {
        cancelCrops();
        await leave(paths);
      }
    });

    await test("image-toolrow-narrow", async () => {
      // The tool row at the narrowest window (960 px: the allowed minimum, and
      // a Snap half-screen on a 1080p display) leaves the editor's main column
      // 420 px (960 − 260 Layers − 280 inspector). Both groups need about
      // 590 px with the Pen on, and the pixel eraser's hint needs more: the
      // row must WRAP, so every control is still the one painted at its own
      // centre and nothing slides under the inspector. Also: the Canvas button
      // activated from the keyboard (a click with detail 0) opens its menu on
      // the first row, and a pointer click does not.
      const t0 = performance.now();
      const paths: string[] = [];
      let main: HTMLElement | null = null;
      try {
        const dev = await mountImage(
          createBlankImageProject("Autotest image toolrow", 641, 361, "#ffffff"),
          "Autotest image toolrow",
          paths,
        );
        const menuBtn = $<HTMLButtonElement>("#imged-menu");
        assert(rendered(menuBtn), "#imged-menu is not rendered");

        // Keyboard vs pointer activation of the Canvas button.
        const menuRows = (): HTMLElement[] =>
          Array.from(document.querySelectorAll<HTMLElement>(".ctx-menu .ctx-menu__item")).filter(rendered);
        menuBtn!.click();
        await until(() => menuRows().length > 0, 1_000, () => "the Canvas menu to open from a keyboard-style click");
        const first = menuRows()[0]!;
        assert(
          document.activeElement === first && first.textContent?.trim() === "Crop canvas",
          `a keyboard open of the Canvas menu left focus on ${describeEl(document.activeElement)}, not its first row "Crop canvas"`,
        );
        closeMenu();
        menuBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
        await until(() => menuRows().length > 0, 1_000, () => "the Canvas menu to open from a pointer click");
        const menuHost = $(".ctx-menu");
        assert(
          !(document.activeElement instanceof Node && menuHost?.contains(document.activeElement)),
          `a pointer open of the Canvas menu focused ${describeEl(document.activeElement)}`,
        );
        closeMenu();

        // Undo and Redo both live: a disabled .btn has pointer-events none,
        // so a greyed one could never be the element hit at its centre. Two
        // canvas turns, then one Undo through the button itself.
        const { rotateCanvas } = await import("../image/image-menu");
        rotateCanvas(dev.ctx, 90);
        rotateCanvas(dev.ctx, 90);
        // The buttons follow the session on a microtask: a click before that
        // lands on a still-disabled Undo and does nothing.
        await until(() => !$<HTMLButtonElement>("#imged-undo")!.disabled, 1_000, () => "Undo to enable after two canvas turns");
        $<HTMLButtonElement>("#imged-undo")!.click();
        await until(
          () => !$<HTMLButtonElement>("#imged-undo")!.disabled && !$<HTMLButtonElement>("#imged-redo")!.disabled,
          1_000,
          () => `Undo and Redo both enabled (undo ${$<HTMLButtonElement>("#imged-undo")!.disabled ? "off" : "on"}, redo ${$<HTMLButtonElement>("#imged-redo")!.disabled ? "off" : "on"})`,
        );

        // Narrow the column to what a 960 px window leaves it.
        main = $(".imged .editor__main");
        const inspector = $("#imged-inspector");
        assert(rendered(main) && rendered(inspector), "the editor's main column or inspector is not rendered");
        main!.style.flex = "0 0 420px";
        await frames(2);
        const colW = main!.getBoundingClientRect().width;
        assert(Math.abs(colW - 420) <= 1, `the main column is ${colW.toFixed(1)} px wide, not the 420 px it was set to`);

        const check = async (what: string): Promise<string> => {
          await frames(2);
          const col = main!.getBoundingClientRect();
          const insLeft = inspector!.getBoundingClientRect().left;
          const tools = Array.from(
            document.querySelectorAll<HTMLElement>("#imged-tools button, #imged-tools select"),
          ).filter(rendered);
          assert(tools.length > 0, `${what}: no rendered tool-row controls`);
          const named = [$<HTMLElement>("#imged-undo"), menuBtn, tools[tools.length - 1]!];
          const all = [
            ...tools,
            ...Array.from(document.querySelectorAll<HTMLElement>("#imged-viewctl button")).filter(rendered),
          ];
          for (const b of new Set([...named, ...all])) {
            assert(rendered(b), `${what}: ${describeEl(b)} is not rendered`);
            const hit = hitsItself(b!);
            assert(hit.ok, `${what}: the centre of ${describeEl(b)} "${b!.textContent?.trim() ?? ""}" hits ${hit.hit}`);
            const r = b!.getBoundingClientRect();
            assert(
              r.left >= col.left - 0.5 && r.right <= col.right + 0.5,
              `${what}: ${describeEl(b)} spans ${r.left.toFixed(0)}-${r.right.toFixed(0)}, outside the column ${col.left.toFixed(0)}-${col.right.toFixed(0)}`,
            );
          }
          const menuRight = menuBtn!.getBoundingClientRect().right;
          assert(menuRight <= insLeft + 0.5, `${what}: the Canvas button ends at ${menuRight.toFixed(0)}, under the inspector (from ${insLeft.toFixed(0)})`);
          // The narrow width is really exercised: the view controls wrapped
          // below the tools rather than fitting beside them.
          const toolsTop = $("#imged-tools")!.getBoundingClientRect().top;
          const viewTop = $("#imged-viewctl")!.getBoundingClientRect().top;
          assert(viewTop > toolsTop + 4, `${what}: the view controls (top ${viewTop.toFixed(0)}) did not wrap below the tools (top ${toolsTop.toFixed(0)})`);
          return `${what} ${all.length} controls`;
        };

        dev.tools.set({ ...dev.tools.get(), tool: "pen" });
        const pen = await check("Pen");

        // The widest row: the pixel eraser with no drawing layer to cut shows
        // its hint.
        dev.tools.set({ ...dev.tools.get(), tool: "eraser", eraserMode: "pixel" });
        const hint = await until(
          () => Array.from(document.querySelectorAll<HTMLElement>("#imged-tools .imged-hint")).find(rendered),
          1_000,
          () => "the pixel eraser's hint to show on a project with no drawing",
        );
        const eraser = await check("pixel eraser");
        const hr = hint.getBoundingClientRect();
        const col = main!.getBoundingClientRect();
        assert(hr.right <= col.right + 0.5, `the eraser hint ends at ${hr.right.toFixed(0)}, past the column (${col.right.toFixed(0)})`);
        const hintHit = hitsItself(hint);
        assert(hintHit.ok, `the eraser hint's centre hits ${hintHit.hit}`);
        return `a 420 px column: ${pen}, ${eraser} each hit at their centres inside it, view controls on a second line; Canvas menu opens on its first row from the keyboard only — ${ms(t0)}`;
      } finally {
        if (main) main.style.flex = "";
        closeMenu();
        await leave(paths);
      }
    });

    await test("image-export-roundtrip", async () => {
      // Through the export dialog: a PNG at 100% and a JPEG at 50% are written
      // and read back (size by ffprobe, pixels by decode), the run holds the
      // session ("An export is running.") while it writes and lets go after,
      // and nothing is left beside the output. Then the engine alone: a WebP at
      // quality 100 is lossless (VP8L — the dialog labels it "Lossless", so an
      // engine that stops writing VP8L must turn this red), and a JPEG of a
      // transparent still is
      // flattened onto white, not onto its hidden colour.
      const t0 = performance.now();
      const paths: string[] = [];
      const outs: string[] = [];
      const lastDir = settingsStore.get().lastExportDir;
      const realBegin = ipc.imageSaveBegin;
      const begins: { kind: string; reason: string | null }[] = [];
      try {
        needFixtures();
        const dir = await scratchDir();
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest image export", info), "Autotest image export", paths);
        await photoReady(dev);
        ipc.imageSaveBegin = (dest, format, total) => {
          begins.push({ kind: dest.kind, reason: leaveBlockedReason() });
          return realBegin(dest, format, total);
        };
        const dialogText = (): string => text(".export-modal #ix-body").slice(0, 160);
        const runDialog = async (format: "png" | "jpeg", size: "100" | "50", name: string, px: string): Promise<string> => {
          const out = `${dir}\\${name}.${format === "jpeg" ? "jpg" : "png"}`;
          outs.push(out);
          await removeTestFile(out).catch(() => {});
          $<HTMLButtonElement>("#ed-export")!.click();
          await until(() => $(".export-modal #ix-name"), 2_000, () => `the export dialog (${onScreen()})`);
          $<HTMLButtonElement>(`.export-modal [data-format="${format}"]`)!.click();
          const sel = $<HTMLSelectElement>(".export-modal #ix-size")!;
          sel.value = size;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          assert(text(".export-modal #ix-px") === px, `the dialog plans "${text(".export-modal #ix-px")}" for ${size}%, not "${px}"`);
          for (const [sel2, value] of [["#ix-folder", dir], ["#ix-name", name]] as const) {
            const el = $<HTMLInputElement>(`.export-modal ${sel2}`)!;
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          assert(leaveBlockedReason() === null, `precondition: the session is already held (${String(leaveBlockedReason())})`);
          const n0 = begins.length;
          $<HTMLButtonElement>(".export-modal #ix-run")!.click();
          const end = await until(
            () => ($(".export-modal #ix-reveal") ? "ok" : $(".export-modal .export-result__icon--bad") ? "error" : $(".export-modal #ix-warn-slot .export-warn") ? "warn" : null),
            8_000,
            () => `the ${format} export to finish (hold ${String(leaveBlockedReason())}, dialog "${dialogText()}")`,
          );
          assert(end === "ok", `the ${format} export ended in ${end === "warn" ? "a warning strip" : "the error view"}: "${dialogText()}"`);
          const mine = begins.slice(n0).filter((b) => b.kind === "user");
          assert(mine.length === 1, `the ${format} export began ${mine.length} user saves, expected 1`);
          assert(mine[0]!.reason === HOLD, `while the ${format} export was writing, the session's hold was ${JSON.stringify(mine[0]!.reason)}, not "${HOLD}"`);
          assert(leaveBlockedReason() === null, `the finished ${format} export still holds the session (${String(leaveBlockedReason())})`);
          $<HTMLButtonElement>(".export-modal [data-close-btn]")!.click();
          await until(() => !$(".export-modal"), 2_000, () => "the export dialog to close");
          assert(await ipc.pathExists(out), `the export reported success but ${out} does not exist`);
          for (const ext of [".part", ".bak"]) {
            assert(!(await ipc.pathExists(out + ext)), `the ${format} export left ${baseName(out)}${ext} behind`);
          }
          return out;
        };

        const png = await runDialog("png", "100", "autotest-image-export", "641 × 361 px");
        const pngInfo = await probe(png);
        assert(pngInfo.width === 641 && pngInfo.height === 361, `ffprobe reads the PNG as ${pngInfo.width}x${pngInfo.height}, not 641x361`);
        const dec = await pixelsOf(await fileBlob(png));
        assert(dec.w === 641 && dec.h === 361, `the PNG decodes at ${dec.w}x${dec.h}, not 641x361`);
        const tl = dec.at(100, 60);
        const br = dec.at(480, 270);
        const tr = dec.at(480, 60);
        const bl = dec.at(100, 270);
        for (const [what, got, want] of [["TL", tl, GRID_TL], ["BR", br, GRID_BR], ["TR", tr, GRID_BG], ["BL", bl, GRID_BG]] as const) {
          assert(dist(got, want) <= 1, `the exported PNG's ${what} pixel is ${fmt(got)}, the fixture's is ${fmt(want)}`);
        }

        const jpg = await runDialog("jpeg", "50", "autotest-image-export-half", "321 × 181 px");
        const jpgInfo = await probe(jpg);
        assert(jpgInfo.width === 321 && jpgInfo.height === 181, `ffprobe reads the 50% JPEG as ${jpgInfo.width}x${jpgInfo.height}, not 321x181`);

        const { renderImageExport } = await import("../image/render/export");
        const noop = (): void => {};
        const webp = await renderImageExport(
          dev.session.project,
          { format: "webp", quality: 100, outW: 641, outH: 361 },
          new AbortController().signal,
          noop,
        );
        const head = new TextDecoder("latin1").decode(new Uint8Array(await webp.slice(0, 64).arrayBuffer()));
        assert(
          webp.type === "image/webp" && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP",
          `the q100 export is not a WebP (${webp.type}): "${head.replace(/[^\x20-\x7e]/g, ".").slice(0, 40)}"`,
        );
        // The image chunk follows VP8X and an ICC profile (~3 KB), so look past
        // the 64-byte header read above — reading only the header is exactly
        // what once made a lossless file look lossy.
        const chunks = new TextDecoder("latin1").decode(new Uint8Array(await webp.slice(0, 16384).arrayBuffer()));
        const webpKind = chunks.includes("VP8L") ? "lossless VP8L" : chunks.includes("VP8 ") ? "lossy VP8" : "unknown encoding";
        assert(webpKind === "lossless VP8L", `the q100 WebP the dialog labels "Lossless" is ${webpKind}`);

        const alphaInfo = await probe(fx(ALPHA));
        const alphaDoc = createPhotoImageProject("Autotest image alpha", alphaInfo);
        assert(alphaDoc.image?.background === "transparent", `precondition: the alpha project's background is ${String(alphaDoc.image?.background)}`);
        const flat = await pixelsOf(
          await renderImageExport(alphaDoc, { format: "jpeg", quality: 92, outW: 97, outH: 61 }, new AbortController().signal, noop),
        );
        const clear = flat.at(12, 30);
        const solid = flat.at(70, 30);
        assert(dist(clear, [255, 255, 255]) <= 6, `the transparent columns export as ${fmt(clear)} in a JPEG, not white (their hidden colour is ${fmt(ALPHA_RGB)})`);
        assert(dist(solid, ALPHA_RGB) <= 6, `the opaque columns export as ${fmt(solid)}, not ${fmt(ALPHA_RGB)}`);
        return `dialog PNG 100% → ffprobe 641x361, TL ${fmt(tl)} BR ${fmt(br)} TR ${fmt(tr)} BL ${fmt(bl)}; JPEG 50% → 321x181; hold "${HOLD}" while each wrote, released after; no .part/.bak; WebP q100 → ${webpKind}; transparent JPEG → ${fmt(clear)} beside ${fmt(solid)} — ${ms(t0)}`;
      } finally {
        ipc.imageSaveBegin = realBegin;
        await leave(paths);
        for (const o of outs) await removeTestFile(o).catch(() => {});
        // Unconditionally: the dialog's own write is fire-and-forget, and
        // settings writes are serialized, so this one lands after it.
        await updateSettings({ lastExportDir: lastDir }).catch(() => {});
      }
    });

    await test("image-save-refuses-source", async () => {
      // An export onto a file the project reads is refused by the backend on
      // path IDENTITY — the source is spelled in upper case here — and the file
      // is left exactly as it was. The same save with a different source goes
      // through, so the refusal is about the source and nothing else.
      const t0 = performance.now();
      let copy = "";
      try {
        needFixtures();
        const dir = await scratchDir();
        copy = `${dir}\\autotest-image-source.png`;
        await removeTestFile(copy).catch(() => {});
        const { saveBlob } = await import("../image/save");
        const bytes = await fileBlob(fx(GRID));
        await saveBlob({ kind: "user", path: copy, sources: [] }, "png", bytes);
        const before = await probe(copy);
        let err: unknown = null;
        try {
          await saveBlob({ kind: "user", path: copy, sources: [copy.toUpperCase()] }, "png", bytes);
        } catch (e) {
          err = e;
        }
        assert(err !== null, "a save onto one of the project's sources (spelled in upper case) was written");
        const d = errorDetail(err);
        assert(d.code === "bad_input", `the refusal came back as ${d.code || "no code"}: ${d.message}`);
        const after = await probe(copy);
        assert(
          after.size === before.size && after.mtimeMs === before.mtimeMs,
          `the refused save changed the file: size ${before.size} → ${after.size}, mtime ${before.mtimeMs} → ${after.mtimeMs}`,
        );
        assert(!(await ipc.pathExists(`${copy}.part`)), "the refused save left a .part behind");
        await saveBlob({ kind: "user", path: copy, sources: [fx(GRID)] }, "png", bytes);
        return `onto a source (upper-case spelling) → ${d.code} "${d.message}"; size ${after.size} and mtime unchanged; no .part; with another source the same save goes through — ${ms(t0)}`;
      } finally {
        if (copy) await removeTestFile(copy).catch(() => {});
      }
    });

    await test("image-damaged-stroke-refused", async () => {
      // The typed loader skips a damaged stroke rather than refuse the file, so
      // save_project checks the RAW value: the app can never WRITE a stroke its
      // own loader would drop. A drawing with one good and one malformed stroke
      // is refused naming the stroke; the same drawing without it saves. (The
      // load-side leniency needs a raw .trt on disk that the app did not write,
      // and no dev route writes one: it is pinned by the cargo test
      // a_damaged_stroke_never_refuses_the_project and by validateImageProject's
      // vitest instead.)
      const t0 = performance.now();
      const written: string[] = [];
      try {
        const { addDrawingLayer, appendStrokeTo } = await import("../image/layers");
        const { encodePoints } = await import("../image/strokes");
        const made = addDrawingLayer(createBlankImageProject("Autotest damaged stroke", 320, 240, "transparent"));
        const good: Stroke = { t: "pen", c: "#1a2b3c", w: 3, o: 1, p: encodePoints(new Float32Array([12, 34, 0.5, 56, 78, 0.9])) };
        const clean = appendStrokeTo(made.project, made.trackId, good);
        const crafted = structuredClone(clean);
        const gen = crafted.media.find((m) => m.generator?.type === "drawing")?.generator;
        assert(gen?.type === "drawing", "the crafted project has no drawing");
        // 16 characters, so only the alphabet is wrong, not the length.
        (gen as { chunks: Stroke[][] }).chunks[0]!.push({ ...good, p: "@@@@@@@@@@@@@@@@" });
        const bad = await ipc.tempProjectPath("Autotest damaged stroke");
        let err: unknown = null;
        try {
          await ipc.saveProject(bad, crafted);
          written.push(bad);
        } catch (e) {
          err = e;
        }
        assert(err !== null, "save_project wrote an image project holding a malformed stroke");
        const d = errorDetail(err);
        assert(d.code === "bad_input" && /stroke 2\b/.test(d.message), `the refusal is ${d.code || "no code"}: "${d.message}" — expected bad_input naming stroke 2`);
        assert(!(await ipc.pathExists(bad)), `the refused save left ${baseName(bad)} on disk`);
        const ok = await ipc.tempProjectPath("Autotest clean stroke");
        await ipc.saveProject(ok, clean);
        written.push(ok);
        return `good + malformed stroke → ${d.code} "${d.message}", nothing written; good stroke alone saves (load-side leniency: cargo-pinned, no dev route writes a raw .trt) — ${ms(t0)}`;
      } finally {
        for (const p of written) await ipc.deleteProject(p).catch(() => {});
      }
    });

    await test("image-layers-select", async () => {
      // A 97x61 solid through Add layer → Solid color (the generator dialog's
      // onCreate); a real click on its eye hides it on the stage; a double-click
      // renames it; a select-tool drag of (+40, +25) canvas px moves it by
      // exactly that in ONE history entry; a row drag below the photo puts it
      // under the photo on the stage.
      const t0 = performance.now();
      const paths: string[] = [];
      let spy: { readonly n: number; restore(): void } | null = null;
      try {
        needFixtures();
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest image layers", info), "Autotest image layers", paths);
        const photo = await photoReady(dev);
        $<HTMLButtonElement>("#imged-add-layer")!.click();
        const item = await until(
          () => Array.from(document.querySelectorAll<HTMLButtonElement>(".ctx-menu .ctx-menu__item")).find((b) => b.textContent?.trim() === "Solid color" && rendered(b) && !b.disabled),
          2_000,
          () => "a Solid color item in the Add layer menu",
        );
        item.click();
        const dlg = await until(() => $(".modal-backdrop .gen-color")?.closest<HTMLElement>(".modal-backdrop"), 2_000, () => "the Add solid dialog");
        const colour = dlg.querySelector<HTMLInputElement>(".gen-color")!;
        colour.value = SOLID_HEX;
        colour.dispatchEvent(new Event("input", { bubbles: true }));
        const [wIn, hIn] = Array.from(dlg.querySelectorAll<HTMLInputElement>(".gen-num"));
        assert(wIn !== undefined && hIn !== undefined, "the Add solid dialog has no width/height fields");
        wIn!.value = "97";
        hIn!.value = "61";
        const add = dlg.querySelector<HTMLButtonElement>(".btn--primary");
        assert(add?.textContent?.trim() === "Add solid", `the dialog's primary button reads "${add?.textContent?.trim() ?? "(none)"}", not "Add solid"`);
        add!.click();
        const solid = await until(
          () => {
            const top = dev.layers()[0];
            return dev.layers().length === 2 && top?.kind === "solid" ? top : null;
          },
          2_000,
          () => `a solid layer on top (layers: ${dev.layers().map((l) => l.kind).join(", ")})`,
        );
        assert(solid.media.width === 97 && solid.media.height === 61, `the solid is ${solid.media.width}x${solid.media.height}, not 97x61`);
        assert(dev.layers()[1]!.trackId === photo.trackId, "the solid did not land directly above the photo");
        // (300,168) is inside the solid and over the TL quadrant.
        await stageShows(dev, 300, 168, SOLID_RGB, 2, "the new solid");

        const row = (id: string): HTMLElement | null => $(`#imged-layers .imged-layer[data-track="${CSS.escape(id)}"]`);
        const eye = row(solid.trackId)?.querySelector<HTMLButtonElement>(".imged-layer__eye") ?? null;
        assert(rendered(eye), "the solid's eye button is not rendered");
        const eyeHit = hitsItself(eye!);
        assert(eyeHit.ok, `the solid's eye button is covered by ${eyeHit.hit}`);
        eye!.click();
        await stageShows(dev, 300, 168, GRID_TL, 2, "the photo under the hidden solid");
        assert(dev.layers()[0]!.hidden, "the eye click did not mark the solid hidden");
        eye!.click();
        await stageShows(dev, 300, 168, SOLID_RGB, 2, "the solid shown again");

        row(solid.trackId)!.querySelector(".media-row__name")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const input = await until(() => row(solid.trackId)?.querySelector<HTMLInputElement>(".imged-layer__rename"), 1_000, () => "the rename field");
        input.value = "Autotest solid";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        await until(
          () => dev.layers()[0]!.name === "Autotest solid" && row(solid.trackId)?.querySelector(".media-row__name")?.textContent === "Autotest solid",
          1_000,
          () => `the rename to land (layer "${dev.layers()[0]!.name}", row "${row(solid.trackId)?.querySelector(".media-row__name")?.textContent ?? ""}")`,
        );

        // Select-tool drag: pointerdown on the canvas over the solid, moves and
        // the release on window (where the tool listens once a drag starts).
        assert(dev.tools.get().tool === "select", `precondition: the tool is ${dev.tools.get().tool}, not select`);
        const v = dev.view.store.get();
        const snap = settingsStore.get().snapCenterGuides ? (8 * v.dpr) / v.zoom : 0;
        assert(snap < 25, `precondition: at zoom ${v.zoom.toFixed(3)} the centre snap reaches ${snap.toFixed(1)} canvas px, over the 25 px drag`);
        // Anti-coincidence: (390,225) is outside the solid now and inside it
        // after the move; (280,160) the other way round.
        await stageShows(dev, 390, 225, GRID_BR, 2, "the photo's BR quadrant beside the solid");
        await stageShows(dev, 280, 160, SOLID_RGB, 2, "the solid before the move");
        spy = countPushes(dev.session);
        const t = dev.layers()[0]!.transform;
        const a = dev.view.canvasToClient(300, 168);
        const b = dev.view.canvasToClient(340, 193);
        const canvasEl = $<HTMLCanvasElement>("#imged-canvas")!;
        const mouse = { id: 61, kind: "mouse" as const };
        canvasEl.dispatchEvent(pointer("pointerdown", a.x, a.y, { ...mouse, buttons: 1, button: 0 }));
        for (const f of [1 / 3, 2 / 3, 1]) {
          window.dispatchEvent(pointer("pointermove", a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, { ...mouse, buttons: 1, button: -1 }));
        }
        window.dispatchEvent(pointer("pointerup", b.x, b.y, { ...mouse, buttons: 0, button: 0 }));
        const moved = dev.layers()[0]!.transform;
        assert(
          moved.x - t.x === 40 && moved.y - t.y === 25,
          `the drag moved the solid by (${moved.x - t.x}, ${moved.y - t.y}) canvas px, not exactly (40, 25)`,
        );
        assert(spy.n === 1, `the drag pushed ${spy.n} history entries, expected 1`);
        await stageShows(dev, 390, 225, SOLID_RGB, 2, "the moved solid");
        await stageShows(dev, 280, 160, GRID_TL, 2, "the photo where the solid was");

        // Row drag: press the solid's row, move below the photo's row, release.
        const sRow = row(solid.trackId)!;
        const pRow = row(photo.trackId)!;
        const sr = sRow.getBoundingClientRect();
        const pr = pRow.getBoundingClientRect();
        assert(sr.top < pr.top, "precondition: the solid's row is not above the photo's");
        const meta = sRow.querySelector<HTMLElement>(".media-row__meta")!;
        const x = sr.left + sr.width / 3;
        const rowPtr = { id: 62, kind: "mouse" as const };
        meta.dispatchEvent(pointer("pointerdown", x, sr.top + sr.height / 2, { ...rowPtr, buttons: 1, button: 0 }));
        window.dispatchEvent(pointer("pointermove", x, sr.top + sr.height / 2 + 8, { ...rowPtr, buttons: 1, button: -1 }));
        window.dispatchEvent(pointer("pointermove", x, pr.bottom + 4, { ...rowPtr, buttons: 1, button: -1 }));
        window.dispatchEvent(pointer("pointerup", x, pr.bottom + 4, { ...rowPtr, buttons: 0, button: 0 }));
        const order = dev.layers().map((l) => (l.trackId === solid.trackId ? "solid" : l.trackId === photo.trackId ? "photo" : l.kind));
        assert(order.join(",") === "photo,solid", `after the row drag the layers are [${order.join(", ")}] top first, expected [photo, solid]`);
        await stageShows(dev, 390, 225, GRID_BR, 2, "the photo painted over the solid after the reorder");
        return `solid 97x61 via Add layer → Solid color; eye hides/shows it on the stage; renamed "Autotest solid"; select drag (+40, +25) exact, 1 history entry; row drag → [photo, solid], the photo covers it — ${ms(t0)}`;
      } finally {
        spy?.restore();
        await leave(paths);
      }
    });

    await test("image-viewer-exits", async () => {
      // An image project opened from the viewer ("Open as project" on a still)
      // is the app's current session, wears the Temporary badge and its Keep
      // button, and Back asks Keep/Discard with Keep focused; Discard deletes the
      // scratch file and returns to the viewer on the same photo.
      const t0 = performance.now();
      let tempPath = "";
      const openWith = settingsStore.get().openWith;
      try {
        needFixtures();
        if (openWith !== "viewer") await updateSettings({ openWith: "viewer" });
        await ipc.debugPushOpenPath(fx("viewer\\IMG_7.JPG"));
        await until(
          () => $("#vw") && viewerDev() && baseName(viewerDev()!.path()) === "IMG_7.JPG" && $<HTMLImageElement>("#vw-img")?.naturalWidth === 200,
          5_000,
          () => `the viewer showing IMG_7.JPG (${onScreen()})`,
        );
        const prev = imageDev();
        const more = $<HTMLButtonElement>("#vw-more");
        assert(rendered(more), "the viewer's #vw-more is not rendered");
        more!.click();
        const open = await until(
          () => Array.from(document.querySelectorAll<HTMLButtonElement>(".ctx-menu .ctx-menu__item")).find((b) => b.textContent?.trim() === "Open as project" && rendered(b) && !b.disabled),
          2_000,
          () => "an enabled Open as project item in the viewer's menu",
        );
        open.click();
        const dev = await until(
          () => {
            const d = imageDev();
            return d && d !== prev && $(".imged") && $("#ed-save") ? d : null;
          },
          8_000,
          () => `the image editor after Open as project (${onScreen()})`,
        );
        tempPath = dev.session.path;
        imagePaths.add(norm(tempPath));
        assert(currentSession.get() === dev.session, "the image editor did not publish its session as the current one");
        assert(dev.session.temp.get() && (await isTempProjectPath(tempPath)), `Open as project made a non-temporary project: ${tempPath}`);
        assert(text("#ed-save") === "Temporary", `the badge reads "${text("#ed-save")}", not "Temporary"`);
        assert(rendered($("#ed-keep")), "#ed-keep is not rendered beside the Temporary badge");
        const back = $<HTMLButtonElement>("#ed-home")!;
        assert(back.title === "Back to viewer", `#ed-home is titled "${back.title}", not "Back to viewer"`);
        // Nothing was edited: Back asks nothing (the owner's hands-on report —
        // it used to ask "Keep temporary project?" about an untouched photo).
        assert(!dev.session.edited, "precondition: opening the photo as a project already marked it edited");
        back.click();
        await until(
          () => $("#vw") && !$(".imged") && viewerDev() && baseName(viewerDev()!.path()) === "IMG_7.JPG",
          5_000,
          () => `the viewer back on IMG_7.JPG (${onScreen()}; dialog ${$(".modal-backdrop") ? `"${text(".modal-backdrop .modal__header")}"` : "none"})`,
        );
        assert(currentSession.get() === null, "a session is still current after Back");
        await waitGone(tempPath, "Back left the untouched temporary image project on disk");
        assert(!$(".modal-backdrop"), `Back on an untouched temporary image project asked "${text(".modal-backdrop .modal__header")}"`);
        return `viewer → Open as project → image editor (current session, Temporary + Keep, "Back to viewer"); untouched, so Back → no question → viewer on IMG_7.JPG, scratch deleted — ${ms(t0)}`;
      } finally {
        await leave(tempPath ? [tempPath] : []);
        if (settingsStore.get().openWith !== openWith) await updateSettings({ openWith }).catch(() => {});
      }
    });

    await test("image-keep-close-flow", async () => {
      // An EDITED temporary image project makes the window close ask (Cancel →
      // "stayed", nothing destroyed); Keep on the badge then moves it into the
      // library as an image project (kind "image", no duration) and gives it a
      // rendered card picture within 2 s, which Home shows.
      const t0 = performance.now();
      const paths: string[] = [];
      let kept = "";
      let thumb = "";
      try {
        needFixtures();
        const flow = (window as unknown as { __tarotingCloseFlow?: CloseFlow }).__tarotingCloseFlow;
        assert(typeof flow === "function", "main.ts did not publish __tarotingCloseFlow");
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest image keep", info), "Autotest image keep", paths);
        await photoReady(dev);
        const s = dev.session;
        const tempPath = s.path;
        assert(!s.edited, "precondition: a freshly opened temporary image project is already marked edited");
        // A real edit: rename the project in the top bar.
        $<HTMLElement>("#ed-name")!.click();
        const nameIn = await until(() => $<HTMLInputElement>("#ed-name input"), 1_000, () => "the project-name field");
        nameIn.value = "Autotest image kept";
        nameIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        assert(s.project.name === "Autotest image kept" && s.edited, `the rename did not land as an edit (name "${s.project.name}", edited ${String(s.edited)})`);

        let destroyed = 0;
        const pc = flow!(async () => {
          destroyed++;
        });
        const c1 = await settleOrModal(pc, 4_000);
        assert("modal" in c1, `an EDITED temporary image project closed without asking (${"value" in c1 ? `returned ${c1.value}` : "no dialog in 4 s"})`);
        assert($('.modal-backdrop [data-act="discard"]') !== null, `the close dialog is not Keep/Discard: "${text(".modal-backdrop .modal__header")}"`);
        await answerDialog("cancel");
        const c2 = await settleOrModal(pc, 3_000);
        assert("value" in c2 && c2.value === "stayed", `Cancel did not keep the window (${"value" in c2 ? c2.value : "no answer in 3 s"})`);
        assert(destroyed === 0, `destroy ran ${destroyed} time(s) after Cancel`);
        assert(currentSession.get() === s && s.temp.get() && (await ipc.pathExists(tempPath)), "Cancel lost the temporary image project");

        const keep = $<HTMLButtonElement>("#ed-keep");
        assert(rendered(keep), "#ed-keep is not rendered");
        keep!.click();
        await until(() => !s.temp.get() && !$("#ed-keep"), 5_000, () => `Keep to finish (temp ${String(s.temp.get())}, path ${s.path})`);
        kept = s.path;
        imagePaths.add(norm(kept));
        assert(!(await isTempProjectPath(kept)), `after Keep the project still lives in the temp dir: ${kept}`);
        const lib = await ipc.newProjectPath("Autotest library probe");
        assert(norm(dirName(kept)) === norm(dirName(lib)), `the kept project is in ${dirName(kept)}, not the projects folder ${dirName(lib)}`);
        assert(await ipc.pathExists(kept), `the kept project is not on disk: ${kept}`);
        await waitGone(tempPath, "Keep left the temporary copy behind");
        // imgproj-<id>-<path hash>.jpg: keyed by path as well as id, so two
        // .trt files that share an id never share a card.
        const cardPrefix = `imgproj-${s.project.id}-`.toLowerCase();
        const isCard = (p: string): boolean => {
          const name = p.replace(/^.*[\\/]/, "").toLowerCase();
          return name.startsWith(cardPrefix) && name.endsWith(".jpg");
        };
        let item: { kind?: string; durationSec: number; thumb: string | null } | undefined;
        const tThumb = performance.now();
        for (;;) {
          item = (await ipc.listRecents()).items.find((i) => norm(i.path) === norm(kept));
          if (item?.thumb && isCard(item.thumb) && (await ipc.pathExists(item.thumb))) break;
          if (performance.now() - tThumb > 2_000) {
            throw new Error(`no card picture within 2 s: recents entry ${item ? `thumb ${String(item.thumb)}` : "missing"}, expected …\\${cardPrefix}<hash>.jpg on disk`);
          }
          await sleep(50);
        }
        thumb = item!.thumb!;
        const thumbMs = Math.round(performance.now() - tThumb);
        assert(item!.kind === "image", `the kept project's recents entry has kind ${String(item!.kind)}, not "image"`);
        assert(item!.durationSec === 0, `the kept image project's recents entry has durationSec ${item!.durationSec}, not 0`);

        $<HTMLButtonElement>("#ed-home")!.click();
        await until(
          () => {
            assert($(".modal-backdrop") === null, "Back after Keep still asked Keep or Discard");
            return $(".home") && !$(".editor");
          },
          5_000,
          () => `Home after Back (${onScreen()})`,
        );
        const cardEl = await until(() => $<HTMLElement>(`.project-card[data-path="${CSS.escape(kept)}"]`), 3_000, () => `the kept project's card on Home`);
        assert(cardEl.dataset.kind === "image", `the card's data-kind is ${String(cardEl.dataset.kind)}, not "image"`);
        const sub = (cardEl.querySelector(".project-card__sub")?.textContent ?? "").trim();
        assert(!/\d+:\d\d/.test(sub), `the image card shows a running time: "${sub}"`);
        const img = await until(
          () => {
            const i = cardEl.querySelector<HTMLImageElement>(".project-card__thumb img");
            return i && i.complete && i.naturalWidth > 0 ? i : null;
          },
          3_000,
          () => {
            const i = cardEl.querySelector<HTMLImageElement>(".project-card__thumb img");
            return `the card's <img> to load (${i ? `complete ${String(i.complete)}, naturalWidth ${i.naturalWidth}` : "no <img>"})`;
          },
        );
        return `edited temp + close → Keep/Discard → Cancel → "stayed", 0 destroyed; Keep → ${baseName(kept)} in the projects folder, recents kind image, durationSec 0, ${baseName(item.thumb ?? "")} in ${thumbMs} ms; Home card data-kind=image, "${sub}", <img> ${img.naturalWidth}x${img.naturalHeight} — ${ms(t0)}`;
      } finally {
        await leave(paths);
        if (kept) await ipc.deleteProject(kept).catch(() => {});
        if (thumb) await removeTestFile(thumb).catch(() => {});
      }
    });

    await test("image-home-cards", async () => {
      // Home never asks the backend to backfill a picture for an image project
      // (its card is rendered by the image editor, and the backfill command is
      // synchronous): a thumb-less VIDEO project proves the spy sees the
      // backfill, a thumb-less IMAGE project proves the kind is what skips it.
      // A card whose picture file is gone shows the placeholder, never a broken
      // <img>; one whose picture is there shows it. The New image dialog does
      // not overflow sideways.
      const t0 = performance.now();
      const made: string[] = [];
      const thumbs: string[] = [];
      try {
        const { renderThumbnail, thumbnailSize } = await import("../image/render/export");
        const { saveBlob } = await import("../image/save");
        const saveNew = async (name: string, p: ProjectFile): Promise<string> => {
          const path = await ipc.newProjectPath(name);
          await ipc.saveProject(path, p);
          made.push(path);
          return path;
        };
        const withCard = async (name: string, p: ProjectFile): Promise<{ path: string; thumb: string }> => {
          const path = await saveNew(name, p);
          imagePaths.add(norm(path));
          const saved = await saveBlob({ kind: "projectThumb", projectPath: path, projectId: p.id }, "jpeg", await renderThumbnail(p));
          thumbs.push(saved.path);
          return { path, thumb: saved.path };
        };
        // Sizes and colours differ, so no card can pass for another.
        const shown = await withCard("Autotest image card", createBlankImageProject("Autotest image card", 150, 100, "#c83c28"));
        const gone = await withCard("Autotest image card gone", createBlankImageProject("Autotest image card gone", 90, 130, "#28a0c8"));
        const bare = await saveNew("Autotest image card bare", createBlankImageProject("Autotest image card bare", 70, 50, "transparent"));
        imagePaths.add(norm(bare));
        const video = await saveNew("Autotest video card bare", createProject("Autotest video card bare"));

        const recents = (await ipc.listRecents()).items;
        const entry = (p: string) => recents.find((i) => norm(i.path) === norm(p));
        assert(entry(shown.path)?.thumb === shown.thumb && entry(gone.path)?.thumb === gone.thumb, "precondition: the rendered card pictures are not recorded in recents");
        assert(entry(bare)?.kind === "image" && !entry(bare)?.thumb, `precondition: the bare image project's entry is kind ${String(entry(bare)?.kind)}, thumb ${String(entry(bare)?.thumb)}`);
        assert(entry(video) !== undefined && !entry(video)!.thumb && entry(video)!.kind !== "image", "precondition: the bare video project is not a thumb-less video entry");
        // Gone BEFORE Home ever showed it: a URL an <img> already loaded in this
        // document would be served from memory without asking for the file.
        await removeTestFile(gone.thumb);
        assert(!(await ipc.pathExists(gone.thumb)), "the card picture could not be deleted");

        const n0 = backfilled.length;
        const old = $(".home");
        navigate({ view: "home" });
        await until(() => $(".home") && $(".home") !== old, 5_000, () => `a fresh Home (${onScreen()})`);
        const cardOf = (p: string): HTMLElement | null => $(`.project-card[data-path="${CSS.escape(p)}"]`);
        await until(() => cardOf(shown.path) && cardOf(gone.path) && cardOf(bare) && cardOf(video), 3_000, () => "all four cards on Home");
        for (const p of [shown.path, gone.path, bare]) {
          assert(cardOf(p)!.dataset.kind === "image", `${baseName(p)}: data-kind ${String(cardOf(p)!.dataset.kind)}, not "image"`);
        }
        const want = thumbnailSize(150, 100);
        const img = await until(
          () => {
            const i = cardOf(shown.path)!.querySelector<HTMLImageElement>(".project-card__thumb img");
            return i && i.complete && i.naturalWidth > 0 ? i : null;
          },
          3_000,
          () => {
            const i = cardOf(shown.path)?.querySelector<HTMLImageElement>(".project-card__thumb img");
            return `the rendered card picture to load (${i ? `complete ${String(i.complete)}, naturalWidth ${i.naturalWidth}` : "no <img>"})`;
          },
        );
        assert(
          img.naturalWidth === want.w && img.naturalHeight === want.h,
          `the card shows a ${img.naturalWidth}x${img.naturalHeight} picture, not the ${want.w}x${want.h} one the editor renders`,
        );
        const placeholder = (p: string): boolean => {
          const th = cardOf(p)?.querySelector(".project-card__thumb");
          return !!th && th.querySelector("img") === null && th.querySelector("svg") !== null;
        };
        await until(
          () => placeholder(gone.path),
          3_000,
          () => {
            const i = cardOf(gone.path)?.querySelector<HTMLImageElement>(".project-card__thumb img");
            return `the card with a missing picture to show the placeholder (${i ? `<img> complete ${String(i.complete)}, naturalWidth ${i.naturalWidth}` : "no <img>, no placeholder"})`;
          },
        );
        assert(placeholder(bare), "the image project with no picture shows no placeholder");
        await until(() => backfilled.length > n0 && backfilled.slice(n0).some((p) => norm(p) === norm(video)), 3_000, () => `Home to ask the backfill about the bare VIDEO project (asked: ${backfilled.slice(n0).map(baseName).join(", ") || "nothing"})`);
        await sleep(150); // past onThumbError's 100 ms retry, in case it asks again
        const leaked = backfilled.filter((p) => imagePaths.has(norm(p)));
        assert(leaked.length === 0, `refresh_recent_thumbs was asked about image project(s): ${leaked.map(baseName).join(", ")}`);

        // New project → Image project (the separate New image button is gone).
        assert($("#btn-new-image") === null, "#btn-new-image is still on Home");
        const newBtn = $<HTMLButtonElement>("#btn-new");
        assert(rendered(newBtn), "#btn-new is not rendered");
        newBtn!.click();
        const imageRow = await until(
          () => Array.from(document.querySelectorAll<HTMLButtonElement>(".ctx-menu__item")).find((b) => rendered(b) && b.textContent?.includes("Image project")) ?? null,
          2_000,
          () => "the New project menu's Image project row",
        );
        imageRow.click();
        const body = await until(() => $(".nimg-modal .modal__body"), 3_000, () => "the New image project dialog");
        assert(rendered(body), "the New image dialog's body is not rendered");
        const overflow = `${body.scrollWidth} > ${body.clientWidth}`;
        assert(body.scrollWidth <= body.clientWidth, `the New image dialog overflows sideways (scrollWidth ${overflow})`);
        const widths = `${body.scrollWidth}/${body.clientWidth}`;
        $<HTMLButtonElement>(".nimg-modal .modal__footer [data-act='cancel']")?.click();
        await until(() => !$(".nimg-modal"), 2_000, () => "the New image dialog to close");
        return `card with picture → <img> ${img.naturalWidth}x${img.naturalHeight}; picture deleted → placeholder; no picture → placeholder; backfill asked about the video card, never about any of ${imagePaths.size} image projects (${backfilled.length} paths asked all run); New image body ${widths} px — ${ms(t0)}`;
      } finally {
        closeMenu();
        $<HTMLButtonElement>(".nimg-modal [data-act='cancel']")?.click();
        for (const p of made) await ipc.deleteProject(p).catch(() => {});
        for (const p of thumbs) await removeTestFile(p).catch(() => {});
      }
    });

    await test("image-rescue-chrome", async () => {
      // The straddler theme from custom-theme-applies: its text is 1.43:1 on the
      // panel the editor's top bar is made of, so data-rescue-chrome fires — and
      // the IMAGE editor's Back button must then wear the --safe-* ink like the
      // video editor's does, or the user is stranded in an image project.
      const t0 = performance.now();
      const paths: string[] = [];
      const before = settingsStore.get();
      let restored = false;
      const restore = async (): Promise<void> => {
        if (restored) return;
        restored = true;
        await updateSettings({ theme: before.theme, customTheme: before.customTheme });
      };
      try {
        await updateSettings({ theme: "custom", customTheme: { background: "#241a3d", accent: "#ff5fa2", text: "#453274" } });
        const root = document.documentElement;
        assert(root.dataset.rescueChrome === "1", `fixture drifted: data-rescue-chrome is ${String(root.dataset.rescueChrome)} for the straddler theme`);
        await mountImage(createBlankImageProject("Autotest image rescue", 120, 90, "#ffffff"), "Autotest image rescue", paths);
        const back = $<HTMLButtonElement>("#ed-home");
        assert(rendered(back), "#ed-home is not rendered in the image editor");
        const hit = hitsItself(back!);
        assert(hit.ok, `#ed-home is covered by ${hit.hit}`);
        const probeEl = document.createElement("span");
        document.body.appendChild(probeEl);
        const tok = (n: string): string => getComputedStyle(root).getPropertyValue(n).trim();
        const asRgb = (c: string): string => {
          probeEl.style.color = "";
          probeEl.style.color = c;
          return getComputedStyle(probeEl).color;
        };
        let safe = "";
        let user = "";
        try {
          assert(tok("--safe-text-1") !== "" && tok("--text-1") !== "", "--safe-text-1 / --text-1 are not published on the root");
          safe = asRgb(tok("--safe-text-1"));
          user = asRgb(tok("--text-1"));
        } finally {
          probeEl.remove();
        }
        assert(safe !== user, `--safe-text-1 and --text-1 are both ${safe}: the fixture cannot tell rescued from not`);
        const got = getComputedStyle(back!).color;
        assert(got === safe, `the image editor's #ed-home is drawn in ${got}; under data-rescue-chrome it must use --safe-text-1 ${safe} (the user's --text-1 is ${user})`);
        await restore();
        const now = settingsStore.get();
        assert(
          now.theme === before.theme && JSON.stringify(now.customTheme) === JSON.stringify(before.customTheme),
          `the theme did not come back: ${now.theme} ${JSON.stringify(now.customTheme)} (was ${before.theme} ${JSON.stringify(before.customTheme)})`,
        );
        await until(() => root.dataset.rescueChrome === undefined || before.theme === "custom", 1_000, () => "data-rescue-chrome to clear after the restore");
        return `straddler theme: rescue-chrome on; the image editor's #ed-home drawn in --safe-text-1 ${safe}, not the user's ${user}; theme restored to ${now.theme} — ${ms(t0)}`;
      } finally {
        try {
          await restore();
        } catch {
          // A failed disk write must not mask the block's own result.
        }
        await leave(paths);
      }
    });

    await test("image-picker-holds-keys", async () => {
      // The ink colour picker holds the keyboard while it is up. Its square is
      // a div, not a typing field, so without its shortcuts token Delete took
      // the selected layer and the undo chord undid behind it — and Escape met
      // the shell's window-capture handler first, which put the pen down (and,
      // on a real key press, committed the PREVIEWED colour on the way out).
      // So: a previewed colour, then Delete and undo at the window and at the
      // focused square (nothing may move), then Escape at the square — the
      // picker goes, the pen stays in hand, and its colour is the one the
      // picker opened on.
      const t0 = performance.now();
      const paths: string[] = [];
      let pushes: { readonly n: number; restore(): void } | null = null;
      try {
        needFixtures();
        const info = await probe(fx(GRID));
        const dev = await mountImage(createPhotoImageProject("Autotest picker keys", info), "Autotest picker keys", paths);
        await photoReady(dev);
        // A drawing layer, selected, and one entry to undo: Delete and undo
        // both have something to take if either gets through.
        const { addDrawingLayer } = await import("../image/layers");
        let added = "";
        dev.session.commit((p) => {
          const r = addDrawingLayer(p, { above: null });
          added = r.trackId;
          return r.project;
        });
        dev.selection.set(added);
        assert(
          dev.layers().length === 2 && dev.session.history.canUndo,
          `precondition: ${dev.layers().length} layer(s), canUndo ${dev.session.history.canUndo}`,
        );

        const penBtn = $<HTMLButtonElement>('#imged-tools [data-tool="pen"]');
        assert(rendered(penBtn), 'the pen button [data-tool="pen"] is not rendered');
        penBtn!.click();
        const swatchBtn = await until(
          () => (dev.tools.get().tool === "pen" && rendered($(".imged-swatch-btn")) ? $<HTMLButtonElement>(".imged-swatch-btn") : null),
          1_000,
          () => `the pen's colour swatch (tool ${dev.tools.get().tool})`,
        );
        const opened = dev.tools.get().colors.pen;
        const inkBefore = JSON.stringify(settingsStore.get().inkColors ?? []);
        swatchBtn.click();
        const sv = await until(
          () => (rendered($(".cp")) && rendered($(".cp__sv")) ? $<HTMLElement>(".cp__sv") : null),
          2_000,
          () => `the colour picker (${onScreen()})`,
        );
        await until(() => document.activeElement === sv, 500, () => `focus on the picker's square (focus is on ${describeEl(document.activeElement)})`);

        // Preview a colour that shares no channel with the one it opened on,
        // so a commit on the way out could not pass for a cancel.
        const PREVIEW = opened.toLowerCase() === "#c83ea1" ? "#1fb05c" : "#c83ea1";
        const hex = $<HTMLInputElement>(".cp__hex")!;
        hex.value = PREVIEW;
        hex.dispatchEvent(new Event("input", { bubbles: true }));
        assert(dev.tools.get().colors.pen === PREVIEW, `the picker's preview did not reach the pen: ${dev.tools.get().colors.pen}, typed ${PREVIEW}`);
        sv.focus();

        const order = (): string => dev.layers().map((l) => l.trackId).join(",");
        const layersBefore = order();
        pushes = countPushes(dev.session);
        for (const target of [window, sv] as EventTarget[]) {
          const where = target === window ? "the window" : "the picker's square";
          for (const action of ["delete", "undo"] as const) {
            target.dispatchEvent(chordEvent(chordFor(action)));
            assert(
              order() === layersBefore && dev.selection.get() === added,
              `${chordFor(action)} at ${where} reached the editor behind the picker: layers [${dev.layers().map((l) => l.kind).join(", ")}], selection ${String(dev.selection.get())}`,
            );
            assert(
              pushes.n === 0 && !dev.session.history.canRedo,
              `${chordFor(action)} at ${where} changed the history behind the picker (${pushes.n} push(es), canRedo ${dev.session.history.canRedo})`,
            );
            assert(rendered($(".cp")), `${chordFor(action)} at ${where} closed the picker`);
          }
        }

        const esc = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
        sv.dispatchEvent(esc);
        await frames(1);
        assert(!$(".cp"), `Escape left the picker on screen (${onScreen()})`);
        assert(dev.tools.get().tool === "pen", `Escape in the picker put the pen down: the tool is ${dev.tools.get().tool}`);
        assert(
          penBtn!.getAttribute("aria-pressed") === "true",
          `the pen button reads aria-pressed=${String(penBtn!.getAttribute("aria-pressed"))} after Escape`,
        );
        assert(
          dev.tools.get().colors.pen === opened,
          `Escape kept ${dev.tools.get().colors.pen}; the pen must go back to ${opened}, the colour the picker opened on`,
        );
        assert(
          JSON.stringify(settingsStore.get().inkColors ?? []) === inkBefore,
          `Escape added to the recent ink colors: ${JSON.stringify(settingsStore.get().inkColors)}`,
        );
        assert(pushes.n === 0 && dev.layers().length === 2, `the picker round trip changed the project (${pushes.n} push(es), ${dev.layers().length} layer(s))`);
        return `pen picker previewing ${PREVIEW}: Delete + ${chordFor("undo")} at the window and the square → nothing moved (2 layers, 0 pushes); Escape → picker gone, pen still in hand at ${opened}, no recent color added — ${ms(t0)}`;
      } finally {
        pushes?.restore();
        await leave(paths);
      }
    });

    await test("relink-closes-on-leave", async () => {
      // The relink dialog is parked on document.body, so it outlives the
      // editor unless the editor's teardown closes it: left behind it sat over
      // the next screen and relinked into a project nobody saves. A saved
      // (non-temporary) project has no leave gate, so both exits go straight
      // through: an Explorer open (a .trt pushed the way the OS forwards one)
      // from the VIDEO editor, then Home from the IMAGE editor. Each project's
      // one media file is missing, and each dialog is told apart by its row's
      // media id. The teardown's close is quiet: no "still missing" toast.
      const t0 = performance.now();
      const made: string[] = [];
      try {
        needFixtures();
        const dir = await scratchDir();
        const info = await probe(fx(GRID));
        const gonePath = `${dir}\\autotest-relink-missing.png`;
        assert(!(await ipc.pathExists(gonePath)), `fixture drifted: ${gonePath} exists`);
        const missingInfo: MediaInfo = { ...info, path: gonePath };

        const video = importMediaAsClip(createProject("Autotest relink video"), missingInfo);
        const videoPath = await ipc.newProjectPath("Autotest relink video");
        made.push(videoPath);
        await ipc.saveProject(videoPath, video.project);
        const image = createPhotoImageProject("Autotest relink image", missingInfo);
        const imageMedia = image.media.find((m) => !m.generator)!.id;
        const imagePath = await ipc.newProjectPath("Autotest relink image");
        made.push(imagePath);
        imagePaths.add(norm(imagePath));
        await ipc.saveProject(imagePath, image);

        const stillMissing = (): string[] =>
          Array.from(document.querySelectorAll<HTMLElement>(".toast"))
            .map((t) => (t.textContent ?? "").trim())
            .filter((t) => /still missing/i.test(t));
        const dialogFor = (mediaId: string): HTMLElement | null =>
          document.querySelector<HTMLElement>(`.relink-modal [data-row="${mediaId}"]`)?.closest<HTMLElement>(".relink-modal") ?? null;
        const backdrops = (): number => document.querySelectorAll(".modal-backdrop").length;

        navigate({ view: "editor", projectPath: videoPath });
        const videoDlg = await until(
          () => ($(".editor:not(.imged)") && rendered(dialogFor(video.mediaId)) ? dialogFor(video.mediaId) : null),
          8_000,
          () => `the video editor's relink dialog for its missing media (${onScreen()})`,
        );
        assert(backdrops() === 1, `${backdrops()} dialog backdrops over the video editor, expected the relink one alone`);

        // An Explorer open of the image project while the video's dialog is up.
        const prev = imageDev();
        await ipc.debugPushOpenPath(imagePath);
        await until(
          () => {
            const d = imageDev();
            // The image shell reuses the editor classes (`editor imged`), so "the
            // video editor is gone" is `.editor:not(.imged)`, never bare `.editor`.
            return d && d !== prev && $(".imged") && !$(".editor:not(.imged)") ? d : null;
          },
          8_000,
          () => `the image editor after an Explorer open of its .trt (${onScreen()})`,
        );
        assert(!videoDlg.isConnected, "the video editor's relink dialog is still on the page after the editor closed");
        const imageDlg = await until(
          () => (rendered(dialogFor(imageMedia)) ? dialogFor(imageMedia) : null),
          3_000,
          () => `the image editor's relink dialog for its missing photo (${onScreen()})`,
        );
        assert(dialogFor(video.mediaId) === null, "a relink dialog for the video project's media is still up over the image editor");
        assert(backdrops() === 1, `${backdrops()} dialog backdrops over the image editor, expected its relink one alone`);

        navigate({ view: "home" });
        await until(() => $(".home") && !$(".imged"), 5_000, () => `Home (${onScreen()})`);
        assert(!imageDlg.isConnected && $(".relink-modal") === null, "the image editor's relink dialog is still up over Home");
        assert(backdrops() === 0, `${backdrops()} dialog backdrop(s) left over Home`);
        const toasts = stillMissing();
        assert(toasts.length === 0, `leaving raised the dialog's own toast: "${toasts.join(" | ")}"`);
        return `video (Explorer open away) and image (Home) relink dialogs both closed with their editors, 0 backdrops left, no "still missing" toast — ${ms(t0)}`;
      } finally {
        await leave(made);
      }
    });
  } finally {
    ipc.refreshRecentThumbs = realRefresh;
  }
}
