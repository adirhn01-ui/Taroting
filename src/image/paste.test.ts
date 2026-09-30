import { describe, expect, it } from "vitest";
import { firstImageItem } from "./paste";

const item = (kind: string, type: string): { kind: string; type: string } => ({ kind, type });

describe("firstImageItem", () => {
  it("picks the first FILE whose type is an image", () => {
    // Decoys before it: an image type carried as a string (a browser's HTML
    // snippet naming one), and a file that is not an image.
    const items = [
      item("string", "image/png"),
      item("file", "text/plain"),
      item("file", "image/jpeg"),
      item("file", "image/png"),
    ];
    expect(firstImageItem(items)).toBe(2);
  });

  it("returns −1 when nothing on the clipboard is an image file", () => {
    expect(firstImageItem([])).toBe(-1);
    expect(firstImageItem([item("string", "text/html"), item("file", "application/pdf")])).toBe(-1);
    expect(firstImageItem([item("string", "image/png")])).toBe(-1);
  });

  it("reads an array-like, as a DataTransferItemList is", () => {
    const list = { length: 2, 0: item("string", "text/plain"), 1: item("file", "image/bmp") };
    expect(firstImageItem(list)).toBe(1);
  });
});
