// Bridge-backed durable persistence for settings.
//
// The Even Hub SDK warns that WebView `window.localStorage` "may be
// cleared on app restart" — only `bridge.getLocalStorage` /
// `bridge.setLocalStorage` reliably persist across the packed app being
// closed and reopened (the same pattern the FlightAware_G2 app uses).
//
// Rather than rewrite the (synchronous, SDK-free, heavily-tested)
// `storage/settings.ts` into an async API, we keep `localStorage` as the
// fast working copy and bolt a thin sync layer onto the boundaries:
//
//   - `hydrateSettingsFromBridge(bridge)` runs ONCE at boot, before
//     anything reads settings: it copies every persisted key from the
//     durable bridge store into `localStorage`, so a fresh WebView
//     (whose `localStorage` was cleared) is repopulated from the store.
//   - `setStorageMirror` (in settings.ts) is wired to `mirrorToBridge`
//     so every subsequent settings write is echoed to the bridge store.
//
// Net effect: the bridge store is the cross-session source of truth;
// `localStorage` is a per-session cache rehydrated from it on launch.
//
// All bridge calls are wrapped in a short timeout and swallow errors —
// a slow or missing bridge degrades to "localStorage only" rather than
// blocking the boot path.

import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

import { STORAGE_KEYS } from "./settings";

/** Only the storage methods are needed; accept anything bridge-shaped. */
type StorageBridge = Pick<EvenAppBridge, "getLocalStorage" | "setLocalStorage">;

/** Max wait for any single bridge storage call before giving up. */
const BRIDGE_STORAGE_TIMEOUT_MS = 2_000;

/**
 * Reject `p` if it hasn't settled within `ms`. Unlike a naive
 * `Promise.race([p, timeout])`, this clears the timer as soon as `p`
 * settles, so a fast bridge call doesn't leave a dangling 2s timeout
 * firing later (these run per-key at boot and on every settings write).
 */
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
 * `localStorage`. Run once at boot, before `loadSettings()` /
 * `mountSettingsScreen` / `bootGlasses` read anything.
 *
 * A bridge value of `""` (the store's "unset") is skipped so we never
 * stomp a present `localStorage` value with an empty one. All keys are
 * fetched in parallel; an individual key that errors or times out is
 * silently skipped (that key just falls back to whatever `localStorage`
 * already holds, or defaults).
 */
export async function hydrateSettingsFromBridge(
  bridge: StorageBridge,
): Promise<void> {
  await Promise.all(
    STORAGE_KEYS.map(async (key) => {
      try {
        const value = await withTimeout(
          bridge.getLocalStorage(key),
          BRIDGE_STORAGE_TIMEOUT_MS,
        );
        if (typeof value === "string" && value.length > 0) {
          try {
            localStorage.setItem(key, value);
          } catch {
            // localStorage unavailable (private mode / sandbox) — the
            // in-memory defaults path in settings.ts handles this.
          }
        }
      } catch {
        // Bridge read failed/timed out for this key — leave localStorage
        // (or defaults) in place.
      }
    }),
  );
}

/**
 * Mirror a single settings write to the durable bridge store. Wired into
 * `settings.ts` via `setStorageMirror`. Best-effort and fire-and-forget:
 * the caller does not await it, and any failure is swallowed (the
 * `localStorage` working copy already holds the value for this session).
 */
export function mirrorToBridge(
  bridge: StorageBridge,
  key: string,
  value: string,
): void {
  void withTimeout(
    bridge.setLocalStorage(key, value),
    BRIDGE_STORAGE_TIMEOUT_MS,
  ).catch(() => {
    // ignore — durable mirror is best-effort
  });
}
