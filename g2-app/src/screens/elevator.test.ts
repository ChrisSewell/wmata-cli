// Unit tests for the Elevator/Escalator screen.
//
// Mirrors the Incidents-screen test surface:
//   - Pure helpers (wrap, capDescription, unitGlyph, stationNameOnly,
//     renderUnitHeader, renderHeader, isStale, stalenessMarker)
//   - View: header + body, empty state with EXACT line count, first-
//     load fetch error has its own copy, scroll math.
//   - Reducer: SCROLL_UP / SCROLL_DOWN clamp, DOUBLE_TAP -> home, TAP
//     is a no-op (read-only screen).
//   - Tick: success path resets failure counter, rejection path bumps
//     it, fetcher result with fetchError !== null also bumps it.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { ElevatorIncident } from "../wmata";
import { initialNav, type ViewContext } from "./router";
import {
  MAX_DESC_LINES,
  STALE_THRESHOLD_MS,
  TICK_INTERVAL_MS,
  capDescription,
  flattenBlocks,
  formatClock,
  formatIncidentBlock,
  isStale,
  makeElevatorScreen,
  makeInitialElevatorSnapshot,
  renderHeader,
  renderUnitHeader,
  stalenessMarker,
  stationNameOnly,
  unitGlyph,
  wrap,
  type ElevatorFetchResult,
  type ElevatorSnapshot,
} from "./elevator";

const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();
const CTX: ViewContext = { nowMs: NOW };

function expectFits(lines: string[]): void {
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
  }
}

function incident(over: Partial<ElevatorIncident> = {}): ElevatorIncident {
  return {
    DateOutOfServ: "2026-05-18T13:00:00",
    DateUpdated: "2026-05-18T14:30:00",
    EstimatedReturnToService: null,
    LocationDescription: "Mezzanine to street.",
    StationCode: "A03",
    StationName: "Dupont Circle",
    SymptomDescription: "Service Call",
    UnitName: "A03N04",
    UnitType: "ELEVATOR",
    ...over,
  };
}

function makeSnap(
  incidents: ElevatorIncident[],
  over: Partial<ElevatorSnapshot> = {},
): ElevatorSnapshot {
  return {
    incidents,
    fetchedAt: NOW,
    fetchError: null,
    consecutiveFetchFailures: 0,
    preformatted: incidents.map(formatIncidentBlock),
    ...over,
  };
}

const noopFetcher = (): Promise<ElevatorFetchResult> =>
  Promise.resolve({ incidents: [], fetchedAt: NOW, fetchError: null });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("unitGlyph", () => {
  it("maps ELEVATOR -> E", () => {
    expect(unitGlyph("ELEVATOR")).toBe("E");
  });
  it("maps ESCALATOR -> S", () => {
    expect(unitGlyph("ESCALATOR")).toBe("S");
  });
  it("collapses unknown values to ?", () => {
    expect(unitGlyph("")).toBe("?");
    expect(unitGlyph("UNKNOWN")).toBe("?");
  });
});

describe("stationNameOnly", () => {
  it("strips the entrance suffix at the comma", () => {
    expect(stationNameOnly("Dupont Circle, Q Street Entrance")).toBe(
      "Dupont Circle",
    );
  });
  it("returns single-clause names unchanged", () => {
    expect(stationNameOnly("Foggy Bottom-GWU")).toBe("Foggy Bottom-GWU");
  });
  it("trims trailing whitespace", () => {
    expect(stationNameOnly("Foggy Bottom-GWU   ")).toBe("Foggy Bottom-GWU");
  });
});

describe("wrap", () => {
  it("packs words greedily into the width", () => {
    expect(wrap("one two three four", 11)).toEqual(["one two", "three four"]);
  });
  it("returns an empty array for empty input", () => {
    expect(wrap("", 22)).toEqual([]);
  });
  it("returns an empty array when width <= 1", () => {
    expect(wrap("anything", 1)).toEqual([]);
  });
});

describe("capDescription", () => {
  it("returns the input verbatim when within the cap", () => {
    expect(capDescription(["a", "b"])).toEqual(["a", "b"]);
  });
  it("ellipsis-truncates the last visible line when over the cap", () => {
    const tooMany = Array.from({ length: MAX_DESC_LINES + 2 }, (_, i) =>
      `line-${String(i)}`,
    );
    const out = capDescription(tooMany);
    expect(out.length).toBe(MAX_DESC_LINES);
    expect(out[MAX_DESC_LINES - 1]!.endsWith("…")).toBe(true);
  });
});

describe("renderUnitHeader", () => {
  it("renders an ELEVATOR row as `E <station>`", () => {
    const out = renderUnitHeader(incident({ StationName: "Foggy Bottom-GWU" }));
    expect(out.startsWith("E ")).toBe(true);
    // Width contract: ≤ 22 (BODY_TEXT_WIDTH).
    expect(out.length).toBeLessThanOrEqual(22);
  });

  it("renders an ESCALATOR row as `S <station>`", () => {
    const out = renderUnitHeader(
      incident({ UnitType: "ESCALATOR", StationName: "Dupont Circle" }),
    );
    expect(out.startsWith("S ")).toBe(true);
  });

  it("uses the abbreviation map for long station names", () => {
    const out = renderUnitHeader(
      incident({
        StationName:
          "U Street/African-Amer Civil War Memorial/Cardozo, Vermont Entrance",
      }),
    );
    expect(out).toContain("U Street");
    expect(out.length).toBeLessThanOrEqual(22);
  });
});

