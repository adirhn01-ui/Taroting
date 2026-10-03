// The export dialog: a single centered modal that collects an ExportPreset +
// destination, estimates size live, then runs the export with progress / ETA /
// cancel and a success / error result view.

import "./export.css";
import { registerCloseTask } from "../../core/app-close";
import { createExportRunHold } from "../../core/export-hold";
import type { ReportContext } from "../../core/diagnostics";
import { escapeHtml, fileExt, formatBytes } from "../../core/format";
import { appVersion, describeError, errorDetail, ipc, onJobEvents } from "../../core/ipc";
import type { JobDone, JobFailed, JobProgress } from "../../core/ipc";
import { ProjectSession, settingsStore, updateSettings } from "../../core/session";
import { timelineDuration } from "../../core/time";
import type { ExportPreset, FontFamily, ProjectFile, ResolutionPreset } from "../../core/types";
import { detailPane, recentErrors, recordError } from "../../ui/errors";
import { focusFirst, trapTab } from "../../ui/focus";
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

/** Strip characters Windows forbids in file names, collapse whitespace.
 *  Control characters (U+0000–U+001F) are forbidden too: a project name that
 *  carried one reached the OS as an opaque "invalid argument" with nothing on
 *  screen to say which character it meant. They go before the whitespace
 *  collapse, so a stray tab or newline does not survive as a space either. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "export";
}

/**
 * Why `folder` cannot be an export destination, or null when it can.
 *
 * The folder field is free text and used to be taken verbatim — and saved as
 * the remembered export folder before anything checked it, so "Videos" or
 * "./out" (resolved against wherever the process happens to run) became the
 * default for every later export, image exports included. Only a full path is
 * a destination: a drive path (`C:\…`, `C:/…`) or a network share (`\\server\…`).
 * Whether it exists is the caller's second, asynchronous question.
 */
export function destinationProblem(folder: string): string | null {
  if (folder.trim() === "") return "Choose a folder for the export.";
  if (/^[A-Za-z]:[\\/]/.test(folder) || /^\\\\[^\\]/.test(folder)) return null;
  return "Enter a full folder path, like C:\\Videos, or choose one.";
}

/** What the export says when the typed folder is a full path to nothing. */
export const MISSING_FOLDER = "That folder doesn't exist.";

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
  // The base is a value out of a `.trt`. Spreading a string would copy its
  // characters in as keys "0", "1", … and save them back into the project, so
  // anything that is not a plain object contributes nothing.
  const kept = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  return { ...kept, ...edits };
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

/**
 * The opening format, taken from the project's persisted preset — which is a
 * value out of a `.trt` file, not out of this dialog. The type says it is one of
 * five strings; a crafted project, or one saved by a newer build with a format
 * this one does not know, says otherwise. Left as-is it named the output file
 * (`clip.mkv`), labelled the save filter, and reached the backend, which now
 * refuses it. A format this build does not write opens as MP4 instead.
 */
export function whitelistFormat(value: unknown): Format {
  return FORMATS.some((f) => f.value === value) ? (value as Format) : "mp4";
}

/**
 * The opening codec, whitelisted the same way. It has to be settled BEFORE
 * `resolveCodec` sees it: that indexes `CODEC_FALLBACK[wanted]`, and an unknown
 * codec there is `undefined.find(...)`, a TypeError that takes the whole dialog
 * down on open. An unknown one opens as the format's first choice rather than as
 * a fixed H.264, so WebM does not arrive with a note about moving the user off
 * an H.264 they never picked.
 */
export function whitelistCodec(value: unknown, format: Format): Codec {
  const known = Object.keys(CODEC_LABELS) as Codec[];
  return known.includes(value as Codec) ? (value as Codec) : codecsForFormat(format)[0]!;
}

/** A path compared the way Windows names files: separators unified, ASCII case
 *  folded. ASCII only, on purpose: `toLowerCase` is full Unicode while NTFS
 *  folds with a much narrower table, so "Straße" and "Straẞe" (or a Kelvin
 *  sign and a K) are two files there and must not read as one. A UI hint only —
 *  the backend asks the filesystem itself. */
function comparablePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * What Export says instead of running, or null when there is something to
 * export. Import is bin-first, so every new project and every fresh import
 * starts with no clip placed — a normal state, not a fault, and it must not
 * reach the failure view (or the Diagnostics log) through the backend's refusal.
 */
