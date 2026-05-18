// Unit tests for the Incidents screen.
//
// Acceptance contract:
//   - Every rendered line is ≤ LINE_WIDTH columns across every fixture.
//   - Empty state pins exactly 5 lines (header + 2 copy + spacer + cue).
//   - Short / long / multi-incident bodies fit the 7-row body budget,
//     with scrolling when the content exceeds it.
//   - Description wrapping is word-break-only, capped at MAX_DESC_LINES,
//     with `…` on the last line when truncated.
//   - Edge markers (▴/▾) consume from the 7-row body budget when
//     present.
//   - Reducer: SCROLL_UP/SCROLL_DOWN move the scroll offset (clamped);
//     TAP is a no-op; DOUBLE_TAP navigates to Home.
//   - Stale marker (`*`) follows the 120s threshold using `ctx.nowMs`.
//   - First-load fetch error renders a "Couldn't reach WMATA" body
//     instead of the empty-state copy.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { RailIncident } from "../wmata";
import { initialNav, type ViewContext } from "./router";
import {
  MAX_DESC_LINES,
  STALE_THRESHOLD_MS,
  TICK_INTERVAL_MS,
  capDescription,
  computeUserLines,
  flattenBlocks,
  formatIncidentBlock,
  isStale,
  makeIncidentsScreen,
  makeInitialIncidentsSnapshot,
  renderGlyphRow,
  renderHeader,
  wrap,
  type IncidentsFetchResult,
  type IncidentsSnapshot,
} from "./incidents";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function expectFits(lines: string[]): void {
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
  }
}

/** Fixed wall clock — May 18 2026 14:32 local. */
const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();

const CTX: ViewContext = { nowMs: NOW };

function incident(over: Partial<RailIncident> = {}): RailIncident {
  return {
    IncidentID: "id-1",
    Description: "Single-tracking between Foggy Bottom and Rosslyn.",
    IncidentType: "Delay",
    LinesAffected: "BL; OR; SV;",
    DateUpdated: "2026-05-18T14:30:00",
    ...over,
  };
}

function makeSnap(
  incidents: RailIncident[],
  over: Partial<IncidentsSnapshot> = {},
): IncidentsSnapshot {
  return {
    incidents,
    fetchedAt: NOW,
    fetchError: null,
    consecutiveFetchFailures: 0,
    preformatted: incidents.map(formatIncidentBlock),
    ...over,
  };
}

const noopFetcher = (): Promise<IncidentsFetchResult> =>
  Promise.resolve({ incidents: [], fetchedAt: NOW, fetchError: null });

// ---------------------------------------------------------------------------
// wrap() — pure helper
// ---------------------------------------------------------------------------

describe("wrap", () => {
  it("returns [] for empty input", () => {
    expect(wrap("", 22)).toEqual([]);
  });

  it("greedily packs words into width-bounded lines", () => {
    const out = wrap("Single-tracking between Foggy Bottom and Rosslyn.", 22);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(22);
    // Each consecutive pair must not have been combinable into one line:
    // i.e. previous + " " + next would have exceeded 22.
    for (let i = 1; i < out.length; i++) {
      const merged = out[i - 1]!.length + 1 + out[i]!.split(" ")[0]!.length;
      expect(merged).toBeGreaterThan(22);
    }
  });

  it("hard-breaks a word wider than `width` with a `…` continuation marker", () => {
    const monster = "Antidisestablishmentarianism"; // 28 chars
    const out = wrap(monster, 10);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(10);
    // First (and any intermediate) chunks end with the ellipsis.
    expect(out[0]!.endsWith("…")).toBe(true);
  });

  it("collapses runs of whitespace into single spaces", () => {
    const out = wrap("a  b\t\nc", 22);
    expect(out).toEqual(["a b c"]);
  });

  it("returns [] at the degenerate width=1 (avoids infinite-loop)", () => {
    // The hard-break path would do slice(0, 0) -> "" and slice(0) ->
    // the same string, looping forever. Callers always use
    // BODY_TEXT_WIDTH = 22; this guard makes the helper safe to call
    // with a degenerate budget rather than crashing.
    expect(wrap("Antidisestablishmentarianism", 1)).toEqual([]);
  });

  it("returns [] at width=0 as well", () => {
    expect(wrap("anything at all", 0)).toEqual([]);
  });

  it("hard-breaks a giant word and then continues with following words on subsequent lines", () => {
    // The hard-break path should leave the residue word in `current`
    // (no trailing ellipsis on the last chunk) and the next short
    // words must pack onto the line normally.
    const out = wrap("Antidisestablishmentarianism more text", 22);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(22);
    // First chunk is a 21-char prefix + "…" = 22 cols.
    expect(out[0]).toBe("Antidisestablishmenta…");
    // Subsequent lines must contain the trailing short words.
    const tail = out.slice(1).join(" ");
    expect(tail).toContain("more");
    expect(tail).toContain("text");
  });
});

