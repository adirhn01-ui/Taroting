// Right-docked properties panel. Rebuilds when the selection changes (or the
// selected clip disappears) and edits the selected clip's video transform and
// audio settings. Sliders live-commit: continuous changes flow through
// session.replace() during a drag (no history), then a single history entry is
// pushed on release via session.commitFrom(before).

import "./inspector.css";
import { formatDuration, escapeHtml, fileStem } from "../../core/format";
import { ipc } from "../../core/ipc";
import {
  defaultTransform,
  detachAudio,
  findClip,
  findMedia,
  removeClipAudio,
  setClipSpeed,
  updateClip,
} from "../../core/project";
import type { ProjectSession } from "../../core/session";
import type { Store } from "../../core/store";
import { clipDuration } from "../../core/time";
import type { Clip, ClipTransform, MediaRef, ProjectFile } from "../../core/types";
import type { PlaybackEngine } from "../playback/engine";
import type { MediaManager } from "../media/media";
import { toast } from "../../ui/toast";

export interface InspectorCtx {
  session: ProjectSession;
  media: MediaManager;
  engine: PlaybackEngine;
  selection: Store<string | null>;
  refresh(): void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const ROTATIONS: (0 | 90 | 180 | 270)[] = [0, 90, 180, 270];

/** Located clip plus its media and whether it lives on the video track. */
interface Target {
  clip: Clip;
  media: MediaRef;
  onVideoTrack: boolean;
}

function resolve(p: ProjectFile, id: string | null): Target | null {
  if (!id) return null;
  const found = findClip(p, id);
  if (!found) return null;
  const media = findMedia(p, found.clip.mediaId);
  if (!media) return null;
  return { clip: found.clip, media, onVideoTrack: found.track.kind === "video" };
}

/** True if some clip on an audio track shares this clip's media and overlaps its
 *  source [srcIn, srcOut) range — i.e. a detached copy that would double-play. */
function audioCopyOverlaps(p: ProjectFile, t: Target): boolean {
  const { clip } = t;
  for (const track of p.timeline.tracks) {
    if (track.kind !== "audio") continue;
    for (const c of track.clips) {
      if (c.mediaId !== clip.mediaId) continue;
      if (c.srcIn < clip.srcOut && clip.srcIn < c.srcOut) return true;
    }
  }
  return false;
}

export function mountInspector(
  host: HTMLElement,
  ctx: InspectorCtx,
): { dispose(): void } {
  host.classList.add("inspector");

  // While a slider drag is in flight we update numbers in place instead of
  // tearing down and rebuilding the DOM (which would kill the drag).
  let dragging = false;
  // Cleanup for listeners attached during the current build.
  let cleanup: (() => void)[] = [];

  function clearBuild(): void {
    for (const c of cleanup) c();
    cleanup = [];
  }

  /* -------- small builders (return elements, wire live-commit) -------- */

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    html?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };

  function section(title: string): HTMLElement {
    const s = el("div", "insp-section");
    s.appendChild(el("div", "insp-section__title", escapeHtml(title)));
    return s;
  }

  /** A .field row with a label and a provided control. */
  function field(label: string, control: HTMLElement): HTMLElement {
    const f = el("div", "field insp-field");
    f.appendChild(el("label", undefined, escapeHtml(label)));
    f.appendChild(control);
    return f;
  }

  /** Live-commit slider: replace() on input, commitFrom() on release. */
  function slider(
    clipId: string,
    opts: {
      min: number;
      max: number;
      step: number;
      value: number;
      format: (v: number) => string;
      patch: (v: number) => Partial<Clip>;
    },
  ): HTMLElement {
    const wrap = el("div", "insp-slider");
    const input = el("input", "slider");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.value = String(opts.value);
    const readout = el("div", "insp-slider__value mono", escapeHtml(opts.format(opts.value)));
    wrap.appendChild(input);
    wrap.appendChild(readout);

    let before: ProjectFile | null = null;
    const begin = (): void => {
      dragging = true;
      before = ctx.session.project;
    };
    const commit = (): void => {
      if (before) {
        ctx.session.commitFrom(before);
        before = null;
      }
      dragging = false;
    };
    const onInput = (): void => {
      const v = Number(input.value);
      readout.textContent = opts.format(v);
      ctx.session.replace(updateClip(ctx.session.project, clipId, opts.patch(v)));
      ctx.refresh();
    };
    input.addEventListener("pointerdown", begin);
    input.addEventListener("focusin", begin);
    input.addEventListener("input", onInput);
    input.addEventListener("change", commit);
    input.addEventListener("pointerup", commit);
    cleanup.push(() => {
      input.removeEventListener("pointerdown", begin);
      input.removeEventListener("focusin", begin);
      input.removeEventListener("input", onInput);
      input.removeEventListener("change", commit);
      input.removeEventListener("pointerup", commit);
    });
    return wrap;
  }

