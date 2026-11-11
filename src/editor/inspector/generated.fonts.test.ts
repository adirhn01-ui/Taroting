// The inspector's text section with fonts from the library or this PC (0.9.4),
// against the faked font runtime (../media/fonts-fake.test-util). A ready font
// measures 30 px per character, the fallback 10, so a box measured before the
// font loaded is a different number.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGeneratedMedia, createProject } from "../../core/project";
import type { Generator, MediaRef, ProjectFile } from "../../core/types";
import { face, fakeDocument, flush, fontsState, type FakeEl } from "../media/fonts-fake.test-util";

vi.mock("../../fonts", async () => (await import("../media/fonts-fake.test-util")).fakeFonts);
vi.mock("../../ui/toast", () => ({ toast: { info: () => {}, error: () => {}, notice: () => {} } }));

const { buildGeneratedSection } = await import("./generated");

type TextGen = Extract<Generator, { type: "text" }>;

function mount(
  g: TextGen,
  opts: { onCleanup: (fn: () => void) => void; closed: () => boolean } = { onCleanup: () => {}, closed: () => false },
) {
  const { doc } = fakeDocument();
  vi.stubGlobal("document", doc);
  const made = addGeneratedMedia(createProject("t"), g, 2, 2, "Text");
  let project: ProjectFile = made.project;
  const commits: MediaRef[] = [];
  const session = {
    get project() {
      return project;
    },
    commit(fn: (p: ProjectFile) => ProjectFile) {
      project = fn(project);
      commits.push(project.media.find((m) => m.id === made.media.id)!);
    },
  };
  /** Build the section (again: what the inspector does after every commit). */
  const build = () => {
    const s = buildGeneratedSection(
      { session: session as never, refresh: () => {} },
      { clip: {} as never, media: made.media },
      opts,
    ) as unknown as FakeEl;
    const picker = fontsState.pickers[fontsState.pickers.length - 1]!;
    const all = (pred: (e: FakeEl) => boolean): FakeEl[] => {
      const out: FakeEl[] = [];
      const walk = (e: FakeEl): void => {
        if (pred(e)) out.push(e);
        for (const c of e.children) walk(c);
      };
      walk(s);
      return out;
    };
    const switches = all((e) => e.tag === "input" && e.type === "checkbox");
    const textarea = all((e) => e.tag === "textarea")[0]!;
    return { picker, bold: switches[0]!, italic: switches[1]!, textarea };
  };
  return { commits, ...build(), rebuilt: build };
}

const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Hi there",
  fontFamily: "Arial",
  sizePx: 30,
  color: "#123456",
  bold: true,
  italic: false,
  ...over,
});

beforeEach(() => fontsState.reset());
afterEach(() => vi.unstubAllGlobals());

describe("the inspector's text section", () => {
  it("commits a legacy edit at once, without the font runtime", () => {
    const t = mount(gen());
    t.textarea.value = "Hey";
    t.textarea.fire("change");
    expect(t.commits.length).toBe(1);
    expect(fontsState.ensureCalls).toEqual([]);
  });

  it("measures a picked font only once it is ready", async () => {
    fontsState.late = true;
    const t = mount(gen());
    t.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    expect(t.commits.length).toBe(0);
    fontsState.release();
    await flush();
    expect(t.commits.length).toBe(1);
    const m = t.commits[0]!;
    // "Hi there" is 8 characters: 30 px each in Inter (it would be 80 in the fallback).
    expect(m.width).toBe(240);
    expect(m.generator).toMatchObject({ fontFamily: "Segoe UI", fontId: "lib:Inter" });
  });

  it("a newer edit wins over an older one still waiting for its font", async () => {
    fontsState.late = true;
    const t = mount(gen());
    t.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    t.picker.opts.onPick({ legacy: "Georgia" });
    expect(t.commits.length).toBe(1);
    fontsState.release();
    await flush();
    expect(t.commits.length).toBe(1);
    expect(t.commits[0]!.generator).toMatchObject({ fontFamily: "Georgia" });
    expect("fontId" in t.commits[0]!.generator!).toBe(false);
  });

  it("disables Bold for a family without a bold face", () => {
    fontsState.faces.set("Consolas", [face(false, false), face(false, true)]);
    const t = mount(gen({ fontFamily: "Segoe UI", fontId: "Consolas" }));
    expect(t.bold.disabled).toBe(true);
    expect(t.bold.checked).toBe(false);
    expect(t.italic.disabled).toBe(false);
  });
});

describe("the text section's cleanup", () => {
  /** Mount with the inspectors' hooks: `run()` is what they do on a rebuild
   *  or a replacement, `close()` what they do on dispose. */
  function mountWithCleanup(g: TextGen) {
    const fns: (() => void)[] = [];
    let isClosed = false;
    const t = mount(g, { onCleanup: (fn) => fns.push(fn), closed: () => isClosed });
    const run = (): void => fns.forEach((fn) => fn());
    return {
      ...t,
      fns,
      run,
      close: () => {
        isClosed = true;
        run();
      },
    };
  }

  it("hands the inspector one cleanup, which disposes the picker", () => {
    const t = mountWithCleanup(gen());
    expect(t.fns).toHaveLength(1);
    expect(t.picker.disposed).toBe(false);
    t.run();
    expect(t.picker.disposed).toBe(true);
  });

  it("a commit waiting for its font still lands after a rebuild or replacement, measured with the font", async () => {
    fontsState.late = true;
    const t = mountWithCleanup(gen());
    t.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    t.run();
    expect(t.picker.disposed).toBe(true);
    fontsState.release();
    await flush();
    expect(t.commits).toHaveLength(1);
    // 8 characters at 30 px in Inter (80 would be the fallback's measure).
    expect(t.commits[0]!.width).toBe(240);
    expect(t.commits[0]!.generator).toMatchObject({ fontId: "lib:Inter" });
  });

  it("a commit waiting for its font commits nothing once the editor has closed", async () => {
    fontsState.late = true;
    const t = mountWithCleanup(gen());
    t.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    t.close();
    fontsState.release();
    await flush();
    expect(t.commits).toEqual([]);
  });

  it("a sync edit from a rebuilt section wins over the replaced section's waiting commit", async () => {
    fontsState.late = true;
    const a = mountWithCleanup(gen());
    a.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    a.run();
    // The rebuilt section (another build, the same element) commits at once.
    a.rebuilt().picker.opts.onPick({ legacy: "Georgia" });
    fontsState.release();
    await flush();
    expect(a.commits.map((m) => (m.generator as TextGen).fontFamily)).toEqual(["Georgia"]);
  });
});
