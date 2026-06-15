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

/**
 * One scheduled-departure entry inside a `DayStationTimes.FirstTrains`
 * or `DayStationTimes.LastTrains` array. Both arrays have the same
 * shape. `Time` is `"HH:mm"`; `DestinationStation` is a station code.
 *
 * Per WMATA docs: AM times that appear in `LastTrains` signify the
 * *next* calendar day — the trains run past midnight.
 */
export interface StationTrainTime {
  Time: string;
  DestinationStation: string;
}

/** Per-day-of-week schedule sub-object. */
export interface DayStationTimes {
  /** Station opening time, `"HH:mm"`. */
  OpeningTime: string;
  FirstTrains: StationTrainTime[];
  LastTrains: StationTrainTime[];
}

/**
 * Schedule for one station from `/Rail.svc/json/jStationTimes`.
 *
 * The seven weekday keys mirror the wire shape verbatim. Reading a
 * specific day requires `times[weekdayName]` — see
 * `weekdayKey(epochMs)` in the screen-side helper for the canonical
 * mapping.
 */
export interface StationTimes {
  Code: string;
  StationName: string;
  Monday: DayStationTimes;
  Tuesday: DayStationTimes;
  Wednesday: DayStationTimes;
  Thursday: DayStationTimes;
  Friday: DayStationTimes;
  Saturday: DayStationTimes;
  Sunday: DayStationTimes;
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

export interface StationTimesResponse {
  StationTimes: StationTimes[];
}

/**
 * One station along a same-line path from `/Rail.svc/json/jPath`.
 *
 * `DistanceToPrev` is the distance (in feet) to the previous station
 * in the sequence; the first entry returns 0. `SeqNum` is 1-based.
 */
export interface PathStep {
  DistanceToPrev: number;
  LineCode: string;
  SeqNum: number;
  StationCode: string;
  StationName: string;
}

export interface PathResponse {
  Path: PathStep[];
}

/**
 * One live train from `/TrainPositions/TrainPositions`. Non-revenue
 * trains (deadheading, special service) may have `LineCode === null`
 * and `DestinationStationCode === null`; both are typed as
 * `string | null` to match the wire shape.
 */
export interface TrainPosition {
  TrainId: string;
  TrainNumber: string;
  CarCount: number;
  DirectionNum: number;
  CircuitId: number;
  DestinationStationCode: string | null;
  LineCode: string | null;
  SecondsAtLocation: number;
  ServiceType: string;
}

export interface TrainPositionsResponse {
  TrainPositions: TrainPosition[];
}

/**
 * One track circuit on a StandardRoute. `StationCode` is non-null for
 * revenue stations and null for inter-station circuit segments; the
 * line schematic uses only the non-null entries.
 */
export interface TrackCircuit {
  SeqNum: number;
  CircuitId: number;
  StationCode: string | null;
}

/**
 * One ordered route per (line, track). Track 1 is generally
 * northbound/eastbound; Track 2 the reverse direction. The line
 * schematic uses Track 1 by convention — it doesn't matter which
 * track we read since station ordering is the same.
 */
export interface StandardRoute {
  LineCode: string;
  TrackNum: number;
  TrackCircuits: TrackCircuit[];
}

export interface StandardRoutesResponse {
  StandardRoutes: StandardRoute[];
}

export interface StationsResponse {
  Stations: Station[];
}
