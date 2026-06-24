/// <reference types="vite/client" />

// Preview/verification entry (glasses-preview.html). Two modes:
//   - LIVE: if VITE_WMATA_KEY is set (.env.local), boots a real Session and the
//     production `buildScreen` wiring against the live WMATA API — real ETAs /
//     alerts in the simulator.
//   - FIXTURE: otherwise, deterministic fixture data (no network / no key).
// Either way it boots the REAL host + screens, so the simulator renders actual
// SDK containers. `?screen=unconfigured` mounts that state first.

import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { mountGlassesScreen } from "../host/glasses-host";
import { Session, buildScreen } from "../host/wiring";
import { makeUnconfiguredScreen } from "../screens/unconfigured";
import { makeHomeScreen, type HomeSnapshot } from "../screens/home";
import { makePredictionsScreen, makeInitialPredictionsSnapshot } from "../screens/predictions";
import { makeAlertsScreen, makeInitialAlertsSnapshot } from "../screens/alerts";
import { makeAlertDetailScreen } from "../screens/alert-detail";
import { makeCarMenuScreen } from "../screens/car-menu";
import { makeCarDetailsScreen } from "../screens/car-details";
import { buildAlertItems } from "../data/domain/alerts";
import { carKey, matchesTrackedCar } from "../data/domain/tracked";
import { isTracked, addTrackedCar, removeTrackedCar } from "../storage/settings";
import type { NavIntent, Router, Screen } from "../screens/router";
import type { FavoriteStation } from "../data/domain/lines";
import type { Train, RailIncident, ElevatorIncident } from "../data/wmata";

// Real WMATA station codes, so LIVE mode returns real data.
const FAVORITES: FavoriteStation[] = [
  { code: "A01", name: "Metro Center", lines: ["RD", "BL", "OR", "SV"] },
  { code: "C04", name: "Foggy Bottom-GWU", lines: ["BL", "OR", "SV"] },
  { code: "B11", name: "Glenmont", lines: ["RD"] },
  { code: "D02", name: "Smithsonian", lines: ["BL", "OR", "SV"] },
  { code: "K08", name: "Wiehle-Reston East", lines: ["SV"] },
];

const PARAMS = new URLSearchParams(location.search);
const KEY = (import.meta.env.VITE_WMATA_KEY as string | undefined) ?? "";
// `?fixtures` forces fixture mode even with a key (deterministic accent tests).
const LIVE = KEY.length > 0 && !PARAMS.has("fixtures");

// --- Fixtures (no-key fallback) -------------------------------------------

const ETAS: Record<string, string | null> = { A01: "4", C04: "ARR", B35: "12", D02: "BRD", K08: "9" };
const train = (Line: string, dest: string, Min: string): Train => ({
  Car: "6",
  Destination: dest,
  DestinationCode: null,
  DestinationName: dest,
  Group: "1",
  Line,
  LocationCode: "A01",
  LocationName: "Metro Center",
  Min,
});
const FIXTURE_TRAINS: Train[] = [
  train("OR", "Vienna", "ARR"),
  train("RD", "Glenmont", "BRD"),
  train("RD", "Shady Grove", "3"),
  train("SV", "Wiehle-Reston East", "7"),
  train("BL", "Franconia-Springfield", "9"),
  train("OR", "New Carrollton", "12"),
];
const INCIDENTS: RailIncident[] = [
  {
    IncidentID: "1",
    IncidentType: "Delay",
    LinesAffected: "RD;",
    DateUpdated: "",
    Description:
      "Red Line: Single-tracking between Fort Totten and Takoma due to a disabled train. Expect residual delays in both directions; allow extra travel time this evening.",
  },
  {
    IncidentID: "2",
    IncidentType: "Alert",
    LinesAffected: "OR; SV;",
    DateUpdated: "",
    Description: "Orange/Silver: Trains operating with minor delays due to a track inspection near Ballston.",
  },
];
const OUTAGES: ElevatorIncident[] = [
  {
    DateOutOfServ: "",
    DateUpdated: "",
    EstimatedReturnToService: "Jun 22, 6:00 PM",
    LocationDescription: "Mezzanine to street elevator, west entrance",
    StationCode: "A01",
    StationName: "Metro Center, 13th St Entrance",
    SymptomDescription: "Maintenance",
    UnitName: "X1",
    UnitType: "ELEVATOR",
  },
];
const ALERT_ITEMS = buildAlertItems(INCIDENTS, OUTAGES);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixtureScreen(intent: NavIntent): Screen<any> | null {
  switch (intent.to) {
    case "home":
      return makeHomeScreen((): HomeSnapshot => ({ favorites: FAVORITES, favoriteEtas: ETAS, alertCount: ALERT_ITEMS.length }));
    case "predictions":
      return makePredictionsScreen(
        async () => ({ trains: FIXTURE_TRAINS, fetchedAt: Date.now(), fetchError: null }),
        makeInitialPredictionsSnapshot(intent.stationCode, intent.stationName),
      );
    case "alerts":
      return makeAlertsScreen(async () => ({ items: ALERT_ITEMS, fetchedAt: Date.now(), fetchError: null }), makeInitialAlertsSnapshot());
    case "alertDetail":
      return makeAlertDetailScreen(ALERT_ITEMS[intent.index] ?? { title: "Alert", detail: "Not found." });
    case "carMenu":
      return makeCarMenuScreen(intent.car, isTracked(intent.car));
    case "carDetails":
      return makeCarDetailsScreen(intent.car, async () =>
        FIXTURE_TRAINS.filter((t) => matchesTrackedCar(t, intent.car)).map((t) => t.Min),
      );
    case "trackToggle":
      if (isTracked(intent.car)) removeTrackedCar(carKey(intent.car));
      else addTrackedCar(intent.car);
      return makePredictionsScreen(
        async () => ({ trains: FIXTURE_TRAINS, fetchedAt: Date.now(), fetchError: null }),
        makeInitialPredictionsSnapshot(intent.car.stationCode, intent.car.stationName),
      );
    case "unconfigured":
    case "exit":
      return null;
  }
}

// --- Boot ------------------------------------------------------------------

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (root) root.textContent = `WMATA G2 preview harness — ${LIVE ? "LIVE data" : "fixtures"}.`;

  const bridge = await waitForEvenAppBridge();
  const session = LIVE ? new Session(KEY) : null;
  let unmount: (() => Promise<void>) | null = null;

  const router: Router = {
    current: "home",
    navigate: async (intent: NavIntent): Promise<void> => {
      if (unmount) {
        await unmount();
        unmount = null;
      }
      if (intent.to === "exit") {
        console.log("[preview] exit");
        return;
      }
      router.current = intent.to;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let screen: Screen<any> | null;
      if (intent.to === "unconfigured") screen = makeUnconfiguredScreen();
      else if (LIVE && session) screen = await buildScreen(session, intent, () => FAVORITES);
      else screen = fixtureScreen(intent);
      if (screen) {
        unmount = await mountGlassesScreen(screen, bridge, router);
        console.log(`[preview] mounted: ${intent.to}`);
      }
    },
  };

  const start = PARAMS.get("screen");
  await router.navigate(start === "unconfigured" ? { to: "unconfigured" } : { to: "home" });
  console.log("[preview] ready");
}

void main().catch((e) => console.error(e));
