import { describe, expect, it } from "vitest";
import { applyEdits, canAddPoints, compile, deletePoint, findShape, insertLine, insertPath, insertPoint, movePoint, penPathData, pointHandles, pointSourceRange, sideHandles } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const fmt = (n: number) => String(Math.round(n));

function target(src: string) {
  return { source: src, scene: compile(src).scene };
}

describe("pen tool: path text", () => {
  it("writes lines between corners and curves where a node has handles", () => {
    expect(penPathData([{ x: 0, y: 0 }, { x: 10, y: 0 }], false)).toBe("M 0,0 L 10,0");
    const smooth = { x: 10, y: 10, in: { x: 5, y: 10 }, out: { x: 15, y: 10 } };
    expect(penPathData([{ x: 0, y: 0 }, smooth, { x: 20, y: 0 }], false)).toBe("M 0,0 C 0,0 5,10 10,10 C 15,10 20,0 20,0");
  });

  it("closes with Z, as a curve when the first node has handles", () => {
    expect(penPathData([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true)).toBe("M 0,0 L 10,0 L 10,10 Z");
    const first = { x: 0, y: 0, in: { x: -5, y: 5 }, out: { x: 5, y: -5 } };
    expect(penPathData([first, { x: 10, y: 0 }], true)).toBe("M 0,0 C 5,-5 10,0 10,0 C 10,0 -5,5 0,0 Z");
  });

  it("adds a path at the end of the file and selects it; open paths get no fill", () => {
    const t = target(CANVAS);
    const open = insertPath(t, [{ x: 1.4, y: 2 }, { x: 30, y: 40 }], false, fmt);
    expect(applyEdits(CANVAS, open.edits)).toBe(CANVAS + 'path1 is path(d="M 1,2 L 30,40", fill=none, stroke=black)\n');
    expect(open.select).toBe("path1");
    const closed = insertPath(t, [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 30 }], true, fmt);
    expect(applyEdits(CANVAS, closed.edits)).toBe(CANVAS + 'path1 is path(d="M 0,0 L 30,0 L 0,30 Z")\n');
    expect(compile(applyEdits(CANVAS, closed.edits)).diagnostics).toEqual([]);
  });

  it("refuses a path of one point", () => {
    expect(insertPath(target(CANVAS), [{ x: 0, y: 0 }], false, fmt).notices).toHaveLength(1);
  });
});

describe("line tool and line ends", () => {
  const SRC = CANVAS + "l is line(x1=10, y1=20, x2=50%, y2=60)\n";

  it("adds a line", () => {
    const e = insertLine(target(CANVAS), { x: 10, y: 20 }, { x: 110.4, y: 60 }, fmt);
    expect(applyEdits(CANVAS, e.edits)).toBe(CANVAS + "line1 is line(x1=10, y1=20, x2=110, y2=60)\n");
    expect(e.select).toBe("line1");
  });

  it("has its two ends as points, and moves one end keeping units", () => {
    const t = target(SRC);
    const shape = findShape(t.scene, "l")!;
    expect(pointHandles(t.scene, shape)!.map((h) => [h.x, h.y])).toEqual([
      [10, 20],
      [200, 60],
    ]);
    expect(applyEdits(SRC, movePoint(t, "l", 1, 20, 5).edits)).toContain("line(x1=10, y1=20, x2=55%, y2=65)");
    expect(applyEdits(SRC, movePoint(t, "l", 0, -5, 0).edits)).toContain("line(x1=5, y1=20, x2=50%, y2=60)");
  });

  it("shows the end's numbers in the text", () => {
    const t = target(SRC);
    const r = pointSourceRange(t, "l", 0)!;
    expect(SRC.slice(r.start, r.end)).toBe("x1=10, y1=20");
  });

  it("has no points when connected to shapes", () => {
    const src = CANVAS + "a is rect(x=0, y=0, width=10, height=10)\nb is rect(x=50, y=0, width=10, height=10)\nl is line(from=a, to=b)\n";
    const t = target(src);
    expect(pointHandles(t.scene, findShape(t.scene, "l")!)).toBeNull();
  });
});

