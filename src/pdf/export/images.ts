// Pictures for image marks: read, made embeddable, oriented the way the
// editor shows them.
//
// Orientation follows MediaRef's per-file rule (core/types.ts): a still
// WITHOUT `noAutorotate` is shown turned by its EXIF orientation (a JPEG, or a
// PNG whose eXIf the WebView reads), one WITH it is shown as coded. pdf-lib
// embeds coded pixels and ignores any tag, so the turn is applied here as the
// drawing matrix — no re-encode.

import type { MediaRef } from "../../core/types";
import type { EncodedImage, ExportDeps } from "./deps";

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function readTiffOrientation(b: Uint8Array, tiff: number, end: number): Orientation {
  if (tiff + 8 > end) return 1;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const be = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!le && !be) return 1;
  const u16 = (o: number): number => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
  const u32 = (o: number): number =>
    le ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000 : b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? (v as Orientation) : 1;
    }
  }
  return 1;
}

/** The EXIF orientation tag of a JPEG (APP1 Exif) or a PNG (eXIf chunk);
 *  1 when there is none or the file is anything else. Never throws. */
export function exifOrientation(b: Uint8Array): Orientation {
  try {
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 4 <= b.length) {
        if (b[o] !== 0xff) return 1;
        const marker = b[o + 1]!;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
          o += marker === 0xff ? 1 : 2;
          continue;
        }
        if (marker === 0xda || marker === 0xd9) return 1;
        const len = (b[o + 2]! << 8) | b[o + 3]!;
        const seg = o + 4;
        if (
          marker === 0xe1 &&
          b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 && b[seg + 3] === 0x66 &&
          b[seg + 4] === 0 && b[seg + 5] === 0
        ) {
          return readTiffOrientation(b, seg + 6, Math.min(b.length, o + 2 + len));
        }
        o += 2 + len;
      }
      return 1;
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      let o = 8;
      while (o + 12 <= b.length) {
        const len = b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
        const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
        if (type === "eXIf") return readTiffOrientation(b, o + 8, Math.min(b.length, o + 8 + len));
        if (type === "IEND") return 1;
        o += 12 + len;
      }
    }
  } catch {
    /* a malformed header is "no tag" */
  }
  return 1;
}

/** Displayed (X, Y) in the box (0..1, y down) of image-space corner (u, v)
 *  (0..1, v UP as PDF paints an image's unit square). */
export function displayedOf(o: Orientation, u: number, v: number): [number, number] {
  const s = u;
  const t = 1 - v;
  switch (o) {
    case 1: return [s, t];
    case 2: return [1 - s, t];
    case 3: return [1 - s, 1 - t];
    case 4: return [s, 1 - t];
    case 5: return [t, s];
    case 6: return [1 - t, s];
    case 7: return [1 - t, 1 - s];
    case 8: return [t, 1 - s];
  }
}

const MIME: Record<string, string> = {
  webp: "image/webp",
  bmp: "image/bmp",
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

export interface PreparedImage extends EncodedImage {
  orientation: Orientation;
}

/** Bytes pdf-lib can embed, plus the turn to draw them with. */
export async function prepareImage(m: MediaRef, bytes: Uint8Array, deps: ExportDeps): Promise<PreparedImage> {
  const ext = extOf(m.path);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const orientation: Orientation = m.noAutorotate ? 1 : exifOrientation(bytes);
  if (isJpeg) return { kind: "jpg", bytes, orientation };
  if (isPng) return { kind: "png", bytes, orientation };
  const png = await deps.decodeImage(bytes, MIME[ext] ?? "application/octet-stream");
  return { kind: "png", bytes: png, orientation: 1 };
}
