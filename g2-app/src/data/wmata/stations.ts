// Bare HTTP helpers for the WMATA rail-stations endpoint. No caching — the
// per-session cache (`data/session.ts`) layers on top. Kept for callers without
// a Session in scope: the companion settings flow (one-shot client to validate
// + search) and the StationsCache itself.

import { WmataClient } from "./client";
import { RAIL_STATIONS } from "./endpoints";
import type { Station, StationsResponse } from "./types";

/** Fetch the full station list. No caching. */
export async function getStations(client: WmataClient): Promise<Station[]> {
  const data = await client.get<StationsResponse>(RAIL_STATIONS);
  return data.Stations ?? [];
}

/** Stations whose `Name` contains the query (case-insensitive). */
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
