// Unit tests for the travel-history log.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ENTRIES,
  clearHistory,
  countByCode,
  loadHistory,
  recordOpen,
  suggestReorder,
  type HistoryEntry,
} from "./history";
import type { FavoriteStation } from "./settings";

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

interface MockStorage {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function makeMockStorage(): MockStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string): string | null =>
      store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

let mockStorage: MockStorage;

beforeEach(() => {
  mockStorage = makeMockStorage();
  vi.stubGlobal("localStorage", mockStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = 1_700_000_000_000;

function fav(over: { code: string; name?: string }): FavoriteStation {
  return {
    code: over.code,
    name: over.name ?? `Station ${over.code}`,
    lines: ["RD"],
  };
}

// ---------------------------------------------------------------------------
// recordOpen + loadHistory
// ---------------------------------------------------------------------------

describe("loadHistory", () => {
  it("returns an empty array on a fresh install", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("round-trips a single recorded open", () => {
    recordOpen("A01", NOW);
    const loaded = loadHistory();
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toEqual({ code: "A01", ts: NOW });
  });

  it("preserves chronological order", () => {
    recordOpen("A01", NOW);
    recordOpen("B01", NOW + 1000);
    recordOpen("A01", NOW + 2000);
    const loaded = loadHistory();
    expect(loaded.map((e) => e.code)).toEqual(["A01", "B01", "A01"]);
  });

  it("normalises station codes to uppercase + trim", () => {
    recordOpen("  a01  ", NOW);
    expect(loadHistory()[0]!.code).toBe("A01");
  });

  it("ignores empty-string codes silently", () => {
    recordOpen("", NOW);
    expect(loadHistory()).toEqual([]);
  });

  it("drops malformed entries from a corrupted store", () => {
    mockStorage.store.set(
      "wmata.g2.history",
      JSON.stringify({
        schemaVersion: 1,
        value: [
          { code: "A01", ts: NOW }, // ok
          { code: "", ts: NOW }, // bad code
          { code: "B01", ts: "later" }, // bad ts
          "not an object", // dropped
          { code: "C01" }, // missing ts
        ],
      }),
    );
    const loaded = loadHistory();
    expect(loaded.map((e) => e.code)).toEqual(["A01"]);
  });

  it("caps storage at MAX_ENTRIES (FIFO eviction)", () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      recordOpen(`X${i}`, NOW + i);
    }
    const loaded = loadHistory();
    expect(loaded.length).toBe(MAX_ENTRIES);
    // The OLDEST entries were dropped — first surviving is X10.
    expect(loaded[0]!.code).toBe("X10");
    expect(loaded[loaded.length - 1]!.code).toBe(`X${MAX_ENTRIES + 9}`);
  });
});

describe("clearHistory", () => {
  it("wipes the log", () => {
    recordOpen("A01", NOW);
    expect(loadHistory().length).toBe(1);
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countByCode
// ---------------------------------------------------------------------------

describe("countByCode", () => {
  const entries: HistoryEntry[] = [
    { code: "A01", ts: NOW + 1 },
    { code: "B01", ts: NOW + 2 },
    { code: "A01", ts: NOW + 3 },
    { code: "A01", ts: NOW + 4 },
    { code: "B01", ts: NOW + 5 },
  ];

  it("aggregates opens per code", () => {
    const m = countByCode(entries);
    expect(m.get("A01")).toBe(3);
    expect(m.get("B01")).toBe(2);
  });

  it("sorts the resulting Map descending by count", () => {
    const m = countByCode(entries);
    expect(Array.from(m.keys())).toEqual(["A01", "B01"]);
  });

  it("respects the sinceMs filter", () => {
    const m = countByCode(entries, NOW + 3);
    expect(m.get("A01")).toBe(2); // only the entries at NOW+3, NOW+4
    expect(m.get("B01")).toBe(1); // only NOW+5
  });

  it("returns an empty map for an empty input", () => {
    expect(countByCode([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// suggestReorder
// ---------------------------------------------------------------------------

describe("suggestReorder", () => {
  const favs: FavoriteStation[] = [
    fav({ code: "A01", name: "Metro Center" }),
    fav({ code: "B01", name: "Gallery Pl" }),
    fav({ code: "C01", name: "Federal Triangle" }),
  ];

  it("returns null when history is sparse", () => {
    const out = suggestReorder(favs, [{ code: "A01", ts: NOW }]);
    expect(out).toBeNull();
  });

  it("returns null when every favorite has zero history", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      code: "Z99", // not a favorite
      ts: NOW + i,
    }));
    expect(suggestReorder(favs, entries)).toBeNull();
  });

  it("returns null when current order already matches popularity", () => {
    // A01 has the most opens; B01 has fewer; C01 has the fewest. Order
    // [A01, B01, C01] matches the current `favs`, so no suggestion.
    const entries: HistoryEntry[] = [
      { code: "A01", ts: NOW },
      { code: "A01", ts: NOW + 1 },
      { code: "A01", ts: NOW + 2 },
      { code: "B01", ts: NOW + 3 },
      { code: "B01", ts: NOW + 4 },
      { code: "C01", ts: NOW + 5 },
    ];
    expect(suggestReorder(favs, entries)).toBeNull();
  });

  it("suggests reorder when the popularity ranking changes", () => {
    // C01 is the most-tapped now; should bubble to the top.
    const entries: HistoryEntry[] = [
      { code: "C01", ts: NOW },
      { code: "C01", ts: NOW + 1 },
      { code: "C01", ts: NOW + 2 },
      { code: "C01", ts: NOW + 3 },
      { code: "A01", ts: NOW + 4 },
      { code: "B01", ts: NOW + 5 },
    ];
    const out = suggestReorder(favs, entries);
    expect(out).not.toBeNull();
    expect(out!.map((f) => f.code)).toEqual(["C01", "A01", "B01"]);
  });

  it("returns null when there's only one favorite", () => {
    expect(suggestReorder([favs[0]!], [{ code: "A01", ts: NOW }])).toBeNull();
  });

  it("returns null when the history doesn't cover a favorite", () => {
    // A01, B01 tapped — but C01 is also a favorite with zero opens.
    // We don't want to demote C01 before the user has tapped it.
    const entries: HistoryEntry[] = [
      { code: "B01", ts: NOW },
      { code: "B01", ts: NOW + 1 },
      { code: "B01", ts: NOW + 2 },
      { code: "B01", ts: NOW + 3 },
      { code: "A01", ts: NOW + 4 },
      { code: "A01", ts: NOW + 5 },
    ];
    expect(suggestReorder(favs, entries)).toBeNull();
  });
});
