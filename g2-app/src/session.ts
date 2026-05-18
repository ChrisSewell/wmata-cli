// Per-glasses-session container for the WMATA client + its caches.
//
// Why a Session object?
//
//   v1.0 kept two caches as module-scoped `let` bindings:
//     - `stations.ts:_stations`        (lazy full-station list)
//     - `incidents-cache.ts:_cache`    (filtered rail incidents)
//   Those worked fine when the only way to change the API key was to
//   reload the page (the whole module graph re-initializes on reload).
//   But module-scoped state is invisible global state — it would survive
//   any future "refresh settings without a full reload" path while not
//   surviving a reload, creating a confusing hybrid lifecycle.
//
//   The fix: bind cache lifetime to a `Session`. One Session is built
//   inside `bootGlasses` from the persisted API key; all screens that
//   need cached data go through it. When/if a v1.1 "swap settings" path
//   ever appears, the implementation is just "drop the old Session,
//   construct a new one". No new lifecycle to design.
//
// Public surface (see `Session` below). Internal cache classes live in
// this file as well — they're implementation details of `Session`, not
// reused elsewhere.
//
// The bare HTTP wrappers (`getStations`, `searchStations`,
// `resolveStationCode` in `wmata/stations.ts`) survive as
// no-cache helpers so any caller that doesn't yet have a `Session` in
// scope (e.g. the companion `settings.ts` flow, which constructs a
// throwaway `WmataClient` per validate) keeps working unchanged.

import {
  WmataClient,
  WmataError,
  INCIDENTS_ELEVATOR,
  INCIDENTS_RAIL,
  buildPathUrl,
  buildStationTimesUrl,
  getStations as fetchStations,
  type ElevatorIncident,
  type ElevatorIncidentsResponse,
  type IncidentsResponse,
  type LineCode,
  type PathResponse,
  type PathStep,
  type RailIncident,
  type Station,
  type StationTimes,
  type StationTimesResponse,
} from "./wmata";
import { parseLinesAffected } from "./wmata/incidents-cache";

/**
 * Cached rail-incidents snapshot.
 *
 * Re-exported here so callers can pull a single import path (`./session`)
 * for the whole Session surface. The shape mirrors what `incidents-cache`
 * exported in v1.0 — same fields, same semantics.
 */
export interface CachedIncidents {
  /** Incidents already filtered to lines the user cares about. */
  incidents: RailIncident[];
  /** Epoch-ms of the last successful refresh; 0 if never. */
  fetchedAt: number;
  /** Last fetch error message, or `null` if the most recent refresh succeeded. */
  fetchError: string | null;
}

/**
 * Cached elevator/escalator-outage snapshot. Same shape as
 * `CachedIncidents` but filtered by station code rather than line —
 * the screen scopes outages to the user's favorite stations because
 * a network-wide list would overflow the HUD on busy days.
 */
export interface CachedElevatorIncidents {
  /** Outages already filtered to the user's favorite station codes. */
  incidents: ElevatorIncident[];
  /** Epoch-ms of the last successful refresh; 0 if never. */
  fetchedAt: number;
  /** Last fetch error message, or `null` if the most recent refresh succeeded. */
  fetchError: string | null;
}

// ---------------------------------------------------------------------------
// StationsCache (internal)
// ---------------------------------------------------------------------------

/**
 * Lazy full-station list, scoped to one WmataClient. Direct port of the
 * old module-scoped `_stations` from `wmata/stations.ts`, but the cache
 * lifetime is now tied to the owning `Session` rather than the JS module.
 */
class StationsCache {
  private stations: Station[] | null = null;

  constructor(private readonly client: WmataClient) {}

  /** Fetch + cache the full station list (called once per session). */
  async getStations(): Promise<Station[]> {
    if (this.stations === null) {
      this.stations = await fetchStations(this.client);
    }
    return this.stations;
  }

  /** Case-insensitive substring match on `Name`. Warms the cache. */
  async searchStations(query: string): Promise<Station[]> {
    const q = query.toLowerCase();
    const stations = await this.getStations();
    return stations.filter((s) => s.Name.toLowerCase().includes(q));
  }

