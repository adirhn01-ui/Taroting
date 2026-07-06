// Single source of truth for all shared data shapes.
// The Rust side mirrors these with serde(rename_all = "camelCase").

export interface Rational {
  num: number;
  den: number;
}

export type MediaKind = "video" | "audio" | "image" | "imageSeq" | "gif";

/** The 6 fonts available to text generators (all ship with Windows). */
export type FontFamily =
  | "Segoe UI"
  | "Arial"
  | "Georgia"
  | "Times New Roman"
  | "Courier New"
  | "Impact";

/** A synthetic media source (no file on disk): a solid color fill or styled text.
 *  Media carrying a generator has kind:"image"; its `path` is a display label. */
export type Generator =
  | { type: "solid"; color: string }
  | {
      type: "text";
      text: string;
      fontFamily: FontFamily;
      sizePx: number;
      color: string;
      bold: boolean;
      italic: boolean;
    };

/** A reference to an original media file on disk. Originals are never modified. */
export interface MediaRef {
  id: string;
  path: string;
  /** size + mtime form the identity for cache keys and relink detection */
  size: number;
  mtimeMs: number;
  kind: MediaKind;
  duration: number;
  fps?: Rational;
  width?: number;
  height?: number;
  container?: string;
  vcodec?: string;
  acodec?: string;
  pixFmt?: string;
  bitDepth?: number;
  hasAudio: boolean;
  audioRate?: number;
  audioChannels?: number;
  /** present → synthetic media (solid/text); no file is probed */
  generator?: Generator;
}

/** What `probe_media` returns — a MediaRef without an assigned id. */
export type MediaInfo = Omit<MediaRef, "id">;

export interface ClipCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Applied in fixed order: crop → rotate → flip → scale → position → opacity. */
export interface ClipTransform {
  crop?: ClipCrop;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** 1 = fit project canvas */
  scale: number;
  /** px offset from centered position, in project-canvas space */
  x: number;
  y: number;
  opacity: number;
}

export interface ClipAudio {
  /** linear gain 0..2 */
  volume: number;
  muted: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  /** set by Normalize (peak scan); 0 by default */
  gainOffsetDb: number;
  /** true → this video clip contributes no audio (it lives as a detached audio clip) */
  detached: boolean;
}

/** A prop that can be animated over the life of a clip. */
export type AnimProp = "x" | "y" | "scale" | "opacity";

/** One animation control point.
 *  `t` is in SOURCE seconds — the same domain as srcIn/srcOut. Keyframes glue
 *  to media content (not timeline position), so move / trim / split / speed
 *  changes need no remapping: the value at any source time is unchanged, and a
 *  split simply lets both halves share the array (out-of-range "ghost"
 *  keyframes remain legal interpolation anchors). */
export interface Keyframe {
  t: number;
  v: number;
}

/** Per-prop keyframe tracks for a clip. Each array is sorted strictly ascending
 *  by `t`. The `x` and `y` arrays are kept PAIRED (same length, same times) by
 *  the mutations so position animates as a single 2D track. */
export type ClipKeyframes = Partial<Record<AnimProp, Keyframe[]>>;

export interface Clip {
  id: string;
  mediaId: string;
  /** seconds on the timeline */
  timelineStart: number;
  /** source seconds (pre-speed); timeline duration = (srcOut - srcIn) / speed */
  srcIn: number;
  srcOut: number;
  /** 0.25 .. 4 */
  speed: number;
  /** video clips only */
  transform?: ClipTransform;
  audio: ClipAudio;
  /** present → this clip animates one or more transform props */
  keyframes?: ClipKeyframes;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  name: string;
  muted: boolean;
  /** invariant: sorted by timelineStart, non-overlapping */
  clips: Clip[];
}

/** A ruler flag at timeline time `t`. `color` is a palette index 0..5. */
export interface Marker {
  id: string;
  t: number;
  color: number;
}

export interface Timeline {
  /** project timebase (adopted from first video) */
  fps: Rational;
  /** project canvas (adopted from first video) */
  width: number;
  height: number;
  /** invariant: >=1 video track; all video tracks form a contiguous prefix;
   *  array order = z-order with tracks[0] the TOPMOST layer. */
  tracks: Track[];
  /** ruler markers, sorted ascending by t */
  markers?: Marker[];
}

