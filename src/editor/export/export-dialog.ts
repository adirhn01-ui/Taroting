// The export dialog: a single centered modal that collects an ExportPreset +
// destination, estimates size live, then runs the export with progress / ETA /
// cancel and a success / error result view.

import "./export.css";
import type { ReportContext } from "../../core/diagnostics";
import { escapeHtml, fileExt, formatBytes } from "../../core/format";
import { appVersion, describeError, errorDetail, ipc, onJobEvents } from "../../core/ipc";
import type { JobDone, JobFailed, JobProgress } from "../../core/ipc";
import { ProjectSession, settingsStore, updateSettings } from "../../core/session";
import { timelineDuration } from "../../core/time";
import type { ExportPreset, ResolutionPreset } from "../../core/types";
import { detailPane, recentErrors, recordError } from "../../ui/errors";
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

/** How many " (n)" candidates a rename tries before it gives up. */
export const RENAME_ATTEMPT_LIMIT = 1000;

/**
 * Given a base file name (without extension), append " (2)", " (3)", … until
 * `taken(candidate)` reports the name free. If the name already ends in a
 * suffix, the numbering continues from there ("clip (3)" ⇒ "clip (4)").
 *
 * Returns `null` when `limit` candidates in a row are taken. That case used to
 * be a **silent overwrite**: the shipped copy of this loop fell out of its
 * guard still holding the last, taken candidate and exported straight over
 * someone's file. There is no free name left to offer, so the caller has to say
 * so — it must never write.
 *
 * `taken` may be sync or async, so production probes the filesystem through the
 * very same numbering the tests drive with a plain predicate. This is the only
 * implementation, and it is the one that ships.
 */
export async function renameWithSuffix(
  name: string,
  taken: (candidate: string) => boolean | Promise<boolean>,
  limit = RENAME_ATTEMPT_LIMIT,
): Promise<string | null> {
  const match = /^(.*?)(?: \((\d+)\))?$/.exec(name);
  const stem = match?.[1] ?? name;
  const first = match?.[2] ? parseInt(match[2], 10) + 1 : 2;
  for (let i = 0; i < limit; i++) {
    const candidate = `${stem} (${first + i})`;
    if (!(await taken(candidate))) return candidate;
  }
  return null;
}

/** The export-preset fields this dialog owns. Anything else on a project's
 *  persisted preset belongs to a different (or newer) build. */
export interface PresetEdits {
  format: Format;
  vcodec: Codec;
  resolution: ResolutionPreset;
  fps: "original" | number;
  videoBitrate: "auto" | number;
  audioBitrate: "auto" | number;
  useHardware: boolean;
}

/**
 * Rebuild a project's export preset from the dialog's current values.
 *
 * The `.trt` schema is **additive optional fields only** and round-tripping
 * must not lose unknown data — but this used to be reconstructed from seven
 * literals, so any field added later, or already present in a project written
 * by a newer build, was silently dropped on every save. So: spread whatever is
 * persisted first, then write the owned fields over it.
 *
 * The order matters in both directions. Base-first keeps unknown keys; every
 * one of the seven owned fields is then assigned UNCONDITIONALLY (never
 * conditionally, never via `??`), so a stale persisted value can never survive
 * for a field the dialog controls — including `false`, `0` and `"auto"`.
 */
