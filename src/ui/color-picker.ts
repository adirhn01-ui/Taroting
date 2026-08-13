// A framework-less colour picker popover: a 2D saturation/brightness field, a
// hue slider, a dedicated brightness slider, a hex field, preset swatches, a
// system-wide screen eyedropper (when the webview provides one) and a reset.
//
// PERF: nothing here runs while the popover is closed. The module is imported
// dynamically on the click that opens it, every listener is registered in
// openColorPicker and torn down by close(), and there is no rAF loop and no
// polling — drags are driven by pointer events with a rect cached for the whole
// gesture, so a move never reads layout. Styles live in settings/settings.css
// (the only route that opens this) under a "colour picker" heading.
//
// The two 1-D controls are native <input type="range"> on purpose: keyboard
// support, pointer capture and touch behaviour come for free and correct, which
// is not true of a hand-rolled div. Only the 2-D field needs its own pointer
// handling.
//
// EVERY COLOUR HERE IS WRITTEN THROUGH THE CSSOM, never as an inline `style`
// attribute in the innerHTML below — the preview swatch, the twelve presets,
// the --cp-hue-color / --cp-bright-to gradient stops and the popover's own
// placement. That is not incidental tidiness: the packaged app's CSP refuses
// style attributes outright (Tauri appends a nonce to `style-src`, which makes
// its `'unsafe-inline'` inert), so a preset moved into the template for brevity
// would render as a row of empty boxes — in the packaged build only, and never
// under `npm run dev`. The full chain is documented above `colorRow` in
// src/settings/settings.ts.

import { escapeHtml } from "../core/format";
import { normalizeHexColor } from "../core/session";
import { trapTab } from "./focus";

/* ---------------- colour maths (HSV — the picker's own model) ---------------- */

/** h 0..360, s/v 0..100 → "#rrggbb". */
function hsvToHex(h: number, s: number, v: number): string {
  const sn = s / 100;
  const vn = v / 100;
  const c = vn * sn;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vn - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n: number): number => Math.round((n + m) * 255);
  const packed = (to(r) << 16) | (to(g) << 8) | to(b);
  return `#${(packed | 0x1000000).toString(16).slice(1)}`;
}

/** "#rrggbb" (already validated) → [h 0..360, s 0..100, v 0..100]. */
function hexToHsv(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, max === 0 ? 0 : (d / max) * 100, max * 100];
}

/* ---------------- screen eyedropper ---------------- */

interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperInstance {
  open(): Promise<EyeDropperResult>;
}
type EyeDropperCtor = new () => EyeDropperInstance;

/** Feature detection, not a version guess: WebView2 ships the EyeDropper API,
 *  but the button is HIDDEN ENTIRELY where it does not exist rather than
 *  offered as a control that does nothing. */
function eyeDropperCtor(): EyeDropperCtor | null {
  return "EyeDropper" in window
    ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper
    : null;
}

/* ---------------- presets ---------------- */

/** A spread of hues that all stay legible on both shipped palettes, opening on
 *  the app's own two accents. Used when the caller offers nothing better —
 *  which is right for an accent and useless for a background, hence the
 *  `presets` option below. */
const PRESETS = [
  "#6c7cff",
  "#5563e8",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#ef4444",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#6fd3ae",
  "#06b6d4",
  "#38bdf8",
];

/* ---------------- the popover ---------------- */

export interface ColorPickerOptions {
  /** The button the popover is anchored under. Clicks on it are NOT treated as
   *  "outside", so the caller can use it as a toggle. */
  anchor: HTMLElement;
  /** Current value. Anything that is not a valid hex falls back to
   *  `defaultValue`. */
  value: string;
  /** What "Reset to default" restores. */
  defaultValue: string;
  /** Accessible name of the colour being edited, e.g. "Accent color". */
  label: string;
  /** Swatches to offer. Twelve is what the row is laid out for. Defaults to the
   *  accent spread — a background or a text colour wants a different shelf
   *  entirely, and a row of twelve saturated hues under "Background" is an
   *  invitation to make the app unusable. Every entry is validated like any
   *  other input: these reach a `background:` declaration. */
  presets?: readonly string[];
  /** Every drag frame. Repaint only — must NOT persist (an IPC write per
   *  pointermove is exactly the kind of cost the perf veto exists for). */
  onPreview(hex: string): void;
  /** Once per completed gesture, and once more when the popover closes.
   *  Persist here. On Escape this fires with the value the popover opened on. */
  onCommit(hex: string): void;
  /** After the popover has been removed, on every close path. */
  onClose?(): void;
}

