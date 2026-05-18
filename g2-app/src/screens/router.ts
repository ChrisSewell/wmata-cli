// Screen / router contract for the glasses HUD.
//
// Every glasses screen (Home today; Predictions / Incidents / Voice in
// future work-packages) implements the `Screen<Snapshot>` interface
// below. The interface is intentionally minimal:
//
//   - `init`   :: () => Snapshot
//        Build the initial data snapshot. Pure: no SDK calls, no I/O.
//        Live data (e.g. predictions) gets injected by the host wiring
//        after mount, not from `init`.
//   - `view`   :: (Snapshot, NavState, ViewContext) => string[]
//        Render the screen into ≤ TOTAL_ROWS lines. EACH LINE must be
//        ≤ LINE_WIDTH columns. The host concatenates with `\n` and feeds
//        the result into `bridge.textContainerUpgrade`. The third `ctx`
//        parameter supplies render-time data the host owns (currently
//        just the wall clock — see `ViewContext`).
//   - `reduce` :: (Snapshot, NavState, ScreenEvent) => { nav, navigate? }
//        Pure reducer for touchpad events. Returning `navigate` tells the
//        host to switch screens.
//
// Why a pure split? The view is unit-testable down to the column. The
// reducer is unit-testable as a state machine. Only the host
// (`glasses-host.ts`) touches the SDK — and ONLY the host needs to know
// about Protobuf zero-value coalescing, container IDs, page lifecycle,
// etc. Future screens can be authored without re-learning that surface.

/**
 * Touchpad / lifecycle event, after the host has normalised away the
 * SDK's three event envelopes (sysEvent / textEvent / listEvent) and the
 * Protobuf zero-value caveat (`undefined === CLICK_EVENT`).
 *
 * In addition to the four touchpad gestures, the host can forward
 * voice-flow events emitted by a screen's `onMount` glue (e.g. the
 * Voice screen subscribes to its injected `SttEngine` and dispatches
 * `TRANSCRIPT` / `TRANSCRIPT_SILENCE` / `RESOLVE_RESULT` /
 * `RESOLVE_ERROR` through `dispatch`). Screens that don't care about
 * the voice-flow variants simply ignore them in their reducer's
 * `default` branch — the `Screen<S>` contract requires every reducer to
 * be total over `ScreenEvent`, including future additions.
 */
export type ScreenEvent =
  | { type: "SCROLL_UP" }
  | { type: "SCROLL_DOWN" }
  | { type: "TAP" }
  | { type: "DOUBLE_TAP" }
  | { type: "TRANSCRIPT"; text: string; isFinal: boolean }
  | { type: "TRANSCRIPT_SILENCE" }
  | { type: "RESOLVE_RESULT"; matches: import("../wmata").Station[] }
  | { type: "RESOLVE_ERROR"; message: string };

/**
 * Per-screen UI cursor state. Lives outside the snapshot so we can
 * preserve highlight position across data refreshes (e.g. an ETA tick
 * shouldn't reset which row the user has selected).
 */
export interface NavState {
  highlightedIndex: number;
}

/**
 * Where the user is heading next. The host translates each variant into
 * a mount / unmount sequence. `exit` tears down the page container.
 */
export type NavIntent =
  | { to: "home" }
  | { to: "predictions"; stationCode: string }
  | { to: "incidents" }
  | { to: "voice" }
  | { to: "tutorial" }
  | { to: "exit" };

/**
 * Result of a reducer step.
 *
 * The optional `snapshot` field lets a reducer return a NEW snapshot
 * value (e.g. the Voice screen folds a fresh transcript into
 * `snapshot.transcript` on every `TRANSCRIPT` event). Most reducers
 * leave it unset — touchpad gestures that only move the highlight
 * cursor don't need to allocate a new snapshot.
 *
 * The host treats `snapshot === undefined` as "keep the previous
 * snapshot reference"; an explicit `snapshot` replaces the host's
 * stored value before the next render.
 *
 * `Snapshot` defaults to `unknown` so reducers that never produce a
 * snapshot field can use the bare `ReduceResult` type at their call
 * site. Concrete screens parameterise with their own snapshot type
 * to get full type-safety on the field.
 */
export interface ReduceResult<Snapshot = unknown> {
  nav: NavState;
  navigate?: NavIntent;
  snapshot?: Snapshot;
}

/**
 * Per-render context supplied by the host. Currently just the wall
 * clock, but the interface is open for future additions (e.g. a
 * "battery low" signal, a debug-mode flag).
 *
 * The host writes a fresh `nowMs` on every render call, including the
 * cheap 1Hz clock-only re-renders that fire independently of any
 * `tick()`. This is the load-bearing detail: it means a screen's
 * wall-clock display (and any time-dependent UI like stale markers)
 * can NEVER freeze due to a hung fetch — the clock interval is its
 * own independent timer.
 *
 * Screens with no time-sensitive UI may simply ignore `ctx` in `view`.
 */
