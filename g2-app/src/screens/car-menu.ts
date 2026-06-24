// Car menu — the per-car action sheet reached by pressing a train on the
// Predictions board. Two choices: toggle tracking, or view details. The
// `tracked` flag is injected by the wiring (read from storage at build time);
// the actual storage write happens in the wiring's `trackToggle` handler so
// this screen stays pure.

import { lineGlyph } from "../ui/format";
import { HINTS } from "../nav/affordances";
import type { TrackedCar } from "../data/domain/tracked";
import type { Layout, NavState, ReduceResult, Screen } from "./router";

function clamp(idx: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(idx, count - 1));
}

export function makeCarMenuScreen(car: TrackedCar, tracked: boolean): Screen<null> {
  const glyph = lineGlyph(car.line);
  const title = `${glyph === "--" ? "" : glyph + " "}${car.destinationName || "Train"}`.trim();
  return {
    name: "carMenu",
    mode: "list",
    init: () => null,
    view(_s: null, nav: NavState): Layout {
      const items = [tracked ? "Untrack this car" : "Track this car", "View details"];
      return {
        header: { title },
        body: { kind: "list", items, selectedIndex: clamp(nav.selectedIndex, items.length) },
        hints: [HINTS.open, HINTS.back],
      };
    },
    reduce(_s: null, nav: NavState, event): ReduceResult<null> {
      const idx = clamp(nav.selectedIndex, 2);
      switch (event.type) {
        case "TAP":
          return idx === 0
            ? { nav: { selectedIndex: idx }, navigate: { to: "trackToggle", car } }
            : { nav: { selectedIndex: idx }, navigate: { to: "carDetails", car } };
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "predictions", stationCode: car.stationCode, stationName: car.stationName } };
        case "SCROLL_UP":
          return { nav: { selectedIndex: clamp(idx - 1, 2) } };
        case "SCROLL_DOWN":
          return { nav: { selectedIndex: clamp(idx + 1, 2) } };
      }
    },
  };
}
