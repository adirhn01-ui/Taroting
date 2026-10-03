// Home's "Open as" dialog: media files chosen with Open (or dropped on Home)
// become a new project, and the user says which kind. Nothing is decided for
// them: Video project is always there, Image project whenever every file is a
// picture, and Cancel leaves everything as it was.
//
// Its own lazy chunk (Home imports it when there is media to ask about), and
// it must NEVER import anything under src/image/: that would drag the image
// editor in with it. Image project creation goes through core/image-project.
//
// The app's modal pattern, whole: .modal-backdrop + .modal, trapTab released
// on EVERY close path, Escape / backdrop / X / Cancel close, focus seated on
// the first enabled choice. Built with createElement rather than a template
// so every node the handlers need is held directly.
//
// A choice keeps the dialog up, busy, until the project is made: probing N
// files takes real time, and a dialog that vanished at once left Home looking
// idle while a second Open or a drop was silently thrown away. Its CSS is its
// own file so it ships with this chunk, never in the boot stylesheet.

import "./open-as-dialog.css";
import { fileExt, fileName, fileStem } from "../core/format";
import { createPhotosImageProject } from "../core/image-project";
import { describeError, ipc } from "../core/ipc";
import { stillSizeProblem } from "../core/open-media";
import { mediaFamilyOf } from "../core/types";
import type { MediaInfo } from "../core/types";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

/* ---------------- pure pieces (exported for the tests) ---------------- */

/** The Image project choice's hint. It names the file whose size the canvas
 *  takes only when there is one to name: with a video, a song or too many
 *  pictures among the files the choice is off, and the first file (in name
 *  order) may not be a picture at all — naming it would promise a canvas
 *  "the size of" a video. */
export function imageProjectHint(paths: readonly string[], blocked: string | null): string {
  if (paths.length === 1) return "Draw on, adjust and export a picture";
  if (blocked !== null) return "Every picture a layer, on one canvas";
  return `Every picture a layer, on a canvas the size of ${fileName(paths[0]!)}`;
}

export function openAsTitle(count: number): string {
  return count === 1 ? "Open 1 file as" : `Open ${count} files as`;
}

/** The most pictures "Image project" starts from. Every picture becomes a
 *  full-size layer whose file and decode the image editor keeps in memory, so
 *  a Ctrl+A folder would be hundreds of them; the editor adds more one at a
 *  time. Video project takes any number. */
export const MAX_OPEN_AS_PICTURES = 20;

/** Why these files cannot become an image project, or null when they can.
 *  Only pictures (the image family) can: a GIF plays as a clip in this app
 *  (and is named as a GIF, which is what the user calls it), and audio has
 *  nothing to draw on. Counted, so the reason says what is in the way rather
 *  than only that something is. Then at most MAX_OPEN_AS_PICTURES of them. */
export function imageProjectBlocker(paths: readonly string[]): string | null {
  let videos = 0;
  let gifs = 0;
  let audio = 0;
  let other = 0;
  for (const p of paths) {
    const family = mediaFamilyOf(fileExt(p));
    if (family === "image") continue;
    if (family === "video") videos++;
    else if (family === "gif") gifs++;
    else if (family === "audio") audio++;
    else other++;
  }
  if (videos + gifs + audio + other === 0) {
    if (paths.length <= MAX_OPEN_AS_PICTURES) return null;
    return `Image projects start from up to ${MAX_OPEN_AS_PICTURES} pictures. Pick fewer, or choose Video project.`;
  }
  const lead = "Image projects hold pictures only.";
  if (paths.length === 1) {
    const what = videos ? "a video" : gifs ? "a GIF" : audio ? "an audio file" : "not a picture";
    return `${lead} This is ${what}.`;
  }
  const parts: Array<[n: number, one: string, many: string]> = [
    [videos, "is a video", "are videos"],
    [gifs, "is a GIF", "are GIFs"],
    [audio, "is an audio file", "are audio files"],
    [other, "is not a picture", "are not pictures"],
  ];
  const phrases = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many], i) => `${n}${i === 0 ? " of these" : ""} ${n === 1 ? one : many}`);
  const last = phrases.pop()!;
  const list = phrases.length ? `${phrases.join(", ")} and ${last}` : last;
  return `${lead} ${list}.`;
}

/* ---------------- the dialog ---------------- */

