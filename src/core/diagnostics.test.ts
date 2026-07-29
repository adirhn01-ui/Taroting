import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_CHARS,
  buildReport,
  createRedactor,
  redactProjectShape,
  sweepUsernames,
  type ReportContext,
} from "./diagnostics";
import type { Clip, ProjectFile, Settings } from "./types";
import { DEFAULT_EXPORT_PRESET, DEFAULT_SETTINGS } from "./types";

/* ------------------------------------------------------------------ */
/* Fixtures — every axis deliberately DIFFERENT, so a value that lines */
/* up by accident can't hide a bug (canvas 1920x1080 vs media 1280x718 */
/* vs generator 398x934, timeline 25fps vs media 30000/1001).          */
/* ------------------------------------------------------------------ */

const VIDEO_PATH = "C:\\Users\\adirh\\Videos\\holiday in crete.mp4";
const AUDIO_PATH = "C:\\Users\\adirh\\Music\\secret playlist.mp3";
const SECRET_TEXT = "Happy birthday Dana";

function clip(over: Partial<Clip> & { id: string }): Clip {
  return {
    mediaId: "m1",
    timelineStart: 0,
    srcIn: 0,
    srcOut: 10,
    speed: 1,
    audio: {
      volume: 1,
      muted: false,
      fadeInSec: 0,
      fadeOutSec: 0,
      gainOffsetDb: 0,
      detached: false,
    },
    ...over,
  };
}

function makeProject(): ProjectFile {
  return {
    schema: 1,
    app: "taroting",
    id: "proj-1",
    name: "Wedding rough cut",
    createdAt: "2026-01-02T03:04:05.000Z",
    modifiedAt: "2026-01-02T03:04:05.000Z",
    media: [
      {
        id: "m1",
        path: VIDEO_PATH,
        size: 12_345_678,
        mtimeMs: 111,
        kind: "video",
        duration: 61.5,
        fps: { num: 30000, den: 1001 },
        width: 1280,
        height: 718,
        container: "mov,mp4",
        vcodec: "h264",
        acodec: "aac",
        pixFmt: "yuv420p",
        hasAudio: true,
      },
      {
        id: "m2",
        path: AUDIO_PATH,
        size: 4321,
        mtimeMs: 222,
        kind: "audio",
        duration: 123.25,
        hasAudio: true,
      },
      {
        id: "m3",
        path: `Text: ${SECRET_TEXT}`,
        size: 0,
        mtimeMs: 0,
        kind: "image",
        duration: 0,
        width: 398,
        height: 934,
        hasAudio: false,
        generator: {
          type: "text",
          text: SECRET_TEXT,
          fontFamily: "Georgia",
          sizePx: 64,
          color: "#ff00aa",
          bold: true,
          italic: false,
        },
      },
      {
        id: "m4",
        path: "Solid #112233",
        size: 0,
        mtimeMs: 0,
        kind: "image",
        duration: 0,
        width: 640,
        height: 480,
        hasAudio: false,
        generator: { type: "solid", color: "#112233" },
      },
    ],
    timeline: {
      fps: { num: 25, den: 1 },
      width: 1920,
      height: 1080,
      tracks: [
        {
          id: "t1",
          kind: "video",
          name: "V1",
          muted: false,
          clips: [
            clip({
              id: "c1",
              keyframes: {
                opacity: [
                  { t: 0, v: 0 },
                  { t: 5, v: 1 },
                ],
              },
            }),
            clip({ id: "c2", timelineStart: 10, srcIn: 2, srcOut: 6, speed: 2 }),
          ],
        },
        {
          id: "t2",
          kind: "video",
          name: "V2",
          muted: false,
          clips: [
            clip({
              id: "c3",
              mediaId: "m3",
              timelineStart: 3,
              srcOut: 4,
              keyframes: {
                x: [
                  { t: 0, v: 0 },
                  { t: 1, v: 40 },
                  { t: 2, v: 80 },
                ],
                y: [
                  { t: 0, v: 0 },
                  { t: 1, v: 10 },
                  { t: 2, v: 20 },
                ],
              },
            }),
          ],
        },
        {
          id: "t3",
          kind: "audio",
          name: "A1",
          muted: false,
          clips: [clip({ id: "c4", mediaId: "m2", srcOut: 30 })],
        },
      ],
      markers: [
        { id: "k1", t: 1, color: 0 },
        { id: "k2", t: 2, color: 3 },
      ],
    },
    export: { ...DEFAULT_EXPORT_PRESET },
  };
}

