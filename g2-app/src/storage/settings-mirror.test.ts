// Unit tests for the durable-store mirror hook in settings.ts.
//
// Acceptance surface:
//   - A registered mirror receives every settings WRITE (the same key +
//     envelope string that lands in localStorage).
//   - Removals (clearSettings) mirror as an empty-string "unset".
//   - After `setStorageMirror(null)` no further writes are mirrored.
//
// The mirror is module-level state, so we register in beforeEach and
// clear it in afterEach to keep tests isolated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSettings,
  saveApiKey,
  setStorageMirror,
} from "./settings";

const KEY_API = "wmata.g2.apiKey";

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
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

let mockStorage: MockStorage;
let calls: Array<[string, string]>;

beforeEach(() => {
  mockStorage = makeMockStorage();
  vi.stubGlobal("localStorage", mockStorage);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  calls = [];
  setStorageMirror((key, value) => {
    calls.push([key, value]);
  });
});

afterEach(() => {
  setStorageMirror(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings durable-store mirror", () => {
  it("mirrors a write with the same key + value that lands in localStorage", () => {
    saveApiKey("ABC123");
    const mirrored = calls.find(([k]) => k === KEY_API);
    expect(mirrored).toBeDefined();
    // The mirrored value is the schema-versioned envelope (contains the key)…
    expect(mirrored![1]).toContain("ABC123");
    // …and is byte-identical to what was written to localStorage.
    expect(mirrored![1]).toBe(mockStorage.getItem(KEY_API));
  });

  it("mirrors a removal as an empty-string unset", () => {
    saveApiKey("ABC");
    calls.length = 0;
    clearSettings();
    expect(calls).toContainEqual([KEY_API, ""]);
  });

  it("stops mirroring once unregistered", () => {
    setStorageMirror(null);
    calls.length = 0;
    saveApiKey("X");
    expect(calls).toHaveLength(0);
    // …but the localStorage working copy is still written.
    expect(mockStorage.getItem(KEY_API)).toContain("X");
  });
});
