// Predictions — the per-station next-train board reached by tapping a favorite.
// A read-only board (no caret): line glyph + destination on the left, soonest
// ETA in the right-anchored value column. Auto-refreshes every 10s; stale /
// errored data degrades to a clock marker + a tap-to-retry message rather than
// blanking. Pure: the `fetcher` is injected; the wall clock arrives via ctx.

import type { Train } from "../data/wmata";
import { etaSortValue } from "../data/domain/eta";
import { stalenessMarker } from "../data/domain/staleness";
import { carKey, trackedCarFromTrain, type TrackedCar } from "../data/domain/tracked";
import { formatEtaValue, lineGlyph, toTitleCase } from "../ui/format";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Row, Screen, ViewContext } from "./router";

function clamp(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(idx, count - 1));
}

/** A board row packed into one native-list item string (no positioned column —
 *  the ETA rides after a middot, like Home/Alerts). */
export function trainItem(t: Train): string {
  const r = trainRow(t);
  return r.value ? `${r.left} · ${r.value}` : r.left;
}

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
  getTracked: () => TrackedCar[] = () => [],
): Screen<PredictionsSnapshot> {
  return {
    name: "predictions",
    // Hero + SELECTABLE native list: the big dot-matrix accent of the soonest
    // train on the left, a scrollable list of upcoming trains on the right.
    // Single press opens the per-car menu (track/untrack/details); double press
    // goes back. (The native list owns scroll/selection — no bounce — and the
    // accent is a PNG within the firmware's ≤288×144 image cap, pushed via
    // updateImageRawData after the page builds, like g2-dotmatrix-demo.)
    mode: "list",
    hero: true,
    init: () => initial,
    view(s: PredictionsSnapshot, nav: NavState, ctx: ViewContext): Layout {
      const marker = stalenessMarker(
        { fetchedAt: s.fetchedAt, fetchError: s.fetchError, consecutiveFailures: s.consecutiveFailures },
        ctx.nowMs,
        STALE_MS,
      );
      const header = { title: s.stationName || s.stationCode, marker };
      const sorted = sortTrains(s.trains);
      const numeral = sorted[0] ? heroNumeral(sorted[0].Min) : "";
      const firstLoadError = s.trains.length === 0 && s.fetchedAt === 0 && s.fetchError !== null;
      // Transient states are single-item lists so the page never switches
      // text↔list composition mid-screen (matches Home/Alerts).
      if (firstLoadError) {
        return {
          header,
          body: { kind: "list", items: ["Couldn't reach WMATA — tap to retry"], selectedIndex: 0 },
          hints: [HINTS.retry, HINTS.back],
          hero: { numeral: "" },
        };
      }
      if (s.trains.length === 0 && s.fetchedAt === 0) {
        return { header, body: { kind: "list", items: ["Loading…"], selectedIndex: 0 }, hints: [HINTS.back], hero: { numeral: "" } };
      }
      if (s.trains.length === 0) {
        return { header, body: { kind: "list", items: ["No upcoming trains."], selectedIndex: 0 }, hints: [HINTS.back], hero: { numeral: "" } };
      }
      // Mark trains the user is tracking with a leading • (the tracking
      // indicator) so they stand out on the board.
      const trackedKeys = new Set(getTracked().map(carKey));
      const items = sorted.slice(0, MAX_ROWS).map((t) => {
        const tracked = trackedKeys.has(carKey(trackedCarFromTrain(t, s.stationCode, s.stationName)));
        return (tracked ? "• " : "") + trainItem(t);
      });
      return {
        header,
        body: { kind: "list", items, selectedIndex: clamp(nav.selectedIndex, items.length) },
        hints: [HINTS.open, HINTS.back],
        hero: { numeral },
      };
    },
    reduce(s: PredictionsSnapshot, nav: NavState, event): ReduceResult<PredictionsSnapshot> {
      const firstLoadError = s.trains.length === 0 && s.fetchedAt === 0 && s.fetchError !== null;
      const sorted = sortTrains(s.trains);
      const count = Math.min(sorted.length, MAX_ROWS);
      const idx = clamp(nav.selectedIndex, count);
      switch (event.type) {
        case "TAP": {
          if (s.trains.length === 0) return firstLoadError ? { nav, requestTick: true } : { nav };
          const train = sorted[idx];
          return train
            ? { nav: { selectedIndex: idx }, navigate: { to: "carMenu", car: trackedCarFromTrain(train, s.stationCode, s.stationName) } }
            : { nav };
        }
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "home" } };
        // SCROLL_* are unreachable on a native list (firmware owns scroll) but
        // kept for completeness / tests.
        case "SCROLL_UP":
          return { nav: { selectedIndex: clamp(idx - 1, count) } };
        case "SCROLL_DOWN":
          return { nav: { selectedIndex: clamp(idx + 1, count) } };
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