function makeSettings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

function baseCtx(over: Partial<ReportContext> = {}): ReportContext {
  return {
    at: "2026-07-28T09:00:00.000Z",
    appVersion: "0.7.3",
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141.0.0.0",
    ...over,
  };
}

/* ------------------------------------------------------------------ */

describe("sweepUsernames", () => {
  it("replaces the account name in a Windows profile path", () => {
    expect(sweepUsernames("open C:\\Users\\adirh\\Videos\\a.mp4 failed")).toBe(
      "open C:\\Users\\<user>\\Videos\\a.mp4 failed",
    );
  });

  it("handles forward slashes and POSIX homes", () => {
    expect(sweepUsernames("C:/Users/adirh/x")).toBe("C:/Users/<user>/x");
    expect(sweepUsernames("/home/adirh/x")).toBe("/home/<user>/x");
  });

  it("leaves paths outside a user profile alone", () => {
    const s = "C:\\Program Files\\Taroting\\ffmpeg.exe";
    expect(sweepUsernames(s)).toBe(s);
  });
});

describe("createRedactor", () => {
  it("maps a path to a token that keeps only the extension", () => {
    const r = createRedactor();
    expect(r.path(VIDEO_PATH)).toBe("<file 1.mp4>");
  });

  it("is a stable mapping — the same path always gets the same token", () => {
    const r = createRedactor([VIDEO_PATH, AUDIO_PATH]);
    expect(r.path(VIDEO_PATH)).toBe("<file 1.mp4>");
    expect(r.path(AUDIO_PATH)).toBe("<file 2.mp3>");
    expect(r.path(VIDEO_PATH)).toBe("<file 1.mp4>");
    expect(r.text(`opening ${VIDEO_PATH} now`)).toBe("opening <file 1.mp4> now");
  });

  it("replaces a known path containing spaces in free text", () => {
    const r = createRedactor([VIDEO_PATH]);
    const scrubbed = r.text(`[in#0] Error opening input file ${VIDEO_PATH}.`);
    expect(scrubbed).not.toContain("holiday");
    expect(scrubbed).not.toContain("adirh");
    expect(scrubbed).toContain("<file 1.mp4>");
  });

  it("tokenizes an unknown absolute path found in free text", () => {
    const r = createRedactor();
    const scrubbed = r.text("could not read C:\\temp\\thing.log");
    expect(scrubbed).toBe("could not read <file 1.log>");
  });

  it("gives a label with no extension a bare token", () => {
    const r = createRedactor();
    expect(r.path("Solid #112233")).toBe("<file 1>");
  });
});

