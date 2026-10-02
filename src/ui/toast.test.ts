import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which toasts reach the recent-errors ring (Settings → Diagnostics, the
 * diagnostic report).
 *
 * Only a toast that carried details used to be recorded, so the plain failures
 * — "Couldn't import …", "Couldn't save this project" — never reached it and
 * Diagnostics said nothing had failed. Recording every error toast blindly would
 * have the opposite fault: a dozen input refusals evicting the real errors from
 * a ring of twenty. So an error is recorded, a refusal is not, and a toast with
 * details is recorded once, not twice.
 *
 * Every test loads the two modules afresh: the ring is module state, and a
 * count from a ring other tests already wrote to would prove nothing.
 */

interface FakeNode {
  className: string;
  textContent: string;
  isConnected: boolean;
  children: FakeNode[];
  appendChild(c: FakeNode): FakeNode;
  addEventListener(): void;
  remove(): void;
}

function node(): FakeNode {
  const n: FakeNode = {
    className: "",
    textContent: "",
    isConnected: true,
    children: [],
    appendChild(c) {
      n.children.push(c);
      return c;
    },
    addEventListener() {},
    remove() {
      n.isConnected = false;
    },
  };
  return n;
}

let body: FakeNode;

beforeEach(() => {
  body = node();
  vi.stubGlobal("document", { body, createElement: () => node() });
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load(): Promise<{
  toast: typeof import("./toast").toast;
  recentErrors: typeof import("./errors").recentErrors;
}> {
  const { toast } = await import("./toast");
  const { recentErrors } = await import("./errors");
  return { toast, recentErrors };
}

/** Every toast element shown so far, in order (they live in the one host). */
const shown = (): FakeNode[] => body.children.flatMap((host) => host.children);

describe("toast and the recent-errors ring", () => {
  it("records a failure without details, and never a refusal", async () => {
    const { toast, recentErrors } = await load();
    expect(recentErrors()).toHaveLength(0);

    toast.error("Couldn't import harbour.mov");
    toast.refuse("Please enter a file name.");

    expect(recentErrors()).toHaveLength(1);
    expect(recentErrors()[0]!.message).toBe("Couldn't import harbour.mov");
    expect(recentErrors()[0]!.op).toBe("");
    expect("detail" in recentErrors()[0]!).toBe(false);
  });

  it("styles a refusal as an error all the same", async () => {
    const { toast } = await load();
    toast.refuse("Unsupported file type.");
    expect(shown().map((t) => [t.className, t.textContent])).toEqual([
      ["toast toast--error", "Unsupported file type."],
    ]);
  });

  it("records a failure WITH details exactly once, details and operation kept", async () => {
    const { toast, recentErrors } = await load();
    toast.error("Export failed", { detail: "ffmpeg exited with 0xffffffea", op: "Export" });
    expect(recentErrors()).toHaveLength(1);
    expect(recentErrors()[0]).toMatchObject({
      op: "Export",
      message: "Export failed",
      detail: "ffmpeg exited with 0xffffffea",
    });
  });

  it("never records an info toast", async () => {
    const { toast, recentErrors } = await load();
    toast.info("Copied");
    expect(recentErrors()).toHaveLength(0);
  });
});
