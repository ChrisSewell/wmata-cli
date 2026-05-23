// Unit tests for the Incidents screen.
//
// Acceptance contract:
//   - Every rendered line is ≤ LINE_WIDTH columns across every fixture.
//   - Empty state pins exactly 5 lines (header + 2 copy + spacer + cue).
//   - Short / long / multi-incident bodies fit the 7-row body budget,
//     with scrolling when the content exceeds it.
//   - Description wrapping is word-break-only, capped at MAX_DESC_LINES,
//     with `…` on the last line when truncated.
//   - Edge markers (▴/▾) consume from the 7-row body budget when
//     present.
//   - Reducer: SCROLL_UP/SCROLL_DOWN move the scroll offset (clamped);
//     TAP is a no-op; DOUBLE_TAP navigates to Home.
//   - Stale marker (`*`) follows the 120s threshold using `ctx.nowMs`.
//   - First-load fetch error renders a "Couldn't reach WMATA" body
//     instead of the empty-state copy.

import { describe, expect, it } from "vitest";
import { ELLIPSIS, textWidth } from "../ui/render";
import { SECTION_INNER_WIDTH_PX, TWO_BODY_MAX_LINES } from "../ui/geometry";
import type { RailIncident } from "../wmata";
import {
  flattenSections, initialNav, type ViewContext } from "./router";
