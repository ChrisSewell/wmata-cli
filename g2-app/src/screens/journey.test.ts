// Unit tests for the Journey / Commute screen.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { PathStep } from "../wmata";
import { initialNav, type ViewContext } from "./router";
import {
  MINUTES_PER_STOP,
  estimateTravelMinutes,
  formatClock,
  makeInitialJourneySnapshot,
  makeJourneyScreen,
  renderHeader,
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
    plan: { origin: "A01", destination: "A04" },
    originName: "Metro Center",
    destinationName: "Foggy Bottom-GWU",
    path: null,
    fetchedAt: 0,
    fetchError: null,
    ...over,
  };
}

const noopFetcher = (): Promise<JourneyFetchResult> =>
  Promise.resolve({ path: null, originName: "", destinationName: "" });

// ---------------------------------------------------------------------------
// Helpers
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

describe("formatClock + renderHeader", () => {
  it("formatClock returns canonical 12-hour clock", () => {
    expect(formatClock(NOW)).toBe(" 2:32p");
  });

  it("renderHeader for an unconfigured plan collapses to 'Journey' + clock", () => {
    const out = renderHeader(
      snap({ plan: { origin: "", destination: "" } }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("Journey");
    expect(out).toContain("2:32p");
  });

  it("renderHeader includes the orig→dest pair when configured", () => {
    const out = renderHeader(snap({}), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out).toContain("→");
    expect(out).toContain("2:32p");
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

describe("view: cross-line route", () => {
  it("surfaces the 'transfer required' message when path is empty", () => {
    const screen = makeJourneyScreen(
      noopFetcher,
      snap({ path: [], fetchedAt: NOW }),
    );
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines.some((l) => l.includes("Not a same-line"))).toBe(true);
    expect(lines.some((l) => l.includes("Transfer"))).toBe(true);
  });
});

describe("view: happy path", () => {
  it("renders line glyph + stop count + ETA estimate", () => {
    const path = [
      step({ SeqNum: 1, StationCode: "A01", LineCode: "RD" }),
      step({ SeqNum: 2, StationCode: "A02", LineCode: "RD" }),
      step({ SeqNum: 3, StationCode: "A03", LineCode: "RD" }),
      step({ SeqNum: 4, StationCode: "A04", LineCode: "RD" }),
    ];
    const screen = makeJourneyScreen(noopFetcher, snap({ path, fetchedAt: NOW }));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
    expect(lines.some((l) => l.includes("RD"))).toBe(true);
    expect(lines.some((l) => l.includes("3 stops"))).toBe(true);
    expect(lines.some((l) => l.includes("6 min"))).toBe(true);
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
  it("folds a resolved path + names into the snapshot", async () => {
    const path = [step({ SeqNum: 1 }), step({ SeqNum: 2 })];
    const fetcher = () =>
      Promise.resolve<JourneyFetchResult>({
        path,
        originName: "Metro Center",
        destinationName: "Foggy Bottom-GWU",
      });
    const screen = makeJourneyScreen(fetcher, snap({}));
    const next = await screen.tick(screen.init());
    expect(next.path).toEqual(path);
    expect(next.originName).toBe("Metro Center");
    expect(next.destinationName).toBe("Foggy Bottom-GWU");
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
    expect(out.path).toBeNull();
  });

  it("seeds an empty plan as 'unconfigured'", () => {
    const out = makeInitialJourneySnapshot({ origin: "", destination: "" });
    expect(out.plan.origin).toBe("");
    expect(out.plan.destination).toBe("");
  });
});
