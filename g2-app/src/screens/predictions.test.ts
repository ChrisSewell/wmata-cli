// Unit tests for the Predictions screen.
//
// Acceptance contract:
//   - Every rendered line fits the section inner pixel width across every fixture
//     (header, body, footer, empty state).
//   - Header renders short and long station names correctly, and shows
//     a stale marker (`*`) when the snapshot is older than STALE_THRESHOLD_MS
//     and a `?` marker when there is an active fetch error.
//   - Body rows fit 1, 3, 5 trains. 8+ trains collapse to the top 5 by
//     ETA without overflowing into the footer.
//   - ETA sentinels ("ARR", "BRD", "---", "") all render distinguishably.
//   - Reducer: SCROLL_UP / SCROLL_DOWN / TAP are no-ops; DOUBLE_TAP
//     navigates BACK to Home (not exit).
//   - tick() folds the fetcher result into a new snapshot and never
//     throws — fetch errors land in `fetchError`.
//   - The wall clock and stale check are driven by `ViewContext.nowMs`
//     (host-supplied), NOT by the snapshot. A hung fetch must not
//     freeze the on-glasses clock.

import { describe, expect, it, vi } from "vitest";
import { textWidth } from "../ui/render";
import {
  HEADER_CONTENT_WIDTH_PX,
  SECTION_INNER_WIDTH_PX,
} from "../ui/geometry";
import type { Train } from "../wmata";
import {
  flattenSections,
  initialNav,
  type ViewContext,
} from "./router";
import { mountGlassesScreen } from "./glasses-host";
import {
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import {
  LAST_TRAIN_HOUR,
  MAX_VISIBLE_TRAINS,
  STALE_THRESHOLD_MS,
  TICK_INTERVAL_MS,
  bucketLastTrainsByLine,
  findPinnedTrainIndex,
  formatClock,
  isStale,
  makePredictionsScreen,
  pickLastTrainTime,
  pinnedDistancePhrase,
  renderFooter,
  renderFooterQuiet,
  renderHeader,
  renderLastTrainRow,
  renderPinRow,
  renderPinnedSummary,
  renderTrainRow,
  shouldShowLastTrain,
  sortTrainsForDisplay,
  type PredictionsFetchResult,
  type PredictionsSnapshot,
} from "./predictions";
import type { NavIntent, Router } from "./router";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function expectFits(lines: string[]): void {
  for (const line of lines) {
    expect(textWidth(line)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  }
}

/**
 * Pixel bound for the LEFT body column (line glyph cell + destination).
 * The host overlays the value column flush-right starting near x≈466, so
 * every left cell must measure under that to never run beneath it.
 */
const LEFT_COL_MAX_PX = 466;

/**
 * Pixel bound for the RIGHT value overlay ("<cars> <eta>"). It's a short,
 * right-aligned cell; this generous bound guards against the value column
 * silently widening (the widest current value measures ≈ 89px).
 */
const VALUE_COL_MAX_PX = 100;

/** Construct a Train fixture with sensible defaults. */
function train(over: Partial<Train>): Train {
  return {
    Car: "6",
    Destination: "Shady Grove",
    DestinationCode: null,
    DestinationName: "Shady Grove",
    Group: "1",
    Line: "RD",
    LocationCode: "A01",
    LocationName: "Metro Center",
    Min: "5",
    ...over,
  };
}

/** A fixed wall clock — May 18 2026 14:32 local. */
const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();

/**
 * Standard `ViewContext` used by every `view(...)` call in this suite.
 * Held constant at `NOW` so the renders are deterministic; individual
 * tests that need a different time pass an inline override.
 */
const CTX: ViewContext = { nowMs: NOW };

function snap(over: Partial<PredictionsSnapshot>): PredictionsSnapshot {
  return {
    stationCode: "A01",
    stationName: "Metro Center",
    trains: [],
    fetchedAt: NOW,
    fetchError: null,
    consecutiveFetchFailures: 0,
    incidentHeadline: null,
    lastTrainToday: null,
    pinned: null,
    pinnedPosition: null,
    // WP-M default — cursor visible to keep the v1.2 tests
    // (cursor-on-row-0 expectations) passing. The first-mount
    // boot path in main.ts initialises this to false.
    cursorVisible: true,
    pinnedGone: false,
    ...over,
  };
}

/** A noop fetcher — handy for screens that we never tick in a test. */
const noopFetcher = (): Promise<PredictionsFetchResult> =>
  Promise.resolve({ trains: [], incidentHeadline: null, lastTrainToday: null, pinnedPosition: null });

// ---------------------------------------------------------------------------
// formatClock
// ---------------------------------------------------------------------------

describe("formatClock", () => {
  it("formats a real timestamp in 12-hour form with a single-letter suffix", () => {
    const t = new Date(2026, 4, 18, 9, 5, 0).getTime();
    expect(formatClock(t)).toBe(" 9:05a");
  });

  it("renders midnight as 12:00a and noon as 12:00p", () => {
    expect(formatClock(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe("12:00a");
    expect(formatClock(new Date(2026, 0, 1, 12, 0, 0).getTime())).toBe("12:00p");
  });

  it("renders PM hours past noon with 1-12 numbering", () => {
    expect(formatClock(new Date(2026, 4, 18, 14, 32, 0).getTime())).toBe(" 2:32p");
    expect(formatClock(new Date(2026, 4, 18, 23, 47, 0).getTime())).toBe("11:47p");
  });

  it("returns a stable placeholder for epoch-0 / invalid input", () => {
    expect(formatClock(0)).toBe(" --:--");
    expect(formatClock(Number.NaN)).toBe(" --:--");
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("treats a never-fetched snapshot (fetchedAt=0) as stale", () => {
    expect(isStale(snap({ fetchedAt: 0 }), NOW)).toBe(true);
  });

  it("treats a fresh fetch (now - fetchedAt < threshold) as not stale", () => {
    expect(isStale(snap({ fetchedAt: NOW - 5_000 }), NOW)).toBe(false);
  });

  it("treats an old fetch (> STALE_THRESHOLD_MS) as stale", () => {
    expect(
      isStale(snap({ fetchedAt: NOW - (STALE_THRESHOLD_MS + 1_000) }), NOW),
    ).toBe(true);
  });

  it("treats any fetch error as stale, regardless of recency", () => {
    expect(isStale(snap({ fetchedAt: NOW, fetchError: "boom" }), NOW)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// renderHeader
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  // The header is now the station TITLE ONLY — the host renders the wall
  // clock + staleness marker in its own dedicated top-right container, so
  // neither appears in the header string anymore. (The marker is asserted
  // via `view(...).clockMarker` in the dedicated describe block below.)
  it("renders a short station name verbatim (title only, no clock)", () => {
    const out = renderHeader(snap({ stationName: "Metro Center" }));
    expect(out).toBe("Metro Center");
  });

  it("keeps a long station name within the header title pixel budget", () => {
    // This 48-char name measures under the header content budget, so it
    // fits verbatim (the hand-tuned abbreviation only kicks in once the
    // canonical name overflows the budget); either way the title must
    // never exceed the budget so it can't collide with the host's
    // top-right clock container.
    const out = renderHeader(
      snap({ stationName: "U Street/African-Amer Civil War Memorial/Cardozo" }),
    );
    expect(textWidth(out)).toBeLessThanOrEqual(HEADER_CONTENT_WIDTH_PX);
    expect(out.startsWith("U Street")).toBe(true);
  });

  it("abbreviates an over-budget station name down to the header budget", () => {
    // A synthetic 60-char name forces the truncation path: the result is
    // clamped to the header content pixel budget with the canonical
    // ellipsis.
    const longName = "Very Long Station Name That Exceeds The Fifty Column Budget!!";
    const out = renderHeader(snap({ stationName: longName }));
    expect(textWidth(out)).toBeLessThanOrEqual(HEADER_CONTENT_WIDTH_PX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not embed the clock or a stale marker even when stale", () => {
    const out = renderHeader(
      snap({ fetchedAt: NOW - (STALE_THRESHOLD_MS + 1_000) }),
    );
    expect(out).toBe("Metro Center");
    expect(out).not.toContain(":");
    expect(out).not.toContain("*");
  });

  it("does not embed a marker even after consecutive fetch failures", () => {
    const out = renderHeader(
      snap({ consecutiveFetchFailures: 3, fetchError: "Slow network" }),
    );
    expect(out).toBe("Metro Center");
    expect(out).not.toContain("?");
  });
});

// ---------------------------------------------------------------------------
// view().clockMarker — staleness escalation now rides the host clock cell
// ---------------------------------------------------------------------------
//
// The 3-state marker (`*` → `**` → `?`) moved out of the header string and
// into `ScreenSections.clockMarker`, which the host appends after its own
// wall clock. We pin each branch verbatim so a regression has to update
// the expected glyphs intentionally.

describe("predictions view: clockMarker staleness escalation", () => {
  const markerFor = (over: Partial<PredictionsSnapshot>): string | undefined => {
    const screen = makePredictionsScreen(noopFetcher, snap(over));
    return screen.view(screen.init(), initialNav(), CTX).clockMarker;
  };

  it("is empty for fresh data with no failures", () => {
    expect(markerFor({ fetchedAt: NOW })).toBe("");
  });

  it("is '*' when the snapshot is stale (old fetchedAt, no error)", () => {
    expect(markerFor({ fetchedAt: NOW - (STALE_THRESHOLD_MS + 1_000) })).toBe(
      "*",
    );
  });

  it("is '*' after one consecutive fetch failure", () => {
    expect(
      markerFor({ consecutiveFetchFailures: 1, fetchError: "Slow network" }),
    ).toBe("*");
  });

  it("is '**' after two consecutive fetch failures", () => {
    expect(
      markerFor({ consecutiveFetchFailures: 2, fetchError: "Slow network" }),
    ).toBe("**");
  });

  it("is '?' after three or more consecutive fetch failures", () => {
    expect(
      markerFor({ consecutiveFetchFailures: 3, fetchError: "Slow network" }),
    ).toBe("?");
  });

  it("is '?' when no successful fetch ever AND there's an error", () => {
    expect(markerFor({ fetchedAt: 0, fetchError: "Network down" })).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// renderTrainRow
// ---------------------------------------------------------------------------

describe("renderTrainRow", () => {
  // `renderTrainRow` now returns the two pixel-aligned columns of a body
  // row: `left` (inset + line glyph cell + Title-Case destination,
  // left-aligned) and `right` (the cars+ETA value). The cells are
  // space-padded to PIXEL widths (space granularity), so we assert their
  // content + pixel fit rather than an exact monospace string.
  it("splits a typical row into a left dest cell and a right cars+ETA value", () => {
    const out = renderTrainRow(
      train({ Line: "RD", Destination: "Shady Grove", Car: "6", Min: "5" }),
    );
    // Left: 2-space inset + the line-name glyph cell + the destination.
    expect(out.left.startsWith("  RED")).toBe(true);
    expect(out.left).toContain("Shady Grove");
    expect(textWidth(out.left)).toBeLessThanOrEqual(LEFT_COL_MAX_PX);
    // Right: the cars cell + the right-aligned ETA value.
    expect(out.right).toContain("6c");
    expect(out.right).toContain("5 min");
    expect(textWidth(out.right)).toBeLessThanOrEqual(VALUE_COL_MAX_PX);
  });

  it("renders the ARR sentinel distinguishably in the right value", () => {
    const out = renderTrainRow(train({ Min: "ARR" }));
    expect(out.right).toContain("ARR");
    expect(out.right).toContain("6c");
    expect(textWidth(out.right)).toBeLessThanOrEqual(VALUE_COL_MAX_PX);
  });

  it("renders the BRD sentinel distinguishably in the right value", () => {
    const out = renderTrainRow(train({ Min: "BRD" }));
    expect(out.right).toContain("BRD");
  });

  it("renders the '---' sentinel as the em-dash, never blank", () => {
    const out = renderTrainRow(train({ Min: "---" }));
    expect(out.right).toContain("—");
  });

  it("renders the empty-string sentinel as the em-dash, never blank", () => {
    const out = renderTrainRow(train({ Min: "" }));
    expect(out.right).toContain("—");
  });

  it("fits 8-car trains with double-digit ETAs in the right value", () => {
    const out = renderTrainRow(
      train({ Car: "8", Min: "12", Destination: "Glenmont" }),
    );
    expect(out.right).toContain("8c");
    expect(out.right).toContain("12 min");
    expect(textWidth(out.right)).toBeLessThanOrEqual(VALUE_COL_MAX_PX);
  });

  it("collapses an unknown line code to the '--' glyph in the left cell", () => {
    const out = renderTrainRow(train({ Line: "No" }));
    // 2-char body inset + "--" line glyph.
    expect(out.left.startsWith("  --")).toBe(true);
  });

  it("renders a blank cars cell as two spaces, not a stray 'c'", () => {
    const out = renderTrainRow(train({ Car: "" }));
    // With Car blank the right value is just the right-aligned ETA — the
    // literal 'c' should not appear; two leading spaces stand in for the
    // empty cars cell.
    expect(out.right).not.toContain("c");
    expect(out.right.startsWith("  ")).toBe(true);
  });

  it("keeps the left cell within the body container pixel budget", () => {
    // Even the longest destination must leave the left column short of
    // the value overlay (≈ x 466) so it never renders beneath it.
    const out = renderTrainRow(
      train({
        Line: "GR",
        Destination: "Mt Vernon Sq 7th St-Convention Center",
        Car: "8",
        Min: "12",
      }),
    );
    expect(textWidth(out.left)).toBeLessThanOrEqual(LEFT_COL_MAX_PX);
  });
});

// ---------------------------------------------------------------------------
// renderTrainRow: Destination / DestinationName fallback (Reviewer Nit #3)
// ---------------------------------------------------------------------------

describe("renderTrainRow: Destination / DestinationName fallback", () => {
  // WMATA's Next Train Predictions endpoint returns BOTH `Destination`
  // (short abbreviation, e.g. "Vienna") and `DestinationName` (full,
  // e.g. "Vienna/Fairfax-GMU"). For non-revenue/special-service trains
  // `Destination` is occasionally returned as the empty string while
  // `DestinationName` carries the only readable label. Our renderer
  // therefore PREFERS `Destination` when non-empty and falls back to
  // `DestinationName` only when the primary field is blank.
  //
  // Source for the dual-field contract: docs/wmata-api/predictions.md
  // (also visible in `Train` in src/wmata/types.ts where both fields
  // are typed `string`).

  it("falls back to DestinationName when Destination is empty", () => {
    const out = renderTrainRow(
      train({ Destination: "", DestinationName: "Vienna" }),
    );
    // The dest cell (left column) should show "Vienna", not be blank.
    expect(out.left).toContain("Vienna");
  });

  it("prefers Destination over DestinationName when both are non-empty", () => {
    // The impl prefers the (short) `Destination` field even when it
    // looks like an abbreviation — `DestinationName` is the fallback,
    // not the override. We assert that here so a future refactor that
    // flips the priority will fail this test loudly.
    const out = renderTrainRow(
      train({ Destination: "VN", DestinationName: "Vienna" }),
    );
    expect(out.left).toContain("VN");
    // "Vienna" must NOT appear (it would imply DestinationName won).
    expect(out.left).not.toContain("Vienna");
  });
});

// ---------------------------------------------------------------------------
// sortTrainsForDisplay
// ---------------------------------------------------------------------------

describe("sortTrainsForDisplay", () => {
  it("ranks BRD < ARR < numeric < sentinel", () => {
    const xs = sortTrainsForDisplay([
      train({ Min: "5", Destination: "five" }),
      train({ Min: "ARR", Destination: "arr" }),
      train({ Min: "", Destination: "empty" }),
      train({ Min: "BRD", Destination: "brd" }),
      train({ Min: "12", Destination: "twelve" }),
      train({ Min: "---", Destination: "dashes" }),
      train({ Min: "1", Destination: "one" }),
    ]);
    expect(xs.map((t) => t.Destination)).toEqual([
      "brd",
      "arr",
      "one",
      "five",
      "twelve",
      "empty",
      "dashes",
    ]);
  });

  it("does not mutate the input array", () => {
    const input: Train[] = [
      train({ Min: "5" }),
      train({ Min: "1" }),
    ];
    const before = input.map((t) => t.Min);
    sortTrainsForDisplay(input);
    expect(input.map((t) => t.Min)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// view: empty state
// ---------------------------------------------------------------------------

describe("predictions view: empty state", () => {
  it("renders header + 'No trains predicted.' + a (double-tap to exit) cue", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: [] }));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines[0]).toBe(renderHeader(screen.init()));
    expect(lines.some((l) => l.includes("No trains predicted"))).toBe(true);
    expect(lines.some((l) => l.includes("double-tap to exit"))).toBe(true);
  });

  it("renders a 'Loading…' cue when fetchedAt=0 and no fetchError", () => {
    const initial = snap({ trains: [], fetchedAt: 0, fetchError: null });
    const screen = makePredictionsScreen(noopFetcher, initial);
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines.some((l) => l.includes("Loading"))).toBe(true);
  });

  // Reviewer Nit #7: pin the never-fetched empty state to EXACT
  // strings so the layout can't drift silently. Header line is built
  // by `renderHeader` and includes the stale marker (since
  // `fetchedAt === 0`); the body is the literal "Loading…" cue + a
  // blank spacer + the double-tap cue.
  it("pins the exact line array for the 'Loading…' never-fetched state", () => {
    const initial = snap({
      stationName: "Metro Center",
      trains: [],
      fetchedAt: 0,
      fetchError: null,
    });
    const screen = makePredictionsScreen(noopFetcher, initial);
    const sections = screen.view(screen.init(), initialNav(), CTX);
    const lines = flattenSections(sections);
    // Header is now the bare station title — the host renders the clock
    // (and the staleness marker) in its own top-right container, so the
    // flattened view output no longer contains the clock. The footer is
    // never an empty box: with no visible trains there are no served
    // lines to summarise, so it falls back to the quiet navigation hint
    // (2-char inset).
    expect(lines).toEqual([
      "Metro Center",
      "Loading…",
      "",
      "(double-tap to exit)",
      "  Double-tap for stations",
    ]);
    // Never-fetched → strongest staleness marker rides `clockMarker`.
    expect(sections.clockMarker).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// view: 1 / 3 / 5 trains
// ---------------------------------------------------------------------------

describe("predictions view: 1, 3, 5 trains", () => {
  // Each fixture now also renders a quiet footer line (served-lines
  // summary) since the footer container is never left empty — so the
  // flattened line count is header + N trains + 1 footer line.
  it("renders one train + header + quiet footer in 3 lines, every line fits", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains: [train({ Min: "5" })] }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expect(lines.length).toBe(3);
    expect(lines[lines.length - 1]).toBe("  Serving RED");
    expectFits(lines);
  });

  it("renders three trains + header + quiet footer in 5 lines, every line fits", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Min: "5" }),
    ];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expect(lines.length).toBe(5);
    expect(lines[lines.length - 1]).toBe("  Serving RED, ORANGE");
    expectFits(lines);
  });

  it("renders five trains + header + quiet footer in 7 lines, every line fits", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Min: "5" }),
      train({ Line: "SV", Destination: "Wiehle-Reston East", Min: "7" }),
      train({ Line: "BL", Destination: "Franconia-Springfield", Min: "9" }),
    ];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expect(lines.length).toBe(7);
    expect(lines[lines.length - 1]).toBe("  Serving RED, ORANGE, SILVER, BLUE");
    expectFits(lines);
  });
});

// ---------------------------------------------------------------------------
// view: 8+ trains -> capped to MAX_VISIBLE_TRAINS, sorted by ETA
// ---------------------------------------------------------------------------

describe("predictions view: 8+ trains caps at MAX_VISIBLE_TRAINS", () => {
  it("shows the 5 soonest trains sorted by ETA, no overflow", () => {
    const trains: Train[] = [
      train({ Destination: "T-12", Min: "12" }),
      train({ Destination: "T-3", Min: "3" }),
      train({ Destination: "T-1", Min: "1" }),
      train({ Destination: "T-BRD", Min: "BRD" }),
      train({ Destination: "T-ARR", Min: "ARR" }),
      train({ Destination: "T-9", Min: "9" }),
      train({ Destination: "T-5", Min: "5" }),
      train({ Destination: "T-7", Min: "7" }),
    ];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    // header + MAX_VISIBLE_TRAINS body rows + 1 quiet footer line = 7
    expect(lines.length).toBe(1 + MAX_VISIBLE_TRAINS + 1);
    expectFits(lines);
    // The first body row should be the BRD train; the last *body* row
    // (before the footer) should be T-5.
    expect(lines[1]).toContain("T-BRD");
    expect(lines[5]).toContain("T-5");
    // The quiet footer summarises the (single) served line.
    expect(lines[lines.length - 1]).toBe("  Serving RED");
    // The 12-minute / 9-minute / 7-minute trains should NOT have made it
    // into the visible window.
    for (const l of lines) {
      expect(l).not.toContain("T-12");
      expect(l).not.toContain("T-9");
      expect(l).not.toContain("T-7");
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: longest dest, 8 cars, 99 min
// ---------------------------------------------------------------------------

describe("predictions view: adversarial fixtures", () => {
  it("keeps every row within the section inner width with the longest destinations and 99 min ETAs", () => {
    const trains: Train[] = [
      train({
        Line: "BL",
        Destination: "Largo Town Center",
        Car: "8",
        Min: "99",
      }),
      train({
        Line: "GR",
        Destination: "Ronald Reagan Washington National Airport",
        Car: "8",
        Min: "12",
      }),
      train({
        Line: "OR",
        Destination: "Vienna/Fairfax-GMU",
        Car: "6",
        Min: "ARR",
      }),
      train({
        Line: "SV",
        Destination: "Wiehle-Reston East",
        Car: "8",
        Min: "BRD",
      }),
      train({
        Line: "RD",
        Destination: "Mt Vernon Sq 7th St-Convention Center",
        Car: "6",
        Min: "---",
      }),
    ];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        stationName: "U Street/African-Amer Civil War Memorial/Cardozo",
        trains,
      }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    // The left destination cell is bounded by a PIXEL budget. Most
    // fixture destinations still render in full, but the very longest —
    // "Ronald Reagan Washington National Airport" — exceeds the budget and
    // correctly falls back to its hand-tuned abbreviation ("DCA"). The
    // test's job is to verify the rows fit the section inner width
    // (`expectFits`) and that each destination is present (in full or as
    // its abbreviation).
    const allBody = lines.slice(1).join(" ");
    expect(allBody).toContain("Largo Town Center");
    expect(allBody).toContain("DCA"); // airport abbreviates under the pixel budget
    expect(allBody).toContain("Vienna/Fairfax-GMU");
    expect(allBody).toContain("Wiehle-Reston East");
  });

  it("keeps every LEFT body cell and RIGHT value within their pixel budgets", () => {
    // The two-column contract: LEFT lives in the full-width body
    // container (the value overlay starts at x≈466) and RIGHT is the
    // narrow value overlay. Pin both pixel bounds against an adversarial
    // render (longest destinations, a pinned summary, a late-night
    // last-train row) so neither column can silently overflow.
    const EVENING_CTX: ViewContext = {
      nowMs: new Date(2026, 4, 18, 22, 30, 0).getTime(),
    };
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Glenmont", Car: "8", Min: "ARR" }),
      train({ Line: "GR", Destination: "Ronald Reagan Washington National Airport", Car: "8", Min: "12" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Car: "6", Min: "99" }),
      train({ Line: "SV", Destination: "Wiehle-Reston East", Car: "8", Min: "BRD" }),
      train({ Line: "BL", Destination: "Mt Vernon Sq 7th St-Convention Center", Car: "6", Min: "---" }),
    ];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        stationName: "U Street/African-Amer Civil War Memorial/Cardozo",
        trains,
        pinned: { line: "RD", destination: "Glenmont" },
        pinnedPosition: { label: "* RD 3 stops away", schematic: "RD -*--@-" },
        lastTrainToday: [{ line: "RD", time: "11:47p" }],
      }),
    );
    const cols = screen.view(screen.init(), { highlightedIndex: 0 }, EVENING_CTX)
      .bodyColumns!;
    expect(cols.left.length).toBe(cols.right.length); // lockstep rows
    for (const l of cols.left)
      expect(textWidth(l)).toBeLessThanOrEqual(LEFT_COL_MAX_PX);
    for (const r of cols.right)
      expect(textWidth(r)).toBeLessThanOrEqual(VALUE_COL_MAX_PX);
  });
});

// ---------------------------------------------------------------------------
// Footer: incident headline / fetch error
// ---------------------------------------------------------------------------

describe("renderFooter", () => {
  it("renders an incident headline with a 2-char inset on the first line", () => {
    // No leading "! " glyph — the bordered footer container is the
    // visual signal that this section is an alert. Each line is
    // 2-char inset to match the prefix-width contract. A trailing
    // period on the (complete) first sentence is stripped so the line
    // doesn't end on dangling punctuation.
    const out = renderFooter(
      snap({ incidentHeadline: "Single-tracking on RD between A01 and A02." }),
    );
    expect(out[0]!.startsWith("  ")).toBe(true);
    expect(out[0]!).toContain("Single-tracking");
    for (const line of out)
      expect(textWidth(line)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  });

  it("strips a dangling trailing comma from the final wrapped line", () => {
    // A truncated first-sentence list fragment ("…Foggy Bottom,") must
    // not leave a comma orphaned at the end of the footer block.
    const out = renderFooter(
      snap({ incidentHeadline: "Delays near Metro Center, Gallery Pl," }),
    );
    expect(out[out.length - 1]!.endsWith(",")).toBe(false);
  });

  it("returns a QUIET served-lines line when no incident AND no fetch error", () => {
    // The footer container always exists; rather than render an empty
    // box we surface a quiet served-lines summary derived from the
    // visible trains (full line names).
    const out = renderFooter(
      snap({ trains: [train({ Line: "RD" }), train({ Line: "OR" })] }),
    );
    expect(out).toEqual(["  Serving RED, ORANGE"]);
  });

  it("falls back to a quiet hint when there are no trains to summarise", () => {
    const out = renderFooter(snap({ trains: [] }));
    expect(out).toEqual(["  Double-tap for stations"]);
  });

  it("shows the quiet line (not the error) when a fetchError exists but we still have prior data", () => {
    // Stale `?` marker on the clock is sufficient for the have-data
    // case; the footer surfaces the quiet served-lines summary, not the
    // network error.
    const out = renderFooter(
      snap({
        trains: [train({ Line: "RD" })],
        fetchError: "Network down",
        fetchedAt: NOW - 1000,
      }),
    );
    expect(out).toEqual(["  Serving RED"]);
  });

  it("surfaces a fetch error in the footer only when we have NO data (fetchedAt=0)", () => {
    const out = renderFooter(
      snap({ fetchError: "Network down", fetchedAt: 0 }),
    );
    expect(out[0]!.startsWith("? ")).toBe(true);
    for (const line of out)
      expect(textWidth(line)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  });
});

describe("predictions view: footer presence", () => {
  it("appends the footer row when incidentHeadline is set", () => {
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains, incidentHeadline: "Single-tracking RD" }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    // header + 1 train + footer = 3
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("Single-tracking RD");
  });

  it("wraps a long incident headline across multiple footer lines", () => {
    // 50+ char description that doesn't fit on one line — the footer
    // wraps across up to FOOTER_MAX_LINES rows (instead of truncating
    // to one) so the user can actually read the alert.
    const longHeadline =
      "Single-tracking on RD between Foggy Bottom and Rosslyn";
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains, incidentHeadline: longHeadline }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    // header + 1 train + 1-3 footer lines.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[2]!.startsWith("  ")).toBe(true);
    // The full word-set should appear somewhere across the wrapped
    // footer lines (no information lost when it fits).
    const footerText = lines.slice(2).join(" ");
    expect(footerText).toContain("Single-tracking");
    expect(footerText).toContain("Rosslyn");
  });

  it("fills the footer with a quiet served-lines line when incidentHeadline is null", () => {
    // Mirrors what main.ts seeds when the shared incidents cache has no
    // entries for this station's lines. Rather than leave the bordered
    // footer empty (reads as broken), it carries a quiet served-lines
    // summary. No "! " alert prefix appears.
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains, incidentHeadline: null }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines.length).toBe(3); // header + 1 train + quiet footer
    expect(lines[lines.length - 1]).toBe("  Serving RED");
    for (const l of lines) expect(l.startsWith("! ")).toBe(false);
  });

  it("never leaves the footer empty: a quiet line shows when there's nothing to surface", () => {
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines.length).toBe(3); // header + 1 train + quiet footer
    expect(lines[lines.length - 1]).toBe("  Serving RED");
  });
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

describe("predictions reduce", () => {
  const screen = makePredictionsScreen(noopFetcher, snap({}));

  it("SCROLL_UP is a no-op (no internal navigation)", () => {
    const r = screen.reduce(screen.init(), initialNav(), { type: "SCROLL_UP" });
    expect(r.navigate).toBeUndefined();
    expect(r.nav).toEqual(initialNav());
  });

  it("SCROLL_DOWN is a no-op (no internal navigation)", () => {
    const r = screen.reduce(screen.init(), initialNav(), { type: "SCROLL_DOWN" });
    expect(r.navigate).toBeUndefined();
    expect(r.nav).toEqual(initialNav());
  });

  it("TAP is a no-op", () => {
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toBeUndefined();
    expect(r.nav).toEqual(initialNav());
  });

  it("DOUBLE_TAP navigates BACK to home (not exit)", () => {
    const r = screen.reduce(screen.init(), initialNav(), { type: "DOUBLE_TAP" });
    expect(r.navigate).toEqual({ to: "home" });
  });
});

// ---------------------------------------------------------------------------
// tick(): success + error paths
// ---------------------------------------------------------------------------

describe("predictions tick", () => {
  it("folds a successful fetch into the snapshot and clears fetchError", async () => {
    const fixture: Train[] = [train({ Min: "ARR" })];
    const fetcher = () =>
      Promise.resolve<PredictionsFetchResult>({
        trains: fixture,
        incidentHeadline: "Single-tracking RD",
        lastTrainToday: null,
        pinnedPosition: null,
      });
    const screen = makePredictionsScreen(
      fetcher,
      snap({ trains: [], fetchError: "stale error" }),
    );
    const next = await screen.tick(screen.init());
    expect(next.trains).toEqual(fixture);
    expect(next.incidentHeadline).toBe("Single-tracking RD");
    expect(next.fetchError).toBeNull();
    expect(next.fetchedAt).toBeGreaterThan(0);
  });

  it("never throws: a rejected fetcher stores the error on the snapshot", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makePredictionsScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.fetchError).toBe("boom");
    // Trains are preserved across the failure — we don't blank the HUD.
    expect(next.trains).toEqual(snap({}).trains);
  });

  it("increments consecutiveFetchFailures on each rejected fetcher", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makePredictionsScreen(fetcher, snap({}));
    let s = screen.init();
    expect(s.consecutiveFetchFailures).toBe(0);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(1);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(2);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(3);
  });

  it("resets consecutiveFetchFailures to 0 on a successful fetch", async () => {
    let shouldFail = true;
    const fetcher = (): Promise<PredictionsFetchResult> =>
      shouldFail
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({
            trains: [],
            incidentHeadline: null,
            lastTrainToday: null,
        pinnedPosition: null,
          });
    const screen = makePredictionsScreen(
      fetcher,
      snap({ consecutiveFetchFailures: 2 }),
    );
    let s = screen.init();
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(3);
    // Network recovers.
    shouldFail = false;
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(0);
    expect(s.fetchError).toBeNull();
  });

  it("exposes a tickIntervalMs of 20_000 (20s) for the host", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({}));
    expect(screen.tickIntervalMs).toBe(TICK_INTERVAL_MS);
    expect(screen.tickIntervalMs).toBe(20_000);
  });

  it("folds lastTrainToday into the snapshot from the fetcher result", async () => {
    const fetcher = (): Promise<PredictionsFetchResult> =>
      Promise.resolve({
        trains: [],
        incidentHeadline: null,
        lastTrainToday: [{ line: "RD", time: "11:47p" }],
        pinnedPosition: null,
      });
    const screen = makePredictionsScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.lastTrainToday).toEqual([{ line: "RD", time: "11:47p" }]);
  });

  it("preserves prior lastTrainToday when the fetcher reports null", async () => {
    // Use case: the schedule cache is warm from a prior tick; the
    // current tick's fetcher couldn't update it (e.g. transient
    // jStationTimes blip) and returns null. We should keep the
    // last-known time rather than blinking the row off.
    const fetcher = (): Promise<PredictionsFetchResult> =>
      Promise.resolve({
        trains: [],
        incidentHeadline: null,
        lastTrainToday: null,
        pinnedPosition: null,
      });
    const screen = makePredictionsScreen(
      fetcher,
      snap({ lastTrainToday: [{ line: "RD", time: "11:47p" }] }),
    );
    const next = await screen.tick(screen.init());
    expect(next.lastTrainToday).toEqual([{ line: "RD", time: "11:47p" }]);
  });
});