  /** Live-commit number input with clamping; commits one history step on blur/enter. */
  function numberInput(
    clipId: string,
    opts: {
      value: number;
      step?: number;
      clamp: (v: number) => number;
      patch: (v: number) => Partial<Clip>;
    },
  ): HTMLInputElement {
    const input = el("input", "input insp-num");
    input.type = "number";
    if (opts.step !== undefined) input.step = String(opts.step);
    input.value = String(opts.value);

    let before: ProjectFile | null = null;
    const begin = (): void => {
      dragging = true;
      before = ctx.session.project;
    };
    const onInput = (): void => {
      const raw = Number(input.value);
      if (!Number.isFinite(raw)) return;
      const v = opts.clamp(raw);
      ctx.session.replace(updateClip(ctx.session.project, clipId, opts.patch(v)));
      ctx.refresh();
    };
    const commit = (): void => {
      const v = opts.clamp(Number(input.value) || 0);
      input.value = String(v);
      if (before) {
        ctx.session.commitFrom(before);
        before = null;
      }
      dragging = false;
    };
    input.addEventListener("focusin", begin);
    input.addEventListener("input", onInput);
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    cleanup.push(() => {
      input.removeEventListener("focusin", begin);
      input.removeEventListener("input", onInput);
      input.removeEventListener("change", commit);
      input.removeEventListener("blur", commit);
    });
    return input;
  }

  function switchToggle(
    checked: boolean,
    onChange: (v: boolean) => void,
  ): HTMLInputElement {
    const input = el("input", "switch");
    input.type = "checkbox";
    input.checked = checked;
    const handler = (): void => onChange(input.checked);
    input.addEventListener("change", handler);
    cleanup.push(() => input.removeEventListener("change", handler));
    return input;
  }

