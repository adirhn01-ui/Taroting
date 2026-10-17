// Cancelling an export while it builds, and keeping the UI alive meanwhile.
// The build is a long run of synchronous steps (pdf-lib objects, content
// streams); `checkpoint` between them throws once the signal is aborted and,
// when the steps since the last turn ran longer than a slice, gives the event
// loop a turn so input, paint and the Cancel click get through.

/** What a cancelled export throws: the same shape the export dialog tests for
 *  (`name === "AbortError"`). */
export function abortError(): DOMException {
  return new DOMException("The export was canceled.", "AbortError");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Work between two turns of the event loop, ms. */
export const SLICE_MS = 25;

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A checkpoint function for one build: call it between units of work. */
export function checkpoints(signal: AbortSignal | undefined, sliceMs = SLICE_MS): () => Promise<void> {
  let last = performance.now();
  return async () => {
    throwIfAborted(signal);
    if (performance.now() - last < sliceMs) return;
    await macrotask();
    last = performance.now();
    throwIfAborted(signal);
  };
}
