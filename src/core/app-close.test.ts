import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSession } from "./session";

// Everything the flow reaches outside itself is a fake: the modal and the temp
// session helpers (no DOM under node), the close ack and the listener (no
// Tauri), the settings write queue, and the tmp-projects path test.
const m = vi.hoisted(() => ({
  log: [] as string[],
  closeAck: vi.fn(),
  onCloseRequested: vi.fn(),
  settingsWritesSettled: vi.fn(),
  askCloseAnyway: vi.fn(),
  discardTempSession: vi.fn(),
  createTempLeaveGate: vi.fn(),
  isTempProjectPath: vi.fn(),
}));

vi.mock("./ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ipc")>();
  return {
    ...real,
    ipc: { ...real.ipc, closeAck: m.closeAck },
    onCloseRequested: m.onCloseRequested,
  };
});
// TEARDOWN_WAIT_MS stays the real one: the settle-cap tests pin its value.
vi.mock("./open-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./open-media")>()),
  isTempProjectPath: m.isTempProjectPath,
}));
vi.mock("./session", () => ({ settingsWritesSettled: m.settingsWritesSettled }));
vi.mock("../ui/temp-project", () => ({
  askCloseAnyway: m.askCloseAnyway,
  discardTempSession: m.discardTempSession,
  createTempLeaveGate: m.createTempLeaveGate,
}));

import {
  decideClose,
  flushOrAsk,
  installCloseGate,
  registerBeforeClose,
  registerCloseTask,
  runCloseFlow,
  type CloseDeps,
} from "./app-close";

type SaveState = "saved" | "dirty" | "saving" | "error";

interface FakeOpts {
  path?: string;
  temp?: boolean;
  edited?: boolean;
  blockLeave?: string | null;
  guard?: (() => Promise<boolean>) | null;
  state?: SaveState;
  /** what save() does; default: lands and leaves the state "saved" */
  save?: (s: { state: SaveState }) => Promise<void>;
}

function fakeSession(o: FakeOpts = {}): ProjectSession & { saves: number } {
  const box = { state: o.state ?? "dirty" };
  const s = {
    saves: 0,
    path: o.path ?? "C:/tmp-projects/clip.trt",
    temp: { get: () => o.temp ?? false },
    edited: o.edited ?? false,
    blockLeave: o.blockLeave ?? null,
    leaveGuard: o.guard ?? null,
    saveState: { get: () => box.state },
    save: () => {
      s.saves++;
      m.log.push("save");
      if (o.save) return o.save(box);
      box.state = "saved";
      return Promise.resolve();
    },
  };
  return s as unknown as ProjectSession & { saves: number };
}

function deps(session: ProjectSession | null, over: Partial<CloseDeps> = {}): CloseDeps & {
  destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn(async () => {
    m.log.push("destroy");
  });
  return {
    session: () => {
      m.log.push("session");
      return session;
    },
    settle: async () => {
      m.log.push("settle");
    },
    destroy,
    ...over,
  } as CloseDeps & { destroy: ReturnType<typeof vi.fn> };
}

