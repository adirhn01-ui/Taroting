// Guard: ONE list of media extensions. src/core/media-extensions.json is read
// by the TS side (types.ts derives MEDIA_FILE_EXTENSIONS from it, the file
// picker spreads that) and by Rust (media/extensions.rs include_str!s it), so
// drop, open-with, the picker, import and sibling stepping cannot disagree —
// the shape a hand copy drifting out of date keeps taking in this repo. What
// can still drift is what is NOT derived from it: a quoted list reappearing in
// the picker, and the installer's association set (tauri.conf.json) against
// its uninstall cleanup (hooks.nsh), which are two hand-kept lists by
// necessity. Every check is a pure function over file TEXT with its own
// self-test on a corrupted copy, so a checker that can no longer fail is
// caught here too, without ever touching the real files.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEDIA_EXTENSIONS,
  MEDIA_FILE_EXTENSIONS,
  mediaFamilyOf,
  stepFamilyOf,
  type MediaFamily,
} from "../core/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

const FAMILIES: readonly MediaFamily[] = ["video", "gif", "image", "audio"];

/** Problems with a parsed media-extensions table: exactly the four families,
 *  each a non-empty list of lowercase, dot-free ASCII names, no name twice
 *  (within a family or across two), and never the project extension. */
function checkFamilies(table: unknown): string[] {
  const problems: string[] = [];
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    return ["the table is not an object of families"];
  }
  const rec = table as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  if (keys.join() !== [...FAMILIES].sort().join()) {
    problems.push(`families are [${keys.join(", ")}], expected [${FAMILIES.join(", ")}]`);
  }
  const owner = new Map<string, string>();
  for (const fam of keys) {
    const list = rec[fam];
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`${fam}: not a non-empty list`);
      continue;
    }
    for (const ext of list) {
      if (typeof ext !== "string" || !/^[a-z0-9]+$/.test(ext)) {
        problems.push(`${fam}: ${JSON.stringify(ext)} is not a lowercase, dot-free name`);
        continue;
      }
      if (ext === "trt") problems.push(`${fam}: "trt" is the project file, never media`);
      const prev = owner.get(ext);
      if (prev !== undefined) problems.push(`"${ext}" is listed in both ${prev} and ${fam}`);
      else owner.set(ext, fam);
    }
  }
  return problems;
}

/** The body of `export async function <name>` in `source`, brace-matched, or
 *  null when the function is not there. */
function functionBody(source: string, name: string): string | null {
  const at = source.indexOf(`export async function ${name}(`);
  if (at < 0) return null;
  const open = source.indexOf("{", source.indexOf(")", at));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return null;
}

/** Problems with ipc.ts's pickMediaFiles: its filter must spread
 *  MEDIA_FILE_EXTENSIONS, and no quoted extension may sit anywhere in its body
 *  — a hand copy beside the spread would still widen or narrow the picker. A
 *  literal counts as an extension when it is one of the table's names (dot or
 *  not, any case) or merely LOOKS like one (2-4 letters/digits), so a brand-new
 *  format typed in by hand is caught before it ever reaches the table. */
function checkPickerDerivation(ipcSource: string, media: ReadonlySet<string> = MEDIA_FILE_EXTENSIONS): string[] {
  const body = functionBody(ipcSource, "pickMediaFiles");
  if (body === null) return ["pickMediaFiles was not found in ipc.ts"];
  const problems: string[] = [];
  if (!body.includes("...MEDIA_FILE_EXTENSIONS")) {
    problems.push("pickMediaFiles does not spread MEDIA_FILE_EXTENSIONS into its filter");
  }
  for (const m of body.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
    const lit = m[2]!;
    const bare = lit.replace(/^\*?\./, "").toLowerCase();
    // The looks-like test runs on `bare`, not `lit`: on the raw text a glob's
    // "*." prefix hides a brand-new name ("*.heic") from it, and only names
    // already in the table would be caught.
    if (media.has(bare) || /^[a-z0-9]{2,4}$/.test(bare)) {
      problems.push(`pickMediaFiles holds the extension literal ${m[0]}`);
    }
  }
  return problems;
}

