// Pure schedule-rule evaluator.
//
// The G2 app's auto-rotate and quiet-hours features both reduce to
// "is the current wall clock + day-of-week inside any user-configured
// window?". This module owns the data model for those windows and a
// pure evaluator that maps `(rules, nowMs) -> { defaultScreen,
// quietHours }`. No SDK imports, no I/O — fully Vitest-friendly.
//
// Storage shape — see `src/storage/settings.ts` for the persistence
// layer. Rules are serialized into the localStorage envelope under
// the new `wmata.g2.schedule` key.

import type { LineCode } from "../wmata";

/**
 * Two-letter day-of-week codes. Compact for storage, easy to type
 * in the companion UI without locale ambiguity.
 */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * Canonical ordering. Indices match `Date#getDay()` after a shift
 * (Sunday=0 in JS, but we keep "sun" at index 6 to put weekdays first
 * for readability — see `weekdayFromDate` for the mapping).
 */
export const WEEKDAYS: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/**
 * Auto-rotate rule: during the window, mount this target screen
 * instead of Home. The user's typical commute fits this pattern:
 *
 *   Mon–Fri 08:00–09:30 → predictions(C01)   // home → office
 *   Mon–Fri 17:00–19:00 → predictions(A01)   // office → home
 *
 * `target.kind === "home"` is the no-op rotation (skip into Home
 * directly, identical to the default boot path). Useful for users
 * who want explicit Home windows around quiet hours.
 */
export interface AutoRotateRule {
  kind: "auto-rotate";
  days: Weekday[];
  /** Window start in 24h "HH:MM" local. Inclusive. */
  startHHMM: string;
  /** Window end in 24h "HH:MM" local. Exclusive. */
  endHHMM: string;
  target:
    | { kind: "predictions"; stationCode: string; lines?: LineCode[] }
    | { kind: "home" };
}

/**
 * Quiet-hours rule: during the window, suppress auto-rotate AND
 * the status-glyph / ACCESS rows on Home (the user doesn't want
 * incident alerts blinking at them while watching a movie or
 * sleeping). The Home screen still renders, but synthetic rows
 * stay hidden.
 *
 * Windows may cross midnight: `endHHMM < startHHMM` means "from
 * startHHMM until endHHMM the next calendar day".
 */
export interface QuietHoursRule {
  kind: "quiet-hours";
  days: Weekday[];
  startHHMM: string;
  endHHMM: string;
}

export type ScheduleRule = AutoRotateRule | QuietHoursRule;

/**
 * Result of evaluating a set of rules against the current clock.
 */
export interface ScheduleEvaluation {
  /**
   * Where to land on initial mount. `null` means "no auto-rotate
   * active right now; use the default (Home)". When auto-rotate
   * AND quiet-hours overlap, quiet wins — quiet-hours suppresses
   * the rotation (no point rotating into Predictions if the
   * synthetic rows are also suppressed).
   */
  autoRotateTarget: AutoRotateRule["target"] | null;
  /** True iff at least one quiet-hours rule matches right now. */
  quietHours: boolean;
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Map a `Date` to a two-letter weekday code. `Date#getDay()` returns
 * 0=Sunday..6=Saturday; we re-index so Monday is the first weekday
 * (matches `WEEKDAYS`).
 */
export function weekdayFromDate(d: Date): Weekday {
  const jsDay = d.getDay(); // 0..6, Sunday-first
  // mon=0, tue=1, ..., sat=5, sun=6
  const idx = jsDay === 0 ? 6 : jsDay - 1;
  return WEEKDAYS[idx]!;
}

/**
 * Parse a "HH:MM" string into minutes-since-midnight, or `null` if
 * malformed. The companion UI's time pickers always emit zero-padded
 * 24h strings, so the malformed-input path is purely defensive.
 */
export function parseHHMM(text: string): number | null {
  if (typeof text !== "string" || text.length !== 5) return null;
  if (text[2] !== ":") return null;
  const hh = parseInt(text.slice(0, 2), 10);
  const mm = parseInt(text.slice(3, 5), 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Format minutes-since-midnight back to "HH:MM". Inverse of parseHHMM. */
export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * True iff `nowMinutes` (minutes-since-midnight) falls within the
 * `[startMin, endMin)` window. The window may wrap past midnight:
 * when `endMin < startMin`, the window spans across midnight and
 * `nowMinutes` is "inside" if it's >= startMin OR < endMin.
 *
 * Edge cases:
 *   - startMin === endMin → empty window (always returns false).
 *   - Any null input → false.
 */
export function isInWindow(
  nowMinutes: number,
  startMin: number | null,
  endMin: number | null,
): boolean {
  if (startMin === null || endMin === null) return false;
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return nowMinutes >= startMin && nowMinutes < endMin;
  }
  // Wraps past midnight.
  return nowMinutes >= startMin || nowMinutes < endMin;
}

/**
 * True iff `rule` is active right now. Combines the day-of-week
 * check (against the rule's `days` list) and the time-of-day check
 * (against the rule's `startHHMM` / `endHHMM` window).
 *
 * Wrap-across-midnight semantics for the day check: when a rule's
 * window crosses midnight (e.g. quiet hours 23:00–07:00) AND
 * `nowMinutes < endMin`, the relevant day-of-week is YESTERDAY's
 * (we're still inside last night's window). The day check uses
 * yesterday's weekday in that case.
 *
 * Exported for the test suite.
 */
export function isRuleActive(
  rule: ScheduleRule,
  nowDate: Date,
): boolean {
  const start = parseHHMM(rule.startHHMM);
  const end = parseHHMM(rule.endHHMM);
  if (start === null || end === null) return false;
  if (start === end) return false;
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  if (!isInWindow(nowMinutes, start, end)) return false;
  // Day check.
  if (start < end) {
    // No wrap — today's weekday matters.
    return rule.days.includes(weekdayFromDate(nowDate));
  }
  // Wraps past midnight. If we're in the "before midnight" half
  // (nowMinutes >= start), today's weekday matters; if we're in the
  // "after midnight" half (nowMinutes < end), yesterday's weekday
  // matters — the window started yesterday.
  const today = weekdayFromDate(nowDate);
  if (nowMinutes >= start) return rule.days.includes(today);
  const yesterday = weekdayFromDate(
    new Date(nowDate.getTime() - 24 * 60 * 60 * 1000),
  );
  return rule.days.includes(yesterday);
}

// ---------------------------------------------------------------------------
// Public evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate the full rule list against the current wall clock.
 *
 *   - Quiet-hours: any matching rule sets `quietHours: true`.
 *   - Auto-rotate: the FIRST matching rule wins (`rules` is treated
 *     as an ordered priority list).
 *   - Interaction: a matching quiet-hours rule SUPPRESSES auto-
 *     rotate, even if an auto-rotate rule also matches. Rationale —
 *     the user explicitly said "don't surface anything", so don't
 *     rotate into Predictions either.
 */
export function evaluateSchedule(
  rules: readonly ScheduleRule[],
  nowMs: number,
): ScheduleEvaluation {
  const now = new Date(nowMs);
  let quietHours = false;
  let autoRotateTarget: AutoRotateRule["target"] | null = null;
  for (const r of rules) {
    if (!isRuleActive(r, now)) continue;
    if (r.kind === "quiet-hours") {
      quietHours = true;
    } else if (r.kind === "auto-rotate") {
      if (autoRotateTarget === null) {
        autoRotateTarget = r.target;
      }
    }
  }
  if (quietHours) {
    // Quiet wins.
    return { autoRotateTarget: null, quietHours: true };
  }
  return { autoRotateTarget, quietHours: false };
}
