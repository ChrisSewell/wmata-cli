// Entry point. Glasses-first, matching the Even Hub SDK model (and our
// other G2 apps, e.g. FlightAware_G2): on launch we acquire the bridge,
// then run the phone companion settings UI AND the glasses HUD
// CONCURRENTLY — never gating one behind the other.
//
// Boot sequence (`main`):
//   1. `waitForEvenAppBridge()` with a timeout fallback — so a plain
//      browser (no host) degrades to companion-only instead of hanging.
//   2. Hydrate settings from the durable bridge store into localStorage
//      and register the write-mirror, so variables persist across
//      sessions on hardware (WebView localStorage alone may be cleared).
//   3. Mount the companion settings UI on the phone (always).
//   4. Boot the glasses (always, when a bridge exists): show the
//      `unconfigured` placeholder until an API key + a favorite are set,
//      then auto-swap to the live Home screen — no reload, no button.
//      A lightweight watcher (`bootGlasses`) re-evaluates settings and
//      rebuilds the glasses view when the API key changes or config
//      becomes complete / is cleared on the phone.
//
// The Router below handles every `NavIntent.to` variant: `home`,
// `exit`, `predictions`, `incidents`, and `voice`. Each branch tears
// down the previous screen (`unmount`), builds the next, and mounts it.
// The `voice` branch additionally degrades gracefully when the STT
// provider hasn't been wired in (see `createSttEngine` in
// `src/screens/voice.ts`): it bounces back to Home rather than mounting
// a half-broken screen, so a missing STT never strands the user.

