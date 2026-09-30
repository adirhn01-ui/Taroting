// Guard: ONE list of media extensions. src/core/media-extensions.json is read
// by the TS side (types.ts derives MEDIA_FILE_EXTENSIONS from it, the file
// picker spreads that) and by Rust (media/extensions.rs include_str!s it), so
// drop, open-with, the picker, import and sibling stepping cannot disagree —
// the shape a hand copy drifting out of date keeps taking in this repo. What
// can still drift is what is NOT derived from it: a quoted list reappearing in
// the picker, and the installer's registry work — tauri.conf.json's one
// association (.trt) and hooks.nsh's per-extension Open-with, Default-apps and
// legacy-migration lines, hand-kept lists by necessity (NSIS cannot read the
// JSON). The installer rule these checks exist for: Taroting NEVER claims a
// media default. Every check is a pure function over file TEXT with its own
// self-test on a corrupted copy, so a checker that can no longer fail is
// caught here too, without ever touching the real files. They read SOURCES:
// a stale generated installer.nsi is invisible here, so the release build
// still greps the regenerated script.

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
  description?: unknown;
}

/** The media families' ProgIDs. FOREVER names: a user's UserChoice may point
 *  at one, so a rename orphans it. gif is video (it has motion). */
const FAMILY_PROGID: Readonly<Record<MediaFamily, string>> = {
  video: "Taroting.Video",
  gif: "Taroting.Video",
  image: "Taroting.Image",
  audio: "Taroting.Audio",
};
/** Each ProgID's Explorer "Type" text (its default value). */
const PROGID_DESC: ReadonlyMap<string, string> = new Map([
  ["Taroting.Video", "Taroting video"],
  ["Taroting.Image", "Taroting image"],
  ["Taroting.Audio", "Taroting audio"],
]);
/** What 0.6.0-0.8.1 claimed as "Media file" DEFAULTS. FROZEN: this is history,
 *  not the current media set, so it must never be derived from the JSON. */
const LEGACY_MEDIA: readonly string[] = ["mp4", "mov", "mkv", "avi", "webm", "gif", "mp3", "wav", "flac", "aac"];
/** The project association — the one default Taroting owns. */
const PROJECT_PROGID = "Taroting Project";

// Exact hooks.nsh lines the checks below require (whitespace-normalised).
const TRT_QUOTED_COMMAND =
  `WriteRegStr SHCTX "Software\\Classes\\Taroting Project\\shell\\open\\command" "" '"$INSTDIR\\\${MAINBINARYNAME}.exe" "%1"'`;
const LEGACY_PROGID_DELETE = `DeleteRegKey SHCTX "Software\\Classes\\Media file"`;
const CAPABILITY_VALUES: readonly string[] = [
  `WriteRegStr SHCTX "Software\\Taroting\\Capabilities" "ApplicationName" "Taroting"`,
  `WriteRegStr SHCTX "Software\\Taroting\\Capabilities" "ApplicationDescription" "Free, offline video and image editor"`,
  `WriteRegStr SHCTX "Software\\Taroting\\Capabilities" "ApplicationIcon" "$INSTDIR\\\${MAINBINARYNAME}.exe,0"`,
];
const REGISTERED_APP_WRITE =
  `WriteRegStr SHCTX "Software\\RegisteredApplications" "Taroting" "Software\\Taroting\\Capabilities"`;
const REGISTERED_APP_DELETE = `DeleteRegValue SHCTX "Software\\RegisteredApplications" "Taroting"`;
const CAPABILITIES_DELETE = `DeleteRegKey SHCTX "Software\\Taroting\\Capabilities"`;
const MANUKEY_IFEMPTY_DELETE = `DeleteRegKey /ifempty SHCTX "Software\\Taroting"`;
const UPDATE_MODE_GATE = "${If} $UpdateMode <> 1";
const APP_DATA_GATE = "${If} $DeleteAppDataCheckboxState = 1";
/** The app-data purge block, frozen: the two-gate fix for the v0.7.3 data loss
 *  lives here, and nothing about Open-with or Default apps belongs in it. */
const APP_DATA_PURGE: readonly string[] = [
  "${AndIf} $UpdateMode <> 1",
  'RMDir /r "$APPDATA\\${PRODUCTNAME}"',
  'RMDir /r "$LOCALAPPDATA\\${PRODUCTNAME}"',
  'RMDir /r "$APPDATA\\com.taroting.app"',
  'RMDir /r "$LOCALAPPDATA\\com.taroting.app"',
];

/** NSIS code lines: trimmed, whitespace runs collapsed, blank and comment
 *  lines (`;` or `#` first) dropped — a commented-out line is no registry work. */
function codeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l !== "" && !l.startsWith(";") && !l.startsWith("#"));
}

/** [first, end) of the lines inside `!macro NAME` … `!macroend`, or null.
 *  NSIS reads directive names case-insensitively. */
function macroRange(lines: readonly string[], name: string): [number, number] | null {
  const open = new RegExp(`^!macro ${name}(?: |$)`, "i");
  const at = lines.findIndex((l) => open.test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^!macroend\b/i.test(l));
  return end < 0 ? null : [at + 1, end];
}

/** [first, end) of the lines inside the LogicLib block whose opening line is
 *  exactly `head`, through ITS ${EndIf}: nested ${If}/${IfNot} blocks are
 *  counted, so an inner ${EndIf} (the .trt empty-default drop) does not end it.
 *  ${ElseIf}/${AndIf}/${OrIf} neither open nor close. */
function ifRange(lines: readonly string[], head: string, from = 0, to = lines.length): [number, number] | null {
  const at = lines.findIndex((l, i) => i >= from && i < to && l === head);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at; i < to; i++) {
    if (/^\$\{If(?:Not)?\}/i.test(lines[i]!)) depth++;
    else if (/^\$\{EndIf\}/i.test(lines[i]!) && --depth === 0) return [at + 1, i];
  }
  return null;
}

/** The arguments of every `!insertmacro NAME …` line, quoted ("…" or '…') or
 *  bare, directive case-insensitive. */
