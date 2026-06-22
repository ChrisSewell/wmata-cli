// Next-train ETA domain logic — pure selection/sorting + the batched
// favorite-ETA fetch. Returns raw WMATA `Min` tokens; display formatting
// ("4 min" / "ARR") is a UI concern (`ui/format`).

import { WmataClient, buildRailPredictionsUrl, type PredictionsResponse } from "../wmata";

/**
 * Sortable rank for "soonest train" selection (lower = sooner):
 *   `"BRD"` → -2 · `"ARR"` → -1 · numeric-as-string → the integer ·
 *   everything else (`""`, `"---"`, junk) → +Infinity (sorts to the tail).
 */
export function etaSortValue(min: string): number {
  if (min === "BRD") return -2;
  if (min === "ARR") return -1;
  if (/^\d+$/.test(min)) return Number.parseInt(min, 10);
  return Number.POSITIVE_INFINITY;
}

/**
 * Pick the soonest upcoming train's `Min` token from a station's predictions
 * (across all its lines). Returns the winning token verbatim (so `"ARR"` /
 * `"BRD"` survive for display) or `null` when there is no upcoming train.
 */
export function soonestEta(mins: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const min of mins) {
    const rank = etaSortValue(min);
    if (rank < bestRank) {
      best = min;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Fetch the soonest next-train ETA for every favorite station in ONE batched
 * `GetPrediction` call (WMATA accepts a comma-joined code list), returned as a
 * `stationCode → Min token | null` map. `null` = fetched but no upcoming
 * train; an ABSENT key (empty input) = not requested. One request for N
 * favorites keeps us well under the 10 req/s ceiling.
 *
 * Throws on network/decode failure — the caller (a tick) swallows it so the
 * rows linger at their last values rather than blanking.
 */
export async function buildFavoriteEtaMap(
  client: WmataClient,
  codes: readonly string[],
): Promise<Record<string, string | null>> {
  if (codes.length === 0) return {};
  const url = buildRailPredictionsUrl(codes.join(","));
  const data = await client.get<PredictionsResponse>(url);
  const trains = data.Trains ?? [];

  // The multi-station response can include platform siblings we didn't ask
  // for (e.g. Gallery Place B01/F01) — only bucket the requested codes.
  const wanted = new Set<string>(codes);
  const minsByCode = new Map<string, string[]>();
  for (const t of trains) {
    const code = t.LocationCode;
    if (!code || !wanted.has(code)) continue;
    const bucket = minsByCode.get(code);
    if (bucket) bucket.push(t.Min);
    else minsByCode.set(code, [t.Min]);
  }

  const out: Record<string, string | null> = {};
  for (const code of wanted) out[code] = soonestEta(minsByCode.get(code) ?? []);
  return out;
}
