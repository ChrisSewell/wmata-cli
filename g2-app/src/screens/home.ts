// Home screen — the first thing the user sees on the glasses.
//
// Layout (24 columns x up to 8 rendered rows: 1 header + up to 7 body):
//
//   col: 0         1         2
//   col: 0123456789012345678901234
//        WMATA — Favorites (3/5)
//        > RD!BL YL OR!GR SV
//          Metro Ctr  RD BL OR SV
//          Gallery Pl RD YL GR
//          Union Stn  RD
//          VOICE LOOKUP
//
// The status glyph row only appears when at least one line the user
// follows has an active incident. When visible, it sits ABOVE the
// favorites (the v1.1 behaviour put a count row BELOW favorites; v1.2
// promotes the row to a denser per-line status display at the top of
// the list because that's the surface users peek at first). TAP on it
// still navigates to the Incidents screen. The 6 line codes (RD BL YL
// OR GR SV) are always rendered in the same column positions; a
// trailing `!` on a code means "this line has an active incident".
//
// Empty state (no favorites): exactly 4 rendered lines —
//   1. header                ("WMATA — Favorites (0/5)")
//   2. "No favorites yet."
//   3. "Open phone to add."
//   4. VOICE LOOKUP row (with the highlight prefix)
//
// (The status row, when present, ALSO appears above the help text in
// the empty-state layout — but the empty-state count-of-lines
// assertion in the test suite uses fixtures where `affectedLines` is
// empty, so the line count stays at exactly 4.)
//
// The empty-state line count is locked at 4 by an assertion in the
// home.test.ts suite (per the WP6 Reviewer's "lock per-screen line
// counts to exact integers" pattern). Drift will fail CI.
//
// Width budget after the 2-char highlight prefix (`> ` or `  `):
//   - 10 cols for the abbreviated station name
//   - 1  col spacer
//   - up to 11 cols for line codes ("RD BL OR SV" or "RD BL OR +N")
//   - = 22 cols + 2-char prefix = 24 cols total
//
// Line codes overflow rule: at most 4 raw codes are shown verbatim
// ("RD BL OR SV" = 11 cols exactly). 5+ codes collapse the tail into
// a `+N` suffix ("RD BL OR +1" = 11 cols). The actual WMATA network
// only exposes 6 distinct line codes total, so N is single-digit by
// construction; we still defensively truncate if a caller hands us
// nonsense.
//
// PURITY: This module has NO SDK imports and does no DOM access. The
// glasses host (`glasses-host.ts`) is responsible for everything that
// touches the bridge. That keeps `view` and `reduce` Vitest-friendly.

import type { FavoriteStation } from "../storage/settings";
import { MAX_FAVORITES } from "../storage/settings";
import type { LineCode } from "../wmata";
import { LINE_WIDTH, highlightPrefix, padRight, truncate } from "../ui/render";
import { abbreviateStation } from "../ui/format";
import type { ReduceResult, Screen } from "./router";

// ---------------------------------------------------------------------------
// Column budget constants (single source of truth for the 24-col grid)
// ---------------------------------------------------------------------------

/** Width of the highlight prefix ("> " or "  ") in characters. */
const PREFIX_WIDTH = 2;
/**
 * Width of the abbreviated-station-name cell. Exported so that other
 * modules (e.g. tests that audit the station-abbreviation map) can refer
 * to the canonical budget rather than hard-coding `10`.
 */
export const NAME_WIDTH = 10;
/** Width of the lines-suffix cell. */
const LINES_WIDTH = LINE_WIDTH - PREFIX_WIDTH - NAME_WIDTH - 1; // = 11
/** Maximum number of raw line codes shown verbatim before we collapse to `+N`. */
const MAX_VERBATIM_LINES = 4;

/** Label rendered for the synthetic voice-lookup row. */
export const VOICE_LABEL = "VOICE LOOKUP";

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
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * Render the line-codes cell for a favorite. At most `MAX_VERBATIM_LINES`
 * codes are shown verbatim; the remainder collapses into `+N`.
 *
 * Examples (LINES_WIDTH = 11):
 *   ["RD"]                       -> "RD"
 *   ["RD","BL","OR"]             -> "RD BL OR"      (8 chars)
 *   ["RD","BL","OR","SV"]        -> "RD BL OR SV"   (11 chars — at width)
 *   ["RD","BL","YL","OR","GR"]   -> "RD BL OR +2"   (11 chars)
 *
 * For 5+ lines we drop to 3 verbatim codes ("RD BL OR" = 8 chars) + a
 * " +N" suffix (≤ 3 chars). That stays within the 11-col cell even when
 * N is double-digit. With only 6 line codes in the real WMATA network
 * N is always single-digit; the truncate at the end is a paranoia
 * guard for malformed input.
 */