import {
  MAX_DESC_LINES,
  STALE_THRESHOLD_MS,
  TICK_INTERVAL_MS,
  capDescription,
  computeUserLines,
  flattenBlocks,
  formatIncidentBlock,
  isStale,
  makeIncidentsScreen,
  makeInitialIncidentsSnapshot,
  renderGlyphRow,
  renderHeader,
  stalenessMarker,
  trimTrailingSeparators,
  wrap,
  type IncidentsFetchResult,
  type IncidentsSnapshot,
} from "./incidents";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function expectFits(lines: string[]): void {
  for (const line of lines) {
    expect(textWidth(line)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  }
}

/** Pixel budget used to exercise the (now pixel-based) `wrap` helper. */
const WRAP_BUDGET_PX = 150;

/** Fixed wall clock — May 18 2026 14:32 local. */
const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();

const CTX: ViewContext = { nowMs: NOW };

function incident(over: Partial<RailIncident> = {}): RailIncident {
  return {
    IncidentID: "id-1",
    Description: "Single-tracking between Foggy Bottom and Rosslyn.",
    IncidentType: "Delay",
    LinesAffected: "BL; OR; SV;",
    DateUpdated: "2026-05-18T14:30:00",
    ...over,
  };
}

function makeSnap(
  incidents: RailIncident[],
  over: Partial<IncidentsSnapshot> = {},
): IncidentsSnapshot {
  return {
    incidents,
    fetchedAt: NOW,
    fetchError: null,
    consecutiveFetchFailures: 0,
    preformatted: incidents.map(formatIncidentBlock),
    ...over,
  };
}

const noopFetcher = (): Promise<IncidentsFetchResult> =>
  Promise.resolve({ incidents: [], fetchedAt: NOW, fetchError: null });

// ---------------------------------------------------------------------------
// wrap() — pure helper
// ---------------------------------------------------------------------------

describe("wrap", () => {
  it("returns [] for empty input", () => {
    expect(wrap("", WRAP_BUDGET_PX)).toEqual([]);
  });

  it("greedily packs words into width-bounded lines", () => {
    const out = wrap(
      "Single-tracking between Foggy Bottom and Rosslyn.",
      WRAP_BUDGET_PX,
    );
    expect(out.length).toBeGreaterThan(1);
    for (const l of out) expect(textWidth(l)).toBeLessThanOrEqual(WRAP_BUDGET_PX);
    // Each consecutive pair must not have been combinable into one line:
    // i.e. previous + " " + next-first-word would have exceeded the budget.
    for (let i = 1; i < out.length; i++) {
      const merged = out[i - 1]! + " " + out[i]!.split(" ")[0]!;
      expect(textWidth(merged)).toBeGreaterThan(WRAP_BUDGET_PX);
    }
    // No information lost: the words survive across the wrapped lines.
    expect(out.join(" ")).toContain("Single-tracking");
    expect(out.join(" ")).toContain("Rosslyn");
  });

  it("hard-breaks a word wider than the budget with a `…` continuation marker", () => {
    const monster = "Antidisestablishmentarianism";
    const out = wrap(monster, 40);
    expect(out.length).toBeGreaterThan(1);
    for (const l of out) expect(textWidth(l)).toBeLessThanOrEqual(40);
    // First (and any intermediate) chunks end with the ellipsis.
    expect(out[0]!.endsWith(ELLIPSIS)).toBe(true);
  });

  it("collapses runs of whitespace into single spaces", () => {
    const out = wrap("a  b\t\nc", WRAP_BUDGET_PX);
    expect(out).toEqual(["a b c"]);
  });

  it("returns [] at a degenerate 1px budget (avoids infinite-loop)", () => {
    // Not even the continuation ellipsis fits at 1px, so the hard-break
    // loop bails rather than spinning. Callers always pass a real pixel
    // budget; this guard makes the helper safe with a degenerate one.
    expect(wrap("Antidisestablishmentarianism", 1)).toEqual([]);
  });

  it("returns [] at a 0px budget as well", () => {
    expect(wrap("anything at all", 0)).toEqual([]);
  });

  it("hard-breaks a giant word and then continues with following words on subsequent lines", () => {
    // The hard-break path should leave the residue word in `current`
    // (no trailing ellipsis on the last chunk) and the next short
    // words must pack onto the line normally.
    const out = wrap("Antidisestablishmentarianism more text", WRAP_BUDGET_PX);
    expect(out.length).toBeGreaterThan(1);
    for (const l of out) expect(textWidth(l)).toBeLessThanOrEqual(WRAP_BUDGET_PX);
    // The first chunk is a hard-broken prefix of the giant word, marked
    // with the continuation ellipsis.
    expect(out[0]!.endsWith(ELLIPSIS)).toBe(true);
    expect("Antidisestablishmentarianism".startsWith(out[0]!.slice(0, -1))).toBe(
      true,
    );
    // Subsequent lines must contain the trailing short words.
    const tail = out.slice(1).join(" ");
    expect(tail).toContain("more");
    expect(tail).toContain("text");
  });
});

// ---------------------------------------------------------------------------
// capDescription
// ---------------------------------------------------------------------------

describe("capDescription", () => {
  it("returns the input as-is when it's at or below MAX_DESC_LINES", () => {
    const lines = ["a", "b", "c"];
    expect(capDescription(lines)).toEqual(lines);
  });

  it("truncates to MAX_DESC_LINES with `…` on the last line when too long", () => {
    const lines = Array.from({ length: MAX_DESC_LINES + 3 }, (_, i) => `line${i}`);
    const out = capDescription(lines);
    expect(out.length).toBe(MAX_DESC_LINES);
    expect(out[MAX_DESC_LINES - 1]!.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderGlyphRow
// ---------------------------------------------------------------------------

describe("renderGlyphRow", () => {
  it("renders 1-4 codes verbatim with the `! ` warning prefix", () => {
    expect(renderGlyphRow(["RD"])).toBe("RED");
    expect(renderGlyphRow(["RD", "BL"])).toBe("RED BLUE");
    expect(renderGlyphRow(["RD", "BL", "OR"])).toBe("RED BLUE ORANGE");
    expect(renderGlyphRow(["RD", "BL", "OR", "SV"])).toBe("RED BLUE ORANGE SILVER");
  });

  it("collapses 5+ codes to `+N`", () => {
    expect(renderGlyphRow(["RD", "BL", "YL", "OR", "GR"])).toBe(
      "RED BLUE YELLOW ORANGE +1",
    );
  });

  it("renders `! --` when no codes are present", () => {
    expect(renderGlyphRow([])).toBe("--");
  });
});

// ---------------------------------------------------------------------------
// formatIncidentBlock
// ---------------------------------------------------------------------------

describe("formatIncidentBlock", () => {
  it("emits a glyph row + wrapped description lines", () => {
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;", Description: "Hello world." }),
    );
    expect(block[0]).toBe("BLUE");
    // Trailing period is stripped from the final fragment line.
    expect(block.slice(1).join(" ")).toContain("Hello world");
  });

  it("drops the description block when Description is empty", () => {
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;", Description: "" }),
    );
    expect(block).toEqual(["BLUE"]);
  });

  it("drops the description block when Description is whitespace-only", () => {
    // After trim() the string is empty, so we render just the glyph
    // row — no all-blank description rows leaking into the body.
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;", Description: "   \t  " }),
    );
    expect(block).toEqual(["BLUE"]);
  });

  it("does not crash when Description is null (defensive)", () => {
    // The wire type is `string`, but a defensive guard against
    // corrupted upstream data keeps the screen from blanking. The
    // result is a single glyph row, no description.
    const inc = incident({ LinesAffected: "BL;" });
    const corrupted = {
      ...inc,
      Description: null,
    } as unknown as RailIncident;
    expect(formatIncidentBlock(corrupted)).toEqual(["BLUE"]);
  });

  it("does not crash when Description is undefined (defensive)", () => {
    const inc = incident({ LinesAffected: "BL;" });
    const corrupted = {
      ...inc,
      Description: undefined,
    } as unknown as RailIncident;
    expect(formatIncidentBlock(corrupted)).toEqual(["BLUE"]);
  });

  it("silently drops unknown line codes from the glyph row", () => {
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;XX;SV;", Description: "" }),
    );
    expect(block).toEqual(["BLUE SILVER"]);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("treats a never-fetched snapshot as stale", () => {
    expect(isStale(makeSnap([], { fetchedAt: 0 }), NOW)).toBe(true);
  });

  it("is fresh inside the 2-minute threshold", () => {
    expect(isStale(makeSnap([], { fetchedAt: NOW - 10_000 }), NOW)).toBe(false);
  });

  it("goes stale just past the 2-minute threshold", () => {
    expect(
      isStale(makeSnap([], { fetchedAt: NOW - (STALE_THRESHOLD_MS + 1) }), NOW),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderHeader
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  // The header is now the section TITLE ONLY — the host renders the wall
  // clock + staleness marker in its own dedicated top-right container, so
  // neither appears in the header string. The marker is asserted via
  // `view(...).clockMarker` in the dedicated block below.
  it("renders `ALERTS (n)` as the title only (no clock)", () => {
    const out = renderHeader(makeSnap([incident()]));
    expect(out).toBe("ALERTS (1)");
    expect(out).not.toContain(":");
  });

  it("renders `ALERTS` (no count) when there are 0 incidents", () => {
    const out = renderHeader(makeSnap([]));
    expect(out).toBe("ALERTS");
    expect(out).not.toContain("(0)");
  });

  it("does not embed a stale marker even when older than STALE_THRESHOLD_MS", () => {
    const out = renderHeader(
      makeSnap([incident()], { fetchedAt: NOW - (STALE_THRESHOLD_MS + 5_000) }),
    );
    expect(out).toBe("ALERTS (1)");
    expect(out).not.toContain("*");
  });

  it("keeps the title within the header pixel budget at n=999 (three-digit count)", () => {
    const incs = Array.from({ length: 999 }, (_, i) =>
      incident({ IncidentID: `${i}` }),
    );
    const out = renderHeader(makeSnap(incs));
    expect(out).toBe("ALERTS (999)");
    expect(textWidth(out)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  });
});

// ---------------------------------------------------------------------------
// view().clockMarker — staleness escalation now rides the host clock cell
// ---------------------------------------------------------------------------

describe("incidents view: clockMarker staleness escalation", () => {
  const markerFor = (
    incidents: RailIncident[],
    over: Partial<IncidentsSnapshot>,
    nowMs = NOW,
  ): string | undefined => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incidents, over));
    return screen.view(screen.init(), initialNav(), { nowMs }).clockMarker;
  };

  it("is empty for fresh data with no failures", () => {
    expect(markerFor([incident()], { fetchedAt: NOW })).toBe("");
  });

  it("is '*' when the snapshot is older than STALE_THRESHOLD_MS", () => {
    expect(
      markerFor([incident()], { fetchedAt: NOW - (STALE_THRESHOLD_MS + 5_000) }),
    ).toBe("*");
  });

  it("is '*' / '**' / '?' as consecutive fetch failures escalate", () => {
    expect(
      markerFor([incident()], { consecutiveFetchFailures: 1, fetchError: "x" }),
    ).toBe("*");
    expect(
      markerFor([incident()], { consecutiveFetchFailures: 2, fetchError: "x" }),
    ).toBe("**");
    expect(
      markerFor([incident()], { consecutiveFetchFailures: 3, fetchError: "x" }),
    ).toBe("?");
  });

  // Sanity: the view marker matches the standalone `stalenessMarker`.
  it("matches the standalone stalenessMarker helper", () => {
    const over = { consecutiveFetchFailures: 2, fetchError: "x" };
    const snap = makeSnap([incident()], over);
    expect(markerFor([incident()], over)).toBe(stalenessMarker(snap, NOW));
  });
});

// ---------------------------------------------------------------------------
// View — empty state (Test #1)
// ---------------------------------------------------------------------------

describe("incidents view: empty state", () => {
  it("pins EXACTLY 4 lines for the friendly empty-state copy", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap([]));
    const sections = screen.view(screen.init(), initialNav(), CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    // Header is now the bare title — the host renders the clock in its
    // own container, so the flattened view output has no clock.
    expect(lines).toEqual([
      "ALERTS",
      "All your lines running normally.",
      "",
      "(double-tap to return)",
    ]);
    expect(lines.length).toBe(4);
    // Fresh data → no staleness marker on the host clock cell.
    expect(sections.clockMarker).toBe("");
  });
});

// ---------------------------------------------------------------------------
// View — 1 incident, short description (Test #2)
// ---------------------------------------------------------------------------

describe("incidents view: 1 incident, short description", () => {
  it("fits within the body row budget, no scroll, no edge markers", () => {
    const incs = [
      incident({ LinesAffected: "BL;", Description: "Train OK." }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines.length).toBe(3); // header + glyph row + 1-line description
    expect(lines.some((l) => l === "▴")).toBe(false);
    expect(lines.some((l) => l === "▾")).toBe(false);
    expect(lines[1]).toBe("  BLUE");
    // Description has a 2-char inner inset (so the section gutter
    // plus the inset is 4 chars). The trailing period is stripped so
    // the fragment doesn't read as a clipped sentence.
    expect(lines[2]).toBe("    Train OK");
  });
});

// ---------------------------------------------------------------------------
// View — 1 incident, long description (Test #3)
// ---------------------------------------------------------------------------

describe("incidents view: 1 incident, very long description", () => {
  it("wraps to ≤ MAX_DESC_LINES lines and ends the last line with `…` when cut", () => {
    // Description deliberately long enough to overflow the MAX_DESC_LINES
    // cap at the current description wrap pixel budget (the body inner
    // width minus the section gutter and the inner inset).
    const long =
      "Single tracking between Foggy Bottom and Rosslyn due to a disabled train. " +
      "Expect significant delays on Orange, Blue, and Silver Line trains for the next two hours. " +
      "Shuttle buses are available at Court House, Clarendon, and Ballston for affected riders. " +
      "Customers travelling toward Largo Town Center should consider rerouting via Yellow Line. " +
      "Additional service disruptions may affect the Blue Line at Pentagon City and Crystal City.";
    const incs = [incident({ Description: long })];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    // The visible body lines that look like description (not the glyph
    // row, not the header, not edge markers) cap at MAX_DESC_LINES.
    const block = formatIncidentBlock(incs[0]!);
    // First entry is the glyph row; the rest are description lines.
    expect(block.length - 1).toBe(MAX_DESC_LINES);
    // The last description line should end with the ellipsis.
    expect(block[block.length - 1]!.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// View — 5 incidents, scrolling required (Tests #4, #5, #6, #7)
// ---------------------------------------------------------------------------

/**
 * Fixture: 5 incidents, each with a short single-line description so we
 * deterministically know the body layout:
 *
 *   [glyph][desc][BLANK][glyph][desc][BLANK][glyph][desc][BLANK][glyph][desc][BLANK][glyph][desc]
 *
 * = 5*2 + 4 = 14 body rows. With the two-section body budget
 * (`TWO_BODY_MAX_LINES`) plus room for edge markers, scrolling is
 * required and the `▾` arrow must show on the initial render.
 */
const FIVE_INCIDENTS: RailIncident[] = [
  incident({ IncidentID: "1", LinesAffected: "RD;", Description: "Inc one." }),
  incident({ IncidentID: "2", LinesAffected: "BL;", Description: "Inc two." }),
  incident({ IncidentID: "3", LinesAffected: "OR;", Description: "Inc three." }),
  incident({ IncidentID: "4", LinesAffected: "SV;", Description: "Inc four." }),
  incident({ IncidentID: "5", LinesAffected: "YL;", Description: "Inc five." }),
];

describe("incidents view: 5 incidents — scrolling required", () => {
  it("initial render: `▾` is present, `▴` is not", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    // Header + the two-section body row budget.
    expect(lines.length).toBe(1 + TWO_BODY_MAX_LINES);
    expect(lines.some((l) => l === "▾")).toBe(true);
    expect(lines.some((l) => l === "▴")).toBe(false);
  });

  it("scrolling down shifts the visible window, surfacing `▴`", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    // Push the offset deep enough that content above is hidden.
    let nav = initialNav();
    for (let i = 0; i < 10; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
    const lines = flattenSections(screen.view(screen.init(), nav, CTX));
    expectFits(lines);
    expect(lines.some((l) => l === "▴")).toBe(true);
  });

  it("scroll past the end is a no-op (bottom-edge clamp)", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    let nav = initialNav();
    // Drive ~50 scroll downs to exceed any reasonable body length.
    for (let i = 0; i < 50; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
    // Body length for FIVE_INCIDENTS:
    //   5 incidents × 2 lines + 4 separators = 14 rows.
    expect(nav.highlightedIndex).toBe(13);
  });

  it("scroll up past the start is a no-op (top-edge clamp)", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    let nav = initialNav();
    for (let i = 0; i < 50; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_UP" }).nav;
    }
    expect(nav.highlightedIndex).toBe(0);
  });

  it("a mid-list scroll position shows BOTH `▴` and `▾` simultaneously", () => {
    // FIVE_INCIDENTS yields 14 body rows. After enough SCROLL_DOWNs the
    // window sits in the middle of the body (content hidden both above
    // and below), so both edge markers must be present in the same frame.
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    let nav = initialNav();
    for (let i = 0; i < 8; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
    const lines = flattenSections(screen.view(screen.init(), nav, CTX));
    expectFits(lines);
    expect(lines.some((l) => l === "▴")).toBe(true);
    expect(lines.some((l) => l === "▾")).toBe(true);
    // Whole frame still fits the budget: header + the body row budget.
    expect(lines.length).toBe(1 + TWO_BODY_MAX_LINES);
  });
});

// ---------------------------------------------------------------------------
// View — incident with unknown line codes (Test #8)
// ---------------------------------------------------------------------------

describe("incidents view: unknown LineCodes drop silently", () => {
  it("only valid LineCodes render in the glyph row", () => {
    const incs = [
      incident({
        IncidentID: "1",
        LinesAffected: "BL;XX;SV;QQ;",
        Description: "Test.",
      }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    // The glyph row (the body row that starts with `BLUE`) should not
    // contain the unknown codes XX or QQ.
    const glyphRow = lines.find((l) => l.trimStart().startsWith("BLUE"));
    expect(glyphRow).toBeDefined();
    expect(glyphRow).not.toContain("XX");
    expect(glyphRow).not.toContain("QQ");
    expect(glyphRow).toContain("BLUE");
    expect(glyphRow).toContain("SILVER");
  });
});

// ---------------------------------------------------------------------------
// Stale marker uses ctx.nowMs (Test #9)
// ---------------------------------------------------------------------------

describe("incidents view: stale marker uses ctx.nowMs", () => {
  it("surfaces `*` via clockMarker when fetchedAt is 130s in the past", () => {
    const T = NOW;
    const snap = makeSnap([incident()], { fetchedAt: T - 130_000 });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    // The marker now rides the host clock cell (`clockMarker`), driven by
    // `ctx.nowMs`, not the header string.
    const sections = screen.view(screen.init(), initialNav(), { nowMs: T });
    expectFits(flattenSections(sections));
    expect(sections.clockMarker).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// First-load fetch error renders a distinct body (Test #10)
// ---------------------------------------------------------------------------

describe("incidents view: first-load fetch error", () => {
  it("renders `Couldn't reach WMATA` instead of the empty-state copy", () => {
    const snap = makeSnap([], {
      fetchedAt: 0,
      fetchError: "Could not connect.",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines.some((l) => l.includes("Couldn't reach WMATA"))).toBe(true);
    expect(lines.some((l) => l.includes("No active alerts"))).toBe(false);
  });

  it("pins the EXACT 4-line first-load error body", () => {
    // Symmetric with the empty-state pin: lock the lines verbatim so a
    // future copy change has to update this test on purpose. The
    // `clockMarker` carries a `?` because fetchedAt=0 with an active
    // error is the strongest degraded state — see `stalenessMarker`.
    const snap = makeSnap([], {
      fetchedAt: 0,
      fetchError: "Could not connect.",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const sections = screen.view(screen.init(), initialNav(), CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    expect(lines).toEqual([
      "ALERTS",
      "Couldn't reach WMATA. Will retry shortly.",
      "",
      "(double-tap to return)",
    ]);
    expect(lines.length).toBe(4);
    expect(sections.clockMarker).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// 3-state stale-marker escalation
// ---------------------------------------------------------------------------

describe("incidents view: stale-marker escalation", () => {
  // One incident in the snapshot so we exercise the "data exists, just
  // degrading" branches (the no-data + error case is locked above). The
  // marker rides `view(...).clockMarker` now, not the header string.
  const oneIncident = (): RailIncident => incident();
  const markerFor = (failures: number): string | undefined => {
    const snap = makeSnap([oneIncident()], {
      consecutiveFetchFailures: failures,
      fetchError: "transient",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    return screen.view(screen.init(), initialNav(), CTX).clockMarker;
  };

  it("shows '*' after one consecutive failure", () => {
    expect(markerFor(1)).toBe("*");
  });

  it("shows '**' after two consecutive failures", () => {
    expect(markerFor(2)).toBe("**");
  });

  it("shows '?' after three or more consecutive failures", () => {
    expect(markerFor(3)).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// Reducer — DOUBLE_TAP from any state -> home (Test #11)
// ---------------------------------------------------------------------------

describe("incidents reduce: DOUBLE_TAP returns to home", () => {
  it("returns `{ to: 'home' }` regardless of snapshot state", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap([]));
    for (const initial of [
      makeSnap([]),
      makeSnap(FIVE_INCIDENTS),
      makeSnap([], { fetchedAt: 0, fetchError: "boom" }),
    ]) {
      const r = screen.reduce(initial, initialNav(), { type: "DOUBLE_TAP" });
      expect(r.navigate).toEqual({ to: "home" });
    }
  });

  it("TAP is a no-op (read-only screen)", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toBeUndefined();
    expect(r.nav).toEqual(initialNav());
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: 1 incident, 3-line description (Test #12)
// ---------------------------------------------------------------------------

describe("incidents view snapshot: 1 incident with a multi-line desc", () => {
  it("matches the exact line array", () => {
    const incs = [
      incident({
        IncidentID: "1",
        LinesAffected: "BL; OR; SV;",
        Description:
          "Single-tracking between Foggy Bottom and Rosslyn due to a disabled train.",
      }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const sections = screen.view(screen.init(), initialNav(), CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    // The wrapper packs greedily into pixel-budgeted lines. We assert the
    // exact rendered lines explicitly so a future change to the wrap rules
    // surfaces as a test failure. The header is now the bare title — the
    // host renders the clock in its own container.
    expect(lines).toEqual([
      "ALERTS (1)",
      "  BLUE ORANGE SILVER",
      "    Single-tracking between Foggy Bottom and Rosslyn due to a",
      "    disabled train",
    ]);
    expect(sections.clockMarker).toBe("");
  });
});

// ---------------------------------------------------------------------------
// tick(): success + error paths
// ---------------------------------------------------------------------------

describe("incidents tick", () => {
  it("folds a successful fetch into the snapshot and rebuilds preformatted", async () => {
    const incs = [incident({ LinesAffected: "RD;", Description: "Hi." })];
    const fetcher = () =>
      Promise.resolve<IncidentsFetchResult>({
        incidents: incs,
        fetchedAt: NOW,
        fetchError: null,
      });
    const screen = makeIncidentsScreen(fetcher, makeSnap([]));
    const next = await screen.tick(screen.init());
    expect(next.incidents).toEqual(incs);
    expect(next.fetchError).toBeNull();
    expect(next.preformatted.length).toBe(1);
    expect(next.preformatted[0]![0]).toBe("RED");
  });

  it("never throws: a rejected fetcher stores the error on the snapshot", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makeIncidentsScreen(fetcher, makeSnap([incident()]));
    const next = await screen.tick(screen.init());
    expect(next.fetchError).toBe("boom");
    // Prior incidents are preserved.
    expect(next.incidents.length).toBe(1);
  });

  it("increments consecutiveFetchFailures on each rejected fetcher", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makeIncidentsScreen(fetcher, makeSnap([incident()]));
    let s = screen.init();
    expect(s.consecutiveFetchFailures).toBe(0);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(1);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(2);
  });

  it("treats a fetcher result with fetchError !== null as a failure", async () => {
    // The session-backed fetcher swallows network errors and surfaces
    // them through the result shape rather than throwing. The tick
    // must still treat that as a failure for the escalation counter.
    const fetcher = () =>
      Promise.resolve<IncidentsFetchResult>({
        incidents: [],
        fetchedAt: 0,
        fetchError: "swallowed network error",
      });
    const screen = makeIncidentsScreen(fetcher, makeSnap([]));
    let s = screen.init();
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(1);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(2);
  });

  it("resets consecutiveFetchFailures to 0 on a successful fetch", async () => {
    const successfulFetcher = () =>
      Promise.resolve<IncidentsFetchResult>({
        incidents: [],
        fetchedAt: NOW,
        fetchError: null,
      });
    const screen = makeIncidentsScreen(
      successfulFetcher,
      makeSnap([], { consecutiveFetchFailures: 3 }),
    );
    const next = await screen.tick(screen.init());
    expect(next.consecutiveFetchFailures).toBe(0);
    expect(next.fetchError).toBeNull();
  });

  it("exposes a tickIntervalMs of 60_000 (60s) for the host", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap([]));
    expect(screen.tickIntervalMs).toBe(TICK_INTERVAL_MS);
    expect(screen.tickIntervalMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// computeUserLines + makeInitialIncidentsSnapshot
// ---------------------------------------------------------------------------

describe("computeUserLines", () => {
  it("collects unique line codes across the favorites", () => {
    const out = computeUserLines([
      { code: "A01", name: "Metro Center", lines: ["RD", "BL", "OR"] },
      { code: "B01", name: "Gallery Pl", lines: ["RD", "YL", "GR"] },
    ]);
    expect(new Set(out)).toEqual(new Set(["RD", "BL", "OR", "YL", "GR"]));
  });

  it("returns [] for no favorites", () => {
    expect(computeUserLines([])).toEqual([]);
  });
});

describe("makeInitialIncidentsSnapshot", () => {
  it("pre-formats every cached incident into a block", () => {
    const incs = [
      incident({ IncidentID: "1", LinesAffected: "RD;", Description: "Hi." }),
      incident({ IncidentID: "2", LinesAffected: "BL;", Description: "" }),
    ];
    const snap = makeInitialIncidentsSnapshot({
      incidents: incs,
      fetchedAt: NOW,
      fetchError: null,
    });
    expect(snap.preformatted.length).toBe(2);
    expect(snap.preformatted[0]![0]).toBe("RED");
    // Second incident has no description -> single-row block.
    expect(snap.preformatted[1]).toEqual(["BLUE"]);
  });
});

// ---------------------------------------------------------------------------
// flattenBlocks
// ---------------------------------------------------------------------------

describe("flattenBlocks", () => {
  it("indents each row with 2 spaces and inserts a blank-string separator between incidents", () => {
    const blocks = [
      ["! RD", "Inc one."],
      ["BL", "Inc two."],
    ];
    expect(flattenBlocks(blocks)).toEqual([
      "  ! RD",
      "  Inc one.",
      "",
      "  BL",
      "  Inc two.",
    ]);
  });

  it("emits no trailing separator on the last block", () => {
    const blocks = [["! RD"]];
    expect(flattenBlocks(blocks)).toEqual(["  ! RD"]);
  });
});

// ---------------------------------------------------------------------------
// trimTrailingSeparators
// ---------------------------------------------------------------------------

describe("trimTrailingSeparators", () => {
  it("strips a dangling comma / semicolon / period", () => {
    expect(trimTrailingSeparators("disabled train,")).toBe("disabled train");
    expect(trimTrailingSeparators("Train OK.")).toBe("Train OK");
    expect(trimTrailingSeparators("a; b;")).toBe("a; b");
  });
  it("leaves interior separators untouched", () => {
    expect(trimTrailingSeparators("plat, west side")).toBe("plat, west side");
  });
  it("strips trailing separators together with trailing whitespace", () => {
    expect(trimTrailingSeparators("foo , ")).toBe("foo");
  });
  it("returns the input unchanged when there's no trailing separator", () => {
    expect(trimTrailingSeparators("Rosslyn")).toBe("Rosslyn");
  });
});

// ---------------------------------------------------------------------------
// Overflow invariant: no rendered body line exceeds the section inner width
// ---------------------------------------------------------------------------

describe("incidents view: section-inner-width overflow invariant", () => {
  it("keeps every rendered body line at or below the section inner pixel width", () => {
    // Worst-case fixtures: a 4-line affected-lines header plus prose
    // long enough to exercise the greedy wrap. This is the regression
    // guard for the orphan-word overflow ("to a" / "crews" at col 0).
    const incs = [
      incident({
        IncidentID: "1",
        LinesAffected: "RD;",
        Description:
          "Trains single-tracking between Tenleytown and Bethesda due to a disabled train.",
      }),
      incident({
        IncidentID: "2",
        LinesAffected: "BL; OR; SV;",
        Description:
          "Trains experiencing delays approaching Foggy Bottom while crews clear an earlier mechanical problem near Rosslyn.",
      }),
      incident({
        IncidentID: "3",
        LinesAffected: "RD; BL; YL; OR;",
        Description: "Residual delays in both directions.",
      }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    // Walk the full scroll range so every body row is rendered at least
    // once across the windows. The header row (index 0) is excluded:
    // it carries the bare title and the host renders the clock in its own
    // container. Only real-text body rows must respect the pixel cap.
    let nav = initialNav();
    for (let step = 0; step < 30; step++) {
      const lines = flattenSections(screen.view(screen.init(), nav, CTX));
      for (const line of lines.slice(1)) {
        expect(textWidth(line)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
      }
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
  });
});
