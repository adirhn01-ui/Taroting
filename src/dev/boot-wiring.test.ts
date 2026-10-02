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
  // The listener is AWAITED before the drain: it registers only after a
  // dynamic import, so a drain sent beside it can be answered first, and a
  // wake-up in that gap reaches nobody.
  if (!/await onOpenPath\(/.test(c)) problems.push("onOpenPath is not awaited before the drain");
  // The editor chunk is warmed once, from Home's branch of go(): a launch that
  // opens a file in the viewer never fetches it. The editor ROUTE imports the
  // same module (`await import(...)`); only the fire-and-forget warm counts.
  const warm = 'void import("./editor/editor")';
  const warms = c.split(warm).length - 1;
  if (warms !== 1) problems.push(`the editor warm appears ${warms} times, expected once`);
  const warmAt = c.indexOf(warm);
  const homeAt = c.indexOf('route.view === "home"');
  const nextBranchAt = c.indexOf("} else if (route.view", homeAt);
  if (warmAt >= 0 && !(homeAt >= 0 && warmAt > homeAt && nextBranchAt > warmAt)) {
    problems.push("the editor warm is outside Home's branch of go()");
  }
  // One idle cache trim per plain launch, after Home and the startup drain.
  const trim = "ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, [])";
  const trimAt = c.indexOf(trim);
  if (trimAt < 0) problems.push("missing: the startup cache trim");
  else {
    if (trimAt < c.indexOf("await drainOpenPaths()")) problems.push("the startup cache trim runs before the drain");
    if (!/requestIdleCallback\?\.\(\s*\(\)\s*=>\s*void ipc\.enforceCacheLimit\(/.test(c)) {
      problems.push("the startup cache trim is not deferred to idle");
    }
    // The `if` directly around it, as its `&&` terms: never after a failed
    // settings read (the limit on hand is the default then), and never on a
    // launch that opened a file (its first screen is still preparing that
    // file, and a trim could evict the cache entry it is about to reuse).
    const gateAt = c.lastIndexOf("if (", trimAt);
    const condEnd = gateAt < 0 ? -1 : c.indexOf(") {", gateAt);
    const encloses = condEnd >= 0 && condEnd < trimAt && !c.slice(condEnd, trimAt).includes("}");
    const terms = encloses ? c.slice(gateAt + "if (".length, condEnd).split("&&").map((t) => t.trim()) : [];
    if (!terms.includes("load.ok")) {
      problems.push("the startup cache trim is not gated on a good settings read");
    }
    if (!terms.includes("launch === null")) {
      problems.push("the startup cache trim runs on a launch that opened a file");
    }
  }
  // Crash notes are asked for once, after the first screen and the drain, and
  // never awaited: nothing on the boot path may wait on them.
  const crash = "ipc.takeCrashNotes()";
  const crashes = c.split(crash).length - 1;
  if (crashes !== 1) problems.push(`takeCrashNotes is called ${crashes} times in main.ts, expected once`);
  else {
    if (c.indexOf(crash) < c.indexOf("await drainOpenPaths()")) problems.push("the crash notes are taken before the drain");
    if (!c.includes(`void ${crash}.then(showCrashNotes)`)) problems.push("the crash notes are awaited or not shown");
  }
  // The viewer's held folder order: kept only across a viewer → project →
  // viewer round trip (an editor route with returnTo), dropped on the first
  // route anywhere else — and never asked about on a plain launch.
  const forgets = c.split("ipc.forgetSiblingOrder()").length - 1;
  if (forgets !== 1) problems.push(`forgetSiblingOrder is called ${forgets} times in main.ts, expected once`);
  if (!/if \(route\.view === "editor" && route\.returnTo !== undefined\) siblingOrderHeld = true;/.test(c)) {
    problems.push("the held folder order is not kept for an editor opened from the viewer");
  }
  if (!/else if \(siblingOrderHeld\) \{\s*siblingOrderHeld = false;\s*void ipc\.forgetSiblingOrder\(\)/.test(c)) {
    problems.push("the held folder order is not dropped (only) when one is held");
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
    const listen = "  await onOpenPath(() => void drainOpenPaths()).catch(() => {});";
    const open = "  if (launch) await launch.openQueued(() => ipc.takePendingOpenPaths());";
    expect(MAIN.includes(listen) && MAIN.includes(open)).toBe(true);
    const bad = MAIN.replace(listen, "").replace(open, `${listen}\n${open}`);
    expect(checkBootWiring(bad)).toContain("launch.openQueued( must come before onOpenPath(");
  });

  it("rejects a listener that is not awaited before the drain", () => {
    const listen = "await onOpenPath(() => void drainOpenPaths()).catch(() => {});";
    expect(MAIN.includes(listen)).toBe(true);
    const bad = MAIN.replace(listen, "void onOpenPath(() => void drainOpenPaths());");
    expect(checkBootWiring(bad)).toEqual(["onOpenPath is not awaited before the drain"]);
  });

  it("rejects the editor warm moved back to every launch", () => {
    const warm = '      requestIdleCallback?.(() => void import("./editor/editor"));';
    expect(MAIN.includes(warm)).toBe(true);
    const bad = `${MAIN.replace(warm, "")}\n${warm.trim()}\n`;
    expect(checkBootWiring(bad)).toEqual(["the editor warm is outside Home's branch of go()"]);
  });

  it("rejects the startup cache trim dropped, or run before the drain", () => {
    const trim = "ipc.enforceCacheLimit(settingsStore.get().cacheLimitMB, [])";
    expect(MAIN.includes(trim)).toBe(true);
    expect(checkBootWiring(MAIN.replace(trim, "Promise.resolve()"))).toEqual(["missing: the startup cache trim"]);
    const listen = "  await onOpenPath(";
    expect(MAIN.includes(listen)).toBe(true);
    const early = MAIN.replace(listen, `  if (load.ok && launch === null) { void ${trim}.catch(() => {}); }\n${listen}`);
    expect(checkBootWiring(early)).toEqual(["the startup cache trim runs before the drain"]);
  });

  it("rejects a startup cache trim that is not deferred to idle", () => {
    const at = MAIN.indexOf("ipc.enforceCacheLimit(settingsStore");
    const idle = "requestIdleCallback?.(";
    const idleAt = MAIN.lastIndexOf(idle, at);
    const bad = `${MAIN.slice(0, idleAt)}void (${MAIN.slice(idleAt + idle.length)}`;
    expect(bad).not.toBe(MAIN);
    expect(checkBootWiring(bad)).toEqual(["the startup cache trim is not deferred to idle"]);
  });

  const TRIM_GATE = "if (load.ok && launch === null) {";

  it("rejects a startup cache trim that runs after a failed settings read", () => {
    expect(MAIN.split(TRIM_GATE).length - 1).toBe(1);
    const bad = MAIN.replace(TRIM_GATE, "if (launch === null) {");
    expect(checkBootWiring(bad)).toEqual(["the startup cache trim is not gated on a good settings read"]);
  });

  it("rejects a startup cache trim reached on a launch that opened a file", () => {
    // The file being opened is still being prepared when the idle callback
    // fires; an LRU trim then can evict its own remux or proxy.
    expect(MAIN.split(TRIM_GATE).length - 1).toBe(1);
    const bad = MAIN.replace(TRIM_GATE, "if (load.ok) {");
    expect(checkBootWiring(bad)).toEqual(["the startup cache trim runs on a launch that opened a file"]);
  });

  it("rejects a startup cache trim with no gate at all", () => {
    const bad = MAIN.replace(TRIM_GATE, "{");
    expect(checkBootWiring(bad)).toEqual([
      "the startup cache trim is not gated on a good settings read",
      "the startup cache trim runs on a launch that opened a file",
    ]);
  });

  it("rejects a held folder order dropped unconditionally, or never kept", () => {
    const guard = "  else if (siblingOrderHeld) {";
    expect(MAIN.split(guard).length - 1).toBe(1);
    expect(checkBootWiring(MAIN.replace(guard, "  else {"))).toEqual(["the held folder order is not dropped (only) when one is held"]);
    const keep = "if (route.view === \"editor\" && route.returnTo !== undefined) siblingOrderHeld = true;";
    expect(MAIN.includes(keep)).toBe(true);
    expect(checkBootWiring(MAIN.replace(keep, "if (route.view === \"editor\") siblingOrderHeld = true;"))).toEqual([
      "the held folder order is not kept for an editor opened from the viewer",
    ]);
  });

  it("rejects crash notes taken before the drain, or awaited", () => {
    const line = "  void ipc.takeCrashNotes().then(showCrashNotes).catch(() => {});";
    expect(MAIN.split(line).length - 1).toBe(1);
    const listen = "  await onOpenPath(";
    const early = MAIN.replace(line, "").replace(listen, `${line}\n${listen}`);
    expect(checkBootWiring(early)).toEqual(["the crash notes are taken before the drain"]);
    const awaited = MAIN.replace(line, "  await ipc.takeCrashNotes().then(showCrashNotes).catch(() => {});");
    expect(checkBootWiring(awaited)).toEqual(["the crash notes are awaited or not shown"]);
    expect(checkBootWiring(MAIN.replace(line, ""))).toEqual(["takeCrashNotes is called 0 times in main.ts, expected once"]);
  });

  it("ignores a commented-out call", () => {
    const line = "const launch = beginBoot(hasLaunchHint(window), {";
    expect(MAIN.includes(line)).toBe(true);
    const bad = MAIN.replace(line, `// ${line}\nconst launch = beginBoot(true, {`);
    expect(checkBootWiring(bad).some((x) => x.includes("appears 0 times"))).toBe(true);
  });
});
