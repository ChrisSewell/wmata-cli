// Process-wide rail-incidents cache.
//
// Why a shared cache?
//
//   Two screens need this data at different cadences:
//     - Home renders only an "ALERTS (n)" count and ticks every 60s.
//     - The Incidents screen renders the full list and ticks every 60s.
//   Without a shared cache, both would call `INCIDENTS_RAIL` on their
//   own intervals, doubling the network load and the WMATA rate budget
//   for what is, conceptually, a single fact about the world ("what
//   alerts are active right now").
//
//   Module-level state mirrors `stations.ts` exactly — same pattern, same
//   reasoning, same `clear*()` reset hook for tests.
//
// Failure semantics:
//
//   `refreshIncidents` NEVER throws. A failed fetch leaves the prior
//   `incidents` list intact (so a transient network blip doesn't blank
//   the screen) and stamps `fetchError` with a human-readable message.
//   `fetchedAt` is only advanced on success. This is identical to the
//   policy on the Predictions screen.
//
// Race / staleness behaviour:
//
//   Two concurrent `refreshIncidents` calls (e.g. Home fires its 60s
//   tick at T while the Incidents screen fires at T+epsilon) will both
//   start a fetch and the LAST one to resolve wins. We accept that:
//   the only loss is "freshest wins", which is exactly what we want
//   for a list-of-current-alerts surface where the data is identical
//   between callers. There is no per-caller filter difference, because
//   we filter against `userLines` AFTER the fetch — and `userLines`
//   is loaded from the same `loadSettings()` source in both callers,
//   so they always agree.

import { INCIDENTS_RAIL, WmataError, type LineCode } from "./index";
import type { WmataClient, RailIncident, IncidentsResponse } from "./index";

/** The set of valid line codes used to drop unknown codes during parsing. */
const VALID_LINE_CODES: ReadonlySet<string> = new Set<string>([
  "RD",
  "BL",
  "YL",
  "OR",
  "GR",
  "SV",
]);

/** Shape of the cached value. Always a plain object, never `null`. */
export interface CachedIncidents {
  /** Incidents already filtered to lines the user cares about. */
  incidents: RailIncident[];
  /** Epoch-ms of the last successful refresh; 0 if never. */
  fetchedAt: number;
  /** Last fetch error message, or `null` if the most recent refresh succeeded. */
  fetchError: string | null;
}

/** Module-private cache. Survives across calls until `clearIncidentsCache`. */
let _cache: CachedIncidents = {
  incidents: [],
  fetchedAt: 0,
  fetchError: null,
};

/**
 * Read the current cache snapshot synchronously.
 *
 * Returns a shallow copy so callers can't mutate the module's state by
 * accident (e.g. by sorting the incidents array in place). This keeps
 * the cache referentially stable from the screen's point of view —
 * every render reads a fresh, immutable view.
 */
export function readCachedIncidents(): CachedIncidents {
  return {
    incidents: _cache.incidents.slice(),
    fetchedAt: _cache.fetchedAt,
    fetchError: _cache.fetchError,
  };
}

/**
 * Parse the wire format of `LinesAffected` into a deduped `LineCode[]`.
 *
 * The wire shape (per docs/wmata-api/incidents.md) is a semicolon-and-
 * optionally-space-separated string, e.g.:
 *   "BL; OR; SV;"   (canonical)
 *   "BL;OR;SV"      (no spaces)
 *   "  ; BL ;  "    (whitespace-heavy edge case observed in the wild)
 *   "RD;XX;SV;"     (unknown line code)
 *   ""              (no lines field on the wire)
 *
 * Strategy: split on `;`, trim each piece, drop empties, drop anything
 * that isn't a known LineCode. We use `String.split(/;\s(zero-or-more)/)`
 * rather than the regex shown in the docs (`/;[\s]?/`) because the
 * latter only eats a single whitespace char — real-world responses
 * occasionally double-space or pad with leading whitespace on the
 * first token. Greedy `\s*` is robust to all of those.
 *
 * Case normalization: WMATA's contract is uppercase line codes, but we
 * defensively `.toUpperCase()` each token before the VALID_LINE_CODES
 * lookup so a future API quirk (or a stray test fixture) doesn't cause
 * the parser to silently drop a valid line code that arrived in mixed
 * or lower case.
 *
 * Result is order-preserving and deduped (the wire format occasionally
 * repeats a code, and we don't want to inflate the affected-lines count).
 */
export function parseLinesAffected(s: string): LineCode[] {
  if (!s) return [];
  const out: LineCode[] = [];
  const seen = new Set<string>();
  // Trim leading whitespace so a string like "  ;BL;" doesn't yield a
  // first token of "  " that fails the LineCode check redundantly.
  for (const raw of s.split(/;\s*/)) {
    // Normalize to uppercase BEFORE the lookup. The wire contract is
    // already uppercase per WMATA's docs, but the cost of being robust
    // is one `.toUpperCase()` per token — well worth it to avoid a
    // silent data-loss bug if the contract ever slips.
    const code = raw.trim().toUpperCase();
    if (code.length === 0) continue;
    if (!VALID_LINE_CODES.has(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code as LineCode);
  }
  return out;
}

/**
 * True if an incident shares ≥1 affected line with `userLines`.
 *
 * Exported only for symmetry with the parsing helper; the cache uses
 * this internally inside `refreshIncidents`.
 */
function matchesUserLines(
  incident: RailIncident,
  userLines: ReadonlySet<LineCode>,
): boolean {
  if (userLines.size === 0) return false;
  const lines = parseLinesAffected(incident.LinesAffected);
  for (const code of lines) {
    if (userLines.has(code)) return true;
  }
  return false;
}

/**
 * Refresh the cache from the WMATA API. Filters to the user's lines
 * before storing — there's no point caching incidents on lines the user
 * doesn't ride.
 *
 * Never throws. On failure the prior `incidents` list is preserved
 * (don't blank the HUD over a transient network blip) and `fetchError`
 * is populated. `fetchedAt` only advances on success.
 *
 * Returns the new cache value.
 */
export async function refreshIncidents(
  client: WmataClient,
  userLines: readonly LineCode[],
): Promise<CachedIncidents> {
  const userSet = new Set<LineCode>(userLines);
  try {
    const data = await client.get<IncidentsResponse>(INCIDENTS_RAIL);
    const all = data.Incidents ?? [];
    const filtered = all.filter((inc) => matchesUserLines(inc, userSet));
    _cache = {
      incidents: filtered,
      fetchedAt: Date.now(),
      fetchError: null,
    };
  } catch (err) {
    const message =
      err instanceof WmataError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err ?? "Unknown error");
    // Preserve the prior incidents list so the screen doesn't blank on
    // a transient failure. fetchedAt is left unchanged — it represents
    // the LAST SUCCESSFUL fetch, not the last attempt.
    _cache = {
      incidents: _cache.incidents,
      fetchedAt: _cache.fetchedAt,
      fetchError: message,
    };
  }
  return readCachedIncidents();
}

/** Wipe the cache. Tests / reset flows only. */
export function clearIncidentsCache(): void {
  _cache = {
    incidents: [],
    fetchedAt: 0,
    fetchError: null,
  };
}
