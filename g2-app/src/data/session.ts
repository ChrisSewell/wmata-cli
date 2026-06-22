// Per-glasses-session container for the WMATA client + its caches. Cache
// lifetime is tied to the Session (one per API key); when the key changes, the
// boot watcher drops the old Session and builds a new one. All cache classes
// are internal — `Session` is the public surface.
//
// Semantics preserved from the original: refresh never throws (a failed fetch
// keeps the prior data + stamps fetchError); fetchedAt advances only on
// success; reads return shallow copies so callers can't mutate cache state.

import {
  WmataClient,
  WmataError,
  INCIDENTS_ELEVATOR,
  INCIDENTS_RAIL,
  getStations as fetchStations,
  parseLinesAffected,
  type CachedIncidents,
  type CachedElevatorIncidents,
  type ElevatorIncidentsResponse,
  type IncidentsResponse,
  type LineCode,
  type RailIncident,
  type Station,
} from "./wmata";

export type { CachedIncidents, CachedElevatorIncidents };

// --- StationsCache (internal) ---------------------------------------------

/** Lazy full-station list, scoped to one WmataClient. */
class StationsCache {
  private stations: Station[] | null = null;

  constructor(private readonly client: WmataClient) {}

  async getStations(): Promise<Station[]> {
    if (this.stations === null) this.stations = await fetchStations(this.client);
    return this.stations;
  }

  async searchStations(query: string): Promise<Station[]> {
    const q = query.toLowerCase();
    const stations = await this.getStations();
    return stations.filter((s) => s.Name.toLowerCase().includes(q));
  }

  async resolveStationCode(code: string): Promise<Station | null> {
    const target = code.toUpperCase().trim();
    const stations = await this.getStations();
    return stations.find((s) => s.Code === target) ?? null;
  }
}

// --- IncidentsCache (internal) --------------------------------------------

/** True if an incident shares ≥1 affected line with `userLines`. */
function matchesUserLines(incident: RailIncident, userLines: ReadonlySet<LineCode>): boolean {
  if (userLines.size === 0) return false;
  for (const code of parseLinesAffected(incident.LinesAffected)) {
    if (userLines.has(code)) return true;
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof WmataError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err ?? "Unknown error");
}

class IncidentsCache {
  private cache: CachedIncidents = { incidents: [], fetchedAt: 0, fetchError: null };

  constructor(private readonly client: WmataClient) {}

  read(): CachedIncidents {
    return {
      incidents: this.cache.incidents.slice(),
      fetchedAt: this.cache.fetchedAt,
      fetchError: this.cache.fetchError,
    };
  }

  async refresh(userLines: readonly LineCode[]): Promise<CachedIncidents> {
    const userSet = new Set<LineCode>(userLines);
    try {
      const data = await this.client.get<IncidentsResponse>(INCIDENTS_RAIL);
      const filtered = (data.Incidents ?? []).filter((inc) => matchesUserLines(inc, userSet));
      this.cache = { incidents: filtered, fetchedAt: Date.now(), fetchError: null };
    } catch (err) {
      // Keep the prior list; fetchedAt is the last SUCCESSFUL fetch.
      this.cache = { ...this.cache, fetchError: errorMessage(err) };
    }
    return this.read();
  }
}

// --- ElevatorIncidentsCache (internal) ------------------------------------

class ElevatorIncidentsCache {
  private cache: CachedElevatorIncidents = { incidents: [], fetchedAt: 0, fetchError: null };

  constructor(private readonly client: WmataClient) {}

  read(): CachedElevatorIncidents {
    return {
      incidents: this.cache.incidents.slice(),
      fetchedAt: this.cache.fetchedAt,
      fetchError: this.cache.fetchError,
    };
  }

  async refresh(userStationCodes: readonly string[]): Promise<CachedElevatorIncidents> {
    const userSet = new Set<string>(userStationCodes);
    try {
      const data = await this.client.get<ElevatorIncidentsResponse>(INCIDENTS_ELEVATOR);
      const all = data.ElevatorIncidents ?? [];
      // No favorites => filter against nothing; a network-wide list would
      // overflow the HUD and isn't actionable.
      const filtered = userSet.size === 0 ? [] : all.filter((inc) => userSet.has(inc.StationCode));
      this.cache = { incidents: filtered, fetchedAt: Date.now(), fetchError: null };
    } catch (err) {
      this.cache = { ...this.cache, fetchError: errorMessage(err) };
    }
    return this.read();
  }
}

// --- Session --------------------------------------------------------------

/**
 * Per-glasses-session container. Owns one `WmataClient` and the stations /
 * incidents / elevator caches scoped to that key. Construct from an API key
 * (production) or a pre-built client (tests inject a stub).
 */
export class Session {
  readonly client: WmataClient;
  private readonly stationsCache: StationsCache;
  private readonly incidentsCache: IncidentsCache;
  private readonly elevatorIncidentsCache: ElevatorIncidentsCache;

  constructor(apiKeyOrClient: string | WmataClient) {
    this.client =
      typeof apiKeyOrClient === "string" ? new WmataClient(apiKeyOrClient) : apiKeyOrClient;
    this.stationsCache = new StationsCache(this.client);
    this.incidentsCache = new IncidentsCache(this.client);
    this.elevatorIncidentsCache = new ElevatorIncidentsCache(this.client);
  }

  // -- Stations --
  getStations(): Promise<Station[]> {
    return this.stationsCache.getStations();
  }
  searchStations(query: string): Promise<Station[]> {
    return this.stationsCache.searchStations(query);
  }
  resolveStationCode(code: string): Promise<Station | null> {
    return this.stationsCache.resolveStationCode(code);
  }

  // -- Rail incidents --
  readCachedIncidents(): CachedIncidents {
    return this.incidentsCache.read();
  }
  refreshIncidents(userLines: readonly LineCode[]): Promise<CachedIncidents> {
    return this.incidentsCache.refresh(userLines);
  }

  // -- Elevator / escalator outages --
  readCachedElevatorIncidents(): CachedElevatorIncidents {
    return this.elevatorIncidentsCache.read();
  }
  refreshElevatorIncidents(userStationCodes: readonly string[]): Promise<CachedElevatorIncidents> {
    return this.elevatorIncidentsCache.refresh(userStationCodes);
  }
}
