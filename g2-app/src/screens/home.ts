// Home screen — the first thing the user sees on the glasses.
//
// Layout (1 header + up to 7 body rows):
//
//        WMATA  Favorites                              2:32p
//        > Metro Center · RED BLUE ORANGE SILVER
//          Gallery Pl-Chinatown · RED YELLOW GREEN
//          Union Station · RED
//
// Favorites render as a single LEFT-FLOWING row:
//
//        <prefix>Station Name · LINE LINE LINE
//
// i.e. the 2-char highlight prefix, the full station name, a " · "
// separator, then the full spelled-out line names (RED / BLUE / …).
// Everything is left-aligned. Earlier revisions right-aligned the
// line-code column, but because the code strings vary hugely in width
// (RED vs RED BLUE ORANGE SILVER) and the LVGL font is variable-width,
// that column floated raggedly — anchored to no edge. Left-flowing
// text aligns perfectly in any font, so the raggedness is gone.
//
// The status (ALERTS) row only appears when at least one line the user
// follows has an active incident. When visible, it sits ABOVE the
// favorites. TAP on it navigates to the Incidents screen. The ACCESS
// row (elevator/escalator outages) sits just below it. Both are
// suppressed during quiet hours.
//
// Empty state (no favorites): header + two friendly help lines.
//
// (The status / access rows, when present, ALSO appear above the help
// text in the empty-state layout.)
//
// Overflow guard: a favorite row is truncated to `SAFE_TEXT_WIDTH`
// (= 58 columns of real, non-space text — the point at which the LVGL
// container hard-wraps at the 576px border). We prefer to truncate the
// STATION NAME, keeping the prefix + separator + full line names
// intact (the line codes are the higher-value datum for a metro
// rider). Only when the line names alone already fill the row do we
// fall back to truncating the whole composed string.
//
// PURITY: This module has NO SDK imports and does no DOM access. The
// glasses host (`glasses-host.ts`) is responsible for everything that
// touches the bridge. That keeps `view` and `reduce` Vitest-friendly.

import type { FavoriteStation } from "../storage/settings";
import { MAX_FAVORITES } from "../storage/settings";
import type { LineCode } from "../wmata";
import { highlightPrefix, textWidth, truncate } from "../ui/render";
import {
  HEADER_CONTENT_WIDTH_PX,
  SECTION_INNER_WIDTH_PX,
  VALUE_COL_GAP_PX,
} from "../ui/geometry";
import { abbreviateStation, lineName } from "../ui/format";
// `formatClock` now lives in the shared field-formatter module and is
// rendered by the host into its own top-right clock container. Re-export
// it here so existing imports (`import { formatClock } from "./home"`)
// keep resolving after the screen stopped embedding the clock.
export { formatClock } from "../ui/format";
import type { ReduceResult, Screen, ScreenSections } from "./router";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/**
 * Separator between the station name and the line-name list in a
 * favorite row. The middot reads as a quiet delimiter without adding
 * the visual weight of a dash or pipe.
 */
const FAVORITE_SEPARATOR = " · ";

/**
 * Pixel width reserved on the right for the value column (ETA / alert /
 * outage count). Sized for the widest realistic value so the host's
 * overlay — whose geometry is committed once at mount — always has room.
 * The left column is budgeted around this reserve so the two never
 * overlap, and the screen passes it to the host as `bodyColumns.rightWidthPx`.
 */
export const VALUE_COL_RESERVE_PX = Math.max(
  textWidth("12 min"),
  textWidth("99 alerts"),
  textWidth("99 outages"),
);

/**
 * Max pixel width of the LEFT column in the two-column body. The host
 * overlays the value column flush-right, so the left content must stay
 * clear of it. We truncate the left cell to this budget (preferring to
 * trim the STATION NAME, keeping the line names intact) so a long
 * favorite never runs under the value column.
 */
export const LEFT_COL_MAX_PX =
  SECTION_INNER_WIDTH_PX - VALUE_COL_RESERVE_PX - VALUE_COL_GAP_PX;

/** Label rendered for the synthetic voice-lookup row. */
export const VOICE_LABEL = "VOICE LOOKUP";

