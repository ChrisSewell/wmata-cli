// Production entry (index.html). Glasses-first boot: acquire the bridge (with a
// timeout fallback so a plain browser degrades to companion-only), hydrate
// durable settings BEFORE anything reads them, mount the companion settings UI
// on the phone (always), and run the glasses reconcile watcher — which shows
// the Unconfigured placeholder until an API key + a favorite exist, then swaps
// to the live app (no reload). A key change rebuilds the Session live.

import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";

import { mountSettingsScreen } from "../companion/settings";
import { loadSettings, setStorageMirror } from "../storage/settings";
import { hydrateSettingsFromBridge, mirrorToBridge } from "../storage/bridge-sync";

import { Session } from "../data/session";
import { computeUserLines } from "../data/domain/lines";
import { buildFavoriteEtaMap } from "../data/domain/eta";
import { buildAlertItems } from "../data/domain/alerts";
import { buildRailPredictionsUrl, type PredictionsResponse } from "../data/wmata";

import { mountGlassesScreen } from "./glasses-host";
import { makeUnconfiguredScreen } from "../screens/unconfigured";
import { makeHomeScreen, type HomeSnapshot } from "../screens/home";
import { makePredictionsScreen, makeInitialPredictionsSnapshot } from "../screens/predictions";
import { makeAlertsScreen, makeInitialAlertsSnapshot } from "../screens/alerts";
import { makeAlertDetailScreen } from "../screens/alert-detail";
import type { NavIntent, Router } from "../screens/router";

const BRIDGE_TIMEOUT_MS = 2_000;
const CONFIG_WATCH_INTERVAL_MS = 1_500;
const HOME_TICK_MS = 30_000;

// --- Home data wiring -----------------------------------------------------

function homeLoader(session: Session): HomeSnapshot {
  const favorites = loadSettings().favorites;
  const alertCount =
    session.readCachedIncidents().incidents.length +
    session.readCachedElevatorIncidents().incidents.length;
  return { favorites, favoriteEtas: {}, alertCount };
}

