// Maps a NavIntent to a fully-wired Screen against a live Session. Shared by the
// production router (host/main.ts) and the live preview harness, parameterized
// by a favorites source (production reads saved settings; the preview injects a
// fixed list). Keeps all the fetcher/loader glue in one place.

import { Session } from "../data/session";
import type { FavoriteStation } from "../data/domain/lines";
import { computeUserLines } from "../data/domain/lines";
import { buildFavoriteEtaMap, etaSortValue } from "../data/domain/eta";
import { buildAlertItems } from "../data/domain/alerts";
import { carKey, matchesTrackedCar } from "../data/domain/tracked";
import { buildRailPredictionsUrl, type PredictionsResponse } from "../data/wmata";
import { isTracked, addTrackedCar, removeTrackedCar } from "../storage/settings";

import { makeHomeScreen, type HomeSnapshot } from "../screens/home";
import { makePredictionsScreen, makeInitialPredictionsSnapshot } from "../screens/predictions";
import { makeAlertsScreen, makeInitialAlertsSnapshot } from "../screens/alerts";
import { makeAlertDetailScreen } from "../screens/alert-detail";
import { makeCarMenuScreen } from "../screens/car-menu";
import { makeCarDetailsScreen } from "../screens/car-details";
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
      // The station name rides in the intent (the favorite already has it), so
      // we mount synchronously — no pre-mount network fetch. That pre-mount
      // `await` was a race window: a stray click could land on the newly-
      // mounted screen and bounce it straight back.
      const fetcher = async () => {
        const data = await session.client.get<PredictionsResponse>(buildRailPredictionsUrl(intent.stationCode));
        return { trains: data.Trains ?? [], fetchedAt: Date.now(), fetchError: null };
      };
      return makePredictionsScreen(fetcher, makeInitialPredictionsSnapshot(intent.stationCode, intent.stationName));
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
    case "carMenu":
      return makeCarMenuScreen(intent.car, isTracked(intent.car));
    case "carDetails": {
      const car = intent.car;
      const fetcher = async (): Promise<string[]> => {
        const data = await session.client.get<PredictionsResponse>(buildRailPredictionsUrl(car.stationCode));
        return (data.Trains ?? [])
          .filter((t) => matchesTrackedCar(t, car))
          .sort((a, b) => etaSortValue(a.Min) - etaSortValue(b.Min))
          .map((t) => t.Min);
      };
      return makeCarDetailsScreen(car, fetcher);
    }
    case "trackToggle": {
      // Impure step: do the storage write HERE (screens stay pure), then show
      // the board the car is on so the new tracked state is reflected.
      const car = intent.car;
      if (isTracked(car)) removeTrackedCar(carKey(car));
      else addTrackedCar(car);
      return buildScreen(session, { to: "predictions", stationCode: car.stationCode, stationName: car.stationName }, getFavorites);
    }
    case "unconfigured":
    case "exit":
      return null;
  }
}

export { Session };
