// The per-file registry against a fake backend: index reads and plans answer
// when the test says, job events are delivered by hand, and every call is
// logged in order. Index fixtures differ only in bit rate (gap 4.17 s at 63
// Mbit/s is heavy, the same gap at 3 Mbit/s light), so each verdict fails for
// one reason; every file, job id and copy path differs.

import { describe, expect, it } from "vitest";
import type { KeyframeIndex, ScrubPlan } from "../../core/ipc";
import { ScrubCopyRegistry, type CopyJobHandlers } from "./copy-registry";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const DURATION = 65;
const times = (gap: number): number[] => Array.from({ length: 15 }, (_, i) => i * gap);
const heavyIndex = (): KeyframeIndex => ({ allSync: false, times: times(4.17), duration: DURATION, bytes: (63e6 * DURATION) / 8 });
const lightIndex = (): KeyframeIndex => ({ allSync: false, times: times(4.17), duration: DURATION, bytes: (3e6 * DURATION) / 8 });

function harness() {
  const log: string[] = [];
  const indexes = new Map<string, Deferred<KeyframeIndex | null>>();
  const plans = new Map<string, Deferred<ScrubPlan>[]>();
  let handlers: CopyJobHandlers | null = null;
  let unlistens = 0;
  const changed: string[] = [];
  const released: Array<[string, string | null]> = [];
  const reg = new ScrubCopyRegistry({
    keyframeTimes: (file) => {
      log.push(`index ${file}`);
      const d = deferred<KeyframeIndex | null>();
      indexes.set(file, d);
      return d.promise;
    },
    plan: (file) => {
      log.push(`plan ${file}`);
      const d = deferred<ScrubPlan>();
      plans.set(file, [...(plans.get(file) ?? []), d]);
      return d.promise;
    },
    cancel: (id) => void log.push(`cancel ${id}`),
    listen: (h) => {
      log.push("listen");
      handlers = h;
      return Promise.resolve(() => {
        unlistens++;
        log.push("unlisten");
        if (handlers === h) handlers = null;
      });
    },
    url: (p) => `asset://${p}`,
    changed: (f) => void changed.push(f),
    released: (f, u) => void released.push([f, u]),
  });
  return {
    reg,
    log,
    changed,
    released,
    unlistens: () => unlistens,
    handlers: () => handlers,
    async index(file: string, idx: KeyframeIndex | null): Promise<void> {
      await flush();
      indexes.get(file)!.resolve(idx);
      await flush();
    },
    async plan(file: string, p: ScrubPlan): Promise<void> {
      await flush();
      const list = plans.get(file)!;
      list[list.length - 1]!.resolve(p);
      await flush();
    },
    /** Answer the `i`-th plan asked of `file` (0 = the first). */
    async planAt(file: string, i: number, p: ScrubPlan): Promise<void> {
      await flush();
      plans.get(file)![i]!.resolve(p);
      await flush();
    },
    async done(id: number, path: string | null): Promise<void> {
      handlers!.done(id, path);
      await flush();
    },
    async failed(id: number, msg: string): Promise<void> {
      handlers!.failed(id, msg);
      await flush();
    },
  };
}

const A = "D:\\rec\\match one.mp4";
const B = "E:\\obs\\replay 2.mov";

describe("weighing", () => {
  it("a light verdict plans nothing, and a second ask reads nothing", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, lightIndex());
    expect(h.reg.state(A)).toBe("light");
    h.reg.ask([A]);
    await flush();
    expect(h.log).toEqual([`index ${A}`]);
    expect(h.reg.indexCalls).toBe(1);
    expect(h.reg.planCalls).toBe(0);
  });

  it("a heavy verdict listens BEFORE it plans", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    expect(h.log).toEqual([`index ${A}`, "listen", `plan ${A}`]);
    expect(h.reg.state(A)).toBe("waiting");
  });

  it("I5: ten asks of one file read once and plan once", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.reg.ask([A, A]);
    await h.index(A, heavyIndex());
    for (let i = 0; i < 10; i++) h.reg.ask([A]);
    await flush();
    expect(h.reg.indexCalls).toBe(1);
    expect(h.reg.planCalls).toBe(1);
  });

  it("forcing re-weighs a light record from the index it kept", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, lightIndex());
    h.reg.setForce(true);
    await flush();
    expect(h.reg.state(A)).toBe("waiting");
    expect(h.reg.indexCalls).toBe(1);
    expect(h.log).toEqual([`index ${A}`, "listen", `plan ${A}`]);
  });

  it("an index without keyframes stays light even forced", async () => {
    const h = harness();
    h.reg.setForce(true);
    h.reg.ask([A]);
    await h.index(A, { allSync: true, times: [], duration: 5, bytes: 1e9 });
    expect(h.reg.state(A)).toBe("light");
  });
});

