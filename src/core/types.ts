// Single source of truth for all shared data shapes.
// The Rust side mirrors these with serde(rename_all = "camelCase").

import MEDIA_EXT from "./media-extensions.json";

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

/** A synthetic media source (no file on disk): a solid color fill, styled text,
 *  or an image project's drawing layer. Media carrying a generator has
 *  kind:"image"; its `path` is a display label. */
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
    }
  /** A freehand/markup layer of an IMAGE project. Never valid in a video project:
   *  load_project refuses it there, save_project refuses it unless kind === "image",
   *  and the video exporter's build() pre-check refuses it. */
  | { type: "drawing"; chunks: Stroke[][] };

export type InkKind = "pen" | "pencil" | "marker";
export type ShapeKind = "line" | "rect" | "ellipse" | "arrow";

/** One committed mark on a drawing layer, in LAYER-LOCAL source px (origin = the
 *  layer media box's top-left — the same space as ClipCrop). Immutable once built:
 *  history snapshots share stroke objects by reference.
 *
 *  `p` = standard-alphabet base64, NO padding, of little-endian Float32 triples
 *  [x, y, pressure]*; length is a positive multiple of 16 chars (one point = 12 bytes).
 *  `w` = nominal width in source px (> 0). `c` = lowercase #rrggbb.
 *  `o` = per-stroke opacity 0..1 (pen 1, pencil 0.3+0.7·meanPressure, marker 0.4). */
export type Stroke =
  | { t: InkKind; c: string; w: number; o: number; p: string }
  | { t: "erase"; w: number; p: string }
  | { t: ShapeKind; c: string; w: number; a: [number, number]; b: [number, number] };

/** Image-project colour/tone adjustments of one PHOTO layer. Every field is an
 *  integer; 0 is identity. Ranges: hue -180..180 (degrees), all others -100..100.
 *  Absent `Clip.adjust` === identity. */
export interface ClipAdjust {
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
  hue: number;
  warmth: number;
  tint: number;
}

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
  /** Stills only: `width`/`height` are what THIS app's decoders present, the
   *  same size in the preview and in export (the invariant schema 2 records for
   *  video). For a file the WebView turns by its EXIF orientation (a JPEG, a
   *  PNG with an eXIf before its image data — measured) that is the oriented
   *  size and export autorotates to match; for one it does not it is the coded
   *  size and the file also carries `noAutorotate` — one per-file rule,
   *  `exif::read_still` in the backend.
   *  Stamped by `probe_media` on every new still and by the load-time
   *  orientation repair; a still without it is re-checked against its file
   *  header once, and so, once, is a PNG or WebP stamped without
   *  `noAutorotate` by an earlier build of the rule. The repair is idempotent
   *  without the flag — it only saves the re-check — so a copy that loses it
   *  is safe. */
  oriented?: true;
  /** Stills only: the WebView draws this file's pixels UNTURNED whatever
   *  orientation tag it may carry — every WebP and TIFF, and a PNG whose first
   *  IDAT comes before any eXIf chunk (measured: WebView2 reads an eXIf only
   *  before IDAT; ffmpeg reads one anywhere). Export and thumbnails then decode
   *  it with `-noautorotate` too — a no-op on an untagged file — and
   *  `width`/`height` are the coded size. Decided PER FILE from the chunk
   *  headers by the backend (probe + the load-time repair), by where a tag
   *  could sit, never by reading one. Never set on a JPEG or a BMP. */
  noAutorotate?: true;
  /** Video only: this file's H.264 stream carries in-band headers that must
   *  not be believed — a damaged recording whose garbage frames happen to
   *  parse as parameter sets (SPS/PPS: they re-size ffmpeg's decoder and wreck
   *  every clean frame after them) or as SEI (a display-orientation SEI turns
   *  every later frame). Every ffmpeg decode of the file for EXPORT then
   *  removes the in-band SPS/PPS/SEI (input bitstream filter
   *  `filter_units=remove_types=6|7|8`), so the header's (`avcC`) parameter
   *  sets are the only ones in force — what the MP4 spec says an `avc1`
   *  stream carries anyway. Stamped by the editor only, when the preview's
   *  repair plan reports `repair.dropsHeaders` (see `RepairNote` in ipc.ts);
   *  the editor's plan then goes straight to the repair on later opens.
   *  Cleared by relink and Replace media (a different file). Only a literal
   *  `true` is the flag. */
  dropInbandHeaders?: true;
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
  /** image projects, photo layers only */
  adjust?: ClipAdjust;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  name: string;
  muted: boolean;
  /** invariant: sorted by timelineStart, non-overlapping */
  clips: Clip[];
  /** image projects: layer hidden (eye toggle). Absent = visible. */
  hidden?: true;
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

