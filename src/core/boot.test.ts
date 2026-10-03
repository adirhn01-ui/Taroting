import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOLD_HOME_MAX_MS,
  OPEN_FIRST_MAX_MS,
  beginBoot,
  hasLaunchHint,
  planBoot,
  type BootDeps,
} from "./boot";
import type { Route } from "./nav";

function label(route: Route): string {
  switch (route.view) {
    case "home":
      return "home";
    case "settings":
      return "settings";
    case "viewer":
      return `viewer:${route.path}`;
    case "editor":
      return `editor:${route.projectPath}${route.temp ? "(temp)" : ""}`;
  }
}

/** What the fake routeOpenPath does with the first file, `afterMs` after it starts. */
type FirstOpen =
  // viewer, temp project, .trt: navigates then returns (`navigateAfterMs`
  // earlier than `afterMs` only to widen the gap between the two)
  | { afterMs: number; navigate: Route; navigateAfterMs?: number }
  | { afterMs: number; silent: true } // failed (routeOpenPath toasted) or ignored: no navigation
  | { afterMs: number; reject: string }; // something escaped routeOpenPath

interface Rig {
  deps: BootDeps;
  /** `<ms since boot>:<event>`, in the order things happened. */
  log: string[];
  navigate: (route: Route) => void;
}

/**
 * A fake main.ts. `go` bumps the nav count synchronously like the real one and
 * logs the route; `rejectGo` makes a route's navigation reject (a chunk that
 * failed to load). The fake routeOpenPath navigates through the INSTALLED
 * navigator, as the real one does through `navigate()`.
 */
function rig(first: FirstOpen | null, rejectGo?: (r: Route) => boolean): Rig {
  const t0 = Date.now();
  const log: string[] = [];
  const at = (s: string): void => void log.push(`${Date.now() - t0}:${s}`);
  let nav = 0;
  let navigator: ((r: Route) => void) | null = null;
  const deps: BootDeps = {
    setNavigator: (n) => {
      navigator = n;
    },
    go: (route) => {
      nav++;
      at(label(route));
      return rejectGo?.(route) ? Promise.reject(new Error(`chunk:${label(route)}`)) : Promise.resolve();
    },
    navCount: () => nav,
    routeFirst: (path) => {
      at(`first:${path}`);
      return new Promise<void>((resolve, reject) => {
        if (first && "navigate" in first && first.navigateAfterMs !== undefined) {
          const early = first.navigate;
          setTimeout(() => navigator!(early), first.navigateAfterMs);
        }
        setTimeout(() => {
          if (!first) return resolve();
          if ("navigate" in first) {
            if (first.navigateAfterMs === undefined) navigator!(first.navigate);
            resolve();
          } else if ("silent" in first) resolve();
          else reject(new Error(first.reject));
        }, first?.afterMs ?? 0);
      });
    },
    enqueue: (path) => at(`enqueue:${path}`),
    reportError: (e) => at(`error:${(e as Error).message}`),
  };
  return { deps, log, navigate: (r) => navigator!(r) };
}

function takeAfter(ms: number, paths: string[] | Error): () => Promise<string[]> {
  return () =>
    new Promise((resolve, reject) =>
      setTimeout(() => (paths instanceof Error ? reject(paths) : resolve(paths)), ms),
    );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hasLaunchHint", () => {
  it("is true only for the constant true the Rust script sets", () => {
    expect(hasLaunchHint({ __tarotingLaunchFile: true })).toBe(true);
    for (const v of ["true", 1, {}, null, undefined]) {
      expect(hasLaunchHint({ __tarotingLaunchFile: v }), String(v)).toBe(false);
    }
    expect(hasLaunchHint({})).toBe(false);
    expect(hasLaunchHint(null)).toBe(false);
  });
});

describe("planBoot", () => {
  // Three distinct names and extensions, so first/rest swapped, dropped or
  // re-ordered each fail on their own.
  const A = String.raw`C:\a\clip.mp4`;
  const B = String.raw`D:\b\cut.trt`;
  const C = String.raw`E:\c\song.flac`;
  const q = [A, B, C];
  it.each<{ why: string; paths: string[]; homeShown: boolean; first: string | null; rest: string[] }>([
    { why: "first file opens, the rest keep queue order", paths: q, homeShown: false, first: A, rest: [B, C] },
    { why: "a lone .trt", paths: [B], homeShown: false, first: B, rest: [] },
    { why: "Home already shown: everything opens over it", paths: q, homeShown: true, first: null, rest: q },
    { why: "empty queue (dev reload): Home", paths: [], homeShown: false, first: null, rest: [] },
  ])("$why", ({ paths, homeShown, first, rest }) => {
    expect(planBoot(paths, homeShown)).toEqual({ first, rest });
  });
});

