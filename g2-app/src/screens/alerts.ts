// Alerts — rail service incidents + elevator/escalator outages folded into one
// selectable list (reached from Home), rendered as a NATIVE list: the firmware
// owns scroll, windowing, and the selection highlight, so nothing re-paints as
// you move (no bounce — the old hand-rolled windowed rows did). Press opens the
// paginated detail. Pure: the `fetcher` is injected.

import type { AlertItem } from "../data/domain/alerts";
import { stalenessMarker } from "../data/domain/staleness";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Screen, ViewContext } from "./router";

export const ALERTS_TICK_MS = 60_000;
const STALE_MS = 120_000;

export interface AlertsFetch {
  items: AlertItem[];
  fetchedAt: number;
  fetchError: string | null;
}

export interface AlertsSnapshot {
  items: AlertItem[];
  fetchedAt: number;
  fetchError: string | null;
  consecutiveFailures: number;
}

function clamp(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(idx, count - 1));
}

export function makeInitialAlertsSnapshot(items: AlertItem[] = []): AlertsSnapshot {
  return { items, fetchedAt: 0, fetchError: null, consecutiveFailures: 0 };
}

export function makeAlertsScreen(
  fetcher: () => Promise<AlertsFetch>,
  initial: AlertsSnapshot,
): Screen<AlertsSnapshot> {
  const firstLoadError = (s: AlertsSnapshot): boolean =>
    s.items.length === 0 && s.fetchedAt === 0 && s.fetchError !== null;

  return {
    name: "alerts",
    mode: "list",
    init: () => initial,
    view(s: AlertsSnapshot, nav: NavState, ctx: ViewContext): Layout {
      const marker = stalenessMarker(
        { fetchedAt: s.fetchedAt, fetchError: s.fetchError, consecutiveFailures: s.consecutiveFailures },
        ctx.nowMs,
        STALE_MS,
      );
      const total = s.items.length;
      if (total === 0) {
        // Empty / loading / error: a single non-actionable item keeps the page
        // in list-mode (no risky text↔list composition switch on data change).
        const item = firstLoadError(s)
          ? "Couldn't reach WMATA — tap to retry"
          : s.fetchedAt === 0
            ? "Loading…"
            : "All lines running normally.";
        const hints = firstLoadError(s) ? [HINTS.retry, HINTS.back] : [HINTS.back];
        return { header: { title: "Alerts", marker }, body: { kind: "list", items: [item], selectedIndex: 0 }, hints };
      }
      const selected = clamp(nav.selectedIndex, total);
      const items = s.items.map((it) => it.headline);
      return {
        header: { title: "Alerts", marker: marker || undefined },
        body: { kind: "list", items, selectedIndex: selected },
        hints: [HINTS.open, HINTS.back],
      };
    },
    reduce(s: AlertsSnapshot, nav: NavState, event): ReduceResult<AlertsSnapshot> {
      const total = s.items.length;
      const idx = clamp(nav.selectedIndex, total);
      switch (event.type) {
        // SCROLL_* are unreachable on a native-list screen (firmware owns it).
        case "SCROLL_UP":
          return { nav: { selectedIndex: clamp(idx - 1, total) } };
        case "SCROLL_DOWN":
          return { nav: { selectedIndex: clamp(idx + 1, total) } };
        case "TAP":
          if (total === 0) return firstLoadError(s) ? { nav: { selectedIndex: idx }, requestTick: true } : { nav: { selectedIndex: idx } };
          return { nav: { selectedIndex: idx }, navigate: { to: "alertDetail", index: idx } };
        case "DOUBLE_TAP":
          return { nav: { selectedIndex: idx }, navigate: { to: "home" } };
      }
    },
    async tick(s: AlertsSnapshot): Promise<AlertsSnapshot> {
      try {
        const r = await fetcher();
        const failed = r.fetchError !== null;
        return { items: r.items, fetchedAt: r.fetchedAt, fetchError: r.fetchError, consecutiveFailures: failed ? s.consecutiveFailures + 1 : 0 };
      } catch (err) {
        return { ...s, fetchError: err instanceof Error ? err.message : String(err ?? "Unknown error"), consecutiveFailures: s.consecutiveFailures + 1 };
      }
    },
    tickIntervalMs: ALERTS_TICK_MS,
  };
}