interface Association {
  ext?: unknown;
  name?: unknown;
}

/** Problems between tauri.conf.json's file associations and hooks.nsh's
 *  uninstall cleanup. Every associated media extension must be importable
 *  (in `media`); `trt` is the one non-media association. Every associated
 *  extension needs EXACTLY ONE `!insertmacro TRT_CLEAN_EXT "<ext>" "<ProgID>"`
 *  whose ProgID is its entry's `name` — the ProgID the template registers it
 *  under, so a wrong one cleans nothing — and no cleanup line may name an
 *  extension that is not associated. Only the insertmacro form counts: the
 *  macro's own definition (`!macro TRT_CLEAN_EXT EXT PROGID`) and commented-out
 *  lines are not cleanup. */
function checkAssociationLockstep(
  confText: string,
  nshText: string,
  media: ReadonlySet<string> = MEDIA_FILE_EXTENSIONS,
): string[] {
  const problems: string[] = [];
  let conf: { bundle?: { fileAssociations?: unknown } };
  try {
    conf = JSON.parse(confText) as typeof conf;
  } catch (e) {
    return [`tauri.conf.json does not parse: ${String(e)}`];
  }
  const assoc = conf.bundle?.fileAssociations;
  if (!Array.isArray(assoc) || assoc.length === 0) return ["bundle.fileAssociations is missing or empty"];

  const progidOf = new Map<string, string>();
  for (const entry of assoc as Association[]) {
    const { ext, name } = entry;
    if (!Array.isArray(ext) || typeof name !== "string" || name === "") {
      problems.push(`association ${JSON.stringify(entry)} has no ext list or name`);
      continue;
    }
    for (const e of ext) {
      if (typeof e !== "string") {
        problems.push(`association "${name}" lists a non-string ext ${JSON.stringify(e)}`);
        continue;
      }
      if (progidOf.has(e)) problems.push(`"${e}" is associated twice`);
      progidOf.set(e, name);
      if (e !== "trt" && !media.has(e)) {
        problems.push(`"${e}" is associated but is not in media-extensions.json`);
      }
    }
  }

  const cleaned = new Map<string, string[]>();
  for (const line of nshText.split(/\r?\n/)) {
    // NSIS reads the directive name case-insensitively and takes each argument
    // quoted or bare, so an `!InsertMacro TRT_CLEAN_EXT png Media` line is a
    // real cleanup and must be counted, or a stray one would pass unseen. The
    // ProgID is group 2 (quoted, may hold spaces) or group 3 (bare).
    const m = /^\s*!insertmacro\s+TRT_CLEAN_EXT\s+"?([^"\s]+)"?\s+(?:"([^"]*)"|(\S+))/i.exec(line);
    if (!m) continue;
    const list = cleaned.get(m[1]!) ?? [];
    list.push(m[2] ?? m[3]!);
    cleaned.set(m[1]!, list);
  }
  for (const [ext, progid] of progidOf) {
    const lines = cleaned.get(ext) ?? [];
    if (lines.length !== 1) {
      problems.push(`"${ext}" has ${lines.length} TRT_CLEAN_EXT lines in hooks.nsh, expected exactly 1`);
    } else if (lines[0] !== progid) {
      problems.push(`"${ext}" is cleaned as "${lines[0]}" but associated as "${progid}"`);
    }
  }
  for (const ext of cleaned.keys()) {
    if (!progidOf.has(ext)) problems.push(`hooks.nsh cleans "${ext}", which is not associated`);
  }
  return problems;
}

const jsonText = read("src/core/media-extensions.json");
const ipcText = read("src/core/ipc.ts");
const confText = read("src-tauri/tauri.conf.json");
const nshText = read("src-tauri/windows/hooks.nsh");

