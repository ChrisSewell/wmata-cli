import { describe, it, expect } from "vitest";
import { makeAlertDetailScreen, type AlertDetailSnapshot } from "./alert-detail";

const longText = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} with several words to fill the body.`).join(" ");

describe("alert detail", () => {
  it("paginates long text into multiple pages", () => {
    const screen = makeAlertDetailScreen({ title: "Alert", detail: longText });
    const s = screen.init();
    expect(s.pages.length).toBeGreaterThan(1);
  });

  it("short text is a single page", () => {
    const screen = makeAlertDetailScreen({ title: "Alert", detail: "Short note." });
    expect(screen.init().pages.length).toBe(1);
  });

  it("scroll flips pages, clamped to bounds", () => {
    const screen = makeAlertDetailScreen({ title: "Alert", detail: longText });
    const s = screen.init();
    const max = s.pages.length - 1;
    // up at page 0 stays at 0
    expect((screen.reduce(s, { selectedIndex: 0 }, { type: "SCROLL_UP" }).snapshot as AlertDetailSnapshot).pageIndex).toBe(0);
    // down advances
    expect((screen.reduce(s, { selectedIndex: 0 }, { type: "SCROLL_DOWN" }).snapshot as AlertDetailSnapshot).pageIndex).toBe(1);
    // down at last page stays
    const last = { ...s, pageIndex: max };
    expect((screen.reduce(last, { selectedIndex: 0 }, { type: "SCROLL_DOWN" }).snapshot as AlertDetailSnapshot).pageIndex).toBe(max);
  });

  it("press / double-press return to alerts", () => {
    const screen = makeAlertDetailScreen({ title: "Alert", detail: "x" });
    const s = screen.init();
    expect(screen.reduce(s, { selectedIndex: 0 }, { type: "TAP" }).navigate).toEqual({ to: "alerts" });
    expect(screen.reduce(s, { selectedIndex: 0 }, { type: "DOUBLE_TAP" }).navigate).toEqual({ to: "alerts" });
  });

  it("shows a page marker only when multi-page", () => {
    const ctx = { nowMs: 0 };
    const multi = makeAlertDetailScreen({ title: "Alert", detail: longText });
    expect(multi.view(multi.init(), { selectedIndex: 0 }, ctx).header.marker).toBe("1/" + multi.init().pages.length);
    const single = makeAlertDetailScreen({ title: "Alert", detail: "x" });
    expect(single.view(single.init(), { selectedIndex: 0 }, ctx).header.marker).toBeUndefined();
  });
});
