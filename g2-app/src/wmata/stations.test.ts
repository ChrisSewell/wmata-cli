// Unit tests for the lazy station cache.
//
// Acceptance surface (mirrors stations.ts):
//   - `getStations` populates the module-level cache on first call.
//   - Subsequent calls return the cached array without re-hitting the
//     network.
//   - `clearStationCache` forces a refetch.
//   - `searchStations` is a case-insensitive substring match on `Name`.
//   - `resolveStationCode` is case-insensitive + whitespace-trimming.
//   - Both helpers transparently warm the same shared cache.
//
// We stub the `WmataClient` via the same `Pick<WmataClient, 'get'>` cast
// used in `incidents-cache.test.ts` so we never make a real network call.

import { afterEach, describe, expect, it } from "vitest";
import { WmataClient } from "./client";
import type { Station, StationsResponse } from "./types";
import {
  clearStationCache,
  getStations,
  resolveStationCode,
  searchStations,
} from "./stations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixture: a Station with sensible defaults. */
function station(over: Partial<Station> & { Code: string; Name: string }): Station {
  return {
    Code: over.Code,
    Name: over.Name,
    LineCode1: over.LineCode1 ?? "RD",
    LineCode2: over.LineCode2 ?? null,
    LineCode3: over.LineCode3 ?? null,
    LineCode4: over.LineCode4 ?? null,
    Lat: over.Lat ?? 0,
    Lon: over.Lon ?? 0,
    StationTogether1: over.StationTogether1 ?? "",
    StationTogether2: over.StationTogether2 ?? "",
    Address: over.Address ?? { City: "", State: "", Street: "", Zip: "" },
  };
}

const METRO_CENTER = station({
  Code: "A01",
  Name: "Metro Center",
  LineCode1: "RD",
  LineCode2: "BL",
});
const GALLERY_PLACE = station({
  Code: "B01",
  Name: "Gallery Pl-Chinatown",
  LineCode1: "RD",
});
const FOGGY_BOTTOM = station({
  Code: "C04",
  Name: "Foggy Bottom-GWU",
  LineCode1: "BL",
  LineCode2: "OR",
  LineCode3: "SV",
});
const MCPHERSON = station({
  Code: "C02",
  Name: "McPherson Sq",
  LineCode1: "BL",
});
const FIXTURE_STATIONS: Station[] = [
  METRO_CENTER,
  GALLERY_PLACE,
  FOGGY_BOTTOM,
  MCPHERSON,
];

/**
 * Build a stub `WmataClient` whose `get` returns `response` and bumps
 * the supplied call counter. Same `Pick<...>` cast through `unknown`
 * pattern incidents-cache.test.ts uses (no `any`, no `@ts-ignore`).
 */
function stubClient(opts: {
  response?: StationsResponse;
  counter: { calls: number };
}): WmataClient {
  const get = <T>(): Promise<T> => {
    opts.counter.calls += 1;
    const body = opts.response ?? { Stations: FIXTURE_STATIONS };
    return Promise.resolve(body as unknown as T);
  };
  return { get } as unknown as WmataClient;
}

afterEach(() => {
  // Always reset the module-level cache so per-test setups don't bleed.
  clearStationCache();
});

// ---------------------------------------------------------------------------
// getStations
// ---------------------------------------------------------------------------

describe("getStations", () => {
  it("first call hits the network and returns the response Stations array", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const result = await getStations(client);
    expect(counter.calls).toBe(1);
    expect(result.map((s) => s.Code)).toEqual([
      "A01",
      "B01",
      "C04",
      "C02",
    ]);
  });

  it("second call returns the cached array (network call count stays at 1)", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const a = await getStations(client);
    const b = await getStations(client);
    expect(counter.calls).toBe(1);
    // Same reference — the cache returns the same array.
    expect(a).toBe(b);
  });

  it("clearStationCache forces a refetch on the next call", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    await getStations(client);
    expect(counter.calls).toBe(1);
    clearStationCache();
    await getStations(client);
    expect(counter.calls).toBe(2);
  });

  it("returns [] (defensive) when the response has no `Stations` field", async () => {
    const counter = { calls: 0 };
    // Cast through unknown — production tolerates an undefined Stations
    // field via `?? []`, so we send the wire-shape we want to test.
    const client = stubClient({
      counter,
      response: {} as unknown as StationsResponse,
    });
    const result = await getStations(client);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchStations
// ---------------------------------------------------------------------------

describe("searchStations", () => {
  it("case-insensitive: 'metro', 'METRO', 'MeTrO' all return the same set", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const a = await searchStations(client, "metro");
    const b = await searchStations(client, "METRO");
    const c = await searchStations(client, "MeTrO");
    const codes = (xs: Station[]): string[] => xs.map((s) => s.Code);
    expect(codes(a)).toEqual(["A01"]);
    expect(codes(b)).toEqual(["A01"]);
    expect(codes(c)).toEqual(["A01"]);
  });

  it("returns [] when no station matches the query", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const result = await searchStations(client, "nowhere-real");
    expect(result).toEqual([]);
  });

  it("an empty string query matches every station (substring '' is universal)", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const result = await searchStations(client, "");
    expect(result.map((s) => s.Code)).toEqual([
      "A01",
      "B01",
      "C04",
      "C02",
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveStationCode
// ---------------------------------------------------------------------------

describe("resolveStationCode", () => {
  it("returns the station on an exact code match", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const result = await resolveStationCode(client, "A01");
    expect(result).not.toBeNull();
    expect(result!.Name).toBe("Metro Center");
  });

  it("is case-insensitive and whitespace-trimming on input", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const a = await resolveStationCode(client, "a01");
    const b = await resolveStationCode(client, "A01");
    const c = await resolveStationCode(client, " A01 ");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(a!.Code).toBe("A01");
    expect(b!.Code).toBe("A01");
    expect(c!.Code).toBe("A01");
  });

  it("returns null when no station has the supplied code", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    const result = await resolveStationCode(client, "ZZZ");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache sharing across helpers
// ---------------------------------------------------------------------------

describe("cache sharing across helpers", () => {
  it("searchStations warms the cache so a subsequent getStations doesn't refetch", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    await searchStations(client, "metro");
    expect(counter.calls).toBe(1);
    await getStations(client);
    expect(counter.calls).toBe(1);
  });

  it("resolveStationCode warms the cache so a subsequent getStations doesn't refetch", async () => {
    const counter = { calls: 0 };
    const client = stubClient({ counter });
    await resolveStationCode(client, "A01");
    expect(counter.calls).toBe(1);
    await getStations(client);
    expect(counter.calls).toBe(1);
  });
});
