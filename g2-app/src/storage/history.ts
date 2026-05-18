// Travel-history logger.
//
// Records which favorite station the user TAPs from Home, with a
// rolling-window timestamp log. The companion settings screen reads
// this to surface a "reorder your favorites?" suggestion when the
// user's most-tapped favorite isn't at the top of the list.
//
// Privacy: everything stays in the phone's localStorage. No data
// leaves the device. The log is capped at MAX_ENTRIES so a long
// session can't fill storage.
//
// Schema (under `wmata.g2.history`):
//   {
//     schemaVersion: 1,
//     value: [{ code: string, ts: number }, ...]   // oldest first
//   }

import type { FavoriteStation } from "./settings";

const KEY_HISTORY = "wmata.g2.history";
const SCHEMA_VERSION = 1;

/** Cap on stored entries — old ones are dropped FIFO. */
export const MAX_ENTRIES = 200;

/** One history entry. */
export interface HistoryEntry {
  /** Station code (e.g. "A01"). */
  code: string;
  /** Epoch-ms when the user opened predictions for this station. */
  ts: number;
}

// ---------------------------------------------------------------------------
// Safe localStorage wrappers (duplicated from settings.ts; trivial)
// ---------------------------------------------------------------------------

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    /* swallow — non-critical */
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    /* swallow */
  }
}

interface Envelope<T> {
  schemaVersion: number;
  value: T;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function parseEnvelope(raw: string | null): unknown {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed["schemaVersion"] !== SCHEMA_VERSION) return null;
  return parsed["value"];
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function asEntry(x: unknown): HistoryEntry | null {
  if (!isRecord(x)) return null;
  const code = x["code"];
  const ts = x["ts"];
  if (typeof code !== "string" || code.length === 0) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) return null;
  return { code, ts };
}

/** Read the entire history log (oldest first). Never throws. */
export function loadHistory(): HistoryEntry[] {
  const value = parseEnvelope(safeGet(KEY_HISTORY));
  if (!Array.isArray(value)) return [];
  const out: HistoryEntry[] = [];
  for (const v of value) {
    const e = asEntry(v);
    if (e) out.push(e);
  }
  // Cap defensively in case persisted state somehow exceeded MAX_ENTRIES.
  return out.slice(-MAX_ENTRIES);
}

/** Persist the log. Pass `[]` to clear. */
function writeHistory(entries: readonly HistoryEntry[]): void {
  const envelope: Envelope<HistoryEntry[]> = {
    schemaVersion: SCHEMA_VERSION,
    value: entries.slice(-MAX_ENTRIES),
  };
  safeSet(KEY_HISTORY, JSON.stringify(envelope));
}

/**
 * Append a history entry. `nowMs` is injected for testability;
 * production callers should pass `Date.now()`. The log is capped at
 * `MAX_ENTRIES`; oldest entries fall off FIFO.
 */
export function recordOpen(code: string, nowMs: number): void {
  const normalised = code.trim().toUpperCase();
  if (normalised.length === 0) return;
  const current = loadHistory();
  current.push({ code: normalised, ts: nowMs });
  writeHistory(current);
}

/** Clear the entire history (for the reset flow). */
export function clearHistory(): void {
  safeRemove(KEY_HISTORY);
}

// ---------------------------------------------------------------------------
// Summary / suggestion helpers
// ---------------------------------------------------------------------------

/**
 * Count opens per station code, optionally restricted to a recent
 * time window. Returns a map sorted by count descending.
 */
export function countByCode(
  entries: readonly HistoryEntry[],
  sinceMs: number = 0,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.ts < sinceMs) continue;
    counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
  }
  // Sort descending. Convert through an array of pairs and rebuild
  // the Map so iteration order matches the user's "most opened".
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return new Map(sorted);
}

/**
 * Suggest a reordered favorites list based on the user's last
 * `sinceMs` of taps. Returns `null` when:
 *   - history is sparse (< 5 entries in window),
 *   - the current order ALREADY matches the most-tapped order, or
 *   - any favorite isn't represented in the history (we don't want
 *     to demote a brand-new favorite the user hasn't tapped yet).
 *
 * Otherwise returns the suggested new ordering (same `FavoriteStation`
 * objects, just rearranged). The companion UI surfaces this as a
 * "Reorder?" hint and lets the user accept or dismiss.
 */
export function suggestReorder(
  favorites: readonly FavoriteStation[],
  entries: readonly HistoryEntry[],
  sinceMs: number = 0,
): FavoriteStation[] | null {
  if (favorites.length < 2) return null;
  if (entries.length < 5) return null;
  const counts = countByCode(entries, sinceMs);
  // Every favorite must have at least one open — otherwise we'd
  // demote a fresh favorite the user hasn't engaged with yet.
  for (const fav of favorites) {
    if (!counts.has(fav.code)) return null;
  }
  // Stable sort: ties keep their current order.
  const ranked = favorites
    .map((fav, idx) => ({ fav, idx, count: counts.get(fav.code) ?? 0 }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.idx - b.idx;
    })
    .map((entry) => entry.fav);
  // No-op suggestion: already in the right order.
  const sameAsCurrent = ranked.every(
    (fav, i) => fav.code === favorites[i]!.code,
  );
  if (sameAsCurrent) return null;
  return ranked;
}
