// The editor's scrub copies, per LAYER: one muted <video> per layer index that
// stands in for the layer's real element while a paused drag moves the
// playhead over a heavy clip.
//
// The rules:
//  - The copy lives INSIDE the shown slot's own crop box, after the real
//    element, so it takes the layer's pose, crop, rotation, opacity and
//    z-order from the boxes around it and paints over the real element. It
//    mirrors only the real element's own width, height and transform.
//  - It never writes to the real element and never seeks it: the real
//    element is seeked by the scheduler exactly as without a copy. It only
//    READS it (time, seeking, readyState) to know when the exact frame is up.
//  - One copy seek in flight, the newest target waiting; none within
//    SAME_POSITION_S of where the copy already is; a seek that does not land
//    within COPY_STALL_MS fails the file.
//  - A copy shows only a frame presented during THIS drag from THIS file (a
//    frame counts once the element is settled and two animation frames have
//    passed), only after the pointer has moved, and never while playing or in
//    a drag that began while playing.
//  - At rest or on release each shown copy waits for its real element to be
//    settled at the copy's last target (two animation frames later it hides),
//    CATCHUP_MAX_MS at the most. A move to a new position keeps it up; a
//    move that keeps the position does not.
//  - IDLE_RELEASE_MS after the last copy hid with nothing held, every copy
//    lets go of its file; a playing tick does so at once.
//
// Elements, timers and animation frames are injected, so vitest drives it with
// fakes.

import { CATCHUP_MAX_MS, COPY_STALL_MS, IDLE_RELEASE_MS, SAME_POSITION_S } from "./precheck";

/** The parts of a layer's video slot the copy needs (preview.ts's boxes). */
export interface SlotView {
  pos: HTMLElement;
  crop: HTMLElement;
  media: HTMLVideoElement;
}

export interface CopyTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

export interface CopyLayersDeps {
  /** A new copy element (muted, styled, not yet in the document). */
  createVideo(): HTMLVideoElement;
  /** A copy seek of `file` stalled: the file's copy is given up. */
  stalled(file: string, reason: string): void;
  /** A copy element of `file` could not play. */
  elementError(file: string, detail: string): void;
  timers?: CopyTimers;
  raf?: (fn: () => void) => void;
}

export interface CopyLayerSnapshot {
  idx: number;
  loaded: boolean;
  shown: boolean;
  src: string | null;
  copySeeks: number;
}

interface LayerCopy {
  readonly idx: number;
  readonly el: HTMLVideoElement;
  src: string | null;
  file: string | null;
  loaded: boolean;
  /** The layer qualified on the last tick (a hidden layer never shows). */
  active: boolean;
  inflight: boolean;
  inflightDrag: number;
  inflightSrc: string | null;
  want: number | null;
  stall: number | undefined;
  presentedDrag: number;
  presentedSrc: string | null;
  shown: boolean;
  /** The last source time asked of this copy. */
  target: number;
  /** The real element of the slot the copy last stood in. */
  main: HTMLVideoElement | null;
  awaitingMain: boolean;
  caughtUp: boolean;
  catchSeq: number;
  catchCap: number | undefined;
  catchOff: (() => void) | null;
  poseW: string;
  poseH: string;
  poseT: string;
  copySeeks: number;
}

const browserTimers: CopyTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};
const browserRaf = (fn: () => void): void => void requestAnimationFrame(() => fn());

export class ScrubCopyLayers {
  private readonly d: CopyLayersDeps;
  private readonly timers: CopyTimers;
  private readonly raf: (fn: () => void) => void;
  private readonly layers: (LayerCopy | undefined)[] = [];

  /** Bumped by every press and every tick the pointer did not cause: a frame
   *  presented before it never shows. */
  private dragId = 0;
  private held = false;
  private moved = false;
  private playingAtPress = false;
  private playing = false;
  private idleTimer: number | undefined;
  private disposed = false;

