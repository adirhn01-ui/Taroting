// The app's first screen. A plain launch paints Home at once, exactly as it
// always has. A launch from File Explorer with a file the app opens on its own
// (media or a .trt — the Rust side checks the first queued path and stamps
// `window.__tarotingLaunchFile` before any script runs) opens that file FIRST:
// Home is not mounted only to be torn down a moment later, which is a visible
// flash and a recents/thumbnail load competing with the open for nothing.
//
// Pure and injectable: main.ts hands in `go`, the navigator hook and the open
// routing, so every timing rule here is unit-tested without a window. The
// routing itself is NOT here — the first file goes through `routeOpenPath`
// (core/open-route) like any other open (viewer or temporary project by
// Settings → Opening files, a .trt's editor), so there is one copy of the rules.

import type { Route } from "./nav";

/**
 * Longest the window stays on the bare app background waiting for the
 * settings read and the queue drain before Home is painted anyway. Both are
 * normally a few ms; a Roaming %APPDATA% on a stalled network share is not,
 * and a blank window is never the answer. Past it the launch file opens over
 * Home like any other open.
 */
export const HOLD_HOME_MAX_MS = 250;

/**
 * Longest the first open may take BEFORE it navigates — the viewer's route is
 * immediate, but editor mode probes the file and writes a temporary project
 * first. Past it Home is painted and the open still lands over it when it is
 * ready. Once the open has navigated, the screen's own mount is the progress
 * (the same wait as opening a project from Home), and Home is never forced in
 * over it: `go` is token-superseding, so that would cancel the open.
 */
export const OPEN_FIRST_MAX_MS = 1500;

/** The Rust-side flag (main.rs `launch_hint_plugin`). A constant `true` or absent. */
export function hasLaunchHint(w: unknown): boolean {
  return (w as { __tarotingLaunchFile?: unknown } | null)?.__tarotingLaunchFile === true;
}

export interface BootPlan {
  /** The file to open instead of Home; null means Home. */
  first: string | null;
  /** Everything else, in queue order, for the ordinary open chain. */
  rest: string[];
}

/**
 * What to do with the drained launch queue. The type of `paths[0]` is not
 * re-checked: the hint already said it is known, and a file routeOpenPath
 * ignores is caught by "the open settled and nothing navigated" (Home).
 * Home already painted (the hold ran out) or nothing queued (a dev reload
 * re-runs the init script over an empty queue) → Home, and every path opens
 * over it as usual.
 */
export function planBoot(paths: readonly string[], homeShown: boolean): BootPlan {
  const [first, ...rest] = paths;
  if (homeShown || first === undefined) return { first: null, rest: [...paths] };
  return { first, rest };
}

export interface BootDeps {
  setNavigator(nav: (route: Route) => void): void;
  /** main.ts `go`: starts a navigation synchronously (bumping `navCount`), mounts later. */
  go(route: Route): Promise<void>;
  /** main.ts `navToken`: bumped by every `go`, so "unchanged" means nothing navigated. */
  navCount(): number;
  /** The first file through the open chain: `runOnOpenChain(() => routeOpenPath(path))`. */
  routeFirst(path: string): Promise<void>;
  /** main.ts `enqueueOpen`. */
  enqueue(path: string): void;
  /** A failure nothing else reported (a rejected navigation or open): toast it. */
  reportError(e: unknown): void;
}

export interface LaunchBoot {
  /** Called once, after the settings are in and the close gate is installed:
   *  drain the queue, open the first file, hand the rest to the open chain. */
  openQueued(takePaths: () => Promise<string[]>): Promise<void>;
}

/**
 * Start the boot. Either way the navigator OBSERVES each navigation it starts:
 * one that REJECTS (a chunk that failed to load, a mount that threw) is
 * reported and lands on Home instead of leaving #app blank. A plain launch
 * used to install a navigator that dropped the rejection, so a failed
 * navigation there was an unhandled rejection over an already-cleared window,
 * with nothing said and no way back.
 *
 * No hint → that navigator, and Home started synchronously, before any await:
 * today's first two lines of boot, so a test can hold them to it. Returns null.
 *
 * Hint → nothing is mounted yet. The hold timer starts now, so a settings read
 * that hangs — or a boot that throws before `openQueued` — still ends on Home.
 */
export function beginBoot(hint: boolean, deps: BootDeps): LaunchBoot | null {
  // A Home that itself fails is reported, never retried: Home over a failed
  // Home is the same failure again, in a loop.
  const home = (): void => void deps.go({ view: "home" }).catch((e: unknown) => deps.reportError(e));
  deps.setNavigator((route) => {
    const nav = deps.go(route);
    const mine = deps.navCount();
    nav.catch((e: unknown) => {
      deps.reportError(e);
      // Only while it is still the latest navigation: one a newer route has
      // superseded is not what is on screen, and Home over the newer one
      // would cancel it. Not after a failed Home, for the reason above.
      if (deps.navCount() === mine && route.view !== "home") home();
    });
  });

  if (!hint) {
    home();
    return null;
  }

  let homeShown = false;
  let hold: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    hold = null;
    homeShown = true;
    home();
  }, HOLD_HOME_MAX_MS);

  const openFirst = (path: string): void => {
    const before = deps.navCount();
    // Home only while the open has not navigated yet (see OPEN_FIRST_MAX_MS).
    const slow = setTimeout(() => {
      if (deps.navCount() === before) home();
    }, OPEN_FIRST_MAX_MS);
    const settled = (): void => {
      clearTimeout(slow);
      // The open finished without navigating anywhere: it failed (routeOpenPath
      // has toasted why) or the file was not one it opens. Home, not a blank
      // window. If the slow timer already painted Home, navCount moved and
      // Home stays as it is.
      if (deps.navCount() === before) home();
    };
    deps.routeFirst(path).then(settled, (e: unknown) => {
      deps.reportError(e);
      settled();
    });
  };

  return {
    async openQueued(takePaths) {
      let paths: string[] = [];
      try {
        paths = await takePaths();
      } catch {
        /* not in desktop backend — nothing to open */
      }
      if (hold !== null) {
        clearTimeout(hold);
        hold = null;
      }
      const plan = planBoot(paths, homeShown);
      if (plan.first !== null) openFirst(plan.first);
      else if (!homeShown) {
        homeShown = true;
        home();
      }
      // After the first open is on the chain, so these queue behind it in order.
      for (const path of plan.rest) deps.enqueue(path);
    },
  };
}
