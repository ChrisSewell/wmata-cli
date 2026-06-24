// Tracked-train-slot domain — pure, no SDK/IO.
//
// IMPORTANT framing: a "tracked car" is NOT a physical railcar. The WMATA board
// (`GetPrediction`) carries no train id, so we cannot reliably follow one
// vehicle across refreshes. What we CAN track 100% reliably is a SLOT: "the next
// <Line> train to <Destination> departing <Station> on platform <Group>" — which
// is exactly what GetPrediction reports. So a tracked car is a saved query, and
// its ETA is always a real WMATA prediction, never an inference.

import type { Train } from "../wmata";
import { soonestEta } from "./eta";

export interface TrackedCar {
  /** Station the slot is watched at (where its countdown is reported). */
  stationCode: string;
  stationName: string;
  /** WMATA line code (RD/BL/…); kept as a string since the board can widen it. */
  line: string;
  /** Platform / track group ("1" | "2") — distinguishes the two directions. */
  group: string;
  destinationCode: string | null;
  destinationName: string;
}

/** Stable composite id for a tracked slot (station + line + group + destination). */
export function carKey(c: {
  stationCode: string;
  line: string;
  group: string;
  destinationCode: string | null;
}): string {
  return [c.stationCode, c.line, c.group, c.destinationCode ?? "?"].join("|");
}

/** Build a TrackedCar from a tapped board row + the station it was viewed at. */
export function trackedCarFromTrain(t: Train, stationCode: string, stationName: string): TrackedCar {
  return {
    stationCode,
    stationName,
    line: t.Line,
    group: t.Group,
    destinationCode: t.DestinationCode,
    destinationName: t.DestinationName || t.Destination || "",
  };
}

/** Does a board row at a station match a tracked slot? */
export function matchesTrackedCar(t: Train, c: TrackedCar): boolean {
  return (
    t.LocationCode === c.stationCode &&
    t.Line === c.line &&
    t.Group === c.group &&
    (t.DestinationCode ?? "?") === (c.destinationCode ?? "?")
  );
}

/**
 * For each tracked slot, the soonest matching train's `Min` token at its
 * station (or null = no matching train right now → a "left service / lost"
 * state the UI surfaces honestly rather than snapping to a different train).
 * `trains` is the (possibly multi-station) GetPrediction response.
 */
export function buildTrackedEtaMap(
  trains: readonly Train[],
  tracked: readonly TrackedCar[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const c of tracked) {
    const mins = trains.filter((t) => matchesTrackedCar(t, c)).map((t) => t.Min);
    out[carKey(c)] = soonestEta(mins);
  }
  return out;
}