/** A `.trt` project file.
 *
 *  `schema` 2 = "media dimensions are display-oriented" (the rotation
 *  migration): the Rust loader re-probes a schema-1 file's video media once,
 *  corrects any transposed width/height, and persists it as 2. New projects
 *  are stamped 2 directly — their media is recorded post-rotation-fix, so the
 *  migration pass has nothing to do and skipping it is free.
 *
 *  `schema` 3 is an IMAGE project and nothing else: the Rust `migrate()`
 *  refuses 3 without `kind: "image"`, and `kind: "image"` below 3. A video
 *  project never carries `kind`, stays 2, and is byte-identical on disk. */
export interface ProjectFile {
  /** 3 = image project (requires kind === "image"). Video projects stay 2. */
  schema: 1 | 2 | 3;
  /** present → image project (schema 3). Absent → video project. */
  kind?: "image";
  app: "taroting";
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  media: MediaRef[];
  timeline: Timeline;
  /** last-used export preset, persisted per project */
  export: ExportPreset;
  /** image projects only */
  image?: ImageMeta;
  /** A TEMPORARY project the user has edited (mirrors schema.rs
   *  `temp_edited`). Set on the first save after a real edit, dropped on
   *  Keep, never present on a permanent file. Lets the startup sweep keep an
   *  edited orphan (a crash skipped the keep/discard prompt) for Home to offer
   *  back, while untouched ones are still cleared. */
  tempEdited?: true;
}