// ---------------------------------------------------------------------------
// capDescription
// ---------------------------------------------------------------------------

describe("capDescription", () => {
  it("returns the input as-is when it's at or below MAX_DESC_LINES", () => {
    const lines = ["a", "b", "c"];
    expect(capDescription(lines)).toEqual(lines);
  });

  it("truncates to MAX_DESC_LINES with `…` on the last line when too long", () => {
    const lines = Array.from({ length: MAX_DESC_LINES + 3 }, (_, i) => `line${i}`);
    const out = capDescription(lines);
    expect(out.length).toBe(MAX_DESC_LINES);
    expect(out[MAX_DESC_LINES - 1]!.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderGlyphRow
// ---------------------------------------------------------------------------

describe("renderGlyphRow", () => {
  it("renders 1-4 codes verbatim with the `! ` warning prefix", () => {
    expect(renderGlyphRow(["RD"])).toBe("! RD");
    expect(renderGlyphRow(["RD", "BL"])).toBe("! RD BL");
    expect(renderGlyphRow(["RD", "BL", "OR"])).toBe("! RD BL OR");
    expect(renderGlyphRow(["RD", "BL", "OR", "SV"])).toBe("! RD BL OR SV");
  });

  it("collapses 5+ codes to `+N`", () => {
    expect(renderGlyphRow(["RD", "BL", "YL", "OR", "GR"])).toBe(
      "! RD BL YL OR +1",
    );
  });

  it("renders `! --` when no codes are present", () => {
    expect(renderGlyphRow([])).toBe("! --");
  });
});

// ---------------------------------------------------------------------------
// formatIncidentBlock
// ---------------------------------------------------------------------------

describe("formatIncidentBlock", () => {
  it("emits a glyph row + wrapped description lines", () => {
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;", Description: "Hello world." }),
    );
    expect(block[0]).toBe("! BL");
    expect(block.slice(1).join(" ")).toContain("Hello world.");
  });

  it("drops the description block when Description is empty", () => {
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;", Description: "" }),
    );
    expect(block).toEqual(["! BL"]);
  });

  it("drops the description block when Description is whitespace-only", () => {
    // After trim() the string is empty, so we render just the glyph
    // row — no all-blank description rows leaking into the body.
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;", Description: "   \t  " }),
    );
    expect(block).toEqual(["! BL"]);
  });

  it("does not crash when Description is null (defensive)", () => {
    // The wire type is `string`, but a defensive guard against
    // corrupted upstream data keeps the screen from blanking. The
    // result is a single glyph row, no description.
    const inc = incident({ LinesAffected: "BL;" });
    const corrupted = {
      ...inc,
      Description: null,
    } as unknown as RailIncident;
    expect(formatIncidentBlock(corrupted)).toEqual(["! BL"]);
  });

  it("does not crash when Description is undefined (defensive)", () => {
    const inc = incident({ LinesAffected: "BL;" });
    const corrupted = {
      ...inc,
      Description: undefined,
    } as unknown as RailIncident;
    expect(formatIncidentBlock(corrupted)).toEqual(["! BL"]);
  });

  it("silently drops unknown line codes from the glyph row", () => {
    const block = formatIncidentBlock(
      incident({ LinesAffected: "BL;XX;SV;", Description: "" }),
    );
    expect(block).toEqual(["! BL SV"]);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("treats a never-fetched snapshot as stale", () => {
    expect(isStale(makeSnap([], { fetchedAt: 0 }), NOW)).toBe(true);
  });

  it("is fresh inside the 2-minute threshold", () => {
    expect(isStale(makeSnap([], { fetchedAt: NOW - 10_000 }), NOW)).toBe(false);
  });

  it("goes stale just past the 2-minute threshold", () => {
    expect(
      isStale(makeSnap([], { fetchedAt: NOW - (STALE_THRESHOLD_MS + 1) }), NOW),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderHeader
// ---------------------------------------------------------------------------

describe("renderHeader", () => {
  it("renders `ALERTS (n)` + clock at exactly LINE_WIDTH cols", () => {
    const out = renderHeader(makeSnap([incident()]), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("ALERTS (1)")).toBe(true);
    expect(out.endsWith("14:32")).toBe(true);
  });

  it("renders `ALERTS` (no count) when there are 0 incidents", () => {
    const out = renderHeader(makeSnap([]), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("ALERTS ")).toBe(true);
    expect(out).not.toContain("(0)");
  });

  it("appends `*` when the snapshot is older than STALE_THRESHOLD_MS", () => {
    const out = renderHeader(
      makeSnap([incident()], { fetchedAt: NOW - (STALE_THRESHOLD_MS + 5_000) }),
      NOW,
    );
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.endsWith("14:32*")).toBe(true);
  });

  it("fits at n=99 (two-digit count) in 24 cols with a clock", () => {
    // ALERTS (99) is 11 cols; 14:32 is 5; spacing fills the rest.
    const incs = Array.from({ length: 99 }, (_, i) =>
      incident({ IncidentID: `${i}` }),
    );
    const out = renderHeader(makeSnap(incs), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("ALERTS (99)")).toBe(true);
    expect(out.endsWith("14:32")).toBe(true);
  });

  it("fits at n=999 (three-digit count) in 24 cols with a clock", () => {
    // ALERTS (999) is 12 cols; 14:32 is 5; spacing fills the rest.
    const incs = Array.from({ length: 999 }, (_, i) =>
      incident({ IncidentID: `${i}` }),
    );
    const out = renderHeader(makeSnap(incs), NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("ALERTS (999)")).toBe(true);
    expect(out.endsWith("14:32")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// View — empty state (Test #1)
// ---------------------------------------------------------------------------

describe("incidents view: empty state", () => {
  it("pins EXACTLY 5 lines for the friendly empty-state copy", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap([]));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines).toEqual([
      "ALERTS             14:32",
      "No active alerts on",
      "your lines.",
      "",
      "(double-tap to return)",
    ]);
    expect(lines.length).toBe(5);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// View — 1 incident, short description (Test #2)
// ---------------------------------------------------------------------------

describe("incidents view: 1 incident, short description", () => {
  it("fits in fewer than USABLE_ROWS, no scroll, no edge markers", () => {
    const incs = [
      incident({ LinesAffected: "BL;", Description: "Train OK." }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.length).toBe(3); // header + glyph row + 1-line description
    expect(lines.some((l) => l === "▴")).toBe(false);
    expect(lines.some((l) => l === "▾")).toBe(false);
    expect(lines[1]).toBe("  ! BL");
    expect(lines[2]).toBe("  Train OK.");
  });
});

// ---------------------------------------------------------------------------
// View — 1 incident, long description (Test #3)
// ---------------------------------------------------------------------------

describe("incidents view: 1 incident, very long description", () => {
  it("wraps to ≤ MAX_DESC_LINES lines and ends the last line with `…` when cut", () => {
    // Description deliberately long enough to overflow the
    // MAX_DESC_LINES cap (~120+ chars worth of words).
    const long =
      "Single tracking between Foggy Bottom and Rosslyn due to a disabled train. " +
      "Expect significant delays on Orange, Blue, and Silver Line trains for the next two hours. " +
      "Shuttle buses are available at Court House, Clarendon, and Ballston for affected riders.";
    const incs = [incident({ Description: long })];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // The visible body lines that look like description (not the glyph
    // row, not the header, not edge markers) cap at MAX_DESC_LINES.
    const block = formatIncidentBlock(incs[0]!);
    // First entry is the glyph row; the rest are description lines.
    expect(block.length - 1).toBe(MAX_DESC_LINES);
    // The last description line should end with the ellipsis.
    expect(block[block.length - 1]!.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// View — 5 incidents, scrolling required (Tests #4, #5, #6, #7)
// ---------------------------------------------------------------------------

/**
 * Fixture: 5 incidents, each with a short single-line description so we
 * deterministically know the body layout:
 *
 *   [glyph][desc][BLANK][glyph][desc][BLANK][glyph][desc][BLANK][glyph][desc][BLANK][glyph][desc]
 *
 * = 5*2 + 4 = 14 body rows. With USABLE_ROWS = 7 + room for edge
 * markers, scrolling is required and the `▾` arrow must show on the
 * initial render.
 */
const FIVE_INCIDENTS: RailIncident[] = [
  incident({ IncidentID: "1", LinesAffected: "RD;", Description: "Inc one." }),
  incident({ IncidentID: "2", LinesAffected: "BL;", Description: "Inc two." }),
  incident({ IncidentID: "3", LinesAffected: "OR;", Description: "Inc three." }),
  incident({ IncidentID: "4", LinesAffected: "SV;", Description: "Inc four." }),
  incident({ IncidentID: "5", LinesAffected: "YL;", Description: "Inc five." }),
];

describe("incidents view: 5 incidents — scrolling required", () => {
  it("initial render: `▾` is present, `▴` is not", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // Header + 7 body rows (= USABLE_ROWS budget).
    expect(lines.length).toBe(1 + 7);
    expect(lines.some((l) => l === "▾")).toBe(true);
    expect(lines.some((l) => l === "▴")).toBe(false);
  });

  it("scrolling down shifts the visible window, surfacing `▴`", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    // Push the offset deep enough that content above is hidden.
    let nav = initialNav();
    for (let i = 0; i < 10; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
    const lines = screen.view(screen.init(), nav, CTX);
    expectFits(lines);
    expect(lines.some((l) => l === "▴")).toBe(true);
  });

  it("scroll past the end is a no-op (bottom-edge clamp)", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    let nav = initialNav();
    // Drive ~50 scroll downs to exceed any reasonable body length.
    for (let i = 0; i < 50; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
    // Body length for FIVE_INCIDENTS:
    //   5 incidents × 2 lines + 4 separators = 14 rows.
    expect(nav.highlightedIndex).toBe(13);
  });

  it("scroll up past the start is a no-op (top-edge clamp)", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    let nav = initialNav();
    for (let i = 0; i < 50; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_UP" }).nav;
    }
    expect(nav.highlightedIndex).toBe(0);
  });

  it("a mid-list scroll position shows BOTH `▴` and `▾` simultaneously", () => {
    // FIVE_INCIDENTS yields 14 body rows. After ~5 SCROLL_DOWNs the
    // window sits in the middle of the body, so both edge markers
    // must be present in the same frame.
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    let nav = initialNav();
    for (let i = 0; i < 5; i++) {
      nav = screen.reduce(screen.init(), nav, { type: "SCROLL_DOWN" }).nav;
    }
    const lines = screen.view(screen.init(), nav, CTX);
    expectFits(lines);
    expect(lines.some((l) => l === "▴")).toBe(true);
    expect(lines.some((l) => l === "▾")).toBe(true);
    // Whole frame still fits the budget: header + 7 body rows.
    expect(lines.length).toBe(1 + 7);
  });
});

// ---------------------------------------------------------------------------
// View — incident with unknown line codes (Test #8)
// ---------------------------------------------------------------------------

describe("incidents view: unknown LineCodes drop silently", () => {
  it("only valid LineCodes render in the glyph row", () => {
    const incs = [
      incident({
        IncidentID: "1",
        LinesAffected: "BL;XX;SV;QQ;",
        Description: "Test.",
      }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // The glyph row should NOT contain XX or QQ.
    const glyphRow = lines.find((l) => l.includes("!"));
    expect(glyphRow).toBeDefined();
    expect(glyphRow).not.toContain("XX");
    expect(glyphRow).not.toContain("QQ");
    expect(glyphRow).toContain("BL");
    expect(glyphRow).toContain("SV");
  });
});

// ---------------------------------------------------------------------------
// Stale marker uses ctx.nowMs (Test #9)
// ---------------------------------------------------------------------------

describe("incidents view: stale marker uses ctx.nowMs", () => {
  it("renders `*` after the clock when fetchedAt is 130s in the past", () => {
    const T = NOW;
    const snap = makeSnap([incident()], { fetchedAt: T - 130_000 });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), { nowMs: T });
    expectFits(lines);
    expect(lines[0]!.endsWith("14:32*")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// First-load fetch error renders a distinct body (Test #10)
// ---------------------------------------------------------------------------

describe("incidents view: first-load fetch error", () => {
  it("renders `Couldn't reach WMATA` instead of the empty-state copy", () => {
    const snap = makeSnap([], {
      fetchedAt: 0,
      fetchError: "Could not connect.",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.some((l) => l.includes("Couldn't reach WMATA"))).toBe(true);
    expect(lines.some((l) => l.includes("No active alerts"))).toBe(false);
  });

  it("pins the EXACT 5-line first-load error body", () => {
    // Symmetric with the empty-state pin: lock the lines verbatim so a
    // future copy change has to update this test on purpose. The
    // clock carries a trailing `?` because fetchedAt=0 with an active
    // error is the strongest degraded state — see `stalenessMarker`.
    const snap = makeSnap([], {
      fetchedAt: 0,
      fetchError: "Could not connect.",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines).toEqual([
      "ALERTS            14:32?",
      "Couldn't reach WMATA.",
      "Will retry shortly.",
      "",
      "(double-tap to return)",
    ]);
    expect(lines.length).toBe(5);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// 3-state stale-marker escalation
// ---------------------------------------------------------------------------

describe("incidents view: stale-marker escalation", () => {
  // One incident in the snapshot so we exercise the "data exists, just
  // degrading" branches (the no-data + error case is locked above).
  const oneIncident = (): RailIncident => incident();

  it("shows '*' after one consecutive failure", () => {
    const snap = makeSnap([oneIncident()], {
      consecutiveFetchFailures: 1,
      fetchError: "transient",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines[0]!.endsWith("14:32*")).toBe(true);
  });

  it("shows '**' after two consecutive failures", () => {
    const snap = makeSnap([oneIncident()], {
      consecutiveFetchFailures: 2,
      fetchError: "transient",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines[0]!.endsWith("14:32**")).toBe(true);
  });

  it("shows '?' after three or more consecutive failures", () => {
    const snap = makeSnap([oneIncident()], {
      consecutiveFetchFailures: 3,
      fetchError: "transient",
    });
    const screen = makeIncidentsScreen(noopFetcher, snap);
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expect(lines[0]!.endsWith("14:32?")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reducer — DOUBLE_TAP from any state -> home (Test #11)
// ---------------------------------------------------------------------------

describe("incidents reduce: DOUBLE_TAP returns to home", () => {
  it("returns `{ to: 'home' }` regardless of snapshot state", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap([]));
    for (const initial of [
      makeSnap([]),
      makeSnap(FIVE_INCIDENTS),
      makeSnap([], { fetchedAt: 0, fetchError: "boom" }),
    ]) {
      const r = screen.reduce(initial, initialNav(), { type: "DOUBLE_TAP" });
      expect(r.navigate).toEqual({ to: "home" });
    }
  });

  it("TAP is a no-op (read-only screen)", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(FIVE_INCIDENTS));
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toBeUndefined();
    expect(r.nav).toEqual(initialNav());
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: 1 incident, 3-line description (Test #12)
// ---------------------------------------------------------------------------

describe("incidents view snapshot: 1 incident with a multi-line desc", () => {
  it("matches the exact line array", () => {
    const incs = [
      incident({
        IncidentID: "1",
        LinesAffected: "BL; OR; SV;",
        Description:
          "Single-tracking between Foggy Bottom and Rosslyn due to a disabled train.",
      }),
    ];
    const screen = makeIncidentsScreen(noopFetcher, makeSnap(incs));
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // The wrapper packs greedily into 22-col lines. We compute the
    // expected block via the same helpers used by the impl so the pin
    // stays in lock-step with the wrap rules — but we ALSO assert the
    // exact rendered lines explicitly so a future change to the wrap
    // rules surfaces as a test failure.
    expect(lines).toEqual([
      "ALERTS (1)         14:32",
      "  ! BL OR SV",
      "  Single-tracking",
      "  between Foggy Bottom",
      "  and Rosslyn due to a",
      "  disabled train.",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// tick(): success + error paths
// ---------------------------------------------------------------------------

describe("incidents tick", () => {
  it("folds a successful fetch into the snapshot and rebuilds preformatted", async () => {
    const incs = [incident({ LinesAffected: "RD;", Description: "Hi." })];
    const fetcher = () =>
      Promise.resolve<IncidentsFetchResult>({
        incidents: incs,
        fetchedAt: NOW,
        fetchError: null,
      });
    const screen = makeIncidentsScreen(fetcher, makeSnap([]));
    const next = await screen.tick(screen.init());
    expect(next.incidents).toEqual(incs);
    expect(next.fetchError).toBeNull();
    expect(next.preformatted.length).toBe(1);
    expect(next.preformatted[0]![0]).toBe("! RD");
  });

  it("never throws: a rejected fetcher stores the error on the snapshot", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makeIncidentsScreen(fetcher, makeSnap([incident()]));
    const next = await screen.tick(screen.init());
    expect(next.fetchError).toBe("boom");
    // Prior incidents are preserved.
    expect(next.incidents.length).toBe(1);
  });

  it("increments consecutiveFetchFailures on each rejected fetcher", async () => {
    const fetcher = () => Promise.reject(new Error("boom"));
    const screen = makeIncidentsScreen(fetcher, makeSnap([incident()]));
    let s = screen.init();
    expect(s.consecutiveFetchFailures).toBe(0);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(1);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(2);
  });

  it("treats a fetcher result with fetchError !== null as a failure", async () => {
    // The session-backed fetcher swallows network errors and surfaces
    // them through the result shape rather than throwing. The tick
    // must still treat that as a failure for the escalation counter.
    const fetcher = () =>
      Promise.resolve<IncidentsFetchResult>({
        incidents: [],
        fetchedAt: 0,
        fetchError: "swallowed network error",
      });
    const screen = makeIncidentsScreen(fetcher, makeSnap([]));
    let s = screen.init();
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(1);
    s = await screen.tick(s);
    expect(s.consecutiveFetchFailures).toBe(2);
  });

  it("resets consecutiveFetchFailures to 0 on a successful fetch", async () => {
    const successfulFetcher = () =>
      Promise.resolve<IncidentsFetchResult>({
        incidents: [],
        fetchedAt: NOW,
        fetchError: null,
      });
    const screen = makeIncidentsScreen(
      successfulFetcher,
      makeSnap([], { consecutiveFetchFailures: 3 }),
    );
    const next = await screen.tick(screen.init());
    expect(next.consecutiveFetchFailures).toBe(0);
    expect(next.fetchError).toBeNull();
  });

  it("exposes a tickIntervalMs of 60_000 (60s) for the host", () => {
    const screen = makeIncidentsScreen(noopFetcher, makeSnap([]));
    expect(screen.tickIntervalMs).toBe(TICK_INTERVAL_MS);
    expect(screen.tickIntervalMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// computeUserLines + makeInitialIncidentsSnapshot
// ---------------------------------------------------------------------------

describe("computeUserLines", () => {
  it("collects unique line codes across the favorites", () => {
    const out = computeUserLines([
      { code: "A01", name: "Metro Center", lines: ["RD", "BL", "OR"] },
      { code: "B01", name: "Gallery Pl", lines: ["RD", "YL", "GR"] },
    ]);
    expect(new Set(out)).toEqual(new Set(["RD", "BL", "OR", "YL", "GR"]));
  });

  it("returns [] for no favorites", () => {
    expect(computeUserLines([])).toEqual([]);
  });
});

describe("makeInitialIncidentsSnapshot", () => {
  it("pre-formats every cached incident into a block", () => {
    const incs = [
      incident({ IncidentID: "1", LinesAffected: "RD;", Description: "Hi." }),
      incident({ IncidentID: "2", LinesAffected: "BL;", Description: "" }),
    ];
    const snap = makeInitialIncidentsSnapshot({
      incidents: incs,
      fetchedAt: NOW,
      fetchError: null,
    });
    expect(snap.preformatted.length).toBe(2);
    expect(snap.preformatted[0]![0]).toBe("! RD");
    // Second incident has no description -> single-row block.
    expect(snap.preformatted[1]).toEqual(["! BL"]);
  });
});

// ---------------------------------------------------------------------------
// flattenBlocks
// ---------------------------------------------------------------------------

describe("flattenBlocks", () => {
  it("indents each row with 2 spaces and inserts a blank-string separator between incidents", () => {
    const blocks = [
      ["! RD", "Inc one."],
      ["! BL", "Inc two."],
    ];
    expect(flattenBlocks(blocks)).toEqual([
      "  ! RD",
      "  Inc one.",
      "",
      "  ! BL",
      "  Inc two.",
    ]);
  });

  it("emits no trailing separator on the last block", () => {
    const blocks = [["! RD"]];
    expect(flattenBlocks(blocks)).toEqual(["  ! RD"]);
  });
});
