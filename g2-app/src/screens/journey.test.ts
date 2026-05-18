// Unit tests for the Journey / Commute screen.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { PathStep } from "../wmata";
import { initialNav, type ViewContext } from "./router";
import {
  MINUTES_PER_STOP,
  estimateTravelMinutes,
  estimateTravelMinutesForLegs,
  formatClock,
  formatLineSummary,
  makeInitialJourneySnapshot,
  makeJourneyScreen,
  renderHeader,
  stopsAcrossLegs,
  type JourneyFetchResult,
  type JourneySnapshot,
} from "./journey";

const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();
const CTX: ViewContext = { nowMs: NOW };

function step(over: Partial<PathStep>): PathStep {
  return {
    DistanceToPrev: 0,
    LineCode: "RD",
    SeqNum: 1,
    StationCode: "A01",
    StationName: "Metro Center",
    ...over,
  };
}

function snap(over: Partial<JourneySnapshot> = {}): JourneySnapshot {
  return {
    plan: { origin: "A01", destination: "A04", transfer: "" },
    originName: "Metro Center",
    destinationName: "Foggy Bottom-GWU",
    transferName: "",
    legs: null,
    nextTrain: null,
    fetchedAt: 0,
    fetchError: null,
    ...over,
  };
}

const noopFetcher = (): Promise<JourneyFetchResult> =>
  Promise.resolve({
    legs: null,
    originName: "",
    destinationName: "",
    transferName: "",
    nextTrain: null,
  });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("estimateTravelMinutes", () => {
  it("returns 0 for an empty path", () => {
    expect(estimateTravelMinutes([])).toBe(0);
  });
  it("returns 0 for a path of length 1 (no segments)", () => {
    expect(estimateTravelMinutes([step({})])).toBe(0);
  });
  it("scales linearly with the segment count", () => {
    const path = [step({ SeqNum: 1 }), step({ SeqNum: 2 }), step({ SeqNum: 3 })];
    expect(estimateTravelMinutes(path)).toBe(2 * MINUTES_PER_STOP);
  });
});

describe("estimateTravelMinutesForLegs", () => {
  it("returns 0 for an empty leg list", () => {
    expect(estimateTravelMinutesForLegs([])).toBe(0);
  });

  it("matches the single-leg estimator for one leg", () => {
    const path = [step({ SeqNum: 1 }), step({ SeqNum: 2 })];
    expect(estimateTravelMinutesForLegs([path])).toBe(MINUTES_PER_STOP);
  });

  it("adds a 2-minute transfer dwell between legs", () => {
    const a = [step({ SeqNum: 1 }), step({ SeqNum: 2 })];
    const b = [step({ SeqNum: 1 }), step({ SeqNum: 2 })];
    expect(estimateTravelMinutesForLegs([a, b])).toBe(
      2 * MINUTES_PER_STOP + 2,
    );
  });
});

describe("stopsAcrossLegs", () => {
  it("returns 0 for an empty leg list", () => {
    expect(stopsAcrossLegs([])).toBe(0);
  });
  it("sums intermediate hops across legs", () => {
    const a = [step({ SeqNum: 1 }), step({ SeqNum: 2 }), step({ SeqNum: 3 })];
    const b = [step({ SeqNum: 1 }), step({ SeqNum: 2 })];
    expect(stopsAcrossLegs([a, b])).toBe(3);
  });
});

describe("formatLineSummary", () => {
  it("returns the single line for a one-leg journey", () => {
    const a = [step({ LineCode: "RD" })];
    expect(formatLineSummary([a])).toBe("RD");
  });
  it("joins distinct lines with `→`", () => {
    const a = [step({ LineCode: "OR" })];
    const b = [step({ LineCode: "YL" })];
    expect(formatLineSummary([a, b])).toBe("OR→YL");
  });
  it("dedups consecutive identical line codes", () => {
    // (Unusual but possible if the user picks a same-line transfer.)
    const a = [step({ LineCode: "RD" })];
    const b = [step({ LineCode: "RD" })];
    expect(formatLineSummary([a, b])).toBe("RD");
  });
});

