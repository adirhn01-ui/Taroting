// 0.9.5 E2E blocks: a sound file the editor's audio voices cannot play is
// reported in the bin, once, and recovers through a relink. DEV-only: imported
// lazily by autotest.ts, never part of a release bundle.
//
// NOTHING under src/editor is imported statically here except types (erased):
// the relink helper is reached with `await import(...)`, so loading this file
// loads no lazy chunk as a side effect.
//
// The refused file is tests/fixtures/damaged_tone.wav (scripts/make-fixtures.mjs):
// a .wav name over 4096 bytes that are no RIFF at all. Its MediaRef is written
// by hand with the file's real size and mtime (a probe would refuse it), kind
// "audio" with no codec named, which the backend plans to play DIRECTLY — so
// the only thing that can notice it is the <audio> voice that loads it. The
// healthy control on a second audio track is tone.wav; the relink target is
// tone.flac (a different file from the control, so "the voice loaded the
// relinked file" cannot be satisfied by the control's voice).
//
// Every block ends on Home with every project it wrote deleted. Waits poll at
// 20 ms with their own short deadline and a message naming what they waited
// for and what was there instead.

import { ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { createProject, uid } from "../core/project";
import { currentSession } from "../core/session";
import type { Clip, MediaRef, ProjectFile, Track } from "../core/types";
import { closeMenu } from "../ui/menu";
import { discardTempSession } from "../ui/temp-project";
import type { DevHook } from "./autotest";
import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the other block files. */
export type AudioFailureCtx = Wave1Ctx;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll every 20 ms; `what` is evaluated only on timeout. */
async function until<T>(get: () => T | null | undefined | false, ms: number, what: () => string): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what()}`);
    await sleep(20);
  }
}

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E | null => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E[] => Array.from(root.querySelectorAll<E>(sel));
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

function rendered(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function describeEl(el: Element | null): string {
  if (!el) return "nothing";
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls}`;
}

/** Is `el` what the user would hit at its own centre (paint order, not DOM)? */
function hitsItself(el: HTMLElement): { ok: boolean; hit: string } {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: hit === el || (hit !== null && el.contains(hit)), hit: describeEl(hit) };
}

function onScreen(): string {
  return $(".pdfed") ? "PDF editor" : $(".imged") ? "image editor" : $(".editor") ? "video editor" : $("#vw") ? "viewer" : $(".settings") ? "settings" : $(".home") ? "home" : "?";
}

const audioClip = (m: MediaRef, start: number, dur: number): Clip => ({
  id: uid(),
  mediaId: m.id,
  timelineStart: start,
  srcIn: 0,
  srcOut: dur,
  speed: 1,
  transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
  audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
});

const track = (kind: "video" | "audio", name: string, clips: Clip[]): Track => ({ id: uid(), kind, name, muted: false, clips });

function audioProject(name: string, media: MediaRef[], tracks: Track[]): ProjectFile {
  const p = createProject(name);
  return { ...p, media, timeline: { ...p.timeline, width: 640, height: 360, tracks } };
}

/** The pooled voice elements (private to the graph; read, never driven). */
function voicesOf(dev: DevHook): HTMLAudioElement[] {
  const voices = (dev.audioGraph as unknown as { voices?: Array<{ el: HTMLAudioElement }> }).voices;
  return Array.isArray(voices) ? voices.map((v) => v.el) : [];
}

