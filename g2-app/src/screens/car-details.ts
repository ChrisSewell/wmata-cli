// Car details — a read-only board reached from the car menu's "View details".
// Shows the slot's identity (line / destination / station / platform) and the
// reliable prediction data the API gives for it: the next matching departures
// at its station. `null`/empty matches surface an honest "no matching train"
// instead of inventing data. The `fetcher` (injected by the wiring) returns the
// matching trains' Min tokens, soonest first.

import { stalenessMarker } from "../data/domain/staleness";
import { lineGlyph, formatEtaValue } from "../ui/format";
import { HINTS } from "../nav/affordances";
import type { TrackedCar } from "../data/domain/tracked";
import type { Layout, NavState, ReduceResult, Row, Screen, ViewContext } from "./router";

export const CAR_DETAILS_TICK_MS = 10_000;
const STALE_MS = 60_000;
const ETA_LABELS = ["Next", "Then", "After"] as const;

export interface CarDetailsSnapshot {
  mins: string[]; // matching trains' Min tokens, soonest first
  fetchedAt: number;
  fetchError: string | null;
  consecutiveFailures: number;
}

export function makeInitialCarDetailsSnapshot(): CarDetailsSnapshot {
  return { mins: [], fetchedAt: 0, fetchError: null, consecutiveFailures: 0 };
}

export function makeCarDetailsScreen(
  car: TrackedCar,
  fetcher: () => Promise<string[]>,
  tracked = false,
): Screen<CarDetailsSnapshot> {
  const glyph = lineGlyph(car.line);
  const base = `${glyph === "--" ? "" : glyph + " "}${car.destinationName || "Train"}`.trim();
  const title = (tracked ? "• " : "") + base; // • = the tracking indicator
  return {
    name: "carDetails",
    mode: "text",
    valueReserve: ["12 min"],
    init: makeInitialCarDetailsSnapshot,
    view(s: CarDetailsSnapshot, _nav: NavState, ctx: ViewContext): Layout {
      const marker = stalenessMarker(
        { fetchedAt: s.fetchedAt, fetchError: s.fetchError, consecutiveFailures: s.consecutiveFailures },
        ctx.nowMs,
        STALE_MS,
      );
      // Long text (the station name) stays in the WIDE left column; the narrow
      // value column is reserved for the short ETA tokens only — otherwise a
      // long value wraps and throws the rows out of alignment.
      const rows: Row[] = [{ left: `From ${car.stationName}` }];
      if (s.fetchedAt === 0 && s.mins.length === 0) {
        rows.push({ left: "Loading…" });
      } else if (s.mins.length === 0) {
        rows.push({ left: "No matching train" }); // honest: this slot has no train right now
      } else {
        s.mins.slice(0, ETA_LABELS.length).forEach((m, i) => rows.push({ left: ETA_LABELS[i]!, value: formatEtaValue(m) }));
      }
      return {
        header: { title, marker: marker || undefined },
        body: { kind: "rows", rows, selectedIndex: 0, selectable: false },
        hints: [HINTS.back],
      };
    },
    reduce(_s: CarDetailsSnapshot, nav: NavState, event): ReduceResult<CarDetailsSnapshot> {
      switch (event.type) {
        case "TAP":
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "carMenu", car } };
        default:
          return { nav };
      }
    },
    async tick(s: CarDetailsSnapshot): Promise<CarDetailsSnapshot> {
      try {
        const mins = await fetcher();
        return { mins, fetchedAt: Date.now(), fetchError: null, consecutiveFailures: 0 };
      } catch (err) {
        return {
          ...s,
          fetchError: err instanceof Error ? err.message : String(err ?? "Unknown error"),
          consecutiveFailures: s.consecutiveFailures + 1,
        };
      }
    },
    tickIntervalMs: CAR_DETAILS_TICK_MS,
  };
}
