// Error surfaces the user can actually get data OUT of.
//
// The app suppresses the native context menu outside editable fields and binds
// Ctrl+C to "copy clip" outside typing targets, so an error rendered into a
// <pre> was unreadable-by-clipboard: selectable, but impossible to extract
// (GitHub issue #1 — the reporter had to attach a screenshot that cut off
// mid-line). Everything here renders detail into a readonly <textarea>, which
// both of those guards already whitelist, and pairs it with an explicit copy.
//
// Anything built here to be COPIED OUT is redacted by `src/core/diagnostics.ts`
// — imported, never re-implemented, because two copies of a privacy scrubber
// drift and the quieter copy is the one that leaks.

import { createRedactor } from "../core/diagnostics";
import type { DiagnosticErrorEntry } from "../core/diagnostics";
import { escapeHtml } from "../core/format";
import { trapTab } from "./focus";
import { icon } from "./icons";
import { toast } from "./toast";

/* ---------------- clipboard ---------------- */

/** Copy text, with a fallback for the (unlikely) case the async Clipboard API
 *  is unavailable. The webview origin is `tauri.localhost`, which Chromium
 *  treats as a secure context, and every caller runs inside a click handler, so
 *  the primary path should always win; the fallback is belt-and-braces. */
export async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = execCommandCopy(text);
  }
  if (ok) toast.info("Copied");
  else toast.error("Couldn't copy");
  return ok;
}

function execCommandCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = "position:fixed;top:-9999px;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ---------------- detail pane ---------------- */

/** What the pane tells the user about what it has already done to the text.
 *  Same sentence Settings → Diagnostics uses above "Recent errors", because it
 *  is now the same guarantee in both places. */
const REDACTION_HINT = "Paths are replaced with <file N> tokens.";

/**
 * One redaction pass over text on its way into a pane.
 *
 * A second pass over text a report already scrubbed is a no-op: `<file 1.mp4>`
 * matches neither PATH_LIKE (no drive letter, no leading slash) nor either user
 * sweep, so nothing is re-tokenised and the numbering cannot shift. That is what
 * lets the pane redact unconditionally instead of asking every caller whether
 * their string has been through it already.
 *
 * Exported as the seam the tests pin — the pane around it is DOM.
 */
export function redactDetail(text: string): string {
  return createRedactor().text(text);
}

/**
 * A readonly <textarea> holding `text` plus a Copy button. A textarea (not a
 * <pre>) is the whole point: `isTypingTarget` returns true for it, so Ctrl+A /
 * Ctrl+C reach the browser untouched, the native context menu is allowed, and
 * `trapTab` reaches it for keyboard users.
 *
 * REDACTION HAPPENS HERE, not in the callers. The textarea exists so the native
 * clipboard works on it, so scrubbing only what the Copy button reads leaves the
 * leak wide open — select-all, Ctrl+C, paste into an issue, and the raw text
 * goes with it. The case that made this real: the export dialog seeds this pane
 * with the ffmpeg log tail, which carries absolute paths by construction, and it
 * stays that text permanently whenever the report build fails.
 */
export function detailPane(text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "err-pane";

  const ta = document.createElement("textarea");
  ta.className = "err-detail";
  ta.readOnly = true;
  ta.spellcheck = false;
  ta.value = redactDetail(text);
  ta.setAttribute("aria-label", "Details");

  const actions = document.createElement("div");
  actions.className = "err-pane__actions";
  const copy = document.createElement("button");
  copy.className = "btn btn--sm";
  copy.textContent = "Copy details";
  copy.addEventListener("click", () => void copyText(ta.value));
  actions.appendChild(copy);

  // Said once, next to the text it describes: a user about to paste this into a
  // public issue should not have to take the redaction on trust.
  const hint = document.createElement("div");
  hint.className = "err-hint";
  hint.textContent = REDACTION_HINT;

  wrap.append(ta, actions, hint);
  return wrap;
}

/* ---------------- dialog ---------------- */

export interface ErrorDialogOptions {
  title: string;
  message: string;
  report: string;
}

/** Every error dialog currently on document.body. Each entry is that dialog's
 *  own `close`, and each close removes itself. */
const openDialogs = new Set<() => void>();

/**
 * Close every open error dialog. This is the router's to call on a route change
 * — the FLOOR under the per-screen registries, not a replacement for them.
 *
 * A screen that owns its dialogs (Settings, Home) closes them in dispose() and
 * this finds nothing left. But `toast.error(…, { detail })` opens one from
 * anywhere, and a toast has no teardown moment to hang a closer on: nobody is
 * holding that dialog when the screen underneath it goes away. Without this the
 * dialog outlives the route — painted over the next screen, still holding the
 * focus trap and the window keydown capture, with no owner left to dismiss it.
 *
 * Idempotent, like the closers it calls.
 */