import {
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";

import { recordOpen } from "./storage/history";
import { loadSettings, setStorageMirror } from "./storage/settings";
import {
  hydrateSettingsFromBridge,
  mirrorToBridge,
} from "./storage/bridge-sync";
import { mountSettingsScreen } from "./screens/settings";
import { mountGlassesScreen } from "./screens/glasses-host";
import { makeUnconfiguredScreen } from "./screens/unconfigured";
import { makeHomeScreen, soonestEta } from "./screens/home";
import {
  computeUserLines,
  makeIncidentsScreen,
  makeInitialIncidentsSnapshot,
} from "./screens/incidents";
import {
  makeElevatorScreen,
  makeInitialElevatorSnapshot,
} from "./screens/elevator";
import {
  makeInitialJourneySnapshot,
  makeJourneyScreen,
  type JourneyNextTrain,
} from "./screens/journey";
import {
  bucketLastTrainsByLine,
  makePredictionsScreen,
  resolvePinnedPosition,
  type LastTrainByLine,
  type PredictionsSnapshot,
} from "./screens/predictions";
import type { NavIntent, Router } from "./screens/router";
import { makeTutorialScreen } from "./screens/tutorial";
import {
  createSttEngine,
  makeVoiceScreen,
  resolveVoiceIntent,
} from "./screens/voice";
import { evaluateSchedule } from "./schedule/rules";
import { findNearestFavorite } from "./geofence/geofence";
import { Session } from "./session";
import { parseLinesAffected } from "./wmata/incidents-cache";
import {
  buildRailPredictionsUrl,
  type LineCode,
  type PathStep,
  type PredictionsResponse,
  type RailIncident,
  type Station,
} from "./wmata";

/**
 * How long to wait for the Even App bridge before falling back to
 * companion-only (browser / no-host) mode, so the app never hangs on a
 * bridge that will never arrive. Matches the 2s used by FlightAware_G2.
 */
const BRIDGE_TIMEOUT_MS = 2_000;

/**
 * How often the glasses boot watcher re-reads settings to detect a
 * phone-side config change (setup completed, API key changed, config
 * cleared) and swap the glasses view. Reads are synchronous localStorage,
 * so this is cheap; 1.5s keeps the unconfigured→Home hand-off feeling
 * immediate without busy-looping.
 */
const CONFIG_WATCH_INTERVAL_MS = 1_500;

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

/**
 * Fetch the soonest next-train ETA for every favorite station in ONE
 * batched WMATA predictions call and return a `stationCode → Min token`
 * map. The token is the raw `Min` of the soonest upcoming train at that
 * station across all of its lines (`"4"` / `"ARR"` / `"BRD"`), or
 * `null` when the station has no upcoming train. Drives the Home
 * screen's live departure board.
 *
 * Batching: WMATA's `GetPrediction` endpoint accepts a comma-joined
 * list of station codes (`.../GetPrediction/A01,B01,B03`) and returns a
 * single `Trains[]` array spanning them all — so N favorites cost ONE
 * request, not N, keeping us comfortably under the 10 req/s ceiling.
 * The returned trains carry `LocationCode`, which we group by to find
 * each station's soonest departure.
 *
 * Best-effort: any failure (network, decode) throws, and the caller
 * (`refreshFavoriteEtas`) lets the tick swallow it so the rows linger
 * at their last values rather than blanking. An empty favorites list
 * short-circuits to `{}` without a network call.
 */
async function buildFavoriteEtaMap(
  session: Session,
  codes: readonly string[],
): Promise<Record<string, string | null>> {
  if (codes.length === 0) return {};
  // One request for all favorites. The comma-join is the documented
  // multi-station form of GetPrediction.
  const url = buildRailPredictionsUrl(codes.join(","));
  const data = await session.client.get<PredictionsResponse>(url);
  const trains = data.Trains ?? [];

  // Bucket each train's `Min` token by the station it departs from
  // (`LocationCode`). We only collect tokens for codes the user
  // actually favorites — the multi-station response can include
  // platform siblings (e.g. Gallery Place B01/F01) we didn't ask for.
  const wanted = new Set<string>(codes);
  const minsByCode = new Map<string, string[]>();
  for (const t of trains) {
    const code = t.LocationCode;
    if (!code || !wanted.has(code)) continue;
    const bucket = minsByCode.get(code);
    if (bucket) bucket.push(t.Min);
    else minsByCode.set(code, [t.Min]);
  }

  // Build the map for every requested code so a station with no trains
  // in the response gets an explicit `null` (rendered as a blank,
  // aligned cell — distinct from the absent-key "loading" state before
  // the first successful fetch).
  const out: Record<string, string | null> = {};
  for (const code of wanted) {
    out[code] = soonestEta(minsByCode.get(code) ?? []);
  }
  return out;
}

/**
 * Best-effort geolocation lookup. Returns `null` on any failure
 * (permission denied, timeout, runtime without `navigator.geolocation`,
 * any thrown error). The boot path treats null as "geofence didn't
 * fire" — fall through to the normal nav flow.
 *
 * `timeoutMs` caps how long we wait before giving up; 5s is more
 * than enough for a GPS-warm device and short enough not to delay
 * the glasses HUD mount when GPS is unavailable.
 */
async function geolocateOnce(
  timeoutMs: number = 5_000,
): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: { lat: number; lon: number } | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => settle({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => settle(null),
        { timeout: timeoutMs, maximumAge: 60_000 },
      );
    } catch {
      settle(null);
    }
    // Belt-and-suspenders timeout: getCurrentPosition's own timeout
    // should fire, but some WebView implementations have been known
    // to ignore it.
    setTimeout(() => settle(null), timeoutMs + 500);
  });
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
 * Read tonight's last-train summary for `code`, bucketed by line.
 * Each entry is the latest PM departure on a line that this station
 * serves. Returns `null` on any failure (cache miss, unknown
 * station, network blip).
 *
 * Per-line resolution (WP-J): for each `LastTrains[]` entry, the
 * destination station's primary line (`LineCode1`, falling through
 * to `LineCode2`/3/4 for multi-line termini) tells us which line
 * the train is running on. We bucket by that line and pick the
 * latest PM time per bucket.
 */
