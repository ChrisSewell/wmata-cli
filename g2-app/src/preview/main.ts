// Preview/verification entry (glasses-preview.html). Boots the REAL host +
// REAL screens against deterministic fixture data (no network), so the
// simulator renders actual SDK containers for the review loop. Screens not yet
// built render as a labelled placeholder. Drive via the simulator automation
// API: swipe = move, click = open, double-click = back/exit.
//
// `?screen=unconfigured` mounts that screen first (default: home).

import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { mountGlassesScreen } from "../host/glasses-host";
import { makeHomeScreen, type HomeSnapshot } from "../screens/home";
import { makeUnconfiguredScreen } from "../screens/unconfigured";
import { makePredictionsScreen, makeInitialPredictionsSnapshot } from "../screens/predictions";
import { makeAlertsScreen, makeInitialAlertsSnapshot } from "../screens/alerts";
import { makeAlertDetailScreen } from "../screens/alert-detail";
import { buildAlertItems } from "../data/domain/alerts";
import type { NavIntent, Router } from "../screens/router";
import type { FavoriteStation } from "../data/domain/lines";
import type { Train, RailIncident, ElevatorIncident } from "../data/wmata";

const FAVORITES: FavoriteStation[] = [
  { code: "A01", name: "Metro Center", lines: ["RD", "BL", "OR", "SV"] },
  { code: "C04", name: "Foggy Bottom-GWU", lines: ["BL", "OR", "SV"] },
  { code: "B35", name: "NoMa-Gallaudet U", lines: ["RD"] },
  { code: "D02", name: "Smithsonian", lines: ["BL", "OR", "SV"] },
  { code: "K08", name: "Wiehle-Reston East", lines: ["SV"] },
];
const ETAS: Record<string, string | null> = { A01: "4", C04: "ARR", B35: "12", D02: "BRD", K08: "9" };

const homeSnapshot = (): HomeSnapshot => ({ favorites: FAVORITES, favoriteEtas: ETAS, alertCount: 2 });

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

const stationName = (code: string): string => FAVORITES.find((f) => f.code === code)?.name ?? code;

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

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (root) root.textContent = "WMATA G2 preview harness — drive via the simulator automation API.";

  const bridge = await waitForEvenAppBridge();
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
      switch (intent.to) {
        case "home":
          unmount = await mountGlassesScreen(makeHomeScreen(homeSnapshot), bridge, router);
          break;
        case "unconfigured":
          unmount = await mountGlassesScreen(makeUnconfiguredScreen(), bridge, router);
          break;
        case "predictions": {
          const initial = makeInitialPredictionsSnapshot(intent.stationCode, stationName(intent.stationCode));
          const fetcher = async () => ({ trains: FIXTURE_TRAINS, fetchedAt: Date.now(), fetchError: null });
          unmount = await mountGlassesScreen(makePredictionsScreen(fetcher, initial), bridge, router);
          break;
        }
        case "alerts": {
          const fetcher = async () => ({ items: ALERT_ITEMS, fetchedAt: Date.now(), fetchError: null });
          unmount = await mountGlassesScreen(makeAlertsScreen(fetcher, makeInitialAlertsSnapshot()), bridge, router);
          break;
        }
        case "alertDetail": {
          const item = ALERT_ITEMS[intent.index] ?? { title: "Alert", detail: "Not found." };
          unmount = await mountGlassesScreen(makeAlertDetailScreen(item), bridge, router);
          break;
        }
      }
      console.log(`[preview] mounted: ${intent.to}`);
    },
  };

  const start = new URLSearchParams(location.search).get("screen");
  await router.navigate(start === "unconfigured" ? { to: "unconfigured" } : { to: "home" });
  console.log("[preview] ready");
}

void main().catch((e) => console.error(e));