export interface OpenAsOptions {
  /** The media files, already allowlisted and in the order they will be used. */
  paths: readonly string[];
  /** The choice's work. The dialog stays up, busy, until it settles. */
  onVideo(): Promise<void>;
  onImage(): Promise<void>;
  /** Runs once, last, on EVERY close path (so Home can drop its closer). */
  onClosed?(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A choice: the menu rows' icon tile, label and hint (components.css), in a
 *  larger bordered button. */
function option(kind: "video" | "image", glyph: string, label: string, hint: string): HTMLButtonElement {
  const btn = el("button", "openas-option");
  btn.type = "button";
  btn.dataset.kind = kind;
  const ico = el("span", "ctx-menu__icon");
  ico.setAttribute("aria-hidden", "true");
  ico.innerHTML = icon(glyph, 18);
  const text = el("span", "ctx-menu__text");
  text.append(el("span", "ctx-menu__label", label), el("span", "ctx-menu__hint", hint));
  btn.append(ico, text);
  return btn;
}

/** Opens the dialog and returns its closer, for Home's `openOverlays`. A
 *  choice runs its callback with the dialog still up and busy (both choices
 *  off, focus on Cancel, the user's ways out inert) and closes the dialog once
 *  the callback settles. A callback that navigates tears Home down first, and
 *  Home's teardown closes the dialog through this closer, which is
 *  unconditional and idempotent. */
export function openOpenAsDialog(opts: OpenAsOptions): () => void {
  const count = opts.paths.length;
  const blocked = imageProjectBlocker(opts.paths);

  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal openas-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "openas-title");

  const header = el("div", "modal__header");
  const title = el("span", "", openAsTitle(count));
  title.id = "openas-title";
  const xBtn = el("button", "btn btn--ghost btn--icon btn--sm");
  xBtn.type = "button";
  xBtn.dataset.act = "cancel";
  xBtn.title = "Close";
  xBtn.setAttribute("aria-label", "Close");
  xBtn.innerHTML = icon("x", 14);
  header.append(title, xBtn);

  const body = el("div", "modal__body openas-options");
  const videoBtn = option("video", "film", "Video project", "Clips, photos and music on a timeline");
  const imageBtn = option("image", "image", "Image project", imageProjectHint(opts.paths, blocked));
  body.append(videoBtn, imageBtn);
  if (blocked) {
    imageBtn.disabled = true;
    const reason = el("div", "openas-reason", blocked);
    reason.id = "openas-reason";
    imageBtn.setAttribute("aria-describedby", reason.id);
    body.append(reason);
  }

  const footer = el("div", "modal__footer");
  const cancelBtn = el("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.dataset.act = "cancel";
  footer.append(cancelBtn);

  modal.append(header, body, footer);
  backdrop.append(modal);
  document.body.appendChild(backdrop);

  const releaseTrap = trapTab(backdrop);
  let closed = false;
  /** A choice's work is running: the dialog is busy until it settles. */
  let pending = false;
  // One exit for every path — X, Cancel, Escape, the backdrop, a settled
  // choice and Home's teardown — so the trap and the key listener go on all
  // of them.
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    releaseTrap();
    backdrop.remove();
    opts.onClosed?.();
  };
  // The user's ways out (X, Cancel, Escape, the backdrop) go through here and
  // do nothing while a choice is running; close() itself stays unconditional
  // for a settled choice and Home's teardown.
  const dismiss = (): void => {
    if (!pending) close();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) dismiss();
  });
  xBtn.addEventListener("click", dismiss);
  cancelBtn.addEventListener("click", dismiss);

  async function choose(btn: HTMLButtonElement, run: () => Promise<void>): Promise<void> {
    if (closed || pending || btn.disabled) return;
    pending = true;
    // Focus moves BEFORE the choices are disabled: disabling the focused
    // button would drop focus to <body>, outside the trap. Cancel and X stay
    // focusable (aria-disabled, never disabled) so the trap keeps holding.
    cancelBtn.focus();
    videoBtn.disabled = true;
    imageBtn.disabled = true;
    btn.dataset.pending = "";
    modal.setAttribute("aria-busy", "true");
    xBtn.setAttribute("aria-disabled", "true");
    cancelBtn.setAttribute("aria-disabled", "true");
    try {
      await run();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      close();
    }
  }
  videoBtn.addEventListener("click", () => void choose(videoBtn, opts.onVideo));
  imageBtn.addEventListener("click", () => void choose(imageBtn, opts.onImage));

  // The first enabled choice (Video project is always enabled). trapTab only
  // sees keys while focus is already inside, so this is its precondition.
  const first = [videoBtn, imageBtn].find((b) => !b.disabled);
  first?.focus();
  return close;
}

/* ---------------- image project from the chosen pictures ---------------- */

/** Probes every picture, drops (and names, in a toast) any that fails or is
 *  not a still with a size, and saves one image project of the rest — a real
 *  library project in Documents\Taroting, named after the first picture.
 *  Returns its path, or null when nothing was made. `gone` is asked after
 *  every await: a Home that has been left makes nothing and says nothing. */
export async function createImageProjectFrom(
  paths: readonly string[],
  gone: () => boolean,
): Promise<string | null> {
  const infos: MediaInfo[] = [];
  for (const path of paths) {
    const stem = fileStem(path);
    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(path);
    } catch (e) {
      if (gone()) return null;
      toast.error(`Couldn't open ${stem}: ${describeError(e)}`);
      continue;
    }
    if (gone()) return null;
    const problem =
      info.kind !== "image" || info.generator ? `${stem} is not a still picture, so it was left out.` : stillSizeProblem(info);
    if (problem) {
      // Declined, not failed: the file is fine, it just is not a picture with
      // a size this can use. A refusal is never recorded in Diagnostics.
      toast.refuse(problem);
      continue;
    }
    infos.push(info);
  }
  if (infos.length === 0) {
    // A summary, not a failure of its own: each probe that failed has already
    // been reported (and recorded) above, so recording this too would count
    // the same failures twice.
    toast.refuse("None of the pictures could be opened, so no project was made.");
    return null;
  }
  const projectPath = await ipc.newProjectPath(fileStem(infos[0]!.path));
  if (gone()) return null;
  await ipc.saveProject(projectPath, createPhotosImageProject(fileStem(projectPath), infos));
  return projectPath;
}
