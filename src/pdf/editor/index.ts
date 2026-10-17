// The PDF editor's public door. `mountEditor` (src/editor/editor.ts) reaches
// it ONLY through `await import("../pdf/editor")`, so the editor, pdf.js and
// everything they pull in stay out of startup and out of the video editor.

export { mountPdfEditor } from "./shell";
