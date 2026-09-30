import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ipc } from "../core/ipc";
import { addMarkerAt, createProject } from "../core/project";
import { ProjectSession } from "../core/session";
import {
  createTempExits,
  createTempLeaveGateWith,
  discardTempSession,
  keepTempSession,
  type KeepChoice,
} from "./temp-project";
import { toast } from "./toast";

// The toast host needs a DOM; vitest runs in node. Only the calls matter here.
vi.mock("./toast", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

/**
 * The leave gate every exit from a temporary project goes through: Back, Ctrl+W,
 * the Settings gear, and (through `session.leaveGuard`) an OS open-path from
 * File Explorer. Two properties are load-bearing and each has cost a real bug:
 *
 * - EXACTLY ONE of dest / onCancel fires, on every path. An OS open awaits the
 *   gate as a promise; a path that fired neither stalled the open queue for the
 *   rest of the session, and one that fired both would navigate AND report a
 *   refusal.
 * - Discard stops the session BEFORE deleting its file. Otherwise the editor's
 *   dispose flush (which targets the same temp path) resurrects the file.
 *
 * The modal itself cannot run here (no DOM), so the prompt is injected.
 */

/* Fixtures differ on every axis the code could confuse: the temp path and the
 * kept path are in different folders under different names, and neither is
 * derived from the project name, so an assertion that one path was used can
 * never pass because the other happened to be spelled the same. */
const TEMP_DIR = "C:\\Users\\adirh\\AppData\\Local\\Taroting\\tmp-projects";
const TEMP_PATH = `${TEMP_DIR}\\holiday-in-crete.trt`;
const KEPT_PATH = "C:\\Users\\adirh\\Documents\\Taroting\\Ferry day 2.trt";
const PROJECT_NAME = "Ferry day";

function installGlobalStubs(): void {
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id?: number) => globalThis.clearInterval(id),
  });
}

/** Let every queued promise continuation run. */
const settle = (): Promise<void> => new Promise((r) => globalThis.setTimeout(r, 0));

/** Records the outcome callbacks of one confirmLeave call. */
function outcome(): { dest: () => void; cancel: () => void; dests: number; cancels: number } {
  const o = {
    dests: 0,
    cancels: 0,
    dest: () => {
      o.dests++;
    },
    cancel: () => {
      o.cancels++;
    },
  };
  return o;
}

/** A prompt whose answer the test gives later. */
function deferredAsk(): {
  ask: () => Promise<KeepChoice>;
  answer: (c: KeepChoice) => void;
  calls: () => number;
} {
  let calls = 0;
  let answer: (c: KeepChoice) => void = () => {};
  return {
    ask: () => {
      calls++;
      return new Promise<KeepChoice>((resolve) => {
        answer = resolve;
      });
    },
    answer: (c) => answer(c),
    calls: () => calls,
  };
}

/** Holds the NEXT deleteProject open until the test releases it, so a test can
 *  act inside the window between the session change and the delete landing. */
