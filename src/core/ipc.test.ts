import { describe, expect, it } from "vitest";
import { ipc } from "./ipc";

/*
 * The IPC surface's shape where it changed for 0.9.1. Outside the desktop app
 * (this suite, a plain-browser preview) a read command answers its inert
 * fallback, so a screen that asks on mount stays previewable.
 */
describe("ipc surface", () => {
  it("lists no orphaned temporary projects outside the desktop app", async () => {
    await expect(ipc.listOrphanTempProjects()).resolves.toEqual([]);
  });

  it("no longer offers the filmstrip command the backend removed", () => {
    // A wrapper left behind would compile and then reject at runtime with
    // "command not found" — only ever on the path that first called it.
    expect("ensureFilmstrip" in ipc).toBe(false);
  });
});