  constructor(deps: CopyLayersDeps) {
    this.d = deps;
    this.timers = deps.timers ?? browserTimers;
    this.raf = deps.raf ?? browserRaf;
  }

  /* ---------------- the drag ---------------- */

  /** A pointer press: a new drag. */
  press(playingNow: boolean): void {
    if (this.disposed) return;
    this.dragId++;
    this.held = true;
    this.moved = false;
    this.playingAtPress = playingNow;
    this.clearIdle();
    for (const L of this.layers) if (L) this.cancelCatchup(L);
    this.paintAll();
  }

  /** The held pointer has moved the playhead (the press alone never shows). */
  setMoved(): void {
    if (this.moved) return;
    this.moved = true;
    this.paintAll();
  }

  /** A tick the pointer did not cause (a step, a key, an edit): every copy
   *  hides now and the next show needs a newly presented frame. */
  interrupt(): void {
    this.dragId++;
    for (const L of this.layers) if (L) this.cancelCatchup(L);
    this.paintAll();
  }

  /** The pointer let go: each shown copy waits for its real element. */
  release(): void {
    this.held = false;
    for (const L of this.layers) {
      if (!L) continue;
      if (L.shown) this.startCatchup(L);
    }
    this.paintAll();
  }

  /** The held pointer rested: the same wait as a release, still held. */
  rest(): void {
    for (const L of this.layers) if (L && L.shown && !L.awaitingMain) this.startCatchup(L);
    this.paintAll();
  }

  /** The engine's play state. A playing tick lets go of every copy. */
  setPlaying(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    if (on) this.unloadAll();
  }

  /* ---------------- per layer ---------------- */

  /**
   * Layer `idx` qualifies on this pointer-caused tick: stand in `slot`, show
   * `url` (the copy of `file`), aim at `srcT`.
   */
  follow(idx: number, slot: SlotView, url: string, file: string, srcT: number): void {
    if (this.disposed) return;
    const L = this.place(idx, slot, url, file);
    L.active = true;
    this.mirror(L, slot.media);
    const prev = L.target;
    L.target = srcT;
    // A new position keeps the copy up (cancels the wait for the real
    // element). The same position does not: the real element was already
    // asked for that frame, and a caught-up copy must not cover it again.
    if (this.moved && (L.awaitingMain || L.caughtUp) && Math.abs(srcT - prev) > SAME_POSITION_S) this.cancelCatchup(L);
    if (!this.playing && !this.playingAtPress) this.aim(L, srcT);
    this.paint(L);
  }

  /** Load `url` into layer `idx`'s copy ahead of a press (no seek, no show). */
  preload(idx: number, slot: SlotView, url: string, file: string): void {
    if (this.disposed || this.playing) return;
    const L = this.place(idx, slot, url, file);
    this.mirror(L, slot.media);
    this.settleIdle();
  }

  /** Layer `idx` does not qualify now: its copy hides (the real element shows). */
  hide(idx: number): void {
    const L = this.layers[idx];
    if (!L) return;
    L.active = false;
    this.cancelCatchup(L);
    this.paint(L);
  }

  /** Every copy showing `url` lets go of it. */
  releaseUrl(url: string): void {
    for (const L of this.layers) if (L && L.src === url) this.unload(L);
  }

  unloadAll(): void {
    for (const L of this.layers) if (L) this.unload(L);
    this.clearIdle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.unloadAll();
    this.disposed = true;
    for (const L of this.layers) if (L) L.el.remove();
    this.layers.length = 0;
  }

  /** One past the highest layer index a copy was made for. */
  extent(): number {
    return this.layers.length;
  }

  /** How many copy elements exist. */
  count(): number {
    return this.layers.filter((L) => L !== undefined).length;
  }

  snapshot(): CopyLayerSnapshot[] {
    const out: CopyLayerSnapshot[] = [];
    for (const L of this.layers) {
      if (L) out.push({ idx: L.idx, loaded: L.loaded, shown: L.shown, src: L.src, copySeeks: L.copySeeks });
    }
    return out;
  }