export type ResolutionPreset =
  | "original"
  | "4320p"
  | "2160p"
  | "1440p"
  | "1080p"
  | "720p"
  | "480p"
  | { w: number; h: number };

export interface ExportPreset {
  format: "mp4" | "mov" | "webm" | "gif" | "avi";
  vcodec: "h264" | "hevc" | "av1";
  resolution: ResolutionPreset;
  fps: "original" | number;
  /** kbps; "auto" = quality mode (CRF/CQ) */
  videoBitrate: "auto" | number;
  audioBitrate: "auto" | number;
  useHardware: boolean;
}

/** A `.trt` project file. */
export interface ProjectFile {
  schema: 1;
  app: "taroting";
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  media: MediaRef[];
  timeline: Timeline;
  /** last-used export preset, persisted per project */
  export: ExportPreset;
}

export type ActionId =
  | "playPause"
  | "stop"
  | "stepFwd"
  | "stepBack"
  | "jumpFwd"
  | "jumpBack"
  | "goStart"
  | "goEnd"
  | "split"
  | "delete"
  | "rippleDelete"
  | "undo"
  | "redo"
  | "save"
  | "copy"
  | "paste"
  | "toggleSnap"
  | "toggleLoop"
  | "addMarker"
  | "export"
  | "goHome"
  | "fullscreen";

export interface Settings {
  schema: 1;
  theme: "dark" | "light" | "system";
  autosaveSeconds: number;
  defaultExportDir: string | null;
  lastExportDir: string | null;
  hardwareAccel: boolean;
  cacheLimitMB: number;
  proxyMedia: boolean;
  /** drag a clip on the canvas → snap its center to the project center */
  snapCenterGuides: boolean;
  /** open-with a media file from Explorer → temporary project (kept only if the
   *  user presses Back in the editor). Off = the classic permanent-project flow. */
  tempOpenWith: boolean;
  /** preview/monitor listening level 0..1 — NOT baked into clips or exports */
  monitorVolume: number;
  shortcuts: Record<ActionId, string>;
}

export interface RecentItem {
  path: string;
  name: string;
  modifiedAt: string;
  durationSec: number;
  thumb: string | null;
  /** on-disk size of the .trt file, refreshed by list_recents */
  sizeBytes: number;
  /** ISO 8601; stamped when the project is opened (absent until first open) */
  openedAt?: string;
}

export interface RecentsIndex {
  schema: 1;
  items: RecentItem[];
}

export const DEFAULT_SHORTCUTS: Record<ActionId, string> = {
  playPause: "Space",
  stop: "Shift+Space",
  stepFwd: "ArrowRight",
  stepBack: "ArrowLeft",
  jumpFwd: "Shift+ArrowRight",
  jumpBack: "Shift+ArrowLeft",
  goStart: "Home",
  goEnd: "End",
  split: "S",
  delete: "Delete",
  rippleDelete: "Shift+Delete",
  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  save: "Ctrl+S",
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  toggleSnap: "N",
  toggleLoop: "L",
  addMarker: "M",
  export: "Ctrl+E",
  goHome: "Ctrl+W",
  fullscreen: "F",
};

export const DEFAULT_SETTINGS: Settings = {
  schema: 1,
  theme: "dark",
  autosaveSeconds: 3,
  defaultExportDir: null,
  lastExportDir: null,
  hardwareAccel: true,
  cacheLimitMB: 2048,
  proxyMedia: true,
  snapCenterGuides: true,
  tempOpenWith: false,
  monitorVolume: 1,
  shortcuts: DEFAULT_SHORTCUTS,
};

export const MEDIA_FILE_EXTENSIONS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "gif",
  "mp3", "wav", "flac", "aac", "m4a", "ogg",
  "png", "jpg", "jpeg",
]);

export const DEFAULT_EXPORT_PRESET: ExportPreset = {
  format: "mp4",
  vcodec: "h264",
  resolution: "original",
  fps: "original",
  videoBitrate: "auto",
  audioBitrate: "auto",
  useHardware: true,
};