export function closeErrorDialogs(): void {
  // Each close() removes itself from the set, so iterate a copy.
  for (const close of [...openDialogs]) close();
  openDialogs.clear();
}

/**
 * A modal showing one message plus a copyable detail pane. Safe to nest over
 * the export dialog: `trapTab` listens on its own container, and the Escape
 * handler binds on `window` in the capture phase — which runs BEFORE the
 * document-level capture handlers the dialogs underneath use — then stops the
 * event, so Escape closes only the topmost dialog.
 *
 * RETURNS ITS CLOSER, and the caller is expected to hold it.
 *
 * The backdrop has to live on `document.body` to sit above everything, but the
 * router tears a screen down with `dispose()` and then clears `#app` — neither
 * of which touches the body. Without a closer the dialog outlives the screen
 * that opened it: still painted, still holding the `trapTab` focus trap, still
 * holding the `window` keydown capture. Concretely: open Settings → Diagnostics
 * → Recent errors → View, then let an OS "open with" arrive (a double-clicked
 * `.trt` or media file), and the router navigates to the editor underneath a
 * dialog you cannot tab out of. Nothing destructive is reachable — it is a
 * read-only text pane — but it is a keyboard dead end.
 *
 * Screens with a teardown registry should register the returned closer; see
 * `openOverlays` in `src/settings/settings.ts` and `src/home/home.ts`. `close`
 * is idempotent, so registering it and also letting the user dismiss the dialog
 * normally is safe. `closeErrorDialogs` above is the floor for the callers that
 * have nowhere to register one — a toast, most of all.
 */
export function openErrorDialog(opts: ErrorDialogOptions): () => void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal err-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title)}">
      <div class="modal__header">
        <span>${escapeHtml(opts.title)}</span>
        <button class="btn btn--ghost btn--icon btn--sm" data-close title="Close">${icon("x", 14)}</button>
      </div>
      <div class="modal__body">
        <div class="err-msg">${escapeHtml(opts.message)}</div>
        <div data-pane-slot></div>
      </div>
      <div class="modal__footer">
        <button class="btn btn--primary" data-ok>Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("[data-pane-slot]")!.replaceWith(detailPane(opts.report));

  const releaseTrap = trapTab(backdrop);
  // Idempotent: a screen's teardown may close a dialog the user has already
  // dismissed, and `trapTab`'s release must not run twice.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    openDialogs.delete(close);
    window.removeEventListener("keydown", onKey, true);
    releaseTrap();
    backdrop.remove();
  };
  openDialogs.add(close);
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // Only the topmost backdrop reacts, so a nested pane never closes the
    // dialog underneath it — and stopping the event here (window capture runs
    // before the document-level capture handlers the other dialogs use) keeps
    // that dialog open behind us.
    const stack = document.querySelectorAll(".modal-backdrop");
    if (stack[stack.length - 1] !== backdrop) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
  window.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("[data-close]")!.addEventListener("click", close);
  const ok = backdrop.querySelector<HTMLButtonElement>("[data-ok]")!;
  ok.addEventListener("click", close);
  ok.focus();
  return close;
}

/* ---------------- recent-errors ring ---------------- */

const RING_MAX = 20;

/** Bounded ring of the errors actually SHOWN this session. It is appended to
 *  only at the moment something is surfaced to the user, so a healthy session
 *  costs exactly zero bytes — this is not an always-on log. In memory only;
 *  nothing is ever written to disk. */
const ring: DiagnosticErrorEntry[] = [];

export function recordError(entry: DiagnosticErrorEntry): void {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
}

export function recentErrors(): readonly DiagnosticErrorEntry[] {
  return ring;
}

/**
 * Plain-text dump of the ring, oldest first.
 *
 * Scrubbed through the SAME redactor `buildReport` uses. This dump exists to be
 * pasted into an issue, and a toast's detail is typically an ffmpeg log line or
 * an fs error — precisely where an absolute path turns up. "Recent errors" and
 * "Copy report" sit one row apart in Settings → Diagnostics, so the two must not
 * disagree about what leaves the machine; only one of them used to redact.
 *
 * ONE redactor for the whole dump, matching a report's one-per-report rule: a
 * file that fails twice then reads as the same `<file N>` in both entries
 * instead of two unrelated ones, which is what makes the dump diagnosable at
 * all after the names are gone.
 */
export function formatRecentErrors(entries: readonly DiagnosticErrorEntry[]): string {
  if (entries.length === 0) return "No errors this session.";
  const redactor = createRedactor();
  return entries
    .map((e, i) => {
      const when = new Date(e.at).toISOString();
      const headLine = `${String(i + 1).padStart(2)}. ${when}  ${e.op || "—"}\n    ${redactor.text(e.message)}`;
      if (!e.detail) return headLine;
      const detail = redactor
        .text(e.detail)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      return `${headLine}\n${detail}`;
    })
    .join("\n\n");
}
