// Unit tests for the Home screen.
//
// Acceptance contract:
//   - `view()` always returns lines ≤ LINE_WIDTH columns.
//   - `reduce()` clamps the highlight to [0, rowCount-1].
//   - TAP / DOUBLE_TAP return the right navigation intent.
//   - The empty state renders a help message + a single VOICE LOOKUP row.
//   - The 5-favorite adversarial case (longest names, 5 lines each) still
//     fits in the 24-column grid.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { FavoriteStation } from "../storage/settings";
import { initialNav, type ViewContext } from "./router";
import {
  ALERTS_LABEL_PREFIX,
  VOICE_LABEL,
  makeHomeScreen,
  renderAlertsRow,
  renderFavoriteRow,
  renderHeader,
  renderLinesSuffix,
  rowCount,
} from "./home";

/**
 * Fixed wall clock for view-call ctx. Home doesn't read it, but the
 * `Screen<S>.view` contract requires a `ViewContext` argument now.
 * Using a constant keeps the tests deterministic.
 */
const MOCK_NOW = 1_700_000_000_000;
const CTX: ViewContext = { nowMs: MOCK_NOW };

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const F = {
  metroCenter: {
    code: "A01",
    name: "Metro Center",
    lines: ["RD", "BL", "OR", "SV"],
  } as FavoriteStation,
  galleryPl: {
    code: "B01",
    name: "Gallery Pl-Chinatown",
    lines: ["RD", "YL", "GR"],
  } as FavoriteStation,
  unionStn: {
    code: "B03",
    name: "Union Station",
    lines: ["RD"],
  } as FavoriteStation,
  lEnfant: {
    code: "D03",
    name: "L'Enfant Plaza",
    lines: ["BL", "OR", "YL", "GR"],
  } as FavoriteStation,
  uStreet: {
    code: "E03",
    name: "U Street/African-Amer Civil War Memorial/Cardozo",
    // The whole network only has 6 codes, so 5 is the upper-bound; we
    // intentionally feed all 6 to drive the +N overflow path.
    lines: ["RD", "BL", "YL", "OR", "GR", "SV"],
  } as FavoriteStation,
  woodleyPark: {
    code: "Q01",
    name: "Woodley Park-Zoo/Adams Morgan",
    lines: ["RD", "BL", "YL", "OR", "GR"],
  } as FavoriteStation,
};

function expectFits(lines: string[]): void {
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
  }
}

// A stable loader so tests don't share state. The optional second
// argument supplies the `incidentCount` field added in WP8 — almost
// every test stays at `0` (no alerts) so the existing assertions about
// row counts and indices keep their original meanings.
function loaderFor(favorites: FavoriteStation[], incidentCount: number = 0) {
  return () => ({ favorites, incidentCount });
}

// ---------------------------------------------------------------------------
// Header + helpers
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  it("renders 'WMATA — Favorites (n/5)' at width ≤ LINE_WIDTH", () => {
    for (let n = 0; n <= 5; n++) {
      const h = renderHeader(n);
      expect(h.length).toBeLessThanOrEqual(LINE_WIDTH);
      expect(h).toContain(`(${n}/5)`);
    }
  });
});

describe("renderLinesSuffix", () => {
  it("returns empty for no lines", () => {
    expect(renderLinesSuffix([])).toBe("");
  });

  it("joins 1-3 codes verbatim", () => {
    expect(renderLinesSuffix(["RD"])).toBe("RD");
    expect(renderLinesSuffix(["RD", "BL"])).toBe("RD BL");
    expect(renderLinesSuffix(["RD", "BL", "OR"])).toBe("RD BL OR");
  });

  it("joins exactly 4 codes verbatim (within the 11-col cell)", () => {
    expect(renderLinesSuffix(["RD", "BL", "OR", "SV"])).toBe("RD BL OR SV");
  });

  it("collapses 5 codes into '<a> <b> <c> +N'", () => {
    expect(renderLinesSuffix(["RD", "BL", "YL", "OR", "GR"])).toBe(
      "RD BL YL +2",
    );
  });

  it("handles all 6 codes without exceeding 11 chars", () => {
    const out = renderLinesSuffix(["RD", "BL", "YL", "OR", "GR", "SV"]);
    expect(out).toBe("RD BL YL +3");
    expect(out.length).toBeLessThanOrEqual(11);
  });
});

