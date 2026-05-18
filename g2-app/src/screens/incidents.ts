// Incidents screen — a read-only, scrollable list of active rail
// incidents on lines the user follows.
//
// Layout (24 cols × up to 7 usable body rows + 1 header row):
//
//   col:   0         1         2
//   col:   0123456789012345678901234
//          ALERTS (3)         14:32
//            ! RD BL OR
//            Single-tracking
//            between Foggy Btm
//            and Rosslyn due to
//            disabled train.
//          ▾
//
// Empty state (zero incidents matching user's lines):
//
//          ALERTS             14:32
//          No active alerts on
//          your lines.
//
//          (double-tap to return)
//
// Wrapping budget for a body row:
//   - 2 cols   prefix gutter (always two spaces; the screen is read-only
//              so there's no per-row selection chrome)
//   - 22 cols  glyph block / wrapped description text
//   = 24 cols total
//
// Selection model:
//   - SCROLL_UP / SCROLL_DOWN advance a SCROLL OFFSET (not a row
//     highlight — there's nothing to select). We reuse
//     `NavState.highlightedIndex` to carry that offset so we don't have
//     to grow the router contract.
//   - TAP is a no-op.
//   - DOUBLE_TAP returns to Home (this is a leaf screen, never an
//     exit).
//
// PURITY: This module has no SDK imports and does no I/O. The host
// (`glasses-host.ts`) drives the tick interval; the screen's `tick()`
// calls the injected `fetcher`, which is wired in `main.ts` to the
// shared `refreshIncidents` cache so Home + Incidents don't double-
// fetch.

import {
  ELLIPSIS,
  LINE_WIDTH,
  USABLE_ROWS,
  scrollWindowWithMarkers,
  truncate,
} from "../ui/render";
import { lineGlyph } from "../ui/format";
import { parseLinesAffected } from "../wmata/incidents-cache";
import type { LineCode, RailIncident } from "../wmata";
import type {
  FavoriteStation,
} from "../storage/settings";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";

// ---------------------------------------------------------------------------
// Column / row budgets
// ---------------------------------------------------------------------------

/** Two-column gutter that precedes every body row (no selection prefix). */
const INDENT = "  ";
/** Usable text width inside a body row, after the 2-col gutter. */
const BODY_TEXT_WIDTH = LINE_WIDTH - INDENT.length; // 22

/** Maximum number of wrapped description lines per incident. */
export const MAX_DESC_LINES = 6;

/** Maximum number of raw line codes shown before the `+N` overflow. */
const MAX_VERBATIM_LINES = 4;

/**
 * Wall-clock age (ms) after which a snapshot is considered stale.
 *
 * Incidents update much less frequently than predictions — the WMATA
 * Incidents endpoint changes on the order of minutes, not seconds — so
 * 2 minutes is the right threshold here rather than the predictions
 * screen's 60s.
 */
export const STALE_THRESHOLD_MS = 120_000;

/** Auto-refresh cadence handed back to the host via `tickIntervalMs`. */
export const TICK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Snapshot + fetcher contract
// ---------------------------------------------------------------------------

/** Fields a `fetcher()` is expected to fill in on every refresh. */
export interface IncidentsFetchResult {
  incidents: RailIncident[];
  fetchedAt: number;
  fetchError: string | null;
}

