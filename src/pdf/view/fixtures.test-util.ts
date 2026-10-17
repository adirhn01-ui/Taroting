// Test-only helpers: pdf.js's legacy (Node) build behind the real loader, and
// the generated fixtures in tests/fixtures/pdf (gitignored — `npm run
// fixtures` makes them; tests that need them skip when they are absent).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SharedResource } from "./lifecycle";
import { createLoader, type Loader, type PdfjsLike } from "./loader";

export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/pdf");
export const hasFixtures = existsSync(resolve(FIXTURES, "plain_3p.pdf"));
export const fixture = (name: string): string => resolve(FIXTURES, name);

export function legacyPdfjs(): Promise<PdfjsLike> {
  return import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfjsLike>;
}

/** A counting stand-in for the shared worker (pdf.js makes its own). */
export function countingWorker(): SharedResource<unknown> & { acquired: number; released: number } {
  const w = {
    acquired: 0,
    released: 0,
    acquire(): unknown {
      w.acquired++;
      return undefined;
    },
    release(): void {
      w.released++;
    },
    get refs(): number {
      return w.acquired - w.released;
    },
    peek: (): unknown => null,
  };
  return w;
}

export function testLoader(worker: SharedResource<unknown> | null = null): Loader {
  return createLoader({
    pdfjs: legacyPdfjs,
    readBytes: async (path) => (existsSync(path) ? new Uint8Array(readFileSync(path)) : null),
    params: () => ({ verbosity: 0, useWasm: false }),
    worker,
  });
}
