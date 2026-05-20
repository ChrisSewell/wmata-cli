// Unit tests for the Home screen.
//
// Acceptance contract:
//   - `view()` always returns lines ≤ LINE_WIDTH columns, and favorite
//     rows additionally stay within SAFE_TEXT_WIDTH (the real-text wrap
//     budget) because they are left-flowing prose, not space-padded.
//   - `reduce()` clamps the highlight to [0, rowCount-1].
//   - TAP / DOUBLE_TAP return the right navigation intent.
//   - The empty state renders a friendly help message.
//   - The 5-favorite adversarial case (longest names, many lines each)
//     never overflows SAFE_TEXT_WIDTH.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH, SAFE_TEXT_WIDTH } from "../ui/render";
import type { FavoriteStation } from "../storage/settings";
import type { LineCode } from "../wmata";
import {
  FLAT_LEFT_COLS,
  flattenSections,
  initialNav,
  type ViewContext,
} from "./router";
import {
  ACCESS_LABEL_PREFIX,
  ETA_CELL_WIDTH,
  LEFT_COL_MAX,
  STATUS_ROW_LINE_ORDER,
  etaSortValue,
  favoritesOffset,
  hasAccessRow,
  hasAlertsRow,
  isAccessIndex,
  isAlertsIndex,
  isVoiceIndex,
  makeHomeScreen,
  renderAccessLeft,
  renderAccessRow,
  renderAccessValue,
  renderAlertsLeft,
  renderAlertsValue,
  renderEtaCell,
  renderEtaValue,
  renderFavoriteLeft,
  renderFavoriteRow,
  renderAlertsRow,
  renderHeader,
  renderLinesSuffix,
  rowCount,
  soonestEta,
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

/**
 * Assert a left-flowing favorite row stays within the real-text wrap
 * budget. Favorite rows are prose (no space padding), so the binding
 * constraint is SAFE_TEXT_WIDTH, not LINE_WIDTH.
 */
function expectFavoriteRowFits(row: string): void {
  expect(row.length).toBeLessThanOrEqual(SAFE_TEXT_WIDTH);
}

/**
 * Assert every LEFT-column body line stays within `LEFT_COL_MAX` so it
 * can never run under the borderless right-column value overlay (pinned
 * at ≈ column 50). The right column is positioned by container geometry,
 * not padding, so only the left column needs this guard.
 */
function expectLeftColumnFits(sections: {
  bodyColumns?: { left: string[]; right: string[] };
}): void {
  for (const l of sections.bodyColumns!.left) {
    expect(l.length).toBeLessThanOrEqual(LEFT_COL_MAX);
  }
}

// A stable loader so tests don't share state. The optional second
// argument supplies the `affectedLines` field; the optional third
// supplies `accessOutageCount`; the optional fourth supplies
// `quietHours`; the optional fifth supplies the per-favorite
// `favoriteEtas` map. Most tests use the empty defaults so the row
// count assertions keep their original meanings (an empty ETA map
// renders blank, aligned ETA cells). A non-empty `affectedLines`
// surfaces the status glyph row; a positive `accessOutageCount` adds
// the ACCESS row just beneath it; a true `quietHours` suppresses
// BOTH synthetic alert surfaces.
function loaderFor(
  favorites: FavoriteStation[],
  affectedLines: LineCode[] = [],
  accessOutageCount: number = 0,
  quietHours: boolean = false,
  favoriteEtas: Record<string, string | null> = {},
) {
  return () => ({
    favorites,
    affectedLines,
    accessOutageCount,
    quietHours,
    favoriteEtas,
  });
}

// ---------------------------------------------------------------------------
// Header + helpers
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  it("renders the 'WMATA  Favorites' title only (clock is host-rendered)", () => {
    const h = renderHeader();
    expect(h).toBe("WMATA  Favorites");
    expect(h).toContain("Favorites");
    // The clock is no longer embedded; the title stays within the 50-col
    // budget so it can't collide with the host's top-right clock cell.
    expect(h).not.toContain(" 2:32p");
    expect(h.length).toBeLessThanOrEqual(50);
    expect(h.length).toBeLessThanOrEqual(LINE_WIDTH);
  });
});

describe("renderLinesSuffix", () => {
  it("returns empty for no lines", () => {
    expect(renderLinesSuffix([])).toBe("");
  });

  it("joins 1-3 codes verbatim with spelled-out names", () => {
    expect(renderLinesSuffix(["RD"])).toBe("RED");
    expect(renderLinesSuffix(["RD", "BL"])).toBe("RED BLUE");
    expect(renderLinesSuffix(["RD", "BL", "OR"])).toBe("RED BLUE ORANGE");
  });

  it("joins exactly 4 codes verbatim with spelled-out names", () => {
    expect(renderLinesSuffix(["RD", "BL", "OR", "SV"])).toBe(
      "RED BLUE ORANGE SILVER",
    );
  });

  it("keeps full names for 5+ codes (no +N collapse)", () => {
    expect(renderLinesSuffix(["RD", "BL", "YL", "OR", "GR"])).toBe(
      "RED BLUE YELLOW ORANGE GREEN",
    );
  });

  it("spells out all 6 codes in order", () => {
    expect(renderLinesSuffix(["RD", "BL", "YL", "OR", "GR", "SV"])).toBe(
      "RED BLUE YELLOW ORANGE GREEN SILVER",
    );
  });
});

// ---------------------------------------------------------------------------
// ETA parsing + soonest-train selection (live departure board)
// ---------------------------------------------------------------------------