/** Does this element's src name the file `fileName` (asset URLs are encoded)? */
function loads(el: HTMLMediaElement, fileName: string): boolean {
  let src = el.getAttribute("src") ?? "";
  try {
    src = decodeURIComponent(src);
  } catch {
    /* keep it raw */
  }
  return src.replace(/\//g, "\\").toLowerCase().endsWith(`\\${fileName.toLowerCase()}`);
}

function voicesSummary(dev: DevHook): string {
  return (
    voicesOf(dev)
      .map((el) => {
        const src = el.getAttribute("src") ?? "";
        const name = src ? decodeURIComponent(src).replace(/\//g, "\\").split("\\").pop() : "(none)";
        return `${name} rs${el.readyState} err${el.error?.code ?? "-"}`;
      })
      .join("; ") || "no voices"
  );
}

export async function runAudioFailureBlocks(ctx: AudioFailureCtx): Promise<void> {
  const { test, assert, fixturesDir } = ctx;

  const BROKEN_FILE = "damaged_tone.wav";
  const brokenPath = `${fixturesDir}\\${BROKEN_FILE}`;
  const goodPath = `${fixturesDir}\\tone.wav`;
  const relinkPath = `${fixturesDir}\\tone.flac`;
  const WORDS = /^This file couldn't be played \(error ([2-9]|[1-9]\d+)(: .+)?\)$/;

  /** Close dialogs, discard the temp session, park on Home, delete `paths`.
   *  Never throws. */
  const backHome = async (paths: readonly string[]): Promise<void> => {
    try {
      closeMenu();
      for (const b of $$(".modal-backdrop")) {
        const out = b.querySelector<HTMLElement>('[data-act="cancel"], [data-cancel], [data-close], [data-close-btn]');
        if (out) out.click();
        else b.remove();
      }
      const s = currentSession.get();
      if (s && s.temp.get()) await discardTempSession(s);
      navigate({ view: "home" });
      await until(() => $(".home") && !$(".editor") && !$("#vw") && !$(".settings"), 5_000, () => `Home (${onScreen()})`);
    } catch (e) {
      console.error("audio failure autotest: cleanup did not finish", e);
    }
    for (const p of paths) if (p) await ipc.deleteProject(p).catch(() => {});
  };

  /** Save `project` as a temp .trt (the autotest root) and open the editor. */
  const mountVideo = async (project: ProjectFile, name: string, paths: string[]): Promise<DevHook> => {
    const path = await ipc.tempProjectPath(name);
    assert(/taroting-autotest/i.test(path), `the temp project path ${path} is not inside the autotest root — refusing to write there`);
    paths.push(path);
    await ipc.saveProject(path, project);
    const hook = (): DevHook | undefined => (window as unknown as { __tarotingDev?: DevHook }).__tarotingDev;
    const prev = hook();
    navigate({ view: "editor", projectPath: path, temp: true });
    return until(
      () => {
        const d = hook();
        return d && d !== prev && $(".editor:not(.imged)") && $("#media-list") ? d : null;
      },
      8_000,
      () => `the video editor on "${name}" — on screen: ${onScreen()}`,
    );
  };

  /** The broken sound file as the project records it: real size and mtime,
   *  kind audio, no codec named (planned to play directly). */
  const brokenRef = async (): Promise<MediaRef> => {
    const stat = await ipc.fileStat(brokenPath);
    assert(stat !== null, `${brokenPath} is missing — run npm run fixtures`);
    assert(stat!.size === 4096, `${brokenPath} is ${stat!.size} bytes, not the 4096-byte fixture make-fixtures writes`);
    return { id: uid(), path: brokenPath, size: stat!.size, mtimeMs: stat!.mtimeMs, kind: "audio", duration: 30, hasAudio: true };
  };

  /** Two audio tracks: the broken file on the first, tone.wav on the second,
   *  both from 0 s, so both are claimed by the paused tick at 0. With
   *  `controlMuted` the second track is muted, so only the first can sound. */
  const twoTracks = async (name: string, controlMuted = false): Promise<{ project: ProjectFile; broken: MediaRef; good: MediaRef }> => {
    const broken = await brokenRef();
    const good: MediaRef = { id: uid(), ...(await ipc.probeMedia(goodPath)) };
    assert(good.kind === "audio", `${goodPath} probes as ${good.kind}, not audio`);
    const project = audioProject(name, [broken, good], [
      track("video", "Video", []),
      track("audio", "Audio 1", [audioClip(broken, 0, 4)]),
      { ...track("audio", "Audio 2", [audioClip(good, 0, 4)]), muted: controlMuted },
    ]);
    return { project, broken, good };
  };

  const pillOf = (mediaId: string): HTMLElement | null => $(`.media-row[data-id="${CSS.escape(mediaId)}"] .media-row__status`);
  const binSummary = (): string =>
    $$(".media-row")
      .map((r) => `${r.querySelector(".media-row__name")?.textContent ?? "?"}: ${r.querySelector(".media-row__status")?.textContent ?? "?"}`)
      .join("; ") || "empty bin";

  /* ================================================================ */
  /* 1. a refused sound file is failed in the bin, once                */
  /* ================================================================ */

  await test("audio-voice-failure-marks-bin", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    let dev: DevHook | null = null;
    try {
      const { project, broken, good } = await twoTracks("Audio voice failure");
      dev = await mountVideo(project, "Audio voice failure", paths);
      const d = dev;
      d.engine.seek(0.5);

      // The voice's error reaches the manager: failed, never a repair.
      const failed = await until(
        () => {
          const s = d.media.status.get()[broken.id];
          return s?.state === "failed" ? s : null;
        },
        2_500,
        () => `${BROKEN_FILE} to be failed — status ${JSON.stringify(d.media.status.get()[broken.id])}; voices: ${voicesSummary(d)}`,
      );
      const tFailed = ms(t0);
      assert(WORDS.test(failed.message), `the failed status says "${failed.message}", not the sentence with the element's error code`);
      const failedVoice = voicesOf(d).find((el) => loads(el, BROKEN_FILE));
      assert(failedVoice !== undefined && failedVoice.error !== null, `no voice holds ${BROKEN_FILE} with an error: ${voicesSummary(d)}`);
      assert(failed.message.includes(`(error ${failedVoice!.error!.code}`), `the message "${failed.message}" does not carry the element's code ${failedVoice!.error!.code}`);
      assert(d.media.damage.get()[broken.id] === undefined, `${BROKEN_FILE} got a damage record: ${JSON.stringify(d.media.damage.get()[broken.id])}`);

      // The bin shows it: a painted "Failed" pill the pointer reaches, the
      // message in its tooltip; the healthy file beside it stays Ready.
      const pill = await until(
        () => {
          const p = pillOf(broken.id);
          return p && p.classList.contains("media-row__status--bad") && rendered(p) ? p : null;
        },
        1_000,
        () => `a painted Failed pill on ${BROKEN_FILE}'s row — bin: ${binSummary()}`,
      );
      assert(pill.textContent?.trim() === "Failed", `the pill reads "${pill.textContent}"`);
      assert(pill.title === failed.message, `the pill's tooltip is "${pill.title}", not the status message "${failed.message}"`);
      const hit = hitsItself(pill);
      assert(hit.ok, `the Failed pill is painted under ${hit.hit}`);
      assert(d.media.status.get()[good.id]?.state === "ready", `the healthy tone.wav is ${JSON.stringify(d.media.status.get()[good.id])}, not ready`);
      const okPill = pillOf(good.id);
      assert(rendered(okPill) && okPill.textContent?.trim() === "Ready", `tone.wav's pill reads "${okPill?.textContent ?? "nothing"}"`);

      // Once: playing on over the failed clip loads nothing again and leaves
      // the status untouched (the same object: nobody re-marked it).
      let reloads = 0;
      const onLoad = (e: Event): void => {
        if (loads(e.target as HTMLMediaElement, BROKEN_FILE)) reloads++;
      };
      const voices = voicesOf(d);
      for (const el of voices) el.addEventListener("loadstart", onLoad);
      let notified = 0;
      const unsub = d.media.status.subscribe(() => {
        if (d.media.status.get()[broken.id] !== failed) notified++;
      });
      try {
        d.engine.play();
        await sleep(600);
        d.engine.pause();
      } finally {
        unsub();
        for (const el of voices) el.removeEventListener("loadstart", onLoad);
      }
      assert(reloads === 0, `${BROKEN_FILE} was loaded ${reloads} more time(s) while the transport played over it`);
      assert(notified === 0 && d.media.status.get()[broken.id] === failed, `${BROKEN_FILE}'s status changed after it failed: ${JSON.stringify(d.media.status.get()[broken.id])}`);
      return `failed at ${tFailed} ("${failed.message}"), pill painted and hit, no reload in 600 ms of playback; ${ms(t0)}`;
    } finally {
      dev?.engine.pause();
      await backHome(paths);
    }
  });

  /* ================================================================ */
  /* 2. a relink onto a healthy file recovers it                       */
  /* ================================================================ */

  await test("audio-voice-failure-relink-recovers", async () => {
    const t0 = performance.now();
    const paths: string[] = [];
    let dev: DevHook | null = null;
    try {
      const { project, broken } = await twoTracks("Audio voice relink", true);
      dev = await mountVideo(project, "Audio voice relink", paths);
      const d = dev;
      d.engine.seek(0.5);
      await until(
        () => d.media.status.get()[broken.id]?.state === "failed",
        2_500,
        () => `${BROKEN_FILE} to be failed first — status ${JSON.stringify(d.media.status.get()[broken.id])}`,
      );

      // The relink dialog's own commit, without the dialog: the same id onto
      // tone.flac, then the manager retracks it as a changed file.
      const info = await ipc.probeMedia(relinkPath);
      const { applyRelink } = await import("../editor/media/relink");
      d.session.commit((p) => applyRelink(p, broken.id, relinkPath, info));
      d.media.retrack(broken.id, true);

      await until(
        () => d.media.status.get()[broken.id]?.state === "ready",
        2_500,
        () => `the relinked media to be ready — status ${JSON.stringify(d.media.status.get()[broken.id])}`,
      );
      const pill = await until(
        () => {
          const p = pillOf(broken.id);
          return p && p.classList.contains("media-row__status--ok") && rendered(p) ? p : null;
        },
        1_000,
        () => `a Ready pill on the relinked row — bin: ${binSummary()}`,
      );
      const hit = hitsItself(pill);
      assert(hit.ok, `the Ready pill is painted under ${hit.hit}`);

      // A voice really loaded the relinked file, without an error.
      d.engine.seek(0.75);
      const voice = await until(
        () => voicesOf(d).find((el) => loads(el, "tone.flac") && el.error === null && el.readyState >= 1) ?? null,
        2_000,
        () => `a voice holding tone.flac with metadata and no error — voices: ${voicesSummary(d)}`,
      );

      // And it plays: its clock moves and sound reaches the master bus.
      assert(await d.audioGraph.devEnsureRunning(), "the editor's AudioContext would not run, so no playback could be measured");
      d.audioGraph.devMasterAnalyser();
      const before = voice.currentTime;
      let rms = 0;
      d.engine.play();
      try {
        for (let i = 0; i < 12; i++) {
          await sleep(40);
          rms = Math.max(rms, d.audioGraph.devMasterRms());
        }
      } finally {
        d.engine.pause();
      }
      const moved = voice.currentTime - before;
      assert(moved > 0.1, `the relinked voice's clock moved ${moved.toFixed(3)} s in ~480 ms of playback`);
      assert(rms > 0.001, `the master bus stayed silent (RMS ${rms.toFixed(5)}) while the relinked tone played (master-bus RMS measured)`);
      return `failed, relinked, Ready pill hit; voice moved ${moved.toFixed(2)} s, RMS ${rms.toFixed(3)} (master-bus RMS measured); ${ms(t0)}`;
    } finally {
      dev?.engine.pause();
      await backHome(paths);
    }
  });
}
