// Wire-format parsers for the WMATA rail-incidents endpoint.
//
// History: v1.0 owned a module-scoped cache of filtered incidents
// (`_cache`). That has been lifted into a per-session cache on the
// `Session` class (see `src/session.ts`), so the lifetime of cached data
// is the lifetime of the API key. This module now only owns the pure
// parsing helper and the `CachedIncidents` shape — both stateless.
//
// The file name is kept (`incidents-cache.ts`) rather than renamed to
// `incidents.ts` to minimize churn on importers. The actual cache lives
// in `session.ts`.

import { type LineCode } from "./index";
import type { RailIncident } from "./index";

/**
 * Shape of the cached value held inside `Session`.
 *
 * Always a plain object, never `null`.
 */
export interface CachedIncidents {
  /** Incidents already filtered to lines the user cares about. */
  incidents: RailIncident[];
  /** Epoch-ms of the last successful refresh; 0 if never. */
  fetchedAt: number;
  /** Last fetch error message, or `null` if the most recent refresh succeeded. */
  fetchError: string | null;
}

/** The set of valid line codes used to drop unknown codes during parsing. */
const VALID_LINE_CODES: ReadonlySet<string> = new Set<string>([
  "RD",
  "BL",
  "YL",
  "OR",
  "GR",
  "SV",
]);

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
