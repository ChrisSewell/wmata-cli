// Calendar-bridge spike + scaffolding (WP-L).
//
// The user's next meeting carries useful transit context: the user
// wants to *be* at a particular place at a particular time, and we
// know which favorite station is nearest. If we can reach the
// device's calendar API, we can pre-load Predictions for the right
// station automatically before they leave.
//
// WP-L splits this into two parts:
//
//   L.1 (spike): verify on real Even Realities hardware whether the
//   companion app's WebView exposes any of the candidate APIs.
//   Without that verification we can't ship a working bridge — the
//   Web Calendar API isn't standardised, and the Even Realities
//   SDK doesn't document a calendar surface.
//
//   L.2 (build): conditional on L.1 returning "yes". The bridge
//   reads the next event with a location, geocodes the location
//   to a nearest favorite, and writes a transient schedule rule
//   so the next boot mounts predictions for that station.
//
// This module ships L.1's infrastructure: a pure
// `probeCalendarAvailability()` that checks the available surface
// at runtime. The result is unit-testable (stub `globalThis`
// during the test) and lets the eventual L.2 build know which
// path to take without re-doing the discovery.

/** Result of the platform-availability probe. */
export type CalendarAvailability =
  | { kind: "w3c" } // standard `navigator.calendar` (experimental Chromium flag)
  | { kind: "host-bridge"; surface: string } // host-side bridge — e.g. `window.evenhubCalendar`
  | { kind: "intent-scheme" } // content://com.android.calendar pair (rare)
  | { kind: "unavailable"; reason: string };

/**
 * Probe what calendar surface (if any) the current runtime exposes.
 *
 * Pure / safe to call from any context — never touches calendar
 * data, just checks for the presence of API symbols. Designed to
 * be called once at companion mount and the result cached.
 *
 * The function is intentionally conservative — it only reports
 * `unavailable` for the absent state. A real "yes" result must
 * still be verified by `fetchUpcomingEvents()` actually returning
 * data; the probe is the first-pass filter that lets the caller
 * skip the fetch when there's no chance of success.
 */
export function probeCalendarAvailability(): CalendarAvailability {
  // 1. W3C Calendar API. As of 2026 this is still experimental and
  // gated behind a Chromium flag (`#experimental-web-platform-features`).
  // `navigator.calendar` would be the entry point if/when it ships.
  type NavWithCalendar = Navigator & { calendar?: unknown };
  if (typeof navigator !== "undefined") {
    const nav = navigator as NavWithCalendar;
    if (typeof nav.calendar === "object" && nav.calendar !== null) {
      return { kind: "w3c" };
    }
  }

  // 2. Host-side bridge injection. The Even Realities SDK might
  // expose a calendar surface in a future release; the convention
  // would be `window.evenhubCalendar` or a similar identifier.
  // Check a couple of likely names.
  type WindowWithBridge = Window & {
    evenhubCalendar?: unknown;
    EvenhubCalendar?: unknown;
  };
  if (typeof window !== "undefined") {
    const w = window as WindowWithBridge;
    if (typeof w.evenhubCalendar === "object" && w.evenhubCalendar !== null) {
      return { kind: "host-bridge", surface: "window.evenhubCalendar" };
    }
    if (typeof w.EvenhubCalendar === "object" && w.EvenhubCalendar !== null) {
      return { kind: "host-bridge", surface: "window.EvenhubCalendar" };
    }
  }

  // 3. Intent scheme (Android-only). Probing this from JS isn't
  // reliable — the scheme exists whether or not an app handles it.
  // We don't attempt to detect it here; if/when L.2 is built, an
  // explicit user opt-in could try the scheme + handle the no-op
  // case gracefully.

  return {
    kind: "unavailable",
    reason: "No calendar API surface detected in this runtime.",
  };
}

// ---------------------------------------------------------------------------
// Event shape — defines the canonical view of an upcoming event we
// would consume IF the bridge resolves. Used by L.2; ships here so
// the type system gates the eventual integration point.
// ---------------------------------------------------------------------------

export interface UpcomingEvent {
  /** Stable identifier from the source calendar. */
  id: string;
  /** Event title (e.g. "Standup with team"). */
  title: string;
  /** Epoch-ms start time. */
  startMs: number;
  /** Epoch-ms end time. */
  endMs: number;
  /**
   * Free-text location. WMATA station resolution is a separate
   * pass — `geocodeEventToFavorite` lives in the L.2 build.
   */
  location: string;
}

/**
 * Stub bridge for L.2. Always rejects with "unavailable" until the
 * spike resolves. Wired here so consumers can be written and tested
 * against the eventual real surface.
 */
export async function fetchUpcomingEvents(
  _maxResults: number = 5,
): Promise<UpcomingEvent[]> {
  const probe = probeCalendarAvailability();
  if (probe.kind === "unavailable") {
    throw new Error(`Calendar bridge unavailable: ${probe.reason}`);
  }
  // L.2 implementation goes here — branch on `probe.kind` and call
  // into the appropriate API. Until then, surface a clear error
  // rather than returning stale / empty data.
  throw new Error(
    `Calendar bridge probe returned "${probe.kind}" but L.2 ` +
      "implementation is not shipped. See WP-L.",
  );
}

// ---------------------------------------------------------------------------
// Pure helper for L.2: pick the nearest favorite to an event's
// location. Ships now so the test surface for the eventual build is
// already exercised; the consumer wires this to `fetchUpcomingEvents`
// once that resolves.
// ---------------------------------------------------------------------------

import type { FavoriteStation } from "../storage/settings";

/**
 * Resolve an event's free-text location to the user's nearest
 * favorite by case-insensitive substring match. Returns the favorite
 * code, or `null` when no favorite name appears in the location.
 *
 * Future enhancement: geocode via the stations cache lat/lon to
 * match by physical proximity. For v1 substring match is the
 * dependency-light option.
 */
export function matchEventLocationToFavorite(
  location: string,
  favorites: readonly FavoriteStation[],
): string | null {
  if (typeof location !== "string" || location.length === 0) return null;
  const needle = location.toLowerCase();
  let best: { code: string; matchLength: number } | null = null;
  for (const fav of favorites) {
    const name = fav.name.toLowerCase();
    if (needle.includes(name)) {
      // Prefer the longest matching favorite name (so "Foggy Bottom"
      // wins over a hypothetical short prefix like "FB").
      if (best === null || name.length > best.matchLength) {
        best = { code: fav.code, matchLength: name.length };
      }
    }
  }
  return best?.code ?? null;
}
