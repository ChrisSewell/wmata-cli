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

import { Session, buildScreen } from "./wiring";
import { mountGlassesScreen } from "./glasses-host";
import { makeUnconfiguredScreen } from "../screens/unconfigured";
import type { NavIntent, Router } from "../screens/router";

const BRIDGE_TIMEOUT_MS = 2_000;
const CONFIG_WATCH_INTERVAL_MS = 1_500;

// --- Configured app (one Session per API key) -----------------------------

async function bootConfiguredApp(bridge: EvenAppBridge): Promise<() => Promise<void>> {
  const session = new Session(loadSettings().apiKey);
  const getFavorites = () => loadSettings().favorites;
  let unmount: (() => Promise<void>) | null = null;

  const router: Router = {
    current: "home",
    navigate: async (intent: NavIntent): Promise<void> => {
      if (unmount) {
        await unmount();
        unmount = null;
      }
      router.current = intent.to;
      const screen = await buildScreen(session, intent, getFavorites);
      if (screen) unmount = await mountGlassesScreen(screen, bridge, router);
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

  // Double-press on the unconfigured placeholder exits the app; stop the
  // watcher so it doesn't poll against a shut-down page.
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
