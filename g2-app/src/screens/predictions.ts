// Predictions screen — the main glanceable view of the app.
//
// User journey: tap a favorite on Home → land here → within 1-2s see when
// the next train arrives at that station. The screen auto-refreshes on a
// 20-second cadence; stale or errored data degrades visibly (a `*` after
// the clock, an optional footer note) rather than blanking the HUD.
//
// Layout (TRUE two-column body — see `ScreenSections.bodyColumns`):
//
//          Metro Center                              14:32
//          RED    Shady Grv                       6c    ARR
//          RED    Glenmont                        8c   3 min
//          ORANGE Vienna                          6c   5 min
//          SILVER Wiehle                          8c   7 min
//          BLUE   Franc-Spr                       6c   9 min
//          Single-tracking RD
//
// Empty state (0 trains):
//
//          Metro Center                              14:32
//          No trains predicted.
//          (double-tap to exit)
//
// Body two-column model (`bodyColumns = { left, right }`):
//   - LEFT  : the 2-char body inset + the 6-wide line-name glyph cell
//             (with cursor/pin marker behaviour) + the Title-Case
//             destination, LEFT-ALIGNED and NOT padded to a fixed cell.
//             Because the G2 font is variable-width, padding a value
//             column with spaces never aligns; instead the host renders
//             LEFT in the full-width body container.
//   - RIGHT : the cars+ETA value, e.g. "6c   ARR" / "8c  3 min" — a
//             short (≤ ~10-char) string the host overlays in a
//             borderless container at a FIXED pixel x (≈466). Every
//             right line therefore starts at the same x: a genuinely
//             pixel-aligned value column regardless of the destination's
//             glyph width. Rows with no value (last-train prose, the
//             empty/loading cues, blank separators) carry right = "".
//
// Header row (40 cols):
//   - 34 cols  station name (fits "Foggy Bottom-GWU" in full)
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

import type { StandardRoute, Train } from "../wmata";
import {
  ELLIPSIS,
  LINE_WIDTH,
  SAFE_TEXT_WIDTH,
  padLeft,
  padRight,
  truncate,
  wrapText,
} from "../ui/render";
import {
  abbreviateStation,
  formatEta,
  lineGlyph,
  lineName,
  toTitleCase,
} from "../ui/format";
import {
  buildLineStations,
  findNearestStationToCircuit,
  renderLineSchematic,
  stationsBetween,
} from "../ui/schematic";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ScreenSections,
  ViewContext,
} from "./router";

// The canonical HUD clock formatter now lives in `../ui/format` (the host
// renders it in its own dedicated top-right container). Re-export it here
// so existing `import { formatClock } from "./predictions"` call sites
// (notably the test suite) keep resolving.
export { formatClock } from "../ui/format";

// ---------------------------------------------------------------------------
// Column budget constants
// ---------------------------------------------------------------------------

/** Width of the line-name cell on a body row. Sized for the widest
 *  spelled-out WMATA line name ("YELLOW" / "ORANGE" / "SILVER" = 6). */
const GLYPH_WIDTH = 6;
/** Upper bound (in chars) for a destination on a LEFT body cell. The
 *  destination is left-aligned and NOT padded in the two-column body —
 *  this only bounds `abbreviateStation` so an over-long name can't push
 *  the left column past its safe width. The value column is a separate,
 *  pixel-aligned overlay (`RIGHT`), so the destination no longer needs a
 *  fixed-width cell to align the ETA.
 *
 *  Sized at 41 so the left cell — inset(2) + glyph(6) + " "(1) + dest —
 *  tops out at 50 chars (the value overlay sits at x≈466 ≈ col 50). 41
 *  is also wide enough to render even the longest real WMATA
 *  destinations in full ("Ronald Reagan Washington National Airport" =
 *  41, "Mt Vernon Sq 7th St-Convention Center" = 37) without falling
 *  back to a hand-tuned abbreviation. */
const DEST_WIDTH = 41;
/** Width of the cars cell ("6c" / "8c"). */
const CARS_WIDTH = 2;
/** Width of the ETA cell — sized to fit "12 min". */
const ETA_WIDTH = 6;

/**
 * One body row, split into its two pixel-aligned columns:
 *   - `left`  goes in the full-width body container (line glyph cell +
 *             destination / prose / cue).
 *   - `right` is the value the host overlays at a FIXED x (the cars+ETA
 *             cell, or a bare ETA). "" for rows with no value.
 *
 * `flattenSections` (router.ts) zips a row back to a flat string via
 * `padRight(left, FLAT_LEFT_COLS) + right`, so the right string must
 * stay short (≤ ~10 chars — the overlay is ~110px ≈ 11 chars).
 */
export interface BodyRow {
  left: string;
  right: string;
}

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
 * Parse a WMATA time string into a normalised 24-hour "HH:MM" string
 * suitable for lexicographic comparison.
 *
 * WMATA's LastTrains API mixes two formats in the same response:
 *   "22:15"  — 24-hour, no suffix  (plain PM departure)
 *   "11:47p" — 12-hour with "p" PM suffix  (= 23:47 in 24h)
 *   "01:30"  — 24-hour, no suffix, h < 12  (next-day AM train, skip)
 *
 * Returns `null` for empty, malformed, or unparseable input.
 */