describe("etaSortValue", () => {
  it("ranks BRD soonest, then ARR, then numeric ascending", () => {
    expect(etaSortValue("BRD")).toBe(-2);
    expect(etaSortValue("ARR")).toBe(-1);
    expect(etaSortValue("0")).toBe(0);
    expect(etaSortValue("4")).toBe(4);
    expect(etaSortValue("12")).toBe(12);
    // Strict ordering: BRD < ARR < 0 < 4 < 12.
    expect(etaSortValue("BRD")).toBeLessThan(etaSortValue("ARR"));
    expect(etaSortValue("ARR")).toBeLessThan(etaSortValue("0"));
    expect(etaSortValue("4")).toBeLessThan(etaSortValue("12"));
  });

  it("sends unknown sentinels ('', '---', junk) to +Infinity (never wins)", () => {
    expect(etaSortValue("")).toBe(Number.POSITIVE_INFINITY);
    expect(etaSortValue("---")).toBe(Number.POSITIVE_INFINITY);
    expect(etaSortValue("DLY")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("soonestEta", () => {
  it("returns null for an empty list", () => {
    expect(soonestEta([])).toBeNull();
  });

  it("returns null when every entry is an unknown sentinel", () => {
    expect(soonestEta(["", "---", ""])).toBeNull();
  });

  it("picks the smallest numeric ETA across a station's lines", () => {
    expect(soonestEta(["8", "4", "12"])).toBe("4");
  });

  it("prefers BRD over ARR over any numeric (verbatim token kept)", () => {
    expect(soonestEta(["5", "ARR", "2"])).toBe("ARR");
    expect(soonestEta(["ARR", "BRD", "1"])).toBe("BRD");
  });

  it("ignores junk entries when a real ETA is present", () => {
    expect(soonestEta(["---", "9", ""])).toBe("9");
  });

  it("keeps the numeric token verbatim (not parsed) for display", () => {
    // "07" would parse to 7 but we keep the raw token; WMATA never
    // zero-pads, but this guards the no-reformatting contract.
    expect(soonestEta(["07"])).toBe("07");
  });
});

// ---------------------------------------------------------------------------
// ETA cell rendering (left-aligned, fixed-width, blank when unknown)
// ---------------------------------------------------------------------------

describe("renderEtaCell", () => {
  it("renders a numeric ETA as '<n> min' left-aligned in a 6-col cell", () => {
    expect(renderEtaCell("4")).toBe("4 min ");
    expect(renderEtaCell("4").length).toBe(ETA_CELL_WIDTH);
  });

  it("renders a 2-digit ETA filling the whole cell", () => {
    expect(renderEtaCell("12")).toBe("12 min");
    expect(renderEtaCell("12").length).toBe(ETA_CELL_WIDTH);
  });

  it("renders ARR / BRD verbatim, padded to the cell width", () => {
    expect(renderEtaCell("ARR")).toBe("ARR   ");
    expect(renderEtaCell("BRD")).toBe("BRD   ");
    expect(renderEtaCell("ARR").length).toBe(ETA_CELL_WIDTH);
    expect(renderEtaCell("BRD").length).toBe(ETA_CELL_WIDTH);
  });

  it("renders null as an all-spaces cell (loading / no train), never 'null'", () => {
    expect(renderEtaCell(null)).toBe(" ".repeat(ETA_CELL_WIDTH));
    expect(renderEtaCell(null)).not.toContain("null");
  });

  it("renders unknown sentinels ('', '---') as a blank cell (kept aligned)", () => {
    expect(renderEtaCell("")).toBe(" ".repeat(ETA_CELL_WIDTH));
    expect(renderEtaCell("---")).toBe(" ".repeat(ETA_CELL_WIDTH));
  });

  it("lets a pathological 3-digit ETA overflow the cell rather than truncate", () => {
    // Losing the digit would be worse than a one-row misalignment.
    expect(renderEtaCell("100")).toBe("100 min");
    expect(renderEtaCell("100").length).toBeGreaterThan(ETA_CELL_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// renderFavoriteRow: ETA column placement + overflow guard
// ---------------------------------------------------------------------------

describe("renderFavoriteRow: ETA column", () => {
  it("places the ETA cell between the cursor prefix and the station name", () => {
    const row = renderFavoriteRow(F.metroCenter, false, "4");
    expect(row).toBe("  4 min  Metro Center · RED BLUE ORANGE SILVER");
    // Name starts at the constant column: 2 prefix + 6 cell + 1 space.
    expect(row.indexOf("Metro Center")).toBe(9);
  });

  it("aligns names across ETAs of different widths (numeric vs ARR vs blank)", () => {
    const numeric = renderFavoriteRow(F.unionStn, false, "4");
    const twoDigit = renderFavoriteRow(F.unionStn, false, "12");
    const arr = renderFavoriteRow(F.unionStn, false, "ARR");
    const brd = renderFavoriteRow(F.unionStn, false, "BRD");
    const blank = renderFavoriteRow(F.unionStn, false, null);
    for (const row of [numeric, twoDigit, arr, brd, blank]) {
      // Every variant lands the station name at the same column.
      expect(row.indexOf("Union Station")).toBe(9);
    }
  });

  it("defaults to a blank ETA cell when no eta arg is passed", () => {
    expect(renderFavoriteRow(F.unionStn, false)).toBe(
      "         Union Station · RED",
    );
  });

  it("never exceeds SAFE_TEXT_WIDTH even with a long name + ETA + many lines", () => {
    // Worst case: longest name, widest 5-line set, plus an ETA column.
    const fav: FavoriteStation = {
      code: "E03",
      name: "U Street/African-Amer Civil War Memorial/Cardozo",
      lines: ["RD", "BL", "YL", "OR", "GR"],
    };
    for (const eta of ["4", "12", "ARR", "BRD", null]) {
      const row = renderFavoriteRow(fav, true, eta);
      expectFavoriteRowFits(row);
      // Codes survive intact at the tail (the name gives way first).
      expect(row.endsWith("RED BLUE YELLOW ORANGE GREEN")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Two-column helpers: renderEtaValue + renderFavoriteLeft
// ---------------------------------------------------------------------------

describe("renderEtaValue", () => {
  it("renders a numeric ETA as '<n> min' with NO padding", () => {
    expect(renderEtaValue("4")).toBe("4 min");
    expect(renderEtaValue("12")).toBe("12 min");
    // The value is its true length — the container, not spaces, aligns it.
    expect(renderEtaValue("4").length).toBe(5);
  });

  it("renders ARR / BRD verbatim", () => {
    expect(renderEtaValue("ARR")).toBe("ARR");
    expect(renderEtaValue("BRD")).toBe("BRD");
  });

  it("returns '' for null (loading / no train), never 'null'", () => {
    expect(renderEtaValue(null)).toBe("");
  });

  it("returns '' for unknown sentinels ('', '---')", () => {
    expect(renderEtaValue("")).toBe("");
    expect(renderEtaValue("---")).toBe("");
  });

  it("keeps a pathological 3-digit ETA whole (no truncation)", () => {
    expect(renderEtaValue("100")).toBe("100 min");
  });
});

describe("renderFavoriteLeft", () => {
  it("is the cursor prefix + name + ' · ' + full line names, NO ETA", () => {
    expect(renderFavoriteLeft(F.metroCenter, false)).toBe(
      "  Metro Center · RED BLUE ORANGE SILVER",
    );
    // Highlighted row swaps the 2-space prefix for "> ".
    expect(renderFavoriteLeft(F.metroCenter, true)).toBe(
      "> Metro Center · RED BLUE ORANGE SILVER",
    );
  });

  it("drops the separator when the favorite has no lines", () => {
    const fav: FavoriteStation = { code: "X01", name: "Empty", lines: [] };
    expect(renderFavoriteLeft(fav, false)).toBe("  Empty");
    expect(renderFavoriteLeft(fav, false)).not.toContain("·");
  });

  it("stays within LEFT_COL_MAX, truncating the NAME but keeping line codes", () => {
    const fav: FavoriteStation = {
      code: "E03",
      name: "U Street/African-Amer Civil War Memorial/Cardozo",
      lines: ["RD", "BL", "YL", "OR", "GR"],
    };
    for (const hl of [false, true]) {
      const left = renderFavoriteLeft(fav, hl);
      expect(left.length).toBeLessThanOrEqual(LEFT_COL_MAX);
      // Line names survive intact at the tail; the name gives way first.
      expect(left.endsWith("RED BLUE YELLOW ORANGE GREEN")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Empty-state
// ---------------------------------------------------------------------------

describe("home view: empty favorites", () => {
  it("renders header + friendly help copy", () => {
    const screen = makeHomeScreen(loaderFor([]));
    const snap = screen.init();
    const sections = screen.view(snap, initialNav(), CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    // header + 2 help lines = 3
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe(renderHeader());
    expect(lines.some((l) => l.includes("No favorites yet."))).toBe(true);
    // Help copy lives in the LEFT column; every help row has an empty
    // value cell (no ETA / count), so flattenSections returns it verbatim.
    expect(sections.body).toEqual([]);
    expect(sections.bodyColumns!.left).toEqual([
      "No favorites yet. Open the phone app",
      "to add your home + commute stations.",
    ]);
    expect(sections.bodyColumns!.right).toEqual(["", ""]);
    expectLeftColumnFits(sections);
  });

});

// ---------------------------------------------------------------------------
// Standard render paths
// ---------------------------------------------------------------------------

describe("home view: 1 favorite", () => {
  it("renders header + 1 favorite row, every line fits", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, initialNav(), CTX));
    expect(lines.length).toBe(2); // header + 1 fav
    expectFits(lines);
    expect(lines[0]).toContain("Favorites");
    expect(lines.some((l) => l.includes("Metro Center"))).toBe(true);
  });

  it("lands the station name + lines in `left` and the ETA in `right`", () => {
    // A loaded ETA proves the two-column split: name on the left, value
    // on the right (no fixed-width padding — the host pins the column).
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter], [], 0, false, { A01: "4" }),
    );
    const snap = screen.init();
    const sections = screen.view(snap, initialNav(), CTX);
    expect(sections.body).toEqual([]);
    expect(sections.bodyColumns!.left).toEqual([
      "> Metro Center · RED BLUE ORANGE SILVER",
    ]);
    expect(sections.bodyColumns!.right).toEqual(["4 min"]);
    expectLeftColumnFits(sections);
  });

  it("renders an empty `right` value for a favorite with no ETA loaded", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]));
    const snap = screen.init();
    const sections = screen.view(snap, initialNav(), CTX);
    // No ETA in the (empty) map → the value cell is "" (the column
    // contract's "no value for this row" sentinel).
    expect(sections.bodyColumns!.right).toEqual([""]);
    expect(sections.bodyColumns!.left[0]).toBe(
      "> Metro Center · RED BLUE ORANGE SILVER",
    );
  });
});

describe("home view: 5 favorites (cap)", () => {
  it.skip("renders header + 5 favorite rows + voice row, every line fits", () => {
    const favs = [
      F.metroCenter,
      F.galleryPl,
      F.unionStn,
      F.lEnfant,
      F.woodleyPark,
    ];
    const screen = makeHomeScreen(loaderFor(favs));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expect(lines.length).toBe(8);
    expectFits(lines);
    expect(lines[0]).toContain("Favorites");
  });
});

describe("home view: adversarial 5 favorites (longest names + many lines)", () => {
  it("keeps every LEFT column within LEFT_COL_MAX with long names + 5 lines each", () => {
    // All five entries get the same lines payload (the maximum
    // realistic 5-line set) so each row's line-name list is as wide as
    // it gets — forcing the station-name truncation path.
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
    // Load a 2-digit ETA for every station so the value column is
    // exercised under the adversarial widths too — the name truncates on
    // the LEFT while the ETA sits independently on the RIGHT.
    const etas: Record<string, string> = {
      E03: "12",
      Q01: "12",
      F03: "12",
      E10: "12",
      C12: "12",
    };
    const screen = makeHomeScreen(loaderFor(favs, [], 0, false, etas));
    const snap = screen.init();
    for (let idx = 0; idx < rowCount(snap); idx++) {
      const sections = screen.view(snap, { highlightedIndex: idx }, CTX);
      const lines = flattenSections(sections);
      expectFits(lines);
      // LEFT column: no line may run under the value overlay (≤ 50).
      expectLeftColumnFits(sections);
      // Each left line still keeps the full line names at its tail (the
      // station name gives way first).
      for (const l of sections.bodyColumns!.left) {
        expect(l.endsWith("RED BLUE YELLOW ORANGE GREEN")).toBe(true);
      }
      // Every value cell carries the 2-digit ETA, unpadded.
      for (const r of sections.bodyColumns!.right) {
        expect(r).toBe("12 min");
      }
      // Flat zip stays within the panel width too.
      for (const l of lines.slice(1)) {
        expect(l.length).toBeLessThanOrEqual(LINE_WIDTH);
      }
    }
  });

  it("shortens the station name but keeps the full line names when a row overflows", () => {
    // Worst case from the design brief: the longest station name with
    // four wide line names. The codes must survive intact; the name
    // gives way (here via its hand-tuned abbreviation "Mt Vernon").
    const fav: FavoriteStation = {
      code: "F03",
      name: "Mt Vernon Sq 7th St-Convention Center",
      lines: ["RD", "BL", "OR", "SV"],
    };
    const row = renderFavoriteRow(fav, false);
    expectFavoriteRowFits(row);
    // Line names are preserved verbatim at the tail.
    expect(row.endsWith("RED BLUE ORANGE SILVER")).toBe(true);
    // The separator survives, so the row reads as "<name> · <lines>".
    expect(row).toContain(" · RED BLUE ORANGE SILVER");
    // The name gave way — the full canonical name does NOT appear, but a
    // shortened form (the abbreviation) does.
    expect(row).not.toContain("Mt Vernon Sq 7th St-Convention Center");
    expect(row).toContain("Mt Vernon");
  });

  it("falls back to whole-row truncation when the line names alone overflow", () => {
    // Pathological: a name plus an absurd line list that exceeds the
    // budget even with an empty name. The row must still not overflow.
    const fav: FavoriteStation = {
      code: "Z99",
      name: "Anytown",
      // 6 full names = "RED BLUE YELLOW ORANGE GREEN SILVER" (35 chars);
      // doubled here purely to force the line-names-too-wide branch.
      lines: [
        "RD", "BL", "YL", "OR", "GR", "SV",
        "RD", "BL", "YL", "OR", "GR", "SV",
      ],
    };
    const row = renderFavoriteRow(fav, false);
    expectFavoriteRowFits(row);
    // The canonical full station name cannot fit, so it's cut down.
    expect(row).not.toContain("Anytown");
    // The row terminates with the ellipsis from whole-row truncation.
    expect(row.endsWith("…")).toBe(true);
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
    expect(r.nav.highlightedIndex).toBe(1);
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
  it.skip("TAP on the voice-lookup row returns navigate.to === 'voice'", () => {
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
  it("renders an empty `lines: []` favorite as just the name, no separator (no crash)", () => {
    const fav: FavoriteStation = {
      code: "X01",
      name: "Empty",
      lines: [],
    };
    const screen = makeHomeScreen(loaderFor([fav]));
    const snap = screen.init();
    const sections = screen.view(snap, { highlightedIndex: 0 }, CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    expect(lines.length).toBe(2); // header + 1 fav
    // No lines → no " · " separator; the LEFT cell is just prefix + name.
    // idx 0 highlights the sole favorite, so it carries the "> " cursor.
    // The ETA is unknown (no map entry) so the RIGHT value is empty and
    // flattenSections returns the left cell verbatim.
    expect(sections.bodyColumns!.left[0]).toBe("> Empty");
    expect(sections.bodyColumns!.right[0]).toBe("");
    expect(lines[1]).toBe("> Empty");
    expect(lines[1]).not.toContain("·");
  });

  it("renders a `name: ''` favorite as prefix + separator + lines, no crash", () => {
    const fav: FavoriteStation = {
      code: "X02",
      name: "",
      lines: ["RD"],
    };
    const screen = makeHomeScreen(loaderFor([fav]));
    const snap = screen.init();
    const sections = screen.view(snap, { highlightedIndex: 0 }, CTX);
    const lines = flattenSections(sections);
    expectFits(lines);
    expect(lines.length).toBe(2); // header + 1 fav
    // Empty name collapses to nothing; idx 0 highlights it, so the LEFT
    // cell is "> " + "" + " · RED". No ETA → empty RIGHT value, so the
    // flat row is the left cell verbatim.
    expect(sections.bodyColumns!.left[0]).toBe(">  · RED");
    expect(sections.bodyColumns!.right[0]).toBe("");
    expect(lines[1]).toBe(">  · RED");
  });

  it("keeps duplicate line codes verbatim (['RD','RD','RD','RD','RD'] -> full names)", () => {
    // Duplicate codes are not de-duplicated; each is spelled out in
    // full. This guards against the renderer assuming unique input.
    expect(renderLinesSuffix(["RD", "RD", "RD", "RD", "RD"])).toBe(
      "RED RED RED RED RED",
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
    const lines = flattenSections(screen.view(snap, initialNav(), CTX));
    expectFits(lines);
    // header + 5 fav rows = 6 lines (clamped). No throw.
    expect(lines.length).toBe(6);
    // The header still reports the clamped count.
    expect(lines[0]).toContain("Favorites");
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
  it("splits each favorite into a left (name + lines) and right (ETA) column", () => {
    // Soonest-train ETAs for each station: a 1-digit numeric, a 2-digit
    // numeric, and the ARR sentinel. These exercise the value column.
    const etas = { A01: "4", B01: "12", B03: "ARR" };
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl, F.unionStn], [], 0, false, etas),
    );
    const snap = screen.init();
    const sections = screen.view(snap, { highlightedIndex: 1 }, CTX);
    // `body` is empty when columns are present; the host + flatten use
    // `bodyColumns`.
    expect(sections.body).toEqual([]);
    // LEFT column: cursor prefix + station name + " · " + full line
    // names, NO ETA. 'highlight at idx 1' puts the "> " cursor on Gallery
    // Pl; the others get the 2-space prefix.
    expect(sections.bodyColumns!.left).toEqual([
      "  Metro Center · RED BLUE ORANGE SILVER",
      "> Gallery Pl-Chinatown · RED YELLOW GREEN",
      "  Union Station · RED",
    ]);
    // RIGHT column: the ETA value verbatim (no fixed-width padding — the
    // host aligns the container by pixel).
    expect(sections.bodyColumns!.right).toEqual(["4 min", "12 min", "ARR"]);
    // The header is unchanged.
    expect(sections.header).toEqual([renderHeader()]);
    // Each left line equals `renderFavoriteLeft` for that row.
    expect(sections.bodyColumns!.left[0]).toBe(
      renderFavoriteLeft(F.metroCenter, false),
    );
    expect(sections.bodyColumns!.left[1]).toBe(
      renderFavoriteLeft(F.galleryPl, true),
    );
    expect(sections.bodyColumns!.left[2]).toBe(
      renderFavoriteLeft(F.unionStn, false),
    );
    // Left column stays clear of the value overlay.
    expectLeftColumnFits(sections);
  });

  it("zips to flat 'padded-left + value' rows via flattenSections", () => {
    const etas = { A01: "4", B01: "12", B03: "ARR" };
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl, F.unionStn], [], 0, false, etas),
    );
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 1 }, CTX));
    expectFits(lines);
    // Header first, then each body row as `padRight(left, FLAT_LEFT_COLS)
    // + right` (the monospace stand-in; the device positions by pixel).
    const padded = (l: string): string =>
      l.length >= FLAT_LEFT_COLS
        ? l.slice(0, FLAT_LEFT_COLS)
        : l + " ".repeat(FLAT_LEFT_COLS - l.length);
    expect(lines[0]).toBe("WMATA  Favorites");
    expect(lines[1]).toBe(padded("  Metro Center · RED BLUE ORANGE SILVER") + "4 min");
    expect(lines[2]).toBe(padded("> Gallery Pl-Chinatown · RED YELLOW GREEN") + "12 min");
    expect(lines[3]).toBe(padded("  Union Station · RED") + "ARR");
    // The value column lands at a constant flat offset across all rows
    // (FLAT_LEFT_COLS) regardless of the left cell's real width — this is
    // the alignment the two-column layout buys.
    expect(lines[1]!.indexOf("4 min")).toBe(FLAT_LEFT_COLS);
    expect(lines[2]!.indexOf("12 min")).toBe(FLAT_LEFT_COLS);
    expect(lines[3]!.indexOf("ARR")).toBe(FLAT_LEFT_COLS);
  });

  it("renders an empty right value when no ETAs are loaded yet", () => {
    // The seeded "loading" state ({} ETA map) must not print "null"; the
    // value cell is simply "" so the host renders nothing on the right.
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl, F.unionStn]),
    );
    const snap = screen.init();
    const sections = screen.view(snap, { highlightedIndex: 1 }, CTX);
    // Left column is the name + lines (highlighted row uses "> ").
    expect(sections.bodyColumns!.left).toEqual([
      "  Metro Center · RED BLUE ORANGE SILVER",
      "> Gallery Pl-Chinatown · RED YELLOW GREEN",
      "  Union Station · RED",
    ]);
    // Every value cell is empty (loading) — no ETA known yet.
    expect(sections.bodyColumns!.right).toEqual(["", "", ""]);
    // No literal "null" leaks into any column.
    for (const l of sections.bodyColumns!.left) expect(l).not.toContain("null");
    for (const r of sections.bodyColumns!.right) expect(r).not.toContain("null");
    // With every right cell empty, flattenSections returns the left
    // cells verbatim (no padding applied for value-less rows).
    const lines = flattenSections(sections);
    expect(lines[1]).toBe("  Metro Center · RED BLUE ORANGE SILVER");
    expect(lines[2]).toBe("> Gallery Pl-Chinatown · RED YELLOW GREEN");
    expect(lines[3]).toBe("  Union Station · RED");
  });
});

// ---------------------------------------------------------------------------
// Alerts row (decoded prose form: `ALERTS · RD · OR        N alerts`)
// ---------------------------------------------------------------------------

describe("renderAlertsRow", () => {
  it("renders 'ALERTS · <line>' on the left with the count on the right", () => {
    const out = renderAlertsRow(new Set<LineCode>(["RD"]), 1, false);
    expect(out.startsWith("  ALERTS · RED")).toBe(true);
    expect(out.endsWith("1 alert")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
  });

  it("joins multiple affected lines with ' · ' in canonical order", () => {
    const out = renderAlertsRow(new Set<LineCode>(["OR", "RD"]), 2, false);
    // STATUS_ROW_LINE_ORDER puts RD before OR — preserve that.
    expect(out).toContain("ALERTS · RED · ORANGE");
    expect(out.endsWith("2 alerts")).toBe(true);
  });

  it("pluralises the count correctly (1 alert vs N alerts)", () => {
    expect(renderAlertsRow(new Set<LineCode>(["RD"]), 1, false)).toContain(
      "1 alert",
    );
    expect(renderAlertsRow(new Set<LineCode>(["RD"]), 3, false)).toContain(
      "3 alerts",
    );
  });

  it("uses the highlight prefix when selected", () => {
    const out = renderAlertsRow(new Set<LineCode>(["RD"]), 1, true);
    expect(out.startsWith("> ")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
  });

  it("collapses to just 'ALERTS' (no separator) when the affected set is empty", () => {
    // Defensive — production code only renders the row when at least
    // one line is affected, but the pure renderer should still
    // produce a non-overflowing string for the empty case.
    const out = renderAlertsRow(new Set<LineCode>(), 0, false);
    expect(out.startsWith("  ALERTS")).toBe(true);
    expect(out).not.toContain(" · ");
  });

  it("exposes the canonical line order for callers", () => {
    expect(STATUS_ROW_LINE_ORDER).toEqual(["RD", "BL", "YL", "OR", "GR", "SV"]);
  });
});

describe("home view: status row presence", () => {
  it("renders the status row at the TOP when ≥ 1 line is affected", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], ["RD", "OR"]));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expectFits(lines);
    // header(1) + status(1) + blank(1) + fav(1) = 4
    expect(lines.length).toBe(4);
    // Status row anchor: decoded prose lists both affected lines.
    expect(lines[1]).toContain("ALERTS · RED");
    expect(lines[1]).toContain("ORANGE");
    // Unaffected lines no longer appear in the prose form.
    expect(lines[1]).not.toContain("BL");
    expect(lines[1]).not.toContain("GR");
    expect(lines.some((l) => l.includes("Metro Center"))).toBe(true);
  });

  it("omits the status row when affectedLines is empty", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], []));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expectFits(lines);
    expect(lines.length).toBe(2); // header + 1 favorite
    // No status row → no bang glyphs in any rendered line.
    expect(lines.some((l) => /[A-Z]{2}!/.test(l))).toBe(false);
  });

  it("places the status row directly BELOW the header (above all favorites)", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], ["RD"]),
    );
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    // header(1) + status(1) + blank(1) + fav(1) + fav(1) = 5
    expect(lines.length).toBe(5);
    expect(lines[1]).toContain("ALERTS · RED");
  });

  it("renders in the empty-favorites state too (above the help text)", () => {
    const screen = makeHomeScreen(loaderFor([], ["RD"]));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expectFits(lines);
    // header + alerts + blank-sep + help1 + help2 = 5
    expect(lines.length).toBe(5);
    expect(lines[1]).toContain("ALERTS · RED");
  });
});

