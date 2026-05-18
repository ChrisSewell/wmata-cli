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
// The Router below handles every `NavIntent.to` variant: `home`,
// `exit`, `predictions`, `incidents`, and `voice`. Each branch tears
// down the previous screen (`unmount`), builds the next, and mounts it.
// The `voice` branch additionally degrades gracefully when the STT
// provider hasn't been wired in (see `createSttEngine` in
// `src/screens/voice.ts`): it bounces back to Home rather than mounting
// a half-broken screen, so a missing STT never strands the user.

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
import {
  makeElevatorScreen,
  makeInitialElevatorSnapshot,
} from "./screens/elevator";
import { makePredictionsScreen, pickLastTrainTime } from "./screens/predictions";
import type { NavIntent, Router } from "./screens/router";
import { makeTutorialScreen } from "./screens/tutorial";
import {
  createSttEngine,
  makeVoiceScreen,
  resolveVoiceIntent,
} from "./screens/voice";
import { evaluateSchedule } from "./schedule/rules";
import { Session } from "./session";
import { parseLinesAffected } from "./wmata/incidents-cache";
import {
  buildRailPredictionsUrl,
  type LineCode,
  type PredictionsResponse,
  type RailIncident,
  type Station,
} from "./wmata";

/**
 * Collect the non-null line codes a Station serves. Inline rather than
 * a top-level helper because this is the only caller and the body is
 * three lines.
 */
function stationLines(station: Station): LineCode[] {
  const out: LineCode[] = [];
  for (const code of [
    station.LineCode1,
    station.LineCode2,
    station.LineCode3,
    station.LineCode4,
  ]) {
    if (code) out.push(code);
  }
  return out;
}

/**
 * Extract the first-sentence headline of the freshest incident from the
 * session's incidents cache. Returns null when the cache is empty (or
 * the first incident has no description) so the Predictions footer can
 * hide.
 */
function readFirstIncidentHeadline(session: Session): string | null {
  const first = session.readCachedIncidents().incidents[0];
  if (!first) return null;
  const desc = first.Description ?? "";
  const headline = desc.split(".")[0]?.trim() ?? "";
  return headline.length > 0 ? headline : null;
}

/**
 * Compute the deduped set of line codes that have at least one active
 * incident, intersected with the user's followed lines. Drives the
 * Home screen's status glyph row.
 */
function computeAffectedLines(
  incidents: readonly RailIncident[],
  userLines: readonly LineCode[],
): LineCode[] {
  if (userLines.length === 0) return [];
  const userSet = new Set<LineCode>(userLines);
  const out = new Set<LineCode>();
  for (const inc of incidents) {
    for (const code of parseLinesAffected(inc.LinesAffected ?? "")) {
      if (userSet.has(code)) out.add(code);
    }
  }
  return Array.from(out);
}

/** Day-of-week key for indexing into a `StationTimes` schedule. */
const WEEKDAY_KEYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Read the latest scheduled departure time from `code`'s
 * `LastTrains[]` for today's day-of-week. Returns `null` on any
 * failure (cache miss, unknown station, network blip). The session
 * cache makes calls after the first one essentially free.
 */
async function readLastTrainToday(
  session: Session,
  code: string,
): Promise<string | null> {
  try {
    const times = await session.getStationTimes(code);
    if (!times) return null;
    const today = WEEKDAY_KEYS[new Date().getDay()];
    const day = times[today];
    if (!day) return null;
    return pickLastTrainTime(day.LastTrains ?? []);
  } catch {
    return null;
  }
}

