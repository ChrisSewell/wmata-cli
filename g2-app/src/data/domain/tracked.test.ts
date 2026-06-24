import { describe, it, expect } from "vitest";
import { carKey, trackedCarFromTrain, matchesTrackedCar, buildTrackedEtaMap } from "./tracked";
import type { Train } from "../wmata";

const train = (over: Partial<Train> = {}): Train => ({
  Car: "8",
  Destination: "Shady Grove",
  DestinationCode: "A15",
  DestinationName: "Shady Grove",
  Group: "1",
  Line: "RD",
  LocationCode: "B11",
  LocationName: "Glenmont",
  Min: "5",
  ...over,
});

describe("tracked domain", () => {
  it("carKey is a stable composite of station + line + group + destination", () => {
    expect(carKey({ stationCode: "B11", line: "RD", group: "1", destinationCode: "A15" })).toBe("B11|RD|1|A15");
    expect(carKey({ stationCode: "B11", line: "RD", group: "1", destinationCode: null })).toBe("B11|RD|1|?");
  });

  it("trackedCarFromTrain captures the slot identity + the station it was viewed at", () => {
    expect(trackedCarFromTrain(train(), "B11", "Glenmont")).toEqual({
      stationCode: "B11",
      stationName: "Glenmont",
      line: "RD",
      group: "1",
      destinationCode: "A15",
      destinationName: "Shady Grove",
    });
  });

  it("matchesTrackedCar matches the slot regardless of countdown, but not other slots", () => {
    const c = trackedCarFromTrain(train(), "B11", "Glenmont");
    expect(matchesTrackedCar(train({ Min: "2" }), c)).toBe(true); // same slot, later refresh
    expect(matchesTrackedCar(train({ Group: "2" }), c)).toBe(false); // other platform
    expect(matchesTrackedCar(train({ LocationCode: "A01" }), c)).toBe(false); // other station
    expect(matchesTrackedCar(train({ DestinationCode: "B08" }), c)).toBe(false); // other destination
  });

  it("buildTrackedEtaMap picks the soonest matching train's Min, null when none match", () => {
    const c = trackedCarFromTrain(train(), "B11", "Glenmont");
    const trains = [train({ Min: "9" }), train({ Min: "BRD" }), train({ Group: "2", Min: "1" })];
    expect(buildTrackedEtaMap(trains, [c])[carKey(c)]).toBe("BRD"); // soonest matching (group 1), not the group-2 "1"
    expect(buildTrackedEtaMap([train({ LocationCode: "A01" })], [c])[carKey(c)]).toBe(null); // no matching train
  });
});
