import { describe, it, expect } from "vitest";
import {
  makePredictionsScreen,
  makeInitialPredictionsSnapshot,
  sortTrains,
  trainRow,
  heroNumeral,
  type PredictionsSnapshot,
} from "./predictions";
import type { Train } from "../data/wmata";

const t = (Line: string, dest: string, Min: string): Train => ({
  Car: "6",
  Destination: dest,
  DestinationCode: null,
  DestinationName: dest,
  Group: "1",
  Line,
  LocationCode: "A01",
  LocationName: "Metro Center",
  Min,
});

const ctx = { nowMs: 1_000_000 };
const fetcher = async () => ({ trains: [], fetchedAt: 0, fetchError: null });
const screen = makePredictionsScreen(fetcher, makeInitialPredictionsSnapshot("A01", "Metro Center"));

const snap = (over: Partial<PredictionsSnapshot> = {}): PredictionsSnapshot => ({
  ...makeInitialPredictionsSnapshot("A01", "Metro Center"),
  ...over,
});

describe("sortTrains", () => {
  it("orders BRD < ARR < numeric < junk", () => {
    const out = sortTrains([t("RD", "x", "5"), t("RD", "y", "ARR"), t("RD", "z", "BRD"), t("RD", "j", "---")]);
    expect(out.map((x) => x.Min)).toEqual(["BRD", "ARR", "5", "---"]);
  });
});

describe("trainRow", () => {
  it("prefixes a known line code and formats the ETA", () => {
    expect(trainRow(t("RD", "Glenmont", "3"))).toEqual({ left: "RD Glenmont", value: "3 min" });
    expect(trainRow(t("RD", "Glenmont", "BRD")).value).toBe("BRD");
  });
  it("drops an unknown line code prefix", () => {
    expect(trainRow(t("No", "Yard", "5")).left).toBe("Yard");
  });
});

describe("view states", () => {
  it("loading before the first fetch", () => {
    const v = screen.view(snap(), { selectedIndex: 0 }, ctx);
    expect(v.body).toMatchObject({ kind: "message" });
    expect((v.body as { lines: string[] }).lines[0]).toBe("Loading…");
  });
  it("first-load error offers retry", () => {
    const v = screen.view(snap({ fetchError: "boom" }), { selectedIndex: 0 }, ctx);
    expect((v.body as { lines: string[] }).lines[0]).toContain("Couldn't reach");
  });
  it("empty after a successful fetch", () => {
    const v = screen.view(snap({ fetchedAt: ctx.nowMs }), { selectedIndex: 0 }, ctx);
    expect((v.body as { lines: string[] }).lines.join(" ")).toBe("No upcoming trains.");
  });
  it("renders a read-only sorted board, capped at 6", () => {
    const many = Array.from({ length: 9 }, (_, i) => t("RD", `Dest${i}`, String(i + 1)));
    const v = screen.view(snap({ fetchedAt: ctx.nowMs, trains: many }), { selectedIndex: 0 }, ctx);
    expect(v.body.kind).toBe("rows");
    const body = v.body as { rows: unknown[]; selectable?: boolean };
    expect(body.rows.length).toBe(6);
    expect(body.selectable).toBe(false);
  });
});

describe("heroNumeral", () => {
  it("is the word for ARR/BRD, digits for numeric, empty otherwise", () => {
    expect(heroNumeral("ARR")).toBe("ARR");
    expect(heroNumeral("BRD")).toBe("BRD");
    expect(heroNumeral("7")).toBe("7");
    expect(heroNumeral("---")).toBe("");
  });
});

describe("reduce", () => {
  it("press and double-press go back to home", () => {
    const loaded = snap({ fetchedAt: ctx.nowMs, trains: [t("RD", "x", "3")] });
    expect(screen.reduce(loaded, { selectedIndex: 0 }, { type: "TAP" }).navigate).toEqual({ to: "home" });
    expect(screen.reduce(loaded, { selectedIndex: 0 }, { type: "DOUBLE_TAP" }).navigate).toEqual({ to: "home" });
  });
  it("press requests a retry in the first-load error state", () => {
    const r = screen.reduce(snap({ fetchError: "boom" }), { selectedIndex: 0 }, { type: "TAP" });
    expect(r.requestTick).toBe(true);
    expect(r.navigate).toBeUndefined();
  });
});
