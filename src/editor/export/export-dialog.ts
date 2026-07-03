// The export dialog: a single centered modal that collects an ExportPreset +
// destination, estimates size live, then runs the export with progress / ETA /
// cancel and a success / error result view.

import "./export.css";
import { escapeHtml, fileExt, formatBytes } from "../../core/format";
import { onJobEvents } from "../../core/ipc";
import type { JobDone, JobFailed, JobProgress } from "../../core/ipc";
import { ProjectSession, settingsStore, updateSettings } from "../../core/session";
import type { ExportPreset, ResolutionPreset } from "../../core/types";
import { trapTab } from "../../ui/focus";
import { icon } from "../../ui/icons";
import { toast } from "../../ui/toast";
import {
  cancelJob,
  clearTaskbarProgress,
  detectEncoders,
  estimateExport,
  pathExists,
  revealInExplorer,
  saveFileDialog,
  setTaskbarProgress,
  startExport,
  type EncoderReport,
  type ExportSpec,
} from "./export-ipc";

type Format = ExportPreset["format"];
type Codec = ExportPreset["vcodec"];

/* ---------------- pure helpers (tested) ---------------- */

/** Strip characters Windows forbids in file names, collapse whitespace. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "export";
}

/** File extension (without dot) for an export format. */
export function extForFormat(format: Format): string {
  return format;
}

