// Pure helpers for the live-train tracker + ASCII line schematic
// (WP-I). All functions are pure — no SDK calls, no I/O — so the
// view-side schematic is fully unit-testable.

import type { StandardRoute } from "../wmata";
import { textWidth } from "./render";
import { SECTION_INNER_WIDTH_PX } from "./geometry";

// The schematic is a monospace-style ASCII diagram (one char per station
// cell). The firmware font is proportional, so we conservatively size the
// column count by the WIDEST glyph the diagram can contain — guaranteeing
// the row never overflows the body width regardless of which cells land on
// markers.
const SCHEMATIC_GLYPH_MAX_PX = Math.max(
  textWidth("-"),
  textWidth("*"),
  textWidth("@"),
  textWidth(" "),
  textWidth("W"),
);
const SCHEMATIC_COLS = Math.floor(SECTION_INNER_WIDTH_PX / SCHEMATIC_GLYPH_MAX_PX);

/**
 * Build the ordered list of revenue station codes for a given line,
 * derived from `StandardRoutes`. Track 1 is read by convention —
 * WMATA's two tracks share the same station ordering, just opposite
 * directions of travel. Stations are unique by code; duplicates
 * (which appear in the raw data for branching points) are kept in
 * first-seen order.
 *
 * Returns an empty array when no route is found for the line.
 */
export function buildLineStations(
  routes: readonly StandardRoute[],
  lineCode: string,
): string[] {
  if (typeof lineCode !== "string" || lineCode.length === 0) return [];
  const route =
    routes.find((r) => r.LineCode === lineCode && r.TrackNum === 1) ??
    routes.find((r) => r.LineCode === lineCode);
  if (!route) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const circuit of route.TrackCircuits ?? []) {
    if (typeof circuit.StationCode !== "string") continue;
    if (circuit.StationCode.length === 0) continue;
    if (seen.has(circuit.StationCode)) continue;
    seen.add(circuit.StationCode);
    out.push(circuit.StationCode);
  }
  return out;
}

/**
 * Find the station code closest to a given track circuit on a line.
 * Walks the route's `TrackCircuits` in `SeqNum` order, picks the
 * nearest revenue station by sequence-number distance. Returns
 * `null` when the line has no revenue stations.
 *
 * Notes:
 *   - "Nearest revenue station" is an approximation — circuits
 *     between stations resolve to the *next* upcoming station along
 *     the train's direction of travel, which is what the user wants
 *     for an arrival estimate.
 *   - The track-number argument is intentionally ignored: a
 *     `circuitId` is unique system-wide, so we'd just scan both
 *     tracks for the same answer.
 */
export function findNearestStationToCircuit(
  routes: readonly StandardRoute[],
  lineCode: string,
  circuitId: number,
): string | null {
  const route =
    routes.find((r) => r.LineCode === lineCode && r.TrackNum === 1) ??
    routes.find((r) => r.LineCode === lineCode);
  if (!route) return null;
  const circuits = route.TrackCircuits ?? [];
  // Find the SeqNum of the train's circuit on this route.
  const trainSeq = circuits.find(
    (c) => c.CircuitId === circuitId,
  )?.SeqNum;
  if (typeof trainSeq !== "number") {
    // Fall back: the circuit isn't on Track 1 (e.g. the train is on
    // Track 2). Try every route on the line.
    for (const r of routes) {
      if (r.LineCode !== lineCode) continue;
      const hit = r.TrackCircuits.find((c) => c.CircuitId === circuitId);
      if (typeof hit?.SeqNum === "number") {
        return findNearestStationByCircuit(circuits, hit.SeqNum);
      }
    }
    return null;
  }
  return findNearestStationByCircuit(circuits, trainSeq);
}

function findNearestStationByCircuit(
  circuits: readonly { SeqNum: number; StationCode: string | null }[],
  trainSeq: number,
): string | null {
  let bestStation: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of circuits) {
    if (typeof c.StationCode !== "string") continue;
    if (c.StationCode.length === 0) continue;
    const d = Math.abs(c.SeqNum - trainSeq);
    if (d < bestDistance) {
      bestDistance = d;
      bestStation = c.StationCode;
    }
  }
  return bestStation;
}

/**
 * Count stations between two station codes on the same line, using
 * the ordered station list from `buildLineStations`. Returns `null`
 * when either station isn't on the line. The result is the absolute
 * number of intermediate stops — `0` means "the train is at the
 * user's station", `1` means "one stop away", etc.
 */
export function stationsBetween(
  lineStations: readonly string[],
  fromCode: string,
  toCode: string,
): number | null {
  const a = lineStations.indexOf(fromCode);
  const b = lineStations.indexOf(toCode);
  if (a < 0 || b < 0) return null;
  return Math.abs(a - b);
}

/** Plain-station cell glyph (looks like line continuity). */
export const SCHEMATIC_GLYPH_PLAIN = "-";
/** User-station cell glyph. Matches the predictions-row cursor `*`. */
export const SCHEMATIC_GLYPH_USER = "*";
/** Pinned-train cell glyph. */
export const SCHEMATIC_GLYPH_TRAIN = "@";

/**
 * Render a 1-row ASCII line schematic showing the user's station
 * (`*`) and (optionally) the pinned train's nearest station (`@`).
 * Returns a fixed-width row of `SCHEMATIC_COLS` cells.
 *
 * Glyphs deliberately stay in 7-bit ASCII — the G2 panel's font set
 * isn't documented to include `·` / `★` / `⦿`, and an `*` reads as
 * a station marker on any monospace grid.
 *
 * Strategy:
 *   - 3-char left-prefix: line code + space (`"RD "`).
 *   - Remaining `LINE_WIDTH - 3` cells: one char per station.
 *     For lines longer than the budget, resample (linear stride)
 *     so the user and train markers land on their best-fit cells.
 *     The cell rule when multiple stations map to one cell:
 *     train (`@`) wins over user (`*`) wins over plain (`-`).
 *
 * `userIdx` / `trainIdx` are indices into `lineStations`; pass
 * `-1` to mean "not on the line".
 */
export function renderLineSchematic(
  lineCode: string,
  lineStations: readonly string[],
  userIdx: number,
  trainIdx: number,
): string {
  const prefix = (lineCode.length > 0 ? lineCode : "--").slice(0, 2) + " ";
  const budget = SCHEMATIC_COLS - prefix.length;
  if (budget <= 0 || lineStations.length === 0) {
    return (prefix + " ".repeat(SCHEMATIC_COLS)).slice(0, SCHEMATIC_COLS);
  }
  const cells: string[] = [];
  // Map each cell index → set of station indices it covers, then
  // pick the highest-precedence marker for that cell.
  const stationsPerCell = Math.max(1, Math.ceil(lineStations.length / budget));
  for (let cell = 0; cell < budget; cell++) {
    const startStation = cell * stationsPerCell;
    const endStation = Math.min(
      lineStations.length,
      startStation + stationsPerCell,
    );
    if (startStation >= lineStations.length) {
      cells.push(" ");
      continue;
    }
    let glyph: string = SCHEMATIC_GLYPH_PLAIN;
    for (let i = startStation; i < endStation; i++) {
      if (i === trainIdx) {
        glyph = SCHEMATIC_GLYPH_TRAIN;
        break;
      }
      if (i === userIdx) {
        glyph = SCHEMATIC_GLYPH_USER;
      }
    }
    cells.push(glyph);
  }
  // Truncate to budget defensively. The map above guarantees length
  // === budget but a future change might break that.
  const body = cells.join("").slice(0, budget);
  return prefix + body;
}
