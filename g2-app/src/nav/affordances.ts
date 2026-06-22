// Gesture-hint affordances. The HUD has no pointer, so a screen states what each
// gesture does as bracketed keycaps shown on entry and dismissed on first input.
// Pure strings; the host renders them in the hint container.

import type { Hint } from "../screens/router";

/** Compose hints into one line: "[▲▼] Move   [●] Open   [●●] Back". */
export function hintLine(hints: readonly Hint[]): string {
  return hints.map((h) => `[${h.glyph}] ${h.label}`).join("   ");
}

/** Common hints, so screens share one vocabulary. */
export const HINTS = {
  move: { glyph: "▲▼", label: "Move" } as Hint,
  open: { glyph: "●", label: "Open" } as Hint,
  back: { glyph: "●●", label: "Back" } as Hint,
  exit: { glyph: "●●", label: "Exit" } as Hint,
  page: { glyph: "▲▼", label: "Page" } as Hint,
  retry: { glyph: "●", label: "Retry" } as Hint,
};
