// Home's "New image project" dialog (New project → Image project): a blank
// canvas (a preset size or a custom one, and a background) or a photo, created
// as an image project and opened.
//
// Its own lazy chunk (Home imports it on that choice), and it must NEVER import
// anything under src/image/: that would drag the image editor in with it.
// Project creation goes through core/image-project.ts. The rows, segmented
// control and number fields are the video export dialog's own classes, so the
// two dialogs cannot drift apart in look; home.css carries only what that
// sheet has no rule for.
//
// These projects are PERMANENT (Documents\Taroting, in recents), exactly like
// Home's "New project": a temporary project is what an Explorer open makes.
//
// The app's modal pattern, whole: .modal-backdrop + .modal, trapTab released
// on EVERY close path, Escape / backdrop / X / Cancel close, focus seated on
// the primary action.

import "../editor/export/export.css";
import { escapeHtml, fileExt, fileStem } from "../core/format";
import {
  IMAGE_BLANK_PRESETS,
  createBlankImageProject,
  createPhotoImageProject,
} from "../core/image-project";
import { describeError, ipc, pickImageFile } from "../core/ipc";
import { stillSizeProblem } from "../core/open-media";
import { normalizeHexColor } from "../core/session";
import { IMAGE_CANVAS_MAX_SIDE, mediaFamilyOf } from "../core/types";
import type { MediaInfo } from "../core/types";
import type { ColorPickerHandle } from "../ui/color-picker";
import { focusFirst, trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

/* ---------------- pure pieces (exported for the tests) ---------------- */

/** The Size select's value for "Custom"; every preset is its index. */
export const CUSTOM_SIZE = "custom";

/** A typed canvas side: an integer in [1, IMAGE_CANVAS_MAX_SIDE], else null.
 *  "12.5", "0", "", "1e9", "-3" and "0x10" are all refused — a side is a pixel
 *  count, never rounded or clamped behind the user's back. Leading zeros are
 *  fine ("0640" is 640); seven digits never are. */
export function parseCanvasSide(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= IMAGE_CANVAS_MAX_SIDE ? n : null;
}

/** The Size select (a preset index or CUSTOM_SIZE) plus the two custom fields
 *  → the canvas, or null when there is nothing valid to create. The custom
 *  fields are read ONLY for Custom: a stale half-typed value behind a preset
 *  must not block Create. */
export function resolveCanvasSize(
  choice: string,
  customW: string,
  customH: string,
): { w: number; h: number } | null {
  if (choice === CUSTOM_SIZE) {
    const w = parseCanvasSide(customW);
    const h = parseCanvasSide(customH);
    return w !== null && h !== null ? { w, h } : null;
  }
  // Digits only: Number("") is 0, which would quietly read as the first preset.
  if (!/^\d{1,3}$/.test(choice)) return null;
  const p = IMAGE_BLANK_PRESETS[Number(choice)];
  return p ? { w: p.w, h: p.h } : null;
}

/** The four regulars of the Background control. */
export type BackgroundChoice = "transparent" | "white" | "black" | "colour";

/** What "Color" starts on before anything was picked: a neutral grey, which
 *  is neither of the two regulars beside it. */
export const DEFAULT_PICK = "#808080";

/** A Background choice (and the picked colour, read only for "colour") → the
 *  project's `image.background`: "transparent" or a lowercase #rrggbb. */
export function backgroundOf(choice: BackgroundChoice, picked: string): string {
  switch (choice) {
    case "transparent":
      return "transparent";
    case "white":
      return "#ffffff";
    case "black":
      return "#000000";
    case "colour":
      // The picker only ever hands back a valid colour; validated anyway, as
      // at every other colour sink, since this lands in the saved project.
      return normalizeHexColor(picked, DEFAULT_PICK);
  }
}

/** Why a probed file cannot become a photo project, or null when it can. The
 *  picker filters to stills, but the filter can be typed around ("*.*"), and a
 *  file named .png may probe as something else entirely. The size half is
 *  open-media's own check (Explorer's and the viewer's way in asks the same
 *  one), so the two can never disagree about which photo is usable. */
export function photoProblem(info: MediaInfo): string | null {
  if (info.kind !== "image" || info.generator) return "Pick a still image.";
  return stillSizeProblem(info);
}

/** Whether Cancel, X, Escape or the backdrop may close the dialog right now.
 *  While the OS file picker is up nothing has been decided yet, so they may
 *  (the pick is dropped when it returns). Past it, a creation is writing a
 *  project into Documents and recents: closing then would leave a project
 *  made silently behind a dialog the user believes they cancelled, so they
 *  are ignored until the write settles one way or the other. */
export function dismissible(busy: boolean, inFilePicker: boolean): boolean {
  return !busy || inFilePicker;
}

/** What focusAfterPicker may hand focus to: a live control, never a disabled
 *  one (focus() on it is a no-op and would strand the Tab trap). */
const FOCUSABLE_CONTROL = "button:not(:disabled), select:not(:disabled), input:not(:disabled)";

/** Where focus goes when the colour popover closes. A pointerdown on another
 *  control of the dialog (Transparent, say, or the Size select) closed it,
 *  so focus lands on THAT control, where the click did — the picker removes
 *  its own focused element before telling us, so the document's
 *  activeElement is only <body> by then and cannot say. Anything else (the
 *  backdrop, the popover's own Done, Escape, a scroll) goes back to the
 *  Colour button that opened it. */
export function focusAfterPicker<T>(
  downTarget: { closest(selector: string): T | null } | null,
  dialog: { contains(node: T): boolean },
  colourButton: T,
): T {
  const control = downTarget?.closest(FOCUSABLE_CONTROL) ?? null;
  return control !== null && dialog.contains(control) ? control : colourButton;
}

/** A background shelf for the picker, not its accent hues: papers, greys and
 *  near-blacks. Twelve, the row the popover lays out. */
const BACKGROUND_PRESETS = [
  "#ffffff", "#f6f6f8", "#f4f1ea", "#eef3f8", "#f7eef2", "#edf4ee",
  "#c8c8d2", "#808080", "#55555f", "#1b1b20", "#0d1117", "#000000",
];

const BG_LABELS: Record<BackgroundChoice, string> = {
  transparent: "Transparent",
  white: "White",
  black: "Black",
  colour: "Color",
};

/* ---------------- the dialog ---------------- */

/** Opens the dialog and returns its closer, for Home's `openOverlays`.
 *  `onCreated` receives the new project's path; `isDisposed` is checked after
 *  every await, so a Home that has gone away is never navigated from.
 *  `onClosed` runs once, last, on EVERY close path (so Home can drop its
 *  closer, and the detached dialog with it, on a Cancel too). The closer is
 *  idempotent and always closes — it is Home's teardown, which must win even
 *  over a creation mid-write. */
export function openNewImageDialog(opts: {
  onCreated(projectPath: string): void;
  onClosed?(): void;
  isDisposed(): boolean;
}): () => void {
  let sizeChoice = "0";
  let bg: BackgroundChoice = "white";
  let picked = DEFAULT_PICK;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop nimg-backdrop";
  backdrop.innerHTML = `
    <div class="modal nimg-modal" role="dialog" aria-modal="true" aria-label="New image project">
      <div class="modal__header">
        <span>New image project</span>
        <button class="btn btn--ghost btn--icon btn--sm" data-act="cancel" title="Close" aria-label="Close">${icon("x", 14)}</button>
      </div>
      <div class="modal__body">
        <div class="export-form">
          <div class="export-row">
            <label for="nimg-size">Size</label>
            <div class="export-row__control">
              <select class="select" id="nimg-size">
                ${IMAGE_BLANK_PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p.label)}</option>`).join("")}
                <option value="${CUSTOM_SIZE}">Custom</option>
              </select>
            </div>
          </div>
          <div class="export-row export-row--hidden" id="nimg-custom">
            <label for="nimg-w">Width × height</label>
            <div class="export-row__control">
              <input class="input export-num" id="nimg-w" type="number" min="1" max="${IMAGE_CANVAS_MAX_SIDE}" step="1" aria-label="Width" />
              <span class="export-dim-x" aria-hidden="true">×</span>
              <input class="input export-num" id="nimg-h" type="number" min="1" max="${IMAGE_CANVAS_MAX_SIDE}" step="1" aria-label="Height" />
              <span class="export-dim-x">px</span>
            </div>
          </div>
          <div class="export-note" id="nimg-hint" hidden>Enter whole pixels from 1 to ${IMAGE_CANVAS_MAX_SIDE}.</div>
          <div class="export-row">
            <label id="nimg-bg-label">Background</label>
            <div class="export-seg" id="nimg-bg" role="group" aria-labelledby="nimg-bg-label">
              ${(Object.keys(BG_LABELS) as BackgroundChoice[])
                .map(
                  (b) =>
                    `<button class="btn" data-bg="${b}" aria-pressed="false"><span class="nimg-swatch nimg-swatch--${b}" aria-hidden="true"></span>${BG_LABELS[b]}</button>`,
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>
      <div class="modal__footer">
        <button class="btn nimg-from-photo" data-act="photo" title="Start from a photo on your disk">${icon("image", 14)}From a photo</button>
        <button class="btn" data-act="cancel" id="nimg-cancel">Cancel</button>
        <button class="btn btn--primary" data-act="create">Create</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const $ = <T extends HTMLElement>(sel: string): T => backdrop.querySelector<T>(sel)!;
  const sizeSel = $<HTMLSelectElement>("#nimg-size");
  const customRow = $<HTMLElement>("#nimg-custom");
  const wIn = $<HTMLInputElement>("#nimg-w");
  const hIn = $<HTMLInputElement>("#nimg-h");
  const hint = $<HTMLElement>("#nimg-hint");
  const bgSeg = $<HTMLElement>("#nimg-bg");
  const colourBtn = $<HTMLButtonElement>('[data-bg="colour"]');
  const colourSwatch = $<HTMLElement>(".nimg-swatch--colour");
  const createBtn = $<HTMLButtonElement>('[data-act="create"]');
  const photoBtn = $<HTMLButtonElement>('[data-act="photo"]');
  const cancelBtn = $<HTMLButtonElement>("#nimg-cancel");
  sizeSel.value = sizeChoice;

  let closed = false;
  let busy = false;
  /** Set only across the await on the OS file picker — see dismissible(). */
  let inFilePicker = false;
  let picker: ColorPickerHandle | null = null;
  let pickerLoading = false;
  /** Whether the picker was open when the current pointerdown started — see
   *  onDocPointerDown. */
  let pickerAtDown = false;
  /** What the latest pointerdown landed on, for focusAfterPicker. Cleared by
   *  any key and after each use, so it never outlives the gesture it names. */
  let downTarget: Element | null = null;
  const gone = (): boolean => closed || opts.isDisposed();

  /* -------- painting: every write only on an actual change -------- */

  /** The swatch colour last written, so paint() writes it only on a change. */
  let paintedSwatch = "";
  function paint(): void {
    const custom = sizeChoice === CUSTOM_SIZE;
    if (customRow.classList.contains("export-row--hidden") === custom) {
      customRow.classList.toggle("export-row--hidden", !custom);
    }
    const dims = resolveCanvasSize(sizeChoice, wIn.value, hIn.value);
    const bad = custom && dims === null;
    if (hint.hidden === bad) hint.hidden = !bad;
    const createOff = busy || dims === null;
    if (createBtn.disabled !== createOff) createBtn.disabled = createOff;
    if (photoBtn.disabled !== busy) photoBtn.disabled = busy;
    for (const b of bgSeg.querySelectorAll<HTMLElement>("[data-bg]")) {
      const pressed = b.dataset.bg === bg ? "true" : "false";
      if (b.getAttribute("aria-pressed") === pressed) continue;
      b.setAttribute("aria-pressed", pressed);
      b.classList.toggle("btn--on", pressed === "true");
    }
    // Through the CSSOM, never a style attribute: the packaged CSP refuses
    // those outright (see the note above `colorRow` in settings.ts). Compared
    // against the last value written, not read back: the engine reports a set
    // colour as rgb(), so a read-back test would never match.
    const swatch = normalizeHexColor(picked, DEFAULT_PICK);
    if (swatch !== paintedSwatch) {
      paintedSwatch = swatch;
      colourSwatch.style.background = swatch;
    }
  }

  /* -------- lifecycle -------- */

  const releaseTrap = trapTab(backdrop);
  // One exit for every path — X, Cancel, Escape, the backdrop, a finished
  // Create, Home's teardown — so the trap, both listeners and the picker are
  // released on all of them.
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    releaseTrap();
    picker?.close();
    picker = null;
    backdrop.remove();
    opts.onClosed?.();
  };
  // The user's ways out (X, Cancel, Escape, the backdrop) go through here;
  // close() itself stays unconditional for finish() and Home's teardown.
  const dismiss = (): void => {
    if (dismissible(busy, inFilePicker)) close();
  };

  function onKey(e: KeyboardEvent): void {
    downTarget = null;
    // The picker handles its own Escape (a real cancel back to the colour it
    // opened on). Both listeners sit on the document's capture phase and this
    // one was registered first, so without the early return one Escape would
    // close the whole dialog out from under the popover.
    if (e.key !== "Escape" || picker) return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  }
  // The picker dismisses itself on any pointerdown outside it, in the capture
  // phase — which runs BEFORE the backdrop's own listener below. Without this
  // note taken first, a click on the backdrop meant only to put the popover
  // away would close the whole dialog too. Registered before any picker can
  // exist, so it always runs ahead of the picker's listener — and so it has
  // also noted WHAT was pressed by the time the picker's onClose asks.
  function onDocPointerDown(e: PointerEvent): void {
    pickerAtDown = picker !== null;
    downTarget = e.target instanceof Element ? e.target : null;
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop && !pickerAtDown) dismiss();
  });
  for (const b of backdrop.querySelectorAll('[data-act="cancel"]')) b.addEventListener("click", dismiss);

  /* -------- size -------- */

  sizeSel.addEventListener("change", () => {
    const prev = resolveCanvasSize(sizeChoice, wIn.value, hIn.value);
    sizeChoice = sizeSel.value;
    // Custom opens on the size that was showing, so a small change to a
    // preset is a small edit rather than two fields typed from scratch.
    if (sizeChoice === CUSTOM_SIZE && prev) {
      wIn.value = String(prev.w);
      hIn.value = String(prev.h);
    }
    paint();
    if (sizeChoice === CUSTOM_SIZE) {
      wIn.focus();
      wIn.select();
    }
  });
  const onDims = (): void => paint();
  wIn.addEventListener("input", onDims);
  hIn.addEventListener("input", onDims);
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void create();
  };
  wIn.addEventListener("keydown", onEnter);
  hIn.addEventListener("keydown", onEnter);

  /* -------- background -------- */

  bgSeg.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-bg]");
    if (!btn) return;
    const next = btn.dataset.bg as BackgroundChoice;
    if (next !== "colour") {
      picker?.close();
      bg = next;
      paint();
      return;
    }
    // Colour toggles its popover: the picker treats its anchor as "inside",
    // so a second click lands here rather than dismissing it.
    if (picker) {
      picker.close();
      return;
    }
    bg = "colour";
    paint();
    void openPicker();
  });

  async function openPicker(): Promise<void> {
    if (pickerLoading) return;
    pickerLoading = true;
    try {
      // Loaded on the click, like every other opener of the picker: nothing of
      // it is parsed until someone actually wants a colour.
      const { openColorPicker } = await import("../ui/color-picker");
      if (gone() || picker || bg !== "colour") return;
      picker = openColorPicker({
        anchor: colourBtn,
        value: picked,
        defaultValue: DEFAULT_PICK,
        label: "Background color",
        presets: BACKGROUND_PRESETS,
        onPreview(hex) {
          picked = hex;
          paint();
        },
        onCommit(hex) {
          picked = normalizeHexColor(hex, DEFAULT_PICK);
          if (!closed) paint();
        },
        onClose() {
          picker = null;
          // The popover took focus with it; hand it back inside the dialog —
          // to the control whose press closed it, else to Colour — or the
          // dialog's Tab trap (a listener on the backdrop) never sees another
          // key.
          const to = focusAfterPicker<Element>(downTarget, backdrop, colourBtn);
          downTarget = null;
          if (!closed && to instanceof HTMLElement) to.focus();
        },
      });
    } catch (e) {
      if (!gone()) toast.error("Couldn't open the color picker.", { detail: describeError(e), op: "New image project" });
    } finally {
      pickerLoading = false;
    }
  }

  /* -------- create -------- */

  /** Runs one creation at a time, with both actions disabled while it does:
   *  a double click on Create must never make two projects.
   *
   *  Focus moves to the footer Cancel BEFORE paint() disables the actions:
   *  disabling the focused button drops focus to <body>, and the Tab trap only
   *  hears keys from inside the dialog, so after a cancelled photo pick (the
   *  usual way here), a refusal or a failed save Tab walked Home behind the
   *  backdrop. Cancel is never disabled. Once the task settles with the dialog
   *  still up, focus goes back to where it was (the button pressed, or the
   *  size field Enter was typed in) if it is still parked on Cancel or was
   *  lost; one the user moved on purpose stays where they put it. */
  async function run(task: () => Promise<void>): Promise<void> {
    if (busy || closed) return;
    busy = true;
    const before = document.activeElement;
    cancelBtn.focus();
    paint();
    try {
      await task();
    } catch (e) {
      if (!gone()) toast.error(describeError(e));
    } finally {
      busy = false;
      if (!closed) {
        paint();
        const now = document.activeElement;
        if (now === cancelBtn || now === null || !backdrop.contains(now)) {
          const back = before !== null && backdrop.contains(before) ? (before as HTMLElement) : null;
          if (back && !(back as HTMLButtonElement).disabled) back.focus();
          else focusFirst(backdrop, '[data-act="create"]');
        }
      }
    }
  }

  /** Save, then leave: the dialog closes BEFORE the navigation so nothing of
   *  it outlives Home. The user cannot close the dialog while the save runs
   *  (see dismissible()); a Home torn down meanwhile navigates nowhere — the
   *  file is written and in recents already, one click away, and whatever
   *  replaced the screen is the newer intent. */
  function finish(projectPath: string): void {
    if (gone()) return;
    close();
    opts.onCreated(projectPath);
  }

  function create(): Promise<void> {
    // Nothing valid to create (Enter in a half-typed size field): nothing to
    // run, and focus stays in the field being typed in.
    if (!resolveCanvasSize(sizeChoice, wIn.value, hIn.value)) return Promise.resolve();
    return run(async () => {
      const dims = resolveCanvasSize(sizeChoice, wIn.value, hIn.value);
      if (!dims) return;
      const background = backgroundOf(bg, picked);
      const projectPath = await ipc.newProjectPath("Untitled image");
      if (gone()) return;
      const project = createBlankImageProject(fileStem(projectPath), dims.w, dims.h, background);
      await ipc.saveProject(projectPath, project);
      finish(projectPath);
    });
  }

  function fromPhoto(): Promise<void> {
    return run(async () => {
      picker?.close();
      // Until the OS picker returns, the dialog may still be cancelled (the
      // pick is then dropped); from here on it is committed — dismissible().
      inFilePicker = true;
      let photo: string | null;
      try {
        photo = await pickImageFile();
      } finally {
        inFilePicker = false;
      }
      if (gone() || !photo) return;
      const stem = fileStem(photo);
      // The picker's filter can be typed around; the family is applied here
      // too, as it is on every other way in, before anything reads the file.
      if (mediaFamilyOf(fileExt(photo)) !== "image") {
        toast.refuse("Pick a still image.");
        return;
      }
      let info: MediaInfo;
      try {
        info = await ipc.probeMedia(photo);
      } catch (e) {
        if (!gone()) toast.error(`Couldn't open ${stem}: ${describeError(e)}`);
        return;
      }
      if (gone()) return;
      const problem = photoProblem(info);
      if (problem) {
        toast.refuse(problem);
        return;
      }
      const projectPath = await ipc.newProjectPath(stem);
      if (gone()) return;
      await ipc.saveProject(projectPath, createPhotoImageProject(fileStem(projectPath), info));
      finish(projectPath);
    });
  }

  createBtn.addEventListener("click", () => void create());
  photoBtn.addEventListener("click", () => void fromPhoto());

  paint();
  focusFirst(backdrop, '[data-act="create"]');
  return close;
}
