// Toast notifications — one host, stacked bottom-center, auto-dismiss.

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
): void {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast toast--error" : "toast";
  el.textContent = message;
  ensureHost().appendChild(el);

  // Fast path: identical to a toast without details — one timer, nothing else.
  if (!opts) {
    window.setTimeout(() => el.remove(), ms);
    return;
  }

  recordError({ at: Date.now(), op: opts.op ?? "", message, detail: opts.detail });
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
  error: (message: string, opts?: ToastOptions): void => show(message, "error", 6500, opts),
};
