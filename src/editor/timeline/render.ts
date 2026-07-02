// Timeline canvas renderer. Draws only the visible time range; zero
// allocation in the hot path beyond Path2D construction for waveforms.

import { fileStem } from "../../core/format";
import { clipDuration } from "../../core/time";
import type { Clip, MediaRef, ProjectFile, Track } from "../../core/types";
import type { WaveformData } from "../media/media";
import type { DragState } from "./interactions";

export const RULER_H = 26;
export const VIDEO_LANE_H = 60;
export const AUDIO_LANE_H = 42;
export const LANE_GAP = 4;
export const EDGE_ZONE_PX = 7;
/** ±px hit slop around a marker stem in the ruler. */
export const MARKER_HIT_PX = 5;

/** Marker flag colors (index 0 = accent, resolved at draw time; 1..5 = fixed
 *  hexes chosen to read on both the dark and light themes). */
export const MARKER_PALETTE = [
  "", // 0 → accent (filled in from theme colors)
  "#e5484d",
  "#f5a623",
  "#30a46c",
  "#0091ff",
  "#8e4ec6",
];

/** Resolve a marker's palette index to a concrete color. */
function markerColor(index: number, accent: string): string {
  const c = MARKER_PALETTE[index] ?? "";
  return c === "" ? accent : c;
}

export interface LaneRect {
  track: Track;
  y: number;
  h: number;
}

export function laneLayout(project: ProjectFile): LaneRect[] {
  const lanes: LaneRect[] = [];
  let y = RULER_H + LANE_GAP;
  for (const track of project.timeline.tracks) {
    const h = track.kind === "video" ? VIDEO_LANE_H : AUDIO_LANE_H;
    lanes.push({ track, y, h });
    y += h + LANE_GAP;
  }
  return lanes;
}

export function totalLanesHeight(project: ProjectFile): number {
  const last = laneLayout(project).at(-1);
  return last ? last.y + last.h + LANE_GAP : RULER_H + LANE_GAP;
}

export interface TimelineColors {
  bg: string;
  laneBg: string;
  border: string;
  text1: string;
  text2: string;
  text3: string;
  accent: string;
  accentDim: string;
  clipVideoBg: string;
  clipVideoBorder: string;
  clipAudioBg: string;
  clipAudioBorder: string;
  wave: string;
  playhead: string;
  rulerTick: string;
}

export function readColors(el: HTMLElement): TimelineColors {
  const cs = getComputedStyle(el);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    bg: v("--bg-app"),
    laneBg: v("--bg-panel"),
    border: v("--border"),
    text1: v("--text-1"),
    text2: v("--text-2"),
    text3: v("--text-3"),
    accent: v("--accent"),
    accentDim: v("--accent-dim"),
    clipVideoBg: v("--clip-video-bg"),
    clipVideoBorder: v("--clip-video-border"),
    clipAudioBg: v("--clip-audio-bg"),
    clipAudioBorder: v("--clip-audio-border"),
    wave: v("--wave"),
    playhead: v("--playhead"),
    rulerTick: v("--ruler-tick"),
  };
}

export interface RenderInput {
  project: ProjectFile;
  t0: number;
  pxPerSec: number;
  width: number;
  height: number;
  playhead: number;
  selectedClipId: string | null;
  drag: DragState;
  guideT: number | null;
  colors: TimelineColors;
  waveforms: Record<string, WaveformData>;
  mediaById: Map<string, MediaRef>;
}

const RULER_STEPS = [
  1 / 30, 1 / 10, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600,
];

function rulerStep(pxPerSec: number): number {
  for (const s of RULER_STEPS) {
    if (s * pxPerSec >= 72) return s;
  }
  return 7200;
}

