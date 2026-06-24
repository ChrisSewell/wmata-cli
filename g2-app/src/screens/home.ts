// Home — the root screen: a glanceable favorites board, each row showing the
// station name, its lines, and the soonest next-train ETA, plus a "Service
// alerts" entry. Rendered as a NATIVE list: the firmware owns scroll and the
// selection highlight, so the body never re-paints/bounces as you move. A
// native list item is a single string, so the ETA is packed into the row text
// (a glyph-separated suffix — never a space-padded column). ≤ MAX_FAVORITES + 1
// items, so it never needs to scroll.
//
// Pure: no SDK, no I/O. The host injects data via `loader` / `refresh`.

import { MAX_FAVORITES } from "../storage/settings";
import type { FavoriteStation } from "../data/domain/lines";
import { carKey, type TrackedCar } from "../data/domain/tracked";
import { formatEtaValue, lineGlyph } from "../ui/format";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Screen } from "./router";

export interface HomeSnapshot {
  favorites: FavoriteStation[];
  /** stationCode → soonest `Min` token (or null). Empty/absent = not yet loaded. */
  favoriteEtas: Record<string, string | null>;
  /** Tracked train slots, shown below the favorites. */
  tracked: TrackedCar[];
  /** carKey → soonest matching `Min` token (or null = no matching train now). */
  trackedEtas: Record<string, string | null>;
  /** Active alerts on followed lines; 0 hides the count. */
  alertCount: number;
}

const ALERTS_LABEL = "Service alerts";
const SEP = " · ";

function clamp(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(idx, count - 1));
}

/** Left content for a favorite row: name + a quiet line-code list. */
function favoriteLeft(fav: FavoriteStation): string {
  const codes = fav.lines.map(lineGlyph).filter((g) => g !== "--");
  return codes.length ? `${fav.name}${SEP}${codes.join(" ")}` : fav.name;
}

/** A tracked-slot row, marked with a leading `•` (the tracking indicator), its
 *  next-departure ETA packed in. `—` when no matching train right now. */
function trackedItem(car: TrackedCar, eta: string | null): string {
  const glyph = lineGlyph(car.line);
  const label = `${glyph === "--" ? "" : glyph + " "}${car.destinationName}`.trim();
  return `• ${label}${SEP}${formatEtaValue(eta) || "—"}`;
}

/** The list items: each favorite (ETA packed), then tracked slots (• prefix),
 *  then the "Service alerts (N)" entry. One string per row — no value column. */
export function homeItems(s: HomeSnapshot): string[] {
  const items = s.favorites.slice(0, MAX_FAVORITES).map((f) => {
    const eta = formatEtaValue(s.favoriteEtas[f.code] ?? null);
    return eta ? `${favoriteLeft(f)}${SEP}${eta}` : favoriteLeft(f);
  });
  for (const car of s.tracked) items.push(trackedItem(car, s.trackedEtas[carKey(car)] ?? null));
  items.push(s.alertCount > 0 ? `${ALERTS_LABEL} (${s.alertCount})` : ALERTS_LABEL);
  return items;
}

export function makeHomeScreen(
  loader: () => HomeSnapshot,
  refresh?: () => Promise<HomeSnapshot>,
  tickIntervalMs?: number,
): Screen<HomeSnapshot> {
  const screen: Screen<HomeSnapshot> = {
    name: "home",
    mode: "list",
    init: loader,
    view(s: HomeSnapshot, nav: NavState): Layout {
      if (s.favorites.length === 0) {
        return {
          header: { title: "WMATA" },
          body: { kind: "list", items: ["No favorites — add stations in the phone app"], selectedIndex: 0 },
          hints: [HINTS.exit],
        };
      }
      const items = homeItems(s);
      return {
        header: { title: "WMATA" },
        body: { kind: "list", items, selectedIndex: clamp(nav.selectedIndex, items.length) },
        hints: [HINTS.move, HINTS.open, HINTS.exit],
      };
    },
    reduce(s: HomeSnapshot, nav: NavState, event): ReduceResult<HomeSnapshot> {
      const favCount = s.favorites.slice(0, MAX_FAVORITES).length;
      const trackedCount = s.tracked.length;
      const n = favCount + trackedCount + 1; // favorites + tracked + the alerts row
      const idx = clamp(nav.selectedIndex, n);
      switch (event.type) {
        // SCROLL_* are unreachable on a native-list screen (the firmware owns
        // scroll and emits no per-step event) but kept for completeness/tests.
        case "SCROLL_UP":
          return { nav: { selectedIndex: clamp(idx - 1, n) } };
        case "SCROLL_DOWN":
          return { nav: { selectedIndex: clamp(idx + 1, n) } };
        case "TAP": {
          if (favCount === 0) return { nav: { selectedIndex: idx } };
          if (idx < favCount) {
            const fav = s.favorites[idx];
            return fav
              ? { nav: { selectedIndex: idx }, navigate: { to: "predictions", stationCode: fav.code, stationName: fav.name } }
              : { nav: { selectedIndex: idx } };
          }
          if (idx < favCount + trackedCount) {
            const car = s.tracked[idx - favCount];
            return car ? { nav: { selectedIndex: idx }, navigate: { to: "carDetails", car } } : { nav: { selectedIndex: idx } };
          }
          return { nav: { selectedIndex: idx }, navigate: { to: "alerts" } };
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
