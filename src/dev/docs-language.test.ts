// Guard: Taroting is free and open source, forever. This test fails the build
// if any user-facing document reintroduces monetization / cost-implying wording.
// It scans README.md and every Markdown file under docs/ — found by walking
// the folder, never from a hand-kept list, so a new release-notes file is
// covered the moment it exists — plus, best effort, the README.txt of any
// assembled release under release/ (gitignored: present only on a machine that
// has built one, skipped silently otherwise).
// If a match is a legitimate resource-cost sentence, reword it to "overhead"
// rather than weakening this list — the whole point is that nothing here should
// read as if the app costs money.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const slash = (p: string): string => p.replace(/\\/g, "/");

/** README.md plus every .md under docs/ (recursively), as repo-relative paths.
 *  README.md is listed whether or not it exists: a missing one must FAIL
 *  below, not quietly drop out of the scan. */
function discoverDocs(): string[] {
  const docsDir = resolve(root, "docs");
  const docs = existsSync(docsDir)
    ? readdirSync(docsDir, { recursive: true })
        .map((p) => `docs/${slash(p)}`)
        .filter((p) => p.toLowerCase().endsWith(".md"))
        .sort()
    : [];
  return ["README.md", ...docs];
}

/** release/<version>/README.txt — the readme shipped inside each assembled
 *  release. Gitignored, so usually absent; only what is there is scanned. */
function discoverReleaseReadmes(): string[] {
  const rel = resolve(root, "release");
  if (!existsSync(rel)) return [];
  return readdirSync(rel)
    .map((d) => `release/${d}/README.txt`)
    .filter((p) => existsSync(resolve(root, p)));
}

const DOCS = discoverDocs();
const RELEASE_READMES = discoverReleaseReadmes();

// Case-insensitive. Word-boundaried so "accost"/"across" etc. can't false-match.
// "cost"/"pay"/"price" included because the app must not even *read* as paid;
// describe resource use as "overhead"/"footprint" instead.
const BANNED = [
  /pay[-\s]?for[-\s]?use/i,
  /\bpay-for\b/i,
  /\bpaid\b/i,
  /\bpurchase\b/i,
  /\bsubscription\b/i,
  /\bpremium\b/i,
  /\bpro tier\b/i,
  /\bin-app purchase/i,
  /\blicense fee\b/i,
  /\bprice[ds]?\b/i,
  /\bcosts?\b/i,
  /\bcosting\b/i,
];

describe("the docs guard finds what it guards", () => {
  it("README.md exists (a renamed README would otherwise leave nothing scanned)", () => {
    expect(existsSync(resolve(root, "README.md"))).toBe(true);
  });

  it("discovers the docs folder, every release-notes file included", () => {
    const notes = DOCS.filter((p) => /^docs\/RELEASE-NOTES-v\d+\.\d+\.\d+\.md$/.test(p));
    // The hand-kept list this replaced named 12 notes (0.5.0 through 0.9.0);
    // discovery that finds fewer has lost files, not gained precision.
    expect(notes.length, `release notes found: ${notes.join(", ")}`).toBeGreaterThanOrEqual(12);
    expect(DOCS).toContain("docs/PERFORMANCE.md");
    expect(DOCS).toContain("docs/RELEASE-NOTES-v0.9.0.md");
  });
});

describe("docs never imply a price (Taroting is free + open source)", () => {
  for (const rel of [...DOCS, ...RELEASE_READMES]) {
    it(`${rel} has no cost-implying wording`, () => {
      const abs = resolve(root, rel);
      expect(existsSync(abs), `${rel} is missing`).toBe(true);
      const text = readFileSync(abs, "utf8");
      const hits = BANNED.flatMap((re) => {
        const m = text.match(new RegExp(re, "gi"));
        return m ? [`${re} → ${[...new Set(m)].join(", ")}`] : [];
      });
      expect(hits, `${rel}: reword these as resource "overhead", not cost`).toEqual([]);
    });
  }
});