/** Let every queued continuation run (no timers involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Tasks live in module state; every test unregisters what it registered.
const unregs: (() => void)[] = [];
function task(fn: () => void | Promise<void>): void {
  unregs.push(registerCloseTask(fn));
}
function before(fn: () => void): void {
  unregs.push(registerBeforeClose(fn));
}

beforeEach(() => {
  m.log.length = 0;
  m.closeAck.mockReset().mockImplementation(() => {
    m.log.push("closeAck");
    return Promise.resolve();
  });
  m.settingsWritesSettled.mockReset().mockImplementation(() => {
    m.log.push("settings");
    return Promise.resolve();
  });
  m.askCloseAnyway.mockReset().mockResolvedValue(false);
  m.discardTempSession.mockReset().mockImplementation(async () => {
    m.log.push("discard");
  });
  m.createTempLeaveGate.mockReset();
  // The fake session's default path is a scratch file.
  m.isTempProjectPath.mockReset().mockImplementation(async (p: string) => p.startsWith("C:/tmp-projects/"));
});

afterEach(() => {
  while (unregs.length) unregs.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("decideClose", () => {
  // All 16 combinations, written out rather than derived: no session wins over
  // everything, a running export beats temp, then temp splits on edited.
  const rows: [hasSession: boolean, temp: boolean, edited: boolean, blocked: boolean, expected: string][] = [
    [false, false, false, false, "destroy"],
    [false, false, false, true, "destroy"],
    [false, false, true, false, "destroy"],
    [false, false, true, true, "destroy"],
    [false, true, false, false, "destroy"],
    [false, true, false, true, "destroy"],
    [false, true, true, false, "destroy"],
    [false, true, true, true, "destroy"],
    [true, false, false, false, "flush"],
    [true, false, false, true, "export"],
    [true, false, true, false, "flush"],
    [true, false, true, true, "export"],
    [true, true, false, false, "discard"],
    [true, true, false, true, "export"],
    [true, true, true, false, "prompt"],
    [true, true, true, true, "export"],
  ];
  it.each(rows)("session=%s temp=%s edited=%s blocked=%s → %s", (hasSession, temp, edited, blocked, expected) => {
    expect(decideClose({ hasSession, temp, edited, blocked })).toBe(expected);
  });
});

describe("runCloseFlow", () => {
  it("acks the close request before anything else, on every run", async () => {
    const d = deps(null);
    await runCloseFlow(d);
    await runCloseFlow(d);
    expect(m.closeAck).toHaveBeenCalledTimes(2);
    expect(m.log[0]).toBe("closeAck");
    // The second run starts with its own ack, not after the first run's tail.
    expect(m.log.filter((e) => e === "closeAck" || e === "destroy")).toEqual([
      "closeAck",
      "destroy",
      "closeAck",
      "destroy",
    ]);
  });

  it("waits for a closing screen before reading the session", async () => {
    let release!: () => void;
    const settled = new Promise<void>((r) => (release = r));
    const d = deps(null, { settle: () => settled });
    const run = runCloseFlow(d);
    await flush();
    expect(m.log).toEqual(["closeAck"]);
    release();
    expect(await run).toBe("closed");
    expect(m.log).toEqual(["closeAck", "session", "settings", "destroy"]);
  });

  // The closing screen is the editor mid final save, and it has already let go
  // of its session — so `session()` is null by then and nothing downstream
  // would ever see that save. Running out of patience is a question.
  it("a screen that never finishes closing is asked about at 3 s; Stay keeps the window", async () => {
    vi.useFakeTimers();
    let taskRan = false;
    task(() => {
      taskRan = true;
    });
    const d = deps(null, { settle: () => new Promise<void>(() => {}) });
    const run = runCloseFlow(d);
    await vi.advanceTimersByTimeAsync(2999);
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes are still being saved.");
    expect(await run).toBe("stayed");
    expect(d.destroy).not.toHaveBeenCalled();
    expect(taskRan).toBe(false);
    expect(m.log).not.toContain("session");
  });

  it("a screen that never finishes closing: Close anyway closes, exactly once", async () => {
    vi.useFakeTimers();
    m.askCloseAnyway.mockResolvedValue(true);
    const d = deps(null, { settle: () => new Promise<void>(() => {}) });
    const run = runCloseFlow(d);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await run).toBe("closed");
    expect(m.askCloseAnyway).toHaveBeenCalledTimes(1);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("no session: still runs the registered tasks, then the settings wait, then destroys", async () => {
    task(() => {
      m.log.push("task");
    });
    const d = deps(null);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(m.log).toEqual(["closeAck", "settle", "session", "task", "settings", "destroy"]);
  });

  it("unedited temp: discards silently, no prompt, destroys once", async () => {
    const guard = vi.fn(async () => true);
    const s = fakeSession({ temp: true, edited: false, guard });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(m.discardTempSession).toHaveBeenCalledTimes(1);
    expect(m.discardTempSession).toHaveBeenCalledWith(s);
    expect(guard).not.toHaveBeenCalled();
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
    expect(s.saves).toBe(0);
    expect(d.destroy).toHaveBeenCalledTimes(1);
    expect(m.log.indexOf("discard")).toBeLessThan(m.log.indexOf("destroy"));
  });

  // A Keep in flight has already pointed the session at its permanent file but
  // not yet dropped the temp flag: the flags say "discard", the path says the
  // file is the one the user just kept.
  it("unedited 'temp' whose path is already outside tmp-projects: flushed, never discarded", async () => {
    const kept = "C:/Users/me/Documents/Taroting/clip.trt";
    const s = fakeSession({ path: kept, temp: true, edited: false, state: "saving" });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(m.isTempProjectPath).toHaveBeenCalledWith(kept);
    expect(m.discardTempSession).not.toHaveBeenCalled();
    expect(s.saves).toBe(1);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("unedited 'temp' already relocated and saved: nothing written, nothing deleted", async () => {
    const kept = "C:/Users/me/Documents/Taroting/clip.trt";
    const s = fakeSession({ path: kept, temp: true, edited: false, state: "saved" });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(m.discardTempSession).not.toHaveBeenCalled();
    expect(s.saves).toBe(0);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("edited temp: the leave guard decides — false stays, nothing is torn down", async () => {
    let taskRan = false;
    task(() => {
      taskRan = true;
    });
    const guard = vi.fn(async () => false);
    const s = fakeSession({ temp: true, edited: true, guard });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(m.discardTempSession).not.toHaveBeenCalled();
    expect(d.destroy).not.toHaveBeenCalled();
    expect(taskRan).toBe(false);
  });

  it("edited temp: the leave guard's true closes", async () => {
    const guard = vi.fn(async () => true);
    const d = deps(fakeSession({ temp: true, edited: true, guard }));
    expect(await runCloseFlow(d)).toBe("closed");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(m.discardTempSession).not.toHaveBeenCalled();
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("edited temp with no guard installed still asks, through a fresh gate", async () => {
    const confirm = vi.fn(async () => false);
    m.createTempLeaveGate.mockReturnValue({ confirm });
    const s = fakeSession({ temp: true, edited: true, guard: null });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(m.createTempLeaveGate).toHaveBeenCalledWith(s);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("permanent and dirty: flushes, then closes without asking", async () => {
    const s = fakeSession({ state: "dirty" });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(s.saves).toBe(1);
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
    expect(m.log.indexOf("save")).toBeLessThan(m.log.indexOf("destroy"));
  });

  it("permanent and already saved: no write (modifiedAt stays put), closes", async () => {
    const s = fakeSession({ state: "saved" });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(s.saves).toBe(0);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("permanent, the save fails: asks; Stay keeps the window", async () => {
    const s = fakeSession({
      state: "dirty",
      save: async (b) => {
        b.state = "error";
      },
    });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.");
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("permanent, the save fails: Close anyway closes", async () => {
    m.askCloseAnyway.mockResolvedValue(true);
    const s = fakeSession({
      state: "dirty",
      save: async (b) => {
        b.state = "error";
      },
    });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("a save that never lands is asked about at the 4 s cap — never a silent close", async () => {
    vi.useFakeTimers();
    const s = fakeSession({
      state: "dirty",
      save: (b) => {
        b.state = "saving";
        return new Promise<void>(() => {});
      },
    });
    const d = deps(s);
    const run = runCloseFlow(d);
    await vi.advanceTimersByTimeAsync(3999);
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.");
    expect(await run).toBe("stayed");
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("a running export is asked about first; Stay keeps it running", async () => {
    let taskRan = false;
    task(() => {
      taskRan = true;
    });
    const guard = vi.fn(async () => true);
    const d = deps(fakeSession({ temp: true, edited: true, blockLeave: "An export is running.", guard }));
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(m.askCloseAnyway).toHaveBeenCalledWith("An export is running. Closing now stops it.");
    expect(guard).not.toHaveBeenCalled();
    expect(taskRan).toBe(false);
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("Close anyway on an export still offers Keep for an edited temp project", async () => {
    m.askCloseAnyway.mockResolvedValue(true);
    const guard = vi.fn(async () => false);
    const d = deps(fakeSession({ temp: true, edited: true, blockLeave: "An export is running.", guard }));
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(m.askCloseAnyway).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("Close anyway on an export still flushes a permanent project, then closes", async () => {
    m.askCloseAnyway.mockResolvedValue(true);
    const s = fakeSession({ state: "dirty", blockLeave: "An export is running." });
    const d = deps(s);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(s.saves).toBe(1);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("a task that never resolves holds the close for 1.5 s, no longer", async () => {
    vi.useFakeTimers();
    task(() => new Promise<void>(() => {}));
    const d = deps(null);
    const run = runCloseFlow(d);
    await vi.advanceTimersByTimeAsync(1499);
    expect(d.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe("closed");
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("throwing tasks (sync and async) do not stop the others or the close", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let ran = 0;
    task(() => {
      throw new Error("sync");
    });
    task(async () => {
      throw new Error("async");
    });
    task(() => {
      ran++;
    });
    const d = deps(null);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(ran).toBe(1);
    expect(d.destroy).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("the settings write queue is waited on, but at most 1.5 s", async () => {
    vi.useFakeTimers();
    m.settingsWritesSettled.mockImplementation(() => new Promise<void>(() => {}));
    const d = deps(null);
    const run = runCloseFlow(d);
    await vi.advanceTimersByTimeAsync(1499);
    expect(d.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe("closed");
  });

  /** Stands in for the page: a `.modal-backdrop` is present or it is not. */
  function stubModal(present: boolean): void {
    vi.stubGlobal("document", {
      querySelector: (sel: string) => (present && sel === ".modal-backdrop" ? {} : null),
    });
  }

  it("a second request while a prompt is up is ignored but acked: one prompt, one destroy", async () => {
    stubModal(true);
    let answer!: (v: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const d = deps(fakeSession({ temp: true, edited: true, guard }));
    const first = runCloseFlow(d);
    await flush();
    const second = await runCloseFlow(d);
    const acks = m.closeAck.mock.calls.length;
    // The first flow is settled BEFORE anything is asserted: a failure must not
    // strand the latch and turn every later test red with it.
    answer(true);
    expect(await first).toBe("closed");
    expect(second).toBe("stayed");
    // The repeat X still acked, so the backend never force-closes past the prompt.
    expect(acks).toBe(2);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("a second request while the flow is wedged with no prompt up is NOT acked", async () => {
    // A Keep whose write never lands: the guard never settles, and the prompt
    // that led there is long gone. Silence lets the Rust side force-close.
    stubModal(false);
    let answer!: (v: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const d = deps(fakeSession({ temp: true, edited: true, guard }));
    const first = runCloseFlow(d);
    await flush();
    const acksBefore = m.closeAck.mock.calls.length;
    const firstLogged = m.log[0];
    const second = await runCloseFlow(d);
    const acksAfter = m.closeAck.mock.calls.length;
    // Settled before asserting, as above.
    answer(false);
    expect(await first).toBe("stayed");
    // The first request of a flow acks unconditionally, before anything else.
    expect(acksBefore).toBe(1);
    expect(firstLogged).toBe("closeAck");
    expect(second).toBe("stayed");
    expect(acksAfter).toBe(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("a second request during a CAPPED wait is acked even with no prompt up", async () => {
    // A permanent project whose final save is slow: the flow sits in the 4 s
    // flush cap with nothing on screen. That wait always ends (in a close or a
    // question), so the repeat X must be acked — silence would let the Rust
    // escape hatch destroy the window in the middle of the final save.
    stubModal(false);
    vi.useFakeTimers();
    const s = fakeSession({
      state: "dirty",
      save: (b) => {
        b.state = "saving";
        return new Promise<void>(() => {});
      },
    });
    const d = deps(s);
    const first = runCloseFlow(d);
    await vi.advanceTimersByTimeAsync(500);
    const second = await runCloseFlow(d);
    const acks = m.closeAck.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3500);
    expect(await first).toBe("stayed");
    expect(second).toBe("stayed");
    expect(acks).toBe(2);
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.");
    expect(d.destroy).not.toHaveBeenCalled();
  });

  it("after a Stay, the next request runs a fresh flow", async () => {
    const guard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps(fakeSession({ temp: true, edited: true, guard }));
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(await runCloseFlow(d)).toBe("closed");
    expect(guard).toHaveBeenCalledTimes(2);
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  it("an internal failure asks instead of rejecting, and releases the latch", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps(null, {
      session: () => {
        throw new Error("boom");
      },
    });
    await expect(runCloseFlow(d)).resolves.toBe("stayed");
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.");
    // Latch released: a later request gets its own prompt.
    await runCloseFlow(d);
    expect(m.askCloseAnyway).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("a prompt that cannot be shown closes rather than trapping the window", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.askCloseAnyway.mockRejectedValue(new Error("no document"));
    const d = deps(fakeSession({ state: "dirty", save: async (b) => void (b.state = "error") }));
    expect(await runCloseFlow(d)).toBe("closed");
    expect(d.destroy).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a destroy that fails resolves 'stayed' and the next request can try again", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps(null);
    d.destroy.mockRejectedValueOnce(new Error("not permitted"));
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(await runCloseFlow(d)).toBe("closed");
    expect(d.destroy).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

describe("registerCloseTask", () => {
  it("unregister removes exactly its own registration, even of the same function", async () => {
    let n = 0;
    const fn = (): void => {
      n++;
    };
    const a = registerCloseTask(fn);
    task(fn);
    a();
    await runCloseFlow(deps(null));
    expect(n).toBe(1);
  });
});

describe("registerBeforeClose", () => {
  it("runs right after the ack, before the settle wait and the session is read", async () => {
    before(() => {
      m.log.push("before");
    });
    task(() => {
      m.log.push("task");
    });
    expect(await runCloseFlow(deps(null))).toBe("closed");
    expect(m.log).toEqual(["closeAck", "before", "settle", "session", "task", "settings", "destroy"]);
  });

  // What the task reverts is what the decision sees: an edited temp project
  // whose only "edit" was a transient preview is discarded silently, never
  // asked about — the ask would offer to keep a preview the user never applied.
  it("the decision sees what the task left behind", async () => {
    const guard = vi.fn(async () => false);
    const s = fakeSession({ temp: true, edited: true, guard });
    before(() => {
      (s as unknown as { edited: boolean }).edited = false;
    });
    expect(await runCloseFlow(deps(s))).toBe("closed");
    expect(guard).not.toHaveBeenCalled();
    expect(m.discardTempSession).toHaveBeenCalledWith(s);
  });

  it("a throwing task is logged and does not stop the others or the close", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let ran = 0;
    before(() => {
      throw new Error("boom");
    });
    before(() => {
      ran++;
    });
    const d = deps(null);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(ran).toBe(1);
    expect(d.destroy).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith("A before-close task failed", expect.any(Error));
    err.mockRestore();
  });

  it("unregister removes exactly its own registration, even of the same function", async () => {
    let n = 0;
    const fn = (): void => {
      n++;
    };
    const a = registerBeforeClose(fn);
    before(fn);
    a();
    await runCloseFlow(deps(null));
    expect(n).toBe(1);
    const b = registerBeforeClose(fn);
    b();
    await runCloseFlow(deps(null));
    expect(n).toBe(2);
  });

  it("runs on every close request, a fresh one after a Stay included", async () => {
    let n = 0;
    before(() => {
      n++;
    });
    const guard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps(fakeSession({ temp: true, edited: true, guard }));
    expect(await runCloseFlow(d)).toBe("stayed");
    expect(n).toBe(1);
    expect(await runCloseFlow(d)).toBe("closed");
    expect(n).toBe(2);
  });

  // A repeat X while a flow runs is acked and ignored: it never settles or
  // decides, so there is no "before the decision" for it to run ahead of.
  it("does not run for a repeat request ignored while a flow is running", async () => {
    let n = 0;
    before(() => {
      n++;
    });
    let release!: () => void;
    const settled = new Promise<void>((r) => (release = r));
    const d = deps(null, { settle: () => settled });
    const first = runCloseFlow(d);
    try {
      await flush();
      expect(await runCloseFlow(d)).toBe("stayed");
      expect(n).toBe(1);
    } finally {
      // Released on every outcome: a flow left parked would hold the latch
      // and turn every later test's request into an ignored repeat.
      release();
    }
    expect(await first).toBe("closed");
    expect(n).toBe(1);
  });
});

// The dialogs behind a close (../ui/temp-project) stay out of the boot chunk:
// app-close is imported by main.ts, so a static import here puts the Keep
// question and "close anyway?" into every launch's parse, used or not.
describe("app-close boot weight", () => {
  it("imports ../ui/temp-project only lazily", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "app-close.ts"), "utf8");
    const staticImports = src
      .split(/\r?\n/)
      .filter((l) => /^\s*import\s(?!type\b)/.test(l) && l.includes("../ui/temp-project"));
    expect(staticImports).toEqual([]);
    expect(src).toContain('await import("../ui/temp-project")');
  });
});

describe("installCloseGate", () => {
  it("listens once, and each close request runs the flow", async () => {
    let handler: (() => void) | null = null;
    m.onCloseRequested.mockImplementation(async (h: () => void) => {
      handler = h;
      return () => {};
    });
    const d = deps(null);
    installCloseGate(d);
    installCloseGate(d);
    await flush();
    expect(m.onCloseRequested).toHaveBeenCalledTimes(1);
    handler!();
    await flush();
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });
});

/**
 * flushOrAsk: the one final-save rule every exit from a permanent project now
 * shares. The window close already had it; Back, Ctrl+W, the gear and an OS
 * open went straight to dispose, where a failed save is reported to nobody.
 */
describe("flushOrAsk", () => {
  const failing = (): ProjectSession & { saves: number } =>
    fakeSession({
      state: "dirty",
      save: async (b) => {
        b.state = "error";
      },
    });

  it("writes nothing and asks nothing for a project already on disk", async () => {
    const s = fakeSession({ state: "saved" });
    expect(await flushOrAsk(s, "leave")).toBe(true);
    expect(s.saves).toBe(0);
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
  });

  it("leaves without asking once the pending save lands", async () => {
    const s = fakeSession({ state: "dirty" });
    expect(await flushOrAsk(s, "leave")).toBe(true);
    expect(s.saves).toBe(1);
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
  });

  it("asks the LEAVE question when leaving, and Stay stays", async () => {
    m.askCloseAnyway.mockResolvedValue(false);
    expect(await flushOrAsk(failing(), "leave")).toBe(false);
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.", "leave");
  });

  it("asks the CLOSE question, unchanged, when closing", async () => {
    m.askCloseAnyway.mockResolvedValue(true);
    expect(await flushOrAsk(failing(), "close")).toBe(true);
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.");
  });

  it("an injected question replaces the modal", async () => {
    const ask = vi.fn(async () => true);
    expect(await flushOrAsk(failing(), "leave", ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith("Your latest changes couldn't be saved.");
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
  });

  it("a leave prompt that cannot be shown stays (a close one closes)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    m.askCloseAnyway.mockRejectedValue(new Error("no dialog"));
    expect(await flushOrAsk(failing(), "leave")).toBe(false);
    expect(await flushOrAsk(failing(), "close")).toBe(true);
    quiet.mockRestore();
  });

  it("a save still out at the 4 s cap is asked about", async () => {
    vi.useFakeTimers();
    const s = fakeSession({
      state: "dirty",
      save: (b) => {
        b.state = "saving";
        return new Promise<void>(() => {});
      },
    });
    const run = flushOrAsk(s, "leave");
    await vi.advanceTimersByTimeAsync(3999);
    expect(m.askCloseAnyway).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.askCloseAnyway).toHaveBeenCalledWith("Your latest changes couldn't be saved.", "leave");
    expect(await run).toBe(false);
  });
});
