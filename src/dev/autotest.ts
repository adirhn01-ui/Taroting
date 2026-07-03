// Dev-only in-app E2E harness. Launched when the app starts with
// TAROTING_AUTOTEST=1: builds a project from the synthetic fixtures, opens
// the editor, and asserts real behavior (frame-accurate seeking, stepping,
// split/undo, playback advancement) against the actual video elements.
// Results are written to %TEMP%\taroting-autotest-report.json.

import { ipc } from "../core/ipc";
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
import { openGeneratorDialog } from "../editor/media/generators";
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

      return `button-click blurs; single Space = one toggle; ${storms} storm-clicks, pause always wins`;
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

    // ---- v0.6 Phase 3: multi-layer playback, stepping, canvas refit ----

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

    await test("canvas-refit", async () => {
      const { setProjectCanvas } = await import("../core/project");
      const canvas = document.querySelector<HTMLElement>(".preview__canvas")!;
      session.commit((p) => setProjectCanvas(p, 1280, 720));
      await sleep(120); // let stage.refit() from the store subscription run
      const w = parseFloat(canvas.style.width);
      const h = parseFloat(canvas.style.height);
      const ratio = w / h;
      assert(Math.abs(ratio - 16 / 9) < 0.02, `canvas ratio ${ratio.toFixed(3)} not 16:9`);
      session.undo();
      engine.refresh();
      return `refit to 16:9 ok (${w}x${h}, ratio ${ratio.toFixed(3)})`;
    });

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

    // ---- v0.6 Phase 3: keyframe UI evaluation + project canvas panel ----

    await test("keyframe-ui-eval", async () => {
      const { setPositionKeyframes, clearAnimation, findClip } = await import("../core/project");
      const { evalKfs } = await import("../core/anim");
      const { sourceTime } = await import("../core/time");
      const { computeTransform } = await import("../editor/preview/transforms");

      const clip0 = session.project.timeline.tracks[0]!.clips[0]!;
      const id = clip0.id;

      session.commit((p) => setPositionKeyframes(p, id, 0, -50, 0));
      session.commit((p) => setPositionKeyframes(p, id, 2, 50, 0));

      engine.seek(1);
      await sleep(120);
      const clip = findClip(session.project, id)!.clip;
      const s = sourceTime(clip, engine.time - clip.timelineStart);
      const evalX = evalKfs(clip.keyframes!.x!, s);
      const expected = -50 + (50 - -50) * 0.5; // lerp(-50, 50, 0.5) = 0
      assert(Math.abs(evalX - expected) < 1e-6, `evalX=${evalX}, expected ${expected}`);

      const media2 = session.project.media.find((m) => m.id === clip.mediaId)!;
      const proj = session.project.timeline;
      const ct = computeTransform(clip.transform, media2, proj);
      assert(Math.abs(ct.posX - clip.transform!.x) < 1e-6, "computeTransform reads static x");

      session.commit((p) => clearAnimation(p, id, "position", { x: evalX, y: 0 }));
      const baked = findClip(session.project, id)!.clip;
      assert(baked.keyframes?.x === undefined, "position kfs should be cleared");
      assert(Math.abs(baked.transform!.x - evalX) < 1e-6, `baked x=${baked.transform!.x}`);

      session.undo();
      session.undo();
      session.undo();
      engine.refresh();
      const restored = findClip(session.project, id)!.clip;
      assert(restored.keyframes === undefined, "keyframes should be gone after undo x3");
      return `evalX=${evalX.toFixed(3)} (expected ${expected}); bake+undo round-trip exact`;
    });

    await test("project-canvas-panel", async () => {
      const { setProjectCanvas, checkInvariants } = await import("../core/project");
      const tl = (): import("../core/types").Timeline => session.project.timeline;
      const w0 = tl().width;
      const h0 = tl().height;

      session.commit((p) => setProjectCanvas(p, 1280, 720));
      assert(tl().width === 1280 && tl().height === 720, `${tl().width}x${tl().height}`);
      const errs = checkInvariants(session.project);
      assert(errs.length === 0, `invariants: ${errs.join("; ")}`);

      session.undo();
      engine.refresh();
      assert(tl().width === w0 && tl().height === h0, `undo restored ${tl().width}x${tl().height}`);
      return `canvas 1280x720 set + invariants clean + undo restored ${w0}x${h0}`;
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
      const textMedia = {
        id: "atx_text", path: "Text", size: 0, mtimeMs: 0, kind: "image" as const,
        duration: 0, hasAudio: false, width: 640, height: 360,
        generator: { type: "text" as const, text: "TAROTING 100%", fontFamily: "Arial" as const,
          sizePx: 96, color: "#ffffff", bold: true, italic: false },
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
  } catch (e) {
    results.push({ name: "setup", pass: false, detail: String(e) });
  }

  clearTimeout(hardTimeout);
  await finish();
}
