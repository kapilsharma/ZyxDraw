// Drawing and editing arcs (issue #39): the pen draws a circle arc with Shift (a half circle,
// or bent through the mouse while dragging); a circle arc's side can be dragged to bend it,
// staying a circle arc; a `T` shows the control point it mirrors.
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  arcThrough,
  bendableSides,
  bendSide,
  compile,
  continuePath,
  findShape,
  halfCircle,
  insertPath,
  movePoint,
  penPathData,
  pointHandles,
  pointSourceRange,
  type PenNode,
} from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const src = (d: string) => `${CANVAS}p is path(d="${d}", fill=none, stroke=black)\n`;
const dOf = (text: string) => /d="([^"]*)"/.exec(text)![1];

function target(text: string) {
  const r = compile(text);
  expect(r.diagnostics).toEqual([]);
  return { source: text, scene: r.scene };
}

function bend(d: string, grab: { x: number; y: number }, dx: number, dy: number): string {
  const t = target(src(d));
  const e = bendSide(t, "p", 0, grab, dx, dy, fmt);
  expect(e.notices).toEqual([]);
  const out = applyEdits(t.source, e.edits);
  expect(compile(out).diagnostics).toEqual([]);
  return dOf(out);
}

describe("the arc through three points", () => {
  it("gives the radius and which of the four arcs", () => {
    expect(arcThrough({ x: 0, y: 0 }, { x: 10, y: -10 }, { x: 20, y: 0 })).toMatchObject({ large: 0, sweep: 1 });
    expect(arcThrough({ x: 0, y: 0 }, { x: 10, y: -10 }, { x: 20, y: 0 })!.rx).toBeCloseTo(10);
    // Through a point far over the top: more than half a circle.
    const big = arcThrough({ x: 0, y: 0 }, { x: 10, y: -20 }, { x: 20, y: 0 })!;
    expect(big).toMatchObject({ large: 1, sweep: 1 });
    expect(big.rx).toBeCloseTo(12.5);
    // The other way round: anticlockwise.
    expect(arcThrough({ x: 20, y: 0 }, { x: 10, y: -10 }, { x: 0, y: 0 })).toMatchObject({ large: 0, sweep: 0 });
    expect(arcThrough({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 })).toBeNull();
  });

  it("a half circle goes to the right of the way drawn", () => {
    expect(halfCircle({ x: 0, y: 0 }, { x: 20, y: 0 })).toEqual({ x: 10, y: 10 });
  });
});

describe("the pen draws arcs", () => {
  it("writes A for a side to a node with an arc, and a line when the three points are in a line", () => {
    expect(penPathData([{ x: 0, y: 0 }, { x: 20, y: 0, arc: { x: 10, y: -10 } }], false)).toBe("M 0,0 A 10 10 0 0 1 20,0");
    expect(penPathData([{ x: 0, y: 0 }, { x: 20, y: 0, arc: { x: 10, y: 0 } }], false)).toBe("M 0,0 L 20,0");
  });

  it("closes with an arc kept on the first node", () => {
    expect(penPathData([{ x: 0, y: 0, arc: { x: 10, y: 10 } }, { x: 20, y: 0 }], true)).toBe("M 0,0 L 20,0 A 10 10 0 0 1 0,0 Z");
  });

  it("an arc after a smooth point does not make the next curve an S", () => {
    const nodes: PenNode[] = [{ x: 0, y: 0 }, { x: 20, y: 0, arc: { x: 10, y: -10 }, in: { x: 15, y: 5 }, out: { x: 25, y: -5 } }, { x: 40, y: 0 }];
    expect(penPathData(nodes, false)).toBe("M 0,0 A 10 10 0 0 1 20,0 C 25,-5 40,0 40,0");
  });

  it("adds a path with an arc, its numbers rounded", () => {
    const out = applyEdits(CANVAS, insertPath(target(CANVAS), [{ x: 0, y: 0 }, { x: 20, y: 0, arc: { x: 10.4, y: -9.6 } }], false, (n) => String(Math.round(n))).edits);
    expect(dOf(out)).toBe("M 0,0 A 10 10 0 0 1 20,0");
  });

  it("continues a path with arcs, at the start (turned around) and closing at the end", () => {
    const line = src("M 10,10 L 50,10");
    const atStart = continuePath(target(line), "p", "start", [{ x: 10, y: 10 }, { x: -10, y: 10, arc: { x: 0, y: 0 } }], false, fmt);
    expect(dOf(applyEdits(line, atStart.edits))).toBe("M -10,10 A 10 10 0 0 1 10,10 L 50,10");
    const closing = continuePath(target(line), "p", "end", [{ x: 50, y: 10, arc: { x: 10, y: 50 } }, { x: 50, y: 50 }], true, fmt);
    expect(dOf(applyEdits(line, closing.edits))).toBe("M 10,10 L 50,10 L 50,50 A 28.284 28.284 0 0 1 10,10 Z");
  });
});

