// The folder viewer: one file at a time, arrows through its folder, no project.
// Lazy route chunk, never prefetched; imports only main-chunk modules plus
// ./loader and ./stepper (never anything under src/editor/ — that would drag
// the editor chunk into this one).
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
import { describeError, ipc, revealInFolder, setWindowTitle } from "../core/ipc";
import { createMonitorVolume } from "../core/monitor-volume";
import type { MonitorVolumeState } from "../core/monitor-volume";
import { navigate } from "../core/nav";
import { openMediaAsProject, runOnOpenChain } from "../core/open-media";
import { settingsStore } from "../core/session";
import { ShortcutManager, normalizeChord } from "../core/shortcuts";
import type { ActionId } from "../core/types";
import { elementFullscreen } from "../ui/fullscreen";
import { icon } from "../ui/icons";
import { closeMenu, showMenu } from "../ui/menu";
import { toast } from "../ui/toast";
import { DIRECT_TIMEOUT_MS, createSourceLoader } from "./loader";
import type { LoadState } from "./loader";
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

/** Idle time before the chrome and cursor fade while something plays (ms). */
const AUTO_HIDE_MS = 2500;
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

// Static markup only: every file name reaches the DOM through textContent /
// properties, never through this string. No style attributes (packaged CSP).
const TEMPLATE = `
  <div class="viewer__stage" id="vw-stage">
    <img class="viewer__img" id="vw-img" decoding="async" draggable="false" alt="" hidden />
    <video class="viewer__video" id="vw-video" playsinline preload="auto" hidden></video>
    <div class="viewer__audio-card" id="vw-audio" hidden>${icon("music", 48)}<div class="viewer__audio-name"></div></div>
    <div class="viewer__status" id="vw-status" role="status" hidden><div class="viewer__status-text"></div></div>
  </div>
  <div class="viewer__top" id="vw-top">
    <button class="btn btn--ghost btn--icon viewer__chrome-btn" id="vw-back" aria-label="Back">${icon("chevronLeft")}</button>
    <div class="viewer__name" id="vw-name"></div>
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
  const audioCard = $("#vw-audio");
  const audioName = $(".viewer__audio-name");
  const statusEl = $("#vw-status");
  const statusText = $(".viewer__status-text");
  const backBtn = $<HTMLButtonElement>("#vw-back");
  const nameEl = $("#vw-name");
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

  const hasMedia = (): boolean => videoUrl !== null;

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
      }
    : null;
  if (dev) devWin.__tarotingViewerDev = dev;

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

  /* ---------------- media elements ---------------- */

  /** Empty the <video>: pause, drop the src, load() — the documented way to
   *  make the engine let go of the decoder (~130 MB for 4K) and the file handle
   *  (Explorer cannot rename or delete a file we still hold). */
  function releaseVideo(): void {
    tryingDirect = false;
    window.clearTimeout(directTimer);
    directTimer = undefined;
    if (videoUrl !== null || video.hasAttribute("src")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    videoUrl = null;
    video.hidden = true;
    audioCard.hidden = true;
    bar.hidden = true;
    scrubbing = false;
    paintPlay();
    syncAutoHide();
  }

  function releaseImg(): void {
    if (img.hasAttribute("src")) img.removeAttribute("src");
    imgUrl = null;
    img.hidden = true;
  }

  function showReady(s: Extract<LoadState, { state: "ready" }>): void {
    setStatus(null);
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
        loader.directFailed();
      }, DIRECT_TIMEOUT_MS);
    }
    paintReadout();
    // Autoplay; a refusal just leaves the paused glyph showing.
    void video.play().catch(() => {});
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
      case "ready":
        showReady(s);
        return;
      case "preparing":
        releaseVideo();
        releaseImg();
        setStatus(s.ratio === null ? "Preparing preview" : `Preparing preview ${Math.round(clamp(s.ratio, 0, 1) * 100)}%`);
        return;
      case "needsPrepare":
        releaseVideo();
        releaseImg();
        setStatus("This video needs a preview copy", { prepare: true });
        return;
      case "failed":
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
  video.addEventListener("error", () => {
    if (disposed || videoUrl === null || videoGen !== gen || video.getAttribute("src") !== videoUrl) return;
    if (tryingDirect) {
      tryingDirect = false;
      window.clearTimeout(directTimer);
      directTimer = undefined;
      loader.directFailed();
      return;
    }
    releaseVideo();
    setStatus("Can't show this file");
  });
  video.addEventListener("loadedmetadata", () => {
    if (videoGen !== gen) return;
    window.clearTimeout(directTimer);
    directTimer = undefined;
    paintReadout();
  });
  video.addEventListener("durationchange", () => {
    if (!hidden) paintReadout();
  });
  video.addEventListener("seeked", () => {
    if (!hidden) paintReadout();
  });
  video.addEventListener("timeupdate", () => {
    // Hidden chrome: remember, repaint once on reveal.
    if (hidden) readoutDirty = true;
    else paintReadout();
  });
  const onPlayState = (): void => {
    paintPlay();
    syncAutoHide();
  };
  video.addEventListener("play", onPlayState);
  video.addEventListener("pause", onPlayState);
  video.addEventListener("ended", onPlayState);

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
    // next file is a picture too (no black flash between photos).
    releaseVideo();
    if (target !== "img") releaseImg();
    setStatus(null);
    scheduleSettle(repeat ? DWELL_MS.repeat : target === "img" ? DWELL_MS.image : DWELL_MS.media);
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
    if (elementFor(fileExt(p)) !== "img") releaseImg();
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
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const t = hasMedia() ? video.currentTime || 0 : 0;
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

  function seekTo(t: number): void {
    if (!hasMedia()) return;
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    video.currentTime = clamp(t, 0, d);
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

  const wantsAutoHide = (): boolean =>
    !disposed && !scrubbing && (fsWanted || (hasMedia() && !video.paused));

  const menuOpen = (): boolean =>
    document.querySelector<HTMLElement>(".ctx-menu")?.style.display === "block";

  function setHidden(v: boolean): void {
    if (v === hidden) return;
    hidden = v;
    el.classList.toggle("viewer--chrome-hidden", v);
    if (!v && readoutDirty) paintReadout();
  }

  function onHideTimer(): void {
    hideTimer = undefined;
    if (!wantsAutoHide()) return;
    // The "…" menu lives on document.body (ui/menu.ts), so a pointer over it
    // never reaches `el`: while it is open, count it as activity rather than
    // fade the bar out from under it. Asked only here, at timer fire, so it
    // costs one lookup per interval while already playing — nothing when idle.
    if (menuOpen()) lastActivity = performance.now();
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
      if (loadingPath === target) {
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
        toast.error(describeError(e));
        // A failed open must hand the file back to the loader (its contract:
        // load() again). The hand-off may have canceled the job behind a
        // "Preparing" without saying so, and it leaves the editor's CLAIM on
        // this file in place — so a "Prepare preview" or a failed direct
        // attempt afterwards would start a job the loader believes the editor
        // owns, and dispose() would leave it running for nobody. Only a
        // settled picture or video (not a direct attempt) is left alone
        // rather than restarted from 0; a failure card has nothing to lose.
        if (
          handedOff &&
          !disposed &&
          myGen === gen &&
          loadingPath === target &&
          shownState !== "failed" &&
          !(shownState === "ready" && !tryingDirect)
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
  moreBtn.addEventListener("click", () => {
    const r = moreBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: "Open as project", disabled: busy, onSelect: openAsProject },
      {
        label: "Show in folder",
        onSelect: () =>
          void revealInFolder(cur).catch((e) => toast.error(`Couldn't show this file in its folder: ${describeError(e)}`)),
      },
    ]);
    // After showMenu has recorded the opener: a keyboard dismissal still hands
    // focus back here, a mouse user is left with nothing focused.
    moreBtn.blur();
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
  // off the thin track (the theater bar's behaviour).
  const seekFromX = (clientX: number): void => {
    const box = seekEl.getBoundingClientRect();
    if (box.width <= 0 || !hasMedia()) return;
    seekTo(((clientX - box.left) / box.width) * video.duration);
  };
  seekEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !hasMedia()) return;
    e.preventDefault();
    scrubbing = true;
    try {
      seekEl.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer (autotest): listeners still fire on the element */
    }
    seekFromX(e.clientX);
    syncAutoHide();
  });
  seekEl.addEventListener("pointermove", (e) => {
    if (scrubbing) seekFromX(e.clientX);
  });
  const endScrub = (e: PointerEvent): void => {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      seekEl.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    syncAutoHide();
  };
  seekEl.addEventListener("pointerup", endScrub);
  seekEl.addEventListener("pointercancel", endScrub);

  // Click the picture to play/pause; double-click anywhere on the stage for
  // fullscreen (its two clicks toggle play twice: net unchanged).
  stage.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (t === video || audioCard.contains(t)) togglePlay();
  });
  stage.addEventListener("dblclick", (e) => {
    if (statusEl.contains(e.target as Node)) return;
    toggleFs();
  });

  /* ---------------- keyboard ---------------- */

  const keys = new ShortcutManager("viewer");
  keys.setSuppressed(() => !!document.querySelector(".modal-backdrop"));
  keys.on("prevFile", (e) => userStep(-1, e.repeat));
  keys.on("nextFile", (e) => userStep(1, e.repeat));
  keys.on("seekBack", () => seekTo(video.currentTime - SEEK_S));
  keys.on("seekFwd", () => seekTo(video.currentTime + SEEK_S));
  keys.on("playPause", () => togglePlay());
  keys.on("goStart", () => seekTo(0));
  keys.on("goEnd", () => seekTo(video.duration));
  keys.on("fullscreen", () => toggleFs());
  keys.on("goHome", () => back());
  keys.setBindings(settingsStore.get().shortcuts);
  keys.attach();
  const unSettings = settingsStore.subscribe((s, prev) => {
    if (s.shortcuts === prev.shortcuts) return;
    keys.setBindings(s.shortcuts);
    paintTitles();
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
      unSettings();
      window.removeEventListener("keydown", onAnyKey);
      loader.dispose();
      fsWanted = false;
      fs.dispose();
      window.clearTimeout(dwellTimer);
      window.clearTimeout(hideTimer);
      window.clearTimeout(directTimer);
      releaseVideo();
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