  /** DEV / E2E: layer `idx`'s copy element, if made. */
  element(idx: number): HTMLVideoElement | null {
    return this.layers[idx]?.el ?? null;
  }

  /* ---------------- placement ---------------- */

  private place(idx: number, slot: SlotView, url: string, file: string): LayerCopy {
    const L = this.layers[idx] ?? this.make(idx);
    // Inside the shown slot's crop, after the real element: its pose, crop,
    // opacity and z-order are the layer's own.
    if (L.el.parentElement !== slot.crop) slot.crop.appendChild(L.el);
    L.main = slot.media;
    if (L.src !== url) {
      this.unload(L);
      L.src = url;
      L.file = file;
      L.el.src = url;
    }
    return L;
  }

  private mirror(L: LayerCopy, media: HTMLVideoElement): void {
    const s = media.style;
    const c = L.el.style;
    if (L.poseW !== s.width) c.width = L.poseW = s.width;
    if (L.poseH !== s.height) c.height = L.poseH = s.height;
    if (L.poseT !== s.transform) c.transform = L.poseT = s.transform;
  }

  private make(idx: number): LayerCopy {
    const el = this.d.createVideo();
    const L: LayerCopy = {
      idx,
      el,
      src: null,
      file: null,
      loaded: false,
      active: false,
      inflight: false,
      inflightDrag: -1,
      inflightSrc: null,
      want: null,
      stall: undefined,
      presentedDrag: -1,
      presentedSrc: null,
      shown: false,
      target: 0,
      main: null,
      awaitingMain: false,
      caughtUp: false,
      catchSeq: 0,
      catchCap: undefined,
      catchOff: null,
      poseW: "",
      poseH: "",
      poseT: "",
      copySeeks: 0,
    };
    this.layers[idx] = L;
    el.addEventListener("loadeddata", () => {
      if (L.src === null || el.getAttribute("src") !== L.src || L.loaded) return;
      L.loaded = true;
      if (L.want !== null) this.issue(L, L.want);
    });
    el.addEventListener("error", () => {
      // Letting go of the src fires one too: only the file we loaded counts.
      if (L.src === null || el.getAttribute("src") !== L.src || L.file === null) return;
      const file = L.file;
      const code = el.error?.code;
      this.unload(L);
      this.d.elementError(file, `media error ${code === undefined ? "?" : String(code)}`);
    });
    el.addEventListener("seeked", () => this.copySeeked(L));
    return L;
  }

  private unload(L: LayerCopy): void {
    this.timers.clearTimeout(L.stall);
    L.stall = undefined;
    this.cancelCatchup(L);
    L.inflight = false;
    L.want = null;
    L.loaded = false;
    L.src = null;
    L.file = null;
    L.presentedDrag = -1;
    L.presentedSrc = null;
    if (L.el.hasAttribute("src")) {
      L.el.removeAttribute("src");
      L.el.load();
    }
    this.paint(L);
  }

  /* ---------------- seeks ---------------- */

  private aim(L: LayerCopy, t: number): void {
    if (L.inflight || !L.loaded) {
      // Latest wins; a copy still loading takes it on `loadeddata`.
      L.want = t;
      return;
    }
    this.issue(L, t);
  }

  private issue(L: LayerCopy, t: number): void {
    const c = L.el;
    L.want = null;
    if (!c.seeking && Math.abs(c.currentTime - t) <= SAME_POSITION_S) {
      this.presentCheck(L, this.dragId, L.src);
      return;
    }
    L.inflight = true;
    L.inflightDrag = this.dragId;
    L.inflightSrc = L.src;
    c.currentTime = t;
    L.copySeeks++;
    this.timers.clearTimeout(L.stall);
    L.stall = this.timers.setTimeout(() => this.stalled(L), COPY_STALL_MS);
  }

  private stalled(L: LayerCopy): void {
    L.stall = undefined;
    if (!L.inflight || L.file === null) return;
    const file = L.file;
    this.unload(L);
    this.d.stalled(file, "a seek of the copy did not land (decode stall)");
  }

