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
import { makePredictionsScreen } from "./screens/predictions";
import type { NavIntent, Router } from "./screens/router";
import {
  WmataClient,
  buildRailPredictionsUrl,
  resolveStationCode,
  type PredictionsResponse,
} from "./wmata";

async function bootGlasses(): Promise<void> {
  const bridge = await waitForEvenAppBridge();

  // Build the Home screen with a fresh-load snapshot factory. We
  // call `loadSettings()` inside `init` so re-mounting the screen
  // (e.g. after a return-from-predictions) picks up any favorite-list
  // changes made on the phone in the interim.
  const homeScreen = makeHomeScreen(() => ({
    favorites: loadSettings().favorites,
  }));

  // One WMATA client per glasses session — the API key only changes
  // when the user re-runs the companion settings flow, which forces a
  // full page reload anyway.
  const client = new WmataClient(loadSettings().apiKey);

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
            nowMs: Date.now(),
          });
          router.current = "predictions";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
        case "incidents": {
          console.log(`[router] incidents screen not yet implemented in WP6`);
          return;
        }
        case "voice": {
          console.log(`[router] voice screen not yet implemented in WP6`);
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