  function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", cls);
    b.textContent = label;
    b.addEventListener("click", onClick);
    cleanup.push(() => b.removeEventListener("click", onClick));
    return b;
  }

  /* -------- discrete commit helper -------- */

  const commit = (mutate: (p: ProjectFile) => ProjectFile): void => {
    ctx.session.commit(mutate);
    ctx.refresh();
  };

  /* -------- section builders -------- */

  function buildVideoSection(t: Target): HTMLElement {
    const s = section("Video");
    const clipId = t.clip.id;
    const tf = t.clip.transform ?? defaultTransform();

    // Speed
    const speedSel = el("select", "select select--sm");
    for (const sp of SPEEDS) {
      const o = el("option");
      o.value = String(sp);
      o.textContent = `${sp}×`;
      if (Math.abs(sp - t.clip.speed) < 1e-6) o.selected = true;
      speedSel.appendChild(o);
    }
    const onSpeed = (): void => {
      commit((p) => setClipSpeed(p, clipId, Number(speedSel.value)));
    };
    speedSel.addEventListener("change", onSpeed);
    cleanup.push(() => speedSel.removeEventListener("change", onSpeed));
    s.appendChild(field("Speed", speedSel));

    // Scale
    s.appendChild(
      field(
        "Scale",
        slider(clipId, {
          min: 0.1,
          max: 4,
          step: 0.01,
          value: tf.scale,
          format: (v) => `${v.toFixed(2)}×`,
          patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), scale: v } }),
        }),
      ),
    );

    // Position X / Y
    const posRow = el("div", "insp-row");
    posRow.appendChild(
      field(
        "X",
        numberInput(clipId, {
          value: tf.x,
          clamp: (v) => Math.round(v),
          patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), x: v } }),
        }),
      ),
    );
    posRow.appendChild(
      field(
        "Y",
        numberInput(clipId, {
          value: tf.y,
          clamp: (v) => Math.round(v),
          patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), y: v } }),
        }),
      ),
    );
    s.appendChild(posRow);

    // Rotate (cycles)
    const rotBtn = button(`Rotate ${tf.rotate}°`, "btn btn--sm", () => {
      const cur = currentTransform(clipId) ?? tf;
      const next = ROTATIONS[(ROTATIONS.indexOf(cur.rotate) + 1) % ROTATIONS.length]!;
      commit((p) => updateClip(p, clipId, { transform: { ...cur, rotate: next } }));
    });
    s.appendChild(field("Rotate", rotBtn));

    // Flip switches
    const flipRow = el("div", "insp-row");
    flipRow.appendChild(
      field(
        "Flip H",
        switchToggle(tf.flipH, (v) => {
          const cur = currentTransform(clipId) ?? tf;
          commit((p) => updateClip(p, clipId, { transform: { ...cur, flipH: v } }));
        }),
      ),
    );
    flipRow.appendChild(
      field(
        "Flip V",
        switchToggle(tf.flipV, (v) => {
          const cur = currentTransform(clipId) ?? tf;
          commit((p) => updateClip(p, clipId, { transform: { ...cur, flipV: v } }));
        }),
      ),
    );
    s.appendChild(flipRow);

    // Opacity
    s.appendChild(
      field(
        "Opacity",
        slider(clipId, {
          min: 0,
          max: 1,
          step: 0.01,
          value: tf.opacity,
          format: (v) => `${Math.round(v * 100)}%`,
          patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), opacity: v } }),
        }),
      ),
    );

    // Crop
    s.appendChild(buildCrop(t));

    // Reset transform
    s.appendChild(
      button("Reset transform", "btn btn--ghost btn--sm insp-block", () => {
        commit((p) => updateClip(p, clipId, { transform: defaultTransform() }));
      }),
    );

    return s;
  }

  function currentTransform(clipId: string): ClipTransform | undefined {
    const cur = resolve(ctx.session.project, clipId);
    return cur?.clip.transform;
  }

  function buildCrop(t: Target): HTMLElement {
    const clipId = t.clip.id;
    const wrap = el("div", "insp-crop");
    wrap.appendChild(el("div", "insp-sublabel", "Crop"));
    const mediaW = t.media.width ?? 0;
    const mediaH = t.media.height ?? 0;
    const crop = t.clip.transform?.crop ?? { x: 0, y: 0, w: mediaW, h: mediaH };

    const grid = el("div", "insp-crop__grid");
    const mk = (label: string, value: number): HTMLInputElement => {
      const input = el("input", "input insp-num");
      input.type = "number";
      input.value = String(Math.round(value));
      const f = el("div", "field insp-field");
      f.appendChild(el("label", undefined, label));
      f.appendChild(input);
      grid.appendChild(f);
      return input;
    };
    const xI = mk("X", crop.x);
    const yI = mk("Y", crop.y);
    const wI = mk("W", crop.w);
    const hI = mk("H", crop.h);
    wrap.appendChild(grid);

    const btns = el("div", "insp-row");
    btns.appendChild(
      button("Apply", "btn btn--sm", () => {
        const x = Math.round(Number(xI.value) || 0);
        const y = Math.round(Number(yI.value) || 0);
        const w = Math.round(Number(wI.value) || 0);
        const h = Math.round(Number(hI.value) || 0);
        // validate: 0 <= x < x+w <= mediaW ; 0 <= y < y+h <= mediaH
        if (
          !(x >= 0 && w > 0 && x + w <= mediaW && y >= 0 && h > 0 && y + h <= mediaH)
        ) {
          toast.error(`Crop must fit inside ${mediaW}×${mediaH}.`);
          return;
        }
        const cur = currentTransform(clipId) ?? defaultTransform();
        commit((p) => updateClip(p, clipId, { transform: { ...cur, crop: { x, y, w, h } } }));
      }),
    );
    btns.appendChild(
      button("Clear", "btn btn--ghost btn--sm", () => {
        const cur = currentTransform(clipId) ?? defaultTransform();
        const { crop: _drop, ...rest } = cur;
        commit((p) => updateClip(p, clipId, { transform: { ...rest } }));
      }),
    );
    wrap.appendChild(btns);
    return wrap;
  }

  function buildAudioSection(t: Target): HTMLElement {
    const s = section("Audio");
    const clipId = t.clip.id;
    const a = t.clip.audio;
    const clipDur = clipDuration(t.clip);

    if (t.onVideoTrack && a.detached) {
      s.appendChild(el("div", "insp-note", "Audio detached"));
      s.appendChild(
        button("Restore audio", "btn btn--sm insp-block", () => {
          commit((p) =>
            updateClip(p, clipId, (c) => ({ ...c, audio: { ...c.audio, detached: false } })),
          );
        }),
      );
      // Warn if a detached copy of this media overlaps our source range on an
      // audio track — restoring would then play the sound twice.
      if (audioCopyOverlaps(ctx.session.project, t)) {
        s.appendChild(
          el(
            "div",
            "insp-note insp-note--warn",
            "A detached copy exists on an audio track — restoring may double the sound.",
          ),
        );
      }
      return s;
    }

    // Volume 0..2 shown as 0..200%
    s.appendChild(
      field(
        "Volume",
        slider(clipId, {
          min: 0,
          max: 2,
          step: 0.01,
          value: a.volume,
          format: (v) => `${Math.round(v * 100)}%`,
          patch: (v) => ({ audio: { ...currentAudio(clipId, a), volume: v } }),
        }),
      ),
    );

    // Mute
    s.appendChild(
      field(
        "Mute",
        switchToggle(a.muted, (v) => {
          commit((p) => updateClip(p, clipId, { audio: { ...currentAudio(clipId, a), muted: v } }));
        }),
      ),
    );

    // Fades
    const fadeRow = el("div", "insp-row");
    fadeRow.appendChild(
      field(
        "Fade in (s)",
        numberInput(clipId, {
          value: a.fadeInSec,
          step: 0.1,
          clamp: (v) => Math.min(Math.max(0, v), clipDur),
          patch: (v) => ({ audio: { ...currentAudio(clipId, a), fadeInSec: v } }),
        }),
      ),
    );
    fadeRow.appendChild(
      field(
        "Fade out (s)",
        numberInput(clipId, {
          value: a.fadeOutSec,
          step: 0.1,
          clamp: (v) => Math.min(Math.max(0, v), clipDur),
          patch: (v) => ({ audio: { ...currentAudio(clipId, a), fadeOutSec: v } }),
        }),
      ),
    );
    s.appendChild(fadeRow);

    // Gain offset readout
    const gainRow = el("div", "insp-readout");
    gainRow.innerHTML = `<span>Gain offset</span><span class="mono">${a.gainOffsetDb >= 0 ? "+" : ""}${a.gainOffsetDb.toFixed(1)} dB</span>`;
    s.appendChild(gainRow);

    // Normalize
    const normBtn = button("Normalize", "btn btn--sm insp-block", () => {
      normBtn.disabled = true;
      normBtn.textContent = "Analyzing…";
      ipc
        .normalizeScan(t.media.path, t.clip.srcIn, t.clip.srcOut)
        .then((r) => {
          commit((p) =>
            updateClip(p, clipId, {
              audio: { ...currentAudio(clipId, a), gainOffsetDb: r.suggestedGainDb },
            }),
          );
          toast.info(
            `Peak ${r.maxVolumeDb.toFixed(1)} dB → ${r.suggestedGainDb >= 0 ? "+" : ""}${r.suggestedGainDb.toFixed(1)} dB gain`,
          );
        })
        .catch((e: unknown) => {
          toast.error(
            `Normalize failed: ${e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)}`,
          );
        })
        .finally(() => {
          normBtn.disabled = false;
          normBtn.textContent = "Normalize";
        });
    });
    s.appendChild(normBtn);

    // Video-track extras: detach / remove
    if (t.onVideoTrack) {
      const row = el("div", "insp-row");
      row.appendChild(
        button("Detach audio", "btn btn--sm", () => {
          const beforeSel = ctx.session.project;
          let newId: string | null = null;
          ctx.session.commit((p) => {
            const r = detachAudio(p, clipId);
            newId = r.audioClipId;
            return r.project;
          });
          if (ctx.session.project !== beforeSel && newId) {
            ctx.selection.set(newId);
          }
          ctx.refresh();
        }),
      );
      row.appendChild(
        button("Remove audio", "btn btn--ghost btn--sm", () => {
          commit((p) => removeClipAudio(p, clipId));
        }),
      );
      s.appendChild(row);
    }

    return s;
  }

  function currentAudio(clipId: string, fallback: Clip["audio"]): Clip["audio"] {
    const cur = resolve(ctx.session.project, clipId);
    return cur?.clip.audio ?? fallback;
  }

  /* -------- top-level rebuild -------- */

  function rebuild(): void {
    clearBuild();
    host.innerHTML = "";

    const sel = ctx.selection.get();
    const t = resolve(ctx.session.project, sel);
    if (!t) {
      const empty = el("div", "empty-state", "Select a clip to edit its properties.");
      host.appendChild(empty);
      return;
    }

    // Header
    const header = el("div", "insp-header");
    header.appendChild(el("div", "insp-header__name", escapeHtml(fileStem(t.media.path))));
    const meta = el("div", "insp-header__meta");
    meta.appendChild(el("span", "badge", escapeHtml(t.media.kind)));
    meta.appendChild(el("span", "insp-header__dur mono", formatDuration(clipDuration(t.clip))));
    header.appendChild(meta);
    host.appendChild(header);

    const body = el("div", "insp-body");
    // Video section only for video-track clips
    if (t.onVideoTrack) body.appendChild(buildVideoSection(t));

    // Audio section for every audio-track clip, and for video-track clips whose
    // media has audio (detached clips render a "detached" note inside it).
    if (!t.onVideoTrack || t.media.hasAudio) {
      body.appendChild(buildAudioSection(t));
    }
    host.appendChild(body);
  }

  /* -------- reactivity -------- */

  const unsubSel = ctx.selection.subscribe(() => rebuild());
  const unsubSession = ctx.session.store.subscribe(() => {
    // Rebuild on project changes (e.g. the selected clip was deleted → empty
    // state), but never tear down the DOM mid-drag.
    if (dragging) return;
    rebuild();
  });

  rebuild();

  return {
    dispose(): void {
      unsubSel();
      unsubSession();
      clearBuild();
      host.innerHTML = "";
    },
  };
}
