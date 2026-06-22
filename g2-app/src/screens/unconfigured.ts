// First-run / not-configured placeholder shown on the glasses until an API key
// and a favorite are saved on the phone. The boot watcher swaps it for Home the
// instant config completes (no reload). Root screen: double-press exits.

import { HINTS } from "../nav/affordances";
import type { Screen } from "./router";

export function makeUnconfiguredScreen(): Screen<null> {
  return {
    name: "unconfigured",
    mode: "text",
    init: () => null,
    view: () => ({
      header: { title: "WMATA Transit" },
      body: {
        kind: "message",
        lines: [
          "Finish setup on your phone.",
          "",
          "Add your WMATA API key and a",
          "favorite station in the Even app.",
        ],
      },
      hints: [HINTS.exit],
    }),
    reduce: (_snapshot, nav, event) =>
      event.type === "DOUBLE_TAP" ? { nav, navigate: { to: "exit" } } : { nav },
  };
}