async function readLastTrainToday(
  session: Session,
  code: string,
): Promise<LastTrainByLine[] | null> {
  try {
    const times = await session.getStationTimes(code);
    if (!times) return null;
    const today = WEEKDAY_KEYS[new Date().getDay()];
    const day = times[today];
    if (!day) return null;
    const lastTrains = day.LastTrains ?? [];
    if (lastTrains.length === 0) return [];
    // Build a `destinationStation → line` map by resolving each
    // unique destination through the stations cache. We only
    // resolve uniques (a busy station has lots of duplicates in
    // LastTrains[]) to minimise the lookup load.
    const uniqueDests = new Set<string>(
      lastTrains.map((t) => t.DestinationStation).filter((s) => s.length > 0),
    );
    const destToLine = new Map<string, string>();
    for (const dest of uniqueDests) {
      const station = await session.resolveStationCode(dest);
      if (!station) continue;
      // For multi-line termini, prefer LineCode1 by convention. A
      // future WP could be smarter (cross-reference with the
      // station's served-lines), but the heuristic is correct for
      // every WMATA terminus today — all terminus stations are
      // single-line.
      const line =
        station.LineCode1 ??
        station.LineCode2 ??
        station.LineCode3 ??
        station.LineCode4 ??
        null;
      if (line) destToLine.set(dest, line);
    }
    return bucketLastTrainsByLine(lastTrains, destToLine);
  } catch {
    return null;
  }
}

/**
 * Boot the fully-configured glasses app: build a Session from the saved
 * API key, wire the screen router, and navigate to the initial screen.
 *
 * Returns a teardown function the boot watcher (`bootGlasses`) calls to
 * tear the whole thing down — used when the user changes their API key on
 * the phone (rebuild with a fresh Session) or clears their config (fall
 * back to the `unconfigured` placeholder). Precondition: `loadSettings()`
 * has a non-empty `apiKey` AND at least one favorite (the watcher only
 * calls this once config is complete).
 */
