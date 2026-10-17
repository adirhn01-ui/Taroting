import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { key, type FakeElement } from "../editor/fake-dom.test-util";
import { fakeDoc, installEnv, pagesOf, until, type Env } from "./dom.test-util";

vi.mock("./pdfjs", async () => (await import("./dom.test-util")).pdfjsModule());

const { createThumbRail } = await import("./thumbs");

let env: Env;
beforeEach(() => {
  env = installEnv();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(n: number) {
  const doc = fakeDoc(n);
  const onPick = vi.fn();
  const rail = createThumbRail({ onPick });
  env.doc.body.appendChild(rail.el as unknown as FakeElement);
  rail.setPages(pagesOf(doc));
  const el = rail.el as unknown as FakeElement;
  const rows = el.querySelectorAll(".pdfv-thumb");
  const near = (...slots: number[]): void =>
    env.io[env.io.length - 1]!.cb(slots.map((i) => ({ target: rows[i]!, isIntersecting: true })));
  return { doc, rail, el, rows, near, onPick };
}

describe("thumbnail rail", () => {
  it("releases pdf.js page data once a thumbnail is painted", async () => {
    const { doc, near, rail } = mount(3);
    near(0);
    await until(() => (doc.proxies.get(1)?.render.mock.calls.length ?? 0) > 0);
    await until(() => doc.proxies.get(1)!.cleanup.mock.calls.length > 0);
    rail.dispose();
  });

  it("keys it handles never reach the window's shortcuts (ArrowRight = next file)", () => {
    const { el, rail } = mount(5);
    const seen: string[] = [];
    env.win.addEventListener("keydown", (e: { key: string }) => seen.push(e.key));
    for (const k of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " "]) key(el, k);
    expect(seen).toEqual([]);
    // a key the rail does not handle still does
    key(el, "F5");
    expect(seen).toEqual(["F5"]);
    rail.dispose();
  });

  it("asks page sizes only for items near the rail's viewport", () => {
    const { doc, near, rail } = mount(2000);
    expect(doc.pageInfo).not.toHaveBeenCalled();
    near(0, 1, 2);
    expect(doc.pageInfo.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    near(1);
    expect(doc.pageInfo).toHaveBeenCalledTimes(3);
    rail.dispose();
  });

  it("following the current page touches only the old and new items", () => {
    const { rows, rail } = mount(500);
    rail.setCurrent(3);
    const spies = rows.map((r) => vi.spyOn(r, "setAttribute"));
    const classes = rows.map((r) => vi.spyOn(r.classList, "toggle"));
    rail.setCurrent(4);
    const touched = rows.filter((_, i) => spies[i]!.mock.calls.length > 0 || classes[i]!.mock.calls.length > 0);
    expect(touched.length).toBeLessThanOrEqual(2);
    expect(rows[3]!.getAttribute("aria-selected")).toBe("false");
    expect(rows[4]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[4]!.classList.contains("pdfv-thumb--current")).toBe(true);
    expect(rows[3]!.classList.contains("pdfv-thumb--current")).toBe(false);
    rail.dispose();
  });
});
