// Pure content composition for a text-mode page: turn a screen's `Layout` +
// fixed column geometry into the exact strings each native container should
// hold. This is where the cardinal-sin fixes live — measured truncation (never
// character counts), the fixed-x value column, caret focus, the hint line. No
// SDK here, so it's fully unit-testable.

import {
  pageRects,
  computeValueColumn,
  BODY_INSET,
  HEADER_INSET,
  CLOCK_RESERVE_PX,
  type Rect,
} from "../ui/layout";
import { truncateToPx } from "../ui/measure";
import { formatClock } from "../ui/format";
import { hintLine } from "../nav/affordances";
import type { Layout } from "../screens/router";

/** Selected / unselected row carets. `▶` is in the firmware affordance set
 *  (◀▶); the unselected slot is blank so the caret reads as the one focus cue. */
const CARET_ON = "▶ ";
const CARET_OFF = "  ";

export interface ColumnGeom {
  /** Left x of the value-overlay container, or null when the screen has no value column. */
  valueX: number | null;
  /** Pixel budget for left/body content before it would collide with the value column. */
  leftW: number;
}

/** Compute the value column + left budget for a text-mode screen — fixed at
 *  mount from the screen's worst-case `valueReserve`. `bodyRect` defaults to the
 *  standard body; hero screens pass their narrower body. */
export function columnGeom(valueReserve: readonly string[] | undefined, bodyRect?: Rect): ColumnGeom {
  const body = bodyRect ?? pageRects().body;
  const innerLeft = body.x + BODY_INSET;
  const innerRight = body.x + body.w - BODY_INSET;
  if (!valueReserve || valueReserve.length === 0) {
    return { valueX: null, leftW: innerRight - innerLeft };
  }
  const col = computeValueColumn(innerLeft, innerRight, valueReserve);
  return { valueX: col.valueX, leftW: col.leftW };
}

export interface TextRender {
  title: string;
  clock: string;
  bodyContent: string;
  /** "" when the screen has no value column or the body isn't rows. */
  valueContent: string;
  hint: string;
  /** Hero accent token to draw big (hero screens only); "" otherwise. */
  numeral: string;
}

/** Resolve a Layout into per-container content for the given column geometry. */
export function composeText(
  layout: Layout,
  geom: ColumnGeom,
  nowMs: number,
  hintsVisible: boolean,
): TextRender {
  const { header } = pageRects();
  const titleBudget = header.w - HEADER_INSET * 2 - CLOCK_RESERVE_PX - 8;
  const title = truncateToPx(layout.header.title, Math.max(1, titleBudget));
  const marker = layout.header.marker;
  const clock = formatClock(nowMs) + (marker ? ` ${marker}` : "");
  const hint = hintsVisible && layout.hints && layout.hints.length ? hintLine(layout.hints) : "";

  const leftW = geom.leftW;
  let bodyContent = "";
  let valueContent = "";
  const b = layout.body;

  if (b.kind === "message") {
    bodyContent = b.lines.map((l) => truncateToPx(l, leftW)).join("\n");
  } else if (b.kind === "rows") {
    const selectable = b.selectable !== false;
    const lefts: string[] = [];
    const vals: string[] = [];
    b.rows.forEach((r, i) => {
      const prefix = selectable ? (i === b.selectedIndex ? CARET_ON : CARET_OFF) : "";
      lefts.push(truncateToPx(prefix + r.left, leftW));
      vals.push(r.value ?? "");
    });
    bodyContent = lefts.join("\n");
    valueContent = vals.join("\n");
  } else if (b.kind === "paged") {
    // Pages are pre-split (pure) by the screen; the host just shows one.
    const idx = Math.max(0, Math.min(b.pageIndex, b.pages.length - 1));
    bodyContent = b.pages[idx] ?? "";
  }
  // 'list' bodies are handled by the list-mode host path, not here.

  return { title, clock, bodyContent, valueContent, hint, numeral: layout.hero?.numeral ?? "" };
}