function labelFor(t: number, step: number): string {
  if (step < 1) return `${t.toFixed(2)}s`;
  const total = Math.round(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Effective clip geometry with drag overrides applied (pure). */
export function effectiveClip(clip: Clip, drag: DragState): Clip {
  if (!drag || drag.clipId !== clip.id) return clip;
  if (drag.kind === "move") {
    return { ...clip, timelineStart: drag.start };
  }
  if (drag.kind === "trimIn") {
    const delta = (drag.t - clip.timelineStart) * clip.speed;
    return { ...clip, timelineStart: drag.t, srcIn: clip.srcIn + delta };
  }
  // trimOut
  const dur = drag.t - clip.timelineStart;
  return { ...clip, srcOut: clip.srcIn + dur * clip.speed };
}

export function draw(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { t0, pxPerSec, width, height, colors } = input;
  const xOf = (t: number): number => (t - t0) * pxPerSec;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);

  /* ---------------- ruler ---------------- */
  const step = rulerStep(pxPerSec);
  const minor = step / 5;
  ctx.fillStyle = colors.text3;
  ctx.strokeStyle = colors.rulerTick;
  ctx.lineWidth = 1;
  ctx.font = "10px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  ctx.textBaseline = "alphabetic";

  const firstMinor = Math.max(0, Math.floor(t0 / minor) * minor);
  ctx.beginPath();
  for (let t = firstMinor; xOf(t) <= width; t += minor) {
    const x = Math.round(xOf(t)) + 0.5;
    if (x < -10) continue;
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ctx.moveTo(x, isMajor ? RULER_H - 12 : RULER_H - 6);
    ctx.lineTo(x, RULER_H - 1);
    if (isMajor) {
      ctx.fillText(labelFor(t, step), x + 4, RULER_H - 13);
    }
  }
  ctx.stroke();
  ctx.strokeStyle = colors.border;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(width, RULER_H - 0.5);
  ctx.stroke();

  /* ---------------- markers (ruler flags) ---------------- */
  const markers = input.project.timeline.markers;
  if (markers && markers.length > 0) {
    for (const marker of markers) {
      const mx = xOf(marker.t);
      if (mx < -8 || mx > width + 8) continue;
      const x = Math.round(mx) + 0.5;
      const color = markerColor(marker.color, colors.accent);
      // stem
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, RULER_H - 1);
      ctx.stroke();
      // pennant (points right, ~7x9)
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x + 7, 2);
      ctx.lineTo(x + 7, 7);
      ctx.lineTo(x, 11);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ---------------- lanes + clips ---------------- */
  const lanes = laneLayout(input.project);
  for (const lane of lanes) {
    if (lane.y > height) break;
    ctx.fillStyle = colors.laneBg;
    ctx.fillRect(0, lane.y, width, lane.h);

    for (const raw of lane.track.clips) {
      const clip = effectiveClip(raw, input.drag);
      const x = xOf(clip.timelineStart);
      const w = clipDuration(clip) * pxPerSec;
      if (x + w < 0 || x > width) continue;
      drawClip(ctx, input, clip, lane, x, w);
    }
  }

  /* ---------------- snap guide ---------------- */
  if (input.guideT !== null) {
    const gx = Math.round(xOf(input.guideT)) + 0.5;
    ctx.strokeStyle = colors.accent;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(gx, RULER_H);
    ctx.lineTo(gx, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ---------------- playhead ---------------- */
  const px = Math.round(xOf(input.playhead)) + 0.5;
  if (px >= -1 && px <= width + 1) {
    ctx.strokeStyle = colors.playhead;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.fillStyle = colors.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  clip: Clip,
  lane: LaneRect,
  x: number,
  w: number,
): void {
  const { colors } = input;
  const isVideo = lane.track.kind === "video";
  const selected = input.selectedClipId === clip.id;
  const y = lane.y + 2;
  const h = lane.h - 4;
  const r = Math.min(6, w / 2);

  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(w, 2), h, r);
  ctx.fillStyle = isVideo ? colors.clipVideoBg : colors.clipAudioBg;
  ctx.fill();

  // waveform (audio clips, or video clips whose media has peaks)
  const media = input.mediaById.get(clip.mediaId);
  const wf = media ? input.waveforms[media.id] : undefined;
  if (wf && w > 8) {
    drawWaveform(ctx, input, clip, wf, x, y, w, h, isVideo);
  }

  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected
    ? colors.accent
    : isVideo
      ? colors.clipVideoBorder
      : colors.clipAudioBorder;
  ctx.beginPath();
  ctx.roundRect(
    x + (selected ? 1 : 0.5),
    y + (selected ? 1 : 0.5),
    Math.max(w, 2) - (selected ? 2 : 1),
    h - (selected ? 2 : 1),
    r,
  );
  ctx.stroke();

  // name label
  if (w > 40 && media) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 6, y, Math.max(0, w - 12), h);
    ctx.clip();
    ctx.fillStyle = colors.text1;
    ctx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(fileStem(media.path), x + 7, y + 5);
    ctx.restore();
  }

  // trim handles on selection
  if (selected && w > 18) {
    ctx.fillStyle = colors.accent;
    const hy = y + h / 2;
    for (const hx of [x + 3.5, x + w - 3.5]) {
      ctx.beginPath();
      ctx.roundRect(hx - 1.5, hy - 8, 3, 16, 2);
      ctx.fill();
    }
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  clip: Clip,
  wf: WaveformData,
  x: number,
  y: number,
  w: number,
  h: number,
  isVideo: boolean,
): void {
  const waveTop = isVideo ? y + h * 0.55 : y + 2;
  const waveH = isVideo ? h * 0.42 : h - 4;
  const mid = waveTop + waveH / 2;
  const amp = waveH / 2 / 128;

  const startCol = Math.max(0, Math.floor(-x));
  const endCol = Math.min(Math.ceil(w), Math.ceil(input.width - x));
  if (endCol <= startCol) return;

  const srcSpan = clip.srcOut - clip.srcIn;
  const path = new Path2D();
  for (let col = startCol; col < endCol; col++) {
    const f0 = clip.srcIn + (col / w) * srcSpan;
    const f1 = clip.srcIn + ((col + 1) / w) * srcSpan;
    let i0 = Math.floor(f0 * wf.pairsPerSec);
    let i1 = Math.max(i0 + 1, Math.ceil(f1 * wf.pairsPerSec));
    i0 = Math.max(0, Math.min(i0, wf.mins.length - 1));
    i1 = Math.max(0, Math.min(i1, wf.mins.length));
    let lo = 127;
    let hi = -128;
    for (let i = i0; i < i1; i++) {
      const mn = wf.mins[i]!;
      const mx = wf.maxs[i]!;
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
    }
    if (hi < lo) continue;
    const yTop = mid - hi * amp;
    const yBot = mid - lo * amp;
    path.rect(x + col, yTop, 1, Math.max(1, yBot - yTop));
  }
  ctx.fillStyle = input.colors.wave;
  ctx.globalAlpha = isVideo ? 0.55 : 0.8;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}
