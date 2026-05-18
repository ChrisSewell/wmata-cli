// Journey / Commute screen.
//
// Renders a glanceable summary of the user's saved origin → destination
// commute. The path itself comes from WMATA's `/Rail.svc/json/jPath`
// (same-line only); the screen falls back to a clear "not a same-
// line route" message when the user's pair spans a transfer.
//
// Layout (24 cols × up to 8 rendered rows):
//
//   col:   0         1         2
//   col:   0123456789012345678901234
//          MetroCtr→Vienna   14:32
//          RD · 8 stops
//          Est. travel: ~16 min
//          (double-tap to return)
//
// Empty state (journey not yet configured):
//
//          Journey            14:32
//          No journey saved.
//          Open phone to add.
//          (double-tap to return)
//
// Cross-line state (origin & destination on different lines — jPath
// returns []):
//
//          MetroCtr→Glnmt    14:32
//          Not a same-line
//          route. Transfer
//          required.
//          (double-tap to return)
//
// PURITY: pure view + reducer. The host injects a `fetcher` that
// resolves the path via `Session.getPath` (one-shot, cached).

import type { JourneyPlan } from "../storage/settings";
import type { PathStep } from "../wmata";
import { LINE_WIDTH, padRight, truncate } from "../ui/render";
import { abbreviateStation } from "../ui/format";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";

/** Approximate travel time per intermediate stop on the WMATA network. */
export const MINUTES_PER_STOP = 2;

/** Wall-clock age (ms) after which the snapshot is considered stale. */
export const STALE_THRESHOLD_MS = 300_000; // 5 min — path data is static

/** Auto-refresh cadence. Path data is static, so we tick once per mount. */
export const TICK_INTERVAL_MS = 0;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * What the fetcher resolves to. For a same-line journey the
 * `legs` array carries one entry; for a transfer-composed
 * journey two entries.
 */
export interface JourneyFetchResult {
  /**
   * Resolved legs. One entry per same-line segment. An empty array
   * means "not a routable journey" (the user picked a cross-line
   * pair with no transfer, or one of the legs returned empty).
   * `null` means "fetcher hasn't populated yet / network failure".
   */
  legs: PathStep[][] | null;
  /** Resolved origin station name for the header. */
  originName: string;
  /** Resolved destination station name for the header. */
  destinationName: string;
  /** Resolved transfer station name; empty when no transfer. */
  transferName: string;
  /**
   * Live next-train at the origin for the leg's lead line. `null`
   * when not pinned, fetch failed, or no train matches. WP-K
   * surfaces this as a "Next: RD 5 min" row in the body.
   */
  nextTrain: JourneyNextTrain | null;
}

/** Compact next-train summary for the origin's lead line. */
export interface JourneyNextTrain {
  /** Line code, e.g. "RD". */
  line: string;
  /** `Min` string from rail predictions ("5", "ARR", "BRD", etc). */
  min: string;
  /** Short destination name (e.g. "Glenmont"). */
  destination: string;
}

