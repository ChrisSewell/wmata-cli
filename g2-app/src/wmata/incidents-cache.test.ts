// Unit tests for the rail-incidents shared cache.
//
// Two surfaces matter here:
//
//   1. `parseLinesAffected` — the pure wire-string parser. The WMATA
//      documentation example uses `split(/;[\s]?/)` but in practice the
//      wire returns mixed whitespace patterns, including bare `;`,
//      `;<space>`, double spaces, and leading whitespace. We exercise
//      each of those.
//
//   2. `refreshIncidents` — the I/O entry point. We mock the
//      `WmataClient` with a tiny `get<T>` stub so the test never makes a
//      real network call. The required acceptance behaviour:
//        - success populates `incidents` filtered to `userLines`,
//        - failure preserves the prior `incidents` (don't blank the HUD)
//          and reports the message on `fetchError`,
//        - clear resets to defaults.

import { afterEach, describe, expect, it } from "vitest";
import { WmataError, type IncidentsResponse, type RailIncident } from "./index";
import type { WmataClient } from "./index";
import {
  clearIncidentsCache,
  parseLinesAffected,
  readCachedIncidents,
  refreshIncidents,
} from "./incidents-cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stub `WmataClient` that returns the supplied response from
 * `get()`, or rejects with the supplied error. The cache only consumes
 * the `get<T>()` method, so we satisfy the type with `Pick<...>` cast
 * through `unknown` (no `any`, no `@ts-ignore`).
 */
function stubClient(opts: {
  response?: IncidentsResponse;
  reject?: unknown;
}): WmataClient {
  const get = <T>(): Promise<T> => {
    if (opts.reject !== undefined) return Promise.reject(opts.reject);
    return Promise.resolve(opts.response as unknown as T);
  };
  return { get } as unknown as WmataClient;
}

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

afterEach(() => {
  // Each test starts from a clean slate so per-test setups don't bleed.
  clearIncidentsCache();
});

// ---------------------------------------------------------------------------
// parseLinesAffected
// ---------------------------------------------------------------------------

describe("parseLinesAffected", () => {
  it("parses the canonical `BL; OR; SV;` wire shape", () => {
    expect(parseLinesAffected("BL; OR; SV;")).toEqual(["BL", "OR", "SV"]);
  });

  it("parses the no-space `BL;OR;SV` wire shape", () => {
    expect(parseLinesAffected("BL;OR;SV")).toEqual(["BL", "OR", "SV"]);
  });

  it("returns [] for an empty string", () => {
    expect(parseLinesAffected("")).toEqual([]);
  });

  it("drops unknown line codes silently", () => {
    expect(parseLinesAffected("BL;XX;SV;")).toEqual(["BL", "SV"]);
  });

  it("tolerates heavy whitespace padding (`  ;  BL  ;  `)", () => {
    expect(parseLinesAffected("  ;  BL  ;  ")).toEqual(["BL"]);
  });

  it("dedupes repeated codes while preserving first-seen order", () => {
    expect(parseLinesAffected("RD; BL; RD; BL;")).toEqual(["RD", "BL"]);
  });

  it("returns [] when every separator is empty (`;;;`)", () => {
    expect(parseLinesAffected(";;;")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refreshIncidents — success path
// ---------------------------------------------------------------------------

describe("refreshIncidents: success path", () => {
  it("populates the cache with incidents filtered to the user's lines", async () => {
    const incs: RailIncident[] = [
      incident({ IncidentID: "1", LinesAffected: "BL; OR;" }),
      incident({ IncidentID: "2", LinesAffected: "RD;" }),
      incident({ IncidentID: "3", LinesAffected: "SV;" }),
    ];
    const client = stubClient({ response: { Incidents: incs } });
    const next = await refreshIncidents(client, ["BL", "SV"]);

    expect(next.fetchError).toBeNull();
    expect(next.fetchedAt).toBeGreaterThan(0);
    // Only the BL/OR (matches BL) and the SV incident should land.
    expect(next.incidents.map((i) => i.IncidentID)).toEqual(["1", "3"]);
  });

  it("filters to an empty list when no incident matches user's lines", async () => {
    const incs: RailIncident[] = [
      incident({ IncidentID: "1", LinesAffected: "RD;" }),
      incident({ IncidentID: "2", LinesAffected: "GR;" }),
    ];
    const client = stubClient({ response: { Incidents: incs } });
    const next = await refreshIncidents(client, ["BL"]);
    expect(next.incidents).toEqual([]);
    expect(next.fetchError).toBeNull();
  });

  it("returns [] when userLines is empty (no lines to match)", async () => {
    const incs: RailIncident[] = [
      incident({ IncidentID: "1", LinesAffected: "BL;" }),
    ];
    const client = stubClient({ response: { Incidents: incs } });
    const next = await refreshIncidents(client, []);
    expect(next.incidents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refreshIncidents — error path
// ---------------------------------------------------------------------------

describe("refreshIncidents: error path", () => {
  it("populates fetchError on WmataError without clobbering prior incidents", async () => {
    // 1) Seed the cache via a successful refresh.
    const goodClient = stubClient({
      response: {
        Incidents: [incident({ IncidentID: "1", LinesAffected: "BL;" })],
      },
    });
    const first = await refreshIncidents(goodClient, ["BL"]);
    expect(first.incidents.map((i) => i.IncidentID)).toEqual(["1"]);
    const seededAt = first.fetchedAt;

    // 2) Now drive a failing refresh; the prior incidents must survive.
    const badClient = stubClient({
      reject: new WmataError("Could not connect to the WMATA API."),
    });
    const second = await refreshIncidents(badClient, ["BL"]);
    expect(second.fetchError).toBe("Could not connect to the WMATA API.");
    expect(second.incidents.map((i) => i.IncidentID)).toEqual(["1"]);
    // `fetchedAt` represents the LAST SUCCESSFUL fetch — must NOT move
    // on a failure.
    expect(second.fetchedAt).toBe(seededAt);
  });

  it("stores a sensible message even when the rejection is a plain Error", async () => {
    const client = stubClient({ reject: new Error("boom") });
    const next = await refreshIncidents(client, ["BL"]);
    expect(next.fetchError).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// clear / read helpers
// ---------------------------------------------------------------------------

describe("clearIncidentsCache + readCachedIncidents", () => {
  it("resets the cache to defaults", async () => {
    const client = stubClient({
      response: { Incidents: [incident({ LinesAffected: "BL;" })] },
    });
    await refreshIncidents(client, ["BL"]);
    expect(readCachedIncidents().incidents.length).toBe(1);

    clearIncidentsCache();
    const cleared = readCachedIncidents();
    expect(cleared.incidents).toEqual([]);
    expect(cleared.fetchedAt).toBe(0);
    expect(cleared.fetchError).toBeNull();
  });

  it("returns a snapshot copy (mutating the returned list is safe)", async () => {
    const client = stubClient({
      response: { Incidents: [incident({ LinesAffected: "BL;" })] },
    });
    await refreshIncidents(client, ["BL"]);
    const a = readCachedIncidents();
    a.incidents.length = 0;
    const b = readCachedIncidents();
    expect(b.incidents.length).toBe(1);
  });
});
