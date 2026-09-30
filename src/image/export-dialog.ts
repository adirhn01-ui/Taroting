// The image export dialog: format, quality and size, the source-file guard,
// then render → save with progress and cancel.
//
// Built from the video export dialog's own parts — the same `.export-*` rows,
// segmented control, overwrite strip, progress bar and result views, the same
// file-name helpers and overwrite rules, and the same run hold (core/app-close)
// — so the two read as one app. What differs is only what an image needs:
// quality, a size in pixels, and the canvas limits of the engine that renders
// it.

import "../editor/export/export.css";
import "./export-dialog.css";
import { registerCloseTask } from "../core/app-close";
import { createExportRunHold } from "../core/export-hold";
import { escapeHtml, fileExt } from "../core/format";
import { errorDetail } from "../core/ipc";
import { settingsStore, updateSettings, type ProjectSession } from "../core/session";
import type { ImageExportFormat, ImageExportPreset, ProjectFile, Settings } from "../core/types";
import {
  isProjectSource,
  joinPath,
  RENAME_ATTEMPT_LIMIT,
  renameWithSuffix,
  sanitizeFileName,
  splitPath,
} from "../editor/export/export-dialog";
import {
  clearTaskbarProgress,
  pathExists,
  revealInExplorer,
  saveFileDialog,
  setTaskbarProgress,
} from "../editor/export/export-ipc";
import { detailPane, recordError } from "../ui/errors";
import { focusFirst, trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import type { ImageEditorCtx } from "./context";
import { maxRenderSize, outputSize, renderImageExport, webpFits } from "./render/export";
import { saveBlob } from "./save";

/** Where the project's first photo came from, for the default name
 *  (`<stem> (edited)`) and format. `ext` null = no photo, or one whose format
 *  the export does not write (then PNG). */
export interface ExportSourceHint {
  stem: string;
  ext: "png" | "jpg" | "webp" | null;
}

/* ---------------- pure helpers (tested) ---------------- */

export const IMAGE_FORMATS: readonly { value: ImageExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

/** The file extension an export format is written with. */
export function extForImageFormat(format: ImageExportFormat): "png" | "jpg" | "webp" {
  return format === "jpeg" ? "jpg" : format;
}

/** Quality a lossy format opens on when nothing was chosen before. */
export const DEFAULT_QUALITY = 92;
/** Above this many output pixels the dialog warns that it may take a while. */
export const LARGE_EXPORT_PX = 50_000_000;

export const WEBP_TOO_LARGE = "WebP can't be larger than 16383 px on a side.";
export const ORIGINAL_FILE_WARNING = "That's the original file — choose a different name. Originals are never changed.";
export const METADATA_NOTE = "Location and camera details are not included in the exported file.";

/** The quality readout: WebP at 100 is the engine's lossless mode (quality
 *  1.0 → VP8L, measured on WebView2 152 and pinned by the
 *  image-export-roundtrip E2E block, which fails if an engine update stops
 *  writing VP8L), and says so. */
export function qualityReadout(format: ImageExportFormat, quality: number): string {
  return format === "webp" && quality >= 100 ? "Lossless" : String(quality);
}

/** A persisted `image.export` (a value out of a `.trt`, so untrusted) as a
 *  clean preset, or null when it is not one. */
export function sanitizeImagePreset(raw: unknown): ImageExportPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const format = IMAGE_FORMATS.some((f) => f.value === o.format) ? (o.format as ImageExportFormat) : null;
  if (!format) return null;
  const q = typeof o.quality === "number" && Number.isFinite(o.quality) ? Math.round(o.quality) : DEFAULT_QUALITY;
  const quality = Math.min(100, Math.max(1, q));
  let size: ImageExportPreset["size"] = 100;
  const s = o.size;
  if (s === 100 || s === 50 || s === 25) size = s;
  else if (s && typeof s === "object") {
    const w = (s as { w?: unknown }).w;
    const h = (s as { h?: unknown }).h;
    if (typeof w === "number" && typeof h === "number" && Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1) {
      size = { w: Math.round(w), h: Math.round(h) };
    }
  }
  return { format, quality, size };
}

/** The preset the dialog opens on: the project's last one, else one that
 *  follows the source photo's format (a JPEG stays a JPEG). */
export function defaultImagePreset(project: ProjectFile, hint: ExportSourceHint): ImageExportPreset {
  const saved = sanitizeImagePreset(project.image?.export);
  if (saved) return saved;
  if (hint.ext === "jpg") return { format: "jpeg", quality: DEFAULT_QUALITY, size: 100 };
  if (hint.ext === "webp") return { format: "webp", quality: DEFAULT_QUALITY, size: 100 };
  return { format: "png", quality: DEFAULT_QUALITY, size: 100 };
}

/** `<stem> (edited)` — never the original's own name — or the project name
 *  for an image with no photo. */
export function defaultFileName(project: ProjectFile, hint: ExportSourceHint): string {
  const stem = hint.stem.trim();
  return sanitizeFileName(stem ? `${stem} (edited)` : project.name);
}

/** Every file the project reads, from the project AS IT IS NOW — a layer added
 *  since the last save included — for the backend's refuse-the-original check. */
export function exportSources(project: ProjectFile): string[] {
  return project.media.filter((m) => !m.generator && typeof m.path === "string" && m.path !== "").map((m) => m.path);
}

/** Last export folder, else the default one, else the first photo's folder. */
export function defaultFolder(settings: Pick<Settings, "lastExportDir" | "defaultExportDir">, project: ProjectFile): string {
  if (settings.lastExportDir) return settings.lastExportDir;
  if (settings.defaultExportDir) return settings.defaultExportDir;
  const first = exportSources(project)[0];
  return first ? splitPath(first).dir : "";
}

export interface OutputPlan {
  /** what the size setting asks for */
  requested: { w: number; h: number };
  /** what will actually be rendered (requested, fitted to the engine's limits) */
  out: { w: number; h: number };
  reduced: boolean;
  webpOk: boolean;
  large: boolean;
}

export function planOutput(size: ImageExportPreset["size"], canvasW: number, canvasH: number): OutputPlan {
  const requested = outputSize(size, canvasW, canvasH);
  const fit = maxRenderSize(requested.w, requested.h);
  const out = { w: fit.w, h: fit.h };
  return {
    requested,
    out,
    reduced: fit.reduced,
    webpOk: webpFits(out.w, out.h),
    large: out.w * out.h > LARGE_EXPORT_PX,
  };
}

/** The other side of an aspect-locked custom size. */
export function lockedSide(typed: number, typedCanvas: number, otherCanvas: number): number {
  return Math.max(1, Math.round((typed * otherCanvas) / typedCanvas));
}

function samePreset(a: ImageExportPreset | undefined, b: ImageExportPreset): boolean {
  if (!a || a.format !== b.format || a.quality !== b.quality) return false;
  if (typeof a.size === "number" || typeof b.size === "number") return a.size === b.size;
  return a.size.w === b.size.w && a.size.h === b.size.h;
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
}

/** Inline check icon (the video dialog's, not part of the shared icon set). */
function checkIcon(size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
}

/* ---------------- dialog ---------------- */

/** The open dialog's closer: opening a second one closes the first. */
let openCloser: (() => void) | null = null;

/** Opens the dialog (closing one already open first) and returns its closer.
 *  The closer aborts a running export, so the editor registers it with
 *  `ctx.registerOverlay` and dispose() can never leave an export running. */
export function openImageExportDialog(ctx: ImageEditorCtx, sourceHint: ExportSourceHint): () => void {
  openCloser?.();
  const session: ProjectSession = ctx.session;

  const start = defaultImagePreset(session.project, sourceHint);
  let format: ImageExportFormat = start.format;
  let quality = start.quality;
  let size: ImageExportPreset["size"] = start.size;
  let filename = defaultFileName(session.project, sourceHint);
  let folder = defaultFolder(settingsStore.get(), session.project);

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal export-modal" role="dialog" aria-modal="true" aria-label="Export image">
      <div class="modal__header">
        <span>Export image</span>
        <button class="btn btn--ghost btn--icon btn--sm" data-close title="Close">${icon("x", 14)}</button>
      </div>
      <div class="modal__body" id="ix-body"></div>
      <div class="modal__footer" id="ix-footer"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const bodyEl = backdrop.querySelector<HTMLElement>("#ix-body")!;
  const footerEl = backdrop.querySelector<HTMLElement>("#ix-footer")!;
  const releaseTrap = trapTab(backdrop);

  let exporting = false;
  let closed = false;
  let run: AbortController | null = null;
  let running: Promise<void> | null = null;
  let lastTaskbarPct = -1;

  // The same hold the video export takes: an OS open refuses while it runs,
  // and closing the window cancels it (and waits for the cancel to land).
  const runHold = createExportRunHold(session, registerCloseTask, async () => {
    run?.abort();
    await running?.catch(() => {});
  });

  const unregisterOverlay = ctx.registerOverlay(() => forceClose());

  function teardown(): void {
    if (closed) return;
    closed = true;
    runHold.release();
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    unregisterOverlay();
    if (lastTaskbarPct !== -1) void clearTaskbarProgress();
    backdrop.remove();
    if (openCloser === forceClose) openCloser = null;
  }

  /** Esc, the backdrop, X, Cancel and Close: never while an export runs. */
  function close(): void {
    if (exporting) return;
    teardown();
  }

  /** The editor going away (or a second dialog opening): abort a running
   *  export and close regardless. */
  function forceClose(): void {
    if (closed) return;
    run?.abort();
    exporting = false;
    teardown();
  }
  openCloser = forceClose;

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (exporting) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  document.addEventListener("keydown", onKeydown, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("[data-close]")!.addEventListener("click", () => close());

  const q = <T extends HTMLElement>(sel: string): T | null => backdrop.querySelector<T>(sel);

  function preset(): ImageExportPreset {
    return { format, quality, size: typeof size === "object" ? { ...size } : size };
  }
  function plan(): OutputPlan {
    const tl = session.project.timeline;
    return planOutput(size, tl.width, tl.height);
  }
  function currentExt(): string {
    return extForImageFormat(format);
  }
  function outPath(): string {
    return joinPath(folder, `${filename}.${currentExt()}`);
  }

  /* ============================ FORM ============================ */

  function renderForm(): void {
    const tl = session.project.timeline;
    const custom = typeof size === "object";
    const cw = custom ? (size as { w: number; h: number }).w : outputSize(size, tl.width, tl.height).w;
    const ch = custom ? (size as { w: number; h: number }).h : outputSize(size, tl.width, tl.height).h;
    const sizeValue = custom ? "custom" : String(size);
    bodyEl.innerHTML = `
      <div class="export-form">
        <div class="export-row">
          <label>Format</label>
          <div class="export-seg" id="ix-format">
            ${IMAGE_FORMATS.map(
              (f) => `<button class="btn ${f.value === format ? "btn--on" : ""}" data-format="${f.value}">${f.label}</button>`,
            ).join("")}
          </div>
        </div>

        <div class="export-row" id="ix-quality-row">
          <label for="ix-quality">Quality</label>
          <div class="export-row__control imgx-quality">
            <input class="slider" id="ix-quality" type="range" min="1" max="100" step="1" value="${quality}" />
            <span class="mono imgx-quality__value" id="ix-quality-value"></span>
          </div>
        </div>

        <div class="export-row">
          <label for="ix-size">Size</label>
          <div class="export-row__control">
            <select class="select" id="ix-size">
              <option value="100" ${sizeValue === "100" ? "selected" : ""}>100%</option>
              <option value="50" ${sizeValue === "50" ? "selected" : ""}>50%</option>
              <option value="25" ${sizeValue === "25" ? "selected" : ""}>25%</option>
              <option value="custom" ${custom ? "selected" : ""}>Custom</option>
            </select>
            <span class="export-row__control ${custom ? "" : "export-row--hidden"}" id="ix-custom">
              <input class="input export-num" id="ix-w" type="number" min="1" step="1" value="${cw}" aria-label="Width" />
              <span class="export-dim-x">×</span>
              <input class="input export-num" id="ix-h" type="number" min="1" step="1" value="${ch}" aria-label="Height" />
            </span>
            <span class="mono imgx-px ${custom ? "export-row--hidden" : ""}" id="ix-px"></span>
          </div>
        </div>
        <div class="export-note" id="ix-note-webp" hidden>${escapeHtml(WEBP_TOO_LARGE)}</div>
        <div class="export-note" id="ix-note-reduced" hidden></div>
        <div class="export-note" id="ix-note-large" hidden>Large image — exporting may take a while.</div>

        <div class="export-row">
          <label for="ix-name">File name</label>
          <div class="export-row__control">
            <input class="input" id="ix-name" value="${escapeHtml(filename)}" spellcheck="false" />
            <span class="export-ext" id="ix-ext">.${currentExt()}</span>
          </div>
        </div>

        <div class="export-row">
          <label for="ix-folder">Destination</label>
          <div class="export-row__control">
            <input class="input" id="ix-folder" value="${escapeHtml(folder)}" placeholder="Choose a folder" spellcheck="false" />
            <button class="btn" id="ix-choose">${icon("folder", 14)}Choose</button>
          </div>
        </div>

        <div class="export-outpath" id="ix-outpath"></div>
        <div class="imgx-privacy">${escapeHtml(METADATA_NOTE)}</div>
        <div id="ix-warn-slot"></div>
      </div>
    `;
    footerEl.innerHTML = `
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn--primary" id="ix-run">${icon("export", 14)}Export</button>
    `;
    wireForm();
    refresh();
    // Every paint replaces the focused node; seat focus again so the Tab trap
    // (a listener on the backdrop) keeps seeing keys. Export is the primary
    // action (when WebP-too-large disables it, focusFirst falls back to the first control).
    if (!backdrop.contains(document.activeElement)) {
      focusFirst(backdrop, "#ix-run");
    }
  }

  /** Everything that depends on format / quality / size / name, written in
   *  place (no re-render: the slider keeps its drag). */
  function refresh(): void {
    const p = plan();
    const lossy = format !== "png";
    const qRow = q<HTMLElement>("#ix-quality-row");
    if (qRow) qRow.classList.toggle("export-row--hidden", !lossy);
    const qVal = q<HTMLElement>("#ix-quality-value");
    if (qVal) qVal.textContent = qualityReadout(format, quality);

    const px = q<HTMLElement>("#ix-px");
    if (px) px.textContent = `${p.requested.w} × ${p.requested.h} px`;

    const webpBtn = q<HTMLButtonElement>('[data-format="webp"]');
    if (webpBtn) {
      webpBtn.disabled = !p.webpOk;
      webpBtn.title = p.webpOk ? "" : WEBP_TOO_LARGE;
    }
    const nWebp = q<HTMLElement>("#ix-note-webp");
    if (nWebp) nWebp.hidden = p.webpOk;
    const nRed = q<HTMLElement>("#ix-note-reduced");
    if (nRed) {
      nRed.hidden = !p.reduced;
      nRed.textContent = p.reduced
        ? `This image is larger than the app can render in one piece — it will be exported at ${p.out.w} × ${p.out.h}.`
        : "";
    }
    const nLarge = q<HTMLElement>("#ix-note-large");
    if (nLarge) nLarge.hidden = !p.large;

    const ext = q<HTMLElement>("#ix-ext");
    if (ext) ext.textContent = `.${currentExt()}`;
    const out = q<HTMLElement>("#ix-outpath");
    if (out) out.textContent = outPath();
    const runBtn = q<HTMLButtonElement>("#ix-run");
    if (runBtn) runBtn.disabled = format === "webp" && !p.webpOk;
    // The warning strip is about a name that has since changed.
    const slot = q<HTMLElement>("#ix-warn-slot");
    if (slot && slot.childElementCount) slot.innerHTML = "";
  }

  function wireForm(): void {
    q<HTMLElement>("#ix-format")!.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-format]");
      if (!btn || btn.disabled) return;
      const next = btn.dataset.format as ImageExportFormat;
      if (next === format) return;
      format = next;
      for (const b of backdrop.querySelectorAll<HTMLElement>("[data-format]")) {
        b.classList.toggle("btn--on", b.dataset.format === format);
      }
      refresh();
    });

    const slider = q<HTMLInputElement>("#ix-quality")!;
    slider.addEventListener("input", () => {
      quality = Math.min(100, Math.max(1, Math.round(Number(slider.value) || DEFAULT_QUALITY)));
      refresh();
    });

    const sizeSel = q<HTMLSelectElement>("#ix-size")!;
    sizeSel.addEventListener("change", () => {
      const v = sizeSel.value;
      if (v === "custom") {
        const tl = session.project.timeline;
        size = { w: tl.width, h: tl.height };
      } else {
        size = Number(v) as 100 | 50 | 25;
      }
      const custom = typeof size === "object";
      q<HTMLElement>("#ix-custom")!.classList.toggle("export-row--hidden", !custom);
      q<HTMLElement>("#ix-px")!.classList.toggle("export-row--hidden", custom);
      if (custom) {
        q<HTMLInputElement>("#ix-w")!.value = String((size as { w: number }).w);
        q<HTMLInputElement>("#ix-h")!.value = String((size as { h: number }).h);
      }
      refresh();
    });

    // Aspect-locked: typing one side sets the other from the canvas aspect.
    const wIn = q<HTMLInputElement>("#ix-w")!;
    const hIn = q<HTMLInputElement>("#ix-h")!;
    wIn.addEventListener("input", () => {
      const tl = session.project.timeline;
      const w = Math.max(1, Math.round(Number(wIn.value) || 0));
      const h = lockedSide(w, tl.width, tl.height);
      size = { w, h };
      hIn.value = String(h);
      refresh();
    });
    hIn.addEventListener("input", () => {
      const tl = session.project.timeline;
      const h = Math.max(1, Math.round(Number(hIn.value) || 0));
      const w = lockedSide(h, tl.height, tl.width);
      size = { w, h };
      wIn.value = String(w);
      refresh();
    });

    const nameInput = q<HTMLInputElement>("#ix-name")!;
    nameInput.addEventListener("input", () => {
      filename = nameInput.value;
      refresh();
    });
    nameInput.addEventListener("blur", () => {
      filename = sanitizeFileName(nameInput.value);
      nameInput.value = filename;
      refresh();
    });
    const folderInput = q<HTMLInputElement>("#ix-folder")!;
    folderInput.addEventListener("input", () => {
      folder = folderInput.value;
      refresh();
    });
    q<HTMLElement>("#ix-choose")!.addEventListener("click", () => void chooseDestination());
    q<HTMLElement>("#ix-run")!.addEventListener("click", () => void onExportClick());
    footerEl.querySelector("[data-cancel]")!.addEventListener("click", () => close());
  }

  async function chooseDestination(): Promise<string | null> {
    const ext = currentExt();
    const extensions = format === "jpeg" ? ["jpg", "jpeg"] : [ext];
    const chosen = await saveFileDialog({
      defaultPath: outPath() || undefined,
      filters: [{ name: format === "jpeg" ? "JPEG" : format.toUpperCase(), extensions }],
    });
    if (!chosen || closed) return null;
    const { dir, file } = splitPath(chosen);
    folder = dir;
    const chosenExt = fileExt(file);
    filename = chosenExt ? file.slice(0, file.length - chosenExt.length - 1) : file;
    const nameInput = q<HTMLInputElement>("#ix-name");
    if (nameInput) nameInput.value = filename;
    const folderInput = q<HTMLInputElement>("#ix-folder");
    if (folderInput) folderInput.value = folder;
    refresh();
    return outPath();
  }

  /** The inline strip under the form. `onReplace: null` = no Replace offered
   *  (the name is one of the project's originals). */
  function showWarning(message: string, onReplace: (() => void) | null, onRename: () => void): void {
    const slot = q<HTMLElement>("#ix-warn-slot");
    if (!slot) return;
    slot.innerHTML = `
      <div class="export-warn">
        ${icon("warning", 16)}
        <div class="export-warn__msg">${escapeHtml(message)}</div>
        <div class="export-warn__actions">
          ${onReplace === null ? "" : `<button class="btn btn--sm" data-w="replace">Replace</button>`}
          <button class="btn btn--sm" data-w="rename">Rename</button>
          <button class="btn btn--sm" data-w="cancel">Cancel</button>
        </div>
      </div>`;
    const clear = (): void => {
      slot.innerHTML = "";
    };
    slot.querySelector('[data-w="replace"]')?.addEventListener("click", () => {
      clear();
      onReplace?.();
    });
    slot.querySelector('[data-w="rename"]')!.addEventListener("click", () => {
      clear();
      onRename();
    });
    slot.querySelector('[data-w="cancel"]')!.addEventListener("click", clear);
  }

  async function onExportClick(): Promise<void> {
    if (exporting) return;
    if (!folder) {
      const picked = await chooseDestination();
      if (!picked) return;
    }
    filename = sanitizeFileName(filename);
    if (!filename) {
      toast.error("Please enter a file name.");
      return;
    }
    if (format === "webp" && !plan().webpOk) return;

    // Remember the choices on the project — not an edit the user made to the
    // image, so it must not make an untouched temporary project ask "keep?".
    const now = preset();
    const p = session.project;
    if (!samePreset(p.image?.export, now)) {
      session.replace({ ...p, image: { background: p.image?.background ?? "transparent", ...p.image, export: now } }, { edit: false });
    }
    void updateSettings({ lastExportDir: folder }).catch((e: unknown) => {
      toast.error("Couldn't save your settings.", {
        detail: errorDetail(e).message,
        op: "Settings",
        title: "Export folder",
      });
    });

    const target = outPath();
    const media = session.project.media;
    // The originals guard comes FIRST, whether or not the name is taken: an
    // original is never offered for replacing. The backend refuses it on its
    // own (path identity, not spelling); this only says why up front.
    if (isProjectSource(target, media)) {
      showWarning(ORIGINAL_FILE_WARNING, null, () => void renameThenExport());
      return;
    }
    if (await pathExists(target)) {
      if (closed) return;
      showWarning("A file with this name already exists.", () => void beginExport(target), () => void renameThenExport());
      return;
    }
    if (closed) return;
    void beginExport(target);
  }

  async function renameThenExport(): Promise<void> {
    const ext = currentExt();
    const dir = folder;
    const media = session.project.media;
    const free = await renameWithSuffix(filename, async (candidate) => {
      const path = joinPath(dir, `${candidate}.${ext}`);
      return isProjectSource(path, media) || (await pathExists(path));
    });
    if (closed) return;
    if (free === null) {
      toast.error("Couldn't find a free file name.", {
        op: "Export",
        title: "Rename",
        detail:
          `Tried ${RENAME_ATTEMPT_LIMIT} numbered variations of "${filename}.${ext}" in ${dir}` +
          ` and every one already exists. Nothing was overwritten — choose a different name or folder.`,
      });
      return;
    }
    filename = free;
    const nameInput = q<HTMLInputElement>("#ix-name");
    if (nameInput) nameInput.value = filename;
    refresh();
    void beginExport(outPath());
  }

  /* ============================ RUN ============================ */

  function beginExport(target: string): Promise<void> {
    if (exporting || closed) return Promise.resolve();
    const ac = new AbortController();
    run = ac;
    exporting = true;
    lastTaskbarPct = -1;
    runHold.hold();
    renderProgress();
    const fmt = format;
    const out = plan().out;
    const q100 = quality;
    const job = (async (): Promise<void> => {
      try {
        // Read the project live: an edit made while the dialog was open is the
        // one that gets exported.
        const doc = session.project;
        const sources = exportSources(doc);
        const blob = await renderImageExport(doc, { format: fmt, quality: q100, outW: out.w, outH: out.h }, ac.signal, (r) =>
          progress(r * 0.8, "Rendering"),
        );
        const saved = await saveBlob({ kind: "user", path: target, sources }, fmt, blob, ac.signal, (r) =>
          progress(0.8 + r * 0.2, "Saving"),
        );
        if (closed) return;
        finish();
        renderSuccess(saved.path);
      } catch (e) {
        if (closed) return;
        finish();
        if (isAbort(e) || ac.signal.aborted) {
          toast.info("Export canceled");
          renderForm();
          return;
        }
        renderError(errorDetail(e));
      }
    })();
    running = job;
    return job;
  }

  function finish(): void {
    exporting = false;
    run = null;
    running = null;
    runHold.release();
    if (lastTaskbarPct !== -1) void clearTaskbarProgress();
    lastTaskbarPct = -1;
  }

  function renderProgress(): void {
    bodyEl.innerHTML = `
      <div class="export-progress">
        <div class="export-progress__pct" id="ix-pct">0%</div>
        <div class="export-bar"><div class="export-bar__fill" id="ix-fill"></div></div>
        <div class="export-progress__meta"><span id="ix-phase">Rendering</span></div>
      </div>
    `;
    footerEl.innerHTML = `<button class="btn btn--danger" id="ix-cancel">Cancel</button>`;
    q<HTMLElement>("#ix-cancel")!.addEventListener("click", () => run?.abort());
    focusFirst(backdrop, "#ix-cancel");
  }

  function progress(ratio: number, phase: string): void {
    if (closed) return;
    const r = Math.min(1, Math.max(0, ratio));
    const pct = Math.round(r * 100);
    const pctEl = q<HTMLElement>("#ix-pct");
    const fillEl = q<HTMLElement>("#ix-fill");
    const phaseEl = q<HTMLElement>("#ix-phase");
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (phaseEl && phaseEl.textContent !== phase) phaseEl.textContent = phase;
    if (pct !== lastTaskbarPct) {
      lastTaskbarPct = pct;
      void setTaskbarProgress(r);
    }
  }

  function renderSuccess(path: string): void {
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--ok">${checkIcon(24)}</div>
        <div class="export-result__title">Exported</div>
        <div class="export-result__path">${escapeHtml(path)}</div>
      </div>
    `;
    footerEl.innerHTML = `
      <button class="btn" id="ix-reveal">${icon("folder", 14)}Reveal in Explorer</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    q<HTMLElement>("#ix-reveal")!.addEventListener("click", () => void revealInExplorer(path));
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", () => close());
    focusFirst(backdrop, "[data-close-btn]");
  }

  function renderError(err: { code: string; message: string }): void {
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--bad">${icon("warning", 22)}</div>
        <div class="export-result__title">Export failed</div>
        <div class="export-result__msg">${escapeHtml(err.message)}</div>
      </div>
    `;
    // Copyable, with the backend's code kept: the identifier that makes a
    // report actionable.
    const detail = err.code ? `${err.message}\n\ncode: ${err.code}` : err.message;
    recordError({ at: Date.now(), op: "Export image", message: err.message, detail });
    bodyEl.querySelector(".export-result")!.appendChild(detailPane(detail));
    footerEl.innerHTML = `
      <button class="btn" id="ix-back">Back</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    q<HTMLElement>("#ix-back")!.addEventListener("click", () => renderForm());
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", () => close());
    focusFirst(backdrop, ".err-detail");
  }

  renderForm();
  return forceClose;
}
