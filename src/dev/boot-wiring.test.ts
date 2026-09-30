// Guard: how src/main.ts wires core/boot. The in-app E2E always boots with no
// launch file and always ends on Home, so it cannot see a plain launch pushed
// onto the launch-file path (Home delayed until the settings read and the
// drain) or the first file opened in the wrong order relative to the close
// gate and the second-launch listener. These checks read the source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN = readFileSync(resolve(root, "src/main.ts"), "utf8");

/** Line comments dropped, so a commented-out call never counts. */
const code = (src: string): string =>
  src
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

/** Problems with the boot wiring, [] when sound. */
function checkBootWiring(src: string): string[] {
  const c = code(src);
  const problems: string[] = [];
  // Only a launch that carries a file takes the hint path: the argument is the
  // hint itself, never a literal `true`.
  const begins = c.split("beginBoot(hasLaunchHint(window),").length - 1;
  if (begins !== 1) problems.push(`beginBoot(hasLaunchHint(window), …) appears ${begins} times, expected once`);
  if (/beginBoot\(\s*true\b/.test(c)) problems.push("beginBoot is forced onto the launch-file path");
  // The first file opens after the close gate (so a close during it is gated)
  // and before the second-launch listener and drain (so nothing is opened twice).
  const order = ["installCloseGate(closeDeps)", "launch.openQueued(", "onOpenPath(", "await drainOpenPaths()"];
  const at = order.map((needle) => c.indexOf(needle));
  order.forEach((needle, i) => {
    if (at[i]! < 0) problems.push(`missing: ${needle}`);
  });
  for (let i = 1; i < order.length; i++) {
    const before = at[i - 1]!;
    const here = at[i]!;
    if (before >= 0 && here >= 0 && before > here) {
      problems.push(`${order[i - 1]} must come before ${order[i]}`);
    }
  }
  return problems;
}

describe("boot wiring (src/main.ts)", () => {
  it("is sound in the real file", () => {
    expect(checkBootWiring(MAIN)).toEqual([]);
  });

  // One corruption per rule, each failing for exactly its own reason.
  it("rejects a plain launch forced onto the launch-file path", () => {
    const bad = MAIN.replace("beginBoot(hasLaunchHint(window),", "beginBoot(true,");
    expect(bad).not.toBe(MAIN);
    const p = checkBootWiring(bad);
    expect(p.some((x) => x.includes("appears 0 times"))).toBe(true);
    expect(p.some((x) => x.includes("forced onto the launch-file path"))).toBe(true);
  });

  it("rejects the first file opened before the close gate", () => {
    const gate = "  installCloseGate(closeDeps);";
    const open = "  if (launch) await launch.openQueued(() => ipc.takePendingOpenPaths());";
    expect(MAIN.includes(gate) && MAIN.includes(open)).toBe(true);
    const bad = MAIN.replace(gate, "").replace(open, `${open}\n${gate}`);
    expect(checkBootWiring(bad)).toContain("installCloseGate(closeDeps) must come before launch.openQueued(");
  });

  it("rejects the second-launch listener attached before the first file opens", () => {
    const listen = "  void onOpenPath(() => void drainOpenPaths());";
    const open = "  if (launch) await launch.openQueued(() => ipc.takePendingOpenPaths());";
    expect(MAIN.includes(listen) && MAIN.includes(open)).toBe(true);
    const bad = MAIN.replace(listen, "").replace(open, `${listen}\n${open}`);
    expect(checkBootWiring(bad)).toContain("launch.openQueued( must come before onOpenPath(");
  });

  it("ignores a commented-out call", () => {
    const line = "const launch = beginBoot(hasLaunchHint(window), {";
    expect(MAIN.includes(line)).toBe(true);
    const bad = MAIN.replace(line, `// ${line}\nconst launch = beginBoot(true, {`);
    expect(checkBootWiring(bad).some((x) => x.includes("appears 0 times"))).toBe(true);
  });
});
