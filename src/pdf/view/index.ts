// The PDF page view's public door. Hosts (the folder viewer, the PDF editor)
// reach it ONLY through a dynamic import — nothing in src/core or Home may
// import it statically — so pdf.js and this code stay out of startup.

export { openPdf, countPages, renderPageToBlob, isPdfOpenError } from "./loader";
export { createPdfView, type PdfViewExt } from "./strip";
export { createSearch } from "./search";
export { createThumbRail } from "./thumbs";
