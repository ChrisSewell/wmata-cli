// Unit tests for the schedule-rule evaluator.

import { describe, expect, it } from "vitest";
import {
  evaluateSchedule,
  formatHHMM,
  isInWindow,
  isRuleActive,
  parseHHMM,
  weekdayFromDate,
  type AutoRotateRule,
  type QuietHoursRule,
  type ScheduleRule,
} from "./rules";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("weekdayFromDate", () => {
  // 2026-05-18 is a Monday.
  it("maps a Monday to 'mon'", () => {
    expect(weekdayFromDate(new Date(2026, 4, 18))).toBe("mon");
  });
  it("maps a Tuesday to 'tue'", () => {
    expect(weekdayFromDate(new Date(2026, 4, 19))).toBe("tue");
  });
  it("maps a Saturday to 'sat'", () => {
    expect(weekdayFromDate(new Date(2026, 4, 23))).toBe("sat");
  });
  it("maps a Sunday to 'sun' (the only Date.getDay()=0 case)", () => {
    expect(weekdayFromDate(new Date(2026, 4, 24))).toBe("sun");
  });
});

describe("parseHHMM", () => {
  it("parses a canonical time", () => {
    expect(parseHHMM("09:30")).toBe(9 * 60 + 30);
  });
  it("parses midnight", () => {
    expect(parseHHMM("00:00")).toBe(0);
  });
  it("parses 23:59", () => {
    expect(parseHHMM("23:59")).toBe(23 * 60 + 59);
  });
  it("rejects malformed inputs", () => {
    expect(parseHHMM("")).toBeNull();
    expect(parseHHMM("9:30")).toBeNull();
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("09:60")).toBeNull();
    expect(parseHHMM("ab:cd")).toBeNull();
  });
});

describe("formatHHMM", () => {
  it("inverts parseHHMM", () => {
    expect(formatHHMM(parseHHMM("09:30")!)).toBe("09:30");
    expect(formatHHMM(parseHHMM("00:05")!)).toBe("00:05");
    expect(formatHHMM(parseHHMM("23:59")!)).toBe("23:59");
  });
});