describe("redactProjectShape", () => {
  it("counts tracks, clips, keyframes, markers and generators", () => {
    const shape = redactProjectShape(makeProject());
    expect(shape.videoTracks).toBe(2);
    expect(shape.audioTracks).toBe(1);
    expect(shape.clips).toBe(4);
    expect(shape.animatedClips).toBe(2);
    expect(shape.keyframes).toBe(8);
    expect(shape.markers).toBe(2);
    expect(shape.generators).toBe(2);
    expect(shape.mediaCount).toBe(4);
    expect(shape.canvas).toBe("1920x1080");
    expect(shape.timebase).toBe("25/1");
    expect(shape.durationSec).toBe(30);
  });

  it("keeps media properties — they are the reproduction, not personal data", () => {
    const first = redactProjectShape(makeProject()).media[0]!;
    expect(first).toMatchObject({
      kind: "video",
      width: 1280,
      height: 718,
      fps: "30000/1001",
      vcodec: "h264",
      acodec: "aac",
      pixFmt: "yuv420p",
      durationSec: 61.5,
      sizeBytes: 12_345_678,
      hasAudio: true,
    });
  });

  it("never emits a file path, only stable tokens", () => {
    const shape = redactProjectShape(makeProject());
    const json = JSON.stringify(shape);
    expect(json).not.toContain("adirh");
    expect(json).not.toContain("holiday");
    expect(json).not.toContain("secret playlist");
    expect(shape.media.map((m) => m.ref)).toEqual([
      "<file 1.mp4>",
      "<file 2.mp3>",
      "<file 3>",
      "<file 4>",
    ]);
  });

  it("reports a text generator's shape but never its text", () => {
    const gen = redactProjectShape(makeProject()).media[2]!.generator!;
    expect(gen).toEqual({
      type: "text",
      chars: SECRET_TEXT.length,
      fontFamily: "Georgia",
      sizePx: 64,
      bold: true,
      italic: false,
    });
    expect(JSON.stringify(gen)).not.toContain("Dana");
  });

  it("reports a solid generator as a bare type", () => {
    expect(redactProjectShape(makeProject()).media[3]!.generator).toEqual({ type: "solid" });
  });

  it("caps the media table and reports how many rows were dropped", () => {
    const project = makeProject();
    const many = { ...project, media: [] as ProjectFile["media"] };
    for (let i = 0; i < 55; i++) {
      many.media.push({ ...project.media[0]!, id: `m${i}`, path: `C:\\clips\\${i}.mp4` });
    }
    const shape = redactProjectShape(many);
    expect(shape.mediaCount).toBe(55);
    expect(shape.media.length).toBe(40);
    expect(shape.mediaOmitted).toBe(15);
  });
});