export interface ViewContext {
  /**
   * Wall-clock millis at the moment of rendering. Always
   * `Date.now()` at render time, NEVER read from the snapshot. The
   * host updates this once per second on its clock tick (and again
   * on every fetch tick and event-driven re-render).
   */
  nowMs: number;
}

/**
 * The contract each screen implements. `Snapshot` is screen-specific
 * data (favorites for Home, predictions for the Predictions screen, etc.)
 * and stays opaque to the router.
 *
 * Optional `tick` / `tickIntervalMs` hooks let a screen request periodic
 * background refreshes (e.g. WP7 Predictions polls WMATA every 20s).
 * The host calls `tick(currentSnapshot)` once on mount and then on a
 * `setInterval(tickIntervalMs)` cadence, replacing the live snapshot
 * with the returned value and re-rendering. A screen that omits both
 * hooks (Home in WP6) never gets ticked.
 *
 * Independently, the host runs a 1Hz CLOCK tick that re-invokes `view`
 * with a fresh `ctx.nowMs` but does NOT touch the snapshot. That tick
 * runs whether or not the screen opts into `tick`/`tickIntervalMs`.
 */
export interface Screen<Snapshot> {
  /** Stable identifier for logging / debugging. */
  readonly name: NavIntent["to"];
  /** Build the initial snapshot. Pure: no SDK, no I/O. */
  init(): Snapshot;
  /**
   * Optional: called once by the host after the page container is
   * created, BEFORE any tick or clock-render. Use for SDK side effects
   * that are tied to the screen's lifetime — e.g. the Voice screen
   * enables the microphone here (`bridge.audioControl(true)`) and
   * starts its STT stream, wiring callbacks to `dispatch` so transcript
   * updates flow through the reducer like any other event.
   *
   * The `dispatch` parameter forwards a `ScreenEvent` through the host's
   * normal event path: `screen.reduce(snapshot, nav, event)` is invoked,
   * the resulting snapshot is applied, and a re-render is queued — so
   * the reducer stays pure even though the event source is asynchronous.
   *
   * Best-effort: errors are caught by the host and logged but do not
   * block the page from mounting (the user can always double-tap out).
   */
  onMount?: (
    bridge: import("@evenrealities/even_hub_sdk").EvenAppBridge,
    dispatch: (event: ScreenEvent) => void,
  ) => Promise<void>;
  /**
   * Optional: called once by the host during `unmount`, before
   * `shutDownPageContainer`. Use for cleanup tied to the screen's
   * lifetime — e.g. the Voice screen disables the microphone
   * (`bridge.audioControl(false)`) and stops its STT stream.
   *
   * Best-effort: errors are caught by the host and logged.
   */
  onUnmount?: (
    bridge: import("@evenrealities/even_hub_sdk").EvenAppBridge,
  ) => Promise<void>;
  /**
   * Render the screen into ≤ TOTAL_ROWS lines, each ≤ LINE_WIDTH cols.
   *
   * `ctx.nowMs` is freshly stamped by the host on EVERY render —
   * including clock-only re-renders that don't touch the snapshot.
   * Read the wall clock from `ctx.nowMs`, never from the snapshot.
   * Screens with no time-sensitive UI can ignore `ctx`.
   */
  view(snapshot: Snapshot, nav: NavState, ctx: ViewContext): string[];
  /**
   * Pure reducer over (snapshot, nav, event).
   *
   * Returning `snapshot` in the result replaces the host's stored
   * snapshot before the next render — used by the Voice screen to
   * fold STT-driven `TRANSCRIPT` events into the snapshot without
   * giving the reducer a side-channel.
   */
  reduce(
    snapshot: Snapshot,
    nav: NavState,
    event: ScreenEvent,
  ): ReduceResult<Snapshot>;
  /**
   * Optional: called by the host on mount and then on the
   * `tickIntervalMs` cadence. Must NOT throw — fetch errors should be
   * encoded into the returned snapshot. Returning the same snapshot
   * unchanged is fine and triggers a (cheap) re-render.
   */
  tick?: (snapshot: Snapshot) => Promise<Snapshot>;
  /**
   * Optional: refresh cadence in milliseconds. If both `tick` and
   * `tickIntervalMs > 0` are provided, the host auto-ticks; otherwise
   * the screen is render-once. The independent 1Hz clock tick runs
   * either way.
   */
  tickIntervalMs?: number;
}

/**
 * The host-side router. The implementation lives in `main.ts` (it
 * needs the SDK bridge to mount glasses screens). For WP6 only `home`
 * and `exit` have real handlers; future screens log a placeholder so
 * the user is never stranded on an unmountable screen.
 */
export interface Router {
  /** Identifier of the currently-mounted screen, or `'exit'` when down. */
  current: NavIntent["to"];
  /** Mount the screen for `intent`. */
  navigate(intent: NavIntent): Promise<void>;
}

/** Fresh navigation state (highlight at the top). */
export function initialNav(): NavState {
  return { highlightedIndex: 0 };
}
