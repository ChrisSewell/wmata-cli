import { describe, it, expect } from "vitest";
import { makeAlertsScreen, makeInitialAlertsSnapshot, windowRange, type AlertsSnapshot } from "./alerts";
import type { AlertItem } from "../data/domain/alerts";

const items = (n: number): AlertItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "rail" as const, headline: `Alert ${i}`, detail: `Detail ${i}`, title: `T${i}` }));

const ctx = { nowMs: 1_000_000 };
const screen = makeAlertsScreen(async () => ({ items: [], fetchedAt: 0, fetchError: null }), makeInitialAlertsSnapshot());
const snap = (over: Partial<AlertsSnapshot> = {}): AlertsSnapshot => ({ ...makeInitialAlertsSnapshot(), ...over });

describe("windowRange", () => {
  it("returns the whole range when it fits", () => {
    expect(windowRange(0, 4, 6)).toEqual({ start: 0, end: 4 });
  });
  it("keeps the selection centered and clamped within bounds", () => {
    expect(windowRange(0, 20, 6)).toEqual({ start: 0, end: 6 });
    expect(windowRange(10, 20, 6)).toEqual({ start: 7, end: 13 });
    expect(windowRange(19, 20, 6)).toEqual({ start: 14, end: 20 });
  });
});

describe("view states", () => {
  it("loading / empty / error / populated", () => {
    expect((screen.view(snap(), { selectedIndex: 0 }, ctx).body as { lines: string[] }).lines[0]).toBe("Loading…");
    const empty = screen.view(snap({ fetchedAt: ctx.nowMs }), { selectedIndex: 0 }, ctx);
    expect((empty.body as { lines: string[] }).lines[0]).toContain("running normally");
    const err = screen.view(snap({ fetchError: "boom" }), { selectedIndex: 0 }, ctx);
    expect((err.body as { lines: string[] }).lines[0]).toContain("Couldn't reach");
    const pop = screen.view(snap({ fetchedAt: ctx.nowMs, items: items(3) }), { selectedIndex: 0 }, ctx);
    expect(pop.body.kind).toBe("rows");
  });
  it("shows a position marker only when the list exceeds the window", () => {
    const v = screen.view(snap({ fetchedAt: ctx.nowMs, items: items(10) }), { selectedIndex: 4 }, ctx);
    expect(v.header.marker).toBe("5/10");
  });
});

describe("reduce", () => {
  const loaded = snap({ fetchedAt: ctx.nowMs, items: items(3) });
  it("opens detail for the selected row on press", () => {
    expect(screen.reduce(loaded, { selectedIndex: 2 }, { type: "TAP" }).navigate).toEqual({ to: "alertDetail", index: 2 });
  });
  it("double-press returns to home", () => {
    expect(screen.reduce(loaded, { selectedIndex: 0 }, { type: "DOUBLE_TAP" }).navigate).toEqual({ to: "home" });
  });
  it("scroll clamps to the list bounds", () => {
    expect(screen.reduce(loaded, { selectedIndex: 0 }, { type: "SCROLL_UP" }).nav.selectedIndex).toBe(0);
    expect(screen.reduce(loaded, { selectedIndex: 2 }, { type: "SCROLL_DOWN" }).nav.selectedIndex).toBe(2);
  });
  it("press retries in the first-load error state", () => {
    expect(screen.reduce(snap({ fetchError: "boom" }), { selectedIndex: 0 }, { type: "TAP" }).requestTick).toBe(true);
  });
});
