import { describe, it, expect } from "vitest";
import { makeAlertsScreen, makeInitialAlertsSnapshot, type AlertsSnapshot } from "./alerts";
import type { AlertItem } from "../data/domain/alerts";

const items = (n: number): AlertItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "rail" as const, headline: `Alert ${i}`, detail: `Detail ${i}`, title: `T${i}` }));

const ctx = { nowMs: 1_000_000 };
const screen = makeAlertsScreen(async () => ({ items: [], fetchedAt: 0, fetchError: null }), makeInitialAlertsSnapshot());
const snap = (over: Partial<AlertsSnapshot> = {}): AlertsSnapshot => ({ ...makeInitialAlertsSnapshot(), ...over });

describe("view states", () => {
  it("renders loading / empty / error as single-item lists", () => {
    const loading = screen.view(snap(), { selectedIndex: 0 }, ctx).body as { kind: string; items: string[] };
    expect(loading.kind).toBe("list");
    expect(loading.items[0]).toBe("Loading…");
    const empty = screen.view(snap({ fetchedAt: ctx.nowMs }), { selectedIndex: 0 }, ctx).body as { items: string[] };
    expect(empty.items[0]).toContain("running normally");
    const err = screen.view(snap({ fetchError: "boom" }), { selectedIndex: 0 }, ctx).body as { items: string[] };
    expect(err.items[0]).toContain("Couldn't reach");
  });
  it("renders a populated native list of headlines", () => {
    const pop = screen.view(snap({ fetchedAt: ctx.nowMs, items: items(3) }), { selectedIndex: 0 }, ctx);
    expect(pop.body.kind).toBe("list");
    expect((pop.body as { items: string[] }).items).toEqual(["Alert 0", "Alert 1", "Alert 2"]);
  });
});

describe("reduce", () => {
  const loaded = snap({ fetchedAt: ctx.nowMs, items: items(3) });
  it("opens detail for the firmware-selected row on press", () => {
    expect(screen.reduce(loaded, { selectedIndex: 2 }, { type: "TAP" }).navigate).toEqual({ to: "alertDetail", index: 2 });
  });
  it("double-press returns to home", () => {
    expect(screen.reduce(loaded, { selectedIndex: 0 }, { type: "DOUBLE_TAP" }).navigate).toEqual({ to: "home" });
  });
  it("scroll arms still clamp to bounds (defensive; firmware owns scroll)", () => {
    expect(screen.reduce(loaded, { selectedIndex: 0 }, { type: "SCROLL_UP" }).nav.selectedIndex).toBe(0);
    expect(screen.reduce(loaded, { selectedIndex: 2 }, { type: "SCROLL_DOWN" }).nav.selectedIndex).toBe(2);
  });
  it("press retries in the first-load error state", () => {
    expect(screen.reduce(snap({ fetchError: "boom" }), { selectedIndex: 0 }, { type: "TAP" }).requestTick).toBe(true);
  });
});
