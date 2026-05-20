// Unit tests for the first-launch gesture cheat sheet.
//
// What's locked here (mirrors the WP6 pattern):
//   - The view returns EXACTLY 8 lines, each ≤ LINE_WIDTH cols.
//   - Every touchpad gesture navigates to Home.
//   - `onUnmount` persists `tutorialSeen = true` exactly once.
//   - The reducer is total over `ScreenEvent` (voice-flow variants
//     are absorbed as a no-op).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINE_WIDTH } from "../ui/render";
import {
  flattenSections, initialNav, type ViewContext } from "./router";
import {
  TUTORIAL_BODY_LINES,
  TUTORIAL_TITLE,
  makeTutorialScreen,
  renderHeader,
} from "./tutorial";
import { loadSettings, markTutorialSeen } from "../storage/settings";

// ---------------------------------------------------------------------------
// Mock localStorage (same minimal shape as settings.test.ts)
// ---------------------------------------------------------------------------

interface MockStorage {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function makeMockStorage(): MockStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string): string | null =>
      store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

let mockStorage: MockStorage;

beforeEach(() => {
  mockStorage = makeMockStorage();
  vi.stubGlobal("localStorage", mockStorage);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fixed wall clock — May 18 2026 14:32 local. */
const NOW = new Date(2026, 4, 18, 14, 32, 0).getTime();
const CTX: ViewContext = { nowMs: NOW };

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe("tutorial view", () => {
  it("renders EXACTLY 8 lines (lock per the WP6 pattern)", () => {
    const screen = makeTutorialScreen();
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    expect(lines.length).toBe(8);
  });

  it("every line is ≤ LINE_WIDTH columns", () => {
    const screen = makeTutorialScreen();
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    }
  });

  it("renders the title in the header and the body cheat sheet", () => {
    const screen = makeTutorialScreen();
    const lines = flattenSections(screen.view(screen.init(), initialNav(), CTX));
    // Header at the top: title only — the host renders the clock in its
    // own top-right container, so it's no longer in the header string.
    expect(lines[0]).toBe(renderHeader());
    expect(lines[0]).toBe(TUTORIAL_TITLE);
    expect(lines[0]).not.toContain(" 2:32p");
    // Body matches the canonical cheat-sheet verbatim.
    expect(lines.slice(1)).toEqual([...TUTORIAL_BODY_LINES]);
  });
});

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

describe("tutorial reduce", () => {
  it("TAP navigates to Home", () => {
    const screen = makeTutorialScreen();
    const r = screen.reduce(screen.init(), initialNav(), { type: "TAP" });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("DOUBLE_TAP navigates to Home", () => {
    const screen = makeTutorialScreen();
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "DOUBLE_TAP",
    });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("SCROLL_UP navigates to Home", () => {
    const screen = makeTutorialScreen();
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "SCROLL_UP",
    });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("SCROLL_DOWN navigates to Home", () => {
    const screen = makeTutorialScreen();
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "SCROLL_DOWN",
    });
    expect(r.navigate).toEqual({ to: "home" });
  });

  it("absorbs voice-flow events as a no-op (no navigate)", () => {
    const screen = makeTutorialScreen();
    const r = screen.reduce(screen.init(), initialNav(), {
      type: "TRANSCRIPT",
      text: "metro center",
      isFinal: false,
    });
    expect(r.navigate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onUnmount
// ---------------------------------------------------------------------------

describe("tutorial onUnmount", () => {
  it("persists tutorialSeen = true so the next mount routes to Home", async () => {
    expect(loadSettings().tutorialSeen).toBe(false);
    const screen = makeTutorialScreen();
    // The bridge argument is unused inside `onUnmount` (only the
    // storage-side write matters), so we can pass an undefined-cast
    // placeholder for the test.
    await screen.onUnmount!({} as never);
    expect(loadSettings().tutorialSeen).toBe(true);
  });

  it("is idempotent: calling onUnmount twice leaves tutorialSeen as true", async () => {
    const screen = makeTutorialScreen();
    await screen.onUnmount!({} as never);
    await screen.onUnmount!({} as never);
    expect(loadSettings().tutorialSeen).toBe(true);
  });

  it("markTutorialSeen alone is sufficient (no other side effects required)", () => {
    expect(loadSettings().tutorialSeen).toBe(false);
    markTutorialSeen();
    expect(loadSettings().tutorialSeen).toBe(true);
  });
});
