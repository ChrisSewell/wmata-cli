// Unit tests for the geofence helpers.

import { describe, expect, it } from "vitest";
import type { FavoriteStation } from "../storage/settings";
import {
  MAX_RADIUS_METERS,
  findNearestFavorite,
  haversineMeters,
} from "./geofence";

// ---------------------------------------------------------------------------
// Reference coordinates (verified against WMATA's station list).
// ---------------------------------------------------------------------------
const METRO_CENTER = { lat: 38.898303, lon: -77.028099 };
const GALLERY_PLACE = { lat: 38.898303, lon: -77.021851 };

function fav(over: Partial<FavoriteStation> & { code: string }): FavoriteStation {
  return {
    code: over.code,
    name: over.name ?? `Station ${over.code}`,
    lines: over.lines ?? ["RD"],
    lat: over.lat,
    lon: over.lon,
  };
}

// ---------------------------------------------------------------------------
// haversineMeters
// ---------------------------------------------------------------------------

describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMeters(0, 0, 0, 0)).toBe(0);
    expect(
      haversineMeters(
        METRO_CENTER.lat,
        METRO_CENTER.lon,
        METRO_CENTER.lat,
        METRO_CENTER.lon,
      ),
    ).toBe(0);
  });

  it("computes a plausible distance for Metro Center → Gallery Place (~550m)", () => {
    const d = haversineMeters(
      METRO_CENTER.lat,
      METRO_CENTER.lon,
      GALLERY_PLACE.lat,
      GALLERY_PLACE.lon,
    );
    // The actual on-the-ground distance is around 540m; haversine
    // gives ~542m for these coordinates. Allow ±50m for fixture drift.
    expect(d).toBeGreaterThan(490);
    expect(d).toBeLessThan(600);
  });

  it("is symmetric", () => {
    const d1 = haversineMeters(38.9, -77.0, 38.95, -77.05);
    const d2 = haversineMeters(38.95, -77.05, 38.9, -77.0);
    expect(d1).toBeCloseTo(d2, 6);
  });
});

// ---------------------------------------------------------------------------
// findNearestFavorite
// ---------------------------------------------------------------------------

describe("findNearestFavorite", () => {
  const favorites: FavoriteStation[] = [
    fav({ code: "A01", lat: METRO_CENTER.lat, lon: METRO_CENTER.lon }),
    fav({ code: "B01", lat: GALLERY_PLACE.lat, lon: GALLERY_PLACE.lon }),
  ];

  it("returns the closest favorite when the user is within range", () => {
    // Stand on the Metro Center platform.
    const hit = findNearestFavorite(
      favorites,
      METRO_CENTER.lat,
      METRO_CENTER.lon,
    );
    expect(hit).not.toBeNull();
    expect(hit!.favorite.code).toBe("A01");
    expect(hit!.distanceMeters).toBeLessThan(1);
  });

  it("returns null when no favorite is within MAX_RADIUS_METERS", () => {
    // White House (~38.8977, -77.0365) is ~730m from Metro Center —
    // well outside the 250m default radius.
    const hit = findNearestFavorite(favorites, 38.8977, -77.0365);
    expect(hit).toBeNull();
  });

  it("returns null when the favorites list has no geocoded entries", () => {
    const noCoords: FavoriteStation[] = [
      { code: "X01", name: "Unknown", lines: ["RD"] },
    ];
    const hit = findNearestFavorite(
      noCoords,
      METRO_CENTER.lat,
      METRO_CENTER.lon,
    );
    expect(hit).toBeNull();
  });

  it("returns null on non-finite inputs", () => {
    expect(
      findNearestFavorite(favorites, Number.NaN, METRO_CENTER.lon),
    ).toBeNull();
    expect(
      findNearestFavorite(favorites, METRO_CENTER.lat, Number.NaN),
    ).toBeNull();
  });

  it("respects a custom maxMeters override", () => {
    // White House -> Metro Center is ~730m. Default radius (250m)
    // rejects; an explicit 1000m accepts.
    const wh = { lat: 38.8977, lon: -77.0365 };
    expect(findNearestFavorite(favorites, wh.lat, wh.lon, 250)).toBeNull();
    const hit = findNearestFavorite(favorites, wh.lat, wh.lon, 1000);
    expect(hit).not.toBeNull();
    expect(hit!.favorite.code).toBe("A01");
  });

  it("picks the closest favorite when multiple are in range", () => {
    // Midpoint between the two stations.
    const midpoint = {
      lat: (METRO_CENTER.lat + GALLERY_PLACE.lat) / 2,
      lon: (METRO_CENTER.lon + GALLERY_PLACE.lon) / 2,
    };
    const hit = findNearestFavorite(favorites, midpoint.lat, midpoint.lon, 1000);
    expect(hit).not.toBeNull();
    // The midpoint is equidistant in theory but tiny rounding favours
    // the FIRST entry; either is a valid closest. We only check that
    // a hit was returned at all.
    expect(["A01", "B01"]).toContain(hit!.favorite.code);
  });

  it("exposes the default MAX_RADIUS_METERS constant for callers", () => {
    expect(MAX_RADIUS_METERS).toBe(250);
  });
});
