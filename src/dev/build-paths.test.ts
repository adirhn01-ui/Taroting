// Guard: the build machine's account name stays out of the shipped exe.
// `npm run tauri build` goes through scripts/tauri.mjs, which remaps the home,
// CARGO_HOME and repo prefixes for rustc and then scans the exe with
// accountPathHits (scripts/build-paths.mjs). What remapping cannot reach is
// `env!("CARGO_MANIFEST_DIR")` in our own code, so the last check here keeps
// every such site out of a release build at the source level.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

interface BuildPaths {
  isReleaseBuild(args: string[]): boolean;
  remapFlags(paths: { home: string; cargoHome: string; root: string }): string[];
  accountPathHits(bytes: Uint8Array, home: string): number;
}
// A plain .mjs module with no declaration file: load it through a runtime URL
// and give it the shape the wrapper relies on.
const modulePath: string = new URL("../../scripts/build-paths.mjs", import.meta.url).href;
const { isReleaseBuild, remapFlags, accountPathHits } = (await import(/* @vite-ignore */ modulePath)) as BuildPaths;

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
/** UTF-16LE, optionally after `pad` junk bytes so the text starts on an odd
 *  offset. */
const wide = (text: string, pad = 0): Uint8Array => {
  const out = new Uint8Array(pad + text.length * 2).fill(0x41, 0, pad);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[pad + 2 * i] = unit & 0xff;
    out[pad + 2 * i + 1] = unit >> 8;
  }
  return out;
};
const join = (...chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

describe("isReleaseBuild", () => {
  it("is true for a release build only, so dev and debug builds keep their cargo caches", () => {
    expect(isReleaseBuild(["build"])).toBe(true);
    expect(isReleaseBuild(["--verbose", "build", "--no-bundle"])).toBe(true);
    for (const args of [
      [],
      ["--version"],
      ["dev"],
      ["dev", "--", "build"],
      ["build", "--debug"],
      ["build", "-d"],
      ["build", "--help"],
      ["icon", "build.png"],
    ]) {
      expect(isReleaseBuild(args), args.join(" ")).toBe(false);
    }
  });
});

describe("remapFlags", () => {
  it("lists home, then CARGO_HOME, then the repo, so the specific prefixes win", () => {
    // rustc applies the LAST matching prefix. Paths differ on every axis: a
    // home with a space, a CARGO_HOME outside it, a trailing separator.
    expect(
      remapFlags({
        home: "D:\\Profiles\\Jo Ann\\",
        cargoHome: "E:\\rust\\cargo-home",
        root: "D:\\Profiles\\Jo Ann\\code\\taroting",
      }),
    ).toEqual([
      "--remap-path-prefix=D:\\Profiles\\Jo Ann=/home",
      "--remap-path-prefix=E:\\rust\\cargo-home=/cargo",
      "--remap-path-prefix=D:\\Profiles\\Jo Ann\\code\\taroting=/taroting",
    ]);
  });
});

describe("accountPathHits", () => {
  const home = "C:\\Users\\sam";

  it("counts the path as ASCII and as UTF-16LE at even and odd offsets", () => {
    expect(accountPathHits(ascii("x C:\\Users\\sam\\.cargo\\registry y"), home)).toBe(1);
    expect(accountPathHits(wide("C:\\Users\\sam\\Downloads"), home)).toBe(1);
    expect(accountPathHits(wide("C:\\Users\\sam\\Downloads", 1), home)).toBe(1);
    expect(
      accountPathHits(join(ascii("Users\\sam\\a"), wide("Users\\sam\\b"), wide("Users\\sam\\c", 1)), home),
    ).toBe(3);
  });

  it("counts both separators and ignores case", () => {
    expect(accountPathHits(ascii("/c/Users/sam/x"), home)).toBe(1);
    expect(accountPathHits(ascii("C:\\USERS\\Sam\\x"), home)).toBe(1);
    expect(accountPathHits(wide("c:/users/SAM/x", 1), home)).toBe(1);
    expect(accountPathHits(ascii("C:\\Users\\sam"), "c:/users/SAM/")).toBe(1);
  });

  it("never counts the bare name without its parent folder", () => {
    expect(accountPathHits(ascii("Published by sam, built in \\sam\\ and /sam/"), home)).toBe(0);
    expect(accountPathHits(wide("sam\\Downloads"), home)).toBe(0);
    // An account named like a path component must not match panic paths.
    expect(accountPathHits(ascii("registry\\src\\index\\crate\\src\\lib.rs"), "C:\\Users\\src")).toBe(0);
  });

  it("stops the name at a non-name character, so a longer account is not this one", () => {
    // Boundary rule: after the name, a letter, digit, `_`, `.` or `-` means a
    // different, longer account; anything else (separator, NUL, quote, space,
    // end of data) ends the name and counts.
    expect(accountPathHits(ascii("C:\\Users\\samuel\\x"), home)).toBe(0);
    expect(accountPathHits(ascii("C:\\Users\\sam-old\\x C:\\Users\\sam.corp"), home)).toBe(0);
    expect(accountPathHits(wide("C:\\Users\\samuel\\x", 1), home)).toBe(0);
    expect(accountPathHits(ascii("C:\\Users\\sam"), home)).toBe(1);
    expect(accountPathHits(ascii("\"C:\\Users\\sam\" C:\\Users\\sam\0"), home)).toBe(2);
    expect(accountPathHits(wide("C:\\Users\\sam\0"), home)).toBe(1);
  });
});

/**
 * Every `env!("CARGO_MANIFEST_DIR")` in `text` (Rust source) that a release
 * build would compile, as 1-based line numbers. A site is allowed only inside
 * an item carrying `#[cfg(debug_assertions)]`, or inside a `#[cfg(test)]` mod.
 * Enclosing items are found by indentation (the source is rustfmt-formatted):
 * each line above at a strictly smaller indent opens an enclosing block.
 */
function releaseManifestDirSites(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const indent = (l: string): number => l.length - l.trimStart().length;
  const isCode = (l: string): boolean => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("//") && !t.startsWith("#[");
  };
  /** Whether the item or statement starting on line `head` is compiled out
   *  of a release build by its own attributes. */
  const cfgOut = (head: number): boolean => {
    const isMod = /^(pub(\([^)]*\))?\s+)?mod\s/.test(lines[head]!.trim());
    for (let a = head - 1; a >= 0; a--) {
      const t = lines[a]!.trim();
      if (t.startsWith("//")) continue;
      if (!t.startsWith("#[")) return false;
      if (t === "#[cfg(debug_assertions)]" || (isMod && t === "#[cfg(test)]")) return true;
    }
    return false;
  };
  const leaks: number[] = [];
  lines.forEach((line, at) => {
    const hit = line.indexOf('env!("CARGO_MANIFEST_DIR")');
    if (hit < 0 || line.slice(0, hit).includes("//")) return;
    let level = indent(line);
    let guarded = cfgOut(at);
    for (let i = at - 1; i >= 0 && level > 0 && !guarded; i--) {
      if (!isCode(lines[i]!) || indent(lines[i]!) >= level) continue;
      level = indent(lines[i]!);
      // A multi-line signature: `) -> T {` closes it; climb to where it opens.
      let head = i;
      while (/^(\)|>|where\b|\{)/.test(lines[head]!.trim()) && head > 0) {
        head--;
        while (head > 0 && (!isCode(lines[head]!) || indent(lines[head]!) > level)) head--;
      }
      i = head;
      guarded = cfgOut(head);
    }
    if (!guarded) leaks.push(at + 1);
  });
  return leaks;
}

