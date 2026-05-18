// Unit tests for the pure-function layout primitives in render.ts. The
// goal here is exhaustive: any regression in a formatter must break the
// suite, because the on-glasses UI has no other safety net.

import { describe, expect, it } from "vitest";
import {
  ELLIPSIS,
  LINE_WIDTH,
  SCREEN_HEIGHT_PX,
  SCREEN_WIDTH_PX,
  TOTAL_ROWS,
  USABLE_ROWS,
  highlightPrefix,
  padLeft,
  padRight,
  row,
  scrollWindow,
  truncate,
  withEdgeMarkers,
} from "./render";

describe("grid constants", () => {
  it("matches the 576x288 G2 panel", () => {
    expect(SCREEN_WIDTH_PX).toBe(576);
    expect(SCREEN_HEIGHT_PX).toBe(288);
  });

  it("reserves 3 rows for header/footer/status", () => {
    expect(TOTAL_ROWS).toBe(10);
    expect(USABLE_ROWS).toBe(7);
    expect(TOTAL_ROWS - USABLE_ROWS).toBe(3);
  });

  it("uses a 24-column conservative line width", () => {
    expect(LINE_WIDTH).toBe(24);
  });
});

describe("truncate", () => {
  it("returns '' for empty input", () => {
    expect(truncate("", 5)).toBe("");
  });

  it("returns '' when maxLen is zero", () => {
    expect(truncate("hello", 0)).toBe("");
  });

  it("returns '' when maxLen is negative", () => {
    expect(truncate("hello", -1)).toBe("");
  });

  it("returns the text unchanged at an exact fit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("returns the text unchanged when shorter than maxLen", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });

  it("cuts the last char and appends an ellipsis when one over", () => {
    // "hello!" is 6 chars; into 5 cols becomes "hell…" (also 5 cols).
    const out = truncate("hello!", 5);
    expect(out).toBe("hell" + ELLIPSIS);
    expect(out.length).toBe(5);
  });

  it("returns just the ellipsis when maxLen is 1 and text must be cut", () => {
    expect(truncate("hello", 1)).toBe(ELLIPSIS);
  });
});

describe("padRight", () => {
  it("returns text unchanged at the exact width", () => {
    expect(padRight("hi", 2)).toBe("hi");
  });

  it("pads with trailing spaces when shorter than width", () => {
    expect(padRight("hi", 5)).toBe("hi   ");
  });

  it("truncates with ellipsis when longer than width", () => {
    // 'overflow' is 8 chars; into 5 cols becomes 'over' + ellipsis.
    expect(padRight("overflow", 5)).toBe("over" + ELLIPSIS);
  });

  it("always returns exactly `width` columns", () => {
    expect(padRight("a", 4).length).toBe(4);
    expect(padRight("foobarbaz", 4).length).toBe(4);
  });

  it("returns '' when width is zero", () => {
    expect(padRight("hi", 0)).toBe("");
  });
});

describe("padLeft", () => {
  it("returns text unchanged at the exact width", () => {
    expect(padLeft("hi", 2)).toBe("hi");
  });

  it("pads with leading spaces when shorter than width", () => {
    expect(padLeft("hi", 5)).toBe("   hi");
  });

  it("drops the left side when longer than width (rare numeric case)", () => {
    expect(padLeft("12345", 3)).toBe("345");
  });

  it("returns '' when width is zero", () => {
    expect(padLeft("hi", 0)).toBe("");
  });
});

describe("row", () => {
  it("composes a 2-column row joined by a single space", () => {
    // widths: 4 + 1 + 5 = 10 columns total
    const r = row(["RD", "ARR"], [4, 5]);
    expect(r).toBe("RD   ARR  ");
    expect(r.length).toBe(10);
  });

  it("composes a 3-column row joined by single spaces", () => {
    // widths: 2 + 1 + 4 + 1 + 5 = 13 columns total
    const r = row(["RD", "DCA", "5 min"], [2, 4, 5]);
    expect(r).toBe("RD DCA  5 min");
    expect(r.length).toBe(13);
  });

  it("right-pads short cells and truncates long ones", () => {
    const r = row(["Anacostia", "ARR"], [6, 3]);
    // "Anacostia" is 9 chars truncated into 6 -> "Anaco" + ellipsis = 6
    expect(r).toBe("Anaco" + ELLIPSIS + " ARR");
    expect(r.length).toBe(10);
  });

  it("fits exactly at LINE_WIDTH (24 cols)", () => {
    // 11 + 1 + 12 = 24 columns, no overflow.
    const r = row(["a".repeat(11), "b".repeat(12)], [11, 12]);
    expect(r.length).toBe(LINE_WIDTH);
  });

  it("throws when total width + separators exceeds LINE_WIDTH", () => {
    // 12 + 1 + 12 = 25 > 24
    expect(() => row(["x".repeat(12), "y".repeat(12)], [12, 12])).toThrow(
      /LINE_WIDTH/,
    );
  });

  it("throws when cells and widths array lengths differ", () => {
    expect(() => row(["a", "b"], [3])).toThrow(/cells/);
  });

  it("returns '' for an empty cell list", () => {
    expect(row([], [])).toBe("");
  });
});

describe("scrollWindow", () => {
  // Stickiness strategy under test:
  //   "Minimum-scroll, top-anchored". The window starts at index 0 and
  //   only advances when the highlight would otherwise fall off the
  //   bottom. The window never extends past the array. This means:
  //     - the highlight sits as high as possible in the window,
  //     - paging up/down by one row does NOT thrash the viewport,
  //     - the user can see "what comes next" until the cursor needs to
  //       move off-screen.
  //
  //   For a 10-row list with maxRows=7:
  //     - highlight 0..6  -> window [0..6]  (no scroll yet)
  //     - highlight 7     -> window [1..7]
  //     - highlight 8     -> window [2..8]
  //     - highlight 9     -> window [3..9]
  //
  //   That's the contract; the assertions below pin it down.

  it("returns an empty window for an empty list", () => {
    const w = scrollWindow([], 0);
    expect(w.lines).toEqual([]);
    expect(w.hasMoreAbove).toBe(false);
    expect(w.hasMoreBelow).toBe(false);
  });

  it("returns all rows when the list fits in maxRows (no scrolling)", () => {
    const w = scrollWindow(["a", "b", "c"], 0, 7);
    expect(w.lines).toEqual(["a", "b", "c"]);
    expect(w.hasMoreAbove).toBe(false);
    expect(w.hasMoreBelow).toBe(false);
  });

  it("shows the first 7 rows and signals more below when highlight is at index 0", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 0, 7);
    expect(w.lines).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(w.hasMoreAbove).toBe(false);
    expect(w.hasMoreBelow).toBe(true);
  });

  it("keeps a mid-list highlight (5) inside the window with appropriate flags", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 5, 7);
    expect(w.lines).toContain("r5");
    expect(w.lines.length).toBe(7);
    // With minimum-scroll, idx 5 < maxRows so the window stays at the top.
    expect(w.lines).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(w.hasMoreAbove).toBe(false);
    expect(w.hasMoreBelow).toBe(true);
  });

  it("does NOT thrash the viewport for a middle highlight (idx 4)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    // The minimum-scroll strategy keeps the window at the top until the
    // highlight would actually fall off the bottom edge.
    const w = scrollWindow(rows, 4, 7);
    expect(w.lines).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(w.hasMoreAbove).toBe(false);
    expect(w.hasMoreBelow).toBe(true);
  });

  it("shows the last 7 rows and signals more above when highlight is at the bottom", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 9, 7);
    expect(w.lines).toEqual(["r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
    expect(w.hasMoreAbove).toBe(true);
    expect(w.hasMoreBelow).toBe(false);
  });

  it("advances exactly one row when the highlight steps onto index 7", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 7, 7);
    expect(w.lines).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    expect(w.hasMoreAbove).toBe(true);
    expect(w.hasMoreBelow).toBe(true);
  });

  it("clamps an out-of-range negative highlight to 0", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, -3, 3);
    expect(w.lines).toEqual(["r0", "r1", "r2"]);
    expect(w.hasMoreAbove).toBe(false);
    expect(w.hasMoreBelow).toBe(true);
  });

  it("clamps an out-of-range positive highlight to the last row", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 99, 3);
    expect(w.lines).toEqual(["r2", "r3", "r4"]);
    expect(w.hasMoreAbove).toBe(true);
    expect(w.hasMoreBelow).toBe(false);
  });

  it("defaults maxRows to USABLE_ROWS when not provided", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 0);
    expect(w.lines.length).toBe(USABLE_ROWS);
  });
});

