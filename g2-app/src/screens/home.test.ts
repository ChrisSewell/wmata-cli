import { describe, it, expect } from "vitest";
import { makeHomeScreen, homeRows, type HomeSnapshot } from "./home";
import type { FavoriteStation } from "../data/domain/lines";

const FAVS: FavoriteStation[] = [
  { code: "A01", name: "Metro Center", lines: ["RD", "BL"] },
  { code: "C04", name: "Foggy Bottom", lines: ["BL", "OR"] },
];
const snap = (over: Partial<HomeSnapshot> = {}): HomeSnapshot => ({
  favorites: FAVS,
  favoriteEtas: { A01: "4", C04: "ARR" },
  alertCount: 3,
  ...over,
});

describe("homeRows", () => {
  it("builds favorite rows (ETA value) then a Service alerts row (count value)", () => {
    const rows = homeRows(snap());
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ left: "Metro Center · RD BL", value: "4 min" });
    expect(rows[1]!.value).toBe("ARR");
    expect(rows[2]).toEqual({ left: "Service alerts", value: "3" });
  });
  it("blanks the alerts value when there are none", () => {
    expect(homeRows(snap({ alertCount: 0 }))[2]!.value).toBe("");
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

  it("opens predictions for a tapped favorite", () => {
    const r = screen.reduce(snap(), { selectedIndex: 0 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01" });
  });

  it("opens alerts when the alerts row is tapped", () => {
    const r = screen.reduce(snap(), { selectedIndex: 2 }, { type: "TAP" });
    expect(r.navigate).toEqual({ to: "alerts" });
  });

  it("exits the app on double-tap (root)", () => {
    expect(screen.reduce(snap(), { selectedIndex: 0 }, { type: "DOUBLE_TAP" }).navigate).toEqual({ to: "exit" });
  });
});

describe("home view", () => {
  const screen = makeHomeScreen(() => snap());
  const ctx = { nowMs: 1_000_000 };
  it("shows a rows body when configured", () => {
    expect(screen.view(snap(), { selectedIndex: 0 }, ctx).body.kind).toBe("rows");
  });
  it("shows a message when there are no favorites", () => {
    const empty = snap({ favorites: [], favoriteEtas: {}, alertCount: 0 });
    const v = screen.view(empty, { selectedIndex: 0 }, ctx);
    expect(v.body.kind).toBe("message");
  });
});
