// Toast notifications — one host, stacked bottom-center, auto-dismiss.

import type { DiagnosticErrorEntry } from "../core/diagnostics";
import { openErrorDialog, recordError } from "./errors";

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  return host;
}

export interface ToastOptions {
  /** Full text behind the one-line message. Grows a "Details" button that
   *  cancels the auto-dismiss and opens it in a copyable dialog — without it,
   *  "the toast vanished and I'll never know what it said". */
  detail: string;
  /** Short operation label for the recent-errors list, e.g. "Export". */
  op?: string;
  /** Title for the details dialog (defaults to the operation). */
  title?: string;
}

function show(
  message: string,
  kind: "info" | "error",
  ms: number,
  opts?: ToastOptions,
  record = kind === "error",
): void {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast toast--error" : "toast";
  el.textContent = message;
  ensureHost().appendChild(el);

  // Every failure goes into the recent-errors ring, with or without details.
  // Recording only the toasts that carried details left "Couldn't import …",
  // "Couldn't save this project" and the like out of Settings → Diagnostics,
  // which then said nothing had failed. A refusal (`toast.refuse`) is not a
  // failure and is never recorded: a dozen "please enter a name" would evict
  // the real errors from a ring of twenty.
  if (record) {
    const entry: DiagnosticErrorEntry = { at: Date.now(), op: opts?.op ?? "", message };
    if (opts) entry.detail = opts.detail;
    recordError(entry);
  }

  // Fast path: identical to a toast without details — one timer, nothing else.
  if (!opts) {
    window.setTimeout(() => el.remove(), ms);
    return;
  }

  const timer = window.setTimeout(() => el.remove(), ms);
  const btn = document.createElement("button");
  btn.className = "btn btn--sm btn--ghost";
  btn.textContent = "Details";
  btn.addEventListener("click", () => {
    window.clearTimeout(timer);
    el.remove();
    openErrorDialog({
      title: opts.title ?? opts.op ?? "Details",
      message,
      report: opts.detail,
    });
  });
  el.appendChild(btn);
}

export const toast = {
  info: (message: string): void => show(message, "info", 3500),
  /** Something failed. Always recorded in the recent-errors ring. */
  error: (message: string, opts?: ToastOptions): void => show(message, "error", 6500, opts),
  /** The app declined an input — an empty name, a crop that does not fit, a
   *  file type it does not open. Styled like an error so it is noticed, but
   *  NEVER recorded: nothing failed, and the ring is for things that did. */
  refuse: (message: string): void => show(message, "error", 6500, undefined, false),
};
