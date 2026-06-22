import { describe, it, expect } from "vitest";
import { computeUserLines, stationLines, computeAffectedLines, type FavoriteStation } from "./lines";
import type { RailIncident, Station } from "../wmata";

const fav = (code: string, lines: FavoriteStation["lines"]): FavoriteStation => ({
  code,
  name: code,
  lines,
});

const station = (over: Partial<Station>): Station => ({
  Code: "A01",
  Name: "Metro Center",
  LineCode1: "RD",
  LineCode2: null,
  LineCode3: null,
  LineCode4: null,
  Lat: 0,
  Lon: 0,
  StationTogether1: "",
  StationTogether2: "",
  Address: { City: "", State: "", Street: "", Zip: "" },
  ...over,
});

describe("computeUserLines", () => {
  it("dedupes across favorites", () => {
    const out = computeUserLines([fav("A", ["RD", "BL"]), fav("B", ["RD", "OR"])]);
    expect(new Set(out)).toEqual(new Set(["RD", "BL", "OR"]));
    expect(out.length).toBe(3);
  });
});

describe("stationLines", () => {
  it("collects only non-null line slots", () => {
    expect(stationLines(station({ LineCode1: "RD", LineCode2: "BL", LineCode3: null }))).toEqual([
      "RD",
      "BL",
    ]);
  });
});

describe("computeAffectedLines", () => {
  const inc = (lines: string): RailIncident => ({
    IncidentID: "x",
    Description: "d",
    IncidentType: "Delay",
    LinesAffected: lines,
    DateUpdated: "",
  });

  it("intersects affected with followed lines, in canonical order", () => {
    const out = computeAffectedLines([inc("OR; RD;"), inc("GR;")], ["RD", "OR"]);
    expect(out).toEqual(["RD", "OR"]); // canonical order, GR dropped (not followed)
  });
  it("is empty when the user follows nothing", () => {
    expect(computeAffectedLines([inc("RD;")], [])).toEqual([]);
  });
});
