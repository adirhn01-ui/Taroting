import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontCatalog, FontFamilyInfo } from "../core/types";
import { installFakeDom, type FakeDom, type FakeEl } from "./fake-dom.test-util";

// The shared font picker mounted against a small fake DOM and a fake IPC. The
// real keyboard-ownership module is used, so "holds blockShortcuts while
// open" is checked against the real token count, not a mock.

const ipcMock = vi.hoisted(() => ({
  fontsResolve: vi.fn(),
  fontsList: vi.fn(),
  fontsImport: vi.fn(),
  fontsRemove: vi.fn(),
}));
vi.mock("../core/ipc", () => ({ ipc: ipcMock, mediaUrl: (p: string) => p }));

type Fonts = typeof import("./index");
type Shortcuts = typeof import("../core/shortcuts");
let F: Fonts;
let S: Shortcuts;
let dom: FakeDom;

const fam = (id: string, name: string, source: "library" | "installed"): FontFamilyInfo => ({
  id,
  name,
  source,
  faces: [{ bold: false, italic: false, weight: 400, style: "Regular", embed: "full" }],
});
// Installed deliberately out of order, and missing two legacy fonts (Impact,
// Georgia) that the picker must still offer.
const CATALOG: FontCatalog = {
  library: [fam("lib:Zilla", "Zilla", "library"), fam("lib:Inter", "Inter", "library")],
  installed: [
    fam("Segoe UI", "Segoe UI", "installed"),
    fam("Consolas", "Consolas", "installed"),
    fam("Arial", "Arial", "installed"),
    fam("Courier New", "Courier New", "installed"),
    fam("Times New Roman", "Times New Roman", "installed"),
    fam("Bahnschrift", "Bahnschrift", "installed"),
  ],
};

beforeEach(async () => {
  vi.resetModules();
  for (const f of Object.values(ipcMock)) f.mockReset();
  ipcMock.fontsList.mockResolvedValue(CATALOG);
  dom = installFakeDom();
  F = await import("./index");
  S = await import("../core/shortcuts");
});
afterEach(() => dom.restore());

function mount(value: { legacy: "Segoe UI" | "Arial" | "Impact"; fontId?: string } = { legacy: "Arial" }) {
  const host = dom.doc.createElement("div");
  dom.doc.body.appendChild(host);
  const picks: unknown[] = [];
  const handle = F.mountFontPicker(host as unknown as HTMLElement, {
    value: () => value,
    onPick: (v) => picks.push(v),
  });
  const btn = host.children[0]!;
  return { host, btn, picks, handle };
}
const popover = (): FakeEl | undefined => dom.doc.body.children.find((c) => c.classList.contains("fontpk__pop"));
/** The list's group headers and rows that a search has not hidden. */
const shown = (): FakeEl[] => popover()!.findAll("fontpk__list")[0]!.children.filter((c) => !c.hidden);
const search = (): FakeEl => popover()!.findAll("fontpk__search")[0]!;
/** Group headers and row names, in order, e.g. ["# Your fonts", "Inter", …]. */
const listing = (): string[] =>
  shown().map((c) => (c.classList.contains("fontpk__group") ? `# ${c.textContent}` : c.findAll("fontpk__name")[0]!.textContent));
const activeName = (): string =>
  popover()!.findAll("fontpk__row--active").map((r) => r.findAll("fontpk__name")[0]!.textContent)[0] ?? "";
async function openBy(btn: FakeEl, how: "click" | string = "click"): Promise<void> {
  if (how === "click") dom.fire(btn, "click");
  else dom.fire(btn, "keydown", { key: how });
  await vi.waitFor(() => expect(popover()?.findAll("fontpk__row").length ?? 0).toBeGreaterThan(0));
}

