// The FFmpeg sidecars ship as two small exes (bundle.externalBin) and the
// libraries both link, carried once beside them (bundle.resources). The pin
// in scripts/ffmpeg-pin.json decides which libraries those are; this keeps
// the bundle configuration and the pin from drifting apart. A library left
// out of the bundle installs an ffmpeg.exe that cannot start; a stray one
// ships a file nobody verified.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (rel: string): unknown => JSON.parse(readFileSync(resolve(root, rel), "utf8"));

interface Member {
  path: string;
  bytes: number;
  sha256: string;
  kind: string;
  dest: string;
}
interface PinMembers extends Record<string, Member> {
  ffmpeg: Member;
  ffprobe: Member;
}
interface Pin {
  version: string;
  url: string;
  archiveBytes: number;
  archiveSha256: string;
  members: PinMembers;
}
interface Bundle {
  externalBin?: string[];
  resources?: Record<string, string> | string[];
}

const pin = readJson("scripts/ffmpeg-pin.json") as Pin;
const bundle = (readJson("src-tauri/tauri.conf.json") as { bundle: Bundle }).bundle;

/** Problems between a pin and a bundle configuration; empty when they agree.
 *  A function of both, so each mutation below fails for its own reason. */
function mismatches(p: Pin, b: Bundle): string[] {
  const out: string[] = [];
  const members = Object.entries(p.members);
  const libraries = members.filter(([, m]) => m.kind === "dll");

  for (const [name, m] of members) {
    if (!/^[0-9a-f]{64}$/.test(m.sha256)) out.push(`${name}: sha256 is not 64 hex digits`);
    if (!Number.isInteger(m.bytes) || m.bytes <= 0) out.push(`${name}: bytes must be positive`);
    if (m.kind !== "exe" && m.kind !== "dll") out.push(`${name}: kind ${m.kind}`);
    if (/ffplay/i.test(name) || /ffplay/i.test(m.path) || /ffplay/i.test(m.dest)) out.push(`${name}: ffplay is not shipped`);
  }

  const exes = members.filter(([, m]) => m.kind === "exe");
  const exeNames = exes.map(([n]) => n).sort();
  if (exeNames.join() !== "ffmpeg,ffprobe") out.push(`exe members are ${exeNames.join()}`);
  for (const [name, m] of exes) {
    if (m.dest !== `${name}-x86_64-pc-windows-msvc.exe`) out.push(`${name}: dest ${m.dest}`);
  }
  const bins = [...(b.externalBin ?? [])].sort();
  if (bins.join() !== "binaries/ffmpeg,binaries/ffprobe") out.push(`externalBin is ${bins.join()}`);

  if (!b.resources || Array.isArray(b.resources)) {
    out.push("bundle.resources must be the map form");
    return out;
  }
  const entries = Object.entries(b.resources);
  for (const [name, m] of libraries) {
    if (m.dest !== name) out.push(`${name}: a library keeps its own name, not ${m.dest}`);
    const hits = entries.filter(([src]) => src === `binaries/${m.dest}`);
    if (hits.length !== 1) out.push(`${m.dest}: ${hits.length} resource entries`);
    else if (hits[0]?.[1] !== m.dest) out.push(`${m.dest}: installed as ${hits[0]?.[1]}, not at the root under its own name`);
  }
  const pinned = new Set(libraries.map(([, m]) => `binaries/${m.dest}`));
  for (const [src, to] of entries) {
    if (src.includes("*") || to.includes("*")) out.push(`${src}: no globs`);
    // Anything shipped from binaries/ is a file nobody verified unless the
    // pin names it, DLL or not (an exe or a stray file there included).
    if ((/\.dll$/i.test(src) || src.startsWith("binaries/")) && !pinned.has(src)) {
      out.push(`${src}: not a pinned library`);
    }
    if (/\.dll$/i.test(to) && !pinned.has(`binaries/${to}`)) out.push(`${to}: not a pinned library`);
  }
  return out;
}

