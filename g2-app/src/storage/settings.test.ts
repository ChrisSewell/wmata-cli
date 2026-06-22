import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadSettings,
  saveApiKey,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  clearSettings,
  setStorageMirror,
  MAX_FAVORITES,
  type FavoriteStation,
} from "./settings";

// Map-backed localStorage stub so these tests run in the `node` env without
// pulling in jsdom.
function makeLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

beforeEach(() => vi.stubGlobal("localStorage", makeLocalStorage()));
afterEach(() => {
  setStorageMirror(null);
  vi.unstubAllGlobals();
});

const fav = (code: string): FavoriteStation => ({ code, name: code, lines: ["RD"] });

describe("loadSettings defaults", () => {
  it("returns empty defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual({ apiKey: "", favorites: [] });
  });
  it("returns defaults on a schema-version mismatch", () => {
    localStorage.setItem("wmata.g2.apiKey", JSON.stringify({ schemaVersion: 99, value: "abc" }));
    expect(loadSettings().apiKey).toBe("");
  });
});

describe("apiKey", () => {
  it("round-trips a trimmed key", () => {
    saveApiKey("  mykey123  ");
    expect(loadSettings().apiKey).toBe("mykey123");
  });
});

describe("favorites", () => {
  it("adds, dedupes, and enforces the cap", () => {
    addFavorite(fav("A"));
    addFavorite(fav("A")); // duplicate — no-op
    expect(loadSettings().favorites.map((f) => f.code)).toEqual(["A"]);

    for (const c of ["B", "C", "D", "E", "F"]) addFavorite(fav(c));
    const codes = loadSettings().favorites.map((f) => f.code);
    expect(codes.length).toBe(MAX_FAVORITES);
    expect(codes).toEqual(["A", "B", "C", "D", "E"]); // F refused at cap
  });

  it("removes by code", () => {
    addFavorite(fav("A"));
    addFavorite(fav("B"));
    removeFavorite("A");
    expect(loadSettings().favorites.map((f) => f.code)).toEqual(["B"]);
  });

  it("reorders", () => {
    addFavorite(fav("A"));
    addFavorite(fav("B"));
    reorderFavorites([fav("B"), fav("A")]);
    expect(loadSettings().favorites.map((f) => f.code)).toEqual(["B", "A"]);
  });
});

describe("durable mirror", () => {
  it("echoes every write to the registered mirror", () => {
    const writes: Array<[string, string]> = [];
    setStorageMirror((k, v) => writes.push([k, v]));
    saveApiKey("k");
    addFavorite(fav("A"));
    const keys = writes.map(([k]) => k);
    expect(keys).toContain("wmata.g2.apiKey");
    expect(keys).toContain("wmata.g2.favorites");
  });
  it("mirrors an empty string on clear (the store's 'unset')", () => {
    const writes: Array<[string, string]> = [];
    setStorageMirror((k, v) => writes.push([k, v]));
    clearSettings();
    expect(writes).toContainEqual(["wmata.g2.apiKey", ""]);
    expect(writes).toContainEqual(["wmata.g2.favorites", ""]);
  });
});
