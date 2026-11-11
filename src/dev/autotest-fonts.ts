// 0.9.4 E2E blocks: the font library. DEV-only: imported lazily by
// autotest.ts, never part of a release bundle.
//
// NOTHING under src/fonts, src/editor, src/image or src/pdf is imported
// statically here: each block reaches the runtime module it drives with
// `await import(...)` (type-only imports are erased), so loading this file
// loads no lazy chunk as a side effect.
//
// The library font is a stock Windows file, C:\Windows\Fonts\consola.ttf
// (Consolas Regular), imported through the runtime as `lib:Consolas`; no font
// file is committed. Consolas is monospaced, so a run of "i" is more than
// twice as wide in it as in Segoe UI: every "drawn in the library font" check
// below is a WIDTH RATIO of the same string drawn both ways (DOM text, stage
// pixels, decoded video frames), never a style string alone.
//
// Under the harness the app's data folders live in %TEMP%\taroting-autotest
// and are wiped per run, so the library starts empty and the owner's library
// is never touched. Block 1 imports and removes on its own; blocks 2-6 share
// ONE import (`ensureLib`), removed after the last of them in a finally.
//
// Every block ends on Home with every file it wrote deleted. Waits poll at
// 20 ms with their own short deadline and a message naming what they waited
// for and what was there instead.

import { invoke } from "@tauri-apps/api/core";
import { errorDetail, ipc, mediaUrl } from "../core/ipc";
import { createBlankImageProject } from "../core/image-project";
import { navigate } from "../core/nav";
import { createProject, uid, updateMedia } from "../core/project";
import { currentSession, type ProjectSession } from "../core/session";
import type { Clip, FontId, Generator, MediaRef, PdfAnnot, ProjectFile, Track } from "../core/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { DevHook } from "./autotest";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type FontsCtx = Wave1Ctx;

const removeTestFile = (path: string): Promise<void> => invoke<void>("debug_remove_test_file", { path });

const FONT_FILE = "C:\\Windows\\Fonts\\consola.ttf";
const LIB_ID: FontId = "lib:Consolas";
const MISSING_ID: FontId = "lib:NoSuchFontXyz";
/** Twelve "i": ~6.6 em in Consolas, ~2.9 em in Segoe UI. */
const IIS = "iiiiiiiiiiii";
/** A Consolas rendering of IIS must be at least this much wider than Segoe UI's. */
const MIN_RATIO = 1.4;

type TextGen = Extract<Generator, { type: "text" }>;

/** What the image editor publishes on window while mounted (image-editor.ts, DEV). */
interface ImageDev {
  session: ProjectSession;
  view: {
    store: { get(): { zoom: number; panX: number; panY: number } };
    actual(): void;
  };
  canvas: HTMLCanvasElement;
  renderNow(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pageRaf = window.requestAnimationFrame.bind(window);
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => pageRaf(() => r()));
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

/** A promise with a deadline whose message says what it was waiting for. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E | null => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E[] => Array.from(root.querySelectorAll<E>(sel));
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;
const f1 = (n: number): string => n.toFixed(1);

function rendered(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}

function hitsItself(el: HTMLElement): { ok: boolean; hit: string } {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: hit === el || (hit !== null && el.contains(hit)), hit: describeEl(hit) };
}

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

/** The laid-out width of an element's text (a Range over its contents). */
function textWidth(el: Element): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect().width;
}

