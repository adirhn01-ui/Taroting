// Pure helpers for keeping the build machine's account name out of a release
// binary. No side effects: scripts/tauri.mjs uses them for `tauri build`, and
// src/dev/build-paths.test.ts pins their behaviour.

/** Whether `args` carries one of `flags`, bare or as `--flag=value`.
 *  @param {string[]} args
 *  @param {...string} flags */
export function hasFlag(args, ...flags) {
  return args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
}

/**
 * Whether these Tauri CLI arguments start a RELEASE build: the only run the
 * wrapper changes. `dev`, `build --debug` and everything else must keep their
 * environment, or cargo rebuilds the debug and test caches from scratch.
 *
 * @param {string[]} args
 */
export function isReleaseBuild(args) {
  return (
    args.find((a) => !a.startsWith("-")) === "build" &&
    !hasFlag(args, "--debug", "-d", "--help", "-h", "--version", "-V")
  );
}

/** Drop trailing separators, so `C:\Users\x\` and `C:\Users\x` map alike
 *  (a drive root such as `C:\` keeps its one separator). */
function trimSeparators(path) {
  const trimmed = path.replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/**
 * The `--remap-path-prefix` flags for a release build, MOST GENERAL FIRST:
 * rustc applies the LAST flag whose prefix matches, so a more specific prefix
 * (CARGO_HOME, the repo) must come after the home folder it usually sits in.
 * CARGO_HOME, not its registry folder, is what gets remapped, so a dependency
 * path still reads `/cargo\registry\src\<index>\<crate>-<ver>\…` and the
 * crash notes' `sanitize_location` keeps cutting it down to `<crate>-<ver>\…`.
 *
 * @param {{ home: string, cargoHome: string, root: string }} paths
 * @returns {string[]}
 */
export function remapFlags({ home, cargoHome, root }) {
  return [
    [home, "/home"],
    [cargoHome, "/cargo"],
    [root, "/taroting"],
  ].map(([from, to]) => `--remap-path-prefix=${trimSeparators(from)}=${to}`);
}

/** A character that continues an account name: letter, digit, `_`, `.`, `-`. */
function isNameChar(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2e ||
    code === 0x2d
  );
}

/** Lower-case ASCII A-Z only; every other byte (UTF-16 high bytes included)
 *  is left exactly as it is. */
function foldAscii(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
  }
  return out;
}

function utf16le(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[2 * i] = unit & 0xff;
    out[2 * i + 1] = unit >> 8;
  }
  return out;
}

/**
 * How many times the account's home folder shows up PATH-SHAPED in `bytes`:
 * the home folder's last two components joined by `\` or `/` (for
 * `C:\Users\someone`: `Users\someone` and `Users/someone`), ignoring ASCII
 * case, as UTF-8/ASCII and as UTF-16LE at both byte alignments.
 *
 * The bare account name is never counted: it can sit inside unrelated text (a
 * publisher string), and an account called `src` would otherwise match every
 * `\src\` in a panic location.
 *
 * Boundary rule: a match counts only when the character right after the name
 * (the next byte, or the next UTF-16 code unit) is NOT a name character —
 * ASCII letter, digit, `_`, `.` or `-`. A separator, NUL, quote, space or the
 * end of the data all end the name. So for `C:\Users\sam`, `Users\sam\x` and
 * `Users\sam` at the very end count; `Users\samuel`, `Users\sam-old` and
 * `Users\sam.corp` are other accounts and do not.
 *
 * @param {Uint8Array} bytes
 * @param {string} home
 * @returns {number}
 */
export function accountPathHits(bytes, home) {
  const parts = home.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new Error(`accountPathHits: home folder has no parent folder: ${home}`);
  }
  const [parent, name] = parts.slice(-2);
  const hay = foldAscii(bytes);
  const encoder = new TextEncoder();
  let hits = 0;
  for (const sep of ["\\", "/"]) {
    const text = `${parent}${sep}${name}`;
    const needles = [
      { needle: foldAscii(encoder.encode(text)), wide: false },
      { needle: foldAscii(utf16le(text)), wide: true },
    ];
    for (const { needle, wide } of needles) {
      hits += countMatches(hay, needle, wide);
    }
  }
  return hits;
}

function countMatches(hay, needle, wide) {
  let hits = 0;
  const last = hay.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    const end = i + needle.length;
    const continues = wide
      ? end + 1 < hay.length && hay[end + 1] === 0 && isNameChar(hay[end])
      : end < hay.length && isNameChar(hay[end]);
    if (!continues) hits++;
  }
  return hits;
}
