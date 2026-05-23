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
  scrollWindowWithMarkers,
  textWidth,
  truncate,
} from "../ui/render";
import {
  HEADER_CONTENT_WIDTH_PX,
  SECTION_INNER_WIDTH_PX,
  TWO_BODY_MAX_LINES,
} from "../ui/geometry";
import { abbreviateStation } from "../ui/format";
import type { ElevatorIncident } from "../wmata";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ScreenSections,
  ViewContext,
} from "./router";

// The canonical HUD clock formatter now lives in `../ui/format` (the host
// renders it in its own dedicated top-right container). Re-export it here
// so existing `import { formatClock } from "./elevator"` call sites
// (notably the test suite) keep resolving.
export { formatClock } from "../ui/format";

// ---------------------------------------------------------------------------
// Column / row budgets
// ---------------------------------------------------------------------------

/** Two-column gutter that precedes every body row. */
const INDENT = "  ";

/**
 * Pixel-width budget for the station-header row. It carries only the
 * 2-space section gutter (added by `flattenBlocks`), so it gets the body
 * inner width minus that gutter before the LVGL container hard-wraps.
 */
const STATION_TEXT_WIDTH_PX = SECTION_INNER_WIDTH_PX - textWidth(INDENT);

/**
 * Inner inset (extra indent) applied to per-unit detail rows so they
 * read as detail nested under the station-name header.
 */
const DETAIL_INSET = "  ";

/**
 * Pixel-width budget for a wrapped detail line ("Type · location"). A
 * detail line carries BOTH the section gutter (added by `flattenBlocks`)
 * AND the inner inset (added in `formatStationGroup`), so we wrap at the
 * body inner width minus both — keeping indent + text in the container.
 */
const DETAIL_TEXT_WIDTH_PX =
  SECTION_INNER_WIDTH_PX - textWidth(INDENT) - textWidth(DETAIL_INSET);

/** Pixel budget for the abbreviated station name on the unit-header row
 *  (the "X " glyph cell precedes it). */
