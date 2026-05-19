// Unit tests for the Voice (ASR) screen.
//
// Acceptance contract:
//   - Every rendered line is ≤ LINE_WIDTH columns across every phase
//     (listening / resolving / matches / noMatch / error).
//   - Live partial transcripts render directly; long transcripts get
//     a `…`-prefixed tail-slice that stays within the 22-col window.
//   - Silence dispatch transitions the snapshot from `listening`
//     through `resolving` and into `matches` / `noMatch` based on
//     `searchFn` results.
//   - Unique match → reducer emits `{ to: 'predictions', stationCode }`.
//   - Multiple matches → SCROLL_UP / SCROLL_DOWN cycle `matchIndex` modulo
//     `matches.length`; TAP confirms the highlighted match and emits
//     `{ to: 'predictions', stationCode }`.
//   - `noMatch` → TAP returns to `listening` with a cleared transcript.
//   - `error` → DOUBLE_TAP returns to Home.
//   - DOUBLE_TAP from every phase navigates to `{ to: 'home' }`.
//   - The `createSttEngine` factory throws a clear, grep-able message.
//   - One canonical snapshot pin for the matches state — locks the
//     exact rendered line array.

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import type { Station } from "../wmata";
import { initialNav, type ScreenEvent, type ViewContext } from "./router";
import {
  MAX_MATCHES,
  MockSttEngine,
  TRANSCRIPT_WINDOW,
  createSttEngine,
  formatClock,
  formatTranscriptWindow,
  initialVoiceSnapshot,
  makeVoiceScreen,
  renderHeader,
  renderMatchRow,
  resolveVoiceIntent,
  type VoiceIntent,
  type VoiceSnapshot,
} from "./voice";

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

/** Build a Station fixture with sensible defaults. */
function station(over: Partial<Station> & { Code: string; Name: string }): Station {
  return {
    Code: over.Code,
    Name: over.Name,
    LineCode1: over.LineCode1 ?? "RD",
    LineCode2: over.LineCode2 ?? null,
    LineCode3: over.LineCode3 ?? null,
    LineCode4: over.LineCode4 ?? null,
    Lat: 0,
    Lon: 0,
    StationTogether1: "",
    StationTogether2: "",
    Address: { City: "", State: "", Street: "", Zip: "" },
  };
}

/** A canned no-op search that returns no candidates. */
const emptySearch = (_q: string): Promise<Station[]> => Promise.resolve([]);

/** Make a screen + an attached `MockSttEngine` for driving STT events. */
function makeRig(
  search: (q: string) => Promise<Station[]> = emptySearch,
  initial?: Partial<VoiceSnapshot>,
): {
  screen: ReturnType<typeof makeVoiceScreen>;
  stt: MockSttEngine;
} {
  const stt = new MockSttEngine();
  const screen = makeVoiceScreen(stt, search, initial);
  return { screen, stt };
}

// ---------------------------------------------------------------------------
// formatClock + renderHeader
// ---------------------------------------------------------------------------

describe("voice formatClock", () => {
  it("formats a real timestamp in 12-hour form", () => {
    expect(formatClock(NOW)).toBe(" 2:32p");
  });

  it("returns a stable placeholder for epoch-0 / invalid input", () => {
    expect(formatClock(0)).toBe(" --:--");
    expect(formatClock(Number.NaN)).toBe(" --:--");
  });
});