// ---------------------------------------------------------------------------
// Last-train glance (A3)
// ---------------------------------------------------------------------------

describe("shouldShowLastTrain", () => {
  it("returns false during the morning rush (08:00)", () => {
    const t = new Date(2026, 4, 18, 8, 0, 0).getTime();
    expect(shouldShowLastTrain(t)).toBe(false);
  });

  it("returns false at 20:59 (just before the threshold)", () => {
    const t = new Date(2026, 4, 18, 20, 59, 0).getTime();
    expect(shouldShowLastTrain(t)).toBe(false);
  });

  it("returns true exactly at LAST_TRAIN_HOUR (21:00)", () => {
    const t = new Date(2026, 4, 18, LAST_TRAIN_HOUR, 0, 0).getTime();
    expect(shouldShowLastTrain(t)).toBe(true);
  });

  it("returns true at 23:30", () => {
    const t = new Date(2026, 4, 18, 23, 30, 0).getTime();
    expect(shouldShowLastTrain(t)).toBe(true);
  });

  it("returns false for epoch-0 / NaN", () => {
    expect(shouldShowLastTrain(0)).toBe(false);
    expect(shouldShowLastTrain(Number.NaN)).toBe(false);
  });
});

describe("pickLastTrainTime", () => {
  it("returns null for an empty list", () => {
    expect(pickLastTrainTime([])).toBeNull();
  });

  it("returns the latest PM time across the list", () => {
    expect(
      pickLastTrainTime([
        { Time: "21:30" },
        { Time: "11:47p" },
        { Time: "22:15" },
      ]),
    ).toBe("11:47p");
  });

  it("ignores AM times (they signify the next day per WMATA docs)", () => {
    // 01:30 is an AM entry — WMATA puts these in LastTrains[] when
    // service crosses midnight. We want the latest PM entry, not
    // tomorrow morning.
    expect(
      pickLastTrainTime([
        { Time: "11:47p" },
        { Time: "01:30" },
      ]),
    ).toBe("11:47p");
  });

  it("returns null when every entry is AM", () => {
    expect(
      pickLastTrainTime([{ Time: "01:30" }, { Time: "02:15" }]),
    ).toBeNull();
  });

  it("ignores malformed entries", () => {
    expect(
      pickLastTrainTime([
        { Time: "" },
        { Time: "not-a-time" },
        { Time: "22:15" },
      ]),
    ).toBe("22:15");
  });
});

