// `npm run tauri <args>`: the Tauri CLI, unchanged, except for a release
// `build`. That one runs with `--remap-path-prefix` flags (see
// scripts/build-paths.mjs) so dependency panic locations stop carrying the
// build machine's home folder, and afterwards the built exe is scanned: any
// path-shaped trace of the account fails the build.
//
// Every other subcommand, `tauri dev` and `tauri build --debug` included, runs
// with the environment untouched. Rustflags are part of cargo's fingerprint,
// so setting them there would rebuild the debug and test caches from scratch.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountPathHits, hasFlag, isReleaseBuild, remapFlags } from "./build-paths.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = process.argv.slice(2);

const release = isReleaseBuild(args);

let env = process.env;
if (release) {
  const home = homedir();
  const cargoHome = process.env.CARGO_HOME || join(home, ".cargo");
  const existing = process.env.CARGO_ENCODED_RUSTFLAGS
    ? process.env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
    : (process.env.RUSTFLAGS ?? "").split(/\s+/);
  const flags = [...existing.filter((f) => f.length > 0), ...remapFlags({ home, cargoHome, root })];
  env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
  delete env.RUSTFLAGS;
}

const run = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env });
if (run.error) {
  console.error(`tauri: could not start the Tauri CLI: ${run.error.message}`);
  process.exit(1);
}
const status = run.status ?? 1;

if (status === 0 && release && !hasFlag(args, "--target", "-t")) {
  const targetDir = process.env.CARGO_TARGET_DIR
    ? resolve(root, "src-tauri", process.env.CARGO_TARGET_DIR)
    : join(root, "src-tauri", "target");
  const exe = join(targetDir, "release", "taroting.exe");
  if (!existsSync(exe)) {
    console.error(`tauri: build finished but ${exe} is missing, so it could not be checked for the account name`);
    process.exit(1);
  }
  const hits = accountPathHits(readFileSync(exe), homedir());
  if (hits > 0) {
    console.error(`tauri: the built taroting.exe contains the build account's home folder path ${hits} time(s); it must not ship`);
    process.exit(1);
  }
  console.log("tauri: taroting.exe checked: no trace of the build account's home folder");
}

process.exit(status);
