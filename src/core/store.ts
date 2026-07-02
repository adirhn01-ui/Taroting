// A ~60-line reactive store: get / set / update / subscribe, with
// microtask-batched notifications so bursts of mutations paint once.

export type Listener<T> = (state: T, prev: T) => void;

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
      for (const l of [...this.listeners]) l(this.state, prev);
    });
  }
}

/** Subscribe to a derived slice; fires only when the selected value changes. */
export function subscribeSelect<T, K>(
  store: Store<T>,
  select: (s: T) => K,
  cb: (value: K, prev: K) => void,
): () => void {
  let last = select(store.get());
  return store.subscribe((s) => {
    const v = select(s);
    if (!Object.is(v, last)) {
      const p = last;
      last = v;
      cb(v, p);
    }
  });
}
