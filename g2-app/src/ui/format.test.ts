// Unit tests for the field-level formatters. These run with Vitest and
// have no DOM / SDK dependencies — `format.ts` is a pure-function module.

import { describe, expect, it } from "vitest";
import { ELLIPSIS, textWidth } from "./render";
import {
  STATION_ABBREVIATIONS,
  abbreviateStation,
  formatEta,
  lineGlyph,
} from "./format";

describe("formatEta", () => {
  it("maps empty string to the em-dash sentinel", () => {
    expect(formatEta("")).toBe("—");
  });

  it("maps the WMATA '---' no-prediction sentinel to the em-dash", () => {
    expect(formatEta("---")).toBe("—");
  });

  it("preserves 'ARR' verbatim", () => {
    expect(formatEta("ARR")).toBe("ARR");
  });

  it("preserves 'BRD' verbatim", () => {
    expect(formatEta("BRD")).toBe("BRD");
  });

  it("formats a single-digit minute count", () => {
    expect(formatEta("1")).toBe("1 min");
  });

  it("formats a multi-digit minute count", () => {
    expect(formatEta("12")).toBe("12 min");
  });

  it("returns unknown junk verbatim (defensive)", () => {
    expect(formatEta("abc")).toBe("abc");
  });
});

describe("lineGlyph", () => {
  it("returns each of the six valid line codes unchanged", () => {
    expect(lineGlyph("RD")).toBe("RD");
    expect(lineGlyph("BL")).toBe("BL");
    expect(lineGlyph("YL")).toBe("YL");
    expect(lineGlyph("OR")).toBe("OR");
    expect(lineGlyph("GR")).toBe("GR");
    expect(lineGlyph("SV")).toBe("SV");
  });

  it("returns '--' for a blank line code", () => {
    expect(lineGlyph("")).toBe("--");
  });

  it("returns '--' for the 'No' (non-revenue) line code", () => {
    expect(lineGlyph("No")).toBe("--");
  });

  it("returns '--' for an unknown line code", () => {
    expect(lineGlyph("XX")).toBe("--");
  });
});

describe("abbreviateStation", () => {
  // `abbreviateStation(name, maxPx)` is PIXEL-budgeted now. A 110px
  // budget is wide enough that every hand-tuned abbreviation fits
  // (widest is "Woodley Pk" ≈ 100px) but every canonical name below is
  // far too wide (all > 119px) — so it drives the "reach for the
  // abbreviation" branch.
  const ABBR_BUDGET_PX = 110;

  it("returns the known abbreviation for 'L'Enfant Plaza' when the full name is too wide", () => {
    expect(abbreviateStation("L'Enfant Plaza", ABBR_BUDGET_PX)).toBe(
      "L'Enfant",
    );
  });

  it("returns the known abbreviation for the very-long 'U Street...' name", () => {
    const name = "U Street/African-Amer Civil War Memorial/Cardozo";
    expect(abbreviateStation(name, ABBR_BUDGET_PX)).toBe("U Street");
  });

  it("returns the known abbreviation for 'Mt Vernon Sq 7th St-Convention Center'", () => {
    expect(
      abbreviateStation("Mt Vernon Sq 7th St-Convention Center", ABBR_BUDGET_PX),
    ).toBe("Mt Vernon");
  });

  it("returns the known abbreviation for 'Ronald Reagan...' as 'DCA'", () => {
    expect(
      abbreviateStation(
        "Ronald Reagan Washington National Airport",
        ABBR_BUDGET_PX,
      ),
    ).toBe("DCA");
  });

  it("returns the known abbreviation for 'Woodley Park-Zoo/Adams Morgan'", () => {
    expect(abbreviateStation("Woodley Park-Zoo/Adams Morgan", ABBR_BUDGET_PX)).toBe(
      "Woodley Pk",
    );
  });

  it("returns the canonical name unchanged when it already fits", () => {
    // "Shaw" measures well under the budget and isn't the kind of name we
    // would rewrite even though it's in the map.
    expect(abbreviateStation("Shaw", ABBR_BUDGET_PX)).toBe("Shaw");
  });

  it("returns a not-in-map name unchanged when it fits the pixel budget", () => {
    expect(abbreviateStation("Foo Bar", ABBR_BUDGET_PX)).toBe("Foo Bar");
  });

  it("truncates a not-in-map name that exceeds the budget with the ellipsis", () => {
    const truncated = abbreviateStation("Something Very Long Indeed", ABBR_BUDGET_PX);
    expect(textWidth(truncated)).toBeLessThanOrEqual(ABBR_BUDGET_PX);
    expect(truncated.endsWith(ELLIPSIS)).toBe(true);
  });

  it("falls back to truncating the abbreviation when the abbrev is also too wide", () => {
    // "Fed Tri" measures ≈ 56px; force a 50px budget to drive the
    // 'truncate the abbreviation' branch.
    const result = abbreviateStation("Federal Triangle", 50);
    expect(textWidth(result)).toBeLessThanOrEqual(50);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
  });

  it("returns the empty string for empty input", () => {
    expect(abbreviateStation("", ABBR_BUDGET_PX)).toBe("");
  });

  it("returns the empty string for a non-positive pixel budget", () => {
    expect(abbreviateStation("Metro Center", 0)).toBe("");
  });

  it("exposes the abbreviation map so other modules can introspect it", () => {
    expect(STATION_ABBREVIATIONS["L'Enfant Plaza"]).toBe("L'Enfant");
    expect(STATION_ABBREVIATIONS["NoMa-Gallaudet U"]).toBe("NoMa");
  });
});

// ---------------------------------------------------------------------------
// Width budget invariant: every abbreviation must fit the narrowest column
// it's rendered into, measured in PIXELS (the firmware font). Anything wider
// is invisibly truncated with `…` at render time, which defeats the purpose
// of a hand-tuned abbreviation. This guard fails CI if a future edit drifts
// an entry past the budget.
// ---------------------------------------------------------------------------

describe("STATION_ABBREVIATIONS width budget", () => {
  // The abbreviations are rendered into narrow value cells (the
  // predictions destination / Home abbreviated-name column). 110px is the
  // binding pixel budget — wide enough for every current entry (the
  // widest, "Eisenhower", measures ≈ 101px) while still flagging an entry
  // that drifts long. We hard-code the pixel value (rather than reaching
  // into a screen module) to keep ui/format.ts free of screen-layer deps.
  const ABBREV_BUDGET_PX = 110;

  it("keeps every value at or below the pixel column budget", () => {
    const offenders: Array<{ key: string; value: string; widthPx: number }> = [];
    for (const [key, value] of Object.entries(STATION_ABBREVIATIONS)) {
      const widthPx = textWidth(value);
      if (widthPx > ABBREV_BUDGET_PX) {
        offenders.push({ key, value, widthPx });
      }
    }
    // Surface ALL offenders in the failure message at once so a single
    // failing assertion shows the maintainer the full list to fix.
    expect(offenders).toEqual([]);
  });
});
