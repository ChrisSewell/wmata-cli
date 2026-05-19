// Elevator / escalator outages screen.
//
// User journey:
//   1. Home shows an `ACCESS (n)` row when ≥ 1 outage hits a favorite.
//   2. TAP on it lands here.
//   3. Scrollable list, one block per outage:
//        glyph(E/S) + station name, wrapped location description.
//
// Layout (24 cols × up to 7 usable body rows + 1 header row):
//
//   col:   0         1         2
//   col:   0123456789012345678901234
//          ACCESS (2)         14:32
//            E Foggy Bottom
//              Mezzanine to
//              street, west side
//
//            S Dupont Circle
//              Q St entr to plat
//
// Empty state (zero outages at favorite stations):
//
//          ACCESS             14:32
//          No active outages at
//          your stations.
//
//          (double-tap to return)
//
// Design notes:
//   - Mirrors the Incidents screen architecture exactly: pure view +
//     reducer, fetcher injection, pre-formatted blocks computed at
//     tick time, scroll math via `scrollWindowWithMarkers`.
//   - 3-state stale-marker escalation (`*` / `**` / `?`) matches
//     Predictions and Incidents — see `stalenessMarker` for the
//     identical contract.
//   - The unit-type glyph is a single character (`E` / `S`) to leave
//     room for the abbreviated station name on the same line.
//
// PURITY: No SDK imports. No I/O. The host owns the tick interval.

import {
  ELLIPSIS,
  LINE_WIDTH,
  USABLE_ROWS,
  scrollWindowWithMarkers,
  truncate,
} from "../ui/render";
import { abbreviateStation } from "../ui/format";
import type { ElevatorIncident } from "../wmata";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";

// ---------------------------------------------------------------------------
// Column / row budgets
// ---------------------------------------------------------------------------

/** Two-column gutter that precedes every body row. */
const INDENT = "  ";
/** Usable text width inside a body row, after the 2-col gutter. */
const BODY_TEXT_WIDTH = LINE_WIDTH - INDENT.length; // 22

/** Width budget for the abbreviated station name on the unit-header row. */
const STATION_NAME_BUDGET = BODY_TEXT_WIDTH - 2; // 20  ("X " glyph cell)

/**
 * Per-incident location-description lines cap. Matches the
 * `Incidents` screen's MAX_DESC_LINES so two screens have a
 * consistent visual rhythm.
 */
export const MAX_DESC_LINES = 4;

/** Wall-clock age (ms) after which a snapshot is considered stale. */
export const STALE_THRESHOLD_MS = 120_000;

/** Auto-refresh cadence handed back to the host via `tickIntervalMs`. */
export const TICK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Fields a `fetcher()` is expected to fill in on every refresh. */
export interface ElevatorFetchResult {
  incidents: ElevatorIncident[];
  fetchedAt: number;
  fetchError: string | null;
}