describe("home reduce: status row navigation", () => {
  it("SCROLL_DOWN starts at status (idx 0) and steps onto favorites", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], ["RD"]),
    );
    const snap = screen.init();
    // rowCount = 1 status + 2 favs = 3. Status idx = 0.
    expect(rowCount(snap)).toBe(3);
    expect(hasAlertsRow(snap)).toBe(true);
    expect(isAlertsIndex(snap, 0)).toBe(true);
    expect(favoritesOffset(snap)).toBe(1);
    // Status row at index 0 gets the highlight prefix.
    const linesAt0 = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expect(linesAt0[1]!.startsWith("> ")).toBe(true);
    expect(linesAt0[1]).toContain("ALERTS · RED");
  });

  it("TAP on the status row returns `{ to: 'incidents' }`", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], ["RD"]),
    );
    const snap = screen.init();
    // Status row index = 0.
    const r = screen.reduce(snap, { highlightedIndex: 0 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "incidents" });
  });

  it.skip("VOICE row is the LAST row when status is present (TAP -> 'voice')", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], ["RD"]));
    const snap = screen.init();
    // rowCount = 1 status + 1 fav + 1 voice = 3. VOICE index = 2.
    expect(rowCount(snap)).toBe(2);
    expect(isVoiceIndex(snap, 2)).toBe(true);
    const r = screen.reduce(snap, { highlightedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "voice" });
  });

  it.skip("VOICE row TAP still resolves to 'voice' when status is absent", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], []));
    const snap = screen.init();
    // rowCount = 1 fav + 1 voice = 2. VOICE index = 1.
    expect(rowCount(snap)).toBe(2);
    const r = screen.reduce(snap, { highlightedIndex: 1 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "voice" });
  });

  it("TAP on a favorite (with status row present) navigates by station code", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], ["RD"]),
    );
    const snap = screen.init();
    // Favorites occupy indices [1, 2]. idx=1 is metroCenter.
    const r1 = screen.reduce(snap, { highlightedIndex: 1 }, { type: "TAP" });
    expect(r1.navigate).toEqual({ to: "predictions", stationCode: "A01" });
    // idx=2 is galleryPl.
    const r2 = screen.reduce(snap, { highlightedIndex: 2 }, { type: "TAP" });
    expect(r2.navigate).toEqual({ to: "predictions", stationCode: "B01" });
  });
});

