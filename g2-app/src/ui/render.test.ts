// Unit tests for the pure-function layout primitives in render.ts. The
// goal here is exhaustive: any regression in a formatter must break the
// suite, because the on-glasses UI has no other safety net.

import { describe, expect, it } from "vitest";
import {
  ELLIPSIS,
  SCREEN_HEIGHT_PX,
  SCREEN_WIDTH_PX,
  SPACE_PX,
  highlightPrefix,
  padLeft,
  padRight,
  row,
  scrollWindow,
  scrollWindowWithMarkers,
  textWidth,
  truncate,
  withEdgeMarkers,
  wrapText,
} from "./render";
import { SECTION_INNER_WIDTH_PX, TWO_BODY_MAX_LINES } from "./geometry";

describe("panel constants", () => {
  it("matches the 576x288 G2 panel", () => {
    expect(SCREEN_WIDTH_PX).toBe(576);
    expect(SCREEN_HEIGHT_PX).toBe(288);
  });

  it("exposes a positive space advance and a body inner width under the panel", () => {
    expect(SPACE_PX).toBeGreaterThan(0);
    expect(SECTION_INNER_WIDTH_PX).toBeGreaterThan(0);
    expect(SECTION_INNER_WIDTH_PX).toBeLessThan(SCREEN_WIDTH_PX);
  });
});

describe("truncate", () => {
  it("returns '' for empty input", () => {
    expect(truncate("", 500)).toBe("");
  });

  it("returns '' for a non-positive pixel budget", () => {
    expect(truncate("hello", 0)).toBe("");
    expect(truncate("hello", -1)).toBe("");
  });

  it("returns the text unchanged when it already fits", () => {
    expect(truncate("hello", SECTION_INNER_WIDTH_PX)).toBe("hello");
  });

  it("truncates with an ellipsis and never exceeds the pixel budget", () => {
    const long = "Foggy Bottom-GWU station entrance closed for repairs";
    const budget = 120;
    const out = truncate(long, budget);
    expect(out).not.toBe(long);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(textWidth(out)).toBeLessThanOrEqual(budget);
  });

  it("returns '' when not even the ellipsis fits", () => {
    // The ellipsis glyph alone is wider than a 1px budget.
    expect(truncate("hello", 1)).toBe("");
  });
});

describe("padRight", () => {
  it("returns '' when the target width is non-positive", () => {
    expect(padRight("hi", 0)).toBe("");
  });

  it("pads with trailing spaces to approximately the target pixel width", () => {
    const out = padRight("hi", 100);
    expect(out.startsWith("hi")).toBe(true);
    expect(out.length).toBeGreaterThan(2); // trailing spaces were added
    // Space granularity means we land within half a space of target.
    expect(Math.abs(textWidth(out) - 100)).toBeLessThanOrEqual(SPACE_PX);
  });

  it("truncates within budget when the text is wider than the target", () => {
    const out = padRight("overflowing station name", 60);
    expect(textWidth(out)).toBeLessThanOrEqual(60);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
  });
});

describe("padLeft", () => {
  it("returns '' when the target width is non-positive", () => {
    expect(padLeft("hi", 0)).toBe("");
  });

  it("right-aligns by padding leading spaces to ~target pixel width", () => {
    const out = padLeft("hi", 100);
    expect(out.endsWith("hi")).toBe(true);
    expect(out.startsWith(" ")).toBe(true);
    expect(Math.abs(textWidth(out) - 100)).toBeLessThanOrEqual(SPACE_PX);
  });

  it("drops glyphs from the left when the text is wider than the target", () => {
    const out = padLeft("123456789", 20);
    expect(textWidth(out)).toBeLessThanOrEqual(20);
    // Keeps the tail (right-aligned numeric field).
    expect("123456789".endsWith(out)).toBe(true);
  });
});

describe("row", () => {
  it("composes cells padded to their pixel widths, space-separated", () => {
    const r = row(["RD", "ARR"], [60, 80]);
    expect(r.startsWith("RD")).toBe(true);
    expect(r).toContain("ARR");
    // Total stays within the column budgets plus the separator, allowing
    // for space-padding granularity.
    expect(textWidth(r)).toBeLessThanOrEqual(60 + 80 + 2 * SPACE_PX);
  });

  it("truncates an over-wide cell within its column budget", () => {
    const r = row(["Anacostia-very-long", "ARR"], [40, 40]);
    expect(textWidth(r)).toBeLessThanOrEqual(40 + 40 + 2 * SPACE_PX);
  });

  it("throws when the total exceeds the section inner width", () => {
    expect(() =>
      row(["x", "y"], [SECTION_INNER_WIDTH_PX, SECTION_INNER_WIDTH_PX]),
    ).toThrow(/exceeds/);
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

  it("defaults maxRows to the two-section body budget when not provided", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const w = scrollWindow(rows, 0);
    expect(w.lines.length).toBe(TWO_BODY_MAX_LINES);
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
  it("returns an empty array for empty / whitespace input", () => {
    expect(wrapText("", 200, 3)).toEqual([]);
    expect(wrapText("   ", 200, 3)).toEqual([]);
  });

  it("returns an empty array when the budget is non-positive", () => {
    expect(wrapText("hello world", 0, 3)).toEqual([]);
    expect(wrapText("hello world", 200, 0)).toEqual([]);
  });

  it("returns a single line when the text fits the pixel budget", () => {
    expect(wrapText("hello world", SECTION_INNER_WIDTH_PX, 3)).toEqual([
      "hello world",
    ]);
  });

  it("wraps at word boundaries; every line fits the pixel budget", () => {
    const maxPx = 150;
    const out = wrapText(
      "Single-tracking on RD between Foggy Bottom and Rosslyn",
      maxPx,
      6,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThanOrEqual(6);
    for (const line of out) expect(textWidth(line)).toBeLessThanOrEqual(maxPx);
    // No information lost: words survive across the wrapped lines.
    expect(out.join(" ")).toContain("Single-tracking");
    expect(out.join(" ")).toContain("Rosslyn");
  });

  it("hard-breaks a single word wider than the budget into fitting pieces", () => {
    const maxPx = 40;
    const out = wrapText("supercalifragilisticexpialidocious", maxPx, 8);
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(textWidth(line)).toBeLessThanOrEqual(maxPx);
  });

  it("appends the canonical ellipsis when content overflows maxLines", () => {
    const maxPx = 60;
    const out = wrapText(
      "one two three four five six seven eight nine ten",
      maxPx,
      2,
    );
    expect(out.length).toBe(2);
    for (const line of out) expect(textWidth(line)).toBeLessThanOrEqual(maxPx);
    expect(out[out.length - 1]!.endsWith(ELLIPSIS)).toBe(true);
  });

  it("does NOT append ellipsis when the entire input fits", () => {
    const out = wrapText("hello world", SECTION_INNER_WIDTH_PX, 3);
    expect(out.join("")).not.toContain(ELLIPSIS);
  });
});