/** Data the Incidents screen renders against. */
export interface IncidentsSnapshot {
  /** Already filtered upstream to the user's followed lines. */
  incidents: RailIncident[];
  /** Epoch-ms when the cache was last successfully refreshed; 0 = never. */
  fetchedAt: number;
  /** Last fetch error message; null when the most recent fetch succeeded. */
  fetchError: string | null;
  /**
   * Pre-wrapped, ready-to-render body rows for the current `incidents`.
   * Each top-level array is one incident's lines (glyph row + wrapped
   * description lines), with a blank-string separator between incidents
   * flattened in by `flattenBlocks` at render time.
   *
   * Pre-wrapping at tick time keeps the per-frame render cheap (no
   * text-wrap math on the 1Hz clock tick).
   */
  preformatted: string[][];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * Word-break-only text wrap. Port of `wmata/cli/incidents.py:13` `_wrap`.
 *
 * Strategy:
 *   - Split the input on runs of whitespace.
 *   - Greedily pack words into lines of at most `width` columns,
 *     separated by single spaces.
 *   - If a single word is wider than `width`, hard-break it across as
 *     many lines as needed, each ending with `…` to flag the cut.
 *
 * Returns `[]` for empty input — callers can branch on `length === 0`
 * to drop the description block entirely.
 */
export function wrap(text: string, width: number): string[] {
  if (!text) return [];
  if (width <= 0) return [];
  // Degenerate single-column wraps are not supported: the hard-break
  // branch would do `slice(0, 0)` -> "" and `slice(0)` -> the same
  // string, looping forever. Callers always pass BODY_TEXT_WIDTH = 22,
  // so a safe-return-empty here is the right semantics — throwing
  // would be more disruptive (it'd surface as a render crash).
  if (width <= 1) return [];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // Hard-break an oversize word into width-1 + "…" chunks. The
    // continuation marker uses our canonical ELLIPSIS so the user can
    // tell it was a forced cut rather than a natural word boundary.
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

/**
 * Cap a list of wrapped description lines at `MAX_DESC_LINES`. If the
 * input is longer, the final visible line is truncated with `…` so the
 * user can tell that text was cut.
 */
export function capDescription(lines: readonly string[]): string[] {
  if (lines.length <= MAX_DESC_LINES) return lines.slice();
  const out = lines.slice(0, MAX_DESC_LINES);
  const last = out[MAX_DESC_LINES - 1] ?? "";
  // Only append the ellipsis if the line doesn't already end with it
  // (e.g. when wrap() already hard-broke a long word).
  if (!last.endsWith(ELLIPSIS)) {
    if (last.length < BODY_TEXT_WIDTH) {
      out[MAX_DESC_LINES - 1] = last + ELLIPSIS;
    } else {
      out[MAX_DESC_LINES - 1] = last.slice(0, BODY_TEXT_WIDTH - 1) + ELLIPSIS;
    }
  }
  return out;
}

/**
 * Render the comma-joined line-glyphs row for an incident.
 *
 *   ["RD","BL","OR"]              -> "! RD BL OR"
 *   ["RD","BL","YL","OR","GR"]    -> "! RD BL YL OR +1"
 *   []                            -> "! --"
 *
 * The `! ` warning prefix sits inside the 22-column body-text budget
 * (so prefix + indent gutter still = 24 cols).
 */
export function renderGlyphRow(lines: readonly LineCode[]): string {
  const safe = lines.map((l) => lineGlyph(l)).filter((g) => g !== "--");
  if (safe.length === 0) return "! --";
  if (safe.length <= MAX_VERBATIM_LINES) {
    return truncate("! " + safe.join(" "), BODY_TEXT_WIDTH);
  }
  const head = safe.slice(0, MAX_VERBATIM_LINES).join(" ");
  const extra = safe.length - MAX_VERBATIM_LINES;
  return truncate(`! ${head} +${extra}`, BODY_TEXT_WIDTH);
}

/**
 * Pre-format one incident into the block of body rows it will occupy:
 *
 *   ["! RD BL OR", "Single-tracking", "between Foggy Btm", ...]
 *
 * No leading indent — the renderer adds the 2-col gutter at flatten time
 * so the same block can be sliced for scroll math without re-indenting.
 *
 * Empty-description incidents collapse to a single row (the glyphs).
 */
export function formatIncidentBlock(incident: RailIncident): string[] {
  // We import `parseLinesAffected` from the cache module rather than
  // re-implementing it here. The cache's runtime imports are clean
  // (a constant, an error class, and types), so the screen module
  // stays pure — no SDK or network code is pulled in transitively.
  const lines = parseLinesAffected(incident.LinesAffected ?? "");
  const glyphRow = renderGlyphRow(lines);
  const desc = (incident.Description ?? "").trim();
  if (desc.length === 0) return [glyphRow];
  const wrapped = capDescription(wrap(desc, BODY_TEXT_WIDTH));
  return [glyphRow, ...wrapped];
}

/**
 * Flatten a list of incident blocks into a single body-row list, with
 * a blank-string separator between consecutive incidents. The 2-col
 * gutter is added here too so the result is directly renderable.
 */
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

/**
 * Format an epoch-ms timestamp as a 24-hour "HH:MM" string.
 * Identical helper to the Predictions screen's `formatClock`.
 */
export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "--:--";
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * True when the snapshot's last-known fetch is older than
 * `STALE_THRESHOLD_MS` (or has never succeeded). Same shape as the
 * Predictions screen's `isStale` but with a longer threshold because
 * incidents change on the order of minutes.
 */
export function isStale(snapshot: IncidentsSnapshot, nowMs: number): boolean {
  if (snapshot.fetchedAt <= 0) return true;
  return nowMs - snapshot.fetchedAt > STALE_THRESHOLD_MS;
}

/**
 * Render the header row.
 *
 *   "ALERTS (n)              HH:MM"   (n > 0)
 *   "ALERTS                  HH:MM"   (n === 0, empty state)
 *
 * Adds a `*` after the clock when stale. The text on the left collapses
 * to a single "ALERTS" when there are no incidents (we don't want to
 * render "ALERTS (0)" — it looks like a button label).
 */
export function renderHeader(
  snapshot: IncidentsSnapshot,
  nowMs: number,
): string {
  const count = snapshot.incidents.length;
  const left = count > 0 ? `ALERTS (${count})` : "ALERTS";
  const stale = isStale(snapshot, nowMs);
  const clockStr = formatClock(nowMs);
  const marker = stale ? "*" : "";
  const clockCell = clockStr + marker;
  // total = left + spaces + clockCell == LINE_WIDTH
  const spaces = Math.max(1, LINE_WIDTH - left.length - clockCell.length);
  const composed = left + " ".repeat(spaces) + clockCell;
  // Defensive truncate — a future change that grows the left cell
  // beyond budget will be cut at the right edge rather than overflowing.
  return truncate(composed, LINE_WIDTH);
}

// ---------------------------------------------------------------------------
// Snapshot helpers — exported for main.ts wiring
// ---------------------------------------------------------------------------

/**
 * Collect the unique `LineCode` values across the user's favorites.
 * Used to scope the incidents fetch to just the lines that matter.
 */
export function computeUserLines(
  favorites: readonly FavoriteStation[],
): LineCode[] {
  const seen = new Set<LineCode>();
  for (const fav of favorites) {
    for (const code of fav.lines) {
      if (!seen.has(code)) seen.add(code);
    }
  }
  return Array.from(seen);
}

/**
 * Build the initial snapshot from a cached `CachedIncidents` shape. Pre-
 * formats the blocks so the very first render doesn't have to wait on
 * the first tick. (If the cache is empty, the empty-state branch
 * handles the layout instead.)
 */
export function makeInitialIncidentsSnapshot(cache: {
  incidents: RailIncident[];
  fetchedAt: number;
  fetchError: string | null;
}): IncidentsSnapshot {
  return {
    incidents: cache.incidents.slice(),
    fetchedAt: cache.fetchedAt,
    fetchError: cache.fetchError,
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

/**
 * Build the Incidents screen.
 *
 * `fetcher` is injected so the screen stays pure-testable (no SDK, no
 * `WmataClient`). The host calls `tick` on mount and on the
 * `tickIntervalMs` cadence; `tick` invokes `fetcher` and folds the
 * result (or error) into a new snapshot, then re-renders.
 */
export function makeIncidentsScreen(
  fetcher: () => Promise<IncidentsFetchResult>,
  initialSnapshot: IncidentsSnapshot,
): Screen<IncidentsSnapshot> & {
  tick: (snapshot: IncidentsSnapshot) => Promise<IncidentsSnapshot>;
  tickIntervalMs: number;
} {
  return {
    name: "incidents",
    init: () => initialSnapshot,
    view(snapshot, nav, ctx: ViewContext): string[] {
      const lines: string[] = [];
      lines.push(renderHeader(snapshot, ctx.nowMs));

      // Empty-data branches:
      //   - first-load fetch error (no successful fetch yet) — surface
      //     a "Couldn't reach WMATA" line so the user knows it isn't
      //     just "no incidents".
      //   - genuinely empty list — friendly empty-state copy.
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
        lines.push(truncate("No active alerts on", LINE_WIDTH));
        lines.push(truncate("your lines.", LINE_WIDTH));
        lines.push("");
        lines.push(truncate("(double-tap to return)", LINE_WIDTH));
        return lines;
      }

      // Body: flatten the pre-formatted blocks and scroll within the
      // USABLE_ROWS budget. Edge markers (▴/▾) consume from that
      // budget; `scrollWindowWithMarkers` resolves the circularity
      // (markers shrink the window which can then need fewer markers)
      // with a tiny fixed-point so we don't reinvent it per-screen.
      const body = flattenBlocks(snapshot.preformatted);
      const offset = clamp(nav.highlightedIndex, Math.max(0, body.length - 1));
      const decorated = scrollWindowWithMarkers(body, offset, USABLE_ROWS);
      for (const r of decorated) lines.push(truncate(r, LINE_WIDTH));
      return lines;
    },
    reduce(snapshot, nav, event: ScreenEvent): ReduceResult<IncidentsSnapshot> {
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
          // Voice-flow events (TRANSCRIPT, RESOLVE_RESULT, etc.) are
          // never dispatched against the Incidents screen; absorb them
          // as a no-op so the reducer stays total over `ScreenEvent`.
          return { nav: { highlightedIndex: offset } };
      }
    },
    /**
     * Refresh the snapshot from the injected fetcher. Never throws —
     * fetch errors land in `fetchError`. On success the pre-formatted
     * blocks are rebuilt so subsequent renders stay cheap.
     */
    async tick(snapshot: IncidentsSnapshot): Promise<IncidentsSnapshot> {
      try {
        const result = await fetcher();
        return {
          incidents: result.incidents,
          fetchedAt: result.fetchedAt,
          fetchError: result.fetchError,
          preformatted: result.incidents.map(formatIncidentBlock),
        };
      } catch (err) {
        // The injected fetcher (the cache module) shouldn't throw, but
        // if it does we still want to keep the prior incidents visible
        // rather than blanking the HUD.
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
