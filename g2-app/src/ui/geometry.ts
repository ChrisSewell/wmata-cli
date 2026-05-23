// Pixel geometry — the single source of truth for the G2 page layout.
//
// The G2 panel is 576x288. The HUD is composed of bordered text
// containers (header / body / footer) plus two host-owned overlays (the
// top-right clock and an optional right-hand value column). Historically
// the per-container x/y/width/height lived as private constants inside
// `glasses-host.ts`, and the screens guessed their text budgets in
// CHARACTERS ("~72 cols", "~7 rows"). That guessing is what the
// pixel-accurate refactor removes: this module exposes every container's
// box and the exact INNER pixel dimensions text actually renders into, so
// screens size their content with `@evenrealities/pretext` against a real
// budget instead of an empirical column count.
//
// PURE: no SDK, no pretext, no I/O — just geometry. The pretext-backed
// measurement helpers live in `render.ts`; the runtime value-column
// placement (which needs to measure content) lives in `glasses-host.ts`.

/** Physical panel width in pixels. */
export const SCREEN_WIDTH_PX = 576;

/** Physical panel height in pixels. */
export const SCREEN_HEIGHT_PX = 288;

/**
 * Fixed line height of the firmware LVGL font, in pixels. Per the Even
 * Realities `pretext` measurement library this is a hard constant (27px)
 * — text does not have a selectable size. `maxLines()` divides a
 * container's inner height by this to get the row budget.
 */
export const LINE_HEIGHT_PX = 27;

/**
 * Border + padding applied to the three bordered sections (header, body,
 * footer). The LVGL renderer draws the border INSIDE the container and
 * then insets the text by the padding, so each subtracts from the text
 * area on all four sides (see pretext docs: total inset =
 * paddingLength + borderWidth per side).
 */
export const SECTION_BORDER_PX = 1;
export const SECTION_PADDING_PX = 6;
/** Per-side inset for a bordered section: border + padding. */
export const SECTION_INSET_PX = SECTION_BORDER_PX + SECTION_PADDING_PX;

/**
 * A container's outer box plus the insets that eat into its text area.
 * `border`/`padding` are per-side; the inner text area is
 * `width - 2*(border+padding)` × `height - 2*(border+padding)`.
 */
export interface ContainerBox {
  x: number;
  y: number;
  width: number;
  height: number;
  border: number;
  padding: number;
}

/** Inner text width of a box, in pixels (never negative). */
export function innerWidth(box: ContainerBox): number {
  return Math.max(0, box.width - 2 * (box.border + box.padding));
}

/** Inner text height of a box, in pixels (never negative). */
export function innerHeight(box: ContainerBox): number {
  return Math.max(0, box.height - 2 * (box.border + box.padding));
}

/**
 * How many full text lines fit in a box, at the fixed 27px line height.
 * A partial line that would be clipped (or trigger an LVGL auto
 * scrollbar) does NOT count.
 */
export function maxLines(box: ContainerBox): number {
  return Math.floor(innerHeight(box) / LINE_HEIGHT_PX);
}

// ---------------------------------------------------------------------------
// Section boxes
// ---------------------------------------------------------------------------
//
// Heights are carried over verbatim from the simulator-tuned values in
// glasses-host.ts so this is a behaviour-preserving lift. The header is
// the same height in both layouts; the body shrinks in three-section mode
// to make room for the footer.

/**
 * Header height. 44 (not 40): at 40 the inner area equalled one line
 * height exactly and LVGL drew a spurious auto-scrollbar in the header's
 * top-right; 44 gives the single title line clear room.
 */
export const HEADER_HEIGHT_PX = 44;

/** Header section — full width, top of the panel. Holds the screen title. */
export const HEADER_BOX: ContainerBox = {
  x: 0,
  y: 0,
  width: SCREEN_WIDTH_PX,
  height: HEADER_HEIGHT_PX,
  border: SECTION_BORDER_PX,
  padding: SECTION_PADDING_PX,
};

