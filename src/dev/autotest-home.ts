// Home E2E blocks (0.9.0 review): "New project" asks which kind in a menu, and
// Open (or a drop) asks "Open as" instead of opening media in the viewer.
// DEV-only: imported lazily by autotest.ts, never part of a release bundle.
//
// The native file picker cannot be driven, so "home-open-as" hands fixture
// paths to Home's own routing through `window.__tarotingHomeDev` (published by
// mountHome only under dev + autotest) — the same function the picker's result
// goes through. What a block asserts is what is ON SCREEN (rendered boxes, the
// element hit at a point, the focused element) or ON DISK (the saved project),
// never a class alone.
//
// "home-open-as" creates an image project and lets Home open it, so the image
// editor chunk is loaded by it: register these blocks AFTER any block that
// asserts nothing loaded that chunk early.
//
// Each block ends on Home with every project it created deleted.

import { ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { isTempProjectPath } from "../core/open-media";
import { currentSession } from "../core/session";
import type { ProjectFile } from "../core/types";
import { closeMenu } from "../ui/menu";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the Wave 1, viewer and image blocks. */
export type HomeCtx = Wave1Ctx;

/** What Home publishes on window while it is mounted (home.ts, dev + autotest). */
interface HomeDev {
  open(paths: string[]): void;
  drop(paths: string[]): void;
}

const $ = <E extends Element = HTMLElement>(sel: string): E | null => document.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string): E[] => Array.from(document.querySelectorAll<E>(sel));
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").trim();
const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const norm = (p: string): string => p.replace(/\//g, "\\").toLowerCase();

/** Laid out AND painted: a box, no display:none ancestor, not visibility:hidden. */
function rendered(el: Element | null | undefined): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.isConnected &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden"
  );
}

/** Whether the element painted at the centre of `el` is `el` or inside it. */
function hitsItself(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit === el || (hit !== null && el.contains(hit));
}

function onScreen(): string {
  const scr = $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".home") ? "home" : "?";
  const dlg = $(".modal-backdrop") ? `dialog "${text($(".modal-backdrop .modal__header"))}"` : "no dialog";
  return `${scr}, ${dlg}`;
}

