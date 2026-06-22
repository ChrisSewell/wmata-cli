// The ONLY place text width is computed. `@evenrealities/pretext` measures
// strings in real pixels matching the firmware LVGL renderer, so every
// truncation / wrap / column-alignment decision is exact — no character
// counting, no space-padding, no magic `LINE_WIDTH`.
//
// pretext's documented example numbers can drift across versions; never assert
// against hardcoded widths — always measure live (a unit test pins relative
// invariants, not absolute px). Verify the visual result in the simulator.

import { getTextWidth, measureTextWrap } from "@evenrealities/pretext";
import { LINE_HEIGHT } from "./geometry";

export { LINE_HEIGHT };

/** Single-line pixel width of `s` (with kerning), per the firmware font. */
export function textWidth(s: string): number {
  if (!s) return 0;
  return getTextWidth(s);
}

/** Does `s` fit in `maxPx` on one line? */
export function fits(s: string, maxPx: number): boolean {
  return textWidth(s) <= maxPx;
}

/**
 * Wrap metrics for `s` inside `maxPx`: line count and the pixel height it
 * occupies (lineCount × 27). Returns the geometry, not the broken strings —
 * pretext measures widths, it doesn't return the wrapped lines.
 */
export function wrapInfo(s: string, maxPx: number): { lineCount: number; height: number } {
  const w = Math.max(1, Math.floor(maxPx));
  const lineCount = s ? measureTextWrap(s, w).lineCount : 0;
  return { lineCount, height: lineCount * LINE_HEIGHT };
}

const ELLIPSIS = "…"; // one glyph (~10px), cheaper than ASCII "..." (~15px)

/**
 * Truncate `s` to a pixel budget, appending a single-glyph ellipsis when a cut
 * occurs. Binary-searches the longest prefix whose width + `…` fits `maxPx`.
 * Returns `s` unchanged when it already fits, `""` when even `…` won't fit.
 */
export function truncateToPx(s: string, maxPx: number): string {
  if (!s) return "";
  if (textWidth(s) <= maxPx) return s;
  const ell = textWidth(ELLIPSIS);
  if (ell > maxPx) return "";
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(s.slice(0, mid)) + ell <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + ELLIPSIS;
}

/** Max single-line pixel width across `strings` (0 for an empty list). */
export function maxWidth(strings: readonly string[]): number {
  let m = 0;
  for (const s of strings) {
    const w = textWidth(s);
    if (w > m) m = w;
  }
  return m;
}

export { ELLIPSIS };