export function mergeExportPreset(
  base: ExportPreset | null | undefined,
  edits: PresetEdits,
): ExportPreset {
  return { ...base, ...edits };
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

const FORMAT_LABELS: Record<Format, string> = {
  mp4: "MP4",
  mov: "MOV",
  webm: "WebM",
  avi: "AVI",
  gif: "GIF",
};

/**
 * Which codecs a container can actually be handed.
 *
 * Only combinations verified against the bundled ffmpeg are on offer. The two
 * exclusions are muxer limits, not preferences — the container refuses the
 * stream at header-write time, so offering them is offering a guaranteed
 * failure with a generic "exit code: 1" at the end of it:
 *
 *   webm + h264/hevc  →  "Only VP8 or VP9 or AV1 video … are supported for WebM"
 *   mov  + av1        →  "av1 only supported in MP4 and AVIF."
 *
 * The MOV rule is about the codec ID, not the encoder: `-c copy` of an
 * already-encoded AV1 stream into MOV fails identically, so the hardware
 * encoders (av1_nvenc / av1_qsv / av1_amf) are just as impossible and must not
 * be reachable either. mp4/avi mux all three; this was checked, not assumed.
 *
 * GIF keeps the full list on purpose. Its codec row is hidden (the palette
 * pipeline owns the output), so returning a short list here would clobber the
 * user's codec every time they passed through GIF on the way somewhere else.
 */
export function codecsForFormat(format: Format): Codec[] {
  if (format === "webm") return ["av1"];
  if (format === "mov") return ["h264", "hevc"];
  // AVI has no fourcc for HEVC. ffmpeg does NOT refuse it — it exits 0 and
  // writes a stream with a null fourcc, which ffprobe then reads back as
  // `rawvideo / [0][0][0][0]` and no decoder can open ("Invalid buffer size,
  // packet size 6093 < expected frame_size 230400"). Measured with the bundled
  // 8.1.1. That is worse than the mov+av1 case above, which at least fails
  // loudly: here the user is told the export succeeded and is handed a file
  // that will not play anywhere, including back in this app.
  // avi+h264 (fourcc H264) and avi+av1 (AV01) are both fine.
  if (format === "avi") return ["h264", "av1"];
  return ["h264", "hevc", "av1"];
}

/**
 * Fallback order when a container cannot mux the codec that was asked for:
 * nearest in intent first. Someone who picked AV1 picked it for efficiency, so
 * dropping them onto HEVC honours that better than onto H.264, which is the
 * largest-file option of the three.
 */
const CODEC_FALLBACK: Record<Codec, Codec[]> = {
  av1: ["hevc", "h264"],
  hevc: ["av1", "h264"],
  h264: ["hevc", "av1"],
};

/**
 * The codec `format` will actually be exported with, given the one that was
 * asked for. Returns `wanted` untouched whenever the container can mux it.
 *
 * This has to run on the OPENING preset too, not just on a format switch: a
 * project saved by an older build can carry MOV+AV1, and rendering a `<select>`
 * whose options exclude the current value leaves the browser showing option one
 * while the variable still says AV1 — the dialog would claim H.264 and export
 * (fail at) AV1.
 */
export function resolveCodec(format: Format, wanted: Codec): Codec {
  const allowed = codecsForFormat(format);
  if (allowed.includes(wanted)) return wanted;
  return CODEC_FALLBACK[wanted].find((c) => allowed.includes(c)) ?? allowed[0]!;
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

/** Why hardware encoding is off the table for an export, or null if it isn't. */
export type HardwareBlock = "setting" | "codec" | null;

/**
 * Whether something OUTSIDE the project forbids hardware for this export.
 *
 * Both reasons are about the machine and the session, never about what the
 * project asked for — which is exactly why they get their own function. Pass
 * `encoder: null` while the probe is still in flight (unknown ≠ software-only).
 */
export function hardwareBlockedBy(opts: {
  globalEnabled: boolean;
  encoder: string | null;
}): HardwareBlock {
  if (!opts.globalEnabled) return "setting";
  if (opts.encoder !== null && isSoftwareOnly(opts.encoder)) return "codec";
  return null;
}

/**
 * The preset THIS export runs with: the project's preset, with `useHardware`
 * forced off when something outside the project blocks it.
 *
 * The returned object is always a copy, and the input is never touched. That is
 * the whole fix: the global "Hardware acceleration" switch used to be folded
 * into the dialog's `useHardware` on open and then written back into the
 * project on every export, so turning the global setting off once destroyed the
 * project's own answer permanently — turning the setting back on did not bring
 * it back. Gating the run and persisting the preference are now two different
 * objects built from the same source.
 */
export function gateHardware(preset: ExportPreset, blocked: HardwareBlock): ExportPreset {
  return blocked === null ? { ...preset } : { ...preset, useHardware: false };
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

  /* -------- working preset (a mutable copy of the persisted one) --------
     Only the OPENING values are snapshotted here. Everything that feeds an
     estimate or the export itself reads `session.project` live, so an edit made
     while this dialog is open is the one that gets exported. */
  const start = session.project.export;
  let format: Format = start.format;
  let codec: Codec = start.vcodec;
  let resolution: ResolutionPreset = start.resolution;
  let fps: "original" | number = start.fps;
  let videoBitrate: "auto" | number = start.videoBitrate;
  let audioBitrate: "auto" | number = start.audioBitrate;
  /* What the PROJECT asked for, and nothing else. The global "Hardware
     acceleration" setting is applied where the export is built (see runPreset),
     never folded in here — folding it in is what let a global toggle overwrite a
     per-project choice for good. */
  let useHardware = start.useHardware;

  /** Set when the container could not mux the codec that was asked for, so the
   *  form can say which one it moved to instead of changing under the user. */
  let codecNote: string | null = null;

  const settings = settingsStore.get();
  let folder = settings.lastExportDir ?? settings.defaultExportDir ?? "";
  let filename = sanitizeFileName(session.project.name);

  let encoders: EncoderReport | null = null;

  /** Move `codec` to something `next` can actually mux, remembering whether it
   *  had to. Runs on open as well as on every format switch. */
  function adoptFormat(next: Format): void {
    const resolved = resolveCodec(next, codec);
    codecNote =
      resolved === codec
        ? null
        : `${CODEC_LABELS[codec]} can't be stored in a ${FORMAT_LABELS[next]} file — using ${CODEC_LABELS[resolved]}.`;
    codec = resolved;
    format = next;
  }
  // A project saved by an older build can carry an impossible pair (MOV+AV1).
  adoptFormat(format);

  /* -------- build the current preset object -------- */

  /** What gets PERSISTED into the project: the user's answers, verbatim. */
  function projectPreset(): ExportPreset {
    // Read the persisted preset LIVE (same rule as everything else here), so a
    // field this dialog does not own survives even if it changed while the
    // dialog was open. See mergeExportPreset for why the spread order matters.
    return mergeExportPreset(session.project.export, {
      format,
      vcodec: codec,
      resolution,
      fps,
      videoBitrate,
      audioBitrate,
      useHardware,
    });
  }

  /** Which encoder the probe found for the codec on screen, or null if the
   *  probe has not answered yet (GIF has no video codec at all). */
  function currentEncoder(): string | null {
    if (!encoders || format === "gif") return null;
    return encoders[codec];
  }

  function hardwareBlock(): HardwareBlock {
    // Read the setting live, like everything else in this dialog.
    return hardwareBlockedBy({
      globalEnabled: settingsStore.get().hardwareAccel,
      encoder: currentEncoder(),
    });
  }

  /** Whether THIS export actually runs on hardware. */
  function effectiveHardware(): boolean {
    return useHardware && hardwareBlock() === null;
  }

  /** What THIS export runs with: the project's preset, hardware gated. */
  function runPreset(): ExportPreset {
    return gateHardware(projectPreset(), hardwareBlock());
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
  /** Set by close() so an in-flight async listener registration can tell that
   *  the dialog is already gone (see beginExport). */
  let closed = false;
  let jobId: number | null = null;
  /** Last whole-percent pushed to the taskbar; -1 = nothing pushed yet. */
  let lastTaskbarPct = -1;
  let unlistenJobs: (() => void) | null = null;
  let estimateTimer: number | undefined;

  /* -------- lifecycle -------- */
  function close(): void {
    if (exporting) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    releaseTrap();
    window.clearTimeout(estimateTimer);
    if (unlistenJobs) {
      unlistenJobs();
      unlistenJobs = null;
    }
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

    const canvas = session.project.timeline;
    const customW = isCustomRes ? (resolution as { w: number; h: number }).w : canvas.width;
    const customH = isCustomRes ? (resolution as { w: number; h: number }).h : canvas.height;
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
        <div class="export-note" id="ex-codec-note" ${codecNote && showCodec ? "" : "hidden"}>${escapeHtml(codecNote ?? "")}</div>

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
            <input class="switch" type="checkbox" id="ex-hw" />
          </div>
        </div>
        <div class="export-note" id="ex-hw-note" hidden></div>

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
    updateHardwareRow();
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
      // Sets `format` AND moves the codec to one this container can mux,
      // leaving a note when it had to.
      adoptFormat(next);
      // gif caps fps at 30
      if (format === "gif" && fps !== "original" && (fps as number) > 30) fps = 30;
      renderForm();
    });

    $<HTMLSelectElement>("#ex-codec").addEventListener("change", (e) => {
      codec = (e.target as HTMLSelectElement).value as Codec;
      // The user has now made the call themselves; the note has served its turn.
      codecNote = null;
      const note = backdrop.querySelector<HTMLElement>("#ex-codec-note");
      if (note) note.hidden = true;
      updateEncoderBadge();
      updateHardwareRow();
      scheduleEstimate();
    });

    const resSel = $<HTMLSelectElement>("#ex-res");
    resSel.addEventListener("change", () => {
      const v = resSel.value;
      if (v === "custom") {
        const canvas = session.project.timeline;
        resolution = { w: canvas.width, h: canvas.height };
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
      // Only reachable while the switch is enabled, i.e. while nothing outside
      // the project is gating hardware — so this really is the project's own
      // preference, and it is the only thing that ever writes it.
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
    const name = currentEncoder();
    if (name === null) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.textContent = encoderBadge(name);
  }

  /**
   * Point the hardware switch at what THIS export will do, and say why when
   * that differs from what the project asked for.
   *
   * The switch shows `effectiveHardware()`, not `useHardware`: when the global
   * setting is off, or the codec has no hardware encoder on this machine, the
   * export genuinely runs in software and the switch should not claim
   * otherwise. It is disabled in exactly those cases, which is what keeps
   * `useHardware` — the project's own preference — from ever being written by
   * anything but a real click on an enabled switch. Re-enable the setting and
   * the project's choice is simply there again.
   */
  function updateHardwareRow(): void {
    const blocked = hardwareBlock();
    const hw = backdrop.querySelector<HTMLInputElement>("#ex-hw");
    if (hw) {
      hw.checked = effectiveHardware();
      hw.disabled = blocked !== null;
    }
    const note = backdrop.querySelector<HTMLElement>("#ex-hw-note");
    if (note) {
      note.hidden = blocked === null || format === "gif";
      note.textContent =
        blocked === "setting"
          ? "Hardware acceleration is off in Settings, so this export runs in software. Your project keeps its own preference."
          : blocked === "codec"
            ? "No hardware encoder for this codec on this machine — this export runs in software."
            : "";
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
    // Read the project live: an edit made while the dialog is open must be the
    // one we estimate (and export).
    const live = session.project;
    // Only the four scalars the estimate reads — never the media list or the
    // clips. See EstimateInput for the measured reason (16.9 ms of UI-thread
    // JSON.stringify on a 1600-clip project, on a 300 ms debounce, per control
    // change). The derivation here is the one the backend used to do itself.
    const tl = live.timeline;
    try {
      const est = await estimateExport({
        durationSec: timelineDuration(tl),
        width: tl.width,
        height: tl.height,
        fps: tl.fps.num / Math.max(1, tl.fps.den),
        // The estimate has to describe the encode that will actually run, so
        // it reads the gated preset — not the project's stored preference.
        preset: runPreset(),
      });
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

    // Persist the preset into the project + remember the folder. This is the
    // UNGATED preset on purpose: the project records what the user asked for,
    // and a global setting (or a machine with no hardware encoder) must never
    // get to rewrite that. runPreset() is what the export itself is handed.
    session.replace({ ...session.project, export: projectPreset() });
    // SAY SO if the write fails. Nothing else here reports it: the export runs
    // regardless, so a bare `void` meant a rejected write silently cost the user
    // their remembered destination — the next export opened somewhere else with
    // no explanation. Same shape as settings.ts persist().
    void updateSettings({ lastExportDir: folder }).catch((e: unknown) => {
      toast.error("Couldn't save your settings.", {
        detail: describeError(e),
        op: "Settings",
        title: "Export folder",
      });
    });

    const target = outPath();
    if (await pathExists(target)) {
      showOverwriteWarning(
        () => void beginExport(target),
        () => {
          // auto-suffix until the filesystem says the name is free
          void resolveRenameThenExport();
        },
      );
      return;
    }
    void beginExport(target);
  }

  async function resolveRenameThenExport(): Promise<void> {
    const ext = currentExt();
    const dir = folder;
    // The numbering lives in renameWithSuffix — the same function the unit
    // tests drive — and the filesystem is the predicate. There is no second
    // copy of this loop to drift away from the tested one.
    const free = await renameWithSuffix(filename, (candidate) =>
      pathExists(joinPath(dir, `${candidate}.${ext}`)),
    );
    if (free === null) {
      // Every candidate was taken. The old loop fell out of its guard holding
      // the last one and exported over it; there is no free name to offer, so
      // say so and write nothing.
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
    const nameInput = backdrop.querySelector<HTMLInputElement>("#ex-name");
    if (nameInput) nameInput.value = filename;
    refreshOutPath();
    void beginExport(outPath());
  }

  /* ============================================================
     PROGRESS VIEW
     ============================================================ */

  async function beginExport(target: string): Promise<void> {
    lastTaskbarPct = -1;
    const live = session.project;
    const spec: ExportSpec = {
      media: live.media,
      timeline: live.timeline,
      preset: runPreset(),
      outPath: target,
    };

    exporting = true;
    renderProgress();

    // Listen before starting so we don't miss the first progress event.
    try {
      const un = await onJobEvents({
        onProgress: (e) => handleProgress(e),
        onDone: (e) => handleDone(e),
        onFailed: (e) => handleFailed(e),
      });
      // Registration is async. The `exporting` flag makes close() a no-op while
      // this is in flight today, but never rely on that: if the dialog did go
      // away, drop the listener here rather than leaking it for the rest of the
      // process (a later job event would then drive a detached dialog).
      if (closed) un();
      else unlistenJobs = un;
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
      renderError(errorDetail(e), []);
    }
  }

  function renderProgress(): void {
    bodyEl.innerHTML = `
      <div class="export-progress">
        <div class="export-progress__pct" id="ex-pct">0%</div>
        <div class="export-bar"><div class="export-bar__fill" id="ex-fill"></div></div>
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
    // Progress events arrive ~10x/s but the taskbar only has 100 states, so
    // most calls would be an IPC round-trip that sets the value it already has.
    if (pct !== lastTaskbarPct) {
      lastTaskbarPct = pct;
      void setTaskbarProgress(ratio);
    }
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
    renderError({ code: "", message: e.message }, e.logTail);
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

  /** Assemble the diagnostic report for a failed export. Everything here is
   *  on-demand: nothing is collected or kept while exports succeed. */
  async function collectReport(
    err: { code: string; message: string },
    logTail: string[],
  ): Promise<{ short: string; full: string }> {
    // The report builder is loaded here and nowhere else: a session that never
    // sees an export fail never downloads or parses it.
    const [{ buildReport }, version, failure] = await Promise.all([
      import("../../core/diagnostics"),
      appVersion(),
      // The backend command may not answer (older build); the log tail we were
      // handed with the failure event still carries the useful part.
      ipc.exportFailureReport().catch(() => null),
    ]);
    const base: ReportContext = {
      at: new Date().toISOString(),
      appVersion: version,
      platform: navigator.platform || "",
      userAgent: navigator.userAgent,
      operation: "Export",
      error: { code: err.code, message: err.message },
      ffmpeg: {
        argv: failure?.argv ?? [],
        filterComplex: failure?.filterComplex ?? "",
        message: failure?.message ?? err.message,
        logTail: failure?.logTail?.length ? failure.logTail : logTail,
        ffmpegVersion: failure?.ffmpegVersion ?? "",
      },
      // The preset ffmpeg was actually handed — that is the one being debugged.
      preset: runPreset(),
      destinationSet: folder !== "",
      encoders,
      project: session.project,
      settings: settingsStore.get(),
      recentErrors: recentErrors(),
    };
    return {
      short: buildReport({ ...base, full: false }),
      full: buildReport({ ...base, full: true }),
    };
  }

  function renderError(err: { code: string; message: string }, logTail: string[]): void {
    jobId = null;
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--bad">${icon("warning", 22)}</div>
        <div class="export-result__title">Export failed</div>
        <div class="export-result__msg">${escapeHtml(err.message)}</div>
      </div>
    `;
    const seed = logTail.length ? logTail.join("\n") : err.message;
    recordError({ at: Date.now(), op: "Export", message: err.message, detail: seed });

    // The detail pane is ALWAYS visible and always a <textarea>: an export
    // failure is not a "you might want this" moment, and a <pre> here is what
    // locked the issue-#1 reporter out of copying their own log.
    const pane = detailPane(seed);
    const ta = pane.querySelector<HTMLTextAreaElement>(".err-detail")!;
    const actions = pane.querySelector<HTMLElement>(".err-pane__actions")!;

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn--sm";
    saveBtn.textContent = "Save report";
    actions.appendChild(saveBtn);

    const hint = document.createElement("div");
    hint.className = "err-hint";
    hint.textContent = "The saved file also includes the full filter graph.";
    pane.appendChild(hint);
    bodyEl.querySelector(".export-result")!.appendChild(pane);

    // Swap the raw log for the full report as soon as it is assembled.
    let fullReport: string | null = null;
    void collectReport(err, logTail)
      .then((built) => {
        if (!ta.isConnected) return;
        ta.value = built.short;
        fullReport = built.full;
      })
      .catch(() => {
        /* the pane already holds the raw log — nothing is lost */
      });

    saveBtn.addEventListener("click", () => {
      const content = fullReport ?? ta.value;
      saveBtn.disabled = true;
      void ipc
        .saveDiagnosticReport(content)
        .then((path) => {
          toast.info("Report saved");
          void revealInExplorer(path);
        })
        .catch((e: unknown) => {
          // The report rides along as the detail, so a failed write never costs
          // the user the text they asked for.
          toast.error("Couldn't save the report.", {
            detail: `${describeError(e)}\n\n${content}`,
            op: "Export",
            title: "Diagnostic report",
          });
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });

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
      // The probe is what tells us whether this codec has a hardware encoder at
      // all, so the switch can only settle once it lands.
      updateHardwareRow();
    })
    .catch(() => {
      /* estimate + export still work; badge just stays hidden */
    });
}