describe("editing path points", () => {
  // A smooth node at 50,0 (handles 40,0 and 60,0), closed back onto the start.
  const SRC = CANVAS + 'p is path(d="M 0,50 C 0,20 40,0 50,0 C 60,0 100,20 100,50 C 100,80 0,80 0,50 Z")\n';
  const handles = (src: string) => {
    const t = target(src);
    return pointHandles(t.scene, findShape(t.scene, "p")!)!;
  };

  it("shows a closing end on the start point as one point", () => {
    const ends = handles(SRC).filter((h) => h.kind === "end");
    expect(ends.map((h) => [h.x, h.y])).toEqual([
      [0, 50],
      [50, 0],
      [100, 50],
    ]);
  });

  it("moves an end point with its curve handles", () => {
    const t = target(SRC);
    const i = handles(SRC).findIndex((h) => h.kind === "end" && h.x === 50);
    expect(applyEdits(SRC, movePoint(t, "p", i, 0, 10).edits)).toContain('d="M 0,50 C 0,20 40,10 50,10 C 60,10 100,20 100,50');
  });

  it("moves the start point together with the closing end", () => {
    const t = target(SRC);
    expect(applyEdits(SRC, movePoint(t, "p", 0, 5, 0).edits)).toContain('d="M 5,50 C 5,20 40,0 50,0 C 60,0 100,20 100,50 C 100,80 5,80 5,50 Z"');
  });

  it("keeps a smooth point smooth, unless dragged freely", () => {
    const t = target(SRC);
    const i = handles(SRC).findIndex((h) => h.kind === "control" && h.x === 40 && h.y === 0);
    // Handle 40,0 -> 40,10: the other one (60,0, length 10) turns to 60,-10 scaled to length 10.
    const out = applyEdits(SRC, movePoint(t, "p", i, 0, 10).edits);
    expect(out).toContain("40,10 50,0 C 57,-7");
    expect(applyEdits(SRC, movePoint(t, "p", i, 0, 10, { free: true }).edits)).toContain("40,10 50,0 C 60,0");
  });

  it("adds a point in the middle of a curve, splitting it, and selects it", () => {
    const t = target(SRC);
    const shape = findShape(t.scene, "p")!;
    expect(canAddPoints(shape)).toBe(true);
    const sides = sideHandles(t.scene, shape)!;
    expect(sides).toHaveLength(3);
    // On the curve at t = 0.5.
    expect(sides[0]).toEqual({ x: 21.25, y: 13.75 });
    const e = insertPoint(t, "p", 0, 0, 0, (n) => String(n));
    const out = applyEdits(SRC, e.edits);
    expect(out).toContain('d="M 0,50 C 0,35 10,22.5 21.25,13.75 C 32.5,5 45,0 50,0 C');
    const after = handles(out);
    expect(after[e.point!]).toMatchObject({ kind: "end", x: 21.25, y: 13.75 });
  });

  it("deletes a point, joining the curves around it", () => {
    const t = target(SRC);
    const i = handles(SRC).findIndex((h) => h.kind === "end" && h.x === 50);
    expect(applyEdits(SRC, deletePoint(t, "p", i).edits)).toContain('d="M 0,50 C 0,20 100,20 100,50 C 100,80 0,80 0,50 Z"');
  });

  it("deletes the start point of a closed path", () => {
    const t = target(SRC);
    expect(applyEdits(SRC, deletePoint(t, "p", 0).edits)).toContain('d="M 50,0 C 60,0 100,20 100,50 C 100,80 40,0 50,0 Z"');
  });

  it("adds and deletes points on straight sides and an implied closing side", () => {
    const src = CANVAS + 'p is path(d="M 0,0 L 40,0 L 40,40 Z")\n';
    const t = target(src);
    const sides = sideHandles(t.scene, findShape(t.scene, "p")!)!;
    expect(sides).toEqual([
      { x: 20, y: 0 },
      { x: 40, y: 20 },
      { x: 20, y: 20 },
    ]);
    expect(applyEdits(src, insertPoint(t, "p", 2, 0, 0, (n) => String(n)).edits)).toContain('d="M 0,0 L 40,0 L 40,40 L 20,20 Z"');
    expect(applyEdits(src, deletePoint(t, "p", 1).edits)).toContain('d="M 0,0 L 40,40 Z"');
    expect(deletePoint(target(CANVAS + 'p is path(d="M 0,0 L 40,0")\n'), "p", 1).notices[0]).toContain("at least 2");
  });

  it("adds points to paths with relative commands and arcs too (#37)", () => {
    const t = target(CANVAS + 'p is path(d="M 0 0 l 10 0 A 5 5 0 0 1 20 0")\n');
    expect(canAddPoints(findShape(t.scene, "p")!)).toBe(true);
  });
});