/** The faces registered in document.fonts under `family`, with their status. */
function facesNamed(family: string): string[] {
  const out: string[] = [];
  document.fonts.forEach((f) => {
    if (f.family.replace(/^["']|["']$/g, "") === family) out.push(`${f.weight}/${f.style}:${f.status}`);
  });
  return out;
}

/* ---------------- pixels ---------------- */

interface Luma {
  w: number;
  h: number;
  /** 0..255 per pixel, row-major */
  y: Uint8ClampedArray;
}

function lumaOf(data: Uint8ClampedArray, w: number, h: number): Luma {
  const y = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) y[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  return { w, h, y };
}

/** Ink of `l` inside rows [y0, y1): pixels on the ink side of `cut`
 *  (`dark` ink on a light ground, or the other way), their count and box. */
function inkIn(l: Luma, y0: number, y1: number, cut: number, dark: boolean): { n: number; left: number; right: number; top: number; bottom: number; w: number } {
  let n = 0;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let y = Math.max(0, y0); y < Math.min(l.h, y1); y++) {
    for (let x = 0; x < l.w; x++) {
      const v = l.y[y * l.w + x]!;
      if (dark ? v < cut : v > cut) {
        n++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { n, left, right, top, bottom, w: n > 0 ? right - left + 1 : 0 };
}

const boxStr = (b: { n: number; left: number; right: number; top: number; bottom: number }): string =>
  b.n > 0 ? `${b.n} px in x ${b.left}..${b.right} y ${b.top}..${b.bottom}` : "no ink";

/** Pixels where two equal-sized lumas differ by more than `by`. */
function diffCount(a: Luma, b: Luma, by: number): number {
  let n = 0;
  for (let i = 0; i < a.y.length; i++) if (Math.abs(a.y[i]! - b.y[i]!) > by) n++;
  return n;
}

/** Frames of a video file at `times` (s), decoded by the webview the way the
 *  preview decodes (crossOrigin anonymous over the asset protocol). */
async function videoFrames(path: string, times: number[]): Promise<Luma[]> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  const once = (ev: string, ms: number, what: string): Promise<void> =>
    within(
      new Promise<void>((resolve, reject) => {
        const ok = (): void => {
          v.removeEventListener("error", bad);
          resolve();
        };
        const bad = (): void => {
          v.removeEventListener(ev, ok);
          reject(new Error(`${what}: the webview refused ${baseName(path)} (MediaError ${v.error?.code ?? "?"} ${v.error?.message ?? ""})`));
        };
        v.addEventListener(ev, ok, { once: true });
        v.addEventListener("error", bad, { once: true });
      }),
      ms,
      what,
    );
  try {
    const loaded = once("loadeddata", 5_000, `${baseName(path)} to load in a <video>`);
    v.src = mediaUrl(path);
    await loaded;
    const w = v.videoWidth;
    const h = v.videoHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    const out: Luma[] = [];
    for (const t of times) {
      const seeked = once("seeked", 3_000, `${baseName(path)} to seek to ${t} s`);
      v.currentTime = t;
      await seeked;
      g.drawImage(v, 0, 0, w, h);
      out.push(lumaOf(g.getImageData(0, 0, w, h).data, w, h));
    }
    c.width = 0;
    return out;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/* ---------------- video export ---------------- */

/** Start an export and wait for ITS outcome (a copy of autotest.ts's private
 *  runExportJob: listener first, events buffered until the id is known). */
async function runExportJob(
  spec: import("../editor/export/export-ipc").ExportSpec,
  capMs: number,
): Promise<{ ok: true; path: string } | { ok: false; detail: string }> {
  const { startExport } = await import("../editor/export/export-ipc");
  const { onJobEvents } = await import("../core/ipc");
  type Outcome = { ok: true; path: string } | { ok: false; detail: string };
  const seen = new Map<number, Outcome>();
  let wanted: number | null = null;
  let settle: (o: Outcome) => void = () => {};
  const outcome = new Promise<Outcome>((r) => (settle = r));
  const note = (id: number, o: Outcome): void => {
    if (wanted === null) seen.set(id, o);
    else if (id === wanted) settle(o);
  };
  const un = await onJobEvents({
    onDone: (e) => note(e.id, { ok: true, path: String(e.output.path ?? spec.outPath) }),
    onFailed: (e) => note(e.id, { ok: false, detail: `${e.message} | ${e.logTail.slice(-3).join(" / ")}` }),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const id = await startExport(spec);
    wanted = id;
    const early = seen.get(id);
    if (early) return early;
    return await Promise.race([
      outcome,
      new Promise<Outcome>((r) => {
        timer = setTimeout(() => r({ ok: false, detail: `export timed out after ${capMs / 1000}s` }), capMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    un();
  }
}

/** A text generator: IIS at 48 px, white, plain. */
const textGen = (color: string, fontId?: FontId): TextGen => ({
  type: "text",
  text: IIS,
  fontFamily: "Segoe UI",
  ...(fontId !== undefined ? { fontId } : {}),
  sizePx: 48,
  color,
  bold: false,
  italic: false,
});

/** A generated text MediaRef with a fixed 400x60 box (the same box for every
 *  font, so the font is the only thing that differs between two of them). */
const textMedia = (g: TextGen): MediaRef => ({
  id: uid(),
  path: "Text",
  size: 0,
  mtimeMs: 0,
  kind: "image",
  duration: 0,
  hasAudio: false,
  width: 400,
  height: 60,
  generator: g,
});

const clipOf = (m: MediaRef, start: number, dur: number, y: number): Clip => ({
  id: uid(),
  mediaId: m.id,
  timelineStart: start,
  srcIn: 0,
  srcOut: dur,
  speed: 1,
  transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y, opacity: 1 },
  audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
});

const videoTrack = (clips: Clip[]): Track => ({ id: uid(), kind: "video", name: "Video", muted: false, clips });

/** A 640x360 video project holding `media` with `tracks` (tracks[0] topmost). */
function videoProject(name: string, media: MediaRef[], tracks: Track[]): ProjectFile {
  const p = createProject(name);
  return { ...p, media, timeline: { ...p.timeline, width: 640, height: 360, tracks } };
}

/* ================================================================== */

export async function runFontBlocks(ctx: FontsCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;

  /** Scratch output: the autotest root, never the repo or the owner's folders. */
  let outDir = "";
  const scratchDir = async (): Promise<string> => {
    if (outDir) return outDir;
    const dir = dirName((await ipc.tempProjectsDir()).replace(/[\\/]+$/, ""));
    assert(/taroting-autotest/i.test(dir), `the scratch folder ${dir} is not inside the autotest root — refusing to write test output there`);
    outDir = dir;
    return dir;
  };

  /** Close dialogs, discard a temp session, park on Home, delete `paths`
   *  (projects). Never throws. */
  const backHome = async (paths: readonly string[] = []): Promise<void> => {
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
      console.error("fonts autotest: cleanup did not finish", e);
    }
    for (const p of paths) if (p) await ipc.deleteProject(p).catch(() => {});
  };

  const fonts = (): Promise<typeof import("../fonts")> => import("../fonts");

  /** Import consola.ttf as `lib:Consolas` unless the library has it already. */
  const importConsolas = async (): Promise<string> => {
    const rt = await fonts();
    const cat = await within(rt.fontCatalog(), 5_000, "the font catalogue (fonts_list)");
    if (cat.library.some((f) => f.id === LIB_ID)) return "already in the library";
    const t = performance.now();
    const res = await within(rt.importFonts([FONT_FILE]), 5_000, `importFonts(${FONT_FILE})`);
    const r = res[0];
    assert(res.length === 1 && r !== undefined, `importFonts answered ${res.length} results for one file`);
    assert(r!.ok || r!.error === "exists", `importing ${FONT_FILE} failed: ${JSON.stringify(r)}`);
    assert(!r!.ok || r!.id === LIB_ID, `consola.ttf imported as ${String(r!.id)} (family "${String(r!.family)}", style "${String(r!.style)}"), not ${LIB_ID}`);
    return `imported in ${ms(t)}`;
  };

  /** Remove `lib:Consolas` from the library if it is there. Never throws. */
  const removeConsolas = async (): Promise<void> => {
    try {
      const rt = await fonts();
      const cat = await rt.fontCatalog();
      if (cat.library.some((f) => f.id === LIB_ID)) await rt.removeFont(LIB_ID);
    } catch (e) {
      console.error("fonts autotest: could not remove lib:Consolas", e);
    }
  };

  /** The runtime has `lib:Consolas` loaded: its alias, with a loaded face. */
  let libReady: Promise<string> | null = null;
  const ensureLib = (): Promise<string> => {
    libReady ??= (async () => {
      await importConsolas();
      const rt = await fonts();
      await rt.ensureFonts([{ id: LIB_ID, bold: false, italic: false }]);
      const f = rt.fontFace("Segoe UI", LIB_ID, false, false);
      assert(!f.missing && f.family.startsWith("tfont-"), `after import + ensureFonts, fontFace answers ${JSON.stringify(f)} for ${LIB_ID}`);
      return f.family;
    })();
    // A failed setup is retried by the next block rather than cached.
    libReady.catch(() => {
      libReady = null;
    });
    return libReady;
  };

  /** Save `project` as a temp .trt and open it in the video editor. */
  const mountVideo = async (project: ProjectFile, name: string, paths: string[]): Promise<DevHook> => {
    const path = await ipc.tempProjectPath(name);
    paths.push(path);
    await ipc.saveProject(path, project);
    const hook = (): DevHook | undefined => (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev;
    const prev = hook();
    navigate({ view: "editor", projectPath: path, temp: true });
    return until(
      () => {
        const d = hook();
        return d && d !== prev && $(".editor:not(.imged)") && $(".preview__canvas") ? d : null;
      },
      8_000,
      () => `the video editor on "${name}" — on screen: ${onScreen()}`,
    );
  };

  /** The stage's generated-text element whose computed colour is `rgb`. */
  const stageText = (rgb: string): HTMLElement | null =>
    $$(".preview__canvas .stage-layer__gen").find((el) => rendered(el) && el.textContent === IIS && getComputedStyle(el).color === rgb) ?? null;
  const stageTexts = (): string =>
    $$(".preview__canvas .stage-layer__gen")
      .map((el) => `"${(el.textContent ?? "").slice(0, 16)}" ${getComputedStyle(el).color} ${rendered(el) ? "shown" : "hidden"}`)
      .join("; ") || "none";
  const WHITE = "rgb(255, 255, 255)";
  const NEAR_WHITE = "rgb(254, 254, 254)";

  /* ================================================================ */
  /* 1. import, list, load, Settings, remove                          */
  /* ================================================================ */

  await test("fonts-import-list-remove", async () => {
    const t0 = performance.now();
    const violations: string[] = [];
    const onViolation = (e: SecurityPolicyViolationEvent): void => {
      violations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`);
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const removeDialog = (): HTMLElement | null => $('.modal[aria-label="Remove Consolas?"]');
    try {
      assert(await ipc.pathExists(FONT_FILE), `${FONT_FILE} is not on this PC — the font blocks need a stock Windows font file`);
      const rt = await fonts();
      const before = await within(rt.fontCatalog(), 5_000, "the font catalogue (fonts_list)");
      assert(!before.library.some((f) => f.id === LIB_ID), `the library already holds ${LIB_ID} before the import (it is wiped per run): ${before.library.map((f) => f.id).join(", ")}`);
      const how = await importConsolas();

      // The catalogue lists it, with a Regular face.
      const cat = await within(rt.fontCatalog(), 3_000, "the catalogue after the import");
      const fam = cat.library.find((f) => f.id === LIB_ID);
      assert(fam !== undefined, `after the import the library lists ${cat.library.map((f) => `${f.id} (${f.name})`).join(", ") || "nothing"}, not ${LIB_ID}`);
      assert(fam!.source === "library" && fam!.name === "Consolas", `${LIB_ID} is listed as ${JSON.stringify({ name: fam!.name, source: fam!.source })}`);
      const regular = fam!.faces.find((f) => !f.bold && !f.italic);
      assert(regular !== undefined, `${LIB_ID} has no Regular face: ${JSON.stringify(fam!.faces)}`);

      // Loaded from its asset URL under the app's CSP: a FontFace under the
      // alias reached "loaded", and canvas draws IIS far wider with it.
      await within(rt.ensureFonts([{ id: LIB_ID, bold: false, italic: false }]), 6_000, `ensureFonts(${LIB_ID})`);
      const face = rt.fontFace("Segoe UI", LIB_ID, false, false);
      assert(!face.missing && face.family.startsWith("tfont-"), `fontFace answers ${JSON.stringify(face)}, not a tfont- alias`);
      const alias = face.family;
      const faces = facesNamed(alias);
      assert(faces.some((f) => f.endsWith(":loaded")), `no FontFace under ${alias} reached "loaded" (${faces.join(", ") || "none registered"}); CSP violations: ${violations.join("; ") || "none"}`);
      assert(document.fonts.check(`40px ${alias}`), `document.fonts.check("40px ${alias}") is false`);
      const c = document.createElement("canvas").getContext("2d")!;
      c.font = `40px ${alias}, "Segoe UI"`;
      const wLib = c.measureText(IIS).width;
      c.font = `40px "Segoe UI"`;
      const wSegoe = c.measureText(IIS).width;
      assert(wLib / wSegoe > MIN_RATIO, `canvas measures "${IIS}" ${f1(wLib)} px in ${alias} vs ${f1(wSegoe)} px in Segoe UI — the loaded face is not Consolas`);
      const fontViolations = violations.filter((v) => /font/i.test(v));
      assert(fontViolations.length === 0, `CSP blocked a font: ${fontViolations.join("; ")}`);

      // Settings > Fonts: ONE row with the count and a View button (no
      // per-font rows there any more), painted and on top. The card re-renders
      // itself (catalogue landing, import, removal), so every lookup re-queries.
      navigate({ view: "settings" });
      const countText = (): string => ($("#settings-fonts-count")?.textContent ?? "").replace(/\s+/g, " ").trim();
      await until(() => countText().startsWith("1 imported font.") || null, 4_000, () => `Settings > Fonts to say "1 imported font." (it says "${countText() || "nothing"}"; on screen: ${onScreen()})`);
      const settingsCount = countText();
      assert($$("#settings-fonts [data-font-remove]").length === 0, "Settings > Fonts still lists a per-font Remove button");
      const viewBtn = await until(
        () => {
          const b = $<HTMLButtonElement>("#settings-fonts-view");
          return rendered(b) ? b : null;
        },
        2_000,
        () => "a rendered View button in Settings > Fonts",
      );
      viewBtn.scrollIntoView({ block: "center" });
      await frames(2);
      const viewHit = hitsItself(viewBtn);
      assert(viewHit.ok, `the View button's centre paints ${viewHit.hit}`);

      // View → the Fonts page, rendered (not just present), Settings gone.
      viewBtn.click();
      await until(
        () => (rendered($(".fontlib")) && rendered($("#fontlib-list")) && !$("#settings-inner")) || null,
        4_000,
        () => `the Fonts page after View (on screen: ${onScreen()}; .fontlib ${$(".fontlib") ? "present" : "absent"})`,
      );
      const pageText = (): string => ($("#fontlib-list")?.textContent ?? "no #fontlib-list").replace(/\s+/g, " ").trim().slice(0, 160);
      // Every lookup re-queries: the list re-renders (catalogue, search, removal).
      const rowOf = (): HTMLElement | null => $$("#fontlib-list [data-font]").find((r) => r.getAttribute("data-font") === LIB_ID) ?? null;
      const removeBtn = (): HTMLButtonElement | null =>
        [...(rowOf()?.querySelectorAll<HTMLButtonElement>("[data-font-remove]") ?? [])].find((b) => b.getAttribute("data-font-remove") === LIB_ID) ?? null;
      await until(() => (rendered(rowOf()) ? rowOf() : null), 4_000, () => `a rendered "Consolas" row on the Fonts page (list: "${pageText()}")`);
      const rowName = (rowOf()!.querySelector(".fontlib__name")?.textContent ?? "").trim();
      assert(rowName === "Consolas", `the row for ${LIB_ID} is named "${rowName}"`);
      assert(rendered(removeBtn()), `the Consolas row has no rendered Remove button with data-font-remove="${LIB_ID}" (list: "${pageText()}")`);
      const hit = hitsItself(removeBtn()!);
      assert(hit.ok, `the Consolas row's Remove button centre paints ${hit.hit}`);
      const meta = (rowOf()!.querySelector(".fontlib__meta")?.textContent ?? "").trim();

      // Its sample is drawn in the library font once the row's face is in
      // (loaded when the row nears the viewport): its computed font-family
      // names the alias, and the pangram is clearly wider than in Segoe UI.
      const sample = (): HTMLElement | null => rowOf()?.querySelector<HTMLElement>("[data-sample]") ?? null;
      await until(
        () => getComputedStyle(sample() ?? document.body).fontFamily.startsWith(alias) || null,
        4_000,
        () => `the Consolas row's sample to use ${alias} (its font-family: ${sample() ? getComputedStyle(sample()!).fontFamily : "no sample"})`,
      );
      const sampleEl = sample()!;
      c.font = `${getComputedStyle(sampleEl).fontSize} "Segoe UI"`;
      const wSampleSegoe = c.measureText(sampleEl.textContent ?? "").width;
      const wSample = await until(
        () => {
          const w = textWidth(sampleEl);
          return w / wSampleSegoe > 1.15 ? w : null;
        },
        2_000,
        () => `the sample to draw in Consolas: ${f1(textWidth(sampleEl))} px wide vs ${f1(wSampleSegoe)} px in Segoe UI`,
      );

      // Search: a name that matches nothing hides the row and says so;
      // clearing brings it back.
      const search = $<HTMLInputElement>("#fontlib-search");
      assert(rendered(search), "the Fonts page has no rendered search field");
      const setSearch = (v: string): void => {
        search!.value = v;
        search!.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const NO_MATCH = "zzqq-no-such-font";
      setSearch(NO_MATCH);
      await frames(1);
      assert(!rendered(rowOf()), `searching "${NO_MATCH}" still shows the Consolas row`);
      const noMatch = $(".fontlib__empty");
      assert(
        rendered(noMatch) && (noMatch!.textContent ?? "").includes(`No fonts match "${NO_MATCH}"`),
        `searching "${NO_MATCH}" shows "${(noMatch?.textContent ?? "nothing").trim()}", not the no-match line`,
      );
      setSearch("");
      await frames(1);
      assert(rendered(rowOf()), "clearing the search did not bring the Consolas row back");

      // Remove → Escape: nothing removed, focus back on Remove.
      removeBtn()!.click();
      const dlg = await until(removeDialog, 2_000, () => `the "Remove Consolas?" confirm (dialogs: ${$$(".modal").map((m) => m.getAttribute("aria-label")).join(", ") || "none"})`);
      const cancel = dlg.querySelector<HTMLButtonElement>("[data-cancel]");
      assert(document.activeElement === cancel, `the Remove confirm opened with focus on ${describeEl(document.activeElement)}, not Cancel`);
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await until(() => !removeDialog() || null, 2_000, () => "Escape to close the Remove confirm");
      await frames(1);
      assert(rendered($(".fontlib")), `Escape in the Remove confirm left the Fonts page (on screen: ${onScreen()})`);
      assert(rendered(rowOf()), "Escape in the Remove confirm removed the Consolas row");
      assert(document.activeElement === removeBtn(), `after Escape focus is on ${describeEl(document.activeElement)}, not Consolas's Remove button`);
      assert((await rt.fontCatalog()).library.some((f) => f.id === LIB_ID), "Escape in the Remove confirm removed the font from the library");

      // Remove → Remove: the row goes, the empty state shows, the catalogue
      // drops it, the faces leave document.fonts.
      removeBtn()!.click();
      const dlg2 = await until(removeDialog, 2_000, () => "the Remove confirm, reopened");
      dlg2.querySelector<HTMLButtonElement>("[data-confirm]")!.click();
      await until(() => !rowOf() || null, 4_000, () => `the Consolas row to leave the Fonts page (list: "${pageText()}")`);
      const empty = await until(
        () => {
          const e = $(".fontlib__empty");
          return rendered(e) && (e.textContent ?? "").includes("No fonts imported yet.") ? e : null;
        },
        2_000,
        () => `the "No fonts imported yet." empty state (list: "${pageText()}")`,
      );
      assert(rendered(empty.querySelector("#fontlib-empty-import")), "the empty state has no rendered Import fonts button");
      const after = await rt.fontCatalog();
      assert(!after.library.some((f) => f.id === LIB_ID), `the catalogue still lists ${LIB_ID} after Remove`);
      const left = facesNamed(alias);
      assert(left.length === 0, `after Remove document.fonts still holds ${alias}: ${left.join(", ")}`);
      const focusAfter = describeEl(document.activeElement);

      // Back → Settings, which now says the library is empty.
      $<HTMLButtonElement>("#fontlib-back")!.click();
      await until(
        () => (!$(".fontlib") && countText().startsWith("No fonts imported yet.")) || null,
        4_000,
        () => `Settings saying "No fonts imported yet." after Back (on screen: ${onScreen()}; count: "${countText() || "none"}")`,
      );
      return `consola.ttf ${how} → library ${LIB_ID} "${fam!.name}" faces ${fam!.faces.map((f) => f.style).join("/")}; alias ${alias} ${faces.join(", ")}, canvas "${IIS}" ${f1(wLib)} vs Segoe ${f1(wSegoe)} px, no CSP violation; Settings "${settingsCount.slice(0, 16)}", View on top → Fonts page; row "Consolas" (${meta || "no meta"}) painted, Remove on top, sample in ${alias} ${f1(wSample)} vs Segoe ${f1(wSampleSegoe)} px; no-match search hides it, clearing restores it; Escape → kept, focus on Remove; Remove → row gone, empty state, catalogue and document.fonts clean, focus on ${focusAfter}; Back → Settings "No fonts imported yet." — ${ms(t0)}`;
    } finally {
      document.removeEventListener("securitypolicyviolation", onViolation);
      removeDialog()?.querySelector<HTMLButtonElement>("[data-cancel]")?.click();
      await removeConsolas();
      libReady = null;
      await backHome();
    }
  });

  /* ================================================================ */
  /* 2-6 share one import of lib:Consolas, removed after the last.    */
  /* ================================================================ */

  try {
    await test("fonts-video-text-export", async () => {
      const t0 = performance.now();
      const paths: string[] = [];
      const outs: string[] = [];
      try {
        const alias = await ensureLib();
        // Preview: the library text above, the same text in Segoe UI below.
        const lib = textMedia(textGen("#ffffff", LIB_ID));
        const plain = textMedia(textGen("#fefefe"));
        const project = videoProject("Autotest fonts video", [lib, plain], [
          videoTrack([clipOf(lib, 0, 2, -80)]),
          videoTrack([clipOf(plain, 0, 2, 80)]),
        ]);
        const dev = await mountVideo(project, "Autotest fonts video", paths);
        dev.engine.seek(0.5);
        dev.engine.refresh();
        const elLib = await until(() => stageText(WHITE), 3_000, () => `the library text on the stage (gen layers: ${stageTexts()})`);
        const elPlain = await until(() => stageText(NEAR_WHITE), 3_000, () => `the Segoe UI text on the stage (gen layers: ${stageTexts()})`);
        const famLib = getComputedStyle(elLib).fontFamily;
        const famPlain = getComputedStyle(elPlain).fontFamily;
        assert(famLib.startsWith(alias), `the stage's library text has font-family ${famLib}, not one starting with ${alias}`);
        assert(!famPlain.includes("tfont-"), `the stage's Segoe UI text has font-family ${famPlain}`);
        const ratio = await until(
          () => {
            const r = textWidth(elLib) / textWidth(elPlain);
            return r > MIN_RATIO ? r : null;
          },
          3_000,
          () => `the stage's library text to draw in Consolas: "${IIS}" is ${f1(textWidth(elLib))} px vs ${f1(textWidth(elPlain))} px in Segoe UI (faces ${facesNamed(alias).join(", ") || "none"})`,
        );
        const wStage = `${f1(textWidth(elLib))} vs ${f1(textWidth(elPlain))} px`;

        // Export: the library text 0-1 s, the Segoe UI text 1-2 s, same place.
        const dir = await scratchDir();
        const out = `${dir}\\autotest-fonts-video-${Date.now().toString(36)}.mp4`;
        outs.push(out);
        const libW = { ...lib, generator: textGen("#ffffff", LIB_ID) };
        const plainW = { ...plain, generator: textGen("#ffffff") };
        const spec = {
          media: [libW, plainW],
          timeline: { ...project.timeline, tracks: [videoTrack([clipOf(libW, 0, 1, 0), clipOf(plainW, 1, 1, 0)])] },
          preset: { format: "mp4" as const, vcodec: "h264" as const, resolution: { w: 640, h: 360 }, fps: 30, videoBitrate: "auto" as const, audioBitrate: "auto" as const, useHardware: false },
          outPath: out,
        };
        const t1 = performance.now();
        const result = await runExportJob(spec, 20_000);
        assert(result.ok, `the export with a ${LIB_ID} text failed: ${result.ok ? "" : result.detail}`);
        const exportMs = ms(t1);
        const [a, b] = await videoFrames(out, [0.5, 1.5]);
        const inkA = inkIn(a!, 0, a!.h, 128, false);
        const inkB = inkIn(b!, 0, b!.h, 128, false);
        assert(inkA.n > 200 && inkB.n > 200, `the exported frames show too little text: library ${boxStr(inkA)}, Segoe UI ${boxStr(inkB)}`);
        const diff = diffCount(a!, b!, 64);
        assert(diff > 300 && diff > 0.5 * Math.min(inkA.n, inkB.n), `the exported library-font frame differs from the Segoe UI frame in only ${diff} px (ink ${inkA.n} vs ${inkB.n})`);
        assert(inkA.w / inkB.w > MIN_RATIO, `the exported "${IIS}" is ${inkA.w} px wide in ${LIB_ID} vs ${inkB.w} px in Segoe UI — ffmpeg did not draw Consolas (library ${boxStr(inkA)}; Segoe ${boxStr(inkB)})`);
        return `stage: library text font-family "${famLib.slice(0, 48)}…", "${IIS}" ${wStage} (×${ratio.toFixed(2)}); export ${exportMs}: frame 0.5 s ink ${inkA.w} px wide vs 1.5 s (Segoe UI) ${inkB.w} px (×${(inkA.w / inkB.w).toFixed(2)}), ${diff} px differ; the copied font in %TEMP% (taroting-font-<xxh3 of the out path>-0.ttf) is not observable from the page — not checked — ${ms(t0)}`;
      } finally {
        await backHome(paths);
        for (const o of outs) await removeTestFile(o).catch(() => {});
      }
    });

    await test("fonts-video-pick-restyles", async () => {
      // A Segoe UI text on the stage gets the library font the way the
      // inspector's picker commits it (updateMedia with fontId; fontFamily
      // stays "Segoe UI"): the stage text must follow without a reload.
      const t0 = performance.now();
      const paths: string[] = [];
      try {
        const alias = await ensureLib();
        const m = textMedia(textGen("#ffffff"));
        const project = videoProject("Autotest fonts pick", [m], [videoTrack([clipOf(m, 0, 2, 0)])]);
        const dev = await mountVideo(project, "Autotest fonts pick", paths);
        dev.engine.seek(0.5);
        dev.engine.refresh();
        const el = await until(() => stageText(WHITE), 3_000, () => `the Segoe UI text on the stage (gen layers: ${stageTexts()})`);
        const w0 = textWidth(el);
        const fam0 = getComputedStyle(el).fontFamily;
        dev.session.commit((p) => updateMedia(p, m.id, { generator: textGen("#ffffff", LIB_ID) }));
        dev.engine.refresh();
        const now = (): HTMLElement | null => stageText(WHITE);
        await until(
          () => {
            const e = now();
            return e && getComputedStyle(e).fontFamily.startsWith(alias) && textWidth(e) / w0 > MIN_RATIO ? e : null;
          },
          1_500,
          () => {
            const e = now();
            return `the stage text to switch to ${LIB_ID} after the pick: font-family ${e ? getComputedStyle(e).fontFamily : "(no element)"} (was ${fam0}), width ${e ? f1(textWidth(e)) : "?"} px (was ${f1(w0)}) — note scheduler.ts generatorKey() omits fontId, so a pick that keeps fontFamily "Segoe UI" may never restyle the stage`;
          },
        );
        const e = now()!;
        return `Segoe UI ${f1(w0)} px → picked ${LIB_ID}: font-family "${getComputedStyle(e).fontFamily.slice(0, 40)}…", ${f1(textWidth(e))} px — ${ms(t0)}`;
      } finally {
        await backHome(paths);
      }
    });

    await test("fonts-pdf-textbox-export", async () => {
      const t0 = performance.now();
      const outs: string[] = [];
      try {
        await ensureLib();
        const src = `${fixturesDir}\\pdf\\plain_3p.pdf`;
        const stat = await ipc.fileStat(src);
        assert(stat !== null, `${src} is missing — run npm run fixtures`);
        const { countPages } = await import("../pdf/view/loader");
        const { createPdfProject } = await import("../core/pdf-project");
        const { addAnnot, newId } = await import("../pdf/model");
        const pages = await countPages(src);
        let project = createPdfProject("Autotest fonts PDF", { path: src, size: stat!.size, mtimeMs: stat!.mtimeMs, pages });
        const key = project.pdf!.pages[0]!.id;
        const box: PdfAnnot = {
          id: newId(), t: "text", x: 100, y: 470, w: 360, h: 40, text: `${IIS} Taroting`,
          font: "Segoe UI", fontId: LIB_ID, size: 18, c: "#1a1a1a", bold: false, italic: false, align: "left",
        };
        project = addAnnot(project, key, box);
        const dir = await scratchDir();
        const out = `${dir}\\autotest-fonts-${Date.now().toString(36)}.pdf`;
        outs.push(out);
        const { exportPdf } = await import("../pdf/export/export");
        const t1 = performance.now();
        const res = await within(
          exportPdf(project, { flattenMarks: true, flattenForms: true }, out).catch((e: unknown) => {
            throw new Error(`the PDF export with a ${LIB_ID} text box failed: ${errorDetail(e).message}`);
          }),
          10_000,
          "the PDF export",
        );
        const exportMs = ms(t1);
        const got = await pdfFonts(res.path);
        const srcNames = (await pdfFonts(src)).names;
        assert(!srcNames.some((n) => /consolas/i.test(n)), `the source fixture already names Consolas (${srcNames.join(", ")}) — the check below would prove nothing`);
        const hit = got.names.find((n) => /consolas/i.test(n));
        assert(
          hit !== undefined,
          `the exported PDF (${got.bytes} bytes) embeds no font named Consolas: ${got.names.length} font object(s)${got.names.length ? `: ${got.names.join(", ")}` : ""}; source fixture fonts ${srcNames.join(", ") || "none"}`,
        );
        return `exported in ${exportMs} (${got.bytes} bytes): /BaseFont ${hit} (${got.names.length} font objects: ${got.names.join(", ")}); source fixture fonts ${srcNames.join(", ") || "none"} — ${ms(t0)}`;
      } finally {
        for (const o of outs) await removeTestFile(o).catch(() => {});
      }
    });

    await test("fonts-missing-fallback", async () => {
      const t0 = performance.now();
      const paths: string[] = [];
      const outs: string[] = [];
      const seen: string[] = [];
      const obs = new MutationObserver((recs) => {
        for (const r of recs) {
          for (const n of Array.from(r.addedNodes)) {
            if (!(n instanceof HTMLElement)) continue;
            const toasts = n.matches(".toast") ? [n] : $$(".toast", n);
            for (const t of toasts) if ((t.textContent ?? "").includes("NoSuchFontXyz")) seen.push((t.textContent ?? "").trim());
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      try {
        const miss = textMedia(textGen("#ffffff", MISSING_ID));
        const plain = textMedia(textGen("#fefefe"));
        const project = videoProject("Autotest fonts missing", [miss, plain], [
          videoTrack([clipOf(miss, 0, 2, -80)]),
          videoTrack([clipOf(plain, 0, 2, 80)]),
        ]);
        const dev = await mountVideo(project, "Autotest fonts missing", paths);
        dev.engine.seek(0.5);
        dev.engine.refresh();
        const toastEl = await until(
          () => $$(".toast").find((t) => (t.textContent ?? "").includes("NoSuchFontXyz") && rendered(t)) ?? null,
          3_000,
          () => `the missing-font notice naming NoSuchFontXyz (toasts: ${$$(".toast").map((t) => `"${(t.textContent ?? "").trim().slice(0, 80)}"`).join(", ") || "none"})`,
        );
        const said = (toastEl.textContent ?? "").trim();
        assert(!said.includes("lib:"), `the notice shows the raw id: "${said}"`);
        assert(said.includes("isn't on this PC") && said.includes("Segoe UI"), `the notice reads "${said}"`);
        await sleep(600);
        assert(seen.length === 1, `the missing-font notice appeared ${seen.length} times on one open: ${seen.map((s) => `"${s.slice(0, 60)}"`).join(", ")}`);

        // Preview in Segoe UI: the same width as the plain Segoe UI text.
        const elMiss = await until(() => stageText(WHITE), 2_000, () => `the missing-font text on the stage (gen layers: ${stageTexts()})`);
        const elPlain = await until(() => stageText(NEAR_WHITE), 2_000, () => `the Segoe UI text on the stage (gen layers: ${stageTexts()})`);
        const wm = textWidth(elMiss);
        const wp = textWidth(elPlain);
        assert(Math.abs(wm - wp) <= 1, `the missing-font text is ${f1(wm)} px wide, the Segoe UI text ${f1(wp)} px — the fallback is not Segoe UI (font-family ${getComputedStyle(elMiss).fontFamily})`);
        assert(dev.session.project.media.find((m) => m.id === miss.id)?.generator?.type === "text" && (dev.session.project.media.find((m) => m.id === miss.id)!.generator as TextGen).fontId === MISSING_ID, "opening the project rewrote the missing font's fontId");

        // Export: missing 0-1 s, Segoe UI 1-2 s; it succeeds and draws the same.
        const dir = await scratchDir();
        const out = `${dir}\\autotest-fonts-missing-${Date.now().toString(36)}.mp4`;
        outs.push(out);
        const missW = { ...miss, generator: textGen("#ffffff", MISSING_ID) };
        const plainW = { ...plain, generator: textGen("#ffffff") };
        const spec = {
          media: [missW, plainW],
          timeline: { ...project.timeline, tracks: [videoTrack([clipOf(missW, 0, 1, 0), clipOf(plainW, 1, 1, 0)])] },
          preset: { format: "mp4" as const, vcodec: "h264" as const, resolution: { w: 640, h: 360 }, fps: 30, videoBitrate: "auto" as const, audioBitrate: "auto" as const, useHardware: false },
          outPath: out,
        };
        const result = await runExportJob(spec, 20_000);
        assert(result.ok, `the export with a missing font failed: ${result.ok ? "" : result.detail}`);
        const [a, b] = await videoFrames(out, [0.5, 1.5]);
        const inkA = inkIn(a!, 0, a!.h, 128, false);
        const inkB = inkIn(b!, 0, b!.h, 128, false);
        assert(inkA.n > 200, `the missing-font frame shows no text: ${boxStr(inkA)}`);
        assert(Math.abs(inkA.w - inkB.w) <= 2 && Math.abs(inkA.left - inkB.left) <= 2, `the missing-font text exports ${boxStr(inkA)}, the Segoe UI text ${boxStr(inkB)} — not the same font`);
        const diff = diffCount(a!, b!, 64);
        assert(diff < 0.25 * inkB.n, `the missing-font frame differs from the Segoe UI frame in ${diff} px (ink ${inkB.n})`);
        return `notice once: "${said}"; stage ${f1(wm)} vs Segoe UI ${f1(wp)} px; fontId kept; export ok, frame ink ${boxStr(inkA)} vs Segoe UI ${boxStr(inkB)}, ${diff} px differ — ${ms(t0)}`;
      } finally {
        obs.disconnect();
        await backHome(paths);
        for (const o of outs) await removeTestFile(o).catch(() => {});
      }
    });

    await test("fonts-image-text", async () => {
      const t0 = performance.now();
      const paths: string[] = [];
      try {
        await ensureLib();
        const { addGeneratorLayer, setLayerTransform } = await import("../image/layers");
        // 360x160 white canvas; the library text in the top band (rows 0-79),
        // the same text in Segoe UI in the bottom band (rows 80-159), each in
        // the same 320x40 box at whole pixels.
        const gen = (fontId?: FontId): TextGen => ({ ...textGen("#000000", fontId), sizePx: 32 });
        let p = createBlankImageProject("Autotest fonts image", 360, 160, "#ffffff");
        const a = addGeneratorLayer(p, gen(LIB_ID), 320, 40, "Text");
        p = setLayerTransform(a.project, a.trackId, { y: -40 });
        const b = addGeneratorLayer(p, gen(), 320, 40, "Text");
        p = setLayerTransform(b.project, b.trackId, { y: 40 });

        const path = await ipc.tempProjectPath("Autotest fonts image");
        paths.push(path);
        await ipc.saveProject(path, p);
        const imageDev = (): ImageDev | undefined => (window as unknown as { __tarotingImageDev?: ImageDev }).__tarotingImageDev;
        const prev = imageDev();
        navigate({ view: "editor", projectPath: path, temp: true });
        const dev = await until(() => {
          const d = imageDev();
          return d && d !== prev && $(".imged") ? d : null;
        }, 8_000, () => `the image editor on "Autotest fonts image" — on screen: ${onScreen()}`);
        await frames(2);
        dev.view.actual();
        await frames(2);

        const W = 360;
        const H = 160;
        const stage = (): Luma | string => {
          dev.renderNow();
          const v = dev.view.store.get();
          if (v.zoom !== 1) return `zoom ${v.zoom}, not 1 after actual()`;
          const x0 = Math.round(v.panX);
          const y0 = Math.round(v.panY);
          if (x0 < 0 || y0 < 0 || x0 + W > dev.canvas.width || y0 + H > dev.canvas.height) {
            return `the canvas at zoom 1 (${x0},${y0} ${W}x${H}) does not fit the ${dev.canvas.width}x${dev.canvas.height} stage`;
          }
          return lumaOf(dev.canvas.getContext("2d")!.getImageData(x0, y0, W, H).data, W, H);
        };
        let last = "";
        const shown = await until(
          () => {
            const s = stage();
            if (typeof s === "string") {
              last = s;
              return null;
            }
            const ta = inkIn(s, 0, 80, 128, true);
            const tb = inkIn(s, 80, 160, 128, true);
            last = `library band ${boxStr(ta)}, Segoe UI band ${boxStr(tb)}`;
            return ta.n > 50 && tb.n > 50 && ta.w / tb.w > MIN_RATIO ? s : null;
          },
          3_000,
          () => `the stage to draw the library layer in Consolas: ${last}`,
        );
        const v = dev.view.store.get();
        const integral = Number.isInteger(v.panX) && Number.isInteger(v.panY);
        const sA = inkIn(shown, 0, 80, 128, true);
        const sB = inkIn(shown, 80, 160, 128, true);

        // The 100% PNG export against the stage at zoom 1.
        const { renderImageExport } = await import("../image/render/export");
        const blob = await within(
          renderImageExport(dev.session.project, { format: "png", quality: 92, outW: W, outH: H }, new AbortController().signal, () => {}),
          6_000,
          "the PNG export",
        );
        const bmp = await createImageBitmap(blob);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const og = oc.getContext("2d")!;
        og.drawImage(bmp, 0, 0);
        bmp.close();
        assert(oc.width === W && oc.height === H, `the PNG decodes at ${oc.width}x${oc.height}, not ${W}x${H}`);
        const ex = lumaOf(og.getImageData(0, 0, W, H).data, W, H);
        const eA = inkIn(ex, 0, 80, 128, true);
        const eB = inkIn(ex, 80, 160, 128, true);
        for (const [what, s, e] of [["library", sA, eA], ["Segoe UI", sB, eB]] as const) {
          const near = Math.abs(s.left - e.left) <= 1 && Math.abs(s.right - e.right) <= 1 && Math.abs(s.top - e.top) <= 1 && Math.abs(s.bottom - e.bottom) <= 1;
          assert(near && Math.abs(s.n - e.n) <= 0.1 * s.n, `the ${what} text: stage ${boxStr(s)}, export ${boxStr(e)}`);
        }
        // Pixel for pixel (±2, the neighbouring image blocks' tolerance) when
        // the stage sits on whole device pixels; a fractional pan resamples
        // the stage, so then only the boxes above are compared.
        let close = 0;
        for (let i = 0; i < ex.y.length; i++) if (Math.abs(ex.y[i]! - shown.y[i]!) <= 2) close++;
        const share = close / ex.y.length;
        if (integral) assert(share >= 0.99, `only ${(share * 100).toFixed(2)}% of the export's pixels are within ±2 of the stage at zoom 1 (pan ${v.panX},${v.panY})`);
        return `stage at zoom 1: library ${boxStr(sA)} vs Segoe UI ${boxStr(sB)} (×${(sA.w / sB.w).toFixed(2)}); PNG 100%: library ${boxStr(eA)}, Segoe UI ${boxStr(eB)}; ${(share * 100).toFixed(2)}% of pixels within ±2 of the stage${integral ? "" : ` (pan ${v.panX},${v.panY} fractional: boxes compared only)`} — ${ms(t0)}`;
      } finally {
        await backHome(paths);
      }
    });
  } finally {
    await removeConsolas();
    libReady = null;
  }
}

/** The /BaseFont of every font dictionary (/Type /Font) in a PDF, one entry
 *  per object (so a Type0 font and its descendant both count), read the way
 *  src/pdf/export/fonts.test.ts reads it: the file loaded with pdf-lib (the
 *  export chunk's own library, lazily), which resolves object streams — where
 *  pdf-lib puts most font dictionaries — so nothing is cut by hand. Also the
 *  file's size, for the failure message. */
async function pdfFonts(path: string): Promise<{ names: string[]; bytes: number }> {
  const res = await within(fetch(mediaUrl(path), { cache: "no-store" }), 5_000, `reading ${baseName(path)} back`);
  if (!res.ok) throw new Error(`reading ${baseName(path)} back failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { PDFDict, PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Type"))?.toString() !== "/Font") continue;
    names.push(obj.get(PDFName.of("BaseFont"))?.toString().replace(/^\//, "") ?? "(no /BaseFont)");
  }
  return { names, bytes: bytes.length };
}
