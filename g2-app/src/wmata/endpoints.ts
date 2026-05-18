// WMATA REST API endpoint URLs.
//
// Mirror of wmata/api/endpoints.py, trimmed to the rail-only subset we
// actually use on the glasses. Bus, parking, fares, station-times,
// station-to-station, and path endpoints are intentionally omitted.

export const BASE = "https://api.wmata.com";

export const VALIDATE = `${BASE}/Misc/Validate`;

// Rail Incidents
export const INCIDENTS_RAIL = `${BASE}/Incidents.svc/json/Incidents`;

// Elevator / Escalator Incidents
export const INCIDENTS_ELEVATOR = `${BASE}/Incidents.svc/json/ElevatorIncidents`;

// Rail Station Information
export const RAIL_STATIONS = `${BASE}/Rail.svc/json/jStations`;
export const RAIL_STATION_INFO = `${BASE}/Rail.svc/json/jStationInfo`;

// Rail Predictions — Python had `RAIL_PREDICTIONS = "...{station_codes}"`
// and called `.format(station_codes=...)`. In TS we expose a helper.
export function buildRailPredictionsUrl(stationCodes: string): string {
  return `${BASE}/StationPrediction.svc/json/GetPrediction/${stationCodes}`;
}

/**
 * Build the `jStationTimes` URL for a specific station. The
 * `StationCode` query parameter is technically optional per the
 * WMATA docs (omitting it returns every station), but the only
 * caller of this URL is the per-station last-train cache, so we
 * always pass the code.
 */
export function buildStationTimesUrl(stationCode: string): string {
  const params = new URLSearchParams({ StationCode: stationCode });
  return `${BASE}/Rail.svc/json/jStationTimes?${params.toString()}`;
}
