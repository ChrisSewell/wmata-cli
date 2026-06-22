import { describe, it, expect } from "vitest";
import { buildAlertItems, stationNameOnly } from "./alerts";
import type { RailIncident, ElevatorIncident } from "../wmata";

const inc = (lines: string, desc: string): RailIncident => ({
  IncidentID: "x",
  IncidentType: "Delay",
  LinesAffected: lines,
  DateUpdated: "",
  Description: desc,
});
const outage = (station: string, loc: string): ElevatorIncident => ({
  DateOutOfServ: "",
  DateUpdated: "",
  EstimatedReturnToService: null,
  LocationDescription: loc,
  StationCode: "A01",
  StationName: station,
  SymptomDescription: "",
  UnitName: "X1",
  UnitType: "ELEVATOR",
});

describe("stationNameOnly", () => {
  it("strips an entrance suffix", () => {
    expect(stationNameOnly("Dupont Circle, Q St Entrance")).toBe("Dupont Circle");
    expect(stationNameOnly("Metro Center")).toBe("Metro Center");
  });
});

describe("buildAlertItems", () => {
  it("lists rail incidents first, then access outages", () => {
    const items = buildAlertItems(
      [inc("RD;", "Red Line: single-tracking near Takoma. Residual delays.")],
      [outage("Metro Center", "Street elevator")],
    );
    expect(items.map((i) => i.kind)).toEqual(["rail", "access"]);
    expect(items[0]!.headline).toContain("RD ·");
    expect(items[0]!.headline).toContain("Red Line: single-tracking near Takoma");
    expect(items[0]!.headline).not.toContain("Residual"); // headline is first sentence only
    expect(items[0]!.detail).toContain("Residual delays"); // detail is the full text
    expect(items[1]!.headline).toBe("Elevator out · Metro Center");
  });
});