  /** Find a station by exact code match (uppercase, trimmed). Warms the cache. */
  async resolveStationCode(code: string): Promise<Station | null> {
    const target = code.toUpperCase().trim();
    const stations = await this.getStations();
    return stations.find((s) => s.Code === target) ?? null;
  }
}

// ---------------------------------------------------------------------------
// IncidentsCache (internal)
// ---------------------------------------------------------------------------

/**
 * Rail-incidents cache, scoped to one WmataClient. Direct port of the
 * old module-scoped `_cache` from `wmata/incidents-cache.ts`. All
 * failure / race / staleness semantics from v1.0 are preserved verbatim:
 *
 *   - `refresh` never throws; a failed fetch keeps the prior `incidents`
 *     and stamps `fetchError`.
 *   - `fetchedAt` only advances on success.
 *   - `read` returns a shallow copy so callers can't mutate cache state.
 */
class IncidentsCache {
  private cache: CachedIncidents = {
    incidents: [],
    fetchedAt: 0,
    fetchError: null,
  };

  constructor(private readonly client: WmataClient) {}

  /** Return a shallow-copied snapshot. Safe to mutate. */
  read(): CachedIncidents {
    return {
      incidents: this.cache.incidents.slice(),
      fetchedAt: this.cache.fetchedAt,
      fetchError: this.cache.fetchError,
    };
  }

  /**
   * Refresh from the WMATA API. Filters to `userLines` before storing —
   * no point caching incidents on lines the user doesn't ride.
   *
   * Never throws. Returns the post-update snapshot.
   */
  async refresh(userLines: readonly LineCode[]): Promise<CachedIncidents> {
    const userSet = new Set<LineCode>(userLines);
    try {
      const data = await this.client.get<IncidentsResponse>(INCIDENTS_RAIL);
      const all = data.Incidents ?? [];
      const filtered = all.filter((inc) =>
        matchesUserLines(inc, userSet),
      );
      this.cache = {
        incidents: filtered,
        fetchedAt: Date.now(),
        fetchError: null,
      };
    } catch (err) {
      const message =
        err instanceof WmataError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err ?? "Unknown error");
      // Preserve the prior incidents list so the screen doesn't blank on
      // a transient failure. fetchedAt is left unchanged — it represents
      // the LAST SUCCESSFUL fetch, not the last attempt.
      this.cache = {
        incidents: this.cache.incidents,
        fetchedAt: this.cache.fetchedAt,
        fetchError: message,
      };
    }
    return this.read();
  }
}

