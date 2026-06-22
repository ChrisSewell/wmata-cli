import { describe, it, expect } from "vitest";
import { etaSortValue, soonestEta, buildFavoriteEtaMap } from "./eta";
import type { WmataClient } from "../wmata";

describe("etaSortValue", () => {
  it("ranks BRD < ARR < numeric < junk", () => {
    expect(etaSortValue("BRD")).toBeLessThan(etaSortValue("ARR"));
    expect(etaSortValue("ARR")).toBeLessThan(etaSortValue("1"));
    expect(etaSortValue("1")).toBeLessThan(etaSortValue("12"));
    expect(etaSortValue("---")).toBe(Number.POSITIVE_INFINITY);
    expect(etaSortValue("")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("soonestEta", () => {
  it("returns null for empty or all-junk", () => {
    expect(soonestEta([])).toBeNull();
    expect(soonestEta(["", "---"])).toBeNull();
  });
  it("prefers BRD over ARR over numeric, verbatim", () => {
    expect(soonestEta(["5", "ARR", "BRD"])).toBe("BRD");
    expect(soonestEta(["5", "ARR", "12"])).toBe("ARR");
    expect(soonestEta(["12", "3", "8"])).toBe("3");
  });
});

describe("buildFavoriteEtaMap", () => {
  const fakeClient = (trains: Array<{ LocationCode: string; Min: string }>): WmataClient =>
    ({ get: async () => ({ Trains: trains }) }) as unknown as WmataClient;

  it("returns {} for no codes without a network call", async () => {
    let called = false;
    const client = { get: async () => ((called = true), { Trains: [] }) } as unknown as WmataClient;
    expect(await buildFavoriteEtaMap(client, [])).toEqual({});
    expect(called).toBe(false);
  });

  it("buckets the soonest Min per requested code, ignoring siblings", async () => {
    const client = fakeClient([
      { LocationCode: "A01", Min: "5" },
      { LocationCode: "A01", Min: "ARR" },
      { LocationCode: "B01", Min: "3" },
      { LocationCode: "F01", Min: "1" }, // sibling we didn't ask for
    ]);
    const map = await buildFavoriteEtaMap(client, ["A01", "B01"]);
    expect(map).toEqual({ A01: "ARR", B01: "3" });
    expect("F01" in map).toBe(false);
  });

  it("maps a requested code with no trains to null", async () => {
    const client = fakeClient([{ LocationCode: "A01", Min: "5" }]);
    const map = await buildFavoriteEtaMap(client, ["A01", "C05"]);
    expect(map).toEqual({ A01: "5", C05: null });
  });
});
