// Unit tests for the calendar-bridge spike infrastructure (WP-L).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchUpcomingEvents,
  matchEventLocationToFavorite,
  probeCalendarAvailability,
} from "./calendar";
import type { FavoriteStation } from "../storage/settings";

// ---------------------------------------------------------------------------
// probeCalendarAvailability
// ---------------------------------------------------------------------------

describe("probeCalendarAvailability", () => {
  // The Vitest default `window` / `navigator` globals don't have
  // any calendar surface, so the default path is `unavailable`.
  // Each test stubs the relevant global before checking.

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 'unavailable' when no calendar surface is present", () => {
    expect(probeCalendarAvailability()).toEqual({
      kind: "unavailable",
      reason: expect.stringMatching(/no calendar/i),
    });
  });

  it("detects the W3C `navigator.calendar` surface", () => {
    const fakeNavigator = { calendar: { /* stub */ } };
    vi.stubGlobal("navigator", fakeNavigator);
    expect(probeCalendarAvailability()).toEqual({ kind: "w3c" });
  });

  it("detects an Evenhub host-bridge injection on `window`", () => {
    vi.stubGlobal("window", { evenhubCalendar: { stub: true } });
    expect(probeCalendarAvailability()).toEqual({
      kind: "host-bridge",
      surface: "window.evenhubCalendar",
    });
  });

  it("detects the capitalised bridge variant", () => {
    vi.stubGlobal("window", { EvenhubCalendar: { stub: true } });
    expect(probeCalendarAvailability()).toEqual({
      kind: "host-bridge",
      surface: "window.EvenhubCalendar",
    });
  });

  it("ignores a non-object `calendar` value (defensive)", () => {
    vi.stubGlobal("navigator", { calendar: "not an object" });
    expect(probeCalendarAvailability().kind).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// fetchUpcomingEvents (stub — always errors until L.2 ships)
// ---------------------------------------------------------------------------

describe("fetchUpcomingEvents (L.2 stub)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with a clear 'unavailable' error on platforms with no surface", async () => {
    await expect(fetchUpcomingEvents()).rejects.toThrow(/unavailable/i);
  });

  it("rejects with a clear 'L.2 not shipped' error when a surface IS present", async () => {
    vi.stubGlobal("navigator", { calendar: {} });
    await expect(fetchUpcomingEvents()).rejects.toThrow(/L.2/);
  });
});

// ---------------------------------------------------------------------------
// matchEventLocationToFavorite
// ---------------------------------------------------------------------------

describe("matchEventLocationToFavorite", () => {
  function fav(over: { code: string; name: string }): FavoriteStation {
    return { code: over.code, name: over.name, lines: ["RD"] };
  }
  const favorites: FavoriteStation[] = [
    fav({ code: "A01", name: "Metro Center" }),
    fav({ code: "A04", name: "Foggy Bottom" }),
    fav({ code: "B01", name: "Gallery Place" }),
  ];

  it("matches a favorite name appearing inside the location string", () => {
    expect(
      matchEventLocationToFavorite("123 Main St, Foggy Bottom DC", favorites),
    ).toBe("A04");
  });

  it("matches case-insensitively", () => {
    expect(
      matchEventLocationToFavorite("near foggy bottom area", favorites),
    ).toBe("A04");
  });

  it("returns null when no favorite name is present", () => {
    expect(
      matchEventLocationToFavorite("Outside the network entirely", favorites),
    ).toBeNull();
  });

  it("returns null on empty / non-string input", () => {
    expect(matchEventLocationToFavorite("", favorites)).toBeNull();
  });

  it("prefers the longest-matching favorite name when several overlap", () => {
    const overlapping: FavoriteStation[] = [
      fav({ code: "F1", name: "Foggy" }),
      fav({ code: "F4", name: "Foggy Bottom" }),
    ];
    expect(
      matchEventLocationToFavorite("Meet at Foggy Bottom Lot", overlapping),
    ).toBe("F4");
  });
});