function normalizeTo24h(time: string): string | null {
  if (typeof time !== "string" || time.length === 0) return null;
  const isPm = time.endsWith("p");
  const isAm = time.endsWith("a");
  const base = isPm || isAm ? time.slice(0, -1) : time;
  const colon = base.indexOf(":");
  if (colon < 0) return null;
  const hh = parseInt(base.slice(0, colon), 10);
  const mm = parseInt(base.slice(colon + 1), 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  let h24: number;
  if (isPm) {
    // 12-hour PM: 12p stays 12; 1p..11p map to 13..23.
    h24 = hh === 12 ? 12 : hh + 12;
  } else if (isAm) {
    // 12-hour AM: 12a = 0; 1a..11a = 1..11.
    h24 = hh === 12 ? 0 : hh;
  } else {
    // 24-hour format.
    h24 = hh;
  }
  return String(h24).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

/**
 * Pick the time string (in its original form) representing the latest
 * PM departure from a list of `StationTrainTime`s. Returns `null` for
 * an empty list or one where every entry is AM / malformed.
 *
 * Handles both WMATA 24-hour ("22:15") and 12-hour-suffixed ("11:47p")
 * formats. AM entries (next-day per WMATA docs) are skipped — the
 * user-facing "last train" is the latest PM departure.
 */
export function pickLastTrainTime(
  times: ReadonlyArray<{ Time: string }>,
): string | null {
  let best: string | null = null;
  let bestNorm: string | null = null;
  for (const t of times) {
    const norm = normalizeTo24h(t.Time);
    if (norm === null) continue;
    const hh = parseInt(norm.slice(0, 2), 10);
    if (hh < 12) continue; // AM = next-day train, skip
    if (bestNorm === null || norm > bestNorm) {
      best = t.Time;
      bestNorm = norm;
    }
  }
  return best;
}

/**
 * Bucket a list of `LastTrains[]` entries by their destination's
 * primary line, then pick the latest PM time per bucket. The
 * `destToLine` map resolves `LastTrains[].DestinationStation` (a
 * station code) to the served-line that destination belongs to —
 * usually `LineCode1`, walked-through-1..4 for multi-line termini.
 *
 * Returns one entry per line that has at least one PM departure
 * for this station, sorted by 24-hour time ascending so the
 * earliest-out line surfaces first in the render.
 *
 * Handles both WMATA 24-hour ("22:15") and 12-hour-suffixed ("11:47p")
 * formats. The stored `time` field preserves the original string.
 *
 * Used by `main.ts:readLastTrainToday` (WP-J).
 */
export function bucketLastTrainsByLine(
  lastTrains: ReadonlyArray<{ Time: string; DestinationStation: string }>,
  destToLine: ReadonlyMap<string, string>,
): LastTrainByLine[] {
  // Track both the original string and its normalised 24h form per line.
  const byLine = new Map<string, { time: string; norm: string }>();
  for (const t of lastTrains) {
    const norm = normalizeTo24h(t.Time);
    if (norm === null) continue;
    const hh = parseInt(norm.slice(0, 2), 10);
    if (hh < 12) continue; // AM = next-day train, skip
    const line = destToLine.get(t.DestinationStation);
    if (!line) continue;
    const existing = byLine.get(line);
    if (!existing || norm > existing.norm) byLine.set(line, { time: t.Time, norm });
  }
  const out: LastTrainByLine[] = [];
  for (const [line, { time }] of byLine) out.push({ line, time });
  // Sort by normalised 24h time ascending — earliest-departing first.
  out.sort((a, b) => {
    const na = normalizeTo24h(a.time) ?? "";
    const nb = normalizeTo24h(b.time) ?? "";
    return na.localeCompare(nb);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The fields a `fetcher()` is expected to fill in on every successful refresh. */
export interface PredictionsFetchResult {
  trains: Train[];
  incidentHeadline: string | null;
  /**
   * Per-line last-train summary for tonight. Each entry is the
   * latest PM departure on that line from this station. Empty
   * array means "no schedule data tonight" (e.g. schedule fetch
   * failed); `null` means "fetcher hasn't populated this yet".
   *
   * WP-J: this replaces v1.2's single-time form. Per-line gives
   * commuters the right "which line is gone first" signal at a
   * glance.
   */
  lastTrainToday: LastTrainByLine[] | null;
  /**
   * Resolved live-position data for the pinned train (WP-I). Only
   * populated when:
   *   1. The user has a pin (`snapshot.pinned !== null`)
   *   2. TrainPositions has a matching train (same Line +
   *      DestinationStationCode)
   *   3. StandardRoutes has resolved (lazy session cache)
   *
   * Otherwise `null` — the schematic + "N stops away" affordance
   * hides.
   */
  pinnedPosition: PinnedPosition | null;
}

/** Resolved position info for the pinned train. */
export interface PinnedPosition {
  /** Schematic row, exactly LINE_WIDTH cols. Renders below the pin. */
  schematic: string;
  /** "<N> stops away" / "at this station" / "approaching" label. */
  label: string;
}

/** Per-line last-train time. `line` is a `LineCode`; `time` is "HH:mm". */
export interface LastTrainByLine {
  line: string;
  time: string;
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
   * Per-line last-train summary for tonight. Only rendered after
   * the late-evening cutoff (see `shouldShowLastTrain`). `null`
   * means "schedule fetch hasn't landed yet"; an empty array means
   * "loaded but no data for tonight"; a populated array surfaces
   * one cell per line. Sourced from `main.ts:readLastTrainToday`,
   * which buckets `LastTrains[]` by destination → line.
   */
  lastTrainToday: LastTrainByLine[] | null;
  /**
   * If non-null, the user has TAP-pinned a specific (line,
   * destination) pair to track. The screen renders a single-line
   * summary row at the top of the body, and the matching train (if
   * still visible in the predictions list) is highlighted with a
   * "*" cursor in place of its line-glyph cell.
   *
   * WMATA predictions don't carry a stable `TrainId`, so a pin is
   * identified by (Line + Destination). The optional
   * `destinationCode` (from `Train.DestinationCode` at pin time)
   * lets WP-I match against `/TrainPositions/TrainPositions` —
   * which only carries the station code, not the short name.
   *
   * `null` = no pin. Reset on remount (the pin doesn't persist
   * across navigations — the user explicitly chose it for this
   * Predictions session).
   */
  pinned: {
    line: string;
    destination: string;
    destinationCode?: string | null;
  } | null;
  /**
   * Live position of the pinned train, resolved via
   * `/TrainPositions/TrainPositions` + `/StandardRoutes` (WP-I).
   * `null` when no pin, no match, or StandardRoutes hasn't
   * resolved yet.
   */
  pinnedPosition: PinnedPosition | null;
  /**
   * True iff the user has explicitly scrolled (or pinned) on this
   * screen mount. The Predictions cursor is hidden by default
   * (WP-M opt-in cursor) so the at-rest render stays glanceable;
   * the first SCROLL or pin makes it visible.
   */
  cursorVisible: boolean;
  /**
   * True for one render after the pinned train rolled off the
   * predictions list. Renders `* RD Glnmt (gone)` and clears the
   * pin on the NEXT tick. Avoids silently dropping the pin —
   * the user gets visual confirmation that their tracked train
   * departed.
   */
  pinnedGone: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

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
 * Render the header row: the station TITLE ONLY, left-aligned.
 *
 * The host now renders the wall clock (and the staleness marker — see
 * `clockMarker` on `ScreenSections`) in its own dedicated top-right
 * container, identically on every screen. So the header no longer embeds
 * the clock or the marker; it's just the station name, truncated so it
 * can't collide with the clock container (which starts at x≈486px ≈
 * column 50). The staleness marker is surfaced via `view()`'s
 * `clockMarker` field instead.
 */
export function renderHeader(snapshot: PredictionsSnapshot): string {
  return truncate(abbreviateStation(toTitleCase(snapshot.stationName), 50), 50);
}

/**
 * Render a single train body row as its two pixel-aligned columns.
 *
 *   left  = "  " + <glyph cell> + " " + <Title-Case destination>
 *   right = <cars> + " " + <right-aligned ETA>     e.g. "6c   ARR"
 *
 * The destination is left-aligned and NOT padded to a fixed cell: the
 * value column is the host's borderless RIGHT overlay at a fixed pixel x,
 * so the ETA aligns regardless of how wide the destination's glyphs are.
 * That removes the variable-width misalignment a space-padded cell had.
 *
 * `marker` is an optional 1-char glyph that replaces the line cell's
 * LAST character (so the line is still readable from its first letters)
 * — this stays in the LEFT cell exactly as before:
 *   - undefined / "" → no marker; full line-name glyph cell
 *   - "*"            → pinned train (kept across ticks)
 *   - ">"            → cursor highlight (TAP target)
 *
 * Why steal the last glyph char and not pad somewhere else: the marker
 * is more informative than a trailing line-name letter at the moment the
 * user needs it (pinning / selecting a row), and keeping it in the line
 * cell preserves the v1.2 pin-a-train convention.
 */
export function renderTrainRow(
  train: Train,
  marker: "" | "*" | ">" = "",
): BodyRow {
  // Spelled-out line name ("RED" / "BLUE" / "YELLOW" …); the 2-char
  // `lineGlyph` fallback ("--") covers unknown / blank codes.
  const code = lineGlyph(train.Line);
  const fullName = code === "--" ? "--" : lineName(code);
  // When a marker is present, replace the LAST char of the line cell
  // with the marker glyph so the cursor still reads as part of the
  // line column (matching the v1.2 pin-a-train convention) but the
  // line name is otherwise readable in full.
  const padded = padRight(fullName, GLYPH_WIDTH);
  const glyph =
    marker === ""
      ? padded
      : padded.slice(0, GLYPH_WIDTH - 1) + marker;
  // `Destination` is WMATA's primary field; some rows have a tighter
  // 8-char code in `Destination` plus a full name in `DestinationName`.
  // Keep the existing `Destination || DestinationName` preference
  // (verified by the dedicated fallback test suite) and title-case
  // the result at render time so all-caps API strings ("SHADY GROVE")
  // come out reading as "Shady Grove". Left-aligned, NOT padded — the
  // ETA lives in the right overlay column.
  const destSource = toTitleCase(train.Destination || train.DestinationName);
  const dest = abbreviateStation(destSource, DEST_WIDTH);
  // Cars: "6c" / "8c". WMATA occasionally returns "" for non-revenue or
  // unknown consist length; render that as "  " (two spaces) so the
  // column doesn't collapse.
  const carsRaw = train.Car && train.Car.trim().length > 0 ? `${train.Car}c` : "";
  const cars = padLeft(carsRaw, CARS_WIDTH);
  const eta = padLeft(formatEta(train.Min), ETA_WIDTH);
  // LEFT: 2-char "  " indent so the row reads as content INSIDE the body
  // container, not flush to the border. RIGHT: cars + a space + the
  // right-aligned ETA — 2 + 1 + 6 = 9 chars, within the ~10-char overlay.
  return {
    left: "  " + glyph + " " + dest,
    right: cars + " " + eta,
  };
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
 * and the train list, as its two pixel-aligned columns. Returns `null`
 * when no train is pinned, or when the pinned train is no longer visible
 * AND there's no "(gone)" latch to surface.
 *
 *   left = "* RED Glenmont"      right = "3 min"
 *   left = "* RED Glenmont (gone)" right = ""   (one-tick gone latch)
 *
 * The pin marker "* " doubles as the 2-char body inset so the line cell
 * aligns with the unmarked train rows below (`"  " + glyph + …`). The
 * destination is left-aligned (NOT padded) — the ETA is the right
 * overlay column.
 */
export function renderPinRow(
  snapshot: PredictionsSnapshot,
  visibleTrains: readonly Train[],
): BodyRow | null {
  if (!snapshot.pinned) return null;
  const idx = findPinnedTrainIndex(visibleTrains, snapshot.pinned);
  if (idx < 0) {
    // Pinned train no longer in the visible list. Render a "(gone)"
    // indicator for one tick before the auto-clear in `tick()`
    // wipes the pin. Without this the row would silently disappear.
    if (snapshot.pinnedGone) {
      const code = lineGlyph(snapshot.pinned.line);
      const fullName = code === "--" ? "--" : lineName(code);
      const lineCell = padRight(fullName, GLYPH_WIDTH);
      const dest = abbreviateStation(
        toTitleCase(snapshot.pinned.destination),
        DEST_WIDTH,
      );
      // The "(gone)" tag rides the LEFT cell (it's not a value); no
      // right-column ETA for a departed train.
      const left = truncate("* " + lineCell + " " + dest + " (gone)", SAFE_TEXT_WIDTH);
      return { left, right: "" };
    }
    return null;
  }
  const t = visibleTrains[idx]!;
  const code = lineGlyph(t.Line);
  const fullName = code === "--" ? "--" : lineName(code);
  const line = padRight(fullName, GLYPH_WIDTH);
  const dest = abbreviateStation(
    toTitleCase(t.Destination || t.DestinationName),
    DEST_WIDTH,
  );
  const eta = padLeft(formatEta(t.Min), ETA_WIDTH);
  // LEFT: "* "(2) + line glyph cell + " " + destination, clamped to the
  // safe text width so the LVGL container can't hard-wrap. RIGHT: the
  // right-aligned ETA in the value overlay.
  const left = truncate("* " + line + " " + dest, SAFE_TEXT_WIDTH);
  return { left, right: eta };
}

/**
 * Pull the human-readable distance phrase out of a `PinnedPosition.label`.
 *
 * `resolvePinnedPosition` builds the label as `* <lineCode> <phrase>`,
 * where `<phrase>` is one of:
 *   - "at this station"  → returns "at station"   (tightened)
 *   - "approaching"      → returns "approaching"
 *   - "<N> stops away"   → returns "<N> stops"    (drops "away")
 *   - "<destination>"    → fallback form when the train couldn't be
 *                          located on the line → returns `null` (no real
 *                          position info to surface in the compact line).
 *
 * Parsing strips the leading `* ` marker and the line-code token rather
 * than re-deriving the phrase, so the label stays the single source of
 * truth for the position wording. Returns `null` when there's nothing
 * position-specific to show.
 */
export function pinnedDistancePhrase(
  label: string,
  pinLine: string,
): string | null {
  if (typeof label !== "string" || label.length === 0) return null;
  // Strip the `* ` marker, then the line-code token + its trailing space.
  let rest = label.startsWith("* ") ? label.slice(2) : label;
  const lineToken = pinLine + " ";
  if (rest.startsWith(lineToken)) rest = rest.slice(lineToken.length);
  rest = rest.trim();
  if (rest.length === 0) return null;
  if (rest === "at this station") return "at station";
  if (rest === "approaching") return "approaching";
  // "<N> stops away" → "<N> stops". Keep singular "1 stop" tidy too.
  const stopsMatch = /^(\d+)\s+stops?\s+away$/.exec(rest);
  if (stopsMatch) {
    const n = stopsMatch[1]!;
    return n === "1" ? "1 stop" : `${n} stops`;
  }
  // Anything else is the fallback `* <line> <destination>` form (the
  // train wasn't locatable) — no position phrase to surface.
  return null;
}

/**
 * Render the COMPACT pinned-summary row that merges the old two-row
 * "pin summary" + "N stops away" block into ONE row, so the dense
 * pinned-with-position state fits the body without clipping the train
 * list. Returns its two pixel-aligned columns, or `null` when there's
 * no pin / the pinned train isn't visible (the `(gone)` / no-pin cases
 * stay on `renderPinRow`).
 *
 *   left = "* RED Glenmont (3 stops)"     right = "3 min"
 *
 * When no position phrase is available (train not yet locatable) the
 * parenthetical is dropped:
 *
 *   left = "* RED Glenmont"               right = "5 min"
 *
 * The "* " marker doubles as the 2-char body inset so the line cell
 * aligns with the train rows below. The left segment is clamped to
 * `SAFE_TEXT_WIDTH` so the LVGL container can't hard-wrap it; the ETA is
 * the host's right overlay column (pixel-aligned with the train ETAs).
 */
export function renderPinnedSummary(
  snapshot: PredictionsSnapshot,
  visibleTrains: readonly Train[],
): BodyRow | null {
  if (!snapshot.pinned) return null;
  const idx = findPinnedTrainIndex(visibleTrains, snapshot.pinned);
  if (idx < 0) return null;
  const t = visibleTrains[idx]!;
  const code = lineGlyph(t.Line);
  const fullName = code === "--" ? "--" : lineName(code);
  const dest = abbreviateStation(
    toTitleCase(t.Destination || t.DestinationName),
    DEST_WIDTH,
  );
  // Distance phrase from the resolved position (when present).
  const phrase =
    snapshot.pinnedPosition !== null
      ? pinnedDistancePhrase(snapshot.pinnedPosition.label, t.Line)
      : null;
  // Left content: "* RED Glenmont (3 stops)". The "* " marker doubles
  // as the 2-char body inset so the line code aligns with the train
  // rows below ("  " + glyph + …).
  const head = `* ${fullName} ${dest}`;
  const left = phrase ? `${head} (${phrase})` : head;
  // Clamp real text to the safe width so the LVGL container can't
  // hard-wrap it. The ETA goes in the right overlay column.
  return {
    left: truncate(left, SAFE_TEXT_WIDTH),
    right: formatEta(t.Min),
  };
}

/**
 * Maximum lines we'll spend on an incident footer. The footer
 * container is ~88px (~3 text rows) in the rebalanced three-section
 * geometry, so we cap the wrapped headline at 3 lines: enough to read
 * the first sentence of a typical service alert at SAFE_TEXT_WIDTH,
 * while the `wrapText` ellipsis path terminates anything longer
 * cleanly rather than overflowing the bordered box.
 */
const FOOTER_MAX_LINES = 3;

/**
 * Build the QUIET fallback line shown in the footer when there's no
 * incident and no surfaced fetch error — so the bordered footer
 * container reads as intentional rather than a big empty box.
 *
 * Priority:
 *   1. A distinct served-lines summary derived from the visible
 *      trains, full line names per the screen's consistency rule:
 *        "Serving RED, ORANGE"
 *   2. When no trains are visible (so no lines to summarise), a subtle
 *      navigation hint:
 *        "Double-tap for stations"
 *
 * Always a single line, clamped to `SAFE_TEXT_WIDTH` and 2-char inset
 * to match the incident footer's prefix rhythm.
 */
export function renderFooterQuiet(
  visibleTrains: readonly Train[],
): string {
  // Distinct served lines, in first-seen (ETA) order, full names.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const t of visibleTrains) {
    const code = lineGlyph(t.Line);
    if (code === "--") continue;
    if (seen.has(code)) continue;
    seen.add(code);
    names.push(lineName(code));
  }
  if (names.length === 0) {
    // No revenue lines to summarise — fall back to a gentle hint.
    return "  " + truncate("Double-tap for stations", SAFE_TEXT_WIDTH - 2);
  }
  const body = "Serving " + names.join(", ");
  return "  " + truncate(body, SAFE_TEXT_WIDTH - 2);
}

/**
 * Render the footer rows.
 *
 * Precedence:
 *   1. An active incident headline → word-wrapped prose (2-3 lines).
 *   2. A fetch error with NO data at all → the "? " network-problem
 *      line (the stale clock marker covers the have-data case).
 *   3. Otherwise → a single QUIET fallback line (served lines / hint)
 *      so the bordered footer never reads as an empty broken box.
 *
 * Never returns `null` for the three-section layout: the footer
 * container always exists, so we always give it gentle content. The
 * incident text is wrapped at `SAFE_TEXT_WIDTH` (via `wrapWithPrefix`)
 * so long alerts can't trip the container's hard-wrap.
 *
 * `visibleTrains` feeds the quiet fallback's served-lines summary;
 * when omitted it's derived from `snapshot.trains` (sorted + capped),
 * which keeps single-argument callers (and the test suite) working.
 */
export function renderFooter(
  snapshot: PredictionsSnapshot,
  visibleTrains?: readonly Train[],
): string[] {
  if (snapshot.incidentHeadline && snapshot.incidentHeadline.trim().length > 0) {
    // No leading "! " glyph — the bordered footer container is itself
    // the visual "this is an alert" signal. The headline reads as
    // plain wrapped prose inside its own framed section.
    return wrapWithPrefix("  ", snapshot.incidentHeadline.trim());
  }
  if (snapshot.fetchError !== null && snapshot.fetchedAt === 0) {
    // Only surface fetch errors in the footer when we have NO data at all
    // — otherwise the stale `?` marker on the clock is sufficient and the
    // footer should stay reserved for genuine incidents. The "? " prefix
    // distinguishes a network problem from a service alert.
    return wrapWithPrefix("? ", snapshot.fetchError);
  }
  const visible =
    visibleTrains ??
    sortTrainsForDisplay(snapshot.trains).slice(0, MAX_VISIBLE_TRAINS);
  return [renderFooterQuiet(visible)];
}

/**
 * Render `prefix + body` wrapped into 1..FOOTER_MAX_LINES rows. The
 * prefix sits on the FIRST line only; continuation lines are
 * indented by `prefix.length` spaces so the wrap reads as one
 * coherent block visually:
 *
 *   ! This weekend, trains
 *     will single-track
 *     between A01 and …
 */
function wrapWithPrefix(prefix: string, body: string): string[] {
  const indent = " ".repeat(prefix.length);
  // Wrap real prose at SAFE_TEXT_WIDTH (NOT LINE_WIDTH) so a long alert
  // can't push past the container's 576px hard-wrap point and dump an
  // orphan word at column 0. The prefix/indent consumes from that
  // budget so wrapped + inset still fits.
  const innerWidth = SAFE_TEXT_WIDTH - prefix.length;
  const wrapped = wrapText(body.trim(), innerWidth, FOOTER_MAX_LINES);
  if (wrapped.length === 0) return [];
  // Strip a single dangling comma/period from the final line when the
  // wrap consumed the whole headline (no trailing ellipsis). A first
  // sentence that was itself a truncated list fragment ("…Foggy
  // Bottom,") would otherwise leave a comma orphaned at the line end.
  const lastIdx = wrapped.length - 1;
  const last = wrapped[lastIdx]!;
  if (!last.endsWith(ELLIPSIS) && /[,.]$/.test(last)) {
    wrapped[lastIdx] = last.slice(0, -1);
  }
  return wrapped.map((line, i) => (i === 0 ? prefix : indent) + line);
}

/**
 * Convert a normalised 24-hour "HH:MM" string to the app's 12-hour
 * label ("23:47" → "11:47p", "22:50" → "10:50p", "00:30" → "12:30a").
 * Keeps the whole HUD on one clock convention (the header clock and
 * ETAs are all 12-hour). Returns the input unchanged if it can't parse.
 */
function to12hLabel(hhmm24: string): string {
  const colon = hhmm24.indexOf(":");
  if (colon < 0) return hhmm24;
  const h24 = parseInt(hhmm24.slice(0, colon), 10);
  const mm = hhmm24.slice(colon + 1);
  if (!Number.isFinite(h24) || mm.length === 0) return hhmm24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? "a" : "p";
  return `${String(h12)}:${mm}${ap}`;
}

/**
 * Render the optional late-night last-train row. Returns `null` when
 * the wall clock is before `LAST_TRAIN_HOUR` OR the schedule data
 * isn't available — in either case the row is hidden.
 *
 * Line codes are spelled out (ORANGE, RED) and times use the app's
 * 12-hour convention to stay consistent with the rest of the HUD:
 *
 *   1 line:    "Last RED 11:47p"
 *   2 lines:   "Last ORANGE 10:50p  RED 11:47p"
 *   3+ lines:  "Last ORANGE 10:50p +2"   (drops cell #2 for the
 *              overflow count so the row stays short)
 *
 * Sorted by time ascending so the earliest-departing line is
 * surfaced first (the line the user has to leave fastest for).
 */
export function renderLastTrainRow(
  snapshot: PredictionsSnapshot,
  nowMs: number,
): string | null {
  if (!shouldShowLastTrain(nowMs)) return null;
  const lines = snapshot.lastTrainToday;
  if (!lines || lines.length === 0) return null;
  const sorted = [...lines].sort((a, b) => {
    const na = normalizeTo24h(a.time) ?? "";
    const nb = normalizeTo24h(b.time) ?? "";
    return na.localeCompare(nb);
  });
  // Spell out the line code and render the time in the app's 12-hour
  // convention (the stored value may be 24h "22:50" or 12h "11:47p").
  const label = (e: LastTrainByLine) => {
    const n = normalizeTo24h(e.time);
    return `${lineName(e.line)} ${n ? to12hLabel(n) : e.time}`;
  };
  if (sorted.length === 1) {
    return truncate(`Last ${label(sorted[0]!)}`, SAFE_TEXT_WIDTH);
  }
  if (sorted.length === 2) {
    const cells = sorted.map(label).join("  ");
    return truncate(`Last ${cells}`, SAFE_TEXT_WIDTH);
  }
  // 3+ — drop cell #2; the +N marker takes the slot.
  const overflow = sorted.length - 1;
  return truncate(
    `Last ${label(sorted[0]!)} +${overflow}`,
    SAFE_TEXT_WIDTH,
  );
}

/**
 * Resolve a pinned train's live position from TrainPositions +
 * StandardRoutes. Returns `null` when:
 *
 *   - no pin
 *   - the pin's `destinationCode` is missing (legacy pin from a
 *     pre-WP-I session)
 *   - no TrainPositions entry matches (the train hasn't entered
 *     service yet, or just left the system)
 *   - StandardRoutes hasn't resolved
 *
 * On a hit, returns a `PinnedPosition` carrying:
 *   - `label` — one of "at this station", "approaching",
 *     "N stops away" (the distance is in revenue-station hops on
 *     the line)
 *   - `schematic` — the 1-row line diagram with the user's
 *     station and train's nearest station marked
 *
 * Exported for the test suite + the `main.ts` fetcher.
 */
export function resolvePinnedPosition(
  pin: PredictionsSnapshot["pinned"],
  userStationCode: string,
  positions: readonly import("../wmata").TrainPosition[] | null,
  routes: readonly StandardRoute[] | null,
): PinnedPosition | null {
  if (!pin) return null;
  if (!positions || !routes) return null;
  const destCode = pin.destinationCode ?? null;
  if (typeof destCode !== "string" || destCode.length === 0) return null;
  // Find the matching train. Multiple trains can share a (line,
  // destination) on a busy commute — pick the one with the smallest
  // SecondsAtLocation as a proxy for "most recently moved", which
  // is the one most likely to be approaching the user.
  const candidates = positions.filter(
    (p) =>
      p.LineCode === pin.line && p.DestinationStationCode === destCode,
  );
  if (candidates.length === 0) return null;
  const match = candidates.reduce((best, p) =>
    p.SecondsAtLocation < best.SecondsAtLocation ? p : best,
  );

  const lineStations = buildLineStations(routes, pin.line);
  if (lineStations.length === 0) return null;
  const userIdx = lineStations.indexOf(userStationCode);

  const trainStation = findNearestStationToCircuit(
    routes,
    pin.line,
    match.CircuitId,
  );
  const trainIdx = trainStation ? lineStations.indexOf(trainStation) : -1;

  // Label: "at this station" / "approaching" / "N stops away".
  let label = `* ${pin.line} ${pin.destination}`;
  if (trainIdx >= 0 && userIdx >= 0) {
    const stops = stationsBetween(lineStations, userStationCode, trainStation!);
    if (stops !== null) {
      if (stops === 0) label = `* ${pin.line} at this station`;
      else if (stops === 1) label = `* ${pin.line} approaching`;
      else label = `* ${pin.line} ${stops} stops away`;
    }
  }
  const schematic = renderLineSchematic(
    pin.line,
    lineStations,
    userIdx,
    trainIdx,
  );
  return {
    label: truncate(label, LINE_WIDTH),
    schematic,
  };
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
  /**
   * Fetcher accepts the CURRENT snapshot so the implementation can
   * read `pinned` and conditionally fetch TrainPositions (skipping
   * the extra round-trip when nothing is pinned).
   */
  fetcher: (
    snapshot: PredictionsSnapshot,
  ) => Promise<PredictionsFetchResult>,
  initialSnapshot: PredictionsSnapshot,
): Screen<PredictionsSnapshot> & {
  tick: (snapshot: PredictionsSnapshot) => Promise<PredictionsSnapshot>;
  tickIntervalMs: number;
} {
  return {
    name: "predictions",
    // Predictions uses a 3-section layout: incidents render in their
    // own bordered footer block below the trains list, so the alert
    // is visually decoupled from the train predictions even when both
    // are scrolling state.
    layout: "three-section",
    init: () => initialSnapshot,
    view(snapshot, nav, ctx: ViewContext): ScreenSections {
      // `ctx.nowMs` is freshly stamped by the host on EVERY render —
      // including the 1Hz clock-only re-renders that fire independently
      // of any fetch tick. The header is now just the station title; the
      // wall clock + staleness marker live in the host's own top-right
      // clock container (the marker is surfaced via `clockMarker` below).
      const header: string[] = [renderHeader(snapshot)];
      // TRUE two-column body: `bodyLeft[i]` / `bodyRight[i]` are the same
      // visual row. The host renders LEFT in the full-width body
      // container and overlays RIGHT (the value) at a fixed pixel x, so
      // the value column is pixel-aligned regardless of the (variable-
      // width) destination glyphs. `right` is "" for value-less rows
      // (prose, cues, separators). A `push(row)` helper keeps the two
      // arrays in lockstep.
      const bodyLeft: string[] = [];
      const bodyRight: string[] = [];
      const pushRow = (row: BodyRow): void => {
        bodyLeft.push(row.left);
        bodyRight.push(row.right);
      };
      const footer: string[] = [];

      const sorted = sortTrainsForDisplay(snapshot.trains);
      const visible = sorted.slice(0, MAX_VISIBLE_TRAINS);

      // Pinned-train header block. COMPACT by design so the dense
      // "pinned + live position" state fits the 5-row body without
      // clipping the train list:
      //
      //   - With a resolved live position, the old two-row block
      //     (summary row + "N stops away" row + ASCII schematic) is
      //     merged into ONE row: left "* RED Glenmont (3 stops)" +
      //     right "3 min". The crude ASCII schematic ("RD -*--@---") is
      //     intentionally dropped — it read poorly at one char per
      //     station and cost a whole row.
      //   - Without a position (or in the "(gone)" latch), we keep the
      //     existing single-row pin summary via `renderPinRow`.
      if (snapshot.pinned !== null && snapshot.pinnedPosition !== null) {
        const summary = renderPinnedSummary(snapshot, visible);
        if (summary !== null) {
          pushRow(summary);
        } else {
          // Pinned train not in the visible list but a stale position
          // lingers — fall back to the plain pin row (handles "(gone)").
          const pinRow = renderPinRow(snapshot, visible);
          if (pinRow !== null) pushRow(pinRow);
        }
      } else {
        const pinRow = renderPinRow(snapshot, visible);
        if (pinRow !== null) pushRow(pinRow);
      }

      if (visible.length === 0) {
        // Empty state — distinct copy depending on whether we have data
        // at all. If there's no data yet AND we've never fetched, show a
        // "Loading…" cue; otherwise show "No trains predicted". These are
        // value-less prose rows: all content in the LEFT column.
        const firstLoadError =
          snapshot.fetchedAt === 0 && snapshot.fetchError !== null;
        if (snapshot.fetchedAt === 0 && snapshot.fetchError === null) {
          pushRow({ left: truncate("Loading…", LINE_WIDTH), right: "" });
        } else if (firstLoadError) {
          pushRow({ left: truncate("Couldn't reach WMATA.", LINE_WIDTH), right: "" });
        } else {
          pushRow({ left: truncate("No trains predicted.", LINE_WIDTH), right: "" });
        }
        pushRow({ left: "", right: "" });
        // On the first-load error, TAP retries the fetch (wired in the
        // reducer); otherwise the only action is double-tap to exit.
        pushRow({
          left: truncate(
            firstLoadError ? "Tap to retry · double-tap to exit" : "(double-tap to exit)",
            LINE_WIDTH,
          ),
          right: "",
        });
      } else {
        // Cursor: `nav.highlightedIndex` is clamped to the visible
        // range. The pinned train (if any) is marked with "*"; the
        // cursor target (which may or may not be the pinned train)
        // is marked with ">". When both coincide on the same row,
        // the pin marker wins — the user has confirmed this is
        // their tracked train, no need to also surface the cursor.
        //
        // WP-M opt-in cursor: the ">" marker is suppressed until
        // the user explicitly engages (first SCROLL or TAP), so
        // the at-rest render stays glanceable.
        const pinnedIdx = findPinnedTrainIndex(visible, snapshot.pinned);
        const cursorIdx = Math.max(
          0,
          Math.min(nav.highlightedIndex, visible.length - 1),
        );
        const showCursor = snapshot.cursorVisible;
        for (let i = 0; i < visible.length; i++) {
          const t = visible[i]!;
          const marker: "" | "*" | ">" =
            i === pinnedIdx
              ? "*"
              : showCursor && i === cursorIdx
                ? ">"
                : "";
          pushRow(renderTrainRow(t, marker));
        }
      }

      // Late-night last-train row stays at the bottom of the body —
      // it's train-list metadata, not an incident. A blank row sets it
      // apart from the train rows above (so the left-flowing "Last …"
      // prose doesn't read as a clipped train row), but only when the
      // list is short enough that the spacer won't push the summary out
      // of the ~5-row body. The "Last …" string has no value column.
      const lastTrain = renderLastTrainRow(snapshot, ctx.nowMs);
      if (lastTrain !== null) {
        if (bodyLeft.length <= 3) pushRow({ left: "", right: "" });
        pushRow({ left: lastTrain, right: "" });
      }

      // Footer section: the active service alert / network-error line
      // when present, otherwise a QUIET fallback (served-lines summary
      // or a gentle hint) so the bordered footer never reads as an
      // empty broken box. `renderFooter` always returns ≥1 line for the
      // three-section layout; `visible` feeds the served-lines summary.
      footer.push(...renderFooter(snapshot, visible));
      return {
        header,
        // `body` is ignored by the host when `bodyColumns` is present;
        // we set it to [] per the two-column contract (router.ts).
        body: [],
        bodyColumns: { left: bodyLeft, right: bodyRight },
        footer,
        clockMarker: stalenessMarker(snapshot, ctx.nowMs),
      };
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
            // First scroll surfaces the cursor (WP-M opt-in).
            snapshot: snapshot.cursorVisible
              ? snapshot
              : { ...snapshot, cursorVisible: true },
          };
        case "SCROLL_DOWN":
          if (visible.length === 0) return { nav };
          return {
            nav: { highlightedIndex: Math.min(maxIdx, cursorIdx + 1) },
            snapshot: snapshot.cursorVisible
              ? snapshot
              : { ...snapshot, cursorVisible: true },
          };
        case "TAP": {
          if (visible.length === 0) {
            // Empty body: TAP is "tap to retry" in the first-load error
            // state (couldn't reach WMATA, never fetched) — ask the host
            // to refetch now (single-flight-guarded). In the benign empty
            // states (still loading / genuinely no trains) TAP is a no-op.
            const firstLoadError =
              snapshot.fetchedAt === 0 && snapshot.fetchError !== null;
            return { nav, requestTick: firstLoadError ? true : undefined };
          }
          const t = visible[cursorIdx]!;
          const candidate = {
            line: t.Line,
            destination: t.Destination,
            // Capture DestinationCode so WP-I's TrainPositions
            // matcher can resolve the same train across ticks even
            // though the short-name `Destination` may differ
            // between rail predictions and live positions.
            destinationCode: t.DestinationCode,
          };
          // TAP on the already-pinned train toggles the pin off.
          const isAlreadyPinned =
            snapshot.pinned !== null &&
            snapshot.pinned.line === candidate.line &&
            snapshot.pinned.destination === candidate.destination;
          return {
            nav,
            snapshot: {
              ...snapshot,
              // Unpinning clears the resolved live position too.
              pinned: isAlreadyPinned ? null : candidate,
              pinnedPosition: isAlreadyPinned ? null : snapshot.pinnedPosition,
              pinnedGone: false,
              // Any TAP makes the cursor visible (the user has
              // engaged with the screen).
              cursorVisible: true,
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
        const result = await fetcher(snapshot);

        // WP-M "pinned-train gone" detection + auto-clear. Two-tick
        // state machine:
        //   1. The user's pinned (line, destination) is no longer
        //      in the freshly-fetched trains list → set
        //      `pinnedGone = true` for this tick. The view renders
        //      "* RD Glnmt (gone)".
        //   2. Next tick (still no match): clear the pin entirely.
        let nextPinned = snapshot.pinned;
        let nextPinnedPosition =
          result.pinnedPosition ?? snapshot.pinnedPosition;
        let nextPinnedGone = false;
        if (snapshot.pinned !== null) {
          const stillPresent =
            findPinnedTrainIndex(result.trains, snapshot.pinned) >= 0;
          if (!stillPresent) {
            if (snapshot.pinnedGone) {
              // Second consecutive miss — clear the pin.
              nextPinned = null;
              nextPinnedPosition = null;
              nextPinnedGone = false;
            } else {
              // First miss — surface the "(gone)" indicator.
              nextPinnedGone = true;
            }
          }
        }

        return {
          ...snapshot,
          trains: result.trains,
          incidentHeadline: result.incidentHeadline,
          // Carry the last-train field forward when the fetcher
          // provides one; preserve the prior value when null so the
          // user doesn't see the row blink off if the fetcher only
          // populates it on the first call.
          lastTrainToday: result.lastTrainToday ?? snapshot.lastTrainToday,
          pinned: nextPinned,
          pinnedPosition: nextPinnedPosition,
          pinnedGone: nextPinnedGone,
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