async function bootConfiguredApp(
  bridge: EvenAppBridge,
): Promise<() => Promise<void>> {
  // One Session per configured boot. The Session owns the WmataClient AND
  // the stations/incidents caches; when the API key changes on the phone,
  // the watcher tears this down and calls us again to build a fresh one.
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
        // Seed empty = "loading": no per-favorite ETA is known until
        // the first `refreshFavoriteEtas` tick lands. An empty map
        // renders the rows without an ETA cell content (blank, aligned)
        // so the first paint doesn't blink an ETA in then out.
        favoriteEtas: {},
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
      refreshFavoriteEtas: async (): Promise<
        Record<string, string | null>
      > => {
        // Re-read favorites each tick so a phone-side edit is picked up
        // without remounting. One batched predictions call covers them
        // all. Any throw here propagates to the tick's allSettled, which
        // preserves the prior ETA map (rows linger, never blank).
        const codes = loadSettings().favorites.map((f) => f.code);
        return buildFavoriteEtaMap(session, codes);
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
          // Travel-history hook: log the station code the user just
          // opened. The companion's "Reorder favorites?" suggestion
          // reads this to surface popular destinations. Stays purely
          // on-device.
          recordOpen(intent.stationCode, Date.now());
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

          const fetcher = async (
            snapshot: PredictionsSnapshot,
          ) => {
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
            // WP-I live-position lookup. Only burns a fetch when
            // the user has a pin active — otherwise null. The two
            // calls run in parallel (StandardRoutes is cached after
            // the first hit so it's free thereafter).
            let pinnedPosition = null;
            if (snapshot.pinned !== null) {
              const [positions, routes] = await Promise.all([
                session.getTrainPositions(),
                session.getStandardRoutes(),
              ]);
              pinnedPosition = resolvePinnedPosition(
                snapshot.pinned,
                intent.stationCode,
                positions,
                routes,
              );
            }
            return {
              trains: data.Trains ?? [],
              incidentHeadline: readFirstIncidentHeadline(session),
              lastTrainToday,
              pinnedPosition,
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
            // Pin is per-mount — the user re-engages with TAP when
            // they navigate back to Predictions. This avoids stale
            // pins surviving across station changes.
            pinned: null,
            // WP-I: resolved once the user pins a train AND the
            // first TrainPositions tick lands. `null` hides the
            // schematic + "stops away" rows.
            pinnedPosition: null,
            // WP-M opt-in cursor: hidden until the user scrolls.
            cursorVisible: false,
            // WP-M pin-gone latch: set by the tick when a pinned
            // train rolls off; cleared on the next miss.
            pinnedGone: false,
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
        case "journey": {
          if (unmount) {
            await unmount();
            unmount = null;
          }
          const plan = loadSettings().journeyPlan;
          const fetcher = async () => {
            if (plan.origin.length === 0 || plan.destination.length === 0) {
              return {
                legs: null,
                originName: "",
                destinationName: "",
                transferName: "",
                nextTrain: null,
              };
            }
            const hasTransfer =
              typeof plan.transfer === "string" && plan.transfer.length > 0;
            const [origStation, destStation, transferStation] =
              await Promise.all([
                session.resolveStationCode(plan.origin),
                session.resolveStationCode(plan.destination),
                hasTransfer
                  ? session.resolveStationCode(plan.transfer!)
                  : Promise.resolve(null),
              ]);

            // Path composition.
            let legs: PathStep[][] | null = null;
            if (hasTransfer) {
              const [leg1, leg2] = await Promise.all([
                session.getPath(plan.origin, plan.transfer!),
                session.getPath(plan.transfer!, plan.destination),
              ]);
              if (leg1 === null || leg2 === null) {
                legs = null;
              } else if (leg1.length === 0 || leg2.length === 0) {
                // One leg is itself cross-line — the user picked a
                // bad transfer station.
                legs = [];
              } else {
                legs = [leg1, leg2];
              }
            } else {
              const path = await session.getPath(plan.origin, plan.destination);
              if (path === null) legs = null;
              else if (path.length === 0) legs = [];
              else legs = [path];
            }

            // Live next-train at origin (WP-K). Pull the predictions
            // for the origin station and pick the first train whose
            // line matches the origin leg. Best-effort: any failure
            // here resolves to null.
            let nextTrain: JourneyNextTrain | null = null;
            try {
              const data = await session.client.get<PredictionsResponse>(
                buildRailPredictionsUrl(plan.origin),
              );
              const trains = data.Trains ?? [];
              const originLine =
                legs && legs.length > 0 ? legs[0]![0]?.LineCode : null;
              const match = originLine
                ? trains.find((t) => t.Line === originLine)
                : trains[0];
              if (match) {
                nextTrain = {
                  line: match.Line,
                  min: match.Min,
                  destination: match.Destination || match.DestinationName,
                };
              }
            } catch {
              nextTrain = null;
            }

            return {
              legs,
              originName: origStation?.Name ?? plan.origin,
              destinationName: destStation?.Name ?? plan.destination,
              transferName: transferStation?.Name ?? plan.transfer ?? "",
              nextTrain,
            };
          };
          const initial = makeInitialJourneySnapshot(plan);
          const screen = makeJourneyScreen(fetcher, initial);
          router.current = "journey";
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

  // First-launch users land on the Tutorial; everyone else picks an
  // initial nav intent from three signals (in priority order):
  //
  //   1. Geofence (WP-G): if enabled AND a favorite is within
  //      MAX_RADIUS_METERS, mount predictions for that station.
  //   2. Schedule auto-rotate (WP-B): a window-matching auto-rotate
  //      rule mounts its configured target.
  //   3. Default: Home.
  //
  // Quiet-hours rules from the same schedule suppress auto-rotate
  // (handled inside `evaluateSchedule`); the geofence overrides
  // BOTH because the user's physical position is the most
  // immediate signal of intent.
  //
  // The inference inside `readTutorialSeen()` means existing v1.1
  // users with a saved API key never see the tutorial on upgrade —
  // only genuine clean-install users do.
  const settings = loadSettings();
  let initialIntent: NavIntent;
  if (!settings.tutorialSeen) {
    initialIntent = { to: "tutorial" };
  } else {
    initialIntent = await pickInitialIntent(settings);
  }
  await router.navigate(initialIntent);

  // Teardown for the boot watcher: route to `exit`, which unmounts the
  // active screen and shuts down the page container. The watcher calls
  // this before rebuilding (API-key change) or before dropping back to
  // the unconfigured placeholder (config cleared on the phone).
  return async (): Promise<void> => {
    await router.navigate({ to: "exit" });
  };
}

/**
 * Glasses boot orchestrator + live-settings watcher.
 *
 * Mounts the right glasses view for the current settings and keeps it in
 * sync as the user edits config on the phone — WITHOUT a page reload:
 *
 *   - No API key OR no favorites  ->  the `unconfigured` placeholder
 *                                     ("finish setup on your phone").
 *   - API key + ≥1 favorite       ->  the full app via `bootConfiguredApp`.
 *
 * A cheap interval re-reads `loadSettings()` (synchronous localStorage)
 * and computes a config "signature". When the signature changes it tears
 * down the current view and mounts the new one:
 *
 *   - unconfigured -> configured : first-time setup completes; the card
 *                                  auto-swaps to Home (the user never
 *                                  touches the glasses).
 *   - API key changes            : rebuild with a fresh Session, so a new
 *                                  key takes effect live.
 *   - configured -> unconfigured : config cleared on the phone; fall back
 *                                  to the placeholder.
 *
 * Favorites edits that DON'T cross the empty/non-empty boundary need no
 * rebuild — the Home screen already re-reads favorites every tick.
 */
async function bootGlasses(bridge: EvenAppBridge): Promise<void> {
  // Active view's teardown (placeholder or configured app), and the
  // signature it was built for. `null` teardown = nothing mounted.
  let activeTeardown: (() => Promise<void>) | null = null;
  let activeSignature: string | null = null;
  // Guards against overlapping reconciles (a slow teardown/mount while
  // the next interval fires) — we skip a tick rather than race.
  let reconciling = false;
  // The watch-interval handle, and a flag that retires the whole
  // subsystem once the user dismisses the setup card (double-tap → exit).
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  /**
   * Config signature: `"configured:<apiKey>"` when the app can run (key
   * + ≥1 favorite), else `"unconfigured"`. Embedding the API key means a
   * key change yields a new signature and forces a Session rebuild.
   */
  const computeSignature = (): string => {
    const s = loadSettings();
    return s.apiKey.length > 0 && s.favorites.length > 0
      ? `configured:${s.apiKey}`
      : "unconfigured";
  };

  /**
   * Tear down the active view AND stop watching — a clean, final exit.
   * Used when the user double-taps the setup card to leave: we don't want
   * a zombie interval polling against a shut-down page. Re-launching the
   * app re-runs `main()` and starts the watcher fresh.
   */
  const stopWatching = async (): Promise<void> => {
    stopped = true;
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (activeTeardown) {
      const teardown = activeTeardown;
      activeTeardown = null;
      await teardown();
    }
    activeSignature = null;
  };

  /** Trivial router for the placeholder: it only ever emits `exit`. */
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
      // Tear down whatever is mounted before building the next view.
      if (activeTeardown) {
        const teardown = activeTeardown;
        activeTeardown = null;
        await teardown();
      }
      // Re-read the signature AFTER the (async) teardown so we build for
      // the LATEST config — a phone-side change during teardown is
      // reflected now rather than one interval later, and the Session
      // `bootConfiguredApp` builds matches the signature we record.
      if (stopped) return;
      const sig = computeSignature();
      activeSignature = sig;
      if (sig === "unconfigured") {
        activeTeardown = await mountGlassesScreen(
          makeUnconfiguredScreen(),
          bridge,
          placeholderRouter,
        );
      } else {
        activeTeardown = await bootConfiguredApp(bridge);
      }
    } catch (err) {
      // A failed build leaves nothing mounted; reset the signature so the
      // next tick retries rather than wedging on a half-built state.
      console.warn("[main] glasses reconcile failed:", err);
      activeSignature = null;
    } finally {
      reconciling = false;
    }
  };

  // Mount the initial view, then poll for phone-side config changes.
  await reconcile();
  if (!stopped) {
    watchTimer = setInterval(() => {
      void reconcile();
    }, CONFIG_WATCH_INTERVAL_MS);
  }
}

/**
 * Pick the boot-time nav intent from geofence / schedule / default.
 * Extracted from `bootGlasses` so the geolocation round-trip is
 * isolated to one async function the host can await once.
 */
async function pickInitialIntent(
  settings: ReturnType<typeof loadSettings>,
): Promise<NavIntent> {
  // Geofence first (WP-G).
  if (settings.geofenceEnabled && settings.favorites.length > 0) {
    const pos = await geolocateOnce();
    if (pos) {
      const hit = findNearestFavorite(settings.favorites, pos.lat, pos.lon);
      if (hit) {
        return { to: "predictions", stationCode: hit.favorite.code };
      }
    }
  }
  // Schedule auto-rotate (WP-B).
  const evaluation = evaluateSchedule(settings.schedule, Date.now());
  const target = evaluation.autoRotateTarget;
  if (target && target.kind === "predictions") {
    return { to: "predictions", stationCode: target.stationCode };
  }
  return { to: "home" };
}

function bootCompanion(root: HTMLElement): void {
  // The companion settings UI is mounted once at startup and stays up for
  // the whole session (it runs concurrently with the glasses now — no
  // page reload on save; the glasses watcher picks up edits live). The
  // settings screen returns an unmount fn we don't currently call;
  // captured anyway so a future "Reset" flow can reuse it cleanly.
  const unmount = mountSettingsScreen(root);
  // Stash on a module-private symbol for debugging only.
  type GlobalWithUnmount = typeof globalThis & {
    __wmataSettingsUnmount?: () => void;
  };
  (globalThis as GlobalWithUnmount).__wmataSettingsUnmount = unmount;
}

async function main(): Promise<void> {
  // 1. Acquire the bridge, but never hang. A plain browser (dev server,
  //    the preview gallery) has no Even App host, so the bridge never
  //    becomes ready — fall back to `null` after a short timeout and run
  //    companion-only. On real hardware / the simulator the bridge
  //    resolves well within the timeout.
  let bridge: EvenAppBridge | null = null;
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    console.warn("[main] waitForEvenAppBridge failed; companion-only:", err);
    bridge = null;
  }

  // 2. Durable settings. Hydrate localStorage from the bridge store, then
  //    register the write-mirror so future saves echo back to it. MUST
  //    run before anything reads settings (companion render, glasses
  //    boot) so a freshly-cleared WebView is repopulated from the store.
  if (bridge) {
    const activeBridge = bridge;
    try {
      await hydrateSettingsFromBridge(activeBridge);
    } catch (err) {
      console.warn("[main] settings hydrate failed; using localStorage:", err);
    }
    setStorageMirror((key, value) => {
      mirrorToBridge(activeBridge, key, value);
    });
  }

  // 3. Companion settings UI on the phone — ALWAYS mounted (concurrent
  //    with the glasses), so the user can enter / edit their variables
  //    at any time.
  const root = document.getElementById("app");
  if (root) bootCompanion(root);
  else console.error("[main] #app root missing; cannot mount companion UI");

  // 4. Glasses — ALWAYS boot when a bridge is present. The watcher shows
  //    the unconfigured placeholder until an API key + favorite are set,
  //    then auto-swaps to the live Home screen (no reload, no button).
  if (bridge) {
    try {
      await bootGlasses(bridge);
    } catch (err) {
      console.error("[main] bootGlasses failed:", err);
    }
  }
}

void main();
