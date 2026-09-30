import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const chunkSizes: number[] = [];
let chunkFailsAt = -1;
let beginToken = 7;

vi.mock("../core/ipc", () => ({
  ipc: {
    imageSaveBegin: vi.fn(async (_dest: unknown, _format: unknown, total: number) => {
      calls.push(`begin:${total}`);
      return { token: beginToken, path: "C:\\out\\a.png" };
    }),
    imageSaveChunk: vi.fn(async (token: number, bytes: Uint8Array) => {
      if (chunkSizes.length === chunkFailsAt) {
        calls.push(`chunk-fail:${token}`);
        throw { code: "io", message: "disk full" };
      }
      chunkSizes.push(bytes.byteLength);
      calls.push(`chunk:${token}`);
    }),
    imageSaveCommit: vi.fn(async (token: number) => {
      calls.push(`commit:${token}`);
      return { token, path: "C:\\out\\final.png" };
    }),
    imageSaveAbort: vi.fn(async (token: number) => {
      calls.push(`abort:${token}`);
      // The abort's own failure must never replace the real error.
      throw new Error("abort also failed");
    }),
  },
}));

import type { ImageSaveDest } from "../core/ipc";
import { SAVE_CHUNK_BYTES, saveBlob } from "./save";

const MiB = 1024 * 1024;
const dest: ImageSaveDest = { kind: "user", path: "C:\\out\\a.png", sources: [] };

beforeEach(() => {
  calls.length = 0;
  chunkSizes.length = 0;
  chunkFailsAt = -1;
  beginToken = 7;
});

describe("saveBlob", () => {
  it("slices 20 MiB + 3 B into 8, 8 and 4 MiB + 3 B chunks, in order, then commits", async () => {
    const blob = new Blob([new Uint8Array(20 * MiB + 3)]);
    const seen: number[] = [];
    const out = await saveBlob(dest, "png", blob, undefined, (r) => seen.push(r));
    expect(SAVE_CHUNK_BYTES).toBe(8 * MiB);
    expect(chunkSizes).toEqual([8 * MiB, 8 * MiB, 4 * MiB + 3]);
    expect(calls).toEqual([`begin:${20 * MiB + 3}`, "chunk:7", "chunk:7", "chunk:7", "commit:7"]);
    expect(out.path).toBe("C:\\out\\final.png");
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("a failing chunk aborts exactly once, never commits, and rethrows the backend error unchanged", async () => {
    beginToken = 12;
    chunkFailsAt = 1;
    const blob = new Blob([new Uint8Array(17 * MiB)]);
    const err = await saveBlob(dest, "jpeg", blob).catch((e: unknown) => e);
    expect(err).toEqual({ code: "io", message: "disk full" });
    expect(calls.filter((c) => c.startsWith("abort"))).toEqual(["abort:12"]);
    expect(calls.some((c) => c.startsWith("commit"))).toBe(false);
  });

  it("a signal aborted mid-stream aborts the save and commits nothing", async () => {
    const ac = new AbortController();
    const blob = new Blob([new Uint8Array(9 * MiB)]);
    const err = await saveBlob(dest, "webp", blob, ac.signal, (r) => {
      if (r > 0) ac.abort();
    }).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(calls).toEqual([`begin:${9 * MiB}`, "chunk:7", "abort:7"]);
  });

  it("an already-aborted signal never opens a save", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await saveBlob(dest, "png", new Blob([new Uint8Array(5)]), ac.signal).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(calls).toEqual([]);
  });
});
