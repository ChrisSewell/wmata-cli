// Pure helpers for the WP-H companion settings cards.
//
// Lifted out of `screens/settings.ts` so they can be unit-tested
// independently of the DOM (the parent module pulls in
// `./settings.css`, which Vitest can't resolve without a CSS handler).
// All functions are pure — no DOM access, no localStorage, no side
// effects.

import {
  WEEKDAYS,
  parseHHMM,
  type AutoRotateRule,
  type QuietHoursRule,
  type ScheduleRule,
  type Weekday,
} from '../schedule/rules';

/** Soft cap on schedule rules (exported for tests + UI). */
export const MAX_SCHEDULE_RULES = 6;

/**
 * Validate a `ScheduleRule` form-state value before persisting.
 * Returns the canonicalised rule on success, or a `string` error
 * message on failure (e.g. `start === end`).
 */
export function validateScheduleRule(
  rule: ScheduleRule,
): ScheduleRule | string {
  if (rule.days.length === 0) return 'Select at least one day.';
  const startMin = parseHHMM(rule.startHHMM);
  const endMin = parseHHMM(rule.endHHMM);
  if (startMin === null || endMin === null) return 'Invalid time.';
  if (startMin === endMin) return 'Start and end must differ.';
  if (rule.kind === 'auto-rotate') {
    if (
      rule.target.kind === 'predictions' &&
      rule.target.stationCode.length === 0
    ) {
      return 'Pick a station for predictions.';
    }
  }
  return rule;
}

/**
 * Build a fresh default `AutoRotateRule` — Mon–Fri 08:00–09:00,
 * target Home. The user picks a station via the target dropdown
 * after the rule is added.
 */
export function defaultAutoRotateRule(): AutoRotateRule {
  return {
    kind: 'auto-rotate',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    startHHMM: '08:00',
    endHHMM: '09:00',
    target: { kind: 'home' },
  };
}

/**
 * Toggle membership of `wd` in `days`. Preserves the canonical
 * `WEEKDAYS` ordering of survivors so the persisted rule always
 * round-trips through the storage validator without re-sorting.
 */
export function toggleDay(
  days: readonly Weekday[],
  wd: Weekday,
): Weekday[] {
  if (days.includes(wd)) return days.filter((d) => d !== wd);
  const next = [...days, wd];
  return WEEKDAYS.filter((w) => next.includes(w));
}

/**
 * Switch a rule's kind while preserving the day-of-week + time
 * fields. The auto-rotate target collapses to `{kind: 'home'}` on
 * a quiet→auto-rotate switch — the user has to re-pick the
 * station explicitly.
 */
export function changeRuleKind(
  rule: ScheduleRule,
  nextKind: ScheduleRule['kind'],
): ScheduleRule {
  if (rule.kind === nextKind) return rule;
  if (nextKind === 'auto-rotate') {
    const out: AutoRotateRule = {
      kind: 'auto-rotate',
      days: rule.days,
      startHHMM: rule.startHHMM,
      endHHMM: rule.endHHMM,
      target: { kind: 'home' },
    };
    return out;
  }
  const out: QuietHoursRule = {
    kind: 'quiet-hours',
    days: rule.days,
    startHHMM: rule.startHHMM,
    endHHMM: rule.endHHMM,
  };
  return out;
}