describe("media-extensions.json", () => {
  it("has four well-formed, disjoint families and never names trt", () => {
    expect(checkFamilies(JSON.parse(jsonText))).toEqual([]);
  });

  it("the family checker catches each kind of damage on its own", () => {
    const good = JSON.parse(jsonText) as Record<string, string[]>;
    const damaged = (fam: string, list: unknown): unknown => ({ ...good, [fam]: list });
    // One corruption per row, each on a different family, so no row can pass
    // on the strength of another row's defect.
    const rows: [string, unknown, RegExp][] = [
      ["project ext", damaged("video", [...good.video!, "trt"]), /"trt" is the project file/],
      ["uppercase", damaged("image", [...good.image!, "PNG2"]), /"PNG2" is not a lowercase/],
      ["dotted", damaged("audio", [...good.audio!, ".opus"]), /"\.opus" is not a lowercase/],
      ["cross-family duplicate", damaged("gif", ["gif", "mp4"]), /"mp4" is listed in both/],
      ["empty family", damaged("gif", []), /gif: not a non-empty list/],
      ["missing family", { video: good.video, image: good.image, audio: good.audio }, /families are/],
    ];
    for (const [what, table, expected] of rows) {
      const problems = checkFamilies(table);
      expect(problems.join("\n"), what).toMatch(expected);
    }
  });

  it("MEDIA_FILE_EXTENSIONS is exactly the union of the JSON families", () => {
    const raw = JSON.parse(jsonText) as Record<MediaFamily, string[]>;
    const union = FAMILIES.flatMap((f) => raw[f]);
    expect([...MEDIA_FILE_EXTENSIONS].sort()).toEqual([...union].sort());
    expect(MEDIA_FILE_EXTENSIONS.size).toBe(union.length);
    for (const f of FAMILIES) expect([...MEDIA_EXTENSIONS[f]]).toEqual(raw[f]);
  });

  it("every extension maps back to its own family and step family", () => {
    const raw = JSON.parse(jsonText) as Record<MediaFamily, string[]>;
    for (const f of FAMILIES) {
      for (const ext of raw[f]) {
        expect(mediaFamilyOf(ext), ext).toBe(f);
        expect(stepFamilyOf(ext), ext).toBe(f === "audio" ? "audio" : "visual");
      }
    }
    expect(mediaFamilyOf("trt")).toBeNull();
    expect(stepFamilyOf("trt")).toBeNull();
  });
});

describe("the file picker derives its filter", () => {
  it("pickMediaFiles spreads MEDIA_FILE_EXTENSIONS and holds no extension literal", () => {
    expect(checkPickerDerivation(ipcText)).toEqual([]);
  });

  it("the picker checker fails on a hand copy, a missing spread or a missing function", () => {
    const body = functionBody(ipcText, "pickMediaFiles");
    expect(body, "pickMediaFiles must exist for the corruptions below to mean anything").not.toBeNull();
    // A hand copy beside the spread: the spread alone must not excuse it.
    const handCopy = ipcText.replace(
      "extensions: [...MEDIA_FILE_EXTENSIONS]",
      'extensions: [...MEDIA_FILE_EXTENSIONS, "heic"]',
    );
    expect(handCopy).not.toBe(ipcText);
    expect(checkPickerDerivation(handCopy).join("\n")).toMatch(/literal "heic"/);
    // A known name written as a glob, in capitals, is still that extension —
    // and only the table lookup can see it (it does not LOOK like one).
    const glob = ipcText.replace("[...MEDIA_FILE_EXTENSIONS]", '[...MEDIA_FILE_EXTENSIONS, "*.MP4"]');
    expect(checkPickerDerivation(glob).join("\n")).toMatch(/literal "\*\.MP4"/);
    // A brand-new name written as a glob is in no table yet: only the
    // looks-like-an-extension test, run on the bare name, can see it.
    const newGlob = ipcText.replace("[...MEDIA_FILE_EXTENSIONS]", '[...MEDIA_FILE_EXTENSIONS, "*.heic"]');
    expect(checkPickerDerivation(newGlob).join("\n")).toMatch(/literal "\*\.heic"/);
    // The list typed out by hand instead of spread.
    const noSpread = ipcText.replace("[...MEDIA_FILE_EXTENSIONS]", "[...ALL_EXTENSIONS]");
    expect(checkPickerDerivation(noSpread)).toEqual([
      "pickMediaFiles does not spread MEDIA_FILE_EXTENSIONS into its filter",
    ]);
    const renamed = ipcText.replace("function pickMediaFiles(", "function pickFiles(");
    expect(checkPickerDerivation(renamed)).toEqual(["pickMediaFiles was not found in ipc.ts"]);
  });
});

