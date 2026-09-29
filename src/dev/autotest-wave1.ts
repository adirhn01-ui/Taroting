// Dev-only E2E blocks pinning the 0.9 foundations, run at the end of
// runAutotest (autotest.ts hands over its own harness). Kept in a module of
// their own so the 0.9 blocks do not grow autotest.ts further.

import { ipc, mediaUrl } from "../core/ipc";
import { navigate } from "../core/nav";
import { splitClip } from "../core/project";
import { shortcutsBlocked } from "../core/shortcuts";
import { clipDuration, snapToFrame } from "../core/time";
import type { Clip } from "../core/types";
import type { DevHook } from "./autotest";

export interface Wave1Ctx {
  test(name: string, fn: () => Promise<string> | string): Promise<void>;
  assert(cond: boolean, detail: string): void;
  waitFor<T>(get: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T>;
  sleep(ms: number): Promise<void>;
  /** tests/fixtures, as runAutotest received it. */
  fixturesDir: string;
  /** The run's own project. By the time these blocks run the app is back on
   *  Home (the last theme block navigates there), so the editor is reopened on
   *  it rather than assumed open. */
  projectPath: string;
}

export async function runWave1Blocks(ctx: Wave1Ctx): Promise<void> {
  const { test, assert, waitFor, fixturesDir, projectPath } = ctx;

  await test("editor-ctrl-y-redo", async () => {
    // Ctrl+Y is the second redo chord (redoAlt), bound only on the editor's
    // screen. The block dispatches the chord the way a keyboard does — at
    // window, through the editor's own ShortcutManager — so it pins the whole
    // path: the default chord, the editor-mode binding and the handler.
    const hookOf = (): DevHook | undefined =>
      (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev;
    // A fresh hook is mountEditor's completion signal; the previous one is
    // still on window from an earlier mount and would resolve instantly.
    const prevHook = hookOf();
    // A mount that times out may still complete afterwards; without this the
    // run would be left parked in the editor for every later block, because
    // the try/finally below only begins once the hook is in hand.
    let dev: DevHook;
    try {
      navigate({ view: "editor", projectPath });
      dev = await waitFor(
        () => {
          const h = hookOf();
          return h && h !== prevHook ? h : null;
        },
        15_000,
        "the editor to mount",
      );
    } catch (e) {
      navigate({ view: "home" });
      throw e;
    }
    const { session, engine } = dev;
    const clipsOf = (): readonly Clip[] =>
      session.project.timeline.tracks[0]!.clips;
    const before = clipsOf().length;
    // Written from inside the commit mutator, so a holder rather than a let
    // (the compiler would keep a closure-assigned let narrowed to null).
    const split: { rightId: string | null } = { rightId: null };
    try {
      const target = clipsOf().find((c) => clipDuration(c) >= 2);
      assert(target !== undefined, "the autotest project has no clip of 2 s or more on track 1 to split");
      // Not the 30 s the split-undo-redo block uses, and frame-aligned, so a
      // redo that restored some OTHER split would not land on this time.
      const splitT = snapToFrame(target!.timelineStart + clipDuration(target!) * 0.37, engine.fps());
      session.commit((p) => {
        const r = splitClip(p, target!.id, splitT);
        split.rightId = r.rightId;
        return r.project;
      });
      assert(
        split.rightId !== null && clipsOf().length === before + 1,
        `the split at ${splitT.toFixed(3)}s did not land (${clipsOf().length} clips, expected ${before + 1})`,
      );
      session.undo();
      // Without this the redo below would be observed on a timeline that was
      // never un-split — a pass by construction.
      assert(
        clipsOf().length === before && !clipsOf().some((c) => c.id === split.rightId),
        `undo did not remove the split (${clipsOf().length} clips, expected ${before})`,
      );

      // A leftover dialog or menu from an earlier block makes every chord
      // inert by design; name it here instead of misreading it as a dead
      // Ctrl+Y.
      assert(document.querySelector(".modal-backdrop") === null, "a dialog is still open over the editor");
      assert(!shortcutsBlocked(), "a surface still holds the keyboard (blockShortcuts)");

      const ev = new KeyboardEvent("keydown", {
        key: "y",
        code: "KeyY",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
      assert(
        ev.defaultPrevented,
        "Ctrl+Y was not claimed by the editor's shortcuts — no redoAlt binding or no handler for it",
      );
      const right = clipsOf().find((c) => c.id === split.rightId);
      assert(
        clipsOf().length === before + 1 && right !== undefined,
        `Ctrl+Y was claimed but the split did not come back (${clipsOf().length} clips, expected ${before + 1})`,
      );
      assert(
        Math.abs(right!.timelineStart - splitT) < 1e-9,
        `the redone split starts at ${right!.timelineStart}s, not ${splitT}s`,
      );
      return `split at ${splitT.toFixed(3)}s → undo → Ctrl+Y: ${before} → ${before + 1} clips, right half back at its split time`;
    } finally {
      // Undo only a split that is actually on the timeline: an unconditional
      // undo would pop whatever else the history holds.
      if (split.rightId !== null && clipsOf().some((c) => c.id === split.rightId)) session.undo();
      engine.refresh();
      navigate({ view: "home" });
    }
  });

  /** Probe a fixture still the way import does. */
  const probeStill = async (name: string) => {
    const info = await ipc.probeMedia(`${fixturesDir}\\${name}`).catch((e: unknown) => {
      throw new Error(`probing ${name} failed (run npm run fixtures if it is missing): ${String(e)}`);
    });
    assert(info.kind === "image", `${name} probed as ${info.kind}, not a still`);
    return { info, size: `${info.width}x${info.height}` };
  };

  /** The webview's own decode of a fixture: the <img> natural size, as the
   *  preview would draw the file. */
  const webviewSize = async (name: string): Promise<string> => {
    const img = new Image();
    img.src = mediaUrl(`${fixturesDir}\\${name}`);
    // Given a handler up front: a timeout must not leave an unhandled
    // rejection behind to fail the whole run from the errors list.
    const decoding = img.decode();
    decoding.catch(() => {});
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`timed out decoding ${name}`)), 5_000);
    });
    try {
      await Promise.race([decoding, timeout]);
      return `${img.naturalWidth}x${img.naturalHeight}`;
    } finally {
      clearTimeout(timer);
      img.removeAttribute("src");
    }
  };

  await test("exif-orientation-webp", async () => {
    // exif-orientation-still's WebP twin: CODED 64x36, EXIF orientation 6 in
    // a VP8X EXIF chunk. ffmpeg would turn it on decode (measured 36x64), but
    // WebView2 does NOT turn a WebP by its EXIF (measured, runtime 152) — so
    // the app ignores the tag everywhere (exif::read_still, per file): the
    // probe stores the CODED 64x36 and flags the entry noAutorotate, which is
    // what makes export open it -noautorotate.
    //
    // DRIFT ALARM: if a later WebView2 starts honouring WebP EXIF, the <img>
    // decodes 36x64, parity breaks and this goes red — change the WebP row of
    // read_still's table then (and this block's 64x36 with it). Parity is the
    // real pin: the preview's <img> is sized from the probe's numbers.
    const { info, size } = await probeStill("photo_o6.webp");
    assert(size === "64x36", `probe stored ${size}; a WebP keeps its CODED 64x36 — the webview does not turn it, so neither may the app`);
    // Not the pin: the probe stamps EVERY still (probe.rs sets it
    // unconditionally), so this can only fail if the flag is dropped outright.
    assert(info.oriented === true, `probe did not stamp the still as oriented (got ${String(info.oriented)})`);
    assert(
      info.noAutorotate === true,
      `probe did not flag the WebP noAutorotate (got ${String(info.noAutorotate)}) — export would turn what the preview does not`,
    );
    const webview = await webviewSize("photo_o6.webp");
    assert(
      webview === size,
      `DRIFT: the webview decodes ${webview} but the probe stored ${size} — WebView2 now turns a WebP by its EXIF; change the WebP row of exif::read_still`,
    );
    return `probe ${size} oriented=${String(info.oriented)} noAutorotate=${String(info.noAutorotate)} (coded 64x36, EXIF 6, tag ignored); webview <img> natural ${webview} — WebView2 still ignores WebP EXIF orientation, parity holds`;
  });

  // The same photo as a PNG, twice: CODED 64x36, eXIf orientation 6, before
  // the image data and after it — and ffmpeg turns both (make-fixtures refuses
  // to write one it does not). WebView2 turns the early one and NOT the late
  // one (measured, runtime 152), so the rule is per FILE (exif::read_still):
  // the early PNG is followed (probe 36x64, no flag), the late one is coded
  // and flagged noAutorotate (probe 64x36). Both are DRIFT ALARMS: parity with
  // the webview's own decode is the pin, and every number is in the message,
  // so a red run says which way the webview went.
  for (const [block, name, where, want, flagged] of [
    ["exif-orientation-png-early", "photo_o6_early.png", "before", "36x64", false],
    ["exif-orientation-png-late", "photo_o6_late.png", "after", "64x36", true],
  ] as const) {
    await test(block, async () => {
      const { info, size } = await probeStill(name);
      assert(
        size === want,
        `probe stored ${size}; a PNG with its eXIf ${where} IDAT must store ${want} (coded 64x36, eXIf 6) — see exif::read_still's PNG rows`,
      );
      assert(
        (info.noAutorotate === true) === flagged,
        `probe noAutorotate=${String(info.noAutorotate)}; an eXIf ${where} IDAT must ${flagged ? "" : "NOT "}be flagged`,
      );
      const webview = await webviewSize(name);
      const turns = webview === "36x64";
      assert(
        webview === size,
        `DRIFT: webview <img> natural ${webview}, probe ${size} — WebView2 now ${turns ? "TURNS" : "does NOT turn"} a PNG by an eXIf ${where} IDAT; change that PNG row of exif::read_still`,
      );
      return `webview <img> natural ${webview}, probe ${size} noAutorotate=${String(info.noAutorotate)} (coded 64x36, eXIf 6 ${where} IDAT) — WebView2 ${turns ? "turns" : "does not turn"} it, parity holds`;
    });
  }
}
