// The failures PDF export reports to the user. Each carries a plain-language
// message (shown as is) and a code the export dialog can branch on.

export type PdfExportErrorCode =
  | "source-missing"
  | "source-changed"
  | "source-invalid"
  | "password"
  | "font-missing"
  | "image-missing"
  | "image-invalid"
  | "range"
  | "empty";

export class PdfExportError extends Error {
  readonly code: PdfExportErrorCode;
  /** the file the failure is about, when there is one */
  readonly path: string | undefined;
  constructor(code: PdfExportErrorCode, message: string, path?: string) {
    super(message);
    this.name = "PdfExportError";
    this.code = code;
    this.path = path;
  }
}

/** The file name alone, for messages: a full path is noise in a toast. */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
