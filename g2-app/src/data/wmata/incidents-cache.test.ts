import { describe, it, expect } from "vitest";
import { parseLinesAffected } from "./incidents-cache";

describe("parseLinesAffected", () => {
  it("parses the canonical semicolon-space form", () => {
    expect(parseLinesAffected("BL; OR; SV;")).toEqual(["BL", "OR", "SV"]);
  });
  it("tolerates missing/extra whitespace", () => {
    expect(parseLinesAffected("BL;OR;SV")).toEqual(["BL", "OR", "SV"]);
    expect(parseLinesAffected("  ; BL ;  ")).toEqual(["BL"]);
  });
  it("drops unknown codes and dedupes, preserving order", () => {
    expect(parseLinesAffected("RD;XX;SV;RD")).toEqual(["RD", "SV"]);
  });
  it("uppercases defensively and returns [] for empty", () => {
    expect(parseLinesAffected("rd;bl")).toEqual(["RD", "BL"]);
    expect(parseLinesAffected("")).toEqual([]);
  });
});
