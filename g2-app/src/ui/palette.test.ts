// Locks the canonical Even Realities design-language tokens so a future
// drift (a stale green, a sub-floor brightness tier) fails loudly here.

import { describe, expect, it } from "vitest";

import { OS_GREEN, TIER } from "./palette";

describe("palette: canonical OS green", () => {
  it("is the official ER-OS Green token (#3DFA44)", () => {
    expect(OS_GREEN).toBe("#3DFA44");
  });
});

describe("palette: brightness tiers", () => {
  it("are valid 16-level greyscale indices (0..15)", () => {
    for (const v of Object.values(TIER)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it("respects the MUTED(6) readability floor", () => {
    // Nothing legible should be rendered below index 6.
    for (const v of Object.values(TIER)) {
      expect(v).toBeGreaterThanOrEqual(TIER.MUTED);
    }
    expect(TIER.MUTED).toBe(6);
  });

  it("is a strictly-descending ladder (PRIMARY > STRONG > SECONDARY > MUTED)", () => {
    expect(TIER.PRIMARY).toBeGreaterThan(TIER.STRONG);
    expect(TIER.STRONG).toBeGreaterThan(TIER.SECONDARY);
    expect(TIER.SECONDARY).toBeGreaterThan(TIER.MUTED);
  });
});
