// Home screen — the first thing the user sees on the glasses.
//
// Layout (24 columns x up to 8 rendered rows: 1 header + up to 7 body):
//
//   col: 0         1         2
//   col: 0123456789012345678901234
//        WMATA — Favorites (3/5)
//        > Metro Ctr  RD BL OR SV
//          Gallery Pl RD YL GR
//          Union Stn  RD
//          VOICE LOOKUP
//
// Empty state (no favorites): exactly 4 rendered lines —
//   1. header                ("WMATA — Favorites (0/5)")
//   2. "No favorites yet."
//   3. "Open phone to add."
//   4. VOICE LOOKUP row (with the highlight prefix)
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

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Data the Home screen renders against. */
export interface HomeSnapshot {
  favorites: FavoriteStation[];
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
 * The flat list of selectable rows. We treat "VOICE LOOKUP" as a real
 * row in the navigation model so SCROLL_DOWN can land on it.
 *
 * Index conventions:
 *   - 0..favorites.length-1  ->  the favorites
 *   - favorites.length       ->  the voice-lookup row
 */
export function rowCount(snapshot: HomeSnapshot): number {
  return snapshot.favorites.length + 1;
}

/**
 * True if `index` points at the voice-lookup synthetic row.
 */
export function isVoiceIndex(snapshot: HomeSnapshot, index: number): boolean {
  return index === snapshot.favorites.length;
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
 */
export function makeHomeScreen(
  loader: () => HomeSnapshot,
): Screen<HomeSnapshot> {
  return {
    name: "home",
    init: loader,
    view(snapshot, nav) {
      // Defensive clamp: if a future migration / data-corruption bug
      // hands us more than MAX_FAVORITES, render only the first slice
      // rather than throwing or producing an oversized list. The same
      // clamp is applied in `reduce()` via `rowCount`/`isVoiceIndex`,
      // both of which call through `clampedSnapshot()`.
      const clamped = clampedSnapshot(snapshot);
      const lines: string[] = [];
      lines.push(renderHeader(clamped.favorites.length));

      if (clamped.favorites.length === 0) {
        // Empty state — exactly 4 rendered lines:
        //   header + "No favorites yet." + "Open phone to add." + voice
        // The voice-lookup row is at index 0 in this state.
        lines.push(truncate("No favorites yet.", LINE_WIDTH));
        lines.push(truncate("Open phone to add.", LINE_WIDTH));
        lines.push(renderVoiceRow(nav.highlightedIndex === 0));
        return lines;
      }

      const total = rowCount(clamped);
      const idx = clampIndex(nav.highlightedIndex, total);
      for (let i = 0; i < clamped.favorites.length; i++) {
        const fav = clamped.favorites[i]!;
        lines.push(renderFavoriteRow(fav, idx === i));
      }
      lines.push(renderVoiceRow(idx === clamped.favorites.length));
      return lines;
    },
    reduce(snapshot, nav, event): ReduceResult {
      const clamped = clampedSnapshot(snapshot);
      const total = rowCount(clamped);
      const idx = clampIndex(nav.highlightedIndex, total);
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
          const fav = clamped.favorites[idx];
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
      }
    },
  };
}
