// Wire-format parsing for rail incidents + the cached-snapshot shapes held by
// `data/session.ts`. Pure / stateless — the actual cache lives in the Session.

import type { LineCode, RailIncident, ElevatorIncident } from "./types";

/** Cached rail-incidents snapshot. Always a plain object, never `null`. */
export interface CachedIncidents {
  /** Incidents already filtered to lines the user cares about. */
  incidents: RailIncident[];
  /** Epoch-ms of the last successful refresh; 0 if never. */
  fetchedAt: number;
  /** Last fetch error message, or `null` if the most recent refresh succeeded. */
  fetchError: string | null;
}

/** Cached elevator/escalator-outage snapshot (filtered by favorite station). */
export interface CachedElevatorIncidents {
  incidents: ElevatorIncident[];
  fetchedAt: number;
  fetchError: string | null;
}

const VALID_LINE_CODES: ReadonlySet<string> = new Set<string>(["RD", "BL", "YL", "OR", "GR", "SV"]);

/**
 * Parse `LinesAffected` into a deduped, order-preserving `LineCode[]`.
 *
 * Wire shape is `;`-separated with variable whitespace, e.g. `"BL; OR; SV;"`,
 * `"BL;OR;SV"`, `"  ; BL ;  "`. Splits on `;\s*`, uppercases each token
 * defensively, drops empties / unknown codes / duplicates.
 */
export function parseLinesAffected(s: string): LineCode[] {
  if (!s) return [];
  const out: LineCode[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(/;\s*/)) {
    const code = raw.trim().toUpperCase();
    if (code.length === 0) continue;
    if (!VALID_LINE_CODES.has(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code as LineCode);
  }
  return out;
}