export interface ColorPickerHandle {
  close(): void;
}

/** Only one picker is ever open. */
let active: { dismiss(cancel: boolean): void } | null = null;

export function openColorPicker(opts: ColorPickerOptions): ColorPickerHandle {
  active?.dismiss(false);

  const initial = normalizeHexColor(opts.value, normalizeHexColor(opts.defaultValue, "#6c7cff"));
  let [h, s, v] = hexToHsv(initial);

  const el = document.createElement("div");
  el.className = "cp";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", opts.label);
  el.innerHTML = `
    <div class="cp__title">${escapeHtml(opts.label)}</div>
    <div class="cp__sv" tabindex="0" role="slider" aria-label="Saturation and brightness"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="">
      <div class="cp__sv-thumb"></div>
    </div>
    <label class="cp__slider-row">
      <span class="cp__slider-label">Hue</span>
      <input type="range" class="slider cp__range cp__hue" min="0" max="360" step="1" aria-label="Hue" />
    </label>
    <label class="cp__slider-row">
      <span class="cp__slider-label">Brightness</span>
      <input type="range" class="slider cp__range cp__bright" min="0" max="100" step="1" aria-label="Brightness" />
    </label>
    <div class="cp__hexrow">
      <span class="cp__swatch"></span>
      <input class="input cp__hex" spellcheck="false" autocomplete="off" autocorrect="off"
             maxlength="7" aria-label="Hex color" />
      <button type="button" class="btn btn--sm btn--icon cp__eyedropper" title="Pick a color from the screen"
              aria-label="Pick a color from the screen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18.2 2.8a2.6 2.6 0 0 1 3 3L15 12l-3-3z"/>
          <path d="m11.4 9.6-6.9 6.9V20h3.5l6.9-6.9"/>
        </svg>
      </button>
    </div>
    <div class="cp__presets" role="group" aria-label="Preset colors"></div>
    <div class="cp__foot">
      <button type="button" class="btn btn--sm btn--ghost cp__reset">Reset to default</button>
      <button type="button" class="btn btn--sm cp__done">Done</button>
    </div>`;
  document.body.appendChild(el);

  const q = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const sv = q<HTMLElement>(".cp__sv");
  const svThumb = q<HTMLElement>(".cp__sv-thumb");
  const hue = q<HTMLInputElement>(".cp__hue");
  const bright = q<HTMLInputElement>(".cp__bright");
  const swatch = q<HTMLElement>(".cp__swatch");
  const hex = q<HTMLInputElement>(".cp__hex");
  const eyedropper = q<HTMLButtonElement>(".cp__eyedropper");
  const presets = q<HTMLElement>(".cp__presets");

  // A dead control is worse than a missing one — drop it from the DOM (and out
  // of the Tab ring) where the webview has no EyeDropper.
  const EyeDropper = eyeDropperCtor();
  if (!EyeDropper) eyedropper.remove();

  for (const raw of opts.presets ?? PRESETS) {
    // Normalized even though every caller passes a module-local literal: this is
    // the one value here that comes from OUTSIDE the picker and lands straight
    // in a `background:` declaration.
    const preset = normalizeHexColor(raw, "");
    if (preset === "") continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cp__preset";
    b.title = preset;
    b.setAttribute("aria-label", preset);
    b.style.background = preset;
    b.addEventListener("click", () => {
      setHex(preset);
      paint(true);
      preview();
      commit();
    });
    presets.appendChild(b);
  }

  /* ---------------- painting ---------------- */

  const current = (): string => hsvToHex(h, s, v);

  /** `writeHex` is false while the user is typing, so a rejected keystroke
   *  never rewrites what is in the field under the caret. */
  function paint(writeHex: boolean): void {
    const hexValue = current();
    sv.style.setProperty("--cp-hue-color", hsvToHex(h, 100, 100));
    svThumb.style.left = `${s}%`;
    svThumb.style.top = `${100 - v}%`;
    sv.setAttribute("aria-valuenow", String(Math.round(v)));
    sv.setAttribute(
      "aria-valuetext",
      `Saturation ${Math.round(s)} percent, brightness ${Math.round(v)} percent`,
    );
    hue.value = String(Math.round(h));
    bright.value = String(Math.round(v));
    bright.style.setProperty("--cp-bright-to", hsvToHex(h, s, 100));
    swatch.style.background = hexValue;
    if (writeHex) {
      hex.value = hexValue;
      hex.classList.remove("cp__hex--bad");
      hex.removeAttribute("aria-invalid");
    }
  }

  function setHex(value: string): void {
    [h, s, v] = hexToHsv(normalizeHexColor(value, initial));
  }

  function preview(): void {
    opts.onPreview(current());
  }

  function commit(): void {
    opts.onCommit(current());
  }

  /* ---------------- 2-D saturation / brightness field ---------------- */

  sv.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sv.focus({ preventScroll: true });
    sv.setPointerCapture(e.pointerId);
    // Read the geometry ONCE for the whole drag: a getBoundingClientRect per
    // pointermove interleaved with style writes is textbook layout thrash.
    const rect = sv.getBoundingClientRect();
    const track = (ev: PointerEvent): void => {
      s = Math.min(100, Math.max(0, ((ev.clientX - rect.left) / rect.width) * 100));
      v = Math.min(100, Math.max(0, (1 - (ev.clientY - rect.top) / rect.height) * 100));
      paint(true);
      preview();
    };
    const end = (ev: PointerEvent): void => {
      sv.removeEventListener("pointermove", track);
      sv.removeEventListener("pointerup", end);
      sv.removeEventListener("pointercancel", end);
      if (sv.hasPointerCapture(ev.pointerId)) sv.releasePointerCapture(ev.pointerId);
      commit();
    };
    sv.addEventListener("pointermove", track);
    sv.addEventListener("pointerup", end);
    sv.addEventListener("pointercancel", end);
    track(e);
  });

  /* ---------------- keyboard auto-repeat ----------------
   *
   * A HELD arrow key is one gesture, but the browser reports it as a keystroke
   * every ~30 ms — and on a range input each of those also fires `change`. Every
   * commit here is an IPC round-trip and a settings.json rewrite, so a two-second
   * hold was persisting the file some sixty times to reach one colour.
   *
   * The repeats paint and preview exactly as before (the whole app recolours
   * live); only the persist waits for the key to come up, which is the same
   * once-per-gesture rule the pointer path already gets from pointerup and from
   * change-on-release. Nothing can be lost by waiting: `dismiss` commits
   * `current()` on every close path, so even a key released outside the picker
   * ends up on disk.
   *
   * Cleared by any fresh keydown and by blur, so a stale flag can never swallow
   * a later commit — including the `change` a mouse drag ends on.
   */
  let repeating = false;
  function commitAfterRepeat(): void {
    if (!repeating) return;
    repeating = false;
    commit();
  }
  for (const control of [sv, hue, bright]) {
    control.addEventListener("keyup", commitAfterRepeat);
    control.addEventListener("blur", commitAfterRepeat);
  }

  sv.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 1;
    let ds = 0;
    let dv = 0;
    if (e.key === "ArrowLeft") ds = -step;
    else if (e.key === "ArrowRight") ds = step;
    else if (e.key === "ArrowUp") dv = step;
    else if (e.key === "ArrowDown") dv = -step;
    else return;
    e.preventDefault();
    s = Math.min(100, Math.max(0, s + ds));
    v = Math.min(100, Math.max(0, v + dv));
    paint(true);
    preview();
    if (e.repeat) {
      repeating = true;
      return;
    }
    repeating = false;
    commit();
  });

  /* ---------------- hue + brightness sliders ---------------- */

  hue.addEventListener("input", () => {
    h = Number(hue.value);
    paint(true);
    preview();
  });
  bright.addEventListener("input", () => {
    v = Number(bright.value);
    paint(true);
    preview();
  });
  // A pointer drag ends in one `change`; a held arrow key fires one per repeat,
  // so those are folded into the keyup above instead.
  const onRangeKeyDown = (e: KeyboardEvent): void => {
    // A fresh key FLUSHES rather than clears: if a hold ended somewhere this
    // never saw a keyup (focus taken mid-hold), the pending value goes to disk
    // now instead of being dropped on the floor.
    if (e.repeat) repeating = true;
    else commitAfterRepeat();
  };
  const onRangeChange = (): void => {
    if (!repeating) commit();
  };
  for (const range of [hue, bright]) {
    range.addEventListener("keydown", onRangeKeyDown);
    range.addEventListener("change", onRangeChange);
  }

  /* ---------------- hex field ---------------- */

  hex.addEventListener("input", () => {
    const typed = hex.value;
    const parsed = normalizeHexColor(typed, "");
    if (parsed === "") {
      // Garbage so far — flag it, but leave the text alone. Half of "#6c7c"
      // is not yet a colour and must survive being typed through.
      hex.classList.add("cp__hex--bad");
      hex.setAttribute("aria-invalid", "true");
      return;
    }
    hex.classList.remove("cp__hex--bad");
    hex.removeAttribute("aria-invalid");
    setHex(parsed);
    paint(false);
    preview();
  });
  hex.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    paint(true); // normalise "#ABC" → "#aabbcc" in place
    commit();
  });
  // On blur the field always shows the value that is actually in effect, so
  // an abandoned half-edit can never look like it was applied.
  hex.addEventListener("blur", () => paint(true));

  /* ---------------- screen eyedropper ---------------- */

  if (EyeDropper) {
    eyedropper.addEventListener("click", () => {
      // Requires transient user activation, hence a click. Escape rejects the
      // promise — a cancelled pick is a normal outcome, not an error, and must
      // not reach the console.
      void new EyeDropper()
        .open()
        .then((res) => {
          // The pick can take as long as the user likes, and everything can
          // change underneath it: Done, Escape, a click outside, a scroll, or
          // another picker opening on a different colour. `handle` is this
          // popover's own identity, so this covers both — a closed picker and a
          // superseded one. Without it a dead popover still repaints the app's
          // CSS variables and persists a colour for a screen that is gone.
          if (active !== handle) return;
          const picked = normalizeHexColor(res.sRGBHex, "");
          if (picked === "") return; // never trust the value, even from the platform
          setHex(picked);
          paint(true);
          preview();
          commit();
        })
        .catch(() => {
          /* cancelled */
        });
    });
  }

  /* ---------------- reset / done ---------------- */

  q<HTMLButtonElement>(".cp__reset").addEventListener("click", () => {
    setHex(opts.defaultValue);
    paint(true);
    preview();
    commit();
  });
  q<HTMLButtonElement>(".cp__done").addEventListener("click", () => dismiss(false));

  /* ---------------- lifecycle ---------------- */

  const releaseTrap = trapTab(el);

  function onOutsidePointerDown(e: PointerEvent): void {
    const t = e.target as Node;
    // The anchor is deliberately "inside": the caller toggles on it.
    if (el.contains(t) || opts.anchor.contains(t)) return;
    dismiss(false);
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismiss(true);
  }
  function onDismiss(): void {
    dismiss(false);
  }

  function dismiss(cancel: boolean): void {
    if (active !== handle) return; // already closed
    active = null;
    document.removeEventListener("pointerdown", onOutsidePointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onDismiss);
    window.removeEventListener("scroll", onDismiss, true);
    releaseTrap();
    el.remove();
    // Escape is a real cancel: the value the popover opened on wins.
    opts.onCommit(cancel ? initial : current());
    opts.onClose?.();
  }

  const handle = { dismiss };
  active = handle;

  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onDismiss);
  // The Settings screen scrolls; a popover pinned to a stale anchor position is
  // worse than one that gets out of the way.
  window.addEventListener("scroll", onDismiss, true);
  // Deliberately NOT dismissed on window blur, unlike the context menu: the
  // screen eyedropper and "alt-tab to look at the colour I want" are both
  // normal parts of using this control, and closing under either would throw
  // away the pick the user is in the middle of making.

  paint(true);
  place(el, opts.anchor);
  sv.focus({ preventScroll: true });

  return { close: () => dismiss(false) };
}

/** Anchor below, flip above when that would overflow, clamp into the viewport. */
function place(el: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const pad = 8;
  const gap = 6;
  let top = a.bottom + gap;
  if (top + r.height > window.innerHeight - pad) {
    top = a.top - r.height - gap;
    if (top < pad) top = Math.max(pad, window.innerHeight - r.height - pad);
  }
  const left = Math.max(pad, Math.min(a.left, window.innerWidth - r.width - pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
