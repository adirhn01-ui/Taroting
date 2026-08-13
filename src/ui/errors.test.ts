import { describe, expect, it } from "vitest";
import { buildReport, createRedactor, type DiagnosticErrorEntry } from "../core/diagnostics";
import { formatRecentErrors, redactDetail } from "./errors";

/**
 * THE REGRESSION THESE PIN: "Recent errors" dumped `detail` verbatim — full
 * absolute paths and all — one row above "Copy report", which redacts. A user
 * pasting the dump into a public issue handed over their account name and their
 * folder layout, which is the exact thing the redaction work was built to stop.
 *
 * The contract is not "this dump is scrubbed somehow", it is "this dump is
 * scrubbed by the SAME code the report uses", so the parity test below is the
 * load-bearing one: it fails if anybody re-implements the scrubber here.
 */

/* Fixtures differ on every axis the code could confuse: two DIFFERENT files, in
 * two DIFFERENT folders, under two DIFFERENT extensions, and a message/detail
 * pair that never share a string — so a token that lines up did so for a
 * reason. */
const PROJECT_PATH = "C:\\Users\\adirh\\Documents\\Taroting\\wedding-rough-cut.trt";
const MEDIA_PATH = "C:\\Users\\adirh\\Videos\\holiday-in-crete.mp4";
/** A third file, in a third folder, under a third extension — the export
 *  destination, which is what an ffmpeg log names alongside the input. */
const OUTPUT_PATH = "D:\\Renders\\2026\\ceremony-master.mov";

function entry(over: Partial<DiagnosticErrorEntry> = {}): DiagnosticErrorEntry {
  return {
    at: Date.parse("2026-07-28T08:59:00.000Z"),
    op: "Export",
    message: "Export failed",
    ...over,
  };
}

describe("formatRecentErrors", () => {
  it("says so when nothing has failed", () => {
    expect(formatRecentErrors([])).toBe("No errors this session.");
  });

  it("scrubs the account name and the file name out of a detail dump", () => {
    const text = formatRecentErrors([
      entry({ detail: `could not open ${PROJECT_PATH}` }),
    ]);
    expect(text).not.toContain("adirh");
    expect(text).not.toContain("wedding-rough-cut");
    expect(text).not.toContain("Documents");
    expect(text).toContain("<file 1.trt>");
  });

  it("scrubs the message too, not only the detail", () => {
    // The head line is one row above the detail and was just as verbatim.
    const text = formatRecentErrors([
      entry({ message: `No such file: ${MEDIA_PATH}`, detail: "exit code 1" }),
    ]);
    expect(text).not.toContain("adirh");
    expect(text).not.toContain("holiday-in-crete");
    expect(text).toContain("<file 1.mp4>");
  });

  it("redacts exactly as the diagnostics report does — one scrubber, not two", () => {
    const line = `ffmpeg could not open ${MEDIA_PATH}`;
    const scrubbed = createRedactor().text(line);

    const dump = formatRecentErrors([entry({ message: "", detail: line })]);
    const report = buildReport({
      at: "2026-07-28T09:00:00.000Z",
      appVersion: "0.7.4",
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141.0.0.0",
      recentErrors: [entry({ message: line })],
    });

    expect(scrubbed).not.toContain("adirh");
    expect(dump).toContain(scrubbed);
    expect(report).toContain(scrubbed);
  });

  it("gives one file one token across every entry in the dump", () => {
    // A single redactor per dump is what keeps it diagnosable: two failures over
    // the same file must still read as the same file once the name is gone.
    const text = formatRecentErrors([
      entry({ op: "Open", detail: `read failed: ${PROJECT_PATH}` }),
      entry({ op: "Save", detail: `write failed: ${MEDIA_PATH}` }),
      entry({ op: "Export", detail: `still failing: ${PROJECT_PATH}` }),
    ]);
    expect(text.match(/<file 1\.trt>/g)?.length).toBe(2);
    expect(text).toContain("<file 2.mp4>");
    expect(text).not.toContain("<file 3");
  });

  it("keeps the numbering, timestamp, op and detail indent intact", () => {
    const text = formatRecentErrors([
      entry({ op: "Open", message: "Broken project", detail: "line one\nline two" }),
    ]);
    expect(text).toBe(
      " 1. 2026-07-28T08:59:00.000Z  Open\n    Broken project\n    line one\n    line two",
    );
  });

  it("indents every line of a multi-line detail after redaction", () => {
    // Redaction runs BEFORE the split, so a token spanning nothing weird still
    // leaves the line structure — and every line keeps its four spaces.
    const text = formatRecentErrors([
      entry({ detail: `opening ${MEDIA_PATH}\nfailed at ${PROJECT_PATH}` }),
    ]);
    expect(text).toContain("    opening <file 1.mp4>");
    expect(text).toContain("    failed at <file 2.trt>");
  });
});

