// Maps a NavIntent to a fully-wired Screen against a live Session. Shared by the
// production router (host/main.ts) and the live preview harness, parameterized
// by a favorites source (production reads saved settings; the preview injects a
// fixed list). Keeps all the fetcher/loader glue in one place.

import { Session } from "../data/session";
import type { FavoriteStation } from "../data/domain/lines";
import { computeUserLines } from "../data/domain/lines";
import { buildFavoriteEtaMap } from "../data/domain/eta";
import { buildAlertItems } from "../data/domain/alerts";
import { buildRailPredictionsUrl, type PredictionsResponse } from "../data/wmata";

import { makeHomeScreen, type HomeSnapshot } from "../screens/home";
import { makePredictionsScreen, makeInitialPredictionsSnapshot } from "../screens/predictions";
import { makeAlertsScreen, makeInitialAlertsSnapshot } from "../screens/alerts";
import { makeAlertDetailScreen } from "../screens/alert-detail";
import type { NavIntent, Screen } from "../screens/router";

export const HOME_TICK_MS = 30_000;

/** Provides the current favorites (saved settings in prod, a fixed list in preview). */
export type FavoritesProvider = () => FavoriteStation[];

function homeLoader(session: Session, getFavorites: FavoritesProvider): HomeSnapshot {
  const favorites = getFavorites();
  const alertCount =
    session.readCachedIncidents().incidents.length +
    session.readCachedElevatorIncidents().incidents.length;
  return { favorites, favoriteEtas: {}, alertCount };
}

async function homeRefresh(session: Session, getFavorites: FavoritesProvider): Promise<HomeSnapshot> {
  const favorites = getFavorites();
  const codes = favorites.map((f) => f.code);
  const userLines = computeUserLines(favorites);
  const [etas] = await Promise.all([
    buildFavoriteEtaMap(session.client, codes).catch(() => ({}) as Record<string, string | null>),
    session.refreshIncidents(userLines),
    session.refreshElevatorIncidents(codes),
  ]);
  const alertCount =
    session.readCachedIncidents().incidents.length +
    session.readCachedElevatorIncidents().incidents.length;
  return { favorites, favoriteEtas: etas, alertCount };
}

/**
 * Build the Screen for an intent. Returns null for `exit` (handled by the host)
 * and `unconfigured` (handled by the reconcile watcher). Typed loosely because
 * the screens have distinct snapshot types; the host's `mountGlassesScreen<S>`
 * accepts any of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildScreen(
  session: Session,
  intent: NavIntent,
  getFavorites: FavoritesProvider,
): Promise<Screen<any> | null> {
  switch (intent.to) {
    case "home":
      return makeHomeScreen(
        () => homeLoader(session, getFavorites),
        () => homeRefresh(session, getFavorites),
        HOME_TICK_MS,
      );
    case "predictions": {
      let name = intent.stationCode;
      try {
        const station = await session.resolveStationCode(intent.stationCode);
        if (station) name = station.Name;
      } catch (err) {
        console.warn(`[wiring] resolveStationCode(${intent.stationCode}) failed:`, err);
      }
      const fetcher = async () => {
        const data = await session.client.get<PredictionsResponse>(buildRailPredictionsUrl(intent.stationCode));
        return { trains: data.Trains ?? [], fetchedAt: Date.now(), fetchError: null };
      };
      return makePredictionsScreen(fetcher, makeInitialPredictionsSnapshot(intent.stationCode, name));
    }
    case "alerts": {
      const fetcher = async () => {
        const favorites = getFavorites();
        const [inc, elev] = await Promise.all([
          session.refreshIncidents(computeUserLines(favorites)),
          session.refreshElevatorIncidents(favorites.map((f) => f.code)),
        ]);
        return {
          items: buildAlertItems(inc.incidents, elev.incidents),
          fetchedAt: Math.max(inc.fetchedAt, elev.fetchedAt) || Date.now(),
          fetchError: inc.fetchError ?? elev.fetchError,
        };
      };
      return makeAlertsScreen(fetcher, makeInitialAlertsSnapshot());
    }
    case "alertDetail": {
      const items = buildAlertItems(
        session.readCachedIncidents().incidents,
        session.readCachedElevatorIncidents().incidents,
      );
      const item = items[intent.index] ?? { title: "Alert", detail: "This alert is no longer available." };
      return makeAlertDetailScreen(item);
    }
    case "unconfigured":
    case "exit":
      return null;
  }
}

export { Session };