export function nothingToExport(p: ProjectFile): string | null {
  return p.timeline.tracks.every((t) => t.clips.length === 0) ? "Add a clip to the timeline first." : null;
}

/**
 * Whether the export will carry any sound: some placed clip is audible. The
 * exact rule of the backend's `clip_audible` (media has audio, the clip is
 * neither muted nor detached, its track is not muted) — the backend writes a
 * project with none as `-an`, and the size estimate has to price the same file.
 *
 * Runs on every estimate (a 300 ms debounce per control change), so it is one
 * pass that stops at the first audible clip, never touches a muted track's
 * clips, and allocates only the set of media that carry audio at all.
 */
export function exportHasAudio(p: Pick<ProjectFile, "media" | "timeline">): boolean {
  const audible = new Set<string>();
  for (const m of p.media) if (m.hasAudio) audible.add(m.id);
  if (audible.size === 0) return false;
  for (const t of p.timeline.tracks) {
    if (t.muted) continue;
    for (const c of t.clips) {
      if (!c.audio.muted && !c.audio.detached && audible.has(c.mediaId)) return true;
    }
  }
  return false;
}

/* ---------------- text the export font cannot draw ---------------- */

type Range = readonly [number, number];

/** Code points every one of the six export faces draws: Latin (with the
 *  extended blocks and combining marks), Greek, Cyrillic, punctuation,
 *  currency, letterlike symbols, number forms, arrows, maths operators, box
 *  drawing and geometric shapes, plus the handful of WGL4 symbols (☺ ♀ ♠ ♥ ♪)
 *  that Georgia and Impact, the two narrowest faces, also carry. */
const COMMON_GLYPHS: readonly Range[] = [
  [0x0000, 0x036f],
  [0x0370, 0x03ff],
  [0x0400, 0x052f],
  [0x1e00, 0x1eff],
  [0x2000, 0x200c],
  [0x200e, 0x206f],
  [0x2070, 0x20cf],
  [0x2100, 0x22ff],
  [0x2500, 0x25ff],
  [0x263a, 0x263c],
  [0x2640, 0x2640],
  [0x2642, 0x2642],
  [0x2660, 0x2660],
  [0x2663, 0x2663],
  [0x2665, 0x2666],
  [0x266a, 0x266b],
  [0xfb00, 0xfb06],
];

/** Hebrew, Arabic (with its presentation forms) and Greek Extended: in the
 *  Segoe UI, Arial, Times New Roman and Courier New files, not in Georgia or
 *  Impact. */
const RTL_AND_GREEK_EXT: readonly Range[] = [
  [0x0590, 0x05ff],
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x1f00, 0x1fff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
];

/** Segoe UI alone adds Armenian, Georgian and the later Latin extensions. */
const SEGOE_EXTRA: readonly Range[] = [
  [0x0530, 0x058f],
  [0x10a0, 0x10ff],
  [0x2c60, 0x2c7f],
  [0xa720, 0xa7ff],
];

const FONT_COVERAGE: Record<FontFamily, readonly (readonly Range[])[]> = {
  "Segoe UI": [COMMON_GLYPHS, RTL_AND_GREEK_EXT, SEGOE_EXTRA],
  Arial: [COMMON_GLYPHS, RTL_AND_GREEK_EXT],
  "Times New Roman": [COMMON_GLYPHS, RTL_AND_GREEK_EXT],
  "Courier New": [COMMON_GLYPHS, RTL_AND_GREEK_EXT],
  Georgia: [COMMON_GLYPHS],
  Impact: [COMMON_GLYPHS],
};

/**
 * Whether the export's font file for `family` has a glyph for code point `cp`.
 *
 * The export draws text with ONE whitelisted font file and no fallback, while
 * the preview is Chromium, which borrows any missing glyph from another font —
 * so an emoji, a CJK title or a Thai caption looks right in the editor and
 * exports as empty boxes. This is a conservative, table-driven view of what
 * each of the six files covers (the faces `font_file` maps them to): it says
 * "missing" only for blocks the file certainly lacks — emoji and pictographs,
 * dingbats, CJK, the Indic and South-East Asian scripts — so a warning built on
 * it never fires on ordinary text. The zero-width joiner and the emoji
 * presentation selector (U+FE0F) count as missing: they only ever appear inside
 * an emoji the preview draws in colour and the export cannot.
 *
 * Measuring with a canvas cannot answer this: canvas text falls back per glyph
 * exactly like the preview, so it measures the borrowed glyph.
 */
