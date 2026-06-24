// Predictions — the per-station next-train board reached by tapping a favorite.
// A read-only board (no caret): line glyph + destination on the left, soonest
// ETA in the right-anchored value column. Auto-refreshes every 10s; stale /
// errored data degrades to a clock marker + a tap-to-retry message rather than
// blanking. Pure: the `fetcher` is injected; the wall clock arrives via ctx.

import type { Train } from "../data/wmata";
import { etaSortValue } from "../data/domain/eta";
import { stalenessMarker } from "../data/domain/staleness";
import { formatEtaValue, lineGlyph, toTitleCase } from "../ui/format";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Row, Screen, ViewContext } from "./router";

// WMATA refreshes its real-time predictions every ~20-30s server-side, so
// polling much faster than this only adds requests without new data; 10s keeps
// the board feeling live (picks up a server update within ~10s) without waste.
export const PREDICTIONS_TICK_MS = 10_000;
const STALE_MS = 60_000;
/** Soonest N trains shown — sized to fit the body without overflow (no bounce). */
const MAX_ROWS = 6;

export interface PredictionsFetch {
  trains: Train[];
  fetchedAt: number;
  fetchError: string | null;
}

export interface PredictionsSnapshot {
  stationCode: string;
  stationName: string;
  trains: Train[];
  fetchedAt: number;
  fetchError: string | null;
  consecutiveFailures: number;
}

/** Sort trains by soonest arrival (BRD < ARR < numeric < junk). */
export function sortTrains(trains: readonly Train[]): Train[] {
  const rank = (m: string): number => {
    const v = etaSortValue(m);
    return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
  };
  return [...trains].sort((a, b) => rank(a.Min) - rank(b.Min));
}

/** One board row: "RD Shady Grove" + an ETA value. */
export function trainRow(t: Train): Row {
  const code = lineGlyph(t.Line);
  const dest = toTitleCase(t.Destination || t.DestinationName || "");
  return { left: code === "--" ? dest : `${code} ${dest}`, value: formatEtaValue(t.Min) };
}

/** The big hero token for the soonest train: digits for a numeric ETA, the word
 *  for ARR/BRD, "" otherwise (blank accent). */
export function heroNumeral(min: string): string {
  if (min === "ARR" || min === "BRD") return min;
  return /^\d+$/.test(min) ? min : "";
}

/** Build the initial snapshot (pre-first-fetch loading state). */
export function makeInitialPredictionsSnapshot(
  stationCode: string,
  stationName: string,
): PredictionsSnapshot {
  return { stationCode, stationName, trains: [], fetchedAt: 0, fetchError: null, consecutiveFailures: 0 };
}

export function makePredictionsScreen(
  fetcher: () => Promise<PredictionsFetch>,
  initial: PredictionsSnapshot,
): Screen<PredictionsSnapshot> {
  return {
    name: "predictions",
    mode: "text",
    // Hero screen: a big dot-matrix accent of the soonest train's ETA on the
    // left, the train board (with its ETA value column) on the right. The
    // accent is a PNG ≤156×140 — within the firmware's ≤288×144 image cap — sent
    // via updateImageRawData after the page is built, the same proven pattern as
    // g2-dotmatrix-demo. (It was once blamed for the on-device crash that turned
    // out to be shutDownPageContainer-on-navigation, now fixed.)
    hero: true,
    valueReserve: ["12 min"],
    init: () => initial,
    view(s: PredictionsSnapshot, _nav: NavState, ctx: ViewContext): Layout {
      const marker = stalenessMarker(
        { fetchedAt: s.fetchedAt, fetchError: s.fetchError, consecutiveFailures: s.consecutiveFailures },
        ctx.nowMs,
        STALE_MS,
      );
      const header = { title: s.stationName || s.stationCode, marker };
      const sorted = sortTrains(s.trains);
      const numeral = sorted[0] ? heroNumeral(sorted[0].Min) : "";
      const firstLoadError = s.trains.length === 0 && s.fetchedAt === 0 && s.fetchError !== null;
      if (firstLoadError) {
        return {
          header,
          body: { kind: "message", lines: ["Couldn't reach WMATA.", "", "Tap to retry."] },
          hints: [HINTS.retry, HINTS.back],
          hero: { numeral: "" },
        };
      }
      if (s.trains.length === 0 && s.fetchedAt === 0) {
        return { header, body: { kind: "message", lines: ["Loading…"] }, hints: [HINTS.back], hero: { numeral: "" } };
      }
      if (s.trains.length === 0) {
        return { header, body: { kind: "message", lines: ["No upcoming trains."] }, hints: [HINTS.back], hero: { numeral: "" } };
      }
      const rows = sorted.slice(0, MAX_ROWS).map(trainRow);
      return {
        header,
        body: { kind: "rows", rows, selectedIndex: 0, selectable: false },
        hints: [HINTS.back],
        hero: { numeral },
      };
    },
    reduce(s: PredictionsSnapshot, nav: NavState, event): ReduceResult<PredictionsSnapshot> {
      const firstLoadError = s.trains.length === 0 && s.fetchedAt === 0 && s.fetchError !== null;
      switch (event.type) {
        case "TAP":
          // Pure viewer: press is back. In the first-load error state it's the
          // tap-to-retry affordance instead.
          return firstLoadError ? { nav, requestTick: true } : { nav, navigate: { to: "home" } };
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "home" } };
        default:
          return { nav }; // a board doesn't scroll-select
      }
    },
    async tick(s: PredictionsSnapshot): Promise<PredictionsSnapshot> {
      try {
        const r = await fetcher();
        const failed = r.fetchError !== null;
        return {
          ...s,
          trains: r.trains,
          fetchedAt: r.fetchedAt,
          fetchError: r.fetchError,
          consecutiveFailures: failed ? s.consecutiveFailures + 1 : 0,
        };
      } catch (err) {
        return {
          ...s,
          fetchError: err instanceof Error ? err.message : String(err ?? "Unknown error"),
          consecutiveFailures: s.consecutiveFailures + 1,
        };
      }
    },
    tickIntervalMs: PREDICTIONS_TICK_MS,
  };
}
