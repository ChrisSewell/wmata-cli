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

import { describe, expect, it } from "vitest";
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
}

function makeFakeBridge(): { bridge: EvenAppBridge; record: FakeBridgeRecord } {
  const record: FakeBridgeRecord = { upgrades: [], shutdownCalls: 0 };
  const fake = {
    createStartUpPageContainer: (
      _container: CreateStartUpPageContainer,
    ): Promise<StartUpPageCreateResult> =>
      Promise.resolve(StartUpPageCreateResult.success),
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
    view(snapshot: TickerSnapshot): string[] {
      const lines = [`gen=${String(snapshot.generation)}`];
      ticker.latestRenderedLines = lines;
      return lines;
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
