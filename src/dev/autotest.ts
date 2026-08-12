// Dev-only in-app E2E harness. Launched when the app starts with
// TAROTING_AUTOTEST=1: builds a project from the synthetic fixtures, opens
// the editor, and asserts real behavior (frame-accurate seeking, stepping,
// split/undo, playback advancement) against the actual video elements.
// Results are written to %TEMP%\taroting-autotest-report.json.

import { appVersion, ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import {
  addGeneratedMedia,
  addMarkerAt,
  createProject,
  importMediaAsClip,
  setKeyframe,
  setPositionKeyframes,
  splitClip,
} from "../core/project";
import type { ProjectSession } from "../core/session";
import { frameCenter } from "../core/time";
import { measureText, openGeneratorDialog } from "../editor/media/generators";
import type { AudioGraph } from "../editor/playback/audio-graph";
import type { MediaManager } from "../editor/media/media";
import type { PlaybackEngine } from "../editor/playback/engine";

export interface DevHook {
  engine: PlaybackEngine;
  session: ProjectSession;
  media: MediaManager;
  audioGraph: AudioGraph;
  activeVideo(): HTMLVideoElement | null;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

/** mediaTime of the next presented frame on the active video element. */
function presentedMediaTime(el: HTMLVideoElement): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const fallback = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(el.currentTime);
      }
    }, 400);
    el.requestVideoFrameCallback((_now, meta) => {
      if (!done) {
        done = true;
        clearTimeout(fallback);
        resolve(meta.mediaTime);
      }
    });
  });
}

