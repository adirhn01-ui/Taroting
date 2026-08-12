// A tiny reactive store: get / set / update / subscribe, with
// microtask-batched notifications so bursts of mutations paint once.

export type Listener<T> = (state: T, prev: T) => void;

/**
 * Where a subscriber's failure goes.
 *
 * One function, so the two call sites in `notify` cannot drift, and so a test
 * can assert the failure was REPORTED rather than only that delivery carried
 * on. `console.error` is the channel: it is what a developer actually sees in
 * the WebView2 devtools, and it is available in every environment this module
 * runs in (the app, the unit tests, a plain browser preview).
 *
 * Deliberately NOT re-thrown from a microtask to become an uncaught error. The
 * whole point of the guard is that one broken subscriber must not decide
 * anything for the others; turning its throw into a global error would hand it
 * that power back through a different door.
 */
function reportListenerError(e: unknown): void {
  console.error("Store subscriber threw; the remaining subscribers were still notified", e);
}

export class Store<T> {
  private state: T;
  private prevNotified: T;
  private listeners = new Set<Listener<T>>();
  private scheduled = false;

  constructor(initial: T) {
    this.state = initial;
    this.prevNotified = initial;
  }

  get(): T {
    return this.state;
  }

  set(next: T): void {
    if (Object.is(next, this.state)) return;
    this.state = next;
    this.schedule();
  }

  update(fn: (s: T) => T): void {
    this.set(fn(this.state));
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const prev = this.prevNotified;
      if (Object.is(prev, this.state)) return;
      this.prevNotified = this.state;
      this.notify(this.state, prev);
    });
  }

  /**
   * Deliver one notification to every subscriber, each ISOLATED from the rest.
   *
   * WHAT THIS REPLACES, and why it mattered. The old body was a bare
   * `for (const l of [...this.listeners]) l(this.state, prev)`. One throwing
   * subscriber aborted the whole delivery: every listener registered after it
   * was skipped, and because `prevNotified` is advanced BEFORE this runs, that
   * value was never delivered to them — not on this notification and not on any
   * later one, since the next `schedule()` compares against the state they
   * never saw. Concretely: a throw inside the Settings re-render stopped the
   * editor re-binding its shortcuts, silently, with no error path back.
   *
   * THE HAPPY PATH IS THE OLD LOOP, INSTRUCTION FOR INSTRUCTION. This is the
   * hottest shared primitive in the app — every project mutation ends up here —
   * so the guard is only paid for once something has actually thrown. The outer
   * `try` costs nothing per iteration; the per-listener `try/catch` lives in the
   * resume loop, which is entered exactly once per failed notification and only
   * for the listeners that are still owed the value. Do not "simplify" this into
   * a try/catch inside the main loop: that is the version this shape exists to
   * avoid.
   */
  private notify(state: T, prev: T): void {
    // Snapshot first: a listener is allowed to subscribe or unsubscribe while
    // being notified, and mutating the Set mid-iteration is undefined-ish.
    const ls = [...this.listeners];
    let i = 0;
    try {
      for (; i < ls.length; i++) ls[i]!(state, prev);
    } catch (e) {
      reportListenerError(e);
      // `i` is still the index that threw (the increment never ran), so step
      // past it and finish the list. Guarded one at a time from here on: a
      // second failure must not swallow a third subscriber either.
      for (i++; i < ls.length; i++) {
        try {
          ls[i]!(state, prev);
        } catch (rest) {
          reportListenerError(rest);
        }
      }
    }
  }
}
