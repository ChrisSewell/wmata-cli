import { describe, it, expect } from "vitest";
import { textWidth, fits, wrapInfo, truncateToPx, maxWidth, ELLIPSIS } from "./measure";

// We assert RELATIVE invariants and budget-respecting behaviour, never absolute
// pixel values — pretext's example numbers drift across versions.

describe("textWidth", () => {
  it("is 0 for empty", () => {
    expect(textWidth("")).toBe(0);
  });
  it("grows with more characters", () => {
    expect(textWidth("Metro Center")).toBeGreaterThan(textWidth("Metro"));
  });
  it("wide glyphs measure wider than narrow ones at equal length", () => {
    expect(textWidth("WWWW")).toBeGreaterThan(textWidth("iiii"));
  });
});

describe("truncateToPx", () => {
  it("returns the input unchanged when it fits", () => {
    const s = "Shady Grove";
    const budget = textWidth(s) + 10;
    expect(truncateToPx(s, budget)).toBe(s);
  });
  it("cuts to the budget and appends a single-glyph ellipsis", () => {
    const s = "Wiehle-Reston East";
    const budget = Math.floor(textWidth(s) / 2);
    const out = truncateToPx(s, budget);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(fits(out, budget)).toBe(true);
    expect(out.length).toBeLessThan(s.length);
  });
  it("returns empty when even the ellipsis cannot fit", () => {
    expect(truncateToPx("anything", 0)).toBe("");
  });
});

describe("wrapInfo", () => {
  it("reports more lines for longer text at a fixed width", () => {
    const short = wrapInfo("Red line", 120).lineCount;
    const long = wrapInfo(
      "Trains single tracking between Fort Totten and Takoma due to a disabled train.",
      120,
    ).lineCount;
    expect(long).toBeGreaterThan(short);
  });
  it("height is lineCount * 27", () => {
    const r = wrapInfo("a few words here", 120);
    expect(r.height).toBe(r.lineCount * 27);
  });
});

describe("maxWidth", () => {
  it("is 0 for an empty list and equals the widest entry", () => {
    expect(maxWidth([])).toBe(0);
    const list = ["1 min", "12 min", "ARR", "Delayed"];
    expect(maxWidth(list)).toBe(Math.max(...list.map(textWidth)));
    expect(maxWidth(list)).toBeGreaterThan(0);
  });
});
