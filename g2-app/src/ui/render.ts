// Pixel-accurate layout primitives for the Even Realities G2 glasses HUD.
//
// The G2 panel is 576x288 4-bit greyscale rendered with a single fixed,
// PROPORTIONAL LVGL font baked into the firmware. There is no font-size
// or alignment control. Historically this module faked a fixed character
// grid (a 72-"column" line, plus a narrower 58-col budget for real text)
// with magic numbers tuned by eye in the simulator — because the SDK
// exposes no font metrics. It does now: `@evenrealities/pretext` measures
// strings in real pixels matching the firmware renderer, so every budget
// here is a PIXEL budget and the dual width collapses to one truth — the
// container's inner pixel width (see `./geometry`).
//
// Two kinds of alignment, two mechanisms:
//   - Truncation / wrapping / fit decisions are EXACT (getTextWidth).
//   - Column alignment WITHIN one container is approximate: text is
//     left-aligned and the only filler is the space glyph (SPACE_PX wide),
//     so `padRight`/`padLeft`/`row` land within ±half a space of target.
//     For a genuinely pixel-aligned value column (the departure-board
//     ETA), the host renders a separate borderless overlay container at a
//     measured x — see `glasses-host.ts`. Use space-padding for casual
//     list columns; use the overlay when exact alignment matters.
//
// All helpers are pure (pretext is a pure measurement library — no SDK,
// no DOM, no I/O), so the layout stays fully unit-testable in Vitest.

import { getAdvW, getTextWidth, measureTextWrap } from "@evenrealities/pretext";
import {
  SCREEN_HEIGHT_PX,
  SCREEN_WIDTH_PX,
  SECTION_INNER_WIDTH_PX,
  TWO_BODY_MAX_LINES,
} from "./geometry";

// Re-export the panel dimensions from the geometry source of truth so
// existing `import { SCREEN_WIDTH_PX } from "../ui/render"` call sites keep
// resolving.
export { SCREEN_WIDTH_PX, SCREEN_HEIGHT_PX };

// Convenience re-exports so screens measure text without importing pretext
// directly (keeps the dependency surface in one place).
export { measureTextWrap };
/** Single-line pixel width of a string (with kerning), per the firmware font. */
export const textWidth = getTextWidth;

/** Single-codepoint ellipsis appended on truncation. 10px in the firmware
 *  font — markedly narrower than ASCII "..." (15px), which matters on a
 *  576px-wide panel. */
export const ELLIPSIS = "…";

/** Pixel advance width of the space glyph — the narrowest filler, and the
 *  unit of all space-padding math below. */
export const SPACE_PX = getAdvW(0x20) / 16;

/** Code-point-safe character array (so truncation never splits a surrogate
 *  pair — transit text is BMP today, but cheap insurance). */
function codepoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Truncate `text` to fit within `maxPx` pixels, appending `…` if a cut
 * occurred. The result's measured width is always `<= maxPx`.
 *
 * Edge cases:
 *   - empty / undefined input        -> "".
 *   - `maxPx <= 0`                    -> "".
 *   - `…` alone wider than `maxPx`    -> "" (nothing legible fits).
 *   - text already fits              -> returned unchanged.
 */
export function truncate(text: string, maxPx: number): string {
  if (!text) return "";
  if (maxPx <= 0) return "";
  if (getTextWidth(text) <= maxPx) return text;
  if (getTextWidth(ELLIPSIS) > maxPx) return "";
  const cps = codepoints(text);
  // Binary-search the longest code-point prefix whose width + `…` fits.
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getTextWidth(cps.slice(0, mid).join("") + ELLIPSIS) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join("") + ELLIPSIS;
}

/** Longest code-point prefix of `text` whose width fits `maxPx` (no
 *  ellipsis). Used to hard-break a word too wide for one line. */
