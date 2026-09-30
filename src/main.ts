import "./style/tokens.css";
import "./style/base.css";
import "./style/components.css";
import { installCloseGate, runCloseFlow, type CloseDeps } from "./core/app-close";
import { beginBoot, hasLaunchHint } from "./core/boot";
import { fileExt, fileName } from "./core/format";
import { describeError, destroyWindow, inTauri, ipc, onOpenPath } from "./core/ipc";
import { navigate, setNavigator, type Route } from "./core/nav";
import {
  TEARDOWN_WAIT_MS,
  createTeardowns,
  isTempProjectPath,
  openMediaAsProject,
  runOnOpenChain,
} from "./core/open-media";
import {
  confirmLeaveCurrentSession,
  currentSession,
  initSettings,
  leaveBlockedReason,
  settingsStore,
} from "./core/session";
import { MEDIA_FILE_EXTENSIONS } from "./core/types";
import { mountHome } from "./home/home";
import { closeErrorDialogs } from "./ui/errors";
import { toast } from "./ui/toast";

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

// Boot: a plain launch paints the home screen immediately; a launch with a
// file opens that file first (core/boot). The editor is a separate chunk,
// prefetched on idle the first time Home is up, so opening a project is
// instant without slowing startup — and a launch that opens a file in the
// viewer never fetches it unless the user goes on to Home.
// The viewer is a separate chunk too, and deliberately NOT prefetched: it is
// only ever reached from File Explorer (or back from a project opened from
// it), and a user who never goes there must not pay for it.

const app = document.getElementById("app")!;

type Disposer = () => void | Promise<void>;
let dispose: Disposer | null = null;
let navToken = 0;

/**
 * Every screen teardown still in flight (see core/open-media `createTeardowns`).
 * `teardowns.settled()` is the unbounded wait the app's close gate wants.
 *
 * A teardown that THROWS is shown, not just logged. Session saves never throw
 * (a failed write is reported through the save state), so a throw means some
 * component's dispose broke part-way — and everything after it in the editor's
 * teardown, the final save included, never ran. That is worth the user's
 * attention, and a toast with details also puts it in Settings → Diagnostics.
 * The next screen still mounts: this used to reject go() and leave #app half
 * torn down.
 */
const teardowns = createTeardowns((e) =>
  toast.error("The previous screen didn't close cleanly.", {
    detail: describeError(e),
    op: "Navigation",
    title: "Close",
  }),
);

/** The mounted viewer, so a second Explorer open swaps the file in place
 *  instead of remounting (ViewerHandle.show). */
let activeViewer: import("./viewer/viewer").ViewerHandle | null = null;

/** The idle editor prefetch has been asked for (once per app lifetime). */
let editorWarmed = false;

/** The viewer left for "Open as project" (an editor route with returnTo) and
 *  asked the backend to keep its folder order for the way back. */
let siblingOrderHeld = false;

async function go(route: Route): Promise<void> {
  const token = ++navToken;
  const prev = dispose;
  dispose = null;
  if (prev) teardowns.track(prev);
  // EVERY navigation waits for every teardown still running, not just its own
  // `prev`. A go() that arrives while an earlier one is mid-dispose finds
  // `dispose` already null; without this it painted over an editor still
  // awaiting its final save, and reopening that same .trt could load the file
  // from before the flush. BOUNDED (TEARDOWN_WAIT_MS): a save hung on an
  // unreachable disk must not freeze every navigation after it, Explorer opens
  // included. Nothing is said when the bound runs out — the teardown is still
  // running and reports its own failure if it ends in one.
  await teardowns.settledWithin(TEARDOWN_WAIT_MS);
  if (token !== navToken) return; // superseded while disposing
  // The folder order held for a viewer → project → viewer round trip goes as
  // soon as the app heads anywhere else (the gear to Settings, Home, another
  // project): a later open of that folder with no Explorer window showing it
  // must not step in a stale order. Back in the viewer, the viewer owns it
  // again (its own dispose drops it). A plain launch never gets here set.
  if (route.view === "editor" && route.returnTo !== undefined) siblingOrderHeld = true;
  else if (route.view === "viewer") siblingOrderHeld = false;
  else if (siblingOrderHeld) {
    siblingOrderHeld = false;
    void ipc.forgetSiblingOrder().catch(() => {});
  }
  // Clearing #app cannot reach an error dialog: those live on document.body so
  // they can sit above everything. A screen that owns one has just closed it in
  // dispose(); this catches the ones nobody owns — a toast's "Details" dialog
  // has no teardown moment of its own, so without this it stays painted over
  // the next screen, still trapping Tab.
  closeErrorDialogs();
  app.innerHTML = "";

  if (route.view === "home") {
    const view = mountHome(app);
    dispose = () => view.dispose();
    // Warm the editor chunk once Home is up — the one screen that leads
    // straight into a project. Not on a launch that opened a file: the viewer
    // never uses it, and it must not compete with that file's first paint.
    if (!editorWarmed) {
      editorWarmed = true;
      requestIdleCallback?.(() => void import("./editor/editor"));
    }
  } else if (route.view === "settings") {
    const { mountSettings } = await import("./settings/settings");
    if (token !== navToken) return;
    const view = mountSettings(app);
    dispose = () => view.dispose();
  } else if (route.view === "viewer") {
    // Lazy and never prefetched: a user who never opens a file from Explorer
    // never pays for the viewer chunk.
    const { mountViewer } = await import("./viewer/viewer");
    if (token !== navToken) return;
    const v = mountViewer(app, route.path);
    activeViewer = v;
    dispose = () => {
      if (activeViewer === v) activeViewer = null;
      v.dispose();
    };
  } else if (route.view === "editor") {
    // The whole route goes through, `temp` and `returnTo` included: every
    // editor exit reads `returnTo` to go back to the viewer's file.
    const { mountEditor } = await import("./editor/editor");
    if (token !== navToken) return;
    const view = await mountEditor(app, route, () => token !== navToken);
    if (token !== navToken) {
      // Tracked like any other teardown. The screen that superseded this mount
      // has usually mounted already (it passed its own wait while this one was
      // still loading), so what this buys is the NEXT navigation and the close
      // gate (`teardowns.settled()`): neither starts on top of a half-closed
      // editor.
      teardowns.track(() => view.dispose());
      return;
    }
    dispose = () => view.dispose();
  } else {
    // A view added to Route without a branch here fails to compile instead of
    // silently mounting nothing.
    const unhandled: never = route;
    void unhandled;
  }
}

