import { describe, it, expect } from "vitest";
import { makeHomeScreen, homeItems, type HomeSnapshot } from "./home";
import type { FavoriteStation } from "../data/domain/lines";
import { carKey, type TrackedCar } from "../data/domain/tracked";

const FAVS: FavoriteStation[] = [
  { code: "A01", name: "Metro Center", lines: ["RD", "BL"] },
  { code: "C04", name: "Foggy Bottom", lines: ["BL", "OR"] },
];
const snap = (over: Partial<HomeSnapshot> = {}): HomeSnapshot => ({
  favorites: FAVS,
  favoriteEtas: { A01: "4", C04: "ARR" },
  tracked: [],
  trackedEtas: {},
  alertCount: 3,
  ...over,
});

describe("homeItems", () => {
  it("packs each favorite's ETA into the row, then a Service alerts (N) entry", () => {
    const list = homeItems(snap());
    expect(list.length).toBe(3);
    expect(list[0]).toBe("Metro Center · RD BL · 4 min");
    expect(list[1]).toBe("Foggy Bottom · BL OR · ARR");
    expect(list[2]).toBe("Service alerts (3)");
  });
  it("omits the ETA suffix when none and the count when zero", () => {
    const list = homeItems(snap({ favoriteEtas: {}, alertCount: 0 }));
    expect(list[0]).toBe("Metro Center · RD BL");
    expect(list[2]).toBe("Service alerts");
  });
});

describe("home reduce", () => {
  const screen = makeHomeScreen(() => snap());

  it("clamps selection on scroll", () => {
    expect(screen.reduce(snap(), { selectedIndex: 0 }, { type: "SCROLL_UP" }).nav.selectedIndex).toBe(0);
    expect(screen.reduce(snap(), { selectedIndex: 0 }, { type: "SCROLL_DOWN" }).nav.selectedIndex).toBe(1);
    // 3 rows → max index 2
    expect(screen.reduce(snap(), { selectedIndex: 2 }, { type: "SCROLL_DOWN" }).nav.selectedIndex).toBe(2);
  });

  it("opens predictions for a tapped favorite (carrying its name)", () => {
    const r = screen.reduce(snap(), { selectedIndex: 0 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01", stationName: "Metro Center" });
  });

  it("opens alerts when the alerts row is tapped", () => {
    const r = screen.reduce(snap(), { selectedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "alerts" });
  });

  it("exits the app on double-tap (root)", () => {
    expect(screen.reduce(snap(), { selectedIndex: 0 }, { type: "DOUBLE_TAP" }).navigate).toEqual({ to: "exit" });
  });
});

describe("home with tracked slots", () => {
  const car: TrackedCar = {
    stationCode: "B11",
    stationName: "Glenmont",
    line: "RD",
    group: "1",
    destinationCode: "A15",
    destinationName: "Shady Grove",
  };
  const screen = makeHomeScreen(() => snap());
  it("inserts a • tracked row between favorites and the alerts row", () => {
    const items = homeItems(snap({ tracked: [car], trackedEtas: { [carKey(car)]: "4" } }));
    expect(items.length).toBe(4); // 2 favorites + 1 tracked + alerts
    expect(items[2]).toBe("• RD Shady Grove · 4 min");
  });
  it("shows — for a tracked slot with no matching train", () => {
    const items = homeItems(snap({ tracked: [car], trackedEtas: {} }));
    expect(items[2]).toBe("• RD Shady Grove · —");
  });
  it("routes a tracked-row press to that car's details", () => {
    const s = snap({ tracked: [car], trackedEtas: {} });
    const r = screen.reduce(s, { selectedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toMatchObject({ to: "carDetails" });
    expect((r.navigate as { car: TrackedCar }).car).toEqual(car);
  });
});

describe("home view", () => {
  const screen = makeHomeScreen(() => snap());
  const ctx = { nowMs: 1_000_000 };
  it("shows a native list body when configured", () => {
    expect(screen.view(snap(), { selectedIndex: 0 }, ctx).body.kind).toBe("list");
  });
  it("shows a single-item list when there are no favorites", () => {
    const empty = snap({ favorites: [], favoriteEtas: {}, alertCount: 0 });
    const v = screen.view(empty, { selectedIndex: 0 }, ctx);
    expect(v.body.kind).toBe("list");
    expect((v.body as { items: string[] }).items.length).toBe(1);
  });
});
