import { describe, expect, it } from "vitest";
import { compile, findShape, formatCoordinate, gridPath, gridSteps, localOrigin, pointSourceRange, snapDelta } from "../../src/core";

describe("grid steps", () => {
  it("picks the smallest 1-2-5 step at least 8 px apart, with a round major step", () => {
    expect(gridSteps(1)).toEqual({ minor: 10, major: 50 });
    expect(gridSteps(2)).toEqual({ minor: 5, major: 10 });
    expect(gridSteps(3)).toEqual({ minor: 5, major: 10 });
    expect(gridSteps(5)).toEqual({ minor: 2, major: 10 });
    expect(gridSteps(10)).toEqual({ minor: 1, major: 5 });
    expect(gridSteps(0.5)).toEqual({ minor: 20, major: 100 });
    expect(gridSteps(0.1)).toEqual({ minor: 100, major: 500 });
    expect(gridSteps(40)).toEqual({ minor: 0.2, major: 1 });
  });

  it("survives a zero or broken zoom", () => {
    expect(gridSteps(0)).toEqual({ minor: 10, major: 50 });
    expect(gridSteps(Number.NaN)).toEqual({ minor: 10, major: 50 });
  });
});

describe("grid lines", () => {
  it("draws lines on multiples of the step, inside the area", () => {
    expect(gridPath(0, 0, 20, 10, 10)).toBe("M0 0V10M10 0V10M20 0V10M0 0H20M0 10H20");
    expect(gridPath(5, 0, 10, 10, 10)).toBe("M10 0V10M5 0H15M5 10H15");
  });

  it("leaves out the major lines", () => {
    expect(gridPath(0, 0, 20, 0.5, 5, 10)).toBe("M5 0V0.5M15 0V0.5");
  });

  it("draws nothing for an empty area", () => {
    expect(gridPath(0, 0, 0, 10, 10)).toBe("");
  });
});

describe("point in the text", () => {
  const text = (source: string, path: string, index: number) => {
    const r = compile(source);
    const range = pointSourceRange({ source, scene: r.scene }, path, index);
    return range && source.slice(range.start, range.end);
  };

  it("finds a polygon point's numbers", () => {
    const src =
      'canvas(width=200, height=200)\np is polygon(\n  fill=red\n  points="10,10 100,10 100,27 34,95 100,95 150,172"\n)\n';
    expect(text(src, "p", 0)).toBe("10,10");
    expect(text(src, "p", 3)).toBe("34,95");
    expect(text(src, "p", 5)).toBe("150,172");
    expect(text(src, "p", 6)).toBeNull();
  });

  it("finds path end points and control points", () => {
    const src = 'canvas(width=200, height=200)\np is path(d="M 20 20 Q 100 0 180 20 H 50")\n';
    expect(text(src, "p", 0)).toBe("20 20");
    expect(text(src, "p", 1)).toBe("100 0");
    expect(text(src, "p", 2)).toBe("180 20");
    expect(text(src, "p", 3)).toBe("50");
  });
});

describe("snap to grid", () => {
  it("moves the anchor onto the nearest grid line", () => {
    expect(snapDelta(13, 0, 10)).toBe(-3);
    expect(snapDelta(13, 4, 10)).toBe(7);
    expect(snapDelta(13, -9, 10)).toBe(-13);
    expect(snapDelta(0.3, 0.25, 0.2)).toBe(0.3);
  });

  it("leaves an axis that is not dragged alone", () => {
    expect(snapDelta(null, 4.7, 10)).toBe(4.7);
    expect(snapDelta(5, 4.7, 0)).toBe(4.7);
  });
});

describe("coordinates", () => {
  it("shows more decimals when zoomed in", () => {
    expect(formatCoordinate(12.3456, 0.5)).toBe("12");
    expect(formatCoordinate(12.3456, 2)).toBe("12.3");
    expect(formatCoordinate(12.3456, 20)).toBe("12.35");
    expect(formatCoordinate(-0.01, 1)).toBe("0");
  });

  it("measures a path's numbers from where its 0,0 is drawn", () => {
    const r = compile("canvas(width=200, height=200)\np is path(x=30, y=40, d=\"M 10 20 L 50 60\")\n");
    expect(localOrigin(r.scene, findShape(r.scene, "p")!)).toEqual({ x: 30, y: 40 });
  });

  it("measures a custom shape's parts from its corner", () => {
    const r = compile(
      "canvas(width=200, height=200)\ntag is shape():\n  path(d=\"M 0 0 L 20 10\")\nt is tag(x=50, y=60)\nc is circle(cx=5, cy=5, r=5)\n",
    );
    expect(localOrigin(r.scene, findShape(r.scene, "t")!)).toEqual({ x: 50, y: 60 });
    expect(localOrigin(r.scene, findShape(r.scene, "c")!)).toBeNull();
  });
});
