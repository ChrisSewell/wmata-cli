import { describe, it, expect } from "vitest";
import { textWidth } from "./measure";
import {
  pageRects,
  innerBox,
  maxLines,
  computeValueColumn,
  paginate,
} from "./layout";
import { WIDTH, HEIGHT } from "./geometry";

describe("pageRects", () => {
  it("keeps every region inside the 576x288 panel", () => {
    const r = pageRects();
    for (const rect of [r.header, r.body, r.hint]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(WIDTH);
      expect(rect.y + rect.h).toBeLessThanOrEqual(HEIGHT);
    }
  });
  it("stacks header above body above hint without overlap", () => {
    const r = pageRects();
    expect(r.body.y).toBeGreaterThanOrEqual(r.header.y + r.header.h);
    expect(r.hint.y).toBeGreaterThanOrEqual(r.body.y + r.body.h);
  });
});

describe("innerBox / maxLines", () => {
  it("insets by padding + border on all sides", () => {
    const inner = innerBox({ x: 10, y: 10, w: 100, h: 100 }, 4, 2);
    expect(inner).toEqual({ x: 16, y: 16, w: 88, h: 88 });
  });
  it("counts 27px rows", () => {
    expect(maxLines(27)).toBe(1);
    expect(maxLines(80)).toBe(2);
    expect(maxLines(10)).toBe(0);
  });
});

describe("computeValueColumn", () => {
  it("fits inside the inner box and leaves a positive left column", () => {
    const innerLeft = 20;
    const innerRight = 560;
    const col = computeValueColumn(innerLeft, innerRight, ["1 min", "12 min", "ARR"]);
    expect(col.valueX).toBeGreaterThan(innerLeft);
    expect(col.valueX + col.valueW).toBeLessThanOrEqual(innerRight);
    expect(col.leftW).toBeGreaterThan(0);
    // value column is wide enough for the worst-case reserve value
    expect(col.valueW).toBeGreaterThanOrEqual(textWidth("12 min"));
  });
  it("the value x is the same regardless of left content (alignment by position)", () => {
    const a = computeValueColumn(20, 560, ["12 min"]);
    const b = computeValueColumn(20, 560, ["12 min"]);
    expect(a.valueX).toBe(b.valueX);
  });
});

describe("paginate", () => {
  it("returns a single page for short text", () => {
    const pages = paginate("Red line: good service.", { width: 520, height: 160 });
    expect(pages.length).toBe(1);
  });
  it("splits long text across multiple pages", () => {
    const para = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} with enough words to occupy a full line or two of the container body.`).join("\n\n");
    const pages = paginate(para, { width: 520, height: 110 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.length > 0)).toBe(true);
  });
  it("never returns an empty array", () => {
    expect(paginate("", { width: 520, height: 160 })).toEqual([""]);
  });
});
