// Entry point. Decides — based on persisted settings — whether to
// render the companion settings UI on the phone or to mount the
// glasses HUD. Never both: the glasses are useless without an API key
// + at least one favorite, and the settings UI is useless once the
// glasses are running.
//
// Routing rules:
//   - apiKey empty OR favorites empty   ->  companion settings DOM.
//                                           Glasses are not touched.
//   - otherwise                         ->  glasses Home screen via
//                                           `mountGlassesScreen`.
//
// The Router for WP6 handles only `home` and `exit`. Placeholder
// branches for `predictions` / `incidents` / `voice` log the intent
// and leave the user on Home rather than tearing the page down —
// that way no user is ever stranded on a missing screen.

import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";

import { loadSettings } from "./storage/settings";
import { mountSettingsScreen } from "./screens/settings";
import { mountGlassesScreen } from "./screens/glasses-host";
import { makeHomeScreen } from "./screens/home";
import {
  computeUserLines,
  makeIncidentsScreen,
  makeInitialIncidentsSnapshot,
} from "./screens/incidents";
import { makePredictionsScreen } from "./screens/predictions";
import type { NavIntent, Router } from "./screens/router";
import { createSttEngine, makeVoiceScreen } from "./screens/voice";
import {
  WmataClient,
  buildRailPredictionsUrl,
  resolveStationCode,
  searchStations,
  type PredictionsResponse,
} from "./wmata";
import {
  readCachedIncidents,
  refreshIncidents,
} from "./wmata/incidents-cache";

async function bootGlasses(): Promise<void> {
  const bridge = await waitForEvenAppBridge();

  // One WMATA client per glasses session — the API key only changes
  // when the user re-runs the companion settings flow, which forces a
  // full page reload anyway.
  const client = new WmataClient(loadSettings().apiKey);

  // Build the Home screen with a fresh-load snapshot factory. We
  // call `loadSettings()` inside `init` so re-mounting the screen
  // (e.g. after a return-from-predictions) picks up any favorite-list
  // changes made on the phone in the interim. The cached incident
  // count is seeded from the shared cache so a re-mount doesn't blink
  // the ALERTS row off-then-on while the first tick is in flight.
  const homeScreen = makeHomeScreen(
    () => ({
      favorites: loadSettings().favorites,
      incidentCount: readCachedIncidents().incidents.length,
    }),
    {
      refreshIncidentCount: async (): Promise<number> => {
        const userLines = computeUserLines(loadSettings().favorites);
        const cache = await refreshIncidents(client, userLines);
        return cache.incidents.length;
      },
      tickIntervalMs: 60_000,
    },
  );

  // Mutable handle to the active unmount fn so the router can swap
  // screens cleanly.
  let unmount: (() => Promise<void>) | null = null;

  const router: Router = {
    current: "exit",
    navigate: async (intent: NavIntent): Promise<void> => {
      switch (intent.to) {
        case "home": {
          if (unmount) {
            // Already on the home screen; ignore.
            if (router.current === "home") return;
            await unmount();
            unmount = null;
          }
          router.current = "home";
          unmount = await mountGlassesScreen(homeScreen, bridge, router);
          return;
        }
        case "exit": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          router.current = "exit";
          return;
        }
        case "predictions": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          // Resolve a human-readable station name for the header. If the
          // station-cache lookup fails (network error, unknown code) we
          // fall back to the raw code so the screen still mounts.
          let stationName = intent.stationCode;
          try {
            const station = await resolveStationCode(client, intent.stationCode);
            if (station) stationName = station.Name;
          } catch (err) {
            console.warn(
              `[router] resolveStationCode(${intent.stationCode}) failed:`,
              err,
            );
          }

          const fetcher = async () => {
            const url = buildRailPredictionsUrl(intent.stationCode);
            const data = await client.get<PredictionsResponse>(url);
            return {
              trains: data.Trains ?? [],
              // WP8 will wire real incidents into the footer; for WP7
              // the predictions screen ships with an inert headline.
              incidentHeadline: null,
            };
          };

          const screen = makePredictionsScreen(fetcher, {
            stationCode: intent.stationCode,
            stationName,
            trains: [],
            fetchedAt: 0,
            fetchError: null,
            incidentHeadline: null,
          });
          router.current = "predictions";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
        case "incidents": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          const userLines = computeUserLines(loadSettings().favorites);
          // The fetcher always goes through the shared cache so the
          // Home screen's ticking + the Incidents screen's ticking
          // converge on a single source of truth.
          const fetcher = async () => {
            const cache = await refreshIncidents(client, userLines);
            return {
              incidents: cache.incidents,
              fetchedAt: cache.fetchedAt,
              fetchError: cache.fetchError,
            };
          };
          const initial = makeInitialIncidentsSnapshot(readCachedIncidents());
          const screen = makeIncidentsScreen(fetcher, initial);
          router.current = "incidents";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
        case "voice": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          // The STT engine is the only WMATA-unrelated dependency this
          // screen needs. `createSttEngine` intentionally throws today
          // — see `src/screens/voice.ts` for the wiring TODO. We catch
          // here so the user gets a clear error phase on the HUD
          // rather than an uncaught exception in the router.
          let stt;
          try {
            stt = createSttEngine(loadSettings().apiKey);
          } catch (err) {
            console.warn(`[router] createSttEngine failed:`, err);
            // Bounce back to Home rather than mounting a half-broken
            // page. The Home screen's footer is the natural recovery
            // surface (and the user can re-attempt or change settings).
            await router.navigate({ to: "home" });
            return;
          }
          const screen = makeVoiceScreen(
            stt,
            (q: string) => searchStations(client, q),
          );
          router.current = "voice";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
      }
    },
  };

  await router.navigate({ to: "home" });
}

function bootCompanion(root: HTMLElement): void {
  // The settings screen returns an unmount fn, but main.ts doesn't
  // currently need to call it — the user navigates by reloading the
  // page after they save settings. Capturing the handle anyway so a
  // future "Reset" flow can reuse it cleanly.
  const unmount = mountSettingsScreen(root);
  // Stash on a module-private symbol for debugging only.
  type GlobalWithUnmount = typeof globalThis & {
    __wmataSettingsUnmount?: () => void;
  };
  (globalThis as GlobalWithUnmount).__wmataSettingsUnmount = unmount;
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const hasKey = settings.apiKey.length > 0;
  const hasFavorites = settings.favorites.length > 0;

  if (!hasKey || !hasFavorites) {
    const root = document.getElementById("app");
    if (!root) {
      console.error("[main] #app root missing; cannot mount companion UI");
      return;
    }
    bootCompanion(root);
    return;
  }

  try {
    await bootGlasses();
  } catch (err) {
    console.error("[main] bootGlasses failed:", err);
  }
}

void main();
