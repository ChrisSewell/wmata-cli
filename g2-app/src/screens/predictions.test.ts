// Unit tests for the Predictions screen.
//
// Acceptance contract:
//   - Every rendered line is ≤ LINE_WIDTH columns across every fixture
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
import { LINE_WIDTH } from "../ui/render";
import type { Train } from "../wmata";
import { initialNav, type ViewContext } from "./router";
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
  findPinnedTrainIndex,
  formatClock,
  isStale,
  makePredictionsScreen,
  pickLastTrainTime,
  renderFooter,
  renderHeader,
  renderLastTrainRow,
  renderPinRow,
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
    expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
  }
}

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
    ...over,
  };
}

/** A noop fetcher — handy for screens that we never tick in a test. */
const noopFetcher = (): Promise<PredictionsFetchResult> =>
  Promise.resolve({ trains: [], incidentHeadline: null, lastTrainToday: null });

// ---------------------------------------------------------------------------
// formatClock
// ---------------------------------------------------------------------------

describe("formatClock", () => {
  it("formats a real timestamp as 24h HH:MM", () => {
    const t = new Date(2026, 4, 18, 9, 5, 0).getTime();
    expect(formatClock(t)).toBe("09:05");
  });

  it("pads single-digit hours and minutes to two digits", () => {
    const t = new Date(2026, 0, 1, 0, 0, 0).getTime();
    expect(formatClock(t)).toBe("00:00");
  });

  it("returns a stable placeholder for epoch-0 / invalid input", () => {
    expect(formatClock(0)).toBe("--:--");
    expect(formatClock(Number.NaN)).toBe("--:--");
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
  it("renders a short station name + clock at exactly LINE_WIDTH cols", () => {
    const out = renderHeader(snap({ stationName: "Metro Center" }), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("Metro Center");
    expect(out).toContain("14:32");
  });

  it("abbreviates a long station name to fit the 18-col name budget", () => {
    const out = renderHeader(
      snap({ stationName: "U Street/African-Amer Civil War Memorial/Cardozo" }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("U Street");
    expect(out).toContain("14:32");
  });

  it("appends '*' when the snapshot is stale (old fetchedAt, no error)", () => {
    const out = renderHeader(
      snap({ fetchedAt: NOW - (STALE_THRESHOLD_MS + 1_000) }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32*")).toBe(true);
  });

  // ----- 3-state stale-marker escalation -----
  //
  // The marker now reflects the *number of consecutive fetch failures*
  // since the last success, not just a binary stale/error flag. We pin
  // each branch verbatim so a future regression has to update the
  // expected glyphs intentionally.

  it("appends '*' after one consecutive fetch failure", () => {
    const out = renderHeader(
      snap({ consecutiveFetchFailures: 1, fetchError: "Slow network" }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32*")).toBe(true);
  });

  it("appends '**' after two consecutive fetch failures", () => {
    const out = renderHeader(
      snap({ consecutiveFetchFailures: 2, fetchError: "Slow network" }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32**")).toBe(true);
  });

  it("appends '?' after three or more consecutive fetch failures", () => {
    const out = renderHeader(
      snap({ consecutiveFetchFailures: 3, fetchError: "Slow network" }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32?")).toBe(true);
  });

  it("appends '?' when no successful fetch ever AND there's an error", () => {
    // fetchedAt=0 with an active error means we've never had data at
    // all. This is the strongest degraded state, marker = '?'.
    const out = renderHeader(
      snap({ fetchedAt: 0, fetchError: "Network down" }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32?")).toBe(true);
  });

  it("steals 2 cols from the name budget when the marker is '**'", () => {
    // "Metro Center" (12 chars) → with **, the name budget is 18-2=16,
    // so the name still fits verbatim. The total line length stays at
    // exactly LINE_WIDTH.
    const out = renderHeader(
      snap({ consecutiveFetchFailures: 2, fetchError: "x" }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("Metro Center");
  });

  it("renders '--:--' placeholder when ctx.nowMs is zero", () => {
    // The wall clock is now sourced from `ctx.nowMs` (passed via the
    // 2nd arg here), not from the snapshot. A zero clock should still
    // produce the canonical placeholder.
    const out = renderHeader(snap({ fetchedAt: 0 }), 0);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("--:--");
  });
});

// ---------------------------------------------------------------------------
// renderTrainRow
// ---------------------------------------------------------------------------

describe("renderTrainRow", () => {
  it("fits a typical row in exactly LINE_WIDTH cols", () => {
    const out = renderTrainRow(
      train({ Line: "RD", Destination: "Shady Grove", Car: "6", Min: "5" }),
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("RD");
    // "Shady Grove" (11 chars) fits the 11-col dest cell verbatim; the
    // abbreviation map's "Shady Grv" only kicks in below 11 cols.
    expect(out).toContain("Shady Grove");
    expect(out).toContain("6c");
    expect(out).toContain("5 min");
  });

  it("renders the ARR sentinel distinguishably", () => {
    const out = renderTrainRow(train({ Min: "ARR" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("ARR");
  });

  it("renders the BRD sentinel distinguishably", () => {
    const out = renderTrainRow(train({ Min: "BRD" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("BRD");
  });

  it("renders the '---' sentinel as the em-dash, never blank", () => {
    const out = renderTrainRow(train({ Min: "---" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("—");
  });

  it("renders the empty-string sentinel as the em-dash, never blank", () => {
    const out = renderTrainRow(train({ Min: "" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("—");
  });

  it("fits 8-car trains with double-digit ETAs", () => {
    const out = renderTrainRow(
      train({ Car: "8", Min: "12", Destination: "Glenmont" }),
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("8c");
    expect(out).toContain("12 min");
  });

  it("collapses an unknown line code to the '--' glyph", () => {
    const out = renderTrainRow(train({ Line: "No" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("--")).toBe(true);
  });

  it("renders a blank cars cell as two spaces, not a stray 'c'", () => {
    const out = renderTrainRow(train({ Car: "" }));
    expect(out.length).toBe(LINE_WIDTH);
    // The cars cell sits between dest and ETA — the literal 'c' should
    // not appear once Car is blank.
    expect(out).not.toContain(" c ");
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
    expect(out.length).toBe(LINE_WIDTH);
    // The dest cell should show "Vienna", not be blank.
    expect(out).toContain("Vienna");
  });

  it("prefers Destination over DestinationName when both are non-empty", () => {
    // The impl prefers the (short) `Destination` field even when it
    // looks like an abbreviation — `DestinationName` is the fallback,
    // not the override. We assert that here so a future refactor that
    // flips the priority will fail this test loudly.
    const out = renderTrainRow(
      train({ Destination: "VN", DestinationName: "Vienna" }),
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("VN");
    // "Vienna" must NOT appear (it would imply DestinationName won).
    expect(out).not.toContain("Vienna");
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
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines[0]).toBe(renderHeader(screen.init(), CTX.nowMs));
    expect(lines.some((l) => l.includes("No trains predicted"))).toBe(true);
    expect(lines.some((l) => l.includes("double-tap to exit"))).toBe(true);
  });

  it("renders a 'Loading…' cue when fetchedAt=0 and no fetchError", () => {
    const initial = snap({ trains: [], fetchedAt: 0, fetchError: null });
    const screen = makePredictionsScreen(noopFetcher, initial);
    const lines = screen.view(screen.init(), initialNav(), CTX);
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
    const lines = screen.view(screen.init(), initialNav(), CTX);
    // Header: "Metro Center" + spaces + "14:32" + "*" (stale because
    // never fetched). With the marker present the name cell shrinks
    // from 18 to 17 cols, so total = 17 + 1 + 6 = 24.
    expect(lines).toEqual([
      "Metro Center      14:32*",
      "Loading…",
      "",
      "(double-tap to exit)",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// view: 1 / 3 / 5 trains
// ---------------------------------------------------------------------------

describe("predictions view: 1, 3, 5 trains", () => {
  it("renders one train + header in 2 lines, every line fits", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains: [train({ Min: "5" })] }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.length).toBe(2);
    expectFits(lines);
  });

  it("renders three trains + header in 4 lines, every line fits", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Min: "5" }),
    ];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.length).toBe(4);
    expectFits(lines);
  });

  it("renders five trains + header in 6 lines, every line fits", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Min: "5" }),
      train({ Line: "SV", Destination: "Wiehle-Reston East", Min: "7" }),
      train({ Line: "BL", Destination: "Franconia-Springfield", Min: "9" }),
    ];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.length).toBe(6);
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
    const lines = screen.view(screen.init(), initialNav(), CTX);
    // header + MAX_VISIBLE_TRAINS body rows = 6
    expect(lines.length).toBe(1 + MAX_VISIBLE_TRAINS);
    expectFits(lines);
    // The first body row should be the BRD train; the last should be T-5.
    expect(lines[1]).toContain("T-BRD");
    expect(lines[5]).toContain("T-5");
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
  it("keeps every row ≤ LINE_WIDTH with the longest destinations and 99 min ETAs", () => {
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
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // Header carries the abbreviated station; every body row carries an
    // abbreviated destination — none of the raw long names should bleed
    // through verbatim.
    expect(lines[0]).not.toContain("African-Amer");
    for (const l of lines.slice(1)) {
      expect(l).not.toContain("Town Center");
      expect(l).not.toContain("National Airport");
    }
  });
});

// ---------------------------------------------------------------------------
// Footer: incident headline / fetch error
// ---------------------------------------------------------------------------

describe("renderFooter", () => {
  it("renders an incident headline with the '!' prefix", () => {
    const out = renderFooter(
      snap({ incidentHeadline: "Single-tracking on RD between A01 and A02." }),
    );
    expect(out).not.toBeNull();
    expect(out!.startsWith("! ")).toBe(true);
    expect(out!.length).toBeLessThanOrEqual(LINE_WIDTH);
  });

  it("returns null when no incident AND no fetch error", () => {
    expect(renderFooter(snap({}))).toBeNull();
  });

  it("returns null when a fetchError exists but we still have prior data (fetchedAt > 0)", () => {
    // Stale `?` marker on the clock is sufficient; the footer is
    // reserved for genuine incidents in that case.
    expect(
      renderFooter(snap({ fetchError: "Network down", fetchedAt: NOW - 1000 })),
    ).toBeNull();
  });

  it("surfaces a fetch error in the footer only when we have NO data (fetchedAt=0)", () => {
    const out = renderFooter(
      snap({ fetchError: "Network down", fetchedAt: 0 }),
    );
    expect(out).not.toBeNull();
    expect(out!.startsWith("? ")).toBe(true);
    expect(out!.length).toBeLessThanOrEqual(LINE_WIDTH);
  });
});

describe("predictions view: footer presence", () => {
  it("appends the footer row when incidentHeadline is set", () => {
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains, incidentHeadline: "Single-tracking RD" }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // header + 1 train + footer = 3
    expect(lines.length).toBe(3);
    expect(lines[2]!.startsWith("! ")).toBe(true);
    expect(lines[2]).toContain("Single-tracking RD");
  });

  it("truncates a long incident headline to fit LINE_WIDTH (24 cols)", () => {
    // 30+ char description that doesn't fit verbatim — the footer must
    // truncate (with the canonical ellipsis) rather than overflow.
    const longHeadline =
      "Single-tracking on RD between Foggy Bottom and Rosslyn";
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains, incidentHeadline: longHeadline }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.length).toBe(3);
    expect(lines[2]!.startsWith("! ")).toBe(true);
    // The footer line is exactly LINE_WIDTH cols when the headline
    // overflows, and must terminate with the canonical ellipsis so the
    // user sees the truncation.
    expect(lines[2]!.length).toBe(LINE_WIDTH);
    expect(lines[2]!.endsWith("…")).toBe(true);
  });

  it("hides the footer when incidentHeadline is null (no alert)", () => {
    // Mirrors what main.ts seeds when the shared incidents cache has no
    // entries for this station's lines. The footer row is omitted —
    // not rendered as a blank line — so the body keeps its full budget.
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ trains, incidentHeadline: null }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.length).toBe(2); // header + 1 train, no footer
    for (const l of lines) expect(l.startsWith("! ")).toBe(false);
  });

  it("omits the footer row entirely when there is nothing to surface", () => {
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.length).toBe(2); // header + 1 train, no footer
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
        lastTrainToday: "23:47",
      });
    const screen = makePredictionsScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.lastTrainToday).toBe("23:47");
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
      });
    const screen = makePredictionsScreen(
      fetcher,
      snap({ lastTrainToday: "23:47" }),
    );
    const next = await screen.tick(screen.init());
    expect(next.lastTrainToday).toBe("23:47");
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
        { Time: "23:47" },
        { Time: "22:15" },
      ]),
    ).toBe("23:47");
  });

  it("ignores AM times (they signify the next day per WMATA docs)", () => {
    // 01:30 is an AM entry — WMATA puts these in LastTrains[] when
    // service crosses midnight. We want the latest PM entry, not
    // tomorrow morning.
    expect(
      pickLastTrainTime([
        { Time: "23:47" },
        { Time: "01:30" },
      ]),
    ).toBe("23:47");
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
      renderLastTrainRow(snap({ lastTrainToday: "23:47" }), MORNING),
    ).toBeNull();
  });

  it("returns null when lastTrainToday is missing", () => {
    expect(renderLastTrainRow(snap({ lastTrainToday: null }), EVENING)).toBeNull();
    expect(renderLastTrainRow(snap({ lastTrainToday: "" }), EVENING)).toBeNull();
  });

  it("renders `Last train: HH:MM` when both conditions are met", () => {
    const out = renderLastTrainRow(
      snap({ lastTrainToday: "23:47" }),
      EVENING,
    );
    expect(out).toBe("Last train: 23:47");
    expect(out!.length).toBeLessThanOrEqual(LINE_WIDTH);
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
        lastTrainToday: "23:47",
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), EVENING_CTX);
    expectFits(lines);
    expect(lines[lines.length - 1]).toBe("Last train: 23:47");
  });

  it("does NOT append the row before LAST_TRAIN_HOUR", () => {
    // CTX (above) is the canonical 14:32 fixture.
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: [train({ Line: "RD", Min: "5" })],
        lastTrainToday: "23:47",
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.some((l) => l.includes("Last train"))).toBe(false);
  });

  it("does NOT append the row when lastTrainToday is null (data not loaded yet)", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: [train({ Line: "RD", Min: "5" })],
        lastTrainToday: null,
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), EVENING_CTX);
    expect(lines.some((l) => l.includes("Last train"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale-check is driven by ctx.nowMs, not the snapshot
// ---------------------------------------------------------------------------

describe("predictions: stale check uses ctx.nowMs (not the snapshot)", () => {
  it("recomputes the stale marker as ctx.nowMs advances and a tick later refreshes fetchedAt", async () => {
    const T = NOW;
    // 1) Snapshot fetched 70s ago — stale relative to T (threshold 60s).
    const s1: PredictionsSnapshot = snap({ fetchedAt: T - 70_000 });
    expect(isStale(s1, T)).toBe(true);
    const h1 = renderHeader(s1, T);
    expect(h1.endsWith("*")).toBe(true);

    // 2) Same snapshot, 5s of wall-clock later (still no fetch). The
    //    host has only run the 1Hz clock tick — the snapshot.fetchedAt
    //    hasn't moved, so the marker MUST still be present.
    expect(isStale(s1, T + 5_000)).toBe(true);
    const h2 = renderHeader(s1, T + 5_000);
    expect(h2.endsWith("*")).toBe(true);

    // 3) A fetch tick finally lands and refreshes fetchedAt to T+5s.
    //    From that moment the snapshot is fresh again, so the marker
    //    disappears.
    const fetcher = () =>
      Promise.resolve<PredictionsFetchResult>({
        trains: [],
        incidentHeadline: null,
        lastTrainToday: null,
      });
    const screen = makePredictionsScreen(fetcher, s1);
    // Pin Date.now() so the tick stamps fetchedAt deterministically.
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(T + 5_000);
    try {
      const s2 = await screen.tick(s1);
      expect(s2.fetchedAt).toBe(T + 5_000);
      expect(isStale(s2, T + 5_000)).toBe(false);
      const h3 = renderHeader(s2, T + 5_000);
      expect(h3.endsWith("*")).toBe(false);
      expect(h3.endsWith("?")).toBe(false);
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
      // Anchor wall-clock so the formatted "HH:MM" string is deterministic
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
        // Bump system clock so HH:MM changes; advance fake timers so
        // the 1Hz interval callback fires.
        vi.setSystemTime(new Date(2026, 4, 18, 14, 32 + s, 0));
        await vi.advanceTimersByTimeAsync(1000);
        grab();
      }

      // We should have at LEAST 4 re-renders (one per clock tick) on
      // top of the initial render. In practice the dedupe filter passes
      // every one because HH:MM changes each step.
      expect(upgrades.length).toBeGreaterThanOrEqual(5);

      // Each rendered first line is the header; pull the clock substring
      // out and check they're strictly increasing in minutes. Header
      // shape: "<name padded> HH:MM*"  (the snapshot is stale because
      // `fetchedAt === 0`, so the `*` marker is present.)
      const minutes = renderedClocks
        .map((line) => line.match(/(\d{2}):(\d{2})/))
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
  it("matches the exact line array", () => {
    const trains: Train[] = [
      train({ Line: "RD", Destination: "Shady Grove", Car: "6", Min: "ARR" }),
      train({ Line: "RD", Destination: "Glenmont", Car: "8", Min: "3" }),
      train({ Line: "OR", Destination: "Vienna/Fairfax-GMU", Car: "6", Min: "5" }),
    ];
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({ stationName: "Metro Center", trains }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);

    expectFits(lines);
    // Exact-pin against the canonical render. Cells (24 cols total):
    //   header:    name(18) + " " + clock(5)
    //   body row:  glyph(2) + " " + dest(11) + " " + cars(2) + " " + eta(6)
    //
    // The first train carries the `>` cursor in place of its second
    // glyph char (v1.2 pin-a-train default cursor — TAP affordance).
    expect(lines).toEqual([
      "Metro Center       14:32",
      "R> Shady Grove 6c    ARR",
      "RD Glenmont    8c  3 min",
      "OR Vienna      6c  5 min",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
    expect(lines[1]!.length).toBe(LINE_WIDTH);
    expect(lines[2]!.length).toBe(LINE_WIDTH);
    expect(lines[3]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: 3 trains + a non-null incidentHeadline → 5-line render
// with the truncated `! …` footer row at the tail.
// ---------------------------------------------------------------------------

describe("predictions view snapshot: 3 trains + incident footer", () => {
  it("matches the exact line array including the truncated footer", () => {
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
        // Long enough to force truncation: "! " (2) + 22 chars of the
        // input + "…" (1) = 24. With the headline below, the rendered
        // footer fills exactly to LINE_WIDTH and ends with `…`.
        incidentHeadline: "Single-tracking on RD between Foggy Bottom",
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines).toEqual([
      "Metro Center       14:32",
      "R> Shady Grove 6c    ARR",
      "RD Glenmont    8c  3 min",
      "OR Vienna      6c  5 min",
      "! Single-tracking on RD…",
    ]);
    expect(lines[4]!.length).toBe(LINE_WIDTH);
    expect(lines[4]!.startsWith("! ")).toBe(true);
    expect(lines[4]!.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pin-a-train (cursor + TAP-to-pin)
// ---------------------------------------------------------------------------

describe("renderTrainRow: cursor + pin markers", () => {
  it("renders the full line glyph when no marker is supplied", () => {
    const out = renderTrainRow(train({ Line: "RD" }));
    expect(out.startsWith("RD")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
  });

  it("replaces the second glyph char with `*` for a pinned train", () => {
    const out = renderTrainRow(train({ Line: "RD" }), "*");
    expect(out.startsWith("R*")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
  });

  it("replaces the second glyph char with `>` for the cursor target", () => {
    const out = renderTrainRow(train({ Line: "OR" }), ">");
    expect(out.startsWith("O>")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
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

  it("renders `* <line> <dest> <eta>` at exactly LINE_WIDTH", () => {
    const visible = [
      train({ Line: "RD", Destination: "Glenmont", Min: "3" }),
    ];
    const out = renderPinRow(
      snap({ pinned: { line: "RD", destination: "Glenmont" } }),
      visible,
    );
    expect(out).not.toBeNull();
    expect(out!.length).toBe(LINE_WIDTH);
    expect(out!).toContain("RD");
    expect(out!).toContain("Glenmont");
    expect(out!).toContain("3 min");
    expect(out!.startsWith("* ")).toBe(true);
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
    const lines = screen.view(
      screen.init(),
      { highlightedIndex: 1 },
      CTX,
    );
    // header at 0; trains start at index 1 with no pin row.
    const cursorRow = lines.find((l) => l.startsWith("R>"));
    expect(cursorRow).toBeDefined();
    expect(cursorRow).toContain("Glenmont");
  });

  it("marks the pinned train with `*` regardless of cursor position", () => {
    const screen = makePredictionsScreen(
      noopFetcher,
      snap({
        trains: trains(),
        pinned: { line: "OR", destination: "Vienna" },
      }),
    );
    const lines = screen.view(
      screen.init(),
      { highlightedIndex: 0 },
      CTX,
    );
    // Pin row appears under the header (line index 1).
    expect(lines[1]).toMatch(/^\* /);
    expect(lines[1]).toContain("Vienna");
    // The OR/Vienna row in the body carries `O*` marker.
    expect(lines.some((l) => l.startsWith("O*") && l.includes("Vienna"))).toBe(
      true,
    );
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