describe("withEdgeMarkers", () => {
  it("adds neither marker when there is no off-screen content", () => {
    const out = withEdgeMarkers({
      lines: ["a", "b"],
      hasMoreAbove: false,
      hasMoreBelow: false,
    });
    expect(out).toEqual(["a", "b"]);
  });

  it("adds a leading '▴' marker when there is content above", () => {
    const out = withEdgeMarkers({
      lines: ["b", "c"],
      hasMoreAbove: true,
      hasMoreBelow: false,
    });
    expect(out).toEqual(["▴", "b", "c"]);
  });

  it("adds a trailing '▾' marker when there is content below", () => {
    const out = withEdgeMarkers({
      lines: ["a", "b"],
      hasMoreAbove: false,
      hasMoreBelow: true,
    });
    expect(out).toEqual(["a", "b", "▾"]);
  });

  it("adds both markers when content extends in both directions", () => {
    const out = withEdgeMarkers({
      lines: ["b", "c"],
      hasMoreAbove: true,
      hasMoreBelow: true,
    });
    expect(out).toEqual(["▴", "b", "c", "▾"]);
    // Each marker consumes one row of the caller's budget.
    expect(out.length).toBe(4);
  });
});

describe("highlightPrefix", () => {
  it("returns '> ' for the highlighted row", () => {
    expect(highlightPrefix(true)).toBe("> ");
  });

  it("returns two spaces for an unhighlighted row", () => {
    expect(highlightPrefix(false)).toBe("  ");
  });

  it("returns a fixed-width 2-char prefix so columns stay aligned", () => {
    expect(highlightPrefix(true).length).toBe(2);
    expect(highlightPrefix(false).length).toBe(2);
  });
});