describe("env!(\"CARGO_MANIFEST_DIR\") in release builds", () => {
  it("the checker catches the shapes that used to leak, and passes the fixed ones", () => {
    // 0.9.3's ffmpeg.rs: a RUNTIME cfg! still compiles the string in.
    const runtimeCfg = [
      "pub fn sidecar_path(name: &str) -> Result<PathBuf> {",
      "    if cfg!(debug_assertions) {",
      '        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))',
      '            .join("binaries");',
      "        Ok(p)",
      "    } else {",
      "        todo!()",
      "    }",
      "}",
    ].join("\n");
    expect(releaseManifestDirSites(runtimeCfg)).toEqual([3]);
    // 0.9.3's debug.rs: gated only by an early return.
    const earlyReturn = [
      "#[tauri::command]",
      "pub fn debug_info(",
      "    x: u8,",
      ") -> Result<DebugInfo> {",
      "    dev_only()?;",
      '    let fixtures = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));',
      "}",
    ].join("\n");
    expect(releaseManifestDirSites(earlyReturn)).toEqual([6]);
    // Not debug_assertions itself, and a cfg(test) that is not on a mod.
    const lookalikes = [
      "#[cfg(not(debug_assertions))]",
      'fn a() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")) }',
      "#[cfg(test)]",
      "fn b() -> PathBuf {",
      '    PathBuf::from(env!("CARGO_MANIFEST_DIR"))',
      "}",
    ].join("\n");
    expect(releaseManifestDirSites(lookalikes)).toEqual([2, 5]);

    const fixed = [
      "/// Dev sidecars.",
      "#[cfg(debug_assertions)]",
      "pub fn sidecar_path(",
      "    name: &str,",
      ") -> Result<PathBuf> {",
      '    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));',
      "}",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn t() {",
      '        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));',
      "    }",
      "}",
    ].join("\n");
    expect(releaseManifestDirSites(fixed)).toEqual([]);
  });

  it("no site under src-tauri/src reaches a release build", () => {
    const dir = resolve(root, "src-tauri/src");
    const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".rs"));
    expect(files.length).toBeGreaterThan(10);
    const leaks = files.flatMap((f) =>
      releaseManifestDirSites(readFileSync(resolve(dir, f), "utf8")).map((n) => `${f}:${n}`),
    );
    expect(leaks).toEqual([]);
  });
});

describe("npm run tauri", () => {
  it("goes through the wrapper that remaps paths and scans the exe", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.tauri).toBe("node scripts/tauri.mjs");
    const wrapper = read("scripts/tauri.mjs");
    expect(wrapper).toContain("CARGO_ENCODED_RUSTFLAGS");
    expect(wrapper).toContain("remapFlags(");
    expect(wrapper).toContain("accountPathHits(");
  });
});
