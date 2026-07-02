// Toast notifications — one host, stacked bottom-center, auto-dismiss.

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  return host;
}

function show(message: string, kind: "info" | "error", ms: number): void {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast toast--error" : "toast";
  el.textContent = message;
  ensureHost().appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}

export const toast = {
  info: (message: string): void => show(message, "info", 3500),
  error: (message: string): void => show(message, "error", 6500),
};