/** Label prefix rendered for the synthetic elevator/escalator row. */
export const ACCESS_LABEL_PREFIX = "ACCESS";

/**
 * Canonical order for the line-code glyph cells in the status row.
 *
 * WMATA has six lines total. Listing them in the type-declaration
 * order (RD BL YL OR GR SV) keeps the renderer deterministic and the
 * visual scan-rhythm consistent across renders — affected lines
 * always sit in the same column position.
 */
export const STATUS_ROW_LINE_ORDER: readonly LineCode[] = [
  "RD",
  "BL",
  "YL",
  "OR",
  "GR",
  "SV",
];

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Data the Home screen renders against. */
export interface HomeSnapshot {
  favorites: FavoriteStation[];
  /**
   * Set of line codes (intersected with the user's followed lines)
   * that currently have at least one active rail incident.
   *
   * Empty array → hide the status row entirely; one or more entries
   * → render the per-line glyph row at the top of the screen as a
   * tappable synthetic row (TAP → Incidents).
   *
   * Refreshed in-band by the screen's `tick()`, which delegates to the
   * shared incidents cache (`Session.refreshIncidents`).
   *
   * (Replaces v1.1's `incidentCount: number`; the count is recoverable
   * as `affectedLines.length` but the per-line breakdown is more
   * actionable on a glanceable HUD — the user can tell which lines
   * to worry about without opening the Incidents screen.)
   */
  affectedLines: LineCode[];
  /**
   * Number of active elevator/escalator outages at the user's
   * favorite stations. 0 → hide the ACCESS row; > 0 → render a
   * tappable `ACCESS (n)` row between the status glyph row and the
   * favorites list (TAP → Elevator screen).
   */
  accessOutageCount: number;
  /**
   * True when the user's configured quiet-hours window is currently
   * active. Suppresses BOTH the status glyph row AND the ACCESS row
   * — the user explicitly asked not to be disturbed. The data is
   * still fetched in the background so the rows reappear instantly
   * when quiet hours end.
   *
   * Refreshed on every Home tick via the same scheduler that
   * `bootGlasses` consults for the initial mount.
   */
  quietHours: boolean;
  /**
   * Per-favorite soonest next-train ETA, keyed by station code. The
   * value is the WMATA `Min` token of the soonest upcoming train at
   * that station, across all of its lines — a numeric-as-string
   * (`"4"`), the boarding/arriving sentinels (`"BRD"` / `"ARR"`), or
   * `null` (no upcoming train / unknown). The raw token is kept (not
   * a parsed number) so `renderFavoriteRow` can show `BRD`/`ARR`
   * verbatim while still aligning the numeric ETAs in a fixed column.
   *
   * Lifecycle:
   *   - Seeded to `{}` by the init factory. An ABSENT key renders no
   *     ETA cell content yet ("loading") — the first paint shows the
   *     names without an ETA blink.
   *   - Filled by the `refreshFavoriteEtas` tick (one batched
   *     predictions call for all favorite codes). Best-effort: any
   *     fetch failure leaves the map untouched (ETAs simply linger /
   *     stay blank rather than the row vanishing).
   *   - A key present with a `null` value means "fetched, but this
   *     station has no upcoming train" — rendered as a blank cell,
   *     same as the loading state (we keep the column width either
   *     way so the station names stay aligned).
   *
   * This drives ONLY the favorites; the synthetic ALERTS / ACCESS
   * rows never carry an ETA.
   */
  favoriteEtas: Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * Render the line-name list for a favorite: every code spelled out in
 * full and space-joined, in the order supplied.
 *
 * Examples:
 *   []                            -> ""
 *   ["RD"]                        -> "RED"
 *   ["RD","BL","OR"]              -> "RED BLUE ORANGE"
 *   ["RD","BL","OR","SV"]         -> "RED BLUE ORANGE SILVER"
 *
 * No `+N` collapse: the left-flowing favorite row keeps the full names
 * and lets `renderFavoriteRow` enforce the width budget at the row
 * level (preferring to truncate the station name, not the codes). With
 * only six lines in the real WMATA network a station never carries
 * more than a handful, so the joined string stays short in practice.
 */
export function renderLinesSuffix(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return lines.map((code) => lineName(code)).join(" ");
}

/**
 * Map a WMATA `Min` token to a sortable rank for "soonest train"
 * selection. Mirrors `sortTrainsForDisplay` in the Predictions screen
 * so the two surfaces agree on ordering:
 *
 *   - `"BRD"` (boarding)  -> -2  (soonest)
 *   - `"ARR"` (arriving)  -> -1
 *   - numeric-as-string   -> the parsed integer (e.g. `"4"` -> 4)
 *   - everything else     -> +Infinity (sorts to the tail / never wins)
 *     (covers `""`, `"---"`, and any junk WMATA surprises us with)
 *
 * BRD/ARR rank ahead of every numeric value, which is the design
 * brief's "treat as 0 for soonest" intent expressed as a strict total
 * order (a train that is BRD is sooner than one that is ARR is sooner
 * than one that is 1 minute out).
 */
export function etaSortValue(min: string): number {
  if (min === "BRD") return -2;
  if (min === "ARR") return -1;
  if (/^\d+$/.test(min)) return Number.parseInt(min, 10);
  return Number.POSITIVE_INFINITY;
}

/**
 * Pick the soonest upcoming train's `Min` token from a list of raw
 * `Min` strings (one favorite station's predictions, across all its
 * lines). Returns the winning token verbatim (so `"ARR"` / `"BRD"`
 * survive for display) or `null` when there is no upcoming train —
 * i.e. the list is empty or every entry is an unknown sentinel
 * (`""` / `"---"` / junk).
 *
 * "Soonest" is by `etaSortValue`: BRD < ARR < numeric. Ties keep the
 * first occurrence (stable), which doesn't matter for display since the
 * token is identical.
 */
export function soonestEta(mins: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const min of mins) {
    const rank = etaSortValue(min);
    // Strictly-less keeps the first of equal ranks; the +Infinity
    // sentinels never beat the initial `bestRank`, so an all-junk list
    // yields `null`.
    if (rank < bestRank) {
      best = min;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Render the ETA as the borderless RIGHT-column VALUE for the
 * two-column body. Unlike `renderEtaCell`, this is NOT space-padded —
 * the host pins the value container at a fixed pixel x, so alignment
 * comes from container geometry, not padding. Returns:
 *
 *   - numeric token (`"4"`)  -> `"4 min"`
 *   - `"ARR"` / `"BRD"`      -> `"ARR"` / `"BRD"` (verbatim)
 *   - `null` / unknown       -> `""`  (loading or no-train → empty value
 *                               cell; the host renders nothing on the
 *                               right and the row reads as name-only)
 *
 * The empty-string return is the column contract's "no value for this
 * row" sentinel (`right[i] === ""`).
 */
export function renderEtaValue(min: string | null): string {
  if (min === null) return "";
  if (min === "ARR" || min === "BRD") return min;
  if (/^\d+$/.test(min)) return `${min} min`;
  return ""; // unknown sentinel ("" / "---") → empty value cell
}

/**
 * Build the LEFT column of a favorite row for the two-column body: the
 * cursor prefix, the station name, a separator, and the full line
 * names — i.e. `renderFavoriteRow` WITHOUT the ETA cell (the ETA now
 * lives in the borderless right column via `renderEtaValue`).
 *
 *   "> Metro Center · RED BLUE ORANGE SILVER"
 *   "  Gallery Pl-Chinatown · RED YELLOW GREEN"
 *   "  Union Station · RED"
 *
 * Width contract: the returned string never exceeds `LEFT_COL_MAX`
 * (=50) columns, so it can never run under the right-column value
 * overlay (pinned at ≈ column 50). As in the single-column form we
 * prefer to truncate the STATION NAME, keeping the separator + full
 * line names intact (the codes are the higher-value datum); only when
 * the line names alone already fill the budget do we fall back to
 * truncating the whole composed string. A favorite with no lines drops
 * the separator entirely.
 */
export function renderFavoriteLeft(
  fav: FavoriteStation,
  isHighlighted: boolean,
): string {
  const prefix = highlightPrefix(isHighlighted);
  const lines = renderLinesSuffix(fav.lines);
  const suffix = lines.length > 0 ? FAVORITE_SEPARATOR + lines : "";

  // Budget for the station name = the left-column pixel width minus the
  // fixed parts (prefix + separator + line names). When positive we keep
  // the codes whole and trim the name to fit; abbreviateStation
  // short-circuits when the name already fits.
  const nameBudget = LEFT_COL_MAX_PX - textWidth(prefix) - textWidth(suffix);
  if (nameBudget >= 1) {
    const name = abbreviateStation(fav.name, nameBudget);
    return prefix + name + suffix;
  }

  // Pathological case: prefix + line names already fill the column.
  // Keep at least one character of the name and truncate the whole
  // composed string so nothing runs under the value overlay.
  const firstNameChar = fav.name.slice(0, 1);
  return truncate(prefix + firstNameChar + suffix, LEFT_COL_MAX_PX);
}

/**
 * Build the LEFT column of the ALERTS row for the two-column body: the
 * `renderAlertsRow` content MINUS the right-aligned count (which moves
 * to the value column via `renderAlertsValue`). Left-flowing, no
 * padding:
 *
 *   "  ALERTS · RED · ORANGE"   (count "2 alerts" lives in right[i])
 *
 * Truncated to `LEFT_COL_MAX` for the same overlay-collision reason as
 * the favorite left cell.
 */
export function renderAlertsLeft(
  affected: ReadonlySet<LineCode>,
  isHighlighted: boolean,
): string {
  const prefix = highlightPrefix(isHighlighted);
  const affectedNames = STATUS_ROW_LINE_ORDER
    .filter((c) => affected.has(c))
    .map((c) => lineName(c));
  const linesPart =
    affectedNames.length === 0
      ? "ALERTS"
      : `ALERTS · ${affectedNames.join(" · ")}`;
  return truncate(prefix + linesPart, LEFT_COL_MAX_PX);
}

/** The ALERTS row's right-column VALUE: the pluralised count. */
export function renderAlertsValue(alertCount: number): string {
  return alertCount === 1 ? "1 alert" : `${alertCount} alerts`;
}

/**
 * Build the LEFT column of the ACCESS row for the two-column body: the
 * label only (the count moves to the value column).
 *
 *   "  ACCESS"   (count "2 outages" lives in right[i])
 */
export function renderAccessLeft(isHighlighted: boolean): string {
  return truncate(highlightPrefix(isHighlighted) + ACCESS_LABEL_PREFIX, LEFT_COL_MAX_PX);
}

/** The ACCESS row's right-column VALUE: the pluralised outage count. */
export function renderAccessValue(count: number): string {
  return count === 1 ? "1 outage" : `${count} outages`;
}

/** Build the always-present "VOICE LOOKUP" row. */
export function renderVoiceRow(isHighlighted: boolean): string {
  // "> VOICE LOOKUP" is 14 chars; well under 24. No trailing pad — the
  // physical panel does not care about right-padding for monospace rows,
  // and shorter strings serialise less data over the bridge.
  return highlightPrefix(isHighlighted) + VOICE_LABEL;
}

/**
 * Render the title row — the screen identifier only, left-aligned:
 *   "WMATA  Favorites"
 *
 * The wall clock is NO LONGER part of the header string: the host
 * renders it into a dedicated top-right clock container on every screen
 * for consistent placement. The title is truncated to 50 columns so it
 * can never collide with that clock cell (which starts at x≈486px ≈
 * column 50).
 *
 * The `(n/5)` count parenthetical was dropped earlier — the user can
 * count favorites by looking at the body rows below — and the
 * `favoritesCount` / `nowMs` parameters went with the clock; the title
 * is now a constant.
 */
export function renderHeader(): string {
  return truncate("WMATA  Favorites", HEADER_CONTENT_WIDTH_PX);
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/**
 * True when the snapshot has at least one active incident on a line
 * the user follows, so the status glyph row should be rendered.
 *
 * Row position: the row sits ABOVE the favorites (the v1.1 ALERTS
 * row sat below them).
 *
 * Quiet-hours rule: even with active incidents the row is hidden
 * during quiet hours. The user explicitly asked not to be
 * disturbed; surfacing alerts would defeat the point.
 */
export function hasAlertsRow(snapshot: HomeSnapshot): boolean {
  if (snapshot.quietHours) return false;
  return snapshot.affectedLines.length > 0;
}

/**
 * True when the snapshot has ≥ 1 elevator/escalator outage at a
 * favorite station, so the ACCESS row should be rendered.
 *
 * Position: just below the status glyph row (if present), above the
 * favorites. Tappable; TAP navigates to the Elevator screen.
 *
 * Quiet-hours rule: same as `hasAlertsRow` — both synthetic alert
 * surfaces hide during quiet hours.
 */
export function hasAccessRow(snapshot: HomeSnapshot): boolean {
  if (snapshot.quietHours) return false;
  return snapshot.accessOutageCount > 0;
}

/**
 * The flat list of selectable rows. The synthetic rows (status,
 * access) are part of the navigation model so SCROLL_UP/DOWN can
 * land on them. The voice-lookup utility row was removed because
 * the underlying voice-search feature isn't wired up yet — once it
 * lands, restore a `+1` here and the `isVoiceIndex` helper below.
 *
 * Index conventions (rows that are absent are skipped, indices shift):
 *   - 0?  (optional) status glyph row
 *   - 1?  (optional) ACCESS row
 *   - …   the favorites
 */
export function rowCount(snapshot: HomeSnapshot): number {
  return (
    (hasAlertsRow(snapshot) ? 1 : 0) +
    (hasAccessRow(snapshot) ? 1 : 0) +
    snapshot.favorites.length
  );
}

/** True if `index` points at the status glyph (alerts) row. */
export function isAlertsIndex(
  snapshot: HomeSnapshot,
  index: number,
): boolean {
  if (!hasAlertsRow(snapshot)) return false;
  return index === 0;
}

/** True if `index` points at the ACCESS (elevator outages) row. */
export function isAccessIndex(
  snapshot: HomeSnapshot,
  index: number,
): boolean {
  if (!hasAccessRow(snapshot)) return false;
  return index === (hasAlertsRow(snapshot) ? 1 : 0);
}

/**
 * Index where the favorites region starts. Equals the count of
 * preceding synthetic rows (status + access). Exported so reducers /
 * tests can translate raw indices into favorite-array indices.
 */
export function favoritesOffset(snapshot: HomeSnapshot): number {
  return (
    (hasAlertsRow(snapshot) ? 1 : 0) + (hasAccessRow(snapshot) ? 1 : 0)
  );
}

/**
 * Stub retained for callsites — the voice-lookup row was removed
 * pending the underlying feature wiring up. Always returns false.
 */
export function isVoiceIndex(_snapshot: HomeSnapshot, _index: number): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Screen impl
// ---------------------------------------------------------------------------

function clampIndex(idx: number, count: number): number {
  if (count <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= count) return count - 1;
  return idx;
}

/**
 * Return a snapshot whose `favorites` list is clipped to at most
 * `MAX_FAVORITES` entries. If the input is already within the cap, the
 * original snapshot is returned by reference (zero allocation in the
 * common case). This is a defensive guard for data-corruption paths
 * (e.g. a future schema-migration bug that writes 6+ favorites): the
 * screen should silently render only the first five, never throw or
 * produce an oversized list.
 */
function clampedSnapshot(snapshot: HomeSnapshot): HomeSnapshot {
  if (snapshot.favorites.length <= MAX_FAVORITES) return snapshot;
  return { ...snapshot, favorites: snapshot.favorites.slice(0, MAX_FAVORITES) };
}

/**
 * The Home screen value. The host imports this and passes it into
 * `mountGlassesScreen(homeScreen, bridge, router)`.
 *
 * Optional `tick` / `tickIntervalMs` keep the snapshot's
 * `incidentCount` current. The tick is best-effort — fetch failures
 * are swallowed silently because the incident count is non-critical
 * for the Home surface (the ALERTS row will simply linger at the last
 * known count rather than blanking the HUD).
 */
export function makeHomeScreen(
  loader: () => HomeSnapshot,
  options?: {
    refreshAffectedLines?: () => Promise<LineCode[]>;
    /**
     * Fetch the current count of elevator/escalator outages at the
     * user's favorite stations. Wired in `main.ts` to the session's
     * `refreshElevatorIncidents` cache. Best-effort: a rejection is
     * swallowed and the last-known count is preserved (the row will
     * simply linger rather than blinking).
     */
    refreshAccessOutageCount?: () => Promise<number>;
    /**
     * Re-evaluate the quiet-hours flag (the only schedule-driven
     * piece Home needs at runtime — auto-rotate is a boot-time
     * concern handled by `main.ts`). Cheap: pure date math against
     * the stored schedule. Wired in `main.ts`.
     */
    refreshQuietHours?: () => Promise<boolean>;
    /**
     * Fetch the soonest next-train ETA for every favorite station,
     * returned as a `stationCode → Min token` map (the token is the
     * raw WMATA `Min` of the soonest upcoming train, or `null` when a
     * station has no upcoming train). Wired in `main.ts` to a single
     * batched predictions call for all favorite codes (WMATA accepts a
     * comma-joined code list), keeping us well under the 10 req/s
     * ceiling. Best-effort: a rejection is swallowed and the previous
     * ETA map is preserved (the rows linger at their last values rather
     * than blanking).
     */
    refreshFavoriteEtas?: () => Promise<Record<string, string | null>>;
    tickIntervalMs?: number;
  },
): Screen<HomeSnapshot> {
  const screen: Screen<HomeSnapshot> = {
    name: "home",
    init: loader,
    // `ctx` (third param) carries the host-supplied wall clock for
    // time-sensitive UI; Home has none — the host renders the clock in
    // its own container — so we accept-and-ignore it. Prefixing with `_`
    // quiets `noUnusedParameters` while still documenting the contract.
    view(snapshot, nav, _ctx): ScreenSections {
      // Defensive clamp: if a future migration / data-corruption bug
      // hands us more than MAX_FAVORITES, render only the first slice
      // rather than throwing or producing an oversized list. The same
      // clamp is applied in `reduce()` via `rowCount`/`isVoiceIndex`,
      // both of which call through `clampedSnapshot()`.
      const clamped = clampedSnapshot(snapshot);
      const header: string[] = [renderHeader()];
      // TRUE two-column body: `left[i]` is the primary content (station
      // name + line names, or a synthetic label), `right[i]` the value
      // (ETA / count) — pixel-aligned because the host overlays the
      // right column in a borderless container pinned at a fixed x. The
      // two arrays are built in lockstep so `left[i]`/`right[i]` are the
      // SAME row. `body` is left empty: when `bodyColumns` is present
      // the host ignores `body` and `flattenSections` zips the columns.
      const left: string[] = [];
      const right: string[] = [];
      // Append a (left, right) pair as one body row, keeping the two
      // arrays the same length.
      const pushRow = (l: string, r: string): void => {
        left.push(l);
        right.push(r);
      };

      const affected = new Set<LineCode>(clamped.affectedLines);
      const showStatus = hasAlertsRow(clamped);
      const showAccess = hasAccessRow(clamped);

      // Synthetic-row count is just the number of distinct affected
      // lines — the only count we have at this layer. Drives the
      // `ALERTS · RD … N alerts` value-column summary.
      const alertCount = affected.size;

      if (clamped.favorites.length === 0) {
        // Empty state: synthetic alert / access rows at the top (if
        // present), then friendly help copy.
        //
        // NOTE: empty-state branch uses the RAW highlightedIndex (not
        // the clamped value) so that an out-of-range index renders an
        // un-highlighted row.
        let cursor = 0;
        if (showStatus) {
          pushRow(
            renderAlertsLeft(affected, nav.highlightedIndex === cursor),
            renderAlertsValue(alertCount),
          );
          cursor += 1;
        }
        if (showAccess) {
          pushRow(
            renderAccessLeft(nav.highlightedIndex === cursor),
            renderAccessValue(clamped.accessOutageCount),
          );
          cursor += 1;
        }
        if (showStatus || showAccess) pushRow("", "");
        // Friendly two-line empty state. These are real-text (prose)
        // lines with no value column, so each carries an empty `right`
        // cell. They sit comfortably within the body inner width. We
        // deliberately do not pad with filler — the favorites list is
        // meant to grow.
        pushRow(
          truncate("No favorites yet. Open the phone app", SECTION_INNER_WIDTH_PX),
          "",
        );
        pushRow(
          truncate("to add your home + commute stations.", SECTION_INNER_WIDTH_PX),
          "",
        );
        return {
        header,
        body: [],
        bodyColumns: { left, right, rightWidthPx: VALUE_COL_RESERVE_PX },
      };
      }

      const total = rowCount(clamped);
      const idx = clampIndex(nav.highlightedIndex, total);
      const favOffset = favoritesOffset(clamped);
      if (showStatus) {
        pushRow(
          renderAlertsLeft(affected, isAlertsIndex(clamped, idx)),
          renderAlertsValue(alertCount),
        );
      }
      if (showAccess) {
        pushRow(
          renderAccessLeft(isAccessIndex(clamped, idx)),
          renderAccessValue(clamped.accessOutageCount),
        );
      }
      // Blank separator between the synthetic alert rows (alerts /
      // access) and the user's actual favorites — only when there's at
      // least one synthetic row above to separate from. Both columns
      // blank.
      if (showStatus || showAccess) pushRow("", "");
      for (let i = 0; i < clamped.favorites.length; i++) {
        const fav = clamped.favorites[i]!;
        // An ABSENT key (the seeded `{}` loading state) and a present
        // `null` value both render an empty ETA value — `?? null`
        // normalises `undefined` to `null` so `renderEtaValue` gets a
        // single "no ETA" representation (returns "").
        const eta = clamped.favoriteEtas[fav.code] ?? null;
        pushRow(
          renderFavoriteLeft(fav, idx === favOffset + i),
          renderEtaValue(eta),
        );
      }
      return {
        header,
        body: [],
        bodyColumns: { left, right, rightWidthPx: VALUE_COL_RESERVE_PX },
      };
    },
    reduce(snapshot, nav, event): ReduceResult<HomeSnapshot> {
      const clamped = clampedSnapshot(snapshot);
      const total = rowCount(clamped);
      const idx = clampIndex(nav.highlightedIndex, total);
      const favOffset = favoritesOffset(clamped);
      switch (event.type) {
        case "SCROLL_UP": {
          return { nav: { highlightedIndex: clampIndex(idx - 1, total) } };
        }
        case "SCROLL_DOWN": {
          return { nav: { highlightedIndex: clampIndex(idx + 1, total) } };
        }
        case "TAP": {
          if (isVoiceIndex(clamped, idx)) {
            return { nav: { highlightedIndex: idx }, navigate: { to: "voice" } };
          }
          if (isAlertsIndex(clamped, idx)) {
            return {
              nav: { highlightedIndex: idx },
              navigate: { to: "incidents" },
            };
          }
          if (isAccessIndex(clamped, idx)) {
            return {
              nav: { highlightedIndex: idx },
              navigate: { to: "elevator" },
            };
          }
          // Favorites occupy [favOffset, favOffset + N). Translate
          // the raw nav index into the favorites-array index.
          const favIdx = idx - favOffset;
          const fav = clamped.favorites[favIdx];
          if (!fav) {
            // Defensive — should be impossible given clamping above.
            return { nav: { highlightedIndex: idx } };
          }
          return {
            nav: { highlightedIndex: idx },
            navigate: { to: "predictions", stationCode: fav.code },
          };
        }
        case "DOUBLE_TAP": {
          return {
            nav: { highlightedIndex: idx },
            navigate: { to: "exit" },
          };
        }
        default: {
          // Voice-flow events (TRANSCRIPT, RESOLVE_RESULT, etc.) are
          // never dispatched against the Home screen; absorb them as a
          // no-op so the reducer stays total over `ScreenEvent`.
          return { nav: { highlightedIndex: idx } };
        }
      }
    },
  };

  // Optional auto-refresh of the synthetic rows + quiet-hours flag.
  // Wired via `options` (in `main.ts`) rather than reaching into the
  // cache modules directly, so the Home screen stays pure-testable:
  // tests can omit `options` entirely and the screen never ticks.
  //
  // All three refreshers fire in parallel on each tick so the rows
  // update together. If any rejects the corresponding field is
  // preserved (rather than blanked) — a transient network blip
  // should NOT make a row disappear or flip quiet hours.
  const refreshLines = options?.refreshAffectedLines;
  const refreshAccess = options?.refreshAccessOutageCount;
  const refreshQuiet = options?.refreshQuietHours;
  const refreshEtas = options?.refreshFavoriteEtas;
  if (
    (refreshLines || refreshAccess || refreshQuiet || refreshEtas) &&
    (options?.tickIntervalMs ?? 0) > 0
  ) {
    screen.tick = async (snapshot: HomeSnapshot): Promise<HomeSnapshot> => {
      const [linesResult, accessResult, quietResult, etasResult] =
        await Promise.allSettled([
          refreshLines
            ? refreshLines()
            : Promise.resolve(snapshot.affectedLines),
          refreshAccess
            ? refreshAccess()
            : Promise.resolve(snapshot.accessOutageCount),
          refreshQuiet
            ? refreshQuiet()
            : Promise.resolve(snapshot.quietHours),
          refreshEtas
            ? refreshEtas()
            : Promise.resolve(snapshot.favoriteEtas),
        ]);

      const nextLines =
        linesResult.status === "fulfilled"
          ? linesResult.value
          : snapshot.affectedLines;
      const nextAccess =
        accessResult.status === "fulfilled"
          ? accessResult.value
          : snapshot.accessOutageCount;
      const nextQuiet =
        quietResult.status === "fulfilled"
          ? quietResult.value
          : snapshot.quietHours;
      const nextEtas =
        etasResult.status === "fulfilled"
          ? etasResult.value
          : snapshot.favoriteEtas;

      const linesUnchanged = sameLines(nextLines, snapshot.affectedLines);
      const accessUnchanged = nextAccess === snapshot.accessOutageCount;
      const quietUnchanged = nextQuiet === snapshot.quietHours;
      const etasUnchanged = sameEtas(nextEtas, snapshot.favoriteEtas);
      if (
        linesUnchanged &&
        accessUnchanged &&
        quietUnchanged &&
        etasUnchanged
      ) {
        return snapshot;
      }

      return {
        ...snapshot,
        affectedLines: linesUnchanged ? snapshot.affectedLines : nextLines,
        accessOutageCount: accessUnchanged
          ? snapshot.accessOutageCount
          : nextAccess,
        quietHours: quietUnchanged ? snapshot.quietHours : nextQuiet,
        favoriteEtas: etasUnchanged ? snapshot.favoriteEtas : nextEtas,
      };
    };
    screen.tickIntervalMs = options!.tickIntervalMs;
  }

  return screen;
}

/**
 * Order-and-membership equality on `LineCode[]`. Used by the Home
 * tick to skip a re-render when the affected-lines set hasn't
 * changed. We compare by *set* membership rather than identity so a
 * fresh array literal with the same contents is a no-op.
 */
function sameLines(a: readonly LineCode[], b: readonly LineCode[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set<LineCode>(a);
  for (const c of b) if (!seen.has(c)) return false;
  return true;
}

/**
 * Key-and-value equality on the favorite-ETA map. Used by the Home tick
 * to skip a re-render when no ETA actually changed (the common case at
 * the 60s cadence between trains). Compares both directions so a key
 * appearing or disappearing counts as a change; values compare with
 * `===` (string tokens or `null`).
 */
function sameEtas(
  a: Record<string, string | null>,
  b: Record<string, string | null>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    // A key in `a` but absent in `b` → `b[k]` is undefined, which !==
    // any string-or-null value in `a`, so this correctly flags a diff.
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}
