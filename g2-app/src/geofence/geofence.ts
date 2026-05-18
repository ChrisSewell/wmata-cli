// Geofence helper for boot-time auto-mount.
//
// When the user has `geofenceEnabled: true` and the companion has
// populated lat/lon coordinates on their favorites, `bootGlasses`
// consults `navigator.geolocation.getCurrentPosition()` and finds
// the closest favorite within `MAX_RADIUS_METERS`. If a hit is
// found, the initial nav intent overrides to predictions for that
// station — the user walking up to a Metro entrance sees that
// station's predictions instantly without tapping anything.
//
// The geolocation call itself lives in `main.ts` (it's a side-effect
// gated on the runtime); this module owns the pure distance math +
// the orchestration helper, all unit-testable without a browser.

import type { FavoriteStation } from "../storage/settings";

/** Maximum proximity for a geofence hit, in meters. */
export const MAX_RADIUS_METERS = 250;

/** Mean Earth radius for the haversine formula, in meters. */
const EARTH_RADIUS_METERS = 6_371_000;

/** Convert degrees to radians. */
function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two (lat, lon) pairs in meters.
 * Pure haversine; exported so the test suite can pin specific
 * point-to-point distances against the canonical formula.
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Result of a nearest-favorite lookup: the matched favorite + its
 * distance in meters, or `null` when nothing is in range / no
 * favorites have geocoded coordinates.
 */
export interface GeofenceHit {
  favorite: FavoriteStation;
  distanceMeters: number;
}

/**
 * Find the favorite within `maxMeters` of the user's current
 * position. Returns `null` when no favorite has lat/lon set OR
 * nothing is in range. When multiple favorites are in range, the
 * CLOSEST wins.
 *
 * `lat` / `lon` must be valid finite degrees; pass the values that
 * arrived in `GeolocationPosition.coords` directly.
 */
export function findNearestFavorite(
  favorites: readonly FavoriteStation[],
  lat: number,
  lon: number,
  maxMeters: number = MAX_RADIUS_METERS,
): GeofenceHit | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: GeofenceHit | null = null;
  for (const fav of favorites) {
    if (typeof fav.lat !== "number" || typeof fav.lon !== "number") continue;
    if (!Number.isFinite(fav.lat) || !Number.isFinite(fav.lon)) continue;
    const d = haversineMeters(lat, lon, fav.lat, fav.lon);
    if (d > maxMeters) continue;
    if (best === null || d < best.distanceMeters) {
      best = { favorite: fav, distanceMeters: d };
    }
  }
  return best;
}