export function renderLinesSuffix(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  if (lines.length <= MAX_VERBATIM_LINES) {
    return lines.join(" ");
  }
  const head = lines.slice(0, MAX_VERBATIM_LINES - 1).join(" "); // 3 codes = 8 chars
  const extra = lines.length - (MAX_VERBATIM_LINES - 1);
  const candidate = `${head} +${extra}`;
  if (candidate.length <= LINES_WIDTH) return candidate;
  return truncate(candidate, LINES_WIDTH);
}

/**
 * Build a single favorite row, including the highlight prefix.
 * Guarantees `result.length <= LINE_WIDTH`.
 */
export function renderFavoriteRow(
  fav: FavoriteStation,
  isHighlighted: boolean,
): string {
  const prefix = highlightPrefix(isHighlighted);
  const name = padRight(abbreviateStation(fav.name, NAME_WIDTH), NAME_WIDTH);
  const lines = padRight(renderLinesSuffix(fav.lines), LINES_WIDTH);
  // prefix(2) + name(10) + " "(1) + lines(11) = 24 exactly.
  return prefix + name + " " + lines;
}

/** Build the always-present "VOICE LOOKUP" row. */
export function renderVoiceRow(isHighlighted: boolean): string {
  // "> VOICE LOOKUP" is 14 chars; well under 24. No trailing pad — the
  // physical panel does not care about right-padding for monospace rows,
  // and shorter strings serialise less data over the bridge.
  return highlightPrefix(isHighlighted) + VOICE_LABEL;
}

/**
 * Build the per-line status glyph row. Six fixed-width 3-col cells,
 * one per WMATA rail line in `STATUS_ROW_LINE_ORDER`, each rendered
 * as the 2-char code followed by either `!` (line has an active
 * incident the user follows) or ` ` (clear).
 *
 * Width contract: returns exactly `LINE_WIDTH` columns.
 *
 *   prefix(2) + 6 cells × 3 chars (18) + 4 trailing pad = 24
 *
 * No leading "ALERTS" label — the bang-suffix glyphs are enough
 * signal (an "RD!" cell is visually distinct from "RD "), and trying
 * to fit a 5-char label drove the row over budget. The 4-col trailing
 * pad keeps the row exactly LINE_WIDTH regardless of how many cells
 * end with `!` vs ` `, so the visual grid stays stable across
 * renders.
 */
export function renderStatusGlyphRow(
  affected: ReadonlySet<LineCode>,
  isHighlighted: boolean,
): string {
  const prefix = highlightPrefix(isHighlighted); // 2 cols
  const cells = STATUS_ROW_LINE_ORDER.map(
    (code) => code + (affected.has(code) ? "!" : " "),
  ).join("");
  // padRight handles both the trailing pad and the (defensive)
  // truncate-on-overflow contract — a future LineCode addition would
  // truncate at the right edge rather than blowing past LINE_WIDTH.
  return padRight(prefix + cells, LINE_WIDTH);
}

/**
 * Render the title row. `WMATA — Favorites (n/5)` is 24 cols when n is a
 * single digit (it's always 0-5 by construction of MAX_FAVORITES), so
 * we don't need to truncate. We still pass it through `truncate` as a
 * belt-and-suspenders guard.
 */