export type ImageExportFormat = "png" | "jpeg" | "webp";
export interface ImageExportPreset {
  format: ImageExportFormat;
  /** 1..100; JPEG/WebP only. WebP 100 = lossless (Chromium's own rule). */
  quality: number;
  /** percent of the canvas, or an explicit output size */
  size: 100 | 50 | 25 | { w: number; h: number };
}
export interface ImageMeta {
  /** "transparent" or a validated lowercase #rrggbb */
  background: string;
  /** last-used image export options, persisted per project */
  export?: ImageExportPreset;
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
  | "fullscreen"
  | "redoAlt"
  | "prevFile"
  | "nextFile"
  | "seekBack"
  | "seekFwd"
  | "imgSelect"
  | "imgPen"
  | "imgPencil"
  | "imgMarker"
  | "imgEraser"
  | "imgShape"
  | "imgRuler"
  | "imgSizeDown"
  | "imgSizeUp"
  | "imgZoomIn"
  | "imgZoomOut"
  | "imgZoomFit"
  | "imgZoom100"
  | "imgPanHold";

/** The three user-settable colours of the "custom" theme.
 *
 *  Every one of them is a colour — there is no dark/light switch any more. The
 *  app's light-or-dark character is READ OFF the background's relative
 *  luminance (`deriveCustomTheme` in core/session.ts), so a near-black and a
 *  near-white background both produce a coherent app without asking.
 *
 *  All three are used EXACTLY as picked — no contrast floor, no readability
 *  nudge. The app can therefore be themed into something illegible on purpose;
 *  Settings → Appearance is deliberately exempt from the custom palette so that
 *  is always reversible (`SAFE_APPEARANCE` in core/session.ts).
 *
 *  All three are stored as validated lowercase `#rrggbb` and are re-validated
 *  at every sink (see `normalizeHexColor` in core/session.ts): settings.json is
 *  opaque to the backend, so a hand-edited or corrupt value reaches the
 *  frontend completely untyped.
 *
 *  MIGRATION: v0.7.4 pre-release carried `base: "dark" | "light"` plus
 *  `primary` / `secondary`. `sanitizeSettings` reads that shape — `base` maps
 *  to the matching stock background, `primary` to `accent`, `secondary` is
 *  dropped (audio clips and waveforms now follow the accent) — so an existing
 *  settings.json neither crashes nor produces a nonsense colour. */
export interface CustomTheme {
  /** The app background, exactly as picked. The whole surface ramp — panel,
   *  raised, input, hover, active, borders, ruler ticks — is derived from it,
   *  its luminance decides whether the app renders dark or light, and it is
   *  also the ink drawn on accent-filled surfaces (`--on-accent`). */
  background: string;
  /** Buttons, selection, focus rings, the toggled-on state, drop overlays, and
   *  the timeline's video clips, audio clips and waveforms. Used verbatim. */
  accent: string;
  /** The text ramp: --text-1 exactly as picked, plus the two quieter steps
   *  mixed from it toward the panel. */
  text: string;
}

/** Where a media file opened from File Explorer lands. Neither creates anything permanent:
 *  "viewer" shows it with no project; "editor" makes a TEMPORARY project. */
export type OpenWith = "viewer" | "editor";

export interface Settings {
  schema: 1;
  theme: "dark" | "light" | "system" | "custom";
  /** Only consulted when `theme === "custom"`; always present so the picker
   *  has something to open on. */
  customTheme: CustomTheme;
  autosaveSeconds: number;
  defaultExportDir: string | null;
  lastExportDir: string | null;
  hardwareAccel: boolean;
  cacheLimitMB: number;
  proxyMedia: boolean;
  /** drag a clip on the canvas → snap its center to the project center */
  snapCenterGuides: boolean;
  /** where a media file opened from File Explorer lands (see `OpenWith`).
   *  Replaces 0.8's `tempOpenWith` boolean, which the sanitizer still reads
   *  once as a migration hint and never writes back. */
  openWith: OpenWith;
  /** preview/monitor listening level 0..1 — NOT baked into clips or exports */
  monitorVolume: number;
  /** Height of the timeline panel in px, written by dragging its top divider.
   *  Clamped to [TIMELINE_HEIGHT_MIN, TIMELINE_HEIGHT_MAX] on read AND write —
   *  settings.json is opaque to the backend, so a hand-edited value reaches the
   *  frontend untyped and must never produce an unusable layout. */
  timelineHeight: number;
  shortcuts: Record<ActionId, string>;
  /** image editor: recently used ink colours, most recent first, ≤ 6, lowercase
   *  #rrggbb. Sanitized on read like every field (`asInkColors` in
   *  core/session.ts); diagnostics report only how many there are. */
  inkColors: string[];
}

/** The one clamp for `timelineHeight`, shared by the sanitizer and the drag
 *  handle so the two can never disagree about what a legal height is. The
 *  minimum keeps the ruler plus one lane usable; the maximum keeps the preview
 *  from collapsing on a 768-tall laptop. */
export const TIMELINE_HEIGHT_MIN = 160;
export const TIMELINE_HEIGHT_MAX = 640;

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
  /** "image" for image projects; absent for video projects */
  kind?: "image";
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
  // New actions go at the END: key order is the binding order (a chord bound to
  // several actions of one mode dispatches the first one listed that has a
  // handler), so appending never changes what an existing chord does.
  redoAlt: "Ctrl+Y",
  prevFile: "ArrowLeft",
  nextFile: "ArrowRight",
  seekBack: "Shift+ArrowLeft",
  seekFwd: "Shift+ArrowRight",
  // The image editor's own actions, image mode only (ACTION_MODES). None shares
  // a mode with an editor or viewer action, so these defaults cannot collide
  // with a stock chord — only with a user's custom one, and sanitizeShortcuts
  // then leaves that chord to the user and this action unbound.
  imgSelect: "V",
  imgPen: "P",
  imgPencil: "B",
  imgMarker: "H",
  imgEraser: "E",
  imgShape: "U",
  imgRuler: "R",
  imgSizeDown: "[",
  imgSizeUp: "]",
  imgZoomIn: "Ctrl+=",
  imgZoomOut: "Ctrl+-",
  imgZoomFit: "Ctrl+0",
  imgZoom100: "Ctrl+1",
  // Resolved by the image editor's own keydown/keyup pair through
  // `resolveChord`, never by a ShortcutManager handler: holding needs keyup.
  imgPanHold: "Space",
};

/** Which screens an action lives on. A chord conflicts only with an action that shares a
 *  mode; a ShortcutManager binds only its own mode's actions. `image` is the Phase-3 image
 *  editor: Phase 3 adds its own ActionIds and may WIDEN an existing row (copy/paste/delete),
 *  never narrow one. Record<ActionId, …> makes the compiler demand a row per new action.
 *
 *  Why seekBack/seekFwd are their own actions rather than jumpBack/jumpFwd in the viewer:
 *  the viewer seeks ±5 s while the editor's jump is ±1 s ("Jump forward 1s"), one action
 *  cannot mean both, and both must stay rebindable. */
