// Unit tests for the localStorage-backed settings + favorites store.
//
// Acceptance surface (mirrors settings.ts):
//   - `loadSettings` returns documented defaults when storage is empty.
//   - `saveApiKey` trims whitespace and round-trips; `""` clears.
//   - `addFavorite` appends, no-ops on dup code, refuses past MAX.
//   - `removeFavorite` removes; no-op when the code isn't present.
//   - `reorderFavorites` persists; throws on length > MAX; deep-copies.
//   - `clearSettings` wipes both keys.
//   - Corrupt JSON, schema mismatch, malformed entries all degrade
//     gracefully to defaults / drop-silent.
//   - `localStorage` failure on get/set never escapes.
//   - Unknown LineCode values are dropped from persisted entries.
//
// Per-test isolation: we stub a fresh in-memory `localStorage` (Map-backed)
// at the start of every test via `vi.stubGlobal`. No singletons.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineCode } from "../wmata";
import {
  MAX_FAVORITES,
  addFavorite,
  clearSettings,
  loadSettings,
  removeFavorite,
  reorderFavorites,
  saveApiKey,
  type FavoriteStation,
} from "./settings";

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

/**
 * Minimal `Storage`-shape mock backed by a Map. Production code only
 * touches `getItem` / `setItem` / `removeItem`, so we don't bother
 * implementing the indexed accessors / length.
 */
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
  // Silence the warn calls the production code emits on error paths
  // (they're expected and would otherwise clutter the test output).
  vi.spyOn(console, "warn").mockImplementation(() => {
    /* swallowed */
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fav(over: Partial<FavoriteStation> & { code: string }): FavoriteStation {
  return {
    code: over.code,
    name: over.name ?? `Station ${over.code}`,
    lines: over.lines ?? ["RD"],
  };
}

// ---------------------------------------------------------------------------
// loadSettings: defaults
// ---------------------------------------------------------------------------

describe("loadSettings: empty storage", () => {
  it("returns the defaults { apiKey: '', favorites: [] }", () => {
    const s = loadSettings();
    expect(s.apiKey).toBe("");
    expect(s.favorites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// saveApiKey + roundtrip
// ---------------------------------------------------------------------------

describe("saveApiKey + loadSettings roundtrip", () => {
  it("a saved key is visible on the next load", () => {
    saveApiKey("abc-123");
    expect(loadSettings().apiKey).toBe("abc-123");
  });

  it("saveApiKey('  abc  ') trims whitespace before persisting", () => {
    saveApiKey("  abc  ");
    expect(loadSettings().apiKey).toBe("abc");
  });

  it("saveApiKey('') clears a previously saved key", () => {
    saveApiKey("first-key");
    expect(loadSettings().apiKey).toBe("first-key");
    saveApiKey("");
    expect(loadSettings().apiKey).toBe("");
  });
});

// ---------------------------------------------------------------------------
// addFavorite
// ---------------------------------------------------------------------------

describe("addFavorite", () => {
  it("appends a favorite; subsequent load shows it", () => {
    addFavorite(fav({ code: "A01", name: "Metro Center", lines: ["RD"] }));
    const s = loadSettings();
    expect(s.favorites.length).toBe(1);
    expect(s.favorites[0]!.code).toBe("A01");
    expect(s.favorites[0]!.name).toBe("Metro Center");
  });

  it("a duplicate code is a no-op: length unchanged, existing entry preserved", () => {
    addFavorite(fav({ code: "A01", name: "Metro Center", lines: ["RD"] }));
    const before = loadSettings().favorites;
    const next = addFavorite(
      fav({ code: "A01", name: "Different Name", lines: ["BL"] }),
    );
    expect(next.length).toBe(1);
    // The first-write entry survived — duplicate is a no-op, not an upsert.
    expect(next[0]!.name).toBe("Metro Center");
    expect(before).toEqual(next);
  });

  it("silently refuses to add past MAX_FAVORITES; length stays at MAX_FAVORITES", () => {
    for (let i = 0; i < MAX_FAVORITES; i += 1) {
      addFavorite(fav({ code: `X${i}` }));
    }
    expect(loadSettings().favorites.length).toBe(MAX_FAVORITES);
    const next = addFavorite(fav({ code: "OVERFLOW" }));
    expect(next.length).toBe(MAX_FAVORITES);
    expect(loadSettings().favorites.length).toBe(MAX_FAVORITES);
    expect(next.some((f) => f.code === "OVERFLOW")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeFavorite
// ---------------------------------------------------------------------------

describe("removeFavorite", () => {
  it("removes the entry with the matching code", () => {
    addFavorite(fav({ code: "A01" }));
    addFavorite(fav({ code: "B01" }));
    const next = removeFavorite("A01");
    expect(next.map((f) => f.code)).toEqual(["B01"]);
    expect(loadSettings().favorites.map((f) => f.code)).toEqual(["B01"]);
  });

  it("returns the same list when the code isn't present (no-op)", () => {
    addFavorite(fav({ code: "A01" }));
    const before = loadSettings().favorites;
    const next = removeFavorite("DOES-NOT-EXIST");
    expect(next).toEqual(before);
    expect(loadSettings().favorites).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// reorderFavorites
// ---------------------------------------------------------------------------

describe("reorderFavorites", () => {
  it("persists the new ordering", () => {
    const ordered = [
      fav({ code: "C04", name: "Foggy Bottom-GWU", lines: ["BL"] }),
      fav({ code: "A01", name: "Metro Center", lines: ["RD"] }),
      fav({ code: "B01", name: "Gallery Pl-Chinatown", lines: ["RD"] }),
    ];
    reorderFavorites(ordered);
    const loaded = loadSettings().favorites;
    expect(loaded.map((f) => f.code)).toEqual(["C04", "A01", "B01"]);
  });

  it("throws when the input length exceeds MAX_FAVORITES", () => {
    const tooMany: FavoriteStation[] = Array.from(
      { length: MAX_FAVORITES + 1 },
      (_, i) => fav({ code: `X${i}` }),
    );
    expect(() => reorderFavorites(tooMany)).toThrowError(/MAX_FAVORITES/);
  });

  it("deep-copies the input: mutating the input after the call doesn't change storage", () => {
    const input: FavoriteStation[] = [
      fav({ code: "A01", name: "Metro Center", lines: ["RD"] }),
    ];
    reorderFavorites(input);
    // Mutate the caller's array AND the inner lines array.
    input[0]!.name = "MUTATED";
    input[0]!.lines.push("BL");
    input.push(fav({ code: "B01" }));

    const loaded = loadSettings().favorites;
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.name).toBe("Metro Center");
    expect(loaded[0]!.lines).toEqual(["RD"]);
  });
});

// ---------------------------------------------------------------------------
// clearSettings
// ---------------------------------------------------------------------------

describe("clearSettings", () => {
  it("wipes both keys; subsequent load returns defaults", () => {
    saveApiKey("abc");
    addFavorite(fav({ code: "A01" }));
    clearSettings();
    const s = loadSettings();
    expect(s.apiKey).toBe("");
    expect(s.favorites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Corrupt / mismatched / malformed payloads
// ---------------------------------------------------------------------------

describe("loadSettings: corrupt or invalid stored payloads", () => {
  it("corrupt JSON under wmata.g2.favorites returns empty favorites without throwing", () => {
    mockStorage.store.set("wmata.g2.favorites", "{not valid json}");
    let s: ReturnType<typeof loadSettings>;
    expect(() => {
      s = loadSettings();
    }).not.toThrow();
    expect(s!.favorites).toEqual([]);
    expect(s!.apiKey).toBe("");
  });

  it("schema version mismatch is ignored on load (returns defaults)", () => {
    mockStorage.store.set(
      "wmata.g2.favorites",
      JSON.stringify({
        schemaVersion: 99,
        value: [{ code: "A01", name: "Metro Center", lines: ["RD"] }],
      }),
    );
    const s = loadSettings();
    expect(s.favorites).toEqual([]);
  });

  it("malformed favorite entries are dropped; valid ones survive", () => {
    mockStorage.store.set(
      "wmata.g2.favorites",
      JSON.stringify({
        schemaVersion: 1,
        value: [
          { code: "A01", name: 42, lines: ["RD"] }, // bad name → dropped
          { code: "B01", name: "Gallery Pl", lines: ["RD"] }, // ok
          { code: 7, name: "wat", lines: [] }, // bad code → dropped
          "not even an object", // dropped
        ],
      }),
    );
    const s = loadSettings();
    expect(s.favorites.map((f) => f.code)).toEqual(["B01"]);
  });

  it("unknown LineCode values are dropped silently from the persisted entry", () => {
    mockStorage.store.set(
      "wmata.g2.favorites",
      JSON.stringify({
        schemaVersion: 1,
        value: [
          {
            code: "A01",
            name: "Metro Center",
            lines: ["RD", "PURPLE", "BL", 42],
          },
        ],
      }),
    );
    const s = loadSettings();
    expect(s.favorites.length).toBe(1);
    const wantedLines: LineCode[] = ["RD", "BL"];
    expect(s.favorites[0]!.lines).toEqual(wantedLines);
  });
});

// ---------------------------------------------------------------------------
// localStorage throwing on getItem / setItem
// ---------------------------------------------------------------------------

describe("loadSettings: localStorage throws on getItem", () => {
  it("degrades to defaults; no throw escapes", () => {
    // Wrap the existing mock with a Proxy that throws on getItem.
    const throwing = new Proxy(mockStorage, {
      get(target, prop, receiver): unknown {
        if (prop === "getItem") {
          return (): string | null => {
            throw new Error("SecurityError: private browsing");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    vi.stubGlobal("localStorage", throwing);

    let s: ReturnType<typeof loadSettings>;
    expect(() => {
      s = loadSettings();
    }).not.toThrow();
    expect(s!.apiKey).toBe("");
    expect(s!.favorites).toEqual([]);
  });
});

describe("saveApiKey: localStorage throws on setItem", () => {
  it("doesn't throw; nothing persists; subsequent load returns defaults", () => {
    const throwing = new Proxy(mockStorage, {
      get(target, prop, receiver): unknown {
        if (prop === "setItem") {
          return (): void => {
            throw new Error("QuotaExceededError");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    vi.stubGlobal("localStorage", throwing);

    expect(() => saveApiKey("abc")).not.toThrow();

    // Swap to a non-throwing storage to read back — nothing was written.
    vi.stubGlobal("localStorage", mockStorage);
    expect(loadSettings().apiKey).toBe("");
  });
});
