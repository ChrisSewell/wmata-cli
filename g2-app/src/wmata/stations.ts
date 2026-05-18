// Bare HTTP helpers for the WMATA rail-stations endpoint.
//
// History: v1.0 cached the station list at module scope (`_stations`).
// That has been lifted into a per-session cache on the `Session` class
// (see `src/session.ts`), so the lifetime of cached data is the lifetime
// of the API key. These functions now ALWAYS hit the network — they are
// just typed wrappers around `WmataClient.get`.
//
// Why keep them? Two callers don't have a `Session` in scope:
//
//   1. `screens/settings.ts` constructs a one-shot `WmataClient` to
//      validate the API key + search stations while the user is still
//      configuring the app. There's no Session yet.
//   2. `Session` itself (`StationsCache.getStations`) calls
//      `getStations(client)` as the bare-HTTP layer underneath its
//      cache.
//
// Both of those want "just hit the network", which is exactly what these
// wrappers do now.

import { WmataClient } from "./client";
import { RAIL_STATIONS } from "./endpoints";
import type { Station, StationsResponse } from "./types";

/** Fetch the full station list. No caching. */
export async function getStations(client: WmataClient): Promise<Station[]> {
  const data = await client.get<StationsResponse>(RAIL_STATIONS);
  return data.Stations ?? [];
}

/** Return stations whose `Name` contains the query (case-insensitive). */
export async function searchStations(
  client: WmataClient,
  query: string,
): Promise<Station[]> {
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