describe("voice renderHeader", () => {
  it("renders VOICE + clock at exactly LINE_WIDTH cols", () => {
    const out = renderHeader(NOW);
    expect(out.length).toBe(LINE_WIDTH);
    expect(out.startsWith("VOICE")).toBe(true);
    expect(out.endsWith("2:32p")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatTranscriptWindow
// ---------------------------------------------------------------------------

describe("voice formatTranscriptWindow", () => {
  it("returns empty for an empty / whitespace-only transcript", () => {
    expect(formatTranscriptWindow("")).toBe("");
    expect(formatTranscriptWindow("    ")).toBe("");
  });

  it("collapses runs of whitespace into single spaces", () => {
    expect(formatTranscriptWindow("metro   center")).toBe("metro center");
  });

  it("returns the transcript verbatim when within the TRANSCRIPT_WINDOW budget", () => {
    const t = "metro center"; // 12 chars, < 22
    expect(formatTranscriptWindow(t)).toBe(t);
  });

  it("tail-slices long transcripts with a `…` prefix", () => {
    // 30 chars, > TRANSCRIPT_WINDOW (22). The output should be exactly
    // TRANSCRIPT_WINDOW chars total: "…" + the last 21 chars of the
    // input. With a 10-char "a" prefix + 20-char "b" tail, the last 21
    // chars are 1×"a" followed by 20×"b".
    const t = "a".repeat(10) + "b".repeat(20);
    const out = formatTranscriptWindow(t);
    expect(out.length).toBe(TRANSCRIPT_WINDOW);
    expect(out.startsWith("…")).toBe(true);
    // Just the trailing 'b' run is preserved.
    expect(out.endsWith("b".repeat(20))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Initial view (listening, empty transcript)
// ---------------------------------------------------------------------------

describe("voice view: initial render (listening, empty transcript)", () => {
  it("renders header + 'Listening...' + empty transcript line + cancel cue", () => {
    const { screen } = makeRig();
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines[0]).toBe(renderHeader(NOW));
    expect(lines.some((l) => l.includes("Listening"))).toBe(true);
    expect(lines.some((l) => l.includes("double-tap to cancel"))).toBe(true);
    // The transcript row is the "> " prefix + empty window = "> ".
    expect(lines.some((l) => l === "> ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Partial transcript renders truncated to fit width
// ---------------------------------------------------------------------------

describe("voice view: partial transcript", () => {
  it("renders 'metr' verbatim under the listening cue", () => {
    const { screen } = makeRig(emptySearch, { transcript: "metr" });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.some((l) => l.includes("metr"))).toBe(true);
  });

  it("a long partial transcript is tail-sliced under the 22-col window", () => {
    const longTranscript = "metropolitan station something else extra";
    const { screen } = makeRig(emptySearch, {
      transcript: longTranscript,
    });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // The transcript row's content (excluding the "> " prefix) is at
    // most TRANSCRIPT_WINDOW chars wide.
    const transcriptRow = lines.find((l) => l.startsWith("> "));
    expect(transcriptRow).toBeDefined();
    const content = transcriptRow!.slice(2);
    expect(content.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW);
    // The tail of the transcript (the last word) is preserved.
    expect(content).toContain("extra");
    // The front is clipped with an ellipsis.
    expect(content.startsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Silence → resolving (intermediate state)
// ---------------------------------------------------------------------------

describe("voice reduce: silence → resolving", () => {
  it("transitions phase from 'listening' to 'resolving' and stamps lastQuery", () => {
    const { screen } = makeRig(emptySearch, { transcript: "metro center" });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "TRANSCRIPT_SILENCE",
    });
    expect(r.snapshot).toBeDefined();
    expect(r.snapshot!.phase).toBe("resolving");
    expect(r.snapshot!.lastQuery).toBe("metro center");
  });

  it("ignores silence when the transcript is too short", () => {
    const tooShort = "a"; // length 1, below MIN_QUERY_LENGTH (2)
    const { screen } = makeRig(emptySearch, { transcript: tooShort });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "TRANSCRIPT_SILENCE",
    });
    // No phase change.
    expect(r.snapshot).toBeUndefined();
    expect(r.navigate).toBeUndefined();
  });

  it("renders a 'Resolving...' cue with the quoted query in 'resolving' phase", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "resolving",
      lastQuery: "metro center",
    });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.some((l) => l.includes("Resolving"))).toBe(true);
    expect(lines.some((l) => l.includes("metro center"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unique match → navigation
// ---------------------------------------------------------------------------

describe("voice reduce: unique match → predictions", () => {
  it("emits `{ to: 'predictions', stationCode }` when RESOLVE_RESULT has exactly 1 match", () => {
    const metroCenter = station({
      Code: "A01",
      Name: "Metro Center",
      LineCode1: "RD",
      LineCode2: "BL",
    });
    const { screen } = makeRig(emptySearch, {
      phase: "resolving",
      lastQuery: "metro center",
    });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "RESOLVE_RESULT",
      matches: [metroCenter],
    });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01" });
  });
});

// ---------------------------------------------------------------------------
// Three matches → renders 3 rows; SCROLL cycles, TAP confirms
// ---------------------------------------------------------------------------

describe("voice view + reduce: three matches", () => {
  const THREE: Station[] = [
    station({
      Code: "A01",
      Name: "Metro Center",
      LineCode1: "RD",
      LineCode2: "BL",
    }),
    station({
      Code: "F03",
      Name: "Mt Vernon Sq 7th St-Convention Center",
      LineCode1: "GR",
      LineCode2: "YL",
    }),
    station({
      Code: "C02",
      Name: "McPherson Sq",
      LineCode1: "BL",
      LineCode2: "OR",
      LineCode3: "SV",
    }),
  ];

  it("renders 3 match rows with the first highlighted by default", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 0,
    });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // header + "Did you mean:" + spacer + 3 match rows + spacer + cue = 8
    expect(lines.length).toBe(8);
    // First match row carries the "> " prefix; others don't.
    expect(lines[3]!.startsWith("> ")).toBe(true);
    expect(lines[4]!.startsWith("  ")).toBe(true);
    expect(lines[5]!.startsWith("  ")).toBe(true);
    // Names appear (abbreviated where the map provides one).
    expect(lines[3]).toContain("Metro Ctr");
    expect(lines[4]).toContain("Mt Vernon");
    expect(lines[5]).toContain("McPherson");
  });

  it("SCROLL_DOWN cycles matchIndex forward (0 → 1 → 2 → 0)", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 0,
    });
    let snap: VoiceSnapshot = screen.init();
    for (const expected of [1, 2, 0]) {
      const r = screen.reduce(snap, initialNav(), { type: "SCROLL_DOWN" });
      expect(r.snapshot).toBeDefined();
      expect(r.snapshot!.matchIndex).toBe(expected);
      snap = r.snapshot!;
    }
  });

  it("SCROLL_UP cycles matchIndex in reverse (0 → 2 → 1 → 0)", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 0,
    });
    let snap: VoiceSnapshot = screen.init();
    for (const expected of [2, 1, 0]) {
      const r = screen.reduce(snap, initialNav(), { type: "SCROLL_UP" });
      expect(r.snapshot).toBeDefined();
      expect(r.snapshot!.matchIndex).toBe(expected);
      snap = r.snapshot!;
    }
  });

  it("TAP on the highlighted match emits { to: 'predictions', stationCode } for THAT match", () => {
    // Highlight idx 1 (Mt Vernon Sq, Code F03) and confirm TAP picks it.
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 1,
    });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "F03" });
  });

  it("TAP on idx 0 emits the first match's stationCode", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 0,
    });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01" });
  });

  it("TAP on idx 2 emits the third match's stationCode", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 2,
    });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "C02" });
  });
});

