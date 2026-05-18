// First-launch gesture cheat sheet.
//
// A one-shot card mounted on the very first glasses run (when
// `loadSettings().tutorialSeen === false`). Auto-dismisses on any
// touchpad gesture → navigates to Home. The `markTutorialSeen()`
// persistence write happens in `onUnmount` rather than `reduce` so
// the reducer stays pure (per the WP6 contract).
//
// Why a screen at all (vs. an overlay or modal): the SDK only knows
// about pages; the cheapest path that fits inside the existing
// `Screen<S>` + router pattern is a regular screen that always
// navigates away on first input. Mount cost ≈ one page create.
//
// Layout (24 cols × exactly 8 rows — pinned by `tutorial.test.ts`):
//
//   col:   0         1         2
//   col:   0123456789012345678901234
//          WMATA G2 — gestures
//
//          SCROLL    move cursor
//          TAP       select
//          DBL TAP   back to Home
//          VOICE     tap & speak
//                    a station
//          (tap to continue)
//
// Why the trimmed VOICE wording? "speak after TAP on VOICE LOOKUP" is
// the natural English description but it overflows 24 cols by one
// character on each of two lines. "tap & speak / a station" preserves
// the affordance (TAP + speech) without dropping the row count.
//
// PURITY: no SDK imports inside `view` / `reduce`. The only side
// effect is `markTutorialSeen()` inside `onUnmount`.

import { markTutorialSeen } from "../storage/settings";
import { LINE_WIDTH, truncate } from "../ui/render";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";

/**
 * The Tutorial screen carries no per-mount state, so its snapshot is
 * the empty object. We export the type alias for symmetry with the
 * other screens (`HomeSnapshot`, `PredictionsSnapshot`, …).
 */
export type TutorialSnapshot = Record<string, never>;

/** Exact body lines for the cheat sheet. Pinned verbatim by the test. */
export const TUTORIAL_LINES: readonly string[] = [
  "WMATA G2 — gestures",
  "",
  "SCROLL    move cursor",
  "TAP       select",
  "DBL TAP   back to Home",
  "VOICE     tap & speak",
  "          a station",
  "(tap to continue)",
];

/**
 * Build the Tutorial screen. No fetcher, no tick — just a static page
 * that navigates to Home on any input.
 */
export function makeTutorialScreen(): Screen<TutorialSnapshot> {
  return {
    name: "tutorial",
    init: (): TutorialSnapshot => ({}),

    // `ctx` is unused — the tutorial has no time-sensitive UI.
    // Prefixing with `_` quiets `noUnusedParameters`.
    view(_snapshot, _nav, _ctx: ViewContext): string[] {
      // Defensive truncate — `TUTORIAL_LINES` is a constant under
      // LINE_WIDTH, but a future copy-edit could slip an oversize
      // line in. Truncate-at-render keeps the contract honest.
      return TUTORIAL_LINES.map((l) => truncate(l, LINE_WIDTH));
    },

    reduce(
      _snapshot,
      nav,
      event: ScreenEvent,
    ): ReduceResult<TutorialSnapshot> {
      // Any touchpad gesture dismisses the tutorial and routes Home.
      // Voice-flow events (TRANSCRIPT, RESOLVE_RESULT, etc.) are
      // never dispatched against this screen, but we still need to
      // accept them per the total-reducer contract.
      switch (event.type) {
        case "SCROLL_UP":
        case "SCROLL_DOWN":
        case "TAP":
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "home" } };
        default:
          return { nav };
      }
    },

    /**
     * Persist `tutorialSeen = true` exactly once, when the screen
     * unmounts. Doing this in `onUnmount` (rather than in `reduce`)
     * keeps the reducer pure and means the write happens whether the
     * dismissal is user-driven (any gesture) or system-driven
     * (SYSTEM_EXIT). Side-effect safe: `markTutorialSeen` swallows
     * localStorage errors.
     */
    async onUnmount(): Promise<void> {
      markTutorialSeen();
    },
  };
}
