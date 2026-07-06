import "./style/tokens.css";
import "./style/base.css";
import "./style/components.css";
import { fileExt, fileStem } from "./core/format";
import { navigate, setNavigator, type Route } from "./core/nav";
import { initSettings } from "./core/session";
import { MEDIA_FILE_EXTENSIONS } from "./core/types";
import { mountHome } from "./home/home";

// Suppress WebView2's native context menu everywhere except editable text
// fields (which keep native copy/paste). Our own contextmenu handlers still
// fire — preventDefault only kills the browser's default menu. Zero-cost.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  const editable =
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
  if (!editable) e.preventDefault();
});

// In production only, block browser-chrome shortcuts that make no sense in a
// packaged desktop app (print, reload, find, downloads, view-source, …).
if (!import.meta.env.DEV) {
  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key;
      const ctrl = e.ctrlKey && !e.altKey;
      if (
        (ctrl && (k === "p" || k === "r" || k === "f" || k === "j" || k === "u")) ||
        k === "F5" ||
        k === "F3" ||
        k === "F7"
      ) {
        e.preventDefault();
      }
    },
    true,
  );
}

// Boot: paint the home screen immediately. The editor is a separate chunk,
// prefetched on idle so opening a project is instant without slowing startup.

const app = document.getElementById("app")!;

type Disposer = () => void | Promise<void>;
let dispose: Disposer | null = null;
let navToken = 0;

async function go(route: Route): Promise<void> {
  const token = ++navToken;
  const prev = dispose;
  dispose = null;
  if (prev) await prev();
  if (token !== navToken) return; // superseded while disposing
  app.innerHTML = "";

  if (route.view === "home") {
    const view = mountHome(app);
    dispose = () => view.dispose();
  } else if (route.view === "settings") {
    const { mountSettings } = await import("./settings/settings");
    if (token !== navToken) return;
    const view = mountSettings(app);
    dispose = () => view.dispose();
  } else {
    const { mountEditor } = await import("./editor/editor");
    if (token !== navToken) return;
    const view = await mountEditor(app, route.projectPath, route.temp ?? false);
    if (token !== navToken) {
      await view.dispose();
      return;
    }
    dispose = () => view.dispose();
  }
}

setNavigator((route) => void go(route));
void go({ view: "home" });

// OS file-open routing: a ".trt" opens the project directly; a supported media
// file starts a new project with that file placed on the timeline (an OS
// "Open with" implies the user wants to work with it, not just stage it).
// This differs from in-app import, which is bin-first (see home createNew).
// Serialized so overlapping launches can't interleave two project creations.
let openChain: Promise<void> = Promise.resolve();

// The temp-projects dir, resolved once per app run (a stable OS path). Cached as
// a promise so concurrent opens share the single IPC round-trip. Normalized to
// backslashes + lowercase for a case-insensitive Windows prefix test. Empty in a
// plain browser (ipc fallback), which makes the prefix test below always false.
let tempDirPrefix: Promise<string> | null = null;
function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}
function tempProjectsDirPrefix(): Promise<string> {
  if (!tempDirPrefix) {
    tempDirPrefix = import("./core/ipc")
      .then(({ ipc }) => ipc.tempProjectsDir())
      .then((dir) => (dir ? normalizePath(dir) : ""))
      .catch(() => "");
  }
  return tempDirPrefix;
}

async function routeOpenPath(path: string): Promise<void> {
  const ext = fileExt(path);
  if (ext === "trt") {
    // A .trt that physically lives in the temp-projects dir is a live quick-view
    // scratch file: route it as temp so the editor shows the Temporary badge and
    // applies the keep gate on exit, matching the recents exclusion the backend
    // already enforces for that dir. Anything outside it is a normal project.
    const prefix = await tempProjectsDirPrefix();
    const temp = prefix.length > 0 && normalizePath(path).startsWith(prefix);
    navigate(temp ? { view: "editor", projectPath: path, temp: true } : { view: "editor", projectPath: path });
    return;
  }
  if (!MEDIA_FILE_EXTENSIONS.has(ext)) return; // unknown type: ignore
  const { ipc, describeError } = await import("./core/ipc");
  const { createProject, importMediaAsClip } = await import("./core/project");
  const { settingsStore } = await import("./core/session");
  // Quick-view: with the setting on, an open-with media file becomes a
  // temporary project in the temp dir (never in recents) until the user presses
  // Back in the editor. Off → the classic permanent flow, byte-identical.
  const temp = settingsStore.get().tempOpenWith;
  try {
    const projectPath = temp
      ? await ipc.tempProjectPath(fileStem(path))
      : await ipc.newProjectPath(fileStem(path));
    let project = createProject(fileStem(projectPath));
    const info = await ipc.probeMedia(path);
    project = importMediaAsClip(project, info).project;
    await ipc.saveProject(projectPath, project);
    navigate(temp ? { view: "editor", projectPath, temp: true } : { view: "editor", projectPath });
  } catch (e) {
    const { toast } = await import("./ui/toast");
    toast.error(describeError(e));
  }
}

function enqueueOpen(path: string): void {
  openChain = openChain.then(() => routeOpenPath(path)).catch(() => {});
}

void (async () => {
  await initSettings();
  const { ipc, onOpenPath } = await import("./core/ipc");
  // Atomically drain the server-side open-path queue and route each path. Safe
  // to call repeatedly: the drain returns every queued path to exactly one
  // caller, so the wake-up handler and the startup drain never double-open.
  const drainOpenPaths = async (): Promise<void> => {
    try {
      for (const path of await ipc.takePendingOpenPaths()) enqueueOpen(path);
    } catch {
      /* not in desktop backend */
    }
  };
  // Attach the wake-up listener first, then drain once. A second launch during
  // the boot window pushed its path into the queue; this initial drain picks it
  // up even if its wake-up event fired before the listener was ready.
  void onOpenPath(() => void drainOpenPaths());
  await drainOpenPaths();
})();

// Dev-only in-app E2E harness (activated via TAROTING_AUTOTEST=1).
if (import.meta.env.DEV) {
  void (async () => {
    try {
      const { ipc, inTauri } = await import("./core/ipc");
      if (!inTauri) return;
      const info = await ipc.debugInfo();
      if (info.autotest) {
        const { runAutotest } = await import("./dev/autotest");
        void runAutotest(info.fixturesDir);
      }
    } catch {
      /* not in dev backend */
    }
  })();
}

// Warm the editor chunk once the home screen has painted.
requestIdleCallback?.(() => {
  void import("./editor/editor");
});
