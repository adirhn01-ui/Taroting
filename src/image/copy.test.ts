import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../core/types";

const toasts: string[] = [];
const details: string[] = [];
vi.mock("../ui/toast", () => ({
  toast: {
    info: (m: string) => toasts.push(`info:${m}`),
    error: (m: string, o?: { detail?: string }) => {
      toasts.push(`error:${m}`);
      if (o?.detail !== undefined) details.push(o.detail);
    },
  },
}));
vi.mock("../core/ipc", () => ({ describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
let render: Promise<Blob>;
/** when set, each render is made by this from its own signal */
let renderFor: ((signal: AbortSignal) => Promise<Blob>) | null = null;
const sizes: string[] = [];
const signals: AbortSignal[] = [];
vi.mock("./render/export", () => ({
  maxRenderSize: (w: number, h: number) => (w > 32767 ? { w: 32767, h: Math.floor((h * 32767) / w), reduced: true } : { w, h, reduced: false }),
  renderImageExport: (_d: unknown, o: { format: string; outW: number; outH: number }, signal: AbortSignal) => {
    sizes.push(`${o.format}:${o.outW}x${o.outH}`);
    signals.push(signal);
    return renderFor ? renderFor(signal) : render;
  },
}));

/** A render that finishes only when told to, and rejects with AbortError the
 *  moment its signal is aborted — what renderImageExport does. */
function controlledRender(signal: AbortSignal, finish: ((b: Blob) => void)[]): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    finish.push(resolve);
    signal.addEventListener("abort", () => reject(new DOMException("The export was canceled.", "AbortError")));
  });
}

import { COPY_REFUSED_MESSAGE, copyImage } from "./copy";

const doc = (w: number, h: number): ProjectFile => ({ timeline: { width: w, height: h } }) as unknown as ProjectFile;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

class FakeItem {
  constructor(readonly items: Record<string, unknown>) {}
}

let writes: FakeItem[][] = [];
/** by default the clipboard settles as the item's promise does */
let writeResult: ((items: FakeItem[]) => Promise<void>) | null = null;

beforeEach(() => {
  toasts.length = 0;
  details.length = 0;
  sizes.length = 0;
  signals.length = 0;
  writes = [];
  render = Promise.resolve(new Blob([new Uint8Array(4)], { type: "image/png" }));
  renderFor = null;
  writeResult = null;
  vi.stubGlobal("ClipboardItem", FakeItem);
  vi.stubGlobal("navigator", {
    clipboard: {
      write: (items: FakeItem[]) => {
        writes.push(items);
        if (writeResult) return writeResult(items);
        return (items[0]!.items["image/png"] as Promise<Blob>).then(() => undefined);
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("copyImage", () => {
  it("starts the clipboard write synchronously, with the render as a PROMISE-valued PNG item", async () => {
    copyImage(doc(641, 361));
    // no await yet: the write must already have been issued inside the gesture
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]!.items["image/png"]).toBe(render);
    expect(sizes).toEqual(["png:641x361"]);
    await flush();
    expect(toasts).toEqual(["info:Image copied"]);
  });

  it("renders a canvas past the engine's limits at the largest size that fits", () => {
    copyImage(doc(40000, 1000));
    expect(sizes).toEqual(["png:32767x819"]);
  });

  it("a refused write (no focus / no gesture) says how to recover", async () => {
    writeResult = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    copyImage(doc(10, 10));
    await flush();
    expect(toasts).toEqual([`error:${COPY_REFUSED_MESSAGE}`]);
  });

  it("a new copy aborts the render of the one still running; the superseded copy says nothing", async () => {
    const finish: ((b: Blob) => void)[] = [];
    renderFor = (signal) => controlledRender(signal, finish);
    // an engine that reports any rejected item as NotAllowedError
    writeResult = (items) =>
      (items[0]!.items["image/png"] as Promise<Blob>).then(
        () => undefined,
        () => Promise.reject(new DOMException("denied", "NotAllowedError")),
      );
    copyImage(doc(10, 10));
    copyImage(doc(10, 10));
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    finish[1]!(new Blob([new Uint8Array(4)], { type: "image/png" }));
    await flush();
    expect(toasts).toEqual(["info:Image copied"]);
  });

  it("a finished copy is not aborted by the next one", async () => {
    copyImage(doc(10, 10));
    await flush();
    copyImage(doc(10, 10));
    expect(signals[0]!.aborted).toBe(false);
  });

  it("names the render's own failure even when the clipboard calls it NotAllowedError", async () => {
    render = Promise.reject(new Error('Couldn\'t read "Harbour". Relink it and try again.'));
    writeResult = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    copyImage(doc(10, 10));
    await flush();
    expect(toasts).toEqual(["error:Couldn't copy the image."]);
    expect(details).toEqual(['Couldn\'t read "Harbour". Relink it and try again.']);
  });

  it("a failed render is reported once, never as an unhandled rejection", async () => {
    render = Promise.reject(new Error("Couldn't read \"Harbour\". Relink it and try again."));
    writeResult = () => Promise.reject(new Error("Couldn't read \"Harbour\". Relink it and try again."));
    copyImage(doc(10, 10));
    await flush();
    expect(toasts).toEqual(["error:Couldn't copy the image."]);
  });
});
