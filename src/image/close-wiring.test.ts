// Guard: how the image editor puts back what is only being previewed before
// the window closes (core/app-close `registerBeforeClose`), and how its drop
// re-checks after the probe. The shell's mount is not exported and the colour
// picker is reached only through a dynamic import, so no unit test drives
// either: if one of these calls went missing, every other test would still
// pass and a close would save an unapplied crop or an unpicked colour. These
// checks read the source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** LF throughout, so each corruption below is written once whatever the
 *  checkout's line endings are. */
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");
const SHELL = read("src/image/image-editor.ts");
const INSPECTOR = read("src/image/inspector.ts");

/** Line comments dropped, so a commented-out call never counts. */
const code = (src: string): string =>
  src
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

/** The inside of the first `{ … }` block opening at or after `from`, braces
 *  balanced; null when there is none. */
function blockAfter(src: string, from: number): string | null {
  const open = src.indexOf("{", from);
  if (from < 0 || open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Problems with the shell's close task and its drop re-check, [] when sound. */
function checkShell(src: string): string[] {
  const c = code(src);
  const problems: string[] = [];
  // ONE task: its three calls run together, synchronously, before the close
  // flow reads the save state. (The import names it without a paren.)
  const reg = "registerBeforeClose(";
  const regs = c.split(reg).length - 1;
  if (regs !== 1) problems.push(`${reg} appears ${regs} times, expected once`);
  const task = blockAfter(c, c.indexOf(reg));
  if (task === null) problems.push("missing: the close task's body");
  else {
    for (const call of ["selectTool.revertCrop()", "cancelImageCrop()", "inspector.dropPreview()"]) {
      if (!task.includes(call)) problems.push(`the close task does not call ${call}`);
    }
  }
  // A drop re-checks the drop's own full refusal after its probe (a crop, a
  // dialog, a menu or picker opened meanwhile), not the crop alone.
  const add = blockAfter(c, c.indexOf("const addPhotos = async"));
  const probeAt = add?.indexOf("await ipc.probeMedia(path)") ?? -1;
  const recheckAt = add?.indexOf("dropRefusal(mode.get(), modalOpen(), shortcutsBlocked())") ?? -1;
  if (!(probeAt >= 0 && recheckAt > probeAt)) {
    problems.push("the drop does not re-check dropRefusal after its probe");
  }
  return problems;
}

/** Problems with the picker's preview drop, [] when sound. */
function checkInspector(src: string): string[] {
  const c = code(src);
  const problems: string[] = [];
  // The handle's dropPreview reaches the open picker.
  const method = blockAfter(c, c.indexOf("dropPreview(): void {"));
  if (method === null || !method.includes("dropPickerPreview?.()")) {
    problems.push("the handle's dropPreview does not reach the picker");
  }
  // The flag is up BEFORE the close: close() commits synchronously, and that
  // commit reads the flag to put back the colour from before the preview.
  const drop = blockAfter(c, c.indexOf("dropPickerPreview = () => {"));
  const setAt = drop?.indexOf("dropPreview = true") ?? -1;
  const closeAt = drop?.indexOf("handle.close()") ?? -1;
  if (setAt < 0) problems.push("the picker's preview drop does not set dropPreview = true");
  if (closeAt < 0) problems.push("the picker's preview drop does not close the picker");
  if (setAt >= 0 && closeAt >= 0 && setAt > closeAt) {
    problems.push("the picker's preview drop closes the picker before setting dropPreview = true");
  }
  return problems;
}

/** `src` with exactly one `from` replaced; fails the test if there is not one. */
function corrupt(src: string, from: string, to: string): string {
  expect(src.split(from).length - 1).toBe(1);
  return src.replace(from, to);
}

describe("image editor close wiring (src/image/image-editor.ts)", () => {
  it("is sound in the real file", () => {
    expect(checkShell(SHELL)).toEqual([]);
  });

  // One corruption per rule, each failing for exactly its own reason.
  it("rejects a second close task", () => {
    const bad = `${SHELL}\nregisterBeforeClose(() => {});\n`;
    expect(checkShell(bad)).toEqual(["registerBeforeClose( appears 2 times, expected once"]);
  });

  it("rejects a close task that leaves the layer crop in place", () => {
    const bad = corrupt(SHELL, "      selectTool.revertCrop();\n", "");
    expect(checkShell(bad)).toEqual(["the close task does not call selectTool.revertCrop()"]);
  });

  it("rejects a close task that leaves the image crop open", () => {
    const bad = corrupt(SHELL, "      cancelImageCrop();\n", "");
    expect(checkShell(bad)).toEqual(["the close task does not call cancelImageCrop()"]);
  });

  it("rejects a close task that keeps a previewed colour", () => {
    const bad = corrupt(SHELL, "      inspector.dropPreview();\n", "");
    expect(checkShell(bad)).toEqual(["the close task does not call inspector.dropPreview()"]);
  });

  it("rejects a drop that re-checks only the crop after its probe", () => {
    const bad = corrupt(
      SHELL,
      "dropRefusal(mode.get(), modalOpen(), shortcutsBlocked());\n        if (refused",
      'mode.get() !== "idle" ? "crop" : null;\n        if (refused',
    );
    expect(checkShell(bad)).toEqual(["the drop does not re-check dropRefusal after its probe"]);
  });
});

describe("image inspector picker drop (src/image/inspector.ts)", () => {
  it("is sound in the real file", () => {
    expect(checkInspector(INSPECTOR)).toEqual([]);
  });

  it("rejects a handle whose dropPreview no longer reaches the picker", () => {
    const bad = corrupt(INSPECTOR, "dropPickerPreview?.();", "void 0;");
    expect(checkInspector(bad)).toEqual(["the handle's dropPreview does not reach the picker"]);
  });

  it("rejects a preview drop that closes without raising the flag", () => {
    const bad = corrupt(INSPECTOR, "          dropPreview = true;", "");
    expect(checkInspector(bad)).toEqual(["the picker's preview drop does not set dropPreview = true"]);
  });

  it("rejects a preview drop that raises the flag only after the close", () => {
    const bad = corrupt(
      INSPECTOR,
      "          dropPreview = true;\n          handle.close();\n",
      "          handle.close();\n          dropPreview = true;\n",
    );
    expect(checkInspector(bad)).toEqual([
      "the picker's preview drop closes the picker before setting dropPreview = true",
    ]);
  });

  it("ignores a commented-out call", () => {
    const bad = corrupt(INSPECTOR, "          dropPreview = true;", "          // dropPreview = true;");
    expect(checkInspector(bad)).toEqual(["the picker's preview drop does not set dropPreview = true"]);
  });
});
