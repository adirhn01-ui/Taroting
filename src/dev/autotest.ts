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
  } catch (e) {
    results.push({ name: "setup", pass: false, detail: String(e) });
  }

  clearTimeout(hardTimeout);
  await finish();
}
