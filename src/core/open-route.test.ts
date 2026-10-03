import { describe, expect, it } from "vitest";
import type { Route } from "./nav";
import { createOpenRouter, type OpenRouteDeps } from "./open-route";
import type { ProjectSession } from "./session";

/**
 * routeOpenPath is the path File Explorer opens go through — including the one
 * a user reported — and it used to live in main.ts, where importing it runs the
 * whole app. Only a fake of it was ever exercised (boot.test.ts), so breaking
 * its catch branch or its leave gate kept every suite green.
 *
 * Every row differs on every axis the router could confuse: each path has its
 * own drive, folder, name and extension; the session kinds, the gate's answer,
 * the block reason and the open mode all vary independently; and each row
 * expects exactly one outcome (a navigation, a viewer swap, or nothing) and at
 * most one toast, so a crossed branch shows as a wrong label, not a near miss.
 */

const TRT = String.raw`D:\cuts\a.trt`;
const TEMP_TRT = String.raw`T:\tmp-projects\b.trt`;
const MP4 = String.raw`E:\v\c.mp4`;
const PNG = String.raw`F:\p\d.png`;
const TXT = String.raw`G:\n\e.txt`;
const OPENED = String.raw`T:\tmp-projects\c-1f3a.trt`;

type SessionKind = "none" | "permanent" | "temp-unedited" | "temp-edited" | "temp-unguarded";
type Gate = "proceed" | "cancel";

interface Row {
  why: string;
  session: SessionKind;
  gate: Gate;
  blocked?: string;
  openWith: "viewer" | "editor";
  viewerUp?: boolean;
  path: string;
  /** what openMediaAsProject does */
  open?: "ok" | "throws";
  /** the gate replaced the screen's session before the open failed */
  sessionGoneAfterGate?: boolean;
  /** expected: navigations, viewer swaps and toasts, in order */
  log: string[];
  asked: number;
}

function fakeSession(kind: SessionKind): ProjectSession | null {
  if (kind === "none") return null;
  const temp = kind !== "permanent";
  const guard = kind === "temp-unedited" || kind === "temp-edited" ? async () => true : null;
  return { temp: { get: () => temp }, leaveGuard: guard } as unknown as ProjectSession;
}

function label(r: Route): string {
  switch (r.view) {
    case "editor":
      return `nav:editor:${r.projectPath}${r.temp ? "(temp)" : ""}`;
    case "viewer":
      return `nav:viewer:${r.path}`;
    default:
      return `nav:${r.view}`;
  }
}

function rig(row: Row): { route: (path: string) => Promise<void>; log: string[]; asked: () => number } {
  const log: string[] = [];
  let current = fakeSession(row.session);
  let asked = 0;
  const deps: OpenRouteDeps = {
    navigate: (r) => void log.push(label(r)),
    currentSession: () => current,
    confirmLeave: async () => {
      asked++;
      if (row.blocked) return false;
      if (row.sessionGoneAfterGate) current = fakeSession("permanent");
      return row.gate === "proceed";
    },
    leaveBlockedReason: () => row.blocked ?? null,
    isTempProjectPath: async (p) => p.startsWith("T:\\tmp-projects\\"),
    openMediaAsProject: async (p) => {
      if (row.open === "throws") throw new Error(`ffprobe could not read ${p}`);
      return OPENED;
    },
    openWith: () => row.openWith,
    activeViewer: () => (row.viewerUp ? { show: (p: string) => void log.push(`show:${p}`) } : null),
    toast: {
      info: (m) => void log.push(`info:${m}`),
      error: (m) => void log.push(`error:${m}`),
      refuse: (m) => void log.push(`refuse:${m}`),
    },
  };
  return { route: createOpenRouter(deps), log, asked: () => asked };
}

describe("routeOpenPath", () => {
  it.each<Row>([
    {
      why: "a .trt with nothing open: its editor",
      session: "none",
      gate: "proceed",
      openWith: "viewer",
      path: TRT,
      log: [`nav:editor:${TRT}`],
      asked: 1,
    },
    {
      why: "a .trt inside tmp-projects opens as a temporary project",
      session: "permanent",
      gate: "proceed",
      openWith: "editor",
      path: TEMP_TRT,
      log: [`nav:editor:${TEMP_TRT}(temp)`],
      asked: 1,
    },
    {
      why: "Cancel on the Keep question: nothing opens, and it is said",
      session: "temp-edited",
      gate: "cancel",
      openWith: "editor",
      path: MP4,
      open: "ok",
      log: ["info:Still editing. c.mp4 wasn't opened."],
      asked: 1,
    },
    {
      why: "Stay after a permanent project's save failed: nothing opens, and it is said",
      session: "permanent",
      gate: "cancel",
      openWith: "viewer",
      path: TRT,
      log: ["info:Still editing. a.trt wasn't opened."],
      asked: 1,
    },
    {
      why: "a running export refuses by name",
      session: "temp-edited",
      gate: "proceed",
      blocked: "An export is running.",
      openWith: "viewer",
      path: PNG,
      log: ["refuse:An export is running. d.png wasn't opened."],
      asked: 1,
    },
    {
      why: "viewer mode with a viewer up: the file swaps in place",
      session: "none",
      gate: "proceed",
      openWith: "viewer",
      viewerUp: true,
      path: MP4,
      log: [`show:${MP4}`],
      asked: 1,
    },
    {
      why: "viewer mode with no viewer: the viewer route",
      session: "permanent",
      gate: "proceed",
      openWith: "viewer",
      path: PNG,
      log: [`nav:viewer:${PNG}`],
      asked: 1,
    },
    {
      why: "editor mode: a temporary project, even with a viewer up",
      session: "temp-unedited",
      gate: "proceed",
      openWith: "editor",
      viewerUp: true,
      path: MP4,
      open: "ok",
      log: [`nav:editor:${OPENED}(temp)`],
      asked: 1,
    },
    {
      why: "editor mode, the open fails after a temp editor was let go: error, then Home",
      session: "temp-edited",
      gate: "proceed",
      openWith: "editor",
      path: PNG,
      open: "throws",
      log: [`error:ffprobe could not read ${PNG}`, "nav:home"],
      asked: 1,
    },
    {
      why: "editor mode, the open fails over a permanent project: error, and its editor stays",
      session: "permanent",
      gate: "proceed",
      openWith: "editor",
      path: MP4,
      open: "throws",
      log: [`error:ffprobe could not read ${MP4}`],
      asked: 1,
    },
    {
      why: "the open fails but another screen already replaced the temp editor: no Home over it",
      session: "temp-edited",
      gate: "proceed",
      openWith: "editor",
      path: MP4,
      open: "throws",
      sessionGoneAfterGate: true,
      log: [`error:ffprobe could not read ${MP4}`],
      asked: 1,
    },
    {
      why: "a temp session with no gate was never asked: a failed open leaves it alone",
      session: "temp-unguarded",
      gate: "proceed",
      openWith: "editor",
      path: PNG,
      open: "throws",
      log: [`error:ffprobe could not read ${PNG}`],
      asked: 1,
    },
    {
      why: "an unknown type is ignored before anything is asked",
      session: "temp-edited",
      gate: "proceed",
      openWith: "editor",
      path: TXT,
      open: "ok",
      log: [],
      asked: 0,
    },
  ])("$why", async (row) => {
    const r = rig(row);
    await expect(r.route(row.path)).resolves.toBeUndefined();
    expect(r.log).toEqual(row.log);
    expect(r.asked()).toBe(row.asked);
  });
});
