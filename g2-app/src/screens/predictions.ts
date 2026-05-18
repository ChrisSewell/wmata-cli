// Predictions screen — the main glanceable view of the app.
//
// User journey: tap a favorite on Home → land here → within 1-2s see when
// the next train arrives at that station. The screen auto-refreshes on a
// 20-second cadence; stale or errored data degrades visibly (a `*` after
// the clock, an optional footer note) rather than blanking the HUD.
//
// Layout (24 cols × up to 7 usable rows):
//
//   col:   0         1         2
//   col:   0123456789012345678901234
//          Metro Center      14:32
//          RD Shady Grv   6c    ARR
//          RD Glenmont    8c   3 min
//          OR Vienna      6c   5 min
//          SV Wiehle      8c   7 min
//          BL Franc-Spr   6c   9 min
//          ! Single-tracking RD
//
// Empty state (0 trains):
//
//          Metro Center      14:32
//          No trains predicted.
//          (double-tap to exit)
//
// Body row column budget (no list-selection prefix here):
//   - 2 cols   line glyph (`lineGlyph(line)`)
//   - 1 col    space
//   - 11 cols  abbreviated destination
//   - 1 col    space
//   - 2 cols   cars (`{n}c`)
//   - 1 col    space
//   - 6 cols   ETA, right-aligned (fits "12 min" exactly)
//   - total = 24 cols
//
// Why a 6-col ETA cell (not 5 with a trimmed "12m"): keeping the canonical
// `formatEta` output ("12 min") matches the rest of the app and the user's
// mental model of WMATA timetables. The cost is shrinking the destination
// from 12 to 11 cols, which is still wide enough for every entry in
// `STATION_ABBREVIATIONS` (longest map value is "Tenleytown" at 10 chars).
//
// Header row (24 cols):
//   - 18 cols  abbreviated station name
//   - 1 col    space
//   - 5 cols   "HH:MM" wall clock (+ optional `*` stale marker that
//              consumes one column from the name budget when present).
//
// PURITY: This module has no SDK imports and does no I/O of its own. The
// `fetcher` is injected and the wall clock arrives via `view(...)`'s
// third `ctx: ViewContext` parameter (NEVER from the snapshot), so
// `view()` and `reduce()` are fully deterministic and trivially
// Vitest-friendly. The host (`glasses-host.ts`) owns the `setInterval`s
// (a fetch tick AND an independent 1Hz clock tick) and is the only
// file that touches `Date.now()`.

import type { Train } from "../wmata";
import { LINE_WIDTH, padLeft, padRight, truncate } from "../ui/render";
import { abbreviateStation, formatEta, lineGlyph } from "../ui/format";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";

// ---------------------------------------------------------------------------
// Column budget constants
// ---------------------------------------------------------------------------

/** Width of the line-glyph cell on a body row. */
const GLYPH_WIDTH = 2;
/** Width of the destination cell on a body row. */
const DEST_WIDTH = 11;
/** Width of the cars cell ("6c" / "8c"). */
const CARS_WIDTH = 2;
/** Width of the ETA cell — sized to fit "12 min". */
const ETA_WIDTH = 6;
/** Width of the station-name cell in the header. */
const HEADER_NAME_WIDTH = 18;
// Clock cell is fixed at 5 cols ("HH:MM") plus an optional 1-col stale
// marker; no constant needed because we never reference the width
// outside `renderHeader` where the cell composition is open-coded for
// readability.

/** Maximum number of predictions rendered as body rows. */
export const MAX_VISIBLE_TRAINS = 5;

/** Wall-clock age (ms) after which a snapshot is considered stale. */
export const STALE_THRESHOLD_MS = 60_000;

/** Auto-refresh cadence handed back to the host via `tickIntervalMs`. */
export const TICK_INTERVAL_MS = 20_000;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The fields a `fetcher()` is expected to fill in on every successful refresh. */
export interface PredictionsFetchResult {
  trains: Train[];
  incidentHeadline: string | null;
}

