// Guard: Taroting is free and open source, forever. This test fails the build
// if any user-facing document reintroduces monetization / cost-implying wording.
// It scans README + docs/** and the (untracked-but-present) release READMEs.
// If a match is a legitimate resource-cost sentence, reword it to "overhead"
// rather than weakening this list — the whole point is that nothing here should
// read as if the app costs money.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Files that must never imply a price. Missing files are simply skipped.
const DOCS = [
  "README.md",
  "docs/PERFORMANCE.md",
  "docs/RELEASE-NOTES-v0.5.0.md",
  "docs/RELEASE-NOTES-v0.6.0.md",
  "docs/RELEASE-NOTES-v0.6.1.md",
  "docs/RELEASE-NOTES-v0.6.2.md",
  "docs/RELEASE-NOTES-v0.7.0.md",
];

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

describe("docs never imply a price (Taroting is free + open source)", () => {
  for (const rel of DOCS) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    it(`${rel} has no cost-implying wording`, () => {
      const text = readFileSync(abs, "utf8");
      const hits = BANNED.flatMap((re) => {
        const m = text.match(new RegExp(re, "gi"));
        return m ? [`${re} → ${[...new Set(m)].join(", ")}`] : [];
      });
      expect(hits, `${rel}: reword these as resource "overhead", not cost`).toEqual([]);
    });
  }
});
