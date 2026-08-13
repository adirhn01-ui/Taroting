// Preview stage: a letterboxed project canvas with a dynamic stack of media
// layer SETS — one per video track. Each set owns an A/B <video> pair (double-
// buffering across cuts), one <img> for stills, and one "gen" <div> for
// generated media (solid / text). Sets are z-ordered so index 0 paints on top
// (z = count - i); the ".stage-overlay" sits above them at var(--z-stage-overlay)
// (see the z scale in tokens.css). A status overlay sits above everything.

import type { LayerBoxes } from "./transforms";

/** One video track's worth of pooled preview elements, wrapped in the
 *  pos/rot/crop transform tower. All four slots share the same layer set; only
 *  one is displayed at a time (the scheduler owns show/hide). */
export interface LayerSet {
  /** the wrapper that carries z-index for the whole set */
  el: HTMLElement;
  videoA: LayerBoxes & { media: HTMLVideoElement };
  videoB: LayerBoxes & { media: HTMLVideoElement };
  image: LayerBoxes & { media: HTMLImageElement };
  gen: LayerBoxes & { media: HTMLElement };
}

export interface Stage {
  root: HTMLElement;
  canvas: HTMLElement;
  /** one entry per video track, index-aligned with videoTracks(project);
   *  index 0 is the TOPMOST layer (highest z-index). */
  layers: LayerSet[];
  overlay: HTMLElement;
  /** px per project-canvas px */
  scale: number;
  /** (re)build/park layer sets so exactly n are live and mounted */
  syncLayerCount(n: number): void;
  /** recompute fit from the current timeline dims (call when they change) */
  refit(): void;
  dispose(): void;
}

function buildLayer(tag: "video" | "img" | "div"): LayerBoxes {
  const pos = document.createElement("div");
  pos.className = "stage-layer__pos";
  const rot = document.createElement("div");
  rot.className = "stage-layer__rot";
  const crop = document.createElement("div");
  crop.className = "stage-layer__crop";
  const media = document.createElement(tag);
  media.className = "stage-layer__media";
  if (media instanceof HTMLVideoElement) {
    media.playsInline = true;
    media.preload = "auto";
    media.crossOrigin = "anonymous";
  }
  if (media instanceof HTMLImageElement) {
    media.draggable = false;
  }
  crop.appendChild(media);
  rot.appendChild(crop);
  pos.appendChild(rot);
  return { pos, rot, crop, media };
}

function buildLayerSet(): LayerSet {
  const el = document.createElement("div");
  el.className = "stage-layer-set";
  const videoA = buildLayer("video") as LayerSet["videoA"];
  const videoB = buildLayer("video") as LayerSet["videoB"];
  const image = buildLayer("img") as LayerSet["image"];
  const gen = buildLayer("div") as LayerSet["gen"];
  gen.media.className = "stage-layer__media stage-layer__gen";
  el.append(videoA.pos, videoB.pos, image.pos, gen.pos);
  return { el, videoA, videoB, image, gen };
}

export function mountStage(
  host: HTMLElement,
  getTimelineDims: () => { width: number; height: number },
  onResize: () => void,
): Stage {
  host.innerHTML = `
    <div class="preview no-select">
      <div class="preview__canvas" tabindex="-1"></div>
    </div>
  `;
  const root = host.querySelector<HTMLElement>(".preview")!;
  const canvas = host.querySelector<HTMLElement>(".preview__canvas")!;

  const overlay = document.createElement("div");
  overlay.className = "preview__overlay";

  // a parked pool so growing/shrinking the layer count never destroys elements
  // (createMediaElementSource is one-shot per <video>, so sets must persist).
  const pool: LayerSet[] = [];
  // How many sets are currently mounted, in order. -1 = nothing mounted yet.
  let liveCount = -1;

  const stage: Stage = {
    root,
    canvas,
    layers: [],
    overlay,
    scale: 1,
    syncLayerCount(n: number): void {
      // activate() calls this on every seek — i.e. every scrub pointermove.
      // The pool is stable and mounted in index order and nothing else
      // re-parents these sets, so an unchanged n means the DOM is already
      // right; re-attaching would needlessly tear down the <video> elements'
      // layout and compositing layers.
      if (n === liveCount) return;
      liveCount = n;
      while (pool.length < n) pool.push(buildLayerSet());
      // detach every set, then (re)attach the first n in z-order.
      for (const set of pool) if (set.el.parentElement) set.el.remove();
      const live: LayerSet[] = [];
      for (let i = 0; i < n; i++) {
        const set = pool[i]!;
        set.el.style.zIndex = String(n - i); // index 0 paints on top
        canvas.appendChild(set.el);
        live.push(set);
      }
      // Keep the overlay a child of the canvas after the re-attach churn.
      // DOM order does NOT decide its paint order — the layer sets carry
      // positive z-indexes, which beat document order among positioned
      // siblings whatever the append sequence. What keeps the status scrim
      // above every layer is --z-stage-status on .preview__overlay.
      canvas.appendChild(overlay);
      stage.layers = live;
    },
    refit(): void {
      fit();
    },
    dispose() {
      observer.disconnect();
      for (const set of pool) {
        set.videoA.media.src = "";
        set.videoB.media.src = "";
      }
    },
  };

  // start with a single layer set (today's default cost) + overlay on top
  stage.syncLayerCount(1);

  function fit(): void {
    const dims = getTimelineDims();
    const box = root.getBoundingClientRect();
    // In theater/fullscreen the stage is a plain player: no breathing pad, so the
    // video letterboxes edge-to-edge against pure-black bars. Windowed keeps the
    // 24px inset so the canvas doesn't kiss the panel borders.
    const pad = root.closest(".editor__preview.theater") ? 0 : 24;
    const availW = Math.max(80, box.width - pad * 2);
    const availH = Math.max(60, box.height - pad * 2);
    const scale = Math.min(availW / dims.width, availH / dims.height);
    stage.scale = scale;
    canvas.style.width = `${Math.round(dims.width * scale)}px`;
    canvas.style.height = `${Math.round(dims.height * scale)}px`;
    onResize();
  }

  const observer = new ResizeObserver(fit);
  observer.observe(root);
  fit();

  return stage;
}

export function setOverlay(stage: Stage, text: string | null): void {
  // Reached on every seek with `null`; skip the DOM write when nothing changed.
  const next = text ?? "";
  if (stage.overlay.textContent === next) return;
  stage.overlay.textContent = next;
  stage.overlay.classList.toggle("active", text !== null);
}
