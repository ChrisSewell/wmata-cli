// Lazy-loaded rail station cache.
//
// Direct port of wmata/cli/station_cache.py. The Python version uses a
// module-level `_stations: list[dict] | None`; we do the equivalent with
// a module-scoped `let`. The cache is process-wide and survives across
// helper calls until `clearStationCache()` is invoked.

import { WmataClient } from "./client";
import { RAIL_STATIONS } from "./endpoints";
import type { Station, StationsResponse } from "./types";

let _stations: Station[] | null = null;

/** Fetch and cache the full station list (called once per session). */
export async function getStations(client: WmataClient): Promise<Station[]> {
  if (_stations === null) {
    const data = await client.get<StationsResponse>(RAIL_STATIONS);
    _stations = data.Stations ?? [];
  }
  return _stations;
}

/** Return stations whose `Name` contains the query (case-insensitive). */
export async function searchStations(client: WmataClient, query: string): Promise<Station[]> {
  const q = query.toLowerCase();
  const stations = await getStations(client);
  return stations.filter((s) => s.Name.toLowerCase().includes(q));
}

/** Find a station by exact code match (uppercase, trimmed). */
export async function resolveStationCode(
  client: WmataClient,
  code: string,
): Promise<Station | null> {
  const target = code.toUpperCase().trim();
  const stations = await getStations(client);
  return stations.find((s) => s.Code === target) ?? null;
}

/** Drop the cached station list. Mostly useful for tests / forced refresh. */
export function clearStationCache(): void {
  _stations = null;
}
