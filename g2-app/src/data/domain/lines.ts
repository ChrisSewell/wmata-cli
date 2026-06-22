// Line-set domain helpers — pure, no SDK. A `FavoriteStation` is the domain
// record the companion saves and the glasses render; it lives here (not in
// storage) because it's domain data, and storage imports it.

import type { LineCode, RailIncident, Station } from "../wmata";
import { parseLinesAffected } from "../wmata";

/** A saved station: its code, display name, and the lines it serves. */
export interface FavoriteStation {
  code: string;
  name: string;
  lines: LineCode[];
}

/** Canonical line order, for deterministic display across renders. */
export const LINE_ORDER: readonly LineCode[] = ["RD", "BL", "YL", "OR", "GR", "SV"];

/** Collect the non-null line codes a Station serves (LineCode1..4). */
export function stationLines(station: Station): LineCode[] {
  const out: LineCode[] = [];
  for (const code of [station.LineCode1, station.LineCode2, station.LineCode3, station.LineCode4]) {
    if (code) out.push(code);
  }
  return out;
}

/** Unique `LineCode`s across the user's favorites — scopes the incidents fetch. */
export function computeUserLines(favorites: readonly FavoriteStation[]): LineCode[] {
  const seen = new Set<LineCode>();
  for (const fav of favorites) {
    for (const code of fav.lines) seen.add(code);
  }
  return Array.from(seen);
}

/**
 * The deduped set of followed lines that currently have ≥1 active incident,
 * returned in canonical `LINE_ORDER`. Drives the Home "Alerts" summary.
 */
export function computeAffectedLines(
  incidents: readonly RailIncident[],
  userLines: readonly LineCode[],
): LineCode[] {
  if (userLines.length === 0) return [];
  const userSet = new Set<LineCode>(userLines);
  const affected = new Set<LineCode>();
  for (const inc of incidents) {
    for (const code of parseLinesAffected(inc.LinesAffected ?? "")) {
      if (userSet.has(code)) affected.add(code);
    }
  }
  return LINE_ORDER.filter((c) => affected.has(c));
}
