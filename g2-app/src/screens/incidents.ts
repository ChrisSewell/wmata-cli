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
  scrollWindowWithMarkers,
  textWidth,
  truncate,
} from "../ui/render";
import {
  HEADER_CONTENT_WIDTH_PX,
  SECTION_INNER_WIDTH_PX,
  TWO_BODY_MAX_LINES,
} from "../ui/geometry";
import { lineGlyph, lineName } from "../ui/format";
import { parseLinesAffected } from "../wmata/incidents-cache";
import type { LineCode, RailIncident } from "../wmata";
import type {
  FavoriteStation,
} from "../storage/settings";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ScreenSections,
  ViewContext,
} from "./router";

// The canonical HUD clock formatter now lives in `../ui/format` (the host
// renders it in its own dedicated top-right container). Re-export it here
// so existing `import { formatClock } from "./incidents"` call sites
// (notably the test suite) keep resolving.
export { formatClock } from "../ui/format";

// ---------------------------------------------------------------------------
// Column / row budgets
// ---------------------------------------------------------------------------

/** Two-column gutter that precedes every body row (no selection prefix). */
const INDENT = "  ";

/**
 * Pixel-width budget for the affected-lines glyph row. It carries the
 * 2-space section gutter only, so it gets the body inner width minus that
 * gutter before the LVGL container would hard-wrap.
 */
const GLYPH_ROW_WIDTH_PX = SECTION_INNER_WIDTH_PX - textWidth(INDENT);

/**
 * Inner inset (extra indent) applied to description rows so they read as
 * detail nested under the affected-lines header.
 */
const DESC_INSET = "  ";

/**
 * Pixel-width budget for a wrapped description line. A description line
 * carries BOTH the section gutter (added by `flattenBlocks`) AND the
 * inner inset (added in `formatIncidentBlock`), so we wrap at the body
 * inner width minus both — keeping indent + text within the container.
 */
const DESC_TEXT_WIDTH_PX =
  SECTION_INNER_WIDTH_PX - textWidth(INDENT) - textWidth(DESC_INSET);

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
   * Number of consecutive `tick()` failures since the last successful
   * fetch. Reset to 0 on success. Drives the 3-state header marker
   * (`*` → `**` → `?`) — see `stalenessMarker` below. Mirrors the
   * same field on `PredictionsSnapshot` so both screens degrade with
   * the same UX vocabulary.
   */
  consecutiveFetchFailures: number;
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
 * Word-break-only text wrap, measured in PIXELS. Port of
 * `wmata/cli/incidents.py:13` `_wrap`, with the fit test swapped from
 * character count to real glyph width.
 *
 * Strategy:
 *   - Split the input on runs of whitespace.
 *   - Greedily pack words into lines of at most `maxPx` pixels,
 *     separated by single spaces.
 *   - If a single word is wider than `maxPx`, hard-break it across as
 *     many lines as needed, each ending with `…` to flag the cut.
 *
 * Returns `[]` for empty input — callers can branch on `length === 0`
 * to drop the description block entirely.
 */
