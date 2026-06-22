// Screen / router contract for the glasses HUD.
//
// A screen is a pure state machine: `init` builds a snapshot, `view` renders it
// to a declarative LAYOUT descriptor, `reduce` folds gestures into a new
// nav/snapshot. The host (`host/glasses-host.ts`) is the ONLY SDK consumer — it
// translates the descriptor into native containers and owns all pixel geometry,
// measurement, and event plumbing. Screens never touch the SDK, never count
// characters, and never compute pixels — that keeps them fully unit-testable.

import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/** Touchpad gesture after the host normalizes the SDK's event envelopes. */
export type ScreenEvent =
  | { type: "SCROLL_UP" }
  | { type: "SCROLL_DOWN" }
  | { type: "TAP" }
  | { type: "DOUBLE_TAP" };

/** Per-screen cursor state, preserved across data refreshes by the host. */
export interface NavState {
  selectedIndex: number;
}

export function initialNav(): NavState {
  return { selectedIndex: 0 };
}

/** Where the user is heading next; the host maps each to a mount/unmount. */
export type NavIntent =
  | { to: "home" }
  | { to: "predictions"; stationCode: string }
  | { to: "alerts" }
  | { to: "alertDetail"; index: number }
  | { to: "unconfigured" }
  | { to: "exit" };

/** A gesture→action hint shown on entry (bracketed keycap + label). */
export interface Hint {
  glyph: string;
  label: string;
}

/** One row of a `rows` body: primary `left` content + an optional right-anchored `value`. */
export interface Row {
  left: string;
  value?: string;
}

/**
 * The body content. The host renders each kind into the body region:
 *   - `message`: centered-ish bordered text (loading / empty / error / info).
 *   - `rows`: hand-rolled selectable rows (caret focus) + a fixed-x value
 *     overlay column. `reserveValues` sizes that column to the worst case so
 *     it never shifts between renders. Content is sized to fit — no scroll.
 *   - `list`: a native firmware ListContainer (selection border + discrete
 *     scroll). The list is the sole event capturer.
 *   - `paged`: long body text the host paginates; `pageIndex` selects the page.
 */
export type Body =
  | { kind: "message"; lines: string[] }
  | {
      kind: "rows";
      rows: Row[];
      selectedIndex: number;
      /** Show the focus caret (a menu). Set false for a read-only board
       *  (e.g. Predictions) — still uses the value column, just no caret. */
      selectable?: boolean;
    }
  | { kind: "list"; items: string[]; selectedIndex: number }
  | { kind: "paged"; pages: string[]; pageIndex: number };

/** The full declarative screen layout returned by `view`. */
export interface Layout {
  header: {
    title: string;
    /** Optional 1–2 char marker rendered after the host-owned clock (e.g. "*"). */
    marker?: string;
  };
  body: Body;
  /** Gesture hints shown on entry, dismissed on first input. */
  hints?: Hint[];
  /** The image accent (hero screens only): a short token drawn big (e.g. the
   *  soonest ETA). The host renders it to the one ≤288×144 image container. */
  hero?: { numeral: string };
}

/** Per-render context the host supplies. `nowMs` is stamped on EVERY render
 *  (including the 1Hz clock re-render); read the wall clock from here, never
 *  from the snapshot, so a hung fetch can't freeze time-dependent UI. */
export interface ViewContext {
  nowMs: number;
}

export interface ReduceResult<Snapshot = unknown> {
  nav: NavState;
  /** Switch screens. */
  navigate?: NavIntent;
  /** Replace the host's stored snapshot before the next render. */
  snapshot?: Snapshot;
  /** Ask the host to run one immediate tick (the "tap to retry" affordance). */
  requestTick?: boolean;
}

/** Structural page mode, fixed at mount (the SDK commits container structure at
 *  `createStartUpPageContainer`). `text` = header+body-text+value-overlay+hint;
 *  `list` = header+native-list+hint. */
export type ScreenMode = "text" | "list";

export interface Screen<Snapshot> {
  readonly name: NavIntent["to"];
  readonly mode: ScreenMode;
  /**
   * Worst-case value strings for a `rows` screen's right-hand value column.
   * The host sizes the fixed-x value-overlay container to these at mount (the
   * column then never shifts between loading/loaded renders). Omit for screens
   * with no value column.
   */
  readonly valueReserve?: readonly string[];
  /** When true, the host uses the hero layout (image-accent numeral on the
   *  left, body list on the right) and renders `Layout.hero`. */
  readonly hero?: boolean;
  init(): Snapshot;
  view(snapshot: Snapshot, nav: NavState, ctx: ViewContext): Layout;
  reduce(snapshot: Snapshot, nav: NavState, event: ScreenEvent): ReduceResult<Snapshot>;
  /** Side-effect setup tied to the screen's lifetime (rare). */
  onMount?(bridge: EvenAppBridge): Promise<void>;
  onUnmount?(bridge: EvenAppBridge): Promise<void>;
  /** Auto-refresh: called on mount + every `tickIntervalMs`. Must not throw. */
  tick?(snapshot: Snapshot): Promise<Snapshot>;
  tickIntervalMs?: number;
}

/** Host-side router; implemented in `host/main.ts` (it needs the bridge). */
export interface Router {
  current: NavIntent["to"];
  navigate(intent: NavIntent): Promise<void>;
}
