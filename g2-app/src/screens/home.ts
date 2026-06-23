// Home — the root screen: a glanceable favorites board with each station's
// soonest next-train ETA in a right-anchored value column, plus a "Service
// alerts" entry. Hand-rolled selectable rows (caret focus + value overlay) —
// the native LIST can't carry a per-row live ETA value, so this is the
// sanctioned hand-roll. ≤ MAX_FAVORITES + 1 rows, so it never scrolls.
//
// Pure: no SDK, no I/O. The host injects data via `loader` / `refresh`.

import { MAX_FAVORITES } from "../storage/settings";
import type { FavoriteStation } from "../data/domain/lines";
import { formatEtaValue, lineGlyph } from "../ui/format";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Row, Screen } from "./router";

export interface HomeSnapshot {
  favorites: FavoriteStation[];
  /** stationCode → soonest `Min` token (or null). Empty/absent = not yet loaded. */
  favoriteEtas: Record<string, string | null>;
  /** Active alerts on followed lines; 0 hides the count. */
  alertCount: number;
}

const ALERTS_LABEL = "Service alerts";
const SEP = " · ";

/** Worst-case value strings, for the fixed-x value column. */
export const HOME_VALUE_RESERVE = ["12 min"] as const;

function clamp(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(idx, count - 1));
}

/** Left content for a favorite row: name + a quiet line-code list. */
function favoriteLeft(fav: FavoriteStation): string {
  const codes = fav.lines.map(lineGlyph).filter((g) => g !== "--");
  return codes.length ? `${fav.name}${SEP}${codes.join(" ")}` : fav.name;
}

/** The selectable rows: favorites (ETA value) then the alerts entry (count value). */
export function homeRows(s: HomeSnapshot): Row[] {
  const rows: Row[] = s.favorites.slice(0, MAX_FAVORITES).map((f) => ({
    left: favoriteLeft(f),
    value: formatEtaValue(s.favoriteEtas[f.code] ?? null),
  }));
  rows.push({ left: ALERTS_LABEL, value: s.alertCount > 0 ? String(s.alertCount) : "" });
  return rows;
}

export function makeHomeScreen(
  loader: () => HomeSnapshot,
  refresh?: () => Promise<HomeSnapshot>,
  tickIntervalMs?: number,
): Screen<HomeSnapshot> {
  const screen: Screen<HomeSnapshot> = {
    name: "home",
    mode: "text",
    valueReserve: HOME_VALUE_RESERVE,
    init: loader,
    view(s: HomeSnapshot, nav: NavState): Layout {
      if (s.favorites.length === 0) {
        return {
          header: { title: "WMATA" },
          body: {
            kind: "message",
            lines: ["No favorites yet.", "Add stations in the phone app."],
          },
          hints: [HINTS.exit],
        };
      }
      const rows = homeRows(s);
      return {
        header: { title: "WMATA" },
        body: { kind: "rows", rows, selectedIndex: clamp(nav.selectedIndex, rows.length) },
        hints: [HINTS.move, HINTS.open, HINTS.exit],
      };
    },
    reduce(s: HomeSnapshot, nav: NavState, event): ReduceResult<HomeSnapshot> {
      const rows = homeRows(s);
      const n = rows.length;
      const idx = clamp(nav.selectedIndex, n);
      switch (event.type) {
        case "SCROLL_UP":
          return { nav: { selectedIndex: clamp(idx - 1, n) } };
        case "SCROLL_DOWN":
          return { nav: { selectedIndex: clamp(idx + 1, n) } };
        case "TAP": {
          if (s.favorites.length === 0) return { nav: { selectedIndex: idx } };
          if (idx === n - 1) return { nav: { selectedIndex: idx }, navigate: { to: "alerts" } };
          const fav = s.favorites[idx];
          return fav
            ? {
                nav: { selectedIndex: idx },
                navigate: { to: "predictions", stationCode: fav.code, stationName: fav.name },
              }
            : { nav: { selectedIndex: idx } };
        }
        case "DOUBLE_TAP":
          return { nav: { selectedIndex: idx }, navigate: { to: "exit" } };
      }
    },
  };

  if (refresh && tickIntervalMs && tickIntervalMs > 0) {
    screen.tick = async (s: HomeSnapshot): Promise<HomeSnapshot> => {
      try {
        return await refresh();
      } catch {
        return s; // best-effort: keep the prior board rather than blanking
      }
    };
    screen.tickIntervalMs = tickIntervalMs;
  }

  return screen;
}
