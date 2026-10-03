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

type Handler = () => void;

interface FakeNode {
  className: string;
  textContent: string;
  readonly isConnected: boolean;
  parentNode: FakeNode | null;
  children: FakeNode[];
  attrs: Map<string, string>;
  handlers: Map<string, Handler[]>;
  setAttribute(k: string, v: string): void;
  appendChild(c: FakeNode): FakeNode;
  contains(n: unknown): boolean;
  addEventListener(t: string, fn: Handler): void;
  remove(): void;
  focus(): void;
}

function node(): FakeNode {
  const n: FakeNode = {
    className: "",
    textContent: "",
    // Connected = hangs off the document's <body>, as in a real DOM: a node
    // whose parent was removed is disconnected with it.
    get isConnected(): boolean {
      for (let x: FakeNode | null = n; x; x = x.parentNode) if (x === body) return true;
      return false;
    },
    parentNode: null,
    children: [],
    attrs: new Map(),
    handlers: new Map(),
    setAttribute(k, v) {
      n.attrs.set(k, v);
    },
    appendChild(c) {
      // A real append MOVES the node: it leaves its old parent first.
      if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
      c.parentNode = n;
      n.children.push(c);
      return c;
    },
    contains(other) {
      for (let x = other as FakeNode | null; x; x = x.parentNode) if (x === n) return true;
      return false;
    },
    addEventListener(t, fn) {
      n.handlers.set(t, [...(n.handlers.get(t) ?? []), fn]);
    },
    remove() {
      if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((x) => x !== n);
      n.parentNode = null;
    },
    focus() {
      doc.activeElement = n;
    },
  };
  return n;
}

let body: FakeNode;
let doc: {
  body: FakeNode;
  fullscreenElement: FakeNode | null;
  activeElement: FakeNode | null;
  createElement(): FakeNode;
  listeners: Map<string, Set<Handler>>;
  addEventListener(t: string, fn: Handler): void;
  removeEventListener(t: string, fn: Handler): void;
};

