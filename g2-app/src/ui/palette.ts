// Canonical Even Realities G2 design-language palette + brightness tiers.
//
// The G2 micro-LED panel emits a single colour (green); the host renders
// in a 16-level greyscale (border-colour index 0..15). Visual hierarchy
// on this hardware is expressed through BRIGHTNESS, never hue — there is
// no additive blend and no second colour to reach for. This module is the
// single source of truth for both:
//
//   1. The canonical OS green token (`OS_GREEN`). The panel renders this
//      as its native emission colour; we vary BRIGHTNESS (alpha / the
//      greyscale index below), never the hue. Cite: figma-extract/
//      tokens.md → `OS Color/ER-OS Green` = #3DFA44.
//
//   2. The brightness TIER ladder (`TIER`). Official guidance is ~3 tiers
//      per screen mapped to the OS Full / Half / Low / No brightness
//      steps, with a MUTED floor at index 6 (anything dimmer is unreadable
//      on-glass). We use these for container border-colour indices so the
//      one focused/active element reads brighter than its frame, instead
//      of the previous flat single index where header / body / footer all
//      sat at one weight.
//
// Keeping these as named constants (rather than magic numbers scattered
// across the host) makes the hierarchy auditable and gives any future
// accent a token to anchor on.

/**
 * Canonical OS green. The G2 panel's only emission colour; brightness is
 * varied via alpha / the greyscale index, NEVER the hue (there is no
 * additive blend). Sourced from the official Even Realities design tokens
 * (`OS Color/ER-OS Green`). Use this constant for any future on-glass
 * accent so the hue stays exact.
 */
export const OS_GREEN = "#3DFA44";

/**
 * Border / content brightness tiers, expressed as 16-level greyscale
 * indices (0 = off … 15 = full brightness). Maps to the OS brightness
 * steps:
 *
 *   PRIMARY   (15) → Full  — the one focused / active element per view.
 *   STRONG    (12) → Half  — secondary emphasis (e.g. an active body).
 *   SECONDARY  (9) → Low   — structural chrome that should recede (header).
 *   MUTED      (6) → No*   — the dimmest still-legible weight (footer /
 *                            decorative frames). This is the FLOOR: never
 *                            render a readable element below 6.
 *
 * Aim for ~3 tiers on screen at once so the hierarchy stays legible.
 */
export const TIER = {
  /** Full brightness — the single focused / active element. */
  PRIMARY: 15,
  /** Half brightness — secondary emphasis (the live body frame). */
  STRONG: 12,
  /** Low brightness — structural chrome that should recede (header). */
  SECONDARY: 9,
  /** Lowest still-legible weight — the floor (footer / quiet frames). */
  MUTED: 6,
} as const;

export type TierName = keyof typeof TIER;