function homeDev(): HomeDev | undefined {
  return (window as unknown as { __tarotingHomeDev?: HomeDev }).__tarotingHomeDev;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

export async function runHomeBlocks(ctx: HomeCtx): Promise<void> {
  const { test, assert, waitFor, sleep, fixturesDir } = ctx;
  const fx = (name: string): string => `${fixturesDir}\\${name}`;
  const ALPHA = fx("image_alpha_97x61.png");
  const GRID = fx("image_grid_641x361.png");
  const VIDEO = fx("counter_h264.mp4");

  /** Dismiss anything left open and park on a FRESH Home. Never throws. */
  const freshHome = async (): Promise<void> => {
    closeMenu();
    for (const b of $$(".modal-backdrop")) {
      const out = b.querySelector<HTMLElement>('[data-act="cancel"]');
      if (out) out.click();
      else b.remove();
    }
    const old = $(".home");
    navigate({ view: "home" });
    await waitFor(() => $(".home") && $(".home") !== old && !$(".editor") && !$("#vw"), 5_000, `a fresh Home (${onScreen()})`);
  };

  const menuRows = (): HTMLElement[] => $$<HTMLElement>(".ctx-menu .ctx-menu__item");

  await test("home-new-project-menu", async () => {
    try {
      await freshHome();
      assert($("#btn-new-image") === null, "#btn-new-image still exists on Home");
      const newBtn = $<HTMLButtonElement>("#btn-new");
      assert(rendered(newBtn), "#btn-new is not rendered");
      assert(text(newBtn) === "New project", `the button reads "${text(newBtn)}"`);
      // .click() is a click with detail 0 — what Enter/Space on the button
      // delivers — so this is the KEYBOARD open: the menu starts on its first
      // row, focused, and the next Enter would choose it.
      newBtn!.focus();
      newBtn!.click();
      const menu = await waitFor(() => (rendered($(".ctx-menu")) ? $(".ctx-menu") : null), 2_000, "the New project menu");
      const rows = menuRows();
      assert(rows.length === 2, `the menu has ${rows.length} rows, not 2`);
      assert(
        document.activeElement === rows[0] && rows[0]!.classList.contains("ctx-menu__item--active"),
        `a keyboard open did not start on Video project (focus on ${document.activeElement?.textContent ?? "nothing"})`,
      );
      const labels = rows.map((r) => text(r.querySelector(".ctx-menu__label")));
      const hints = rows.map((r) => text(r.querySelector(".ctx-menu__hint")));
      assert(
        labels.join("|") === "Video project|Image project",
        `the rows read ${JSON.stringify(labels)}`,
      );
      assert(
        hints.join("|") === "Clips, photos and music on a timeline|Draw on, adjust and export a picture",
        `the hints read ${JSON.stringify(hints)}`,
      );
      for (const r of rows) {
        const ico = r.querySelector(".ctx-menu__icon svg");
        assert(rendered(r.querySelector(".ctx-menu__icon")) && ico !== null, `${text(r)}: no rendered icon`);
        const hint = r.querySelector<HTMLElement>(".ctx-menu__hint");
        assert(rendered(hint), `${text(r)}: the hint is not rendered`);
        // A second line: the hint sits below the label, not beside it.
        const lb = r.querySelector(".ctx-menu__label")!.getBoundingClientRect();
        assert(hint!.getBoundingClientRect().top >= lb.bottom - 1, `${text(r)}: the hint is not under the label`);
        assert(hitsItself(r), `${text(r)}: the row is not what paints at its centre`);
      }
      // Anchored to the button, never over it.
      const b = newBtn!.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      assert(m.top >= b.bottom || m.bottom <= b.top, `the menu (${Math.round(m.top)}..${Math.round(m.bottom)}) covers the button (${Math.round(b.top)}..${Math.round(b.bottom)})`);
      pressEscape();
      await waitFor(() => !rendered($(".ctx-menu")), 1_000, "Escape to close the menu");
      assert(!$(".modal-backdrop") && $(".home") !== null, `Escape did more than close the menu (${onScreen()})`);
      assert(document.activeElement === newBtn, "Escape did not hand focus back to New project");

      // A POINTER open (detail 1) highlights nothing and leaves focus alone.
      // Image project → the New image project dialog, unchanged but retitled.
      newBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      await waitFor(() => menuRows().length === 2 && rendered(menuRows()[1]), 2_000, "the menu again");
      assert(
        !$(".ctx-menu")!.contains(document.activeElement) && !menuRows().some((r) => r.classList.contains("ctx-menu__item--active")),
        "a pointer open highlighted or focused a row",
      );
      menuRows()[1]!.click();
      const header = await waitFor(() => $(".nimg-modal .modal__header"), 3_000, "the New image project dialog");
      assert(text(header) === "New image project", `the dialog is titled "${text(header)}"`);
      $<HTMLButtonElement>(".nimg-modal .modal__footer [data-act='cancel']")!.click();
      await waitFor(() => !$(".nimg-modal"), 2_000, "the New image project dialog to close");
      return `two rows with icon + hint, anchored ${m.top >= b.bottom ? "below" : "above"} the button; a keyboard open starts on Video project, a pointer open on nothing; Escape closes; Image project → "New image project"`;
    } finally {
      closeMenu();
      $<HTMLButtonElement>(".nimg-modal [data-act='cancel']")?.click();
    }
  });

  await test("home-open-as", async () => {
    const t0 = performance.now();
    const made: string[] = [];
    try {
      for (const f of [ALPHA, GRID, VIDEO]) {
        assert(await ipc.pathExists(f), `fixture missing: ${baseName(f)} — run npm run fixtures`);
      }
      await freshHome();
      const dev = homeDev();
      assert(dev !== undefined, "Home published no __tarotingHomeDev hook");
      const dialog = (): HTMLElement | null => $(".openas-modal");
      const opt = (kind: string): HTMLButtonElement => $<HTMLButtonElement>(`.openas-modal [data-kind="${kind}"]`)!;
      const waitDialog = (what: string): Promise<HTMLElement> =>
        waitFor(() => (rendered(dialog()) ? dialog() : null), 3_000, `the Open as dialog (${what}) — ${onScreen()}`);
      const waitClosed = (what: string): Promise<boolean> =>
        waitFor(() => !dialog(), 2_000, `the Open as dialog to close (${what})`);

      // 1. Two pictures: both choices, focus on the first, Cancel does nothing.
      dev!.open([GRID, ALPHA]);
      await waitDialog("two pictures");
      assert(text($(".openas-modal .modal__header")) === "Open 2 files as", `titled "${text($(".openas-modal .modal__header"))}"`);
      for (const k of ["video", "image"]) {
        assert(rendered(opt(k)) && !opt(k).disabled, `${k}: not an enabled, rendered choice`);
        assert(hitsItself(opt(k)), `${k}: the choice is not what paints at its centre`);
      }
      assert($(".openas-reason") === null, "a reason is shown for two pictures");
      assert(document.activeElement === opt("video"), `focus is on ${document.activeElement?.className ?? "nothing"}, not Video project`);
      $<HTMLButtonElement>(".openas-modal .modal__footer [data-act='cancel']")!.click();
      await waitClosed("Cancel");
      assert($(".home") !== null && !$("#vw") && !$(".editor"), `Cancel left Home (${onScreen()})`);

      // 2. A picture and a video: Image project off, its reason under it.
      dev!.open([ALPHA, VIDEO]);
      await waitDialog("a picture and a video");
      assert(opt("image").disabled, "Image project is enabled with a video among the files");
      assert(!opt("video").disabled, "Video project is disabled");
      const reason = $(".openas-reason");
      assert(rendered(reason), "the reason is not rendered");
      assert(
        text(reason) === "Image projects hold pictures only. 1 of these is a video.",
        `the reason reads "${text(reason)}"`,
      );
      assert(
        reason!.getBoundingClientRect().top >= opt("image").getBoundingClientRect().bottom - 1,
        "the reason is not under Image project",
      );
      opt("image").click();
      await sleep(50);
      assert(rendered(dialog()), "clicking the disabled Image project closed the dialog");
      // A drop while the dialog is up is refused, never a second dialog.
      dev!.drop([GRID, VIDEO]);
      await sleep(50);
      assert($$(".modal-backdrop").length === 1, `a drop over the open dialog made ${$$(".modal-backdrop").length} dialogs`);
      pressEscape();
      await waitClosed("Escape");
      assert(!$("#vw"), "a media Open reached the viewer");

      // 2b. A drop takes the same question as Open.
      dev!.drop([ALPHA, VIDEO]);
      await waitDialog("a dropped picture and video");
      assert(opt("image").disabled && !opt("video").disabled, "a drop's dialog does not match Open's (Image off, Video on)");
      pressEscape();
      await waitClosed("Escape after a drop");

      // 3. A project picked with media: refused with a toast, no dialog.
      const toastBefore = $$(".toast").length;
      dev!.open([ALPHA, fx("nothing here.trt")]);
      await waitFor(
        () => $$(".toast").some((t) => text(t).startsWith("Open one project at a time")),
        1_000,
        `the one-project toast (${$$(".toast").length - toastBefore} new toasts)`,
      );
      assert(!dialog(), "a .trt with media opened the Open as dialog");

      // 4. Image project from two pictures of different sizes, handed over in
      //    the WRONG order: natural order makes the 97x61 one the canvas and
      //    the bottom layer, and the 641x361 one is fitted inside it.
      const before = currentSession.get();
      dev!.open([GRID, ALPHA]);
      await waitDialog("making an image project");
      // The hint names the picture whose size the canvas takes.
      const imageHint = text(opt("image").querySelector(".ctx-menu__hint"));
      assert(imageHint.endsWith(`the size of ${baseName(ALPHA)}`), `the Image project hint reads "${imageHint}"`);
      opt("image").click();
      // Synchronously, before the probes can finish: the dialog stays up and
      // busy, focus on Cancel, and none of the ways out close it.
      const busyDialog = dialog();
      assert(rendered(busyDialog) && busyDialog!.getAttribute("aria-busy") === "true", `the dialog is not up and busy after the choice (${onScreen()})`);
      assert(opt("video").disabled && opt("image").disabled, "a choice is still enabled while the project is made");
      const cancelBtn = $<HTMLButtonElement>(".openas-modal .modal__footer [data-act='cancel']")!;
      assert(document.activeElement === cancelBtn, `focus is on ${document.activeElement?.textContent ?? "nothing"}, not Cancel, while busy`);
      pressEscape();
      cancelBtn.click();
      assert(dialog() === busyDialog, "Escape or Cancel closed the dialog while the project was being made");
      const session = await waitFor(
        () => {
          const s = currentSession.get();
          return s && s !== before && $(".imged") ? s : null;
        },
        10_000,
        `the image editor on the new project — ${onScreen()}`,
      );
      const path = session.path;
      made.push(path);
      assert(!session.temp.get() && !(await isTempProjectPath(path)), `the project is temporary: ${path}`);
      const disk: ProjectFile = (await ipc.loadProject(path)).project;
      assert(disk.kind === "image", `the saved project is kind ${String(disk.kind)}`);
      assert(
        disk.timeline.width === 97 && disk.timeline.height === 61,
        `the canvas is ${disk.timeline.width}x${disk.timeline.height}, not the first picture's 97x61`,
      );
      const tracks = disk.timeline.tracks;
      assert(tracks.length === 2, `${tracks.length} layers, not 2`);
      const mediaOf = (i: number) => disk.media.find((x) => x.id === tracks[i]!.clips[0]!.mediaId);
      assert(norm(mediaOf(1)?.path ?? "") === norm(ALPHA), `the bottom layer is ${baseName(mediaOf(1)?.path ?? "none")}`);
      assert(norm(mediaOf(0)?.path ?? "") === norm(GRID), `the top layer is ${baseName(mediaOf(0)?.path ?? "none")}`);
      const fit = Math.min(1, 97 / 641, 61 / 361);
      const topScale = tracks[0]!.clips[0]!.transform?.scale ?? NaN;
      const bottomScale = tracks[1]!.clips[0]!.transform?.scale ?? NaN;
      assert(Math.abs(topScale - fit) < 1e-9, `the larger picture's scale is ${topScale}, not ${fit.toFixed(4)}`);
      assert(bottomScale === 1, `the first picture's scale is ${bottomScale}, not 1`);
      const inRecents = (await ipc.listRecents()).items.some((i) => norm(i.path) === norm(path));
      assert(inRecents, "the new image project is not in recents");
      assert(!dialog() && $$(".modal-backdrop").length === 0, `the Open as dialog outlived Home (${onScreen()})`);

      // 5. That project dropped on Home together with a picture: the project
      //    opens, and a toast says the picture was not opened.
      await freshHome();
      const beforeDrop = currentSession.get();
      homeDev()!.drop([ALPHA, path]);
      // The toast first: it is shown the moment Home navigates and lives
      // 3.5 s, which the image editor's mount must not be allowed to eat.
      const notOpened = "Opened the project. The other file was not opened.";
      await waitFor(() => $$(".toast").some((t) => text(t).includes(notOpened)), 3_000, `the not-opened toast after a mixed drop — ${onScreen()}`);
      await waitFor(
        () => {
          const s = currentSession.get();
          return s && s !== beforeDrop && norm(s.path) === norm(path) && $(".imged") ? s : null;
        },
        10_000,
        `the dropped project to open — ${onScreen()}`,
      );
      return `2 pictures → both choices, focus on Video; picture + video → Image off ("${text(reason)}"); .trt + media → toast; Image project (hint names ${baseName(ALPHA)}, busy until made) → ${baseName(path)} ${disk.timeline.width}x${disk.timeline.height}, 2 layers, top scale ${topScale.toFixed(4)}; project + picture dropped → opens, "${notOpened}" — ${Math.round(performance.now() - t0)} ms`;
    } finally {
      try {
        await freshHome();
      } catch (e) {
        console.error("home autotest: cleanup did not reach Home", e);
      }
      // The image editor renders a card picture as it is left; delete it with
      // the project.
      const recents = await ipc.listRecents().catch(() => ({ items: [] as { path: string; thumb?: string | null }[] }));
      for (const p of made) {
        const thumb = recents.items.find((i) => norm(i.path) === norm(p))?.thumb;
        await ipc.deleteProject(p).catch(() => {});
        if (thumb) await ipc.deleteProject(thumb).catch(() => {});
      }
    }
  });
}