function longestFittingPrefix(text: string, maxPx: number): string {
  const cps = codepoints(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getTextWidth(cps.slice(0, mid).join("")) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join("");
}

/**
 * Word-wrap `text` to at most `maxLines` lines of `maxPx` pixels each.
 *
 * Greedy line-fill: pack words until the next word's measured width
 * doesn't fit, then break. A word wider than `maxPx` is hard-broken at
 * the pixel boundary (no hyphenation). If the input doesn't fit in
 * `maxLines`, the LAST line is terminated with `…`.
 *
 * Returns [] for empty / whitespace-only input.
 */
export function wrapText(
  text: string,
  maxPx: number,
  maxLines: number,
): string[] {
  if (!text || maxPx <= 0 || maxLines <= 0) return [];
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const fits = (s: string): boolean => getTextWidth(s) <= maxPx;
  const lines: string[] = [];
  let current = "";
  let consumed = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    // Hard-break an over-wide word into pixel-sized slices.
    if (!fits(word)) {
      if (current.length > 0) {
        if (lines.length >= maxLines) break;
        lines.push(current);
        current = "";
      }
      let remaining = word;
      while (remaining.length > 0 && !fits(remaining)) {
        if (lines.length >= maxLines) break;
        const chunk = longestFittingPrefix(remaining, maxPx);
        if (chunk.length === 0) break; // not even one glyph fits
        lines.push(chunk);
        remaining = remaining.slice(chunk.length);
      }
      if (lines.length >= maxLines) break;
      current = remaining;
      consumed = i + 1;
      continue;
    }
    const candidate = current.length === 0 ? word : current + " " + word;
    if (fits(candidate)) {
      current = candidate;
      consumed = i + 1;
      continue;
    }
    if (lines.length >= maxLines) break;
    lines.push(current);
    if (lines.length >= maxLines) {
      current = "";
      break;
    }
    current = word;
    consumed = i + 1;
  }
  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }
  // Overflow: mark the last line with `…` so the reader knows there's more.
  if (consumed < words.length && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    if (last.endsWith(ELLIPSIS)) {
      // Already terminated by the hard-break path — leave it.
    } else if (fits(last + ELLIPSIS)) {
      lines[lines.length - 1] = last + ELLIPSIS;
    } else {
      lines[lines.length - 1] = truncate(last, maxPx);
    }
  }
  return lines;
}

/**
 * Right-pad with spaces to approximately `targetPx` pixels wide. Because
 * the only filler is the space glyph (`SPACE_PX`), the result lands within
 * half a space of `targetPx` — fine for casual list columns, NOT for a
 * value column that must align exactly (use the host's overlay for that).
 * If `text` is already wider than `targetPx`, it is truncated (with `…`).
 */
export function padRight(text: string, targetPx: number): string {
  if (targetPx <= 0) return "";
  const safe = text ?? "";
  const w = getTextWidth(safe);
  if (w > targetPx) return truncate(safe, targetPx);
  const n = Math.round((targetPx - w) / SPACE_PX);
  return safe + " ".repeat(Math.max(0, n));
}

/**
 * Left-pad with spaces to approximately `targetPx` pixels (right-aligns
 * `text` within the cell). If `text` is wider than `targetPx`, the LEFT
 * side is dropped a glyph at a time until it fits — matches right-aligned
 * numeric fields (e.g. an ETA pinned to the right of its cell).
 */
export function padLeft(text: string, targetPx: number): string {
  if (targetPx <= 0) return "";
  const safe = text ?? "";
  const w = getTextWidth(safe);
  if (w > targetPx) {
    const cps = codepoints(safe);
    while (cps.length > 0 && getTextWidth(cps.join("")) > targetPx) cps.shift();
    return cps.join("");
  }
  const n = Math.round((targetPx - w) / SPACE_PX);
  return " ".repeat(Math.max(0, n)) + safe;
}

/**
 * Compose a fixed-pixel-column row. Cells are joined by a single space
 * separator (`SPACE_PX`), each cell `padRight`'d to its declared pixel
 * width. Approximate alignment (space granularity) — see `padRight`.
 *
 * Throws if the declared widths + separators exceed the section inner
 * width, so a misconfigured row fails loudly instead of overflowing.
 */
