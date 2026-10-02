import { describe, expect, it } from "vitest";
import { CRASH_TITLES, ENGINE_NOT_RESTARTED, crashTitle, showCrashNotes, type CrashNoteSink } from "./crash-notes";
import type { CrashNote } from "./ipc";
import type { ToastOptions } from "../ui/toast";

/** Records every toast instead of painting it (vitest runs without a DOM). */
function recorder(): { sink: CrashNoteSink; calls: { message: string; opts?: ToastOptions }[] } {
  const calls: { message: string; opts?: ToastOptions }[] = [];
  return { sink: { error: (message, opts) => calls.push({ message, opts }) }, calls };
}

/* Every note differs from every other on kind, time and detail, so a title or
 * a detail that lands on the wrong toast cannot line up by accident. */
const PANIC: CrashNote = {
  kind: "panic",
  at: "2026-09-30T21:04:17Z",
  detail: "Taroting 0.9.1\ntime: 2026-09-30T21:04:17Z\nkind: panic\nthread: main\nmessage: slice index 9 out of range",
};
const FAULT: CrashNote = {
  kind: "fault",
  at: "2026-08-02T03:11:58Z",
  detail: "Taroting 0.9.1\ntime: 2026-08-02T03:11:58Z\nkind: fault\ncode: 0xC0000005\nmodule: avcodec-61.dll+0x1A2B3C",
};
const PAGE: CrashNote = {
  kind: "page",
  at: "2026-10-01T09:45:00Z",
  detail: "Taroting 0.9.1\ntime: 2026-10-01T09:45:00Z\nkind: page\nreason: crashed\nexit code: 0xC0000409",
};
const ENGINE: CrashNote = {
  kind: "engine",
  at: null,
  detail: "Taroting 0.9.1\ntime: unknown\nkind: engine\nreason: terminated\nexit code: 0x00000001",
};

describe("showCrashNotes", () => {
  it("raises one error toast per note, in order, each with its own title and detail", () => {
    const { sink, calls } = recorder();
    showCrashNotes([PANIC, FAULT, PAGE, ENGINE], sink);
    expect(calls.map((c) => c.message)).toEqual([
      "Taroting closed unexpectedly last time.",
      "Taroting closed unexpectedly last time.",
      "The page stopped working, so Taroting reloaded it. Edits made since the last autosave may be lost.",
      "Taroting's display engine stopped, so Taroting restarted. Edits made since the last autosave may be lost.",
    ]);
    expect(calls.map((c) => c.opts?.detail)).toEqual([PANIC.detail, FAULT.detail, PAGE.detail, ENGINE.detail]);
  });

  it("labels every toast for Settings → Diagnostics and the details dialog", () => {
    const { sink, calls } = recorder();
    showCrashNotes([PAGE, FAULT], sink);
    for (const c of calls) {
      expect(c.opts?.op).toBe("Crash");
      expect(c.opts?.title).toBe("Crash report");
    }
  });

  it("passes the detail through untouched — redaction belongs to the detail pane", () => {
    // The pane (ui/errors detailPane) redacts on display and copy; scrubbing
    // here too would hide the path from nobody and drift from that scrubber.
    const withPath: CrashNote = { ...PANIC, detail: "message: can't open C:\\Users\\Someone\\clip 7.mp4" };
    const { sink, calls } = recorder();
    showCrashNotes([withPath], sink);
    expect(calls[0]?.opts?.detail).toBe(withPath.detail);
  });

  it("says the app closed, not restarted, when the engine note refused the restart", () => {
    // The exact line crash.rs writes when engine_restart_allowed said no.
    const refused: CrashNote = {
      ...ENGINE,
      detail: `${ENGINE.detail}\nrestarted: no (the engine also stopped less than a minute earlier)`,
    };
    const restarted: CrashNote = { ...ENGINE, detail: `${ENGINE.detail}\nrestarted: yes` };
    const { sink, calls } = recorder();
    showCrashNotes([refused, restarted], sink);
    expect(calls.map((c) => c.message)).toEqual([ENGINE_NOT_RESTARTED, CRASH_TITLES.engine]);
    // Only an engine note reads its detail: a panic message quoting the line is still a panic.
    expect(crashTitle("panic", "restarted: no")).toBe(CRASH_TITLES.panic);
  });

  it("shows nothing for no notes", () => {
    const { sink, calls } = recorder();
    showCrashNotes([], sink);
    expect(calls).toEqual([]);
  });

  it("reads an unknown kind as the plain closed-unexpectedly title", () => {
    const odd = { ...ENGINE, kind: "gpu" } as unknown as CrashNote;
    const { sink, calls } = recorder();
    showCrashNotes([odd], sink);
    expect(calls[0]?.message).toBe(CRASH_TITLES.panic);
    expect(calls[0]?.opts?.detail).toBe(ENGINE.detail);
  });

  it("never takes a title from the object prototype", () => {
    // `kind in CRASH_TITLES` would accept "toString" and hand back a function.
    expect(crashTitle("toString")).toBe(CRASH_TITLES.panic);
    expect(crashTitle("constructor")).toBe(CRASH_TITLES.panic);
  });

  it("titles are sentence case with no trailing ellipsis", () => {
    for (const t of Object.values(CRASH_TITLES)) {
      expect(t[0]).toBe(t[0]!.toUpperCase());
      expect(t.endsWith("…") || t.endsWith("...")).toBe(false);
    }
  });
});