export async function runAutotest(fixturesDir: string): Promise<void> {
  const results: TestResult[] = [];
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  window.addEventListener("error", (e) => {
    // benign: layout settled on the next frame; not a defect
    if (e.message.includes("ResizeObserver loop")) return;
    errors.push(`error: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { stack?: string } | undefined;
    errors.push(`unhandledrejection: ${r?.stack ?? String(e.reason)}`);
  });

  const write = async (done: boolean): Promise<void> => {
    const pass = done && results.length > 0 && results.every((r) => r.pass) && errors.length === 0;
    const report = {
      pass,
      done,
      startedAt,
      updatedAt: new Date().toISOString(),
      results,
      errors,
    };
    try {
      await ipc.debugWriteReport(JSON.stringify(report, null, 2));
    } catch {
      console.error("autotest: could not write report", report);
    }
  };
  const finish = (): Promise<void> => write(true);

  const test = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    results.push({ name, pass: false, detail: "…running" });
    await write(false);
    try {
      const detail = await fn();
      results[results.length - 1] = { name, pass: true, detail };
    } catch (e) {
      results[results.length - 1] = { name, pass: false, detail: String(e) };
    }
    await write(false);
  };

  const hardTimeout = setTimeout(() => {
    results.push({ name: "overall", pass: false, detail: "timed out after 90s" });
    void finish();
  }, 90_000);

  try {
    await write(false); // mark the run as started
    /* ---- build a project from fixtures ---- */
    const projectPath = await ipc.newProjectPath("Autotest");
    let project = createProject("Autotest");
    const counter = await ipc.probeMedia(`${fixturesDir}\\counter_h264.mp4`);
    project = importMediaAsClip(project, counter).project;
    const tone = await ipc.probeMedia(`${fixturesDir}\\tone.mp3`);
    project = importMediaAsClip(project, tone).project;
    await ipc.saveProject(projectPath, project);
    navigate({ view: "editor", projectPath });

    /* ---- wait for the editor + media readiness ---- */
    const dev = await waitFor(
      () => (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev,
      15_000,
      "editor dev hook",
    );
    const { engine, session, media } = dev;
    await waitFor(
      () => {
        const st = media.status.get();
        const states = Object.values(st);
        return states.length >= 2 && states.every((s) => s.state === "ready");
      },
      30_000,
      "all media ready",
    );

    const fps = engine.fps();
    const frameAt = (mediaTime: number): number =>
      Math.floor((mediaTime * fps.num) / fps.den + 1e-9);

    await test("project-duration", () => {
      const d = engine.duration();
      assert(Math.abs(d - 60) < 0.6, `expected ≈60s, got ${d}`);
      return `${d.toFixed(3)}s`;
    });

    await test("seek-frame-accuracy", async () => {
      engine.seek(frameCenter(100, fps));
      await sleep(150);
      const el = dev.activeVideo();
      assert(el !== null, "no active video element");
      const mt = await presentedMediaTime(el!);
      const frame = frameAt(mt);
      assert(frame === 100, `expected frame 100, presented ${frame} (mediaTime=${mt.toFixed(5)})`);
      return `frame 100 @ mediaTime ${mt.toFixed(5)}`;
    });

    await test("frame-stepping", async () => {
      engine.stepFrames(1);
      await sleep(120);
      let mt = await presentedMediaTime(dev.activeVideo()!);
      const f1 = frameAt(mt);
      assert(f1 === 101, `step +1: expected 101, got ${f1}`);
      engine.stepFrames(-2);
      await sleep(120);
      mt = await presentedMediaTime(dev.activeVideo()!);
      const f2 = frameAt(mt);
      assert(f2 === 99, `step -2: expected 99, got ${f2}`);
      return "100 → 101 → 99 exact";
    });

    await test("split-undo-redo", () => {
      const clips = (): number => session.project.timeline.tracks[0]!.clips.length;
      const first = session.project.timeline.tracks[0]!.clips[0]!;
      const before = clips();
      session.commit((p) => splitClip(p, first.id, 30).project);
      assert(clips() === before + 1, `split: ${clips()} clips, expected ${before + 1}`);
      session.undo();
      assert(clips() === before, `undo: ${clips()} clips, expected ${before}`);
      session.redo();
      assert(clips() === before + 1, `redo: ${clips()} clips`);
      session.undo(); // leave the timeline as it was
      engine.refresh();
      return "split → undo → redo consistent";
    });

    await test("playback-advances", async () => {
      engine.seek(5);
      await sleep(200);
      const t0 = engine.time;
      engine.play();
      await sleep(2000);
      const t1 = engine.time;
      engine.pause();
      assert(!engine.playing, "engine should be paused");
      const advanced = t1 - t0;
      assert(advanced > 1.4 && advanced < 2.8, `advanced ${advanced.toFixed(3)}s in 2s wall`);
      return `advanced ${advanced.toFixed(3)}s in 2.0s wall clock`;
    });

    await test("pause-always-wins", async () => {
      // Exercises the real transport wiring: the #tr-play button click handler
      // AND the window "playPause" shortcut (Space) both call engine.toggle().
      // The button reflects engine state via the tick listener (pause/play icon).
      const playBtn = document.querySelector<HTMLButtonElement>("#tr-play");
      assert(playBtn !== null, "no #tr-play transport button");
      const showsPause = (): boolean => playBtn!.innerHTML.includes("M7 4h3v16"); // pause glyph
      const showsPlay = (): boolean => playBtn!.innerHTML.includes("m6 4 14 8"); // play glyph
      // window-level Space, the shortcut path (bubbles to ShortcutManager).
      const pressSpace = (): void => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
        );
      };

      engine.seek(5);
      await sleep(120);
      if (engine.playing) engine.pause();
      assert(!engine.playing && showsPlay(), "precondition: paused + play glyph");

      // 1) Space toggles play; button flips to the pause glyph immediately.
      pressSpace();
      await sleep(60);
      assert(engine.playing, "Space did not start playback");
      assert(showsPause(), "button did not flip to pause glyph after play");

      // 2) The core symptom: after clicking the play button to pause, the button
      // holds focus. A focused <button> makes Space a native activation (click)
      // AS WELL AS the window shortcut — two toggles for one press → the pause
      // is undone. Clicking must blur the button so the next Space is a single
      // toggle. Reproduce exactly: click to pause, then press Space once.
      playBtn!.focus();
      playBtn!.click(); // pause via the transport button
      await sleep(60);
      assert(!engine.playing, "transport-button click did not pause");
      assert(showsPlay(), "button did not flip to play glyph after pause");
      assert(document.activeElement !== playBtn, "play button must blur after click");

      // now a single Space must produce exactly ONE toggle (→ playing), not two.
      const wasPlaying = engine.playing;
      pressSpace();
      await sleep(60);
      assert(engine.playing !== wasPlaying, "single Space did not produce exactly one toggle");
      assert(engine.playing, "expected exactly one toggle → playing");
      assert(showsPause(), "button glyph out of sync with engine after Space");

      // 3) Rapid Space toggling ends deterministically and pause always wins:
      // an even number of presses returns to the start state; the button matches.
      const startPlaying = engine.playing;
      for (let i = 0; i < 6; i++) { pressSpace(); await sleep(20); }
      assert(engine.playing === startPlaying, "6 rapid Space presses not idempotent");
      // explicit pause must stop, and the button must show the play glyph.
      engine.pause();
      await sleep(30);
      assert(!engine.playing, "final pause did not stop playback");
      assert(showsPlay(), "button glyph shows pause after engine paused");
      // and no video element is left playing behind a paused engine.
      const stuck = dev.activeVideo();
      assert(stuck === null || stuck.paused, "a video element kept playing after pause");

      // 4) The reported symptom: spamming physical mouse clicks on the play
      // button sometimes leaves playback RUNNING even though the last click was
      // a pause. Root cause modeled faithfully: the browser synthesizes a
      // `click` from the mouse-DOWN target; while playing, the tick listener
      // used to rewrite the button's innerHTML ~60×/s, destroying the <svg> the
      // press landed on before mouse-up, so the click was dropped. We reproduce
      // by driving native down/up/click sequences through the DOM (NOT the
      // synthetic .click() helper, which cannot miss) and letting real RAF ticks
      // run between down and up. A robust build swaps the glyph only on an actual
      // flip and marks the icon pointer-events:none, so the button is always the
      // event target and no click is ever eaten.
      const scheduler2 = (dev as unknown as { scheduler: import("../editor/playback/scheduler").Scheduler }).scheduler;
      const allVideosPaused = (): boolean => scheduler2.videoElements().every((v) => v.paused);
      // Dispatch one native activation the way a stationary mouse does: press on
      // whatever node is currently under the button (svg/path or the button
      // itself), let the frame advance, then release + click routed through the
      // DOWN target with bubbling — exactly how the platform pairs a click.
      const nativeActivate = async (settleMs: number): Promise<void> => {
        const downTarget: Element = playBtn!.querySelector("svg *") ?? playBtn!.querySelector("svg") ?? playBtn!;
        const opts = { bubbles: true, cancelable: true, view: window } as MouseEventInit;
        downTarget.dispatchEvent(new PointerEvent("pointerdown", opts));
        downTarget.dispatchEvent(new MouseEvent("mousedown", opts));
        await sleep(settleMs); // a real RAF tick (or several) lands here mid-press
        const upTarget: Element = downTarget.isConnected ? downTarget : playBtn!;
        upTarget.dispatchEvent(new PointerEvent("pointerup", opts));
        upTarget.dispatchEvent(new MouseEvent("mouseup", opts));
        // The platform fires `click` from the mouse-DOWN target. If that node was
        // detached mid-press it is no longer in the tree, so a bubbling click
        // never reaches the button handler — reproducing the eaten click.
        downTarget.dispatchEvent(new MouseEvent("click", opts));
      };

      // Storm: several rounds of alternating activations at varied 60–140ms
      // spacing, always ending on an ODD count so the final intent is PAUSE.
      // Start each round from a known playing state and assert the button icon
      // stays consistent with the engine mid-storm (icon-vs-engine coherence).
      const spacings = [60, 75, 90, 110, 140, 70, 100, 130, 65, 120, 85, 115];
      let storms = 0;
      for (let round = 0; round < 12; round++) {
        // begin the round PLAYING so an odd click count ends on pause
        if (!engine.playing) { engine.play(); await sleep(40); }
        assert(engine.playing && showsPause(), `round ${round}: expected playing+pause-glyph at start`);
        const clicks = 2 * (round % 3) + 1; // 1,3,5,1,3,5,... always odd → ends paused
        for (let c = 0; c < clicks; c++) {
          const gap = spacings[(round * 5 + c) % spacings.length]!;
          await nativeActivate(gap);
          storms++;
          // mid-storm coherence: the glyph must match the engine after settle.
          await sleep(20);
          const coherent = engine.playing ? showsPause() : showsPlay();
          assert(coherent, `round ${round} click ${c}: icon out of sync (playing=${engine.playing})`);
        }
        // odd clicks from a playing start ⇒ the engine MUST now be paused.
        await sleep(300); // settle: let any in-flight play() promise resolve
        assert(!engine.playing, `round ${round}: ${clicks} clicks ending on pause left engine PLAYING`);
        assert(showsPlay(), `round ${round}: engine paused but button shows pause glyph`);
        assert(allVideosPaused(), `round ${round}: a <video> kept playing after the pause click`);
      }

      // 5) The mirror image of "pause always wins": PLAY must always survive a
      // benign re-activation. Seeking during playback re-runs scheduler.activate,
      // which re-arms the SAME active clip and issues a fresh el.play() while an
      // earlier play() promise is still pending. Under the old generation-token
      // guard the earlier promise resolved, saw a bumped token, and paused the
      // master mid-playback — freezing the playhead while the transport still
      // read "playing". Seek repeatedly DURING playback, then assert the engine
      // is still playing, the active <video> is NOT paused, and time advances.
      engine.seek(4);
      await sleep(60);
      if (!engine.playing) { engine.play(); await sleep(40); }
      assert(engine.playing, "precondition: playing before seek storm");
      // several seeks within the SAME clip at ~50ms spacing (each re-activates)
      for (let i = 0; i < 6; i++) {
        engine.seek(4 + i * 0.15); // stays inside the base counter clip
        await sleep(50);
      }
      await sleep(400); // settle: let every in-flight play() promise resolve
      assert(engine.playing, "seek-during-play stopped the transport (engine.playing false)");
      const liveVid = dev.activeVideo();
      assert(liveVid !== null, "no active video after seek storm");
      assert(!liveVid!.paused, "active <video> was paused by a stale play() guard mid-playback");
      const seekT0 = engine.time;
      await sleep(500);
      const seekT1 = engine.time;
      assert(
        seekT1 > seekT0 + 0.2,
        `playhead frozen after seek storm: advanced only ${(seekT1 - seekT0).toFixed(3)}s in 0.5s`,
      );
      engine.pause();
      await sleep(30);
      assert(!engine.playing && allVideosPaused(), "cleanup pause after seek storm did not settle");

      return `button-click blurs; single Space = one toggle; ${storms} storm-clicks, pause always wins; seek-during-play keeps playing (+${(seekT1 - seekT0).toFixed(2)}s)`;
    });

    await test("theater-mode", async () => {
      // Fullscreen playback ("theater") mode. requestFullscreen() rejects without
      // a user gesture in this harness, so the in-window theater must engage on
      // its own; every assertion below works purely off the in-window layer.
      const preview = document.querySelector<HTMLElement>(".editor__preview");
      assert(preview !== null, "no .editor__preview container");
      const fsBtn = document.querySelector<HTMLButtonElement>("#tr-fullscreen");
      assert(fsBtn !== null, "no #tr-fullscreen transport button");
      const transport = document.querySelector<HTMLElement>(".transport");
      assert(transport !== null, "no .transport bar");

      // clean, paused precondition well inside the timeline
      if (engine.playing) engine.pause();
      engine.seek(20);
      await sleep(80);

      // Establish a real selection BEFORE entering so we can prove it survives
      // the round-trip: click the clip under the playhead via the overlay (its
      // pointerdown hit-tests + selects), then confirm the selection box paints.
      const stageOverlay = document.querySelector<HTMLElement>(".stage-overlay")!;
      const selbox = stageOverlay.querySelector<HTMLElement>(".stage-overlay__selbox")!;
      const stageCanvas = stageOverlay.parentElement as HTMLElement; // .preview__canvas

      // Teardown runs in a finally so a mid-test assertion failure can NEVER leak
      // theater state (fixed inset-0, overlay display:none, a live selection) into
      // the tests that follow (e.g. crop-mode-cycle needs the overlay interactive).
      try {
      {
        const cbox = stageCanvas.getBoundingClientRect();
        const ccx = cbox.left + cbox.width / 2;
        const ccy = cbox.top + cbox.height / 2;
        stageOverlay.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: ccx, clientY: ccy, bubbles: true }));
        stageOverlay.dispatchEvent(new PointerEvent("pointerup", { button: 0, clientX: ccx, clientY: ccy, bubbles: true }));
        await sleep(60);
      }
      assert(getComputedStyle(selbox).display !== "none", "precondition: selection box should be visible before theater");

      // 1) enter via the REAL button click; container gets .theater + bar visible
      fsBtn!.click();
      await sleep(60);
      assert(preview!.classList.contains("theater"), "container missing .theater class after enter");
      const bar = preview!.querySelector<HTMLElement>(".theater-bar");
      assert(bar !== null, "no .theater-bar mounted");
      assert(getComputedStyle(bar!).display !== "none", "theater bar not visible when active");

      // 1a) OVERLAY GONE: the whole manipulation overlay is display:none while
      // active (view-only), so no selection box / handles / guides paint over the
      // video. (Merely pointer-events:none would still leave the chrome painted.)
      // The selbox keeps its own inline display:block (its render state is frozen,
      // not cleared — proving selection survives), so we assert it is not RENDERED:
      // a node inside a display:none subtree has no layout box (offsetParent null,
      // zero client rects). That is the correct "not visible" semantic.
      assert(getComputedStyle(stageOverlay).display === "none", "stage-overlay must be display:none in theater (view-only)");
      assert(
        selbox.offsetParent === null && selbox.getClientRects().length === 0,
        "selection box must not be rendered in theater (overlay is display:none)",
      );

      // 1b) SHARP: the stage/canvas has no rounded corners in theater (plain
      // player, clean letterbox), regardless of the windowed --radius-s.
      assert(
        getComputedStyle(stageCanvas).borderRadius === "0px",
        `canvas border-radius must be 0px in theater, got ${getComputedStyle(stageCanvas).borderRadius}`,
      );

      // 1c) PAINT/HIT ORDER: the control bar (and its play button) must be the
      // topmost thing at their own center — elementFromPoint there returns the bar
      // / button or a descendant, NEVER a video / canvas / overlay behind it. This
      // is the exact failure the user saw (bar painted under the z-indexed video).
      const withinBar = (el: Element | null): boolean => !!el && (el === bar || bar!.contains(el));
      {
        const bb = bar!.getBoundingClientRect();
        const hitBar = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
        assert(
          withinBar(hitBar),
          `bar center is occluded: elementFromPoint=${(hitBar as HTMLElement | null)?.className ?? "null"} (bar not on top)`,
        );
        const playBtn = bar!.querySelector<HTMLButtonElement>('[data-act="playpause"]')!;
        const pb = playBtn.getBoundingClientRect();
        const hitPlay = document.elementFromPoint(pb.left + pb.width / 2, pb.top + pb.height / 2);
        assert(
          withinBar(hitPlay),
          `play button is occluded: elementFromPoint=${(hitPlay as HTMLElement | null)?.className ?? "null"}`,
        );
      }

      // 1d) REFIT: after the container jumped to fixed inset-0, the stage refit so
      // the canvas letterboxes the new box — its rendered size matches an aspect
      // fit of the project dims into the container (within a couple px). Proves the
      // fit() path ran on the transition (no stale windowed size / transient tiny).
      {
        await sleep(80); // let the refit rAFs run
        const cont = preview!.getBoundingClientRect();
        const cvs = stageCanvas.getBoundingClientRect();
        const dims = session.project.timeline;
        const k = Math.min(cont.width / dims.width, cont.height / dims.height);
        const expW = dims.width * k;
        const expH = dims.height * k;
        assert(
          Math.abs(cvs.width - expW) < 3 && Math.abs(cvs.height - expH) < 3,
          `canvas did not refit to the fullscreen box: got ${cvs.width.toFixed(1)}x${cvs.height.toFixed(1)}, expected ~${expW.toFixed(1)}x${expH.toFixed(1)}`,
        );
      }

      // 2) ±5s buttons move engine.time by ~±5 (respect clamping)
      const back5 = bar!.querySelector<HTMLButtonElement>('[data-act="back5"]')!;
      const fwd5 = bar!.querySelector<HTMLButtonElement>('[data-act="fwd5"]')!;
      engine.seek(20);
      await sleep(60);
      const tb0 = engine.time;
      back5.click();
      await sleep(60);
      assert(Math.abs(engine.time - (tb0 - 5)) < 0.3, `back5: ${engine.time.toFixed(2)} vs ${(tb0 - 5).toFixed(2)}`);
      const tf0 = engine.time;
      fwd5.click();
      await sleep(60);
      assert(Math.abs(engine.time - (tf0 + 5)) < 0.3, `fwd5: ${engine.time.toFixed(2)} vs ${(tf0 + 5).toFixed(2)}`);
      // clamp at 0: seek near start, back5 must not go negative
      engine.seek(2);
      await sleep(40);
      back5.click();
      await sleep(60);
      assert(engine.time >= -1e-6 && engine.time < 1e-3, `back5 clamp at 0: got ${engine.time.toFixed(3)}`);

      // 3) the seek bar reflects position after a seek (fill width + aria)
      const seek = bar!.querySelector<HTMLElement>('[data-el="seek"]')!;
      const fill = bar!.querySelector<HTMLElement>('[data-el="fill"]')!;
      const dur = engine.duration();
      engine.seek(dur / 2);
      await sleep(80); // let a tick paint the bar
      const aria = Number(seek.getAttribute("aria-valuenow"));
      assert(Math.abs(aria - 50) < 2, `seek aria-valuenow ${aria} not ~50 at mid`);
      const fillPct = parseFloat(fill.style.width);
      assert(Math.abs(fillPct - 50) < 2, `seek fill width ${fillPct}% not ~50 at mid`);

      // 4) auto-hide: while PLAYING, no pointer movement for > the hide delay hides
      // the chrome; a pointermove reveals it instantly. (Never hides while paused.)
      engine.seek(5);
      engine.play();
      await sleep(60);
      // a fresh pointermove reveals + arms the idle countdown
      preview!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 }));
      await sleep(50);
      assert(!preview!.classList.contains("theater--hidden"), "chrome should be visible right after pointermove");
      await sleep(2700); // > AUTO_HIDE_MS (2500) with NO movement while playing
      assert(preview!.classList.contains("theater--hidden"), "chrome did not auto-hide after idle while playing");
      preview!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
      await sleep(50);
      assert(!preview!.classList.contains("theater--hidden"), "pointermove did not reveal the chrome");
      engine.pause();
      await sleep(40);

      // 5) frame-step arrows behave as ±5s INSIDE theater (intercepted before the
      // global frame-step shortcut). Dispatch on document so the capture handler
      // sees it, exactly as a real key press would.
      engine.seek(20);
      await sleep(50);
      const ta0 = engine.time;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      await sleep(60);
      assert(Math.abs(engine.time - (ta0 + 5)) < 0.3, `ArrowRight in theater: ${engine.time.toFixed(2)} vs ${(ta0 + 5).toFixed(2)} (expected +5s, not a frame)`);
      const ta1 = engine.time;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
      await sleep(60);
      assert(Math.abs(engine.time - (ta1 - 5)) < 0.3, `ArrowLeft in theater: ${engine.time.toFixed(2)} vs ${(ta1 - 5).toFixed(2)} (expected -5s)`);

      // 6) Escape exits: .theater removed, the editor transport is visible again
      engine.seek(20);
      await sleep(40);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(60);
      assert(!preview!.classList.contains("theater"), ".theater class not removed after Escape");
      assert(getComputedStyle(transport!).display !== "none", "transport not visible after exiting theater");

      // OVERLAY RESTORED: exiting theater returns the manipulation overlay exactly
      // as it was — it paints again (display not none) AND the prior selection is
      // intact (its box is visible again, never cleared by entering/leaving). The
      // canvas radius returns to the windowed rounded look, too.
      assert(getComputedStyle(stageOverlay).display !== "none", "stage-overlay must paint again after exiting theater");
      assert(
        getComputedStyle(selbox).display !== "none" && selbox.offsetParent !== null,
        "prior selection lost after exiting theater (selbox not rendered)",
      );
      assert(getComputedStyle(stageCanvas).borderRadius !== "0px", "canvas should regain its windowed radius after exit");

      // frame-step semantics restore on exit: an ArrowRight now steps ONE frame
      // (via the global shortcut), a sub-second move — NOT ±5s.
      const fps2 = engine.fps();
      const frameSec = fps2.den / fps2.num;
      engine.seek(20);
      await sleep(40);
      const te0 = engine.time;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      await sleep(60);
      const stepped = engine.time - te0;
      assert(
        stepped > 0 && stepped < 4 * frameSec + 1e-3,
        `after exit ArrowRight stepped ${stepped.toFixed(4)}s, expected ~1 frame (${frameSec.toFixed(4)}s), not ±5s`,
      );

      } finally {
        // clean up: fully out of theater, drop the selection (Escape on the
        // focused overlay), paused, back near the start — leave no state for later
        // tests. Runs even if an assertion above threw, so a theater failure never
        // cascades into the crop / overlay tests that follow.
        if (preview!.classList.contains("theater")) {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          await sleep(40);
        }
        stageOverlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(30);
        engine.pause();
        engine.seek(0);
        await sleep(40);
      }
      return "enter→.theater+bar; overlay display:none+selbox gone+radius 0; bar/play hit-topmost; canvas refit to fullscreen box; ±5s+clamp; seek 50%; auto-hide↔pointermove; arrows ±5s→frame-step after exit; Escape restores transport+overlay+selection";
    });

    await test("delete-layer", async () => {
      const { addVideoTrack, removeTrack, findTrack, findClip, makeClip, insertClip, videoTracks, checkInvariants } =
        await import("../core/project");
      const counter = session.project.media[0]!; // the counter fixture (video)
      const vcount = (): number => videoTracks(session.project).length;
      const before = vcount();

      // 1) empty layer: add → +1, delete instantly → restored
      let emptyId = "";
      session.commit((p) => { const r = addVideoTrack(p); emptyId = r.trackId; return r.project; });
      engine.refresh();
      assert(vcount() === before + 1, `add empty layer → ${before + 1} video tracks, got ${vcount()}`);
      session.commit((p) => removeTrack(p, emptyId));
      engine.refresh();
      assert(vcount() === before, `delete empty layer → ${before} video tracks, got ${vcount()}`);
      assert(findTrack(session.project, emptyId) === undefined, "empty layer should be gone");

      // 2) sole-video guard: removeTrack refuses the last video track (with or
      //    without force) — the project reference is unchanged.
      if (before === 1) {
        const only = videoTracks(session.project)[0]!.id;
        const guarded = removeTrack(session.project, only, { force: true });
        assert(guarded === session.project, "last video track must be refused even with force");
      }

      // 3) force path: add a layer, put a clip on it, force-remove → clips gone +
      //    invariants clean; undo x1 restores the track AND its clip exactly.
      let forceId = "";
      session.commit((p) => { const r = addVideoTrack(p); forceId = r.trackId; return r.project; });
      let clipId = "";
      session.commit((p) => {
        const clip = makeClip(counter, 0);
        clip.srcOut = clip.srcIn + 3; // 3s footprint
        clipId = clip.id;
        return insertClip(p, forceId, clip);
      });
      engine.refresh();
      assert(findTrack(session.project, forceId)!.clips.length === 1, "clip should sit on the new layer");
      const beforeForce = session.project;

      session.commit((p) => removeTrack(p, forceId, { force: true }));
      engine.refresh();
      assert(findTrack(session.project, forceId) === undefined, "force-removed layer should be gone");
      assert(findClip(session.project, clipId) === undefined, "the layer's clip should be gone too");
      assert(vcount() === before, `after force-remove → ${before} video tracks, got ${vcount()}`);
      const errs = checkInvariants(session.project);
      assert(errs.length === 0, `invariants must stay clean: ${errs.join("; ")}`);

      // undo x1 restores the track AND its clip exactly
      session.undo();
      engine.refresh();
      const restored = findTrack(session.project, forceId);
      assert(restored !== undefined, "undo should restore the force-removed layer");
      assert(restored!.clips.length === 1 && restored!.clips[0]!.id === clipId, "undo should restore the clip exactly");
      assert(
        JSON.stringify(session.project) === JSON.stringify(beforeForce),
        "undo should restore the project state exactly",
      );

      // clean up: undo back to the pristine 'before' state (drop the force layer)
      session.undo(); // removes the clip-insert commit
      session.undo(); // removes the addVideoTrack commit
      engine.refresh();
      assert(vcount() === before, `cleanup → ${before} video tracks, got ${vcount()}`);
      return `empty layer add/delete (+1→${before}); force-remove drops 1 clip + clean invariants; undo x1 restored track+clip`;
    });

    await test("embedded-audio", async () => {
      // The user-reported v0.7.0 bug: a plain H.264+AAC video (Decision::Direct)
      // played with NO audio, or audio that "cuts at parts". counter_h264.mp4 is
      // deliberately video-only, so this path had ZERO coverage. counter_audio_
      // h264.mp4 is the same burnt-in counter WITH a muxed 440Hz AAC tone.
      const graph = dev.audioGraph;
      const scheduler = (dev as unknown as { scheduler: import("../editor/playback/scheduler").Scheduler }).scheduler;
      const { splitClip, findClip } = await import("../core/project");
      const { clipEnd, frameCenter } = await import("../core/time");

      const info = await ipc.probeMedia(`${fixturesDir}\\counter_audio_h264.mp4`);
      assert(info.hasAudio, "fixture counter_audio_h264.mp4 must carry an audio stream");

      // importMediaAsClip appends onto the top video track AFTER the 60s video-
      // only counter, so this clip owns [60, 80] alone — tone.mp3 ends at 30s and
      // the counter carries no audio, so ALL master-bus energy in [60,80] is this
      // clip's embedded audio (clean attribution for the RMS probes).
      let clipId = "";
      session.commit((p) => {
        const r = importMediaAsClip(p, info);
        clipId = r.clipId;
        return r.project;
      });
      engine.refresh();
      // A raw session.commit doesn't run the editor's import side effects, so
      // kick media preparation explicitly (Direct plan → ready), as the
      // generated-media test does.
      media.ensureAll(session.project);
      const mediaId = session.project.media[session.project.media.length - 1]!.id;
      const clipStart = findClip(session.project, clipId)!.clip.timelineStart;
      assert(clipStart > 59, `audio clip should append after the 60s counter, got start ${clipStart}`);
      await waitFor(
        () => { const s = media.status.get()[mediaId]; return s && s.state === "ready" ? s : null; },
        15_000,
        "counter_audio media ready",
      );

      // Split 5s in so a CONTINUOUS play crosses a real cut boundary (the A/B
      // double-buffer swap) — the exact path the "cuts at parts" symptom rides.
      const cut = clipStart + 5;
      session.commit((p) => splitClip(p, clipId, cut).project);
      engine.refresh();

      // Headless harnesses may lack the user activation the autoplay policy wants;
      // if the AudioContext won't run, the master-bus RMS can't be measured, so we
      // fall back to the element's live gain-envelope value (which is the direct
      // routing signal for this bug and is deterministic either way).
      const analyserRunning = await graph.devEnsureRunning();

      // Wait (briefly) for an active ready video over the playhead. A fresh
      // seek / ruler scrub leaves the element re-buffering for a few frames
      // (readyState < 2 → it drops out of activeVideoInfos), so poll instead of
      // asserting on the first frame. This does NOT mask the mute bug: the
      // reproduction mutes via a STALE envelope while the element stays ready
      // (gain locked at 0), so `assertAudible`'s gain check still catches it.
      const waitActiveEl = async (): Promise<HTMLVideoElement> => {
        let el: HTMLVideoElement | null = null;
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          el = scheduler.activeVideoInfos()[0]?.el ?? null;
          if (el) break;
          await sleep(30);
        }
        assert(el !== null, "no active video element over the audio clip");
        return el!;
      };
      // Read peak master RMS + the active element's routing over a short window.
      const measure = async (ms: number): Promise<{ rms: number; gain: number; wired: boolean }> => {
        const el = await waitActiveEl();
        let rms = 0;
        const end = performance.now() + ms;
        while (performance.now() < end) {
          rms = Math.max(rms, graph.devMasterRms());
          await sleep(30);
        }
        return { rms, gain: graph.devVideoGainValue(el), wired: graph.devVideoWired(el) };
      };
      const assertAudible = (m: { rms: number; gain: number; wired: boolean }, where: string): void => {
        assert(m.wired, `${where}: active <video> is NOT routed through the audio graph`);
        assert(m.gain > 0.5, `${where}: gain envelope pinned at ${m.gain.toFixed(3)} (want ~1) — audio gated OFF`);
        if (analyserRunning) {
          assert(m.rms > 0.02, `${where}: master-bus RMS ${m.rms.toFixed(4)} ≈ 0 — no real audio at the speakers`);
        }
      };

      try {
        // 1) INSIDE part1 from a fresh play (the discontinuity path). Positive
        //    control: audible with AND without the fix — proves the rig works.
        engine.seek(clipStart + 2);
        await sleep(200);
        engine.play();
        assertAudible(await measure(400), "start-of-clip");

        // 2) THE REGRESSION: play continuously across the cut into part2 via the
        //    A/B swap (no seek → no discontinuity). The old build never re-armed
        //    the newly-active slot's envelope, so its gain stayed pinned at 0 even
        //    though its fresh MediaElementSource had already stolen the element's
        //    audio off the default output → silence after the cut.
        engine.seek(cut - 0.8);
        await sleep(150);
        if (!engine.playing) engine.play();
        await sleep(2000);
        assert(engine.time > cut + 0.6, `did not cross the cut (t=${engine.time.toFixed(2)}, cut=${cut.toFixed(2)})`);
        assertAudible(await measure(400), "after-cut-boundary");

        // 3) after a SEEK deep into part2 (discontinuity path again) — still audible.
        engine.seek(cut + 6);
        await sleep(250);
        if (!engine.playing) engine.play();
        assertAudible(await measure(400), "after-seek");

        // ---- MANUAL SEEK / RULER SCRUB (the v0.7.1 user report: "I skip to
        // certain frames manually / drag the red playhead and it cuts the audio
        // and it doesn't come back / just goes mute"). These drive engine.seek
        // the way the ruler does — to frame centers of arbitrary frames — with
        // sub-0.3s jumps that are NOT discontinuities, so the old build's
        // discontinuity heuristic and drop-out/re-enter dance both miss the
        // re-arm and a stale (time-absolute) envelope mutes audio that must
        // stay full. part2 spans [cut, p2end]; model scrubs inside it.
        const fps = session.project.timeline.fps;
        const frameSec = fps.den / fps.num;
        const part2 = ((): import("../core/types").Clip => {
          for (const tr of session.project.timeline.tracks) {
            for (const c of tr.clips) if (Math.abs(c.timelineStart - cut) < 1e-3) return c;
          }
          throw new Error("part2 clip (starting at the cut) not found");
        })();
        const p2end = clipEnd(part2);
        // seek to the frame center of the frame containing `time` — exactly how
        // the timeline ruler resolves a pointer position to a seek target.
        const scrubTo = (time: number): void =>
          engine.seek(frameCenter(Math.round(time / frameSec), fps));

        // (a) small FORWARD manual seek (<0.3s, no discontinuity): audio must
        //     recover to full within a few hundred ms.
        engine.seek(cut + 4);
        await sleep(200);
        if (!engine.playing) engine.play();
        await measure(120);
        scrubTo(engine.time + 0.2);
        assertAudible(await measure(400), "after-small-forward-seek");

        // (b) backward-then-forward manual seek, both sub-0.3s.
        scrubTo(engine.time - 0.24);
        await sleep(120);
        scrubTo(engine.time + 0.18);
        assertAudible(await measure(400), "after-backward-then-forward-seek");

        // (c) BOUNDARY-CROSSING scrub: land just inside part2, then scrub back
        //     across the cut into part1 (<0.3s jump) — the active clip id
        //     changes, so a fresh envelope must arm on the newly-active clip.
        engine.seek(cut + 0.15);
        await sleep(150);
        if (!engine.playing) engine.play();
        scrubTo(cut - 0.12); // lands in part1; playback then carries back over the cut
        await sleep(200);
        assertAudible(await measure(400), "after-cut-crossing-scrub");

        // (d) RAPID SCRUB STORM, net-BACKWARD — the precise reproduction of the
        //     user's "drag the playhead and it goes mute / doesn't come back".
        //     Start ~0.6s before the clip end so the envelope scheduled at play()
        //     bakes its "zero at clip end" only ~0.6s out in ctx time. Then
        //     ruler-drag backward as a rapid SYNCHRONOUS burst (no awaits between
        //     hops — a real pointermove drag fires many seeks within one input
        //     turn), so NO rAF tick lands mid-burst: the element never drops out
        //     of activeVideoInfos, so the old build's drop-out/re-enter re-arm
        //     never fires. Small (<frame-ish) hops stay inside the just-played,
        //     still-decoded buffer so the seek doesn't force a readyState dip.
        //     Each hop is <0.3s (no discontinuity) and the clip id never changes,
        //     so on the OLD build the play()-scheduled envelope is NEVER re-armed;
        //     once ctx time passes its baked-in zero the gain is locked at 0 with
        //     seconds of real audio still to play → sticky mute. The fix re-arms
        //     the instant the element's real position diverges from that stale
        //     envelope, so audio stays full.
        engine.seek(p2end - 3);
        await sleep(200);
        if (!engine.playing) engine.play();
        await measure(200); // play() scheduled the envelope from t≈p2end-3
        // Play THROUGH [p2end-3, p2end-0.6] so that region is decoded+buffered;
        // a later backward scrub into it then completes without the element
        // dropping out of activeVideoInfos for more than a blip.
        await waitFor(() => (engine.time > p2end - 0.7 ? true : null), 6000, "play through the buffer region");
        // Ruler-drag backward through the just-played (buffered) region as a
        // rapid SYNCHRONOUS burst: small <0.3s hops, no awaits between them (a
        // real pointermove drag fires many seeks in one input turn). No rAF tick
        // lands mid-burst and each hop stays in decoded data, so the element does
        // NOT drop out — the OLD build's drop-out/re-enter re-arm never fires,
        // and with no discontinuity and an unchanged clip id its envelope is
        // never re-armed. Its baked-in "zero" (scheduled for a position AHEAD of
        // where we now are) then fires early and the gain LOCKS at 0 with ~2s of
        // real audio still to play → the user's "it cuts the audio". The fix
        // re-arms the instant the element's real position diverges from that
        // stale envelope, so the gain never cuts.
        let sp = engine.time;
        for (let i = 0; i < 22; i++) {
          sp -= 0.09; // small, sub-discontinuity, stays inside the buffered region
          scrubTo(sp); // synchronous — no await
        }
        await sleep(300);
        assert(engine.playing, "playback must continue through the scrub storm");
        assert(
          engine.time < p2end - 0.3,
          `backward scrub should have moved back, at ${engine.time.toFixed(2)} (p2end ${p2end.toFixed(2)})`,
        );
        // The "doesn't come back" guard: after the scrub the embedded audio must
        // be full AND STAY full over a sustained window — a stale-envelope mute
        // that never re-arms (the pre-fix failure mode) fails this. NOTE: the
        // *transient* cut this bug can produce is intermittent in a headless
        // WebView2 (a buffered backward seek may or may not dip readyState → the
        // drop-out/re-enter re-arm sometimes masks it), so gating on the cut
        // itself would be flaky; this asserts the deterministic steady state.
        assertAudible(await measure(400), "after-backward-scrub-storm");
        assertAudible(await measure(400), "after-backward-scrub-storm-sustained");

        // (e) manual seek while PAUSED, then play — audio must be full on resume.
        engine.pause();
        await sleep(120);
        engine.seek(cut + 8);
        await sleep(150);
        scrubTo(cut + 8.15); // tiny nudge while paused
        await sleep(120);
        engine.play();
        assertAudible(await measure(400), "after-seek-while-paused");

        // 4) PAUSED → the bus goes quiet (no element is producing samples).
        engine.pause();
        await sleep(200);
        assert(scheduler.videoElements().every((v) => v.paused), "a <video> kept playing after pause");
        let pausedRms = 0;
        for (let i = 0; i < 8; i++) { pausedRms = Math.max(pausedRms, graph.devMasterRms()); await sleep(30); }
        if (analyserRunning) assert(pausedRms < 0.01, `paused master-bus RMS ${pausedRms.toFixed(4)} not ≈ 0`);
      } finally {
        engine.pause();
        session.undo(); // undo split
        session.undo(); // undo import
        engine.seek(0);
        engine.refresh();
        await sleep(40);
      }

      return `embedded video audio routed+audible at start, across the A/B cut boundary, after a seek, and after every manual seek / ruler scrub (small fwd, back-then-fwd, cut-crossing, rapid backward storm, seek-while-paused); silent when paused ${analyserRunning ? "(master-bus RMS measured)" : "(ctx suspended — gain-envelope measured)"}`;
    });

    await test("playback-across-cut", async () => {
      // split at 8s, then play from 7.5 → should cross the cut and keep going
      const first = session.project.timeline.tracks[0]!.clips[0]!;
      session.commit((p) => splitClip(p, first.id, 8).project);
      engine.refresh();
      engine.seek(7.5);
      await sleep(200);
      engine.play();
      await sleep(1500);
      const t = engine.time;
      engine.pause();
      session.undo();
      engine.refresh();
      assert(t > 8.4, `expected to cross the 8s cut, reached ${t.toFixed(3)}`);
      return `crossed cut, reached ${t.toFixed(3)}s`;
    });

    await test("audio-drift", async () => {
      const graph = dev.audioGraph;
      graph.resetDriftStats();
      engine.seek(1);
      await sleep(200);
      engine.play();
      await sleep(3000);
      engine.pause();
      const drift = graph.maxObservedDriftSec();
      assert(drift < 0.12, `A/V drift ${drift.toFixed(4)}s exceeded 0.12s`);
      return `max A/V drift ${(drift * 1000).toFixed(1)}ms over 3s`;
    });

    // ---- v0.6 interaction QoL: markers, restore-audio, ctx-menu suppression ----

    await test("marker-add-seek-drag-delete", async () => {
      const { addMarkerAt, moveMarkerTo, removeMarker } = await import("../core/project");
      const markers = (): import("../core/types").Marker[] =>
        session.project.timeline.markers ?? [];
      const before = markers().length;

      // add at the playhead (transport "M" equivalent)
      engine.seek(4);
      await sleep(50);
      let id = "";
      session.commit((p) => {
        const r = addMarkerAt(p, engine.time);
        id = r.markerId;
        return r.project;
      });
      assert(markers().length === before + 1, `add: ${markers().length} markers`);
      const added = markers().find((m) => m.id === id)!;
      assert(Math.abs(added.t - 4) < 1e-6, `marker t=${added.t}, expected 4`);

      // seek-to-marker (what a pointerdown on the flag does)
      engine.seek(added.t);
      assert(Math.abs(engine.time - added.t) < 0.05, `seek-to-marker time=${engine.time}`);

      // drag (marker-move gesture, clamped >= 0)
      session.commit((p) => moveMarkerTo(p, id, 9));
      assert(Math.abs(markers().find((m) => m.id === id)!.t - 9) < 1e-6, "drag to 9s");

      // right-click → delete
      session.commit((p) => removeMarker(p, id));
      assert(!markers().some((m) => m.id === id), "marker not deleted");
      assert(markers().length === before, `after delete: ${markers().length}`);
      return "add → seek → drag(4→9) → delete round-trip exact";
    });

    await test("restore-audio-round-trip", async () => {
      const { detachAudio, updateClip, findClip, importMediaAsClip } = await import(
        "../core/project"
      );
      // the counter fixture is video-only; use direct_h264.mp4 (testsrc2+sine)
      // which actually has an audio stream to detach.
      const info = await ipc.probeMedia(`${fixturesDir}\\direct_h264.mp4`);
      assert(info.hasAudio, "fixture direct_h264.mp4 must have audio");
      let id = "";
      session.commit((p) => {
        const r = importMediaAsClip(p, info);
        id = r.clipId;
        return r.project;
      });

      // detach via the existing mutation
      session.commit((p) => detachAudio(p, id).project);
      const detached = findClip(session.project, id)!.clip;
      assert(detached.audio.detached === true, "clip should be detached");

      // restore via the button-equivalent mutation the inspector runs
      session.commit((p) =>
        updateClip(p, id, (c) => ({ ...c, audio: { ...c.audio, detached: false } })),
      );
      const restored = findClip(session.project, id)!.clip;
      assert(restored.audio.detached === false, "clip should be restored");

      // clean up: restore → detach → import
      session.undo();
      session.undo();
      session.undo();
      engine.refresh();
      return "detach → restore flips audio.detached true→false";
    });

    await test("contextmenu-suppressed", () => {
      // main.ts installs a window-level contextmenu handler that preventDefaults
      // on any non-editable target. Dispatch on document.body and assert it took.
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      const delivered = document.body.dispatchEvent(ev);
      assert(ev.defaultPrevented === true, "native context menu was not suppressed");
      assert(delivered === false, "contextmenu default should be prevented");

      // an editable field keeps the native menu (copy/paste)
      const inp = document.createElement("input");
      document.body.appendChild(inp);
      const ev2 = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      inp.dispatchEvent(ev2);
      const ok = ev2.defaultPrevented === false;
      inp.remove();
      assert(ok, "editable input should keep the native context menu");
      return "suppressed on body, preserved on <input>";
    });

    // ---- v0.6 Phase 3: multi-layer playback, frame stepping ----

    await test("multi-layer-composite", async () => {
      const { addVideoTrack, makeClip, insertClip } = await import("../core/project");
      const scheduler = (dev as unknown as { scheduler: import("../editor/playback/scheduler").Scheduler }).scheduler;
      const counter = session.project.media[0]!; // the counter fixture (imported first)

      let topId = "";
      session.commit((p) => { const r = addVideoTrack(p); topId = r.trackId; return r.project; });
      session.commit((p) => {
        const clip = makeClip(counter, 1);
        clip.srcOut = clip.srcIn + 2; // 2s footprint → occupies [1,3]
        return insertClip(p, topId, clip);
      });
      engine.refresh();

      engine.seek(2);
      await sleep(200);
      const infos = scheduler.activeVideoInfos();
      assert(infos.length === 2, `expected 2 active video layers at t=2, got ${infos.length}`);
      const setOf = (el: HTMLVideoElement): HTMLElement =>
        el.closest(".stage-layer-set") as HTMLElement;
      const zTop = Number(setOf(infos[0]!.el).style.zIndex);
      const zBot = Number(setOf(infos[1]!.el).style.zIndex);
      assert(zTop > zBot, `topmost layer must have higher z-index (${zTop} vs ${zBot})`);
      assert(infos[0]!.track.id === topId, "topmost active info must be the new top track");

      engine.seek(4);
      await sleep(150);
      assert(scheduler.activeVideoInfos().length === 1, "expected 1 active video layer at t=4");

      engine.seek(2.5);
      await sleep(150);
      const samples: number[] = [];
      engine.play();
      for (let i = 0; i < 12; i++) { await sleep(100); samples.push(engine.time); }
      engine.pause();
      let monotone = true;
      for (let i = 1; i < samples.length; i++) if (samples[i]! < samples[i - 1]! - 0.02) monotone = false;
      assert(monotone, `engine.time not monotone: ${samples.map((s) => s.toFixed(2)).join(",")}`);
      assert(engine.time > 3, `expected to cross the top-layer 3s boundary, reached ${engine.time.toFixed(3)}`);

      session.undo(); session.undo();
      engine.refresh();
      return `2-layer composite ok; z ${zTop}>${zBot}; crossed 3s, reached ${engine.time.toFixed(2)}s`;
    });

    await test("frame-step-rapid", async () => {
      const fps = engine.fps();
      const frameAt2 = (mt: number): number => Math.floor((mt * fps.num) / fps.den + 1e-9);
      engine.seek(frameCenter(100, fps));
      await sleep(150);
      for (let i = 0; i < 10; i++) engine.stepFrames(1); // no sleeps → must chain to 110
      await sleep(250);
      let mt = await presentedMediaTime(dev.activeVideo()!);
      assert(frameAt2(mt) === 110, `after 10x +1 expected frame 110, presented ${frameAt2(mt)}`);
      for (let i = 0; i < 10; i++) engine.stepFrames(-1);
      await sleep(250);
      mt = await presentedMediaTime(dev.activeVideo()!);
      assert(frameAt2(mt) === 100, `after 10x -1 expected frame 100, presented ${frameAt2(mt)}`);
      return "rapid stepping lands exactly: 100 → 110 → 100";
    });

    // (the old `canvas-refit` block lived here; it was a no-op — see the merged
    //  `project-canvas-refit` block below.)

    // ---- v0.6 Phase 4: bin-first import, add-layer, generated media ----

    await test("bin-first-import", async () => {
      const { addMedia, insertClip, makeClip, topVideoTrack, findClip } = await import("../core/project");
      const info = await ipc.probeMedia(`${fixturesDir}\\counter_h264.mp4`);
      const clipCount = (): number =>
        session.project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
      const mediaCount = (): number => session.project.media.length;
      const clipsBefore = clipCount();
      const mediaBefore = mediaCount();
      session.commit((p) => addMedia(p, info).project);
      engine.refresh();
      assert(clipCount() === clipsBefore, `import must NOT create a clip (was ${clipsBefore}, now ${clipCount()})`);
      assert(mediaCount() === mediaBefore + 1, `media list should grow by 1 (was ${mediaBefore})`);
      const media2 = session.project.media[session.project.media.length - 1]!;

      engine.seek(3);
      await sleep(50);
      const at = engine.time;
      // the playhead position is occupied by the base clip, so insertClip
      // resolves to the nearest free spot — compute the expectation the same way
      const { resolvePosition } = await import("../core/project");
      const { clipDuration } = await import("../core/time");
      const probeClip = makeClip(media2, at);
      const expectedAt = resolvePosition(
        topVideoTrack(session.project).clips,
        clipDuration(probeClip),
        at,
      );
      let newId = "";
      session.commit((p) => {
        const clip = makeClip(media2, at);
        newId = clip.id;
        return insertClip(p, topVideoTrack(p).id, clip);
      });
      engine.refresh();
      assert(clipCount() === clipsBefore + 1, `double-click should insert exactly one clip`);
      const placed = findClip(session.project, newId)!.clip;
      assert(
        Math.abs(placed.timelineStart - expectedAt) < 1e-6,
        `clip should land at the resolved position (${placed.timelineStart} vs ${expectedAt})`,
      );

      session.undo();
      session.undo();
      engine.refresh();
      assert(clipCount() === clipsBefore && mediaCount() === mediaBefore, `undo x2 should restore (${clipCount()} clips, ${mediaCount()} media)`);
      return `import→bin only (0 clips, +1 media); dblclick→clip @ ${at.toFixed(2)}s; undo x2 restored`;
    });

    await test("add-layer-button", async () => {
      const { addVideoTrack, videoTracks } = await import("../core/project");
      const before = videoTracks(session.project).length;
      let topId = "";
      session.commit((p) => { const r = addVideoTrack(p); topId = r.trackId; return r.project; });
      engine.refresh();
      assert(videoTracks(session.project).length === before + 1, `video tracks should be ${before + 1}`);
      assert(session.project.timeline.tracks[0]!.id === topId, `new layer must be tracks[0] (topmost/z-order)`);
      session.undo();
      engine.refresh();
      assert(videoTracks(session.project).length === before, `undo should restore ${before} video tracks`);
      return `addVideoTrack → +1 layer as tracks[0]; undo restored ${before}`;
    });

    await test("generated-media-roundtrip", async () => {
      const { addGeneratedMedia, makeClip, insertClip, updateMedia, findMedia } =
        await import("../core/project");

      let solidId = "";
      session.commit((p) => {
        const r = addGeneratedMedia(p, { type: "solid", color: "#10b981" }, 640, 360, "Solid #10b981");
        solidId = r.media.id;
        return r.project;
      });
      const gm = findMedia(session.project, solidId);
      assert(!!gm && gm.generator?.type === "solid", "solid media not in project with generator");

      media.ensureAll(session.project);
      const st = await waitFor(
        () => {
          const s = media.status.get()[solidId];
          return s && s.state === "ready" ? s : null;
        },
        4000,
        "solid media ready",
      );
      assert(st.state === "ready" && st.url === "", `expected ready+empty url, got ${JSON.stringify(st)}`);

      engine.seek(0.2);
      let genClipId = "";
      session.commit((p) => {
        const m = findMedia(p, solidId)!;
        const clip = makeClip(m, engine.time);
        genClipId = clip.id;
        return insertClip(p, p.timeline.tracks[0]!.id, clip);
      });
      engine.refresh();
      const genClip = session.project.timeline.tracks[0]!.clips.find((c) => c.id === genClipId)!;
      engine.seek(genClip.timelineStart + 0.3);
      engine.refresh();
      await sleep(200);

      let shownGreen = false;
      for (const g of Array.from(document.querySelectorAll<HTMLElement>(".stage-layer__gen"))) {
        if (getComputedStyle(g).backgroundColor === "rgb(16, 185, 129)") shownGreen = true;
      }
      assert(shownGreen, "solid gen div not shown as rgb(16,185,129)");

      session.commit((p) => updateMedia(p, solidId, { generator: { type: "solid", color: "#000000" } }));
      engine.refresh();
      await sleep(200);
      let shownBlack = false;
      for (const g of Array.from(document.querySelectorAll<HTMLElement>(".stage-layer__gen"))) {
        if (getComputedStyle(g).backgroundColor === "rgb(0, 0, 0)") shownBlack = true;
      }
      assert(shownBlack, "solid gen div did not recolor to black");

      session.undo();
      session.undo();
      session.undo();
      engine.refresh();
      assert(!findMedia(session.project, solidId), "solid media should be gone after 3 undos");
      return "solid added → ready(empty url) → green → black → undo x3";
    });

    // ---- v0.6 Phase 3: keyframe UI evaluation + project canvas refit ----

    await test("keyframe-ui-eval", async () => {
      // REWRITTEN — the old fixture was degenerate on four axes at once:
      // SYMMETRIC keyframes (-50 / +50) sampled at their exact MIDPOINT
      // (expected 0), on a clip with timelineStart 0 / srcIn 0 / speed 1, then
      // baked with { x: evalX } = { x: 0 } — which is already
      // defaultTransform().x. An evalKfs that ignored `t` and averaged, or
      // inverted the lerp factor, or dropped srcIn / speed / timelineStart from
      // the source-time mapping, AND a bake that silently did nothing, all
      // still produced 0 and passed.
      //
      // The fixture below is asymmetric, sampled OFF the midpoint, on a clip
      // whose timelineStart, srcIn and speed are all non-default, and bakes a
      // NONZERO value. Hand arithmetic, straight from the definitions
      // (core/time.ts `sourceTime`, core/anim.ts `lerpSeg`/`evalKfs`):
      //
      //   clip    timelineStart 3, srcIn 1.5, srcOut 9.5, speed 2
      //           footprint = (srcOut - srcIn) / speed = 8 / 2 = 4 s → [3, 7]
      //   kfs     x: (t=2, v=-30), (t=6, v= 90)     (t is SOURCE seconds)
      //           y: (t=2, v= 20), (t=6, v=-60)
      //   probe   seek(4)  →  clipLocal = 4 - 3 = 1
      //           s = srcIn + clipLocal * speed = 1.5 + 1*2 = 3.5
      //           f = (s - 2) / (6 - 2) = 1.5 / 4 = 0.375
      //           x = -30 + (90 - (-30)) * 0.375 = -30 + 45 =  15
      //           y =  20 + (-60 -  20) * 0.375 =  20 - 30 = -10
      //
      //   Every degeneracy the old fixture hid now lands somewhere else:
      //     ignore t / average                        →  x =  30
      //     inverted lerp factor (f = 0.625)          →  x =  45
      //     srcIn dropped        (s = 2.0)            →  x = -30
      //     speed dropped        (s = 2.5)            →  x = -15
      //     timelineStart dropped (s = 9.5 ≥ last kf) →  x =  90
      //   The nearest wrong answer (30) is 15 away from the true 15, so the
      //   ±0.5 band below discriminates every one of them.
      type P = import("../core/types").ProjectFile;
      const {
        addVideoTrack, makeClip, insertClip, setPositionKeyframes, clearAnimation,
        findClip, findTrack, defaultTransform, checkInvariants,
      } = await import("../core/project");
      const { evalKfs } = await import("../core/anim");
      const { sourceTime, clipDuration } = await import("../core/time");
      const { computeTransform } = await import("../editor/preview/transforms");

      const counter = session.project.media[0]!; // the counter fixture (imported first)
      assert(counter.duration > 9.5, `fixture too short for srcOut 9.5 (${counter.duration}s)`);

      // Count only the history entries THIS block really created (commit is a
      // no-op when the mutator returns the same reference), so teardown can
      // never pop another block's undo step.
      let steps = 0;
      const step = (mutate: (p: P) => P): boolean => {
        const before = session.project;
        session.commit(mutate);
        const changed = session.project !== before;
        if (changed) steps++;
        return changed;
      };
      const drain = (): void => {
        while (steps > 0) {
          session.undo();
          steps--;
        }
        engine.refresh();
      };

      let trackId = "";
      let clipId = "";
      try {
        // A dedicated layer, so the fixture clip can own a non-zero
        // timelineStart without colliding with (or disturbing) the base clip.
        assert(
          step((p) => { const r = addVideoTrack(p); trackId = r.trackId; return r.project; }),
          "addVideoTrack must create a layer",
        );
        assert(
          step((p) => {
            const clip = makeClip(counter, 3); // timelineStart 3
            clip.srcIn = 1.5;
            clip.srcOut = 9.5;
            clip.speed = 2; // → 4 s on the timeline: [3, 7]
            clipId = clip.id;
            return insertClip(p, trackId, clip);
          }),
          "insertClip must place the fixture clip",
        );
        engine.refresh();

        const placed = findClip(session.project, clipId)!.clip;
        assert(
          placed.timelineStart === 3 && placed.srcIn === 1.5 && placed.speed === 2,
          `fixture clip must keep start/srcIn/speed, got ${placed.timelineStart}/${placed.srcIn}/${placed.speed}`,
        );
        assert(
          Math.abs(clipDuration(placed) - 4) < 1e-9,
          `fixture footprint ${clipDuration(placed)}s, expected 4s`,
        );

        assert(step((p) => setPositionKeyframes(p, clipId, 2, -30, 20)), "keyframe @ s=2 not written");
        assert(step((p) => setPositionKeyframes(p, clipId, 6, 90, -60)), "keyframe @ s=6 not written");
        const kfErrs = checkInvariants(session.project);
        assert(kfErrs.length === 0, `invariants with keyframes: ${kfErrs.join("; ")}`);

        engine.seek(4);
        await sleep(120);
        const clip = findClip(session.project, clipId)!.clip;
        const clipLocal = engine.time - clip.timelineStart;
        // The mapping is spelled out here rather than called, so a broken
        // sourceTime cannot define its own expectation.
        const sExpected = 1.5 + clipLocal * 2;
        const s = sourceTime(clip, clipLocal);
        assert(
          Math.abs(s - sExpected) < 1e-9,
          `sourceTime=${s}, expected srcIn + local*speed = ${sExpected}`,
        );
        assert(
          Math.abs(s - 3.5) < 0.05,
          `probe landed at source ${s.toFixed(4)}s, expected 3.5s (seek 4 → clipLocal 1)`,
        );

        const f = (s - 2) / (6 - 2);
        const expX = -30 + (90 - -30) * f;
        const expY = 20 + (-60 - 20) * f;
        const evalX = evalKfs(clip.keyframes!.x!, s);
        const evalY = evalKfs(clip.keyframes!.y!, s);
        assert(Math.abs(evalX - expX) < 1e-9, `evalKfs x=${evalX}, expected ${expX}`);
        assert(Math.abs(evalY - expY) < 1e-9, `evalKfs y=${evalY}, expected ${expY}`);
        assert(
          Math.abs(evalX - 15) < 0.5 && Math.abs(evalY + 10) < 0.5,
          `hand-computed check failed: evalX=${evalX.toFixed(3)} (want 15), evalY=${evalY.toFixed(3)} (want -10)`,
        );

        // Bake those NONZERO values. A bake that silently did nothing would
        // leave the DEFAULT transform (x=0, y=0) — indistinguishable from the
        // old block's expectation, which is why it could not fail.
        const dt = defaultTransform();
        assert(
          step((p) => clearAnimation(p, clipId, "position", { x: evalX, y: evalY })),
          "clearAnimation must clear + bake",
        );
        const baked = findClip(session.project, clipId)!.clip;
        assert(
          baked.keyframes?.x === undefined && baked.keyframes?.y === undefined,
          "position keyframes should be cleared",
        );
        assert(Math.abs(baked.transform!.x - evalX) < 1e-9, `baked x=${baked.transform!.x}, expected ${evalX}`);
        assert(Math.abs(baked.transform!.y - evalY) < 1e-9, `baked y=${baked.transform!.y}, expected ${evalY}`);
        assert(
          Math.abs(baked.transform!.x - dt.x) > 1 && Math.abs(baked.transform!.y - dt.y) > 1,
          `baked transform must differ from defaultTransform(): ${baked.transform!.x}/${baked.transform!.y} vs ${dt.x}/${dt.y}`,
        );

        // and that nonzero pose must survive the preview's pure transform math
        const mediaRef = session.project.media.find((m) => m.id === baked.mediaId)!;
        const ct = computeTransform(baked.transform, mediaRef, session.project.timeline);
        assert(
          Math.abs(ct.posX - evalX) < 1e-9 && Math.abs(ct.posY - evalY) < 1e-9,
          `computeTransform pos=${ct.posX}/${ct.posY}, expected ${evalX}/${evalY}`,
        );

        const undos = steps;
        drain();
        assert(findClip(session.project, clipId) === undefined, "undo should remove the fixture clip");
        assert(findTrack(session.project, trackId) === undefined, "undo should remove the fixture layer");
        return `s=${s.toFixed(3)} (srcIn 1.5 + local ${clipLocal.toFixed(3)} × speed 2) → x=${evalX.toFixed(3)} y=${evalY.toFixed(3)} (hand: 15 / -10); bake ≠ default; undo x${undos} clean`;
      } finally {
        drain();
      }
    });

    await test("project-canvas-refit", async () => {
      // MERGED (was `canvas-refit` + `project-canvas-panel`). Both old blocks
      // committed setProjectCanvas(1280, 720) onto a canvas that was ALREADY
      // 1280x720 — addMedia adopts counter_h264.mp4's dims (testsrc2 1280x720)
      // as the project canvas — and setProjectCanvas returns the SAME reference
      // when nothing changes, so session.commit no-op'd and pushed no history.
      // Every assertion (including "undo restored WxH", which compared 1280 to
      // 1280) was true BEFORE the call: both blocks passed with setProjectCanvas
      // deleted, and the whole store-subscription → stage.refit() path could
      // have been dead code. Worse, the unconditional session.undo() that
      // followed a no-op commit popped an EARLIER block's history entry.
      //
      // Merged into one block rather than kept as two because they exercise a
      // single seam (canvas change → refit → letterbox). One honest test that
      // walks TWO genuinely different canvases (1:1, then 32:9 — which flips
      // which axis the min() fit binds on) covers strictly more than the two
      // no-ops did. Judged by RENDERED geometry: the .preview__canvas box
      // against preview.ts fit() (scale = min(availW/W, availH/H), 24px pad
      // windowed) plus an elementFromPoint probe of a real letterbox bar.
      type P = import("../core/types").ProjectFile;
      const { setProjectCanvas, checkInvariants } = await import("../core/project");
      const tl = (): import("../core/types").Timeline => session.project.timeline;
      const canvas = document.querySelector<HTMLElement>(".preview__canvas");
      assert(canvas !== null, "no .preview__canvas mounted");
      const root = canvas!.parentElement as HTMLElement; // .preview — the letterbox container
      assert(
        root.closest(".editor__preview.theater") === null,
        "precondition: theater mode is still active (fit() would use pad 0)",
      );
      const PAD = 24; // windowed breathing pad, per preview.ts fit()

      const w0 = tl().width;
      const h0 = tl().height;
      const r0 = canvas!.getBoundingClientRect();
      const a0 = r0.width / r0.height;

      let steps = 0;
      const step = (mutate: (p: P) => P): boolean => {
        const before = session.project;
        session.commit(mutate);
        const changed = session.project !== before;
        if (changed) steps++;
        return changed;
      };
      const undoStep = (): void => {
        if (steps > 0) {
          session.undo();
          steps--;
        }
      };

      const avail = (): { w: number; h: number } => {
        const box = root.getBoundingClientRect();
        return { w: Math.max(80, box.width - PAD * 2), h: Math.max(60, box.height - PAD * 2) };
      };

      /** Wait for the store-subscription → stage.refit() path to land the
       *  letterbox for WxH, then assert the RENDERED box really is it. */
      const expectFit = async (W: number, H: number, label: string): Promise<DOMRect> => {
        const a = avail();
        const k = Math.min(a.w / W, a.h / H);
        const expW = Math.round(W * k);
        const expH = Math.round(H * k);
        const rect = await waitFor(
          () => {
            const r = canvas!.getBoundingClientRect();
            return Math.abs(r.width - expW) < 1.5 && Math.abs(r.height - expH) < 1.5 ? r : null;
          },
          3000,
          `${label}: .preview__canvas to refit to ${expW}x${expH}`,
        );
        // Letterbox invariant: fits inside the available box on BOTH axes and
        // touches at least one. A max()-fit (cover) or a single-axis fit fails.
        assert(
          rect.width <= a.w + 1.5 && rect.height <= a.h + 1.5,
          `${label}: canvas ${rect.width.toFixed(1)}x${rect.height.toFixed(1)} overflows avail ${a.w.toFixed(1)}x${a.h.toFixed(1)}`,
        );
        assert(
          rect.width >= a.w - 1.5 || rect.height >= a.h - 1.5,
          `${label}: canvas ${rect.width.toFixed(1)}x${rect.height.toFixed(1)} touches neither axis of avail ${a.w.toFixed(1)}x${a.h.toFixed(1)}`,
        );
        return rect;
      };

      /** Probe a REAL letterbox bar: a point midway between the canvas edge and
       *  the container edge must not hit the canvas (or anything inside it),
       *  while the canvas centre must. */
      const probeBar = (rect: DOMRect, label: string): string => {
        const box = root.getBoundingClientRect();
        const gapX = box.width - rect.width;
        const gapY = box.height - rect.height;
        const horiz = gapX >= gapY;
        const bar = (horiz ? gapX : gapY) / 2;
        // the thinnest possible bar is the 24px windowed pad, so this only trips
        // if the canvas is NOT letterboxed on either axis
        assert(
          bar >= 10,
          `${label}: no letterbox bar to probe (gapX=${gapX.toFixed(1)}, gapY=${gapY.toFixed(1)})`,
        );
        const px = horiz ? (box.left + rect.left) / 2 : rect.left + rect.width / 2;
        const py = horiz ? rect.top + rect.height / 2 : (box.top + rect.top) / 2;
        const hitBar = document.elementFromPoint(px, py);
        assert(
          hitBar !== null && !canvas!.contains(hitBar),
          `${label}: the ${horiz ? "side" : "top"} letterbox point is covered by the canvas (elementFromPoint=${(hitBar as HTMLElement | null)?.className ?? "null"})`,
        );
        const hitIn = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        assert(
          hitIn !== null && canvas!.contains(hitIn),
          `${label}: the canvas centre does not hit the canvas (elementFromPoint=${(hitIn as HTMLElement | null)?.className ?? "null"})`,
        );
        return `${horiz ? "side" : "top/bottom"} bars ${bar.toFixed(0)}px`;
      };

      try {
        // ---- A) square 1:1 — the canvas is NOT this, so the commit must bite
        assert(
          step((p) => setProjectCanvas(p, 1080, 1080)),
          `setProjectCanvas(1080,1080) was a no-op — canvas already 1080x1080? (start ${w0}x${h0})`,
        );
        assert(
          tl().width === 1080 && tl().height === 1080,
          `model ${tl().width}x${tl().height}, expected 1080x1080`,
        );
        let errs = checkInvariants(session.project);
        assert(errs.length === 0, `invariants after 1:1: ${errs.join("; ")}`);
        const rA = await expectFit(1080, 1080, "1:1");
        const aA = rA.width / rA.height;
        assert(Math.abs(aA - 1) < 0.02, `rendered aspect ${aA.toFixed(3)} is not 1:1`);
        assert(
          Math.abs(aA - a0) > 0.2,
          `rendered aspect did not actually change (${a0.toFixed(3)} → ${aA.toFixed(3)})`,
        );
        const barA = probeBar(rA, "1:1");
        const bindWA = rA.width >= avail().w - 1.5;

        // ---- B) ultrawide 32:9 — a genuinely different canvas; for any panel
        //         between 1:1 and 32:9 the OTHER fit axis binds.
        assert(step((p) => setProjectCanvas(p, 2560, 720)), "setProjectCanvas(2560,720) was a no-op");
        assert(
          tl().width === 2560 && tl().height === 720,
          `model ${tl().width}x${tl().height}, expected 2560x720`,
        );
        errs = checkInvariants(session.project);
        assert(errs.length === 0, `invariants after 32:9: ${errs.join("; ")}`);
        const rB = await expectFit(2560, 720, "32:9");
        const aB = rB.width / rB.height;
        assert(Math.abs(aB - 2560 / 720) < 0.05, `rendered aspect ${aB.toFixed(3)} is not 32:9`);
        const barB = probeBar(rB, "32:9");
        const bindWB = rB.width >= avail().w - 1.5;
        const panel = avail().w / avail().h;
        if (panel > 1.05 && panel < 3.5) {
          assert(
            bindWA !== bindWB,
            `the binding fit axis did not flip between 1:1 and 32:9 on a ${panel.toFixed(2)}:1 panel`,
          );
        }

        // ---- undo x2 restores BOTH the model and the rendered letterbox
        undoStep();
        undoStep();
        engine.refresh();
        assert(
          tl().width === w0 && tl().height === h0,
          `undo x2 restored ${tl().width}x${tl().height}, expected ${w0}x${h0}`,
        );
        const rZ = await waitFor(
          () => {
            const r = canvas!.getBoundingClientRect();
            return Math.abs(r.width - r0.width) < 1.5 && Math.abs(r.height - r0.height) < 1.5
              ? r
              : null;
          },
          3000,
          `.preview__canvas to refit back to ${r0.width.toFixed(0)}x${r0.height.toFixed(0)}`,
        );
        assert(
          Math.abs(rZ.width / rZ.height - a0) < 0.02,
          `restored aspect ${(rZ.width / rZ.height).toFixed(3)} vs ${a0.toFixed(3)}`,
        );
        return `${w0}x${h0} → 1080x1080 (${rA.width.toFixed(0)}x${rA.height.toFixed(0)}, ${barA}) → 2560x720 (${rB.width.toFixed(0)}x${rB.height.toFixed(0)}, ${barB}) → undo x2 back to ${rZ.width.toFixed(0)}x${rZ.height.toFixed(0)}`;
      } finally {
        while (steps > 0) undoStep();
        engine.refresh();
      }
    });

    await test("v06-file-roundtrip", async () => {
      // Build a full v0.6 project in memory (never touches the live session):
      // marker + paired position keyframes + opacity keyframe + both generator
      // kinds. Save through the real IPC path, reload, and assert nothing was
      // dropped and generated media is not reported "missing" (relink bait).
      const rtPath = await ipc.newProjectPath("Autotest RT");
      let rt = createProject("Autotest RT");
      const src = await ipc.probeMedia(`${fixturesDir}\\counter_h264.mp4`);
      rt = importMediaAsClip(rt, src).project;
      const rtClip = rt.timeline.tracks[0]!.clips[0]!.id;
      rt = addMarkerAt(rt, 2.5, 4).project;
      rt = setPositionKeyframes(rt, rtClip, 0, 0, 0);
      rt = setPositionKeyframes(rt, rtClip, 2, 150, -80);
      rt = setKeyframe(rt, rtClip, "opacity", 1, 0.3);
      rt = addGeneratedMedia(rt, { type: "solid", color: "#00ff00" }, 320, 240, "Solid #00ff00")
        .project;
      rt = addGeneratedMedia(
        rt,
        { type: "text", text: "RT", fontFamily: "Georgia", sizePx: 72, color: "#ffffff", bold: true, italic: false },
        200,
        80,
        "Text: RT",
      ).project;
      await ipc.saveProject(rtPath, rt);

      const loaded = await ipc.loadProject(rtPath);
      const lt = loaded.project.timeline;
      const mk = lt.markers ?? [];
      assert(
        mk.length === 1 && Math.abs(mk[0]!.t - 2.5) < 1e-9 && mk[0]!.color === 4,
        `markers lost: ${JSON.stringify(lt.markers)}`,
      );
      const kf = lt.tracks[0]!.clips[0]!.keyframes;
      const kfx = kf?.x ?? [];
      const kfy = kf?.y ?? [];
      assert(
        kfx.length === 2 && kfy.length === 2 && kf?.opacity?.length === 1,
        `keyframes lost: ${JSON.stringify(kf)}`,
      );
      assert(
        Math.abs(kfx[1]!.v - 150) < 1e-9 && Math.abs(kfy[1]!.v + 80) < 1e-9,
        `keyframe values wrong: ${JSON.stringify(kfx)} ${JSON.stringify(kfy)}`,
      );
      const gens = loaded.project.media.filter((m) => m.generator);
      assert(gens.length === 2, `generators lost: ${gens.length} of 2`);
      const txt = gens.find((m) => m.generator!.type === "text");
      assert(
        txt !== undefined && txt.generator!.type === "text" && txt.generator!.text === "RT",
        "text generator fields lost",
      );
      assert(
        !loaded.missing.some((id) => gens.some((g) => g.id === id)),
        `generator flagged missing: ${JSON.stringify(loaded.missing)}`,
      );
      return "marker+kf(x,y,opacity)+2 generators survive save→load; generators not 'missing'";
    });

    await test("modal-above-overlay", async () => {
      // Regression: the canvas-manipulation .stage-overlay (z var(--z-stage-overlay))
      // must NOT hit-test above a modal rendered over the preview. Open a real
      // .modal-backdrop and probe the OVERLAY's own center: the full-screen
      // backdrop (or the modal panel, depending on window geometry) must win
      // that hit-test regardless of where the panel happens to sit.
      const overlay = document.querySelector<HTMLElement>(".stage-overlay");
      assert(overlay !== null, "no .stage-overlay mounted");
      assert(
        document.querySelector(".modal-backdrop") === null,
        "a modal was already open before the test",
      );

      openGeneratorDialog("solid", { session, media });
      const backdrop = await waitFor(
        () => document.querySelector<HTMLElement>(".modal-backdrop"),
        2000,
        "solid dialog modal-backdrop",
      );
      try {
        const ob = overlay!.getBoundingClientRect();
        const px = ob.left + ob.width / 2;
        const py = ob.top + ob.height / 2;
        const hit = document.elementFromPoint(px, py);
        assert(hit !== null, "elementFromPoint returned null");
        assert(
          !overlay!.contains(hit) && hit !== overlay,
          `.stage-overlay intercepts the modal layer (hit=${(hit as HTMLElement).className})`,
        );
        assert(
          hit === backdrop || backdrop.contains(hit),
          `hit at overlay center is not the modal layer (hit=${(hit as HTMLElement).className})`,
        );

        // a real click on the Cancel button must close the dialog
        const cancel = Array.from(backdrop.querySelectorAll<HTMLButtonElement>("button")).find(
          (b) => b.textContent?.trim() === "Cancel",
        );
        assert(cancel !== undefined, "no Cancel button in the modal");
        cancel!.click();
        await waitFor(
          () => document.querySelector(".modal-backdrop") === null,
          2000,
          "modal to close after Cancel click",
        );
      } finally {
        // Never leak an open dialog into later tests: its document-capture
        // Escape handler would swallow keys meant for the canvas overlay.
        // [data-close] routes through the dialog's close() (removes listeners).
        document
          .querySelector<HTMLButtonElement>(".modal-backdrop [data-close]")
          ?.click();
      }
      // generated media stores its label in `path`; Cancel must add nothing
      assert(session.project.media.every((m) => m.path !== "Solid #000000"), "Cancel added media");
      return "modal layer wins the hit-test over the stage overlay; real Cancel click closes it";
    });

    await test("canvas-overlay-drag", async () => {
      const overlay = document.querySelector<HTMLElement>(".stage-overlay");
      assert(overlay !== null, "no .stage-overlay mounted");
      // put the playhead inside the base clip on tracks[0]
      engine.seek(3);
      await sleep(150);
      const clip0 = () => session.project.timeline.tracks[0]!.clips[0]!;
      const x0 = clip0().transform!.x;
      const canvas = overlay!.parentElement as HTMLElement; // .preview__canvas
      const box = canvas.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const projW = session.project.timeline.width;
      const clientDx = 80; // px on screen
      const projDx = (clientDx * projW) / box.width; // project-space px dragged
      const ev = (type: string, x: number, y: number) =>
        overlay!.dispatchEvent(
          new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true }),
        );
      ev("pointerdown", cx, cy);
      ev("pointermove", cx + clientDx / 2, cy);
      ev("pointermove", cx + clientDx, cy);
      ev("pointerup", cx + clientDx, cy);
      const x1 = clip0().transform!.x;
      assert(
        Math.abs(x1 - x0 - projDx) < 1.5,
        `x moved ${(x1 - x0).toFixed(2)}, expected ~${projDx.toFixed(2)}`,
      );
      // exactly one history entry: one undo restores the original x
      assert(session.history.canUndo, "expected a history entry from the drag");
      session.undo();
      const x2 = clip0().transform!.x;
      assert(Math.abs(x2 - x0) < 1e-6, `undo did not restore x: ${x2} vs ${x0}`);
      engine.refresh();
      return `drag ${projDx.toFixed(1)}px = 1 history entry, undo restores`;
    });

    await test("crop-mode-cycle", async () => {
      const overlay = document.querySelector<HTMLElement>(".stage-overlay")!;
      engine.seek(3);
      await sleep(120);
      engine.play();
      await sleep(200);
      const canvas = overlay.parentElement as HTMLElement;
      const box = canvas.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      overlay.dispatchEvent(new MouseEvent("dblclick", { clientX: cx, clientY: cy, bubbles: true }));
      await sleep(50);
      assert(
        document.querySelector(".crop-ghost.stage-overlay__ghost") !== null &&
          getComputedStyle(document.querySelector(".stage-overlay__ghost")!).display !== "none",
        "crop ghost not shown",
      );
      assert(!engine.playing, "entering crop mode should pause playback");
      // crop mode is modal: a Space keydown on the focused overlay must be
      // swallowed (stopPropagation) so the global play shortcut can't resume
      // playback behind the frozen crop chrome. Simulate that global handler on
      // the window bubble phase and assert it never fires.
      let globalSawSpace = false;
      const spy = (ev: KeyboardEvent): void => { if (ev.key === " ") globalSawSpace = true; };
      window.addEventListener("keydown", spy);
      overlay.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      window.removeEventListener("keydown", spy);
      await sleep(30);
      assert(!globalSawSpace, "Space leaked to window during crop mode (not swallowed)");
      assert(!engine.playing, "Space during crop mode must not resume playback");
      // Escape exits — chrome gone
      overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(50);
      assert(
        getComputedStyle(document.querySelector(".stage-overlay__window")!).display === "none",
        "crop window still visible after Escape",
      );
      return "dblclick → ghost + paused; Escape → chrome gone";
    });

    await test("timeline-canvas-painted", () => {
      const canvas = document.querySelector<HTMLCanvasElement>(".timeline-canvas");
      assert(canvas !== null, "timeline canvas missing");
      const ctx = canvas!.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas!.width, Math.min(canvas!.height, 300));
      const first = [data[0], data[1], data[2]];
      let diff = 0;
      for (let i = 0; i < data.length; i += 16) {
        if (
          Math.abs(data[i]! - first[0]!) > 12 ||
          Math.abs(data[i + 1]! - first[1]!) > 12 ||
          Math.abs(data[i + 2]! - first[2]!) > 12
        ) {
          diff++;
        }
      }
      assert(diff > 500, `canvas looks blank (diff=${diff})`);
      return `canvas has content (diff=${diff})`;
    });

    // Full-stack export: spec → Rust builder → ffmpeg → probe the output.
    await test("export-e2e", async () => {
      const { startExport } = await import("../editor/export/export-ipc");
      const { onJobEvents } = await import("../core/ipc");
      const project = session.project;
      const outPath = `${fixturesDir}\\..\\autotest-export.mp4`;
      const spec = {
        media: project.media,
        timeline: project.timeline,
        preset: {
          format: "mp4" as const,
          vcodec: "h264" as const,
          resolution: { w: 640, h: 360 },
          fps: 30,
          videoBitrate: "auto" as const,
          audioBitrate: "auto" as const,
          useHardware: false,
        },
        outPath,
      };
      const jobId = await startExport(spec);
      const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        let un: () => void = () => {};
        const timer = setTimeout(() => {
          un();
          resolve({ ok: false, detail: "export timed out after 60s" });
        }, 60_000);
        void onJobEvents({
          onDone: (e) => {
            if (e.id !== jobId) return;
            clearTimeout(timer);
            un();
            resolve({ ok: true, detail: String(e.output.path ?? outPath) });
          },
          onFailed: (e) => {
            if (e.id !== jobId) return;
            clearTimeout(timer);
            un();
            resolve({ ok: false, detail: `${e.message} | ${e.logTail.slice(-3).join(" / ")}` });
          },
        }).then((u) => (un = u));
      });
      assert(result.ok, result.detail);
      const info = await ipc.probeMedia(result.detail);
      assert(info.vcodec === "h264", `vcodec=${info.vcodec}`);
      assert(info.width === 640 && info.height === 360, `${info.width}x${info.height}`);
      assert(Math.abs(info.duration - engine.duration()) < 0.6, `duration=${info.duration}`);
      assert(info.hasAudio, "expected audio stream");
      return `exported ${info.width}x${info.height} h264, ${info.duration.toFixed(2)}s, audio ok`;
    });

    // Full-stack v0.6 export: 2 stacked video layers + a windowed top clip with
    // x/opacity keyframes + a text generator → Rust builder → ffmpeg → probe.
    // Exercises overlay stacking, kf_expr (position + alphamerge), drawtext
    // textfile lifecycle, tail-pad.
    await test("export-v06-layers-keyframes-text", async () => {
      const { startExport } = await import("../editor/export/export-ipc");
      const { onJobEvents } = await import("../core/ipc");
      const p = session.project;
      const baseTrack = p.timeline.tracks.find((t) => t.kind === "video")!;
      const baseClip = baseTrack.clips[0];
      assert(!!baseClip, "need at least one base clip");
      // Dimensions come from the REAL measureText path, not a hand-written
      // literal. This fixture used to declare 640x360 — identical to the export
      // resolution below — which is exactly why it never caught GitHub issue #1:
      // the generator's alpha mask and its stream only have to agree when those
      // two numbers coincide, so matching them made a shipped crash invisible.
      // A measured text box will never equal the canvas, which is the point.
      const textGen = {
        type: "text" as const, text: "TAROTING 100%", fontFamily: "Arial" as const,
        sizePx: 96, color: "#ffffff", bold: true, italic: false,
      };
      const textBox = measureText(textGen);
      assert(
        textBox.width !== 640 || textBox.height !== 360,
        `fixture must not coincide with the export resolution (got ${textBox.width}x${textBox.height})`,
      );
      const textMedia = {
        id: "atx_text", path: "Text", size: 0, mtimeMs: 0, kind: "image" as const,
        duration: 0, hasAudio: false, width: textBox.width, height: textBox.height,
        generator: textGen,
      };
      const topClip = {
        id: "atx_top", mediaId: "atx_text", timelineStart: 0,
        srcIn: 0, srcOut: Math.min(2, baseClip!.srcOut - baseClip!.srcIn), speed: 1,
        transform: { rotate: 0 as const, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
        audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
        keyframes: {
          x: [{ t: 0, v: -100 }, { t: 2, v: 100 }],
          opacity: [{ t: 0, v: 0.2 }, { t: 2, v: 1 }],
        },
      };
      const topTrack = { id: "atx_vtop", kind: "video" as const, name: "V2", muted: false, clips: [topClip] };
      // tracks[0] is TOPMOST → unshift the overlay track above the existing prefix.
      const timeline = { ...p.timeline, tracks: [topTrack, ...p.timeline.tracks] };
      const outPath = `${fixturesDir}\\..\\autotest-export-v06.mp4`;
      const spec = {
        media: [...p.media, textMedia], timeline,
        preset: { format: "mp4" as const, vcodec: "h264" as const, resolution: { w: 640, h: 360 },
          fps: 30, videoBitrate: "auto" as const, audioBitrate: "auto" as const, useHardware: false },
        outPath,
      };
      const jobId = await startExport(spec);
      const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        let un: () => void = () => {};
        const timer = setTimeout(() => { un(); resolve({ ok: false, detail: "timeout 60s" }); }, 60_000);
        void onJobEvents({
          onDone: (e) => { if (e.id !== jobId) return; clearTimeout(timer); un();
            resolve({ ok: true, detail: String(e.output.path ?? outPath) }); },
          onFailed: (e) => { if (e.id !== jobId) return; clearTimeout(timer); un();
            resolve({ ok: false, detail: `${e.message} | ${e.logTail.slice(-3).join(" / ")}` }); },
        }).then((u) => (un = u));
      });
      assert(result.ok, result.detail);
      const info = await ipc.probeMedia(result.detail);
      assert(info.vcodec === "h264", `vcodec=${info.vcodec}`);
      assert(info.width === 640 && info.height === 360, `${info.width}x${info.height}`);
      return `v0.6 layered+keyframed+text export ok: ${info.width}x${info.height} ${info.duration.toFixed(2)}s`;
    });

    // The bug report that started v0.7.3 said "(can't copy-past the log :/)" —
    // the reporter could SELECT the failed-export log but had no way to extract
    // it, because the context menu is suppressed outside inputs AND Ctrl+C
    // resolved to the timeline's copy-clip binding. Asserts real rendered
    // behavior per AGENTS.md, then the privacy gate on the generated report
    // (only E2E has real paths to leak).
    await test("error-report", async () => {
      const { buildReport } = await import("../core/diagnostics");
      const openBackdrops = (): number => document.querySelectorAll(".modal-backdrop").length;
      const before = openBackdrops();
      try {
        // Fail fast: an output path in a directory that cannot exist.
        const { startExport } = await import("../editor/export/export-ipc");
        const { onJobEvents } = await import("../core/ipc");
        const bad = `${fixturesDir}\\__nope__\\out.mp4`;
        const p = session.project;
        const jobId = await startExport({
          media: p.media, timeline: p.timeline,
          preset: { format: "mp4" as const, vcodec: "h264" as const,
            resolution: { w: 320, h: 180 }, fps: 30, videoBitrate: "auto" as const,
            audioBitrate: "auto" as const, useHardware: false },
          outPath: bad,
        }).catch(() => null);
        if (jobId !== null) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 20_000);
            void onJobEvents({
              onDone: () => { clearTimeout(t); resolve(); },
              onFailed: () => { clearTimeout(t); resolve(); },
            });
          });
        }

        // A report must be buildable and must not carry identifying data.
        const report = buildReport({
          operation: "Export",
          project: session.project,
          error: { code: "ffmpeg", message: "ffmpeg exited with exit code: 1" },
        } as Parameters<typeof buildReport>[0]);
        assert(report.length > 0, "report is empty");

        const user = (fixturesDir.match(/^[A-Za-z]:\\Users\\([^\\]+)/) ?? [])[1];
        if (user) {
          assert(
            !report.toLowerCase().includes(user.toLowerCase()),
            `report leaked the account name "${user}"`,
          );
        }
        assert(!report.includes(fixturesDir), "report leaked the fixtures directory");
        assert(
          !/machineId|installId|sessionId/i.test(report),
          "report must not carry any correlating identifier",
        );
        return `report ${report.length} chars, no account name / path / id leaked`;
      } finally {
        // Never leak an open dialog into a later block.
        for (const b of Array.from(document.querySelectorAll(".modal-backdrop")).slice(before)) {
          b.remove();
        }
      }
    });

    // LAST block on purpose: it navigates away from the editor, so nothing after
    // it could inherit a different route. Asserts the version is really PAINTED,
    // not just present in the DOM — an empty or zero-box label would be useless.
    //
    // The version lives ONLY in Settings > About now (the home badge is gone),
    // so the expected string has to come from somewhere other than the page:
    // `appVersion()` is the same source Settings renders from, which turns this
    // from "shows a version" into "shows the RIGHT version" — a label stuck on a
    // stale or hardcoded string would still pass a bare semver match.
    await test("settings-version-visible", async () => {
      try {
        const expected = await appVersion();
        // "dev" (outside Tauri) or "unknown" (getVersion threw) mean the version
        // plumbing itself is broken — the label would then agree with a wrong
        // value, so check the source before comparing against it.
        assert(
          /^\d+\.\d+\.\d+/.test(expected),
          `appVersion() did not return a real version: "${expected}"`,
        );

        navigate({ view: "settings" });
        const about = await waitFor(
          () => {
            const el = Array.from(document.querySelectorAll<HTMLElement>(".settings__version"))
              .find((n) => n.textContent && n.textContent.includes(expected));
            return el ?? null;
          },
          10_000,
          "settings About version",
        );
        const shown = about.textContent!.trim();
        assert(
          /^Taroting \d+\.\d+\.\d+/.test(shown),
          `About version looks wrong: "${shown}"`,
        );
        assert(
          about.offsetParent !== null && about.getClientRects().length > 0,
          "About version is in the DOM but not rendered",
        );
        assert(
          getComputedStyle(about).userSelect === "text",
          "About version must be selectable so it can be quoted in a bug report",
        );
        return `"${shown}" matches appVersion() ${expected} in Settings > About`;
      } finally {
        // Leave the app on a neutral route even if an assertion threw, so a
        // failure here cannot park the harness inside Settings.
        navigate({ view: "home" });
      }
    });

    /* ---------------- shared colour measurement ----------------
     *
     * Every theme block below measures with THESE, not with a private copy. A
     * second, slightly different `parse` or `bgUnder` is how two blocks end up
     * disagreeing about the same pixel and one of them quietly stops testing
     * anything — and `bgUnder` in particular is the difference between a real
     * number and a meaningless one, so there is exactly one of it.
     */

    const root = document.documentElement;
    const tok = (name: string): string => getComputedStyle(root).getPropertyValue(name).trim();

    interface Rgba {
      rgb: number[];
      a: number;
    }
    /** A computed custom property comes back as rgb(...) or #rrggbb depending
     *  on how it was written, and a computed color/background-color as
     *  rgb()/rgba() — so everything is compared as parsed channels. */
    const parse = (s: string): Rgba => {
      const t = s.trim();
      if (t.startsWith("#")) {
        const b = t.slice(1);
        const h = b.length === 3 ? b.split("").map((c) => c + c).join("") : b;
        return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
      }
      const n = t.match(/-?[\d.]+/g);
      if (!n || n.length < 3) return { rgb: [0, 0, 0], a: 0 };
      return { rgb: n.slice(0, 3).map(Number), a: n.length > 3 ? Number(n[3]) : 1 };
    };
    const chan = (s: string): number[] => parse(s).rgb;
    /** The real WCAG 2.1 relative luminance, gamma-corrected — NOT a channel
     *  average. An earlier version of this block averaged channels, which
     *  measures nothing: it calls #0000ff and #808080 equally bright. */
    const lum = (c: number[]): number => {
      const f = (v: number): number => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const ratio = (a: number[], b: number[]): number => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    /** Same colour, allowing one channel step for a hex/rgb round trip. Any
     *  contrast clamp moves a colour very much further than that. */
    const same = (got: string, want: string): boolean => {
      const g = chan(got);
      const w = chan(want);
      return g.length === 3 && w.every((c, i) => Math.abs(c - g[i]!) <= 1);
    };
    /** The largest single-channel gap between two colours, in 0..255 steps.
     *  Contrast ratio is the right instrument for ink-on-surface and the wrong
     *  one for "are these two FILLS different": a 15% accent tint over its own
     *  track can be plainly visible and still measure 1.05:1, because the two
     *  differ mostly in hue. This is what "you can see that one is selected"
     *  actually reduces to for a flat fill. */
    const maxDelta = (a: number[], b: number[]): number =>
      Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));
    /** What a run of text is REALLY drawn on: walk up the tree compositing
     *  every translucent layer onto the first opaque one. Reading
     *  background-color off the text element alone returns rgba(0,0,0,0) on
     *  nearly every element in this app and would score a meaningless ratio. */
    const bgUnder = (el: HTMLElement): number[] => {
      const layers: Rgba[] = [];
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const p = parse(getComputedStyle(n).backgroundColor);
        if (p.a <= 0) continue;
        layers.push(p);
        if (p.a >= 0.999) break;
      }
      // Nothing opaque all the way to the root: the canvas underneath is white.
      let out =
        layers.length > 0 && layers[layers.length - 1]!.a >= 0.999
          ? layers.pop()!.rgb
          : [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i]!;
        out = out.map((v, k) => l.rgb[k]! * l.a + v * (1 - l.a));
      }
      return out;
    };

    // Custom theme: assert the tokens the whole app reads ACTUALLY change, not
    // that a setting was stored. A custom theme that persists but never repaints
    // would pass any state-level check while being completely broken.
    //
    // THE CONTRACT THIS PINS — colours are no longer clamped to contrast floors:
    //   1. background / accent / text land VERBATIM, however unreadable. The
    //      user's pick is the user's pick.
    //   2. --on-accent IS the background colour, so the ink on every accent
    //      surface is the user's base colour — the home brand mark above all.
    //   3. The surface ramp is still DERIVED (--bg-panel != --bg-app): "no
    //      clamping" must not have quietly become "no derivation".
    //   4. Settings > Appearance is the escape hatch, so someone who paints the
    //      app invisible can still get back and fix it. It and the colour picker
    //      it opens are the surfaces allowed to disobey the colours — but only
    //      when the colours have actually stopped working.
    //   5. That disobedience is CONDITIONAL (v0.7.5), and narrowly so.
    //      data-rescue-appearance is stamped only when --text-1 — the row
    //      labels, the unselected theme options and the picker's "Reset to
    //      default", i.e. the controls that get you back out — drops under
    //      CARD_RESCUE_RATIO against a surface the card paints it on. Quiet
    //      tiers do not count: a theme whose HINTS are unreadable keeps the
    //      user's colours, which is a cost the owner accepted to stop the card
    //      being rescued on ordinary themes. Both directions are painted and
    //      measured below, because a rescue that fires for everything and a
    //      rescue that fires for nothing pass exactly the same one-directional
    //      test.
    // 1 and 4 are deliberately opposites, and that tension IS the feature — so
    // both halves are asserted here, against the same live document.
    await test("custom-theme-applies", async () => {
      const { NAV_RESCUE_RATIO, settingsStore, updateSettings } = await import("../core/session");
      const before = settingsStore.get();
      assert(
        tok("--accent") !== "" && tok("--bg-app") !== "",
        "theme tokens must resolve before we start",
      );

      /* ---------------- fixtures ---------------- */

      // Nothing like either stock palette, so "it changed" cannot be satisfied
      // by a default leaking through — and TEXT is picked almost on top of the
      // BACKGROUND, which is the exact two-click route to an unreadable app that
      // the old code clamped away. Keeping it verbatim is now the contract.
      const BG = "#241a3d";
      const ACCENT = "#ff5fa2";
      const TEXT = "#3a2f55";
      // Fixture self-check. If someone ever "tidies" TEXT into a readable colour
      // the clamp regression below silently stops testing anything at all.
      const pickRatio = ratio(chan(TEXT), chan(BG));
      assert(
        pickRatio < 2,
        `fixture no longer triggers the old clamp: text is ${pickRatio.toFixed(2)}:1 on the background`,
      );
      // Background == accent == text: the app renders as one flat rectangle.
      // This is the state the Settings escape hatch exists for.
      const PATHO = "#3d1f6e";
      /** Body text on the one card that has to stay usable. WCAG 2.1 AA — below
       *  that, "you can still get back and fix it" is not a true statement. */
      const ESCAPE_FLOOR = 4.5;
      /** An UGLY but genuinely visible text on BG: 2.78:1, a WCAG failure for a
       *  UI component and still perfectly findable. The nav rescue must leave it
       *  completely alone. */
      const UGLY_TEXT = "#6a5f85";
      /** A theme that must keep the user's colours on the APPEARANCE CARD too,
       *  with room to spare: row labels 4.70:1, row hints 2.00:1 — low contrast,
       *  a WCAG failure, and entirely operable.
       *
       *  Kept alongside UGLY_TEXT rather than merged with it because the two
       *  bracket the rule from different distances. This one is comfortable
       *  (3.42:1 at its weakest gated pair); UGLY_TEXT is the uncomfortable one
       *  (2.09:1, hints gone at 1.37:1) that the card is nonetheless required to
       *  leave alone. A rule that only ever saw the comfortable case would not
       *  be pinned anywhere near where it actually sits. */
      const CALM_BG = "#3b3b46";
      const CALM_ACCENT = "#8a8ad0";
      const CALM_TEXT = "#b0b0c0";
      /** What a FIRED rescue has to deliver. The trigger is much lower (see
       *  NAV_RESCUE_RATIO — "you cannot see it at all"), but once it fires the
       *  gear is drawn from the fixed safe palette and has to be a properly
       *  visible control: WCAG 2.1 SC 1.4.11's UI-component floor. */
      const RESCUED_GEAR_FLOOR = 3;

      /** Open the colour picker on one of the three colour buttons and hand the
       *  popover to `check`.
       *
       *  It is opened by clicking the real button, so the dynamic import, the
       *  anchor wiring and the CSS gate are all exercised the way a user gets
       *  them — the picker is half of the recovery gesture ("Reset to default"
       *  lives in it) and is gated on the same attribute as the card, so a card
       *  that rescues while the popover does not is still a dead end.
       *
       *  Always closed again, through the real Done button, because the popover
       *  installs document-level capture listeners that only its own dismiss path
       *  removes. The bare remove() at the end is a last resort so a broken close
       *  cannot leak a popover into the next block. */
      const withPicker = async (
        role: string,
        check: (cp: HTMLElement) => void,
      ): Promise<void> => {
        const btn = await waitFor(
          () => document.querySelector<HTMLElement>(`#settings-color-${role}`),
          5_000,
          `the ${role} colour button`,
        );
        btn.click();
        try {
          const cp = await waitFor(
            () => document.querySelector<HTMLElement>(".cp"),
            5_000,
            "the colour picker popover",
          );
          // NOT offsetParent, unlike every other element in this block: .cp is
          // position:fixed, for which offsetParent is null even when the popover
          // is perfectly visible. Its own box and what hit-tests at its centre
          // are the honest questions here.
          const box = cp.getBoundingClientRect();
          assert(
            cp.getClientRects().length > 0 && box.width > 0 && box.height > 0,
            "the colour picker is in the DOM but has no box",
          );
          const hit = document.elementFromPoint(
            Math.round(box.left + box.width / 2),
            Math.round(box.top + box.height / 2),
          );
          assert(
            hit !== null && (hit === cp || cp.contains(hit)),
            "the colour picker is rendered but something else hit-tests at its centre",
          );
          check(cp);
        } finally {
          document.querySelector<HTMLElement>(".cp__done")?.click();
          for (let i = 0; i < 20 && document.querySelector(".cp"); i++) await sleep(50);
          document.querySelector(".cp")?.remove();
        }
      };

      /** The Appearance card and the two runs of text whose tiers decide whether
       *  it gets rescued: a row label (--text-1) and a row hint (--text-3, the
       *  faintest tier and the one the trigger is calibrated on). Re-queried on
       *  every use rather than captured once — each updateSettings notifies the
       *  settings store, which rebuilds these nodes underneath. Selected through
       *  `.settings__card--appearance`, the same class the CSS gate keys on. */
      const appearanceCard = async (): Promise<{ label: HTMLElement; hint: HTMLElement }> => {
        const themeOpt = await waitFor(
          () => document.querySelector<HTMLElement>('[data-theme-opt="custom"]'),
          10_000,
          "the theme control",
        );
        const box = themeOpt.closest<HTMLElement>(".settings__card--appearance");
        assert(box !== null, "the theme control must live inside the Appearance card");
        const label = box!.querySelector<HTMLElement>(".settings__row-label");
        const hint = box!.querySelector<HTMLElement>(".settings__hint");
        assert(
          label !== null && hint !== null,
          "the Appearance card must carry a row label and a row hint",
        );
        assert(
          label!.offsetParent !== null && label!.getClientRects().length > 0,
          "the Appearance card's row label is not rendered",
        );
        assert(
          hint!.offsetParent !== null && hint!.getClientRects().length > 0,
          "the Appearance card's row hint is not rendered",
        );
        return { label: label!, hint: hint! };
      };

      try {
        navigate({ view: "settings" });
        const seg = await waitFor(
          () => document.querySelector<HTMLElement>('[data-theme-opt="custom"]'),
          10_000,
          "Custom theme option",
        );
        seg.click();

        // Choosing Custom must expand the card — that is the owner-visible half.
        const area = await waitFor(
          () => document.querySelector<HTMLElement>(".settings__custom"),
          5_000,
          "expanded custom area",
        );
        assert(
          area.offsetParent !== null && area.getClientRects().length > 0,
          "custom area is in the DOM but not rendered",
        );
        assert(
          !!document.querySelector("#settings-color-background") &&
            !!document.querySelector("#settings-color-accent") &&
            !!document.querySelector("#settings-color-text"),
          "custom area must offer background, accent and text",
        );

        /* ---- 1. every pick lands verbatim ---- */

        await updateSettings({
          theme: "custom",
          customTheme: { background: BG, accent: ACCENT, text: TEXT },
        });
        await waitFor(
          () => (same(tok("--accent"), ACCENT) ? true : null),
          5_000,
          "--accent to repaint",
        );
        const accent = tok("--accent");
        const bg = tok("--bg-app");
        const text1 = tok("--text-1");
        assert(same(bg, BG), `--bg-app is not the chosen background: got ${bg}, want ${BG}`);
        assert(
          same(accent, ACCENT),
          `--accent is not the chosen accent: got ${accent}, want ${ACCENT}`,
        );
        // THE regression test for the behaviour change. This pick is ~1.3:1 on
        // its own background and the old code walked it out to 4.5:1. If any
        // form of clamping comes back, this is the assertion that says so.
        assert(
          same(text1, TEXT),
          `--text-1 was rewritten — clamping is back: got ${text1}, want ${TEXT}`,
        );

        /* ---- 2. --on-accent IS the background colour ---- */

        const onAccent = tok("--on-accent");
        assert(onAccent !== "", "--on-accent must always be set");
        assert(
          same(onAccent, BG),
          `--on-accent must be the background colour ${BG} (the brand-mark rule), got ${onAccent}`,
        );

        /* ---- 3. the surface ramp still derives ---- */

        const panel = tok("--bg-panel");
        assert(
          panel !== "" && !same(panel, bg),
          `--bg-panel must still be derived off --bg-app ${bg}, got ${panel}`,
        );

        /* ---- the brand mark, in really painted pixels ---- */

        // The owner asked for this one by name: the "T" is the base colour, its
        // tile is the accent. Assert the RENDERED element and not just the
        // tokens behind it — home.css could stop reading them tomorrow.
        navigate({ view: "home" });
        const mark = await waitFor(
          () => document.querySelector<HTMLElement>(".home__brand-mark"),
          10_000,
          "home brand mark",
        );
        assert(
          mark.offsetParent !== null && mark.getClientRects().length > 0,
          "brand mark is in the DOM but not rendered",
        );
        const markCs = getComputedStyle(mark);
        assert(
          same(markCs.backgroundColor, ACCENT),
          `brand mark tile is ${markCs.backgroundColor}, want the accent ${ACCENT}`,
        );
        assert(
          same(markCs.color, BG),
          `the brand "T" is ${markCs.color}, want the background colour ${BG}`,
        );

        /* ---- 4. the escape hatch ---- */

        await updateSettings({
          theme: "custom",
          customTheme: { background: PATHO, accent: PATHO, text: PATHO },
        });
        // This also proves the theme repaints while ALREADY on custom, which is
        // the harder case — which is why nothing above compares against the
        // pre-test baseline (a previous run's leftovers could equal it).
        await waitFor(
          () => (same(tok("--bg-app"), PATHO) ? true : null),
          5_000,
          "pathological theme to paint",
        );
        assert(
          same(tok("--accent"), PATHO) && same(tok("--text-1"), PATHO),
          `the pathological pick was rewritten: accent ${tok("--accent")}, text ${tok("--text-1")}`,
        );

        navigate({ view: "settings" });
        const opt = await waitFor(
          () => document.querySelector<HTMLElement>('[data-theme-opt="custom"]'),
          10_000,
          "theme control under the pathological theme",
        );
        const card = opt.closest<HTMLElement>(".settings__card, .card");
        assert(card !== null, "the theme control must live inside a Settings card");
        assert(
          card!.offsetParent !== null && card!.getClientRects().length > 0,
          "the Appearance card is in the DOM but not rendered",
        );
        assert(
          opt.offsetParent !== null && opt.getClientRects().length > 0,
          "the theme control is not rendered — there would be no way back",
        );
        const row = await waitFor(
          () => document.querySelector<HTMLElement>("#settings-color-background"),
          5_000,
          "background colour row",
        );
        assert(
          row.offsetParent !== null && row.getClientRects().length > 0,
          "the background colour row is not rendered — the bad colour cannot be changed",
        );

        // The escape hatch is CONDITIONAL since v0.7.5, so the flag is asserted
        // before anything it produces. Under PATHO every tier of this card is
        // collapsed (the weakest measures 1.03:1), so if this attribute is not
        // stamped the card below is being read in the user's own colours and the
        // ratio that follows would be measuring an accident.
        assert(
          root.dataset.rescueAppearance === "1",
          `every tier of the Appearance card is gone under ${PATHO} but data-rescue-appearance was not stamped — there is no way back`,
        );

        // Measured, not assumed. The row label re-resolves `color: var(--text-1)`
        // at its own position in the tree, so a card-scoped override shows up
        // here while the root token stays the user's (unreadable) pick — which
        // is why this reads the label and not the card's inherited colour.
        const label = card!.querySelector<HTMLElement>(".settings__row-label");
        assert(label !== null, "the Appearance card must have a readable row label");
        const labelRatio = ratio(chan(getComputedStyle(label!).color), bgUnder(label!));
        assert(
          labelRatio >= ESCAPE_FLOOR,
          `Appearance card text is only ${labelRatio.toFixed(2)}:1 on its own background — the escape hatch does not work`,
        );
        // …and it really is the fixed palette doing that, not a lucky pick: the
        // ink must be the published --safe-text-1 and not the user's --text-1.
        assert(
          same(getComputedStyle(label!).color, tok("--safe-text-1")) &&
            !same(getComputedStyle(label!).color, PATHO),
          `the rescued label is drawn in ${getComputedStyle(label!).color}, not the escape-hatch ink ${tok("--safe-text-1")}`,
        );
        const optRatio = ratio(chan(getComputedStyle(opt).color), bgUnder(opt));
        const rowRatio = ratio(chan(getComputedStyle(row).color), bgUnder(row));

        // The SELECTED theme option, asserted rather than reported — this is the
        // number that settles what the trigger's segment term should measure.
        //
        // It has TWO legitimate painted states, and which one this reads depends
        // on where the pointer happens to be sitting, which the harness does not
        // control (it clicks by dispatching events, it never moves the mouse).
        // At rest the option sits on the segmented control's BARE track:
        // `.settings__segmented .btn { background: transparent }` is two classes
        // to `.btn--on`'s one, so no --accent-dim fill lands. Under the pointer
        // it does land, because `.settings__segmented .btn--on:hover` ties
        // `.settings__segmented .btn:hover` at (0,3,0) and wins on source order.
        // The two differ by about a ratio point.
        //
        // So both predictions are computed and the measurement has to match ONE
        // of them. Matching neither means the ink or the surface is something
        // this model does not know about — and needsAppearanceRescue takes the
        // minimum of exactly these two, so a surface it does not know about is a
        // trigger measuring the wrong thing. Derived from the live tokens rather
        // than hardcoded, so a palette retune moves prediction and measurement
        // together.
        const dim = parse(tok("--safe-accent-dim"));
        const track = chan(tok("--safe-input"));
        const hoveredFill = track.map((v2, i) => dim.rgb[i]! * dim.a + v2 * (1 - dim.a));
        const segAtRest = ratio(chan(tok("--safe-accent-strong")), track);
        const segHovered = ratio(chan(tok("--safe-accent-strong")), hoveredFill);
        const segState =
          Math.abs(optRatio - segAtRest) < 0.05
            ? "at rest"
            : Math.abs(optRatio - segHovered) < 0.05
              ? "hovered"
              : "neither";
        assert(
          segState !== "neither",
          `the selected theme option measures ${optRatio.toFixed(2)}:1, which is neither its resting track (${segAtRest.toFixed(2)}:1) nor its hovered fill (${segHovered.toFixed(2)}:1) — the segmented control's cascade changed, and the rescue trigger measures the wrong surface now`,
        );
        // Whichever state it is in, it has to be a control the user can read:
        // the whole point of the segment tier is "which theme is active".
        assert(
          optRatio >= ESCAPE_FLOOR,
          `the selected theme option is only ${optRatio.toFixed(2)}:1 — the user cannot see which theme is active`,
        );

        // The second half of the same gesture. A readable card that opens an
        // unreadable "Reset to default" is the same dead end, and the popover is
        // a separate selector under the same flag — so it is opened for real and
        // measured, rather than assumed to follow.
        let resetRatio = 0;
        await withPicker("background", (cp) => {
          const cpBg = getComputedStyle(cp).backgroundColor;
          assert(
            same(cpBg, tok("--safe-raised")),
            `the picker popover is painted ${cpBg}, not the escape-hatch surface ${tok("--safe-raised")}`,
          );
          assert(
            !same(cpBg, tok("--bg-raised")),
            `the picker popover is still on the user's own surface ${tok("--bg-raised")} under ${PATHO}`,
          );
          const reset = cp.querySelector<HTMLElement>(".cp__reset");
          assert(reset !== null, 'the picker must offer "Reset to default"');
          assert(
            reset!.getClientRects().length > 0,
            '"Reset to default" is in the DOM but not rendered',
          );
          resetRatio = ratio(chan(getComputedStyle(reset!).color), bgUnder(reset!));
          assert(
            resetRatio >= ESCAPE_FLOOR,
            `"Reset to default" is only ${resetRatio.toFixed(2)}:1 on the popover — the last way back is unreadable`,
          );
        });

        /* ---- 5. the way IN to that card ---- */

        // A readable Appearance card is worth nothing if the control that
        // reaches it is invisible, and on home that control is one ghost icon
        // button whose only ink is a 1.33 px --text-1 stroke on --bg-app. Under
        // PATHO (still active) that stroke is the background, so the rescue has
        // to have fired. Asserted on the PAINTED result: what actually hit-tests
        // at the button's centre, and the ratio of the ink really being drawn
        // against the surface really behind it — a `display` check would have
        // passed here even when the theme erased the thing.
        navigate({ view: "home" });
        const gear = await waitFor(
          () => document.querySelector<HTMLElement>("#home-settings"),
          10_000,
          "home Settings gear under the pathological theme",
        );
        assert(
          root.dataset.rescueNav === "1",
          `the gear is invisible under ${PATHO} but data-rescue-nav was not stamped`,
        );
        assert(
          gear.offsetParent !== null && gear.getClientRects().length > 0,
          "the Settings gear is in the DOM but not rendered — there is no way into Settings",
        );
        /** Whatever the compositor says is on top at the middle of the button.
         *  The icon <svg> is a legitimate answer (only the transport and theater
         *  bars make their glyphs pointer-transparent); anything OUTSIDE the
         *  button is not — that would be a click landing somewhere else. */
        const hitsGear = (): boolean => {
          const r = gear.getBoundingClientRect();
          const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + r.height / 2),
          );
          return hit !== null && (hit === gear || gear.contains(hit));
        };
        assert(hitsGear(), "the Settings gear is rendered but not hit-testable at its own centre");
        const gearRatio = ratio(chan(getComputedStyle(gear).color), bgUnder(gear));
        assert(
          gearRatio >= RESCUED_GEAR_FLOOR,
          `the rescued gear is only ${gearRatio.toFixed(2)}:1 on what is behind it — it is not a visible control`,
        );

        // …and the other direction, which is the harder promise: an ugly,
        // WCAG-failing, but VISIBLE theme must be left exactly as picked. If
        // this ever fires the feature has become contrast clamping.
        await updateSettings({
          theme: "custom",
          customTheme: { background: BG, accent: ACCENT, text: UGLY_TEXT },
        });
        await waitFor(
          () => (same(tok("--text-1"), UGLY_TEXT) ? true : null),
          5_000,
          "the ugly-but-visible theme to paint",
        );
        const uglyRatio = ratio(chan(UGLY_TEXT), chan(BG));
        assert(
          uglyRatio > NAV_RESCUE_RATIO && uglyRatio < RESCUED_GEAR_FLOOR,
          `fixture no longer tests anything: ${uglyRatio.toFixed(2)}:1 is not "ugly but visible"`,
        );
        assert(
          root.dataset.rescueNav === undefined,
          `the gear is visible at ${uglyRatio.toFixed(2)}:1 and was restyled anyway — that is clamping`,
        );
        assert(
          same(getComputedStyle(gear).color, UGLY_TEXT),
          `the gear is drawn in ${getComputedStyle(gear).color}, not the user's own text colour ${UGLY_TEXT}`,
        );
        assert(hitsGear(), "the Settings gear stopped hit-testing under a normal custom theme");

        /* ---- 6. the card keeps the user's colours unless it is truly gone ---- */

        // THE ACCEPTED TRADE, in painted pixels. #6a5f85 used to be the case
        // that PROVED the card rescue was its own decision: 2.78:1 on --bg-app
        // so the gear was left alone, 1.37:1 on the card's hint tier so the card
        // was rescued. The owner reversed that. The card is now gated on
        // --text-1 only — the row labels, the unselected theme options and the
        // picker's "Reset to default", i.e. exactly the controls that get you
        // back out — so a theme whose HINTS have gone keeps the user's colours.
        //
        // The cost is asserted rather than glossed: the label here is genuinely
        // below the body-text bar, and the hint below it is worse. What has to
        // hold is that the route out still clears the trigger.
        assert(
          root.dataset.rescueAppearance === undefined,
          `the card was rescued at ${UGLY_TEXT}, whose labels read at 2.62:1 — the gate has been widened back past --text-1 and the over-fire is back`,
        );
        navigate({ view: "settings" });
        const uglyCard = await appearanceCard();
        assert(
          same(getComputedStyle(uglyCard.label).color, UGLY_TEXT),
          `the card's label is ${getComputedStyle(uglyCard.label).color}, not the user's own ${UGLY_TEXT}`,
        );
        const uglyCardRatio = ratio(
          chan(getComputedStyle(uglyCard.label).color),
          bgUnder(uglyCard.label),
        );
        const uglyHintRatio = ratio(
          chan(getComputedStyle(uglyCard.hint).color),
          bgUnder(uglyCard.hint),
        );
        // Fixture self-check AND the statement of the trade: the label is under
        // the escape floor and still well clear of the trigger, and the hint is
        // worse than the label. If the label ever climbs past 4.5 this theme has
        // stopped being the uncomfortable case it is kept for.
        assert(
          uglyCardRatio < ESCAPE_FLOOR && uglyCardRatio > NAV_RESCUE_RATIO,
          `fixture drifted: the card's label is ${uglyCardRatio.toFixed(2)}:1, no longer "poor but a working way out"`,
        );
        assert(
          uglyHintRatio < uglyCardRatio,
          `the hint (${uglyHintRatio.toFixed(2)}:1) should be fainter than the label (${uglyCardRatio.toFixed(2)}:1)`,
        );
        // The control that actually undoes the theme, on the surface it is
        // really painted on. Deliberately the UNSELECTED "Dark" option and not
        // the selected one: clicking it is the escape, its ink is --text-1 on
        // the segmented track, and that pair is in the gate. (The SELECTED
        // option is --accent-strong and is no longer gated at all — losing it
        // costs you the marker saying which theme is live, not the way out.)
        // Re-queried rather than reusing the reference from section 4, which
        // several re-renders ago stopped being attached to this document.
        const escapeOpt = await waitFor(
          () => document.querySelector<HTMLElement>('[data-theme-opt="dark"]'),
          5_000,
          "the Dark theme option",
        );
        assert(
          escapeOpt.offsetParent !== null && escapeOpt.getClientRects().length > 0,
          "the Dark option is not rendered — there is no way to undo the theme",
        );
        const escapeRatio = ratio(chan(getComputedStyle(escapeOpt).color), bgUnder(escapeOpt));
        assert(
          escapeRatio > NAV_RESCUE_RATIO,
          `the way out reads ${escapeRatio.toFixed(2)}:1 under ${UGLY_TEXT} and the card was not rescued`,
        );

        // …and the other direction for the CARD, which is the promise this
        // release actually added: a theme whose faintest tier is merely poor
        // keeps the user's own colours on the one screen they were chosen from.
        // Before v0.7.5 this card was rescued unconditionally, so a permanently
        // mismatched panel sat in the middle of an app somebody had deliberately
        // coloured. If this half ever fires, that is back.
        await updateSettings({
          theme: "custom",
          customTheme: { background: CALM_BG, accent: CALM_ACCENT, text: CALM_TEXT },
        });
        await waitFor(
          () => (same(tok("--text-1"), CALM_TEXT) ? true : null),
          5_000,
          "the ugly-but-usable theme to paint",
        );
        const calm = await appearanceCard();
        assert(
          root.dataset.rescueAppearance === undefined,
          "the Appearance card was overridden for a theme it can be read in — that is clamping",
        );
        assert(
          root.dataset.rescueNav === undefined && root.dataset.rescueChrome === undefined,
          "a readable theme stamped a nav rescue",
        );
        // The card is really in the user's ink, not merely un-stamped: the row
        // label must compute to the exact pick, and NOT to the safe palette's
        // --safe-text-1, which is still published on the root the whole time.
        const calmLabelColor = getComputedStyle(calm.label).color;
        assert(
          same(calmLabelColor, CALM_TEXT),
          `the card's label is ${calmLabelColor}, not the user's own text colour ${CALM_TEXT}`,
        );
        assert(
          !same(calmLabelColor, tok("--safe-text-1")),
          `the card is still painted from the escape-hatch palette ${tok("--safe-text-1")}`,
        );
        const calmLabelRatio = ratio(chan(calmLabelColor), bgUnder(calm.label));
        const calmHintRatio = ratio(chan(getComputedStyle(calm.hint).color), bgUnder(calm.hint));
        // Fixture self-check, on the painted pixels rather than on the hex: the
        // label has to be comfortably readable and the HINT has to be genuinely
        // poor — a WCAG failure that is still above the trigger. If either drifts
        // this case stops being "ugly but usable" and stops testing anything.
        assert(
          calmLabelRatio > 4 && calmLabelRatio < 6,
          `fixture drifted: the card's label is ${calmLabelRatio.toFixed(2)}:1, not the ~4.7:1 this case is about`,
        );
        assert(
          calmHintRatio > NAV_RESCUE_RATIO && calmHintRatio < 3,
          `fixture drifted: the card's hint is ${calmHintRatio.toFixed(2)}:1, which is no longer "poor but above the line"`,
        );
        // The picker follows the same flag in this direction too — it is a
        // separate selector, so "the card kept the user's colours" says nothing
        // about the popover until the popover is opened and measured.
        await withPicker("text", (cp) => {
          const cpBg = getComputedStyle(cp).backgroundColor;
          assert(
            same(cpBg, tok("--bg-raised")),
            `the picker is painted ${cpBg}, not the user's own surface ${tok("--bg-raised")}`,
          );
          assert(
            !same(cpBg, tok("--safe-raised")),
            `the picker fell back to the escape-hatch surface ${tok("--safe-raised")} for a readable theme`,
          );
        });

        return `verbatim bg ${bg} / accent ${accent} / text ${text1} (${pickRatio.toFixed(2)}:1, unclamped), on-accent ${onAccent} == bg, panel ${panel} derived; card rescue fired on ${PATHO}: label ${labelRatio.toFixed(2)}:1 (theme btn ${optRatio.toFixed(2)}:1 ${segState}, predicted ${segAtRest.toFixed(2)}:1 at rest / ${segHovered.toFixed(2)}:1 hovered; colour btn ${rowRatio.toFixed(2)}:1), picker Reset ${resetRatio.toFixed(2)}:1; nav rescue fired on ${PATHO}: gear hit-tests at ${gearRatio.toFixed(2)}:1, and stayed OFF at ${uglyRatio.toFixed(2)}:1; BOTH flags stayed off on ${UGLY_TEXT} too — card in the user's own ink at label ${uglyCardRatio.toFixed(2)}:1 / hint ${uglyHintRatio.toFixed(2)}:1, way out ${escapeRatio.toFixed(2)}:1 (the accepted trade: hints unreadable, escape intact) — and on ${CALM_TEXT}: label ${calmLabelRatio.toFixed(2)}:1, hint ${calmHintRatio.toFixed(2)}:1`;
      } finally {
        // Never leak an open colour picker into a later block: it holds
        // document-level capture listeners for pointerdown and Escape, and a
        // dismiss firing later would commit a colour long after this block
        // finished. Closed through its own Done button so those listeners are
        // really released — the remove() only catches a popover that arrived
        // after the wait for it had already given up.
        for (const cp of Array.from(document.querySelectorAll<HTMLElement>(".cp"))) {
          cp.querySelector<HTMLElement>(".cp__done")?.click();
          cp.remove();
        }
        // Never leave the owner's real theme changed by a test run — and nothing
        // clamps any more, so a leaked pathological theme would leave the app
        // genuinely unusable. The repaint inside updateSettings is synchronous;
        // the await is only so the restore is the LAST write to settings.json.
        try {
          await updateSettings({ theme: before.theme, customTheme: before.customTheme });
        } catch {
          // The repaint already happened. A failed disk write must not mask the
          // assertion failure that sent us here.
        }
        navigate({ view: "home" });
      }
    });

    /* ---------------- settings across a navigation round trip ----------------
     *
     * WHY THIS EXISTS, and what it is for. The owner set a custom theme, went
     * home, came back to Settings, and the colour swatches were EMPTY — the hex
     * captions beside them still correct. Reported twice. 708 TS tests, 173 Rust
     * tests and thirty E2E blocks saw none of it, and the reason is exactly one
     * gap: not one of them ever left the Settings screen and came back.
     * `custom-theme-applies` above sets a theme and measures what it paints, but
     * it measures the screen it is standing on. Nothing anywhere asserted that
     * what is RENDERED after a re-mount still equals what is STORED.
     *
     * So the two blocks below do only that, and they compare three things that
     * have to agree WITH EACH OTHER rather than each with a constant:
     *
     *   swatch   the COMPUTED background-color of .settings__color-swatch.
     *            Deliberately not the style attribute (that is the string we
     *            wrote, which reads perfectly on a swatch the compositor is
     *            drawing nothing for) and not innerHTML (that is markup, not
     *            paint). The reported symptom is rgba(0, 0, 0, 0) here.
     *   caption  the .mono hex beside it — which in the report was RIGHT, which
     *            is precisely why a one-sided assertion would have shipped past
     *            this bug without a murmur.
     *   store    settingsStore.get().customTheme, what the app believes.
     *
     * …plus a fourth read that is not in the DOM at all: settings.json, through
     * the same ipc the app uses. A theme that repaints and is never written is
     * the other half of what the owner described, and it is invisible until the
     * next launch.
     *
     * WHAT THESE BLOCKS CANNOT DO, stated up front so nobody trusts them for it.
     * The original fault was Tauri's CSP refusing the swatch's inline `style`
     * ATTRIBUTE in a PACKAGED build — see the long note above `colorRow` in
     * settings/settings.ts. This harness runs against Vite's dev server, which
     * Tauri never rewrites, so an inline style attribute is honoured here and the
     * original defect is not reproducible in the E2E at all, by these blocks or
     * by any others. That invariant ("no colour reaches a swatch through the
     * markup") is a property of the emitted string and belongs in a unit test
     * against the now-exported, pure `colorRow`.
     *
     * What IS pinned here is the shape the fix left behind, which is the part
     * that regresses in dev exactly as it would in a shipped build: the swatch is
     * emitted empty and filled from the store on EVERY render, so dropping that
     * repaint — the single most likely way this bug comes back — leaves an empty
     * swatch beside a correct caption in dev too, and section 4 below proves that
     * is what these assertions go red on.
     */

    const THEME_ROLES = ["background", "accent", "text"] as const;
    type ThemeRole = (typeof THEME_ROLES)[number];

    /** The picks both round-trip blocks use.
     *
     *  A plum background, a mint accent and a cream text: pairwise MILES apart
     *  in every channel, and that is the whole point. If any two coincided, a
     *  swatch painted from the wrong role would still look correct — this
     *  project's documented way of making a bug invisible — so the fixture
     *  self-check below refuses to let anyone quietly tidy them together.
     *
     *  (Nothing here needs to be checked against DEFAULT_CUSTOM_THEME: `same`
     *  allows one channel step, so a default leaking through already fails the
     *  exact-match assertions. What those CANNOT catch is one role standing in
     *  for another, which is what the pairwise check covers.)
     *
     *  Chosen so no rescue flag fires — see the assertions in
     *  `checkSelectedSegment` — because a rescued Appearance card is painted
     *  from the fixed --safe-* palette, and every prediction below is read off
     *  the user's own tokens. */
    const TRIP: Record<ThemeRole, string> = {
      background: "#2a1420",
      accent: "#4fd6a8",
      text: "#f0e3c8",
    };

    /** One channel step: a hex/rgb round trip, and nothing else. */
    const SEG_SAME = 1;
    /** How far apart the selected segment's fill and an unselected one have to
     *  be before the control is telling the user anything. TRIP measures ~28
     *  steps at rest and ~21 under the pointer, so this is a floor with real
     *  room under it rather than a restatement of the measurement. */
    const SEG_FILL_MIN_DELTA = 10;

    const need = <T extends HTMLElement>(sel: string): T => {
      const el = document.querySelector<T>(sel);
      assert(el !== null, `expected ${sel} to be in the document and it is not`);
      return el!;
    };

    /** The three-way agreement, on whatever Settings is showing RIGHT NOW.
     *  Everything is re-queried, never captured: each settings write notifies
     *  the store, which rebuilds these nodes underneath. Throws on the first
     *  disagreement; returns what it measured so the report carries the values
     *  and not the word "ok". */
    const checkRows = (
      want: Record<ThemeRole, string>,
      stored: Record<ThemeRole, string>,
      where: string,
    ): string => {
      const parts: string[] = [];
      for (const role of THEME_ROLES) {
        const btn = document.querySelector<HTMLElement>(`#settings-color-${role}`);
        assert(btn !== null, `${where}: the ${role} colour row is not in the DOM at all`);
        assert(
          btn!.offsetParent !== null && btn!.getClientRects().length > 0,
          `${where}: the ${role} colour row is in the DOM but not rendered`,
        );
        const swatch = btn!.querySelector<HTMLElement>(".settings__color-swatch");
        const caption = btn!.querySelector<HTMLElement>(".mono");
        assert(
          swatch !== null && caption !== null,
          `${where}: the ${role} row lost its swatch or its hex caption`,
        );
        const box = swatch!.getBoundingClientRect();
        assert(
          swatch!.offsetParent !== null && box.width > 0 && box.height > 0,
          `${where}: the ${role} swatch has no box — there is nothing to paint`,
        );
        const painted = getComputedStyle(swatch!).backgroundColor;
        const alpha = parse(painted).a;
        // THE REPORTED SYMPTOM, called by its name so the report says it.
        assert(
          alpha >= 0.999,
          `${where}: the ${role} swatch is EMPTY — its computed background-color is ${painted}. This is the bug that was reported twice.`,
        );
        assert(
          same(painted, want[role]),
          `${where}: the ${role} swatch is painted ${painted}, not the pick ${want[role]}`,
        );
        const shown = (caption!.textContent ?? "").trim().toLowerCase();
        assert(
          shown === want[role],
          `${where}: the ${role} caption reads "${shown}", not the pick ${want[role]}`,
        );
        const held = (stored[role] ?? "").trim().toLowerCase();
        assert(
          held === want[role],
          `${where}: the store holds ${role} ${held || "(nothing)"}, not the pick ${want[role]}`,
        );
        // …and now the three against EACH OTHER. The reported state is a right
        // caption beside a wrong swatch, so agreeing with a constant is not the
        // same question and would not have caught it.
        assert(
          same(painted, shown) && shown === held,
          `${where}: the ${role} row disagrees with itself — swatch ${painted}, caption ${shown}, store ${held}`,
        );
        // The fourth copy of the same value, and the only one a screen-reader
        // user gets: the swatch is decorative to them, the label is the colour.
        const aria = (btn!.getAttribute("aria-label") ?? "").toLowerCase();
        assert(
          aria.includes(want[role]),
          `${where}: the ${role} button's accessible name is "${aria}", which never mentions ${want[role]}`,
        );
        // Really on screen and really on top. A swatch sitting behind a sibling
        // measures perfectly and shows the user nothing.
        const hit = document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        );
        assert(
          hit !== null && (hit === swatch! || swatch!.contains(hit) || btn!.contains(hit)),
          `${where}: the ${role} swatch is rendered but something else hit-tests at its centre`,
        );
        parts.push(`${role} ${painted} == ${shown}`);
      }
      return parts.join(", ");
    };

    /** The theme control's SELECTED state, measured rather than assumed.
     *
     *  Under a custom theme the live option is filled with --accent-dim —
     *  `html[data-custom-theme] .settings__segmented .btn--on` in settings.css —
     *  while the unselected ones sit on the bare segmented track. That fill is
     *  the signal that survives an arbitrary accent: the ink alone (
     *  --accent-strong against --text-1) can be almost nothing, and for TRIP it
     *  IS almost nothing, which is asserted below so the fill assertions stay
     *  load-bearing.
     *
     *  DELIBERATELY NOT ASSERTED FOR DARK AND LIGHT. The fill is scoped to
     *  custom themes on purpose — the shipped palettes keep the ink-only
     *  treatment they ship with — so pinning the same thing there would pin the
     *  opposite of what the CSS says. */
    const checkSelectedSegment = (where: string): string => {
      const opts = Array.from(document.querySelectorAll<HTMLElement>("[data-theme-opt]"));
      assert(opts.length >= 2, `${where}: the theme control is not rendered`);
      const on = opts.filter((o) => o.classList.contains("btn--on"));
      assert(
        on.length === 1 && on[0]!.dataset.themeOpt === "custom",
        `${where}: ${on.length} theme options are marked selected (${on.map((o) => String(o.dataset.themeOpt)).join(", ") || "none"}) — expected exactly Custom`,
      );
      const sel = on[0]!;
      assert(
        sel.offsetParent !== null && sel.getClientRects().length > 0,
        `${where}: the selected theme option is in the DOM but not rendered`,
      );
      // The fill only exists while this is stamped, so a lost flag would make
      // every measurement below a measurement of the wrong thing — and the flag
      // is written by applyTheme, which navigation does NOT re-run.
      assert(
        root.dataset.customTheme === "1",
        `${where}: data-custom-theme is not stamped, so the selected option's fill cannot apply at all`,
      );
      // …and every escape hatch must be OFF, or the card is painted from the
      // fixed --safe-* palette while the predictions below are read off the
      // user's own tokens.
      assert(
        root.dataset.rescueAppearance === undefined &&
          root.dataset.rescueNav === undefined &&
          root.dataset.rescueChrome === undefined,
        `${where}: fixture drifted — this theme fired a rescue (appearance ${String(root.dataset.rescueAppearance)}, nav ${String(root.dataset.rescueNav)}, chrome ${String(root.dataset.rescueChrome)}), so the segment is being read in the safe palette and not the user's`,
      );

      const dim = parse(tok("--accent-dim"));
      const trackRest = chan(tok("--bg-input"));
      const trackHover = chan(tok("--bg-hover"));
      const predicted = trackRest.map((v, i) => dim.rgb[i]! * dim.a + v * (1 - dim.a));
      const selFill = bgUnder(sel);
      assert(
        maxDelta(selFill, predicted) <= SEG_SAME,
        `${where}: the selected option is filled ${selFill.map(Math.round).join(",")}, not the --accent-dim over --bg-input this theme predicts (${predicted.map(Math.round).join(",")}) — the html[data-custom-theme] fill is not landing`,
      );
      // Fixture self-check. If --accent-dim's alpha or the accent itself ever
      // drifts toward the track, the separation assertions stop separating.
      const headroom = maxDelta(predicted, trackRest);
      assert(
        headroom >= SEG_FILL_MIN_DELTA * 1.8,
        `fixture drifted: the selected fill is only ${headroom.toFixed(1)} channel steps off the bare track, too near the floor to be a real test`,
      );

      const selInk = getComputedStyle(sel).color;
      assert(
        same(selInk, tok("--accent-strong")),
        `${where}: the selected option's ink is ${selInk}, not --accent-strong ${tok("--accent-strong")}`,
      );
      const states: string[] = [];
      for (const u of opts) {
        if (u === sel) continue;
        assert(
          u.offsetParent !== null && u.getClientRects().length > 0,
          `${where}: the ${String(u.dataset.themeOpt)} option is not rendered`,
        );
        const uFill = bgUnder(u);
        // Two legitimate resting states, exactly as in custom-theme-applies: the
        // harness clicks by dispatching events and never moves the mouse, so
        // whichever option the pointer happens to sit over gets --bg-hover
        // instead of the bare track. (The SELECTED one has no such ambiguity
        // under a custom theme — its at-rest rule and its :hover rule are both
        // --accent-dim.)
        const state =
          maxDelta(uFill, trackRest) <= SEG_SAME
            ? "at rest"
            : maxDelta(uFill, trackHover) <= SEG_SAME
              ? "hovered"
              : "neither";
        assert(
          state !== "neither",
          `${where}: the ${String(u.dataset.themeOpt)} option is filled ${uFill.map(Math.round).join(",")}, which is neither the track (${trackRest.join(",")}) nor its hover shade (${trackHover.join(",")}) — the segmented control's cascade changed`,
        );
        const gap = maxDelta(selFill, uFill);
        assert(
          gap >= SEG_FILL_MIN_DELTA,
          `${where}: the selected option and ${String(u.dataset.themeOpt)} are painted only ${gap.toFixed(1)} channel steps apart (${state}) — the user cannot see which theme is active`,
        );
        assert(
          same(getComputedStyle(u).color, tok("--text-1")),
          `${where}: the unselected ${String(u.dataset.themeOpt)} option's ink is ${getComputedStyle(u).color}, not --text-1 ${tok("--text-1")}`,
        );
        states.push(`${String(u.dataset.themeOpt)} ${gap.toFixed(0)} steps ${state}`);
      }
      // The ink must NOT be what is carrying "selected" here — that is the whole
      // reason the fill rule exists (settings.css: a dull accent draws the live
      // option FAINTER than the ones you can pick). If a future fixture makes
      // the two inks obviously different, everything above stops being
      // load-bearing and this is what says so.
      const inkRatio = ratio(chan(tok("--accent-strong")), chan(tok("--text-1")));
      assert(
        inkRatio < 1.6,
        `fixture drifted: the selected ink and the unselected ink are ${inkRatio.toFixed(2)}:1 apart, so ink alone already says which option is live and the fill is no longer what is under test`,
      );
      // …and it still has to be a control someone can READ: WCAG 2.1 SC 1.4.11's
      // UI-component floor, measured on the fill it is actually drawn on.
      const selReadable = ratio(chan(selInk), selFill);
      assert(
        selReadable >= 3,
        `${where}: the selected option's label is only ${selReadable.toFixed(2)}:1 on its own fill`,
      );
      return `selected fill ${selFill.map(Math.round).join(",")} vs ${states.join(" / ")}; its ink reads ${selReadable.toFixed(2)}:1 on that fill and is only ${inkRatio.toFixed(2)}:1 from the unselected ink, so the fill is the signal`;
    };

    /** PERSISTENCE, not paint. `get_settings` re-reads settings.json from disk
     *  on every call, so this is a genuine file round trip and not the store
     *  wearing a different hat. A write that repainted and never landed looks
     *  identical on screen until the next launch — the other half of what the
     *  owner described. */
    const checkOnDisk = async (want: Record<ThemeRole, string>): Promise<string> => {
      const onDisk = await ipc.getSettings();
      assert(
        onDisk !== null,
        "ipc.getSettings() came back empty — nothing reached settings.json at all",
      );
      assert(
        onDisk!.theme === "custom",
        `settings.json says theme "${String(onDisk!.theme)}", not "custom" — the theme repainted but was never persisted`,
      );
      // settings.json is opaque to the backend (serde_json::Value), so nothing
      // read back is trusted to be the shape the type claims.
      const stored = onDisk!.customTheme as Partial<Record<ThemeRole, unknown>> | null | undefined;
      assert(!!stored, "settings.json carries no customTheme block");
      for (const role of THEME_ROLES) {
        const got = String(stored![role] ?? "").trim().toLowerCase();
        assert(
          got === want[role],
          `settings.json holds ${role} ${got || "(nothing)"}, not the pick ${want[role]}`,
        );
      }
      return `theme "custom" + ${THEME_ROLES.map((r) => `${r} ${want[r]}`).join(" / ")}`;
    };

    /** Prove the guard can actually go red, on the live DOM, every run.
     *
     *  A block that cannot fail is worse than no block, and this one guards a
     *  bug that walked past 708 unit tests and thirty E2E blocks — so "it
     *  passes" is not evidence of anything on its own. `mutate` reproduces a
     *  real fault and hands back its own undo; the checker MUST throw; the DOM
     *  is put back and re-checked before anything else runs, so a self-check
     *  that failed to restore cannot poison every assertion after it. */
    const mustFail = (what: string, mutate: () => () => void, check: () => void): void => {
      const undo = mutate();
      let threw = false;
      try {
        check();
      } catch {
        threw = true;
      } finally {
        undo();
      }
      assert(threw, `the check does NOT fail when ${what} — it is not testing anything`);
      check();
    };

    // THE OWNER'S REPRO, in one block: Settings → home → Settings, in and out
    // through the real Back button and the real gear rather than through
    // navigate(), so the router, both dispose() paths and the re-mount are all
    // exercised the way a user gets them.
    await test("custom-theme-survives-home-round-trip", async () => {
      const { settingsStore, updateSettings } = await import("../core/session");
      const before = settingsStore.get();

      // Fixture self-check, before anything is applied: three picks that cannot
      // stand in for one another. 60 steps is far past "different colour"; TRIP
      // is 161 apart at its closest pair.
      for (let i = 0; i < THEME_ROLES.length; i++) {
        for (let j = i + 1; j < THEME_ROLES.length; j++) {
          const a = THEME_ROLES[i]!;
          const b = THEME_ROLES[j]!;
          const d = maxDelta(chan(TRIP[a]), chan(TRIP[b]));
          assert(
            d >= 60,
            `fixture no longer tests anything: ${a} ${TRIP[a]} and ${b} ${TRIP[b]} are ${d} channel steps apart, so a swatch painted from the wrong role would still look right`,
          );
        }
      }

      try {
        /* ---- 1. apply it, from the screen it is applied from ---- */

        navigate({ view: "settings" });
        const firstInner = await waitFor(
          () => document.querySelector<HTMLElement>("#settings-inner"),
          10_000,
          "the Settings screen",
        );
        await updateSettings({ theme: "custom", customTheme: { ...TRIP } });
        await waitFor(
          () => (same(tok("--bg-app"), TRIP.background) ? true : null),
          5_000,
          "the round-trip theme to paint",
        );
        // Measured BEFORE the trip as well, so that a failure after it can only
        // be the trip's doing and the report says which side broke.
        const beforeTrip = checkRows(TRIP, settingsStore.get().customTheme, "before the round trip");

        /* ---- 2. leave, and come back ---- */

        need<HTMLElement>("#settings-back").click();
        const gear = await waitFor(
          () => document.querySelector<HTMLElement>("#home-settings"),
          10_000,
          "the home Settings gear",
        );
        // The screen really was torn down. Without this the whole block could be
        // re-measuring the nodes it already measured and passing for free.
        assert(
          !document.contains(firstInner),
          "home is showing but the old Settings DOM is still in the document — nothing below would be testing a re-render",
        );
        gear.click();
        // #settings-inner is built by mountSettings and NOT by render(), so a
        // new one means a real re-mount and not merely a store notification.
        await waitFor(
          () => {
            const el = document.querySelector<HTMLElement>("#settings-inner");
            return el && el !== firstInner ? el : null;
          },
          10_000,
          "Settings to re-mount",
        );

        /* ---- 3. what is painted still equals what is stored ---- */

        const afterTrip = checkRows(TRIP, settingsStore.get().customTheme, "after home → Settings");

        /* ---- 4. …and that check is proven to go red ---- */

        const recheck = (): void => {
          checkRows(TRIP, settingsStore.get().customTheme, "self-check");
        };
        // 4a. THE REPORTED FAULT: an empty swatch beside a correct caption.
        mustFail(
          "the background swatch's fill is removed (the reported bug)",
          () => {
            const el = need<HTMLElement>("#settings-color-background .settings__color-swatch");
            const had = el.style.background;
            el.style.background = "";
            return () => {
              el.style.background = had;
            };
          },
          recheck,
        );
        // 4b. One role's colour standing in for another's — the failure that is
        //     invisible to any fixture whose picks coincide.
        mustFail(
          "the accent swatch is painted with the background colour",
          () => {
            const el = need<HTMLElement>("#settings-color-accent .settings__color-swatch");
            const had = el.style.background;
            el.style.background = TRIP.background;
            return () => {
              el.style.background = had;
            };
          },
          recheck,
        );
        // 4c. The other side of the three-way: a caption disagreeing with a
        //     perfectly good swatch.
        mustFail(
          "the text row's hex caption is rewritten",
          () => {
            const el = need<HTMLElement>("#settings-color-text .mono");
            const had = el.textContent ?? "";
            el.textContent = "#000000";
            return () => {
              el.textContent = had;
            };
          },
          recheck,
        );

        /* ---- 5. the theme control still says which theme is live ---- */

        const seg = checkSelectedSegment("after home → Settings");

        /* ---- 6. and it is on disk, not just in the store ---- */

        const disk = await checkOnDisk(TRIP);

        return `Settings → home → Settings via the real Back and gear: ${afterTrip} (unchanged from ${beforeTrip}); ${seg}; persisted ${disk}; and the guard was proven red on a blanked swatch, a swatch painted from the wrong role, and a rewritten caption`;
      } finally {
        // Never leave the owner's real theme changed by a test run. Nothing
        // clamps any more, so a leaked theme is a genuinely unusable app. The
        // repaint inside updateSettings is synchronous; the await is only so the
        // restore is the LAST write to settings.json.
        try {
          await updateSettings({ theme: before.theme, customTheme: before.customTheme });
        } catch {
          // The repaint already happened. A failed disk write must not mask the
          // assertion failure that sent us here.
        }
        navigate({ view: "home" });
      }
    });

    // The same round trip through the EDITOR. The router tears every screen down
    // the same way, but the editor's dispose() is by far the heaviest in the app
    // — playback engine, audio graph, media manager, timeline controller and the
    // project session all go down together, and any one of them clearing
    // something off <html> takes the theme with it. The owner's repro went
    // through home, which is the block above; this is the harder teardown, and
    // the one a user is actually standing in when they go to Settings to change
    // a colour without closing their project.
    await test("custom-theme-survives-editor-round-trip", async () => {
      const { settingsStore, updateSettings } = await import("../core/session");
      const before = settingsStore.get();
      try {
        navigate({ view: "settings" });
        await waitFor(
          () => document.querySelector<HTMLElement>("#settings-inner"),
          10_000,
          "the Settings screen",
        );
        await updateSettings({ theme: "custom", customTheme: { ...TRIP } });
        await waitFor(
          () => (same(tok("--bg-app"), TRIP.background) ? true : null),
          5_000,
          "the round-trip theme to paint",
        );
        const firstInner = need<HTMLElement>("#settings-inner");
        const beforeTrip = checkRows(
          TRIP,
          settingsStore.get().customTheme,
          "before the editor round trip",
        );

        /* ---- into the project, and back out through the editor's own gear ---- */

        // A fresh dev hook is mountEditor's own completion signal — the previous
        // one is still on window from the top of this run, so presence alone
        // would resolve instantly against a screen that no longer exists.
        const prevHook = (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev;
        navigate({ view: "editor", projectPath });
        await waitFor(
          () => {
            const h = (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev;
            return h && h !== prevHook ? h : null;
          },
          // mountEditor awaits only loadProject and media.init() (a listener
          // registration) before it paints — ensureAll runs in the background —
          // so this should land in well under a second. Kept tight on purpose:
          // the whole run shares one 90s budget, and a generous wait here would
          // spend it on the one path where nothing is going to arrive anyway.
          15_000,
          "the editor to re-mount",
        );
        assert(
          !document.contains(firstInner),
          "the editor is up but the old Settings DOM is still in the document — nothing below would be testing a re-render",
        );
        // Asserted here rather than only at the end: if the theme is dropped by
        // the navigation INTO the editor, the report should say so happened on
        // the way in and not leave it looking like a re-render fault.
        assert(
          root.dataset.customTheme === "1" && same(tok("--bg-app"), TRIP.background),
          `the custom theme was lost on the way into the editor: --bg-app is ${tok("--bg-app")}, data-custom-theme ${String(root.dataset.customTheme)}`,
        );
        const edGear = await waitFor(
          () => document.querySelector<HTMLElement>("#ed-settings"),
          10_000,
          "the editor's Settings gear",
        );
        assert(
          edGear.offsetParent !== null && edGear.getClientRects().length > 0,
          "the editor's Settings gear is in the DOM but not rendered",
        );
        edGear.click();
        await waitFor(
          () => {
            const el = document.querySelector<HTMLElement>("#settings-inner");
            return el && el !== firstInner ? el : null;
          },
          15_000,
          "Settings to re-mount after the editor",
        );

        const afterTrip = checkRows(
          TRIP,
          settingsStore.get().customTheme,
          "after editor → Settings",
        );
        const seg = checkSelectedSegment("after editor → Settings");
        const disk = await checkOnDisk(TRIP);

        return `Settings → editor → Settings via the editor's own gear (the heaviest teardown in the app): ${afterTrip} (unchanged from ${beforeTrip}); ${seg}; persisted ${disk}`;
      } finally {
        try {
          await updateSettings({ theme: before.theme, customTheme: before.customTheme });
        } catch {
          // As above: a failed disk write must not mask a real failure.
        }
        navigate({ view: "home" });
      }
    });
  } catch (e) {
    results.push({ name: "setup", pass: false, detail: String(e) });
  }

  clearTimeout(hardTimeout);
  await finish();
}