// A plain launch paints Home right here, synchronously, as it always has. A
// launch from File Explorer with a media file or a .trt (the Rust-side hint)
// mounts nothing yet: the first file opens once the settings are in, below,
// with Home as the bounded fallback (core/boot).
const launch = beginBoot(hasLaunchHint(window), {
  setNavigator,
  go,
  navCount: () => navToken,
  routeFirst: (path) => runOnOpenChain(() => routeOpenPath(path)),
  enqueue: enqueueOpen,
  reportError: (e) => toast.error(describeError(e)),
});

// OS file-open routing (File Explorer "Open with", a second launch). A ".trt"
// opens that project. A media file goes where Settings → Opening files says:
// the viewer (no project at all), or a TEMPORARY one-clip project in the
// editor. Neither creates anything permanent — the user keeps a temporary
// project only by choosing Keep (owner decision; Home's "New project" is the
// one permanent creation path). Serialized on the open chain (core/open-media)
// so overlapping launches can't interleave two project creations.

async function routeOpenPath(path: string): Promise<void> {
  const ext = fileExt(path);
  const isProject = ext === "trt";
  if (!isProject && !MEDIA_FILE_EXTENSIONS.has(ext)) return; // unknown type: ignore

  // An OS open-path replaces whatever is on screen WITHOUT going through any of
  // the editor's own exits (Back, Ctrl+W, the Settings gear), so it has to
  // honour the same leave gate they do. Without this, opening a second file
  // while a quick-view project is live disposes the editor past its
  // keep/discard prompt: the session flushes into the temp scratch file, which
  // the next launch's temp sweep deletes — and temp projects are excluded from
  // recents, so there is no way back. Resolves true (no gate installed, or the
  // user chose Keep/Discard); false cancels this open entirely, before any
  // project file is created — and false is SAID: a running export refuses by
  // name, and a Cancel on the Keep prompt (or a prompt already open) used to
  // drop the open without a word, which reads as "Explorer did nothing".
  //
  // Sampled BEFORE the gate: a temporary session only gets through it by Keep
  // (relocated to a permanent file) or Discard (disposed, its file deleted).
  // Either way the user has agreed to leave that screen, and the editor left
  // on it no longer edits what it shows — a Discarded one saves nothing, and a
  // Kept one still carries the scratch route. See the catch below.
  const leaving = currentSession.get();
  // Only a temp editor whose gate actually asked: without a guard the leave
  // went through unasked, and that editor is still live — never navigate over it.
  const leavingTemp = leaving?.temp.get() === true && !!leaving.leaveGuard;
  if (!(await confirmLeaveCurrentSession())) {
    const why = leaveBlockedReason();
    const name = fileName(path);
    toast.info(why ? `${why} ${name} wasn't opened.` : `Still editing. ${name} wasn't opened.`);
    return; // settles, so the chain moves on to the next open
  }

  if (isProject) {
    // A .trt that physically lives in the temp-projects dir is a live quick-view
    // scratch file: route it as temp so the editor shows the Temporary badge and
    // applies the keep gate on exit, matching the recents exclusion the backend
    // already enforces for that dir. Anything outside it is a normal project.
    const temp = await isTempProjectPath(path);
    navigate(temp ? { view: "editor", projectPath: path, temp: true } : { view: "editor", projectPath: path });
    return;
  }

  if (settingsStore.get().openWith === "viewer") {
    // A viewer already on screen swaps the file in place: no remount, no
    // reload of the chunk, and the folder is re-listed for the new file.
    if (activeViewer) activeViewer.show(path);
    else navigate({ view: "viewer", path });
    return;
  }

  // "editor": a temporary project in tmp-projects (never in recents) until the
  // user keeps it. Called directly, not through runOnOpenChain: this function
  // already runs on the chain, and a task that awaits the chain awaits itself.
  try {
    const projectPath = await openMediaAsProject(path);
    navigate({ view: "editor", projectPath, temp: true });
  } catch (e) {
    toast.error(describeError(e));
    // The open the user agreed to leave for has failed. An editor whose temp
    // session went through the gate (Kept or Discarded above) and is STILL the
    // screen goes home rather than staying on a dead editor: with Discard its
    // edits would be silently dropped, and its Keep button toasts "already
    // closed". Home is where a finished Keep is visible, in the library. A
    // permanent session (no gate to pass) keeps its editor — nothing happened
    // to it. Only this branch needs the rule: a .trt has navigated already,
    // and an editor that cannot load that file routes itself away (mountEditor);
    // the viewer branches cannot fail here.
    if (leavingTemp && currentSession.get() === leaving) navigate({ view: "home" });
  }
}