export interface JourneySnapshot {
  /** The configured journey (or empty strings if unset). */
  plan: JourneyPlan;
  /** Resolved origin / destination / transfer names. */
  originName: string;
  destinationName: string;
  transferName: string;
  /**
   * Resolved legs. One entry per same-line segment. `null` =
   * unresolved, `[]` = not routable, populated = one or two legs.
   */
  legs: PathStep[][] | null;
  /** Live next-train at origin, mirrored from the fetch result. */
  nextTrain: JourneyNextTrain | null;
  /** Epoch-ms of the last successful resolution; 0 = never. */
  fetchedAt: number;
  /** Last fetch error string, or `null` if the most recent resolve worked. */
  fetchError: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** 12-hour clock formatter (` 9:05a` / `12:32p`) — duplicated for module independence. */
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

/**
 * Render the header: `<origin>→<dest>  2:32p`. Names are
 * abbreviated to fit the 17-col budget shared with the clock cell.
 * If the plan is unconfigured, the header collapses to `"Journey"`.
 */
export function renderHeader(
  snapshot: JourneySnapshot,
  nowMs: number,
): string {
  const clock = formatClock(nowMs);
  if (
    snapshot.plan.origin.length === 0 ||
    snapshot.plan.destination.length === 0
  ) {
    const left = padRight("Journey", LINE_WIDTH - clock.length - 1);
    return truncate(left + " " + clock, LINE_WIDTH);
  }
  // Squeeze "<orig>→<dest>" into 17 cols. Allocate ~8 to each side and
  // 2 to the "→" + spacing.
  const orig = abbreviateStation(snapshot.originName, 8);
  const dest = abbreviateStation(snapshot.destinationName, 8);
  const composed = orig + "→" + dest;
  // composed could be ≤ 17 chars; clock is 6; spacing is 1 → 24 max.
  // Pad to LINE_WIDTH.
  const left = padRight(composed, LINE_WIDTH - clock.length - 1);
  return truncate(left + " " + clock, LINE_WIDTH);
}

/**
 * Estimate end-to-end travel time as a "~N min" string. Uses the
 * intermediate-stop count × `MINUTES_PER_STOP` heuristic — WMATA's
 * Station-to-Station endpoint gives a more accurate `RailTime`, but
 * that's an extra fetch we don't want on the per-mount path.
 *
 * `path.length` counts BOTH endpoints, so the intermediate count is
 * `path.length - 1` (one less than the station count is the number
 * of segments between them, which is what travel time scales with).
 */
export function estimateTravelMinutes(path: readonly PathStep[]): number {
  const segments = Math.max(0, path.length - 1);
  return segments * MINUTES_PER_STOP;
}

/**
 * Total travel-time estimate across all legs. Sums each leg's
 * segment count (intermediate hops) and applies the same
 * MINUTES_PER_STOP heuristic; adds a 2-minute transfer dwell
 * between legs for the platform walk + waiting for the connecting
 * train.
 */
export function estimateTravelMinutesForLegs(
  legs: readonly (readonly PathStep[])[],
): number {
  if (legs.length === 0) return 0;
  let total = 0;
  for (const leg of legs) total += estimateTravelMinutes(leg);
  // Transfer dwell between consecutive legs.
  if (legs.length > 1) total += (legs.length - 1) * 2;
  return total;
}

/** Total revenue-station hops across all legs (sum of `len - 1`). */
export function stopsAcrossLegs(
  legs: readonly (readonly PathStep[])[],
): number {
  let total = 0;
  for (const leg of legs) total += Math.max(0, leg.length - 1);
  return total;
}

/**
 * Compact "RD" / "OR→YL" line indicator string. One leg → just
 * the line code; two legs → "AA→BB" using the lead-circuit's
 * `LineCode`.
 */
export function formatLineSummary(
  legs: readonly (readonly PathStep[])[],
): string {
  const codes: string[] = [];
  for (const leg of legs) {
    const lc = leg[0]?.LineCode ?? "?";
    if (codes[codes.length - 1] !== lc) codes.push(lc);
  }
  return codes.join("→");
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function makeJourneyScreen(
  fetcher: () => Promise<JourneyFetchResult>,
  initialSnapshot: JourneySnapshot,
): Screen<JourneySnapshot> & {
  tick: (snapshot: JourneySnapshot) => Promise<JourneySnapshot>;
} {
  return {
    name: "journey",
    init: () => initialSnapshot,
    view(snapshot, _nav, ctx: ViewContext): string[] {
      const lines: string[] = [];
      lines.push(renderHeader(snapshot, ctx.nowMs));

      // Unset plan — surface the friendly empty state.
      if (
        snapshot.plan.origin.length === 0 ||
        snapshot.plan.destination.length === 0
      ) {
        lines.push(truncate("No journey saved.", LINE_WIDTH));
        lines.push(truncate("Open phone to add.", LINE_WIDTH));
        lines.push("");
        lines.push(truncate("(double-tap to return)", LINE_WIDTH));
        return lines;
      }

      // Unresolved (first tick still pending or fetcher failed).
      if (snapshot.legs === null) {
        if (snapshot.fetchError !== null && snapshot.fetchedAt === 0) {
          lines.push(truncate("Couldn't reach WMATA.", LINE_WIDTH));
          lines.push(truncate("Will retry shortly.", LINE_WIDTH));
        } else {
          lines.push(truncate("Loading path…", LINE_WIDTH));
        }
        lines.push("");
        lines.push(truncate("(double-tap to return)", LINE_WIDTH));
        return lines;
      }

      // No routable journey: either a cross-line pair without a
      // transfer configured (legs === []), or one of the two legs
      // returned empty (a malformed transfer code).
      if (snapshot.legs.length === 0) {
        lines.push(truncate("Not a routable", LINE_WIDTH));
        lines.push(truncate("journey. Add a", LINE_WIDTH));
        lines.push(truncate("transfer station.", LINE_WIDTH));
        lines.push(truncate("(double-tap to return)", LINE_WIDTH));
        return lines;
      }

      // Happy path. Summary line shows the line(s) involved + stop
      // count. For two-leg journeys: "OR→YL · 11 stops".
      const lineSummary = formatLineSummary(snapshot.legs);
      const stops = stopsAcrossLegs(snapshot.legs);
      lines.push(truncate(`${lineSummary} · ${stops} stops`, LINE_WIDTH));

      // Optional "via" row for transfer journeys.
      if (snapshot.legs.length > 1 && snapshot.transferName.length > 0) {
        lines.push(truncate(`via ${snapshot.transferName}`, LINE_WIDTH));
      }

      const minutes = estimateTravelMinutesForLegs(snapshot.legs);
      lines.push(truncate(`Est. travel: ~${minutes} min`, LINE_WIDTH));

      // Live next-train at origin.
      if (snapshot.nextTrain !== null) {
        const { line, min, destination } = snapshot.nextTrain;
        const minLabel =
          min === "ARR" || min === "BRD" || min === "" || min === "---"
            ? min || "—"
            : `${min} min`;
        lines.push(
          truncate(`Next: ${line} ${destination} ${minLabel}`, LINE_WIDTH),
        );
      }

      lines.push("");
      lines.push(truncate("(double-tap to return)", LINE_WIDTH));
      return lines;
    },
    reduce(_snapshot, nav, event: ScreenEvent): ReduceResult<JourneySnapshot> {
      switch (event.type) {
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "home" } };
        default:
          return { nav };
      }
    },
    /**
     * Resolve the path one-shot on mount. Subsequent ticks are no-ops
     * (path data is network-static for a session). `tickIntervalMs ===
     * 0` tells the host to call `tick` once and never schedule
     * another.
     */
    async tick(snapshot: JourneySnapshot): Promise<JourneySnapshot> {
      try {
        const result = await fetcher();
        return {
          ...snapshot,
          legs: result.legs,
          originName: result.originName || snapshot.plan.origin,
          destinationName: result.destinationName || snapshot.plan.destination,
          transferName: result.transferName || snapshot.transferName,
          nextTrain: result.nextTrain,
          fetchedAt: result.legs !== null ? Date.now() : snapshot.fetchedAt,
          fetchError: null,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        return { ...snapshot, fetchError: message };
      }
    },
    tickIntervalMs: TICK_INTERVAL_MS,
  };
}

/** Build a fresh snapshot from the user's saved journey plan. */
export function makeInitialJourneySnapshot(
  plan: JourneyPlan,
): JourneySnapshot {
  return {
    plan,
    originName: plan.origin,
    destinationName: plan.destination,
    transferName: plan.transfer ?? "",
    legs: null,
    nextTrain: null,
    fetchedAt: 0,
    fetchError: null,
  };
}