// ---------------------------------------------------------------------------
// formatClock + isStale + stalenessMarker
// ---------------------------------------------------------------------------

describe("formatClock", () => {
  it("formats a real timestamp in 12-hour form", () => {
    const t = new Date(2026, 4, 18, 9, 5, 0).getTime();
    expect(formatClock(t)).toBe(" 9:05a");
  });
  it("renders PM hours with a 'p' suffix and 1-12 hour numbering", () => {
    expect(formatClock(new Date(2026, 4, 18, 14, 32, 0).getTime())).toBe(" 2:32p");
    expect(formatClock(new Date(2026, 4, 18, 12, 0, 0).getTime())).toBe("12:00p");
    expect(formatClock(new Date(2026, 4, 18, 0, 0, 0).getTime())).toBe("12:00a");
  });
  it("returns a stable placeholder for epoch-0 / invalid input", () => {
    expect(formatClock(0)).toBe(" --:--");
  });
});

describe("isStale", () => {
  it("treats a never-fetched snapshot as stale", () => {
    expect(isStale(makeSnap([], { fetchedAt: 0 }), NOW)).toBe(true);
  });
  it("treats a fresh fetch as not-stale", () => {
    expect(isStale(makeSnap([], { fetchedAt: NOW - 10_000 }), NOW)).toBe(false);
  });
  it("treats an old fetch as stale", () => {
    expect(
      isStale(makeSnap([], { fetchedAt: NOW - (STALE_THRESHOLD_MS + 1) }), NOW),
    ).toBe(true);
  });
});

