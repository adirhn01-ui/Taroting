// Diagnostic report builder.
//
// PURE and synchronous: every input arrives in the context object, so the
// output is deterministic and unit-testable, and this module can never reach
// IPC, the clock, the network or the DOM. Nothing is buffered — a report is
// built only at the moment a human asks for one.
//
// Privacy rules (each has a test):
//   * file paths never appear — every distinct path becomes a stable
//     "<file N.ext>" token, so the same file reads the same everywhere
//   * the project name never appears
//   * text-generator CONTENT never appears (only its length + styling)
//   * free text (ffmpeg argv, log lines, messages) is swept for the user name
//   * there is no machine id, install id or session id, here or anywhere else
//   * nothing is sent anywhere; the report exists only where the user puts it

import { timelineDuration } from "./time";
import type {
  ExportPreset,
  MediaKind,
  MediaRef,
  ProjectFile,
  ResolutionPreset,
  Settings,
} from "./types";
import { DEFAULT_SHORTCUTS } from "./types";

/* ---------------- shared shapes ---------------- */

/** One entry of the in-memory recent-errors ring (see `src/ui/errors.ts`). */
export interface DiagnosticErrorEntry {
  /** epoch ms */
  at: number;
  /** short operation label, e.g. "Export" */
  op: string;
  message: string;
  detail?: string;
}

/** What the backend reports about the last failed ffmpeg run. */
export interface FfmpegFailure {
  argv: string[];
  filterComplex: string;
  message: string;
  logTail: string[];
  ffmpegVersion: string;
}

/** The encoder names detect_encoders resolved for each family. */
export interface EncoderSummary {
  h264: string;
  hevc: string;
  av1: string;
}

export interface ReportContext {
  /** ISO timestamp — passed in so the builder itself stays pure. */
  at: string;
  appVersion: string;
  platform: string;
  userAgent: string;
  /** What the user was doing. Omitted ⇒ a plain "nothing crashed" report. */
  operation?: string;
  error?: { code: string; message: string };
  ffmpeg?: FfmpegFailure | null;
  preset?: ExportPreset | null;
  /** Destinations are reported as set / not set — never as a path. */
  destinationSet?: boolean;
  encoders?: EncoderSummary | null;
  project?: ProjectFile | null;
  settings?: Settings | null;
  recentErrors?: readonly DiagnosticErrorEntry[];
  /** true ⇒ include the whole filter graph (the saved file); false ⇒ elide it.
   *  A 12 KB clipboard paste into an issue comment is hostile; a file is not. */
  full?: boolean;
}

export interface RedactedGenerator {
  type: "solid" | "text";
  /** text generators only — the LENGTH of the text, never the text */
  chars?: number;
  fontFamily?: string;
  sizePx?: number;
  bold?: boolean;
  italic?: boolean;
}

export interface RedactedMedia {
  /** stable pseudonym, e.g. "<file 2.mp4>" */
  ref: string;
  kind: MediaKind;
  durationSec: number;
  sizeBytes: number;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: string;
  container?: string;
  vcodec?: string;
  acodec?: string;
  pixFmt?: string;
  generator?: RedactedGenerator;
}

export interface ProjectShape {
  canvas: string;
  timebase: string;
  durationSec: number;
  videoTracks: number;
  audioTracks: number;
  clips: number;
  animatedClips: number;
  keyframes: number;
  markers: number;
  generators: number;
  mediaCount: number;
  /** media rows dropped by the size cap */
  mediaOmitted: number;
  media: RedactedMedia[];
}

/* ---------------- limits (the size cap) ---------------- */

const LABEL_W = 16;
const MAX_LOG_LINES = 80;
const MAX_LINE_CHARS = 400;
const MAX_MEDIA_ROWS = 40;
const MAX_GRAPH_CHARS = 20_000;
const MAX_ERRORS_LISTED = 20;

/** Hard ceiling on a built report. Nothing pastes 200 KB into an issue. */
export const MAX_REPORT_CHARS = 48_000;

/* ---------------- redaction primitives ---------------- */

/* The apostrophe is a LEGAL character in a Windows account name (O'Brien), so
 * it must not end a match: excluding it left everything after the quote —
 * account tail, folders, file name — verbatim in the "redacted" text, and
 * sweepUsernames could not recover because the `X:\Users\` anchor had already
 * been consumed. A name segment still ends at the path separator, so a
 * single-quoted ffmpeg filtergraph (`fontfile='C:/Users/…'`) is unaffected;
 * the closing quote a path-wide match CAN swallow is handled by the trailing
 * trim in `text` below. `"` stays excluded — it is illegal in a filename. */