// ---------------------------------------------------------------------------
// ACCESS row (elevator/escalator outages at favorite stations)
// ---------------------------------------------------------------------------

describe("renderAccessRow", () => {
  it("fits exactly LINE_WIDTH cols with the right-aligned outage count", () => {
    const out = renderAccessRow(2, false);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("  " + ACCESS_LABEL_PREFIX)).toBe(true);
    expect(out.endsWith("2 outages")).toBe(true);
  });

  it("renders the highlight prefix when selected", () => {
    const out = renderAccessRow(1, true);
    expect(out.startsWith("> ")).toBe(true);
    expect(out.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// Two-column synthetic-row helpers (alerts / access split)
// ---------------------------------------------------------------------------

describe("renderAlertsLeft / renderAlertsValue", () => {
  it("puts 'ALERTS · <lines>' on the left and the count in the value", () => {
    expect(renderAlertsLeft(new Set<LineCode>(["RD"]), false)).toBe(
      "  ALERTS · RED",
    );
    expect(renderAlertsValue(1)).toBe("1 alert");
    expect(renderAlertsValue(2)).toBe("2 alerts");
  });

  it("joins affected lines in canonical order on the left, no count there", () => {
    const left = renderAlertsLeft(new Set<LineCode>(["OR", "RD"]), false);
    expect(left).toBe("  ALERTS · RED · ORANGE");
    // The count is NOT in the left cell — it lives in the value column.
    expect(left).not.toContain("alert");
  });

  it("uses the highlight prefix on the left when selected", () => {
    expect(renderAlertsLeft(new Set<LineCode>(["RD"]), true).startsWith("> ")).toBe(
      true,
    );
  });

  it("stays within LEFT_COL_MAX", () => {
    const left = renderAlertsLeft(
      new Set<LineCode>(["RD", "BL", "YL", "OR", "GR", "SV"]),
      true,
    );
    expect(left.length).toBeLessThanOrEqual(LEFT_COL_MAX);
  });
});

describe("renderAccessLeft / renderAccessValue", () => {
  it("puts the bare label on the left and the count in the value", () => {
    expect(renderAccessLeft(false)).toBe("  ACCESS");
    expect(renderAccessValue(1)).toBe("1 outage");
    expect(renderAccessValue(2)).toBe("2 outages");
  });

  it("uses the highlight prefix on the left when selected", () => {
    expect(renderAccessLeft(true)).toBe("> ACCESS");
  });
});

describe("home view: ACCESS row placement", () => {
  it("renders the ACCESS row between the status row and the favorites", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], ["RD"], 2));
    const snap = screen.init();
    const sections = screen.view(snap, { highlightedIndex: 0 }, CTX);
    const lines = flattenSections(sections);
    // header + alerts + access + blank + fav = 5
    expect(lines.length).toBe(5);
    expect(lines[1]).toContain("ALERTS · RED");
    expect(lines[2]).toContain("ACCESS");
    expect(lines.some((l) => l.includes("Metro Center"))).toBe(true);
    // Column split: row 0 = alerts (label left, count value), row 1 =
    // access (label left, outage count value), row 2 = blank separator
    // (both empty), row 3 = the favorite (name left, no ETA → "").
    expect(sections.bodyColumns!.left).toEqual([
      "> ALERTS · RED",
      "  ACCESS",
      "",
      "  Metro Center · RED BLUE ORANGE SILVER",
    ]);
    expect(sections.bodyColumns!.right).toEqual([
      "1 alert", // alertCount = affected.size = 1 (only RD)
      "2 outages",
      "",
      "",
    ]);
    expectLeftColumnFits(sections);
  });

  it("renders the ACCESS row at the top when there is no status row", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 1));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    // header + access + blank + fav = 4
    expect(lines.length).toBe(4);
    expect(lines[1]).toContain("ACCESS");
    expect(lines.some((l) => l.includes("Metro Center"))).toBe(true);
  });

  it("omits the ACCESS row when accessOutageCount is 0", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 0));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expect(lines.length).toBe(2); // header + fav
    expect(lines.some((l) => l.includes("ACCESS"))).toBe(false);
  });
});

