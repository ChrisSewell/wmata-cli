// Unit tests for the `Session` per-glasses-session container.
//
// What's covered:
//
//   - Stations caching: getStations / searchStations / resolveStationCode
//     all warm a single shared cache that lives on the Session. Two
//     Session instances don't share cache state.
//
//   - Incidents caching: initial snapshot has the documented defaults;
//     refreshIncidents stores filtered incidents on success; on a
//     failure the prior incidents and fetchedAt are preserved and the
//     error message lands on `fetchError`; the snapshot is a shallow
//     copy (mutating the returned list is safe).
//
//   - Client exposure: `session.client` is the same object passed in
//     (test path) or a fresh `WmataClient` when the constructor is
//     given an apiKey string (production path).
//
//   - Isolation: two sessions have independent caches AND independent
//     clients.
//
// We stub the `WmataClient` via the same `Pick<WmataClient, 'get'>` cast
// through `unknown` pattern used in `wmata/incidents-cache.test.ts` and
// `wmata/stations.test.ts` (no `any`, no `@ts-ignore`).

import { describe, expect, it } from "vitest";
import { Session } from "./session";
import {
  WmataClient,
  WmataError,
  type IncidentsResponse,
  type RailIncident,
  type Station,
  type StationsResponse,
} from "./wmata";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixture: a Station with sensible defaults. */
function station(
  over: Partial<Station> & { Code: string; Name: string },
): Station {
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
const FIXTURE_STATIONS: Station[] = [METRO_CENTER, GALLERY_PLACE];

function incident(over: Partial<RailIncident> = {}): RailIncident {
  return {
    IncidentID: "id-1",
    Description: "Single-tracking on the Blue Line.",
    IncidentType: "Delay",
    LinesAffected: "BL;",
    DateUpdated: "2026-05-18T14:30:00",
    ...over,
  };
}

/**
 * Build a stub `WmataClient` whose `get` dispatches to one of two
 * fixtures based on the URL: any URL containing "Incidents" returns
 * the incidents response; everything else returns the stations
 * response. Bumps a per-endpoint counter so tests can assert
 * cache-hit / cache-miss behaviour.
 *
 * Same `Pick<WmataClient, 'get'>` cast through `unknown` pattern used
 * elsewhere (no `any`, no `@ts-ignore`).
 */
function stubClient(opts: {
  stations?: StationsResponse;
  incidents?: IncidentsResponse;
  rejectIncidents?: unknown;
  counters: { stations: number; incidents: number };
}): WmataClient {
  const get = <T>(url: string): Promise<T> => {
    if (url.includes("Incidents")) {
      opts.counters.incidents += 1;
      if (opts.rejectIncidents !== undefined) {
        return Promise.reject(opts.rejectIncidents);
      }
      const body = opts.incidents ?? { Incidents: [] };
      return Promise.resolve(body as unknown as T);
    }
    opts.counters.stations += 1;
    const body = opts.stations ?? { Stations: FIXTURE_STATIONS };
    return Promise.resolve(body as unknown as T);
  };
  return { get } as unknown as WmataClient;
}

// ---------------------------------------------------------------------------
// Stations cache
// ---------------------------------------------------------------------------

describe("Session: stations cache", () => {
  it("getStations: first call hits the network, second returns the cache", async () => {
    const counters = { stations: 0, incidents: 0 };
    const client = stubClient({ counters });
    const session = new Session(client);

    const a = await session.getStations();
    expect(counters.stations).toBe(1);
    const b = await session.getStations();
    expect(counters.stations).toBe(1);
    // Same reference — the cache returns the same array.
    expect(a).toBe(b);
  });

  it("searchStations warms the cache transparently", async () => {
    const counters = { stations: 0, incidents: 0 };
    const client = stubClient({ counters });
    const session = new Session(client);

    const hits = await session.searchStations("metro");
    expect(counters.stations).toBe(1);
    expect(hits.map((s) => s.Code)).toEqual(["A01"]);

    // Subsequent getStations should NOT refetch.
    await session.getStations();
    expect(counters.stations).toBe(1);
  });

  it("resolveStationCode warms the cache transparently", async () => {
    const counters = { stations: 0, incidents: 0 };
    const client = stubClient({ counters });
    const session = new Session(client);

    const hit = await session.resolveStationCode("a01");
    expect(counters.stations).toBe(1);
    expect(hit).not.toBeNull();
    expect(hit!.Name).toBe("Metro Center");

    // Subsequent searchStations should NOT refetch.
    await session.searchStations("");
    expect(counters.stations).toBe(1);
  });

  it("resolveStationCode returns null for an unknown code", async () => {
    const counters = { stations: 0, incidents: 0 };
    const client = stubClient({ counters });
    const session = new Session(client);

    const hit = await session.resolveStationCode("ZZZ");
    expect(hit).toBeNull();
  });

  it("two Session instances have independent stations caches", async () => {
    const countersA = { stations: 0, incidents: 0 };
    const countersB = { stations: 0, incidents: 0 };
    const sessionA = new Session(stubClient({ counters: countersA }));
    const sessionB = new Session(stubClient({ counters: countersB }));

    await sessionA.getStations();
    await sessionA.getStations();
    // sessionA: 1 fetch. sessionB: 0 fetches yet.
    expect(countersA.stations).toBe(1);
    expect(countersB.stations).toBe(0);

    await sessionB.getStations();
    expect(countersB.stations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Incidents cache
// ---------------------------------------------------------------------------

describe("Session: incidents cache", () => {
  it("readCachedIncidents: initial state has the documented defaults", () => {
    const counters = { stations: 0, incidents: 0 };
    const session = new Session(stubClient({ counters }));

    const snap = session.readCachedIncidents();
    expect(snap.incidents).toEqual([]);
    expect(snap.fetchedAt).toBe(0);
    expect(snap.fetchError).toBeNull();
  });

  it("refreshIncidents: success populates the cache filtered to userLines", async () => {
    const counters = { stations: 0, incidents: 0 };
    const incs: RailIncident[] = [
      incident({ IncidentID: "1", LinesAffected: "BL; OR;" }),
      incident({ IncidentID: "2", LinesAffected: "RD;" }),
      incident({ IncidentID: "3", LinesAffected: "SV;" }),
    ];
    const session = new Session(
      stubClient({ counters, incidents: { Incidents: incs } }),
    );

    const next = await session.refreshIncidents(["BL", "SV"]);
    expect(next.fetchError).toBeNull();
    expect(next.fetchedAt).toBeGreaterThan(0);
    // Only the BL/OR (matches BL) and the SV incident should land.
    expect(next.incidents.map((i) => i.IncidentID)).toEqual(["1", "3"]);

    // The post-refresh snapshot is mirrored on readCachedIncidents.
    const snap = session.readCachedIncidents();
    expect(snap.incidents.map((i) => i.IncidentID)).toEqual(["1", "3"]);
    expect(snap.fetchedAt).toBe(next.fetchedAt);
  });

  it("refreshIncidents: empty userLines yields []", async () => {
    const counters = { stations: 0, incidents: 0 };
    const incs: RailIncident[] = [
      incident({ IncidentID: "1", LinesAffected: "BL;" }),
    ];
    const session = new Session(
      stubClient({ counters, incidents: { Incidents: incs } }),
    );

    const next = await session.refreshIncidents([]);
    expect(next.incidents).toEqual([]);
  });

  it("refreshIncidents: fetch error preserves prior incidents + sets fetchError", async () => {
    // Single session whose stub flips after the first call: first call
    // seeds the cache, second call rejects. The session's prior
    // incidents must survive the failure (don't blank the HUD) and
    // `fetchedAt` must NOT advance on a failed attempt — it represents
    // the LAST SUCCESSFUL fetch, not the last attempt.
    let callCount = 0;
    const flakyClient: WmataClient = {
      get: <T>(): Promise<T> => {
        callCount += 1;
        if (callCount === 1) {
          const body: IncidentsResponse = {
            Incidents: [incident({ IncidentID: "1", LinesAffected: "BL;" })],
          };
          return Promise.resolve(body as unknown as T);
        }
        return Promise.reject(
          new WmataError("Could not connect to the WMATA API."),
        );
      },
    } as unknown as WmataClient;

    const session = new Session(flakyClient);
    const seed = await session.refreshIncidents(["BL"]);
    expect(seed.incidents.map((i) => i.IncidentID)).toEqual(["1"]);
    expect(seed.fetchError).toBeNull();
    const seedAt = seed.fetchedAt;
    expect(seedAt).toBeGreaterThan(0);

    const second = await session.refreshIncidents(["BL"]);
    expect(second.fetchError).toBe("Could not connect to the WMATA API.");
    expect(second.incidents.map((i) => i.IncidentID)).toEqual(["1"]);
    expect(second.fetchedAt).toBe(seedAt);
  });

  it("refreshIncidents: plain Error rejection yields the error's message on fetchError", async () => {
    const counters = { stations: 0, incidents: 0 };
    const session = new Session(
      stubClient({ counters, rejectIncidents: new Error("boom") }),
    );
    const next = await session.refreshIncidents(["BL"]);
    expect(next.fetchError).toBe("boom");
    expect(next.incidents).toEqual([]);
    expect(next.fetchedAt).toBe(0);
  });

  it("refreshIncidents: parses LinesAffected (integration with parseLinesAffected)", async () => {
    const counters = { stations: 0, incidents: 0 };
    // Whitespace-heavy + mixed-case + unknown-code wire shapes should
    // all parse to "BL" for filtering purposes.
    const incs: RailIncident[] = [
      incident({ IncidentID: "ws", LinesAffected: "  ; bl  ; " }),
      incident({ IncidentID: "unk", LinesAffected: "BL;XX;" }),
      incident({ IncidentID: "nope", LinesAffected: "RD;" }),
    ];
    const session = new Session(
      stubClient({ counters, incidents: { Incidents: incs } }),
    );

    const next = await session.refreshIncidents(["BL"]);
    expect(next.incidents.map((i) => i.IncidentID)).toEqual(["ws", "unk"]);
  });

  it("readCachedIncidents: returns a shallow copy (mutating is safe)", async () => {
    const counters = { stations: 0, incidents: 0 };
    const incs: RailIncident[] = [
      incident({ IncidentID: "1", LinesAffected: "BL;" }),
    ];
    const session = new Session(
      stubClient({ counters, incidents: { Incidents: incs } }),
    );
    await session.refreshIncidents(["BL"]);

    const a = session.readCachedIncidents();
    a.incidents.length = 0;
    const b = session.readCachedIncidents();
    expect(b.incidents.length).toBe(1);
  });

  it("two Session instances have independent incidents caches", async () => {
    const countersA = { stations: 0, incidents: 0 };
    const countersB = { stations: 0, incidents: 0 };
    const sessionA = new Session(
      stubClient({
        counters: countersA,
        incidents: {
          Incidents: [incident({ IncidentID: "A", LinesAffected: "BL;" })],
        },
      }),
    );
    const sessionB = new Session(
      stubClient({
        counters: countersB,
        incidents: {
          Incidents: [incident({ IncidentID: "B", LinesAffected: "BL;" })],
        },
      }),
    );

    await sessionA.refreshIncidents(["BL"]);
    expect(sessionA.readCachedIncidents().incidents.map((i) => i.IncidentID)).toEqual(["A"]);
    // sessionB is untouched.
    expect(sessionB.readCachedIncidents().incidents).toEqual([]);

    await sessionB.refreshIncidents(["BL"]);
    expect(sessionB.readCachedIncidents().incidents.map((i) => i.IncidentID)).toEqual(["B"]);
    // sessionA is still its own value.
    expect(sessionA.readCachedIncidents().incidents.map((i) => i.IncidentID)).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// Client exposure / isolation
// ---------------------------------------------------------------------------

describe("Session: client wiring", () => {
  it("when constructed from a client, `session.client` is the same instance", () => {
    const counters = { stations: 0, incidents: 0 };
    const client = stubClient({ counters });
    const session = new Session(client);
    expect(session.client).toBe(client);
  });

  it("when constructed from an apiKey, `session.client` is a real WmataClient", () => {
    const session = new Session("test-key");
    expect(session.client).toBeInstanceOf(WmataClient);
  });

  it("two sessions built from different keys have separate clients", () => {
    const a = new Session("key-a");
    const b = new Session("key-b");
    expect(a.client).not.toBe(b.client);
  });
});