describe("FFmpeg sidecar bundle", () => {
  it("the bundle carries exactly the pinned libraries beside the two exes", () => {
    expect(mismatches(pin, bundle)).toEqual([]);
  });

  it("the pin names an archive and at least one library", () => {
    expect(pin.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.archiveBytes).toBeGreaterThan(0);
    expect(pin.url).toMatch(/^https:\/\//);
    expect(Object.values(pin.members).filter((m) => m.kind === "dll").length).toBeGreaterThan(0);
  });

  // Each case expects the exact list of problems, so removing any one check
  // from mismatches() turns at least one case red.
  describe("each drift is named exactly", () => {
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    const resources = () => bundle.resources as Record<string, string>;
    const lib = Object.values(pin.members).find((m) => m.kind === "dll")!;

    it("a library left out of bundle.resources", () => {
      const b = clone(bundle);
      delete (b.resources as Record<string, string>)[`binaries/${lib.dest}`];
      expect(mismatches(pin, b)).toEqual([`${lib.dest}: 0 resource entries`]);
    });

    it("a library installed into a subfolder", () => {
      const b = { ...bundle, resources: { ...resources(), [`binaries/${lib.dest}`]: `lib/${lib.dest}` } };
      expect(mismatches(pin, b)).toEqual([
        `${lib.dest}: installed as lib/${lib.dest}, not at the root under its own name`,
        `lib/${lib.dest}: not a pinned library`,
      ]);
    });

    it("a DLL in the bundle that the pin does not list", () => {
      const b = { ...bundle, resources: { ...resources(), "binaries/zlib1.dll": "zlib1.dll" } };
      expect(mismatches(pin, b)).toEqual(["binaries/zlib1.dll: not a pinned library", "zlib1.dll: not a pinned library"]);
    });

    it("a glob in bundle.resources", () => {
      const b = { ...bundle, resources: { ...resources(), "docs/*.txt": "" } };
      expect(mismatches(pin, b)).toEqual(["docs/*.txt: no globs"]);
    });

    it("a file from binaries/ that is not a pinned library", () => {
      const b = { ...bundle, resources: { ...resources(), "binaries/ffmpeg-x86_64-pc-windows-msvc.exe": "ffmpeg.exe" } };
      expect(mismatches(pin, b)).toEqual(["binaries/ffmpeg-x86_64-pc-windows-msvc.exe: not a pinned library"]);
    });

    it("bundle.resources in the array form", () => {
      const b = { ...bundle, resources: Object.keys(resources()) };
      expect(mismatches(pin, b)).toEqual(["bundle.resources must be the map form"]);
    });

    it("a member of an unknown kind", () => {
      const p = clone(pin);
      const name = Object.keys(p.members).find((n) => p.members[n]!.kind === "dll")!;
      p.members[name]!.kind = "lib";
      const r = { ...resources() };
      delete r[`binaries/${name}`];
      expect(mismatches(p, { ...bundle, resources: r })).toEqual([`${name}: kind lib`]);
    });

    it("an exe pinned without the triple suffix", () => {
      const p = clone(pin);
      p.members.ffmpeg.dest = "ffmpeg.exe";
      expect(mismatches(p, bundle)).toEqual(["ffmpeg: dest ffmpeg.exe"]);
    });

    it("a library installed under another name than its own", () => {
      const p = clone(pin);
      const name = Object.keys(p.members).find((n) => p.members[n]!.kind === "dll")!;
      p.members[name]!.dest = "renamed.dll";
      const r = { ...resources() };
      delete r[`binaries/${name}`];
      r["binaries/renamed.dll"] = "renamed.dll";
      expect(mismatches(p, { ...bundle, resources: r })).toEqual([`${name}: a library keeps its own name, not renamed.dll`]);
    });

    it("a third external binary", () => {
      const b = { ...bundle, externalBin: [...(bundle.externalBin ?? []), "binaries/ffplay"] };
      expect(mismatches(pin, b)).toEqual(["externalBin is binaries/ffmpeg,binaries/ffplay,binaries/ffprobe"]);
    });

    it("a member whose digest is not a SHA-256", () => {
      const p = clone(pin);
      p.members.ffmpeg.sha256 = p.members.ffmpeg.sha256.slice(1);
      expect(mismatches(p, bundle)).toEqual(["ffmpeg: sha256 is not 64 hex digits"]);
    });

    it("a member with no size", () => {
      const p = clone(pin);
      p.members.ffprobe.bytes = 0;
      expect(mismatches(p, bundle)).toEqual(["ffprobe: bytes must be positive"]);
    });

    it("ffplay pinned", () => {
      const p = clone(pin);
      p.members["ffplay"] = { ...p.members.ffprobe, path: "x/bin/ffplay.exe", dest: "ffplay-x86_64-pc-windows-msvc.exe" };
      expect(mismatches(p, bundle)).toEqual(["ffplay: ffplay is not shipped", "exe members are ffmpeg,ffplay,ffprobe"]);
    });
  });
});