describe("stalenessMarker", () => {
  it("returns '' for fresh data with 0 failures", () => {
    expect(stalenessMarker(makeSnap([incident()]), NOW)).toBe("");
  });
  it("returns '*' after 1 failure", () => {
    expect(
      stalenessMarker(
        makeSnap([incident()], {
          consecutiveFetchFailures: 1,
          fetchError: "x",
        }),
        NOW,
      ),
    ).toBe("*");
  });
  it("returns '**' after 2 failures", () => {
    expect(
      stalenessMarker(
        makeSnap([incident()], {
          consecutiveFetchFailures: 2,
          fetchError: "x",
        }),
        NOW,
      ),
    ).toBe("**");
  });
  it("returns '?' after 3+ failures", () => {
    expect(
      stalenessMarker(
        makeSnap([incident()], {
          consecutiveFetchFailures: 5,
          fetchError: "x",
        }),
        NOW,
      ),
    ).toBe("?");
  });
  it("returns '?' for never-fetched + active error", () => {
    expect(
      stalenessMarker(
        makeSnap([], { fetchedAt: 0, fetchError: "Could not reach" }),
        NOW,
      ),
    ).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// renderHeader + view
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  it("renders `ACCESS (n)` + clock at exactly LINE_WIDTH cols", () => {
    const out = renderHeader(makeSnap([incident(), incident()]), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("ACCESS (2)");
    expect(out).toContain("2:32p");
  });

  it("renders `ACCESS` (no count) when the list is empty", () => {
    const out = renderHeader(makeSnap([]), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("ACCESS");
    expect(out).not.toContain("(0)");
  });

  it("appends the 3-state marker per `stalenessMarker`", () => {
    const out = renderHeader(
      makeSnap([incident()], {
        consecutiveFetchFailures: 2,
        fetchError: "x",
      }),
      NOW,
    );
    expect(out.endsWith("2:32p**")).toBe(true);
  });
});

describe("view: empty state", () => {
  it("pins EXACTLY 5 lines for the friendly empty-state copy", () => {
    const screen = makeElevatorScreen(noopFetcher, makeSnap([]));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.length).toBe(5);
    // Header layout: "ACCESS" (6) + 12 spaces + " 2:32p" (6) = 24.
    expect(lines).toEqual([
      "ACCESS             2:32p",
      "No active outages at",
      "your stations.",
      "",
      "(double-tap to return)",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
  });

  it("pins the EXACT 5-line first-load error body", () => {
    const snap = makeSnap([], {
      fetchedAt: 0,
      fetchError: "Could not connect.",
    });
    const screen = makeElevatorScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // Header: "ACCESS" (6) + 11 spaces + " 2:32p?" (7) = 24.
    expect(lines).toEqual([
      "ACCESS            2:32p?",
      "Couldn't reach WMATA.",
      "Will retry shortly.",
      "",
      "(double-tap to return)",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
  });
});

describe("view: with incidents", () => {
  it("renders header + per-outage block(s) within the row budget", () => {
    const incs = [
      incident({
        UnitType: "ELEVATOR",
        StationName: "Foggy Bottom-GWU",
        LocationDescription: "Street to mezzanine.",
      }),
      incident({
        UnitType: "ESCALATOR",
        StationName: "Dupont Circle, Q Street Entrance",
        LocationDescription: "Mezz to plat, west side.",
      }),
    ];
    const screen = makeElevatorScreen(noopFetcher, makeSnap(incs));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines[0]).toContain("ACCESS (2)");
    // Block-header rows carry the unit glyph + the (entrance-stripped)
    // station name. The names fit within the 20-col budget without
    // abbreviation, so they appear verbatim.
    expect(lines.some((l) => l.includes("E Foggy Bottom-GWU"))).toBe(true);
    expect(lines.some((l) => l.includes("S Dupont Circle"))).toBe(true);
  });

  it("inserts a blank-line separator between consecutive outages", () => {
    const incs = [
      incident({ LocationDescription: "Foo." }),
      incident({ StationName: "Foggy Bottom-GWU", LocationDescription: "Bar." }),
    ];
    const blocks = incs.map(formatIncidentBlock);
    const out = flattenBlocks(blocks);
    // Between the two blocks there's an empty string.
    const blankIdx = out.indexOf("");
    expect(blankIdx).toBeGreaterThan(0);
    expect(blankIdx).toBeLessThan(out.length - 1);
  });
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

describe("reduce", () => {
  it("DOUBLE_TAP returns `{ to: 'home' }`", () => {
    const screen = makeElevatorScreen(noopFetcher, makeSnap([incident()]));
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "DOUBLE_TAP",
    });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("TAP is a no-op (read-only screen)", () => {
    const screen = makeElevatorScreen(noopFetcher, makeSnap([incident()]));
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toBeUndefined();
  });

  it("SCROLL_DOWN advances the offset", () => {
    // 3 blocks → ≥ 7 body rows, more than the visible budget.
    const incs = [incident(), incident(), incident()];
    const screen = makeElevatorScreen(noopFetcher, makeSnap(incs));
    const r1 = screen.reduce(
      screen.init(),
      { highlightedIndex: 0 },
      { type: "SCROLL_DOWN" },
    );
    expect(r1.nav.highlightedIndex).toBe(1);
    const r2 = screen.reduce(screen.init(), r1.nav, {
      type: "SCROLL_DOWN",
    });
    expect(r2.nav.highlightedIndex).toBe(2);
  });

  it("SCROLL_UP clamps at 0", () => {
    const screen = makeElevatorScreen(noopFetcher, makeSnap([incident()]));
    const r = screen.reduce(
      screen.init(),
      { highlightedIndex: 0 },
      { type: "SCROLL_UP" },
    );
    expect(r.nav.highlightedIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

describe("tick", () => {
  it("folds a successful fetch into the snapshot and rebuilds preformatted", async () => {
    const incs = [incident()];
    const fetcher = () =>
      Promise.resolve<ElevatorFetchResult>({
        incidents: incs,
        fetchedAt: NOW,
        fetchError: null,
      });
    const screen = makeElevatorScreen(fetcher, makeSnap([]));
    const next = await screen.tick(screen.init());
    expect(next.incidents).toEqual(incs);
    expect(next.fetchError).toBeNull();
    expect(next.preformatted.length).toBe(1);
    expect(next.consecutiveFetchFailures).toBe(0);
  });

  it("never throws: a rejected fetcher stores the error on the snapshot", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makeElevatorScreen(fetcher, makeSnap([incident()]));
    const next = await screen.tick(screen.init());
    expect(next.fetchError).toBe("boom");
    expect(next.consecutiveFetchFailures).toBe(1);
    // Prior outages are preserved.
    expect(next.incidents.length).toBe(1);
  });

  it("treats a fetcher result with fetchError !== null as a failure", async () => {
    const fetcher = () =>
      Promise.resolve<ElevatorFetchResult>({
        incidents: [],
        fetchedAt: 0,
        fetchError: "swallowed network error",
      });
    const screen = makeElevatorScreen(fetcher, makeSnap([]));
    let s = screen.init();
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(1);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(2);
  });

  it("exposes a tickIntervalMs of 60_000 (60s) for the host", () => {
    const screen = makeElevatorScreen(noopFetcher, makeSnap([]));
    expect(screen.tickIntervalMs).toBe(TICK_INTERVAL_MS);
    expect(screen.tickIntervalMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// makeInitialElevatorSnapshot
// ---------------------------------------------------------------------------

describe("makeInitialElevatorSnapshot", () => {
  it("seeds incidents + preformatted from a CachedElevatorIncidents shape", () => {
    const cached = {
      incidents: [incident()],
      fetchedAt: NOW,
      fetchError: null,
    };
    const snap = makeInitialElevatorSnapshot(cached);
    expect(snap.incidents.length).toBe(1);
    expect(snap.preformatted.length).toBe(1);
    expect(snap.consecutiveFetchFailures).toBe(0);
  });
});