async function homeRefresh(session: Session): Promise<HomeSnapshot> {
  const favorites = loadSettings().favorites;
  const codes = favorites.map((f) => f.code);
  const userLines = computeUserLines(favorites);
  // One batched predictions call for ETAs + the two alert caches, in parallel.
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

// --- Configured app (one per API key) -------------------------------------

async function bootConfiguredApp(bridge: EvenAppBridge): Promise<() => Promise<void>> {
  const session = new Session(loadSettings().apiKey);
  let unmount: (() => Promise<void>) | null = null;

  const router: Router = {
    current: "home",
    navigate: async (intent: NavIntent): Promise<void> => {
      if (unmount) {
        await unmount();
        unmount = null;
      }
      router.current = intent.to;
      switch (intent.to) {
        case "home":
          unmount = await mountGlassesScreen(
            makeHomeScreen(() => homeLoader(session), () => homeRefresh(session), HOME_TICK_MS),
            bridge,
            router,
          );
          return;
        case "predictions": {
          let name = intent.stationCode;
          try {
            const station = await session.resolveStationCode(intent.stationCode);
            if (station) name = station.Name;
          } catch (err) {
            console.warn(`[host] resolveStationCode(${intent.stationCode}) failed:`, err);
          }
          const fetcher = async () => {
            const data = await session.client.get<PredictionsResponse>(
              buildRailPredictionsUrl(intent.stationCode),
            );
            return { trains: data.Trains ?? [], fetchedAt: Date.now(), fetchError: null };
          };
          unmount = await mountGlassesScreen(
            makePredictionsScreen(fetcher, makeInitialPredictionsSnapshot(intent.stationCode, name)),
            bridge,
            router,
          );
          return;
        }
        case "alerts": {
          const fetcher = async () => {
            const codes = loadSettings().favorites.map((f) => f.code);
            const userLines = computeUserLines(loadSettings().favorites);
            const [inc, elev] = await Promise.all([
              session.refreshIncidents(userLines),
              session.refreshElevatorIncidents(codes),
            ]);
            return {
              items: buildAlertItems(inc.incidents, elev.incidents),
              fetchedAt: Math.max(inc.fetchedAt, elev.fetchedAt) || Date.now(),
              fetchError: inc.fetchError ?? elev.fetchError,
            };
          };
          unmount = await mountGlassesScreen(makeAlertsScreen(fetcher, makeInitialAlertsSnapshot()), bridge, router);
          return;
        }
        case "alertDetail": {
          // Rebuild the same combined list from the (just-fetched) caches and
          // index into it — same order as the Alerts screen used.
          const items = buildAlertItems(
            session.readCachedIncidents().incidents,
            session.readCachedElevatorIncidents().incidents,
          );
          const item = items[intent.index] ?? { title: "Alert", detail: "This alert is no longer available." };
          unmount = await mountGlassesScreen(makeAlertDetailScreen(item), bridge, router);
          return;
        }
        case "unconfigured":
        case "exit":
          // `exit` is handled by the host (app exit); `unconfigured` by the
          // reconcile watcher. Nothing to mount here.
          return;
      }
    },
  };

  await router.navigate({ to: "home" });

  return async (): Promise<void> => {
    if (unmount) {
      await unmount();
      unmount = null;
    }
  };
}

// --- Glasses reconcile watcher --------------------------------------------

async function bootGlasses(bridge: EvenAppBridge): Promise<void> {
  let activeTeardown: (() => Promise<void>) | null = null;
  let activeSignature: string | null = null;
  let reconciling = false;
  let stopped = false;
  let watchTimer: ReturnType<typeof setInterval> | null = null;

  // `configured:<apiKey>` when the app can run (key + ≥1 favorite), else
  // `unconfigured`. Embedding the key forces a Session rebuild on key change.
  const computeSignature = (): string => {
    const s = loadSettings();
    return s.apiKey.length > 0 && s.favorites.length > 0 ? `configured:${s.apiKey}` : "unconfigured";
  };

  const stopWatching = async (): Promise<void> => {
    stopped = true;
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (activeTeardown) {
      const t = activeTeardown;
      activeTeardown = null;
      await t();
    }
    activeSignature = null;
  };

  // The unconfigured placeholder's only intent is `exit` (handled by the host);
  // double-press there leaves the app, so we stop watching to avoid a zombie
  // poll against a shut-down page.
  const placeholderRouter: Router = {
    current: "unconfigured",
    navigate: async (intent: NavIntent): Promise<void> => {
      if (intent.to === "exit") await stopWatching();
    },
  };

  const reconcile = async (): Promise<void> => {
    if (stopped || reconciling) return;
    if (computeSignature() === activeSignature) return;
    reconciling = true;
    try {
      if (activeTeardown) {
        const t = activeTeardown;
        activeTeardown = null;
        await t();
      }
      if (stopped) return;
      const sig = computeSignature();
      activeSignature = sig;
      if (sig === "unconfigured") {
        activeTeardown = await mountGlassesScreen(makeUnconfiguredScreen(), bridge, placeholderRouter);
      } else {
        activeTeardown = await bootConfiguredApp(bridge);
      }
    } catch (err) {
      console.warn("[host] glasses reconcile failed:", err);
      activeSignature = null; // retry next tick
    } finally {
      reconciling = false;
    }
  };

  await reconcile();
  if (!stopped) {
    watchTimer = setInterval(() => void reconcile(), CONFIG_WATCH_INTERVAL_MS);
  }
}

// --- Companion + boot ------------------------------------------------------

function bootCompanion(): void {
  const root = document.getElementById("app");
  if (root) mountSettingsScreen(root);
  else console.error("[host] #app root missing; cannot mount companion UI");
}

async function main(): Promise<void> {
  let bridge: EvenAppBridge | null = null;
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn("[host] waitForEvenAppBridge failed; companion-only:", err);
    bridge = null;
  }

  // Durable settings: hydrate localStorage from the bridge store, then mirror
  // future writes back. MUST run before anything reads settings.
  if (bridge) {
    const b = bridge;
    try {
      await hydrateSettingsFromBridge(b);
    } catch (err) {
      console.warn("[host] settings hydrate failed; using localStorage:", err);
    }
    setStorageMirror((key, value) => mirrorToBridge(b, key, value));
  }

  bootCompanion();

  if (bridge) {
    try {
      await bootGlasses(bridge);
    } catch (err) {
      console.error("[host] bootGlasses failed:", err);
    }
  }
}

void main();