/** Join a directory and a file name with a single OS-appropriate separator. */
export function joinPath(dir: string, file: string): string {
  if (!dir) return file;
  const sep = dir.includes("\\") ? "\\" : dir.includes("/") ? "/" : "\\";
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${file}`;
}

/** Split a full path into its directory and file name. */
export function splitPath(path: string): { dir: string; file: string } {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (i < 0) return { dir: "", file: path };
  return { dir: path.slice(0, i), file: path.slice(i + 1) };
}

/**
 * Given a base file name (without extension), append " (2)", " (3)", … until
 * `taken(candidate)` returns false. If the name already ends in a suffix, the
 * numbering continues from there. Pure + synchronous for easy testing.
 */
export function renameWithSuffix(name: string, taken: (candidate: string) => boolean): string {
  const match = /^(.*?)(?: \((\d+)\))?$/.exec(name);
  const stem = match?.[1] ?? name;
  let n = match?.[2] ? parseInt(match[2], 10) + 1 : 2;
  let candidate = `${stem} (${n})`;
  while (taken(candidate)) {
    n++;
    candidate = `${stem} (${n})`;
  }
  return candidate;
}

/* ---------------- option tables ---------------- */

const FORMATS: { value: Format; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mov", label: "MOV" },
  { value: "webm", label: "WebM" },
  { value: "avi", label: "AVI" },
  { value: "gif", label: "GIF" },
];

const CODEC_LABELS: Record<Codec, string> = {
  h264: "H.264",
  hevc: "H.265 / HEVC",
  av1: "AV1",
};

/** Which codecs a format offers (webm ⇒ AV1 only in v1). */
function codecsForFormat(format: Format): Codec[] {
  if (format === "webm") return ["av1"];
  return ["h264", "hevc", "av1"];
}

const RESOLUTIONS: { value: string; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "4320p", label: "8K (4320p)" },
  { value: "2160p", label: "4K (2160p)" },
  { value: "1440p", label: "1440p" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "custom", label: "Custom" },
];

const FPS_OPTIONS = [
  { value: "original", label: "Original" },
  { value: "24", label: "24" },
  { value: "30", label: "30" },
  { value: "60", label: "60" },
  { value: "120", label: "120" },
  { value: "custom", label: "Custom" },
];

const GIF_FPS_OPTIONS = [
  { value: "original", label: "Original" },
  { value: "12", label: "12" },
  { value: "15", label: "15" },
  { value: "24", label: "24" },
  { value: "30", label: "30" },
  { value: "custom", label: "Custom" },
];

/** Inline check icon (not part of the shared icon set). */
function checkIcon(size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
}

/** Short label for a detected encoder name. */
function encoderBadge(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("nvenc")) return "NVENC";
  if (n.includes("qsv")) return "QSV";
  if (n.includes("amf")) return "AMF";
  return "software";
}

function isSoftwareOnly(name: string): boolean {
  return encoderBadge(name) === "software";
}

/** Human ETA like "about 12s left" / "about 2m left". */
function formatEta(sec: number): string {
  if (sec < 1) return "less than a second left";
  if (sec < 60) return `about ${Math.round(sec)}s left`;
  const m = Math.round(sec / 60);
  return `about ${m}m left`;
}

/* ---------------- dialog ---------------- */

export function openExportDialog(ctx: { session: ProjectSession }): void {
  const { session } = ctx;
  const project = session.project;

  /* -------- working preset (a mutable copy of the persisted one) -------- */
  const start = project.export;
  let format: Format = start.format;
  let codec: Codec = start.vcodec;
  let resolution: ResolutionPreset = start.resolution;
  let fps: "original" | number = start.fps;
  let videoBitrate: "auto" | number = start.videoBitrate;
  let audioBitrate: "auto" | number = start.audioBitrate;
  let useHardware = settingsStore.get().hardwareAccel && start.useHardware;

  const settings = settingsStore.get();
  let folder = settings.lastExportDir ?? settings.defaultExportDir ?? "";
  let filename = sanitizeFileName(project.name);

  let encoders: EncoderReport | null = null;

  /* -------- build the current preset object -------- */
  function buildPreset(): ExportPreset {
    return {
      format,
      vcodec: codec,
      resolution,
      fps,
      videoBitrate,
      audioBitrate,
      useHardware,
    };
  }

  function currentExt(): string {
    return extForFormat(format);
  }

  function outPath(): string {
    return joinPath(folder, `${filename}.${currentExt()}`);
  }

  /* -------- DOM scaffold -------- */
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal export-modal" role="dialog" aria-modal="true" aria-label="Export">
      <div class="modal__header">
        <span>Export</span>
        <button class="btn btn--ghost btn--icon btn--sm" data-close title="Close">${icon("x", 14)}</button>
      </div>
      <div class="modal__body" id="ex-body"></div>
      <div class="modal__footer" id="ex-footer"></div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const $ = <T extends HTMLElement>(sel: string): T => backdrop.querySelector<T>(sel)!;
  const bodyEl = $("#ex-body");
  const footerEl = $("#ex-footer");

  const releaseTrap = trapTab(backdrop);

  let exporting = false;
  let jobId: number | null = null;
  let unlistenJobs: (() => void) | null = null;
  let estimateTimer: number | undefined;

  /* -------- lifecycle -------- */
  function close(): void {
    if (exporting) return;
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    window.clearTimeout(estimateTimer);
    if (unlistenJobs) unlistenJobs();
    void clearTaskbarProgress();
    backdrop.remove();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (exporting) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKeydown, true);

  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop && !exporting) close();
  });
  backdrop.querySelector("[data-close]")!.addEventListener("click", () => {
    if (jobId !== null && exporting) return; // ignore while exporting
    close();
  });

  /* ============================================================
     FORM VIEW
     ============================================================ */

  function renderForm(): void {
    const showCodec = format !== "gif";
    const showBitrates = format !== "gif";
    const showAudio = format !== "gif";
    const codecOpts = codecsForFormat(format);
    const fpsOpts = format === "gif" ? GIF_FPS_OPTIONS : FPS_OPTIONS;

    const isCustomRes = typeof resolution === "object";
    const isCustomFps = fps !== "original" && !fpsOpts.some((o) => o.value === String(fps));
    const resSelValue = isCustomRes ? "custom" : (resolution as string);
    const fpsSelValue = fps === "original" ? "original" : isCustomFps ? "custom" : String(fps);

    const customW = isCustomRes ? (resolution as { w: number; h: number }).w : project.timeline.width;
    const customH = isCustomRes ? (resolution as { w: number; h: number }).h : project.timeline.height;
    const customFps = isCustomFps ? (fps as number) : 30;

    bodyEl.innerHTML = `
      <div class="export-form">
        <div class="export-row">
          <label>Format</label>
          <div class="export-seg" id="ex-format">
            ${FORMATS.map(
              (f) =>
                `<button class="btn ${f.value === format ? "btn--on" : ""}" data-format="${f.value}">${f.label}</button>`,
            ).join("")}
          </div>
        </div>

        <div class="export-row ${showCodec ? "" : "export-row--hidden"}" id="ex-codec-row">
          <label>Codec</label>
          <div class="export-row__control">
            <select class="select" id="ex-codec">
              ${codecOpts
                .map(
                  (c) =>
                    `<option value="${c}" ${c === codec ? "selected" : ""}>${escapeHtml(CODEC_LABELS[c])}</option>`,
                )
                .join("")}
            </select>
            <span class="badge" id="ex-encoder-badge" hidden></span>
          </div>
        </div>

        <div class="export-row">
          <label>Resolution</label>
          <div class="export-row__control">
            <select class="select" id="ex-res">
              ${RESOLUTIONS.map(
                (r) => `<option value="${r.value}" ${r.value === resSelValue ? "selected" : ""}>${r.label}</option>`,
              ).join("")}
            </select>
            <span class="export-row__control ${isCustomRes ? "" : "export-row--hidden"}" id="ex-res-custom">
              <input class="input export-num" id="ex-res-w" type="number" min="16" step="2" value="${customW}" aria-label="Width" />
              <span class="export-dim-x">×</span>
              <input class="input export-num" id="ex-res-h" type="number" min="16" step="2" value="${customH}" aria-label="Height" />
            </span>
          </div>
        </div>

        <div class="export-row">
          <label>Frame rate</label>
          <div class="export-row__control">
            <select class="select" id="ex-fps">
              ${fpsOpts
                .map((o) => `<option value="${o.value}" ${o.value === fpsSelValue ? "selected" : ""}>${o.label}</option>`)
                .join("")}
            </select>
            <input class="input export-num ${isCustomFps ? "" : "export-row--hidden"}" id="ex-fps-custom"
              type="number" min="1" max="${format === "gif" ? 30 : 240}" step="1" value="${customFps}" aria-label="Custom frame rate" />
          </div>
        </div>

        <div class="export-row ${showBitrates ? "" : "export-row--hidden"}" id="ex-vbr-row">
          <label>Video bitrate</label>
          <div class="export-row__control">
            <select class="select" id="ex-vbr-mode">
              <option value="auto" ${videoBitrate === "auto" ? "selected" : ""}>Auto (quality)</option>
              <option value="custom" ${videoBitrate !== "auto" ? "selected" : ""}>Custom</option>
            </select>
            <input class="input export-num ${videoBitrate !== "auto" ? "" : "export-row--hidden"}" id="ex-vbr"
              type="number" min="100" step="100" value="${videoBitrate === "auto" ? 8000 : videoBitrate}" aria-label="Video bitrate kbps" />
            <span class="export-ext ${videoBitrate !== "auto" ? "" : "export-row--hidden"}" id="ex-vbr-unit">kbps</span>
          </div>
        </div>

        <div class="export-row ${showAudio ? "" : "export-row--hidden"}" id="ex-abr-row">
          <label>Audio bitrate</label>
          <div class="export-row__control">
            <select class="select" id="ex-abr-mode">
              <option value="auto" ${audioBitrate === "auto" ? "selected" : ""}>Auto</option>
              <option value="custom" ${audioBitrate !== "auto" ? "selected" : ""}>Custom</option>
            </select>
            <input class="input export-num ${audioBitrate !== "auto" ? "" : "export-row--hidden"}" id="ex-abr"
              type="number" min="32" step="16" value="${audioBitrate === "auto" ? 192 : audioBitrate}" aria-label="Audio bitrate kbps" />
            <span class="export-ext ${audioBitrate !== "auto" ? "" : "export-row--hidden"}" id="ex-abr-unit">kbps</span>
          </div>
        </div>

        <div class="export-row ${format === "gif" ? "export-row--hidden" : ""}" id="ex-hw-row">
          <label>Hardware acceleration</label>
          <div class="export-row__control">
            <input class="switch" type="checkbox" id="ex-hw" ${useHardware ? "checked" : ""} />
          </div>
        </div>

        <div class="export-row">
          <label>File name</label>
          <div class="export-row__control">
            <input class="input" id="ex-name" value="${escapeHtml(filename)}" spellcheck="false" />
            <span class="export-ext" id="ex-ext">.${currentExt()}</span>
          </div>
        </div>

        <div class="export-row">
          <label>Destination</label>
          <div class="export-row__control">
            <input class="input" id="ex-folder" value="${escapeHtml(folder)}" placeholder="Choose a folder" spellcheck="false" />
            <button class="btn" id="ex-choose">${icon("folder", 14)}Choose</button>
          </div>
        </div>

        <div class="export-outpath" id="ex-outpath"></div>
        <div class="export-estimate" id="ex-estimate"></div>
        <div id="ex-warn-slot"></div>
      </div>
    `;

    footerEl.innerHTML = `
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn--primary" id="ex-run">${icon("export", 14)}Export</button>
    `;

    wireForm();
    updateEncoderBadge();
    refreshOutPath();
    scheduleEstimate();
  }

  function wireForm(): void {
    // Format segmented buttons
    $("#ex-format").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-format]");
      if (!btn) return;
      const next = btn.dataset.format as Format;
      if (next === format) return;
      format = next;
      // fix up codec if the new format doesn't offer the current one
      const allowed = codecsForFormat(format);
      if (!allowed.includes(codec)) codec = allowed[0]!;
      // gif caps fps at 30
      if (format === "gif" && fps !== "original" && (fps as number) > 30) fps = 30;
      renderForm();
    });

    $<HTMLSelectElement>("#ex-codec").addEventListener("change", (e) => {
      codec = (e.target as HTMLSelectElement).value as Codec;
      updateEncoderBadge();
      scheduleEstimate();
    });

    const resSel = $<HTMLSelectElement>("#ex-res");
    resSel.addEventListener("change", () => {
      const v = resSel.value;
      if (v === "custom") {
        resolution = { w: project.timeline.width, h: project.timeline.height };
      } else {
        resolution = v as ResolutionPreset;
      }
      renderForm();
    });
    const applyCustomRes = (): void => {
      const w = Math.max(16, Math.round(Number($<HTMLInputElement>("#ex-res-w").value) || 0));
      const h = Math.max(16, Math.round(Number($<HTMLInputElement>("#ex-res-h").value) || 0));
      resolution = { w, h };
      scheduleEstimate();
    };
    $<HTMLInputElement>("#ex-res-w").addEventListener("input", applyCustomRes);
    $<HTMLInputElement>("#ex-res-h").addEventListener("input", applyCustomRes);

    const fpsSel = $<HTMLSelectElement>("#ex-fps");
    fpsSel.addEventListener("change", () => {
      const v = fpsSel.value;
      if (v === "original") fps = "original";
      else if (v === "custom") fps = format === "gif" ? 15 : 30;
      else fps = Number(v);
      renderForm();
    });
    $<HTMLInputElement>("#ex-fps-custom").addEventListener("input", (e) => {
      const cap = format === "gif" ? 30 : 240;
      const n = Math.max(1, Math.min(cap, Math.round(Number((e.target as HTMLInputElement).value) || 1)));
      fps = n;
      scheduleEstimate();
    });

    const vbrMode = $<HTMLSelectElement>("#ex-vbr-mode");
    if (vbrMode) {
      vbrMode.addEventListener("change", () => {
        videoBitrate = vbrMode.value === "custom" ? Number($<HTMLInputElement>("#ex-vbr").value) || 8000 : "auto";
        renderForm();
      });
      $<HTMLInputElement>("#ex-vbr")?.addEventListener("input", (e) => {
        videoBitrate = Math.max(100, Math.round(Number((e.target as HTMLInputElement).value) || 100));
        scheduleEstimate();
      });
    }

    const abrMode = $<HTMLSelectElement>("#ex-abr-mode");
    if (abrMode) {
      abrMode.addEventListener("change", () => {
        audioBitrate = abrMode.value === "custom" ? Number($<HTMLInputElement>("#ex-abr").value) || 192 : "auto";
        renderForm();
      });
      $<HTMLInputElement>("#ex-abr")?.addEventListener("input", (e) => {
        audioBitrate = Math.max(32, Math.round(Number((e.target as HTMLInputElement).value) || 32));
        scheduleEstimate();
      });
    }

    $<HTMLInputElement>("#ex-hw")?.addEventListener("change", (e) => {
      useHardware = (e.target as HTMLInputElement).checked;
      scheduleEstimate();
    });

    const nameInput = $<HTMLInputElement>("#ex-name");
    nameInput.addEventListener("input", () => {
      filename = nameInput.value;
      refreshOutPath();
      scheduleEstimate();
    });
    nameInput.addEventListener("blur", () => {
      filename = sanitizeFileName(nameInput.value);
      nameInput.value = filename;
      refreshOutPath();
    });

    const folderInput = $<HTMLInputElement>("#ex-folder");
    folderInput.addEventListener("input", () => {
      folder = folderInput.value;
      refreshOutPath();
      scheduleEstimate();
    });

    $("#ex-choose").addEventListener("click", () => void chooseDestination());
    $("#ex-run").addEventListener("click", () => void onExportClick());
    footerEl.querySelector("[data-cancel]")!.addEventListener("click", close);
  }

  function updateEncoderBadge(): void {
    const badge = backdrop.querySelector<HTMLElement>("#ex-encoder-badge");
    if (!badge) return;
    if (!encoders || format === "gif") {
      badge.hidden = true;
      return;
    }
    const name = encoders[codec];
    badge.hidden = false;
    badge.textContent = encoderBadge(name);
    // disable HW switch when only software is available for this codec
    const hw = backdrop.querySelector<HTMLInputElement>("#ex-hw");
    if (hw) {
      if (isSoftwareOnly(name)) {
        hw.checked = false;
        hw.disabled = true;
        useHardware = false;
      } else {
        hw.disabled = false;
      }
    }
  }

  function refreshOutPath(): void {
    const ext = backdrop.querySelector<HTMLElement>("#ex-ext");
    if (ext) ext.textContent = `.${currentExt()}`;
    const out = backdrop.querySelector<HTMLElement>("#ex-outpath");
    if (out) out.textContent = outPath();
  }

  function scheduleEstimate(): void {
    window.clearTimeout(estimateTimer);
    const el = backdrop.querySelector<HTMLElement>("#ex-estimate");
    if (el) el.innerHTML = `Estimated size: <strong>—</strong>`;
    estimateTimer = window.setTimeout(() => void runEstimate(), 300);
  }

  async function runEstimate(): Promise<void> {
    const el = backdrop.querySelector<HTMLElement>("#ex-estimate");
    if (!el) return;
    const spec: ExportSpec = {
      media: project.media,
      timeline: project.timeline,
      preset: buildPreset(),
      outPath: outPath(),
    };
    try {
      const est = await estimateExport(spec);
      if (!el.isConnected) return;
      const prefix = est.exact ? "" : "≈ ";
      el.innerHTML = `Estimated size: <strong>${prefix}${escapeHtml(formatBytes(est.bytes))}</strong>`;
    } catch {
      if (el.isConnected) el.innerHTML = `Estimated size: <strong>—</strong>`;
    }
  }

  /* -------- destination picker -------- */
  async function chooseDestination(): Promise<string | null> {
    const ext = currentExt();
    const chosen = await saveFileDialog({
      defaultPath: outPath() || undefined,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!chosen) return null;
    const { dir, file } = splitPath(chosen);
    folder = dir;
    // strip the extension the dialog appended; the ext follows the format
    const chosenExt = fileExt(file);
    filename = chosenExt ? file.slice(0, file.length - chosenExt.length - 1) : file;
    // reflect into the fields (form may still be mounted)
    const nameInput = backdrop.querySelector<HTMLInputElement>("#ex-name");
    if (nameInput) nameInput.value = filename;
    const folderInput = backdrop.querySelector<HTMLInputElement>("#ex-folder");
    if (folderInput) folderInput.value = folder;
    refreshOutPath();
    scheduleEstimate();
    return outPath();
  }

  /* -------- overwrite warning strip -------- */
  function showOverwriteWarning(onReplace: () => void, onRename: () => void): void {
    const slot = backdrop.querySelector<HTMLElement>("#ex-warn-slot");
    if (!slot) return;
    slot.innerHTML = `
      <div class="export-warn">
        ${icon("warning", 16)}
        <div class="export-warn__msg">A file with this name already exists.</div>
        <div class="export-warn__actions">
          <button class="btn btn--sm" data-w="replace">Replace</button>
          <button class="btn btn--sm" data-w="rename">Rename</button>
          <button class="btn btn--sm" data-w="cancel">Cancel</button>
        </div>
      </div>`;
    const clear = (): void => {
      slot.innerHTML = "";
    };
    slot.querySelector('[data-w="replace"]')!.addEventListener("click", () => {
      clear();
      onReplace();
    });
    slot.querySelector('[data-w="rename"]')!.addEventListener("click", () => {
      clear();
      onRename();
    });
    slot.querySelector('[data-w="cancel"]')!.addEventListener("click", clear);
  }

  /* -------- Export click flow -------- */
  async function onExportClick(): Promise<void> {
    // Force a Save As dialog if we have no destination folder at all.
    if (!folder) {
      const picked = await chooseDestination();
      if (!picked) return;
    }
    if (!filename) {
      toast.error("Please enter a file name.");
      return;
    }

    // persist the preset into the project + remember the folder
    const preset = buildPreset();
    session.replace({ ...session.project, export: preset });
    void updateSettings({ lastExportDir: folder });

    const target = outPath();
    if (await pathExists(target)) {
      showOverwriteWarning(
        () => void beginExport(target),
        () => {
          // auto-suffix until free (best-effort: only checks against a cache of
          // known-taken names, then re-verifies with pathExists on start)
          void resolveRenameThenExport();
        },
      );
      return;
    }
    void beginExport(target);
  }

  async function resolveRenameThenExport(): Promise<void> {
    const ext = currentExt();
    // Probe candidates against the filesystem until we find a free one.
    let n = 2;
    const base = filename.replace(/ \(\d+\)$/, "");
    let candidate = `${base} (${n})`;
    // guard against pathological loops
    for (let guard = 0; guard < 1000; guard++) {
      const p = joinPath(folder, `${candidate}.${ext}`);
      if (!(await pathExists(p))) break;
      n++;
      candidate = `${base} (${n})`;
    }
    filename = candidate;
    const nameInput = backdrop.querySelector<HTMLInputElement>("#ex-name");
    if (nameInput) nameInput.value = filename;
    refreshOutPath();
    void beginExport(outPath());
  }

  /* ============================================================
     PROGRESS VIEW
     ============================================================ */

  async function beginExport(target: string): Promise<void> {
    const spec: ExportSpec = {
      media: project.media,
      timeline: project.timeline,
      preset: buildPreset(),
      outPath: target,
    };

    exporting = true;
    renderProgress();

    // Listen before starting so we don't miss the first progress event.
    try {
      unlistenJobs = await onJobEvents({
        onProgress: (e) => handleProgress(e),
        onDone: (e) => handleDone(e),
        onFailed: (e) => handleFailed(e),
      });
    } catch {
      // event listener unavailable (non-tauri) — export will still reject below
    }

    try {
      jobId = await startExport(spec);
    } catch (e) {
      exporting = false;
      if (unlistenJobs) {
        unlistenJobs();
        unlistenJobs = null;
      }
      renderError(describe(e), []);
    }
  }

  function renderProgress(): void {
    bodyEl.innerHTML = `
      <div class="export-progress">
        <div class="export-progress__pct" id="ex-pct">0%</div>
        <div class="export-bar"><div class="export-bar__fill" id="ex-fill" style="width:0%"></div></div>
        <div class="export-progress__meta">
          <span id="ex-eta"></span>
          <span id="ex-speed"></span>
        </div>
      </div>
    `;
    footerEl.innerHTML = `<button class="btn btn--danger" id="ex-cancel">Cancel</button>`;
    $("#ex-cancel").addEventListener("click", () => void onCancelExport());
  }

  function handleProgress(e: JobProgress): void {
    if (e.kind !== "export" || (jobId !== null && e.id !== jobId)) return;
    const ratio = e.ratio ?? 0;
    const pct = Math.round(ratio * 100);
    const pctEl = backdrop.querySelector<HTMLElement>("#ex-pct");
    const fillEl = backdrop.querySelector<HTMLElement>("#ex-fill");
    const etaEl = backdrop.querySelector<HTMLElement>("#ex-eta");
    const speedEl = backdrop.querySelector<HTMLElement>("#ex-speed");
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (etaEl) etaEl.textContent = e.etaSec !== null ? formatEta(e.etaSec) : "";
    if (speedEl) speedEl.textContent = e.speed > 0 ? `${e.speed.toFixed(1)}×` : "";
    void setTaskbarProgress(ratio);
  }

  function handleDone(e: JobDone): void {
    if (e.kind !== "export" || (jobId !== null && e.id !== jobId)) return;
    exporting = false;
    void clearTaskbarProgress();
    if (unlistenJobs) {
      unlistenJobs();
      unlistenJobs = null;
    }
    const path = typeof e.output.path === "string" ? e.output.path : outPath();
    renderSuccess(path);
  }

  function handleFailed(e: JobFailed): void {
    if (e.kind !== "export" || (jobId !== null && e.id !== jobId)) return;
    exporting = false;
    void clearTaskbarProgress();
    if (unlistenJobs) {
      unlistenJobs();
      unlistenJobs = null;
    }
    if (e.canceled) {
      // user-initiated cancel is handled in onCancelExport; ignore here
      return;
    }
    renderError(e.message, e.logTail);
  }

  async function onCancelExport(): Promise<void> {
    if (jobId === null) return;
    const id = jobId;
    try {
      await cancelJob(id);
    } catch {
      /* ignore */
    }
    exporting = false;
    jobId = null;
    void clearTaskbarProgress();
    if (unlistenJobs) {
      unlistenJobs();
      unlistenJobs = null;
    }
    toast.info("Export canceled");
    renderForm();
  }

  /* ============================================================
     RESULT VIEWS
     ============================================================ */

  function renderSuccess(path: string): void {
    jobId = null;
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--ok">${checkIcon(24)}</div>
        <div class="export-result__title">Exported</div>
        <div class="export-result__path">${escapeHtml(path)}</div>
      </div>
    `;
    footerEl.innerHTML = `
      <button class="btn" id="ex-reveal">${icon("folder", 14)}Reveal in Explorer</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    $("#ex-reveal").addEventListener("click", () => void revealInExplorer(path));
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", close);
  }

  function renderError(message: string, logTail: string[]): void {
    jobId = null;
    const log = logTail.length
      ? `<details class="export-log"><summary>Details</summary><pre>${escapeHtml(logTail.join("\n"))}</pre></details>`
      : "";
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--bad">${icon("warning", 22)}</div>
        <div class="export-result__title">Export failed</div>
        <div class="export-result__msg">${escapeHtml(message)}</div>
        ${log}
      </div>
    `;
    footerEl.innerHTML = `
      <button class="btn" id="ex-back">Back</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    $("#ex-back").addEventListener("click", () => renderForm());
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", close);
  }

  /* -------- boot -------- */
  renderForm();
  // focus the filename input on open
  const nameInput = backdrop.querySelector<HTMLInputElement>("#ex-name");
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }

  // detect encoders in the background, then refresh the badge
  void detectEncoders(false)
    .then((report) => {
      encoders = report;
      updateEncoderBadge();
    })
    .catch(() => {
      /* estimate + export still work; badge just stays hidden */
    });
}

/** Best-effort error message extraction (mirrors ipc.describeError). */
function describe(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
