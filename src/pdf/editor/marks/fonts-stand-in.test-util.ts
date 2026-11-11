// A stand-in for the font runtime (src/fonts) in the PDF editor's mount tests
// that are about the PDF inspector, not the picker: the picker is a plain
// <select aria-label="Font"> of the six legacy fonts wired to value() /
// onPick, and no non-legacy font is ever loaded. Test-only.

import { LEGACY_FONTS, fontChoice, isLegacyFont } from "../../../core/font-id";
import type { FontFamily, FontId } from "../../../core/types";

type Pick = { legacy: FontFamily; fontId?: FontId };

export function fontsStandIn() {
  return {
    ensureFonts: async (): Promise<void> => {},
    fontsReady: (): boolean => true,
    fontFace: (legacy: FontFamily, fontId: FontId | undefined, bold: boolean, italic: boolean) => ({
      family: legacy,
      bold,
      italic,
      missing: fontId !== undefined,
    }),
    facesOf: (): null => null,
    onFontsChanged: () => () => {},
    mountFontPicker(host: HTMLElement, opts: { value(): Pick; onPick(v: Pick): void; disabled?: boolean }) {
      const sel = document.createElement("select");
      sel.className = "select select--sm";
      sel.setAttribute("aria-label", "Font");
      for (const f of LEGACY_FONTS) {
        const o = document.createElement("option");
        o.value = f;
        o.textContent = f;
        sel.appendChild(o);
      }
      const refresh = (): void => {
        sel.value = opts.value().legacy;
      };
      const onChange = (): void => {
        if (isLegacyFont(sel.value)) opts.onPick(fontChoice(sel.value));
      };
      sel.addEventListener("change", onChange);
      refresh();
      host.appendChild(sel);
      return {
        refresh,
        dispose() {
          sel.removeEventListener("change", onChange);
          sel.remove();
        },
      };
    },
  };
}
