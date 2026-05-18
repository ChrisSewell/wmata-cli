// Unit tests for the pure helpers used by WP-H's settings cards.
//
// These live in `settings-helpers.ts` (rather than the parent
// `settings.ts`) specifically so they're testable without pulling in
// `./settings.css` — Vitest can't resolve CSS imports without a
// configured handler, and the WMATA G2 vite config doesn't have one.

import { describe, expect, it } from 'vitest';
import type {
  AutoRotateRule,
  QuietHoursRule,
  ScheduleRule,
} from '../schedule/rules';
import {
  MAX_SCHEDULE_RULES,
  changeRuleKind,
  defaultAutoRotateRule,
  toggleDay,
  validateScheduleRule,
} from './settings-helpers';

// ---------------------------------------------------------------------------
// MAX_SCHEDULE_RULES
// ---------------------------------------------------------------------------

describe('MAX_SCHEDULE_RULES', () => {
  it('exposes a positive cap', () => {
    expect(MAX_SCHEDULE_RULES).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// defaultAutoRotateRule
// ---------------------------------------------------------------------------

describe('defaultAutoRotateRule', () => {
  it('returns a Mon–Fri 08:00–09:00 auto-rotate to Home', () => {
    const rule = defaultAutoRotateRule();
    expect(rule.kind).toBe('auto-rotate');
    expect(rule.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    expect(rule.startHHMM).toBe('08:00');
    expect(rule.endHHMM).toBe('09:00');
    expect(rule.target).toEqual({ kind: 'home' });
  });

  it('is valid by construction (passes validateScheduleRule)', () => {
    expect(typeof validateScheduleRule(defaultAutoRotateRule())).not.toBe(
      'string',
    );
  });

  it('returns a fresh object each call (no shared reference)', () => {
    const a = defaultAutoRotateRule();
    const b = defaultAutoRotateRule();
    expect(a).not.toBe(b);
    expect(a.days).not.toBe(b.days);
  });
});

// ---------------------------------------------------------------------------
// toggleDay
// ---------------------------------------------------------------------------

describe('toggleDay', () => {
  it('adds a day not currently in the list', () => {
    expect(toggleDay(['mon', 'fri'], 'wed')).toEqual(['mon', 'wed', 'fri']);
  });

  it('removes a day already in the list', () => {
    expect(toggleDay(['mon', 'wed', 'fri'], 'wed')).toEqual(['mon', 'fri']);
  });

  it('preserves the canonical mon-first WEEKDAYS ordering on add', () => {
    // Add in random order; result must always sort to the WEEKDAYS order.
    expect(toggleDay(['fri'], 'mon')).toEqual(['mon', 'fri']);
    expect(toggleDay(['sun'], 'tue')).toEqual(['tue', 'sun']);
  });

  it('returns an empty array when toggling off the only entry', () => {
    expect(toggleDay(['mon'], 'mon')).toEqual([]);
  });

  it("doesn't mutate the input list", () => {
    const input = ['mon', 'wed', 'fri'] as const;
    toggleDay(input, 'tue');
    expect(input).toEqual(['mon', 'wed', 'fri']);
  });
});

// ---------------------------------------------------------------------------
// changeRuleKind
// ---------------------------------------------------------------------------

describe('changeRuleKind', () => {
  const autoRotate: AutoRotateRule = {
    kind: 'auto-rotate',
    days: ['mon', 'fri'],
    startHHMM: '08:00',
    endHHMM: '09:00',
    target: { kind: 'predictions', stationCode: 'C01' },
  };
  const quiet: QuietHoursRule = {
    kind: 'quiet-hours',
    days: ['sat', 'sun'],
    startHHMM: '23:00',
    endHHMM: '07:00',
  };

  it('returns the same reference when the kind is unchanged', () => {
    expect(changeRuleKind(autoRotate, 'auto-rotate')).toBe(autoRotate);
    expect(changeRuleKind(quiet, 'quiet-hours')).toBe(quiet);
  });

  it('converts auto-rotate → quiet-hours preserving days + times', () => {
    const out = changeRuleKind(autoRotate, 'quiet-hours');
    expect(out.kind).toBe('quiet-hours');
    expect(out.days).toEqual(autoRotate.days);
    expect(out.startHHMM).toBe(autoRotate.startHHMM);
    expect(out.endHHMM).toBe(autoRotate.endHHMM);
  });

  it('converts quiet-hours → auto-rotate with a Home target by default', () => {
    const out = changeRuleKind(quiet, 'auto-rotate');
    expect(out.kind).toBe('auto-rotate');
    expect(out.days).toEqual(quiet.days);
    if (out.kind === 'auto-rotate') {
      expect(out.target).toEqual({ kind: 'home' });
    }
  });
});

// ---------------------------------------------------------------------------
// validateScheduleRule
// ---------------------------------------------------------------------------

describe('validateScheduleRule', () => {
  function autoRotate(over: Partial<AutoRotateRule> = {}): AutoRotateRule {
    return {
      kind: 'auto-rotate',
      days: ['mon'],
      startHHMM: '08:00',
      endHHMM: '09:00',
      target: { kind: 'home' },
      ...over,
    };
  }
  function quiet(over: Partial<QuietHoursRule> = {}): QuietHoursRule {
    return {
      kind: 'quiet-hours',
      days: ['sat'],
      startHHMM: '23:00',
      endHHMM: '07:00',
      ...over,
    };
  }

  it('returns the canonical rule for a valid auto-rotate', () => {
    const r = autoRotate();
    expect(validateScheduleRule(r)).toBe(r);
  });

  it('returns the canonical rule for a valid quiet-hours', () => {
    const r = quiet();
    expect(validateScheduleRule(r)).toBe(r);
  });

  it('returns an error message when days is empty', () => {
    const r = autoRotate({ days: [] });
    const out = validateScheduleRule(r);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/day/i);
  });

  it('returns an error message when start time is malformed', () => {
    const r = autoRotate({ startHHMM: 'bad' });
    const out = validateScheduleRule(r);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/time/i);
  });

  it('returns an error message when end time is malformed', () => {
    const r = quiet({ endHHMM: '25:99' });
    const out = validateScheduleRule(r);
    expect(typeof out).toBe('string');
  });

  it('returns an error when start === end (empty window)', () => {
    const r = autoRotate({ startHHMM: '08:00', endHHMM: '08:00' });
    const out = validateScheduleRule(r);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/differ/i);
  });

  it('returns an error for auto-rotate predictions target without a station code', () => {
    const r: ScheduleRule = autoRotate({
      target: { kind: 'predictions', stationCode: '' },
    });
    const out = validateScheduleRule(r);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/station/i);
  });

  it('accepts auto-rotate to Home (no station code required)', () => {
    const r = autoRotate({ target: { kind: 'home' } });
    expect(validateScheduleRule(r)).toBe(r);
  });

  it('accepts a wrap-past-midnight quiet-hours window', () => {
    const r = quiet({ startHHMM: '23:00', endHHMM: '07:00' });
    expect(validateScheduleRule(r)).toBe(r);
  });
});
