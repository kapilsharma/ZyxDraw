// The curve tool (issue #36): click points, get a smooth curve through every one, written as an
// ordinary path (`C`, or `S` where a point's two handles are mirrored), with readable numbers.
import { describe, expect, it } from "vitest";
import { applyEdits, compile, findShape, insertPath, penPathData, pointHandles, smoothThrough, type Pt } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const dOf = (text: string) => /d="([^"]*)"/.exec(text)![1];
const whole = (n: number) => String(Math.round(n));

/** Adds the curve through `points` as the tool does; returns the new text. */
function draw(points: Pt[], closed: boolean): string {
  const r = compile(CANVAS);
  const out = applyEdits(CANVAS, insertPath({ source: CANVAS, scene: r.scene }, smoothThrough(points, closed), closed, whole).edits);
  expect(compile(out).diagnostics).toEqual([]);
  return out;
}

/** The points on the outline of the path in `text`. */
function ends(text: string): Pt[] {
  const r = compile(text);
  return pointHandles(r.scene, findShape(r.scene, "path1")!)!
    .filter((h) => h.kind === "end")
    .map((h) => ({ x: h.x, y: h.y }));
}

describe("smooth curve through points", () => {
  it("two points give a straight line", () => {
    expect(penPathData(smoothThrough([{ x: 0, y: 0 }, { x: 100, y: 0 }], false), false)).toBe("M 0,0 L 100,0");
  });

  it("a hill: handles along the line between the neighbours, a third of each side; the ends aim at the next handle", () => {
    const d = penPathData(smoothThrough([{ x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 }], false), false);
    expect(d).toBe("M 0,100 C 6.366,50 12.732,0 50,0 S 93.634,50 100,100");
  });

  it("goes through every point clicked", () => {
    const points = [
      { x: 10, y: 50 },
      { x: 40, y: 10 },
      { x: 120, y: 60 },
      { x: 150, y: 20 },
    ];
    expect(ends(draw(points, false))).toEqual(points);
  });

  it("writes whole numbers with the drawing's number format, and C where the sides differ in length", () => {
    const d = dOf(draw([{ x: 0, y: 0 }, { x: 30, y: 30 }, { x: 130, y: 30 }], false));
    expect(d).toMatch(/^[MC\d, -]+$/);
    expect(d).not.toMatch(/\./);
  });

  it("closes into a smooth loop: a square of points gives a round shape", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const out = draw(square, true);
    expect(dOf(out)).toBe("M 0,0 C 24,-24 76,-24 100,0 S 124,76 100,100 S 24,124 0,100 S -24,24 0,0 Z");
    expect(out).toContain('path1 is path(d="M 0,0 C 24,-24 76,-24 100,0 S 124,76 100,100 S 24,124 0,100 S -24,24 0,0 Z")');
  });

  it("an open curve gets no fill, as from the pen", () => {
    expect(draw([{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], false)).toContain(", fill=none, stroke=black)");
  });
});