const STATION_NAME_BUDGET_PX = STATION_TEXT_WIDTH_PX - textWidth("E ");

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
export function wrap(text: string, maxPx: number): string[] {
  if (!text) return [];
  if (maxPx <= 0) return [];
  const fits = (s: string): boolean => textWidth(s) <= maxPx;
  if (!fits(ELLIPSIS)) return [];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!fits(word)) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      let remaining = word;
      while (!fits(remaining)) {
        let k = remaining.length - 1;
        while (k > 0 && !fits(remaining.slice(0, k) + ELLIPSIS)) k--;
        if (k <= 0) break;
        lines.push(remaining.slice(0, k) + ELLIPSIS);
        remaining = remaining.slice(k);
      }
      if (remaining.length > 0) current = remaining;
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (fits(current + " " + word)) {
      current = current + " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Strip trailing sentence separators (`, ; .`) plus any whitespace from
 * a fragment so a wrapped/truncated tail doesn't read as mid-sentence
 * (e.g. "Street to mezzanine," → "Street to mezzanine"). Only the FINAL
 * emitted line of a fragment should be passed through this — interior
 * lines keep their punctuation.
 */
export function trimTrailingSeparators(text: string): string {
  return text.replace(/[\s,;.]+$/, "");
}

/**
 * Cap wrapped description lines at MAX_DESC_LINES with an ellipsis.
 *
 * When the text fits within the cap, the final line gets its dangling
 * sentence separator trimmed so the location doesn't read as a clipped
 * mid-sentence fragment. When the text is truncated we append `…`
 * instead (the ellipsis already signals "more was cut").
 */
export function capDescription(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  if (lines.length <= MAX_DESC_LINES) {
    const out = lines.slice();
    const lastIdx = out.length - 1;
    const last = out[lastIdx]!;
    if (!last.endsWith(ELLIPSIS)) {
      out[lastIdx] = trimTrailingSeparators(last);
    }
    return out;
  }
  const out = lines.slice(0, MAX_DESC_LINES);
  const last = out[MAX_DESC_LINES - 1] ?? "";
  if (!last.endsWith(ELLIPSIS)) {
    const trimmed = trimTrailingSeparators(last);
    out[MAX_DESC_LINES - 1] =
      textWidth(trimmed + ELLIPSIS) <= DETAIL_TEXT_WIDTH_PX
        ? trimmed + ELLIPSIS
        : truncate(trimmed, DETAIL_TEXT_WIDTH_PX);
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
 * Width contract: ≤ STATION_TEXT_WIDTH (56) chars. The caller prepends
 * the 2-col indent at flatten time so the result is directly usable.
 *
 *   "E Foggy Bottom-GWU"
 *   "S Dupont Circle"
 */
export function renderUnitHeader(incident: ElevatorIncident): string {
  const glyph = unitGlyph(incident.UnitType);
  const station = abbreviateStation(
    stationNameOnly(incident.StationName),
    STATION_NAME_BUDGET_PX,
  );
  return truncate(`${glyph} ${station}`, STATION_TEXT_WIDTH_PX);
}

/**
 * Pre-format one outage into the block of body rows it will occupy:
 *
 *   ["Foggy Bottom-GWU",
 *    "  Elevator · Mezzanine to street, west side"]
 *
 * Format: station header (Title Case, no glyph) on its own line;
 * per-unit detail rows indented 2 chars further, prefixed
 * `<Type> · <Location>` so the unit type and where it is read as
 * one phrase. The bordered ACCESS section above already signals
 * "these are access outages."
 *
 * To group multiple outages at the same station under a single
 * header, use `formatStationGroup` (or rebuild the preformatted
 * list by grouping the source incidents first).
 *
 * The location description is wrapped to DETAIL_TEXT_WIDTH cols so the
 * indented detail lines don't push past SAFE_TEXT_WIDTH once
 * `flattenBlocks` adds its own 2-col gutter and the detail inset is
 * applied.
 */
export function formatIncidentBlock(incident: ElevatorIncident): string[] {
  return formatStationGroup(stationNameOnly(incident.StationName), [incident]);
}

/**
 * Pre-format a group of outages at the SAME station into a single
 * block of body rows:
 *
 *   ["Glenmont",
 *    "  Elevator · Street to mezzanine, west side",
 *    "  Escalator · Street to mezzanine, east"]
 *
 * Multiple-unit outages at the same station collapse under one
 * station header — drier than the per-unit form that repeats the
 * station name once per row.
 */
export function formatStationGroup(
  stationName: string,
  incidents: readonly ElevatorIncident[],
): string[] {
  const out: string[] = [
    truncate(stationName, STATION_TEXT_WIDTH_PX),
  ];
  for (const inc of incidents) {
    const type = inc.UnitType === "ELEVATOR" ? "Elevator" : "Escalator";
    const desc = (inc.LocationDescription ?? "").trim();
    if (desc.length === 0) {
      out.push(DETAIL_INSET + type);
      continue;
    }
    // Wrap the bare "Type · location" content (no leading inset) at
    // DETAIL_TEXT_WIDTH, then prepend a uniform 2-col inset to every
    // wrapped line. With `flattenBlocks`' own 2-col gutter that's a
    // 4-col total indent, so no rendered line exceeds SAFE_TEXT_WIDTH
    // real chars (which would make the container re-wrap and orphan
    // words at column 0). `capDescription` trims any dangling trailing
    // separator off the final fragment line.
    const wrapped = capDescription(
      wrap(`${type} · ${desc}`, DETAIL_TEXT_WIDTH_PX),
    );
    for (const line of wrapped) {
      out.push(DETAIL_INSET + line);
    }
  }
  return out;
}

/**
 * Group incidents by station and emit one block per station group,
 * preserving the original ordering of stations as they appeared in
 * the source array (the WMATA API typically returns outages
 * grouped already, but we don't rely on it).
 */
export function groupIncidentsByStation(
  incidents: readonly ElevatorIncident[],
): string[][] {
  const groups = new Map<string, ElevatorIncident[]>();
  for (const inc of incidents) {
    const station = stationNameOnly(inc.StationName);
    const existing = groups.get(station);
    if (existing) {
      existing.push(inc);
    } else {
      groups.set(station, [inc]);
    }
  }
  return Array.from(groups.entries()).map(([station, incs]) =>
    formatStationGroup(station, incs),
  );
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
 * Render the header row: the section TITLE ONLY, left-aligned.
 *
 *   "ACCESS (n)"   (n > 0)
 *   "ACCESS"       (empty)
 *
 * The host now renders the wall clock + staleness marker in its own
 * dedicated top-right container (identically on every screen), so the
 * header no longer embeds the clock or marker. The marker is surfaced
 * via `view()`'s `clockMarker` field. The title is truncated so it can't
 * collide with the clock container (which starts at column ≈ 50).
 */
export function renderHeader(snapshot: ElevatorSnapshot): string {
  const count = snapshot.incidents.length;
  const left = count > 0 ? `ACCESS (${count})` : "ACCESS";
  return truncate(left, HEADER_CONTENT_WIDTH_PX);
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
    preformatted: groupIncidentsByStation(cache.incidents),
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
    view(snapshot, nav, ctx: ViewContext): ScreenSections {
      const header: string[] = [renderHeader(snapshot)];
      const body: string[] = [];
      // Staleness marker rides in the host's top-right clock container
      // (via `clockMarker`), no longer the header string. `ctx.nowMs`
      // drives the time-based stale check on every 1Hz clock re-render.
      const clockMarker = stalenessMarker(snapshot, ctx.nowMs);

      // Empty-data branches mirror the Incidents screen:
      // first-load fetch error gets distinct copy; otherwise the
      // friendly empty-state.
      if (
        snapshot.incidents.length === 0 &&
        snapshot.fetchedAt === 0 &&
        snapshot.fetchError !== null
      ) {
        body.push(truncate("Couldn't reach WMATA. Will retry shortly.", SECTION_INNER_WIDTH_PX));
        body.push("");
        body.push(truncate("(double-tap to return)", SECTION_INNER_WIDTH_PX));
        return { header, body, clockMarker };
      }

      if (snapshot.incidents.length === 0) {
        body.push(truncate("All access points open at your stations.", SECTION_INNER_WIDTH_PX));
        body.push("");
        body.push(truncate("(double-tap to return)", SECTION_INNER_WIDTH_PX));
        return { header, body, clockMarker };
      }

      const flat = flattenBlocks(snapshot.preformatted);
      const offset = clamp(nav.highlightedIndex, Math.max(0, flat.length - 1));
      const decorated = scrollWindowWithMarkers(flat, offset, TWO_BODY_MAX_LINES);
      for (const r of decorated) body.push(truncate(r, SECTION_INNER_WIDTH_PX));
      return { header, body, clockMarker };
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
          preformatted: groupIncidentsByStation(result.incidents),
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