export function fontHasGlyph(family: FontFamily, cp: number): boolean {
  const tables = FONT_COVERAGE[family] ?? FONT_COVERAGE["Segoe UI"];
  for (const ranges of tables) {
    for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** How many example characters the warning quotes. */
const MISSING_GLYPH_SAMPLES = 3;

/**
 * The characters of placed text clips that the export's font cannot draw, as
 * up to three distinct user-visible characters (whole graphemes, so a family
 * emoji joined with ZWJs is quoted as one character, not as fragments).
 * Empty when there are none. A text media sitting in the bin is never drawn,
 * so only text a clip actually uses is read.
 */
export function unsupportedTextSamples(p: Pick<ProjectFile, "media" | "timeline">): string[] {
  const used = new Set<string>();
  for (const t of p.timeline.tracks) for (const c of t.clips) used.add(c.mediaId);
  const found: string[] = [];
  let segmenter: Intl.Segmenter | null = null;
  for (const m of p.media) {
    const g = m.generator;
    if (g?.type !== "text" || !used.has(m.id) || typeof g.text !== "string") continue;
    // Cheap first pass: most text is plain, and needs no segmenter at all.
    let any = false;
    for (const ch of g.text) {
      if (!fontHasGlyph(g.fontFamily, ch.codePointAt(0)!)) {
        any = true;
        break;
      }
    }
    if (!any) continue;
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { segment } of segmenter.segment(g.text)) {
      if (found.includes(segment)) continue;
      for (const ch of segment) {
        if (!fontHasGlyph(g.fontFamily, ch.codePointAt(0)!)) {
          found.push(segment);
          break;
        }
      }
      if (found.length >= MISSING_GLYPH_SAMPLES) return found;
    }
  }
  return found;
}

/** The export form's note for `samples`, or null when there is nothing to say.
 *  A note, never a refusal: the export still runs, and the user decides. */
export function missingGlyphNote(samples: readonly string[]): string | null {
  if (samples.length === 0) return null;
  return `Some characters in your text, like ${samples.join(" ")}, aren't in the text's font, so the export will show empty boxes in their place.`;
}

/**
 * Whether `target` is one of the files this project reads. Exporting onto one
 * would replace an original, so the overwrite strip must not offer Replace for
 * it. Generated media have no file (their `path` is a placeholder) and never
 * match. The backend refuses the same export on its own; this only keeps the
 * dialog from offering a button that is bound to fail.
 */
export function isProjectSource(
  target: string,
  media: readonly { path: string; generator?: unknown }[],
): boolean {
  const want = comparablePath(target);
  return media.some((m) => !m.generator && comparablePath(m.path) === want);
}

/** What the Export button may do with the chosen path: write it (`free`),
 *  offer to replace what is there (`replace`), or refuse it because it is one
 *  of the project's own files (`ownFile`: no Replace, only another name). A
 *  path that does not exist yet cannot be a source, exactly as the backend
 *  decides it. */
export type OverwriteOffer = "free" | "replace" | "ownFile";

export function overwriteOffer(
  target: string,
  exists: boolean,
  media: readonly { path: string; generator?: unknown }[],
): OverwriteOffer {
  if (!exists) return "free";
  return isProjectSource(target, media) ? "ownFile" : "replace";
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

/** A custom export size's side, in px. The floor is the dialog's own `min`;
 *  the ceiling is past 8K on either axis, far beyond anything the encoders
 *  take, and keeps the value a small integer the backend's `u32` accepts. */
export const RES_MIN = 16;
export const RES_MAX = 16384;
/** Frame-rate bounds: the custom field's own range (GIF tops out lower). */
export const FPS_MAX = 240;
export const GIF_FPS_MAX = 30;
/** Bitrate bounds in kbps. The floors are the custom fields' `min`; the
 *  ceilings only keep a crafted number inside what ffmpeg and the backend's
 *  `u64` can be handed. */
export const VIDEO_KBPS_MIN = 100;
export const VIDEO_KBPS_MAX = 1_000_000;
export const AUDIO_KBPS_MIN = 32;
export const AUDIO_KBPS_MAX = 3_000;

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function sanitizeBitrate(v: unknown, lo: number, hi: number): "auto" | number {
  return finiteNumber(v) && v > 0 ? clampInt(v, lo, hi) : "auto";
}

/**
 * A project's persisted export preset — a value out of a `.trt`, so untrusted —
 * as one this dialog can render and the backend can parse.
 *
 * The dialog used to whitelist only the format and the codec. Everything else
 * was interpolated straight into the form's markup (`value="${…}"`), so a
 * crafted string fps or width became attributes and elements of its own (the
 * CSP stops script, not markup); `export: null` threw before the dialog
 * painted; `resolution: null` left an empty modal; a string bitrate or a
 * fractional width reached Rust, whose `u64`/`u32` refuse it, as a failed
 * export. Every field now arrives as the type its control expects, or as the
 * control's own default.
 *
 * Fields this build does not own are not the business of this function: the
 * persisted preset stays the merge base for `mergeExportPreset`, so a newer
 * build's keys survive the save exactly as before.
 */
export function sanitizeExportPreset(raw: unknown): PresetEdits {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const format = whitelistFormat(o.format);
  const vcodec = whitelistCodec(o.vcodec, format);

  let resolution: ResolutionPreset = "original";
  const r = o.resolution;
  if (typeof r === "string" && r !== "custom" && RESOLUTIONS.some((x) => x.value === r)) {
    resolution = r as ResolutionPreset;
  } else if (r && typeof r === "object") {
    const { w, h } = r as { w?: unknown; h?: unknown };
    if (finiteNumber(w) && finiteNumber(h)) {
      resolution = { w: clampInt(w, RES_MIN, RES_MAX), h: clampInt(h, RES_MIN, RES_MAX) };
    }
  }

  // GIF caps the frame rate the same way the format switch does (and the
  // backend after it): an over-cap value becomes the cap, not "original".
  let fps: "original" | number = "original";
  if (finiteNumber(o.fps) && o.fps >= 1 && o.fps <= FPS_MAX) {
    fps = format === "gif" ? Math.min(o.fps, GIF_FPS_MAX) : o.fps;
  }

  return {
    format,
    vcodec,
    resolution,
    fps,
    videoBitrate: sanitizeBitrate(o.videoBitrate, VIDEO_KBPS_MIN, VIDEO_KBPS_MAX),
    audioBitrate: sanitizeBitrate(o.audioBitrate, AUDIO_KBPS_MIN, AUDIO_KBPS_MAX),
    useHardware: o.useHardware === true,
  };
}

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

/** The success view's note when the backend redid a failed hardware encode in
 *  software. Calm, and with no action: the file is there and it is fine. */
export const HW_FALLBACK_NOTE = "Hardware encoding failed, so this export used the CPU instead.";

/**
 * Whether a finished export job was redone in software after its hardware
 * encode failed. The backend adds `hwFallback: true` to the export job's done
 * output in exactly that case (and omits it otherwise). Strictly `true`: the
 * output is a loose JSON record, and nothing but the real flag may claim the
 * hardware failed.
 */
export function usedSoftwareFallback(output: Record<string, unknown> | null | undefined): boolean {
  return output?.hwFallback === true;
}

/** Human ETA like "about 12s left" / "about 2m left". */
function formatEta(sec: number): string {
  if (sec < 1) return "less than a second left";
  if (sec < 60) return `about ${Math.round(sec)}s left`;
  const m = Math.round(sec / 60);
  return `about ${m}m left`;
}

// The export run hold is shared with the image editor's export dialog (its own
// chunk), so it lives in core/export-hold — off the boot path.
export { EXPORT_RUNNING_REASON, createExportRunHold, type ExportRunHold } from "../../core/export-hold";

/* ---------------- dialog ---------------- */

export function openExportDialog(ctx: { session: ProjectSession }): () => void {
  const { session } = ctx;

  /* -------- working preset (a mutable copy of the persisted one) --------
     Only the OPENING values are snapshotted here. Everything that feeds an
     estimate or the export itself reads `session.project` live, so an edit made
     while this dialog is open is the one that gets exported. */
  // Sanitized first, every field: everything below (the file extension, the
  // codec list, the gif-only rows, the form's markup) is derived from these.
  const start = sanitizeExportPreset(session.project.export);
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
  /** False until the form has been painted once — the difference between
   *  opening the dialog and returning to the form from another view. */
  let formPainted = false;
  /** Set by close() so an in-flight async listener registration can tell that
   *  the dialog is already gone (see beginExport). */
  let closed = false;
  let jobId: number | null = null;
  /** Last whole-percent pushed to the taskbar; -1 = nothing pushed yet. */
  let lastTaskbarPct = -1;
  let unlistenJobs: (() => void) | null = null;
  let estimateTimer: number | undefined;
  /** The startExport call still awaiting its job id, if any. A window close in
   *  that gap waits for it, so the job it is about to start gets canceled too
   *  instead of running on after the window is gone. */
  let starting: Promise<unknown> | null = null;
  /** Set by the window close. A run still registering its job listener (before
   *  startExport was even called) sees it and never starts the job at all. */
  let closeCanceled = false;
  const runHold = createExportRunHold(session, registerCloseTask, async () => {
    closeCanceled = true;
    if (jobId === null && starting) await starting.catch(() => {});
    // The dialog's own Cancel path: kill the job, release the hold.
    if (jobId !== null) await onCancelExport();
  });

  /* -------- lifecycle -------- */
  function close(): void {
    if (exporting) return;
    closed = true;
    // Belt and braces: every run path releases on its own, and close() is a
    // no-op while one is running — but a dialog that is gone must never leave
    // the session blocked.
    runHold.release();
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
              <input class="input export-num" id="ex-res-w" type="number" min="16" step="2" value="${Number(customW)}" aria-label="Width" />
              <span class="export-dim-x">×</span>
              <input class="input export-num" id="ex-res-h" type="number" min="16" step="2" value="${Number(customH)}" aria-label="Height" />
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
              type="number" min="1" max="${format === "gif" ? GIF_FPS_MAX : FPS_MAX}" step="1" value="${Number(customFps)}" aria-label="Custom frame rate" />
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
              type="number" min="100" step="100" value="${videoBitrate === "auto" ? 8000 : Number(videoBitrate)}" aria-label="Video bitrate kbps" />
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
              type="number" min="32" step="16" value="${audioBitrate === "auto" ? 192 : Number(audioBitrate)}" aria-label="Audio bitrate kbps" />
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
        <div class="export-note export-note--block" id="ex-glyph-note" hidden></div>
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
    updateGlyphNote();
    scheduleEstimate();
    seatFormFocus();
  }

  /** Say so, without stopping anything, when placed text uses characters the
   *  export's font file cannot draw (see fontHasGlyph). Read from the live
   *  project on every paint of the form, so returning from an edit is current.
   *  Written as text: the samples are the user's own characters. */
  function updateGlyphNote(): void {
    const el = backdrop.querySelector<HTMLElement>("#ex-glyph-note");
    if (!el) return;
    const note = missingGlyphNote(unsupportedTextSamples(session.project));
    el.hidden = note === null;
    el.textContent = note ?? "";
  }

  /** Focus lives in the body this function just replaced. Every view swap here
   *  destroys the focused node — the select the user changed, the Back button
   *  they clicked, the Export button — and focus falls to <body>, where
   *  `trapTab` (a listener on the backdrop) never sees a keydown again. So the
   *  filename field, the form's natural entry point, takes it back.
   *
   *  Only when focus really did fall out: a control that survived the swap (the
   *  header's Close) keeps it. */
  function seatFormFocus(): void {
    const first = !formPainted;
    formPainted = true;
    if (backdrop.contains(document.activeElement)) return;
    const nameInput = $<HTMLInputElement>("#ex-name");
    nameInput.focus();
    // Pre-selected on the first paint only, so a name typed straight after
    // opening replaces the suggestion. On a RE-render the user was reaching for
    // a control, not the name, and a selected field would turn their next
    // keystroke into a rename.
    if (first) nameInput.select();
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
      if (format === "gif" && fps !== "original" && (fps as number) > GIF_FPS_MAX) fps = GIF_FPS_MAX;
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
      const w = clampInt(Number($<HTMLInputElement>("#ex-res-w").value) || 0, RES_MIN, RES_MAX);
      const h = clampInt(Number($<HTMLInputElement>("#ex-res-h").value) || 0, RES_MIN, RES_MAX);
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
      const cap = format === "gif" ? GIF_FPS_MAX : FPS_MAX;
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
        videoBitrate = clampInt(Number((e.target as HTMLInputElement).value) || VIDEO_KBPS_MIN, VIDEO_KBPS_MIN, VIDEO_KBPS_MAX);
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
        audioBitrate = clampInt(Number((e.target as HTMLInputElement).value) || AUDIO_KBPS_MIN, AUDIO_KBPS_MIN, AUDIO_KBPS_MAX);
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
        // A silent export is written with `-an`; without this the estimate
        // priced an audio stream the file will never have.
        hasAudio: exportHasAudio(live),
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
    // The editor can close while Save As is open (an Explorer open disposes
    // it): a destination picked for a dialog that no longer exists starts
    // nothing — and re-arms no estimate timer.
    if (!chosen || closed) return null;
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
  /** `onReplace: null` is the strip for one of the project's own source files:
   *  the name is refused outright, so there is no Replace to offer — only a
   *  different name, or Cancel. */
  function showOverwriteWarning(onReplace: (() => void) | null, onRename: () => void): void {
    const slot = backdrop.querySelector<HTMLElement>("#ex-warn-slot");
    if (!slot) return;
    const msg =
      onReplace === null
        ? "This is one of this project's own files. Choose another name."
        : "A file with this name already exists.";
    slot.innerHTML = `
      <div class="export-warn">
        ${icon("warning", 16)}
        <div class="export-warn__msg">${msg}</div>
        <div class="export-warn__actions">
          ${onReplace === null ? "" : `<button class="btn btn--sm" data-w="replace">Replace</button>`}
          <button class="btn btn--sm" data-w="rename">Rename</button>
          <button class="btn btn--sm" data-w="cancel">Cancel</button>
        </div>
      </div>`;
    // Clearing the strip removes the button that was just clicked, and focus
    // falls to <body>, where the Tab trap never sees a key again. Seat it on
    // Export once the strip is gone (checked AFTER the clear: during its own
    // click the button is still inside the dialog). Replace and Rename move
    // on to the progress view, which seats its own focus over this.
    const clear = (): void => {
      slot.innerHTML = "";
      reseatAfterStrip();
    };
    if (onReplace !== null) {
      slot.querySelector('[data-w="replace"]')!.addEventListener("click", () => {
        clear();
        onReplace();
      });
    }
    slot.querySelector('[data-w="rename"]')!.addEventListener("click", () => {
      clear();
      onRename();
    });
    slot.querySelector('[data-w="cancel"]')!.addEventListener("click", clear);
  }

  /** Put focus back inside the dialog when it fell out (see the strip's
   *  clear()). A control that still holds it keeps it. */
  function reseatAfterStrip(): void {
    if (!backdrop.contains(document.activeElement)) focusFirst(backdrop, "#ex-run");
  }

  /* -------- Export click flow -------- */
  async function onExportClick(): Promise<void> {
    // Before any Save As dialog: there is nothing to ask a destination for.
    // An info toast on purpose: a timeline with no clips is where every new
    // project starts, not a mistake to flag in red.
    const nothing = nothingToExport(session.project);
    if (nothing) {
      toast.info(nothing);
      return;
    }
    // Force a Save As dialog if we have no destination folder at all.
    if (!folder) {
      const picked = await chooseDestination();
      if (!picked) return;
    }
    if (!filename) {
      toast.refuse("Please enter a file name.");
      return;
    }
    // The destination is checked BEFORE anything is persisted below: a typed
    // folder that is not a full path, or names nothing, must not become the
    // remembered export folder (it is the image export's default too).
    const bad = destinationProblem(folder);
    if (bad) {
      toast.refuse(bad);
      return;
    }
    const folderExists = await pathExists(folder);
    if (closed) return;
    if (!folderExists) {
      toast.refuse(MISSING_FOLDER);
      return;
    }

    // Persist the preset into the project + remember the folder. This is the
    // UNGATED preset on purpose: the project records what the user asked for,
    // and a global setting (or a machine with no hardware encoder) must never
    // get to rewrite that. runPreset() is what the export itself is handed.
    // `edit: false`: saving the export settings is not the user changing the
    // project, so it must not make an untouched temporary project ask "keep?"
    // when the window closes.
    session.replace({ ...session.project, export: projectPreset() }, { edit: false });
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
    // Media read live, like everything else the export is built from.
    const exists = await pathExists(target);
    if (closed) return;
    const offer = overwriteOffer(target, exists, session.project.media);
    if (offer !== "free") {
      showOverwriteWarning(
        offer === "replace" ? () => void beginExport(target) : null,
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
    if (closed) return;
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
      // The strip that offered Rename is gone; keep focus inside the dialog.
      reseatAfterStrip();
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
    // Nothing starts for a dialog that has already closed: a run begun here
    // would hold the session with no progress view to ever release it.
    if (exporting || closed) return;
    lastTaskbarPct = -1;
    const live = session.project;
    const spec: ExportSpec = {
      media: live.media,
      timeline: live.timeline,
      preset: runPreset(),
      outPath: target,
    };

    exporting = true;
    // A close that ended in "stay" after all (the destroy failed) must not
    // stop the NEXT run from starting.
    closeCanceled = false;
    runHold.hold();
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

    if (closeCanceled) {
      // The window is closing; there is no job to cancel yet, so start none.
      exporting = false;
      runHold.release();
      if (unlistenJobs) {
        unlistenJobs();
        unlistenJobs = null;
      }
      // Back to the form, not a progress view with nothing behind it, in case
      // the window stays after all.
      renderForm();
      return;
    }

    try {
      const pending = startExport(spec);
      starting = pending;
      jobId = await pending;
    } catch (e) {
      exporting = false;
      runHold.release();
      if (unlistenJobs) {
        unlistenJobs();
        unlistenJobs = null;
      }
      renderError(errorDetail(e), []);
    } finally {
      starting = null;
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
    // A plain button: destructive red is for permanently deleting a real
    // library item, and canceling an export deletes nothing of the user's.
    footerEl.innerHTML = `<button class="btn" id="ex-cancel">Cancel</button>`;
    $("#ex-cancel").addEventListener("click", () => void onCancelExport());
    // The Export button the user just pressed no longer exists. Cancel is the
    // only thing this view offers, and it is the one control they may urgently
    // want — reaching it must not depend on a Tab ring that has fallen out of
    // the dialog.
    focusFirst(backdrop, "#ex-cancel");
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
    runHold.release();
    void clearTaskbarProgress();
    if (unlistenJobs) {
      unlistenJobs();
      unlistenJobs = null;
    }
    const path = typeof e.output.path === "string" ? e.output.path : outPath();
    renderSuccess(path, usedSoftwareFallback(e.output));
  }

  function handleFailed(e: JobFailed): void {
    if (e.kind !== "export" || (jobId !== null && e.id !== jobId)) return;
    exporting = false;
    runHold.release();
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
    runHold.release();
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

  function renderSuccess(path: string, hwFallback: boolean): void {
    jobId = null;
    bodyEl.innerHTML = `
      <div class="export-result">
        <div class="export-result__icon export-result__icon--ok">${checkIcon(24)}</div>
        <div class="export-result__title">Exported</div>
        <div class="export-result__path">${escapeHtml(path)}</div>
        ${hwFallback ? `<div class="export-result__msg" id="ex-hw-fallback">${escapeHtml(HW_FALLBACK_NOTE)}</div>` : ""}
      </div>
    `;
    footerEl.innerHTML = `
      <button class="btn" id="ex-reveal">${icon("folder", 14)}Reveal in Explorer</button>
      <button class="btn btn--primary" data-close-btn>Close</button>
    `;
    $("#ex-reveal").addEventListener("click", () => void revealInExplorer(path));
    footerEl.querySelector("[data-close-btn]")!.addEventListener("click", close);
    // Arrived here from the progress view, whose Cancel button is gone. Close is
    // what the user wants next, and Enter should reach it without a Tab first.
    focusFirst(backdrop, "[data-close-btn]");
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

    // The pane already states what it redacted; the filter graph is the one
    // thing true only here, so it joins that line rather than stacking a second.
    const hint = pane.querySelector<HTMLElement>(".err-hint");
    if (hint) hint.textContent += " The saved file also includes the full filter graph.";
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
    // The detail textarea, not a button: this is the view whose entire purpose
    // is getting the text OUT, and a focused textarea makes Ctrl+A / Ctrl+C work
    // on the first keystroke (the app's own Ctrl+C binding stands aside for a
    // typing target). It also puts focus back inside the backdrop, which is what
    // re-arms the Tab trap after the swap emptied it.
    focusFirst(backdrop, ".err-detail");
  }

  /* -------- boot -------- */
  // renderForm seats focus itself, on every paint — the Back path needs it just
  // as much as the first one.
  renderForm();

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

  // The editor's dispose() calls this, so the dialog never outlives the screen
  // that opened it. A no-op while an export runs (see close()).
  return close;
}