describe("buildReport", () => {
  it("writes a header with the app version, platform and operation", () => {
    const text = buildReport(baseCtx({ operation: "Export" }));
    expect(text).toContain("Taroting diagnostic report");
    expect(text).toContain("App version     0.7.3");
    expect(text).toContain("Platform        Win32");
    expect(text).toContain("Operation       Export");
    expect(text).toContain("Redaction notice");
  });

  it("labels a report with no failing operation as a system report", () => {
    expect(buildReport(baseCtx())).toContain("Operation       none (system report)");
  });

  it("includes the error code the IPC boundary would otherwise discard", () => {
    const text = buildReport(
      baseCtx({ error: { code: "export_failed", message: "ffmpeg exited with 0xffffffea" } }),
    );
    expect(text).toContain("Code            export_failed");
    expect(text).toContain("ffmpeg exited with 0xffffffea");
  });

  it("elides the filter graph unless the caller asks for the full report", () => {
    const ctx = baseCtx({
      ffmpeg: {
        argv: ["ffmpeg", "-y", "-i", VIDEO_PATH],
        filterComplex: "x".repeat(9000),
        message: "boom",
        logTail: [],
        ffmpegVersion: "n7.1",
      },
    });
    const short = buildReport({ ...ctx, full: false });
    expect(short).toContain("9000 chars");
    expect(short).not.toContain("x".repeat(200));

    const full = buildReport({ ...ctx, full: true });
    expect(full).toContain("x".repeat(200));
  });

  it("uses one stable token across the ffmpeg command, the log and the media table", () => {
    const text = buildReport(
      baseCtx({
        project: makeProject(),
        ffmpeg: {
          argv: ["ffmpeg", "-i", VIDEO_PATH, "C:\\Users\\adirh\\Desktop\\my film.mp4"],
          filterComplex: "",
          message: "boom",
          logTail: [`Error opening ${VIDEO_PATH}`, "Conversion failed!"],
          ffmpegVersion: "n7.1",
        },
      }),
    );
    // three sections, one token
    expect(text.match(/<file 1\.mp4>/g)?.length).toBeGreaterThanOrEqual(3);
    // the output path is not project media, so it gets its own token — and
    // its spaces don't leak because an argv element is a whole path
    expect(text).toContain("<file 5.mp4>");
    expect(text).not.toContain("my film");
  });

  it("never leaks a user name, a path, the project name or generator text", () => {
    const text = buildReport(
      baseCtx({
        operation: "Export",
        project: makeProject(),
        settings: makeSettings({ defaultExportDir: "C:\\Users\\adirh\\Desktop" }),
        error: { code: "ffmpeg_failed", message: `could not open ${AUDIO_PATH}` },
        ffmpeg: {
          argv: ["ffmpeg", "-i", VIDEO_PATH],
          filterComplex: `drawtext=text='${SECRET_TEXT}'`,
          message: "boom",
          logTail: [`No such file: ${AUDIO_PATH}`],
          ffmpegVersion: "n7.1",
        },
        full: true,
      }),
    );
    expect(text).not.toContain("adirh");
    expect(text).not.toContain("holiday in crete");
    expect(text).not.toContain("secret playlist");
    expect(text).not.toContain("Wedding rough cut");
    // the filter graph is verbatim by design, so the generator text may appear
    // there — but never in the project shape or the media table
    const shapeSection = text.slice(text.indexOf("Project shape"));
    expect(shapeSection).not.toContain(SECRET_TEXT);
    expect(shapeSection).toContain(`chars=${SECRET_TEXT.length}`);
  });

  it("reports export folders as set / not set, never as a path", () => {
    const text = buildReport(
      baseCtx({
        settings: makeSettings({
          defaultExportDir: null,
          lastExportDir: "C:\\Users\\adirh\\Videos\\out",
        }),
        preset: { ...DEFAULT_EXPORT_PRESET },
        destinationSet: true,
      }),
    );
    expect(text).toContain("Default export  not set");
    expect(text).toContain("Last export     set");
    expect(text).toContain("Destination     set");
    expect(text).not.toContain("Videos");
  });

  it("summarises settings and counts customised shortcuts", () => {
    const stock = buildReport(baseCtx({ settings: makeSettings() }));
    expect(stock).toContain("Shortcuts       default");
    const custom = buildReport(
      baseCtx({
        settings: makeSettings({
          shortcuts: { ...DEFAULT_SETTINGS.shortcuts, split: "Q", undo: "Ctrl+U" },
        }),
      }),
    );
    expect(custom).toContain("Shortcuts       2 customised");
  });

  it("lists the recent-errors ring", () => {
    const text = buildReport(
      baseCtx({
        recentErrors: [
          { at: Date.parse("2026-07-28T08:59:00.000Z"), op: "Export", message: "boom" },
          { at: Date.parse("2026-07-28T08:59:30.000Z"), op: "Settings", message: "no cache" },
        ],
      }),
    );
    expect(text).toContain("Recent errors (2 this session)");
    expect(text).toContain("Export");
    expect(text).toContain("no cache");
  });

  it("carries no machine, install or session identifier", () => {
    const full = buildReport(
      baseCtx({ project: makeProject(), settings: makeSettings(), operation: "Export" }),
    );
    // everything except the notice, which names these only to say they do not exist
    const body = full.slice(0, full.indexOf("Redaction notice")).toLowerCase();
    expect(body.length).toBeGreaterThan(200);
    for (const banned of [
      "machine id",
      "machineid",
      "install id",
      "installid",
      "session id",
      "sessionid",
      "uuid",
    ]) {
      expect(body).not.toContain(banned);
    }
  });

  it("caps the report length however big the log is", () => {
    const text = buildReport(
      baseCtx({
        ffmpeg: {
          argv: [],
          filterComplex: "y".repeat(500_000),
          message: "boom",
          logTail: Array.from({ length: 4000 }, (_, i) => `line ${i} ${"z".repeat(2000)}`),
          ffmpegVersion: "n7.1",
        },
        full: true,
      }),
    );
    expect(text.length).toBeLessThanOrEqual(MAX_REPORT_CHARS + 80);
    expect(text).toContain("report truncated");
  });

  it("is pure — the same context always builds the same text", () => {
    const ctx = baseCtx({ operation: "Export", project: makeProject(), settings: makeSettings() });
    expect(buildReport(ctx)).toBe(buildReport(ctx));
  });
});
