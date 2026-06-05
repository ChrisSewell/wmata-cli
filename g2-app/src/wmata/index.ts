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
  INCIDENTS_ELEVATOR,
  RAIL_STATIONS,
  RAIL_STATION_INFO,
  STANDARD_ROUTES_URL,
  TRAIN_POSITIONS_URL,
  buildRailPredictionsUrl,
  buildStationTimesUrl,
  buildPathUrl,
} from "./endpoints";

export type {
  LineCode,
  Train,
  RailIncident,
  ElevatorIncident,
  Station,
  StationAddress,
  StationTrainTime,
  DayStationTimes,
  StationTimes,
  PathStep,
  TrainPosition,
  TrackCircuit,
  StandardRoute,
  PredictionsResponse,
  IncidentsResponse,
  ElevatorIncidentsResponse,
  StationsResponse,
  StationTimesResponse,
  PathResponse,
  TrainPositionsResponse,
  StandardRoutesResponse,
} from "./types";
