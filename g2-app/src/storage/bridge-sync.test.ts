// Unit tests for the bridge-backed durable-persistence sync layer.
//
// Acceptance surface (mirrors bridge-sync.ts):
//   - hydrate copies every NON-EMPTY persisted key from the bridge store
//     into localStorage.
//   - hydrate SKIPS empty bridge values, so it never stomps a present
//     localStorage value with "".
//   - hydrate tolerates a bridge whose read rejects/times out for a key:
//     that key is skipped, the others still hydrate, and it never throws.
//   - mirrorToBridge forwards (key, value) to bridge.setLocalStorage and
//     swallows a rejecting write (never throws to the caller).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "./settings";
import { hydrateSettingsFromBridge, mirrorToBridge } from "./bridge-sync";

// ---------------------------------------------------------------------------
// Mocks
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
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/** A bridge stub exposing only the two storage methods bridge-sync uses. */
function makeMockBridge(
  values: Record<string, string>,
  opts: { rejectKeys?: Set<string>; rejectWrites?: boolean } = {},
) {
  return {
    getLocalStorage: vi.fn(async (key: string): Promise<string> => {
      if (opts.rejectKeys?.has(key)) throw new Error("read boom");
      return values[key] ?? "";
    }),
    setLocalStorage: vi.fn(async (_key: string, _value: string): Promise<boolean> => {
      if (opts.rejectWrites) throw new Error("write boom");
      return true;
    }),
  };
}

let mockStorage: MockStorage;

beforeEach(() => {
  mockStorage = makeMockStorage();
  vi.stubGlobal("localStorage", mockStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// hydrate
// ---------------------------------------------------------------------------

describe("hydrateSettingsFromBridge", () => {
  it("copies every non-empty bridge value into localStorage", async () => {
    const values: Record<string, string> = {};
    STORAGE_KEYS.forEach((k, i) => {
      values[k] = `value-${i}`;
    });
    const bridge = makeMockBridge(values);

    await hydrateSettingsFromBridge(bridge);

    STORAGE_KEYS.forEach((k, i) => {
      expect(mockStorage.getItem(k)).toBe(`value-${i}`);
    });
  });

  it("skips empty bridge values (no localStorage write)", async () => {
    const bridge = makeMockBridge({}); // every key returns ""
    await hydrateSettingsFromBridge(bridge);
    for (const k of STORAGE_KEYS) {
      expect(mockStorage.getItem(k)).toBeNull();
    }
  });

  it("does not overwrite a present localStorage value with an empty bridge value", async () => {
    const key = STORAGE_KEYS[0]!;
    mockStorage.setItem(key, "keep-me");
    const bridge = makeMockBridge({}); // returns "" for everything
    await hydrateSettingsFromBridge(bridge);
    expect(mockStorage.getItem(key)).toBe("keep-me");
  });

  it("tolerates a rejecting read: skips that key, still hydrates the rest, never throws", async () => {
    const bad = STORAGE_KEYS[0]!;
    const good = STORAGE_KEYS[1]!;
    const bridge = makeMockBridge(
      { [bad]: "wont-be-read", [good]: "ok" },
      { rejectKeys: new Set([bad]) },
    );

    await expect(hydrateSettingsFromBridge(bridge)).resolves.toBeUndefined();
    expect(mockStorage.getItem(bad)).toBeNull();
    expect(mockStorage.getItem(good)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// mirror
// ---------------------------------------------------------------------------

describe("mirrorToBridge", () => {
  it("forwards (key, value) to bridge.setLocalStorage", () => {
    const bridge = makeMockBridge({});
    mirrorToBridge(bridge, "wmata.g2.apiKey", "envelope-json");
    expect(bridge.setLocalStorage).toHaveBeenCalledWith(
      "wmata.g2.apiKey",
      "envelope-json",
    );
  });

  it("swallows a rejecting write — never throws to the caller", () => {
    const bridge = makeMockBridge({}, { rejectWrites: true });
    expect(() => mirrorToBridge(bridge, "k", "v")).not.toThrow();
  });
});