describe("the copy job", () => {
  it("ready → url", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "ready", path: "C:\\cache\\scrub\\a.scrub2.mp4" });
    expect(h.reg.readyUrl(A)).toBe("asset://C:\\cache\\scrub\\a.scrub2.mp4");
    expect(h.changed).toEqual([A]);
    expect(h.unlistens()).toBe(1);
    expect(h.reg.isListening()).toBe(false);
  });

  it("pending, then job:done → ready", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "pending", jobId: 41 });
    expect(h.reg.state(A)).toBe("making");
    await h.done(40, "C:\\other.mp4");
    expect(h.reg.state(A)).toBe("making");
    await h.done(41, "C:\\cache\\scrub\\a.scrub2.mp4");
    expect(h.reg.readyUrl(A)).toBe("asset://C:\\cache\\scrub\\a.scrub2.mp4");
    expect(h.reg.isListening()).toBe(false);
  });

  it("a job:done that arrives before the plan answers is buffered", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.done(57, "C:\\cache\\scrub\\early.mp4");
    expect(h.reg.state(A)).toBe("waiting");
    await h.plan(A, { mode: "pending", jobId: 57 });
    expect(h.reg.readyUrl(A)).toBe("asset://C:\\cache\\scrub\\early.mp4");
  });

  it("unavailable → failed and remembered, silently", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "unavailable", reason: "not a video" });
    expect(h.reg.state(A)).toBe("failed");
    expect(h.reg.snapshot()[0]!.reason).toBe("no copy: not a video");
    h.reg.ask([A]);
    await flush();
    expect(h.reg.planCalls).toBe(1);
  });

  it("job:failed → failed and remembered", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "pending", jobId: 9 });
    await h.failed(9, "ffmpeg exited 1");
    expect(h.reg.state(A)).toBe("failed");
    expect(h.reg.snapshot()[0]!.reason).toContain("ffmpeg exited 1");
    expect(h.reg.isListening()).toBe(false);
  });

  it("failNextPlan answers the next plan without the backend", async () => {
    const h = harness();
    h.reg.failNextPlan("test refusal");
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    expect(h.reg.state(A)).toBe("failed");
    expect(h.reg.planCalls).toBe(0);
    expect(h.reg.snapshot()[0]!.reason).toBe("no copy: test refusal");
  });
});

describe("I6: one job at a time", () => {
  it("the second heavy file is planned only after the first job ends, and a playhead move cancels nothing", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "pending", jobId: 3 });
    h.reg.ask([B]);
    await h.index(B, heavyIndex());
    expect(h.reg.state(B)).toBe("heavy");
    expect(h.log.filter((l) => l.startsWith("plan"))).toEqual([`plan ${A}`]);
    // The playhead goes back to B and stays there: still no cancel of A.
    h.reg.ask([B]);
    await flush();
    expect(h.log.some((l) => l.startsWith("cancel"))).toBe(false);
    await h.done(3, "C:\\cache\\a.mp4");
    expect(h.log.filter((l) => l.startsWith("plan"))).toEqual([`plan ${A}`, `plan ${B}`]);
    expect(h.reg.state(B)).toBe("waiting");
  });

  it("the same after a job:failed", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "pending", jobId: 3 });
    h.reg.ask([B]);
    await h.index(B, heavyIndex());
    await h.failed(3, "killed");
    expect(h.log.filter((l) => l.startsWith("plan"))).toEqual([`plan ${A}`, `plan ${B}`]);
  });
});

