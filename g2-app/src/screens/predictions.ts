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

/**
 * Local-clock hour at and past which the "Last train" row is
 * surfaced. WMATA service ends at midnight on most weeknights and
 * 01:00–03:00 on weekend nights, so 21:00 gives a 3-hour heads-up
 * window without cluttering the screen during normal commute hours.
 *
 * Exported so the test suite can pin the threshold rather than
 * reaching into a constant from a `Date.now()` mock.
 */
export const LAST_TRAIN_HOUR = 21;

/**
 * True when the wall clock (in the runtime's local timezone) is at
 * or past `LAST_TRAIN_HOUR` — at which point the last-train row is
 * worth surfacing. Hidden during the morning rush and afternoon.
 */
export function shouldShowLastTrain(nowMs: number): boolean {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return false;
  return new Date(nowMs).getHours() >= LAST_TRAIN_HOUR;
}

/**
 * Pick the latest "HH:mm" string from a list of `StationTrainTime`s.
 * Returns `null` for an empty list.
 *
 * Comparison is lexicographic-on-"HH:mm" because the format is
 * zero-padded — `"08:32" < "23:47"` reads correctly as a string
 * comparison. WMATA's `LastTrains` array may include AM times that
 * actually mean "next day" (per docs), and those will sort EARLIEST
 * by this comparison; we accept that for the v1.2 ship and just
 * surface the latest PM time, which is the user-facing "last train".
 */
