// Unit tests for the SDK host glue (`glasses-host.ts`).
//
// The host owns the page lifecycle and the auto-refresh interval, so the
// behaviour worth pinning here is the single-flight tick guard: when a
// tick is already in flight, the interval-fired follow-up MUST be dropped
// (not queued, not raced); and when `unmount()` is called while a tick
// is in flight, the late result MUST NOT be applied to the snapshot.
//
// We drive a tiny synthetic `Screen<S>` through `mountGlassesScreen` with
// a minimal fake `EvenAppBridge` — just the four methods the host uses
// (`createStartUpPageContainer`, `textContainerUpgrade`, `onEvenHubEvent`,
// `shutDownPageContainer`). The unused surface of the real bridge is
// cast away via `unknown` (no `any`, no `@ts-ignore`).

import { describe, expect, it, vi } from "vitest";
import {
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";

import { mountGlassesScreen } from "./glasses-host";
import type {
  NavIntent,
  Router,
  Screen,
  ScreenEvent,
  ScreenSections,
  ViewContext,
} from "./router";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal record of every textContainerUpgrade payload that the host
 * pushed during the test. Used to assert "the late-arriving result was
 * NOT rendered after unmount".
 */
interface FakeBridgeRecord {
  upgrades: string[];
  shutdownCalls: number;
  pageCreates: CreateStartUpPageContainer[];
}

function makeFakeBridge(): { bridge: EvenAppBridge; record: FakeBridgeRecord } {
  const record: FakeBridgeRecord = { upgrades: [], shutdownCalls: 0, pageCreates: [] };
  const fake = {
    createStartUpPageContainer: (
      container: CreateStartUpPageContainer,
    ): Promise<StartUpPageCreateResult> => {
      record.pageCreates.push(container);
      return Promise.resolve(StartUpPageCreateResult.success);
    },
    textContainerUpgrade: (container: TextContainerUpgrade): Promise<boolean> => {
      // `content` lives on the protobuf-shaped container. The SDK's
      // generated type makes it `string | undefined`; the host always
      // sets a value before calling, so we coalesce defensively.
      const content =
        (container as unknown as { content?: string }).content ?? "";
      record.upgrades.push(content);
      return Promise.resolve(true);
    },
    shutDownPageContainer: (_exitMode?: number): Promise<boolean> => {
      record.shutdownCalls += 1;
      return Promise.resolve(true);
    },
    onEvenHubEvent: (_cb: (event: EvenHubEvent) => void): (() => void) => {
      return () => {
        /* unsubscribe is a no-op for these tests */
      };
    },
  };
  // The full EvenAppBridge surface is enormous and most of it is
  // irrelevant here; cast through `unknown` to satisfy the typechecker
  // without resorting to `any` or `@ts-ignore`.
  return { bridge: fake as unknown as EvenAppBridge, record };
}

function makeStubRouter(): Router {
  return {
    current: "home" as NavIntent["to"],
    navigate: (_intent: NavIntent): Promise<void> => Promise.resolve(),
  };
}

/** A simple controllable Promise — resolves only when `release()` is invoked. */
function makeGate<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A synthetic Screen<S> with a controllable `tick`. Each `tick` call
 * waits on a gate that the test supplies, so we can hold a tick in
 * flight while a second one fires on the interval.
 */
interface TickerSnapshot {
  generation: number;
}

interface Ticker {
  screen: Screen<TickerSnapshot> & {
    tick: (s: TickerSnapshot) => Promise<TickerSnapshot>;
    tickIntervalMs: number;
  };
  /** How many times tick() has been *called* (regardless of whether it ran). */
  callCount: number;
  /** Resolve the in-flight tick's gate with the given next snapshot. */
  resolveCurrent: (next: TickerSnapshot) => void;
  /** Snapshot the host built `view()` against most recently. */
  latestRenderedLines: string[];
}

function makeTicker(initial: TickerSnapshot, intervalMs: number): Ticker {
  const pending: Array<(s: TickerSnapshot) => void> = [];
  const ticker: Ticker = {
    callCount: 0,
    resolveCurrent: (next: TickerSnapshot) => {
      const resolver = pending.shift();
      if (!resolver) throw new Error("resolveCurrent called with no pending tick");
      resolver(next);
    },
    latestRenderedLines: [],
    // Filled in below.
    screen: null as unknown as Ticker["screen"],
  };
  ticker.screen = {
    name: "predictions",
    init: () => initial,
    view(
      snapshot: TickerSnapshot,
      _nav,
      _ctx: ViewContext,
    ): ScreenSections {
      const lines = [`gen=${String(snapshot.generation)}`];
      ticker.latestRenderedLines = lines;
      return { header: lines, body: [] };
    },
    reduce(_s: TickerSnapshot, nav, _e: ScreenEvent) {
      return { nav };
    },
    tick: (_s: TickerSnapshot): Promise<TickerSnapshot> => {
      ticker.callCount += 1;
      const gate = makeGate<TickerSnapshot>();
      pending.push(gate.release);
      return gate.promise;
    },
    tickIntervalMs: intervalMs,
  };
  return ticker;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("glasses-host single-flight tick guard", () => {
  it("drops an interval-fired tick while a previous tick is still in flight (SKIP strategy)", async () => {
    const { bridge } = makeFakeBridge();
    const router = makeStubRouter();
    // A very small interval so we can manually fire it from the test
    // without waiting on real wall clock. We don't actually rely on the
    // setInterval firing — we manually drive `runTick` via the host's
    // exposed surface. But because `runTick` is not exported, we
    // exercise it through the interval: a 5ms interval is short enough
    // that a few setTimeout(0)s will let one or two ticks fire.
    const ticker = makeTicker({ generation: 0 }, 5);
    const unmount = await mountGlassesScreen(ticker.screen, bridge, router);

    // After mount, the host fires its initial tick immediately. Yield
    // once so the kickoff lands in `pending`.
    await Promise.resolve();
    await Promise.resolve();
    expect(ticker.callCount).toBe(1);

    // Now wait long enough that several interval-fired ticks would
    // attempt to run. None of them should actually invoke `tick()`
    // again because the first tick is still gated.
    await new Promise((r) => setTimeout(r, 30));
    expect(ticker.callCount).toBe(1);

    // Release the in-flight tick. The host should apply the result and
    // re-render. After that, the NEXT interval firing is allowed to
    // proceed (single-flight unlocked).
    ticker.resolveCurrent({ generation: 1 });

    // Yield to let the host apply the result and re-render.
    await new Promise((r) => setTimeout(r, 30));
    // At least one further tick should have been attempted post-unlock.
    expect(ticker.callCount).toBeGreaterThanOrEqual(2);

    await unmount();
  });

  it("does NOT apply an in-flight tick result to the snapshot when unmount has run", async () => {
    const { bridge, record } = makeFakeBridge();
    const router = makeStubRouter();
    const ticker = makeTicker({ generation: 0 }, 10_000); // long interval — only initial tick fires.
    const unmount = await mountGlassesScreen(ticker.screen, bridge, router);

    // Initial render from `init()` + the initial-tick kickoff.
    await Promise.resolve();
    await Promise.resolve();
    expect(ticker.callCount).toBe(1);

    // Snapshot the upgrade count after the initial render (which was
    // "gen=0"). We expect this number to NOT increase even after we
    // release the stale tick post-unmount.
    const upgradesBeforeUnmount = record.upgrades.length;

    // Unmount BEFORE the in-flight tick resolves.
    await unmount();

    // Now release the stale tick result. The host MUST detect that the
    // generation moved and refuse to apply it.
    ticker.resolveCurrent({ generation: 99 });

    // Give microtasks a chance to drain.
    await new Promise((r) => setTimeout(r, 10));

    // No new textContainerUpgrade should have been emitted after
    // unmount — the late result was discarded.
    expect(record.upgrades.length).toBe(upgradesBeforeUnmount);
    // And the rendered lines that view() last produced still reflect
    // the pre-unmount snapshot (generation 0), NOT 99.
    expect(ticker.latestRenderedLines.join("\n")).toContain("gen=0");
  });
});

// ---------------------------------------------------------------------------
// Clock tick fires independently of the fetch tick
// ---------------------------------------------------------------------------
//
// The host runs a 1Hz clock interval that re-renders the current
// snapshot with a fresh `ctx.nowMs` but does NOT invoke `tick()`. The
// load-bearing property: even when `tick()` is permanently hung (a
// network-stall regression), the clock keeps advancing on the HUD.
//
// To make the clock value observable in the rendered content (the
// fake screen's `view` ignores `ctx` and just emits a snapshot-derived
// string), we instead build a screen whose `view` writes `ctx.nowMs`
// into the rendered content directly.

/**
 * A clock-only screen: never ticks, just renders the wall-clock value
 * the host injects. Used to verify the 1Hz tick actually pumps `view`
 * with fresh `nowMs` values.
 */
function makeHungClockScreen(): {
  screen: Screen<{ marker: string }>;
  hungTickCalls: { count: number };
} {
  const hungTickCalls = { count: 0 };
  const screen: Screen<{ marker: string }> & {
    tick: (s: { marker: string }) => Promise<{ marker: string }>;
    tickIntervalMs: number;
  } = {
    name: "predictions",
    init: () => ({ marker: "hung" }),
    view(snapshot, _nav, ctx: ViewContext): ScreenSections {
      return { header: [`now=${ctx.nowMs}`], body: [snapshot.marker] };
    },
    reduce(_s, nav, _e: ScreenEvent) {
      return { nav };
    },
    tick: (_s: { marker: string }): Promise<{ marker: string }> => {
      hungTickCalls.count += 1;
      // Permanently hung — simulates a network-stall regression. The
      // 1Hz clock tick MUST keep firing regardless.
      return new Promise(() => {
        /* never resolves */
      });
    },
    // A long-ish fetch interval is fine: the fetch tick fires once at
    // mount and never again (because the first one never settles, so
    // the single-flight guard blocks subsequent interval firings).
    tickIntervalMs: 20_000,
  };
  return { screen, hungTickCalls };
}

describe("glasses-host clock tick (decoupled from fetch)", () => {
  it("re-renders with a fresh ctx.nowMs every second even when tick() is hung, and stops after unmount", async () => {
    vi.useFakeTimers();
    try {
      // Anchor wall-clock so `Date.now()` is deterministic across the
      // host's clock-tick callbacks.
      vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

      const { bridge, record } = makeFakeBridge();
      const router = makeStubRouter();
      const { screen, hungTickCalls } = makeHungClockScreen();

      const unmount = await mountGlassesScreen(screen, bridge, router);
      // After mount: one initial render (from `view` directly) and one
      // attempted fetch tick (gated forever).
      await Promise.resolve();
      expect(hungTickCalls.count).toBe(1);
      const upgradesAfterMount = record.upgrades.length;

      // Advance 5 wall-clock seconds, bumping `Date.now()` at each step
      // so the rendered content (`now=...`) is distinct per tick — that
      // way the host's dedupe cache doesn't swallow these renders.
      for (let s = 1; s <= 5; s++) {
        vi.setSystemTime(new Date(2026, 4, 18, 12, 0, s));
        await vi.advanceTimersByTimeAsync(1000);
      }

      // The clock tick should have fired at least 5 times and pushed
      // at least 4 distinct text updates (the 5th may coincide with
      // the unmount path on slower runners; we assert >=4 to keep the
      // test stable). The fetch tick must NOT have been re-invoked.
      const upgradesDelta = record.upgrades.length - upgradesAfterMount;
      expect(upgradesDelta).toBeGreaterThanOrEqual(4);
      expect(hungTickCalls.count).toBe(1);

      // Every clock-driven render embeds `ctx.nowMs` in the first line.
      // The series should be strictly increasing.
      const nowValues = record.upgrades
        .slice(upgradesAfterMount)
        .map((c) => {
          const m = c.match(/^now=(\d+)/);
          return m ? Number(m[1]) : NaN;
        })
        .filter((n) => Number.isFinite(n));
      for (let i = 1; i < nowValues.length; i++) {
        expect(nowValues[i]!).toBeGreaterThan(nowValues[i - 1]!);
      }

      // After unmount the clock tick must STOP — no further upgrades.
      await unmount();
      const upgradesAtUnmount = record.upgrades.length;
      vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 10));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(record.upgrades.length).toBe(upgradesAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Page-container shape (host-side deserialiser + event-routing expectations)
// ---------------------------------------------------------------------------
//
// The page is a single TextContainer that fills the 576x288 panel
// and is the page's sole event capturer. Earlier iterations mounted
// a hidden 1x1 ListContainer "to harvest scrolls", on the assumption
// that only LIST containers emit SCROLL_TOP/SCROLL_BOTTOM. That was
// a misreading: lists *consume* scroll events internally for native
// scrolling and never surface them to the page. Empirical testing
// (simulator with `RUST_LOG=debug`) confirmed text containers
// receive every gesture (taps, double-taps, AND swipes) when they
// hold `isEventCapture: 1`. Pin the shape so a future "let's add a
// list back" attempt fails loudly here instead of silently breaking
// every swipe.

describe("glasses-host page-container shape", () => {
  // SDK README "Important Notes": when multiple containers are mounted
  // in a single page, EXACTLY ONE may have `isEventCapture: 1`. The
  // simulator's validation error for the multi-capturer case is
  // "multiple event listeners (N) not allowed", surfaced only via
  // `RUST_LOG=debug`; without it the page creation simply returns
  // `invalid (1)`. Pin the shape here.
  it("has exactly one container with isEventCapture=1 (SDK constraint)", async () => {
    const { bridge, record } = makeFakeBridge();
    const router = makeStubRouter();
    const ticker = makeTicker({ generation: 0 }, 10_000);

    const unmount = await mountGlassesScreen(ticker.screen, bridge, router);
    try {
      expect(record.pageCreates).toHaveLength(1);
      const page = record.pageCreates[0]!;
      const captures: number[] = [];
      for (const t of page.textObject ?? []) {
        captures.push(t.isEventCapture ?? 0);
      }
      for (const l of page.listObject ?? []) {
        captures.push(l.isEventCapture ?? 0);
      }
      const ones = captures.filter((c) => c === 1).length;
      expect(ones).toBe(1);
    } finally {
      await unmount();
    }
  });

  // The page must use a TEXT container as the event capturer, NOT a
  // list. Lists consume scroll events internally (native scrolling)
  // and never deliver them to the page — using a list as the
  // capturer silently drops every swipe.
  it("uses a TextContainer as the event capturer (no list)", async () => {
    const { bridge, record } = makeFakeBridge();
    const router = makeStubRouter();
    const ticker = makeTicker({ generation: 0 }, 10_000);

    const unmount = await mountGlassesScreen(ticker.screen, bridge, router);
    try {
      expect(record.pageCreates).toHaveLength(1);
      const page = record.pageCreates[0]!;
      // No list container at all — lists swallow scrolls natively.
      expect((page.listObject ?? []).length).toBe(0);
      const capturer = (page.textObject ?? []).find(
        (t) => (t.isEventCapture ?? 0) === 1,
      );
      expect(capturer).toBeDefined();
    } finally {
      await unmount();
    }
  });
});
