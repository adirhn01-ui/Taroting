// The folder viewer: one file at a time, arrows through its folder, no project.
// Lazy route chunk, never prefetched; imports only main-chunk modules plus
// ./loader, ./stepper, ./scrub, ./seek-pacer and ./scrub-copy (never anything under
// src/editor/ — that would drag the editor chunk into this one). A PDF is
// shown by ./pdf-mode, reached ONLY through import() on the first PDF: it
// and pdf.js behind it are never part of this chunk.
//
// Zero work while idle. One <img> and one <video>, reused for every file and
// emptied on every switch (the decoder and the Windows file handle go with the
// src). The player bar is driven by `timeupdate` (~4 Hz), never rAF; the one
// auto-hide timer is armed only while something plays or fullscreen is wanted;
// a held arrow key moves the NAME and COUNTER at key rate and loads only the
// file it settles on.

import "../ui/player-bar.css";
import "./viewer.css";
import { registerCloseTask } from "../core/app-close";
import { fileExt, fileName, formatDuration } from "../core/format";
import { describeError, ipc, mediaUrl, onJobEvents, revealInFolder, setWindowTitle } from "../core/ipc";
import type { KeyframeIndex } from "../core/ipc";
import { createMonitorVolume } from "../core/monitor-volume";
import type { MonitorVolumeState } from "../core/monitor-volume";
import { navigate } from "../core/nav";
import { PdfProtectedError, openMediaAsProject, runOnOpenChain } from "../core/open-media";
import { settingsStore } from "../core/session";
import { ShortcutManager, isTypingTarget, normalizeChord, shortcutsBlocked } from "../core/shortcuts";
import type { ActionId } from "../core/types";
import { elementFullscreen } from "../ui/fullscreen";
import { icon } from "../ui/icons";
import { closeMenu, showMenu } from "../ui/menu";
import type { MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";
import { DIRECT_TIMEOUT_MS, createSourceLoader } from "./loader";
import type { Damage, LoadState } from "./loader";
import type { PdfMemory, PdfMode } from "./pdf-mode";
import { bindScrub } from "./scrub";
import { ScrubCopy } from "./scrub-copy";
import type { ScrubCopySnapshot } from "./scrub-copy";
import { SeekPacer } from "./seek-pacer";
import {
  DWELL_MS,
  WINDOW_RADIUS,
  canStep,
  counterText,
  elementFor,
  fromWindow,
  nearEdge,
  step,
} from "./stepper";
import type { StepState } from "./stepper";

export interface ViewerHandle {
  /** Replace the shown file in place (second Explorer open while viewing): no remount,
   *  re-lists the new file's folder. Synchronous; the async work is generation-guarded. */
  show(path: string): void;
  /** The file currently shown (becomes EditorRoute.returnTo). */
  current(): string;
  dispose(): void;
}

/** Idle time before the chrome and cursor fade while something plays (ms).
 *  Was 2500, which the owner timed at "about 2 seconds" of waiting to see the
 *  clip clear: a viewer's chrome should be gone almost as soon as the mouse
 *  rests. Any move brings it straight back. */
const AUTO_HIDE_MS = 1000;
/** Shift+← / Shift+→ in the viewer (the owner's fixed ±5 s). */
const SEEK_S = 5;
/** Steps from the window's edge at which the next window is fetched early. */
const PREFETCH_MARGIN = 3;

/** The DEV hook the E2E reads (S19). Live getters, never snapshots. */
interface ViewerDev {
  readonly loads: number;
  readonly lastClass: string | null;
  readonly jobId: number | null;
  path(): string;
  forceUnprepared: boolean;
  /** Take a video's keyframe index as heavy whatever its gap and bit rate:
   *  the E2E's way onto the heavy drag path with a light fixture. Set after
   *  the index has answered, it re-weighs that answer at once. */
  forceHeavy: boolean;
  /** The current source scrubs as a heavy file (its index has answered). */
  heavy(): boolean;
  /** The current source's keyframe index has answered (heavy, light or none). */
  indexed(): boolean;
  /** That answer (null: unreadable; undefined: not answered yet). */
  index(): KeyframeIndex | null | undefined;
  /** The copy on disk the <video> plays, the one the index is asked of. */
  videoFile(): string | null;
  /** Every seek the pacer assigned since the last press on the seek bar, in
   *  order (`keyframe`: a fast drag's). */
  readonly seeks: { t: number; keyframe: boolean }[];
  /** The last media error the viewer's error listener handled, recorded
   *  before it reassigned anything (null: none yet). */
  lastError(): ViewerMediaError | null;
  /** Since mount: read-error rereads started, rereads that failed (an error
   *  before their frame showed), spurious-end recoveries started, reloads
   *  that showed their frame, and media errors handed to the loader. */
  counts(): { rereads: number; rereadFailures: number; endRecoveries: number; reloadSuccesses: number; toLoader: number };
  /** The heavy video's scrub copy (./scrub-copy): where it stands, whether it
   *  is on screen, the file it is for, and why it failed. */
  scrub(): ScrubCopySnapshot;
  /** Seeks issued since mount: to the scrub copy, and to the main video (its
   *  `seeking` events). */
  scrubSeeks(): { copy: number; main: number };
}
/** DEV: one media error as the viewer's listener saw it. */
interface ViewerMediaError {
  code: number | null;
  message: string;
  /** The element's currentTime then. */
  at: number;
  asked: number | null;
  ended: boolean;
  /** A reload was loading or not yet confirmed (the error is its failure). */
  duringReload: boolean;
}
type DevWindow = { __tarotingViewerDev?: ViewerDev; __tarotingAutotest?: boolean };

/** How a stored chord reads in a tooltip: the arrows as arrows, the rest as
 *  the Shortcuts card shows it. "" = unbound. */
const ARROW_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};
function chordHint(action: ActionId): string {
  const stored = settingsStore.get().shortcuts[action];
  const chord = typeof stored === "string" ? normalizeChord(stored) : "";
  if (!chord) return "";
  return chord
    .split("+")
    .map((p) => ARROW_GLYPHS[p] ?? p)
    .join("+");
}
/** "Next (→)", or "Next" alone when the action is unbound. */
function withChord(label: string, action: ActionId): string {
  const hint = chordHint(action);
  return hint ? `${label} (${hint})` : label;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** MediaError.MEDIA_ERR_NETWORK: for a local file, a read the engine lost.
 *  Spelled out because the node test environment has no MediaError. */
const MEDIA_ERR_NETWORK = 2;

/** In-place reloads a source gets after read errors before the loader is told. */
const READ_RETRIES = 2;

/** The reload allowance refills once this long has passed since the last
 *  reload (ms). A failure that persists — a file gone, a bad sector at the
 *  playhead — fails again within moments of each reload (the reload goes
 *  back to the failing position), so it still reaches the loader after two;
 *  the sporadic demuxer failures of a long scrub session are seconds apart
 *  and each gets its quiet reload. */
const READ_RETRY_WINDOW_MS = 10_000;

/** What holds the chrome up at the auto-hide timer (see chromeHeld). */
const CHROME_HELD =
  ".viewer__top:hover, .viewer__bar:hover, .viewer__nav:hover, " +
  ".viewer__top :focus-visible, .viewer__bar :focus-visible, .viewer__nav:focus-visible";

/** A reload's start position is never assigned before the metadata when it
 *  lies within this of the end (seconds): the reload is told nothing up front
 *  and seeks there once its metadata is in (loadedmetadata). */
const END_PRESTART_S = 0.5;

/** An `ended` the user did not cause: the element reports the end while the
 *  position the user wants is more than this before it (seconds). Natural
 *  playback reaches the end with its last timeupdate ~0.25 s before it. */
const END_SLACK_S = 1.0;

/** Spurious ends recovered in place per source (refilled like READ_RETRIES,
 *  after READ_RETRY_WINDOW_MS); past them the end is accepted. */
const END_RECOVERIES = 2;

/** A seek to within this of the element's position is not made (seconds):
 *  the editor's own margin (scheduler.ts activate), so the two seek alike. */
const SAME_POSITION_S = 0.01;

/** A video that has stayed on screen this long is asked for its keyframe
 *  index (ms): a read of the file's sample tables, no decoding, off the UI
 *  thread. It is what tells a heavy clip from a light one, so a heavy clip's
 *  scrub copy (./scrub-copy, SCRUB_DWELL_MS later) can be ready before the
 *  first drag. Files stepped past sooner are never read. Tuned by the owner's
 *  feel. */
export const INDEX_DWELL_MS = 1000;

/** " 40%", or "" while the ratio is unknown. */
function percentText(r: number | null): string {
  return r === null || !Number.isFinite(r) ? "" : ` ${Math.round(clamp(r, 0, 1) * 100)}%`;
}

// The damage wording below says what the editor says for the same file and
// state (src/editor/media/damage.ts: phaseText, damageRange,
// damageStageText), so the two screens never disagree. Repeated, not
// imported: an import from src/editor would drag the editor chunk into this
// one.

/** Where the repair stands, lower-case, for the middle of a sentence. */
function phaseText(d: Damage): string {
  switch (d.phase) {
    case "repairing":
      return `repairing${percentText(d.ratio)}`;
    case "recovered":
      return "recovered";
    case "unrecovered":
      return "couldn't be recovered";
  }
}

/** The top-bar pill: the user is told the file is damaged in every phase. */
function pillText(d: Damage): string {
  return `Damaged video · ${phaseText(d)}`;
}

/** The pill's tooltip: the range the file could not be read for. The end is
 *  FLOORED to the whole second, as the player's clock shows it: 60.6 s of
 *  damage reads "1:00" (the clock still says 1:00 there), where rounding
 *  would claim "1:01", a second that plays. */
function pillTip(d: Damage): string {
  return d.until === null
    ? "Part of this video couldn't be read"
    : `${formatDuration(0)}-${formatDuration(Math.floor(d.until))} couldn't be read`;
}

/** The label on the cover over the instant copy's unreadable part (shown only
 *  while that copy plays: repairing, or unrecovered when its full repair
 *  failed). */
function coverText(d: Damage): string {
  return d.phase === "recovered" ? "Damaged section" : `Damaged section · ${phaseText(d)}`;
}

// Static markup only: every file name reaches the DOM through textContent /
// properties, never through this string. No style attributes (packaged CSP).
const TEMPLATE = `
  <div class="viewer__stage" id="vw-stage">
    <img class="viewer__img" id="vw-img" decoding="async" draggable="false" alt="" hidden />
    <video class="viewer__video" id="vw-video" playsinline preload="auto" hidden></video>
    <div class="viewer__cover" id="vw-cover" hidden></div>
    <div class="viewer__audio-card" id="vw-audio" hidden>${icon("music", 48)}<div class="viewer__audio-name"></div></div>
    <div class="viewer__status" id="vw-status" role="status" hidden><div class="viewer__status-text"></div></div>
  </div>
  <div class="viewer__top" id="vw-top">
    <button class="btn btn--ghost btn--icon viewer__chrome-btn" id="vw-back" aria-label="Back">${icon("chevronLeft")}</button>
    <div class="viewer__name" id="vw-name"></div>
    <span class="badge viewer__damage" id="vw-damage" hidden></span>
    <div class="viewer__count" id="vw-count"></div>
    <button class="btn btn--ghost btn--icon viewer__chrome-btn" id="vw-fullscreen" aria-label="Fullscreen">${icon("fullscreen")}</button>
    <button class="btn btn--ghost btn--icon viewer__chrome-btn" id="vw-more" aria-label="More" title="More" aria-haspopup="menu">${icon("more")}</button>
  </div>
  <button class="btn btn--ghost btn--icon viewer__chrome-btn viewer__nav viewer__nav--prev" id="vw-prev" aria-label="Previous file" disabled aria-disabled="true">${icon("chevronLeft", 28)}</button>
  <button class="btn btn--ghost btn--icon viewer__chrome-btn viewer__nav viewer__nav--next" id="vw-next" aria-label="Next file" disabled aria-disabled="true">${icon("chevronRight", 28)}</button>
  <div class="theater-bar viewer__bar" id="vw-bar" hidden>
    <button class="btn btn--ghost btn--icon theater-bar__btn viewer__chrome-btn" id="vw-play" aria-label="Play">${icon("play")}</button>
    <div class="theater-bar__time mono" id="vw-time"></div>
    <div class="theater-bar__seek" id="vw-seek" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1">
      <div class="viewer__seek-damage" id="vw-seek-damage" hidden></div>
      <div class="theater-bar__seek-fill"></div>
      <div class="theater-bar__seek-knob"></div>
    </div>
    <div class="theater-bar__volume">
      <button class="btn btn--ghost btn--icon theater-bar__btn viewer__chrome-btn" id="vw-mute" aria-label="Mute" title="Mute / unmute">${icon("volume")}</button>
      <input class="slider theater-bar__volume-slider" id="vw-volume" type="range" min="0" max="1" step="0.01" aria-label="Volume" tabindex="-1" />
    </div>
  </div>
  <div class="viewer__live" id="vw-live" aria-live="polite"></div>
`;

export function mountViewer(root: HTMLElement, path: string): ViewerHandle {
  const el = document.createElement("div");
  el.className = "viewer";
  el.id = "vw";
  el.innerHTML = TEMPLATE;
  root.appendChild(el);

  const $ = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const stage = $("#vw-stage");
  const img = $<HTMLImageElement>("#vw-img");
  const video = $<HTMLVideoElement>("#vw-video");
  const coverEl = $("#vw-cover");
  const audioCard = $("#vw-audio");
  const audioName = $(".viewer__audio-name");
  const statusEl = $("#vw-status");
  const statusText = $(".viewer__status-text");
  const backBtn = $<HTMLButtonElement>("#vw-back");
  const topEl = $("#vw-top");
  const nameEl = $("#vw-name");
  const damageEl = $("#vw-damage");
  const countEl = $("#vw-count");
  const fsBtn = $<HTMLButtonElement>("#vw-fullscreen");
  const moreBtn = $<HTMLButtonElement>("#vw-more");
  const prevBtn = $<HTMLButtonElement>("#vw-prev");
  const nextBtn = $<HTMLButtonElement>("#vw-next");
  const bar = $("#vw-bar");
  const playBtn = $<HTMLButtonElement>("#vw-play");
  const timeEl = $("#vw-time");
  const seekEl = $("#vw-seek");
  const fillEl = $(".theater-bar__seek-fill");
  const knobEl = $(".theater-bar__seek-knob");
  const shadeEl = $("#vw-seek-damage");
  const muteBtn = $<HTMLButtonElement>("#vw-mute");
  const volSlider = $<HTMLInputElement>("#vw-volume");
  const liveEl = $("#vw-live");

  const devWin = window as unknown as DevWindow;
  // Before any src is ever assigned: wry allows gesture-free autoplay, and a
  // native <video>'s sound does not pass through the editor's silenced audio
  // graph, so without this every viewer E2E block would play on the owner's
  // speakers.
  if (import.meta.env.DEV && devWin.__tarotingAutotest === true) video.muted = true;

  /* ---------------- state ---------------- */

  let disposed = false;
  /** Bumped whenever the shown file changes (show or step). Every async
   *  continuation and every media event checks it. */
  let gen = 0;
  /** The file on screen (name, counter, returnTo). */
  let cur = path;
  /** The file last handed to the loader; its states are the only ones painted. */
  let loadingPath: string | null = null;
  let st: StepState | null = null;
  /** The folder listing failed for the shown file: arrows stay off, no toast. */
  let listFailed = false;
  let listGen = 0;
  /** A listSiblings call from refresh() is in flight. Never more than one: a
   *  fast clicker settles (and re-lists) on every photo, and latest-wins alone
   *  only discards the stale answers — the backend still reads the folder once
   *  per click. */
  let listBusy = false;
  /** ONE refresh asked for while another was in flight (latest wins), run as
   *  soon as that one settles either way. */
  let listQueued: { p: string; wantAnnounce: boolean } | null = null;
  /** ONE held direction waiting for a window refill (latest wins). */
  let pendingDir: -1 | 1 | null = null;
  let pendingRepeat = false;
  let dwellTimer: number | undefined;
  /** When the last step was taken (performance.now()); see DWELL_MS.burst. */
  let lastStepAt = Number.NEGATIVE_INFINITY;
  /** "Open as project" is running: user stepping and Back wait for it. */
  let busy = false;
  /** The viewer is being left for the project "Open as project" made, whose
   *  exit comes back here: the folder order the backend holds must survive
   *  that round trip, so dispose() does not drop it. */
  let leavingForProject = false;
  let lastAnnounce = "";

  /** What is loaded into each element, so an `error` fired by clearing a src
   *  (or by a file we already left) is never taken for the current file's. */
  let imgUrl: string | null = null;
  let imgGen = -1;
  let videoUrl: string | null = null;
  let videoGen = -1;
  /** A container-only file is being tried directly; a media error or no
   *  metadata within DIRECT_TIMEOUT_MS hands it to the loader for a remux. */
  let tryingDirect = false;
  let directTimer: number | undefined;
  /** What the loader says about the video on screen when it is a damaged
   *  file's repair; null for a healthy file, and whenever no video is out. */
  let damage: Damage | null = null;
  /** The full repair was just swapped in under the instant copy and does not
   *  know its metadata yet: where playback was and how long the file is, so
   *  the readout, the bar and the cover hold still instead of reading 0. */
  let swapHold: { t: number; d: number } | null = null;
  /** Where the user asked the <video> to be while that seek is in flight:
   *  the bar and the clock show this, not the element's time, exactly as the
   *  editor's fullscreen bar shows its engine time (the owner's reference:
   *  "perfect ... aligned"). Before, the viewer painted the element's time on
   *  `seeked`/`timeupdate` only, so mid-drag the knob trailed the cursor. */
  let asked: number | null = null;
  /** The copy on disk the <video> plays (LoadState `file`): where its
   *  keyframe index is read from. Null for audio and while no video is out. */
  let videoFile: string | null = null;
  /** This source's keyframe index was asked for (after INDEX_DWELL_MS on
   *  screen, or on its first scrub if that came sooner). */
  let indexAsked = false;
  /** Asks for the index once the video has stayed INDEX_DWELL_MS. */
  let indexTimer: number | undefined;
  /** DEV: this source's keyframe index as it answered (null: unreadable),
   *  undefined until it has; kept for forceHeavy to re-weigh. A release build
   *  keeps nothing: the pacer holds a heavy file's keyframes, nobody a light
   *  file's. */
  let indexAnswer: KeyframeIndex | null | undefined;
  /** DEV: the E2E's forceHeavy (see ViewerDev). */
  let devForceHeavy = false;
  /** Bumped by every source change: an index answer for an older source is
   *  dropped. */
  let srcGen = 0;
  /** The next `at` of the seek bar is its press, not a move. */
  let pressAt = false;
  /** In-place reloads after a read error on the video on screen (see the
   *  error listener); reset by every new source. */
  let readRetries = 0;
  /** Such a reload is loading and has not reached its metadata yet: an error
   *  now is the same read failure, whatever code the reload reports — a file
   *  that went away answers its first request 404, which Chromium reports
   *  as MEDIA_ERR_SRC_NOT_SUPPORTED, and the loader would take that for a
   *  damaged stream and start a repair of a missing file. */
  let rereading = false;
  /** When the last such reload started (performance.now()). */
  let lastRereadAt = Number.NEGATIVE_INFINITY;
  /** The last position that was really the user's: what they last asked for,
   *  or where playback was while not at its end. An `ended` the user did not
   *  cause (a seek the engine sent to the end) never moves it, so a reload
   *  after one goes back here, not to the duration. */
  let goodTime = 0;
  /** The user wants the video playing: set by `play`, cleared by any pause
   *  but the end's own (Chromium pauses at the end before `ended`). */
  let playIntent = false;
  /** Spurious ends recovered for this source, and when the last one was. */
  let endRecoveries = 0;
  let lastEndRecoveryAt = Number.NEGATIVE_INFINITY;
  /** A reload (read-error reread or end recovery) reached its metadata and
   *  has not yet shown a frame where the user wants to be. Showing one is the
   *  reload's SUCCESS: the allowances refill (see confirmReload). An error
   *  before it is the reload failing. */
  let verifying = false;
  /** A reload was confirmed (its allowances refilled) and the user has not
   *  asked for a position since: the next failure then comes from playback
   *  alone, at a spot that fails by itself, so the refill is taken back
   *  (refillTaken) — a spot that fails right after every recovery reaches
   *  the loader instead of looping. Any user seek clears it (noteUserSeek):
   *  errors the user's own seeking provokes on a healthy file always get
   *  their reload, however often and wherever aimed. */
  let noSeekSinceConfirm = false;
  /** What the last confirmation refilled, restored by refillTaken. */
  let refilledRetries = 0;
  let refilledEnds = 0;
  /** DEV: what the error listener saw, before it touched the element. */
  let devLastError: ViewerMediaError | null = null;
  const devCounts = { rereads: 0, rereadFailures: 0, endRecoveries: 0, reloadSuccesses: 0, toLoader: 0 };

  /** The PDF mode while a PDF is the shown file (null otherwise); see showPdf. */
  let pdf: PdfMode | null = null;
  let pdfModule: Promise<typeof import("./pdf-mode")> | null = null;
  /** The zoom and the rail toggle, kept while stepping between PDFs. */
  const pdfMemory: PdfMemory = { fit: "width", zoom: 1, railOpen: null };

  const hasMedia = (): boolean => videoUrl !== null;
  /** The position the user is at: where they asked to be while that frame is
   *  not on screen yet, else the held one while a swap loads, else the
   *  element's. */
  const playhead = (): number => {
    return asked !== null ? asked : swapHold !== null ? swapHold.t : video.currentTime || 0;
  };
  /** Where a reload of the current source restores to: the asked position,
   *  else the held one, else the element's — unless the element sits at an
   *  end: then where the user last was (goodTime), which is the end only when
   *  they went there or playback ran out. */
  const restorePoint = (): number => {
    if (asked !== null) return asked;
    if (swapHold !== null) return swapHold.t;
    return video.ended ? goodTime : video.currentTime || 0;
  };
  /** The file's length, or the held one while a swap loads (0: unknown). */
  const lengthOf = (): number =>
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (swapHold?.d ?? 0);

  /* ---------------- the loader ---------------- */

  const loader = createSourceLoader((p, s) => onState(p, s));

  // S19: live getters over the loader, set before the first load() because the
  // loader reads `forceUnprepared` off this object.
  const dev: ViewerDev | null = import.meta.env.DEV
    ? {
        get loads() {
          return loader.debug().loads;
        },
        get lastClass() {
          return loader.debug().lastClass;
        },
        get jobId() {
          return loader.debug().jobId;
        },
        path: () => cur,
        forceUnprepared: false,
        get forceHeavy() {
          return devForceHeavy;
        },
        set forceHeavy(v: boolean) {
          devForceHeavy = v;
          if (indexAnswer !== undefined) {
            pacer.setIndex(indexAnswer, v);
            if (videoFile !== null) scrubCopy.indexed(videoFile, pacer.heavy());
          }
        },
        heavy: () => pacer.heavy(),
        indexed: () => indexAnswer !== undefined,
        index: () => indexAnswer,
        videoFile: () => videoFile,
        seeks: [],
        lastError: () => devLastError,
        counts: () => ({ ...devCounts }),
        scrub: () => scrubCopy.snapshot(),
        scrubSeeks: () => ({ copy: scrubCopy.copySeeks, main: devMainSeeks }),
      }
    : null;
  if (dev) devWin.__tarotingViewerDev = dev;

  /** Heavy clips' seek-bar drags (./seek-pacer): idle for a light file. */
  const pacer = new SeekPacer(video, {
    tolerance: SAME_POSITION_S,
    onIssue: dev ? (t, keyframe) => void dev.seeks.push({ t, keyframe }) : undefined,
  });

  /** DEV: `seeking` events of the main video (the E2E's count). */
  let devMainSeeks = 0;
  if (dev) video.addEventListener("seeking", () => void devMainSeeks++);

  /** A heavy clip's all-keyframe scrub copy (./scrub-copy): shown over the
   *  picture while the seek bar is dragged. Nothing for a light file: its
   *  element is made on the first copy, its job asked only for a heavy one. */
  const scrubCopy = new ScrubCopy({
    main: video,
    createCopy: () => {
      const c = document.createElement("video");
      c.className = "viewer__scrub-copy";
      c.id = "vw-scrub";
      c.muted = true;
      c.preload = "auto";
      c.playsInline = true;
      // CORS-clean like the editor's preview elements (the asset protocol
      // answers the window's origin), so its pixels can be read back.
      c.crossOrigin = "anonymous";
      c.hidden = true;
      c.setAttribute("aria-hidden", "true");
      // Above the picture, below the cover, the status card and the chrome.
      stage.insertBefore(c, coverEl);
      return c;
    },
    seekMain: (t) => seekTo(t),
    plan: (file) => ipc.planScrub(file),
    cancel: (id) => void ipc.cancelJob(id).catch(() => {}),
    listen: (h) =>
      onJobEvents({
        onDone: (e) => h.done(e.id, typeof e.output["path"] === "string" ? e.output["path"] : null),
        onFailed: (e) => h.failed(e.id, e.message),
      }),
    url: (p) => mediaUrl(p),
  });

  /** The <video> is about to get a new source (or none): the pacer forgets
   *  the old one — a keyframe still waiting must never reach the new one —
   *  and the new one is asked for its own index on its first scrub. */
  function resetPacer(): void {
    pacer.reset();
    // A new source: a scrub-copy job still running for the old one stops.
    scrubCopy.reset();
    srcGen++;
    indexAsked = false;
    indexAnswer = undefined;
    pressAt = false;
    window.clearTimeout(indexTimer);
    indexTimer = undefined;
  }

  /** A video source was just set: ask for its keyframe index once it has
   *  stayed INDEX_DWELL_MS, so a heavy clip's scrub copy can be under way
   *  before the first drag. A file stepped past sooner is never read, and an
   *  audio file (no `videoFile`) never is. Always after resetPacer(), which
   *  drops the old source's timer. */
  function armIndexDwell(): void {
    if (videoFile === null) return;
    indexTimer = window.setTimeout(() => {
      indexTimer = undefined;
      askIndex();
    }, INDEX_DWELL_MS);
  }

  /** The current video's keyframe index, once per source: when the video
   *  has stayed INDEX_DWELL_MS (armIndexDwell), or on a scrub's start if
   *  that comes sooner. Never at load: nothing is read for a clip stepped
   *  past. Until it answers, and for no answer, the drag is the light one. */
  function askIndex(): void {
    if (indexAsked || videoFile === null || disposed) return;
    indexAsked = true;
    const my = srcGen;
    const file = videoFile;
    ipc.keyframeTimes(file).then(
      (ix) => {
        if (disposed || my !== srcGen) return;
        if (import.meta.env.DEV) indexAnswer = ix;
        pacer.setIndex(ix, import.meta.env.DEV && devForceHeavy);
        scrubCopy.indexed(file, pacer.heavy());
      },
      () => {},
    );
  }

  /* ---------------- status card ---------------- */

  let statusKey = "";
  let statusDetail: HTMLElement | null = null;
  let prepareBtn: HTMLButtonElement | null = null;

  /** null hides the card. Rebuilt only when what it says changes, so a stream
   *  of progress events at the same percentage writes nothing. */
  function setStatus(text: string | null, opts?: { detail?: string; prepare?: boolean }): void {
    const key = text === null ? "" : `${text}\u0000${opts?.detail ?? ""}\u0000${opts?.prepare ? 1 : 0}`;
    if (key === statusKey) return;
    statusKey = key;
    if (text === null) {
      statusEl.hidden = true;
      statusText.textContent = "";
    } else {
      statusText.textContent = text;
      statusEl.hidden = false;
    }
    const detail = text === null ? undefined : opts?.detail;
    if (detail) {
      if (!statusDetail) {
        statusDetail = document.createElement("div");
        statusDetail.className = "viewer__status-detail";
        statusEl.appendChild(statusDetail);
      }
      statusDetail.textContent = detail;
    } else if (statusDetail) {
      statusDetail.remove();
      statusDetail = null;
    }
    // Created only while it is offered, so "the button exists" and "the button
    // is on screen" never disagree.
    if (text !== null && opts?.prepare) {
      if (!prepareBtn) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn--primary btn--sm";
        b.id = "vw-prepare";
        b.textContent = "Prepare preview";
        b.addEventListener("click", () => {
          b.blur();
          if (!disposed) loader.prepare();
        });
        prepareBtn = b;
        statusEl.appendChild(b);
      }
    } else if (prepareBtn) {
      prepareBtn.remove();
      prepareBtn = null;
    }
  }

  /* ---------------- a damaged file ---------------- */

  // Last written values: a progress stream at one percentage, and the ~4 Hz
  // timeupdate that drives the cover, write nothing.
  let damageText = "";
  let damageTipText = "";
  let shadePct = -1;
  let coverShows = false;

  /** The pill, its tooltip, the seek shade and the cover, from `damage`. */
  function paintDamage(): void {
    const d = hasMedia() ? damage : null;
    const text = d === null ? "" : pillText(d);
    if (text !== damageText) {
      damageText = text;
      damageEl.textContent = text;
      damageEl.hidden = text === "";
    }
    const tip = d === null ? "" : pillTip(d);
    if (tip !== damageTipText) {
      damageTipText = tip;
      damageEl.title = tip;
    }
    paintShade();
    paintCover();
  }

  /** The damaged range [0, until] shaded on the seek track. */
  function paintShade(): void {
    const until = hasMedia() && damage !== null ? damage.until : null;
    const len = lengthOf();
    // A length not known yet (before the metadata): keep what is painted.
    if (until !== null && len <= 0) return;
    const pct = until === null ? 0 : Math.round(clamp(until / len, 0, 1) * 1000) / 10;
    if (pct === shadePct) return;
    shadePct = pct;
    shadeEl.style.setProperty("width", `${pct}%`);
    shadeEl.hidden = pct <= 0;
  }

  /** Black over the instant copy while the playhead is in the part it has no
   *  picture for (the element would hold its first sound frame there, which
   *  reads as a frozen video), labelled on the status card. Never over the
   *  full repair: that part is ffmpeg's recovered picture, shown as it is. */
  function paintCover(): void {
    const d = hasMedia() ? damage : null;
    const on = d !== null && d.phase !== "recovered" && d.until !== null && playhead() < d.until;
    if (on !== coverShows) {
      coverShows = on;
      coverEl.hidden = !on;
      // The card is the cover's label now: clicks go through to the video.
      statusEl.classList.toggle("viewer__status--passive", on);
      if (!on) setStatus(null);
    }
    if (on && d !== null) setStatus(coverText(d));
  }

  /* ---------------- media elements ---------------- */

  /** Empty the <video>: pause, drop the src, load() — the documented way to
   *  make the engine let go of the decoder (~130 MB for 4K) and the file handle
   *  (Explorer cannot rename or delete a file we still hold). */
  function releaseVideo(): void {
    resetPacer();
    videoFile = null;
    tryingDirect = false;
    window.clearTimeout(directTimer);
    directTimer = undefined;
    if (videoUrl !== null || video.hasAttribute("src")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    videoUrl = null;
    swapHold = null;
    asked = null;
    readRetries = 0;
    rereading = false;
    resetEndState();
    damage = null;
    video.hidden = true;
    audioCard.hidden = true;
    bar.hidden = true;
    // A seek bar still held lets go with the file it was seeking: the next
    // file is never dragged by a press that began on this one.
    seekDrag.cancel();
    scrubbing = false;
    paintDamage();
    paintPlay();
    syncAutoHide();
  }

  function releaseImg(): void {
    if (img.hasAttribute("src")) img.removeAttribute("src");
    imgUrl = null;
    img.hidden = true;
  }

  /** Take the PDF mode down (strip, rail, bars, document, listeners). */
  function closePdf(): void {
    if (pdf === null) return;
    pdf.dispose();
    pdf = null;
    bindModeKeys();
    syncAutoHide();
  }

  /** The loader says `p` is a PDF: fetch the PDF mode on first use, then open
   *  it there. A newer file shown meanwhile (gen moved) wins. */
  function showPdf(p: string): void {
    releaseVideo();
    releaseImg();
    setStatus(null);
    const myGen = gen;
    const live = (): boolean => !disposed && myGen === gen && loadingPath === p && cur === p;
    if (pdf !== null) {
      void pdf.open(p, live);
      return;
    }
    pdfModule ??= import("./pdf-mode");
    pdfModule.then(
      (mod) => {
        if (!live()) return;
        pdf ??= mod.mountPdfMode({ root: el, stage, top: topEl, nameEl, setStatus, withChord }, pdfMemory);
        bindModeKeys();
        syncAutoHide();
        void pdf.open(p, live);
      },
      (e) => {
        // A chunk that failed to load: the next PDF tries again.
        pdfModule = null;
        if (live()) setStatus("Can't show this file", { detail: describeError(e) });
      },
    );
  }

  function showReady(s: Extract<LoadState, { state: "ready" }>): void {
    setStatus(null);
    closePdf();
    if (s.element === "img") {
      releaseVideo();
      imgUrl = s.url;
      imgGen = gen;
      img.alt = fileName(cur);
      // Kept on ONE <img>: while the new picture decodes the old one stays up
      // (the HTML "pending request" rule), so stepping through photos never
      // flashes black.
      if (img.getAttribute("src") !== s.url) img.src = s.url;
      img.hidden = false;
      return;
    }
    releaseImg();
    const audio = s.kind === "audio";
    audioName.textContent = fileName(cur);
    audioCard.hidden = !audio;
    video.hidden = audio;
    bar.hidden = false;
    lastTimeText = "";
    lastPct = -1;
    videoUrl = s.url;
    videoGen = gen;
    swapHold = null;
    asked = null;
    resetPacer();
    videoFile = audio ? null : (s.file ?? null);
    armIndexDwell();
    readRetries = 0;
    rereading = false;
    resetEndState();
    damage = s.damage ?? null;
    tryingDirect = s.tryingDirect;
    window.clearTimeout(directTimer);
    directTimer = undefined;
    video.src = s.url;
    if (s.tryingDirect) {
      const myGen = gen;
      const myUrl = s.url;
      directTimer = window.setTimeout(() => {
        directTimer = undefined;
        if (disposed || myGen !== gen || videoUrl !== myUrl || !tryingDirect) return;
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
        tryingDirect = false;
        loader.playbackFailed(null);
      }, DIRECT_TIMEOUT_MS);
    }
    paintReadout();
    paintDamage();
    // Autoplay; a refusal just leaves the paused glyph showing.
    void video.play().catch(() => {});
  }

  /** The full repair replaces the instant copy on screen: the same element
   *  takes the new src and carries playback over — never a release, so no
   *  status card ("Preparing", "Can't show this file") and no hidden bar in
   *  between. */
  function swapVideo(url: string, t = restorePoint(), resume = !video.paused): void {
    const len = lengthOf();
    // A seek still waiting is carried in `t`: the new src abandons the one in
    // flight, so no `seeked` would ever send it.
    asked = null;
    resetPacer();
    armIndexDwell();
    rereading = false;
    verifying = false;
    swapHold = { t, d: len };
    // Before the src: the error guard compares the two.
    videoUrl = url;
    video.src = url;
    // Assigned before the metadata, the position becomes the new copy's
    // default playback start position (HTML), so it starts where the old one
    // was; loadedmetadata makes sure of it.
    // Never AT the end, though: an engine opened with its start position
    // there may have nothing to show but its first frame. Such a reload starts
    // at 0 and loadedmetadata seeks to `t` (more than 0.5 s away).
    if (!(len > 0 && t >= len - END_PRESTART_S)) {
      try {
        video.currentTime = t;
      } catch {
        /* loadedmetadata seeks instead */
      }
    }
    if (resume) void video.play().catch(() => {});
  }

  /** The last state painted for the file on screen (read by openAsProject's
   *  failure path). */
  let shownState: LoadState["state"] | null = null;

  function onState(p: string, s: LoadState): void {
    // May run synchronously inside loader.load(): `cur` and `loadingPath` are
    // always set before load() is called.
    if (disposed || p !== loadingPath || p !== cur) return;
    shownState = s.state;
    switch (s.state) {
      case "loading":
        setStatus(null);
        return;
      case "document":
        showPdf(p);
        return;
      case "ready":
        if (s.element === "video" && s.damage !== undefined && videoUrl !== null && videoGen === gen) {
          // This load's damaged video is already out: only what the user is
          // told changed (the same url — the element is left alone), or the
          // full repair replaced the instant copy (swapped in where it was).
          if (s.url !== videoUrl) {
            // A new source (the full repair over the instant copy): its own
            // reload allowance, not what the instant copy spent.
            readRetries = 0;
            noSeekSinceConfirm = false;
            // Its own copy on disk: its own keyframe index, on its next scrub.
            videoFile = s.file ?? null;
            swapVideo(s.url);
          }
          damage = s.damage;
          paintDamage();
          return;
        }
        showReady(s);
        return;
      case "preparing":
        closePdf();
        releaseVideo();
        releaseImg();
        // A repair of a file the WebView refused says so while it runs: the
        // user is told the file is damaged before anything plays. Until a
        // repair reports a percent - the plan still being asked, or the
        // instant copy being made - it reads "preparing", with no number: the
        // instant copy's own progress is not the repair's, and showing it
        // would make the percent go backwards once the copy plays. Every
        // damaged wait therefore reads preparing, then repairing N%.
        setStatus(
          s.damaged && (s.quick || s.ratio === null)
            ? "Damaged video · preparing"
            : `${s.damaged ? "Damaged video · repairing" : "Preparing preview"}${percentText(s.ratio)}`,
        );
        return;
      case "needsPrepare":
        closePdf();
        releaseVideo();
        releaseImg();
        setStatus("This video needs a preview copy", { prepare: true });
        return;
      case "failed":
        closePdf();
        releaseVideo();
        releaseImg();
        setStatus("Can't show this file", { detail: s.message });
        return;
    }
  }

  // `error` is honoured only for the element in use, for the current file,
  // with the src we gave it: clearing a src fires one too.
  img.addEventListener("error", () => {
    if (disposed || imgUrl === null || imgGen !== gen || img.getAttribute("src") !== imgUrl) return;
    releaseImg();
    setStatus("Can't show this file");
  });
  /** Reload the source on screen at `t`, playing if the user means it to be
   *  (playIntent: the element's own paused flag at an error says nothing
   *  about that). Marks the reload for confirmReload. */
  function reloadInPlace(t: number, now: number): void {
    if (videoUrl === null) return;
    lastRereadAt = now;
    swapVideo(videoUrl, t, playIntent);
    // After the swap, which clears it for any other source change.
    rereading = true;
  }

  /** The read-error reload: the same source again where the user was
   *  (restorePoint), counted against READ_RETRIES until it shows its frame. */
  function rereadInPlace(now = performance.now()): void {
    if (videoUrl === null) return;
    readRetries++;
    devCounts.rereads++;
    reloadInPlace(restorePoint(), now);
  }

  /** A reload reached its metadata and now shows a frame where the user
   *  wants to be: it worked. A seek-burst read error on a healthy file is
   *  then fully behind us, so the allowances refill — provisionally: if the
   *  next failure comes before any user seek, refillTaken takes it back. */
  function confirmReload(): void {
    if (!verifying || video.seeking || asked !== null || video.readyState < 2) return;
    verifying = false;
    devCounts.reloadSuccesses++;
    refilledRetries = readRetries;
    refilledEnds = endRecoveries;
    readRetries = 0;
    endRecoveries = 0;
    noSeekSinceConfirm = true;
  }

  /** The user asked for a position (seekTo, a heavy drag's move): a failure
   *  after this is one their seeking provoked, so the last refill stands. */
  function noteUserSeek(): void {
    noSeekSinceConfirm = false;
  }

  /** A failure (read error or spurious end) arrived with no user seek since
   *  the last confirmed reload: playback alone hit a spot that fails by
   *  itself, so that reload's refill is undone and this failure counts
   *  against what was left. */
  function refillTaken(): void {
    if (!noSeekSinceConfirm) return;
    noSeekSinceConfirm = false;
    readRetries = Math.max(readRetries, refilledRetries);
    endRecoveries = Math.max(endRecoveries, refilledEnds);
  }

  function resetEndState(): void {
    goodTime = 0;
    playIntent = false;
    endRecoveries = 0;
    lastEndRecoveryAt = Number.NEGATIVE_INFINITY;
    verifying = false;
    noSeekSinceConfirm = false;
    refilledRetries = 0;
    refilledEnds = 0;
  }

  /** The element reports its END while the user wants a position well before
   *  it (a seek the engine sent to the end — seen on a fast drag while
   *  playing): a failed seek, not the end of the video. The same source is
   *  reloaded where the user wanted to be, playing if they were, at most
   *  END_RECOVERIES times per READ_RETRY_WINDOW_MS; past that the end stands. */
  function recoverSpuriousEnd(): void {
    if (disposed || !video.ended || videoUrl === null || videoGen !== gen) return;
    if (tryingDirect || swapHold !== null || rereading) return;
    const len = lengthOf();
    if (!(len > 0)) return;
    const want = asked ?? goodTime;
    if (want >= len - END_SLACK_S) return;
    refillTaken();
    const now = performance.now();
    if (now - lastEndRecoveryAt > READ_RETRY_WINDOW_MS) endRecoveries = 0;
    if (endRecoveries >= END_RECOVERIES) return;
    endRecoveries++;
    devCounts.endRecoveries++;
    lastEndRecoveryAt = now;
    reloadInPlace(want, now);
  }

  video.addEventListener("error", () => {
    if (disposed || videoUrl === null || videoGen !== gen || video.getAttribute("src") !== videoUrl) return;
    const duringReload = rereading || verifying;
    if (import.meta.env.DEV) {
      devLastError = {
        code: video.error?.code ?? null,
        message: video.error?.message ?? "",
        at: video.currentTime,
        asked,
        ended: video.ended === true,
        duringReload,
      };
    }
    // A reload that errors before showing its frame has failed: it refills
    // nothing (its retry stays counted).
    if (duringReload) devCounts.rereadFailures++;
    verifying = false;
    // A READ error (MEDIA_ERR_NETWORK) on a local file that already played is
    // the engine losing its place, not the file refusing: a burst of seeks can
    // fail one inside Chromium's demuxer ("demuxer seek failed"). The same
    // source is loaded again where the user was, twice at most per source, and
    // only then does the loader hear of it.
    const readFailure = video.error?.code === MEDIA_ERR_NETWORK || rereading;
    const now = performance.now();
    // No seek since the last confirmed reload: playback alone failed again,
    // so that reload's refill does not count (refillTaken).
    if (readFailure) refillTaken();
    if (readFailure && !rereading && now - lastRereadAt > READ_RETRY_WINDOW_MS) readRetries = 0;
    if (readFailure && !tryingDirect && readRetries < READ_RETRIES && lengthOf() > 0) {
      rereadInPlace(now);
      return;
    }
    // Out of reloads: the loader hears what happened first, a read failure
    // (which it never repairs), not the code the last reload ended on.
    const code = rereading ? MEDIA_ERR_NETWORK : (video.error?.code ?? null);
    rereading = false;
    tryingDirect = false;
    window.clearTimeout(directTimer);
    directTimer = undefined;
    // The loader decides what the refusal earns — a remux for a container-only
    // attempt, a repair for a video the WebView could not decode, or "Can't
    // show this file" — and paints it through onState like any state.
    devCounts.toLoader++;
    loader.playbackFailed(code);
  });
  video.addEventListener("loadedmetadata", () => {
    if (videoGen !== gen) return;
    // A reload after a read error got this far: the source reads again. It
    // has worked once it shows its frame (confirmReload).
    if (rereading) verifying = true;
    rereading = false;
    window.clearTimeout(directTimer);
    directTimer = undefined;
    const hold = swapHold;
    if (hold !== null) {
      swapHold = null;
      const len = lengthOf() || hold.t;
      if (asked !== null) {
        // The user asked for a position while the reload loaded (seekTo kept
        // it in the hold and on the knob): the reload goes exactly there.
        const want = Math.min(asked, len);
        if (Math.abs((video.currentTime || 0) - want) > SAME_POSITION_S) {
          asked = want;
          video.currentTime = want;
        } else {
          asked = null;
        }
      } else if (Math.abs((video.currentTime || 0) - hold.t) > 0.5) {
        // In case the engine dropped the early assignment: a swap must never
        // restart the file from 0.
        video.currentTime = Math.min(hold.t, len);
      }
    }
    confirmReload();
    paintReadout();
    paintDamage();
  });
  video.addEventListener("durationchange", () => {
    if (damage !== null) paintShade();
    if (!hidden) paintReadout();
  });
  video.addEventListener("seeked", () => {
    // A landing where the user asked (or playback's own) is the user's
    // position; one the engine put somewhere else — the end, for a mid-file
    // ask — is not.
    if (!video.seeking && !video.ended && (asked === null || Math.abs(video.currentTime - asked) <= END_PRESTART_S)) {
      goodTime = video.currentTime;
    }
    // Before `asked` is let go of below: it is what the user wanted.
    recoverSpuriousEnd();
    pacer.seeked();
    // The last asked position landed (a newer ask keeps `seeking` true) —
    // unless a heavy drag is held: then the cursor owns the position and the
    // frame that landed may be a keyframe's.
    if (!video.seeking && !pacer.holding() && !scrubCopy.holding()) asked = null;
    scrubCopy.mainSeeked();
    confirmReload();
    if (damage !== null) paintCover();
    if (!hidden) paintReadout();
  });
  // The reload's first frame where it started (no seek after its metadata).
  video.addEventListener("loadeddata", confirmReload);
  video.addEventListener("canplay", confirmReload);
  video.addEventListener("canplay", () => scrubCopy.mainSeeked());
  video.addEventListener("timeupdate", () => {
    if (video.ended) recoverSpuriousEnd();
    else if (!video.seeking && asked === null && swapHold === null) goodTime = video.currentTime;
    // Not chrome: the cover follows the playhead while the bar is hidden too.
    if (damage !== null) paintCover();
    // Hidden chrome: remember, repaint once on reveal.
    if (hidden) readoutDirty = true;
    else paintReadout();
  });
  const onPlayState = (): void => {
    paintPlay();
    syncAutoHide();
  };
  video.addEventListener("play", () => {
    playIntent = true;
    onPlayState();
  });
  video.addEventListener("pause", () => {
    // Only the user's pause drops the intent. The end's own pause, one that
    // comes with a media error, and one while a reload loads keep it: a
    // recovery resumes playing.
    // Nor the scrub copy's pause for a drag: the release resumes playing.
    if (!video.ended && !video.error && swapHold === null && !rereading && !scrubCopy.pausing()) playIntent = false;
    onPlayState();
  });
  video.addEventListener("ended", () => {
    onPlayState();
    recoverSpuriousEnd();
  });

  /* ---------------- name, counter, arrows ---------------- */

  function paintName(): void {
    const name = fileName(cur);
    if (nameEl.textContent !== name) nameEl.textContent = name;
    if (nameEl.title !== cur) nameEl.title = cur;
  }

  function setDisabled(b: HTMLButtonElement, off: boolean): void {
    if (b.disabled === off) return;
    b.disabled = off;
    b.setAttribute("aria-disabled", String(off));
  }

  function paintNav(): void {
    const text = st ? counterText(st) : "";
    if (countEl.textContent !== text) countEl.textContent = text;
    // Nothing to step to either way: nothing to show. Asked of canStep, the
    // same question the keyboard asks — not of the count, which leaves out a
    // hidden or deleted file on screen: that file with one visible neighbour
    // counts 1, yet ←/→ still step to the neighbour, and the mouse must too.
    const single = st !== null && !canStep(st, -1) && !canStep(st, 1);
    if (prevBtn.hidden !== single) prevBtn.hidden = single;
    if (nextBtn.hidden !== single) nextBtn.hidden = single;
    setDisabled(prevBtn, busy || st === null || !canStep(st, -1));
    setDisabled(nextBtn, busy || st === null || !canStep(st, 1));
    // Written only on change: a held key repaints this at key-repeat rate.
    const why = listFailed ? "Couldn't read this folder" : null;
    const prevTitle = why ?? withChord("Previous", "prevFile");
    const nextTitle = why ?? withChord("Next", "nextFile");
    if (prevBtn.title !== prevTitle) prevBtn.title = prevTitle;
    if (nextBtn.title !== nextTitle) nextBtn.title = nextTitle;
  }

  function paintTitles(): void {
    backBtn.title = withChord("Back", "goHome");
    paintNav();
    paintFs(true);
    playShows = null;
    paintPlay();
  }

  function setTitle(p: string): void {
    void setWindowTitle(`${fileName(p)} — Taroting`).catch(() => {});
  }

  function announce(): void {
    if (!st) return;
    const n = st.total;
    const i = st.firstIndex === null ? null : st.firstIndex + st.pos;
    const text = i !== null && n > 1 ? `${fileName(cur)}, ${i} of ${n}` : fileName(cur);
    if (text === lastAnnounce) return;
    lastAnnounce = text;
    liveEl.textContent = text;
  }

  /* ---------------- folder window ---------------- */

  /** List the folder around `p` (latest wins) and re-anchor on whatever file is
   *  shown when the answer lands — a held key may have moved on meanwhile.
   *  `fresh` only for the first listing of a file the viewer was SENT to
   *  (show): that one reads File Explorer's order for the folder; every
   *  refill and settle reuses the order the backend holds. */
  function refresh(p: string, wantAnnounce: boolean, fresh = false): void {
    if (listBusy) {
      listQueued = { p, wantAnnounce };
      return;
    }
    const my = ++listGen;
    listBusy = true;
    /** Taken when the call settles: a queued request is newer than this one. */
    const takeQueued = (): { p: string; wantAnnounce: boolean } | null => {
      const q = listQueued;
      listQueued = null;
      return q;
    };
    ipc.listSiblings(p, WINDOW_RADIUS, fresh).then(
      (w) => {
        if (disposed || my !== listGen) return;
        listBusy = false;
        const q = takeQueued();
        const fresh = fromWindow(p, w);
        const i = fresh.list.indexOf(cur);
        if (i < 0) {
          // Moved past this window while it was in flight: ask around the file
          // on screen instead (that window always contains it) — which is what
          // a queued request already is, or is newer than.
          if (q) refresh(q.p, q.wantAnnounce);
          else refresh(cur, wantAnnounce);
          return;
        }
        // Still a true listing, re-anchored on the file on screen: use it,
        // then run what was queued (applyPending may start a call first; the
        // queued one then waits its turn behind it, never beside it).
        listFailed = false;
        st = { ...fresh, pos: i };
        paintNav();
        if (wantAnnounce && p === cur) announce();
        applyPending(p === cur);
        // A queued request for the very file this answer was listed around
        // (a settle that fired while an early refill was in flight) would read
        // the whole folder again only to name the position: the answer is at
        // most one dwell old, so announce from it instead. `p === cur` is asked
        // AFTER applyPending, which may have stepped on.
        if (q && q.p === p && p === cur) {
          if (q.wantAnnounce) announce();
        } else if (q) refresh(q.p, q.wantAnnounce);
      },
      () => {
        if (disposed || my !== listGen) return;
        listBusy = false;
        const q = takeQueued();
        if (q) {
          // Superseded: this failure may be the folder show() just left, so
          // it says nothing about the file on screen. The queued call decides.
          refresh(q.p, q.wantAnnounce);
          return;
        }
        pendingDir = null;
        // The file stays shown; a sibling failure is not an error the user
        // caused, so no toast. Only a folder we never read turns the arrows off.
        if (st === null) {
          listFailed = true;
          paintNav();
        }
      },
    );
  }

  /** `centred`: the window that just landed was listed around the file on
   *  screen (not an older prefetch the held key has since outrun). */
  function applyPending(centred: boolean): void {
    if (pendingDir === null || st === null) return;
    const d = pendingDir;
    const r = pendingRepeat;
    pendingDir = null;
    if (busy || !canStep(st, d)) return;
    const n = step(st, d);
    if (n === null) {
      // A window centred on an OLDER file whose edge the key has reached: keep
      // the direction and ask around the file on screen — that answer either
      // moves or lands in the branch below, so this cannot loop.
      if (!centred) {
        pendingDir = d;
        pendingRepeat = r;
        refresh(cur, false);
      }
      // Centred and still stuck (a vanished file at a partial window's edge):
      // drop it. Asking again would only get the same answer.
      return;
    }
    goTo(n, d, r);
  }

  /* ---------------- stepping ---------------- */

  function scheduleSettle(ms: number): void {
    window.clearTimeout(dwellTimer);
    dwellTimer = undefined;
    if (ms <= 0) settle();
    else dwellTimer = window.setTimeout(settle, ms);
  }

  /** The dwell elapsed on `cur`: load it, name the window after it, and
   *  re-list its folder (files added or removed meanwhile). */
  function settle(): void {
    dwellTimer = undefined;
    if (disposed) return;
    if (loadingPath !== cur) startLoad(cur);
    setTitle(cur);
    refresh(cur, true);
  }

  function startLoad(p: string): void {
    loadingPath = p;
    shownState = null;
    loader.load(p);
  }

  function goTo(n: StepState, dir: -1 | 1, repeat: boolean): void {
    st = n;
    cur = n.list[n.pos]!;
    gen++;
    // The file we were loading is no longer wanted; nothing it reports paints.
    loadingPath = null;
    paintName();
    paintNav();
    const target = elementFor(fileExt(cur));
    // The <video> is released on every step. An <img> stays up only when the
    // next file is a picture too (no black flash between photos), the PDF
    // strip only when the next file is a PDF too (it opens in place).
    releaseVideo();
    if (target !== "img") releaseImg();
    if (target !== "pdf") closePdf();
    setStatus(null);
    const now = performance.now();
    const burst = now - lastStepAt < DWELL_MS.burst;
    lastStepAt = now;
    scheduleSettle(
      repeat ? DWELL_MS.repeat : target === "img" ? DWELL_MS.image : burst ? DWELL_MS.burst : DWELL_MS.media,
    );
    if (!listBusy && nearEdge(n, dir, PREFETCH_MARGIN)) refresh(cur, false);
  }

  function userStep(dir: -1 | 1, repeat: boolean): void {
    if (disposed || busy || st === null) return;
    if (!canStep(st, dir)) return;
    const n = step(st, dir);
    if (n === null) {
      // The window's edge, not the folder's: hold this one direction until the
      // next window lands (a refill already in flight will carry it).
      pendingDir = dir;
      pendingRepeat = repeat;
      if (!listBusy) refresh(cur, false);
      return;
    }
    pendingDir = null;
    goTo(n, dir, repeat);
  }

  function show(p: string): void {
    if (disposed) return;
    gen++;
    cur = p;
    st = null;
    listFailed = false;
    pendingDir = null;
    lastAnnounce = "";
    window.clearTimeout(dwellTimer);
    dwellTimer = undefined;
    paintName();
    paintNav();
    releaseVideo();
    const target = elementFor(fileExt(p));
    if (target !== "img") releaseImg();
    if (target !== "pdf") closePdf();
    setStatus(null);
    setTitle(p);
    // No dwell for a file the user opened: it loads now.
    startLoad(p);
    // An Explorer open never queues behind the previous folder's listing,
    // which can hang on a network share: abandon it (its handler drops a
    // stale generation) and list the new folder now.
    listGen++;
    listBusy = false;
    listQueued = null;
    refresh(p, true, true);
  }

  /* ---------------- playback ---------------- */

  let playShows: "play" | "pause" | null = null;
  function paintPlay(): void {
    const want = hasMedia() && !video.paused ? "pause" : "play";
    if (playShows === want) return;
    playShows = want;
    playBtn.innerHTML = icon(want);
    const label = want === "pause" ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", label);
    playBtn.title = withChord(label, "playPause");
  }

  let lastTimeText = "";
  let lastPct = -1;
  let readoutDirty = false;
  function paintReadout(): void {
    readoutDirty = false;
    const d = lengthOf();
    const t = hasMedia() ? playhead() : 0;
    // m:ss, not a frame timecode: the viewer never learns a frame rate, and a
    // player readout does not want one.
    const text = hasMedia() ? `${formatDuration(Math.floor(t))} / ${formatDuration(Math.floor(d))}` : "";
    if (text !== lastTimeText) {
      lastTimeText = text;
      timeEl.textContent = text;
    }
    const pct = d > 0 ? Math.round(clamp(t / d, 0, 1) * 1000) / 10 : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      fillEl.style.setProperty("width", `${pct}%`);
      knobEl.style.setProperty("left", `${pct}%`);
      seekEl.setAttribute("aria-valuenow", String(pct));
    }
  }

  function togglePlay(): void {
    if (!hasMedia()) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }

  /**
   * The editor's fullscreen seek, mirrored (theater.ts → engine.seek →
   * scheduler.activate): every call asks the element for the new position
   * unless it is within 10 ms of it already, and the bar and the clock show
   * the asked position at once (`asked`, read by playhead()) until the seek
   * lands — so the knob sits under the cursor however long decoding takes.
   */
  function seekTo(t: number): void {
    if (!hasMedia()) return;
    noteUserSeek();
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) {
      // A reload of this source is loading (no length yet, the old one held):
      // the position is not dropped. It is what the knob shows (`asked`) and
      // where the reload goes once its metadata is in (latest wins).
      if (swapHold !== null && swapHold.d > 0) {
        const held = clamp(t, 0, swapHold.d);
        asked = held;
        goodTime = held;
        paintReadout();
        if (damage !== null) paintCover();
      }
      return;
    }
    const target = clamp(t, 0, d);
    goodTime = target;
    if (Math.abs(video.currentTime - target) > SAME_POSITION_S) {
      asked = target;
      video.currentTime = target;
    } else if (!video.seeking) {
      // Already there: nothing asked, the element's time is the position.
      asked = null;
    }
    paintReadout();
    if (damage !== null) paintCover();
  }

  /* ---------------- monitor volume ---------------- */

  const volume = createMonitorVolume(
    (level) => {
      video.volume = level;
    },
    (e) =>
      toast.error("Couldn't save your settings.", {
        detail: describeError(e),
        op: "Settings",
        title: "Monitor volume",
      }),
  );
  let muteShows: boolean | null = null;
  const reflectVolume = (s: MonitorVolumeState): void => {
    const muted = s.level <= 0;
    if (muteShows !== muted) {
      muteShows = muted;
      muteBtn.innerHTML = icon(muted ? "mute" : "volume");
    }
    if (document.activeElement !== volSlider) volSlider.value = String(s.level);
  };
  reflectVolume(volume.get());
  const unVolume = volume.subscribe(reflectVolume);
  // A level changed in the last 300 ms before the window closes must still land.
  const unregisterClose = registerCloseTask(() => volume.flush());

  /* ---------------- fullscreen ---------------- */

  let fsWanted = false;
  const fs = elementFullscreen(el, {
    stillWanted: () => fsWanted,
    // The OS Esc left element fullscreen: stand down with it.
    onLost: () => {
      fsWanted = false;
      fs.release();
      syncFs();
    },
  });
  let fsShows: boolean | null = null;
  function paintFs(force = false): void {
    if (!force && fsShows === fsWanted) return;
    fsShows = fsWanted;
    fsBtn.innerHTML = icon(fsWanted ? "fullscreenExit" : "fullscreen");
    const label = fsWanted ? "Exit fullscreen" : "Fullscreen";
    fsBtn.setAttribute("aria-label", label);
    fsBtn.title = withChord(label, "fullscreen");
  }
  function syncFs(): void {
    el.classList.toggle("viewer--fullscreen", fsWanted);
    paintFs();
    syncAutoHide();
  }
  function toggleFs(): void {
    if (disposed) return;
    fsWanted = !fsWanted;
    if (fsWanted) fs.request();
    else fs.release();
    syncFs();
  }

  /* ---------------- auto-hide ---------------- */

  // ONE timer, armed only while something plays or fullscreen is wanted.
  // Activity (pointermove at 60-120 Hz, keys, focus) only stamps a time; the
  // timer re-arms itself for the remainder, so a moving mouse costs a clock
  // read per event, not a clearTimeout/setTimeout pair.
  let hideTimer: number | undefined;
  let hidden = false;
  let lastActivity = 0;
  let scrubbing = false;

  // Never over a PDF, fullscreen included: a reader's mouse rests while they
  // read, and the page indicator and scrubber are what they read by.
  const wantsAutoHide = (): boolean =>
    !disposed && !scrubbing && pdf === null && (fsWanted || (hasMedia() && !video.paused));

  const menuOpen = (): boolean =>
    document.querySelector<HTMLElement>(".ctx-menu")?.style.display === "block";

  /** The pointer rests on the chrome, or keyboard focus is on one of its
   *  controls. Fading it then would take the next click away from the button
   *  under the pointer — the chrome goes `pointer-events: none`, so the click
   *  lands on the video and pauses it — and would dismiss the damage pill's
   *  tooltip as it appears. :focus-visible, not :focus-within: a button keeps
   *  focus after a mouse click, which must not hold the chrome up for good. */
  const chromeHeld = (): boolean => el.querySelector(CHROME_HELD) !== null;

  function setHidden(v: boolean): void {
    if (v === hidden) return;
    hidden = v;
    el.classList.toggle("viewer--chrome-hidden", v);
    if (!v && readoutDirty) paintReadout();
  }

  function onHideTimer(): void {
    hideTimer = undefined;
    if (!wantsAutoHide()) return;
    // Outside fullscreen the "…" menu lives on document.body (ui/menu.ts), so
    // a pointer over it never reaches `el`: while it is open, count it as
    // activity rather than fade the bar out from under it. Asked only here,
    // at timer fire, so it costs one lookup per interval while already
    // playing — nothing when idle.
    if (menuOpen() || chromeHeld()) lastActivity = performance.now();
    const idle = performance.now() - lastActivity;
    if (idle < AUTO_HIDE_MS) {
      hideTimer = window.setTimeout(onHideTimer, AUTO_HIDE_MS - idle);
      return;
    }
    setHidden(true);
  }

  /** Arm or disarm after a state change (play/pause, fullscreen, scrub). */
  function syncAutoHide(): void {
    if (!wantsAutoHide()) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
      setHidden(false);
      return;
    }
    if (hideTimer === undefined && !hidden) {
      lastActivity = performance.now();
      hideTimer = window.setTimeout(onHideTimer, AUTO_HIDE_MS);
    }
  }

  function activity(): void {
    lastActivity = performance.now();
    if (hidden) setHidden(false);
    if (hideTimer === undefined && wantsAutoHide()) {
      hideTimer = window.setTimeout(onHideTimer, AUTO_HIDE_MS);
    }
  }

  el.addEventListener("pointermove", activity);
  el.addEventListener("pointerdown", activity);
  el.addEventListener("focusin", activity);
  const onAnyKey = (): void => activity();
  window.addEventListener("keydown", onAnyKey);

  /* ---------------- chrome wiring ---------------- */

  function back(): void {
    if (disposed || busy) return;
    navigate({ view: "home" });
  }

  function openAsProject(): void {
    if (disposed || busy) return;
    busy = true;
    paintNav();
    const myGen = gen;
    const target = cur;
    // On the open chain: two project creations never interleave. An Explorer
    // open that arrived FIRST has already run show() (gen moved) and this task
    // creates nothing; one that arrives after it meets the editor's own gate.
    let handedOff = false;
    runOnOpenChain(async () => {
      if (disposed || myGen !== gen) return;
      // Only once the target itself is loading. Inside a step's dwell the
      // loader still holds the PREVIOUS file's job, and handing that off would
      // leave it running for nobody (dispose() never cancels a handed-off job).
      // A PDF has no job to hand off: the editor opens the file itself.
      if (loadingPath === target && elementFor(fileExt(target)) !== "pdf") {
        handedOff = true;
        await loader.handOff();
      }
      if (disposed || myGen !== gen) return;
      const p = await openMediaAsProject(target);
      if (disposed || myGen !== gen) {
        await ipc.deleteProject(p).catch(() => {});
        return;
      }
      leavingForProject = true;
      navigate({ view: "editor", projectPath: p, temp: true, returnTo: target });
    })
      .catch((e) => {
        // A protected PDF is not a failure: it stays here, in the viewer.
        if (e instanceof PdfProtectedError) toast.info(e.message);
        else toast.error(describeError(e));
        // A failed open must hand the file back to the loader (its contract:
        // load() again). The hand-off may have canceled the job behind a
        // "Preparing" without saying so, and it leaves the editor's CLAIM on
        // this file in place — so a "Prepare preview" or a failed direct
        // attempt afterwards would start a job the loader believes the editor
        // owns, and dispose() would leave it running for nobody. Only a
        // settled picture or video (not a direct attempt) is left alone
        // rather than restarted from 0: the one job a settled video can still
        // start is a repair, and the loader withdraws the claim when a refusal
        // starts one. Not the instant copy of a damaged file while its full
        // repair runs: that job is under the claim (or the hand-off canceled
        // it), and only a fresh load re-plans it as the viewer's own. A
        // failure card has nothing to lose.
        if (
          handedOff &&
          !disposed &&
          myGen === gen &&
          loadingPath === target &&
          shownState !== "failed" &&
          !(shownState === "ready" && !tryingDirect && damage?.phase !== "repairing")
        ) {
          startLoad(target);
        }
      })
      .finally(() => {
        busy = false;
        if (!disposed) paintNav();
      });
  }

  // Every button blurs after a click: a focused button would make Space a
  // native activation on top of the play/pause chord.
  backBtn.addEventListener("click", () => {
    backBtn.blur();
    back();
  });
  prevBtn.addEventListener("click", () => {
    prevBtn.blur();
    userStep(-1, false);
  });
  nextBtn.addEventListener("click", () => {
    nextBtn.blur();
    userStep(1, false);
  });
  fsBtn.addEventListener("click", () => {
    fsBtn.blur();
    toggleFs();
  });
  /** The More menu's rows. ONE list for the button and for a right-click on
   *  the stage, so the two can never offer different things. */
  const moreItems = (): MenuItem[] => [
    { label: "Open as project", disabled: busy, onSelect: openAsProject },
    {
      label: "Show in folder",
      onSelect: () =>
        void revealInFolder(cur).catch((e) => toast.error(`Couldn't show this file in its folder: ${describeError(e)}`)),
    },
  ];
  moreBtn.addEventListener("click", () => {
    const r = moreBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, moreItems());
    // After showMenu has recorded the opener: a keyboard dismissal still hands
    // focus back here, a mouse user is left with nothing focused.
    moreBtn.blur();
  });
  // A right-click anywhere on the stage (the picture, a PDF's pages, the
  // audio card, a status card) opens the same menu at the pointer. Not over
  // the bars: they are controls, and a right-click there asks for nothing.
  stage.addEventListener("contextmenu", (e) => {
    // A menu of its own further in (the PDF rail's) has already answered.
    if (e.defaultPrevented) return;
    // An editable field (Find, a PDF's password) keeps the native menu, as
    // everywhere in the app (main.ts).
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable === true) return;
    e.preventDefault();
    const items = moreItems();
    // Text selected on a PDF's page: the app has no native menu to copy it
    // from, so the row goes first, where a native menu has it. Read now: the
    // menu takes focus, and the text must be what was selected at the click.
    const sel = window.getSelection?.() ?? null;
    const picked = sel !== null && sel.anchorNode !== null && stage.contains(sel.anchorNode) ? sel.toString() : "";
    if (picked.trim() !== "") {
      items.unshift({
        label: "Copy",
        onSelect: () => {
          const copied = navigator.clipboard?.writeText(picked) ?? Promise.reject(new Error("no clipboard"));
          void copied.catch(() => toast.error("Couldn't copy the text"));
        },
      });
    }
    showMenu(e.clientX, e.clientY, items);
  });
  playBtn.addEventListener("click", () => {
    playBtn.blur();
    togglePlay();
  });
  muteBtn.addEventListener("click", () => {
    muteBtn.blur();
    volume.toggleMute();
  });

  // Volume drag holds the chrome up (the bar must not go pointer-events:none
  // under a held thumb) and gives the arrows back when it ends.
  volSlider.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    scrubbing = true;
    syncAutoHide();
  });
  const endVolDrag = (): void => {
    volSlider.blur();
    if (!scrubbing) return;
    scrubbing = false;
    syncAutoHide();
  };
  volSlider.addEventListener("pointerup", endVolDrag);
  volSlider.addEventListener("pointercancel", endVolDrag);
  volSlider.addEventListener("input", () => volume.setLevel(Number(volSlider.value)));

  // Seek: down + every move while held, pointer capture keeps the drag alive
  // off the thin track (the theater bar's behaviour; ./scrub, shared with the
  // PDF page scrubber).
  // A heavy clip's DRAG (./seek-pacer) shows keyframes while it is fast;
  // its press, a click, and every light file seek exactly through seekTo.
  const seekDrag = bindScrub(seekEl, {
    enabled: hasMedia,
    at: (r) => {
      if (!hasMedia()) return;
      const press = pressAt;
      pressAt = false;
      // A heavy clip's drag with its scrub copy ready: the copy follows the
      // pointer and the main video is left alone until the pointer rests or
      // lets go (./scrub-copy).
      if (!press && Number.isFinite(video.duration) && video.duration > 0) {
        const t = clamp(r * video.duration, 0, video.duration);
        if (scrubCopy.move(t)) {
          noteUserSeek();
          asked = t;
          goodTime = t;
          paintReadout();
          if (damage !== null) paintCover();
          return;
        }
      }
      if (press || !pacer.heavy()) {
        seekTo(r * lengthOf());
        if (press && Number.isFinite(video.duration)) {
          const t = clamp(r * video.duration, 0, video.duration);
          pacer.begin(t);
          scrubCopy.press(t);
        }
        return;
      }
      noteUserSeek();
      const d = video.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      // The cursor's position is the one shown, whatever frame is decoding.
      asked = clamp(r * d, 0, d);
      goodTime = asked;
      pacer.move(asked);
      paintReadout();
      if (damage !== null) paintCover();
    },
    start: () => {
      pressAt = true;
      if (dev) dev.seeks.length = 0;
      askIndex();
      scrubbing = true;
      syncAutoHide();
    },
    end: () => {
      pressAt = false;
      // A copy-driven drag: one exact seek to where the pointer let go.
      scrubCopy.release();
      const held = pacer.holding();
      // A heavy drag: the exact frame where the pointer let go; once it
      // lands, the element's time is the position again.
      pacer.release();
      if (held) {
        if (!video.seeking) asked = null;
        paintReadout();
        if (damage !== null) paintCover();
      }
      scrubbing = false;
      syncAutoHide();
    },
  });

  // Click the picture to play/pause; double-click anywhere on the stage for
  // fullscreen (its two clicks toggle play twice: net unchanged).
  stage.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (t === video || audioCard.contains(t)) togglePlay();
  });
  stage.addEventListener("dblclick", (e) => {
    if (statusEl.contains(e.target as Node)) return;
    // A double-click on a PDF's page selects a word; on its rail or prompt it
    // is no request for fullscreen either.
    if (pdf?.owns(e.target as Node)) return;
    toggleFs();
  });

  /* ---------------- keyboard ---------------- */

  const keys = new ShortcutManager("viewer");
  keys.setSuppressed(() => !!document.querySelector(".modal-backdrop"));
  keys.on("prevFile", (e) => userStep(-1, e.repeat));
  keys.on("nextFile", (e) => userStep(1, e.repeat));
  // From playhead(), not the element: presses made while a seek decodes add up.
  keys.on("seekBack", () => seekTo(playhead() - SEEK_S));
  keys.on("seekFwd", () => seekTo(playhead() + SEEK_S));
  keys.on("goStart", () => (pdf ? pdf.goPage("first") : seekTo(0)));
  keys.on("goEnd", () => (pdf ? pdf.goPage("last") : seekTo(lengthOf())));
  keys.on("fullscreen", () => toggleFs());
  keys.on("goHome", () => back());
  keys.setBindings(settingsStore.get().shortcuts);
  keys.attach();

  /** The chords whose meaning depends on what is shown, (re)bound whenever
   *  the PDF mode comes or goes. ShortcutManager preventDefault()s every chord
   *  that has a handler, so a handler that would do nothing must not exist:
   *  - find and the zoom keys exist only over a PDF; on a picture or a video
   *    their chords fall through untouched;
   *  - Play / Pause (Space) pages the strip down over a PDF, as Space does
   *    in any reader (Shift+Space, up, is onPdfShiftSpace below) — never a
   *    dead key that stops it scrolling. */
  function bindModeKeys(): void {
    if (pdf !== null) {
      keys.on("playPause", () => pdf?.scrollPage(1));
      keys.on("find", () => pdf?.find());
      keys.on("imgZoomIn", () => pdf?.zoom("in"));
      keys.on("imgZoomOut", () => pdf?.zoom("out"));
      keys.on("imgZoomFit", () => pdf?.zoom("fit"));
      keys.on("imgZoom100", () => pdf?.zoom("100"));
    } else {
      keys.on("playPause", () => togglePlay());
      keys.off("find");
      keys.off("imgZoomIn");
      keys.off("imgZoomOut");
      keys.off("imgZoomFit");
      keys.off("imgZoom100");
    }
  }
  bindModeKeys();

  // Shift+Space is no chord of Play / Pause, so the manager never sees it:
  // over a PDF it pages the strip up wherever focus is (not only with the
  // strip focused). After the manager's listener: a binding the user gave
  // Shift+Space has already claimed the press (defaultPrevented).
  const onPdfShiftSpace = (e: KeyboardEvent): void => {
    if (pdf === null || e.key !== " " || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.defaultPrevented || isTypingTarget(e.target) || shortcutsBlocked()) return;
    if (document.querySelector(".modal-backdrop")) return;
    e.preventDefault();
    // Once per press, as Space itself (Play / Pause does not repeat).
    if (!e.repeat) pdf.scrollPage(-1);
  };
  window.addEventListener("keydown", onPdfShiftSpace);
  const unSettings = settingsStore.subscribe((s, prev) => {
    if (s.shortcuts === prev.shortcuts) return;
    keys.setBindings(s.shortcuts);
    paintTitles();
    pdf?.retitle();
  });

  /* ---------------- go ---------------- */

  paintTitles();
  show(path);

  return {
    show,
    current: () => cur,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      closeMenu();
      keys.detach();
      window.removeEventListener("keydown", onPdfShiftSpace);
      unSettings();
      window.removeEventListener("keydown", onAnyKey);
      loader.dispose();
      fsWanted = false;
      fs.dispose();
      closePdf();
      window.clearTimeout(dwellTimer);
      window.clearTimeout(hideTimer);
      window.clearTimeout(directTimer);
      releaseVideo();
      scrubCopy.dispose();
      releaseImg();
      unVolume();
      volume.dispose();
      unregisterClose();
      // Left for good (Back, a route elsewhere, the window closing): the
      // backend's held folder order goes too. Not for "Open as project",
      // whose exit returns here and steps in that same order.
      if (!leavingForProject) void ipc.forgetSiblingOrder().catch(() => {});
      void setWindowTitle("Taroting").catch(() => {});
      if (dev && devWin.__tarotingViewerDev === dev) delete devWin.__tarotingViewerDev;
    },
  };
}