describe("bending a circle arc", () => {
  it("can grab a circle arc, not an ellipse one", () => {
    const t = target(src("M 0,0 A 10 10 0 0 1 20,0 A 10 5 0 0 1 40,0"));
    expect(bendableSides(t.scene, findShape(t.scene, "p")!)!.curves).toEqual(["M 0,0 A 10 10 0 0 1 20,0", null]);
  });

  it("stays a circle arc, through the spot held", () => {
    expect(bend("M 0,0 A 10 10 0 0 1 20,0", { x: 10, y: -10 }, 0, -10)).toBe("M 0,0 A 12.5 12.5 0 1 1 20,0");
    expect(bend("M 0,0 a 10 10 0 0 1 20,0", { x: 10, y: -10 }, 0, -10)).toBe("M 0,0 a 12.5 12.5 0 1 1 20,0");
  });

  it("takes the spot on the arc nearest to the mouse", () => {
    expect(bend("M 0,0 A 10 10 0 0 1 20,0", { x: 10, y: -12 }, 0, 0)).toBe("M 0,0 A 10 10 0 0 1 20,0");
  });

  it("refuses to flatten it into a line", () => {
    const t = target(src("M 0,0 A 10 10 0 0 1 20,0"));
    expect(bendSide(t, "p", 0, { x: 10, y: -10 }, 0, 10, fmt).notices[0]).toMatch(/straight line/);
  });
});

describe("the control point a T mirrors", () => {
  const handles = (d: string) => {
    const t = target(src(d));
    return pointHandles(t.scene, findShape(t.scene, "p")!)!;
  };
  const drag = (d: string, index: number, dx: number, dy: number) => {
    const t = target(src(d));
    return dOf(applyEdits(t.source, movePoint(t, "p", index, dx, dy).edits));
  };

  it("is shown, and dragging it moves the Q it comes from the other way", () => {
    const d = "M 0,0 Q 10,10 20,0 T 40,0";
    expect(handles(d).map((h) => [h.kind, h.x, h.y])).toEqual([
      ["end", 0, 0],
      ["control", 10, 10],
      ["end", 20, 0],
      ["control", 30, -10],
      ["end", 40, 0],
    ]);
    expect(drag(d, 3, 0, -5)).toBe("M 0,0 Q 10,15 20,0 T 40,0");
    const t = target(src(d));
    const r = pointSourceRange(t, "p", 3)!;
    expect(t.source.slice(r.start, r.end)).toBe("10,10");
  });

  it("in a chain of T, each mirrors the one before", () => {
    const d = "M 0,0 Q 10,10 20,0 T 40,0 T 60,0";
    expect(handles(d)[5]).toMatchObject({ kind: "control", x: 50, y: 10 });
    expect(drag(d, 5, 0, 5)).toBe("M 0,0 Q 10,15 20,0 T 40,0 T 60,0");
  });

  it("a T after a line mirrors nothing: no handle", () => {
    expect(handles("M 0,0 L 20,0 T 40,0").filter((h) => h.kind === "control")).toHaveLength(0);
  });
});
