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
  scrollWindowWithMarkers,
  truncate,
  withEdgeMarkers,
  wrapText,
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

  it("uses a 72-column line width (empirically tuned from simulator)", () => {
    expect(LINE_WIDTH).toBe(72);
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

  it("fits exactly at LINE_WIDTH (72 cols)", () => {
    // 35 + 1 + 36 = 72 columns, no overflow.
    const r = row(["a".repeat(35), "b".repeat(36)], [35, 36]);
    expect(r.length).toBe(LINE_WIDTH);
  });

  it("throws when total width + separators exceeds LINE_WIDTH", () => {
    // 36 + 1 + 36 = 73 > 72
    expect(() => row(["x".repeat(36), "y".repeat(36)], [36, 36])).toThrow(
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

describe("scrollWindowWithMarkers", () => {
  // The Reviewer asked for this helper to be promoted out of the
  // Incidents screen so future scrolling screens don't get the
  // marker-budget arithmetic wrong. The cases below pin the contract:
  //   - fits-entirely:        budget rows, no markers.
  //   - overflow-below-only:  N-1 content rows + `▾` = budget.
  //   - overflow-above-only:  `▴` + N-1 content rows = budget.
  //   - overflow-both:        `▴` + N-2 content rows + `▾` = budget.
  //   - exact-fit edge:       budget rows, no markers.
  //   - just-over edge:       markers reappear when content > budget.
  //   - empty / zero-budget:  empty result.

  it("returns all rows with no markers when content fits the budget", () => {
    const rows = ["a", "b", "c", "d", "e"];
    const out = scrollWindowWithMarkers(rows, 0, 7);
    expect(out).toEqual(["a", "b", "c", "d", "e"]);
    expect(out.length).toBe(5);
    expect(out.includes("▴")).toBe(false);
    expect(out.includes("▾")).toBe(false);
  });

  it("shows 6 rows + `▾` when content overflows below (idx 0, 10 rows, budget 7)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const out = scrollWindowWithMarkers(rows, 0, 7);
    expect(out.length).toBe(7);
    expect(out[out.length - 1]).toBe("▾");
    expect(out.includes("▴")).toBe(false);
    // 6 content rows, then the marker.
    expect(out.slice(0, 6)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("shows `▴` + 6 rows when content overflows above (idx 9, 10 rows, budget 7)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const out = scrollWindowWithMarkers(rows, 9, 7);
    expect(out.length).toBe(7);
    expect(out[0]).toBe("▴");
    expect(out.includes("▾")).toBe(false);
    // After the marker: the 6 trailing content rows.
    expect(out.slice(1)).toEqual(["r4", "r5", "r6", "r7", "r8", "r9"]);
  });

  it("shows `▴` + 5 rows + `▾` when content overflows in both directions (idx 5, 10 rows, budget 7)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const out = scrollWindowWithMarkers(rows, 5, 7);
    expect(out.length).toBe(7);
    expect(out[0]).toBe("▴");
    expect(out[out.length - 1]).toBe("▾");
    // 5 content rows between the markers.
    expect(out.slice(1, -1).length).toBe(5);
  });

  it("returns 7 rows exactly with no markers at the exact-fit edge (7 rows, budget 7)", () => {
    const rows = Array.from({ length: 7 }, (_, i) => `r${i}`);
    const out = scrollWindowWithMarkers(rows, 0, 7);
    expect(out.length).toBe(7);
    expect(out.includes("▴")).toBe(false);
    expect(out.includes("▾")).toBe(false);
    expect(out).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
  });

  it("markers reappear when content is just one row over budget (8 rows, budget 7)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => `r${i}`);
    const out = scrollWindowWithMarkers(rows, 0, 7);
    expect(out.length).toBe(7);
    expect(out[out.length - 1]).toBe("▾");
    expect(out.includes("▴")).toBe(false);
    expect(out.slice(0, 6)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("returns [] for an empty rows list at any budget", () => {
    expect(scrollWindowWithMarkers([], 0, 7)).toEqual([]);
    expect(scrollWindowWithMarkers([], 5, 1)).toEqual([]);
  });

  it("returns [] for a zero budget", () => {
    expect(scrollWindowWithMarkers(["a", "b", "c"], 0, 0)).toEqual([]);
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

describe("wrapText", () => {
  it("returns an empty array for empty input", () => {
    expect(wrapText("", 24, 3)).toEqual([]);
    expect(wrapText("   ", 24, 3)).toEqual([]);
  });

  it("returns an empty array when the budget is non-positive", () => {
    expect(wrapText("hello world", 0, 3)).toEqual([]);
    expect(wrapText("hello world", 24, 0)).toEqual([]);
  });

  it("returns a single line when the text fits", () => {
    expect(wrapText("hello world", 24, 3)).toEqual(["hello world"]);
  });

  it("wraps at word boundaries when the text overflows one line", () => {
    const out = wrapText(
      "Single-tracking on RD between Foggy Bottom and Rosslyn",
      24,
      4,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThanOrEqual(4);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(24);
    // No information lost: every word from the input appears across
    // the wrapped lines (in order).
    expect(out.join(" ")).toContain("Single-tracking");
    expect(out.join(" ")).toContain("Rosslyn");
  });

  it("packs words greedily — never leaves a line shorter than necessary", () => {
    // "a a a a" (7 chars) all fits on one 7-col line; we should NOT
    // pre-emptively break.
    expect(wrapText("a a a a", 7, 3)).toEqual(["a a a a"]);
    // At 5 cols "a a a" (5) fits, "a" is the overflow → 2 lines.
    expect(wrapText("a a a a", 5, 3)).toEqual(["a a a", "a"]);
  });

  it("hard-breaks a single word longer than the line width", () => {
    // "abcdefghij" (10 chars) at width=4 -> "abcd","efgh","ij"
    expect(wrapText("abcdefghij", 4, 5)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("appends the canonical ellipsis when content overflows maxLines", () => {
    const out = wrapText(
      "one two three four five six seven eight nine ten",
      6,
      2,
    );
    expect(out.length).toBe(2);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(6);
    // The last line ends with "…" to signal "more content was
    // dropped" — without this, the user has no signal that the
    // message was cut.
    expect(out[1]!.endsWith(ELLIPSIS)).toBe(true);
  });

  it("does NOT append ellipsis when the entire input fits", () => {
    const out = wrapText("hello world", 6, 3);
    expect(out.join("")).not.toContain(ELLIPSIS);
  });
});