describe("beginBoot without the hint", () => {
  it("installs the plain navigator and starts Home synchronously, before any await", () => {
    const r = rig(null);
    const launch = beginBoot(false, r.deps);
    // Asserted with no await in between: this is today's boot, and a first
    // screen that waited on anything here would be a slower plain launch.
    expect(r.log).toEqual(["0:home"]);
    expect(launch).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    r.navigate({ view: "settings" });
    expect(r.log).toEqual(["0:home", "0:settings"]);
  });
});

describe("beginBoot with the hint", () => {
  const MP4 = String.raw`C:\Users\Ann\Videos\holiday.mp4`;
  const MKV = String.raw`D:\clips\raw take.mkv`;
  const TRT = String.raw`E:\Projects\cut.trt`;
  const FLAC = String.raw`F:\music\song.flac`;
  const PNG = String.raw`G:\pics\shot.png`;
  const TEMP = String.raw`T:\tmp-projects\raw take.trt`;

  // The rows below use literal times, so these are pinned here once: a
  // changed bound is a decision (§4.3 measures against them), not a drift.
  it("bounds: 250 ms for the settings read, 1500 ms for an open to navigate", () => {
    expect(HOLD_HOME_MAX_MS).toBe(250);
    expect(OPEN_FIRST_MAX_MS).toBe(1500);
  });

  it("does not mount Home at boot", () => {
    const r = rig(null);
    expect(beginBoot(true, r.deps)).not.toBeNull();
    expect(r.log).toEqual([]);
  });

  // Every row has its own drain time and open time, and none of them lands
  // on a multiple of the two bounds, so a swapped constant, a Home painted at
  // the wrong moment, or the rest queued out of order each changes the log.
  it.each<{ why: string; paths: string[] | Error; takeMs: number; first: FirstOpen | null; log: string[] }>([
    {
      why: "viewer mode, media: straight into the viewer, the rest after it",
      paths: [MP4, TRT],
      takeMs: 30,
      first: { afterMs: 12, navigate: { view: "viewer", path: MP4 } },
      log: [`30:first:${MP4}`, `30:enqueue:${TRT}`, `42:viewer:${MP4}`],
    },
    {
      why: "editor mode, slow probe: Home at the open bound, the open still lands over it",
      paths: [MKV],
      takeMs: 60,
      first: { afterMs: 1800, navigate: { view: "editor", projectPath: TEMP, temp: true } },
      log: [`60:first:${MKV}`, "1560:home", `1860:editor:${TEMP}(temp)`],
    },
    {
      why: "editor mode, quick probe: the temporary project and no Home",
      paths: [MKV, PNG],
      takeMs: 45,
      first: { afterMs: 700, navigate: { view: "editor", projectPath: TEMP, temp: true } },
      log: [`45:first:${MKV}`, `45:enqueue:${PNG}`, `745:editor:${TEMP}(temp)`],
    },
    {
      why: ".trt: its editor, the rest in queue order",
      paths: [TRT, FLAC, PNG],
      takeMs: 90,
      first: { afterMs: 5, navigate: { view: "editor", projectPath: TRT } },
      log: [`90:first:${TRT}`, `90:enqueue:${FLAC}`, `90:enqueue:${PNG}`, `95:editor:${TRT}`],
    },
    {
      why: "empty queue: Home as soon as that is known",
      paths: [],
      takeMs: 120,
      first: null,
      log: ["120:home"],
    },
    {
      why: "a failed drain reads as an empty queue",
      paths: new Error("no backend"),
      takeMs: 75,
      first: null,
      log: ["75:home"],
    },
    {
      why: "hold ran out first: Home, then every path opens over it",
      paths: [MP4, TRT],
      takeMs: 300,
      first: null,
      log: ["250:home", `300:enqueue:${MP4}`, `300:enqueue:${TRT}`],
    },
    {
      why: "the open failed without navigating (routeOpenPath toasted): Home at once",
      paths: [MKV],
      takeMs: 40,
      first: { afterMs: 600, silent: true },
      log: [`40:first:${MKV}`, "640:home"],
    },
    {
      why: "a rejection escaped the open: reported, then Home",
      paths: [MP4],
      takeMs: 20,
      first: { afterMs: 900, reject: "probe blew up" },
      log: [`20:first:${MP4}`, "920:error:probe blew up", "920:home"],
    },
  ])("$why", async ({ paths, takeMs, first, log }) => {
    const r = rig(first);
    const launch = beginBoot(true, r.deps)!;
    void launch.openQueued(takeAfter(takeMs, paths));
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.log).toEqual(log);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds Home back exactly HOLD_HOME_MAX_MS while the settings read hangs", async () => {
    const r = rig(null);
    beginBoot(true, r.deps);
    await vi.advanceTimersByTimeAsync(249);
    expect(r.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.log).toEqual(["250:home"]);
  });

  it("waits exactly OPEN_FIRST_MAX_MS for an open that has not navigated", async () => {
    const r = rig({ afterMs: 4000, silent: true });
    void beginBoot(true, r.deps)!.openQueued(async () => [MKV]);
    await vi.advanceTimersByTimeAsync(1499);
    expect(r.log).toEqual([`0:first:${MKV}`]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.log).toEqual([`0:first:${MKV}`, "1500:home"]);
    // The open settling later without navigating must not paint Home twice.
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.log).toEqual([`0:first:${MKV}`, "1500:home"]);
  });

  // The invariant the open bound must never break: `go` supersedes by token,
  // so Home forced in after the open has navigated would CANCEL that open.
  // routeOpenPath returns right after navigating, but the promise reaching
  // boot still passes through the chain; this row stretches that gap past the
  // bound so the check itself is what keeps Home out.
  it("never forces Home over an open that has already navigated", async () => {
    const r = rig({ afterMs: 3000, navigate: { view: "editor", projectPath: TRT }, navigateAfterMs: 400 });
    void beginBoot(true, r.deps)!.openQueued(takeAfter(35, [TRT]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.log).toEqual([`35:first:${TRT}`, `435:editor:${TRT}`]);
  });

  it("a navigation that rejects (chunk failed to load) is reported and lands on Home", async () => {
    const r = rig({ afterMs: 25, navigate: { view: "viewer", path: MP4 } }, (route) => route.view === "viewer");
    void beginBoot(true, r.deps)!.openQueued(takeAfter(15, [MP4]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.log).toEqual([`15:first:${MP4}`, `40:viewer:${MP4}`, `40:error:chunk:viewer:${MP4}`, "40:home"]);
  });

  it("a rejected navigation a newer one superseded is reported but does not pull Home over it", async () => {
    const r = rig(null, (route) => route.view === "settings");
    beginBoot(true, r.deps);
    // Both start in the same tick; the settings one rejects on the microtask
    // queue after the editor navigation has already begun.
    r.navigate({ view: "settings" });
    r.navigate({ view: "editor", projectPath: TRT });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toEqual(["0:settings", `0:editor:${TRT}`, "0:error:chunk:settings"]);
  });
});