describe("I7: letting go cancels once and drops late answers", () => {
  const making = async (): Promise<ReturnType<typeof harness>> => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "pending", jobId: 77 });
    return h;
  };
  const cancels = (h: ReturnType<typeof harness>): string[] => h.log.filter((l) => l.startsWith("cancel"));

  it("the media removed (no file live)", async () => {
    const h = await making();
    const handlers = h.handlers()!;
    h.reg.reconcile(new Set());
    h.reg.reconcile(new Set());
    expect(cancels(h)).toEqual(["cancel 77"]);
    handlers.done(77, "C:\\late.mp4");
    await flush();
    expect(h.reg.state(A)).toBeNull();
    expect(h.reg.isListening()).toBe(false);
  });

  it("relinked onto another file", async () => {
    const h = await making();
    const handlers = h.handlers()!;
    h.reg.reconcile(new Set(["F:\\relinked.mp4"]));
    expect(cancels(h)).toEqual(["cancel 77"]);
    handlers.done(77, "C:\\late.mp4");
    await flush();
    expect(h.reg.readyUrl(A)).toBeNull();
  });

  it("the played file swapped (a re-pack now plays) while the plan was out", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    h.reg.reconcile(new Set([B]));
    await h.plan(A, { mode: "pending", jobId: 12 });
    // The plan answered after the let-go: its job is not adopted, and it is
    // cancelled (nothing else ever learns its id).
    expect(h.reg.state(A)).toBeNull();
    expect(h.reg.snapshot()).toEqual([]);
    expect(cancels(h)).toEqual(["cancel 12"]);
    expect(h.reg.cancels).toBe(1);
  });

  it("disposed while the plan was out: the job it started is cancelled once", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    expect(h.reg.state(A)).toBe("waiting");
    h.reg.dispose();
    expect(cancels(h)).toEqual([]);
    await h.plan(A, { mode: "pending", jobId: 31 });
    expect(cancels(h)).toEqual(["cancel 31"]);
  });

  it("a late answer that was ready or refused cancels nothing", async () => {
    const h = harness();
    h.reg.ask([A, B]);
    await h.index(A, heavyIndex());
    h.reg.reconcile(new Set([B]));
    await h.plan(A, { mode: "ready", path: "C:\cache\a.scrub2.mp4" });
    expect(cancels(h)).toEqual([]);
  });

  it("let go and back while the plan was out: the newer record keeps the file's one job", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    h.reg.reconcile(new Set());
    // The file is played again and asked: a new record, weighed and planned.
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    expect(h.reg.state(A)).toBe("waiting");
    // The backend runs one job per file: both plans name job 44.
    await h.planAt(A, 0, { mode: "pending", jobId: 44 });
    expect(cancels(h)).toEqual([]);
    await h.planAt(A, 1, { mode: "pending", jobId: 44 });
    expect(h.reg.state(A)).toBe("making");
    expect(cancels(h)).toEqual([]);
  });

  it("disposed", async () => {
    const h = await making();
    const handlers = h.handlers()!;
    h.reg.dispose();
    h.reg.dispose();
    expect(cancels(h)).toEqual(["cancel 77"]);
    expect(h.reg.cancels).toBe(1);
    handlers.done(77, "C:\\late.mp4");
    await flush();
    expect(h.reg.readyUrl(A)).toBeNull();
    expect(h.unlistens()).toBe(1);
  });

  it("a file still played elsewhere is kept", async () => {
    const h = await making();
    h.reg.reconcile(new Set([A]));
    expect(cancels(h)).toEqual([]);
    expect(h.reg.state(A)).toBe("making");
  });

  it("a ready copy let go tells the layers its url", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "ready", path: "C:\\c.mp4" });
    h.reg.reconcile(new Set());
    expect(h.released).toEqual([[A, "asset://C:\\c.mp4"]]);
  });
});

describe("element errors", () => {
  it("the first after ready plans again, the second fails", async () => {
    const h = harness();
    h.reg.ask([A]);
    await h.index(A, heavyIndex());
    await h.plan(A, { mode: "ready", path: "C:\\c1.mp4" });
    h.reg.elementError(A, "media error 4");
    await flush();
    expect(h.reg.state(A)).toBe("waiting");
    expect(h.released).toEqual([[A, "asset://C:\\c1.mp4"]]);
    await h.plan(A, { mode: "ready", path: "C:\\c2.mp4" });
    expect(h.reg.readyUrl(A)).toBe("asset://C:\\c2.mp4");
    h.reg.elementError(A, "media error 4");
    expect(h.reg.state(A)).toBe("failed");
    expect(h.reg.planCalls).toBe(2);
  });
});

describe("the job listener", () => {
  it("is held only while something waits or is made", async () => {
    const h = harness();
    expect(h.reg.isListening()).toBe(false);
    h.reg.ask([A]);
    expect(h.reg.isListening()).toBe(false);
    await h.index(A, heavyIndex());
    expect(h.reg.isListening()).toBe(true);
    await h.plan(A, { mode: "pending", jobId: 5 });
    expect(h.reg.isListening()).toBe(true);
    await h.done(5, "C:\\done.mp4");
    expect(h.reg.isListening()).toBe(false);
    expect(h.unlistens()).toBe(1);
  });
});