export function pickLastTrainTime(
  times: ReadonlyArray<{ Time: string }>,
): string | null {
  let best: string | null = null;
  for (const t of times) {
    if (typeof t.Time !== "string" || t.Time.length === 0) continue;
    // Skip AM times — they're "next day" per the WMATA docs, not
    // "later today". A late-evening user wants the latest PM
    // departure, not tomorrow morning's first AM run that happens
    // to spill into the LastTrains array.
    const hh = parseInt(t.Time.slice(0, 2), 10);
    if (!Number.isFinite(hh)) continue;
    if (hh < 12) continue;
    if (best === null || t.Time > best) best = t.Time;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The fields a `fetcher()` is expected to fill in on every successful refresh. */
export interface PredictionsFetchResult {
  trains: Train[];
  incidentHeadline: string | null;
  /**
   * "HH:mm" of today's last scheduled departure from this station,
   * across all destinations served. `null` when the schedule fetch
   * failed or the station isn't in the schedule data. Driven by the
   * Session's lazy-cached `getStationTimes` so the wire fetch happens
   * at most once per glasses session.
   */
  lastTrainToday: string | null;
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
   * Number of consecutive `tick()` failures since the last successful
   * fetch. Reset to 0 on success. Drives the stale-marker escalation
   * in `renderHeader` so users see a degrading network *before* the
   * data goes blank: `*` after one failure, `**` after two, `?` once
   * we have three in a row (or no successful fetch has ever landed).
   */
  consecutiveFetchFailures: number;
  /**
   * Optional headline for the footer alert row. Sourced from the shared
   * incidents cache in `main.ts`'s predictions fetcher (the first
   * sentence of the freshest incident on a line this station serves).
   * `null` when there are no matching incidents — the footer hides.
   */
  incidentHeadline: string | null;
  /**
   * Last scheduled departure from this station today, `"HH:mm"`. Only
   * rendered after the late-evening cutoff (see
   * `shouldShowLastTrain`); rendered as a `"Last train: 23:47"` row
   * appended to the body. `null` when the schedule lookup hasn't
   * landed or the station isn't in the data.
   */
  lastTrainToday: string | null;
  /**
   * If non-null, the user has TAP-pinned a specific (line,
   * destination) pair to track. The screen renders a single-line
   * summary row at the top of the body, and the matching train (if
   * still visible in the predictions list) is highlighted with a
   * "*" cursor in place of its line-glyph cell.
   *
   * WMATA predictions don't carry a stable `TrainId`, so a pin is
   * identified by (Line + Destination). If multiple trains match
   * (a busy commute window with two RD-Glenmont trains stacked),
   * the FIRST match in the sorted list wins for cursor + summary
   * display.
   *
   * `null` = no pin. Reset on remount (the pin doesn't persist
   * across navigations — the user explicitly chose it for this
   * Predictions session).
   */
  pinned: { line: string; destination: string } | null;
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
 * Map (staleness × fetch-failure-count) onto a 3-state header marker.
 *
 * Semantics (matches the same helper in `incidents.ts`):
 *
 *   - `""`  — fresh data, 0 failures. Clean clock.
 *   - `"*"` — stale by time only OR 1 failure since last success.
 *             The data is plausibly old but the network may just be
 *             slow; the user has data to look at.
 *   - `"**"` — 2 consecutive failures. The network is degrading;
 *              data is from before the failures started.
 *   - `"?"` — ≥ 3 consecutive failures, OR `fetchedAt === 0` with an
 *             active `fetchError` (we've never gotten data at all).
 *
 * Exported so the test suite can pin each branch directly.
 */
export function stalenessMarker(
  snapshot: PredictionsSnapshot,
  nowMs: number,
): "" | "*" | "**" | "?" {
  const failures = Math.max(0, snapshot.consecutiveFetchFailures);
  // Total-failure-with-no-data path: we have nothing to show and a
  // current error. Strongest marker.
  if (snapshot.fetchedAt === 0 && snapshot.fetchError !== null) return "?";
  if (failures >= 3) return "?";
  if (failures === 2) return "**";
  if (failures === 1) return "*";
  // No active failure streak. Fall through to the time-based check
  // (data may simply be older than threshold because the fetch tick
  // hasn't fired yet on a slow connection).
  if (isStale(snapshot, nowMs)) return "*";
  return "";
}

/**
 * Render the header row: `<station name> <HH:MM>[stale-marker]`.
 *
 * When the data is stale or the fetch is degrading we append a 1- or
 * 2-char marker after the clock as a glanceable "this is old" cue
 * (the panel is greyscale, so we can't actually dim). The marker
 * consumes its width from the station-name budget — long names lose
 * one or two characters of breathing room while degraded, which is
 * acceptable.
 *
 * `nowMs` is the host-supplied wall clock (`ViewContext.nowMs`). The
 * header re-renders every second via the host's clock tick so the
 * "HH:MM" string and stale marker stay live regardless of fetch state.
 */
export function renderHeader(
  snapshot: PredictionsSnapshot,
  nowMs: number,
): string {
  const marker = stalenessMarker(snapshot, nowMs);
  const clockStr = formatClock(nowMs);
  const clockCell = clockStr + marker; // 5, 6, or 7 chars
  // Steal one col from the name per marker char so the total never
  // exceeds LINE_WIDTH. `**` shrinks the name budget by 2.
  const nameBudget = Math.max(1, HEADER_NAME_WIDTH - marker.length);
  const name = padRight(
    abbreviateStation(snapshot.stationName, nameBudget),
    nameBudget,
  );
  // name(nameBudget) + " "(1) + clockCell(5..7) = 24 by construction.
  return name + " " + clockCell;
}

/**
 * Render a single body row.
 *
 * Width contract: returns a string of exactly `LINE_WIDTH` columns. The
 * destination cell is left-aligned (`padRight`), the cars and ETA cells
 * are right-aligned-or-padded so the visual rhythm of the column lines up
 * across rows.
 *
 * `marker` is an optional 1-char glyph that replaces the line code's
 * SECOND character (so the line is still readable as just the first
 * letter):
 *   - undefined / "" → no marker; full 2-char line glyph
 *   - "*"            → pinned train (kept across ticks)
 *   - ">"            → cursor highlight (TAP target)
 *
 * Why steal the second glyph char and not pad somewhere else: the
 * existing 24-col layout has no slack. The first letter of the line
 * code is enough signal once the user knows they're on Red / Orange
 * / Blue — and the marker is more informative than the second
 * letter at the moment they need it (pinning / selecting a row).
 */
export function renderTrainRow(
  train: Train,
  marker: "" | "*" | ">" = "",
): string {
  const fullGlyph = lineGlyph(train.Line);
  const glyph =
    marker === ""
      ? padRight(fullGlyph, GLYPH_WIDTH)
      : fullGlyph.charAt(0) + marker;
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
 * Find the index of the first visible train whose (line, destination)
 * matches the pin. Returns -1 when nothing matches. The destination
 * field on a `Train` is the short form (e.g. "Vienna"); the pin
 * captures it verbatim at TAP time so equality works directly.
 */
export function findPinnedTrainIndex(
  trains: readonly Train[],
  pin: { line: string; destination: string } | null,
): number {
  if (!pin) return -1;
  for (let i = 0; i < trains.length; i++) {
    const t = trains[i]!;
    if (t.Line === pin.line && t.Destination === pin.destination) return i;
  }
  return -1;
}

/**
 * Build the optional "pin summary" row that sits between the header
 * and the train list. Returns `null` when no train is pinned, or
 * when the pinned train is no longer visible in the predictions
 * (e.g. it already departed). Width contract: ≤ LINE_WIDTH.
 *
 *   "* RD Glenmont   3 min"
 *
 * Layout: marker(1) + " "(1) + line(2) + " "(1) + dest(11) + " "(1) +
 *         eta(6) = 23. Pad one trailing space to LINE_WIDTH.
 */
export function renderPinRow(
  snapshot: PredictionsSnapshot,
  visibleTrains: readonly Train[],
): string | null {
  if (!snapshot.pinned) return null;
  const idx = findPinnedTrainIndex(visibleTrains, snapshot.pinned);
  if (idx < 0) return null;
  const t = visibleTrains[idx]!;
  const line = padRight(lineGlyph(t.Line), GLYPH_WIDTH);
  const dest = padRight(
    abbreviateStation(t.Destination || t.DestinationName, DEST_WIDTH),
    DEST_WIDTH,
  );
  const eta = padLeft(formatEta(t.Min), ETA_WIDTH);
  // "*"(1) + " "(1) + line(2) + " "(1) + dest(11) + " "(1) + eta(6) = 23
  const composed = "* " + line + " " + dest + " " + eta;
  return padRight(composed, LINE_WIDTH);
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
 * Render the optional late-night last-train row. Returns `null` when
 * the wall clock is before `LAST_TRAIN_HOUR` OR the schedule data
 * isn't available — in either case the row is hidden.
 *
 *   "Last train: 23:47"  (always ≤ 24 cols)
 */
export function renderLastTrainRow(
  snapshot: PredictionsSnapshot,
  nowMs: number,
): string | null {
  if (!shouldShowLastTrain(nowMs)) return null;
  const time = snapshot.lastTrainToday;
  if (!time || time.length === 0) return null;
  return truncate(`Last train: ${time}`, LINE_WIDTH);
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
    view(snapshot, nav, ctx: ViewContext): string[] {
      const lines: string[] = [];
      // `ctx.nowMs` is freshly stamped by the host on EVERY render —
      // including the 1Hz clock-only re-renders that fire independently
      // of any fetch tick. That's what keeps the HUD clock and the
      // stale-marker advancing even when the network has stalled.
      lines.push(renderHeader(snapshot, ctx.nowMs));

      const sorted = sortTrainsForDisplay(snapshot.trains);
      const visible = sorted.slice(0, MAX_VISIBLE_TRAINS);

      // Pin summary row sits directly under the header when an active
      // pin matches a visible train. Renders nothing otherwise (e.g.
      // before the user has pinned anything, or after the pinned
      // train has rolled out of the predictions window).
      const pinRow = renderPinRow(snapshot, visible);
      if (pinRow !== null) lines.push(pinRow);

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
        // Cursor: `nav.highlightedIndex` is clamped to the visible
        // range. The pinned train (if any) is marked with "*"; the
        // cursor target (which may or may not be the pinned train)
        // is marked with ">". When both coincide on the same row,
        // the pin marker wins — the user has confirmed this is
        // their tracked train, no need to also surface the cursor.
        const pinnedIdx = findPinnedTrainIndex(visible, snapshot.pinned);
        const cursorIdx = Math.max(
          0,
          Math.min(nav.highlightedIndex, visible.length - 1),
        );
        for (let i = 0; i < visible.length; i++) {
          const t = visible[i]!;
          const marker: "" | "*" | ">" =
            i === pinnedIdx ? "*" : i === cursorIdx ? ">" : "";
          lines.push(renderTrainRow(t, marker));
        }
      }

      const footer = renderFooter(snapshot);
      if (footer !== null) lines.push(footer);

      // Late-night last-train row. Independent of the footer — both
      // can be present simultaneously (e.g. midnight on a single-
      // tracking day). Hidden outside the late-night window OR when
      // the schedule fetch hasn't completed; in either case the
      // existing line count stays unchanged.
      const lastTrain = renderLastTrainRow(snapshot, ctx.nowMs);
      if (lastTrain !== null) lines.push(lastTrain);
      return lines;
    },
    reduce(snapshot, nav, event: ScreenEvent): ReduceResult<PredictionsSnapshot> {
      // Predictions added a cursor + pin model in v1.2. The cursor
      // selects a row in the visible-trains slice; TAP toggles a pin
      // on the cursor's target. DOUBLE_TAP still navigates Home.
      //
      // The voice-flow event variants (TRANSCRIPT, RESOLVE_RESULT,
      // etc.) are dispatched only by the Voice screen's `onMount`
      // glue; they arrive at this reducer only via a programming
      // error. The default branch absorbs them as a no-op so the
      // contract stays total.
      const visible = sortTrainsForDisplay(snapshot.trains).slice(
        0,
        MAX_VISIBLE_TRAINS,
      );
      const maxIdx = Math.max(0, visible.length - 1);
      const cursorIdx = Math.max(0, Math.min(nav.highlightedIndex, maxIdx));
      switch (event.type) {
        case "SCROLL_UP":
          if (visible.length === 0) return { nav };
          return {
            nav: { highlightedIndex: Math.max(0, cursorIdx - 1) },
          };
        case "SCROLL_DOWN":
          if (visible.length === 0) return { nav };
          return {
            nav: { highlightedIndex: Math.min(maxIdx, cursorIdx + 1) },
          };
        case "TAP": {
          if (visible.length === 0) return { nav };
          const t = visible[cursorIdx]!;
          const candidate = { line: t.Line, destination: t.Destination };
          // TAP on the already-pinned train toggles the pin off.
          const isAlreadyPinned =
            snapshot.pinned !== null &&
            snapshot.pinned.line === candidate.line &&
            snapshot.pinned.destination === candidate.destination;
          return {
            nav,
            snapshot: {
              ...snapshot,
              pinned: isAlreadyPinned ? null : candidate,
            },
          };
        }
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
     *
     * Tracks `consecutiveFetchFailures` so the header marker can
     * escalate `*` → `**` → `?` as the network degrades. Reset to 0
     * on every successful fetch.
     */
    async tick(snapshot: PredictionsSnapshot): Promise<PredictionsSnapshot> {
      const now = Date.now();
      try {
        const result = await fetcher();
        return {
          ...snapshot,
          trains: result.trains,
          incidentHeadline: result.incidentHeadline,
          // Carry the last-train field forward when the fetcher
          // provides one; preserve the prior value when null so the
          // user doesn't see the row blink off if the fetcher only
          // populates it on the first call.
          lastTrainToday: result.lastTrainToday ?? snapshot.lastTrainToday,
          fetchedAt: now,
          fetchError: null,
          consecutiveFetchFailures: 0,
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
