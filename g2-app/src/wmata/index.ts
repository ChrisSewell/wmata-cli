// Public surface for the WMATA data layer.
//
// Consumers should import from here rather than reaching into the
// individual modules:
//
//   import { WmataClient, type Train } from "./wmata";

export { WmataClient, WmataError } from "./client";

export {
  getStations,
  searchStations,
  resolveStationCode,
} from "./stations";

export {
  BASE,
  VALIDATE,
  INCIDENTS_RAIL,
  RAIL_STATIONS,
  RAIL_STATION_INFO,
  buildRailPredictionsUrl,
} from "./endpoints";

export type {
  LineCode,
  Train,
  RailIncident,
  Station,
  StationAddress,
  PredictionsResponse,
  IncidentsResponse,
  StationsResponse,
} from "./types";