function inserts(lines: readonly string[], name: string): string[][] {
  const re = new RegExp(`^!insertmacro ${name}(?: (.*))?$`, "i");
  const out: string[][] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    out.push([...(m[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((a) => a[1] ?? a[2] ?? a[3]!));
  }
  return out;
}

/** `rows` (each [ext, value]) must hold every key of `expected` exactly once,
 *  with its value, and nothing else. */
function checkPairs(what: string, rows: readonly string[][], expected: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string[]>();
  for (const [key = "", value = ""] of rows) seen.set(key, [...(seen.get(key) ?? []), value]);
  for (const [key, want] of expected) {
    const got = seen.get(key) ?? [];
    if (got.length !== 1) problems.push(`${what} "${key}": ${got.length} lines, expected exactly 1`);
    else if (got[0] !== want) problems.push(`${what} "${key}" is "${got[0]}", expected "${want}"`);
  }
  for (const key of seen.keys()) {
    if (!expected.has(key)) problems.push(`${what} names "${key}", which it must not`);
  }
  return problems;
}

/** `literal` must appear exactly once in `lines`. */
function once(lines: readonly string[], literal: string, where: string): string[] {
  const n = lines.filter((l) => l === literal).length;
  return n === 1 ? [] : [`${where}: ${n} lines of ${literal}, expected exactly 1`];
}

/** ext → ProgID for every media extension, in media-extensions.json order. */
function mediaProgids(table: Readonly<Record<MediaFamily, readonly string[]>>): Map<string, string> {
  return new Map(FAMILIES.flatMap((f) => table[f].map((ext): [string, string] => [ext, FAMILY_PROGID[f]])));
}

/** Problems with tauri.conf.json's installer settings. Every
 *  `bundle.fileAssociations` ext makes the template WRITE the HKCU class
 *  default (APP_ASSOCIATE), so the list must be exactly the project file: a
 *  media ext there is the default-stealing the installer exists to avoid.
 *  installMode must stay currentUser (hooks.nsh treats HKCU and SHCTX as one
 *  hive) and the publisher "Taroting" (it names the template's
 *  Software\Taroting key, the parent of our Capabilities key). */
function checkConfAssociations(confText: string, media: ReadonlySet<string> = MEDIA_FILE_EXTENSIONS): string[] {
  let conf: {
    bundle?: { publisher?: unknown; fileAssociations?: unknown; windows?: { nsis?: { installMode?: unknown } } };
  };
  try {
    conf = JSON.parse(confText) as typeof conf;
  } catch (e) {
    return [`tauri.conf.json does not parse: ${String(e)}`];
  }
  const problems: string[] = [];
  const mode = conf.bundle?.windows?.nsis?.installMode;
  if (mode !== "currentUser") problems.push(`installMode is ${JSON.stringify(mode)}, expected "currentUser"`);
  const publisher = conf.bundle?.publisher;
  if (publisher !== "Taroting") problems.push(`bundle.publisher is ${JSON.stringify(publisher)}, expected "Taroting"`);
  const assoc = conf.bundle?.fileAssociations;
  if (!Array.isArray(assoc)) return [...problems, "bundle.fileAssociations is missing"];
  if (assoc.length !== 1) problems.push(`fileAssociations has ${assoc.length} entries, expected exactly 1 (trt)`);
  let project: Association | null = null;
  for (const entry of assoc as Association[]) {
    const exts: unknown[] = Array.isArray(entry.ext) ? entry.ext : [];
    for (const e of exts) {
      if (e === "trt") project = entry;
      else if (typeof e === "string" && media.has(e)) problems.push(`"${e}" in fileAssociations would claim the default`);
      else problems.push(`${JSON.stringify(e)} in fileAssociations is not the project file`);
    }
  }
  if (project === null) return [...problems, '"trt" is not associated'];
  if (project.name !== PROJECT_PROGID) {
    problems.push(`the trt association is named ${JSON.stringify(project.name)}, expected "${PROJECT_PROGID}"`);
  }
  if (project.description !== "Taroting project") {
    problems.push(`the trt association is described ${JSON.stringify(project.description)}, expected "Taroting project"`);
  }
  return problems;
}

/** Problems between tauri.conf.json's associations and hooks.nsh's uninstall
 *  cleanup: every associated extension needs EXACTLY ONE
 *  `!insertmacro TRT_CLEAN_EXT "<ext>" "<ProgID>"` whose ProgID is its entry's
 *  `name` (the ProgID the template registers it under, so a wrong one cleans
 *  nothing), and no cleanup line may name an extension that is not associated.
 *  Only the insertmacro form counts: the macro's own definition and
 *  commented-out lines are not cleanup. */
function checkCleanupLockstep(confText: string, nshText: string): string[] {
  let conf: { bundle?: { fileAssociations?: unknown } };
  try {
    conf = JSON.parse(confText) as typeof conf;
  } catch (e) {
    return [`tauri.conf.json does not parse: ${String(e)}`];
  }
  const assoc = conf.bundle?.fileAssociations;
  if (!Array.isArray(assoc) || assoc.length === 0) return ["bundle.fileAssociations is missing or empty"];
  const progidOf = new Map<string, string>();
  for (const { ext, name } of assoc as Association[]) {
    if (!Array.isArray(ext) || typeof name !== "string") continue;
    for (const e of ext) if (typeof e === "string") progidOf.set(e, name);
  }
  return checkPairs("TRT_CLEAN_EXT", inserts(codeLines(nshText), "TRT_CLEAN_EXT"), progidOf);
}

/** Problems with NSIS_HOOK_POSTINSTALL: Open-with for every media ext under
 *  its family ProgID, each ProgID defined once with its description, a
 *  Default-apps row for .trt and every media ext, the Capabilities values and
 *  the RegisteredApplications pointer once each, the FROZEN legacy migration
 *  (owner check first, then exactly the ten 0.6-0.8.1 exts, then the
 *  "Media file" key), the quoted .trt command, and UPDATEFILEASSOC once, last. */
function checkInstallHook(nshText: string, table: Readonly<Record<MediaFamily, readonly string[]>>): string[] {
  const lines = codeLines(nshText);
  const range = macroRange(lines, "NSIS_HOOK_POSTINSTALL");
  if (range === null) return ["NSIS_HOOK_POSTINSTALL was not found in hooks.nsh"];
  const body = lines.slice(...range);
  const media = mediaProgids(table);
  const where = "NSIS_HOOK_POSTINSTALL";
  const problems = [
    ...checkPairs("TRT_OPENWITH_ADD", inserts(body, "TRT_OPENWITH_ADD"), media),
    ...checkPairs("TRT_PROGID", inserts(body, "TRT_PROGID"), PROGID_DESC),
    ...checkPairs("TRT_CAPABILITY", inserts(body, "TRT_CAPABILITY"), new Map([["trt", PROJECT_PROGID], ...media])),
    ...checkPairs(
      "TRT_MIGRATE_LEGACY",
      inserts(body, "TRT_MIGRATE_LEGACY").map(([ext = ""]) => [ext, "legacy"]),
      new Map(LEGACY_MEDIA.map((ext) => [ext, "legacy"])),
    ),
    ...once(body, TRT_QUOTED_COMMAND, where),
    ...once(body, LEGACY_PROGID_DELETE, where),
    ...CAPABILITY_VALUES.flatMap((l) => once(body, l, where)),
    ...once(body, REGISTERED_APP_WRITE, where),
  ];
  const owner = body.findIndex((l) => /^!insertmacro TRT_LEGACY_OWNER$/i.test(l));
  const firstMigrate = body.findIndex((l) => /^!insertmacro TRT_MIGRATE_LEGACY /i.test(l));
  if (owner < 0 || owner > firstMigrate) problems.push("TRT_LEGACY_OWNER must run before the first TRT_MIGRATE_LEGACY");
  const updates = inserts(body, "UPDATEFILEASSOC").length;
  if (updates !== 1) problems.push(`${where}: ${updates} UPDATEFILEASSOC lines, expected exactly 1`);
  else if (!/^!insertmacro UPDATEFILEASSOC$/i.test(body[body.length - 1] ?? "")) {
    problems.push(`UPDATEFILEASSOC is not the last line of ${where}`);
  }
  return problems;
}

/** A `.ext` key (or a subkey of one) deleted without /ifempty, any root, as
 *  `"Software\Classes\.<x>…"` or the HKCR form `".<x>…"`. /ifnosubkeys and
 *  /ifnovalues still take a set default or another app's OpenWithProgids with
 *  them, so only /ifempty (no subkeys AND no values) is safe. */
const EXT_KEY_DELETE = /^DeleteRegKey (?!\/ifempty )(?:\/\S+ )?\S+ (["']?)(?:Software\\Classes\\)?\./i;

/** Our uninstall registry work, by pattern — anything matching must sit INSIDE
 *  the `$UpdateMode <> 1` block (it points into $INSTDIR, like .trt). */
const OURS = /TRT_OPENWITH_REMOVE|UPDATEFILEASSOC|Taroting\.(?:Video|Image|Audio)|RegisteredApplications|Software\\Taroting/i;

/** Problems with NSIS_HOOK_POSTUNINSTALL: inside the `$UpdateMode <> 1` block,
 *  our Open-with value off every media ext, each Taroting.* ProgID deleted, the
 *  RegisteredApplications value and the Capabilities key deleted, their parent
 *  (the template's MANUKEY) only /ifempty, and UPDATEFILEASSOC once, last.
 *  None of it outside that block; the app-data purge block exactly as frozen;
 *  and, anywhere in the file, neither Software\Taroting nor any `.ext` key
 *  deleted outright. */
function checkUninstallHook(nshText: string, table: Readonly<Record<MediaFamily, readonly string[]>>): string[] {
  const lines = codeLines(nshText);
  const problems: string[] = [];
  for (const l of lines) {
    if (/^DeleteRegKey (?:SHCTX|HKCU|HKLM|SHELL_CONTEXT) (["'])Software\\Taroting\1$/i.test(l)) {
      problems.push(`${l} would delete the template's key too; only /ifempty may touch Software\\Taroting`);
    }
    if (EXT_KEY_DELETE.test(l)) {
      problems.push(`${l} would delete another app's .ext default or Open-with entries; only /ifempty may delete a .ext key`);
    }
  }
  const range = macroRange(lines, "NSIS_HOOK_POSTUNINSTALL");
  if (range === null) return [...problems, "NSIS_HOOK_POSTUNINSTALL was not found in hooks.nsh"];
  const gate = ifRange(lines, UPDATE_MODE_GATE, ...range);
  if (gate === null) return [...problems, `${UPDATE_MODE_GATE} was not found in NSIS_HOOK_POSTUNINSTALL`];
  const block = lines.slice(...gate);
  const where = "the $UpdateMode <> 1 block";
  problems.push(
    ...checkPairs("TRT_OPENWITH_REMOVE", inserts(block, "TRT_OPENWITH_REMOVE"), mediaProgids(table)),
    ...[...PROGID_DESC.keys()].flatMap((p) => once(block, `DeleteRegKey SHCTX "Software\\Classes\\${p}"`, where)),
    ...once(block, REGISTERED_APP_DELETE, where),
    ...once(block, CAPABILITIES_DELETE, where),
    ...once(block, MANUKEY_IFEMPTY_DELETE, where),
  );
  const updates = inserts(block, "UPDATEFILEASSOC").length;
  if (updates !== 1) problems.push(`${where}: ${updates} UPDATEFILEASSOC lines, expected exactly 1`);
  else if (!/^!insertmacro UPDATEFILEASSOC$/i.test(block[block.length - 1] ?? "")) {
    problems.push(`UPDATEFILEASSOC is not the last line of ${where}`);
  }
  for (let i = range[0]; i < range[1]; i++) {
    if ((i < gate[0] || i >= gate[1]) && OURS.test(lines[i]!)) problems.push(`${lines[i]} sits outside ${where}`);
  }
  const purge = ifRange(lines, APP_DATA_GATE, ...range);
  const purgeBody = purge === null ? null : lines.slice(...purge);
  if (JSON.stringify(purgeBody) !== JSON.stringify(APP_DATA_PURGE)) {
    problems.push(`the app-data purge block changed: ${JSON.stringify(purgeBody)}`);
  }
  return problems;
}

/** A write to a `.ext` DEFAULT value (`"Software\Classes\.<x>" ""` under any
 *  root, or the HKCR form `".<x>" ""`; any WriteReg* form) — the one registry
 *  write that changes what a double-click opens. */
const EXT_DEFAULT_WRITE = /^WriteReg\w* \S+ (["']?)(?:Software\\Classes\\)?\.[^"'\\\s]+\1 (?:""|'')(?: |$)/i;
/** A value deleted from a `.ext` key or its subkeys (another app's default, or
 *  its OpenWithProgids entry) — quoted or not, any root. Only the frozen macros
 *  that remove OUR entries or hand back a legacy default may, and .trt (ours). */
const EXT_VALUE_DELETE = /^DeleteRegValue \S+ (["']?)(?:Software\\Classes\\)?\.(\S*?)\1(?: |$)/i;
const VALUE_DELETE_MACROS = ["TRT_OPENWITH_REMOVE", "TRT_MIGRATE_LEGACY", "TRT_CLEAN_EXT"];
const EXT_KEY_WRITE = /^WriteReg\w* \S+ (["'])((?:Software\\Classes\\)?\.[^"']*)\1/i;

/** The never-steal rule, file-wide: no line of hooks.nsh writes a `.ext`
 *  default value except inside TRT_MIGRATE_LEGACY (which only hands back the
 *  pre-Taroting default). The macros that register media — TRT_OPENWITH_ADD,
 *  TRT_PROGID, TRT_CAPABILITY — touch no `.ext` key but its OpenWithProgids. */
function checkNeverSteal(nshText: string): string[] {
  const lines = codeLines(nshText);
  const problems: string[] = [];
  const legacy = macroRange(lines, "TRT_MIGRATE_LEGACY");
  const deleters = VALUE_DELETE_MACROS.map((name) => macroRange(lines, name));
  lines.forEach((l, i) => {
    if (EXT_DEFAULT_WRITE.test(l)) {
      if (legacy !== null && i >= legacy[0] && i < legacy[1]) return;
      problems.push(`${l} writes a .ext default value`);
      return;
    }
    const del = EXT_VALUE_DELETE.exec(l);
    if (!del) return;
    if (/^trt(?:\\|$)/i.test(del[2]!)) return;
    if (deleters.some((r) => r !== null && i >= r[0] && i < r[1])) return;
    problems.push(`${l} deletes another app's .ext value; only the frozen Open-with, legacy and clean-up macros may`);
  });
  // The template's own claim-the-default macro (FileAssociation.nsh), reached
  // without a WriteReg line in this file.
  for (const [ext = ""] of inserts(lines, "APP_ASSOCIATE(?:_EX)?")) {
    problems.push(`hooks.nsh inserts APP_ASSOCIATE for "${ext}"; only tauri.conf.json's .trt may`);
  }
  for (const name of ["TRT_OPENWITH_ADD", "TRT_PROGID", "TRT_CAPABILITY"]) {
    const range = macroRange(lines, name);
    if (range === null) {
      problems.push(`the ${name} definition was not found in hooks.nsh`);
      continue;
    }
    for (const l of lines.slice(...range)) {
      const m = EXT_KEY_WRITE.exec(l);
      if (m && !EXT_DEFAULT_WRITE.test(l) && !/\\OpenWithProgids$/i.test(m[2]!)) {
        problems.push(`${name} writes ${m[2]}; only its OpenWithProgids may be touched`);
      }
    }
  }
  return problems;
}

/** The registry macros, FROZEN line for line (as codeLines() reads them, the
 *  `!macro NAME PARAMS` line first, so a renamed parameter — which NSIS would
 *  compile into a literal `.${EXT}` key — is a change too). The pattern checks
 *  above see what a line LOOKS like; these bodies are where one dropped
 *  /ifempty, a guard that always holds or an empty Open-with macro still looks
 *  fine. Change a macro here only together with hooks.nsh, deliberately. */
const FROZEN_MACROS: ReadonlyMap<string, readonly string[]> = new Map([
  ["TRT_PROGID", [
    "!macro TRT_PROGID PROGID DESC",
    'WriteRegStr SHCTX "Software\\Classes\\${PROGID}" "" "${DESC}"',
    'WriteRegStr SHCTX "Software\\Classes\\${PROGID}\\DefaultIcon" "" "$INSTDIR\\${MAINBINARYNAME}.exe,0"',
    `WriteRegStr SHCTX "Software\\Classes\\\${PROGID}\\shell\\open\\command" "" '"$INSTDIR\\\${MAINBINARYNAME}.exe" "%1"'`,
  ]],
  ["TRT_OPENWITH_ADD", [
    "!macro TRT_OPENWITH_ADD EXT PROGID",
    'WriteRegNone SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${PROGID}"',
  ]],
  ["TRT_OPENWITH_REMOVE", [
    "!macro TRT_OPENWITH_REMOVE EXT PROGID",
    'DeleteRegValue SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${PROGID}"',
    'DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids"',
    'DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}"',
  ]],
  ["TRT_CAPABILITY", [
    "!macro TRT_CAPABILITY EXT PROGID",
    'WriteRegStr SHCTX "Software\\Taroting\\Capabilities\\FileAssociations" ".${EXT}" "${PROGID}"',
  ]],
  // Deletes a .ext default, so its guard matters as much as the migration's:
  // only a default that names OUR ProgID may go.
  ["TRT_CLEAN_EXT", [
    "!macro TRT_CLEAN_EXT EXT PROGID",
    'ReadRegStr $R0 HKCU "Software\\Classes\\.${EXT}" ""',
    '${If} $R0 == "${PROGID}"',
    'DeleteRegValue HKCU "Software\\Classes\\.${EXT}" ""',
    "${EndIf}",
    'DeleteRegValue HKCU "Software\\Classes\\.${EXT}" "${PROGID}_backup"',
  ]],
  ["TRT_LEGACY_OWNER", [
    "!macro TRT_LEGACY_OWNER",
    "StrCpy $R9 0",
    "ClearErrors",
    'ReadRegStr $R0 SHCTX "Software\\Classes\\Media file\\shell\\open\\command" ""',
    "${If} ${Errors}",
    "StrCpy $R9 1",
    `\${ElseIf} $R0 == '$INSTDIR\\\${MAINBINARYNAME}.exe "%1"'`,
    "StrCpy $R9 1",
    `\${ElseIf} $R0 == '"$INSTDIR\\\${MAINBINARYNAME}.exe" "%1"'`,
    "StrCpy $R9 1",
    "${EndIf}",
  ]],
  ["TRT_MIGRATE_LEGACY", [
    "!macro TRT_MIGRATE_LEGACY EXT",
    "${If} $R9 = 1",
    'ReadRegStr $R0 SHCTX "Software\\Classes\\.${EXT}" ""',
    '${If} $R0 == "Media file"',
    'ReadRegStr $R1 SHCTX "Software\\Classes\\.${EXT}" "Media file_backup"',
    'StrCpy $R2 ""',
    '${If} $R1 != ""',
    '${AndIf} $R1 != "Media file"',
    "ClearErrors",
    'EnumRegKey $R3 HKCR "$R1" 0',
    "${IfNot} ${Errors}",
    "StrCpy $R2 $R1",
    "${EndIf}",
    "${EndIf}",
    '${If} $R2 != ""',
    'WriteRegStr SHCTX "Software\\Classes\\.${EXT}" "" $R2',
    "${Else}",
    'DeleteRegValue SHCTX "Software\\Classes\\.${EXT}" ""',
    "${EndIf}",
    "${EndIf}",
    "ClearErrors",
    'ReadRegStr $R0 SHCTX "Software\\Classes\\.${EXT}" ""',
    "${IfNot} ${Errors}",
    '${AndIf} $R0 == ""',
    'DeleteRegValue SHCTX "Software\\Classes\\.${EXT}" ""',
    "${EndIf}",
    'DeleteRegValue SHCTX "Software\\Classes\\.${EXT}" "Media file_backup"',
    "${EndIf}",
  ]],
]);

/** Problems with the registry macros against FROZEN_MACROS: a definition that
 *  is missing, or the FIRST line where it differs (one problem per macro). */
function checkFrozenMacros(nshText: string): string[] {
  const lines = codeLines(nshText);
  const problems: string[] = [];
  for (const [name, want] of FROZEN_MACROS) {
    const range = macroRange(lines, name);
    if (range === null) {
      problems.push(`the ${name} definition was not found in hooks.nsh`);
      continue;
    }
    const got = lines.slice(range[0] - 1, range[1]);
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      if (got[i] !== want[i]) {
        problems.push(
          `the ${name} definition changed at line ${i + 1}: ${JSON.stringify(got[i] ?? null)}, expected ${JSON.stringify(want[i] ?? null)}`,
        );
        break;
      }
    }
  }
  return problems;
}

const jsonText = read("src/core/media-extensions.json");
const ipcText = read("src/core/ipc.ts");
const confText = read("src-tauri/tauri.conf.json");
// LF-normalised so the corruption rows below splice lines the same way on a
// CRLF checkout; codeLines() itself reads either.
const nshText = read("src-tauri/windows/hooks.nsh").replace(/\r\n/g, "\n");

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

describe("the installer never claims a media default", () => {
  const table = JSON.parse(jsonText) as Record<MediaFamily, string[]>;
  // Swap one exact line of hooks.nsh; a replacement that matched nothing
  // would turn a corruption row into a silent no-op, so it throws instead.
  const swap = (from: string, to: string, text = nshText): string => {
    if (!text.includes(from)) throw new Error(`hooks.nsh has no ${from}`);
    return text.replace(from, to);
  };
  const drop = (line: string, text = nshText): string => {
    const re = new RegExp(`^[ \\t]*${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?\\n`, "m");
    if (!re.test(text)) throw new Error(`hooks.nsh has no line ${line}`);
    return text.replace(re, "");
  };

  it("tauri.conf.json associates only the project file, per-user, under the Taroting publisher", () => {
    expect(checkConfAssociations(confText)).toEqual([]);
  });

  it("the conf checker catches each kind of drift, one at a time", () => {
    const conf = JSON.parse(confText) as {
      bundle: {
        publisher: string;
        fileAssociations: Record<string, unknown>[];
        windows: { nsis: { installMode: string } };
      };
    };
    const edited = (edit: (c: typeof conf) => void): string => {
      const copy = structuredClone(conf);
      edit(copy);
      return JSON.stringify(copy);
    };
    const rows: [string, string, string[]][] = [
      [
        "a media ext back in the project entry",
        edited((c) => (c.bundle.fileAssociations[0]!.ext = ["trt", "mp4"])),
        ['"mp4" in fileAssociations would claim the default'],
      ],
      [
        "an ext that is neither media nor the project",
        edited((c) => (c.bundle.fileAssociations[0]!.ext = ["trt", "heic"])),
        ['"heic" in fileAssociations is not the project file'],
      ],
      [
        "a second, empty entry",
        edited((c) => c.bundle.fileAssociations.push({ ext: [], name: "Other" })),
        ["fileAssociations has 2 entries, expected exactly 1 (trt)"],
      ],
      [
        "the project ProgID renamed (orphans every UserChoice on it)",
        edited((c) => (c.bundle.fileAssociations[0]!.name = "Taroting.Project")),
        ['the trt association is named "Taroting.Project", expected "Taroting Project"'],
      ],
      [
        "the video-only description back",
        edited((c) => (c.bundle.fileAssociations[0]!.description = "Taroting video project")),
        ['the trt association is described "Taroting video project", expected "Taroting project"'],
      ],
      [
        "a per-machine install (HKCU literals would miss HKLM)",
        edited((c) => (c.bundle.windows.nsis.installMode = "perMachine")),
        ['installMode is "perMachine", expected "currentUser"'],
      ],
      [
        "a publisher that no longer names Software\\Taroting",
        edited((c) => (c.bundle.publisher = "Taroting Team")),
        ['bundle.publisher is "Taroting Team", expected "Taroting"'],
      ],
      [
        "no project association at all",
        edited((c) => (c.bundle.fileAssociations[0]!.ext = ["mkv"])),
        ['"mkv" in fileAssociations would claim the default', '"trt" is not associated'],
      ],
    ];
    for (const [what, text, expected] of rows) expect(checkConfAssociations(text), what).toEqual(expected);
  });

  it("hooks.nsh cleans up exactly the associated extensions", () => {
    expect(checkCleanupLockstep(confText, nshText)).toEqual([]);
  });

  it("the cleanup checker fails on each kind of drift, one at a time", () => {
    const rows: [string, string, string[]][] = [
      ["the trt cleanup line missing", drop('!insertmacro TRT_CLEAN_EXT "trt" "Taroting Project"'), [
        'TRT_CLEAN_EXT "trt": 0 lines, expected exactly 1',
      ]],
      ["a cleanup line for an ext nothing associates", `${nshText}\n    !insertmacro TRT_CLEAN_EXT "png" "Media file"\n`, [
        'TRT_CLEAN_EXT names "png", which it must not',
      ]],
      ["a duplicated cleanup line", `${nshText}\n    !insertmacro TRT_CLEAN_EXT "trt" "Taroting Project"\n`, [
        'TRT_CLEAN_EXT "trt": 2 lines, expected exactly 1',
      ]],
      ["a cleanup line under the wrong ProgID", swap('TRT_CLEAN_EXT "trt" "Taroting Project"', 'TRT_CLEAN_EXT "trt" "Media file"'), [
        'TRT_CLEAN_EXT "trt" is "Media file", expected "Taroting Project"',
      ]],
      ["a commented-out cleanup line is no cleanup", swap('!insertmacro TRT_CLEAN_EXT "trt"', '; !insertmacro TRT_CLEAN_EXT "trt"'), [
        'TRT_CLEAN_EXT "trt": 0 lines, expected exactly 1',
      ]],
      ["an unquoted, differently-cased stray line", `${nshText}\n    !InsertMacro TRT_CLEAN_EXT png Media\n`, [
        'TRT_CLEAN_EXT names "png", which it must not',
      ]],
      ["an unquoted ProgID that differs", swap('TRT_CLEAN_EXT "trt" "Taroting Project"', "TRT_CLEAN_EXT trt Taroting"), [
        'TRT_CLEAN_EXT "trt" is "Taroting", expected "Taroting Project"',
      ]],
      ["a differently-cased directive is still a line (a duplicate here)", `${nshText}\n    !INSERTMACRO TRT_CLEAN_EXT "trt" "Taroting Project"\n`, [
        'TRT_CLEAN_EXT "trt": 2 lines, expected exactly 1',
      ]],
    ];
    for (const [what, text, expected] of rows) expect(checkCleanupLockstep(confText, text), what).toEqual(expected);
  });

  it("the install hook registers Open with and Default apps for every media ext, and migrates the legacy defaults", () => {
    expect(checkInstallHook(nshText, table)).toEqual([]);
  });

  it("the install-hook checker fails on each kind of drift, one at a time", () => {
    const openWith = (ext: string, progid: string): string => `!insertmacro TRT_OPENWITH_ADD "${ext}" "${progid}"`;
    const capability = (ext: string, progid: string): string => `!insertmacro TRT_CAPABILITY "${ext}" "${progid}"`;
    const rows: [string, string, string[]][] = [
      ["gif registered as an image (it is video: it has motion)", swap(openWith("gif", "Taroting.Video"), openWith("gif", "Taroting.Image")), [
        'TRT_OPENWITH_ADD "gif" is "Taroting.Image", expected "Taroting.Video"',
      ]],
      ["a media ext with no Open-with line", drop(openWith("ogg", "Taroting.Audio")), [
        'TRT_OPENWITH_ADD "ogg": 0 lines, expected exactly 1',
      ]],
      ["an Open-with line for an ext the app cannot open", swap(openWith("bmp", "Taroting.Image"), `${openWith("bmp", "Taroting.Image")}\n  ${openWith("heic", "Taroting.Image")}`), [
        'TRT_OPENWITH_ADD names "heic", which it must not',
      ]],
      ["a ProgID's Type text changed", swap('"Taroting.Audio" "Taroting audio"', '"Taroting.Audio" "Taroting music"'), [
        'TRT_PROGID "Taroting.Audio" is "Taroting music", expected "Taroting audio"',
      ]],
      ["no Default-apps row for the project file", drop(capability("trt", "Taroting Project")), [
        'TRT_CAPABILITY "trt": 0 lines, expected exactly 1',
      ]],
      ["a Default-apps row under the wrong ProgID", swap(capability("m2ts", "Taroting.Video"), capability("m2ts", "Taroting.Audio")), [
        'TRT_CAPABILITY "m2ts" is "Taroting.Audio", expected "Taroting.Video"',
      ]],
      ["the RegisteredApplications pointer missing", drop(REGISTERED_APP_WRITE), [
        `NSIS_HOOK_POSTINSTALL: 0 lines of ${REGISTERED_APP_WRITE}, expected exactly 1`,
      ]],
      ["the Default-apps description reworded", swap("Free, offline video and image editor", "Offline editor"), [
        `NSIS_HOOK_POSTINSTALL: 0 lines of ${CAPABILITY_VALUES[1]!}, expected exactly 1`,
      ]],
      ["a legacy ext dropped from the migration", drop('!insertmacro TRT_MIGRATE_LEGACY "aac"'), [
        'TRT_MIGRATE_LEGACY "aac": 0 lines, expected exactly 1',
      ]],
      ["the migration run before the owner check", swap("!insertmacro TRT_LEGACY_OWNER\n", "", swap('!insertmacro TRT_MIGRATE_LEGACY "aac"', '!insertmacro TRT_MIGRATE_LEGACY "aac"\n  !insertmacro TRT_LEGACY_OWNER')), [
        "TRT_LEGACY_OWNER must run before the first TRT_MIGRATE_LEGACY",
      ]],
      ["the legacy ProgID left behind", drop(LEGACY_PROGID_DELETE), [
        `NSIS_HOOK_POSTINSTALL: 0 lines of ${LEGACY_PROGID_DELETE}, expected exactly 1`,
      ]],
      ["the .trt command left unquoted", drop(TRT_QUOTED_COMMAND), [
        `NSIS_HOOK_POSTINSTALL: 0 lines of ${TRT_QUOTED_COMMAND}, expected exactly 1`,
      ]],
      ["Explorer notified before the keys are written", swap('!insertmacro TRT_PROGID "Taroting.Video"', '!insertmacro UPDATEFILEASSOC\n  !insertmacro TRT_PROGID "Taroting.Video"', drop("!insertmacro UPDATEFILEASSOC")), [
        "UPDATEFILEASSOC is not the last line of NSIS_HOOK_POSTINSTALL",
      ]],
      ["Open with registered outside the install hook", `${drop(openWith("mp4", "Taroting.Video"))}\n${openWith("mp4", "Taroting.Video")}\n`, [
        'TRT_OPENWITH_ADD "mp4": 0 lines, expected exactly 1',
      ]],
    ];
    for (const [what, text, expected] of rows) expect(checkInstallHook(text, table), what).toEqual(expected);
  });

  it("the legacy list is frozen history, never derived from the current media set", () => {
    // Rewrite the migration to cover today's 24 exts: every extra is refused,
    // which a checker comparing against the JSON could never do.
    const legacyLines = LEGACY_MEDIA.map((e) => `!insertmacro TRT_MIGRATE_LEGACY "${e}"`);
    const current = FAMILIES.flatMap((f) => table[f]);
    let derived = nshText;
    for (const l of legacyLines.slice(1)) derived = drop(l, derived);
    derived = swap(legacyLines[0]!, current.map((e) => `!insertmacro TRT_MIGRATE_LEGACY "${e}"`).join("\n  "), derived);
    const extras = current.filter((e) => !LEGACY_MEDIA.includes(e));
    expect(extras.length).toBeGreaterThan(0);
    expect(checkInstallHook(derived, table)).toEqual(
      extras.map((e) => `TRT_MIGRATE_LEGACY names "${e}", which it must not`),
    );
  });

  it("the uninstall hook removes exactly what the install hook added, on the $UpdateMode gate only", () => {
    expect(checkUninstallHook(nshText, table)).toEqual([]);
  });

  it("the uninstall-hook checker fails on each kind of drift, one at a time", () => {
    const remove = (ext: string, progid: string): string => `!insertmacro TRT_OPENWITH_REMOVE "${ext}" "${progid}"`;
    const outside = "the $UpdateMode <> 1 block";
    const purgeEnd = 'RMDir /r "$LOCALAPPDATA\\com.taroting.app"';
    const rows: [string, string, string[]][] = [
      ["an ext whose Open-with value is never removed", drop(remove("webp", "Taroting.Image")), [
        'TRT_OPENWITH_REMOVE "webp": 0 lines, expected exactly 1',
      ]],
      ["an Open-with removal under the wrong ProgID", swap(remove("mp3", "Taroting.Audio"), remove("mp3", "Taroting.Video")), [
        'TRT_OPENWITH_REMOVE "mp3" is "Taroting.Video", expected "Taroting.Audio"',
      ]],
      ["a ProgID key left behind", drop('DeleteRegKey SHCTX "Software\\Classes\\Taroting.Audio"'), [
        `${outside}: 0 lines of DeleteRegKey SHCTX "Software\\Classes\\Taroting.Audio", expected exactly 1`,
      ]],
      ["the RegisteredApplications value left behind", drop(REGISTERED_APP_DELETE), [
        `${outside}: 0 lines of ${REGISTERED_APP_DELETE}, expected exactly 1`,
      ]],
      ["the Capabilities key left behind", drop(CAPABILITIES_DELETE), [
        `${outside}: 0 lines of ${CAPABILITIES_DELETE}, expected exactly 1`,
      ]],
      ["the template's key deleted outright", swap(MANUKEY_IFEMPTY_DELETE, 'DeleteRegKey SHCTX "Software\\Taroting"'), [
        `DeleteRegKey SHCTX "Software\\Taroting" would delete the template's key too; only /ifempty may touch Software\\Taroting`,
        `${outside}: 0 lines of ${MANUKEY_IFEMPTY_DELETE}, expected exactly 1`,
      ]],
      ["the template's key deleted outright, single-quoted", swap(MANUKEY_IFEMPTY_DELETE, "DeleteRegKey SHCTX 'Software\\Taroting'"), [
        "DeleteRegKey SHCTX 'Software\\Taroting' would delete the template's key too; only /ifempty may touch Software\\Taroting",
        `${outside}: 0 lines of ${MANUKEY_IFEMPTY_DELETE}, expected exactly 1`,
      ]],
      ["the Open-with removal deleting the .ext key outright", swap('DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}"', 'DeleteRegKey SHCTX "Software\\Classes\\.${EXT}"'), [
        `DeleteRegKey SHCTX "Software\\Classes\\.\${EXT}" would delete another app's .ext default or Open-with entries; only /ifempty may delete a .ext key`,
      ]],
      ["an OpenWithProgids key deleted /ifnosubkeys (other apps' values go with it)", swap("DeleteRegKey /ifempty SHCTX \"Software\\Classes\\.${EXT}\\OpenWithProgids\"", "DeleteRegKey /ifnosubkeys SHCTX \"Software\\Classes\\.${EXT}\\OpenWithProgids\""), [
        `DeleteRegKey /ifnosubkeys SHCTX "Software\\Classes\\.\${EXT}\\OpenWithProgids" would delete another app's .ext default or Open-with entries; only /ifempty may delete a .ext key`,
      ]],
      ["a .ext key deleted outright through HKCR", swap(CAPABILITIES_DELETE, `${CAPABILITIES_DELETE}\n    DeleteRegKey HKCR ".png"`), [
        `DeleteRegKey HKCR ".png" would delete another app's .ext default or Open-with entries; only /ifempty may delete a .ext key`,
      ]],
      ["a .ext key deleted outright, unquoted", swap(CAPABILITIES_DELETE, `${CAPABILITIES_DELETE}\n    DeleteRegKey SHCTX Software\\Classes\\.png`), [
        `DeleteRegKey SHCTX Software\\Classes\\.png would delete another app's .ext default or Open-with entries; only /ifempty may delete a .ext key`,
      ]],
      ["Explorer never notified", swap("!insertmacro UPDATEFILEASSOC\n  ${EndIf}", "${EndIf}"), [
        `${outside}: 0 UPDATEFILEASSOC lines, expected exactly 1`,
      ]],
      ["a removal moved under the app-data checkbox", swap(purgeEnd, `${purgeEnd}\n    ${remove("bmp", "Taroting.Image")}`, drop(remove("bmp", "Taroting.Image"))), [
        'TRT_OPENWITH_REMOVE "bmp": 0 lines, expected exactly 1',
        `${remove("bmp", "Taroting.Image")} sits outside ${outside}`,
        `the app-data purge block changed: ${JSON.stringify([...APP_DATA_PURGE, remove("bmp", "Taroting.Image")])}`,
      ]],
      ["the app-data purge block touched", swap(purgeEnd, `${purgeEnd}\n    RMDir /r "$DOCUMENTS\\Taroting"`), [
        `the app-data purge block changed: ${JSON.stringify([...APP_DATA_PURGE, 'RMDir /r "$DOCUMENTS\\Taroting"'])}`,
      ]],
      // The control row: a comment naming our keys, outside the block and
      // inside the purge block, is no registry work and must not trip either.
      ["comments that name our keys are not registry work", swap(purgeEnd, `${purgeEnd}\n    ; not ${REGISTERED_APP_DELETE}`, swap("  ; Purge settings", `  ; ${CAPABILITIES_DELETE} and Taroting.Video are handled above.\n  ; Purge settings`)), []],
    ];
    for (const [what, text, expected] of rows) expect(checkUninstallHook(text, table), what).toEqual(expected);
  });

  it("no line of hooks.nsh writes a .ext default outside the legacy restore", () => {
    expect(checkNeverSteal(nshText)).toEqual([]);
  });

  it("the never-steal checker catches a default write wherever it hides", () => {
    const DELETES = "deletes another app's .ext value; only the frozen Open-with, legacy and clean-up macros may";
    const openWithDef = 'WriteRegNone SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${PROGID}"';
    const capabilityDef = 'WriteRegStr SHCTX "Software\\Taroting\\Capabilities\\FileAssociations" ".${EXT}" "${PROGID}"';
    const steal = 'WriteRegStr SHCTX "Software\\Classes\\.${EXT}" "" "${PROGID}"';
    const rows: [string, string, string[]][] = [
      ["TRT_OPENWITH_ADD claiming the default", swap(openWithDef, `${openWithDef}\n  ${steal}`), [
        `${steal} writes a .ext default value`,
      ]],
      ["TRT_CAPABILITY claiming the default, lowercase directive, single quotes", swap(capabilityDef, `${capabilityDef}\n  writeregstr HKCU 'Software\\Classes\\.\${EXT}' '' "\${PROGID}"`), [
        `writeregstr HKCU 'Software\\Classes\\.\${EXT}' '' "\${PROGID}" writes a .ext default value`,
      ]],
      ["a literal default write in the install hook", swap(REGISTERED_APP_WRITE, `${REGISTERED_APP_WRITE}\n  WriteRegStr SHCTX "Software\\Classes\\.png" "" "Taroting.Image"`), [
        'WriteRegStr SHCTX "Software\\Classes\\.png" "" "Taroting.Image" writes a .ext default value',
      ]],
      ["a default write through HKCR in the install hook", swap(REGISTERED_APP_WRITE, `${REGISTERED_APP_WRITE}\n  WriteRegStr HKCR ".png" "" "Taroting.Image"`), [
        'WriteRegStr HKCR ".png" "" "Taroting.Image" writes a .ext default value',
      ]],
      ["TRT_OPENWITH_ADD touching another .ext subkey through HKCR", swap(openWithDef, `${openWithDef}\n  WriteRegStr HKCR ".\${EXT}\\ShellNew" "NullFile" ""`), [
        "TRT_OPENWITH_ADD writes .${EXT}\\ShellNew; only its OpenWithProgids may be touched",
      ]],
      ["TRT_OPENWITH_ADD touching another .ext subkey", swap(openWithDef, `${openWithDef}\n  WriteRegStr SHCTX "Software\\Classes\\.\${EXT}\\ShellNew" "NullFile" ""`), [
        "TRT_OPENWITH_ADD writes Software\\Classes\\.${EXT}\\ShellNew; only its OpenWithProgids may be touched",
      ]],
      ["the template's claim macro called from the hooks", swap(REGISTERED_APP_WRITE, `${REGISTERED_APP_WRITE}\n  !insertmacro APP_ASSOCIATE "png" "Taroting.Image" "Taroting image" "x,0" "Open" "x"`), [
        'hooks.nsh inserts APP_ASSOCIATE for "png"; only tauri.conf.json\'s .trt may',
      ]],
      ["the restore macro renamed, so its writes and deletes lose their exemption", swap("!macro TRT_MIGRATE_LEGACY EXT", "!macro TRT_RESTORE_LEGACY EXT"), [
        'WriteRegStr SHCTX "Software\\Classes\\.${EXT}" "" $R2 writes a .ext default value',
        `DeleteRegValue SHCTX "Software\\Classes\\.\${EXT}" "" ${DELETES}`,
        `DeleteRegValue SHCTX "Software\\Classes\\.\${EXT}" "" ${DELETES}`,
        `DeleteRegValue SHCTX "Software\\Classes\\.\${EXT}" "Media file_backup" ${DELETES}`,
      ]],
      ["another app's default deleted in the hooks", swap(REGISTERED_APP_WRITE, `${REGISTERED_APP_WRITE}\n  DeleteRegValue SHCTX "Software\\Classes\\.mp4" ""`), [
        `DeleteRegValue SHCTX "Software\\Classes\\.mp4" "" ${DELETES}`,
      ]],
      ["another app's Open-with entry deleted in the hooks", swap(REGISTERED_APP_WRITE, `${REGISTERED_APP_WRITE}\n  DeleteRegValue SHCTX "Software\\Classes\\.mp4\\OpenWithProgids" "VLC.mp4"`), [
        `DeleteRegValue SHCTX "Software\\Classes\\.mp4\\OpenWithProgids" "VLC.mp4" ${DELETES}`,
      ]],
      ["an unquoted default write through HKCR", swap(REGISTERED_APP_WRITE, `${REGISTERED_APP_WRITE}\n  WriteRegStr HKCR .png "" Taroting.Image`), [
        'WriteRegStr HKCR .png "" Taroting.Image writes a .ext default value',
      ]],
    ];
    for (const [what, text, expected] of rows) expect(checkNeverSteal(text), what).toEqual(expected);
  });

  it("the registry macros are exactly as frozen", () => {
    expect(checkFrozenMacros(nshText)).toEqual([]);
  });

  it("the frozen-macro checker catches a one-line change in each macro", () => {
    const changed = (name: string, line: number, got: string | null, want: string | null): string =>
      `the ${name} definition changed at line ${line}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
    const openWithDef = 'WriteRegNone SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${PROGID}"';
    const capabilityDef = 'WriteRegStr SHCTX "Software\\Taroting\\Capabilities\\FileAssociations" ".${EXT}" "${PROGID}"';
    const extKeyDelete = 'DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}"';
    const rows: [string, string, string[]][] = [
      ["the Open-with removal deleting the .ext key outright", swap(extKeyDelete, 'DeleteRegKey SHCTX "Software\\Classes\\.${EXT}"'), [
        changed("TRT_OPENWITH_REMOVE", 4, 'DeleteRegKey SHCTX "Software\\Classes\\.${EXT}"', extKeyDelete),
      ]],
      ["the migration run on a default that is not \"Media file\"", swap('${If} $R0 == "Media file"', "${If} 1 = 1"), [
        changed("TRT_MIGRATE_LEGACY", 4, "${If} 1 = 1", '${If} $R0 == "Media file"'),
      ]],
      ["an Open-with macro that registers nothing", drop(openWithDef), [
        changed("TRT_OPENWITH_ADD", 2, null, openWithDef),
      ]],
      ["a clean-up that deletes any default, not only ours", swap('${If} $R0 == "${PROGID}"', "${If} 1 = 1"), [
        changed("TRT_CLEAN_EXT", 3, "${If} 1 = 1", '${If} $R0 == "${PROGID}"'),
      ]],
      ["an owner check that always says ours", swap("StrCpy $R9 0", "StrCpy $R9 1"), [
        changed("TRT_LEGACY_OWNER", 2, "StrCpy $R9 1", "StrCpy $R9 0"),
      ]],
      ["a ProgID's Type text hardwired", swap('"Software\\Classes\\${PROGID}" "" "${DESC}"', '"Software\\Classes\\${PROGID}" "" "Media file"'), [
        changed("TRT_PROGID", 2, 'WriteRegStr SHCTX "Software\\Classes\\${PROGID}" "" "Media file"', 'WriteRegStr SHCTX "Software\\Classes\\${PROGID}" "" "${DESC}"'),
      ]],
      ["a Default-apps row without its dot", swap('FileAssociations" ".${EXT}"', 'FileAssociations" "${EXT}"'), [
        changed("TRT_CAPABILITY", 2, 'WriteRegStr SHCTX "Software\\Taroting\\Capabilities\\FileAssociations" "${EXT}" "${PROGID}"', capabilityDef),
      ]],
      ["an extra registry line in a macro", swap(capabilityDef, `${capabilityDef}\n  DeleteRegValue SHCTX "Software\\Classes\\.\${EXT}" ""`), [
        changed("TRT_CAPABILITY", 3, 'DeleteRegValue SHCTX "Software\\Classes\\.${EXT}" ""', null),
      ]],
      ["a renamed parameter (the body's ${EXT} would compile as a literal)", swap("!macro TRT_OPENWITH_ADD EXT PROGID", "!macro TRT_OPENWITH_ADD X PROGID"), [
        changed("TRT_OPENWITH_ADD", 1, "!macro TRT_OPENWITH_ADD X PROGID", "!macro TRT_OPENWITH_ADD EXT PROGID"),
      ]],
      ["a macro renamed away", swap("!macro TRT_LEGACY_OWNER\n", "!macro TRT_LEGACY_CHECK\n"), [
        "the TRT_LEGACY_OWNER definition was not found in hooks.nsh",
      ]],
      // The control row: a comment and re-indentation inside a macro are no
      // change to what it does, and must not trip the freeze.
      ["a comment and re-indentation are not a change", swap("  StrCpy $R9 0\n", "  ; not ours until proven\n      StrCpy   $R9   0\n"), []],
    ];
    for (const [what, text, expected] of rows) expect(checkFrozenMacros(text), what).toEqual(expected);
  });
});
