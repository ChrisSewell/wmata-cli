// WMATA REST API endpoint URLs — the rail-only subset the glasses use.

export const BASE = "https://api.wmata.com";

export const VALIDATE = `${BASE}/Misc/Validate`;

/** Rail incidents (delays / alerts). */
export const INCIDENTS_RAIL = `${BASE}/Incidents.svc/json/Incidents`;

/** Elevator / escalator outages. */
export const INCIDENTS_ELEVATOR = `${BASE}/Incidents.svc/json/ElevatorIncidents`;

/** Full rail station list (identity + lines + coordinates). */
export const RAIL_STATIONS = `${BASE}/Rail.svc/json/jStations`;

/**
 * Next-train predictions for one or more comma-joined station codes
 * (`.../GetPrediction/A01,B01`). The multi-station form returns a single
 * `Trains[]` spanning them all — so N favorites cost ONE request.
 */
export function buildRailPredictionsUrl(stationCodes: string): string {
  return `${BASE}/StationPrediction.svc/json/GetPrediction/${stationCodes}`;
}
