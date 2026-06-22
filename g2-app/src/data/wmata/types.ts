// TypeScript shapes for the WMATA response payloads the glasses consume.
// WMATA returns `null` for many "absent" string fields, so optional fields are
// typed `| null` to match the wire shape rather than `?`.
//
// Scope: the rebuild surfaces real-time predictions, rail incidents, elevator/
// escalator outages, and station identity. Last-train schedules, jPath,
// TrainPositions, and StandardRoutes are out of scope (deferred/cut features).

/** Two-letter line abbreviations for the six Metro lines. */
export type LineCode = "RD" | "BL" | "YL" | "OR" | "GR" | "SV";

/**
 * Next-train prediction row.
 *
 * `Min` is a string with several sentinel values:
 *   - numeric-as-string (e.g. `"3"`)
 *   - `"ARR"` arriving · `"BRD"` boarding · `"---"` no prediction · `""` no data
 *
 * `Line` may be blank or `"No"` for non-revenue trains, so it's widened beyond
 * `LineCode`. (Helpers that map to colors narrow with a type guard.)
 */
export interface Train {
  Car: string;
  Destination: string;
  DestinationCode: string | null;
  DestinationName: string;
  Group: string;
  Line: LineCode | "" | "No" | string;
  LocationCode: string;
  LocationName: string;
  Min: string;
}

/**
 * A single rail incident entry. `LinesAffected` is a `;`-and-optionally-space-
 * separated string, e.g. `"BL; OR; SV;"` — parse with `parseLinesAffected`.
 */
export interface RailIncident {
  IncidentID: string;
  Description: string;
  IncidentType: string;
  LinesAffected: string;
  DateUpdated: string;
}

/**
 * A single elevator or escalator outage from `/Incidents.svc/json/
 * ElevatorIncidents`. `UnitType` is `"ELEVATOR"` / `"ESCALATOR"`;
 * `EstimatedReturnToService` may be `null`. Deprecated fields are kept as
 * optional so a future re-instatement doesn't break the parser.
 */
export interface ElevatorIncident {
  DateOutOfServ: string;
  DateUpdated: string;
  EstimatedReturnToService: string | null;
  LocationDescription: string;
  StationCode: string;
  StationName: string;
  SymptomDescription: string;
  UnitName: string;
  /** `"ELEVATOR"` or `"ESCALATOR"` — narrow at the call site if needed. */
  UnitType: string;
  DisplayOrder?: number;
  SymptomCode?: string | null;
  TimeOutOfService?: string;
  UnitStatus?: string | null;
}

/** Postal address sub-object on a Station. */
export interface StationAddress {
  City: string;
  State: string;
  Street: string;
  Zip: string;
}

/**
 * Rail station record from jStations. Unused `LineCode2-4` slots are `null`.
 * `StationTogether1` is a sibling station code for multi-platform stations
 * (e.g. Gallery Place B01/F01); empty string when none.
 */
export interface Station {
  Code: string;
  Name: string;
  LineCode1: LineCode;
  LineCode2: LineCode | null;
  LineCode3: LineCode | null;
  LineCode4: LineCode | null;
  Lat: number;
  Lon: number;
  StationTogether1: string;
  StationTogether2: string;
  Address: StationAddress;
}

// Response wrappers --------------------------------------------------------

export interface PredictionsResponse {
  Trains: Train[];
}

export interface IncidentsResponse {
  Incidents: RailIncident[];
}

export interface ElevatorIncidentsResponse {
  ElevatorIncidents: ElevatorIncident[];
}

export interface StationsResponse {
  Stations: Station[];
}