async function bootGlasses(): Promise<void> {
  const bridge = await waitForEvenAppBridge();

  // One Session per glasses session — the API key only changes when
  // the user re-runs the companion settings flow, which forces a full
  // page reload anyway. The Session owns the WmataClient AND the
  // stations/incidents caches; when v1.1 adds a "swap settings without
  // reload" path, the implementation is just "drop the old Session,
  // build a new one".
  const session = new Session(loadSettings().apiKey);

  // Build the Home screen with a fresh-load snapshot factory. We
  // call `loadSettings()` inside `init` so re-mounting the screen
  // (e.g. after a return-from-predictions) picks up any favorite-list
  // changes made on the phone in the interim. The affected-lines set
  // and the access outage count are seeded from the session caches so
  // a re-mount doesn't blink the synthetic rows off-then-on while the
  // first tick is in flight.
  const homeScreen = makeHomeScreen(
    () => {
      const settings = loadSettings();
      const favorites = settings.favorites;
      const userLines = computeUserLines(favorites);
      const cached = session.readCachedIncidents().incidents;
      const cachedAccess =
        session.readCachedElevatorIncidents().incidents.length;
      const evaluation = evaluateSchedule(settings.schedule, Date.now());
      return {
        favorites,
        affectedLines: computeAffectedLines(cached, userLines),
        accessOutageCount: cachedAccess,
        quietHours: evaluation.quietHours,
      };
    },
    {
      refreshAffectedLines: async (): Promise<LineCode[]> => {
        const userLines = computeUserLines(loadSettings().favorites);
        const cache = await session.refreshIncidents(userLines);
        return computeAffectedLines(cache.incidents, userLines);
      },
      refreshAccessOutageCount: async (): Promise<number> => {
        const codes = loadSettings().favorites.map((f) => f.code);
        const cache = await session.refreshElevatorIncidents(codes);
        return cache.incidents.length;
      },
      refreshQuietHours: async (): Promise<boolean> => {
        const evaluation = evaluateSchedule(
          loadSettings().schedule,
          Date.now(),
        );
        return evaluation.quietHours;
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
          // Resolve a human-readable station name for the header AND the
          // station's served lines. The lines drive the incident filter
          // so the footer only surfaces alerts relevant to *this* station,
          // not the user's full favorite-set. If the station-cache lookup
          // fails (network error, unknown code) we fall back to the raw
          // code for the name and an empty line list (the cache will
          // return no matching incidents in that case, which is the
          // right degraded behaviour).
          let stationName = intent.stationCode;
          let stationServedLines: LineCode[] = [];
          try {
            const station = await session.resolveStationCode(
              intent.stationCode,
            );
            if (station) {
              stationName = station.Name;
              stationServedLines = stationLines(station);
            }
          } catch (err) {
            console.warn(
              `[router] resolveStationCode(${intent.stationCode}) failed:`,
              err,
            );
          }

          const fetcher = async () => {
            const url = buildRailPredictionsUrl(intent.stationCode);
            // Fire predictions + cache-refresh in sequence (not parallel)
            // to keep the request rate under WMATA's 10 req/s ceiling
            // with margin. The session's incidents cache means this also
            // keeps Home's ALERTS count fresh while the user is on
            // Predictions — useful side effect.
            const data = await session.client.get<PredictionsResponse>(url);
            await session.refreshIncidents(stationServedLines);
            // Last-train lookup is a separate HTTP call, but the
            // session cache makes calls beyond the first one free —
            // so a 20s refresh tick only pays the network cost on
            // the very first tick of a glasses session for any given
            // station.
            const lastTrainToday = await readLastTrainToday(
              session,
              intent.stationCode,
            );
            return {
              trains: data.Trains ?? [],
              incidentHeadline: readFirstIncidentHeadline(session),
              lastTrainToday,
            };
          };

          const screen = makePredictionsScreen(fetcher, {
            stationCode: intent.stationCode,
            stationName,
            trains: [],
            fetchedAt: 0,
            fetchError: null,
            // Per-mount counter; the screen's own `tick()` bumps it
            // on each catch and resets to 0 on a successful fetch.
            consecutiveFetchFailures: 0,
            // Seed the headline from the session cache so the first
            // render shows any already-known incident (the cache is
            // shared with Home and the Incidents screen). Avoids a
            // one-tick blink between mount and the first fetcher
            // resolution.
            incidentHeadline: readFirstIncidentHeadline(session),
            // null = not yet loaded; the first tick fills it in. The
            // late-night row hides until then.
            lastTrainToday: null,
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
          // The fetcher always goes through the session's incidents
          // cache so the Home screen's ticking + the Incidents screen's
          // ticking converge on a single source of truth.
          const fetcher = async () => {
            const cache = await session.refreshIncidents(userLines);
            return {
              incidents: cache.incidents,
              fetchedAt: cache.fetchedAt,
              fetchError: cache.fetchError,
            };
          };
          const initial = makeInitialIncidentsSnapshot(
            session.readCachedIncidents(),
          );
          const screen = makeIncidentsScreen(fetcher, initial);
          router.current = "incidents";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
        case "elevator": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          // Filter the elevator outages to the user's favorite station
          // codes — a network-wide list would overflow the HUD. The
          // session-side cache also enforces this filter, so a
          // re-mount of the Elevator screen and a Home tick converge
          // on the same source of truth.
          const codes = loadSettings().favorites.map((f) => f.code);
          const fetcher = async () => {
            const cache = await session.refreshElevatorIncidents(codes);
            return {
              incidents: cache.incidents,
              fetchedAt: cache.fetchedAt,
              fetchError: cache.fetchError,
            };
          };
          const initial = makeInitialElevatorSnapshot(
            session.readCachedElevatorIncidents(),
          );
          const screen = makeElevatorScreen(fetcher, initial);
          router.current = "elevator";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
        case "voice": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          // The STT engine is the only WMATA-unrelated dependency this
          // screen needs. `createSttEngine` throws when the user has
          // not yet entered a Deepgram API key in the companion
          // settings UI. We catch here so the user gets a clear error
          // message on the HUD rather than an uncaught exception in
          // the router, and bounce back to Home.
          const settings = loadSettings();
          let stt;
          try {
            stt = createSttEngine(settings.sttApiKey);
          } catch (err) {
            console.warn(
              "[router] Voice unavailable — Deepgram API key not configured. " +
                "Open the phone app to add one.",
              err,
            );
            // Bounce back to Home rather than mounting a half-broken
            // page. The Home screen's footer is the natural recovery
            // surface (and the user can re-attempt or change settings).
            await router.navigate({ to: "home" });
            return;
          }
          const screen = makeVoiceScreen(
            stt,
            (q: string) => session.searchStations(q),
            undefined,
            // Read voiceTargets at intent-resolution time (not at
            // screen-construction time) so a settings change is
            // picked up on the next utterance without remounting.
            (transcript: string) =>
              resolveVoiceIntent(transcript, loadSettings().voiceTargets),
          );
          router.current = "voice";
          unmount = await mountGlassesScreen(screen, bridge, router);
          return;
        }
        case "tutorial": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          // The Tutorial screen persists `tutorialSeen = true` from
          // its own `onUnmount`, so we don't need to mark it here.
          // Every gesture inside the screen routes back to Home,
          // and the unmount-side persistence runs before the next
          // mount lands.
          router.current = "tutorial";
          unmount = await mountGlassesScreen(makeTutorialScreen(), bridge, router);
          return;
        }
      }
    },
  };

  // First-launch users land on the Tutorial; everyone else consults
  // the schedule evaluator. The inference inside `readTutorialSeen()`
  // means existing v1.1 users with a saved API key never see the
  // tutorial on upgrade — only genuine clean-install users do.
  //
  // Schedule rules: if an auto-rotate window matches right now (and
  // no quiet-hours rule overrides it), boot straight into the
  // configured target screen instead of Home. The user keeps
  // double-tap-to-Home as the manual escape hatch.
  const settings = loadSettings();
  let initialIntent: NavIntent;
  if (!settings.tutorialSeen) {
    initialIntent = { to: "tutorial" };
  } else {
    const evaluation = evaluateSchedule(settings.schedule, Date.now());
    const target = evaluation.autoRotateTarget;
    if (target && target.kind === "predictions") {
      initialIntent = { to: "predictions", stationCode: target.stationCode };
    } else {
      initialIntent = { to: "home" };
    }
  }
  await router.navigate(initialIntent);
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