export function row(cells: string[], widthsPx: number[]): string {
  if (cells.length !== widthsPx.length) {
    throw new Error(
      `row: cells (${cells.length}) and widths (${widthsPx.length}) must match`,
    );
  }
  if (widthsPx.length === 0) return "";
  const separators = (widthsPx.length - 1) * SPACE_PX;
  const total = widthsPx.reduce((a, b) => a + b, 0) + separators;
  if (total > SECTION_INNER_WIDTH_PX) {
    throw new Error(
      `row: total width ${total}px exceeds section inner width ${SECTION_INNER_WIDTH_PX}px`,
    );
  }
  return cells.map((cell, i) => padRight(cell, widthsPx[i]!)).join(" ");
}

/** A visible slice of a longer list, plus edge flags so the caller can
 *  decide whether to draw `▴`/`▾` indicators. */
export interface ScrollWindow {
  lines: string[];
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
}

/**
 * Return the visible window of `rows` that keeps `highlightedIndex` in
 * view, using a minimum-scroll, top-anchored strategy (the window only
 * moves when the highlight would leave it). `maxRows` is a ROW budget
 * (lines), independent of pixel width — pass `maxLines(box)` from
 * `./geometry` for the target container.
 */
export function scrollWindow(
  rows: string[],
  highlightedIndex: number,
  maxRows: number = TWO_BODY_MAX_LINES,
): ScrollWindow {
  if (rows.length === 0 || maxRows <= 0) {
    return { lines: [], hasMoreAbove: false, hasMoreBelow: false };
  }
  if (rows.length <= maxRows) {
    return { lines: rows.slice(), hasMoreAbove: false, hasMoreBelow: false };
  }
  const idx = Math.max(0, Math.min(highlightedIndex, rows.length - 1));
  let start: number;
  if (idx < maxRows) {
    start = 0;
  } else {
    start = idx - maxRows + 1;
  }
  start = Math.min(start, rows.length - maxRows);
  start = Math.max(0, start);
  const end = start + maxRows;
  return {
    lines: rows.slice(start, end),
    hasMoreAbove: start > 0,
    hasMoreBelow: end < rows.length,
  };
}

/**
 * Wrap a `ScrollWindow` with literal `▴` / `▾` rows when there is more
 * content above / below. Callers reserve those rows in their own budget.
 */
export function withEdgeMarkers(window: ScrollWindow): string[] {
  const out: string[] = [];
  if (window.hasMoreAbove) out.push("▴");
  out.push(...window.lines);
  if (window.hasMoreBelow) out.push("▾");
  return out;
}

/**
 * 2-char prefix for a list row. Both branches return strings of equal
 * code-point length so the rest of the row stays roughly aligned.
 *   - highlighted:   "> "
 *   - unhighlighted: "  "
 */
export function highlightPrefix(isHighlighted: boolean): string {
  return isHighlighted ? "> " : "  ";
}

/**
 * Resolved scroll-window math: returns the slice of `rows` that fits in
 * `budget` ROWS, including ▴/▾ edge markers (each costing 1 row) when
 * content overflows. Same minimum-scroll strategy as `scrollWindow`.
 */
export function scrollWindowWithMarkers(
  rows: string[],
  highlightedIndex: number,
  budget: number,
): string[] {
  if (budget <= 0) return [];
  if (rows.length === 0) return [];
  if (rows.length <= budget) {
    return scrollWindow(rows, highlightedIndex, budget).lines.slice();
  }
  let win = scrollWindow(rows, highlightedIndex, budget - 2);
  if (!win.hasMoreAbove || !win.hasMoreBelow) {
    win = scrollWindow(rows, highlightedIndex, budget - 1);
  }
  if (!win.hasMoreAbove && !win.hasMoreBelow) {
    win = scrollWindow(rows, highlightedIndex, budget);
  }
  return withEdgeMarkers(win);
}
