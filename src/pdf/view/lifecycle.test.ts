import { describe, expect, it } from "vitest";
import { createSharedResource } from "./lifecycle";

/** Fake timers the resource is handed (no global timer patching). */
function harness() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  const made: number[] = [];
  const destroyed: number[] = [];
  const res = createSharedResource<number>({
    create: () => {
      const id = made.length + 1;
      made.push(id);
      return id;
    },
    destroy: (r) => destroyed.push(r),
    graceMs: 2000,
    setTimer: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  const fire = (): void => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  return { res, made, destroyed, timers, fire };
}

describe("the shared worker lifecycle", () => {
  it("costs nothing before the first acquire", () => {
    const h = harness();
    expect(h.made).toEqual([]);
    expect(h.res.peek()).toBeNull();
    h.res.release(); // a stray release is harmless
    expect(h.timers.size).toBe(0);
  });

  it("creates once and shares between holders", () => {
    const h = harness();
    expect(h.res.acquire()).toBe(1);
    expect(h.res.acquire()).toBe(1);
    expect(h.made).toEqual([1]);
    expect(h.res.refs).toBe(2);
  });

  it("is destroyed only after the last release AND the grace", () => {
    const h = harness();
    h.res.acquire();
    h.res.acquire();
    h.res.release();
    expect(h.timers.size).toBe(0);
    h.res.release();
    expect(h.destroyed).toEqual([]);
    expect(h.timers.size).toBe(1);
    h.fire();
    expect(h.destroyed).toEqual([1]);
    expect(h.res.peek()).toBeNull();
    expect(h.timers.size).toBe(0);
  });

  it("an acquire inside the grace keeps the same worker (no respawn)", () => {
    const h = harness();
    h.res.acquire();
    h.res.release();
    expect(h.res.acquire()).toBe(1);
    expect(h.timers.size).toBe(0); // grace disarmed
    h.fire();
    expect(h.destroyed).toEqual([]);
    expect(h.made).toEqual([1]);
  });

  it("a new acquire after teardown spawns a fresh one", () => {
    const h = harness();
    h.res.acquire();
    h.res.release();
    h.fire();
    expect(h.res.acquire()).toBe(2);
    expect(h.made).toEqual([1, 2]);
  });
});
