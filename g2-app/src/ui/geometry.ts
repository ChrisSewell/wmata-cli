// Even Realities G2 display geometry — the single source of truth.
//
// The panel is 576×288 px. The firmware LVGL font is PROPORTIONAL and renders
// at a fixed 27px line height; never reason in "character columns" — measure
// pixels with `./measure` (pretext). Snap every container to whole pixels and,
// where it helps, to the official 6×10 OS grid (figma-extract/guidelines/02).

export const WIDTH = 576;
export const HEIGHT = 288;

/** Firmware LVGL line height (fixed). One text row = 27px. */
export const LINE_HEIGHT = 27;

// --- Official OS 6×10 layout grid (86px cols / 12px gutter, 27px rows / 2px gutter) ---
// 6×86 + 5×12 = 576 ; 10×27 + 9×2 = 288.
export const GRID_COLS = 6;
export const GRID_ROWS = 10;
export const COL_W = 86;
export const COL_GUTTER = 12;
export const ROW_H = 27;
export const ROW_GUTTER = 2;

// --- Native container defaults (Figma tokens) ---
/** Default frame corner radius (Figma default = 6, House range 0–10). */
export const RADIUS = 6;
/** Default border width for a meaningful frame. */
export const BORDER_W = 2;

// Official OS insets.
export const LIST_INSET_X = 16;
export const LIST_INSET_Y = 8;
export const CARD_INSET_X = 20;
export const CARD_INSET_Y = 16;

/** HUD legibility margin — keep content off the extreme edge of the field of view. */
export const SAFE = 12;
