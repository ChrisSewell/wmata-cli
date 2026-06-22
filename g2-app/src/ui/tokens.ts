// Brightness tiers + the canonical OS green. The ONLY hierarchy levers on the
// G2 are BORDER brightness, position, spacing, and Unicode glyphs — never type
// size/weight (one firmware font, one size) and never text brightness (uniform).
//
// Tiers are 16-level greyscale indices (0 = transparent/off … 15 = full). They
// are applied to container BORDERS. Aim for ~3 tiers per screen.

/**
 * Canonical OS green (`OS Color/ER-OS Green`, figma-extract/tokens.md). The
 * panel's only emission colour; vary brightness/alpha, never the hue.
 */
export const OS_GREEN = "#3DFA44";

/**
 * Border-brightness ladder. `PRIMARY` is the one focused/active element per
 * view; structural chrome recedes toward `MUTED`.
 *
 * BRIGHTNESS FLOOR: any border that carries meaning sits at `MUTED` (6) or
 * above — the faintest tiers wash out over bright real-world backdrops.
 * `DIM`/`FAINT` are decoration only.
 */
export const TIER = {
  PRIMARY: 15, // the one thing the eye should land on
  STRONG: 12,
  SECONDARY: 9,
  MUTED: 6, // floor for any meaningful border
  DIM: 4, // decoration that may fade outdoors
  FAINT: 2, // texture only
  OFF: 0, // transparent — the real world shows through
} as const;

export type Tier = (typeof TIER)[keyof typeof TIER];

/** Brightness floor for meaningful borders. */
export const FLOOR: Tier = TIER.MUTED;
