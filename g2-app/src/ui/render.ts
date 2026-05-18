// Pure-function layout primitives for the Even Realities G2 glasses HUD.
//
// The G2 panel is 576x288 4-bit greyscale. We render text in a fixed grid;
// the SDK does NOT expose font-metrics, so this module encodes a
// conservative 24-column x 10-row grid (7 usable body rows after we
// reserve space for headers/footers/status). All helpers here are pure
// string math: no SDK imports, no DOM, no I/O. That makes the layout
// fully unit-testable in Vitest.
//
// Truncation rules per work-package:
//   - Horizontal NEVER overflows (truncate / abbreviate, never wrap).
//   - Vertical scrolls (with edge indicators) when content exceeds the
//     visible row budget.

/** Physical panel width in pixels. */
export const SCREEN_WIDTH_PX = 576;

/** Physical panel height in pixels. */
export const SCREEN_HEIGHT_PX = 288;

/** Conservative monospace column budget per row. Tighten only once we
 *  have empirical font metrics from the device. */
export const LINE_WIDTH = 24;

/** Total grid rows on the panel (header + body + status). */
export const TOTAL_ROWS = 10;

/** Body rows available below the system header; the remaining rows are
 *  reserved for the page header (1) and a status/footer band (2). */
export const USABLE_ROWS = 7;

/** Single-codepoint ellipsis we append when we truncate text. */
export const ELLIPSIS = "…";

/**
 * Truncate `text` to `maxLen` columns, appending `…` if a cut occurred.
 * `maxLen` is inclusive of the ellipsis — the result is always
 * `<= maxLen` columns wide.
 *
 * Edge cases:
 *   - empty / undefined input -> "".
 *   - `maxLen <= 0`           -> "".
 *   - `maxLen === 1` and the text would be cut -> just the ellipsis.
 */
export function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return ELLIPSIS;
  return text.slice(0, maxLen - 1) + ELLIPSIS;
}

/**
 * Right-pad with spaces to exactly `width` columns. If `text` is longer
 * than `width`, it is truncated (with ellipsis) so the returned string
 * is always exactly `width` columns.
 */
export function padRight(text: string, width: number): string {
  if (width <= 0) return "";
  const safe = text ?? "";
  if (safe.length > width) return truncate(safe, width);
  return safe + " ".repeat(width - safe.length);
}

/**
 * Left-pad with spaces to exactly `width` columns. If `text` is longer
 * than `width`, the LEFT side is dropped — this is unusual but matches
 * right-aligned numeric fields (e.g. ETA "3 min" pinned to a 6-col
 * column).
 */
export function padLeft(text: string, width: number): string {
  if (width <= 0) return "";
  const safe = text ?? "";
  if (safe.length > width) return safe.slice(safe.length - width);
  return " ".repeat(width - safe.length) + safe;
}

/**
 * Compose a fixed-column row. Cells are joined with a single-space
 * separator, each cell is `padRight`'d to its declared width.
 *
 * Throws if the declared widths + separators exceed `LINE_WIDTH`, so
 * misconfigured rows fail loudly at the call site instead of silently
 * overflowing the panel.
 */