const WIN_USER = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"]+/gi;
const NIX_USER = /(\/(?:home|Users)\/)[^/\s"]+/g;
/** An absolute Windows path embedded in free text. Stops at whitespace, so a
 *  name containing spaces is only caught by the exact known-path pass. */
const PATH_LIKE = /[A-Za-z]:[\\/][^\s"<>|*?]*/g;

/** Replace the account name inside any user-profile path with `<user>`. */
export function sweepUsernames(text: string): string {
  return text.replace(WIN_USER, "$1<user>").replace(NIX_USER, "$1<user>");
}

/** Extension of a path INCLUDING the dot, lowercased ("" when there is none). */
function extOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function looksLikePath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/");
}

export interface Redactor {
  /** Map a WHOLE path to its stable token, and remember it for `text`. */
  path(p: string): string;
  /** Scrub free text: known paths → their tokens, any other absolute path →
   *  a fresh token, then any surviving user-profile name → `<user>`. */
  text(s: string): string;
}

/**
 * Path pseudonymizer for ONE report. The same path always yields the same
 * token, so a file named in the ffmpeg command lines up with its row in the
 * media table — while the folder and the file name never appear.
 */
export function createRedactor(knownPaths: readonly string[] = []): Redactor {
  const seen = new Map<string, string>();
  /** Absolute paths we can match verbatim (so names with spaces are safe),
   *  longest first so a folder never shadows a file inside it. */
  const known: string[] = [];

  const path = (p: string): string => {
    const existing = seen.get(p);
    if (existing !== undefined) return existing;
    const token = `<file ${seen.size + 1}${extOf(p)}>`;
    seen.set(p, token);
    if (looksLikePath(p)) {
      known.push(p);
      known.sort((a, b) => b.length - a.length);
    }
    return token;
  };

  const text = (s: string): string => {
    let out = s;
    for (const p of known) {
      if (out.includes(p)) out = out.split(p).join(seen.get(p)!);
    }
    out = out.replace(PATH_LIKE, (m) => {
      // The quote joins the punctuation trim because PATH_LIKE no longer stops
      // at apostrophes (see WIN_USER above): in `fontfile='C:/…/f.ttf'` the
      // match swallows the closing quote, which belongs to the filtergraph,
      // not the path.
      const trimmed = m.replace(/[.,;:)\]}']+$/, "");
      return path(trimmed) + m.slice(trimmed.length);
    });
    return sweepUsernames(out);
  };

  for (const p of knownPaths) path(p);
  return { path, text };
}

/* ---------------- project shape ---------------- */

function redactMedia(m: MediaRef, mapPath: (p: string) => string): RedactedMedia {
  const out: RedactedMedia = {
    ref: mapPath(m.path),
    kind: m.kind,
    durationSec: round3(m.duration),
    sizeBytes: m.size,
    hasAudio: m.hasAudio,
    width: m.width,
    height: m.height,
    fps: m.fps ? `${m.fps.num}/${m.fps.den}` : undefined,
    container: m.container,
    vcodec: m.vcodec,
    acodec: m.acodec,
    pixFmt: m.pixFmt,
  };
  const g = m.generator;
  if (g) {
    // The text itself is the one thing here that could be personal, so only
    // its length and styling survive.
    out.generator =
      g.type === "text"
        ? {
            type: "text",
            chars: g.text.length,
            fontFamily: g.fontFamily,
            sizePx: g.sizePx,
            bold: g.bold,
            italic: g.italic,
          }
        : { type: "solid" };
  }
  return out;
}

/**
 * Counters + redacted media for a project. Never returns the project name, a
 * file path, or the content of a text generator — media *properties* are kept
 * because they are the reproduction, and they are not personal.
 */
export function redactProjectShape(
  project: ProjectFile,
  mapPath: (p: string) => string = createRedactor().path,
): ProjectShape {
  const t = project.timeline;
  let videoTracks = 0;
  let audioTracks = 0;
  let clips = 0;
  let animatedClips = 0;
  let keyframes = 0;

  for (const track of t.tracks) {
    if (track.kind === "video") videoTracks++;
    else audioTracks++;
    for (const clip of track.clips) {
      clips++;
      if (!clip.keyframes) continue;
      let n = 0;
      for (const arr of Object.values(clip.keyframes)) n += arr ? arr.length : 0;
      if (n > 0) {
        animatedClips++;
        keyframes += n;
      }
    }
  }

  const shown = project.media.slice(0, MAX_MEDIA_ROWS);
  return {
    canvas: `${t.width}x${t.height}`,
    timebase: `${t.fps.num}/${t.fps.den}`,
    durationSec: round3(timelineDuration(t)),
    videoTracks,
    audioTracks,
    clips,
    animatedClips,
    keyframes,
    markers: t.markers?.length ?? 0,
    generators: project.media.reduce((n, m) => n + (m.generator ? 1 : 0), 0),
    mediaCount: project.media.length,
    mediaOmitted: project.media.length - shown.length,
    media: shown.map((m) => redactMedia(m, mapPath)),
  };
}

