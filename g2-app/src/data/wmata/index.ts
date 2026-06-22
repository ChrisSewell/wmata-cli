// Barrel for the WMATA data layer — one import path for callers.

export { WmataClient, WmataError } from "./client";
export {
  BASE,
  VALIDATE,
  INCIDENTS_RAIL,
  INCIDENTS_ELEVATOR,
  RAIL_STATIONS,
  buildRailPredictionsUrl,
} from "./endpoints";
export { getStations, searchStations, resolveStationCode } from "./stations";
export {
  parseLinesAffected,
  type CachedIncidents,
  type CachedElevatorIncidents,
} from "./incidents-cache";
export type {
  LineCode,
  Train,
  RailIncident,
  ElevatorIncident,
  StationAddress,
  Station,
  PredictionsResponse,
  IncidentsResponse,
  ElevatorIncidentsResponse,
  StationsResponse,
} from "./types";