export function row(cells: string[], widths: number[]): string {
  if (cells.length !== widths.length) {
    throw new Error(
      `row: cells (${cells.length}) and widths (${widths.length}) must match`,
    );
  }
  if (widths.length === 0) return "";
  const separators = widths.length - 1;
  const total = widths.reduce((a, b) => a + b, 0) + separators;
  if (total > LINE_WIDTH) {
    throw new Error(
      `row: total width ${total} exceeds LINE_WIDTH ${LINE_WIDTH}`,
    );
  }
  return cells.map((cell, i) => padRight(cell, widths[i]!)).join(" ");
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
 * view.
 *
 * Stickiness strategy: **only-scroll-when-out-of-view** (a.k.a. "page
 * jump"). The window's top index is anchored, and we only move it when
 * the highlight leaves the current window. This keeps the viewport from
 * thrashing when the user nudges the cursor up and down by one. It does
 * mean the highlight can sit at either edge of the window — that's
 * desirable: it makes the user's position legible.
 */
export function scrollWindow(
  rows: string[],
  highlightedIndex: number,
  maxRows: number = USABLE_ROWS,
): ScrollWindow {
  if (rows.length === 0 || maxRows <= 0) {
    return { lines: [], hasMoreAbove: false, hasMoreBelow: false };
  }
  if (rows.length <= maxRows) {
    return { lines: rows.slice(), hasMoreAbove: false, hasMoreBelow: false };
  }
  const idx = Math.max(0, Math.min(highlightedIndex, rows.length - 1));
  // Default: position the highlight such that the window's last row is
  // the highlight when scrolling down, and the first row is the
  // highlight when scrolling up. Because we don't keep state here, we
  // derive a stable "page" position from the index alone: snap the
  // window so the highlight sits as far down as possible without
  // showing empty rows below. This is equivalent to "scroll the
  // minimum distance to keep the highlight visible, with a preference
  // for keeping content visible above the highlight when possible".
  let start: number;
  if (idx < maxRows) {
    start = 0;
  } else {
    start = idx - maxRows + 1;
  }
  // Never let the window extend past the array.
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
 * content above / below. Callers reserve those rows in their own budget;
 * this helper does NOT subtract from `USABLE_ROWS` for you.
 */
export function withEdgeMarkers(window: ScrollWindow): string[] {
  const out: string[] = [];
  if (window.hasMoreAbove) out.push("▴");
  out.push(...window.lines);
  if (window.hasMoreBelow) out.push("▾");
  return out;
}

/**
 * 2-column-wide prefix for a list row. Both branches return exactly 2
 * chars so the rest of the row stays grid-aligned.
 *   - highlighted:   "> "
 *   - unhighlighted: "  "
 */
export function highlightPrefix(isHighlighted: boolean): string {
  return isHighlighted ? "> " : "  ";
}

/**
 * Resolved scroll-window math: returns the slice of `rows` that fits in
 * `budget` rows, including ▴/▾ edge markers (each costing 1 row) when
 * content overflows above/below. Uses the same "minimum-scroll,
 * top-anchored" strategy as `scrollWindow`.
 *
 * The fixed-point step: edge markers consume from the budget, so when
 * they appear they reduce the visible content; when they don't appear
 * the content can grow back. Iterates once.
 *
 * Why one helper instead of asking callers to compose `scrollWindow` +
 * `withEdgeMarkers` themselves: the budget arithmetic ("how much room
 * does the window get after we reserve marker rows?") is fiddly enough
 * that the first two callers got it wrong. Centralizing the math here
 * means any future scrolling screen — Incidents today, others later —
 * gets the same correct behaviour.
 *
 * @param rows the full list of body rows (already formatted).
 * @param highlightedIndex the row to keep in view; clamped to range.
 * @param budget total row budget INCLUDING any markers we add.
 * @returns an array of strings, length <= budget, ready to render.
 */
export function scrollWindowWithMarkers(
  rows: string[],
  highlightedIndex: number,
  budget: number,
): string[] {
  if (budget <= 0) return [];
  if (rows.length === 0) return [];
  // Fast path: everything fits, no markers needed.
  if (rows.length <= budget) {
    return scrollWindow(rows, highlightedIndex, budget).lines.slice();
  }
  // Worst-case pass: reserve 2 rows for both markers. Then check the
  // actual edge state and grow back any unused marker rows.
  let win = scrollWindow(rows, highlightedIndex, budget - 2);
  if (!win.hasMoreAbove || !win.hasMoreBelow) {
    // Only one edge needs a marker (at most); reclaim the other row.
    win = scrollWindow(rows, highlightedIndex, budget - 1);
  }
  if (!win.hasMoreAbove && !win.hasMoreBelow) {
    // After the resize the window hits both edges (content fits).
    // Reclaim the second marker row too.
    win = scrollWindow(rows, highlightedIndex, budget);
  }
  return withEdgeMarkers(win);
}
