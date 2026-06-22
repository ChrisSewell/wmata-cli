// Bridge-backed durable persistence for settings.
//
// WebView `localStorage` "may be cleared on app restart" (Even Hub SDK); only
// `bridge.getLocalStorage` / `bridge.setLocalStorage` reliably persist across
// the packed app closing and reopening. Rather than make `storage/settings.ts`
// async, we keep `localStorage` as the fast working copy and bolt a thin sync
// layer onto the boundaries:
//
//   - `hydrateSettingsFromBridge` runs ONCE at boot (before anything reads
//     settings): copies every persisted key from the durable store into
//     localStorage, repopulating a freshly-cleared WebView.
//   - `mirrorToBridge` is wired via `setStorageMirror` so every settings write
//     echoes to the durable store.
//
// All bridge calls are timeout-wrapped and swallow errors — a slow/missing
// bridge degrades to "localStorage only" rather than blocking boot. This is
// what passes the 5-minute locked-phone test.

import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

import { STORAGE_KEYS } from "./settings";

/** Only the storage methods are needed; accept anything bridge-shaped. */
type StorageBridge = Pick<EvenAppBridge, "getLocalStorage" | "setLocalStorage">;

const BRIDGE_STORAGE_TIMEOUT_MS = 2_000;

/** Reject if `p` hasn't settled within `ms`, clearing the timer on settle. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("bridge storage timeout"));
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Copy every persisted settings key from the durable bridge store into
 * `localStorage`. Run once at boot, before anything reads settings. A bridge
 * value of `""` (the store's "unset") is skipped so we never stomp a present
 * localStorage value. Keys fetched in parallel; an erroring/timed-out key is
 * silently skipped.
 */
export async function hydrateSettingsFromBridge(bridge: StorageBridge): Promise<void> {
  await Promise.all(
    STORAGE_KEYS.map(async (key) => {
      try {
        const value = await withTimeout(bridge.getLocalStorage(key), BRIDGE_STORAGE_TIMEOUT_MS);
        if (typeof value === "string" && value.length > 0) {
          try {
            localStorage.setItem(key, value);
          } catch {
            // localStorage unavailable — settings.ts defaults path handles it.
          }
        }
      } catch {
        // Bridge read failed/timed out — leave localStorage (or defaults).
      }
    }),
  );
}

/**
 * Mirror a single settings write to the durable bridge store. Best-effort and
 * fire-and-forget — the localStorage working copy already holds the value for
 * this session.
 */
export function mirrorToBridge(bridge: StorageBridge, key: string, value: string): void {
  void withTimeout(bridge.setLocalStorage(key, value), BRIDGE_STORAGE_TIMEOUT_MS).catch(() => {
    // ignore — durable mirror is best-effort
  });
}
