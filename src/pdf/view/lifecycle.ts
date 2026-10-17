// One shared resource (the pdf.js worker) held by reference count, with a
// grace period after the last release: stepping from one PDF to the next in
// the viewer releases the old document a moment before the new one opens, and
// tearing the worker down and respawning it in between would be wasted work.
// Nothing exists (and no timer runs) before the first acquire or after the
// grace expires. Pure apart from the injected create/destroy/timers, so the
// refcount maths is tested under Node with fakes.

export interface SharedResource<T> {
  /** take a reference; creates the resource on the first one */
  acquire(): T;
  /** drop a reference; the last one arms the grace timer */
  release(): void;
  /** live references (tests, diagnostics) */
  readonly refs: number;
  /** the resource, if it exists right now */
  peek(): T | null;
}

export interface SharedResourceDeps<T> {
  create(): T;
  destroy(res: T): void;
  graceMs: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export function createSharedResource<T>(deps: SharedResourceDeps<T>): SharedResource<T> {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  let res: T | null = null;
  let refs = 0;
  let timer: unknown = null;

  const disarm = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    acquire(): T {
      disarm();
      refs++;
      if (res === null) res = deps.create();
      return res;
    },
    release(): void {
      if (refs === 0) return;
      refs--;
      if (refs > 0) return;
      disarm();
      timer = setTimer(() => {
        timer = null;
        if (refs > 0 || res === null) return;
        const r = res;
        res = null;
        deps.destroy(r);
      }, deps.graceMs);
    },
    get refs(): number {
      return refs;
    },
    peek(): T | null {
      return res;
    },
  };
}
