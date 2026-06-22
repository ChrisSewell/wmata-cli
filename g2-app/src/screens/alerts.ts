// Alerts — rail service incidents + elevator/escalator outages folded into one
// selectable list (reached from Home). Hand-rolled WINDOWED rows: the screen
// slices the visible window around the cursor so the body never overflows
// (anti-bounce — no text-overflow free-scroll), with a position marker. Press
// opens the paginated detail. Pure: the `fetcher` is injected.

import type { AlertItem } from "../data/domain/alerts";
import { stalenessMarker } from "../data/domain/staleness";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Row, Screen, ViewContext } from "./router";

export const ALERTS_TICK_MS = 60_000;
const STALE_MS = 120_000;
/** Rows that fit the body without overflow. */
const VISIBLE = 6;

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

/** Visible window [start, start+VISIBLE) keeping `selected` in view. */
export function windowRange(selected: number, total: number, visible = VISIBLE): { start: number; end: number } {
  if (total <= visible) return { start: 0, end: total };
  let start = selected - Math.floor(visible / 2);
  start = Math.max(0, Math.min(start, total - visible));
  return { start, end: start + visible };
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
    mode: "text",
    init: () => initial,
    view(s: AlertsSnapshot, nav: NavState, ctx: ViewContext): Layout {
      const marker = stalenessMarker(
        { fetchedAt: s.fetchedAt, fetchError: s.fetchError, consecutiveFailures: s.consecutiveFailures },
        ctx.nowMs,
        STALE_MS,
      );
      const total = s.items.length;
      if (total === 0) {
        const lines = firstLoadError(s)
          ? ["Couldn't reach WMATA.", "", "Tap to retry."]
          : s.fetchedAt === 0
            ? ["Loading…"]
            : ["All lines running normally."];
        const hints = firstLoadError(s) ? [HINTS.retry, HINTS.back] : [HINTS.back];
        return { header: { title: "Alerts", marker }, body: { kind: "message", lines }, hints };
      }
      const selected = clamp(nav.selectedIndex, total);
      const { start, end } = windowRange(selected, total);
      const rows: Row[] = s.items.slice(start, end).map((it) => ({ left: it.headline }));
      const posMarker = total > VISIBLE ? `${selected + 1}/${total}` : marker;
      return {
        header: { title: "Alerts", marker: posMarker || undefined },
        body: { kind: "rows", rows, selectedIndex: selected - start },
        hints: [HINTS.open, HINTS.back],
      };
    },
    reduce(s: AlertsSnapshot, nav: NavState, event): ReduceResult<AlertsSnapshot> {
      const total = s.items.length;
      const idx = clamp(nav.selectedIndex, total);
      switch (event.type) {
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