/** Body section for the default two-section layout (header + body). */
export const TWO_BODY_BOX: ContainerBox = {
  x: 0,
  y: HEADER_HEIGHT_PX,
  width: SCREEN_WIDTH_PX,
  height: SCREEN_HEIGHT_PX - HEADER_HEIGHT_PX, // 244
  border: SECTION_BORDER_PX,
  padding: SECTION_PADDING_PX,
};

/**
 * Body section for the three-section layout (header + body + footer).
 * Sized to hold the densest body state (compact pinned summary on top of
 * the live train list) without clipping.
 */
export const THREE_BODY_HEIGHT_PX = 160;
export const THREE_BODY_BOX: ContainerBox = {
  x: 0,
  y: HEADER_HEIGHT_PX,
  width: SCREEN_WIDTH_PX,
  height: THREE_BODY_HEIGHT_PX,
  border: SECTION_BORDER_PX,
  padding: SECTION_PADDING_PX,
};

/** Footer section (three-section only) — fills the panel below the body. */
export const THREE_FOOTER_BOX: ContainerBox = {
  x: 0,
  y: HEADER_HEIGHT_PX + THREE_BODY_HEIGHT_PX, // 204
  width: SCREEN_WIDTH_PX,
  height: SCREEN_HEIGHT_PX - HEADER_HEIGHT_PX - THREE_BODY_HEIGHT_PX, // 84
  border: SECTION_BORDER_PX,
  padding: SECTION_PADDING_PX,
};

// ---------------------------------------------------------------------------
// Overlays (host-owned, borderless, drawn on top of the sections)
// ---------------------------------------------------------------------------

/**
 * Clock overlay — pinned to the header's top-right, identical on every
 * screen. Borderless with zero padding so its content sits exactly where
 * placed. Height (30) exceeds the 27px line height with margin so no
 * auto-scrollbar appears; it sits inside the 44px header band.
 */
export const CLOCK_BOX: ContainerBox = {
  x: 486,
  y: 6,
  width: 84,
  height: 30,
  border: 0,
  padding: 0,
};

/**
 * Gap (px) the header title must leave before the clock overlay so the
 * two never visually collide (they are separate containers — a long
 * title would otherwise render UNDER the clock).
 */
export const HEADER_CLOCK_GAP_PX = 8;

/**
 * Pixel width available to the header TITLE before it would run into the
 * clock overlay. This is narrower than `innerWidth(HEADER_BOX)` (the hard
 * LVGL wrap bound) because the title shares the band with the clock.
 */
export const HEADER_CONTENT_WIDTH_PX =
  CLOCK_BOX.x - SECTION_INSET_PX - HEADER_CLOCK_GAP_PX;

/**
 * Padding inside the right-hand value-column overlay (borderless). Matches
 * the body padding so the value text's vertical rhythm lines up with the
 * body's left content. The overlay's x/width are computed at render time
 * from the measured width of the value cells (see `glasses-host.ts`),
 * which is the core of the pixel-accurate value column — so they are NOT
 * static constants here.
 */
export const VALUE_COL_PADDING_PX = SECTION_PADDING_PX;

/**
 * Gap (px) between the right edge of the body's left content and the left
 * edge of the value-column overlay, so the two columns never touch.
 */
export const VALUE_COL_GAP_PX = 8;

// ---------------------------------------------------------------------------
// Convenience derived budgets (the values screens actually pass to pretext)
// ---------------------------------------------------------------------------

/** Inner text width shared by all three full-width sections (562px). */
export const SECTION_INNER_WIDTH_PX = innerWidth(HEADER_BOX);

/** Row budget for a two-section body. */
export const TWO_BODY_MAX_LINES = maxLines(TWO_BODY_BOX);

/** Row budget for a three-section body. */
export const THREE_BODY_MAX_LINES = maxLines(THREE_BODY_BOX);

/** Row budget for the three-section footer. */
export const FOOTER_MAX_LINES = maxLines(THREE_FOOTER_BOX);

/** The body box for a given layout mode. */
export function bodyBox(layout: "two-section" | "three-section"): ContainerBox {
  return layout === "three-section" ? THREE_BODY_BOX : TWO_BODY_BOX;
}