/**
 * A plain launch used to install a navigator that dropped the rejection: a
 * navigation whose mount threw left #app cleared, nothing said, and an
 * unhandled rejection behind it. Both launch kinds now observe the same way.
 */
describe("beginBoot without the hint, when a navigation fails", () => {
  const TRT = String.raw`H:\Edits\trailer.trt`;

  it("reports the failure and lands on Home", async () => {
    const r = rig(null, (route) => route.view === "editor");
    beginBoot(false, r.deps);
    r.navigate({ view: "editor", projectPath: TRT });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toEqual(["0:home", `0:editor:${TRT}`, `0:error:chunk:editor:${TRT}`, "0:home"]);
  });

  it("does not pull Home over a newer navigation", async () => {
    const r = rig(null, (route) => route.view === "settings");
    beginBoot(false, r.deps);
    r.navigate({ view: "settings" });
    r.navigate({ view: "editor", projectPath: TRT });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toEqual(["0:home", "0:settings", `0:editor:${TRT}`, "0:error:chunk:settings"]);
  });

  it("a Home that fails is reported once and never retried", async () => {
    const r = rig(null, (route) => route.view === "home");
    beginBoot(false, r.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toEqual(["0:home", "0:error:chunk:home"]);
    r.navigate({ view: "home" }); // the Back button, say
    await vi.advanceTimersByTimeAsync(0);
    expect(r.log).toEqual(["0:home", "0:error:chunk:home", "0:home", "0:error:chunk:home"]);
  });
});
