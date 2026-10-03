// Viewer + open-with E2E blocks (Wave 2). DEV-only: imported lazily by
// autotest.ts, never part of a release bundle.
//
// Every file open is driven through `ipc.debugPushOpenPath`, i.e. the REAL
// Explorer route: the backend queue, the "open-path" wake-up, the open chain,
// routeOpenPath's leave gate and its viewer/editor split. Nothing here calls
// mountViewer or routeOpenPath directly. (close-flow's second scratch project
// is the one exception, opened by route like a temp .trt — see there.)
//
// What a block asserts is what is ON SCREEN — the element hit at the stage's
// centre, its natural size, whether a control actually renders — never a class
// or a state field alone. The fixtures (make-fixtures.mjs, "viewer folder")
// give every file its own pixel size, so a stepper that skipped, repeated or
// reordered a file cannot land on a matching number.
//
// Each block leaves the app on Home with openWith back at "viewer" (the run's
// factory default), so no block depends on another's leftovers. Waits are
// short and every timeout names what WAS on screen: a red run must finish
// inside the harness's 90 s cap and say why without a rerun.

import { devOverrideMediaPicker, getWindowTitle, ipc, onJobEvents, type PlaybackClass } from "../core/ipc";
import { navigate } from "../core/nav";
import { isTempProjectPath } from "../core/open-media";
import { addMarkerAt, createProject, importMediaAsClip, trimClip } from "../core/project";
import {
  currentSession,
  leaveBlockedReason,
  settingsStore,
  settingsWritesSettled,
  updateSettings,
  type ProjectSession,
} from "../core/session";
import type { OpenWith } from "../core/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import { toast } from "../ui/toast";
import type { DevHook } from "./autotest";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the Wave 1 blocks. */
export type ViewerCtx = Wave1Ctx;

/** S19: what the viewer publishes on window while it is mounted. */
interface ViewerDev {
  loads: number;
  lastClass: PlaybackClass | null;
  jobId: number | null;
  path(): string;
  forceUnprepared: boolean;
}

type CloseFlow = (destroy: () => Promise<void>) => Promise<"closed" | "stayed">;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll every 20 ms (the harness's own waitFor polls at 100 ms, and a viewer
 *  block waits many times). `what` is evaluated only on timeout, so the message
 *  carries what was on screen at that moment, not when the wait began. */
async function until<T>(
  get: () => T | null | undefined | false,
  ms: number,
  what: () => string,
): Promise<T> {
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
const text = (sel: string): string => ($(sel)?.textContent ?? "").trim();

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
  return `${el.tagName.toLowerCase()}${cls}`;
}