/** Data the Predictions screen renders against. */
export interface PredictionsSnapshot {
  /** WMATA station code (e.g. `"A01"`). */
  stationCode: string;
  /** Canonical station name (e.g. `"Metro Center"`). */
  stationName: string;
  /** Next-train predictions, freshest at the head. */
  trains: Train[];
  /** epoch ms when `trains` was last successfully fetched; 0 means never. */
  fetchedAt: number;
  /** Last fetch error string, or `null` if the most recent fetch succeeded. */
  fetchError: string | null;
  /**
   * Optional headline for the footer alert row. Sourced from the shared
   * incidents cache in `main.ts`'s predictions fetcher (the first
   * sentence of the freshest incident on a line this station serves).
   * `null` when there are no matching incidents — the footer hides.
   */
  incidentHeadline: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * Format an epoch-ms timestamp as a 24-hour "HH:MM" string in the runtime's
 * local timezone. We deliberately render via `Date` slot getters rather than
 * `toLocaleTimeString` so the output is identical across browsers / Node /
 * the on-glasses runtime regardless of locale settings.
 */
export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "--:--";
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * True if either the last fetch errored OR the last successful fetch is
 * older than `STALE_THRESHOLD_MS`. A snapshot that has never fetched
 * (`fetchedAt === 0`) is also considered stale — there's nothing to show.
 *
 * The wall clock comes from `nowMs` (the host's `ViewContext`), NOT from
 * the snapshot — this is what makes the stale-marker tick forward even
 * when a fetch is hung.
 */
export function isStale(snapshot: PredictionsSnapshot, nowMs: number): boolean {
  if (snapshot.fetchError !== null) return true;
  if (snapshot.fetchedAt <= 0) return true;
  return nowMs - snapshot.fetchedAt > STALE_THRESHOLD_MS;
}

/**
 * Render the header row: `<station name> <HH:MM>[stale-marker]`.
 *
 * When the data is stale we append a `*` after the clock as a glanceable
 * "this is old" cue (the panel is greyscale, so we can't actually dim).
 * The `*` consumes one column from the station-name budget — long names
 * lose one character of breathing room when stale, which is acceptable.
 *
 * `nowMs` is the host-supplied wall clock (`ViewContext.nowMs`). The
 * header re-renders every second via the host's clock tick so the
 * "HH:MM" string and stale marker stay live regardless of fetch state.
 */
export function renderHeader(
  snapshot: PredictionsSnapshot,
  nowMs: number,
): string {
  const stale = isStale(snapshot, nowMs);
  const clockStr = formatClock(nowMs);
  // Stale + a real fetch error get a distinct marker (`?` vs `*`) so the
  // user can tell "old data" from "no data".
  const marker = !stale ? "" : snapshot.fetchError !== null ? "?" : "*";
  const clockCell = clockStr + marker; // 5 or 6 chars
  // Steal one col from the name when the marker is present, so the total
  // never exceeds LINE_WIDTH.
  const nameBudget = HEADER_NAME_WIDTH - marker.length;
  const name = padRight(
    abbreviateStation(snapshot.stationName, nameBudget),
    nameBudget,
  );
  // name(nameBudget) + " "(1) + clockCell(5 or 6) = 18 or 19 chars; with
  // marker the name shrinks by 1 so the total stays at 24.
  return name + " " + clockCell;
}

/**
 * Render a single body row.
 *
 * Width contract: returns a string of exactly `LINE_WIDTH` columns. The
 * destination cell is left-aligned (`padRight`), the cars and ETA cells
 * are right-aligned-or-padded so the visual rhythm of the column lines up
 * across rows.
 */
export function renderTrainRow(train: Train): string {
  const glyph = padRight(lineGlyph(train.Line), GLYPH_WIDTH);
  const dest = padRight(
    abbreviateStation(train.Destination || train.DestinationName, DEST_WIDTH),
    DEST_WIDTH,
  );
  // Cars: "6c" / "8c". WMATA occasionally returns "" for non-revenue or
  // unknown consist length; render that as "  " (two spaces) so the
  // column doesn't collapse.
  const carsRaw = train.Car && train.Car.trim().length > 0 ? `${train.Car}c` : "";
  const cars = padLeft(carsRaw, CARS_WIDTH);
  const eta = padLeft(formatEta(train.Min), ETA_WIDTH);
  // glyph(2) + " "(1) + dest(11) + " "(1) + cars(2) + " "(1) + eta(6) = 24
  return glyph + " " + dest + " " + cars + " " + eta;
}

/**
 * Render the optional footer alert row. Returns `null` when there's no
 * incident headline AND no fetch error to surface; otherwise a single
 * truncated `"! <headline>"` (or `"? <error>"`) string.
 */
export function renderFooter(snapshot: PredictionsSnapshot): string | null {
  if (snapshot.incidentHeadline && snapshot.incidentHeadline.trim().length > 0) {
    return truncate("! " + snapshot.incidentHeadline.trim(), LINE_WIDTH);
  }
  if (snapshot.fetchError !== null && snapshot.fetchedAt === 0) {
    // Only surface fetch errors in the footer when we have NO data at all
    // — otherwise the stale `?` marker on the clock is sufficient and the
    // footer should stay reserved for genuine incidents.
    return truncate("? " + snapshot.fetchError, LINE_WIDTH);
  }
  return null;
}

/**
 * Sort + cap the train list for display. We sort by ETA ascending, with
 * BRD ahead of ARR ahead of any numeric, and unknown sentinels (`""`,
 * `"---"`) at the tail.
 */
export function sortTrainsForDisplay(trains: readonly Train[]): Train[] {
  const rank = (min: string): number => {
    if (min === "BRD") return -2;
    if (min === "ARR") return -1;
    if (/^\d+$/.test(min)) return Number.parseInt(min, 10);
    // Empty / "---" / junk -> end of the list.
    return Number.MAX_SAFE_INTEGER;
  };
  return [...trains].sort((a, b) => rank(a.Min) - rank(b.Min));
}

// ---------------------------------------------------------------------------
// Screen impl
// ---------------------------------------------------------------------------

/**
 * Build the Predictions screen.
 *
 * `fetcher` is injected so the screen stays pure-testable (no `fetch`,
 * no `WmataClient`, no `setInterval`). The host calls `tick` on mount
 * and on the `tickIntervalMs` cadence; `tick` invokes `fetcher` and
 * folds the result (or error) into a new snapshot, then the host
 * re-renders.
 */
export function makePredictionsScreen(
  fetcher: () => Promise<PredictionsFetchResult>,
  initialSnapshot: PredictionsSnapshot,
): Screen<PredictionsSnapshot> & {
  tick: (snapshot: PredictionsSnapshot) => Promise<PredictionsSnapshot>;
  tickIntervalMs: number;
} {
  return {
    name: "predictions",
    init: () => initialSnapshot,
    view(snapshot, _nav, ctx: ViewContext): string[] {
      const lines: string[] = [];
      // `ctx.nowMs` is freshly stamped by the host on EVERY render —
      // including the 1Hz clock-only re-renders that fire independently
      // of any fetch tick. That's what keeps the HUD clock and the
      // stale-marker advancing even when the network has stalled.
      lines.push(renderHeader(snapshot, ctx.nowMs));

      const sorted = sortTrainsForDisplay(snapshot.trains);
      const visible = sorted.slice(0, MAX_VISIBLE_TRAINS);

      if (visible.length === 0) {
        // Empty state — distinct copy depending on whether we have data
        // at all. If there's no data yet AND we've never fetched, show a
        // "Loading…" cue; otherwise show "No trains predicted".
        if (snapshot.fetchedAt === 0 && snapshot.fetchError === null) {
          lines.push(truncate("Loading…", LINE_WIDTH));
        } else {
          lines.push(truncate("No trains predicted.", LINE_WIDTH));
        }
        lines.push("");
        lines.push(truncate("(double-tap to exit)", LINE_WIDTH));
      } else {
        for (const t of visible) {
          lines.push(renderTrainRow(t));
        }
      }

      const footer = renderFooter(snapshot);
      if (footer !== null) lines.push(footer);
      return lines;
    },
    reduce(_snapshot, nav, event: ScreenEvent): ReduceResult<PredictionsSnapshot> {
      // Predictions is a glanceable screen: SCROLL_UP/DOWN and TAP have
      // no meaning here. DOUBLE_TAP navigates BACK to Home (not "exit")
      // — that's the new behaviour for non-root screens.
      //
      // The voice-flow event variants (TRANSCRIPT, RESOLVE_RESULT, etc.)
      // are dispatched only by the Voice screen's `onMount` glue; they
      // arrive at this reducer only via a programming error. The default
      // branch absorbs them as a no-op so the contract stays total.
      switch (event.type) {
        case "SCROLL_UP":
        case "SCROLL_DOWN":
        case "TAP":
          return { nav };
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "home" } };
        default:
          return { nav };
      }
    },
    /**
     * Fetch fresh predictions and fold the result into a new snapshot.
     *
     * Never throws — fetch errors land in `fetchError`. The wall clock
     * is NOT stored on the snapshot: the host injects it via
     * `ViewContext.nowMs` on every render (including the independent
     * 1Hz clock tick), so the staleness check re-evaluates correctly
     * regardless of fetch cadence.
     */
    async tick(snapshot: PredictionsSnapshot): Promise<PredictionsSnapshot> {
      const now = Date.now();
      try {
        const result = await fetcher();
        return {
          ...snapshot,
          trains: result.trains,
          incidentHeadline: result.incidentHeadline,
          fetchedAt: now,
          fetchError: null,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        return {
          ...snapshot,
          fetchError: message,
        };
      }
    },
    tickIntervalMs: TICK_INTERVAL_MS,
  };
}