/* ---------------- text formatting ---------------- */

function round3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function row(label: string, value: string | number): string {
  return `${label.padEnd(LABEL_W)}${String(value)}`;
}

function head(title: string): string {
  return `\n${title}\n${"-".repeat(title.length)}`;
}

function onOff(v: boolean): string {
  return v ? "on" : "off";
}

function clip(s: string, max = MAX_LINE_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

function resolutionLabel(r: ResolutionPreset): string {
  return typeof r === "object" ? `${r.w}x${r.h}` : r;
}

function mediaLine(m: RedactedMedia): string {
  const bits: string[] = [m.ref, m.kind];
  if (m.width !== undefined && m.height !== undefined) bits.push(`${m.width}x${m.height}`);
  if (m.fps) bits.push(`${m.fps} fps`);
  const codecs = [m.vcodec, m.acodec].filter(Boolean).join("/");
  if (codecs) bits.push(codecs);
  if (m.pixFmt) bits.push(m.pixFmt);
  if (m.container) bits.push(m.container);
  bits.push(`${m.durationSec}s`);
  bits.push(`${m.sizeBytes} B`);
  bits.push(m.hasAudio ? "audio" : "no audio");
  const g = m.generator;
  if (g) {
    bits.push(
      g.type === "text"
        ? `generator:text chars=${g.chars} ${g.fontFamily} ${g.sizePx}px${g.bold ? " bold" : ""}${g.italic ? " italic" : ""}`
        : "generator:solid",
    );
  }
  return bits.join("  ");
}

function countCustomShortcuts(s: Settings): number {
  let n = 0;
  for (const [action, chord] of Object.entries(DEFAULT_SHORTCUTS)) {
    if ((s.shortcuts as Record<string, string>)[action] !== chord) n++;
  }
  return n;
}

/* ---------------- the report ---------------- */

/**
 * Build a plain-text diagnostic report. Fixed-width labels, no markup, so it
 * pastes cleanly inside a GitHub fence.
 */
export function buildReport(ctx: ReportContext): string {
  // Seed from the project media so "<file 1>" is the first media item no matter
  // which section happens to mention a path first.
  const redactor = createRedactor(ctx.project ? ctx.project.media.map((m) => m.path) : []);

  const out: string[] = [];
  const title = "Taroting diagnostic report";
  out.push(title, "=".repeat(title.length));
  out.push(row("Generated", ctx.at));
  out.push(row("App version", ctx.appVersion));
  out.push(row("FFmpeg", ctx.ffmpeg?.ffmpegVersion || "unknown"));
  out.push(row("Platform", ctx.platform || "unknown"));
  out.push(row("Webview", clip(redactor.text(ctx.userAgent || "unknown"))));
  out.push(row("Operation", ctx.operation ?? "none (system report)"));

  if (ctx.error) {
    out.push(head("Error"));
    out.push(row("Code", ctx.error.code || "(none)"));
    out.push(row("Message", clip(redactor.text(ctx.error.message))));
  }

  const ff = ctx.ffmpeg;
  if (ff) {
    // The command comes first on purpose: it registers the output path (an
    // argv element is a WHOLE path, spaces and all), so the log lines below
    // inherit the same token instead of leaking a partially-matched name.
    out.push(head("FFmpeg command"));
    if (ff.argv.length === 0) {
      out.push("(not captured)");
    } else {
      out.push(
        ff.argv
          .map((a) => {
            if (ff.filterComplex && a === ff.filterComplex) return "<filter graph>";
            return looksLikePath(a) ? redactor.path(a) : clip(redactor.text(a));
          })
          .join(" "),
      );
    }

    out.push(head("Filter graph"));
    if (!ff.filterComplex) {
      out.push("(none)");
    } else if (ctx.full) {
      out.push(clip(redactor.text(ff.filterComplex), MAX_GRAPH_CHARS));
    } else {
      out.push(
        `(${ff.filterComplex.length} chars — omitted here; "Save report" writes a file that includes it)`,
      );
    }

    out.push(head(`FFmpeg log (last ${Math.min(ff.logTail.length, MAX_LOG_LINES)} lines)`));
    const lines = ff.logTail.slice(-MAX_LOG_LINES);
    out.push(lines.length ? lines.map((l) => clip(redactor.text(l))).join("\n") : "(empty)");
  }

  const p = ctx.preset;
  if (p) {
    out.push(head("Export settings"));
    out.push(row("Format", p.format));
    out.push(row("Codec", p.vcodec));
    out.push(row("Resolution", resolutionLabel(p.resolution)));
    out.push(row("Frame rate", p.fps === "original" ? "original" : String(p.fps)));
    out.push(row("Video bitrate", p.videoBitrate === "auto" ? "auto" : `${p.videoBitrate} kbps`));
    out.push(row("Audio bitrate", p.audioBitrate === "auto" ? "auto" : `${p.audioBitrate} kbps`));
    out.push(row("Hardware", onOff(p.useHardware)));
    if (ctx.destinationSet !== undefined) {
      out.push(row("Destination", ctx.destinationSet ? "set" : "not set"));
    }
  }

  const enc = ctx.encoders;
  if (enc) {
    out.push(head("Encoders detected"));
    out.push(row("H.264", enc.h264));
    out.push(row("H.265", enc.hevc));
    out.push(row("AV1", enc.av1));
  }

  if (ctx.project) {
    const shape = redactProjectShape(ctx.project, redactor.path);
    out.push(head("Project shape"));
    out.push(row("Canvas", shape.canvas));
    out.push(row("Timebase", shape.timebase));
    out.push(row("Duration", `${shape.durationSec}s`));
    out.push(row("Video tracks", shape.videoTracks));
    out.push(row("Audio tracks", shape.audioTracks));
    out.push(row("Clips", shape.clips));
    out.push(row("Animated clips", shape.animatedClips));
    out.push(row("Keyframes", shape.keyframes));
    out.push(row("Markers", shape.markers));
    out.push(row("Generators", shape.generators));
    out.push(row("Media items", shape.mediaCount));

    out.push(head("Media (redacted)"));
    out.push(shape.media.length ? shape.media.map(mediaLine).join("\n") : "(none)");
    if (shape.mediaOmitted > 0) out.push(`(+${shape.mediaOmitted} more not listed)`);
  }

  const s = ctx.settings;
  if (s) {
    const custom = countCustomShortcuts(s);
    out.push(head("Settings"));
    // A custom theme's three picks ARE the reproduction. Legibility under one is
    // MEASURED, not structural — the nav rescue fires on a contrast ratio, so
    // whether a control is rescued depends on the exact hexes — and "I can't
    // read Settings" is unreproducible without them. They are colours the user
    // chose, not facts about the user, so they go in verbatim; the built-in
    // themes keep their bare name, having nothing to say beyond it.
    out.push(
      row(
        "Theme",
        s.theme === "custom"
          ? `custom  background ${s.customTheme.background}  accent ${s.customTheme.accent}  text ${s.customTheme.text}`
          : s.theme,
      ),
    );
    out.push(row("Autosave", `${s.autosaveSeconds}s`));
    out.push(row("Hardware accel", onOff(s.hardwareAccel)));
    out.push(row("Proxy media", onOff(s.proxyMedia)));
    out.push(row("Snap guides", onOff(s.snapCenterGuides)));
    out.push(row("Quick view", onOff(s.tempOpenWith)));
    out.push(row("Cache limit", `${s.cacheLimitMB} MB`));
    out.push(row("Monitor volume", s.monitorVolume.toFixed(2)));
    out.push(row("Default export", s.defaultExportDir ? "set" : "not set"));
    out.push(row("Last export", s.lastExportDir ? "set" : "not set"));
    out.push(row("Shortcuts", custom === 0 ? "default" : `${custom} customised`));
  }

  const recent = ctx.recentErrors;
  if (recent && recent.length > 0) {
    out.push(head(`Recent errors (${recent.length} this session)`));
    out.push(
      recent
        .slice(-MAX_ERRORS_LISTED)
        .map(
          (e, i) =>
            `${String(i + 1).padStart(2)}  ${new Date(e.at).toISOString()}  ${(e.op || "—").padEnd(12)}  ${clip(redactor.text(e.message), 200)}`,
        )
        .join("\n"),
    );
  }

  out.push(head("Redaction notice"));
  out.push(
    [
      "Folder and file names were replaced with <file N> tokens; the same file",
      "always gets the same token. Your user name, the project name and the text",
      "inside text layers were removed — only their length and styling are here.",
      "No machine, install or session identifier exists in Taroting, so none is",
      "in this report. Nothing was sent anywhere: Taroting is fully offline, and",
      "this report exists only where you put it.",
    ].join("\n"),
  );

  const text = out.join("\n");
  return text.length > MAX_REPORT_CHARS
    ? `${text.slice(0, MAX_REPORT_CHARS)}\n\n… report truncated at ${MAX_REPORT_CHARS} characters …`
    : text;
}