describe("isInWindow", () => {
  it("returns true inside a same-day window", () => {
    expect(isInWindow(9 * 60, 8 * 60, 9 * 60 + 30)).toBe(true);
  });
  it("treats the start minute as inclusive", () => {
    expect(isInWindow(8 * 60, 8 * 60, 9 * 60)).toBe(true);
  });
  it("treats the end minute as exclusive", () => {
    expect(isInWindow(9 * 60, 8 * 60, 9 * 60)).toBe(false);
  });
  it("returns true on either side of midnight for a wrapping window", () => {
    // 23:00–07:00.
    expect(isInWindow(23 * 60 + 30, 23 * 60, 7 * 60)).toBe(true);
    expect(isInWindow(3 * 60, 23 * 60, 7 * 60)).toBe(true);
  });
  it("returns false outside the wrap window", () => {
    expect(isInWindow(12 * 60, 23 * 60, 7 * 60)).toBe(false);
  });
  it("returns false for empty windows", () => {
    expect(isInWindow(9 * 60, 9 * 60, 9 * 60)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRuleActive
// ---------------------------------------------------------------------------

const monday = (h: number, m: number = 0): Date =>
  new Date(2026, 4, 18, h, m, 0);
const friday = (h: number, m: number = 0): Date =>
  new Date(2026, 4, 22, h, m, 0);
const saturday = (h: number, m: number = 0): Date =>
  new Date(2026, 4, 23, h, m, 0);

const morningCommute = (over: Partial<AutoRotateRule> = {}): AutoRotateRule => ({
  kind: "auto-rotate",
  days: ["mon", "tue", "wed", "thu", "fri"],
  startHHMM: "08:00",
  endHHMM: "09:30",
  target: { kind: "predictions", stationCode: "C01" },
  ...over,
});

const overnightQuiet = (
  over: Partial<QuietHoursRule> = {},
): QuietHoursRule => ({
  kind: "quiet-hours",
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  startHHMM: "23:00",
  endHHMM: "07:00",
  ...over,
});

describe("isRuleActive: auto-rotate", () => {
  it("matches mid-window on a listed day", () => {
    expect(isRuleActive(morningCommute(), monday(8, 30))).toBe(true);
  });
  it("doesn't match outside the time window", () => {
    expect(isRuleActive(morningCommute(), monday(10, 0))).toBe(false);
  });
  it("doesn't match on an unlisted day", () => {
    expect(isRuleActive(morningCommute(), saturday(8, 30))).toBe(false);
  });
  it("respects the inclusive start", () => {
    expect(isRuleActive(morningCommute(), monday(8, 0))).toBe(true);
  });
  it("respects the exclusive end", () => {
    expect(isRuleActive(morningCommute(), monday(9, 30))).toBe(false);
  });
});

describe("isRuleActive: quiet-hours (wraps midnight)", () => {
  it("matches an evening time on a listed day", () => {
    // Monday 23:30 — inside Monday's 23:00–07:00 window.
    expect(isRuleActive(overnightQuiet(), monday(23, 30))).toBe(true);
  });

  it("matches an early-morning time and credits the PREVIOUS day", () => {
    // Tuesday 03:00 — inside Monday's window (started at 23:00 Mon).
    const ruleOnlyMonday = overnightQuiet({ days: ["mon"] });
    const tuesday3am = new Date(2026, 4, 19, 3, 0);
    expect(isRuleActive(ruleOnlyMonday, tuesday3am)).toBe(true);
  });

  it("doesn't match when the wrap window started on an unlisted day", () => {
    // Saturday 03:00. The active wrap window started Friday at 23:00.
    // If the rule is only-monday, Saturday morning is OUT.
    const ruleOnlyMonday = overnightQuiet({ days: ["mon"] });
    expect(isRuleActive(ruleOnlyMonday, saturday(3, 0))).toBe(false);
  });

  it("doesn't match a daytime time on the same day", () => {
    expect(isRuleActive(overnightQuiet(), friday(15, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateSchedule
// ---------------------------------------------------------------------------

describe("evaluateSchedule", () => {
  function evalAt(rules: ScheduleRule[], at: Date): ReturnType<typeof evaluateSchedule> {
    return evaluateSchedule(rules, at.getTime());
  }

  it("returns no rotation + no quiet for an empty rule set", () => {
    const out = evalAt([], monday(8, 30));
    expect(out.autoRotateTarget).toBeNull();
    expect(out.quietHours).toBe(false);
  });

  it("returns the matching auto-rotate target during its window", () => {
    const out = evalAt([morningCommute()], monday(8, 30));
    expect(out.autoRotateTarget).toEqual({
      kind: "predictions",
      stationCode: "C01",
    });
    expect(out.quietHours).toBe(false);
  });

  it("returns null target outside the window", () => {
    const out = evalAt([morningCommute()], monday(11, 0));
    expect(out.autoRotateTarget).toBeNull();
  });

  it("first-match-wins for overlapping auto-rotate rules", () => {
    const ruleA = morningCommute({
      target: { kind: "predictions", stationCode: "A01" },
    });
    const ruleB = morningCommute({
      target: { kind: "predictions", stationCode: "B01" },
    });
    const out = evalAt([ruleA, ruleB], monday(8, 30));
    expect(out.autoRotateTarget).toEqual({
      kind: "predictions",
      stationCode: "A01",
    });
  });

  it("quiet-hours suppresses an otherwise-matching auto-rotate", () => {
    // Overlap: quiet Mon 06:00–10:00 AND auto-rotate Mon 08:00–09:30.
    // At 08:30 Mon, quiet wins.
    const quiet: QuietHoursRule = {
      kind: "quiet-hours",
      days: ["mon"],
      startHHMM: "06:00",
      endHHMM: "10:00",
    };
    const out = evalAt([quiet, morningCommute()], monday(8, 30));
    expect(out.quietHours).toBe(true);
    expect(out.autoRotateTarget).toBeNull();
  });

  it("multiple quiet-hours rules all contribute to the flag", () => {
    const q1: QuietHoursRule = {
      kind: "quiet-hours",
      days: ["mon"],
      startHHMM: "06:00",
      endHHMM: "07:00",
    };
    const q2: QuietHoursRule = {
      kind: "quiet-hours",
      days: ["mon"],
      startHHMM: "06:30",
      endHHMM: "07:30",
    };
    // Inside q1 only:
    expect(evalAt([q1, q2], monday(6, 10)).quietHours).toBe(true);
    // Inside the union:
    expect(evalAt([q1, q2], monday(6, 45)).quietHours).toBe(true);
    // Outside both:
    expect(evalAt([q1, q2], monday(8, 0)).quietHours).toBe(false);
  });
});
