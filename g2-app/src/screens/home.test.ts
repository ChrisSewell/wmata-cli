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
import { initialNav } from "./router";
import {
  VOICE_LABEL,
  makeHomeScreen,
  renderFavoriteRow,
  renderHeader,
  renderLinesSuffix,
  rowCount,
} from "./home";

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

// A stable loader so tests don't share state.
function loaderFor(favorites: FavoriteStation[]) {
  return () => ({ favorites });
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
    const lines = screen.view(snap, initialNav());
    expectFits(lines);
    // header + 5 help/spacing rows + voice = 7 lines (and ≤ TOTAL_ROWS).
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines[0]).toBe(renderHeader(0));
    const voiceLine = lines[lines.length - 1]!;
    expect(voiceLine).toContain(VOICE_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Standard render paths
// ---------------------------------------------------------------------------

describe("home view: 1 favorite", () => {
  it("renders header + 1 favorite row + voice row, every line fits", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]));
    const snap = screen.init();
    const lines = screen.view(snap, initialNav());
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
    const lines = screen.view(snap, { highlightedIndex: 0 });
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
      const lines = screen.view(snap, { highlightedIndex: idx });
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
// Snapshot pin: 3 favorites, highlight at index 1
// ---------------------------------------------------------------------------

describe("home view snapshot: 3 favorites, highlight idx 1", () => {
  it("matches the exact line array", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl, F.unionStn]),
    );
    const snap = screen.init();
    const lines = screen.view(snap, { highlightedIndex: 1 });
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