describe("renderLastTrainRow", () => {
  const EVENING = new Date(2026, 4, 18, 22, 30, 0).getTime();
  const MORNING = new Date(2026, 4, 18, 8, 30, 0).getTime();

  it("returns null before the late-night window", () => {
    expect(
      renderLastTrainRow(
        snap({ lastTrainToday: [{ line: "RD", time: "11:47p" }] }),
        MORNING,
      ),
    ).toBeNull();
  });

  it("returns null when lastTrainToday is missing or empty", () => {
    expect(
      renderLastTrainRow(snap({ lastTrainToday: null }), EVENING),
    ).toBeNull();
    expect(
      renderLastTrainRow(snap({ lastTrainToday: [] }), EVENING),
    ).toBeNull();
  });

  it("renders single-line form when one bucket is present", () => {
    const out = renderLastTrainRow(
      snap({ lastTrainToday: [{ line: "RD", time: "11:47p" }] }),
      EVENING,
    );
    expect(out).toBe("Last RED 11:47p");
    expect(textWidth(out!)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  });

  it("renders two-line form ascending by time (earliest-out first)", () => {
    // OR 22:50 leaves before RD 23:47 — surface OR first so the
    // user knows the line they have to leave fastest for.
    const out = renderLastTrainRow(
      snap({
        lastTrainToday: [
          { line: "OR", time: "22:50" },
          { line: "RD", time: "11:47p" },
        ],
      }),
      EVENING,
    );
    expect(out).toBe("Last ORANGE 10:50p  RED 11:47p");
    expect(textWidth(out!)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  });

  it("drops cell #2 for 3+ lines and surfaces overflow count", () => {
    // 4 lines won't fit in two-cell form ("Last X HH:MM  X HH:MM +N" = 26
    // chars). The render falls back to single-cell + overflow.
    const out = renderLastTrainRow(
      snap({
        lastTrainToday: [
          { line: "BL", time: "22:30" },
          { line: "OR", time: "22:50" },
          { line: "RD", time: "11:47p" },
          { line: "SV", time: "23:55" },
        ],
      }),
      EVENING,
    );
    expect(textWidth(out!)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
    expect(out).toBe("Last BLUE 10:30p +3");
  });
});

describe("predictions view: late-night last-train row", () => {
  const EVENING = new Date(2026, 4, 18, 22, 30, 0).getTime();
  const EVENING_CTX: ViewContext = { nowMs: EVENING };

  it("appends the row at the end of the body when after LAST_TRAIN_HOUR", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: [train({ Line: "RD", Min: "5" })],
        lastTrainToday: [{ line: "RD", time: "11:47p" }],
      }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), EVENING_CTX));
    expectFits(lines);
    // The last-train row is the final BODY row; the quiet footer line
    // (served-lines summary) follows it in the flattened output.
    expect(lines).toContain("Last RED 11:47p");
    expect(lines[lines.length - 2]).toBe("Last RED 11:47p");
    expect(lines[lines.length - 1]).toBe("  Serving RED");
  });

  it("does NOT append the row before LAST_TRAIN_HOUR", () => {
    // CTX (above) is the canonical 14:32 fixture.
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: [train({ Line: "RD", Min: "5" })],
        lastTrainToday: [{ line: "RD", time: "11:47p" }],
      }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expectFits(lines);
    expect(lines.some((l) => l.includes("Last train"))).toBe(false);
    expect(lines.some((l) => l.includes("Last RD"))).toBe(false);
  });

  it("does NOT append the row when lastTrainToday is null (data not loaded yet)", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: [train({ Line: "RD", Min: "5" })],
        lastTrainToday: null,
        pinnedPosition: null,
      }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), EVENING_CTX));
    expect(lines.some((l) => l.includes("Last train"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale-check is driven by ctx.nowMs, not the snapshot
// ---------------------------------------------------------------------------

describe("predictions: stale check uses ctx.nowMs (not the snapshot)", () => {
  it("recomputes the clockMarker as ctx.nowMs advances and a tick later refreshes fetchedAt", async () => {
    const T = NOW;
    // The staleness marker now rides `view(...).clockMarker` (the host
    // appends it after its own clock), driven by `ctx.nowMs` — not the
    // header string. We assert the marker through `view`.
    const markerAt = (
      s: PredictionsSnapshot,
      nowMs: number,
    ): string | undefined => {
      const screen = makePredictionsScreen(noopFetcher, s);
      return screen.view(screen.init(), initialNav(), { nowMs }).clockMarker;
    };

    // 1) Snapshot fetched 70s ago — stale relative to T (threshold 60s).
    const s1: PredictionsSnapshot = snap({ fetchedAt: T - 70_000 });
    expect(isStale(s1, T)).toBe(true);
    expect(markerAt(s1, T)).toBe("*");

    // 2) Same snapshot, 5s of wall-clock later (still no fetch). The
    //    host has only run the 1Hz clock tick — the snapshot.fetchedAt
    //    hasn't moved, so the marker MUST still be present.
    expect(isStale(s1, T + 5_000)).toBe(true);
    expect(markerAt(s1, T + 5_000)).toBe("*");

    // 3) A fetch tick finally lands and refreshes fetchedAt to T+5s.
    //    From that moment the snapshot is fresh again, so the marker
    //    disappears.
    const fetcher = () =>
      Promise.resolve<PredictionsFetchResult>({
        trains: [],
        incidentHeadline: null,
        lastTrainToday: null,
        pinnedPosition: null,
      });
    const screen = makePredictionsScreen(fetcher, s1);
    // Pin Date.now() so the tick stamps fetchedAt deterministically.
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(T + 5_000);
    try {
      const s2 = await screen.tick(s1);
      expect(s2.fetchedAt).toBe(T + 5_000);
      expect(isStale(s2, T + 5_000)).toBe(false);
      expect(markerAt(s2, T + 5_000)).toBe("");
    } finally {
      dateNow.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Clock decoupled from fetch (hung-fetch regression test)
// ---------------------------------------------------------------------------

/**
 * Minimal fake bridge that records every textContainerUpgrade payload.
 * Mirrors the helper in `glasses-host.test.ts` — duplicated here so the
 * Predictions test file can drive `mountGlassesScreen` for the hung-
 * fetch regression case without cross-importing test helpers.
 */
function makeFakeBridge(): {
  bridge: EvenAppBridge;
  upgrades: string[];
} {
  const upgrades: string[] = [];
  const fake = {
    createStartUpPageContainer: (
      _container: CreateStartUpPageContainer,
    ): Promise<StartUpPageCreateResult> =>
      Promise.resolve(StartUpPageCreateResult.success),
    textContainerUpgrade: (
      container: TextContainerUpgrade,
    ): Promise<boolean> => {
      const content =
        (container as unknown as { content?: string }).content ?? "";
      upgrades.push(content);
      return Promise.resolve(true);
    },
    shutDownPageContainer: (_exitMode?: number): Promise<boolean> =>
      Promise.resolve(true),
    onEvenHubEvent: (_cb: (event: EvenHubEvent) => void): (() => void) => {
      return () => {
        /* no-op */
      };
    },
  };
  return { bridge: fake as unknown as EvenAppBridge, upgrades };
}

function makeStubRouter(): Router {
  return {
    current: "predictions" as NavIntent["to"],
    navigate: (_intent: NavIntent): Promise<void> => Promise.resolve(),
  };
}

describe("predictions: clock decoupled from fetch (hung-fetch regression)", () => {
  it("the 1Hz clock tick re-renders the screen with progressing nowMs even when tick() never resolves", async () => {
    vi.useFakeTimers();
    try {
      // Anchor wall-clock so the formatted 12-hour string is deterministic
      // (the timer-driven render reads Date.now() inside the host).
      vi.setSystemTime(new Date(2026, 4, 18, 14, 32, 0));

      // A screen whose fetch is permanently stuck. `tick()` never
      // resolves; we want to prove the on-screen clock still advances.
      const initial = snap({
        stationName: "Metro Center",
        trains: [],
        fetchedAt: 0,
        fetchError: null,
      });
      const hungFetcher = (): Promise<PredictionsFetchResult> =>
        new Promise(() => {
          /* never resolves */
        });
      const screen = makePredictionsScreen(hungFetcher, initial);

      const { bridge, upgrades } = makeFakeBridge();
      const router = makeStubRouter();
      const unmount = await mountGlassesScreen(screen, bridge, router);

      // The initial mount renders once. Subsequent ticks fire on the
      // 1000ms clock interval. Advance 5 seconds of fake time, allowing
      // the awaited bridge promises to drain between each tick.
      const renderedClocks: string[] = [];
      const grab = (): void => {
        const last = upgrades[upgrades.length - 1];
        if (last) renderedClocks.push(last.split("\n")[0] ?? "");
      };
      grab();

      for (let s = 1; s <= 5; s++) {
        // Bump system clock so the rendered minute changes; advance
        // fake timers so the 1Hz interval callback fires.
        vi.setSystemTime(new Date(2026, 4, 18, 14, 32 + s, 0));
        await vi.advanceTimersByTimeAsync(1000);
        grab();
      }

      // We should have at LEAST 4 re-renders (one per clock tick) on
      // top of the initial render. In practice the dedupe filter passes
      // every one because the rendered minute changes each step.
      expect(upgrades.length).toBeGreaterThanOrEqual(5);

      // The clock now lives in the host's own container, so each 1Hz
      // tick re-pushes just the clock cell ("<h:mma>*", with the `*`
      // staleness marker since `fetchedAt === 0`). The last upgrade per
      // tick is that clock string — pull the HH:MM substring out and
      // check the rendered minutes advance.
      const minutes = renderedClocks
        .map((line) => line.match(/(\d{1,2}):(\d{2})/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => Number(m[1]) * 60 + Number(m[2]));
      // At least 5 distinct clock values across the renders.
      const distinct = new Set(minutes);
      expect(distinct.size).toBeGreaterThanOrEqual(5);

      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: canonical 3-train render at Metro Center, no incident
// ---------------------------------------------------------------------------

describe("predictions view snapshot: 3 trains at Metro Center", () => {
  it("pins the canonical two-column render (content + structure)", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Car: "6", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Car: "8", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Car: "6", Min: "5" }),
    ];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ stationName: "Metro Center", trains }),
    );
    const sections = screen.view(screen.init(), initialNav(), CTX);
    const lines = flattenSections(sections);
    expectFits(lines);

    // Header is the bare station title; the host renders the clock in its
    // own container.
    expect(sections.header).toEqual(["Metro Center"]);
    // The body is TWO columns: each LEFT cell is `inset + line-name glyph
    // cell + destination`; each RIGHT value is `cars + right-aligned ETA`.
    // Columns are space-padded to PIXEL widths, so we pin content +
    // structure rather than the exact monospace spacing.
    const cols = sections.bodyColumns!;
    expect(cols.left.length).toBe(3);
    expect(cols.right.length).toBe(3);
    // Row 0: RED / Shady Grove, with the default cursor `>` riding the
    // line cell (v1.2 pin-a-train affordance), value "6c …ARR".
    expect(cols.left[0]!.startsWith("  RED")).toBe(true);
    expect(cols.left[0]).toContain(">");
    expect(cols.left[0]).toContain("Shady Grove");
    expect(cols.right[0]).toContain("6c");
    expect(cols.right[0]).toContain("ARR");
    // Row 1: RED / Glenmont, value "8c …3 min". No cursor (not selected).
    expect(cols.left[1]!.startsWith("  RED")).toBe(true);
    expect(cols.left[1]).toContain("Glenmont");
    expect(cols.left[1]).not.toContain(">");
    expect(cols.right[1]).toContain("8c");
    expect(cols.right[1]).toContain("3 min");
    // Row 2: ORANGE / Vienna/Fairfax-GMU, value "6c …5 min".
    expect(cols.left[2]!.startsWith("  ORANGE")).toBe(true);
    expect(cols.left[2]).toContain("Vienna/Fairfax-GMU");
    expect(cols.right[2]).toContain("6c");
    expect(cols.right[2]).toContain("5 min");
    // The footer is never empty: with no incident it carries the quiet
    // served-lines summary (distinct full line names in ETA order).
    expect(sections.footer).toEqual(["  Serving RED, ORANGE"]);
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: 3 trains + a non-null incidentHeadline → 6-line render
// with the wrapped `!`-prefixed footer block at the tail.
// ---------------------------------------------------------------------------

describe("predictions view snapshot: 3 trains + incident footer", () => {
  it("renders the body rows + the incident footer block", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Car: "6", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Car: "8", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Car: "6", Min: "5" }),
    ];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        stationName: "Metro Center",
        trains,
        // 41-char headline fits on one footer line at the section inner
        // width — no wrap needed.
        incidentHeadline: "Single-tracking on RD between Foggy Bottom",
      }),
    );
    const sections = screen.view(screen.init(), initialNav(), CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    // The body is the same two-column 3-train render as the no-incident
    // snapshot above; here the test's subject is the footer section, which
    // carries the incident headline (2-space inset) instead of the quiet
    // served-lines summary.
    expect(sections.header).toEqual(["Metro Center"]);
    const cols = sections.bodyColumns!;
    expect(cols.left.length).toBe(3);
    expect(cols.left[0]).toContain("Shady Grove");
    expect(cols.left[1]).toContain("Glenmont");
    expect(cols.left[2]).toContain("Vienna/Fairfax-GMU");
    // Footer: the incident headline on one line with the 2-space inset
    // (no leading "! " glyph — the bordered footer is the alert signal).
    expect(sections.footer).toEqual([
      "  Single-tracking on RD between Foggy Bottom",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pin-a-train (cursor + TAP-to-pin)
// ---------------------------------------------------------------------------

describe("renderTrainRow: cursor + pin markers", () => {
  // The marker glyph rides the LEFT cell's line-name slot (now
  // pixel-padded). The line cell sits between the 2-space inset and the
  // destination word, so we assert the cell carries the line name + the
  // marker rather than an exact monospace string.
  it("renders the full line glyph when no marker is supplied", () => {
    const out = renderTrainRow(train({ Line: "RD" }));
    // 2-space body inset + the line-name glyph cell, then the destination.
    expect(out.left.startsWith("  RED")).toBe(true);
    expect(out.left).toContain("Shady Grove");
    // No marker present in the line cell.
    expect(out.left).not.toContain("*");
    expect(out.left).not.toContain(">");
  });

  it("rides the line cell with `*` for a pinned train", () => {
    const out = renderTrainRow(train({ Line: "RD" }), "*");
    expect(out.left.startsWith("  RED")).toBe(true);
    // The `*` marker sits in the line cell, BEFORE the destination.
    const cell = out.left.slice(0, out.left.indexOf("Shady Grove"));
    expect(cell).toContain("*");
  });

  it("rides the line cell with `>` for the cursor target", () => {
    const out = renderTrainRow(train({ Line: "OR" }), ">");
    // "ORANGE" fills the cell, so it's shortened to make room for the
    // marker at the cell's right edge.
    expect(out.left.startsWith("  ORANG")).toBe(true);
    const cell = out.left.slice(0, out.left.indexOf("Shady Grove"));
    expect(cell).toContain(">");
  });
});

describe("findPinnedTrainIndex", () => {
  it("returns -1 when nothing matches", () => {
    const trains = [
      train({ Line: "RD", Destination: "Glenmont" }),
      train({ Line: "OR", Destination: "Vienna" }),
    ];
    expect(
      findPinnedTrainIndex(trains, { line: "BL", destination: "Largo" }),
    ).toBe(-1);
  });

  it("returns the first matching index", () => {
    const trains = [
      train({ Line: "RD", Destination: "Shady Grove" }),
      train({ Line: "RD", Destination: "Glenmont" }),
      train({ Line: "RD", Destination: "Glenmont" }), // duplicate
    ];
    expect(
      findPinnedTrainIndex(trains, { line: "RD", destination: "Glenmont" }),
    ).toBe(1);
  });

  it("returns -1 when the pin is null", () => {
    expect(findPinnedTrainIndex([], null)).toBe(-1);
  });
});

describe("renderPinRow", () => {
  it("returns null when no train is pinned", () => {
    expect(renderPinRow(snap({}), [])).toBeNull();
  });

  it("returns null when the pinned train is no longer visible", () => {
    const visible = [train({ Line: "RD", Destination: "Glenmont", Min: "3" })];
    const out = renderPinRow(
      snap({ pinned: { line: "BL", destination: "Largo" } }),
      visible,
    );
    expect(out).toBeNull();
  });

  it("splits `* <line> <dest>` into the left cell and the ETA into the right", () => {
    const visible = [
      train({ Line: "RD", Destination: "Glenmont", Min: "3" }),
    ];
    const out = renderPinRow(
      snap({ pinned: { line: "RD", destination: "Glenmont" } }),
      visible,
    );
    expect(out).not.toBeNull();
    // Left: "* " marker (doubles as the body inset) + line glyph cell +
    // the (un-padded) destination. Right: the right-aligned ETA value.
    expect(out!.left).toContain("RED");
    expect(out!.left).toContain("Glenmont");
    expect(out!.left.startsWith("* ")).toBe(true);
    expect(out!.right).toContain("3 min");
    expect(out!.right.length).toBeLessThanOrEqual(10);
  });

  it("puts the `(gone)` tag in the left cell with no right value", () => {
    // The one-tick gone latch: the pinned train rolled off but the pin
    // hasn't been cleared yet. "(gone)" is prose (no ETA value).
    const visible = [train({ Line: "RD", Destination: "Shady Grove", Min: "3" })];
    const out = renderPinRow(
      snap({
        pinned: { line: "RD", destination: "Glenmont" },
        pinnedGone: true,
      }),
      visible,
    );
    expect(out).not.toBeNull();
    expect(out!.left).toContain("(gone)");
    expect(out!.left.startsWith("* ")).toBe(true);
    expect(out!.right).toBe("");
  });
});

// ---------------------------------------------------------------------------
// pinnedDistancePhrase — extract the position phrase from a label
// ---------------------------------------------------------------------------

describe("pinnedDistancePhrase", () => {
  it("extracts and tightens the 'N stops away' phrase", () => {
    expect(pinnedDistancePhrase("* RD 3 stops away", "RD")).toBe("3 stops");
  });

  it("keeps singular '1 stop' tidy", () => {
    expect(pinnedDistancePhrase("* RD 1 stop away", "RD")).toBe("1 stop");
  });

  it("maps 'at this station' to the compact 'at station'", () => {
    expect(pinnedDistancePhrase("* OR at this station", "OR")).toBe("at station");
  });

  it("passes 'approaching' through", () => {
    expect(pinnedDistancePhrase("* SV approaching", "SV")).toBe("approaching");
  });

  it("returns null for the fallback `* <line> <destination>` form", () => {
    // When the train can't be located, resolvePinnedPosition emits the
    // bare destination as the label — there's no position phrase.
    expect(pinnedDistancePhrase("* RD Glenmont", "RD")).toBeNull();
  });

  it("returns null for empty / malformed labels", () => {
    expect(pinnedDistancePhrase("", "RD")).toBeNull();
    expect(pinnedDistancePhrase("* RD ", "RD")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderPinnedSummary — the COMPACT merged pinned line (clip fix)
// ---------------------------------------------------------------------------

describe("renderPinnedSummary", () => {
  it("returns null when nothing is pinned", () => {
    expect(renderPinnedSummary(snap({}), [])).toBeNull();
  });

  it("returns null when the pinned train isn't visible", () => {
    const visible = [train({ Line: "RD", Destination: "Glenmont", Min: "3" })];
    expect(
      renderPinnedSummary(
        snap({ pinned: { line: "BL", destination: "Largo" } }),
        visible,
      ),
    ).toBeNull();
  });

  it("merges line + dest + distance into the left cell, ETA into the right", () => {
    const visible = [train({ Line: "RD", Destination: "Glenmont", Min: "3" })];
    const out = renderPinnedSummary(
      snap({
        pinned: { line: "RD", destination: "Glenmont" },
        pinnedPosition: { label: "* RD 3 stops away", schematic: "RD -*--@-" },
      }),
      visible,
    )!;
    expect(out).not.toBeNull();
    // Left: full line name (consistency rule), the destination, and the
    // compact distance phrase in parens — no separate "N stops away" row,
    // no ASCII schematic row. Right: the ETA value.
    expect(out.left).toBe("* RED Glenmont (3 stops)");
    expect(out.right).toBe("3 min");
    // Uses the FULL line name, never the "RD" abbreviation.
    expect(out.left).not.toContain("RD");
  });

  it("drops the parenthetical when there's no resolvable position phrase", () => {
    const visible = [train({ Line: "OR", Destination: "Vienna", Min: "5" })];
    const out = renderPinnedSummary(
      snap({
        pinned: { line: "OR", destination: "Vienna" },
        // Fallback label (train not locatable) → no phrase.
        pinnedPosition: { label: "* OR Vienna", schematic: "OR -*-" },
      }),
      visible,
    )!;
    expect(out.left).toBe("* ORANGE Vienna");
    expect(out.left).not.toContain("(");
    expect(out.right).toBe("5 min");
  });
});

// ---------------------------------------------------------------------------
// renderFooterQuiet — the gentle non-empty footer fallback
// ---------------------------------------------------------------------------

describe("renderFooterQuiet", () => {
  it("summarises distinct served lines (full names, ETA order, 2-char inset)", () => {
    const out = renderFooterQuiet([
      train({ Line: "RD" }),
      train({ Line: "RD" }), // dup collapses
      train({ Line: "OR" }),
    ]);
    expect(out).toBe("  Serving RED, ORANGE");
  });

  it("falls back to a quiet hint when no revenue lines are present", () => {
    expect(renderFooterQuiet([])).toBe("  Double-tap for stations");
    // Unknown line codes ("--") don't count as served lines.
    expect(renderFooterQuiet([train({ Line: "ZZ" })])).toBe(
      "  Double-tap for stations",
    );
  });

  it("stays within the section inner width even with all six lines", () => {
    const out = renderFooterQuiet([
      train({ Line: "RD" }),
      train({ Line: "OR" }),
      train({ Line: "BL" }),
      train({ Line: "SV" }),
      train({ Line: "GR" }),
      train({ Line: "YL" }),
    ]);
    expect(textWidth(out)).toBeLessThanOrEqual(SECTION_INNER_WIDTH_PX);
  });
});

// ---------------------------------------------------------------------------
// view: dense pinned + live-position state FITS the body (clip regression)
// ---------------------------------------------------------------------------

describe("predictions view: pinned + live position is compact (no clip)", () => {
  function trains3(): Train[] {
    return [
      train({ Line: "RD", Destination: "Shady Grove", Car: "6", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Car: "8", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna", Car: "6", Min: "5" }),
    ];
  }

  it("renders the merged summary + 3 trains within the 5-row body (+footer)", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        stationName: "Metro Center",
        trains: trains3(),
        pinned: { line: "RD", destination: "Glenmont" },
        pinnedPosition: {
          label: "* RD 3 stops away",
          schematic: "RD -*--@--------------",
        },
      }),
    );
    const sections = screen.view(screen.init(), { highlightedIndex: 1 }, CTX);
    // The two-column body is the source of truth now (`body` is []). The
    // BODY must fit the 5-row container: 1 merged pinned summary + 3
    // train rows = 4 rows (≤ 5). The old layout pushed a summary row, a
    // "N stops away" row, a schematic row AND 3 train rows = 6 → clip.
    const left = sections.bodyColumns!.left;
    const right = sections.bodyColumns!.right;
    expect(left.length).toBe(4);
    expect(right.length).toBe(4); // left/right stay in lockstep
    expect(left.length).toBeLessThanOrEqual(5);
    // First body row is the merged compact summary (left + ETA value).
    expect(left[0]!).toBe("* RED Glenmont (3 stops)");
    expect(right[0]!).toBe("3 min");
    // The crude ASCII schematic row is gone from the dense view.
    expect(left.some((l) => l.includes("-*--@"))).toBe(false);
    expect(left.some((l) => l.includes("@"))).toBe(false);
    // Every line still fits the column budget.
    expectFits(flattenSections(sections));
    // The pinned train's own body row still carries the `*` marker in its
    // line cell (before the destination word).
    expect(
      left.some(
        (l) =>
          l.startsWith("  RED") &&
          l.includes("Glenmont") &&
          l.slice(0, l.indexOf("Glenmont")).includes("*"),
      ),
    ).toBe(true);
  });

  it("uses full line names everywhere (no 'RD'/'OR' abbreviations on screen)", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: trains3(),
        pinned: { line: "RD", destination: "Glenmont" },
        pinnedPosition: {
          label: "* RD 3 stops away",
          schematic: "RD -*--@--------------",
        },
      }),
    );
    const lines = flattenSections(
      screen.view(screen.init(), { highlightedIndex: 1 }, CTX),
    );
    const blob = lines.join("\n");
    // The body must never surface the 2-letter line codes — full names
    // only (the abbreviations only live in the internal label/schematic
    // data, which we no longer render in this dense view).
    expect(blob).not.toContain("RD ");
    expect(blob).not.toContain("OR ");
    expect(blob).toContain("RED");
    expect(blob).toContain("ORANGE");
  });
});

describe("predictions view: pin + cursor rendering", () => {
  function trains(): Train[] {
    return [
      train({ Line: "RD", Destination: "Shady Grove", Min: "5" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "8" }),
      train({ Line: "OR", Destination: "Vienna", Min: "10" }),
    ];
  }

  it("marks the cursor target with `>` and no pin when nothing pinned", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: trains() }));
    const lines = flattenSections(screen.view(
      screen.init(),
      { highlightedIndex: 1 },
      CTX,
    ));
    // header at 0; trains start at index 1 with no pin row. The cursor's
    // target (Glenmont) carries the `>` marker in its line cell.
    const cursorRow = lines.find(
      (l) =>
        l.startsWith("  RED") &&
        l.includes("Glenmont") &&
        l.slice(0, l.indexOf("Glenmont")).includes(">"),
    );
    expect(cursorRow).toBeDefined();
  });

  it("marks the pinned train with `*` regardless of cursor position", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: trains(),
        pinned: { line: "OR", destination: "Vienna" },
      }),
    );
    const lines = flattenSections(screen.view(
      screen.init(),
      { highlightedIndex: 0 },
      CTX,
    ));
    // Pin row appears under the header (line index 1).
    expect(lines[1]).toMatch(/^\* /);
    expect(lines[1]).toContain("Vienna");
    // The OR/Vienna row in the body carries the `*` marker in its line
    // cell ("ORANGE" fills the cell, so it's shortened for the marker).
    expect(
      lines.some(
        (l) =>
          l.startsWith("  ORANG") &&
          l.includes("Vienna") &&
          l.slice(0, l.indexOf("Vienna")).includes("*"),
      ),
    ).toBe(true);
  });
});

describe("predictions reduce: pin + cursor", () => {
  function trains(): Train[] {
    return [
      train({ Line: "RD", Destination: "Shady Grove", Min: "5" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "8" }),
      train({ Line: "OR", Destination: "Vienna", Min: "10" }),
    ];
  }

  it("SCROLL_DOWN advances the cursor", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: trains() }));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 0 },
      { type: "SCROLL_DOWN" },
    );
    expect(r.nav.highlightedIndex).toBe(1);
  });

  it("SCROLL_DOWN clamps at the last visible train", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: trains() }));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 99 },
      { type: "SCROLL_DOWN" },
    );
    expect(r.nav.highlightedIndex).toBe(2); // 3 visible trains -> max idx 2
  });

  it("SCROLL_UP clamps at 0", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: trains() }));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 0 },
      { type: "SCROLL_UP" },
    );
    expect(r.nav.highlightedIndex).toBe(0);
  });

  it("TAP pins the cursor target", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: trains() }));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 1 },
      { type: "TAP" },
    );
    expect(r.snapshot?.pinned).toEqual({
      line: "RD",
      destination: "Glenmont",
      // WP-I extends the pin shape with the destination code (used
      // to match `/TrainPositions/TrainPositions` entries). Test
      // fixtures use `DestinationCode: null` so it's null here.
      destinationCode: null,
    });
  });

  it("TAP on the already-pinned train UNPINS it", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: trains(),
        pinned: { line: "RD", destination: "Glenmont" },
      }),
    );
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 1 },
      { type: "TAP" },
    );
    expect(r.snapshot?.pinned).toBeNull();
  });

  it("DOUBLE_TAP still navigates Home", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: trains() }));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 1 },
      { type: "DOUBLE_TAP" },
    );
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("SCROLL with empty trains is a no-op", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({ trains: [] }));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 0 },
      { type: "SCROLL_DOWN" },
    );
    expect(r.nav.highlightedIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bucketLastTrainsByLine (WP-J)
// ---------------------------------------------------------------------------

describe("bucketLastTrainsByLine", () => {
  it("buckets entries by destination → line and picks the latest PM time", () => {
    const lastTrains = [
      { Time: "23:30", DestinationStation: "GLN" }, // RD
      { Time: "11:47p", DestinationStation: "SHA" }, // RD (later — wins for RD)
      { Time: "00:12", DestinationStation: "VIE" }, // OR — AM, skipped
      { Time: "22:50", DestinationStation: "VIE" }, // OR (latest PM)
    ];
    const destToLine = new Map<string, string>([
      ["GLN", "RD"],
      ["SHA", "RD"],
      ["VIE", "OR"],
    ]);
    const out = bucketLastTrainsByLine(lastTrains, destToLine);
    expect(out).toEqual([
      { line: "OR", time: "22:50" }, // earliest-departing first
      { line: "RD", time: "11:47p" },
    ]);
  });

  it("returns [] when no entry maps to a known line", () => {
    const out = bucketLastTrainsByLine(
      [{ Time: "23:30", DestinationStation: "GLN" }],
      new Map(),
    );
    expect(out).toEqual([]);
  });

  it("skips AM-time entries (next-day per WMATA docs)", () => {
    const out = bucketLastTrainsByLine(
      [
        { Time: "00:30", DestinationStation: "GLN" }, // AM, skipped
        { Time: "11:47p", DestinationStation: "GLN" },
      ],
      new Map<string, string>([["GLN", "RD"]]),
    );
    expect(out).toEqual([{ line: "RD", time: "11:47p" }]);
  });

  it("skips malformed time entries", () => {
    const out = bucketLastTrainsByLine(
      [
        { Time: "", DestinationStation: "GLN" },
        { Time: "bad", DestinationStation: "GLN" },
        { Time: "11:47p", DestinationStation: "GLN" },
      ],
      new Map<string, string>([["GLN", "RD"]]),
    );
    expect(out).toEqual([{ line: "RD", time: "11:47p" }]);
  });
});

// ---------------------------------------------------------------------------
// WP-M opt-in cursor
// ---------------------------------------------------------------------------

describe("predictions: opt-in cursor (WP-M)", () => {
  function trains3(): Train[] {
    return [
      train({ Line: "RD", Destination: "Shady Grove", Min: "5" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "8" }),
      train({ Line: "OR", Destination: "Vienna", Min: "10" }),
    ];
  }

  it("hides the `>` cursor when cursorVisible is false", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains: trains3(), cursorVisible: false }),
    );
    const lines = flattenSections(screen.view(screen.init(), { highlightedIndex: 0 }, CTX));
    // No train row should carry the ">" cursor marker glyph at all.
    expect(lines.some((l) => l.includes(">"))).toBe(false);
  });

  it("shows the cursor again once cursorVisible is true", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains: trains3(), cursorVisible: true }),
    );
    const lines = flattenSections(screen.view(screen.init(), { highlightedIndex: 0 }, CTX));
    // The cursor target (Shady Grove, idx 0) carries the ">" marker in its
    // line cell.
    expect(
      lines.some(
        (l) =>
          l.startsWith("  RED") &&
          l.includes("Shady Grove") &&
          l.slice(0, l.indexOf("Shady Grove")).includes(">"),
      ),
    ).toBe(true);
  });

  it("a first SCROLL flips cursorVisible to true via the reducer", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains: trains3(), cursorVisible: false }),
    );
    const r = screen.reduce(
      snap({ trains: trains3(), cursorVisible: false }),
      { highlightedIndex: 0 },
      { type: "SCROLL_DOWN" },
    );
    expect(r.snapshot?.cursorVisible).toBe(true);
  });

  it("a TAP also flips cursorVisible (the user has engaged)", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains: trains3(), cursorVisible: false }),
    );
    const r = screen.reduce(
      snap({ trains: trains3(), cursorVisible: false }),
      { highlightedIndex: 0 },
      { type: "TAP" },
    );
    expect(r.snapshot?.cursorVisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WP-M "pinned-train gone" state machine
// ---------------------------------------------------------------------------

describe("predictions: pinned-train gone (WP-M)", () => {
  function trainsWithGlenmont(): Train[] {
    return [train({ Line: "RD", Destination: "Glenmont", Min: "5" })];
  }
  function trainsWithoutGlenmont(): Train[] {
    return [train({ Line: "RD", Destination: "Shady Grove", Min: "5" })];
  }

  it("renders `(gone)` when the pinned train rolled off + pinnedGone is set", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: trainsWithoutGlenmont(),
        pinned: { line: "RD", destination: "Glenmont" },
        pinnedGone: true,
      }),
    );
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expect(lines.some((l) => l.includes("(gone)"))).toBe(true);
  });

  it("the first tick after a roll-off sets pinnedGone (one-tick latch)", async () => {
    // First tick: trains has the pinned train → no gone.
    // Second tick: trains drops the pinned train → pinnedGone latched.
    let mode: "have" | "gone" = "have";
    const fetcher = (): Promise<PredictionsFetchResult> =>
      Promise.resolve({
        trains: mode === "have" ? trainsWithGlenmont() : trainsWithoutGlenmont(),
        incidentHeadline: null,
        lastTrainToday: null,
        pinnedPosition: null,
      });
    const screen = makePredictionsScreen(
      fetcher,
      snap({ pinned: { line: "RD", destination: "Glenmont" } }),
    );
    let s = screen.init();
    s = await screen.tick(s);
    expect(s.pinnedGone).toBe(false);
    expect(s.pinned).not.toBeNull();
    // Roll off.
    mode = "gone";
    s = await screen.tick(s);
    expect(s.pinnedGone).toBe(true);
    expect(s.pinned).not.toBeNull(); // not yet cleared
    // Second consecutive miss → auto-clear.
    s = await screen.tick(s);
    expect(s.pinnedGone).toBe(false);
    expect(s.pinned).toBeNull();
  });
});