export function renderHeader(favoritesCount: number): string {
  const text = `WMATA — Favorites (${favoritesCount}/5)`;
  return truncate(text, LINE_WIDTH);
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/**
 * True when the snapshot has at least one active incident on a line
 * the user follows, so the status glyph row should be rendered.
 *
 * Row position: the row sits ABOVE the favorites (the v1.1 ALERTS
 * row sat below them). Future WPs (A4 elevator) add an ACCESS peer
 * row at index 1; favorites and voice shift down accordingly.
 */
export function hasAlertsRow(snapshot: HomeSnapshot): boolean {
  return snapshot.affectedLines.length > 0;
}

/**
 * The flat list of selectable rows. The synthetic rows (status,
 * voice) are part of the navigation model so SCROLL_UP/DOWN can land
 * on them.
 *
 * Index conventions (all rows that are absent are simply skipped):
 *   - 0           (optional) status glyph row
 *   - 1..N        the favorites
 *   - N+1         the voice-lookup row
 *
 * (When the status row is absent the favorites start at 0 and the
 * voice row sits at N.)
 */
export function rowCount(snapshot: HomeSnapshot): number {
  return (hasAlertsRow(snapshot) ? 1 : 0) + snapshot.favorites.length + 1;
}

/**
 * True if `index` points at the status glyph (alerts) synthetic row.
 *
 * The row is at index 0 when present; absent → always false.
 */
export function isAlertsIndex(
  snapshot: HomeSnapshot,
  index: number,
): boolean {
  if (!hasAlertsRow(snapshot)) return false;
  return index === 0;
}

/**
 * Index where the favorites region starts. Equals 0 when the status
 * row is hidden, 1 when present. Exported so reducers / tests can
 * translate raw indices into favorite-array indices.
 */
export function favoritesOffset(snapshot: HomeSnapshot): number {
  return hasAlertsRow(snapshot) ? 1 : 0;
}

/** True if `index` points at the voice-lookup synthetic row. */
export function isVoiceIndex(snapshot: HomeSnapshot, index: number): boolean {
  return index === favoritesOffset(snapshot) + snapshot.favorites.length;
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
    tickIntervalMs?: number;
  },
): Screen<HomeSnapshot> {
  const screen: Screen<HomeSnapshot> = {
    name: "home",
    init: loader,
    // `ctx` (third param) carries the host-supplied wall clock for
    // time-sensitive UI; Home has none, so we accept-and-ignore it.
    // Prefixing with `_` quiets `noUnusedParameters` while still
    // documenting the contract for future readers.
    view(snapshot, nav, _ctx) {
      // Defensive clamp: if a future migration / data-corruption bug
      // hands us more than MAX_FAVORITES, render only the first slice
      // rather than throwing or producing an oversized list. The same
      // clamp is applied in `reduce()` via `rowCount`/`isVoiceIndex`,
      // both of which call through `clampedSnapshot()`.
      const clamped = clampedSnapshot(snapshot);
      const lines: string[] = [];
      lines.push(renderHeader(clamped.favorites.length));

      // Status row sits ABOVE everything else when any followed line
      // has an active incident. The same fixture-set is used in both
      // the empty-favorites branch and the populated branch.
      const affected = new Set<LineCode>(clamped.affectedLines);
      const showStatus = hasAlertsRow(clamped);

      if (clamped.favorites.length === 0) {
        // Empty state — exactly 4 rendered lines when there are no
        // active alerts:
        //   header + "No favorites yet." + "Open phone to add." + voice
        // When alerts are active the status row slots in above the
        // help text, bumping the total to 5.
        // NOTE: empty-state branch uses the RAW highlightedIndex (not
        // the clamped value) so that an out-of-range index renders an
        // un-highlighted row. The reducer clamps separately; this
        // preserves the WP6 contract that `view` is a pure projection
        // of (snapshot, nav) without any auto-clamping side effect.
        if (showStatus) {
          lines.push(
            renderStatusGlyphRow(affected, nav.highlightedIndex === 0),
          );
          lines.push(truncate("No favorites yet.", LINE_WIDTH));
          lines.push(truncate("Open phone to add.", LINE_WIDTH));
          lines.push(renderVoiceRow(nav.highlightedIndex === 1));
        } else {
          lines.push(truncate("No favorites yet.", LINE_WIDTH));
          lines.push(truncate("Open phone to add.", LINE_WIDTH));
          lines.push(renderVoiceRow(nav.highlightedIndex === 0));
        }
        return lines;
      }

      const total = rowCount(clamped);
      const idx = clampIndex(nav.highlightedIndex, total);
      const favOffset = favoritesOffset(clamped);
      if (showStatus) {
        lines.push(renderStatusGlyphRow(affected, isAlertsIndex(clamped, idx)));
      }
      for (let i = 0; i < clamped.favorites.length; i++) {
        const fav = clamped.favorites[i]!;
        lines.push(renderFavoriteRow(fav, idx === favOffset + i));
      }
      lines.push(renderVoiceRow(isVoiceIndex(clamped, idx)));
      return lines;
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

  // Optional auto-refresh of the affected-lines set. Wired via
  // `options` (in `main.ts`) rather than reaching into the cache
  // module directly, so the Home screen stays pure-testable: tests
  // can omit `options` entirely and the screen never ticks.
  if (options?.refreshAffectedLines && (options.tickIntervalMs ?? 0) > 0) {
    const refresh = options.refreshAffectedLines;
    screen.tick = async (snapshot: HomeSnapshot): Promise<HomeSnapshot> => {
      try {
        const next = await refresh();
        if (sameLines(next, snapshot.affectedLines)) return snapshot;
        return { ...snapshot, affectedLines: next };
      } catch {
        // Affected-lines is non-critical — swallow and keep the
        // last-known value rather than blanking the row.
        return snapshot;
      }
    };
    screen.tickIntervalMs = options.tickIntervalMs;
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