describe("file associations and their uninstall cleanup move together", () => {
  it("tauri.conf.json's associations are importable and hooks.nsh cleans exactly them", () => {
    expect(checkAssociationLockstep(confText, nshText)).toEqual([]);
  });

  it("the lockstep checker fails when a cleanup line goes missing", () => {
    const withoutAac = nshText.replace(/^.*TRT_CLEAN_EXT "aac" "Media file".*\r?\n/m, "");
    expect(withoutAac).not.toBe(nshText);
    expect(checkAssociationLockstep(confText, withoutAac)).toEqual([
      '"aac" has 0 TRT_CLEAN_EXT lines in hooks.nsh, expected exactly 1',
    ]);
  });

  it("the lockstep checker fails on each other kind of drift, one at a time", () => {
    const conf = JSON.parse(confText) as { bundle: { fileAssociations: { ext: string[]; name: string }[] } };
    const media = conf.bundle.fileAssociations.find((a) => a.ext.includes("mp4"))!;
    const withConf = (edit: (ext: string[]) => string[]): string => {
      const copy = structuredClone(conf);
      const entry = copy.bundle.fileAssociations.find((a) => a.name === media.name)!;
      entry.ext = edit(entry.ext);
      return JSON.stringify(copy);
    };
    const rows: [string, string, string, string[]][] = [
      [
        "a cleanup line for an ext nothing associates",
        confText,
        `${nshText}\n    !insertmacro TRT_CLEAN_EXT "png" "Media file"\n`,
        ['hooks.nsh cleans "png", which is not associated'],
      ],
      [
        "a duplicated cleanup line",
        confText,
        `${nshText}\n    !insertmacro TRT_CLEAN_EXT "wav" "Media file"\n`,
        ['"wav" has 2 TRT_CLEAN_EXT lines in hooks.nsh, expected exactly 1'],
      ],
      [
        "a cleanup line under the wrong ProgID",
        confText,
        nshText.replace('TRT_CLEAN_EXT "mkv" "Media file"', 'TRT_CLEAN_EXT "mkv" "Taroting Project"'),
        ['"mkv" is cleaned as "Taroting Project" but associated as "Media file"'],
      ],
      [
        "an associated ext the app cannot import",
        withConf((ext) => [...ext, "heic"]),
        `${nshText}\n    !insertmacro TRT_CLEAN_EXT "heic" "Media file"\n`,
        ['"heic" is associated but is not in media-extensions.json'],
      ],
      [
        "a commented-out cleanup line is no cleanup",
        confText,
        nshText.replace('!insertmacro TRT_CLEAN_EXT "flac"', '; !insertmacro TRT_CLEAN_EXT "flac"'),
        ['"flac" has 0 TRT_CLEAN_EXT lines in hooks.nsh, expected exactly 1'],
      ],
      [
        "an unquoted, differently-cased cleanup line for an ext nothing associates",
        confText,
        `${nshText}\n    !InsertMacro TRT_CLEAN_EXT png Media\n`,
        ['hooks.nsh cleans "png", which is not associated'],
      ],
      [
        "an unquoted ProgID that differs from the association's",
        confText,
        nshText.replace('TRT_CLEAN_EXT "avi" "Media file"', "TRT_CLEAN_EXT avi Media"),
        ['"avi" is cleaned as "Media" but associated as "Media file"'],
      ],
      [
        "a differently-cased directive is still a cleanup line (a duplicate here)",
        confText,
        `${nshText}\n    !INSERTMACRO TRT_CLEAN_EXT "gif" "Media file"\n`,
        ['"gif" has 2 TRT_CLEAN_EXT lines in hooks.nsh, expected exactly 1'],
      ],
    ];
    for (const [what, c, n, expected] of rows) {
      expect(checkAssociationLockstep(c, n), what).toEqual(expected);
    }
  });
});
