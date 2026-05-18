// TypeScript shapes for the WMATA response payloads the glasses consume.
//
// These mirror the Python dict-shape comments in
// wmata/cli/rail_predictions.py and wmata/cli/incidents.py, cross-checked
// against docs/wmata-api/*. WMATA itself returns null for many "absent"
// string fields, so optional fields are typed `| null` to match the wire
// shape rather than `?` (which would imply the key is missing).

/** Two-letter line abbreviations for the six Metro lines. */
export type LineCode = "RD" | "BL" | "YL" | "OR" | "GR" | "SV";

/**
 * Next-train prediction row.
 *
 * `Min` is a string with several sentinel values:
 *   - numeric-as-string (e.g. `"3"`)
 *   - `"ARR"` arriving
 *   - `"BRD"` boarding
 *   - `"---"` no prediction available
 *   - `""` empty / no data
 *
 * `Line` may be blank or `"No"` for non-revenue trains, so we widen
 * beyond `LineCode` here. (Helpers that want to map to colors should
 * narrow with a type guard.)
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
 * A single rail incident entry.
 *
 * `LinesAffected` is a `;`-and-optionally-space-separated string, e.g.
 * `"BL; OR; SV;"`. Split with `/;[\s]?/` and drop empties to extract
 * codes (see docs/wmata-api/incidents.md).
 */
export interface RailIncident {
  IncidentID: string;
  Description: string;
  IncidentType: string;
  LinesAffected: string;
  DateUpdated: string;
}

/**
 * A single elevator or escalator outage entry from
 * `/Incidents.svc/json/ElevatorIncidents`.
 *
 * Notes from the WMATA docs (docs/wmata-api/incidents.md):
 *   - `UnitType` is one of `"ELEVATOR"` / `"ESCALATOR"`. Render as a
 *     1-char glyph (`E` / `S`) on the HUD.
 *   - `EstimatedReturnToService` may be `null` — WMATA often can't
 *     forecast a return time.
 *   - `StationName` sometimes includes the entrance ("Dupont Circle,
 *     Q Street Entrance"); the screen abbreviates to the station
 *     part only for the body row header.
 *   - Deprecated fields are typed `string | null` (rather than
 *     dropped) so a future re-instatement doesn't break the parser.
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
  /** Deprecated per WMATA docs; preserved so the parser is forward-compat. */
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
 * Rail station record from jStations / jStationInfo.
 *
 * WMATA returns `null` for unused LineCode2-4 slots, so they are typed
 * `LineCode | null`. `StationTogether1` is a sibling station code for
 * multi-platform stations (e.g., Gallery Place B01/F01); empty string
 * when none. `StationTogether2` is reserved and currently always empty.
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