// ---------------------------------------------------------------------------
// Edge case: TAP on a single-match list still confirms
// ---------------------------------------------------------------------------

describe("voice reduce: matches phase edge cases", () => {
  it("TAP on a single-match list confirms (navigates to predictions)", () => {
    const onlyOne = station({ Code: "A01", Name: "Metro Center" });
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: [onlyOne],
      matchIndex: 0,
    });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toEqual({ to: "predictions", stationCode: "A01" });
  });
});

// ---------------------------------------------------------------------------
// No match → retry
// ---------------------------------------------------------------------------

describe("voice view + reduce: noMatch", () => {
  it("renders 'No match.' with the quoted lastQuery", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "noMatch",
      lastQuery: "metropolish",
    });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.some((l) => l.includes("No match"))).toBe(true);
    expect(lines.some((l) => l.includes("metropolish"))).toBe(true);
    expect(lines.some((l) => l.includes("tap to retry"))).toBe(true);
  });

  it("TAP returns to 'listening' with a cleared transcript", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "noMatch",
      lastQuery: "metropolish",
      transcript: "metropolish",
    });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.snapshot).toBeDefined();
    expect(r.snapshot!.phase).toBe("listening");
    expect(r.snapshot!.transcript).toBe("");
    expect(r.snapshot!.lastQuery).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Error phase
// ---------------------------------------------------------------------------

describe("voice view + reduce: error phase", () => {
  it("renders the error message", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "error",
      errorMessage: "Network down",
    });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    expect(lines.some((l) => l.includes("Error"))).toBe(true);
    expect(lines.some((l) => l.includes("Network down"))).toBe(true);
  });

  it("DOUBLE_TAP from 'error' returns to home", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "error",
      errorMessage: "boom",
    });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "DOUBLE_TAP",
    });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("RESOLVE_ERROR transitions any phase into 'error' with the message", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "resolving",
      lastQuery: "metro center",
    });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "RESOLVE_ERROR",
      message: "Search service unreachable",
    });
    expect(r.snapshot).toBeDefined();
    expect(r.snapshot!.phase).toBe("error");
    expect(r.snapshot!.errorMessage).toBe("Search service unreachable");
  });
});

// ---------------------------------------------------------------------------
// DOUBLE_TAP from every phase navigates home
// ---------------------------------------------------------------------------

describe("voice reduce: DOUBLE_TAP from every phase returns to home", () => {
  const phases: VoiceSnapshot["phase"][] = [
    "listening",
    "resolving",
    "matches",
    "noMatch",
    "error",
  ];
  for (const phase of phases) {
    it(`returns { to: 'home' } from phase=${phase}`, () => {
      const { screen } = makeRig(emptySearch, { phase });
      const r = screen.reduce(screen.init(), initialNav(), {
        type: "DOUBLE_TAP",
      });
      expect(r.navigate).toEqual({ to: "home" });
    });
  }
});

// ---------------------------------------------------------------------------
// Width check on every phase (regression net)
// ---------------------------------------------------------------------------