describe("formatClock + renderHeader", () => {
  it("formatClock returns canonical HH:MM", () => {
    expect(formatClock(NOW)).toBe("14:32");
  });

  it("renderHeader for an unconfigured plan collapses to 'Journey' + clock", () => {
    const out = renderHeader(
      snap({ plan: { origin: "", destination: "" } }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("Journey");
    expect(out).toContain("14:32");
  });

  it("renderHeader includes the orig→dest pair when configured", () => {
    const out = renderHeader(snap({}), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("→");
    expect(out).toContain("14:32");
  });
});

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

describe("view: empty plan", () => {
  it("pins the friendly empty-state layout", () => {
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({ plan: { origin: "", destination: "" } }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
    expect(lines.some((l) => l.includes("No journey saved."))).toBe(true);
    expect(lines.some((l) => l.includes("Open phone to add."))).toBe(true);
    expect(lines.some((l) => l.includes("double-tap to return"))).toBe(true);
  });
});

describe("view: not-routable", () => {
  it("surfaces the 'add a transfer' message when legs is empty", () => {
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({ legs: [], fetchedAt: NOW }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.some((l) => l.includes("Not a routable"))).toBe(true);
    expect(lines.some((l) => l.includes("transfer"))).toBe(true);
  });
});

describe("view: happy path (same line)", () => {
  it("renders line summary + stop count + ETA estimate", () => {
    const path = [
      step({ SeqNum: 1, StationCode: "A01", LineCode: "RD" }),
      step({ SeqNum: 2, StationCode: "A02", LineCode: "RD" }),
      step({ SeqNum: 3, StationCode: "A03", LineCode: "RD" }),
      step({ SeqNum: 4, StationCode: "A04", LineCode: "RD" }),
    ];
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({ legs: [path], fetchedAt: NOW }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
    expect(lines.some((l) => l.includes("RD"))).toBe(true);
    expect(lines.some((l) => l.includes("3 stops"))).toBe(true);
    expect(lines.some((l) => l.includes("6 min"))).toBe(true);
  });
});

describe("view: cross-line (two legs)", () => {
  it("renders OR→YL summary + via transfer + combined estimate", () => {
    const leg1 = [
      step({ SeqNum: 1, StationCode: "C01", LineCode: "OR" }),
      step({ SeqNum: 2, StationCode: "C02", LineCode: "OR" }),
      step({ SeqNum: 3, StationCode: "C03", LineCode: "OR" }),
    ];
    const leg2 = [
      step({ SeqNum: 1, StationCode: "C03", LineCode: "YL" }),
      step({ SeqNum: 2, StationCode: "F01", LineCode: "YL" }),
      step({ SeqNum: 3, StationCode: "F02", LineCode: "YL" }),
    ];
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({
        legs: [leg1, leg2],
        transferName: "Lenfant Plaza",
        fetchedAt: NOW,
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
    expect(lines.some((l) => l.includes("OR→YL"))).toBe(true);
    expect(lines.some((l) => l.includes("via Lenfant Plaza"))).toBe(true);
    expect(lines.some((l) => l.includes("4 stops"))).toBe(true);
    // 2 segs × 2 min/seg × 2 legs + 2 dwell = 10 min.
    expect(lines.some((l) => l.includes("10 min"))).toBe(true);
  });
});

describe("view: next-train integration", () => {
  it("renders a 'Next:' row when nextTrain is populated", () => {
    const path = [step({ SeqNum: 1, LineCode: "RD" })];
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({
        legs: [path],
        fetchedAt: NOW,
        nextTrain: { line: "RD", min: "5", destination: "Glenmont" },
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.some((l) => l.includes("Next: RD Glenmont 5 min"))).toBe(
      true,
    );
  });

  it("renders ARR/BRD sentinels without 'min' suffix", () => {
    const path = [step({ SeqNum: 1, LineCode: "RD" })];
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({
        legs: [path],
        fetchedAt: NOW,
        nextTrain: { line: "RD", min: "ARR", destination: "Glenmont" },
      }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.some((l) => l.includes("ARR"))).toBe(true);
    expect(lines.some((l) => /ARR min/.test(l))).toBe(false);
  });
});

describe("view: loading state", () => {
  it("shows 'Loading path…' before the first tick", () => {
    const screen = makeJourneyScreen(noopFetcher, snap({}));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.some((l) => l.includes("Loading path"))).toBe(true);
  });

  it("shows the WMATA-fetch error message when fetchError is set", () => {
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({ fetchError: "boom", fetchedAt: 0 }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.some((l) => l.includes("Couldn't reach WMATA"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

describe("reduce", () => {
  it("DOUBLE_TAP returns to home", () => {
    const screen = makeJourneyScreen(noopFetcher, snap({}));
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "DOUBLE_TAP",
    });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("absorbs SCROLL / TAP as a no-op (read-only screen)", () => {
    const screen = makeJourneyScreen(noopFetcher, snap({}));
    for (const ev of ["SCROLL_UP", "SCROLL_DOWN", "TAP"] as const) {
      const r = screen.reduce(screen.init(), initialNav(), { type: ev });
      expect(r.navigate).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

describe("tick", () => {
  it("folds resolved legs + names + nextTrain into the snapshot", async () => {
    const leg = [step({ SeqNum: 1 }), step({ SeqNum: 2 })];
    const fetcher = () =>
      Promise.resolve<JourneyFetchResult>({
        legs: [leg],
        originName: "Metro Center",
        destinationName: "Foggy Bottom-GWU",
        transferName: "",
        nextTrain: { line: "RD", min: "3", destination: "Glenmont" },
      });
    const screen = makeJourneyScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.legs).toEqual([leg]);
    expect(next.originName).toBe("Metro Center");
    expect(next.destinationName).toBe("Foggy Bottom-GWU");
    expect(next.nextTrain).toEqual({
      line: "RD",
      min: "3",
      destination: "Glenmont",
    });
    expect(next.fetchedAt).toBeGreaterThan(0);
  });

  it("never throws: a fetcher rejection lands on fetchError", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makeJourneyScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.fetchError).toBe("boom");
  });

  it("exposes tickIntervalMs === 0 so the host calls tick once and stops", () => {
    const screen = makeJourneyScreen(noopFetcher, snap({}));
    expect(screen.tickIntervalMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// makeInitialJourneySnapshot
// ---------------------------------------------------------------------------

describe("makeInitialJourneySnapshot", () => {
  it("seeds the snapshot from a plan with both codes", () => {
    const out = makeInitialJourneySnapshot({
      origin: "A01",
      destination: "A04",
    });
    expect(out.plan.origin).toBe("A01");
    expect(out.legs).toBeNull();
  });

  it("seeds an empty plan as 'unconfigured'", () => {
    const out = makeInitialJourneySnapshot({ origin: "", destination: "" });
    expect(out.plan.origin).toBe("");
    expect(out.plan.destination).toBe("");
  });

  it("captures the optional transfer code", () => {
    const out = makeInitialJourneySnapshot({
      origin: "C01",
      destination: "F02",
      transfer: "C03",
    });
    expect(out.plan.transfer).toBe("C03");
    expect(out.transferName).toBe("C03");
  });
});
