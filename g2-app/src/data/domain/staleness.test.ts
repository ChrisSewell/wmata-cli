import { describe, it, expect } from "vitest";
import { isStale, stalenessMarker } from "./staleness";

const T = 60_000;

describe("isStale", () => {
  it("is stale when never fetched", () => {
    expect(isStale(0, 1_000_000, T)).toBe(true);
  });
  it("tracks the threshold", () => {
    expect(isStale(1_000_000, 1_000_000 + T - 1, T)).toBe(false);
    expect(isStale(1_000_000, 1_000_000 + T + 1, T)).toBe(true);
  });
});

describe("stalenessMarker", () => {
  const f = (fetchedAt: number, fetchError: string | null, consecutiveFailures: number) => ({
    fetchedAt,
    fetchError,
    consecutiveFailures,
  });
  const now = 1_000_000;
  it("is empty when fresh with no failures", () => {
    expect(stalenessMarker(f(now, null, 0), now, T)).toBe("");
  });
  it("escalates * -> ** -> ? with failures", () => {
    expect(stalenessMarker(f(now, "e", 1), now, T)).toBe("*");
    expect(stalenessMarker(f(now, "e", 2), now, T)).toBe("**");
    expect(stalenessMarker(f(now, "e", 3), now, T)).toBe("?");
  });
  it("marks ? when never fetched but errored", () => {
    expect(stalenessMarker(f(0, "e", 0), now, T)).toBe("?");
  });
  it("marks * when merely stale by time", () => {
    expect(stalenessMarker(f(now - T - 1, null, 0), now, T)).toBe("*");
  });
});