/** Data the Elevator screen renders against. */
export interface ElevatorSnapshot {
  /** Already filtered upstream to the user's favorite station codes. */
  incidents: ElevatorIncident[];
  /** Epoch-ms when the cache was last successfully refreshed; 0 = never. */
  fetchedAt: number;
  /** Last fetch error message; null when the most recent fetch succeeded. */
  fetchError: string | null;
  /**
   * Number of consecutive `tick()` failures since the last successful
   * fetch. Drives the 3-state stale marker — same contract as the
   * Predictions and Incidents screens.
   */
  consecutiveFetchFailures: number;
  /**
   * Pre-wrapped body rows, one inner array per outage (glyph row +
   * wrapped location-description lines). `flattenBlocks` inserts the
   * blank-line separator between consecutive outages at render time.
   */
  preformatted: string[][];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * Word-break-only text wrap. Identical to the helper in
 * `incidents.ts:wrap` — duplicated locally (rather than imported) so
 * the elevator module has no cross-screen import path. The two
 * implementations are kept in sync by `wrap.test.ts` style golden
 * tests; if the algorithm ever diverges, lift to `ui/render.ts`.
 */
export function wrap(text: string, width: number): string[] {
  if (!text) return [];
  if (width <= 1) return [];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      let remaining = word;
      while (remaining.length > width) {
        lines.push(remaining.slice(0, width - 1) + ELLIPSIS);
        remaining = remaining.slice(width - 1);
      }
      if (remaining.length > 0) current = remaining;
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = current + " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Cap wrapped description lines at MAX_DESC_LINES with an ellipsis. */
export function capDescription(lines: readonly string[]): string[] {
  if (lines.length <= MAX_DESC_LINES) return lines.slice();
  const out = lines.slice(0, MAX_DESC_LINES);
  const last = out[MAX_DESC_LINES - 1] ?? "";
  if (!last.endsWith(ELLIPSIS)) {
    if (last.length < BODY_TEXT_WIDTH - 2) {
      out[MAX_DESC_LINES - 1] = last + ELLIPSIS;
    } else {
      out[MAX_DESC_LINES - 1] =
        last.slice(0, BODY_TEXT_WIDTH - 3) + ELLIPSIS;
    }
  }
  return out;
}

/**
 * Single-char glyph for a `UnitType` string. WMATA returns
 * `"ELEVATOR"` / `"ESCALATOR"`; anything else collapses to `?` so the
 * column stays aligned.
 */
export function unitGlyph(unitType: string): string {
  if (unitType === "ELEVATOR") return "E";
  if (unitType === "ESCALATOR") return "S";
  return "?";
}

/**
 * Strip the entrance-name suffix from a multi-entrance station name.
 *
 * WMATA returns names like "Dupont Circle, Q Street Entrance" for
 * outages tied to a specific entrance. The Q-Street part belongs in
 * the location-description (it'll appear there anyway), not the
 * station-name header row.
 */
export function stationNameOnly(fullName: string): string {
  // Comma is the canonical separator for entrance suffixes.
  const idx = fullName.indexOf(",");
  return idx > 0 ? fullName.slice(0, idx).trim() : fullName.trim();
}

/**
 * Render the unit-header row (glyph + station name).
 *
 * Width contract: ≤ BODY_TEXT_WIDTH (22) chars. The caller prepends
 * the 2-col indent at flatten time so the result is directly usable.
 *
 *   "E Foggy Bottom-GWU"
 *   "S Dupont Circle"
 */
export function renderUnitHeader(incident: ElevatorIncident): string {
  const glyph = unitGlyph(incident.UnitType);
  const station = abbreviateStation(
    stationNameOnly(incident.StationName),
    STATION_NAME_BUDGET,
  );
  // glyph(1) + " "(1) + station(≤20) = ≤22
  return truncate(`${glyph} ${station}`, BODY_TEXT_WIDTH);
}

/**
 * Pre-format one outage into the block of body rows it will occupy:
 *
 *   ["E Foggy Bottom", "  Mezz to street", "  west side"]
 *
 * The description is wrapped to (BODY_TEXT_WIDTH - 2) cols so it sits
 * with a one-space indent under the unit-header — that visually
 * groups the description with its parent row.
 */
export function formatIncidentBlock(incident: ElevatorIncident): string[] {
  const header = renderUnitHeader(incident);
  const desc = (incident.LocationDescription ?? "").trim();
  if (desc.length === 0) return [header];
  // One-space inner indent so the description hangs under the
  // station name. Net usable width is BODY_TEXT_WIDTH - 1 = 21.
  const wrapped = capDescription(wrap(desc, BODY_TEXT_WIDTH - 1));
  return [header, ...wrapped.map((l) => " " + l)];
}

/** Flatten incident blocks into renderable body rows with separators. */
export function flattenBlocks(blocks: readonly string[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    for (const row of block) {
      out.push(INDENT + row);
    }
    if (i < blocks.length - 1) out.push("");
  }
  return out;
}

/** Format epoch-ms timestamp as 12-hour clock (` 9:05a` / `12:32p`). Duplicated from sibling screens. */
export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return " --:--";
  const d = new Date(epochMs);
  const h24 = d.getHours();
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  const hh = String(h12).padStart(2, " ");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ap = h24 < 12 ? "a" : "p";
  return `${hh}:${mm}${ap}`;
}

/** Time-based staleness predicate (mirrors `Incidents` semantics). */
export function isStale(snapshot: ElevatorSnapshot, nowMs: number): boolean {
  if (snapshot.fetchedAt <= 0) return true;
  return nowMs - snapshot.fetchedAt > STALE_THRESHOLD_MS;
}

/**
 * 3-state stale marker. Identical semantics to the helper of the
 * same name in `predictions.ts` / `incidents.ts`. Exported for the
 * test suite.
 */
export function stalenessMarker(
  snapshot: ElevatorSnapshot,
  nowMs: number,
): "" | "*" | "**" | "?" {
  const failures = Math.max(0, snapshot.consecutiveFetchFailures);
  if (snapshot.fetchedAt === 0 && snapshot.fetchError !== null) return "?";
  if (failures >= 3) return "?";
  if (failures === 2) return "**";
  if (failures === 1) return "*";
  if (isStale(snapshot, nowMs)) return "*";
  return "";
}

/**
 * Render the header row.
 *
 *   "ACCESS (n)             2:32p"   (n > 0)
 *   "ACCESS                 2:32p"   (empty)
 *
 * Marker character (`*` / `**` / `?`) sits to the right of the
 * clock, consuming from the gap between the left label and the
 * clock cell. Always exactly LINE_WIDTH cols.
 */
export function renderHeader(
  snapshot: ElevatorSnapshot,
  nowMs: number,
): string {
  const count = snapshot.incidents.length;
  const left = count > 0 ? `ACCESS (${count})` : "ACCESS";
  const marker = stalenessMarker(snapshot, nowMs);
  const clockStr = formatClock(nowMs);
  const clockCell = clockStr + marker;
  const spaces = Math.max(1, LINE_WIDTH - left.length - clockCell.length);
  return truncate(left + " ".repeat(spaces) + clockCell, LINE_WIDTH);
}

/**
 * Build the initial snapshot from a cached value. Pre-formats blocks
 * so the very first render doesn't have to wait on the first tick.
 */
export function makeInitialElevatorSnapshot(cache: {
  incidents: ElevatorIncident[];
  fetchedAt: number;
  fetchError: string | null;
}): ElevatorSnapshot {
  return {
    incidents: cache.incidents.slice(),
    fetchedAt: cache.fetchedAt,
    fetchError: cache.fetchError,
    consecutiveFetchFailures: 0,
    preformatted: cache.incidents.map(formatIncidentBlock),
  };
}

// ---------------------------------------------------------------------------
// Screen impl
// ---------------------------------------------------------------------------

/** Clamp `idx` to `[0, max]`. */
function clamp(idx: number, max: number): number {
  if (max < 0) return 0;
  if (idx < 0) return 0;
  if (idx > max) return max;
  return idx;
}

export function makeElevatorScreen(
  fetcher: () => Promise<ElevatorFetchResult>,
  initialSnapshot: ElevatorSnapshot,
): Screen<ElevatorSnapshot> & {
  tick: (snapshot: ElevatorSnapshot) => Promise<ElevatorSnapshot>;
  tickIntervalMs: number;
} {
  return {
    name: "elevator",
    init: () => initialSnapshot,
    view(snapshot, nav, ctx: ViewContext): string[] {
      const lines: string[] = [];
      lines.push(renderHeader(snapshot, ctx.nowMs));

      // Empty-data branches mirror the Incidents screen:
      // first-load fetch error gets distinct copy; otherwise the
      // friendly empty-state.
      if (
        snapshot.incidents.length === 0 &&
        snapshot.fetchedAt === 0 &&
        snapshot.fetchError !== null
      ) {
        lines.push(truncate("Couldn't reach WMATA.", LINE_WIDTH));
        lines.push(truncate("Will retry shortly.", LINE_WIDTH));
        lines.push("");
        lines.push(truncate("(double-tap to return)", LINE_WIDTH));
        return lines;
      }

      if (snapshot.incidents.length === 0) {
        lines.push(truncate("No active outages at", LINE_WIDTH));
        lines.push(truncate("your stations.", LINE_WIDTH));
        lines.push("");
        lines.push(truncate("(double-tap to return)", LINE_WIDTH));
        return lines;
      }

      const body = flattenBlocks(snapshot.preformatted);
      const offset = clamp(nav.highlightedIndex, Math.max(0, body.length - 1));
      const decorated = scrollWindowWithMarkers(body, offset, USABLE_ROWS);
      for (const r of decorated) lines.push(truncate(r, LINE_WIDTH));
      return lines;
    },
    reduce(snapshot, nav, event: ScreenEvent): ReduceResult<ElevatorSnapshot> {
      const body = flattenBlocks(snapshot.preformatted);
      const maxOffset = Math.max(0, body.length - 1);
      const offset = clamp(nav.highlightedIndex, maxOffset);
      switch (event.type) {
        case "SCROLL_UP":
          return { nav: { highlightedIndex: clamp(offset - 1, maxOffset) } };
        case "SCROLL_DOWN":
          return { nav: { highlightedIndex: clamp(offset + 1, maxOffset) } };
        case "TAP":
          // Read-only screen — no per-row tappable actions.
          return { nav: { highlightedIndex: offset } };
        case "DOUBLE_TAP":
          return {
            nav: { highlightedIndex: offset },
            navigate: { to: "home" },
          };
        default:
          return { nav: { highlightedIndex: offset } };
      }
    },
    /**
     * Refresh the snapshot from the injected fetcher. Never throws —
     * fetch errors land in `fetchError`. The fetcher's own `fetchError`
     * (the cache-layer-style result shape) is treated as a failure for
     * the consecutive-failure counter, matching the Incidents screen.
     */
    async tick(snapshot: ElevatorSnapshot): Promise<ElevatorSnapshot> {
      try {
        const result = await fetcher();
        const failed = result.fetchError !== null;
        return {
          incidents: result.incidents,
          fetchedAt: result.fetchedAt,
          fetchError: result.fetchError,
          consecutiveFetchFailures: failed
            ? snapshot.consecutiveFetchFailures + 1
            : 0,
          preformatted: result.incidents.map(formatIncidentBlock),
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        return {
          ...snapshot,
          fetchError: message,
          consecutiveFetchFailures: snapshot.consecutiveFetchFailures + 1,
        };
      }
    },
    tickIntervalMs: TICK_INTERVAL_MS,
  };
}