/** True if an incident shares ≥1 affected line with `userLines`. */
function matchesUserLines(
  incident: RailIncident,
  userLines: ReadonlySet<LineCode>,
): boolean {
  if (userLines.size === 0) return false;
  const lines = parseLinesAffected(incident.LinesAffected);
  for (const code of lines) {
    if (userLines.has(code)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ElevatorIncidentsCache (internal)
// ---------------------------------------------------------------------------

/**
 * Elevator/escalator-outages cache, scoped to one WmataClient and
 * filtered by station code (rather than line, like the rail-incidents
 * cache). All failure / race / staleness semantics mirror
 * `IncidentsCache` above:
 *
 *   - `refresh` never throws; a failed fetch keeps the prior list
 *     and stamps `fetchError`.
 *   - `fetchedAt` only advances on success.
 *   - `read` returns a shallow copy so callers can't mutate cache
 *     state.
 *
 * Network-cost note: we issue a single GET (without a `StationCode`
 * query parameter) and filter client-side. That's cheaper than N
 * per-station calls (one per favorite at the 60s cadence), and the
 * unfiltered list is small in practice. If response sizes grow over
 * time (see RISK #3 in the WP-A plan) switch to per-station calls.
 */
class ElevatorIncidentsCache {
  private cache: CachedElevatorIncidents = {
    incidents: [],
    fetchedAt: 0,
    fetchError: null,
  };

  constructor(private readonly client: WmataClient) {}

  /** Return a shallow-copied snapshot. Safe to mutate. */
  read(): CachedElevatorIncidents {
    return {
      incidents: this.cache.incidents.slice(),
      fetchedAt: this.cache.fetchedAt,
      fetchError: this.cache.fetchError,
    };
  }

  /**
   * Refresh from the WMATA API. Filters to `userStationCodes` before
   * storing — no point caching outages at stations the user doesn't
   * visit. Never throws; returns the post-update snapshot.
   */
  async refresh(
    userStationCodes: readonly string[],
  ): Promise<CachedElevatorIncidents> {
    const userSet = new Set<string>(userStationCodes);
    try {
      const data = await this.client.get<ElevatorIncidentsResponse>(
        INCIDENTS_ELEVATOR,
      );
      const all = data.ElevatorIncidents ?? [];
      // Empty user-set means "no favorites configured yet" — nothing
      // to filter against, so we return an empty list rather than
      // surfacing every outage in the network (which would overflow
      // the HUD and isn't actionable for a user with no favorites).
      const filtered =
        userSet.size === 0
          ? []
          : all.filter((inc) => userSet.has(inc.StationCode));
      this.cache = {
        incidents: filtered,
        fetchedAt: Date.now(),
        fetchError: null,
      };
    } catch (err) {
      const message =
        err instanceof WmataError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err ?? "Unknown error");
      this.cache = {
        incidents: this.cache.incidents,
        fetchedAt: this.cache.fetchedAt,
        fetchError: message,
      };
    }
    return this.read();
  }
}

// ---------------------------------------------------------------------------
// StationTimesCache (internal)
// ---------------------------------------------------------------------------

/**
 * Lazy per-station schedule cache, scoped to one `WmataClient`.
 *
 * WMATA's station schedule (`jStationTimes`) changes only on pick
 * days (rare; usually every ~6 months). For the lifetime of one
 * glasses session it's effectively immutable — fetch once, never
 * again. This cache lazy-loads on the first `get(code)` call and
 * returns the same value for all subsequent calls.
 *
 * Failure path: a fetch error is NOT cached. Returns `null` and the
 * next call retries. That way a transient network blip on the first
 * load doesn't lock the user out of the last-train glance for the
 * remainder of the session.
 */
class StationTimesCache {
  private readonly byCode = new Map<string, StationTimes>();

  constructor(private readonly client: WmataClient) {}

  async get(code: string): Promise<StationTimes | null> {
    const trimmed = code.toUpperCase().trim();
    const cached = this.byCode.get(trimmed);
    if (cached) return cached;
    try {
      const data = await this.client.get<StationTimesResponse>(
        buildStationTimesUrl(trimmed),
      );
      const times = data.StationTimes?.[0] ?? null;
      if (times) {
        this.byCode.set(trimmed, times);
        return times;
      }
      return null;
    } catch {
      // Do NOT cache a failed lookup — the next call retries.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// PathCache (internal)
// ---------------------------------------------------------------------------

/**
 * Lazy origin→destination path cache. WMATA's `jPath` returns an
 * ordered station list for any same-line pair and an empty list for
 * cross-line pairs. Both outcomes are stable for the life of a
 * glasses session — the WMATA network topology doesn't change
 * mid-session — so we cache by `"FROM|TO"` and never refetch.
 *
 * Failure path: a network error is NOT cached. Returns `null` and
 * the next call retries (same convention as `StationTimesCache`).
 */
class PathCache {
  private readonly byPair = new Map<string, PathStep[]>();

  constructor(private readonly client: WmataClient) {}

  async get(from: string, to: string): Promise<PathStep[] | null> {
    const a = from.toUpperCase().trim();
    const b = to.toUpperCase().trim();
    if (a.length === 0 || b.length === 0) return null;
    const key = `${a}|${b}`;
    const cached = this.byPair.get(key);
    if (cached) return cached;
    try {
      const data = await this.client.get<PathResponse>(buildPathUrl(a, b));
      const path = data.Path ?? [];
      // Empty list means "cross-line pair" per WMATA docs. We still
      // cache it as the canonical answer — the topology doesn't
      // change — so a follow-up call doesn't re-hit the network.
      this.byPair.set(key, path);
      return path;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Per-glasses-session container. Owns a single `WmataClient` and the
 * stations + incidents caches scoped to that client's API key.
 *
 * Construct one in `bootGlasses` and thread it through to every screen
 * that needs cached WMATA data.
 */
export class Session {
  readonly client: WmataClient;
  private readonly stationsCache: StationsCache;
  private readonly incidentsCache: IncidentsCache;
  private readonly elevatorIncidentsCache: ElevatorIncidentsCache;
  private readonly stationTimesCache: StationTimesCache;
  private readonly pathCache: PathCache;

  /**
   * Build a Session from an API key (production path) or from a
   * pre-built `WmataClient` (test path — lets tests inject a stub
   * client without round-tripping through `new WmataClient(apiKey)`).
   *
   * Both call sites land in the same internal cache wiring, so there's
   * no production / test divergence in behaviour.
   */
  constructor(apiKeyOrClient: string | WmataClient) {
    this.client =
      typeof apiKeyOrClient === "string"
        ? new WmataClient(apiKeyOrClient)
        : apiKeyOrClient;
    this.stationsCache = new StationsCache(this.client);
    this.incidentsCache = new IncidentsCache(this.client);
    this.elevatorIncidentsCache = new ElevatorIncidentsCache(this.client);
    this.stationTimesCache = new StationTimesCache(this.client);
    this.pathCache = new PathCache(this.client);
  }

  // -- Stations -------------------------------------------------------------

  /** Fetch + cache the full station list. */
  getStations(): Promise<Station[]> {
    return this.stationsCache.getStations();
  }

  /** Case-insensitive substring match on `Name`. Warms the cache. */
  searchStations(query: string): Promise<Station[]> {
    return this.stationsCache.searchStations(query);
  }

  /** Find a station by exact code (case-insensitive, trimmed). Warms the cache. */
  resolveStationCode(code: string): Promise<Station | null> {
    return this.stationsCache.resolveStationCode(code);
  }

  // -- Incidents ------------------------------------------------------------

  /** Synchronously read the current incidents-cache snapshot. */
  readCachedIncidents(): CachedIncidents {
    return this.incidentsCache.read();
  }

  /** Refresh the incidents cache (filtered to `userLines`). Never throws. */
  refreshIncidents(
    userLines: readonly LineCode[],
  ): Promise<CachedIncidents> {
    return this.incidentsCache.refresh(userLines);
  }

  // -- Elevator / escalator outages -----------------------------------------

  /** Synchronously read the current elevator-outages snapshot. */
  readCachedElevatorIncidents(): CachedElevatorIncidents {
    return this.elevatorIncidentsCache.read();
  }

  /**
   * Refresh the elevator-outages cache (filtered to the user's
   * favorite station codes). Never throws.
   */
  refreshElevatorIncidents(
    userStationCodes: readonly string[],
  ): Promise<CachedElevatorIncidents> {
    return this.elevatorIncidentsCache.refresh(userStationCodes);
  }

  // -- Station schedule (jStationTimes) -------------------------------------

  /**
   * Lazy-load a single station's schedule. Returns `null` on fetch
   * failure or if the station isn't found. The result is cached for
   * the rest of the session — call again is free.
   */
  getStationTimes(code: string): Promise<StationTimes | null> {
    return this.stationTimesCache.get(code);
  }

  // -- Path (jPath) ---------------------------------------------------------

  /**
   * Lazy-load the same-line origin→destination path. Returns
   *   - `null`  if the lookup failed (network error)
   *   - `[]`    if the pair is cross-line (WMATA returns empty)
   *   - `PathStep[]` otherwise (ordered, 1-based `SeqNum`)
   *
   * Cached for the rest of the session.
   */
  getPath(from: string, to: string): Promise<PathStep[] | null> {
    return this.pathCache.get(from, to);
  }
}
