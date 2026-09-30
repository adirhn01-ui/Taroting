import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, ProjectFile } from "../core/types";

// The "Open as" dialog against a small fake DOM (vitest runs in node): the
// disable rule and its counted reason, where focus opens, every close path,
// the two choices, and the image-project creation behind "Image project".

const m = vi.hoisted(() => ({
  probe: new Map<string, MediaInfo | Error>(),
  saved: [] as Array<{ path: string; project: ProjectFile }>,
  errors: [] as string[],
  releases: 0,
}));
vi.mock("../core/ipc", () => ({
  ipc: {
    probeMedia: async (p: string) => {
      const v = m.probe.get(p);
      if (!v || v instanceof Error) throw v ?? new Error("no such file");
      return v;
    },
    newProjectPath: async (s?: string) => `C:\\Docs\\Taroting\\${s ?? "Untitled"}.trt`,
    saveProject: async (path: string, project: ProjectFile) => void m.saved.push({ path, project }),
  },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../ui/toast", () => ({ toast: { error: (s: string) => void m.errors.push(s), info: () => {} } }));
vi.mock("../ui/focus", () => ({ trapTab: () => () => void m.releases++ }));
vi.mock("../ui/icons", () => ({ icon: (n: string) => `<svg data-i="${n}"></svg>` }));
vi.mock("../core/open-media", () => ({
  stillSizeProblem: (i: MediaInfo) => ((i.width ?? 0) > 0 && (i.height ?? 0) > 0 ? null : `Couldn't read the size of x.`),
}));

type Handler = (e: unknown) => void;

class Listeners {
  private map = new Map<string, Set<Handler>>();
  addEventListener(t: string, fn: Handler): void {
    if (!this.map.has(t)) this.map.set(t, new Set());
    this.map.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.map.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown): void {
    for (const fn of [...(this.map.get(t) ?? [])]) fn(e);
  }
  count(t: string): number {
    return this.map.get(t)?.size ?? 0;
  }
}

class El extends Listeners {
  readonly tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  className = "";
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  id = "";
  type = "";
  title = "";
  disabled = false;
  innerHTML = "";
  private text = "";
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  appendChild(c: El): El {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  focus(): void {
    doc.activeElement = this;
  }
  /** Depth-first: every descendant matching `pred`. */
  find(pred: (e: El) => boolean): El[] {
    const out: El[] = [];
    const walk = (e: El): void => {
      for (const c of e.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** A click as the engine delivers it: nothing on a disabled button. */
  click(): void {
    if (!this.disabled) this.fire("click", { target: this });
  }
}

const body = new El("body");
const doc = Object.assign(new Listeners(), {
  body,
  activeElement: body as El | null,
  createElement: (tag: string) => new El(tag),
});
vi.stubGlobal("document", doc);

const { MAX_OPEN_AS_PICTURES, createImageProjectFrom, imageProjectBlocker, openAsTitle, openOpenAsDialog } =
  await import("./open-as-dialog");

const backdrop = (): El | undefined => body.children.find((c) => c.className === "modal-backdrop");
const option = (kind: string): El => backdrop()!.find((e) => e.dataset.kind === kind)[0]!;
const byText = (t: string): El => backdrop()!.find((e) => e.tagName === "BUTTON" && e.textContent === t)[0]!;
const xButton = (): El => backdrop()!.find((e) => e.attrs.get("aria-label") === "Close")[0]!;

/** Every dialog a test opened, closed before the next test so none of their
 *  document listeners leak into it. */
const openClosers: Array<() => void> = [];

/** `work`: what a choice's callback returns; by default it settles at once. */
function open(paths: string[], work: () => Promise<void> = async () => {}) {
  const calls: string[] = [];
  const close = openOpenAsDialog({
    paths,
    onVideo: () => {
      calls.push("video");
      return work();
    },
    onImage: () => {
      calls.push("image");
      return work();
    },
    onClosed: () => calls.push("closed"),
  });
  openClosers.push(close);
  return { calls, close };
}

/** Lets every pending promise callback run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve(): void; reject(e: Error): void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const c of openClosers.splice(0)) c();
  body.children = [];
  doc.activeElement = body;
  m.probe.clear();
  m.saved = [];
  m.errors = [];
  m.releases = 0;
});

describe("imageProjectBlocker", () => {
  const rows: Array<[paths: string[], want: string | null]> = [
    [["a.png", "b.JPG", "c.webp", "d.bmp", "e.jpeg"], null],
    [["a.png"], null],
    [["a.mp4"], "Image projects hold pictures only. This is a video."],
    [["a.gif"], "Image projects hold pictures only. This is a GIF."],
    [["a.mp3"], "Image projects hold pictures only. This is an audio file."],
    [["a.png", "b.mov", "c.gif"], "Image projects hold pictures only. 1 of these is a video and 1 is a GIF."],
    [["a.png", "b.gif", "c.GIF"], "Image projects hold pictures only. 2 of these are GIFs."],
    [["a.png", "b.mkv"], "Image projects hold pictures only. 1 of these is a video."],
    [["a.png", "b.wav", "c.flac", "d.ogg"], "Image projects hold pictures only. 3 of these are audio files."],
    [
      ["a.png", "b.webm", "c.aac", "d.m4a"],
      "Image projects hold pictures only. 1 of these is a video and 2 are audio files.",
    ],
    [
      ["a.avi", "b.wmv", "c.mp3", "d.xyz"],
      "Image projects hold pictures only. 2 of these are videos, 1 is an audio file and 1 is not a picture.",
    ],
  ];
  it.each(rows)("%j → %s", (paths, want) => {
    expect(imageProjectBlocker(paths)).toBe(want);
  });

  const pictures = (n: number): string[] => Array.from({ length: n }, (_, i) => `C:\\p\\shot ${i + 1}.jpg`);
  it("takes up to 20 pictures, and refuses the 21st with a way forward", () => {
    expect(MAX_OPEN_AS_PICTURES).toBe(20);
    expect(imageProjectBlocker(pictures(20))).toBeNull();
    expect(imageProjectBlocker(pictures(21))).toBe(
      "Image projects start from up to 20 pictures. Pick fewer, or choose Video project.",
    );
  });

  it("names what is not a picture before it counts", () => {
    // 21 files with a video among them: the video is the reason, not the count.
    expect(imageProjectBlocker([...pictures(20), "C:\\p\\clip.mp4"])).toBe(
      "Image projects hold pictures only. 1 of these is a video.",
    );
  });

  it("titles by count", () => {
    expect(openAsTitle(1)).toBe("Open 1 file as");
    expect(openAsTitle(7)).toBe("Open 7 files as");
  });
});

describe("openOpenAsDialog", () => {
  it("offers both choices for pictures, titled by count, focused on Video project", () => {
    open(["C:\\p\\a.png", "C:\\p\\b.jpg"]);
    expect(backdrop()!.find((e) => e.id === "openas-title")[0]!.textContent).toBe("Open 2 files as");
    expect(option("video").disabled).toBe(false);
    expect(option("image").disabled).toBe(false);
    expect(option("video").textContent).toContain("Video project");
    expect(option("image").textContent).toContain("Image project");
    // Same classes as a rich menu row: icon tile, label, hint.
    expect(option("image").find((e) => e.className === "ctx-menu__icon")[0]!.innerHTML).toContain('data-i="image"');
    expect(option("video").find((e) => e.className === "ctx-menu__hint")).toHaveLength(1);
    expect(backdrop()!.find((e) => e.className === "openas-reason")).toEqual([]);
    expect(doc.activeElement).toBe(option("video"));
  });

  it("disables Image project with its counted reason rendered under it when a video is among the files", () => {
    open(["C:\\p\\a.png", "C:\\p\\b.mp4"]);
    const image = option("image");
    expect(image.disabled).toBe(true);
    const reason = backdrop()!.find((e) => e.className === "openas-reason")[0]!;
    expect(reason.textContent).toBe("Image projects hold pictures only. 1 of these is a video.");
    expect(image.attrs.get("aria-describedby")).toBe(reason.id);
    expect(option("video").disabled).toBe(false);
    expect(doc.activeElement).toBe(option("video"));
    image.click();
    expect(backdrop()).toBeDefined();
  });

  it("names the picture whose size the canvas takes when there are several", () => {
    open(["C:\\p\\Shot 2.png", "C:\\q\\shot 10.jpg"]);
    const hint = option("image").find((e) => e.className === "ctx-menu__hint")[0]!;
    expect(hint.textContent).toBe("Every picture a layer, on a canvas the size of Shot 2.png");
  });

  it("Video project calls back once, then closes the dialog when the work settles", async () => {
    const { calls } = open(["C:\\p\\a.mp4"]);
    option("video").click();
    option("video").click();
    expect(calls).toEqual(["video"]);
    await flush();
    expect(calls).toEqual(["video", "closed"]);
    expect(backdrop()).toBeUndefined();
    expect(m.releases).toBe(1);
    expect(doc.count("keydown")).toBe(0);
  });

  it("Image project calls back once, then closes the dialog when the work settles", async () => {
    const { calls } = open(["C:\\p\\a.png"]);
    option("image").click();
    expect(calls).toEqual(["image"]);
    await flush();
    expect(calls).toEqual(["image", "closed"]);
    expect(backdrop()).toBeUndefined();
  });

  it("stays up and busy while the chosen project is made; no way out but the work settling", async () => {
    const work = deferred();
    const { calls } = open(["C:\\p\\a.png", "C:\\p\\b.png"], () => work.promise);
    option("image").click();
    const modal = backdrop()!.find((e) => e.className === "modal openas-modal")[0]!;
    expect(modal.attrs.get("aria-busy")).toBe("true");
    expect(option("video").disabled).toBe(true);
    expect(option("image").disabled).toBe(true);
    expect(option("image").dataset.pending).toBe("");
    expect(option("video").dataset.pending).toBeUndefined();
    // Focus sits on Cancel, which stays focusable (so the trap keeps holding)
    // but is marked inert, like the X.
    const cancel = byText("Cancel");
    expect(doc.activeElement).toBe(cancel);
    expect(cancel.disabled).toBe(false);
    expect(cancel.attrs.get("aria-disabled")).toBe("true");
    expect(xButton().attrs.get("aria-disabled")).toBe("true");
    for (const [, act] of cancels) act();
    option("video").click();
    await flush();
    expect(calls).toEqual(["image"]);
    expect(backdrop()).toBeDefined();
    expect(doc.count("keydown")).toBe(1);
    work.resolve();
    await flush();
    expect(calls).toEqual(["image", "closed"]);
    expect(backdrop()).toBeUndefined();
    expect(m.releases).toBe(1);
    expect(doc.count("keydown")).toBe(0);
  });

  it("closes, and says why, when the chosen work fails", async () => {
    const work = deferred();
    const { calls } = open(["C:\\p\\a.mp4"], () => work.promise);
    option("video").click();
    work.reject(new Error("disk full"));
    await flush();
    expect(calls).toEqual(["video", "closed"]);
    expect(backdrop()).toBeUndefined();
    expect(m.errors).toEqual(["disk full"]);
  });

  it("Home's teardown still closes a busy dialog, once", async () => {
    const work = deferred();
    const { calls, close } = open(["C:\\p\\a.png"], () => work.promise);
    option("image").click();
    close();
    expect(calls).toEqual(["image", "closed"]);
    expect(backdrop()).toBeUndefined();
    work.resolve();
    await flush();
    expect(calls).toEqual(["image", "closed"]);
    expect(m.releases).toBe(1);
  });

  const cancels: Array<[string, () => void]> = [
    ["Escape", () => doc.fire("keydown", { key: "Escape", preventDefault: () => {}, stopPropagation: () => {} })],
    ["Cancel", () => byText("Cancel").click()],
    ["the X", () => xButton().click()],
    ["the backdrop", () => backdrop()!.fire("pointerdown", { target: backdrop() })],
  ];
  it.each(cancels)("%s cancels: no choice, trap and listener released", (_name, act) => {
    const { calls } = open(["C:\\p\\a.png", "C:\\p\\b.png"]);
    act();
    expect(calls).toEqual(["closed"]);
    expect(backdrop()).toBeUndefined();
    expect(m.releases).toBe(1);
    expect(doc.count("keydown")).toBe(0);
  });

  it("a press inside the dialog is not a backdrop press, and other keys do nothing", () => {
    const { calls } = open(["C:\\p\\a.png"]);
    backdrop()!.fire("pointerdown", { target: option("video") });
    doc.fire("keydown", { key: "Enter", preventDefault: () => {}, stopPropagation: () => {} });
    expect(calls).toEqual([]);
    expect(backdrop()).toBeDefined();
  });

  it("the closer (Home's teardown) is idempotent", () => {
    const { calls, close } = open(["C:\\p\\a.png"]);
    close();
    close();
    expect(calls).toEqual(["closed"]);
    expect(m.releases).toBe(1);
  });
});

describe("createImageProjectFrom", () => {
  const still = (path: string, w: number, h: number, patch: Partial<MediaInfo> = {}): MediaInfo => ({
    path,
    size: 1,
    mtimeMs: 1,
    kind: "image",
    duration: 0,
    width: w,
    height: h,
    hasAudio: false,
    ...patch,
  });

  it("saves one image project from the pictures in order, canvas from the first", async () => {
    m.probe.set("C:\\p\\a.png", still("C:\\p\\a.png", 97, 61));
    m.probe.set("C:\\p\\b.png", still("C:\\p\\b.png", 641, 361));
    const out = await createImageProjectFrom(["C:\\p\\a.png", "C:\\p\\b.png"], () => false);
    expect(out).toBe("C:\\Docs\\Taroting\\a.trt");
    expect(m.saved).toHaveLength(1);
    const p = m.saved[0]!.project;
    expect(p.kind).toBe("image");
    expect([p.timeline.width, p.timeline.height]).toEqual([97, 61]);
    expect(p.timeline.tracks.map((t) => t.name)).toEqual(["b", "a"]);
    expect(m.errors).toEqual([]);
  });

  it("names and skips a file that fails to probe or is not a still, and keeps the rest", async () => {
    m.probe.set("C:\\p\\bad.png", new Error("corrupt"));
    m.probe.set("C:\\p\\anim.webp", still("C:\\p\\anim.webp", 10, 10, { kind: "video" }));
    m.probe.set("C:\\p\\ok.jpg", still("C:\\p\\ok.jpg", 30, 20));
    const out = await createImageProjectFrom(["C:\\p\\bad.png", "C:\\p\\anim.webp", "C:\\p\\ok.jpg"], () => false);
    expect(out).toBe("C:\\Docs\\Taroting\\ok.trt");
    expect(m.errors).toEqual(["Couldn't open bad: corrupt", "anim is not a still picture, so it was left out."]);
    const p = m.saved[0]!.project;
    expect([p.timeline.width, p.timeline.height]).toEqual([30, 20]);
    expect(p.media.map((x) => x.path)).toEqual(["C:\\p\\ok.jpg"]);
  });

  it("makes nothing when every file fails", async () => {
    m.probe.set("C:\\p\\a.png", still("C:\\p\\a.png", 0, 0));
    expect(await createImageProjectFrom(["C:\\p\\a.png", "C:\\p\\missing.png"], () => false)).toBeNull();
    expect(m.saved).toEqual([]);
    expect(m.errors.at(-1)).toBe("None of the pictures could be opened, so no project was made.");
  });

  it("makes nothing, silently, for a Home that has gone away", async () => {
    m.probe.set("C:\\p\\a.png", still("C:\\p\\a.png", 5, 5));
    expect(await createImageProjectFrom(["C:\\p\\a.png"], () => true)).toBeNull();
    expect(m.saved).toEqual([]);
    expect(m.errors).toEqual([]);
  });
});
