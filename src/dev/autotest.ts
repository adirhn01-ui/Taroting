// Dev-only in-app E2E harness. Launched when the app starts with
// TAROTING_AUTOTEST=1: builds a project from the synthetic fixtures, opens
// the editor, and asserts real behavior (frame-accurate seeking, stepping,
// split/undo, playback advancement) against the actual video elements.
// Results are written to %TEMP%\taroting-autotest-report.json.

import { ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { createProject, importMediaAsClip, splitClip } from "../core/project";
import type { ProjectSession } from "../core/session";
import { frameCenter } from "../core/time";
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
