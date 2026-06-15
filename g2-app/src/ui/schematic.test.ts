// Unit tests for the live-train schematic helpers (WP-I).

import { describe, expect, it } from "vitest";
import type { StandardRoute } from "../wmata";
import { LINE_WIDTH } from "./render";
import {
  SCHEMATIC_GLYPH_PLAIN,
  SCHEMATIC_GLYPH_TRAIN,
  SCHEMATIC_GLYPH_USER,
  buildLineStations,
  findNearestStationToCircuit,
  renderLineSchematic,
  stationsBetween,
} from "./schematic";

/**
 * Stub StandardRoute for the Red line with 5 stations spread over
 * 11 ordered circuits. Mirrors the wire shape: revenue stations
 * have a non-null `StationCode`, inter-station segments are null.
 *
 *   seq 1   circuit 1   station A01
 *   seq 2   circuit 2   (between)
 *   seq 3   circuit 3   station A02
 *   seq 4   circuit 4   (between)
 *   seq 5   circuit 5   station A03
 *   seq 6   circuit 6   (between)
 *   seq 7   circuit 7   station A04
 *   seq 8   circuit 8   (between)
 *   seq 9   circuit 9   station A05
 */
function makeRdRoute(trackNum: number = 1): StandardRoute {
  return {
    LineCode: "RD",
    TrackNum: trackNum,
    TrackCircuits: [
      { SeqNum: 1, CircuitId: 1, StationCode: "A01" },
      { SeqNum: 2, CircuitId: 2, StationCode: null },
      { SeqNum: 3, CircuitId: 3, StationCode: "A02" },
      { SeqNum: 4, CircuitId: 4, StationCode: null },
      { SeqNum: 5, CircuitId: 5, StationCode: "A03" },
      { SeqNum: 6, CircuitId: 6, StationCode: null },
      { SeqNum: 7, CircuitId: 7, StationCode: "A04" },
      { SeqNum: 8, CircuitId: 8, StationCode: null },
      { SeqNum: 9, CircuitId: 9, StationCode: "A05" },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildLineStations
// ---------------------------------------------------------------------------

describe("buildLineStations", () => {
  it("returns the ordered revenue-station codes for the line", () => {
    expect(buildLineStations([makeRdRoute()], "RD")).toEqual([
      "A01",
      "A02",
      "A03",
      "A04",
      "A05",
    ]);
  });

  it("falls back to any matching track when Track 1 is absent", () => {
    expect(buildLineStations([makeRdRoute(2)], "RD")).toEqual([
      "A01",
      "A02",
      "A03",
      "A04",
      "A05",
    ]);
  });

  it("returns [] for an unknown line", () => {
    expect(buildLineStations([makeRdRoute()], "ZZ")).toEqual([]);
  });

  it("returns [] for an empty/invalid line code", () => {
    expect(buildLineStations([makeRdRoute()], "")).toEqual([]);
  });

  it("dedupes repeated station codes (branching points)", () => {
    const repeated: StandardRoute = {
      LineCode: "BL",
      TrackNum: 1,
      TrackCircuits: [
        { SeqNum: 1, CircuitId: 1, StationCode: "B01" },
        { SeqNum: 2, CircuitId: 2, StationCode: "B02" },
        { SeqNum: 3, CircuitId: 3, StationCode: "B01" }, // dup
      ],
    };
    expect(buildLineStations([repeated], "BL")).toEqual(["B01", "B02"]);
  });
});

// ---------------------------------------------------------------------------
// findNearestStationToCircuit
// ---------------------------------------------------------------------------

describe("findNearestStationToCircuit", () => {
  it("returns the matching station when the circuit is AT a station", () => {
    expect(findNearestStationToCircuit([makeRdRoute()], "RD", 3)).toBe("A02");
  });

  it("returns the nearer station when between two", () => {
    // Circuit 4 sits between station A02 (seq 3) and A03 (seq 5).
    // Equal distance — `findNearestStationByCircuit` walks in order,
    // so the first one (A02) wins. Either is acceptable for the
    // schematic; just lock the behaviour.
    expect(findNearestStationToCircuit([makeRdRoute()], "RD", 4)).toBe("A02");
  });

  it("returns the nearer station, biased by distance", () => {
    // Circuit 2 — between A01 (seq 1) and A02 (seq 3). Distance to
    // A01 is 1, distance to A02 is 1. A01 wins by walking order.
    expect(findNearestStationToCircuit([makeRdRoute()], "RD", 2)).toBe("A01");
  });

  it("returns null when the circuit ID isn't on the line", () => {
    expect(findNearestStationToCircuit([makeRdRoute()], "RD", 9999)).toBeNull();
  });

  it("returns null when the line isn't in the routes table", () => {
    expect(findNearestStationToCircuit([makeRdRoute()], "GR", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stationsBetween
// ---------------------------------------------------------------------------

describe("stationsBetween", () => {
  const stations = ["A01", "A02", "A03", "A04", "A05"];

  it("returns 0 when the codes match", () => {
    expect(stationsBetween(stations, "A03", "A03")).toBe(0);
  });

  it("returns the absolute count of intermediate hops", () => {
    expect(stationsBetween(stations, "A01", "A04")).toBe(3);
    expect(stationsBetween(stations, "A04", "A01")).toBe(3);
  });

  it("returns null when either code isn't on the line", () => {
    expect(stationsBetween(stations, "A01", "ZZZ")).toBeNull();
    expect(stationsBetween(stations, "ZZZ", "A01")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderLineSchematic
// ---------------------------------------------------------------------------

describe("renderLineSchematic", () => {
  const stations = ["A01", "A02", "A03", "A04", "A05"];

  it("returns exactly LINE_WIDTH columns", () => {
    expect(renderLineSchematic("RD", stations, 0, 2).length).toBe(LINE_WIDTH);
  });

  it("starts with the line code + space", () => {
    expect(renderLineSchematic("RD", stations, 0, 2).startsWith("RD ")).toBe(
      true,
    );
  });

  it("marks the user station with `*`", () => {
    const out = renderLineSchematic("RD", stations, 2, -1);
    expect(out).toContain(SCHEMATIC_GLYPH_USER);
  });

  it("marks the train station with `@`", () => {
    const out = renderLineSchematic("RD", stations, -1, 3);
    expect(out).toContain(SCHEMATIC_GLYPH_TRAIN);
  });

  it("prefers `@` when the train and user share a cell", () => {
    const out = renderLineSchematic("RD", stations, 2, 2);
    expect(out).toContain(SCHEMATIC_GLYPH_TRAIN);
    expect(out).not.toContain(SCHEMATIC_GLYPH_USER);
  });

  it("renders plain stations with the plain glyph", () => {
    // No user, no train — every cell should be the plain glyph.
    const out = renderLineSchematic("RD", stations, -1, -1);
    const body = out.slice(3); // strip "RD " prefix
    expect(body.includes(SCHEMATIC_GLYPH_PLAIN)).toBe(true);
    expect(body.includes(SCHEMATIC_GLYPH_USER)).toBe(false);
    expect(body.includes(SCHEMATIC_GLYPH_TRAIN)).toBe(false);
  });

  it("collapses an over-long line into the available cell budget", () => {
    // Synthesise a 40-station line (more than LINE_WIDTH-3=21 cells).
    const long: string[] = [];
    for (let i = 0; i < 40; i++) long.push(`X${String(i)}`);
    const out = renderLineSchematic("RD", long, 5, 30);
    expect(out.length).toBe(LINE_WIDTH);
    // Both markers should still appear despite the compression.
    expect(out).toContain(SCHEMATIC_GLYPH_USER);
    expect(out).toContain(SCHEMATIC_GLYPH_TRAIN);
  });

  it("renders a blank schematic for an unknown line", () => {
    const out = renderLineSchematic("--", [], -1, -1);
    expect(out.length).toBe(LINE_WIDTH);
  });
});