export function wrap(text: string, maxPx: number): string[] {
  if (!text) return [];
  if (maxPx <= 0) return [];
  const fits = (s: string): boolean => textWidth(s) <= maxPx;
  // Degenerate: if not even a continuation ellipsis fits, bail rather
  // than spin the hard-break loop forever.
  if (!fits(ELLIPSIS)) return [];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // Hard-break an oversize word into prefix + "…" chunks. The
    // continuation marker uses our canonical ELLIPSIS so the user can
    // tell it was a forced cut rather than a natural word boundary.
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
 * (e.g. "...disabled train," → "...disabled train"). Only the FINAL
 * emitted line of a fragment should be passed through this — interior
 * lines keep their punctuation.
 */
export function trimTrailingSeparators(text: string): string {
  return text.replace(/[\s,;.]+$/, "");
}

/**
 * Cap a list of wrapped description lines at `MAX_DESC_LINES`. If the
 * input is longer, the final visible line is truncated with `…` so the
 * user can tell that text was cut.
 *
 * When the text fits within the cap, the final line gets its dangling
 * sentence separator trimmed so the description doesn't look cut off
 * mid-clause. When the text is truncated we append `…` instead (the
 * ellipsis already signals "more was cut", so no separator-trim there).
 */
export function capDescription(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  if (lines.length <= MAX_DESC_LINES) {
    const out = lines.slice();
    const lastIdx = out.length - 1;
    const last = out[lastIdx]!;
    // Don't disturb a line the wrapper hard-broke (it ends with `…`).
    if (!last.endsWith(ELLIPSIS)) {
      out[lastIdx] = trimTrailingSeparators(last);
    }
    return out;
  }
  const out = lines.slice(0, MAX_DESC_LINES);
  const last = out[MAX_DESC_LINES - 1] ?? "";
  // Only append the ellipsis if the line doesn't already end with it
  // (e.g. when wrap() already hard-broke a long word). Trim any dangling
  // separator first so we emit "word…" rather than "word,…".
  if (!last.endsWith(ELLIPSIS)) {
    const trimmed = trimTrailingSeparators(last);
    out[MAX_DESC_LINES - 1] =
      textWidth(trimmed + ELLIPSIS) <= DESC_TEXT_WIDTH_PX
        ? trimmed + ELLIPSIS
        : truncate(trimmed, DESC_TEXT_WIDTH_PX);
  }
  return out;
}

/**
 * Render the comma-joined line-glyphs row for an incident.
 *
 *   ["RD","BL","OR"]              -> "! RD BL OR"
 *   ["RD","BL","YL","OR","GR"]    -> "! RD BL YL OR +1"
 *   []                            -> "--"
 *
 * No leading "! " glyph — the bordered ALERTS section is itself the
 * "this is an alert" visual signal, and the screen title already
 * says ALERTS. The affected-lines row reads as a clean header.
 */
export function renderGlyphRow(lines: readonly LineCode[]): string {
  const safe = lines
    .map((l) => lineGlyph(l))
    .filter((g) => g !== "--")
    .map((g) => lineName(g));
  if (safe.length === 0) return "--";
  if (safe.length <= MAX_VERBATIM_LINES) {
    const verbatim = safe.join(" ");
    if (textWidth(verbatim) <= GLYPH_ROW_WIDTH_PX) return verbatim;
  }
  // Either we hit the verbatim cap OR the joined names overflow the
  // body cell. Collapse with `+N`, taking as many full names as fit.
  for (let take = MAX_VERBATIM_LINES; take >= 1; take--) {
    const head = safe.slice(0, take).join(" ");
    const extra = safe.length - take;
    const candidate = extra > 0 ? `${head} +${extra}` : head;
    if (textWidth(candidate) <= GLYPH_ROW_WIDTH_PX) return candidate;
  }
  return truncate(safe[0]!, GLYPH_ROW_WIDTH_PX);
}

/**
 * Pre-format one incident into the block of body rows it will occupy:
 *
 *   ["RD BL OR", "  Single-tracking between Foggy Bottom and", "  Rosslyn …"]
 *
 * The glyph row gets no leading indent (it's the affected-lines
 * header). Description rows get a 2-char leading indent so they
 * read as detail nested under the header. `flattenBlocks` adds a
 * further 2-char gutter at the section edge, so the visual result
 * is:
 *
 *     RD BL OR                       <- header indent 2
 *       Single-tracking between …    <- description indent 4
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
  // Wrap the description at DESC_TEXT_WIDTH (= SAFE_TEXT_WIDTH - section
  // gutter - inner inset) so that, once `flattenBlocks` prepends the
  // 2-col gutter and we prepend the 2-col inset here, no rendered line
  // exceeds SAFE_TEXT_WIDTH real chars — the point past which the LVGL
  // container re-wraps and dumps orphan words at column 0.
  const wrapped = capDescription(wrap(desc, DESC_TEXT_WIDTH_PX));
  return [glyphRow, ...wrapped.map((l) => DESC_INSET + l)];
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
 * Map (staleness × fetch-failure-count) onto a 3-state header marker.
 *
 * Identical contract to `stalenessMarker` in `predictions.ts`:
 *
 *   - `""`   — fresh, 0 failures.
 *   - `"*"`  — stale by time only OR 1 failure since last success.
 *   - `"**"` — 2 consecutive failures.
 *   - `"?"`  — ≥ 3 consecutive failures, OR no successful fetch ever
 *              with an active error.
 *
 * Exported for the test suite.
 */
export function stalenessMarker(
  snapshot: IncidentsSnapshot,
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
 *   "ALERTS (n)"   (n > 0)
 *   "ALERTS"       (n === 0, empty state)
 *
 * The host now renders the wall clock + staleness marker in its own
 * dedicated top-right container (identically on every screen), so the
 * header no longer embeds the clock or marker. The marker is surfaced
 * via `view()`'s `clockMarker` field. The title is truncated so it can't
 * collide with the clock container (which starts at column ≈ 50). The
 * left text collapses to a bare "ALERTS" when there are no incidents
 * (we don't render "ALERTS (0)" — it looks like a button label).
 */
export function renderHeader(snapshot: IncidentsSnapshot): string {
  const count = snapshot.incidents.length;
  const left = count > 0 ? `ALERTS (${count})` : "ALERTS";
  return truncate(left, HEADER_CONTENT_WIDTH_PX);
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
    // A fresh-from-cache snapshot has no failure history of its own.
    // The cache's own `fetchError` field captures the LAST attempt;
    // the host-tick counter starts at zero per-screen-mount.
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
    view(snapshot, nav, ctx: ViewContext): ScreenSections {
      const header: string[] = [renderHeader(snapshot)];
      const body: string[] = [];
      // Staleness marker rides in the host's top-right clock container
      // (via `clockMarker`), no longer the header string. `ctx.nowMs`
      // drives the time-based stale check on every 1Hz clock re-render.
      const clockMarker = stalenessMarker(snapshot, ctx.nowMs);

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
        body.push(truncate("Couldn't reach WMATA. Will retry shortly.", SECTION_INNER_WIDTH_PX));
        body.push("");
        body.push(truncate("(double-tap to return)", SECTION_INNER_WIDTH_PX));
        return { header, body, clockMarker };
      }

      if (snapshot.incidents.length === 0) {
        // All-clear copy: a positive statement reads better than
        // "No active alerts on your lines." — the full-width body lets
        // the whole sentence sit on one line.
        body.push(truncate("All your lines running normally.", SECTION_INNER_WIDTH_PX));
        body.push("");
        body.push(truncate("(double-tap to return)", SECTION_INNER_WIDTH_PX));
        return { header, body, clockMarker };
      }

      // Body: flatten the pre-formatted blocks and scroll within the
      // body's row budget. Edge markers (▴/▾) consume from that budget;
      // `scrollWindowWithMarkers` resolves the circularity (markers
      // shrink the window which can then need fewer markers) with a tiny
      // fixed-point so we don't reinvent it per-screen.
      const flat = flattenBlocks(snapshot.preformatted);
      const offset = clamp(nav.highlightedIndex, Math.max(0, flat.length - 1));
      const decorated = scrollWindowWithMarkers(flat, offset, TWO_BODY_MAX_LINES);
      for (const r of decorated) body.push(truncate(r, SECTION_INNER_WIDTH_PX));
      return { header, body, clockMarker };
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
     *
     * Tracks `consecutiveFetchFailures` for the 3-state header marker.
     * The fetcher's own `fetchError` is treated as a failure (the
     * cache layer swallows network errors and surfaces them through
     * the result shape rather than throwing), so a result with
     * `fetchError !== null` still bumps the counter.
     */
    async tick(snapshot: IncidentsSnapshot): Promise<IncidentsSnapshot> {
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
        // The injected fetcher (the cache module) shouldn't throw, but
        // if it does we still want to keep the prior incidents visible
        // rather than blanking the HUD.
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