describe("voice view: width check across every phase", () => {
  it("never overflows LINE_WIDTH in any phase", () => {
    const THREE: Station[] = [
      station({ Code: "A01", Name: "Metro Center", LineCode1: "RD" }),
      station({ Code: "F03", Name: "Mt Vernon Sq 7th St-Convention Center" }),
      station({ Code: "C02", Name: "McPherson Sq" }),
    ];

    const cases: VoiceSnapshot[] = [
      // listening, empty
      { ...initialVoiceSnapshot() },
      // listening, partial
      { ...initialVoiceSnapshot(), transcript: "metro c" },
      // listening, oversized transcript
      {
        ...initialVoiceSnapshot(),
        transcript: "metro center something something extra",
      },
      // resolving with a long query
      {
        ...initialVoiceSnapshot(),
        phase: "resolving",
        lastQuery: "metro center something extra",
      },
      // matches (all three, max-length names)
      {
        ...initialVoiceSnapshot(),
        phase: "matches",
        matches: THREE,
        matchIndex: 1,
      },
      // noMatch with a max-length query
      {
        ...initialVoiceSnapshot(),
        phase: "noMatch",
        lastQuery: "a really long misheard transcript",
      },
      // error
      {
        ...initialVoiceSnapshot(),
        phase: "error",
        errorMessage: "the upstream service returned an unexpected status",
      },
    ];

    for (const snap of cases) {
      const { screen } = makeRig(emptySearch, snap);
      const lines = screen.view(screen.init(), initialNav(), CTX);
      expectFits(lines);
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot pin: matches state
// ---------------------------------------------------------------------------

describe("voice view snapshot: 3 matches at highlight idx 0", () => {
  it("matches the exact line array", () => {
    const THREE: Station[] = [
      station({
        Code: "A01",
        Name: "Metro Center",
        LineCode1: "RD",
        LineCode2: "BL",
      }),
      station({
        Code: "F03",
        Name: "Mt Vernon Sq 7th St-Convention Center",
        LineCode1: "GR",
        LineCode2: "YL",
      }),
      station({
        Code: "C02",
        Name: "McPherson Sq",
        LineCode1: "BL",
        LineCode2: "OR",
        LineCode3: "SV",
      }),
    ];
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: THREE,
      matchIndex: 0,
    });
    const lines = screen.view(screen.init(), initialNav(), CTX);
    expectFits(lines);
    // Header: "VOICE" + 13 spaces + " 2:32p" = 24 cols.
    // Match rows: "> " or "  " + name(10) + " " + lines(11).
    expect(lines).toEqual([
      "VOICE              2:32p",
      "Did you mean:",
      "",
      renderMatchRow(THREE[0]!, true),
      renderMatchRow(THREE[1]!, false),
      renderMatchRow(THREE[2]!, false),
      "",
      "(scroll=pick, tap=ok)",
    ]);
    expect(lines[0]!.length).toBe(LINE_WIDTH);
    expect(lines[3]!.length).toBe(LINE_WIDTH);
    expect(lines[4]!.length).toBe(LINE_WIDTH);
    expect(lines[5]!.length).toBe(LINE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// TRANSCRIPT event folds the new text into the snapshot
// ---------------------------------------------------------------------------

describe("voice reduce: TRANSCRIPT event folds text into snapshot", () => {
  it("updates `snapshot.transcript` while phase is 'listening'", () => {
    const { screen } = makeRig();
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "TRANSCRIPT",
      text: "metro center",
      isFinal: false,
    });
    expect(r.snapshot).toBeDefined();
    expect(r.snapshot!.transcript).toBe("metro center");
    expect(r.snapshot!.phase).toBe("listening");
  });

  it("ignores TRANSCRIPT updates outside of 'listening'", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: [station({ Code: "A01", Name: "Metro Center" })],
    });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "TRANSCRIPT",
      text: "this should be dropped",
      isFinal: false,
    });
    expect(r.snapshot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RESOLVE_RESULT branches: 0 / 2+ matches
// ---------------------------------------------------------------------------

describe("voice reduce: RESOLVE_RESULT branches", () => {
  it("0 matches → phase 'noMatch'", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "resolving",
      lastQuery: "asdf",
    });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "RESOLVE_RESULT",
      matches: [],
    });
    expect(r.snapshot!.phase).toBe("noMatch");
    expect(r.snapshot!.matches).toEqual([]);
  });

  it("2+ matches → phase 'matches', capped at MAX_MATCHES", () => {
    const many: Station[] = Array.from({ length: 5 }, (_, i) =>
      station({ Code: `X0${i}`, Name: `Station ${i}` }),
    );
    const { screen } = makeRig(emptySearch, {
      phase: "resolving",
      lastQuery: "station",
    });
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "RESOLVE_RESULT",
      matches: many,
    });
    expect(r.snapshot!.phase).toBe("matches");
    expect(r.snapshot!.matches.length).toBe(MAX_MATCHES);
    expect(r.snapshot!.matchIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SCROLL events: no-ops outside the `matches` phase (cycle only there)
// ---------------------------------------------------------------------------

describe("voice reduce: SCROLL events are no-ops outside `matches`", () => {
  const otherPhases: VoiceSnapshot["phase"][] = [
    "listening",
    "resolving",
    "noMatch",
    "error",
  ];
  for (const phase of otherPhases) {
    it(`SCROLL_UP / SCROLL_DOWN are no-ops in phase=${phase}`, () => {
      const { screen } = makeRig(emptySearch, { phase });
      for (const t of ["SCROLL_UP", "SCROLL_DOWN"] as const) {
        const r = screen.reduce(screen.init(), initialNav(), { type: t });
        expect(r.navigate).toBeUndefined();
        expect(r.snapshot).toBeUndefined();
      }
    });
  }

  it("SCROLL is also a no-op in `matches` with a single match (nothing to cycle)", () => {
    const { screen } = makeRig(emptySearch, {
      phase: "matches",
      matches: [station({ Code: "A01", Name: "Metro Center" })],
      matchIndex: 0,
    });
    for (const t of ["SCROLL_UP", "SCROLL_DOWN"] as const) {
      const r = screen.reduce(screen.init(), initialNav(), { type: t });
      expect(r.navigate).toBeUndefined();
      expect(r.snapshot).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// TAP in 'listening' commits the transcript (parallel to silence)
// ---------------------------------------------------------------------------

describe("voice reduce: TAP in 'listening' commits the transcript", () => {
  it("transitions to 'resolving' with lastQuery stamped", () => {
    const { screen } = makeRig(emptySearch, { transcript: "metro center" });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.snapshot).toBeDefined();
    expect(r.snapshot!.phase).toBe("resolving");
    expect(r.snapshot!.lastQuery).toBe("metro center");
  });

  it("is a no-op when the transcript is too short", () => {
    const { screen } = makeRig(emptySearch, { transcript: "a" });
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.snapshot).toBeUndefined();
    expect(r.navigate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onMount / onUnmount: lifecycle side effects
// ---------------------------------------------------------------------------

describe("voice onMount / onUnmount lifecycle", () => {
  /**
   * Build a tiny `EvenAppBridge`-compatible double that records its
   * audioControl(...) calls. The full SDK surface is enormous; cast
   * through `unknown` to satisfy the typechecker (no `any`).
   */
  function makeBridgeDouble(): {
    audioCalls: boolean[];
    /**
     * Latest callback registered through `onEvenHubEvent`. Tests can
     * drive raw audio events into the screen by invoking this.
     */
    emitAudio: (pcm: Uint8Array) => void;
    /** True after the screen's `onEvenHubEvent` unsubscribe ran. */
    audioUnsubCalled: () => boolean;
    bridge: import("@evenrealities/even_hub_sdk").EvenAppBridge;
  } {
    const audioCalls: boolean[] = [];
    let audioCb: ((event: { audioEvent?: { audioPcm: Uint8Array } }) => void) | null =
      null;
    let unsubCalled = false;
    const fake = {
      audioControl: (on: boolean): Promise<boolean> => {
        audioCalls.push(on);
        return Promise.resolve(true);
      },
      onEvenHubEvent: (
        cb: (event: { audioEvent?: { audioPcm: Uint8Array } }) => void,
      ): (() => void) => {
        audioCb = cb;
        return () => {
          unsubCalled = true;
          audioCb = null;
        };
      },
    };
    return {
      audioCalls,
      emitAudio: (pcm: Uint8Array): void => {
        audioCb?.({ audioEvent: { audioPcm: pcm } });
      },
      audioUnsubCalled: () => unsubCalled,
      bridge: fake as unknown as import("@evenrealities/even_hub_sdk").EvenAppBridge,
    };
  }

  it("onMount enables the mic and starts the STT stream", async () => {
    const { screen, stt } = makeRig();
    const { audioCalls, bridge } = makeBridgeDouble();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(bridge, dispatch);
    expect(audioCalls).toEqual([true]);
    expect(stt.active).toBe(true);
  });

  it("dispatches TRANSCRIPT events when the STT engine emits partial transcripts", async () => {
    const { screen, stt } = makeRig();
    const { bridge } = makeBridgeDouble();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(bridge, dispatch);
    stt.simulatePartial("metro");
    stt.simulatePartial("metro center");
    stt.simulateFinal("metro center");
    expect(dispatched.filter((e) => e.type === "TRANSCRIPT").length).toBe(3);
  });

  it("dispatches TRANSCRIPT_SILENCE + drives searchFn on a silence boundary", async () => {
    const matches = [station({ Code: "A01", Name: "Metro Center" })];
    let searchedQuery: string | null = null;
    const search = (q: string): Promise<Station[]> => {
      searchedQuery = q;
      return Promise.resolve(matches);
    };
    const { screen, stt } = makeRig(search);
    const { bridge } = makeBridgeDouble();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(bridge, dispatch);

    stt.simulatePartial("metro center");
    stt.simulateSilence();
    // Drain microtasks so the search promise resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect(searchedQuery).toBe("metro center");
    expect(dispatched.some((e) => e.type === "TRANSCRIPT_SILENCE")).toBe(
      true,
    );
    expect(dispatched.some((e) => e.type === "RESOLVE_RESULT")).toBe(true);
  });

  it("dispatches RESOLVE_ERROR when searchFn rejects", async () => {
    const search = (_q: string): Promise<Station[]> =>
      Promise.reject(new Error("network down"));
    const { screen, stt } = makeRig(search);
    const { bridge } = makeBridgeDouble();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(bridge, dispatch);

    stt.simulatePartial("metro center");
    stt.simulateSilence();
    await Promise.resolve();
    await Promise.resolve();

    const errEvent = dispatched.find((e) => e.type === "RESOLVE_ERROR");
    expect(errEvent).toBeDefined();
    if (errEvent && errEvent.type === "RESOLVE_ERROR") {
      expect(errEvent.message).toBe("network down");
    }
  });

  it("skips the search when the live transcript is too short", async () => {
    let searchCalls = 0;
    const search = (_q: string): Promise<Station[]> => {
      searchCalls += 1;
      return Promise.resolve([]);
    };
    const { screen, stt } = makeRig(search);
    const { bridge } = makeBridgeDouble();
    const dispatch = (_event: ScreenEvent): void => {
      /* no-op */
    };
    await screen.onMount!(bridge, dispatch);

    stt.simulatePartial("a"); // length 1, < MIN_QUERY_LENGTH
    stt.simulateSilence();
    await Promise.resolve();
    await Promise.resolve();

    expect(searchCalls).toBe(0);
  });

  it("onUnmount disables the mic and stops the STT stream", async () => {
    const { screen, stt } = makeRig();
    const { audioCalls, bridge } = makeBridgeDouble();
    const dispatch = (_event: ScreenEvent): void => {
      /* no-op */
    };
    await screen.onMount!(bridge, dispatch);
    expect(stt.active).toBe(true);
    await screen.onUnmount!(bridge);
    expect(audioCalls).toEqual([true, false]);
    expect(stt.active).toBe(false);
    expect(stt.stopCount).toBe(1);
  });

  it("forwards raw audioPcm bridge events into pipe.write", async () => {
    const { screen, stt } = makeRig();
    const { bridge, emitAudio, audioUnsubCalled } = makeBridgeDouble();
    const dispatch = (_event: ScreenEvent): void => {
      /* no-op */
    };
    await screen.onMount!(bridge, dispatch);
    const frameA = new Uint8Array([1, 2, 3, 4]);
    const frameB = new Uint8Array([5, 6, 7, 8]);
    emitAudio(frameA);
    emitAudio(frameB);
    expect(stt.writes.length).toBe(2);
    expect(stt.writes[0]).toBe(frameA);
    expect(stt.writes[1]).toBe(frameB);

    await screen.onUnmount!(bridge);
    expect(audioUnsubCalled()).toBe(true);
  });

  it("surfaces an audioControl(true) failure as an error-phase event", async () => {
    const failingBridge = {
      audioControl: (_on: boolean): Promise<boolean> =>
        Promise.reject(new Error("mic blocked")),
      onEvenHubEvent: (_cb: unknown): (() => void) => () => {
        /* never called — audio control failed */
      },
    } as unknown as import("@evenrealities/even_hub_sdk").EvenAppBridge;
    const { screen } = makeRig();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(failingBridge, dispatch);
    const err = dispatched.find((e) => e.type === "RESOLVE_ERROR");
    expect(err).toBeDefined();
    if (err && err.type === "RESOLVE_ERROR") {
      expect(err.message).toBe("mic blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// createSttEngine: production factory throws a clear configuration error
// ---------------------------------------------------------------------------

describe("createSttEngine production factory", () => {
  it("throws a grep-able 'not configured' error when the key is empty", () => {
    expect(() => createSttEngine("")).toThrowError(/voice\.ts/);
    expect(() => createSttEngine("")).toThrowError(
      /STT provider not configured/,
    );
  });

  it("throws on whitespace-only keys (treated as empty)", () => {
    expect(() => createSttEngine("   ")).toThrowError(
      /STT provider not configured/,
    );
  });

  it("returns an SttEngine instance when the key is non-empty", () => {
    // Stub WebSocket so the Deepgram constructor doesn't attempt a
    // real network connection during construction. We only need to
    // verify the factory returns something `start`-able; the deeper
    // Deepgram tests live in `stt/deepgram.test.ts`.
    const originalWS = globalThis.WebSocket;
    class StubWS {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = "blob";
      onopen: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send(_data: unknown): void {
        /* no-op */
      }
      close(): void {
        /* no-op */
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWS;
    try {
      const engine = createSttEngine("test-key");
      const pipe = engine.start({
        onTranscript: () => {},
        onSilence: () => {},
        onError: () => {},
      });
      expect(typeof pipe.write).toBe("function");
      expect(typeof pipe.close).toBe("function");
      pipe.close();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWS;
    }
  });
});

// ---------------------------------------------------------------------------
// Race-safety: stale RESOLVE_RESULT must not clobber a newer search
// ---------------------------------------------------------------------------

describe("voice onMount: in-flight search generation counter", () => {
  /**
   * Test-local bridge double — `audioControl` resolves to `true` by
   * default. Kept here (rather than reusing the lifecycle-block
   * helper) so the new tests are self-contained and the existing
   * tests are untouched.
   */
  function okBridge(): import("@evenrealities/even_hub_sdk").EvenAppBridge {
    const fake = {
      audioControl: (_on: boolean): Promise<boolean> => Promise.resolve(true),
      onEvenHubEvent: (_cb: unknown): (() => void) => () => {
        /* test double */
      },
    };
    return fake as unknown as import("@evenrealities/even_hub_sdk").EvenAppBridge;
  }

  it("drops the FIRST search's result when a SECOND silence fires before it settles", async () => {
    // Set up two manually-resolvable searches. The first resolves to
    // a single match (would navigate); the second to zero (noMatch).
    // We resolve the SECOND first, then the FIRST — the older
    // result must be dropped silently.
    let firstResolve: ((m: Station[]) => void) | null = null;
    let secondResolve: ((m: Station[]) => void) | null = null;
    let callIndex = 0;
    const search = (_q: string): Promise<Station[]> => {
      callIndex += 1;
      if (callIndex === 1) {
        return new Promise<Station[]>((res) => {
          firstResolve = res;
        });
      }
      return new Promise<Station[]>((res) => {
        secondResolve = res;
      });
    };

    const { screen, stt } = makeRig(search);
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(okBridge(), dispatch);

    // First utterance.
    stt.simulatePartial("metro center");
    stt.simulateSilence();
    expect(callIndex).toBe(1);

    // Second utterance arrives before the first search resolves.
    stt.simulatePartial("gallery place");
    stt.simulateSilence();
    expect(callIndex).toBe(2);

    // Resolve the SECOND first (noMatch).
    secondResolve!([]);
    await Promise.resolve();
    await Promise.resolve();

    // Now resolve the FIRST (would have been a unique match) — this
    // is stale and must be dropped.
    firstResolve!([station({ Code: "A01", Name: "Metro Center" })]);
    await Promise.resolve();
    await Promise.resolve();

    const resolveResults = dispatched.filter(
      (e) => e.type === "RESOLVE_RESULT",
    );
    // Only ONE RESOLVE_RESULT must reach the dispatch — the newer
    // (second) one. The older one is dropped by the generation gate.
    expect(resolveResults.length).toBe(1);
    const evt = resolveResults[0]!;
    if (evt.type === "RESOLVE_RESULT") {
      expect(evt.matches).toEqual([]);
    }
  });

  it("dispatches RESOLVE_ERROR + skips STT when audioControl(true) resolves to false", async () => {
    const failingBridge = {
      audioControl: (_on: boolean): Promise<boolean> => Promise.resolve(false),
      onEvenHubEvent: (_cb: unknown): (() => void) => () => {
        /* never called — audio control failed */
      },
    } as unknown as import("@evenrealities/even_hub_sdk").EvenAppBridge;
    const { screen, stt } = makeRig();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(failingBridge, dispatch);

    const err = dispatched.find((e) => e.type === "RESOLVE_ERROR");
    expect(err).toBeDefined();
    if (err && err.type === "RESOLVE_ERROR") {
      expect(err.message).toBe("Microphone unavailable.");
    }
    // STT must NOT have been started — otherwise we'd be reading
    // from a dead mic.
    expect(stt.active).toBe(false);
  });

  it("STT onError callback dispatches RESOLVE_ERROR carrying the error message", async () => {
    const { screen, stt } = makeRig();
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(okBridge(), dispatch);

    stt.simulateError("stt stream lost");
    const err = dispatched.find((e) => e.type === "RESOLVE_ERROR");
    expect(err).toBeDefined();
    if (err && err.type === "RESOLVE_ERROR") {
      expect(err.message).toBe("stt stream lost");
    }
  });

  it("late STT callback after onUnmount is a no-op (no dispatch effect)", async () => {
    const { screen, stt } = makeRig();
    const audioCalls: boolean[] = [];
    const bridge = {
      audioControl: (on: boolean): Promise<boolean> => {
        audioCalls.push(on);
        return Promise.resolve(true);
      },
      onEvenHubEvent: (_cb: unknown): (() => void) => () => {
        /* test double */
      },
    } as unknown as import("@evenrealities/even_hub_sdk").EvenAppBridge;
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };

    await screen.onMount!(bridge, dispatch);
    await screen.onUnmount!(bridge);
    // `stt.stopCount` should be 1 — stream was torn down.
    expect(stt.stopCount).toBe(1);
    // Drop a stale callback. MockSttEngine clears its callback on
    // stop, so simulate* are no-ops — no dispatch must follow.
    const before = dispatched.length;
    stt.simulatePartial("late text");
    stt.simulateSilence();
    stt.simulateError("late error");
    expect(dispatched.length).toBe(before);
  });

  it("formatTranscriptWindow on an unbroken 100-char token slices to ≤ TRANSCRIPT_WINDOW", () => {
    const out = formatTranscriptWindow("a".repeat(100));
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW);
    expect(out.length).toBe(TRANSCRIPT_WINDOW);
    // Tail-slice with `…` prefix — the trailing run of "a"s is preserved.
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("a".repeat(TRANSCRIPT_WINDOW - 1))).toBe(true);
  });

  it("second onSilence while first search still resolving: only the newer result dispatches", async () => {
    // Variant on the stale-race test that locks the chosen strategy
    // (last-wins via gen counter rather than skip-while-resolving):
    // BOTH searches are invoked, but only the newer one's result
    // makes it through to dispatch. If a future implementer switches
    // to skip-while-resolving, this test will need updating — that's
    // intentional, the invariant is load-bearing.
    let callCount = 0;
    let firstResolve: ((m: Station[]) => void) | null = null;
    let secondResolve: ((m: Station[]) => void) | null = null;
    const search = (_q: string): Promise<Station[]> => {
      callCount += 1;
      return new Promise<Station[]>((res) => {
        if (callCount === 1) firstResolve = res;
        else secondResolve = res;
      });
    };
    const { screen, stt } = makeRig(search);
    const dispatched: ScreenEvent[] = [];
    const dispatch = (event: ScreenEvent): void => {
      dispatched.push(event);
    };
    await screen.onMount!(okBridge(), dispatch);

    stt.simulatePartial("metro center");
    stt.simulateSilence();
    stt.simulatePartial("gallery place");
    stt.simulateSilence();

    // Both searches are in flight.
    expect(callCount).toBe(2);

    // Resolve in order (first then second). The first must be
    // dropped because the second has already been initiated.
    const newer = [station({ Code: "B01", Name: "Gallery Pl-Chinatown" })];
    firstResolve!([station({ Code: "A01", Name: "Metro Center" })]);
    await Promise.resolve();
    await Promise.resolve();
    secondResolve!(newer);
    await Promise.resolve();
    await Promise.resolve();

    const results = dispatched.filter((e) => e.type === "RESOLVE_RESULT");
    expect(results.length).toBe(1);
    const r = results[0]!;
    if (r.type === "RESOLVE_RESULT") {
      expect(r.matches.length).toBe(1);
      expect(r.matches[0]!.Code).toBe("B01");
    }
  });
});

// ---------------------------------------------------------------------------
// Voice intent resolver
// ---------------------------------------------------------------------------

describe("resolveVoiceIntent", () => {
  const targets = { home: "C01", work: "A01" };
  const emptyTargets = { home: "", work: "" };

  it("maps 'home' to predictions(home) when configured", () => {
    expect(resolveVoiceIntent("home", targets)).toEqual({
      kind: "navigate",
      intent: { to: "predictions", stationCode: "C01" },
    } satisfies VoiceIntent);
  });

  it("maps 'work' to predictions(work) when configured", () => {
    expect(resolveVoiceIntent("work", targets)).toEqual({
      kind: "navigate",
      intent: { to: "predictions", stationCode: "A01" },
    } satisfies VoiceIntent);
  });

  it("treats 'office' as a synonym for 'work'", () => {
    expect(resolveVoiceIntent("office", targets)).toEqual({
      kind: "navigate",
      intent: { to: "predictions", stationCode: "A01" },
    } satisfies VoiceIntent);
  });

  it("strips a verbal prefix before matching ('take me home' -> home)", () => {
    expect(resolveVoiceIntent("take me home", targets)).toEqual({
      kind: "navigate",
      intent: { to: "predictions", stationCode: "C01" },
    } satisfies VoiceIntent);
  });

  it("maps 'alerts' to incidents", () => {
    expect(resolveVoiceIntent("alerts", emptyTargets)).toEqual({
      kind: "navigate",
      intent: { to: "incidents" },
    } satisfies VoiceIntent);
  });

  it("maps 'incidents' to incidents", () => {
    expect(resolveVoiceIntent("incidents", emptyTargets)).toEqual({
      kind: "navigate",
      intent: { to: "incidents" },
    } satisfies VoiceIntent);
  });

  it("maps 'elevators' / 'outages' / 'access' to elevator", () => {
    for (const word of ["elevators", "outages", "access"]) {
      expect(resolveVoiceIntent(word, emptyTargets)).toEqual({
        kind: "navigate",
        intent: { to: "elevator" },
      } satisfies VoiceIntent);
    }
  });

  it("maps 'last train' to predictions(home) when home is set", () => {
    expect(resolveVoiceIntent("last train", targets)).toEqual({
      kind: "navigate",
      intent: { to: "predictions", stationCode: "C01" },
    } satisfies VoiceIntent);
  });

  it("falls through to station-match when 'last train' has no home configured", () => {
    expect(resolveVoiceIntent("last train", emptyTargets)).toEqual({
      kind: "station-match",
      query: "last train",
    } satisfies VoiceIntent);
  });

  it("falls through when 'home' has no station configured", () => {
    expect(resolveVoiceIntent("home", emptyTargets)).toEqual({
      kind: "station-match",
      query: "home",
    } satisfies VoiceIntent);
  });

  it("falls through to station-match for arbitrary station names", () => {
    expect(resolveVoiceIntent("metro center", targets)).toEqual({
      kind: "station-match",
      query: "metro center",
    } satisfies VoiceIntent);
  });

  it("falls through for empty / non-string input", () => {
    expect(resolveVoiceIntent("", targets)).toEqual({
      kind: "station-match",
      query: "",
    } satisfies VoiceIntent);
  });

  it("preserves the original (non-normalised) query in station-match", () => {
    // Mixed-case + leading/trailing whitespace.
    const out = resolveVoiceIntent("  Metro Center  ", targets);
    expect(out).toEqual({
      kind: "station-match",
      query: "  Metro Center  ",
    } satisfies VoiceIntent);
  });
});

describe("voice screen: intent resolver shortcut", () => {
  it("dispatches RESOLVE_NAVIGATE for a keyword and skips the searchFn", async () => {
    let searchCalls = 0;
    const search = (_q: string): Promise<Station[]> => {
      searchCalls += 1;
      return Promise.resolve([]);
    };
    const stt = new MockSttEngine();
    const screen = makeVoiceScreen(
      stt,
      search,
      undefined,
      (transcript: string) => resolveVoiceIntent(transcript, { home: "C01", work: "" }),
    );

    const dispatched: ScreenEvent[] = [];
    await screen.onMount!(
      // The bridge isn't touched until the audio path is wired —
      // we hand it a stub that satisfies the typed callbacks the
      // Voice screen's `onMount` actually invokes.
      {
        audioControl: () => Promise.resolve(true),
        onEvenHubEvent: () => () => undefined,
      } as never,
      (event) => {
        dispatched.push(event);
      },
    );

    // Drive a transcript + silence — the resolver should fire BEFORE
    // searchFn and dispatch RESOLVE_NAVIGATE.
    stt.simulatePartial("home");
    stt.simulateSilence();
    await Promise.resolve();
    await Promise.resolve();

    expect(searchCalls).toBe(0);
    const nav = dispatched.find((e) => e.type === "RESOLVE_NAVIGATE");
    expect(nav).toBeDefined();
    if (nav?.type === "RESOLVE_NAVIGATE") {
      expect(nav.intent).toEqual({ to: "predictions", stationCode: "C01" });
    }

    await screen.onUnmount!({
      audioControl: () => Promise.resolve(true),
    } as never);
  });

  it("falls through to searchFn for non-keyword transcripts", async () => {
    let searchCalls = 0;
    const search = (q: string): Promise<Station[]> => {
      searchCalls += 1;
      expect(q).toBe("metro center");
      return Promise.resolve([station({ Code: "A01", Name: "Metro Center" })]);
    };
    const stt = new MockSttEngine();
    const screen = makeVoiceScreen(
      stt,
      search,
      undefined,
      (transcript: string) =>
        resolveVoiceIntent(transcript, { home: "C01", work: "" }),
    );

    const dispatched: ScreenEvent[] = [];
    await screen.onMount!(
      {
        audioControl: () => Promise.resolve(true),
        onEvenHubEvent: () => () => undefined,
      } as never,
      (event) => {
        dispatched.push(event);
      },
    );

    stt.simulatePartial("metro center");
    stt.simulateSilence();
    await Promise.resolve();
    await Promise.resolve();

    expect(searchCalls).toBe(1);
    expect(dispatched.some((e) => e.type === "RESOLVE_NAVIGATE")).toBe(false);

    await screen.onUnmount!({
      audioControl: () => Promise.resolve(true),
    } as never);
  });
});
