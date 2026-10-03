// Toast notifications — one host, stacked bottom-center, auto-dismiss.

import type { DiagnosticErrorEntry } from "../core/diagnostics";
import { openErrorDialog, placeOverlay, recordError } from "./errors";

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "toast-host";
    // Announces the info toasts ("Copied", "Saved"): each one is an ADDITION
    // to this region, read politely. Deliberately not role="status" — that
    // implies aria-atomic, which would re-read every stacked toast on each new
    // one. Error toasts carry role="alert" themselves (see show). The one
    // residual: a region is only heard once it exists, so the very first info
    // toast of a session, which creates the host in the same task, may go
    // unannounced. Creating the host at import instead would put DOM work on
    // the boot path for a toast that may never come.
    host.setAttribute("aria-live", "polite");
  }
  // Re-placed on every toast, not only on creation: a toast raised while the
  // viewer or the theater holds fullscreen must go INSIDE that element, or it
  // paints under the top layer and nobody sees it (the monitor-volume save
  // failure, for one). See `placeOverlay`.
  placeOverlay(host);
  return host;
}

export interface ToastOptions {
  /** Full text behind the one-line message. Grows a "Details" button that
   *  cancels the auto-dismiss and opens it in a copyable dialog — without it,
   *  "the toast vanished and I'll never know what it said". */
  detail?: string;
  /** Short operation label for the recent-errors list, e.g. "Export". */
  op?: string;
  /** Title for the details dialog (defaults to the operation). */
  title?: string;
  /** The whole file paths the message or detail names. Kept with the
   *  recent-errors entry and handed to the details pane, so redaction replaces
   *  each one whole — spaces and all — and its bare file name or stem in the
   *  message too ("Couldn't import harbour: …"). Without it a spaced path is
   *  only found in free text, cut short at the space. Costs nothing to show:
   *  a toast with paths but no detail still has no Details button. */
  paths?: readonly string[];
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
  // An inserted alert is announced at once and on its own, whatever the age
  // of the region around it — so a failure (or a refusal) is never missed,
  // the session's first included. Info toasts rely on the host's polite
  // region instead (see ensureHost): a child that is its own live region and
  // arrives already filled is generally not announced at all.
  if (kind === "error") el.setAttribute("role", "alert");
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
    if (opts?.detail !== undefined) entry.detail = opts.detail;
    if (opts?.paths?.length) entry.paths = [...opts.paths];
    recordError(entry);
  }

  // Fast path: identical to a toast without details — one timer, nothing else.
  if (!opts || opts.detail === undefined) {
    window.setTimeout(() => el.remove(), ms);
    return;
  }
  const detail = opts.detail;

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
      report: detail,
      paths: opts.paths,
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