function deferDelete(): () => void {
  let release: () => void = () => {};
  vi.mocked(ipc.deleteProject).mockImplementationOnce((path: string) => {
    order.push(`deleteProject:${path}`);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  return () => release();
}

let sessions: ProjectSession[] = [];
let order: string[] = [];

/** A temporary session the user has EDITED (the case the prompt is for), or,
 *  with `edited: false`, one nobody has touched — which leaves without a
 *  question, as the window close already did. */
function tempSession(opts: { edited?: boolean } = {}): ProjectSession {
  const s = new ProjectSession(TEMP_PATH, createProject(PROJECT_NAME), { temp: true });
  if (opts.edited !== false) s.replace(addMarkerAt(s.project, 0.25).project);
  sessions.push(s);
  return s;
}

/** relocate() is ProjectSession's own (tested in session.test.ts). Here it only
 *  has to MOVE the path the way the real one does, so an implementation that
 *  read `session.path` after relocating would delete the kept file. */
function fakeRelocate(s: ProjectSession, fail?: Error): void {
  vi.spyOn(s, "relocate").mockImplementation(async (dest: string) => {
    order.push(`relocate:${dest}`);
    if (fail) throw fail;
    (s as unknown as { _path: string })._path = dest;
  });
}

beforeEach(() => {
  installGlobalStubs();
  order = [];
  vi.mocked(toast.error).mockClear();
  vi.spyOn(ipc, "newProjectPath").mockImplementation(async (name?: string) => {
    order.push(`newProjectPath:${name}`);
    return KEPT_PATH;
  });
  vi.spyOn(ipc, "deleteProject").mockImplementation(async (path: string) => {
    order.push(`deleteProject:${path}`);
  });
  // discardTempSession deletes only inside this dir (open-media caches the
  // first answer for the run, so every test must give the same one).
  vi.spyOn(ipc, "tempProjectsDir").mockResolvedValue(TEMP_DIR);
});

afterEach(() => {
  for (const s of sessions) s.discard(); // stops the autosave interval
  sessions = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createTempLeaveGateWith — an untouched temporary project", () => {
  it("leaves without asking: the scratch file is discarded, then dest fires once", async () => {
    const s = tempSession({ edited: false });
    expect(s.edited).toBe(false);
    const ask = vi.fn(async (): Promise<KeepChoice> => "keep");
    const o = outcome();
    createTempLeaveGateWith(s, ask).confirmLeave(o.dest, o.cancel);
    await settle();
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(order).toEqual([`deleteProject:${TEMP_PATH}`]);
    expect([o.dests, o.cancels]).toEqual([1, 0]);
  });

  it("an OS open or the window close (confirm) proceeds without asking", async () => {
    const s = tempSession({ edited: false });
    const ask = vi.fn(async (): Promise<KeepChoice> => "cancel");
    await expect(createTempLeaveGateWith(s, ask).confirm()).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(order).toEqual([`deleteProject:${TEMP_PATH}`]);
  });

  it("a decoded-size fix-up the user did not make (edit: false) is still untouched", async () => {
    const s = tempSession({ edited: false });
    s.replace(addMarkerAt(s.project, 0.5).project, { edit: false });
    const ask = vi.fn(async (): Promise<KeepChoice> => "cancel");
    const o = outcome();
    createTempLeaveGateWith(s, ask).confirmLeave(o.dest, o.cancel);
    await settle();
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect([o.dests, o.cancels]).toEqual([1, 0]);
  });

  it("one real edit brings the question back", async () => {
    const s = tempSession({ edited: false });
    s.replace(addMarkerAt(s.project, 0.75).project);
    const ask = vi.fn(async (): Promise<KeepChoice> => "cancel");
    const o = outcome();
    createTempLeaveGateWith(s, ask).confirmLeave(o.dest, o.cancel);
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);
    expect([o.dests, o.cancels]).toEqual([0, 1]);
  });
});

describe("createTempLeaveGateWith — exactly one of dest / onCancel", () => {
  it("a permanent session leaves at once and is never asked", () => {
    const s = new ProjectSession(KEPT_PATH, createProject(PROJECT_NAME));
    sessions.push(s);
    const ask = vi.fn(async (): Promise<KeepChoice> => "discard");
    const o = outcome();
    createTempLeaveGateWith(s, ask).confirmLeave(o.dest, o.cancel);
    // synchronous: nothing to wait for on a permanent project
    expect([o.dests, o.cancels]).toEqual([1, 0]);
    expect(ask).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("cancel stays put, touches nothing, and frees the gate for a second try", async () => {
    const s = tempSession();
    const discard = vi.spyOn(s, "discard");
    const d = deferredAsk();
    const gate = createTempLeaveGateWith(s, d.ask);
    const o = outcome();
    gate.confirmLeave(o.dest, o.cancel);
    expect(gate.busy).toBe(true);
    d.answer("cancel");
    await settle();
    expect([o.dests, o.cancels]).toEqual([0, 1]);
    expect(gate.busy).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(s.temp.get()).toBe(true);
    // the latch really was released: the next exit asks again
    gate.confirmLeave(() => {}, () => {});
    expect(d.calls()).toBe(2);
  });

  it("keep relocates to a new library path, drops the temp flag, deletes the OLD file, then leaves", async () => {
    const s = tempSession();
    fakeRelocate(s);
    const gate = createTempLeaveGateWith(s, async () => "keep");
    const o = outcome();
    gate.confirmLeave(() => {
      order.push(`dest temp=${s.temp.get()}`);
      o.dest();
    }, o.cancel);
    await settle();
    expect([o.dests, o.cancels]).toEqual([1, 0]);
    expect(order).toEqual([
      `newProjectPath:${PROJECT_NAME}`,
      `relocate:${KEPT_PATH}`,
      `deleteProject:${TEMP_PATH}`,
      "dest temp=false",
    ]);
    expect(s.path).toBe(KEPT_PATH);
    expect(gate.busy).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a failed keep toasts, stays temp at the old path, deletes nothing, and fires only onCancel", async () => {
    const s = tempSession();
    fakeRelocate(s, new Error("disk full"));
    const ask = vi.fn(async (): Promise<KeepChoice> => "keep");
    const gate = createTempLeaveGateWith(s, ask);
    const o = outcome();
    gate.confirmLeave(o.dest, o.cancel);
    await settle();
    expect([o.dests, o.cancels]).toEqual([0, 1]);
    expect(s.temp.get()).toBe(true);
    expect(s.path).toBe(TEMP_PATH);
    expect(order.some((e) => e.startsWith("deleteProject:"))).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0]![0]).toContain("disk full");
    // the user stays with their work and may try again
    expect(gate.busy).toBe(false);
    gate.confirmLeave(() => {}, () => {});
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("an exit DURING a discard bails; once the discard is done every exit passes straight through", async () => {
    const s = tempSession();
    const release = deferDelete();
    const d = deferredAsk();
    const gate = createTempLeaveGateWith(s, d.ask);
    const o = outcome();
    gate.confirmLeave(o.dest, o.cancel);
    d.answer("discard");
    await settle();
    // The window is real: the session is stopped, its file's delete in flight.
    expect(order).toEqual([`deleteProject:${TEMP_PATH}`]);
    expect([o.dests, o.cancels]).toEqual([0, 0]);
    // An exit racing the teardown must bail, not ask again.
    const racing = outcome();
    gate.confirmLeave(racing.dest, racing.cancel);
    expect([racing.dests, racing.cancels]).toEqual([0, 1]);
    release();
    await settle();
    expect([o.dests, o.cancels]).toEqual([1, 0]);
    // An OS open asks the gate BEFORE it probes the file; if that file then
    // fails to open it stays on this screen. The gate must not strand the user
    // there: the discarded project has nothing left to lose, so Back, the gear,
    // and the window close all get through — without asking again.
    const later = outcome();
    gate.confirmLeave(later.dest, later.cancel);
    expect([later.dests, later.cancels]).toEqual([1, 0]);
    await expect(gate.confirm()).resolves.toBe(true);
    expect(d.calls()).toBe(1);
    expect(gate.busy).toBe(false);
  });

  it("an exit while Keep is still deleting the scratch file bails, and Keep's own dest fires exactly once", async () => {
    // Keep drops the temp flag BEFORE it awaits the scratch file's delete. An
    // exit in that window used to see a permanent session and pass straight
    // through — then Keep's dest() navigated home over it, losing an OS open.
    const s = tempSession();
    fakeRelocate(s);
    const release = deferDelete();
    const gate = createTempLeaveGateWith(s, async () => "keep");
    const first = outcome();
    gate.confirmLeave(first.dest, first.cancel);
    await settle();
    // The window is real: relocated, flag dropped, delete still pending.
    expect(s.temp.get()).toBe(false);
    expect(order[order.length - 1]).toBe(`deleteProject:${TEMP_PATH}`);
    expect([first.dests, first.cancels]).toEqual([0, 0]);
    const racing = outcome();
    gate.confirmLeave(racing.dest, racing.cancel);
    expect([racing.dests, racing.cancels]).toEqual([0, 1]);
    release();
    await settle();
    expect([first.dests, first.cancels]).toEqual([1, 0]);
    expect([racing.dests, racing.cancels]).toEqual([0, 1]);
    // Kept for good now: the next exit leaves at once.
    const fresh = outcome();
    gate.confirmLeave(fresh.dest, fresh.cancel);
    expect([fresh.dests, fresh.cancels]).toEqual([1, 0]);
  });

  it("a second exit while the prompt is open bails with onCancel and never opens a second prompt", async () => {
    const s = tempSession();
    const d = deferredAsk();
    const gate = createTempLeaveGateWith(s, d.ask);
    const first = outcome();
    const second = outcome();
    gate.confirmLeave(first.dest, first.cancel); // Back
    gate.confirmLeave(second.dest, second.cancel); // then the gear
    expect([second.dests, second.cancels]).toEqual([0, 1]);
    expect(d.calls()).toBe(1);
    d.answer("cancel");
    await settle();
    expect([first.dests, first.cancels]).toEqual([0, 1]);
  });

  it("a prompt that throws is a cancel, not a hang", async () => {
    const s = tempSession();
    const gate = createTempLeaveGateWith(s, () => Promise.reject(new Error("no DOM")));
    const o = outcome();
    gate.confirmLeave(o.dest, o.cancel);
    await settle();
    expect([o.dests, o.cancels]).toEqual([0, 1]);
    expect(gate.busy).toBe(false);
  });

  describe("a callback that throws never strands the gate", () => {
    // The throw is reported (not left as an unhandled rejection), the latch is
    // already released, and a later confirm() still settles.
    let logged: MockInstance<typeof console.error>;
    beforeEach(() => {
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    const boom = new Error("dest blew up");
    const throwing = (): never => {
      throw boom;
    };

    it("after Keep", async () => {
      const s = tempSession();
      fakeRelocate(s);
      const gate = createTempLeaveGateWith(s, async () => "keep");
      const o = outcome();
      gate.confirmLeave(throwing, o.cancel);
      await settle();
      expect(o.cancels).toBe(0);
      expect(gate.busy).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.any(String), boom);
      await expect(gate.confirm()).resolves.toBe(true);
    });

    it("after Discard", async () => {
      const s = tempSession();
      const ask = vi.fn(async (): Promise<KeepChoice> => "discard");
      const gate = createTempLeaveGateWith(s, ask);
      gate.confirmLeave(throwing, () => {});
      await settle();
      expect(gate.busy).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.any(String), boom);
      await expect(gate.confirm()).resolves.toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it("on cancel (a throwing onCancel)", async () => {
      const s = tempSession();
      const ask = vi.fn(async (): Promise<KeepChoice> => "cancel");
      const gate = createTempLeaveGateWith(s, ask);
      const o = outcome();
      gate.confirmLeave(o.dest, throwing);
      await settle();
      expect(o.dests).toBe(0);
      expect(gate.busy).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.any(String), boom);
      await expect(gate.confirm()).resolves.toBe(false);
      expect(ask).toHaveBeenCalledTimes(2); // really re-asked, not bailed on a latch
    });

    it("a failed Keep whose error toast itself throws still fires onCancel", async () => {
      const s = tempSession();
      fakeRelocate(s, new Error("disk full"));
      vi.mocked(toast.error).mockImplementationOnce(() => {
        throw new Error("no toast host");
      });
      const gate = createTempLeaveGateWith(s, async () => "keep");
      await expect(gate.confirm()).resolves.toBe(false);
      await settle();
      expect(gate.busy).toBe(false);
      expect(s.temp.get()).toBe(true);
    });
  });

  it("confirm() resolves true to proceed and false to stay (the leaveGuard contract)", async () => {
    const kept = tempSession();
    fakeRelocate(kept);
    await expect(createTempLeaveGateWith(kept, async () => "keep").confirm()).resolves.toBe(true);
    const stayed = tempSession();
    await expect(createTempLeaveGateWith(stayed, async () => "cancel").confirm()).resolves.toBe(
      false,
    );
  });
});

describe("discardTempSession / keepTempSession", () => {
  it("discard stops the session BEFORE deleting its temp file", async () => {
    const s = tempSession();
    vi.spyOn(s, "discard").mockImplementation(() => {
      order.push("discard");
    });
    await discardTempSession(s);
    expect(order).toEqual(["discard", `deleteProject:${TEMP_PATH}`]);
  });

  it("discard after a Keep relocated the session into the library never deletes the kept file", async () => {
    // A Keep (the badge's, or a gate's) racing a close-time discard: by the
    // time the discard runs, session.path is the library file. Deleting it
    // would undo the Keep and lose the project.
    const s = tempSession();
    fakeRelocate(s);
    await keepTempSession(s);
    expect(s.path).toBe(KEPT_PATH);
    const discard = vi.spyOn(s, "discard");
    order = [];
    await discardTempSession(s);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);
  });

  it("discard never throws when the delete fails (the startup sweep catches the file)", async () => {
    const s = tempSession();
    vi.mocked(ipc.deleteProject).mockRejectedValueOnce(new Error("sharing violation"));
    await expect(discardTempSession(s)).resolves.toBeUndefined();
  });

  it("with the REAL relocate, the kept file is written before the scratch file is deleted", async () => {
    // The one ordering that loses work if it flips: delete the temp .trt first
    // and a failed write to the library leaves the user with neither copy.
    const s = tempSession();
    vi.spyOn(ipc, "saveProject").mockImplementation(async (path: string) => {
      order.push(`saveProject:${path}`);
      return { modifiedAt: "2026-09-29T08:15:00.000Z" };
    });
    await expect(keepTempSession(s)).resolves.toBe(KEPT_PATH);
    expect(order).toEqual([
      `newProjectPath:${PROJECT_NAME}`,
      `saveProject:${KEPT_PATH}`,
      `deleteProject:${TEMP_PATH}`,
    ]);
    expect(s.path).toBe(KEPT_PATH);
    expect(s.temp.get()).toBe(false);
  });

  it("keep returns the new path and survives a failed delete of the scratch file", async () => {
    const s = tempSession();
    fakeRelocate(s);
    vi.mocked(ipc.deleteProject).mockRejectedValueOnce(new Error("sharing violation"));
    await expect(keepTempSession(s)).resolves.toBe(KEPT_PATH);
    expect(s.temp.get()).toBe(false);
  });
});

/**
 * Keep WITHOUT leaving — the editor's Temporary badge — shares one latch with
 * the leave gate. The failure it exists to prevent: Back (or an OS open, or the
 * window close) landing while the badge's Keep is still relocating reaches an
 * idle gate on a still-temp session, prompts again, and a second Keep then
 * relocates from where the first already moved autosave — deleting the FIRST
 * kept file as its "scratch" file.
 */
describe("createTempExits — in-place Keep behind the leave gate", () => {
  beforeEach(() => {
    vi.mocked(toast.info).mockClear();
  });

  /** relocate() that moves the path only when the test says so. */
  function heldRelocate(s: ProjectSession, fail?: Error): () => void {
    let release: () => void = () => {};
    vi.spyOn(s, "relocate").mockImplementation(async (dest: string) => {
      order.push(`relocate:${dest}`);
      await new Promise<void>((r) => {
        release = r;
      });
      if (fail) throw fail;
      (s as unknown as { _path: string })._path = dest;
    });
    return () => release();
  }

  it("Back during a badge Keep waits for it, then leaves WITHOUT a prompt; one Keep, the kept file survives", async () => {
    const s = tempSession();
    const release = heldRelocate(s);
    const d = deferredAsk();
    const exits = createTempExits(s, createTempLeaveGateWith(s, d.ask));
    const kept = exits.keep();
    await settle();
    // the Keep is mid-relocate: still temp, nothing deleted yet
    expect(s.temp.get()).toBe(true);
    const back = outcome();
    exits.confirmLeave(back.dest, back.cancel);
    await settle();
    expect([back.dests, back.cancels]).toEqual([0, 0]);
    expect(d.calls()).toBe(0);
    release();
    await expect(kept).resolves.toBe("kept");
    await settle();
    expect([back.dests, back.cancels]).toEqual([1, 0]);
    expect(d.calls()).toBe(0);
    expect(order).toEqual([
      `newProjectPath:${PROJECT_NAME}`,
      `relocate:${KEPT_PATH}`,
      `deleteProject:${TEMP_PATH}`,
    ]);
    expect(s.path).toBe(KEPT_PATH);
    expect(toast.info).toHaveBeenCalledWith("Kept in your library.");
  });

  it("an OS open / window close (confirm) during a badge Keep resolves true once it lands", async () => {
    const s = tempSession();
    const release = heldRelocate(s);
    const d = deferredAsk();
    const exits = createTempExits(s, createTempLeaveGateWith(s, d.ask));
    void exits.keep();
    await settle();
    let answer: boolean | null = null;
    void exits.confirm().then((v) => {
      answer = v;
    });
    await settle();
    expect(answer).toBeNull();
    release();
    await settle();
    expect(answer).toBe(true);
    expect(d.calls()).toBe(0);
  });

  it("a second click while a Keep runs is ignored: one path asked for, one relocate", async () => {
    const s = tempSession();
    const release = heldRelocate(s);
    const exits = createTempExits(s, createTempLeaveGateWith(s, deferredAsk().ask));
    const first = exits.keep();
    await settle();
    await expect(exits.keep()).resolves.toBe("ignored");
    release();
    await expect(first).resolves.toBe("kept");
    expect(order.filter((e) => e.startsWith("relocate:"))).toHaveLength(1);
    expect(order.filter((e) => e.startsWith("newProjectPath:"))).toHaveLength(1);
  });

  it("the badge does nothing while the leave prompt is open", async () => {
    const s = tempSession();
    const d = deferredAsk();
    const exits = createTempExits(s, createTempLeaveGateWith(s, d.ask));
    const back = outcome();
    exits.confirmLeave(back.dest, back.cancel);
    expect(d.calls()).toBe(1);
    await expect(exits.keep()).resolves.toBe("ignored");
    expect(order).toEqual([]);
    d.answer("cancel");
    await settle();
    expect([back.dests, back.cancels]).toEqual([0, 1]);
  });

  it("a kept (permanent) project ignores the badge", async () => {
    const s = new ProjectSession(KEPT_PATH, createProject(PROJECT_NAME));
    sessions.push(s);
    const exits = createTempExits(s, createTempLeaveGateWith(s, deferredAsk().ask));
    await expect(exits.keep()).resolves.toBe("ignored");
    expect(order).toEqual([]);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a failed Keep toasts its own wording, stays temp, and the next exit asks as usual", async () => {
    const s = tempSession();
    const release = heldRelocate(s, new Error("access denied"));
    const d = deferredAsk();
    const exits = createTempExits(s, createTempLeaveGateWith(s, d.ask));
    const kept = exits.keep();
    await settle();
    const back = outcome();
    exits.confirmLeave(back.dest, back.cancel);
    release();
    await expect(kept).resolves.toBe("failed");
    await settle();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(toast.error).mock.calls[0]![0];
    expect(msg.startsWith("Couldn't keep this project: ")).toBe(true);
    expect(msg).toContain("access denied");
    expect(toast.info).not.toHaveBeenCalled();
    expect(s.temp.get()).toBe(true);
    expect(s.path).toBe(TEMP_PATH);
    expect(order.some((e) => e.startsWith("deleteProject:"))).toBe(false);
    // the waiting Back now reaches the gate, which prompts (still temp)
    expect(d.calls()).toBe(1);
    expect([back.dests, back.cancels]).toEqual([0, 0]);
    d.answer("cancel");
    await settle();
    expect([back.dests, back.cancels]).toEqual([0, 1]);
    // and the badge works again
    heldRelocate(s);
    void exits.keep();
    await settle();
    expect(order.filter((e) => e.startsWith("relocate:"))).toHaveLength(2);
  });

  it("a toast that throws neither rejects the Keep nor strands the latch", async () => {
    const s = tempSession();
    fakeRelocate(s);
    vi.mocked(toast.info).mockImplementationOnce(() => {
      throw new Error("no DOM");
    });
    const exits = createTempExits(s, createTempLeaveGateWith(s, deferredAsk().ask));
    await expect(exits.keep()).resolves.toBe("kept");
    const back = outcome();
    exits.confirmLeave(back.dest, back.cancel);
    expect([back.dests, back.cancels]).toEqual([1, 0]);
  });
});
