// Unit tests for the field-level formatters. These run with Vitest and
// have no DOM / SDK dependencies — `format.ts` is a pure-function module.

import { describe, expect, it } from "vitest";
import { ELLIPSIS } from "./render";
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
  it("returns the known abbreviation for 'L'Enfant Plaza' when the full name is too wide", () => {
    expect(abbreviateStation("L'Enfant Plaza", 10)).toBe("L'Enfant");
  });

  it("returns the known abbreviation for the very-long 'U Street...' name", () => {
    const name = "U Street/African-Amer Civil War Memorial/Cardozo";
    expect(abbreviateStation(name, 10)).toBe("U Street");
  });

  it("returns the known abbreviation for 'Mt Vernon Sq 7th St-Convention Center'", () => {
    expect(
      abbreviateStation("Mt Vernon Sq 7th St-Convention Center", 12),
    ).toBe("Mt Vernon");
  });

  it("returns the known abbreviation for 'Ronald Reagan...' as 'DCA'", () => {
    expect(
      abbreviateStation("Ronald Reagan Washington National Airport", 5),
    ).toBe("DCA");
  });

  it("returns the known abbreviation for 'Woodley Park-Zoo/Adams Morgan'", () => {
    expect(abbreviateStation("Woodley Park-Zoo/Adams Morgan", 12)).toBe(
      "Woodley Pk",
    );
  });

  it("returns the canonical name unchanged when it already fits", () => {
    // "Shaw" is shorter than maxLen=10 and not the kind of name we
    // would rewrite even though it's in the map.
    expect(abbreviateStation("Shaw", 10)).toBe("Shaw");
  });

  it("returns a not-in-map name unchanged when it fits maxLen", () => {
    expect(abbreviateStation("Foo Bar", 10)).toBe("Foo Bar");
  });

  it("truncates a not-in-map name that exceeds maxLen with the ellipsis", () => {
    const truncated = abbreviateStation("Something Very Long Indeed", 10);
    expect(truncated.length).toBeLessThanOrEqual(10);
    expect(truncated.endsWith(ELLIPSIS)).toBe(true);
  });

  it("falls back to truncating the abbreviation when the abbrev is also too long", () => {
    // 'Fed Triangle' is 12 chars; force a maxLen of 6 to drive the
    // 'truncate the abbreviation' branch.
    const result = abbreviateStation("Federal Triangle", 6);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
  });

  it("returns the empty string for empty input", () => {
    expect(abbreviateStation("", 10)).toBe("");
  });

  it("returns the empty string for a non-positive maxLen", () => {
    expect(abbreviateStation("Metro Center", 0)).toBe("");
  });

  it("exposes the abbreviation map so other modules can introspect it", () => {
    expect(STATION_ABBREVIATIONS["L'Enfant Plaza"]).toBe("L'Enfant");
    expect(STATION_ABBREVIATIONS["NoMa-Gallaudet U"]).toBe("NoMa");
  });
});

// ---------------------------------------------------------------------------
// Width budget invariant: every abbreviation must fit NAME_WIDTH (10 cols).
// Anything longer is invisibly truncated with `…` at render time, which
// defeats the purpose of having a hand-tuned abbreviation. This guard
// fails CI if a future edit drifts an entry past the budget.
// ---------------------------------------------------------------------------

describe("STATION_ABBREVIATIONS width budget", () => {
  // NAME_WIDTH is defined in screens/home.ts as the abbreviated-name
  // column width on the Home screen (10). It is the *narrowest* place an
  // abbreviation is rendered, so it is the binding constraint here.
  // We hard-code the value (with this comment) rather than reaching
  // across to home.ts to keep ui/format.ts free of screen-layer
  // dependencies. If the column ever widens, bump this value first.
  const ABBREV_BUDGET = 10;

  it("keeps every value at or below the NAME_WIDTH (10) budget", () => {
    const offenders: Array<{ key: string; value: string; len: number }> = [];
    for (const [key, value] of Object.entries(STATION_ABBREVIATIONS)) {
      if (value.length > ABBREV_BUDGET) {
        offenders.push({ key, value, len: value.length });
      }
    }
    // Surface ALL offenders in the failure message at once so a single
    // failing assertion shows the maintainer the full list to fix.
    expect(offenders).toEqual([]);
  });
});
