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
//   - `view`   :: (Snapshot, NavState) => string[]
//        Render the screen into ≤ TOTAL_ROWS lines. EACH LINE must be
//        ≤ LINE_WIDTH columns. The host concatenates with `\n` and feeds
//        the result into `bridge.textContainerUpgrade`.
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
 * The contract each screen implements. `Snapshot` is screen-specific
 * data (favorites for Home, predictions for the Predictions screen, etc.)
 * and stays opaque to the router.
 */
export interface Screen<Snapshot> {
  /** Stable identifier for logging / debugging. */
  readonly name: NavIntent["to"];
  /** Build the initial snapshot. Pure: no SDK, no I/O. */
  init(): Snapshot;
  /** Render the screen into ≤ TOTAL_ROWS lines, each ≤ LINE_WIDTH cols. */
  view(snapshot: Snapshot, nav: NavState): string[];
  /** Pure reducer over (snapshot, nav, event). */
  reduce(snapshot: Snapshot, nav: NavState, event: ScreenEvent): ReduceResult;
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
