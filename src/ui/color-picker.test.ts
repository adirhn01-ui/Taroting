import { describe, expect, it } from "vitest";
import { eyeDropperRefused } from "./color-picker";

/*
 * The screen eyedropper's failure signal, which is genuinely ambiguous at the
 * source: this app's webview rejects `EyeDropper.open()` with the *same*
 * DOMException the platform uses for a real cancel — "AbortError :: The user
 * canceled the selection" — measured at under a millisecond, with no overlay
 * ever presented and nobody touching the machine.
 *
 * So the name alone cannot decide, and the elapsed time carries the meaning:
 * a rejection that beats a human reaction was never a human decision. These
 * pin both halves, because getting either wrong is user-visible — treat a
 * refusal as a cancel and the button silently does nothing for ever; treat a
 * cancel as a refusal and pressing Escape rips the control out of the popover.
 */
describe("eyeDropperRefused", () => {
  it("calls an instant AbortError a refusal — no overlay was ever shown", () => {
    // The measured case: 0ms, straight back from the webview.
    expect(eyeDropperRefused("AbortError", 0)).toBe(true);
    expect(eyeDropperRefused("AbortError", 37)).toBe(true);
  });

  it("calls a considered AbortError a cancel and leaves the control alone", () => {
    // 1.4s is a person seeing the overlay and pressing Escape.
    expect(eyeDropperRefused("AbortError", 1400)).toBe(false);
    expect(eyeDropperRefused("AbortError", 8300)).toBe(false);
  });

  it("treats every other rejection as a refusal however long it took", () => {
    // A named failure is a failure whether it is instant or slow: only
    // AbortError is ever the user speaking.
    expect(eyeDropperRefused("NotAllowedError", 0)).toBe(true);
    expect(eyeDropperRefused("NotAllowedError", 9000)).toBe(true);
    expect(eyeDropperRefused("OperationError", 5000)).toBe(true);
    expect(eyeDropperRefused("", 5000)).toBe(true);
  });

  it("puts the boundary where a human cannot have acted", () => {
    // Pinned either side of the threshold so moving it has to be deliberate.
    expect(eyeDropperRefused("AbortError", 299)).toBe(true);
    expect(eyeDropperRefused("AbortError", 300)).toBe(false);
  });
});