describe("home reduce: ACCESS row navigation", () => {
  it("TAP on the ACCESS row returns `{ to: 'elevator' }`", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], ["RD"], 2));
    const snap = screen.init();
    // rowCount = status(1) + access(1) + 1 fav = 3. ACCESS = 1.
    expect(rowCount(snap)).toBe(3);
    expect(hasAccessRow(snap)).toBe(true);
    expect(isAccessIndex(snap, 1)).toBe(true);
    const r = screen.reduce(snap, { highlightedIndex: 1 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "elevator" });
  });

  it("ACCESS sits at idx 0 when the status row is hidden", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 3));
    const snap = screen.init();
    expect(isAccessIndex(snap, 0)).toBe(true);
    const r = screen.reduce(snap, { highlightedIndex: 0 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "elevator" });
  });

  it("Favorites index offset is 2 when both synthetic rows are present", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], ["RD"], 1),
    );
    const snap = screen.init();
    expect(favoritesOffset(snap)).toBe(2);
    // idx=2 lands on metroCenter (first favorite).
    const r = screen.reduce(snap, { highlightedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01" });
  });
});

// ---------------------------------------------------------------------------
// Optional tick: refreshes the affected-lines set
// ---------------------------------------------------------------------------

describe("home tick: affected-lines refresh", () => {
  it("folds a new affected-lines set into the snapshot", async () => {
    let calls = 0;
    const screen = makeHomeScreen(loaderFor([F.metroCenter], []), {
      refreshAffectedLines: () => {
        calls += 1;
        return Promise.resolve(["RD", "OR"] as LineCode[]);
      },
      tickIntervalMs: 60_000,
    });
    expect(screen.tickIntervalMs).toBe(60_000);
    expect(screen.tick).toBeDefined();
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(new Set(next.affectedLines)).toEqual(new Set(["RD", "OR"]));
    expect(calls).toBe(1);
  });

  it("swallows fetch errors and keeps the previous affected-lines set", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], ["RD", "BL"]), {
      refreshAffectedLines: () => Promise.reject(new Error("boom")),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(new Set(next.affectedLines)).toEqual(new Set(["RD", "BL"]));
  });

  it("returns the SAME snapshot reference when the set is unchanged", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], ["RD", "BL"]), {
      // Return a fresh array literal with the same members. The
      // dedup logic compares by set membership, so the reference
      // should still be reused.
      refreshAffectedLines: () => Promise.resolve(["BL", "RD"] as LineCode[]),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next).toBe(snap);
  });

  it("omits `tick`/`tickIntervalMs` entirely when no options are passed", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], []));
    expect(screen.tick).toBeUndefined();
    expect(screen.tickIntervalMs).toBeUndefined();
  });

  it("refreshes BOTH affectedLines AND accessOutageCount in one tick", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 0), {
      refreshAffectedLines: () => Promise.resolve(["RD"] as LineCode[]),
      refreshAccessOutageCount: () => Promise.resolve(2),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.affectedLines).toEqual(["RD"]);
    expect(next.accessOutageCount).toBe(2);
  });

  it("preserves the previous accessOutageCount when its refresher rejects", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 5), {
      refreshAffectedLines: () => Promise.resolve(["RD"] as LineCode[]),
      refreshAccessOutageCount: () => Promise.reject(new Error("boom")),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.affectedLines).toEqual(["RD"]);
    // The previous value survives the rejection — the row doesn't blink.
    expect(next.accessOutageCount).toBe(5);
  });

  it("preserves the previous affectedLines when ITS refresher rejects", async () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter], ["BL"], 0),
      {
        refreshAffectedLines: () => Promise.reject(new Error("boom")),
        refreshAccessOutageCount: () => Promise.resolve(1),
        tickIntervalMs: 60_000,
      },
    );
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.affectedLines).toEqual(["BL"]);
    expect(next.accessOutageCount).toBe(1);
  });

  it("registers tick when ONLY refreshAccessOutageCount is supplied", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 0), {
      refreshAccessOutageCount: () => Promise.resolve(3),
      tickIntervalMs: 60_000,
    });
    expect(screen.tick).toBeDefined();
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.accessOutageCount).toBe(3);
  });

  it("refreshes quietHours on each tick", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 0, false), {
      refreshQuietHours: () => Promise.resolve(true),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.quietHours).toBe(true);
  });

  it("preserves quietHours when ITS refresher rejects", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 0, true), {
      refreshQuietHours: () => Promise.reject(new Error("boom")),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.quietHours).toBe(true);
  });

  it("folds a fresh favorite-ETA map into the snapshot", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]), {
      refreshFavoriteEtas: () => Promise.resolve({ A01: "4" }),
      tickIntervalMs: 60_000,
    });
    expect(screen.tick).toBeDefined();
    const snap = screen.init();
    // Seeded loading state: empty map.
    expect(snap.favoriteEtas).toEqual({});
    const next = await screen.tick!(snap);
    expect(next.favoriteEtas).toEqual({ A01: "4" });
  });

  it("registers a tick when ONLY refreshFavoriteEtas is supplied", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter]), {
      refreshFavoriteEtas: () => Promise.resolve({ A01: "ARR" }),
      tickIntervalMs: 60_000,
    });
    expect(screen.tick).toBeDefined();
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.favoriteEtas).toEqual({ A01: "ARR" });
  });

  it("preserves the previous ETA map when its refresher rejects", async () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter], [], 0, false, { A01: "7" }),
      {
        refreshFavoriteEtas: () => Promise.reject(new Error("boom")),
        tickIntervalMs: 60_000,
      },
    );
    const snap = screen.init();
    const next = await screen.tick!(snap);
    // The last-known ETAs survive — the board lingers rather than blanking.
    expect(next.favoriteEtas).toEqual({ A01: "7" });
  });

  it("returns the SAME snapshot reference when the ETA map is unchanged", async () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter], [], 0, false, { A01: "5" }),
      {
        // Fresh object literal, identical contents → value-equal, so the
        // tick should reuse the prior snapshot reference (no re-render).
        refreshFavoriteEtas: () => Promise.resolve({ A01: "5" }),
        tickIntervalMs: 60_000,
      },
    );
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next).toBe(snap);
  });

  it("treats a key appearing or value changing as a real change", async () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter, F.galleryPl], [], 0, false, { A01: "5" }),
      {
        refreshFavoriteEtas: () => Promise.resolve({ A01: "5", B01: "3" }),
        tickIntervalMs: 60_000,
      },
    );
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next).not.toBe(snap);
    expect(next.favoriteEtas).toEqual({ A01: "5", B01: "3" });
  });

  it("refreshes affectedLines, access, quiet, AND etas together in one tick", async () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 0, false), {
      refreshAffectedLines: () => Promise.resolve(["RD"] as LineCode[]),
      refreshAccessOutageCount: () => Promise.resolve(1),
      refreshQuietHours: () => Promise.resolve(false),
      refreshFavoriteEtas: () => Promise.resolve({ A01: "BRD" }),
      tickIntervalMs: 60_000,
    });
    const snap = screen.init();
    const next = await screen.tick!(snap);
    expect(next.affectedLines).toEqual(["RD"]);
    expect(next.accessOutageCount).toBe(1);
    expect(next.quietHours).toBe(false);
    expect(next.favoriteEtas).toEqual({ A01: "BRD" });
  });
});

// ---------------------------------------------------------------------------
// Quiet hours suppression
// ---------------------------------------------------------------------------

describe("home view: quietHours suppression", () => {
  it("suppresses the status glyph row even with active incidents", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter], ["RD", "OR"], 0, true),
    );
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    // header + fav = 2 (status row hidden, no synthetic rows, no blank separator).
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes("RD!"))).toBe(false);
  });

  it("suppresses the ACCESS row even with outages", () => {
    const screen = makeHomeScreen(loaderFor([F.metroCenter], [], 2, true));
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    expect(lines.length).toBe(2); // header + fav
    expect(lines.some((l) => l.includes("ACCESS"))).toBe(false);
  });

  it("re-surfaces both rows once quietHours flips back to false", () => {
    const screen = makeHomeScreen(
      loaderFor([F.metroCenter], ["RD"], 2, false),
    );
    const snap = screen.init();
    const lines = flattenSections(screen.view(snap, { highlightedIndex: 0 }, CTX));
    // header + alerts + access + blank + fav = 5
    expect(lines.length).toBe(5);
  });
});
