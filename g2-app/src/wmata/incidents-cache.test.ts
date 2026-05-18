// Unit tests for the surviving exports of `incidents-cache.ts`.
//
// History: this module previously owned a process-wide incidents cache
// (`_cache`, `refreshIncidents`, `readCachedIncidents`,
// `clearIncidentsCache`). The cache has moved to the `Session` class
// (see `src/session.test.ts` for the cached-behaviour tests). What
// remains here is the pure wire-format parser `parseLinesAffected` and
// the `CachedIncidents` shape.
//
// `parseLinesAffected`: the WMATA documentation example uses
// `split(/;[\s]?/)` but in practice the wire returns mixed whitespace
// patterns, including bare `;`, `;<space>`, double spaces, and leading
// whitespace. We exercise each of those.

import { describe, expect, it } from "vitest";
import { parseLinesAffected } from "./incidents-cache";

// ---------------------------------------------------------------------------
// parseLinesAffected
// ---------------------------------------------------------------------------

describe("parseLinesAffected", () => {
  it("parses the canonical `BL; OR; SV;` wire shape", () => {
    expect(parseLinesAffected("BL; OR; SV;")).toEqual(["BL", "OR", "SV"]);
  });

  it("parses the no-space `BL;OR;SV` wire shape", () => {
    expect(parseLinesAffected("BL;OR;SV")).toEqual(["BL", "OR", "SV"]);
  });

  it("returns [] for an empty string", () => {
    expect(parseLinesAffected("")).toEqual([]);
  });

  it("drops unknown line codes silently", () => {
    expect(parseLinesAffected("BL;XX;SV;")).toEqual(["BL", "SV"]);
  });

  it("tolerates heavy whitespace padding (`  ;  BL  ;  `)", () => {
    expect(parseLinesAffected("  ;  BL  ;  ")).toEqual(["BL"]);
  });

  it("dedupes repeated codes while preserving first-seen order", () => {
    expect(parseLinesAffected("RD; BL; RD; BL;")).toEqual(["RD", "BL"]);
  });

  it("returns [] when every separator is empty (`;;;`)", () => {
    expect(parseLinesAffected(";;;")).toEqual([]);
  });

  it("normalizes all-lowercase line codes via toUpperCase", () => {
    // Defensive: WMATA's contract is uppercase but a future API quirk
    // (or a stray test fixture) shouldn't silently drop valid codes.
    expect(parseLinesAffected("rd; bl;")).toEqual(["RD", "BL"]);
  });

  it("normalizes mixed-case line codes via toUpperCase", () => {
    expect(parseLinesAffected("RD; bl;")).toEqual(["RD", "BL"]);
  });
});