  private copySeeked(L: LayerCopy): void {
    if (!L.inflight || L.el.seeking) return;
    L.inflight = false;
    this.timers.clearTimeout(L.stall);
    L.stall = undefined;
    this.presentCheck(L, L.inflightDrag, L.inflightSrc);
    if (L.want !== null && L.loaded) this.issue(L, L.want);
  }

  /** The copy's frame counts for drag `drag` from `src` once the element is
   *  settled and two animation frames have passed. It is recorded with the
   *  drag and the src it was asked for: `paint` shows it only while both are
   *  still the current ones (the one place that rule lives). */
  private presentCheck(L: LayerCopy, drag: number, src: string | null): void {
    const c = L.el;
    if (src === null || c.seeking || c.readyState < 2) return;
    this.raf(() =>
      this.raf(() => {
        if (this.disposed || c.seeking) return;
        L.presentedDrag = drag;
        L.presentedSrc = src;
        this.paint(L);
      }),
    );
  }

  /* ---------------- catching up ---------------- */

  private startCatchup(L: LayerCopy): void {
    this.cancelCatchup(L);
    const m = L.main;
    if (m === null) return;
    L.awaitingMain = true;
    const seq = L.catchSeq;
    const target = L.target;
    const finish = (): void => {
      if (seq !== L.catchSeq || !L.awaitingMain) return;
      this.removeCatchup(L);
      L.awaitingMain = false;
      L.caughtUp = true;
      // The next show needs a frame presented after this one.
      L.presentedDrag = -1;
      this.paint(L);
    };
    const check = (): void => {
      if (seq !== L.catchSeq || !L.awaitingMain) return;
      if (m.seeking || m.readyState < 2 || Math.abs(m.currentTime - target) > SAME_POSITION_S) return;
      this.raf(() =>
        this.raf(() => {
          if (m.seeking) return;
          finish();
        }),
      );
    };
    m.addEventListener("seeked", check);
    m.addEventListener("loadeddata", check);
    L.catchOff = () => {
      m.removeEventListener("seeked", check);
      m.removeEventListener("loadeddata", check);
    };
    L.catchCap = this.timers.setTimeout(finish, CATCHUP_MAX_MS);
    check();
  }

  private removeCatchup(L: LayerCopy): void {
    const off = L.catchOff;
    L.catchOff = null;
    if (off) off();
    this.timers.clearTimeout(L.catchCap);
    L.catchCap = undefined;
  }

  private cancelCatchup(L: LayerCopy): void {
    L.catchSeq++;
    this.removeCatchup(L);
    L.awaitingMain = false;
    L.caughtUp = false;
  }

  /* ---------------- painting ---------------- */

  private paintAll(): void {
    for (const L of this.layers) if (L) this.paint(L);
    this.settleIdle();
  }

  private paint(L: LayerCopy): void {
    const on =
      !this.disposed &&
      L.active &&
      L.loaded &&
      L.src !== null &&
      this.moved &&
      L.presentedDrag === this.dragId &&
      L.presentedSrc === L.src &&
      !L.caughtUp &&
      (this.held || L.awaitingMain) &&
      !this.playingAtPress &&
      !this.playing;
    if (on === L.shown) return;
    L.shown = on;
    L.el.style.display = on ? "block" : "none";
    this.settleIdle();
  }

  /* ---------------- idle ---------------- */

  private clearIdle(): void {
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private settleIdle(): void {
    if (this.disposed) return;
    let loaded = false;
    for (const L of this.layers) {
      if (!L) continue;
      if (L.shown) {
        this.clearIdle();
        return;
      }
      if (L.src !== null) loaded = true;
    }
    if (this.held || !loaded) {
      this.clearIdle();
      return;
    }
    if (this.idleTimer === undefined) {
      this.idleTimer = this.timers.setTimeout(() => {
        this.idleTimer = undefined;
        this.unloadAll();
      }, IDLE_RELEASE_MS);
    }
  }
}
