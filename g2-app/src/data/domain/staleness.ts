// Shared data-freshness vocabulary for the auto-refreshing screens
// (Predictions, Alerts). Pure. Each screen picks its own threshold (predictions
// go stale in ~60s; incidents in ~2min) but the marker semantics are identical
// so both screens degrade with the same UX vocabulary.

export type StaleMarker = "" | "*" | "**" | "?";

export interface Freshness {
  /** Epoch-ms of the last SUCCESSFUL fetch; 0 = never succeeded. */
  fetchedAt: number;
  /** Last fetch error message, or null if the most recent fetch succeeded. */
  fetchError: string | null;
  /** Consecutive tick failures since the last success. */
  consecutiveFailures: number;
}

/** True when the last success is older than `thresholdMs` (or never happened). */
export function isStale(fetchedAt: number, nowMs: number, thresholdMs: number): boolean {
  if (fetchedAt <= 0) return true;
  return nowMs - fetchedAt > thresholdMs;
}

/**
 * Map (staleness × failure-count) onto a 3-state marker the host renders next
 * to the clock:
 *   `""`  fresh · `"*"` stale-by-time or 1 failure · `"**"` 2 failures ·
 *   `"?"` ≥3 failures, or no successful fetch ever with an active error.
 */
export function stalenessMarker(f: Freshness, nowMs: number, thresholdMs: number): StaleMarker {
  const failures = Math.max(0, f.consecutiveFailures);
  if (f.fetchedAt === 0 && f.fetchError !== null) return "?";
  if (failures >= 3) return "?";
  if (failures === 2) return "**";
  if (failures === 1) return "*";
  if (isStale(f.fetchedAt, nowMs, thresholdMs)) return "*";
  return "";
}