// ---------------------------------------------------------------------------
// Empty-state
// ---------------------------------------------------------------------------

describe("home view: empty favorites", () => {
  it("renders header + help text + a single VOICE LOOKUP row", () => {
    const screen = makeHomeScreen(loaderFor([]));
    const snap = screen.init();
    const lines = screen.view(snap, initialNav(), CTX);
    expectFits(lines);
    // Exact line count is locked at 4 (per the WP6 Reviewer's "lock
    // per-screen line counts to exact integers" pattern). Drift fails CI.
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe(renderHeader(0));
    expect(lines[1]).toBe("No favorites yet.");
    expect(lines[2]).toBe("Open phone to add.");
    const voiceLine = lines[lines.length - 1]!;
    expect(voiceLine).toContain(VOICE_LABEL);
  });

  it("renders the highlighted VOICE LOOKUP row with '> ' prefix when selected", () => {
    const screen = makeHomeScreen(loaderFor([]));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expect(lines.length).toBe(4);
    // index 0 in the empty state is the voice row itself.
    expect(lines[3]!.startsWith("> ")).toBe(true);
  });

  it("renders the unselected VOICE LOOKUP row with '  ' prefix when not selected", () => {
    const screen = makeHomeScreen(loaderFor([]));
    const snap = screen.init();
    // Force a non-zero highlight (which the reducer would normally clamp,
    // but `view` should still render the voice row as unselected).
    const lines = screen.view(snap, { highlightedIndex: 99 }, CTX);
    expect(lines.length).toBe(4);
    expect(lines[3]!.startsWith("  ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Standard render paths
// ---------------------------------------------------------------------------

describe("home view: 1 favorite", () => {
  it("renders header + 1 favorite row + voice row, every line fits", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]));
    const snap = screen.init();
    const lines = screen.view(snap, initialNav(), CTX);
    expect(lines.length).toBe(3); // header + 1 fav + voice
    expectFits(lines);
    expect(lines[0]).toContain("(1/5)");
    expect(lines[1]).toContain("Metro Ctr");
    expect(lines[2]).toContain(VOICE_LABEL);
  });
});

describe("home view: 5 favorites (cap)", () => {
  it("renders header + 5 favorite rows + voice row, every line fits", () => {
    const favs = [
      F.metroCenter,
      F.galleryPl,
      F.unionStn,
      F.lEnfant,
      F.woodleyPark,
    ];
    const screen = makeHomeScreen(loaderFor(favs));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expect(lines.length).toBe(7);
    expectFits(lines);
    expect(lines[0]).toContain("(5/5)");
  });
});

describe("home view: adversarial 5 favorites (longest names + many lines)", () => {
  it("keeps every line ≤ LINE_WIDTH even with 5+ lines each and the longest names", () => {
    // All five entries get the same lines payload (the maximum
    // realistic 5-line set) so the +N rule fires every row.
    const fav = (code: string, name: string): FavoriteStation => ({
      code,
      name,
      lines: ["RD", "BL", "YL", "OR", "GR"],
    });
    const favs = [
      fav(
        "E03",
        "U Street/African-Amer Civil War Memorial/Cardozo",
      ),
      fav("Q01", "Woodley Park-Zoo/Adams Morgan"),
      fav("F03", "Mt Vernon Sq 7th St-Convention Center"),
      fav("E10", "Archives-Navy Memorial-Penn Quarter"),
      fav("C12", "Ronald Reagan Washington National Airport"),
    ];
    const screen = makeHomeScreen(loaderFor(favs));
    const snap = screen.init();
    for (let idx = 0; idx < rowCount(snap); idx++) {
      const lines = screen.view(snap, { highlightedIndex: idx }, CTX);
      expectFits(lines);
      for (const l of lines) {
        // Every favorite row contains a "+N" suffix.
        if (l.includes("+")) {
          expect(l.length).toBeLessThanOrEqual(LINE_WIDTH);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Highlight clamping
// ---------------------------------------------------------------------------

describe("home reduce: highlight clamping", () => {
  const screen = makeHomeScreen(loaderFor([F.metroCenter, F.galleryPl]));
  const snap = screen.init();
  // rowCount = 2 favorites + 1 voice = 3.

  it("SCROLL_UP at index 0 stays at 0", () => {
    const r = screen.reduce(
      snap,
      { highlightedIndex: 0 },
      { type: "SCROLL_UP" },
    );
    expect(r.nav.highlightedIndex).toBe(0);
    expect(r.navigate).toBeUndefined();
  });

  it("SCROLL_DOWN at the last index stays at the last index", () => {
    const r = screen.reduce(
      snap,
      { highlightedIndex: 2 },
      { type: "SCROLL_DOWN" },
    );
    expect(r.nav.highlightedIndex).toBe(2);
    expect(r.navigate).toBeUndefined();
  });

  it("SCROLL_DOWN advances by 1 in the middle of the list", () => {
    const r = screen.reduce(
      snap,
      { highlightedIndex: 0 },
      { type: "SCROLL_DOWN" },
    );
    expect(r.nav.highlightedIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TAP / DOUBLE_TAP
// ---------------------------------------------------------------------------

describe("home reduce: TAP", () => {
  it("TAP on the voice-lookup row returns navigate.to === 'voice'", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]));
    const snap = screen.init();
    // rowCount = 2; voice row sits at index 1.
    const r = screen.reduce(snap, { highlightedIndex: 1 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "voice" });
  });

  it("TAP on a favorite row navigates to predictions with that station code", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter, F.galleryPl]));
    const snap = screen.init();
    const r = screen.reduce(snap, { highlightedIndex: 1 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "B01" });
  });

  it("TAP in the empty state lands on voice (the only row)", () => {
    const screen = makeHomeScreen(loaderFor([]));
    const snap = screen.init();
    const r = screen.reduce(snap, initialNav(), { type: "TAP" });
    expect(r.navigate).toEqual({ to: "voice" });
  });
});

describe("home reduce: DOUBLE_TAP", () => {
  it("DOUBLE_TAP from any index returns navigate.to === 'exit'", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter, F.galleryPl]));
    const snap = screen.init();
    for (const idx of [0, 1, 2]) {
      const r = screen.reduce(
        snap,
        { highlightedIndex: idx },
        { type: "DOUBLE_TAP" },
      );
      expect(r.navigate).toEqual({ to: "exit" });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases the WP6 Reviewer surfaced (empty lines, empty name, duplicate
// codes, favorites-over-cap clamp)
// ---------------------------------------------------------------------------

describe("home view: edge cases", () => {
  it("renders an empty `lines: []` favorite as 11 spaces in the lines column (no crash)", () => {
    const fav: FavoriteStation = {
      code: "X01",
      name: "Empty",
      lines: [],
    };
    const screen = makeHomeScreen(loaderFor([fav]));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expectFits(lines);
    // The favorite row is exactly LINE_WIDTH cols wide, with the lines
    // cell filled with 11 spaces (LINES_WIDTH = 11).
    expect(lines.length).toBe(3); // header + 1 fav + voice
    expect(lines[1]!.length).toBe(LINE_WIDTH);
    expect(lines[1]!.endsWith("           ")).toBe(true); // 11 trailing spaces
  });

  it("renders a `name: ''` favorite as an empty name column with padding, no crash", () => {
    const fav: FavoriteStation = {
      code: "X02",
      name: "",
      lines: ["RD"],
    };
    const screen = makeHomeScreen(loaderFor([fav]));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expectFits(lines);
    expect(lines.length).toBe(3);
    // After the 2-char highlight prefix, the next 10 chars are the
    // name cell, which should be entirely spaces when name === "".
    expect(lines[1]!.slice(2, 12)).toBe("          "); // 10 spaces
    expect(lines[1]!.length).toBe(LINE_WIDTH);
  });

  it("collapses duplicate line codes via the +N rule (['RD','RD','RD','RD','RD'] -> 'RD RD RD +2')", () => {
    // Duplicate codes are still 5 entries, so the +N rule fires at the
    // tail. This guards against the renderer assuming the input is
    // de-duplicated.
    expect(renderLinesSuffix(["RD", "RD", "RD", "RD", "RD"])).toBe(
      "RD RD RD +2",
    );
  });

  it("clamps favorites.length > MAX_FAVORITES silently to the first 5, no oversized list", () => {
    // Simulate data-corruption / future migration bug: 7 favorites stored.
    const fav = (code: string, name: string): FavoriteStation => ({
      code,
      name,
      lines: ["RD"],
    });
    const corrupt: FavoriteStation[] = [
      fav("A01", "One"),
      fav("A02", "Two"),
      fav("A03", "Three"),
      fav("A04", "Four"),
      fav("A05", "Five"),
      fav("A06", "Six"),
      fav("A07", "Seven"),
    ];
    const screen = makeHomeScreen(loaderFor(corrupt));
    const snap = screen.init();
    const lines = screen.view(snap, initialNav(), CTX);
    expectFits(lines);
    // header + 5 fav rows + voice = 7 lines (clamped). No throw.
    expect(lines.length).toBe(7);
    // The header still reports the clamped count.
    expect(lines[0]).toContain("(5/5)");
    // The 6th & 7th favorites must NOT appear in the rendered output.
    for (const l of lines) {
      expect(l).not.toContain("Six");
      expect(l).not.toContain("Seven");
    }
    // And the reducer doesn't choke either — TAP on the highlighted
    // (clamped) row resolves a valid favorite.
    const r = screen.reduce(snap, { highlightedIndex: 0 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01" });
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: 3 favorites, highlight at index 1
// ---------------------------------------------------------------------------

describe("home view snapshot: 3 favorites, highlight idx 1", () => {
  it("matches the exact line array", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl, F.unionStn]),
    );
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 1 }, CTX);
    // Build expected lines using the helper to keep this in lockstep
    // with the rendering rules. The 'highlight at idx 1' shifts the
    // '> ' prefix to the second favorite (Gallery Pl).
    expect(lines).toEqual([
      renderHeader(3),
      renderFavoriteRow(F.metroCenter, false),
      renderFavoriteRow(F.galleryPl, true),
      renderFavoriteRow(F.unionStn, false),
      "  " + VOICE_LABEL,
    ]);
    expectFits(lines);
    // Explicit visual pin: the expected strings, exactly.
    expect(lines[0]).toBe("WMATA — Favorites (3/5)");
    expect(lines[1]).toBe("  Metro Ctr  RD BL OR SV");
    expect(lines[2]).toBe("> Gallery Pl RD YL GR   ");
    expect(lines[3]).toBe("  Union Stn  RD         ");
    expect(lines[4]).toBe("  VOICE LOOKUP");
    // Each favorite body row is exactly LINE_WIDTH columns wide.
    expect(lines[1]!.length).toBe(LINE_WIDTH);
    expect(lines[2]!.length).toBe(LINE_WIDTH);
    expect(lines[3]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// WP8: ALERTS row (renders only when `incidentCount > 0`)
// ---------------------------------------------------------------------------

describe("renderAlertsRow", () => {
  it("fits exactly LINE_WIDTH cols with a single-digit count and a trailing `!`", () => {
    const out = renderAlertsRow(2, false);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("  " + ALERTS_LABEL_PREFIX + " (2)")).toBe(true);
    expect(out.endsWith("!")).toBe(true);
  });

  it("renders the highlight prefix when selected", () => {
    const out = renderAlertsRow(1, true);
    expect(out.startsWith("> ")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
  });
});

describe("home view: ALERTS row presence", () => {
  it("renders an ALERTS row when incidentCount > 0", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 3));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expectFits(lines);
    // header + 1 favorite + ALERTS + VOICE = 4 lines.
    expect(lines.length).toBe(4);
    const alertsLine = lines.find((l) => l.includes("ALERTS (3)"));
    expect(alertsLine).toBeDefined();
    expect(alertsLine!.endsWith("!")).toBe(true);
    expect(alertsLine!.length).toBe(LINE_WIDTH);
  });

  it("omits the ALERTS row when incidentCount === 0", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 0));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expectFits(lines);
    expect(lines.length).toBe(3); // header + 1 favorite + voice
    expect(lines.some((l) => l.includes("ALERTS"))).toBe(false);
  });

  it("places ALERTS directly ABOVE the VOICE LOOKUP row", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter, F.galleryPl], 2));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    // header(0) + fav(1) + fav(2) + ALERTS(3) + VOICE(4)
    expect(lines.length).toBe(5);
    expect(lines[3]).toContain("ALERTS (2)");
    expect(lines[4]).toContain(VOICE_LABEL);
  });

  it("renders in the empty-favorites state too (above VOICE LOOKUP)", () => {
    const screen = makeHomeScreen(loaderFor([], 1));
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 0 }, CTX);
    expectFits(lines);
    // header + 2 help lines + ALERTS + VOICE = 5
    expect(lines.length).toBe(5);
    expect(lines[3]).toContain("ALERTS (1)");
    expect(lines[4]).toContain(VOICE_LABEL);
  });
});

describe("home reduce: ALERTS row navigation", () => {
  it("SCROLL_DOWN past the favorites lands on the ALERTS row", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], 2),
    );
    const snap = screen.init();
    // rowCount = 2 favs + 1 alerts + 1 voice = 4. ALERTS index = 2.
    expect(rowCount(snap)).toBe(4);
    let nav = { highlightedIndex: 0 };
    for (let i = 0; i < 2; i++) {
      const r = screen.reduce(snap, nav, { type: "SCROLL_DOWN" });
      nav = r.nav;
    }
    expect(nav.highlightedIndex).toBe(2);
    // And the rendered ALERTS line carries the `> ` prefix at idx 2.
    const lines = screen.view(snap, nav, CTX);
    expect(lines[3]!.startsWith("> ")).toBe(true);
    expect(lines[3]).toContain("ALERTS (2)");
  });

  it("TAP on the ALERTS row returns `{ to: 'incidents' }`", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], 2),
    );
    const snap = screen.init();
    // ALERTS row index = 2.
    const r = screen.reduce(snap, { highlightedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "incidents" });
  });

  it("VOICE row is the LAST row when ALERTS is present (TAP -> 'voice')", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 1));
    const snap = screen.init();
    // rowCount = 1 fav + 1 alerts + 1 voice = 3. VOICE index = 2.
    expect(rowCount(snap)).toBe(3);
    const r = screen.reduce(snap, { highlightedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "voice" });
  });

  it("VOICE row TAP still resolves to 'voice' when ALERTS is absent", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 0));
    const snap = screen.init();
    // rowCount = 1 fav + 1 voice = 2. VOICE index = 1.
    expect(rowCount(snap)).toBe(2);
    const r = screen.reduce(snap, { highlightedIndex: 1 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "voice" });
  });
});

// ---------------------------------------------------------------------------
// WP8: optional tick refreshes the incidentCount
// ---------------------------------------------------------------------------

describe("home tick: incident-count refresh", () => {
  it("folds a new count into the snapshot", async () => {
    let calls = 0;
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 0), {
      refreshIncidentCount: () => {
        calls += 1;
        return Promise.resolve(4);
      },
      tickIntervalMs: 60_000,
    });
    expect(screen.tickIntervalMs).toBe(60_000);
    expect(screen.tick).toBeDefined();
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.incidentCount).toBe(4);
    expect(calls).toBe(1);
  });

  it("swallows fetch errors and keeps the previous count", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 7), {
      refreshIncidentCount: () => Promise.reject(new Error("boom")),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.incidentCount).toBe(7);
  });

  it("returns the SAME snapshot reference when the count is unchanged", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 2), {
      refreshIncidentCount: () => Promise.resolve(2),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next).toBe(snap);
  });

  it("omits `tick`/`tickIntervalMs` entirely when no options are passed", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], 0));
    expect(screen.tick).toBeUndefined();
    expect(screen.tickIntervalMs).toBeUndefined();
  });
});
