import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPdfOpenError, toOpenError } from "./loader";
import { countingWorker, fixture, hasFixtures, testLoader } from "./fixtures.test-util";

describe("open error mapping", () => {
  const named = (name: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error("x"), { name, ...extra });

  it("maps pdf.js's exceptions to PdfOpenError kinds", () => {
    expect(toOpenError(named("PasswordException", { code: 1 }), false)).toMatchObject({ kind: "password", retry: false });
    expect(toOpenError(named("PasswordException", { code: 2 }), true)).toMatchObject({ kind: "password", retry: true });
    expect(toOpenError(named("InvalidPDFException"), false)).toMatchObject({ kind: "invalid" });
    expect(toOpenError(new Error("boom"), false)).toMatchObject({ kind: "other", message: "boom" });
  });

  it("passes an already-typed error through and is an Error", () => {
    const e = toOpenError(named("InvalidPDFException"), false);
    expect(e).toBeInstanceOf(Error);
    expect(isPdfOpenError(e)).toBe(true);
    expect(toOpenError(e, false)).toBe(e);
    expect(isPdfOpenError(new Error("x"))).toBe(false);
  });
});

describe.skipIf(!hasFixtures)("openPdf against the fixtures (pdf.js legacy build)", () => {
  it("opens a document and reports page sizes and /Rotate", async () => {
    const doc = await testLoader().openPdf("a", fixture("rotated.pdf"));
    expect(doc.numPages).toBe(3);
    expect(doc.id).toBe("a");
    const p1 = await doc.pageInfo(0);
    expect(p1.w).toBeCloseTo(595.28, 2);
    expect(p1.h).toBeCloseTo(841.89, 2);
    expect(p1.rotate).toBe(0);
    expect((await doc.pageInfo(1)).rotate).toBe(90);
    expect(doc.pageInfo(1)).toBe(doc.pageInfo(1)); // cached
    await doc.destroy();
  });

  it("counts pages", async () => {
    expect(await testLoader().countPages(fixture("plain_3p.pdf"))).toBe(3);
  });

  it("a missing file → missing", async () => {
    await expect(testLoader().openPdf("m", fixture("nope.pdf"))).rejects.toMatchObject({ kind: "missing" });
  });

  it("a corrupt file → invalid", async () => {
    await expect(testLoader().openPdf("c", fixture("corrupt.pdf"))).rejects.toMatchObject({ kind: "invalid" });
  });

  it("an encrypted file asks, then retries on a wrong password, then opens", async () => {
    const l = testLoader();
    await expect(l.openPdf("e", fixture("encrypted.pdf"))).rejects.toMatchObject({ kind: "password", retry: false });
    await expect(l.openPdf("e", fixture("encrypted.pdf"), { password: "nope" })).rejects.toMatchObject({
      kind: "password",
      retry: true,
    });
    const doc = await l.openPdf("e", fixture("encrypted.pdf"), { password: "taroting" });
    expect(doc.numPages).toBeGreaterThan(0);
    await doc.destroy();
  });

  it("holds the shared worker for exactly the life of each document", async () => {
    const w = countingWorker();
    const l = testLoader(w);
    const a = await l.openPdf("a", fixture("plain_3p.pdf"));
    const b = await l.openPdf("b", fixture("hebrew.pdf"));
    expect(w.refs).toBe(2);
    await a.destroy();
    await a.destroy(); // twice is once
    expect(w.refs).toBe(1);
    await b.destroy();
    expect(w.refs).toBe(0);
    // a failed open gives its reference back
    await expect(l.openPdf("c", fixture("corrupt.pdf"))).rejects.toBeTruthy();
    expect(w.acquired).toBe(3);
    expect(w.refs).toBe(0);
    // a missing file never takes one
    await expect(l.openPdf("m", fixture("nope.pdf"))).rejects.toBeTruthy();
    expect(w.acquired).toBe(3);
  });
});

describe("startup cost", () => {
  // core/ipc is on the boot path already: a dynamic import() of it only splits
  // it into its own chunk (plus a runtime chunk) at startup. pdfjs.ts must stay
  // dynamic — open-media imports this module just to count pages.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "loader.ts"), "utf8");
  it("imports core/ipc statically and pdf.js only on demand", () => {
    expect(src).not.toMatch(/import\(\s*["']\.\.\/\.\.\/core\/ipc["']\s*\)/);
    expect(src).toMatch(/^import \{[^}]*\bipc\b[^}]*\} from "\.\.\/\.\.\/core\/ipc";$/m);
    expect(src).not.toMatch(/^import [^;]*from "\.\/pdfjs"/m);
    expect(src).not.toMatch(/^import [^;]*from "pdfjs-dist/m);
  });
});
