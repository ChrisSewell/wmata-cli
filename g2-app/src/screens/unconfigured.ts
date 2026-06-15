// Pre-config placeholder screen.
//
// Shown on the glasses the moment the app launches when there's no usable
// configuration yet (no API key, or no favorite stations). It replaces
// the old behaviour where the glasses stayed dark until the user finished
// the phone form and pressed "launch on glasses" (a full page reload).
//
// The app now boots the glasses immediately (see `main.ts`) and mounts
// this card; a boot-time watcher swaps it for the live Home screen the
// instant the API key + a favorite are saved on the phone — no reload,
// no button. So this screen is purely informational: it points the user
// at the phone and otherwise just waits.
//
// PURITY: like every screen, no SDK imports in `view` / `reduce`. The
// only gesture it handles is DOUBLE_TAP → exit, matching the app-wide
// "double-tap backs out" convention so the user is never stranded.

import { LINE_WIDTH, truncate } from "../ui/render";
export { formatClock } from "../ui/format";
import type {
  ReduceResult,
  Screen,
  ScreenEvent,
  ScreenSections,
  ViewContext,
} from "./router";

/** The placeholder carries no per-mount state. */
export type UnconfiguredSnapshot = Record<string, never>;

/** Header title. */
export const UNCONFIGURED_TITLE = "WMATA Transit";

/**
 * Body copy. Directs the user to the phone companion to enter the two
 * required variables (API key + a favorite). The final line reassures
 * them the glasses switch over on their own once setup is done — so they
 * don't go hunting for a "launch" affordance on the HUD.
 *
 * Kept short and within `LINE_WIDTH`; `view` truncates defensively.
 */
export const UNCONFIGURED_BODY_LINES: readonly string[] = [
  "",
  "Open the Even Realities phone app",
  "to finish setup:",
  "",
  "  1. Enter your WMATA API key",
  "  2. Add a favorite station",
  "",
  "Your glasses start automatically.",
];

/** Render the header — title only; the host draws the clock top-right. */
export function renderHeader(): string {
  return truncate(UNCONFIGURED_TITLE, 50);
}

/**
 * Build the unconfigured placeholder screen. Static (no tick); any
 * double-tap exits the app.
 */
export function makeUnconfiguredScreen(): Screen<UnconfiguredSnapshot> {
  return {
    name: "unconfigured",
    init: (): UnconfiguredSnapshot => ({}),

    view(_snapshot, _nav, _ctx: ViewContext): ScreenSections {
      return {
        header: [renderHeader()],
        body: UNCONFIGURED_BODY_LINES.map((l) => truncate(l, LINE_WIDTH)),
      };
    },

    reduce(
      _snapshot,
      nav,
      event: ScreenEvent,
    ): ReduceResult<UnconfiguredSnapshot> {
      // Double-tap backs out of the app (the host turns the resulting
      // `exit` intent into `shutDownPageContainer`). Every other gesture
      // is a no-op — there's nothing to navigate to until setup is done,
      // and the watcher handles the hand-off to Home on its own.
      switch (event.type) {
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "exit" } };
        default:
          return { nav };
      }
    },
  };
}
