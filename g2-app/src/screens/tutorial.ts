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
// Layout (exactly 8 rows — pinned by `tutorial.test.ts`). Terminal-
// style help with a single aligned description column (descriptions
// start at col 10 so the gesture labels read as a tidy table):
//
//          WMATA G2 — gestures                      2:32p
//
//          SCROLL    move cursor
//          TAP       select
//          DBL TAP   back to Home
//          VOICE     tap, then speak a station
//
//          (tap to continue)
//
// The wide grid (SAFE_TEXT_WIDTH = 58) fits the full VOICE
// affordance ("tap, then speak a station") on one line, so the old
// two-line "tap & speak / a station" wrap is gone; the reclaimed row
// becomes a blank spacer above the continue cue for vertical balance.
// The row COUNT is unchanged (7 body lines), keeping the 8-line lock.
//
// PURITY: no SDK imports inside `view` / `reduce`. The only side
// effect is `markTutorialSeen()` inside `onUnmount`.

import { markTutorialSeen } from "../storage/settings";
import { truncate } from "../ui/render";
import { HEADER_CONTENT_WIDTH_PX, SECTION_INNER_WIDTH_PX } from "../ui/geometry";
// `formatClock` now lives in the shared field-formatter module and is
// rendered by the host into its own top-right clock container. Re-export
// it here so existing imports (`import { formatClock } from "./tutorial"`)
// keep resolving after the screen stopped embedding the clock.
export { formatClock } from "../ui/format";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ScreenSections,
  ViewContext,
} from "./router";

/**
 * The Tutorial screen carries no per-mount state, so its snapshot is
 * the empty object. We export the type alias for symmetry with the
 * other screens (`HomeSnapshot`, `PredictionsSnapshot`, …).
 */
export type TutorialSnapshot = Record<string, never>;

/** Title for the tutorial header. */
export const TUTORIAL_TITLE = "WMATA G2 — gestures";

/**
 * Body lines for the cheat sheet (header rendered separately).
 *
 * Description column is aligned at col 10 across all four gestures so
 * the labels form a clean table. The VOICE affordance fits on one
 * line on the wide grid; the freed row is a blank spacer above the
 * continue cue. Exactly 7 lines — the view + test lock the 8-line
 * (header + body) total.
 */
export const TUTORIAL_BODY_LINES: readonly string[] = [
  "",
  "SCROLL    move cursor",
  "TAP       select",
  "DBL TAP   back to Home",
  "VOICE     tap, then speak a station",
  "",
  "(tap to continue)",
];

/**
 * Render the tutorial header — the title only, left-aligned.
 *
 * The wall clock is NO LONGER part of the header string: the host
 * renders it into a dedicated top-right clock container on every screen.
 * The title is truncated to 50 columns so it can never collide with that
 * clock cell (which starts at x≈486px ≈ column 50).
 */
export function renderHeader(): string {
  return truncate(TUTORIAL_TITLE, HEADER_CONTENT_WIDTH_PX);
}

/**
 * Build the Tutorial screen. No fetcher, no tick — just a static page
 * that navigates to Home on any input.
 */
export function makeTutorialScreen(): Screen<TutorialSnapshot> {
  return {
    name: "tutorial",
    init: (): TutorialSnapshot => ({}),

    view(_snapshot, _nav, _ctx: ViewContext): ScreenSections {
      return {
        header: [renderHeader()],
        // Defensive truncate — `TUTORIAL_BODY_LINES` are short constants,
        // but a future copy-edit could slip an oversize line in.
        // Truncate-at-render keeps the contract honest.
        body: TUTORIAL_BODY_LINES.map((l) => truncate(l, SECTION_INNER_WIDTH_PX)),
      };
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