describe("the closed control", () => {
  it("is a select-styled control showing the font in force, and fetches nothing", async () => {
    const { btn } = mount({ legacy: "Segoe UI", fontId: "lib:Inter" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className.split(" ")).toEqual(expect.arrayContaining(["select", "select--sm", "fontpk"]));
    expect(btn.textContent).toBe("Inter");
    expect(btn.getAttribute("aria-label")).toBe("Font");
    await new Promise((r) => setTimeout(r, 0));
    expect(ipcMock.fontsList).not.toHaveBeenCalled();
    expect(ipcMock.fontsResolve).not.toHaveBeenCalled();
  });

  it("refresh re-reads the value", () => {
    const value: { legacy: "Arial" | "Impact"; fontId?: string } = { legacy: "Arial" };
    const host = dom.doc.createElement("div");
    const h = F.mountFontPicker(host as unknown as HTMLElement, { value: () => value, onPick: () => {} });
    expect(host.children[0]!.textContent).toBe("Arial");
    value.legacy = "Impact";
    h.refresh();
    expect(host.children[0]!.textContent).toBe("Impact");
  });
});

describe("opening", () => {
  it("fetches the catalogue on the first open and lists Your fonts, then Installed with the six among them", async () => {
    const { btn } = mount();
    await openBy(btn);
    expect(ipcMock.fontsList).toHaveBeenCalledTimes(1);
    expect(listing()).toEqual([
      "# Your fonts",
      "Inter",
      "Zilla",
      "# Installed",
      "Arial",
      "Bahnschrift",
      "Consolas",
      "Courier New",
      "Georgia",
      "Impact",
      "Segoe UI",
      "Times New Roman",
    ]);
    // Opens on the font in force.
    expect(activeName()).toBe("Arial");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("previews installed rows by family name and draws no sample for an unloaded library font", async () => {
    const { btn } = mount();
    await openBy(btn);
    const rows = popover()!.findAll("fontpk__row");
    const consolas = rows.find((r) => r.textContent.startsWith("Consolas"))!;
    expect(consolas.findAll("fontpk__sample")[0]!.style.fontFamily).toBe('"Consolas", var(--font-ui)');
    const inter = rows.find((r) => r.textContent.startsWith("Inter"))!;
    expect(inter.findAll("fontpk__sample")).toHaveLength(0);
    expect(ipcMock.fontsResolve).not.toHaveBeenCalled();
  });

  it("search filters both groups and drops an empty group", async () => {
    const { btn } = mount();
    await openBy(btn);
    const s = search();
    s.value = "co";
    dom.fire(s, "input");
    expect(listing()).toEqual(["# Installed", "Consolas", "Courier New"]);
    expect(activeName()).toBe("Consolas");
    s.value = "zzz";
    dom.fire(s, "input");
    expect(listing()).toEqual([]);
    expect(popover()!.findAll("fontpk__note")[0]!.textContent).toBe("No fonts match");
    // Clearing the search brings every row back, the same elements, on the
    // font in force.
    const rowsBefore = popover()!.findAll("fontpk__row");
    s.value = "";
    dom.fire(s, "input");
    expect(listing()).toHaveLength(12);
    expect(popover()!.findAll("fontpk__row")).toEqual(rowsBefore);
    expect(activeName()).toBe("Arial");
    expect(popover()!.findAll("fontpk__note")[0]!.hidden).toBe(true);
  });

  it("typing before the catalogue arrives keeps the loading note, then filters when it lands", async () => {
    let land!: (c: FontCatalog) => void;
    ipcMock.fontsList.mockReturnValue(new Promise<FontCatalog>((r) => (land = r)));
    const { btn } = mount();
    dom.fire(btn, "click");
    await vi.waitFor(() => expect(popover()).toBeDefined());
    const s = search();
    s.value = "zil";
    dom.fire(s, "input");
    expect(popover()!.findAll("fontpk__note")[0]!.textContent).toBe("Loading fonts");
    land(CATALOG);
    await vi.waitFor(() => expect(listing()).toEqual(["# Your fonts", "Zilla"]));
  });

  it("typing on the closed control opens it searching for that key", async () => {
    const { btn } = mount();
    const e = dom.fire(btn, "keydown", { key: "z" });
    // The key is the picker's, not the screen's shortcut.
    expect(e.propagationStopped).toBe(true);
    await vi.waitFor(() => expect(popover()?.findAll("fontpk__row").length ?? 0).toBeGreaterThan(0));
    expect(search().value).toBe("z");
    expect(listing()).toEqual(["# Your fonts", "Zilla"]);
  });
});

describe("keyboard ownership of the closed control", () => {
  it("keeps keys from the screen's shortcuts like the select did, but lets Tab and Escape through", () => {
    const { btn } = mount();
    const del = dom.fire(btn, "keydown", { key: "Delete" });
    expect(del.propagationStopped).toBe(true);
    expect(del.defaultPrevented).toBe(false);
    expect(dom.fire(btn, "keydown", { key: "z", ctrlKey: true }).propagationStopped).toBe(true);
    expect(dom.fire(btn, "keydown", { key: "Tab" }).propagationStopped).toBe(false);
    expect(dom.fire(btn, "keydown", { key: "Escape" }).propagationStopped).toBe(false);
    // None of those opened the list.
    expect(popover()).toBeUndefined();
  });
});

describe("picking", () => {
  it("a legacy pick reports { legacy } with no fontId key", async () => {
    const { btn, picks } = mount({ legacy: "Segoe UI", fontId: "lib:Inter" });
    await openBy(btn, "ArrowDown");
    const s = search();
    s.value = "geo";
    dom.fire(s, "input");
    dom.fire(s, "keydown", { key: "Enter" });
    expect(picks).toEqual([{ legacy: "Georgia" }]);
    expect(Object.keys(picks[0] as object)).toEqual(["legacy"]);
    expect(popover()).toBeUndefined();
    expect(btn.textContent).toBe("Georgia");
  });

  it("a non-legacy pick by arrows reports { legacy: Segoe UI, fontId }", async () => {
    const { btn, picks } = mount({ legacy: "Arial" });
    await openBy(btn);
    // Arial -> Bahnschrift -> Consolas
    dom.fire(search(), "keydown", { key: "ArrowDown" });
    dom.fire(search(), "keydown", { key: "ArrowDown" });
    expect(activeName()).toBe("Consolas");
    dom.fire(search(), "keydown", { key: "Enter" });
    expect(picks).toEqual([{ legacy: "Segoe UI", fontId: "Consolas" }]);
    expect(dom.doc.activeElement).toBe(btn);
  });

  it("a click on a row picks it", async () => {
    const { btn, picks } = mount();
    await openBy(btn);
    const zilla = popover()!.findAll("fontpk__row").find((r) => r.textContent === "Zilla")!;
    dom.fire(zilla.findAll("fontpk__name")[0]!, "click");
    expect(picks).toEqual([{ legacy: "Segoe UI", fontId: "lib:Zilla" }]);
  });
});

describe("closing", () => {
  it("Escape closes without picking, before a dialog's own Escape, and focus returns to the control", async () => {
    const { btn, picks } = mount();
    // A dialog that answers Escape on the document's capture phase, registered
    // BEFORE the list opened (the Add text dialog's openModal does this).
    const dialogEscape = vi.fn();
    dom.doc.addEventListener("keydown", dialogEscape as never, true);
    await openBy(btn);
    expect(S.shortcutsBlocked()).toBe(true);
    dom.fire(search(), "keydown", { key: "Escape" });
    expect(popover()).toBeUndefined();
    expect(dialogEscape).not.toHaveBeenCalled();
    expect(picks).toEqual([]);
    expect(dom.doc.activeElement).toBe(btn);
    expect(S.shortcutsBlocked()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("a press outside closes it; a press on a dialog backdrop does not reach the backdrop", async () => {
    const { btn } = mount();
    await openBy(btn);
    const backdrop = dom.doc.createElement("div");
    backdrop.className = "modal-backdrop";
    dom.doc.body.appendChild(backdrop);
    const e = dom.fire(backdrop, "pointerdown");
    expect(popover()).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
    expect(S.shortcutsBlocked()).toBe(false);
  });

  it("dispose while open leaves no listeners, no popover and no keyboard hold", async () => {
    const { btn, host, handle } = mount();
    const before = { doc: dom.doc.listenerCount(), win: dom.win.listenerCount() };
    await openBy(btn);
    expect(dom.doc.listenerCount() + dom.win.listenerCount()).toBeGreaterThan(before.doc + before.win);
    handle.dispose();
    expect(popover()).toBeUndefined();
    expect(host.children).toHaveLength(0);
    expect(btn.listenerCount()).toBe(0);
    expect(dom.doc.listenerCount()).toBe(0);
    expect(dom.win.listenerCount()).toBe(0);
    expect(S.shortcutsBlocked()).toBe(false);
  });

  it("dispose while the list module is still loading never opens it", async () => {
    const { btn, handle } = mount();
    dom.fire(btn, "click");
    handle.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(popover()).toBeUndefined();
    expect(S.shortcutsBlocked()).toBe(false);
  });
});

describe("a catalogue that fails", () => {
  it("still offers the six legacy fonts and says why the rest are absent", async () => {
    ipcMock.fontsList.mockRejectedValue(new Error("boom"));
    const { btn } = mount();
    await openBy(btn);
    expect(listing()).toEqual(["# Installed", "Arial", "Courier New", "Georgia", "Impact", "Segoe UI", "Times New Roman"]);
    expect(popover()!.findAll("fontpk__note")[0]!.textContent).toBe("Couldn't list the fonts on this PC.");
  });
});