/** What the close gate needs from the shell. `settle` is the UNBOUNDED wait on
 *  every screen teardown (an editor's final save included); runCloseFlow puts
 *  its own cap on it, so a teardown hung on a dead disk can delay a close but
 *  never block it. */
const closeDeps: CloseDeps = {
  session: () => currentSession.get(),
  settle: () => teardowns.settled(),
  destroy: destroyWindow,
};

function enqueueOpen(path: string): void {
  // routeOpenPath reports its own failures; the catch only keeps a rejection
  // that escaped it from surfacing as unhandled.
  void runOnOpenChain(() => routeOpenPath(path)).catch(() => {});
}

void (async () => {
  // A failed READ is not the same as a first run, and the difference matters:
  // the store falls back to defaults either way, so without this the app opens
  // looking factory-fresh — every preference, the export folder and every
  // rebound shortcut apparently gone — with nothing said. `updateSettings`
  // now refuses to overwrite a file it could not read, so the real settings
  // survive on disk; this is the half that tells the user why the screen looks
  // wrong, instead of leaving them to conclude their settings were lost.
  const load = await initSettings();
  if (!load.ok) {
    toast.error("Couldn't read your settings.", {
      detail: load.error,
      op: "Settings",
      title: "Load",
    });
  } else if (load.recovered) {
    // settings.json itself was corrupt and the `.bak` supplied the preferences.
    // Nothing is missing and nothing needs doing — but a file was silently
    // repaired underneath the user, and the same courtesy the editor extends
    // for a recovered project applies here.
    toast.info("Your settings were restored from their automatic backup.");
  }
  // The window-close gate (core/app-close). Installed once the settings are
  // in, so a close flow's settings wait covers real writes, not the boot read.
  // Until then — the first moments of a launch — X closes natively, which is
  // safe: nothing can be open yet that a close would lose.
  installCloseGate(closeDeps);
  // A launch file opens first, in place of Home. Its own drain is atomic too,
  // so the one below then sees only paths that arrived after it.
  if (launch) await launch.openQueued(() => ipc.takePendingOpenPaths());
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
  // up even if its wake-up event fired before the listener was ready. AWAITED:
  // the listener registers only after a dynamic import, so a drain sent beside
  // it could be answered first, and a wake-up in between went to nobody — the
  // path then sat queued until some later open. A listener that cannot attach
  // still leaves this drain.
  await onOpenPath(() => void drainOpenPaths()).catch(() => {});
  await drainOpenPaths();
  // One cache trim per plain launch, idle, with Home up. Trims otherwise run
  // only when a job finishes, so a proxy that landed after its editor closed
  // kept the cache over its cap until some later job did. Not on a launch that
  // opened a file: its first screen is still preparing that file (the probe,
  // then the playback plan that marks its cache entry used) while the main
  // thread idles, so a trim then could evict the very remux or proxy it is
  // about to reuse — that launch is left to the job-done trims. Not after a
  // failed settings read either: the limit on hand is then the default, not
  // one the user chose, and trimming to it could empty a cache they sized up.
  if (load.ok && launch === null) {
    requestIdleCallback?.(
      () => void ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, []).catch(() => {}),
    );
  }
})();

// Dev-only in-app E2E harness (activated via TAROTING_AUTOTEST=1).
if (import.meta.env.DEV) {
  // The real close flow with an injected destroy, so the E2E can drive every
  // branch without closing the window it runs in.
  (window as unknown as { __tarotingCloseFlow?: unknown }).__tarotingCloseFlow = (
    destroy: () => Promise<void>,
  ) => runCloseFlow({ ...closeDeps, destroy });
  void (async () => {
    try {
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
