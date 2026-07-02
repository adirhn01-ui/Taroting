// Preview stage: a letterboxed project canvas with pooled media layers.
// Two <video> layers (A/B double-buffering across cuts), one <img> layer for
// stills, and a status overlay for media that is still being prepared.

import type { ProjectFile } from "../../core/types";
import type { LayerBoxes } from "./transforms";

export interface Stage {
  root: HTMLElement;
  canvas: HTMLElement;
  videoA: LayerBoxes & { media: HTMLVideoElement };
  videoB: LayerBoxes & { media: HTMLVideoElement };
  image: LayerBoxes & { media: HTMLImageElement };
  overlay: HTMLElement;
  /** px per project-canvas px */
  scale: number;
  dispose(): void;
}

function buildLayer(tag: "video" | "img"): LayerBoxes {
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

export function mountStage(host: HTMLElement, project: ProjectFile, onResize: () => void): Stage {
  host.innerHTML = `
    <div class="preview no-select">
      <div class="preview__canvas" tabindex="-1"></div>
    </div>
  `;
  const root = host.querySelector<HTMLElement>(".preview")!;
  const canvas = host.querySelector<HTMLElement>(".preview__canvas")!;

  const videoA = buildLayer("video") as Stage["videoA"];
  const videoB = buildLayer("video") as Stage["videoB"];
  const image = buildLayer("img") as Stage["image"];
  const overlay = document.createElement("div");
  overlay.className = "preview__overlay";
  canvas.append(videoA.pos, videoB.pos, image.pos, overlay);

  const stage: Stage = {
    root,
    canvas,
    videoA,
    videoB,
    image,
    overlay,
    scale: 1,
    dispose() {
      observer.disconnect();
      videoA.media.src = "";
      videoB.media.src = "";
    },
  };

  const fit = (): void => {
    const box = root.getBoundingClientRect();
    const pad = 24;
    const availW = Math.max(80, box.width - pad * 2);
    const availH = Math.max(60, box.height - pad * 2);
    const scale = Math.min(availW / project.timeline.width, availH / project.timeline.height);
    stage.scale = scale;
    canvas.style.width = `${Math.round(project.timeline.width * scale)}px`;
    canvas.style.height = `${Math.round(project.timeline.height * scale)}px`;
    onResize();
  };

  const observer = new ResizeObserver(fit);
  observer.observe(root);
  fit();

  return stage;
}

export function setOverlay(stage: Stage, text: string | null): void {
  stage.overlay.textContent = text ?? "";
  stage.overlay.classList.toggle("active", text !== null);
}
