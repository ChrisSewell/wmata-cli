// Unit tests for the pre-config placeholder screen.
//
// What's locked here (mirrors the tutorial test pattern):
//   - The view returns header + body, each line ≤ LINE_WIDTH cols.
//   - The header is the title only (host draws the clock separately).
//   - DOUBLE_TAP backs out (exit); every other gesture is a no-op so the
//     watcher — not a touchpad gesture — drives the hand-off to Home.
//   - The reducer is total over `ScreenEvent` (voice-flow variants are
//     absorbed without navigating).

import { describe, expect, it } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import { flattenSections, initialNav, type ViewContext } from "./router";
import {
  UNCONFIGURED_BODY_LINES,
  UNCONFIGURED_TITLE,
  makeUnconfiguredScreen,
  renderHeader,
} from "./unconfigured";

const CTX: ViewContext = { nowMs: new Date(2026, 4, 18, 14, 32, 0).getTime() };

describe("unconfigured view", () => {
  it("renders the title header + the full body copy", () => {
    const screen = makeUnconfiguredScreen();
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expect(lines[0]).toBe(renderHeader());
    expect(lines[0]).toBe(UNCONFIGURED_TITLE);
    expect(lines.slice(1)).toEqual([...UNCONFIGURED_BODY_LINES]);
  });

  it("every line is ≤ LINE_WIDTH columns", () => {
    const screen = makeUnconfiguredScreen();
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
  });

  it("tells the user setup happens on the phone and is automatic", () => {
    const body = UNCONFIGURED_BODY_LINES.join(" ");
    expect(body.toLowerCase()).toContain("phone");
    expect(body.toLowerCase()).toContain("api key");
    expect(body.toLowerCase()).toContain("favorite");
    expect(body.toLowerCase()).toContain("automatic");
  });
});

describe("unconfigured reduce", () => {
  it("DOUBLE_TAP backs out of the app (exit)", () => {
    const screen = makeUnconfiguredScreen();
    const r = screen.reduce(screen.init(), initialNav(), { type: "DOUBLE_TAP" });
    expect(r.navigate).toEqual({ to: "exit" });
  });

  it.each(["TAP", "SCROLL_UP", "SCROLL_DOWN"] as const)(
    "%s is a no-op (the watcher drives the hand-off, not a gesture)",
    (type) => {
      const screen = makeUnconfiguredScreen();
      const r = screen.reduce(screen.init(), initialNav(), { type });
      expect(r.navigate).toBeUndefined();
    },
  );

  it("absorbs voice-flow events as a no-op (total reducer)", () => {
    const screen = makeUnconfiguredScreen();
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "TRANSCRIPT",
      text: "metro center",
      isFinal: false,
    });
    expect(r.navigate).toBeUndefined();
  });
});