beforeEach(() => {
  body = node();
  doc = {
    body,
    fullscreenElement: null,
    activeElement: null,
    createElement: () => node(),
    listeners: new Map(),
    addEventListener(t, fn) {
      if (!doc.listeners.has(t)) doc.listeners.set(t, new Set());
      doc.listeners.get(t)!.add(fn);
    },
    removeEventListener(t, fn) {
      doc.listeners.get(t)?.delete(fn);
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("./errors");
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

/** The toast host, wherever it currently hangs. */
function hostIn(parent: FakeNode): FakeNode | undefined {
  return parent.children.find((c) => c.className === "toast-host");
}

/** Every toast element shown so far, in order (they live in the one host). */
const shown = (): FakeNode[] => hostIn(body)?.children ?? [];

const fsListeners = (): number => doc.listeners.get("fullscreenchange")?.size ?? 0;

function fireFullscreenChange(): void {
  for (const fn of [...(doc.listeners.get("fullscreenchange") ?? [])]) fn();
}

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
    expect("paths" in recentErrors()[0]!).toBe(false);
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

/**
 * A toast that names files hands their WHOLE paths to the ring entry, so the
 * redaction in Settings → Diagnostics and in the report can replace each one
 * whole instead of finding it in free text and cutting it at a space.
 */
describe("toast paths", () => {
  const CLIP = "D:\\Client Work\\Secret Project\\harbour night.mov";
  const PEAKS = "C:\\Users\\adirh\\AppData\\Local\\Taroting\\cache\\9f3a.pk";

  it("keeps the paths with the recorded entry, as a copy", async () => {
    const { toast, recentErrors } = await load();
    const paths = [CLIP, PEAKS];
    toast.error("Couldn't import harbour night: access denied", { op: "Import", paths });
    paths.push("C:\\later\\mutation.txt");
    expect(recentErrors()[0]!.paths).toEqual([CLIP, PEAKS]);
    expect(recentErrors()[0]!.op).toBe("Import");
  });

  it("grows no Details button for paths alone", async () => {
    const { toast, recentErrors } = await load();
    toast.error("Couldn't import harbour night", { paths: [CLIP] });
    expect(shown()).toHaveLength(1);
    expect(shown()[0]!.children).toEqual([]);
    expect("detail" in recentErrors()[0]!).toBe(false);
  });

  it("passes the paths on to the details dialog", async () => {
    const openErrorDialog = vi.fn(() => () => {});
    vi.doMock("./errors", async (orig) => ({ ...(await orig<typeof import("./errors")>()), openErrorDialog }));
    const { toast } = await load();
    toast.error("Couldn't read the waveform", { detail: `peaks: ${PEAKS}`, op: "Waveform", paths: [CLIP, PEAKS] });
    const button = shown()[0]!.children[0]!;
    for (const fn of button.handlers.get("click") ?? []) fn();
    expect(openErrorDialog).toHaveBeenCalledWith({
      title: "Waveform",
      message: "Couldn't read the waveform",
      report: `peaks: ${PEAKS}`,
      paths: [CLIP, PEAKS],
    });
  });
});

/**
 * Screen readers. The host had no live region and no toast had a role, so
 * nothing a toast said was ever announced.
 */
describe("toast announcements", () => {
  it("makes every error toast — refusals included — an alert, and info toasts not", async () => {
    const { toast } = await load();
    toast.error("Couldn't save this project");
    toast.refuse("Please enter a file name.");
    toast.info("Copied");
    expect(shown().map((t) => t.attrs.get("role"))).toEqual(["alert", "alert", undefined]);
  });

  it("gives the host a polite live region that reads additions, not the whole stack", async () => {
    const { toast } = await load();
    toast.info("Copied");
    const host = hostIn(body)!;
    expect(host.attrs.get("aria-live")).toBe("polite");
    // role="status" would imply aria-atomic=true: every stacked toast re-read
    // on each new one.
    expect(host.attrs.has("role")).toBe(false);
    expect(host.attrs.has("aria-atomic")).toBe(false);
  });
});

/**
 * Element fullscreen (the viewer, the theater) puts that element in the top
 * layer: a toast host on <body> is there and invisible. The host goes inside
 * the fullscreen element, and comes back out when fullscreen ends — attaching a
 * listener only while it is inside, so no fullscreen means no listener at all.
 */
describe("toasts under element fullscreen", () => {
  it("never listens for fullscreen changes when nothing is fullscreen", async () => {
    const { toast } = await load();
    toast.info("Copied");
    toast.error("Couldn't save your settings.");
    expect(hostIn(body)).toBeDefined();
    expect(fsListeners()).toBe(0);
  });

  it("shows a toast inside the fullscreen element, and carries the host back out on exit", async () => {
    const { toast } = await load();
    toast.info("Before");
    const host = hostIn(body)!;

    const viewer = node();
    body.appendChild(viewer);
    doc.fullscreenElement = viewer;
    toast.error("Couldn't save your settings.");
    toast.error("Couldn't save your settings, again.");
    // The SAME host moved (its earlier toast with it), and one listener for
    // it however many toasts were raised.
    expect(hostIn(viewer)).toBe(host);
    expect(hostIn(body)).toBeUndefined();
    expect(host.children.map((t) => t.textContent)).toEqual([
      "Before",
      "Couldn't save your settings.",
      "Couldn't save your settings, again.",
    ]);
    expect(fsListeners()).toBe(1);

    doc.fullscreenElement = null;
    fireFullscreenChange();
    expect(hostIn(body)).toBe(host);
    expect(hostIn(viewer)).toBeUndefined();
    expect(host.children).toHaveLength(3);
    expect(fsListeners()).toBe(0);
  });

  it("starts a fresh host on <body> when the fullscreen element took the old one with it", async () => {
    const { toast } = await load();
    const viewer = node();
    body.appendChild(viewer);
    doc.fullscreenElement = viewer;
    toast.info("Inside");
    const first = hostIn(viewer)!;

    // The router clears the screen: the viewer (and the host in it) is gone.
    viewer.remove();
    doc.fullscreenElement = null;
    fireFullscreenChange();
    expect(fsListeners()).toBe(0);

    toast.info("After");
    const second = hostIn(body)!;
    expect(second).not.toBe(first);
    expect(second.children.map((t) => t.textContent)).toEqual(["After"]);
  });
});