/**
 * THE REGRESSION THESE PIN: a detail pane is a <textarea> precisely so the
 * native clipboard works on it, so scrubbing only what the Copy button reads
 * leaves select-all + Ctrl+C wide open. The pane now redacts what it is GIVEN,
 * once, which is the only place that covers both routes out.
 *
 * The case that made it real: the export dialog seeds the pane with ffmpeg's
 * log tail — absolute paths by construction — and that text stays in the
 * textarea permanently whenever the diagnostic report fails to build.
 *
 * `detailPane` itself is DOM; `redactDetail` is the seam it goes through, and
 * these run against the real redactor rather than a description of it.
 */
describe("redactDetail", () => {
  it("scrubs the raw ffmpeg log the export pane opens on", () => {
    const logTail = [
      `[in#0 @ 000001d9] Error opening input: ${MEDIA_PATH}`,
      `Error opening output file ${OUTPUT_PATH}.`,
    ].join("\n");

    const out = redactDetail(logTail);

    expect(out).not.toContain("adirh");
    expect(out).not.toContain("holiday-in-crete");
    expect(out).not.toContain("ceremony-master");
    expect(out).not.toContain("Renders");
    expect(out).toContain("<file 1.mp4>");
    expect(out).toContain("<file 2.mov>");
    // The trailing full stop is punctuation, not part of the name.
    expect(out).toContain("<file 2.mov>.");
    // Everything that is not a path survives — a scrubbed log still has to be
    // the log.
    expect(out).toContain("[in#0 @ 000001d9]");
  });

  it("uses ONE redactor for the whole pane, so a file reads the same on every line", () => {
    // Two mentions of one file, split across lines and separated by a second
    // file, so a per-line or per-mention redactor would number them apart.
    const text = redactDetail(
      [
        `opening ${MEDIA_PATH}`,
        `writing ${OUTPUT_PATH}`,
        `${MEDIA_PATH}: could not seek`,
      ].join("\n"),
    );
    expect(text.match(/<file 1\.mp4>/g)?.length).toBe(2);
    expect(text).toContain("<file 2.mov>");
    expect(text).not.toContain("<file 3");
  });

  it("leaves a report that has already been through the redactor exactly as it was", () => {
    // What lets the pane redact unconditionally instead of asking each caller
    // whether their text has been scrubbed: <file N.ext> matches neither the
    // absolute-path pattern nor either user sweep, so a second pass changes
    // nothing and the numbering cannot shift underneath the reader.
    const report = buildReport({
      at: "2026-07-28T09:00:00.000Z",
      appVersion: "0.7.4",
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141.0.0.0",
      operation: "Export",
      error: { code: "", message: `could not open ${MEDIA_PATH}` },
      ffmpeg: {
        argv: ["ffmpeg", "-i", MEDIA_PATH, OUTPUT_PATH],
        filterComplex: "[0:v]scale=1920:1080[v]",
        message: "conversion failed",
        logTail: [`Error opening output file ${OUTPUT_PATH}.`],
        ffmpegVersion: "8.0",
      },
      full: true,
    });

    // Guard against a vacuous pass: the report must really contain tokens.
    expect(report).toContain("<file 1.mp4>");
    expect(report).toContain("<file 2.mov>");
    expect(redactDetail(report)).toBe(report);
  });

  it("scrubs through the same redactor the report does — one scrubber, not two", () => {
    const line = `ffmpeg could not open ${PROJECT_PATH}`;
    expect(redactDetail(line)).toBe(createRedactor().text(line));
  });
});
