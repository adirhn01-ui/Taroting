import "./style/tokens.css";
import "./style/base.css";
import "./style/components.css";
import { setNavigator, type Route } from "./core/nav";
import { initSettings } from "./core/session";
import { mountHome } from "./home/home";

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
    const view = await mountEditor(app, route.projectPath);
    if (token !== navToken) {
      await view.dispose();
      return;
    }
    dispose = () => view.dispose();
  }
}

setNavigator((route) => void go(route));
void initSettings();
void go({ view: "home" });

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