function viewerDev(): ViewerDev | undefined {
  return (window as unknown as { __tarotingViewerDev?: ViewerDev }).__tarotingViewerDev;
}
function editorDev(): DevHook | undefined {
  return (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev;
}

const vwImg = (): HTMLImageElement | null => $<HTMLImageElement>("#vw-img");
const vwVideo = (): HTMLVideoElement | null => $<HTMLVideoElement>("#vw-video");

/** The element painted at the stage's centre — where the shown file is. */
function hitAtCentre(): Element | null {
  const stage = $("#vw-stage");
  if (!stage) return null;
  const r = stage.getBoundingClientRect();
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
}

/** `el` is what the stage's centre shows. An element that opts out of hit
 *  testing (pointer-events: none) counts when the stage itself is what the
 *  point lands on — nothing else is painted over it there. */
function onTop(el: HTMLElement): boolean {
  const hit = hitAtCentre();
  if (hit === el || (hit !== null && el.contains(hit))) return true;
  return getComputedStyle(el).pointerEvents === "none" && hit === $("#vw-stage") && rendered(el);
}

/** Everything a failed viewer wait needs to say. */
function viewerState(): string {
  const d = viewerDev();
  const img = vwImg();
  const v = vwVideo();
  const src = v?.currentSrc ? decodeURIComponent(v.currentSrc) : "";
  return [
    `#vw ${$("#vw") ? "mounted" : "ABSENT"}`,
    `name "${text("#vw-name")}"`,
    `count "${text("#vw-count")}"`,
    `centre hit ${describeEl(hitAtCentre())}`,
    `dev ${d ? `path ${baseName(d.path())}, class ${String(d.lastClass)}, job ${String(d.jobId)}, loads ${d.loads}` : "ABSENT"}`,
    `status "${rendered($("#vw-status")) ? text("#vw-status") : ""}"`,
    `img ${img ? `${img.naturalWidth}x${img.naturalHeight}${rendered(img) ? "" : " (not rendered)"}` : "none"}`,
    `video ${v ? `${v.videoWidth}x${v.videoHeight} rs${v.readyState} dur ${Number.isFinite(v.duration) ? v.duration.toFixed(2) : String(v.duration)} src …${src.slice(-28)}${rendered(v) ? "" : " (not rendered)"}` : "none"}`,
  ].join("; ");
}

/** The shown still is `w`x`h`, fully decoded and on top. */
function stillShown(w: number, h: number): HTMLImageElement | null {
  const img = vwImg();
  return img && img.complete && img.naturalWidth === w && img.naturalHeight === h && onTop(img) ? img : null;
}

/** The shown video has metadata, is on top, and passes `ok`. */
function videoShown(ok: (v: HTMLVideoElement) => boolean): HTMLVideoElement | null {
  const v = vwVideo();
  return v && v.readyState >= 1 && ok(v) && onTop(v) ? v : null;
}

function keydown(key: "ArrowRight" | "ArrowLeft", repeat = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, code: key, repeat, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev;
}

/** Wait for the window title (set asynchronously over IPC). */
async function waitTitle(want: string): Promise<void> {
  const start = performance.now();
  let got = "";
  for (;;) {
    got = await getWindowTitle();
    if (got === want) return;
    if (performance.now() - start > 2_000) throw new Error(`window title is "${got}", not "${want}"`);
    await sleep(30);
  }
}

/** Settle `p` or notice a dialog, whichever comes first, without leaving a
 *  losing promise behind to reject into the harness's errors list later. */
async function settleOrModal<T>(
  p: Promise<T>,
  capMs: number,
): Promise<{ value: T } | { modal: HTMLElement } | { timedOut: true }> {
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

export async function runViewerBlocks(ctx: ViewerCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;
  const dir = `${fixturesDir}\\viewer`;
  const fx = (name: string): string => `${dir}\\${name}`;

  // Every file a block steps onto or opens. A missing one would make the push
  // a silent no-op (the backend drops a path that is not a file) and every
  // block would time out on a viewer that never mounts.
  const MEDIA = [
    "clip2.mp4", "clip10.mp4", "Clip11.mov", "d.gif", "IMG_7.JPG",
    "phone.mp4", "w.wmv", "z still.png", "a1.mp3", "a2.wav",
  ];
  const present = await Promise.all(MEDIA.map((f) => ipc.pathExists(fx(f)).catch(() => false)));
  const missing = MEDIA.filter((_, i) => !present[i]);
  const needFixtures = (): void =>
    assert(missing.length === 0, `viewer fixtures missing (${missing.join(", ")}) — run npm run fixtures`);

  const setOpenWith = async (v: OpenWith): Promise<void> => {
    if (settingsStore.get().openWith !== v) await updateSettings({ openWith: v });
  };

  /** Push `name` through the real open route and wait until the viewer shows
   *  it (a fresh mount, or an in-place show on a mounted one). */
  const openInViewer = async (name: string): Promise<ViewerDev> => {
    await ipc.debugPushOpenPath(fx(name));
    return until(
      () => {
        const d = viewerDev();
        return $("#vw") && d && baseName(d.path()) === name ? d : null;
      },
      5_000,
      () => `the viewer on ${name} — ${viewerState()}`,
    );
  };
  const waitCount = (want: string): Promise<true> =>
    until(() => text("#vw-count") === want || null, 3_000, () => `counter "${want}" — ${viewerState()}`);

  /** A fresh editor mount: the hook left on window by an earlier mount would
   *  otherwise resolve at once. */
  const waitEditor = async (prev: DevHook | undefined, what: string): Promise<ProjectSession> => {
    const dev = await until(
      () => {
        const h = editorDev();
        return h && h !== prev && $("#ed-save") ? h : null;
      },
      8_000,
      () => `the editor to mount (${what}) — on screen: ${$(".editor") ? "editor" : $("#vw") ? `viewer (${viewerState()})` : $(".home") ? "home" : "?"}, dialog ${$(".modal-backdrop") ? "OPEN" : "none"}`,
    );
    return dev.session;
  };

  /** Pick an item of the viewer's "…" menu by its label. */
  const viewerMenu = async (label: string): Promise<string[]> => {
    const more = $<HTMLButtonElement>("#vw-more");
    assert(rendered(more), `#vw-more is not rendered — ${viewerState()}`);
    more!.click();
    const btn = await until(
      () =>
        Array.from(document.querySelectorAll<HTMLButtonElement>(".ctx-menu .ctx-menu__item")).find(
          (b) => b.textContent?.trim() === label && rendered(b) && !b.disabled,
        ),
      2_000,
      () => `an enabled "${label}" item in the viewer's menu (menu: ${Array.from(document.querySelectorAll(".ctx-menu .ctx-menu__item")).map((b) => `"${b.textContent?.trim()}"`).join(", ") || "none"})`,
    );
    const labels = Array.from(document.querySelectorAll(".ctx-menu .ctx-menu__item")).map((b) => b.textContent?.trim() ?? "");
    btn.click();
    return labels;
  };

  /** Click one button of the dialog that is up now. */
  const answerDialog = async (act: "keep" | "discard" | "cancel"): Promise<void> => {
    const btn = await until(
      () => $<HTMLButtonElement>(`.modal-backdrop [data-act="${act}"]`),
      3_000,
      () => `a Keep/Discard dialog with a "${act}" button (dialog ${$(".modal-backdrop") ? `open: "${text(".modal-backdrop .modal__header")}"` : "none"})`,
    );
    btn.click();
  };

  /** The one teardown every block ends with: dismiss whatever it left open,
   *  drop a temp project it created, and park the app on Home. Never throws —
   *  a cleanup failure must not mask the block's own. */
  const backHome = async (): Promise<void> => {
    try {
      closeMenu();
      for (const b of Array.from(document.querySelectorAll<HTMLElement>(".modal-backdrop"))) {
        const out = b.querySelector<HTMLElement>('[data-act="cancel"], [data-act="stay"], [data-close]');
        if (out) out.click();
        else b.remove();
      }
      const d = viewerDev();
      if (d) d.forceUnprepared = false;
      const s = currentSession.get();
      // Discarded FIRST, so the editor's teardown has nothing to flush into
      // the scratch file; navigate() itself goes past the leave gate.
      if (s && s.temp.get()) await discardTempSession(s);
      await setOpenWith("viewer");
      navigate({ view: "home" });
      await until(() => $(".home") && !$("#vw") && !$(".editor"), 5_000, () => "Home");
    } catch (e) {
      console.error("viewer autotest: cleanup did not finish", e);
    }
  };

  /** A deleted file may go a moment after the state that announced it (Keep
   *  flips `temp` before it deletes the scratch copy): poll, briefly. */
  const waitGone = async (path: string, what: string): Promise<void> => {
    const start = performance.now();
    while (await ipc.pathExists(path)) {
      if (performance.now() - start > 2_000) throw new Error(`${what}: ${path}`);
      await sleep(30);
    }
  };

  const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

  /* ---------------------------------------------------------------- */

  await test("viewer-open-route", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      const dev = await openInViewer("clip2.mp4");
      assert($(".editor") === null, "an editor is mounted next to the viewer");
      assert(currentSession.get() === null, "the viewer opened a project session — it must show the file with no project");
      const v = await until(
        () => videoShown((x) => x.videoWidth === 96 && x.videoHeight === 54),
        4_000,
        () => `clip2.mp4 (96x54) playing in #vw-video — ${viewerState()}`,
      );
      // Read now: the release below zeroes them, and the report must say what
      // was actually on screen.
      const shown = `${v.videoWidth}x${v.videoHeight}`;
      assert(
        hitAtCentre() === v,
        `the stage centre hits ${describeEl(hitAtCentre())}, not #vw-video`,
      );
      assert(dev.lastClass === "direct", `clip2.mp4 (H.264+AAC in MP4) classified ${String(dev.lastClass)}, not direct`);
      assert(dev.jobId === null, `a direct file started job ${String(dev.jobId)}`);
      await waitTitle("clip2.mp4 — Taroting");
      // Native <video> audio bypasses the audio graph's silent-output switch:
      // without the viewer's own autotest mute this block plays on the
      // owner's speakers.
      assert(v.muted, "#vw-video is not muted under autotest");

      // Release on dispose, on the clip already playing (folded in here: a
      // block of its own paid a second mount and load for the same state).
      // Precondition: a video with nothing loaded would "release" trivially.
      assert(v.hasAttribute("src"), "#vw-video has no src while clip2.mp4 plays");
      const back = $<HTMLButtonElement>("#vw-back");
      assert(rendered(back), "#vw-back is not rendered");
      back!.click();
      await until(() => $(".home") && !$("#vw"), 4_000, () => `Home after #vw-back (${$("#vw") ? "viewer still mounted" : "?"})`);
      // The decoder (~130 MB) and the Windows file handle go with the src.
      assert(!v.hasAttribute("src"), "the disposed viewer's <video> still holds its src (decoder + file handle kept)");
      assert(viewerDev() === undefined, "__tarotingViewerDev survived the viewer's dispose");
      await waitTitle("Taroting");
      return `Explorer open → viewer (no editor, no session); centre shows #vw-video ${shown}, class direct, no job, title set, muted; #vw-back → Home, the old <video> lost its src, dev hook gone, title "Taroting" — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-natural-order", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      const dev = await openInViewer("clip2.mp4");
      await waitCount("1 / 8");
      // The cache outlives the run, so from the second run on a remux of
      // Clip11 or a proxy of w.wmv already exists and `prepared` would skip
      // exactly the paths this block records. Set after the mount (the hook
      // does not exist before it) and before the first step.
      dev.forceUnprepared = true;

      type Want =
        | { name: string; kind: "video"; w: number; h: number; capMs: number }
        | { name: string; kind: "img"; w: number; h: number }
        | { name: string; kind: "prepare" };
      const ORDER: Want[] = [
        { name: "clip10.mp4", kind: "video", w: 128, h: 72, capMs: 4_000 },
        // A direct attempt that dies without an `error` event waits out the
        // loader's DIRECT_TIMEOUT_MS (4 s) before the remux starts.
        { name: "Clip11.mov", kind: "video", w: 160, h: 90, capMs: 7_000 },
        { name: "d.gif", kind: "img", w: 48, h: 32 },
        { name: "IMG_7.JPG", kind: "img", w: 200, h: 150 },
        // CODED 80x44 with a 90° display matrix: the webview shows it upright.
        { name: "phone.mp4", kind: "video", w: 44, h: 80, capMs: 4_000 },
        { name: "w.wmv", kind: "prepare" },
        { name: "z still.png", kind: "img", w: 30, h: 20 },
      ];
      const seen: string[] = [];
      let clip11 = "";
      for (let i = 0; i < ORDER.length; i++) {
        const want = ORDER[i]!;
        const count = `${i + 2} / 8`;
        const ev = keydown("ArrowRight");
        assert(ev.defaultPrevented, `ArrowRight #${i + 1} was not claimed by the viewer (nextFile) — ${viewerState()}`);
        // Synchronous: the name and counter move with the key, before any load.
        const name = text("#vw-name");
        seen.push(name);
        assert(
          name === want.name && text("#vw-count") === count,
          `step ${i + 1}: shows "${name}" "${text("#vw-count")}" right after the key, expected "${want.name}" "${count}" (so far: ${seen.join(", ")})`,
        );
        const t1 = performance.now();
        if (want.kind === "img") {
          await until(
            () => stillShown(want.w, want.h),
            3_000,
            () => `${want.name} as a ${want.w}x${want.h} still on top — ${viewerState()}`,
          );
          assert(!rendered(vwVideo()), `${want.name}: #vw-video is still rendered beside the still`);
        } else if (want.kind === "video") {
          const v = await until(
            () => videoShown((x) => x.videoWidth === want.w && x.videoHeight === want.h),
            want.capMs,
            () => `${want.name} as a ${want.w}x${want.h} video on top — ${viewerState()}`,
          );
          assert(!rendered(vwImg()), `${want.name}: #vw-img is still rendered beside the video`);
          if (want.name === "Clip11.mov") {
            assert(
              dev.lastClass === "containerOnly",
              `Clip11.mov (H.264+AAC in MOV) classified ${String(dev.lastClass)}, not containerOnly`,
            );
            const direct = decodeURIComponent(v.currentSrc).endsWith("Clip11.mov");
            // A WebView2 behaviour pin, recorded rather than asserted: if MOV
            // stops playing directly, every phone clip remuxes into the cache.
            clip11 = `Clip11.mov containerOnly → ${direct ? "played DIRECTLY" : "direct attempt failed, REMUXED"} in ${ms(t1)}`;
          }
        } else {
          const btn = await until(
            () => (rendered($("#vw-prepare")) ? $<HTMLButtonElement>("#vw-prepare") : null),
            3_000,
            () => `the "Prepare preview" button for ${want.name} — ${viewerState()}`,
          );
          assert(dev.lastClass === "proxy", `${want.name} classified ${String(dev.lastClass)}, not proxy`);
          assert(dev.jobId === null, `${want.name}: job ${String(dev.jobId)} started before Prepare preview was pressed`);
          assert(!rendered(vwVideo()) || !vwVideo()!.hasAttribute("src"), `${want.name}: a video is playing although nothing was prepared`);
          const r = btn.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          assert(hit === btn || btn.contains(hit), `the Prepare preview button is covered by ${describeEl(hit)}`);
        }
      }
      assert(text("#vw-count") === "8 / 8", `the counter ends at "${text("#vw-count")}", not "8 / 8"`);
      const next = $<HTMLButtonElement>("#vw-next");
      assert(next !== null && next.disabled, "#vw-next is not disabled on the last file");
      const loads = dev.loads;
      keydown("ArrowRight");
      await sleep(350); // past the longest dwell: a load it scheduled would have run
      assert(
        text("#vw-name") === "z still.png" && text("#vw-count") === "8 / 8" && dev.loads === loads,
        `ArrowRight past the last file moved something: "${text("#vw-name")}" "${text("#vw-count")}", loads ${loads} → ${dev.loads} (no wrap)`,
      );
      return `clip2 → ${seen.join(" → ")}, each at its own size on top; 8 / 8 with next disabled, no wrap; notes.txt, hidden.mp4, ._clip2.mp4, sub.mp4\\ and the audio never appeared; ${clip11} — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-held-key", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      const dev = await openInViewer("z still.png");
      await waitCount("8 / 8");
      await until(() => stillShown(30, 20), 3_000, () => `z still.png shown — ${viewerState()}`);
      const loads0 = dev.loads;
      // A held key: six repeats 40 ms apart, the way a keyboard's auto-repeat
      // arrives. The name and counter must keep up with every one; only the
      // file the key comes to rest on may load. 40 ms, not back to back: the
      // gap sits under DWELL_MS.repeat (150), so a dwell that re-arms its timer
      // still coalesces to one load — but one that forgets to CLEAR the old
      // timer fires ~150 ms in, on d.gif, while the key is still moving, and
      // the loads count below goes past +1. Dispatched in one synchronous
      // burst, every stale timer would fire after the key rested and find the
      // same file already loading, so that bug stayed green.
      const WANT = ["w.wmv", "phone.mp4", "IMG_7.JPG", "d.gif", "Clip11.mov", "clip10.mp4"];
      const got: string[] = [];
      for (let i = 0; i < WANT.length; i++) {
        keydown("ArrowLeft", true);
        got.push(`${text("#vw-name")} ${text("#vw-count")}`);
        if (i < WANT.length - 1) await sleep(40);
      }
      const expected = WANT.map((n, i) => `${n} ${7 - i} / 8`);
      assert(
        got.join(" | ") === expected.join(" | "),
        `held ArrowLeft painted [${got.join(" | ")}], expected [${expected.join(" | ")}]`,
      );
      await until(
        () => videoShown((v) => v.videoWidth === 128 && v.videoHeight === 72),
        3_000,
        () => `clip10.mp4 (128x72) after the key came to rest — ${viewerState()}`,
      );
      await sleep(200); // past DWELL_MS.repeat: a late load of a file the key passed would show up here
      assert(
        dev.loads === loads0 + 1 && baseName(dev.path()) === "clip10.mp4",
        `six held steps loaded ${dev.loads - loads0} file(s) (expected exactly 1, the one the key rested on); shown ${baseName(dev.path())}`,
      );
      return `6 repeats 40 ms apart: counter 7 → 2 in step with every key, then exactly one load (clip10.mp4 128x72) — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-audio-family", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      await openInViewer("a1.mp3");
      await waitCount("1 / 2");
      // a1 is 1 s and a2 is 2 s, so the duration says which one is loaded.
      const audioOn = (name: string, dur: number): HTMLElement | null => {
        const card = $("#vw-audio");
        const v = vwVideo();
        if (!rendered(card) || !v || v.readyState < 1 || Math.abs(v.duration - dur) > 0.15) return null;
        if ((card.querySelector(".viewer__audio-name")?.textContent ?? "").trim() !== name) return null;
        const hit = hitAtCentre();
        return hit !== null && (hit === card || card.contains(hit)) ? card : null;
      };
      await until(() => audioOn("a1.mp3", 1), 4_000, () => `the audio card for a1.mp3 (1 s) — ${viewerState()}`);
      assert(!rendered(vwImg()), "#vw-img is rendered while an audio file is shown");
      assert(!rendered(vwVideo()), "the <video> carrying the audio is rendered — the card should be what shows");
      keydown("ArrowRight");
      assert(
        text("#vw-name") === "a2.wav" && text("#vw-count") === "2 / 2",
        `ArrowRight from a1.mp3 shows "${text("#vw-name")}" "${text("#vw-count")}", expected "a2.wav" "2 / 2" (audio steps only through audio)`,
      );
      await until(() => audioOn("a2.wav", 2), 4_000, () => `the audio card for a2.wav (2 s) — ${viewerState()}`);
      const next = $<HTMLButtonElement>("#vw-next");
      assert(next !== null && next.disabled, "#vw-next is not disabled on the last audio file");
      return `a1.mp3 1 / 2 (card on top, 1 s loaded) → a2.wav 2 / 2 (2 s loaded), next disabled — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-swap-in-place", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      const dev0 = await openInViewer("clip2.mp4");
      await waitCount("1 / 8");
      const root0 = $("#vw");
      // A second Explorer open while viewing: ViewerHandle.show, not a remount.
      const dev1 = await openInViewer("IMG_7.JPG");
      await until(() => stillShown(200, 150), 3_000, () => `IMG_7.JPG (200x150) — ${viewerState()}`);
      assert(
        $("#vw") === root0 && root0 !== null && root0.isConnected,
        "the second open replaced the viewer element — it must swap the file in place",
      );
      assert(dev1 === dev0, "the viewer's dev hook was replaced — the second open remounted the viewer");
      await waitCount("5 / 8");
      await waitTitle("IMG_7.JPG — Taroting");
      return `same #vw element and hook; now IMG_7.JPG 200x150, re-listed 5 / 8, title updated — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-prepare-preview", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      // Mounted on a neighbour first: the knob lives on the viewer's hook, so
      // it can only be set once a viewer exists, and it must be set before
      // w.wmv is classified.
      const dev = await openInViewer("z still.png");
      await waitCount("8 / 8");
      dev.forceUnprepared = true;
      keydown("ArrowLeft");
      const btn = await until(
        () => (rendered($("#vw-prepare")) ? $<HTMLButtonElement>("#vw-prepare") : null),
        3_000,
        () => `the Prepare preview button on w.wmv — ${viewerState()}`,
      );
      assert(baseName(dev.path()) === "w.wmv", `the button is up on ${baseName(dev.path())}, not w.wmv`);
      assert(dev.lastClass === "proxy", `w.wmv classified ${String(dev.lastClass)}, not proxy`);
      // "Nothing starts until pressed" — the whole point of the button.
      assert(dev.jobId === null, `job ${String(dev.jobId)} is already running before Prepare preview was pressed`);
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      assert(hit === btn || btn.contains(hit), `the Prepare preview button is covered by ${describeEl(hit)}`);
      const t1 = performance.now();
      btn.click();
      // The proxy recipe scales to min(720, ih), so a 64x36 source stays 64x36.
      const v = await until(
        () => videoShown((x) => x.videoWidth === 64 && x.videoHeight === 36),
        10_000,
        () => `w.wmv's preview copy (64x36) — ${viewerState()}`,
      );
      assert(
        !decodeURIComponent(v.currentSrc).endsWith("w.wmv"),
        "the <video> points at the raw .wmv — it can only play the prepared copy",
      );
      assert(!rendered($("#vw-prepare")), "the Prepare preview button is still up over a playing preview");

      // The cached path: the copy just made is what the NEXT visit plays.
      // Every other block keeps forceUnprepared on (the cache outlives the
      // run), so this is the one place "already prepared" is exercised: step
      // away and back with the knob off, and w.wmv must come straight back
      // as the prepared copy — no button, no job.
      dev.forceUnprepared = false;
      keydown("ArrowRight");
      await until(() => stillShown(30, 20), 3_000, () => `z still.png after stepping off w.wmv — ${viewerState()}`);
      keydown("ArrowLeft");
      const t2 = performance.now();
      const again = await until(
        () => (baseName(dev.path()) === "w.wmv" ? videoShown((x) => x.videoWidth === 64 && x.videoHeight === 36) : null),
        4_000,
        () => `w.wmv back as its prepared 64x36 copy — ${viewerState()}`,
      );
      assert(!rendered($("#vw-prepare")), "w.wmv asks for Prepare preview again although its copy is cached");
      assert(dev.jobId === null, `revisiting a prepared w.wmv started job ${String(dev.jobId)}`);
      assert(dev.lastClass === "proxy", `w.wmv classified ${String(dev.lastClass)} on the revisit, not proxy`);
      assert(
        !decodeURIComponent(again.currentSrc).endsWith("w.wmv"),
        "the revisit points the <video> at the raw .wmv instead of the prepared copy",
      );
      return `w.wmv: class proxy, no job, button on top → pressed → 64x36 preview copy playing in ${ms(t1)}; stepped off and back → the cached copy in ${ms(t2)}, no button, no job — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-open-as-project", async () => {
    const t0 = performance.now();
    let tempPath = "";
    try {
      needFixtures();
      await setOpenWith("viewer");
      await openInViewer("clip2.mp4");
      await until(
        () => videoShown((x) => x.videoWidth === 96),
        4_000,
        () => `clip2.mp4 playing — ${viewerState()}`,
      );
      const root0 = $("#vw")!;
      const prev = editorDev();
      const labels = await viewerMenu("Open as project");
      assert(
        labels.join("|") === "Open as project|Show in folder",
        `the viewer's menu holds [${labels.join(", ")}], expected exactly [Open as project, Show in folder]`,
      );
      const session = await waitEditor(prev, "Open as project on clip2.mp4");
      tempPath = session.path;
      assert(session.temp.get(), "Open as project made a PERMANENT project — it must be temporary");
      assert(await isTempProjectPath(tempPath), `the project was written outside the temp dir: ${tempPath}`);
      assert(text("#ed-save") === "Temporary", `the badge reads "${text("#ed-save")}", not "Temporary"`);
      const back = $<HTMLButtonElement>("#ed-home");
      assert(
        back?.title === "Back to viewer",
        `#ed-home is titled "${back?.title ?? "(missing)"}", not "Back to viewer"`,
      );
      assert(!$("#vw"), "the viewer is still mounted under the editor");
      // An EDITED temporary project asks on Back (an untouched one just goes:
      // autotest-image's viewer block pins that side), with Keep focused.
      session.commit((p) => addMarkerAt(p, 0.25).project);
      back!.click();
      await until(() => $(".modal-backdrop [data-act='keep']"), 3_000, () => `the Keep/Discard dialog — ${viewerState()}`);
      await until(
        () => document.activeElement === $(".modal-backdrop [data-act='keep']") || null,
        1_000,
        () => `focus on Keep (focus is on ${document.activeElement?.tagName ?? "nothing"})`,
      );
      await answerDialog("discard");
      await until(
        () => {
          const d = viewerDev();
          return $("#vw") && $("#vw") !== root0 && d && baseName(d.path()) === "clip2.mp4";
        },
        5_000,
        () => `a new viewer back on clip2.mp4 — ${viewerState()}`,
      );
      assert(!root0.isConnected, "the old viewer element is still attached");
      await until(
        () => videoShown((x) => x.videoWidth === 96),
        4_000,
        () => `clip2.mp4 playing again — ${viewerState()}`,
      );
      assert(currentSession.get() === null, "a session is still current after Discard");
      await waitGone(tempPath, "Discard left the temp project on disk");
      return `menu → temp project (Temporary, "Back to viewer") → edit → Back → Keep/Discard (Keep focused) → Discard → a NEW viewer on clip2.mp4; temp .trt deleted — ${ms(t0)}`;
    } finally {
      await backHome();
      if (tempPath) await ipc.deleteProject(tempPath).catch(() => {});
    }
  });

  await test("viewer-photo-canvas", async () => {
    const t0 = performance.now();
    let tempPath = "";
    // A photo opened as a project is an IMAGE project, mounted by the image
    // editor — which publishes __tarotingImageDev, never the video editor's
    // __tarotingDev, so the video editor's mount wait cannot see it.
    const imageHook = (): { session: ProjectSession } | undefined =>
      (window as unknown as { __tarotingImageDev?: { session: ProjectSession } }).__tarotingImageDev;
    // The image editor's lazy chunk, as far as this page can tell: Vite's dev
    // <style> for each of its CSS imports (tagged with the file), plus any
    // resource-timing entry. The timing buffer holds 250 entries and may be
    // full by now, which is why the probe is also shown to SEE the chunk once
    // it has loaded.
    const imageChunk = (): string[] =>
      [
        ...Array.from(document.querySelectorAll("style[data-vite-dev-id]"), (s) => s.getAttribute("data-vite-dev-id") ?? ""),
        ...performance.getEntriesByType("resource").map((e) => e.name),
      ].filter((u) => u.replace(/\\/g, "/").includes("/src/image/"));
    try {
      needFixtures();
      await setOpenWith("viewer");
      await openInViewer("IMG_7.JPG");
      await until(() => stillShown(200, 150), 3_000, () => `IMG_7.JPG (200x150) — ${viewerState()}`);
      // The run's first image project: every block before this one (Home, the
      // video editor, the viewer, Settings) must have left the chunk unloaded,
      // because nothing may prefetch it.
      const early = imageChunk();
      assert(
        early.length === 0,
        `the image editor's chunk was loaded before any image project was opened: ${early.slice(0, 3).map(baseName).join(", ")}`,
      );
      const prev = imageHook();
      await viewerMenu("Open as project");
      const hook = await until(
        () => {
          const h = imageHook();
          return h && h !== prev && $(".imged") && $("#ed-save") ? h : null;
        },
        8_000,
        () => `the image editor to mount (Open as project on IMG_7.JPG) — on screen: ${$(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? `viewer (${viewerState()})` : $(".home") ? "home" : "?"}, dialog ${$(".modal-backdrop") ? "OPEN" : "none"}`,
      );
      const session = hook.session;
      tempPath = session.path;
      const p = session.project;
      assert(
        p.kind === "image" && p.schema === 3,
        `Open as project on a photo made kind ${String(p.kind)} schema ${p.schema}, not an image project (kind "image", schema 3)`,
      );
      const tl = p.timeline;
      // 200x150 is neither the 1920x1080 default nor any preset, so only a
      // canvas adopted from the photo lands here.
      assert(
        tl.width === 200 && tl.height === 150,
        `the photo's project canvas is ${tl.width}x${tl.height}, not the photo's 200x150`,
      );
      assert(session.temp.get() === true, "Open as project made a PERMANENT image project — it must be temporary");
      const late = imageChunk();
      assert(
        late.length > 0,
        "the image editor is on screen yet no /src/image/ module shows as loaded — the lazy-chunk check above is blind",
      );
      // Discarded directly: Back → Discard → the viewer remounting is
      // viewer-open-as-project's (and image-viewer-exits') to pin.
      await discardTempSession(session);
      await waitGone(tempPath, "the discarded temp project is still on disk");
      return `image chunk unloaded until now (${late.length} of its modules after); IMG_7.JPG → temporary IMAGE project (schema 3) with a 200x150 canvas → discarded — ${ms(t0)}`;
    } finally {
      await backHome();
      if (tempPath) await ipc.deleteProject(tempPath).catch(() => {});
    }
  });

  await test("editor-mode-open-and-keep", async () => {
    const t0 = performance.now();
    let kept = "";
    let tempPath = "";
    try {
      needFixtures();
      await setOpenWith("editor");
      const prev = editorDev();
      await ipc.debugPushOpenPath(fx("clip10.mp4"));
      const session = await waitEditor(prev, "an Explorer open in editor mode");
      tempPath = session.path;
      assert(session.temp.get() && (await isTempProjectPath(tempPath)), `editor mode opened a non-temporary project: ${tempPath}`);
      assert(text("#ed-save") === "Temporary", `the badge reads "${text("#ed-save")}", not "Temporary"`);
      assert(
        $<HTMLButtonElement>("#ed-home")?.title === "Back to projects",
        `#ed-home is titled "${$<HTMLButtonElement>("#ed-home")?.title ?? "(missing)"}" — an Explorer open has no viewer to return to`,
      );
      const keep = $<HTMLButtonElement>("#ed-keep");
      assert(rendered(keep), "#ed-keep is not rendered beside the Temporary badge");
      keep!.click();
      await until(
        () => !session.temp.get() && !$("#ed-keep"),
        5_000,
        () => `Keep to finish (temp ${String(session.temp.get())}, #ed-keep ${$("#ed-keep") ? "still there" : "gone"}, path ${session.path})`,
      );
      kept = session.path;
      assert(kept !== tempPath && !(await isTempProjectPath(kept)), `after Keep the project still lives in the temp dir: ${kept}`);
      assert(await ipc.pathExists(kept), `the kept project is not on disk: ${kept}`);
      await waitGone(tempPath, "Keep left the temp copy behind");
      const recents = await ipc.listRecents();
      const norm = (p: string): string => p.replace(/\//g, "\\").toLowerCase();
      assert(
        recents.items.some((i) => norm(i.path) === norm(kept)),
        `the kept project is not in recents (${recents.items.length} item(s))`,
      );
      assert(text("#ed-save") !== "Temporary", `the badge still reads "Temporary" after Keep`);
      $<HTMLButtonElement>("#ed-home")!.click();
      // A kept project leaves with no question: any dialog here is a failure.
      await until(
        () => {
          assert($(".modal-backdrop") === null, "Back after Keep still asked Keep or Discard");
          return $(".home") && !$(".editor");
        },
        5_000,
        () => "Home after Back",
      );
      return `editor mode → temp project → Keep on the badge → ${baseName(kept)} in recents, temp copy gone, Keep button gone → Back with no prompt → Home — ${ms(t0)}`;
    } finally {
      await backHome();
      if (kept) {
        await ipc.deleteProject(kept).catch(() => {});
        await ipc.removeRecent(kept).catch(() => {});
      }
      if (tempPath) await ipc.deleteProject(tempPath).catch(() => {});
    }
  });

  await test("open-while-temp-cancel", async () => {
    const t0 = performance.now();
    let tempPath = "";
    try {
      needFixtures();
      await setOpenWith("editor");
      const prev = editorDev();
      await ipc.debugPushOpenPath(fx("clip10.mp4"));
      const session = await waitEditor(prev, "an Explorer open in editor mode");
      tempPath = session.path;
      const editorRoot = $(".editor");
      // A second Explorer open meets the temp project's leave gate — which
      // asks only about an EDITED project (an untouched one just goes).
      session.commit((p) => addMarkerAt(p, 0.25).project);
      await ipc.debugPushOpenPath(fx("clip2.mp4"));
      await answerDialog("cancel");
      const toastEl = await until(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>(".toast")).find(
            (t) => /wasn['’]t opened/.test(t.textContent ?? "") && rendered(t),
          ),
        3_000,
        () => `a "wasn't opened" toast (toasts: ${Array.from(document.querySelectorAll(".toast")).map((t) => `"${t.textContent?.trim()}"`).join(", ") || "none"})`,
      );
      assert(
        (toastEl.textContent ?? "").includes("clip2.mp4"),
        `the refusal toast does not name the file: "${toastEl.textContent?.trim()}"`,
      );
      assert(
        currentSession.get() === session && $(".editor") === editorRoot && editorRoot?.isConnected === true,
        "Cancel did not keep the same editor on screen",
      );
      assert(session.temp.get() && (await ipc.pathExists(tempPath)), "Cancel lost the temporary project");
      assert(!$("#vw"), "the refused file was opened anyway");
      return `temp editor + second open → Keep dialog → Cancel → same editor, temp project intact, toast "${toastEl.textContent?.trim()}" — ${ms(t0)}`;
    } finally {
      await backHome();
      if (tempPath) await ipc.deleteProject(tempPath).catch(() => {});
    }
  });

  await test("close-flow", async () => {
    const t0 = performance.now();
    const temps: string[] = [];
    try {
      needFixtures();
      const flow = (window as unknown as { __tarotingCloseFlow?: CloseFlow }).__tarotingCloseFlow;
      assert(typeof flow === "function", "main.ts did not publish __tarotingCloseFlow");
      let destroyed = 0;
      const fakeDestroy = async (): Promise<void> => {
        destroyed++;
      };
      const tempEditor = async (): Promise<ProjectSession> => {
        await setOpenWith("editor");
        const prev = editorDev();
        await ipc.debugPushOpenPath(fx("clip10.mp4"));
        const s = await waitEditor(prev, "a temp project for the close flow");
        temps.push(s.path);
        return s;
      };
      /** Leave a session the flow already discarded: straight to Home, never
       *  through #ed-home (its gate would ask about a project that is gone). */
      const leave = async (): Promise<void> => {
        navigate({ view: "home" });
        await until(() => $(".home") && !$(".editor") && !$("#vw"), 5_000, () => "Home");
      };
      const steps: string[] = [];

      // (a) Unedited temp → discarded silently, window closed.
      {
        const s = await tempEditor();
        const path = s.path;
        // A precondition, named as one: if merely mounting marks the project
        // edited, the prompt below is the editor's bug, not the flow's.
        assert(!s.edited, "(a) precondition: a freshly opened temp project is already marked edited — the mount itself changed it");
        const out = await settleOrModal(flow!(fakeDestroy), 6_000);
        assert(!("modal" in out), "(a) an UNEDITED temp project asked before closing — it must be discarded silently");
        assert("value" in out && out.value === "closed", `(a) the flow ${"timedOut" in out ? "did not finish in 6 s" : `returned ${String((out as { value: unknown }).value)}`}`);
        assert(destroyed === 1, `(a) destroy ran ${destroyed} time(s), expected 1`);
        await waitGone(path, "(a) the unedited temp project is still on disk");
        steps.push("(a) unedited temp: no prompt, closed, scratch deleted");
        await leave();
      }

      // (c) then (b), on ONE edited temp project: Cancel stays, and the same
      // session then closes through Discard (reordered from the spec's a-b-c-d
      // to save a mount; (b) also proves Cancel left the gate usable). Built
      // in place rather than pushed: (a) already pins the Explorer route, and
      // an EMPTY scratch project mounts with no probe, thumbnail or waveform.
      // It is opened exactly the way routeOpenPath opens a .trt that lives in
      // the temp dir.
      {
        const path = await ipc.tempProjectPath("Close flow");
        temps.push(path);
        await ipc.saveProject(path, createProject("Close flow"));
        const prev = editorDev();
        navigate({ view: "editor", projectPath: path, temp: true });
        const s = await waitEditor(prev, "an empty temp project for the close flow");
        assert(s.temp.get(), `(c) precondition: the scratch project did not open as temporary (${s.path})`);
        s.commit((p) => addMarkerAt(p, 0.25).project);
        assert(s.edited, "(c) precondition: adding a marker did not mark the project edited");

        const pc = flow!(fakeDestroy);
        const c1 = await settleOrModal(pc, 4_000);
        assert("modal" in c1, `(c) an EDITED temp project closed without asking (${"value" in c1 ? `returned ${c1.value}` : "no dialog in 4 s"})`);
        assert($('.modal-backdrop [data-act="discard"]') !== null, `(c) the dialog is not Keep/Discard: "${text(".modal-backdrop .modal__header")}"`);
        await answerDialog("cancel");
        const c2 = await settleOrModal(pc, 3_000);
        assert("value" in c2 && c2.value === "stayed", `(c) Cancel did not keep the window (${"value" in c2 ? c2.value : "no answer in 3 s"})`);
        assert(destroyed === 1, `(c) destroy ran after Cancel (${destroyed})`);
        assert(currentSession.get() === s && s.temp.get() && (await ipc.pathExists(path)), "(c) Cancel lost the project");
        steps.push("(c) edited temp + Cancel: stayed, not destroyed, project intact");

        const pb = flow!(fakeDestroy);
        const b1 = await settleOrModal(pb, 4_000);
        assert("modal" in b1, `(b) the second close of the edited project did not ask (${"value" in b1 ? `returned ${b1.value}` : "no dialog in 4 s"}) — did Cancel leave the gate busy?`);
        await answerDialog("discard");
        const b2 = await settleOrModal(pb, 4_000);
        assert("value" in b2 && b2.value === "closed", `(b) Discard did not close (${"value" in b2 ? b2.value : "no answer in 4 s"})`);
        assert(destroyed === 2, `(b) destroy ran ${destroyed} time(s) in total, expected 2`);
        await waitGone(path, "(b) Discard left the temp project on disk");
        steps.push("(b) edited temp + Discard: closed, scratch deleted");
        await leave();
      }

      // (d) The viewer holds no project: the window just goes.
      {
        await setOpenWith("viewer");
        await openInViewer("z still.png");
        const out = await settleOrModal(flow!(fakeDestroy), 4_000);
        assert(!("modal" in out), "(d) closing from the viewer asked something");
        assert("value" in out && out.value === "closed", "(d) closing from the viewer did not close");
        assert(destroyed === 3, `(d) destroy ran ${destroyed} time(s) in total, expected 3`);
        steps.push("(d) viewer: closed at once");
      }
      return `${steps.join("; ")} — ${ms(t0)}`;
    } finally {
      await backHome();
      for (const p of temps) await ipc.deleteProject(p).catch(() => {});
    }
  });

  await test("export-leave-hold", async () => {
    const t0 = performance.now();
    const HOLD = "An export is running.";
    let tempPath = "";
    let unlisten: () => void = () => {};
    // Written from the job listener, so a holder rather than a let (the
    // compiler would keep a closure-assigned let narrowed to null).
    const job: { id: number | null; progressed: boolean } = { id: null, progressed: false };
    try {
      // A root fixture, not a viewer one: 30 s of 720p, so the canceled run
      // cannot finish before its Cancel lands. The first run is trimmed to
      // 1 s so it can. Both run through the dialog itself — the hold is taken
      // and released there, not by startExport.
      await setOpenWith("editor");
      const prev = editorDev();
      await ipc.debugPushOpenPath(`${fixturesDir}\\direct_h264.mp4`);
      const session = await waitEditor(prev, "a temp project on direct_h264.mp4");
      tempPath = session.path;
      const hold = (): string => JSON.stringify(leaveBlockedReason());
      assert(leaveBlockedReason() === null, `precondition: a fresh project already refuses to leave (${hold()})`);
      const full = session.project;
      const clip = full.timeline.tracks[0]?.clips[0];
      assert(clip !== undefined, "the temp project has no clip on its first track");
      // The dialog snapshots the project's preset when it opens: a small,
      // software-only encode keeps both runs short on any machine. `edit:
      // false` throughout, so the scratch project stays unedited and the
      // teardown discards it without a prompt.
      const withPreset = {
        ...full,
        export: {
          ...full.export,
          format: "mp4" as const,
          vcodec: "h264" as const,
          resolution: { w: 320, h: 180 },
          fps: 30,
          videoBitrate: "auto" as const,
          audioBitrate: "auto" as const,
          useHardware: false,
        },
      };
      const short = trimClip(withPreset, clip!.id, "out", clip!.timelineStart + 1);
      const shortClip = short.timeline.tracks[0]!.clips[0]!;
      assert(
        Math.abs(shortClip.srcOut - shortClip.srcIn - 1) < 0.05,
        `the 1 s trim did not land (${(shortClip.srcOut - shortClip.srcIn).toFixed(2)} s)`,
      );
      session.replace(short, { edit: false });

      // A job exists once one of its progress events has arrived — and only
      // then does #ex-cancel do anything (it is a no-op until startExport has
      // answered with a job id). The temp editor's own playback-preparation
      // and waveform jobs report too, hence the kind filter.
      unlisten = await onJobEvents({
        onProgress: (e) => {
          if (e.kind !== "export") return;
          job.id = e.id;
          job.progressed = true;
        },
      });

      const dialogText = (): string => text(".export-modal #ex-body").slice(0, 160);
      const openDialog = async (name: string): Promise<void> => {
        const btn = $<HTMLButtonElement>("#ed-export");
        assert(rendered(btn), "#ed-export is not rendered");
        btn!.click();
        const nameIn = await until(() => $<HTMLInputElement>(".export-modal #ex-name"), 2_000, () => "the export dialog's form");
        const folderIn = $<HTMLInputElement>(".export-modal #ex-folder")!;
        // Where the other export blocks write, beside tests\fixtures.
        folderIn.value = `${fixturesDir}\\..`;
        folderIn.dispatchEvent(new Event("input"));
        nameIn.value = name;
        nameIn.dispatchEvent(new Event("input"));
      };
      /** Press Export and wait for the progress view. The previous E2E run's
       *  output is still on disk, so the overwrite strip may come first. */
      const run = async (): Promise<void> => {
        $<HTMLButtonElement>(".export-modal #ex-run")!.click();
        await until(
          () => {
            $<HTMLButtonElement>('.export-modal #ex-warn-slot [data-w="replace"]')?.click();
            return leaveBlockedReason() !== null && $(".export-modal #ex-cancel");
          },
          3_000,
          () => `the export to start (hold ${hold()}, dialog "${dialogText()}")`,
        );
        assert(leaveBlockedReason() === HOLD, `a running export holds the session with ${hold()}, not "${HOLD}"`);
      };

      // Run 1: runs to completion. The open is pushed the moment the hold is
      // taken; its route is three IPC hops, the encode an ffmpeg spawn plus a
      // second of video, so the open always meets the hold.
      await openDialog("autotest-leave-hold");
      await run();
      await ipc.debugPushOpenPath(`${fixturesDir}\\photo.png`);
      const refusal = await until(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>(".toast")).find((t) => {
            const s = (t.textContent ?? "").trim();
            return rendered(t) && s.startsWith(HOLD) && s.includes("photo.png");
          }),
        3_000,
        () => `a toast starting "${HOLD}" naming photo.png (hold now ${hold()} — null means the export ended before the open arrived; toasts: ${Array.from(document.querySelectorAll(".toast")).map((t) => `"${t.textContent?.trim()}"`).join(", ") || "none"})`,
      );
      assert(currentSession.get() === session && $(".editor") !== null && !$("#vw"), "the refused open replaced the editor under a running export");
      // #ex-reveal, not the Close button: the error view has a Close too, and
      // a failed run releases the hold as well — only success shows Reveal.
      await until(
        () => $(".export-modal #ex-reveal"),
        10_000,
        () => `the 1 s export to succeed (hold ${hold()}, dialog "${dialogText()}")`,
      );
      assert(leaveBlockedReason() === null, `the finished export still holds the session (${hold()})`);
      $<HTMLButtonElement>(".export-modal [data-close-btn]")!.click();
      await until(() => !$(".export-modal"), 2_000, () => "the export dialog to close");

      // Run 2: the full 30 s, canceled mid-run — at 1080p, because x264
      // "medium" finishes 900 frames of 320x180 in about a second (measured:
      // the run ended before its first progress event could be acted on).
      // Canceled within ~0.5 s of starting, so the burst stays short.
      session.replace(
        {
          ...session.project,
          timeline: full.timeline,
          export: { ...withPreset.export, resolution: { w: 1920, h: 1080 } },
        },
        { edit: false },
      );
      job.id = null;
      job.progressed = false;
      await openDialog("autotest-leave-hold-cancel");
      await run();
      const t1 = performance.now();
      await until(() => job.progressed, 4_000, () => `the 30 s export's first progress event (hold ${hold()}, dialog "${dialogText()}")`);
      assert(
        !$(".export-modal [data-close-btn]"),
        `the 30 s export ended before it could be canceled (${$(".export-modal #ex-reveal") ? "success" : "error"} view: "${dialogText()}")`,
      );
      // The first progress event can race the dialog learning its job id, and
      // Cancel does nothing until it has one.
      await sleep(50);
      $<HTMLButtonElement>(".export-modal #ex-cancel")!.click();
      await until(
        () => $(".export-modal #ex-run"),
        3_000,
        () => `the form back after Cancel (hold ${hold()}, dialog "${dialogText()}")`,
      );
      assert(leaveBlockedReason() === null, `the canceled export still holds the session (${hold()})`);
      job.id = null;
      return `run 1: hold "${HOLD}" while running, toast "${refusal.textContent?.trim()}", editor kept, released on done; run 2 (30 s): hold taken, Cancel after the first progress (${ms(t1)}) released it — ${ms(t0)}`;
    } finally {
      unlisten();
      // A red run can leave an export going: stop it before anything else,
      // or the dialog refuses to close and the hold refuses every later open.
      if (leaveBlockedReason() !== null) {
        $<HTMLButtonElement>(".export-modal #ex-cancel")?.click();
        try {
          await until(() => leaveBlockedReason() === null, 3_000, () => "the export to stop");
        } catch {
          // The dialog's Cancel had no job id yet: cancel the job itself; the
          // dialog's canceled-failure handler then releases the hold.
          if (job.id !== null) await ipc.cancelJob(job.id).catch(() => false);
        }
      }
      $<HTMLButtonElement>(".export-modal [data-close], .export-modal [data-close-btn]")?.click();
      document.querySelector(".export-modal")?.closest(".modal-backdrop")?.remove();
      await backHome();
      if (tempPath) await ipc.deleteProject(tempPath).catch(() => {});
    }
  });

  await test("export-dialog-closes-with-editor", async () => {
    // The video export dialog lives on document.body. Export on an empty
    // timeline (every bin-first project's first state) says so in a toast,
    // never the failure view; and an Explorer open that replaces a (normal,
    // saved) project's editor takes the open dialog with it — it used to stay
    // over the next screen, still trapping the keyboard. (A TEMPORARY project
    // refuses an Explorer open while a dialog is up, by design: its Keep
    // prompt could not be asked — so this uses a library project.)
    const t0 = performance.now();
    let path = "";
    try {
      needFixtures();
      path = await ipc.newProjectPath("Autotest export closes");
      await ipc.saveProject(path, createProject("Autotest export closes"));
      const prev = editorDev();
      navigate({ view: "editor", projectPath: path });
      const s = await waitEditor(prev, "an empty library project");
      assert(!s.temp.get(), `precondition: the project opened as temporary (${s.path})`);
      $<HTMLButtonElement>("#ed-export")!.click();
      const folderIn = await until(() => $<HTMLInputElement>(".export-modal #ex-folder"), 2_000, () => "the export dialog's form");
      // A folder already set, so only the empty-timeline check can stop the run.
      folderIn.value = `${fixturesDir}\\..`;
      folderIn.dispatchEvent(new Event("input"));
      $<HTMLButtonElement>(".export-modal #ex-run")!.click();
      const said = await until(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>(".toast")).find(
            (t) => rendered(t) && (t.textContent ?? "").includes("Add a clip to the timeline first."),
          ),
        2_000,
        () => `the empty-timeline toast (dialog "${text(".export-modal #ex-body").slice(0, 120)}")`,
      );
      assert($(".export-modal .export-result") === null, "an empty timeline showed the export result/failure view");
      assert(rendered($(".export-modal #ex-run")), "the export form is gone after the empty-timeline refusal");
      assert(leaveBlockedReason() === null, "the refused export holds the session");

      // The form is still up. An Explorer open replaces the editor with the viewer.
      await setOpenWith("viewer");
      const v = await openInViewer("clip2.mp4");
      assert($(".export-modal") === null, "the export dialog outlived the editor that opened it");
      assert($(".modal-backdrop") === null, `a dialog is over the viewer: "${text(".modal-backdrop .modal__header")}"`);
      await waitCount("1 / 8");
      // The keyboard is the viewer's again: → steps.
      const ev = keydown("ArrowRight");
      assert(ev.defaultPrevented, `ArrowRight was not claimed by the viewer after the export dialog closed — ${viewerState()}`);
      await until(() => baseName(v.path()) !== "clip2.mp4" || null, 3_000, () => `→ to step past clip2.mp4 — ${viewerState()}`);
      return `empty timeline → toast "${said.textContent?.trim()}", form kept; an Explorer open closed the export dialog with its editor and → steps the viewer — ${ms(t0)}`;
    } finally {
      await backHome();
      if (path) await ipc.deleteProject(path).catch(() => {});
    }
  });

  await test("viewer-inert-behind-modal", async () => {
    const t0 = performance.now();
    try {
      needFixtures();
      await setOpenWith("viewer");
      await openInViewer("d.gif");
      await waitCount("4 / 8");
      // A toast's Details dialog: the one dialog anything can raise over the
      // viewer, and it has no owner that would close it on a route change.
      toast.error("Viewer autotest: a dialog over the viewer", { detail: "viewer-inert-behind-modal", op: "Autotest" });
      const details = await until(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>(".toast .btn")).find(
            (b) => b.textContent?.trim() === "Details",
          ),
        2_000,
        () => "the toast's Details button",
      );
      details.click();
      await until(() => $(".modal-backdrop [data-close]"), 2_000, () => "the Details dialog");
      const ev = keydown("ArrowRight");
      await sleep(50);
      assert(
        !ev.defaultPrevented && text("#vw-name") === "d.gif" && text("#vw-count") === "4 / 8",
        `ArrowRight behind a dialog ${ev.defaultPrevented ? "was claimed" : "was not claimed"} and the viewer shows "${text("#vw-name")}" "${text("#vw-count")}" — it must not step`,
      );
      $<HTMLButtonElement>(".modal-backdrop [data-close]")!.click();
      await until(() => !$(".modal-backdrop"), 2_000, () => "the dialog to close");
      // The other half: the same key steps once the dialog is gone. Without it
      // the first assertion would pass for a viewer that binds nothing at all.
      keydown("ArrowRight");
      assert(
        text("#vw-name") === "IMG_7.JPG" && text("#vw-count") === "5 / 8",
        `ArrowRight after closing the dialog shows "${text("#vw-name")}" "${text("#vw-count")}", expected "IMG_7.JPG" "5 / 8"`,
      );
      return `behind the Details dialog ArrowRight did nothing (not claimed); after closing it the same key stepped to IMG_7.JPG — ${ms(t0)}`;
    } finally {
      await backHome();
    }
  });

  await test("viewer-nav-rescue", async () => {
    const t0 = performance.now();
    const before = settingsStore.get();
    try {
      needFixtures();
      await setOpenWith("viewer");
      // The straddler from custom-theme-applies: its text is 1.52:1 on the app
      // background (no nav rescue) but 1.43:1 on the panel the viewer's top bar
      // is made of — so only data-rescue-chrome fires, and a Back button wired
      // to the wrong flag stays invisible.
      await updateSettings({
        theme: "custom",
        customTheme: { background: "#241a3d", accent: "#ff5fa2", text: "#453274" },
      });
      const root = document.documentElement;
      assert(
        root.dataset.rescueChrome === "1" && root.dataset.rescueNav === undefined,
        `fixture drifted: rescue-chrome ${String(root.dataset.rescueChrome)}, rescue-nav ${String(root.dataset.rescueNav)} (expected chrome only)`,
      );
      await openInViewer("z still.png");
      const back = $<HTMLButtonElement>("#vw-back");
      assert(rendered(back), "#vw-back is not rendered");
      const tok = (n: string): string => getComputedStyle(root).getPropertyValue(n).trim();
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const asRgb = (c: string): string => {
        probe.style.color = "";
        probe.style.color = c;
        return getComputedStyle(probe).color;
      };
      try {
        // An unpublished token would make both probes inherit the same colour.
        assert(tok("--safe-text-1") !== "" && tok("--text-1") !== "", "--safe-text-1 / --text-1 are not published on the root");
        const safe = asRgb(tok("--safe-text-1"));
        const user = asRgb(tok("--text-1"));
        // Anti-coincidence: were the two inks equal, the check below would
        // pass for a Back button that is not rescued at all.
        assert(safe !== user, `--safe-text-1 and --text-1 are both ${safe}: the fixture cannot tell rescued from not`);
        const got = getComputedStyle(back!).color;
        assert(
          got === safe,
          `#vw-back is drawn in ${got}; under data-rescue-chrome it must use --safe-text-1 ${safe} (the user's --text-1 is ${user})`,
        );
        return `straddler theme: rescue-chrome only; #vw-back drawn in --safe-text-1 ${safe}, not the user's ${user} — ${ms(t0)}`;
      } finally {
        probe.remove();
      }
    } finally {
      try {
        await updateSettings({ theme: before.theme, customTheme: before.customTheme });
      } catch {
        // A failed disk write must not mask the block's own result.
      }
      await backHome();
    }
  });

  await test("settings-open-with-card", async () => {
    const t0 = performance.now();
    try {
      await setOpenWith("viewer");
      navigate({ view: "settings" });
      const opt = (v: OpenWith): HTMLButtonElement | null =>
        $<HTMLButtonElement>(`.settings__card--opening [data-openwith-opt="${v}"]`);
      await until(() => opt("editor"), 5_000, () => `the Opening files card's Editor option (card ${$(".settings__card--opening") ? "present" : "ABSENT"})`);
      assert(rendered($(".settings__card--opening")), "the Opening files card is not rendered");
      // Starting state asserted too, so "true after the click" means the
      // click did it.
      assert(
        opt("viewer")?.getAttribute("aria-pressed") === "true" && opt("editor")?.getAttribute("aria-pressed") === "false",
        `before the click: Viewer aria-pressed ${String(opt("viewer")?.getAttribute("aria-pressed"))}, Editor ${String(opt("editor")?.getAttribute("aria-pressed"))}`,
      );
      assert(
        !(document.querySelector(".settings")?.textContent ?? document.body.textContent ?? "").includes("Quick view from File Explorer"),
        "the old Quick view switch is still on the Settings screen",
      );
      opt("editor")!.click();
      // The card re-renders on the store change: re-query, never reuse.
      await until(
        () =>
          settingsStore.get().openWith === "editor" &&
          opt("editor")?.getAttribute("aria-pressed") === "true" &&
          opt("viewer")?.getAttribute("aria-pressed") === "false",
        3_000,
        () => `Editor selected (store ${settingsStore.get().openWith}, Editor aria-pressed ${String(opt("editor")?.getAttribute("aria-pressed"))}, Viewer ${String(opt("viewer")?.getAttribute("aria-pressed"))})`,
      );
      await settingsWritesSettled();
      const disk = await ipc.getSettings();
      assert(disk?.openWith === "editor", `settings.json holds openWith ${String(disk?.openWith)}, not "editor"`);
      // The hint follows the selection: it says what the CURRENT choice does.
      // Re-queried each time, since the card re-renders on the store change.
      const hint = (): string => text(".settings__card--opening .settings__hint");
      assert(
        hint().includes("temporary project"),
        `with Editor selected the card's hint reads "${hint()}" — it should describe the temporary project`,
      );
      // The old Quick view switch's own control, not just its label text.
      assert($("#settings-temp-open") === null, "#settings-temp-open (the old Quick view switch) is still rendered");
      opt("viewer")!.click();
      await until(
        () =>
          settingsStore.get().openWith === "viewer" &&
          opt("viewer")?.getAttribute("aria-pressed") === "true" &&
          opt("editor")?.getAttribute("aria-pressed") === "false",
        3_000,
        () => `Viewer selected again (store ${settingsStore.get().openWith}, Viewer aria-pressed ${String(opt("viewer")?.getAttribute("aria-pressed"))})`,
      );
      assert(
        hint().includes("arrows"),
        `with Viewer selected the card's hint reads "${hint()}" — it should describe stepping with the arrows`,
      );
      return `Settings → Opening files → Editor: store + settings.json "editor", aria-pressed moved, hint names the temporary project; → Viewer: hint names the arrows; no #settings-temp-open, Quick view switch gone — ${ms(t0)}`;
    } finally {
      try {
        await updateSettings({ openWith: "viewer" });
      } catch {
        // As above.
      }
      await backHome();
    }
  });
  /* ---------------------------------------------------------------- */
  /* 0.9.1: the reported crash scenario, mount supersession, an import  */
  /* answered after its editor closed, error-report copy-out, and the   */
  /* Uninstall confirm's focus. Estimated cost (from the measured       */
  /* blocks above, ~50-1700 ms each): ~5-6 s for the six together.      */
  /* ---------------------------------------------------------------- */

  /** A PERMANENT library project holding one clip on `clipFile` (probed for
   *  real), so its editor mounts with a media manager, a video element and
   *  background work like any project a user opens. */
  const mp4Project = async (name: string, clipFile: string): Promise<string> => {
    const path = await ipc.newProjectPath(name);
    const info = await ipc.probeMedia(fx(clipFile));
    await ipc.saveProject(path, importMediaAsClip(createProject(name), info).project);
    return path;
  };
  const dropProject = async (path: string): Promise<void> => {
    if (!path) return;
    await ipc.deleteProject(path).catch(() => {});
    await ipc.removeRecent(path).catch(() => {});
  };

  /** Window responsiveness, measured the way a user feels it: a trivial IPC
   *  round trip (the window title) every ~25 ms, each one needing the
   *  WebView2 UI thread to receive and answer it. A UI thread blocked on a
   *  synchronous command, or a page busy in a long task, shows up as one slow
   *  round trip. */
  const startIpcProbe = (): { stop(): Promise<{ max: number; n: number }> } => {
    let running = true;
    let max = 0;
    let n = 0;
    const loop = (async () => {
      while (running) {
        const t = performance.now();
        await getWindowTitle();
        const d = performance.now() - t;
        if (d > max) max = d;
        n++;
        await sleep(25);
      }
    })();
    return {
      async stop() {
        running = false;
        await loop;
        return { max, n };
      },
    };
  };

  /** Every toast now painted, as text — for a failure message, and to prove
   *  that nothing refused or failed. */
  const toastTexts = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>(".toast"))
      .filter((t) => rendered(t))
      .map((t) => (t.textContent ?? "").trim());
  const assertNoFailureToast = (when: string): void => {
    const bad = Array.from(document.querySelectorAll<HTMLElement>(".toast")).filter(
      (t) => rendered(t) && (t.classList.contains("toast--error") || /wasn['’]t opened|Still editing/.test(t.textContent ?? "")),
    );
    assert(bad.length === 0, `${when}: ${bad.map((t) => `"${(t.textContent ?? "").trim()}"`).join(", ")}`);
  };
  /** No editor left anywhere: not in the DOM, not painted at the window's
   *  centre, not holding the session. */
  const assertNoEditor = (when: string): void => {
    const editors = document.querySelectorAll(".editor").length;
    assert(editors === 0, `${when}: ${editors} .editor element(s) still in the document`);
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    assert(!hit?.closest(".editor"), `${when}: the window's centre paints ${describeEl(hit)} inside an editor`);
    assert(currentSession.get() === null, `${when}: a project session is still current (${currentSession.get()?.path ?? ""})`);
  };

  // The v0.7.3 copy-out regression ("can't copy-past the log"), driven
  // through the REAL export dialog to a REAL ffmpeg failure: the clip's media
  // is pointed at `._clip2.mp4`, a 16-byte file with a video extension (the
  // viewer fixtures' macOS litter), which every check before ffmpeg passes —
  // it is a file, on a drive, that exists — and ffmpeg cannot read. Every
  // destination problem is refused before ffmpeg now, so the input is the
  // only way to get ffmpeg's own argv and log into the report, and without
  // them the privacy checks below would have nothing to leak. Never touches
  // the owner's clipboard: both copy routes are replaced by spies. ~1 s.
  await test("error-report", async () => {
    const t0 = performance.now();
    let tempPath = "";
    const clip = navigator.clipboard as Clipboard | undefined;
    const spied: { text: string | null; exec: number } = { text: null, exec: 0 };
    try {
      needFixtures();
      const junk = fx("._clip2.mp4");
      assert(await ipc.pathExists(junk), `fixture ${junk} is missing — run npm run fixtures`);
      // The account name the report must not carry, from paths this run KNOWS
      // sit under the profile. Underivable means the check below would pass
      // for any report, so that is a failure, not a skip.
      const info = await ipc.debugInfo();
      const user = [info.reportPath, fixturesDir]
        .map((p) => (p.match(/^[A-Za-z]:\\Users\\([^\\]+)/i) ?? [])[1])
        .find((u): u is string => !!u);
      assert(user !== undefined, `cannot derive the Windows account name from ${info.reportPath} or ${fixturesDir} — the leak check would be vacuous`);

      await setOpenWith("editor");
      const prev = editorDev();
      await ipc.debugPushOpenPath(fx("clip2.mp4"));
      const session = await waitEditor(prev, "a temp project on clip2.mp4");
      tempPath = session.path;
      const p = session.project;
      // `edit: false`: the scratch project stays unedited, so the teardown
      // discards it with no prompt. A small software encode, like
      // export-leave-hold's, in case ffmpeg ever got further than the input.
      session.replace(
        {
          ...p,
          media: p.media.map((m) => ({ ...m, path: junk })),
          export: {
            ...p.export,
            format: "mp4" as const,
            vcodec: "h264" as const,
            resolution: { w: 320, h: 180 },
            fps: 30,
            videoBitrate: "auto" as const,
            audioBitrate: "auto" as const,
            useHardware: false,
          },
        },
        { edit: false },
      );

      const ex = $<HTMLButtonElement>("#ed-export");
      assert(rendered(ex), "#ed-export is not rendered");
      ex!.click();
      const nameIn = await until(() => $<HTMLInputElement>(".export-modal #ex-name"), 2_000, () => "the export dialog's form");
      const folderIn = $<HTMLInputElement>(".export-modal #ex-folder")!;
      folderIn.value = `${fixturesDir}\\..`;
      folderIn.dispatchEvent(new Event("input"));
      nameIn.value = "autotest-error-report";
      nameIn.dispatchEvent(new Event("input"));
      $<HTMLButtonElement>(".export-modal #ex-run")!.click();
      await until(
        () => {
          $<HTMLButtonElement>('.export-modal #ex-warn-slot [data-w="replace"]')?.click();
          return $(".export-modal .export-result__icon--bad");
        },
        8_000,
        () => `the export's failure view (dialog: "${text(".export-modal #ex-body").slice(0, 160)}"; toasts: ${toastTexts().join(" | ") || "none"})`,
      );

      // The detail pane: painted, holding text, selectable, and Ctrl+C left to
      // the browser (a hijack would preventDefault it for the timeline's
      // copy-clip binding — the v0.7.3 bug).
      const ta = $<HTMLTextAreaElement>(".export-modal .err-detail");
      assert(rendered(ta), "the failure view has no rendered .err-detail textarea");
      assert(ta!.value.trim().length > 0, "the detail textarea is empty");
      const us = getComputedStyle(ta!).userSelect;
      assert(us !== "none", `the detail textarea has user-select: ${us}`);
      const ctrlC = new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true });
      ta!.dispatchEvent(ctrlC);
      assert(!ctrlC.defaultPrevented, "Ctrl+C in the detail textarea was claimed by an app shortcut (preventDefault) — the copy never reaches the clipboard");

      // The assembled report replaces the raw log; THAT is what users copy.
      await until(
        () => ta!.value.startsWith("Taroting diagnostic report") || null,
        5_000,
        () => `the assembled report in the textarea (it holds: "${ta!.value.slice(0, 80)}")`,
      );
      ta!.focus();
      ta!.select();
      assert(
        ta!.selectionStart === 0 && ta!.selectionEnd === ta!.value.length,
        `select-all in the textarea selected ${ta!.selectionStart}-${ta!.selectionEnd} of ${ta!.value.length}`,
      );
      const report = ta!.value;
      // Non-vacuity: the report carries ffmpeg's own command line, which names
      // the source and the destination in full — so the checks below are
      // looking at text that HAD the paths to leak.
      assert(
        report.includes("FFmpeg command") && !report.includes("(not captured)"),
        "the report carries no captured ffmpeg command: the failure never reached ffmpeg, and the leak checks below would prove nothing",
      );
      const low = report.toLowerCase();
      assert(!low.includes(user!.toLowerCase()), `the report leaks the account name "${user}"`);
      assert(!low.includes(fixturesDir.toLowerCase()), "the report leaks the fixtures folder");
      assert(!report.includes("._clip2"), "the report leaks the source file's name");
      assert(!/machineId|installId|sessionId/i.test(report), "the report carries a correlating identifier");

      // "Copy details" copies exactly that text — through spies, never the
      // real clipboard. Own properties shadow the prototype's methods and are
      // deleted again below, which puts the real ones back.
      if (clip) {
        Object.defineProperty(clip, "writeText", {
          configurable: true,
          writable: true,
          value: async (t: string): Promise<void> => {
            spied.text = t;
          },
        });
      }
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        writable: true,
        value: (cmd: string): boolean => {
          if (cmd !== "copy") return false;
          spied.exec++;
          spied.text = document.querySelector<HTMLTextAreaElement>('textarea[style*="-9999px"]')?.value ?? "";
          return true;
        },
      });
      const copyBtn = Array.from(document.querySelectorAll<HTMLButtonElement>(".export-modal .err-pane__actions button")).find(
        (b) => b.textContent?.trim() === "Copy details",
      );
      assert(rendered(copyBtn ?? null), "the failure view has no rendered Copy details button");
      copyBtn!.click();
      await until(() => spied.text !== null || null, 2_000, () => "Copy details to reach the clipboard");
      assert(spied.text === report, `Copy details copied ${spied.text?.length ?? 0} chars, not the ${report.length}-char report shown`);
      return `real dialog → ffmpeg failed on ._clip2.mp4 → textarea painted, selectable (${us}), Ctrl+C not claimed; report ${report.length} chars with the ffmpeg command, no account name / folder / file name / id; Copy details copied it via ${spied.exec ? "execCommand" : "clipboard.writeText"} (spied) — ${ms(t0)}`;
    } finally {
      if (clip) delete (clip as unknown as Record<string, unknown>).writeText;
      delete (document as unknown as Record<string, unknown>).execCommand;
      $<HTMLButtonElement>(".export-modal [data-close-btn], .export-modal [data-close]")?.click();
      document.querySelector(".export-modal")?.closest(".modal-backdrop")?.remove();
      await backHome();
      if (tempPath) await ipc.deleteProject(tempPath).catch(() => {});
    }
  });

  /**
   * The reported crash: a project with an mp4 is open (its media work possibly
   * still running), there is an edit not yet autosaved, and File Explorer
   * opens an mp4 into the same window. The open must flush the edit, replace
   * the editor with the viewer, leave nothing of the editor behind, and keep
   * the window answering throughout.
   */
  const openOverBusyEditor = async (projectClip: string, opened: string, w: number, h: number): Promise<string> => {
    const t0 = performance.now();
    let path = "";
    let probe: ReturnType<typeof startIpcProbe> | null = null;
    let releaseAutosave: () => void = () => {};
    try {
      needFixtures();
      await setOpenWith("viewer");
      // Named by the stem: a ".mp4" inside a project name is not what this tests.
      path = await mp4Project(`Autotest busy open ${projectClip.replace(/\.[^.]+$/, "")}`, projectClip);
      const prev = editorDev();
      // The .trt through the real Explorer route too, as the user opened it.
      await ipc.debugPushOpenPath(path);
      const session = await waitEditor(prev, `the project on ${projectClip}`);
      assert(!session.temp.get(), `precondition: the library project opened as temporary (${session.path})`);
      // Not waited for: whatever the media manager is still doing is part of
      // the scenario. Reported, not asserted — the cache outlives the run, so
      // from the second run on the work may already be done.
      const states = Object.values(editorDev()!.media.status.get()).map((s) => s.state);
      const busy = states.filter((s) => s !== "ready").length;
      // Autosave is HELD from before the edit (the image editor's own
      // mid-gesture hold: explicit saves and dispose still write). So the
      // only way the marker can reach the disk is the open's leave flush —
      // on a slow run the 500 ms debounce would otherwise save it first, and
      // "the edit reached the .trt" would pass through autosave instead.
      releaseAutosave = session.holdAutosave();
      session.commit((p) => addMarkerAt(p, 0.37).project);
      // Unflushed is the scenario.
      assert(session.saveState.get() === "dirty", `precondition: the edit is already "${session.saveState.get()}", not "dirty"`);
      probe = startIpcProbe();
      const tPush = performance.now();
      await ipc.debugPushOpenPath(fx(opened));
      const v = await until(
        () => videoShown((x) => x.videoWidth === w && x.videoHeight === h),
        6_000,
        () => `${opened} (${w}x${h}) in the viewer — ${viewerState()}; editor ${$(".editor") ? "STILL MOUNTED" : "gone"}, dialog ${$(".modal-backdrop") ? `"${text(".modal-backdrop .modal__header")}"` : "none"}, toasts: ${toastTexts().join(" | ") || "none"}`,
      );
      const switchMs = performance.now() - tPush;
      const { max, n } = await probe.stop();
      probe = null;
      assert(max < 1_000, `the window stopped answering for ${Math.round(max)} ms during the switch (slowest of ${n} title round trips)`);
      assert(hitAtCentre() === v, `the stage centre hits ${describeEl(hitAtCentre())}, not #vw-video`);
      assert($(".modal-backdrop") === null, `a dialog is up over the viewer: "${text(".modal-backdrop .modal__header")}"`);
      assertNoEditor("after the open");
      assertNoFailureToast("the open said");
      const disk = await ipc.loadProject(path);
      const marks = disk.project.timeline.markers ?? [];
      assert(
        marks.some((m) => Math.abs(m.t - 0.37) < 1e-6),
        `the unflushed edit never reached the .trt (markers on disk: [${marks.map((m) => m.t).join(", ")}])`,
      );
      return `project on ${projectClip} (${busy}/${states.length} media still busy) + unsaved marker → open ${opened}: viewer on ${w}x${h} in ${Math.round(switchMs)} ms, marker on disk, no editor left, no dialog/refusal; slowest IPC round trip ${Math.round(max)} ms of ${n} — ${ms(t0)}`;
    } finally {
      releaseAutosave();
      if (probe) await probe.stop();
      await backHome();
      await dropProject(path);
    }
  };

  // ~1.2 s each.
  await test("open-over-busy-editor", () => openOverBusyEditor("phone.mp4", "clip10.mp4", 128, 72));
  // The same file the project is playing: the editor's <video> and the
  // viewer's open it one after the other, on one decoder budget.
  await test("open-same-file-over-busy-editor", () => openOverBusyEditor("clip2.mp4", "clip2.mp4", 96, 54));

  // Mount supersession: an Explorer open arriving while the editor is still
  // MOUNTING. Back-to-back pushes usually finish the first mount before the
  // second arrives, which would make this pass by construction, so the mount
  // is held open deterministically at each of its two awaits in turn:
  //   1. ipc.loadProject (wrapped through the shared `ipc` object the editor
  //      calls it on) — the mount is caught by the check after the load, or
  //      failing that by the one after media.init; this phase cannot tell
  //      which, only that one of them did;
  //   2. MediaManager.prototype.init — only the check after media.init stands
  //      between this mount and painting over the viewer, so this is the
  //      phase that fails if that check goes.
  // What a lost check looks like on screen: an editor painted over the viewer,
  // a session in currentSession that nothing shows, a new editor dev hook.
  // ~1.5 s for both phases.
  await test("open-during-editor-mount", async () => {
    const t0 = performance.now();
    let path = "";
    const realLoad = ipc.loadProject;
    const { MediaManager } = await import("../editor/media/media");
    const realInit = MediaManager.prototype.init;
    const gate: { release: () => void; entered: number; left: number } = { release: () => {}, entered: 0, left: 0 };
    const hold = (): Promise<void> => new Promise<void>((r) => (gate.release = r));
    const steps: string[] = [];
    try {
      needFixtures();
      await setOpenWith("viewer");
      path = await mp4Project("Autotest mount supersession", "clip2.mp4");
      const phase = async (where: "load" | "init", opened: string, w: number, h: number): Promise<void> => {
        gate.entered = 0;
        gate.left = 0;
        const held = hold();
        // Only the FIRST call is held (the mount's own — nothing else loads a
        // project or builds a media manager during a phase). Not matched by
        // path: the open route may hand the editor a respelled one.
        if (where === "load") {
          ipc.loadProject = async (p: string) => {
            const r = await realLoad(p);
            if (gate.entered === 0) {
              gate.entered++;
              await held;
              gate.left++;
            }
            return r;
          };
        } else {
          MediaManager.prototype.init = async function (this: InstanceType<typeof MediaManager>): Promise<void> {
            await realInit.call(this);
            if (gate.entered === 0) {
              gate.entered++;
              await held;
              gate.left++;
            }
          };
        }
        try {
          const prev = editorDev();
          await ipc.debugPushOpenPath(path);
          await until(() => gate.entered === 1 || null, 5_000, () => `the editor mount to reach ${where} (on screen: ${$(".editor") ? "editor" : $("#vw") ? "viewer" : $(".home") ? "home" : "?"})`);
          await ipc.debugPushOpenPath(fx(opened));
          const v = await until(
            () => videoShown((x) => x.videoWidth === w && x.videoHeight === h),
            5_000,
            () => `${opened} in the viewer while the mount is held at ${where} — ${viewerState()}`,
          );
          gate.release();
          await until(() => gate.left === 1 || null, 2_000, () => `the held ${where} to return`);
          // Let the superseded mount run to wherever it stops: two frames and
          // a beat for its remaining awaits and its tracked dispose.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          await sleep(150);
          assertNoEditor(`${where}: after the held mount resumed`);
          assert(editorDev() === prev, `${where}: the superseded mount published a new editor dev hook — it built an editor`);
          assert(vwVideo() === v && hitAtCentre() === v, `${where}: the viewer is no longer what the stage shows (centre hits ${describeEl(hitAtCentre())})`);
          assertNoFailureToast(`${where}: a toast says`);
          steps.push(`held at ${where} → ${opened} shown → released → no editor, no session, no hook`);
        } finally {
          gate.release();
          ipc.loadProject = realLoad;
          MediaManager.prototype.init = realInit;
        }
        await backHome();
      };
      await phase("load", "clip2.mp4", 96, 54);
      await phase("init", "clip10.mp4", 128, 72);
      return `${steps.join("; ")} — ${ms(t0)}`;
    } finally {
      gate.release();
      ipc.loadProject = realLoad;
      MediaManager.prototype.init = realInit;
      await backHome();
      await dropProject(path);
    }
  });

  // An Import dialog still open when an Explorer open replaces its editor
  // (reproduced by hand: pick files after the editor is gone). The answer
  // must be refused in words on the screen that replaced it, and nothing may
  // reach the closed project — neither its session nor its .trt. The native
  // picker is stood in for by a dev seam in ipc.ts (the off-screen harness
  // cannot answer a real one). ~0.8 s.
  await test("import-after-close-refused", async () => {
    const t0 = performance.now();
    let path = "";
    let answer: ((paths: string[]) => void) | null = null;
    let asked = 0;
    try {
      needFixtures();
      await setOpenWith("viewer");
      path = await mp4Project("Autotest import after close", "clip2.mp4");
      const prev = editorDev();
      navigate({ view: "editor", projectPath: path });
      const session = await waitEditor(prev, "the project on clip2.mp4");
      const before = session.project.media.map((m) => m.path);
      devOverrideMediaPicker(() => {
        asked++;
        return new Promise<string[]>((r) => (answer = r));
      });
      const imp = $<HTMLButtonElement>("#ed-import");
      assert(rendered(imp), "#ed-import is not rendered");
      imp!.click();
      await until(() => asked === 1 || null, 2_000, () => "Import to open the (stand-in) picker");
      await openInViewer("clip10.mp4");
      assertNoEditor("with the picker still open");
      answer!([fx("a1.mp3")]);
      answer = null;
      const said = await until(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>(".toast")).find(
            (t) => rendered(t) && (t.textContent ?? "").includes("a1.mp3 wasn't imported because the project was closed."),
          ),
        3_000,
        () => `the "wasn't imported because the project was closed" toast (toasts: ${toastTexts().join(" | ") || "none"})`,
      );
      // Anything that slipped through would commit and autosave: give it the
      // debounce's time to land before reading the file.
      await sleep(600);
      assert(
        session.project.media.length === before.length && !session.project.media.some((m) => m.path.endsWith("a1.mp3")),
        `the closed editor's session took the file (${session.project.media.length} media, was ${before.length})`,
      );
      const disk = await ipc.loadProject(path);
      const onDisk = disk.project.media.map((m) => m.path);
      assert(
        onDisk.length === before.length && !onDisk.some((p) => p.endsWith("a1.mp3")),
        `the .trt was written with the refused file (${onDisk.map(baseName).join(", ")})`,
      );
      assert(rendered($("#vw")) && baseName(viewerDev()?.path() ?? "") === "clip10.mp4", `the viewer did not stay on clip10.mp4 — ${viewerState()}`);
      return `Import open → Explorer open → viewer; the late answer refused: "${said.textContent?.trim()}"; session and .trt still ${before.length} media — ${ms(t0)}`;
    } finally {
      devOverrideMediaPicker(null);
      if (answer) (answer as (paths: string[]) => void)([]);
      await backHome();
      await dropProject(path);
    }
  });

  // Settings → Uninstall: the confirm opens with focus INSIDE it on Cancel
  // (never the red button), painted on top, never stacks a second copy, and
  // every way out puts focus back. The confirm is never pressed, and the
  // uninstall IPC is replaced by a spy that would refuse anyway. ~0.4 s.
  await test("settings-uninstall-focus", async () => {
    const t0 = performance.now();
    const realUninstall = ipc.uninstallApp;
    let calls = 0;
    ipc.uninstallApp = async (): Promise<void> => {
      calls++;
      throw new Error("autotest: the uninstaller is never run");
    };
    const dialog = (): HTMLElement | null => $('.modal[aria-label="Uninstall Taroting"]');
    const openBtn = (): HTMLButtonElement | null => $<HTMLButtonElement>("#settings-uninstall");
    try {
      navigate({ view: "settings" });
      await until(() => rendered(openBtn()) || null, 5_000, () => "Settings → Uninstall Taroting button");
      openBtn()!.click();
      const dlg = await until(dialog, 2_000, () => "the Uninstall Taroting? dialog");
      const cancel = dlg.querySelector<HTMLButtonElement>("[data-cancel]");
      const confirm = dlg.querySelector<HTMLButtonElement>("[data-confirm]");
      assert(cancel !== null && confirm !== null, "the dialog has no Cancel / Uninstall pair");
      assert(
        document.activeElement === cancel,
        `focus opened on ${describeEl(document.activeElement)}${document.activeElement === confirm ? " (the red Uninstall button)" : ""}, not Cancel`,
      );
      const r = cancel!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      assert(hit === cancel || (hit !== null && cancel!.contains(hit)), `Cancel's centre paints ${describeEl(hit)}`);
      // The button behind the backdrop, pressed again (the old Enter path):
      // still exactly one dialog.
      openBtn()!.click();
      await sleep(30);
      const count = document.querySelectorAll(".modal-backdrop").length;
      assert(count === 1, `${count} dialogs after a second press of Uninstall Taroting`);
      // From the focused Cancel, as a real key arrives: the dialog's capture
      // listener on document must see it before anything of the screen's.
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await until(() => !dialog() || null, 2_000, () => "Escape to close the dialog");
      assert(document.activeElement === openBtn(), `after Escape focus is on ${describeEl(document.activeElement)}, not #settings-uninstall`);
      openBtn()!.click();
      const again = await until(dialog, 2_000, () => "the dialog, reopened");
      again.querySelector<HTMLButtonElement>("[data-cancel]")!.click();
      await until(() => !dialog() || null, 2_000, () => "Cancel to close the dialog");
      assert(document.activeElement === openBtn(), `after Cancel focus is on ${describeEl(document.activeElement)}, not #settings-uninstall`);
      assert(calls === 0, `the uninstall IPC was called ${calls} time(s)`);
      return `opens on Cancel (painted on top), a second press stacks nothing, Escape and Cancel both close and refocus the button; uninstall never called — ${ms(t0)}`;
    } finally {
      dialog()?.querySelector<HTMLButtonElement>("[data-cancel]")?.click();
      ipc.uninstallApp = realUninstall;
      await backHome();
    }
  });
}
