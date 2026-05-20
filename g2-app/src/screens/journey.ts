// Journey / Commute screen.
//
// Renders a glanceable summary of the user's saved origin → destination
// commute. The path itself comes from WMATA's `/Rail.svc/json/jPath`
// (same-line only); the screen falls back to a clear "not a same-
// line route" message when the user's pair spans a transfer.
//
// Layout (wide grid × up to 8 rendered rows). Full line + station
// names everywhere, matching Home / Predictions / Incidents:
//
//          Metro Center → Vienna/Fairfax-GMU        2:32p
//          RED · 8 stops
//          Est. travel: ~16 min
//          Next: RED Glenmont 5 min
//          (double-tap to return)
//
// Empty state (journey not yet configured):
//
//          Journey                                  2:32p
//          No journey saved. Open the phone app
//          to set an origin + destination.
//          (double-tap to return)
//
// Cross-line state (a routable two-leg journey via a transfer):
//
//          Metro Center → Pentagon City             2:32p
//          ORANGE→YELLOW · 4 stops
//          via L'Enfant Plaza
//          Est. travel: ~10 min
//          Next: ORANGE New Carrollton 3 min
//          (double-tap to return)
//
// PURITY: pure view + reducer. The host injects a `fetcher` that
// resolves the path via `Session.getPath` (one-shot, cached).

import type { JourneyPlan } from "../storage/settings";
import type { PathStep } from "../wmata";
import { SAFE_TEXT_WIDTH, truncate } from "../ui/render";
import { lineName } from "../ui/format";
// `formatClock` now lives in the shared field-formatter module and is
// rendered by the host into its own top-right clock container. Re-export
// it here so existing imports (`import { formatClock } from "./journey"`)
// keep resolving after the screen stopped embedding the clock.
export { formatClock } from "../ui/format";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ScreenSections,
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

/**
 * Render the header — the journey title only, left-aligned:
 * `<origin> → <dest>` (or `"Journey"` when the plan is unconfigured).
 *
 * Both origin and destination are rendered with their FULL Title-Case
 * names (no abbreviation), matching the rest of the app. The wall clock
 * is NO LONGER part of the header string: the host renders it into a
 * dedicated top-right clock container on every screen. The title is
 * truncated to 50 columns so it can never collide with that clock cell
 * (which starts at x≈486px ≈ column 50).
 */
export function renderHeader(snapshot: JourneySnapshot): string {
  if (
    snapshot.plan.origin.length === 0 ||
    snapshot.plan.destination.length === 0
  ) {
    return "Journey";
  }
  return truncate(`${snapshot.originName} → ${snapshot.destinationName}`, 50);
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
 * Full-name "RED" / "ORANGE→YELLOW" line indicator string. One leg →
 * just the line name; two legs → "AAA→BBB" using the lead-circuit's
 * `LineCode`, spelled out via `lineName` for consistency with the
 * rest of the app (Home / Predictions / Incidents). Dedups
 * consecutive identical codes (a same-line transfer collapses to one
 * name). The wider grid + per-line SAFE_TEXT_WIDTH truncation in the
 * caller keep even "ORANGE→YELLOW · N stops" inside the panel.
 */
export function formatLineSummary(
  legs: readonly (readonly PathStep[])[],
): string {
  const codes: string[] = [];
  for (const leg of legs) {
    const lc = leg[0]?.LineCode ?? "?";
    if (codes[codes.length - 1] !== lc) codes.push(lc);
  }
  return codes.map((c) => lineName(c)).join("→");
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
    view(snapshot, _nav, _ctx: ViewContext): ScreenSections {
      const header: string[] = [renderHeader(snapshot)];
      const body: string[] = [];

      // Unset plan — surface the friendly empty state.
      if (
        snapshot.plan.origin.length === 0 ||
        snapshot.plan.destination.length === 0
      ) {
        body.push(truncate("No journey saved. Open the phone app", SAFE_TEXT_WIDTH));
        body.push(truncate("to set an origin + destination.", SAFE_TEXT_WIDTH));
        body.push("");
        body.push(truncate("(double-tap to return)", SAFE_TEXT_WIDTH));
        return { header, body };
      }

      // Unresolved (first tick still pending or fetcher failed).
      if (snapshot.legs === null) {
        if (snapshot.fetchError !== null && snapshot.fetchedAt === 0) {
          body.push(truncate("Couldn't reach WMATA. Will retry shortly.", SAFE_TEXT_WIDTH));
        } else {
          body.push(truncate("Loading path…", SAFE_TEXT_WIDTH));
        }
        body.push("");
        body.push(truncate("(double-tap to return)", SAFE_TEXT_WIDTH));
        return { header, body };
      }

      // No routable journey: either a cross-line pair without a
      // transfer configured (legs === []), or one of the two legs
      // returned empty (a malformed transfer code).
      if (snapshot.legs.length === 0) {
        body.push(truncate("Not a routable journey. Add a transfer", SAFE_TEXT_WIDTH));
        body.push(truncate("station from the phone app.", SAFE_TEXT_WIDTH));
        body.push("");
        body.push(truncate("(double-tap to return)", SAFE_TEXT_WIDTH));
        return { header, body };
      }

      // Happy path. Summary line shows the line(s) involved + stop
      // count, using full line names: "ORANGE→YELLOW · 11 stops".
      const lineSummary = formatLineSummary(snapshot.legs);
      const stops = stopsAcrossLegs(snapshot.legs);
      body.push(truncate(`${lineSummary} · ${stops} stops`, SAFE_TEXT_WIDTH));

      // Optional "via" row for transfer journeys (full transfer name).
      if (snapshot.legs.length > 1 && snapshot.transferName.length > 0) {
        body.push(truncate(`via ${snapshot.transferName}`, SAFE_TEXT_WIDTH));
      }

      const minutes = estimateTravelMinutesForLegs(snapshot.legs);
      body.push(truncate(`Est. travel: ~${minutes} min`, SAFE_TEXT_WIDTH));

      // Live next-train at origin. The line code is spelled out
      // (lineName) and the destination is rendered in full — it comes
      // from live data, so only the SAFE_TEXT_WIDTH cap clips it.
      if (snapshot.nextTrain !== null) {
        const { line, min, destination } = snapshot.nextTrain;
        const minLabel =
          min === "ARR" || min === "BRD" || min === "" || min === "---"
            ? min || "—"
            : `${min} min`;
        body.push(
          truncate(
            `Next: ${lineName(line)} ${destination} ${minLabel}`,
            SAFE_TEXT_WIDTH,
          ),
        );
      }

      body.push("");
      body.push(truncate("(double-tap to return)", SAFE_TEXT_WIDTH));
      return { header, body };
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
