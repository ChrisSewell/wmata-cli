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

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { Train } from "../wmata";
import { initialNav } from "./router";
import {
  MAX_VISIBLE_TRAINS,
  STALE_THRESHOLD_MS,
  TICK_INTERVAL_MS,
  formatClock,
  isStale,
  makePredictionsScreen,
  renderFooter,
  renderHeader,
  renderTrainRow,
  sortTrainsForDisplay,
  type PredictionsFetchResult,
  type PredictionsSnapshot,
} from "./predictions";

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

function snap(over: Partial<PredictionsSnapshot>): PredictionsSnapshot {
  return {
    stationCode: "A01",
    stationName: "Metro Center",
    trains: [],
    fetchedAt: NOW,
    fetchError: null,
    incidentHeadline: null,
    nowMs: NOW,
    ...over,
  };
}

/** A noop fetcher — handy for screens that we never tick in a test. */
const noopFetcher = (): Promise<PredictionsFetchResult> =>
  Promise.resolve({ trains: [], incidentHeadline: null });

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
    expect(isStale(snap({ fetchedAt: 0 }))).toBe(true);
  });

  it("treats a fresh fetch (now - fetchedAt < threshold) as not stale", () => {
    expect(isStale(snap({ fetchedAt: NOW - 5_000 }))).toBe(false);
  });

  it("treats an old fetch (> STALE_THRESHOLD_MS) as stale", () => {
    expect(
      isStale(snap({ fetchedAt: NOW - (STALE_THRESHOLD_MS + 1_000) })),
    ).toBe(true);
  });

  it("treats any fetch error as stale, regardless of recency", () => {
    expect(
      isStale(snap({ fetchedAt: NOW, fetchError: "boom" })),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderHeader
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  it("renders a short station name + clock at exactly LINE_WIDTH cols", () => {
    const out = renderHeader(snap({ stationName: "Metro Center" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("Metro Center");
    expect(out).toContain("14:32");
  });

  it("abbreviates a long station name to fit the 18-col name budget", () => {
    const out = renderHeader(
      snap({ stationName: "U Street/African-Amer Civil War Memorial/Cardozo" }),
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("U Street");
    expect(out).toContain("14:32");
  });

  it("appends '*' when the snapshot is stale (old fetchedAt, no error)", () => {
    const out = renderHeader(
      snap({ fetchedAt: NOW - (STALE_THRESHOLD_MS + 1_000) }),
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32*")).toBe(true);
  });

  it("appends '?' when there is an active fetch error", () => {
    const out = renderHeader(snap({ fetchError: "Network down" }));
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32?")).toBe(true);
  });

  it("renders '--:--' placeholder when nowMs is zero", () => {
    const out = renderHeader(snap({ nowMs: 0, fetchedAt: 0 }));
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
    const lines = screen.view(screen.init(), initialNav());
    expectFits(lines);
    expect(lines[0]).toBe(renderHeader(screen.init()));
    expect(lines.some((l) => l.includes("No trains predicted"))).toBe(true);
    expect(lines.some((l) => l.includes("double-tap to exit"))).toBe(true);
  });

  it("renders a 'Loading…' cue when fetchedAt=0 and no fetchError", () => {
    const initial = snap({ trains: [], fetchedAt: 0, fetchError: null });
    const screen = makePredictionsScreen(noopFetcher, initial);
    const lines = screen.view(screen.init(), initialNav());
    expectFits(lines);
    expect(lines.some((l) => l.includes("Loading"))).toBe(true);
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
    const lines = screen.view(screen.init(), initialNav());
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
    const lines = screen.view(screen.init(), initialNav());
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
    const lines = screen.view(screen.init(), initialNav());
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
    const lines = screen.view(screen.init(), initialNav());
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
    const lines = screen.view(screen.init(), initialNav());
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
    const lines = screen.view(screen.init(), initialNav());
    expectFits(lines);
    // header + 1 train + footer = 3
    expect(lines.length).toBe(3);
    expect(lines[2]!.startsWith("! ")).toBe(true);
  });

  it("omits the footer row entirely when there is nothing to surface", () => {
    const trains: Train[] = [train({ Min: "ARR" })];
    const screen = makePredictionsScreen(noopFetcher, snap({ trains }));
    const lines = screen.view(screen.init(), initialNav());
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
    // nowMs is advanced to the wall clock so staleness is re-evaluated.
    expect(next.nowMs).toBeGreaterThanOrEqual(next.fetchedAt);
  });

  it("never throws: a rejected fetcher stores the error on the snapshot", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makePredictionsScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.fetchError).toBe("boom");
    // Trains are preserved across the failure — we don't blank the HUD.
    expect(next.trains).toEqual(snap({}).trains);
  });

  it("exposes a tickIntervalMs of 20_000 (20s) for the host", () => {
    const screen = makePredictionsScreen(noopFetcher, snap({}));
    expect(screen.tickIntervalMs).toBe(TICK_INTERVAL_MS);
    expect(screen.tickIntervalMs).toBe(20_000);
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
    const lines = screen.view(screen.init(), initialNav());

    expectFits(lines);
    // Exact-pin against the canonical render. Cells (24 cols total):
    //   header:    name(18) + " " + clock(5)
    //   body row:  glyph(2) + " " + dest(11) + " " + cars(2) + " " + eta(6)
    expect(lines).toEqual([
      "Metro Center       14:32",
      "RD Shady Grove 6c    ARR",
      "RD Glenmont    8c  3 min",
      "OR Vienna      6c  5 min",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
    expect(lines[1]!.length).toBe(LINE_WIDTH);
    expect(lines[2]!.length).toBe(LINE_WIDTH);
    expect(lines[3]!.length).toBe(LINE_WIDTH);
  });
});