export type ShortcutMode = "editor" | "viewer" | "image";
export const ACTION_MODES: Readonly<Record<ActionId, readonly ShortcutMode[]>> = {
  playPause: ["editor", "viewer"],
  stop: ["editor"],
  stepFwd: ["editor"],
  stepBack: ["editor"],
  jumpFwd: ["editor"],
  jumpBack: ["editor"],
  goStart: ["editor", "viewer"],
  goEnd: ["editor", "viewer"],
  split: ["editor"],
  // Delete / Copy mean "the selected layer" / "the whole image" in image mode.
  delete: ["editor", "image"],
  rippleDelete: ["editor"],
  undo: ["editor", "image"],
  redo: ["editor", "image"],
  redoAlt: ["editor", "image"],
  save: ["editor", "image"],
  copy: ["editor", "image"],
  // Editor-only ON PURPOSE: a bound chord is preventDefault()ed by the
  // ShortcutManager, which would kill the DOM `paste` event the image editor
  // reads pasted pixels from.
  paste: ["editor"],
  toggleSnap: ["editor"],
  toggleLoop: ["editor"],
  addMarker: ["editor"],
  export: ["editor", "image"],
  goHome: ["editor", "viewer", "image"],
  fullscreen: ["editor", "viewer"],
  prevFile: ["viewer"],
  nextFile: ["viewer"],
  seekBack: ["viewer"],
  seekFwd: ["viewer"],
  imgSelect: ["image"],
  imgPen: ["image"],
  imgPencil: ["image"],
  imgMarker: ["image"],
  imgEraser: ["image"],
  imgShape: ["image"],
  imgRuler: ["image"],
  imgSizeDown: ["image"],
  imgSizeUp: ["image"],
  imgZoomIn: ["image"],
  imgZoomOut: ["image"],
  imgZoomFit: ["image"],
  imgZoom100: ["image"],
  imgPanHold: ["image"],
};

/** The stock DARK palette's --bg-app, --accent and --text-1 — so switching to
 *  "Custom" starts from what the app already looks like rather than a jolt.
 *  Feeding these three back through `deriveCustomTheme` reproduces the built-in
 *  Dark theme; a test pins that. */
export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  background: "#111113",
  accent: "#6c7cff",
  text: "#ececf1",
};

/** What the pre-release `base` enum meant, kept only so an already-written
 *  settings.json migrates to a sensible colour instead of a fallback. Values
 *  are the two shipped palettes' --bg-app / --text-1. */
export const LEGACY_BASE_COLORS = {
  dark: { background: "#111113", text: "#ececf1" },
  light: { background: "#f6f6f8", text: "#1b1b20" },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  schema: 1,
  theme: "dark",
  customTheme: DEFAULT_CUSTOM_THEME,
  autosaveSeconds: 3,
  defaultExportDir: null,
  lastExportDir: null,
  hardwareAccel: true,
  cacheLimitMB: 2048,
  proxyMedia: true,
  snapCenterGuides: true,
  openWith: "viewer",
  monitorVolume: 1,
  timelineHeight: 280,
  shortcuts: DEFAULT_SHORTCUTS,
  inkColors: [],
};

/** Which family a media extension belongs to (see media-extensions.json). */
export type MediaFamily = "video" | "gif" | "image" | "audio";
/** What the viewer steps through together: video+gif+image, or audio alone. */
export type StepFamily = "visual" | "audio";

/** The ONE list of media extensions, shared with the backend: the Rust side
 *  reads the same JSON with `include_str!` (src-tauri/src/media/extensions.rs),
 *  so the picker, drop, open-with and the viewer's folder stepping can never
 *  disagree about what counts as media. Lowercase, no dots, no extension in two
 *  families, and never `trt` — src/dev/media-extensions.test.ts pins all four. */
export const MEDIA_EXTENSIONS: Readonly<Record<MediaFamily, readonly string[]>> = MEDIA_EXT;
/** Every importable media extension. Derived: never hand-edit a copy. */
export const MEDIA_FILE_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(MEDIA_EXT).flat());

/** `ext` lowercased, no dot (core/format.ts `fileExt` returns exactly that). */
export function mediaFamilyOf(ext: string): MediaFamily | null {
  for (const f of ["video", "gif", "image", "audio"] as const) {
    if (MEDIA_EXTENSIONS[f].includes(ext)) return f;
  }
  return null;
}
export function stepFamilyOf(ext: string): StepFamily | null {
  const f = mediaFamilyOf(ext);
  return f === null ? null : f === "audio" ? "audio" : "visual";
}

/** Crafted-.trt guard for image canvases (load-time only; never a user refusal). */
export const IMAGE_CANVAS_MAX_SIDE = 65535;
/** Chromium canvas limits (kMaxSkiaDim / kMaxCanvasArea): above these the app renders
 *  at the largest size that fits and says so — it never refuses the photo. */
export const RENDER_MAX_SIDE = 32767;
export const RENDER_MAX_AREA = 268_435_456;
/** libwebp bitstream limit per side */
export const WEBP_MAX_SIDE = 16383;
/** Strokes per drawing chunk. Appending a stroke copies only the chunk index and
 *  the last chunk, so unlimited undo stays linear in memory. */
export const STROKE_CHUNK = 256;

export const DEFAULT_EXPORT_PRESET: ExportPreset = {
  format: "mp4",
  vcodec: "h264",
  resolution: "original",
  fps: "original",
  videoBitrate: "auto",
  audioBitrate: "auto",
  useHardware: true,
};
