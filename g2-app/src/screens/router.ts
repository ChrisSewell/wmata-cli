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
 */
export type ScreenEvent =
  | { type: "SCROLL_UP" }
  | { type: "SCROLL_DOWN" }
  | { type: "TAP" }
  | { type: "DOUBLE_TAP" };

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
  | { to: "exit" };

/** Result of a reducer step. */
export interface ReduceResult {
  nav: NavState;
  navigate?: NavIntent;
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
   * Render the screen into ≤ TOTAL_ROWS lines, each ≤ LINE_WIDTH cols.
   *
   * `ctx.nowMs` is freshly stamped by the host on EVERY render —
   * including clock-only re-renders that don't touch the snapshot.
   * Read the wall clock from `ctx.nowMs`, never from the snapshot.
   * Screens with no time-sensitive UI can ignore `ctx`.
   */
  view(snapshot: Snapshot, nav: NavState, ctx: ViewContext): string[];
  /** Pure reducer over (snapshot, nav, event). */
  reduce(snapshot: Snapshot, nav: NavState, event: ScreenEvent): ReduceResult;
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
