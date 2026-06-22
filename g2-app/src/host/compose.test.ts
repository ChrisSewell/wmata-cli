import { describe, it, expect } from "vitest";
import { columnGeom, composeText } from "./compose";
import type { Layout } from "../screens/router";

const NOW = 1_000_000;

describe("columnGeom", () => {
  it("has no value column without a reserve", () => {
    expect(columnGeom(undefined).valueX).toBeNull();
    expect(columnGeom([]).valueX).toBeNull();
  });
  it("places a value column inside the body with a positive left budget", () => {
    const g = columnGeom(["12 min"]);
    expect(g.valueX).not.toBeNull();
    expect(g.leftW).toBeGreaterThan(0);
  });
});

describe("composeText", () => {
  const geom = columnGeom(["12 min"]);

  it("renders message lines into the body, no value column", () => {
    const layout: Layout = { header: { title: "X" }, body: { kind: "message", lines: ["hello", "world"] } };
    const r = composeText(layout, geom, NOW, true);
    expect(r.bodyContent).toBe("hello\nworld");
    expect(r.valueContent).toBe("");
  });

  it("marks the selected row with the caret and aligns the value column", () => {
    const layout: Layout = {
      header: { title: "WMATA" },
      body: {
        kind: "rows",
        selectedIndex: 1,
        rows: [
          { left: "Metro Center", value: "4 min" },
          { left: "Foggy Bottom", value: "ARR" },
        ],
      },
    };
    const r = composeText(layout, geom, NOW, true);
    const lines = r.bodyContent.split("\n");
    expect(lines[0]!.startsWith("▶")).toBe(false);
    expect(lines[1]!.startsWith("▶")).toBe(true);
    // values are their own column, row-for-row, never space-padded
    expect(r.valueContent).toBe("4 min\nARR");
  });

  it("includes the clock and (only when visible) the hint", () => {
    const layout: Layout = {
      header: { title: "WMATA", marker: "*" },
      body: { kind: "message", lines: ["x"] },
      hints: [{ glyph: "●●", label: "Exit" }],
    };
    expect(composeText(layout, geom, NOW, true).clock).toContain("*");
    expect(composeText(layout, geom, NOW, true).hint).toContain("Exit");
    expect(composeText(layout, geom, NOW, false).hint).toBe("");
  });
});
