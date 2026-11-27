// The pen writes `S` for a curve leaving a smooth point (issue #38): its first handle mirrors
// the curve before's last one, so it takes 4 numbers instead of 6. In the drawing area that
// mirrored handle is shown, and dragging it turns the handle it mirrors: the point stays smooth.
import { describe, expect, it } from "vitest";
import { applyEdits, compile, findShape, insertPath, movePoint, penPathData, pointHandles, pointSourceRange, type PenNode } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const src = (d: string) => `${CANVAS}p is path(d="${d}", fill=none, stroke=black)\n`;
const dOf = (text: string) => /d="([^"]*)"/.exec(text)![1];
const smooth = (x: number, y: number, hx: number, hy: number): PenNode => ({ x, y, in: { x: x - hx, y: y - hy }, out: { x: x + hx, y: y + hy } });

function target(text: string) {
  const r = compile(text);
  expect(r.diagnostics).toEqual([]);
  return { source: text, scene: r.scene };
}

function handles(d: string) {
  const t = target(src(d));
  return pointHandles(t.scene, findShape(t.scene, "p")!)!;
}

function drag(d: string, index: number, dx: number, dy: number, free = false): string {
  const t = target(src(d));
  const e = movePoint(t, "p", index, dx, dy, { free });
  expect(e.notices).toEqual([]);
  return dOf(applyEdits(t.source, e.edits));
}

describe("the pen writes S", () => {
  it("for a curve that leaves a smooth point after a curve (the issue's example)", () => {
    const nodes: PenNode[] = [{ x: 0, y: 0, out: { x: 20, y: -20 } }, smooth(60, 0, 20, 20), { x: 120, y: 0, in: { x: 100, y: 20 } }];
    expect(penPathData(nodes, false)).toBe("M 0,0 C 20,-20 40,-20 60,0 S 100,20 120,0");
  });

  it("keeps C for a corner with two handles, and for the first curve (nothing before it to mirror)", () => {
    const corner: PenNode = { x: 60, y: 0, in: { x: 40, y: -20 }, out: { x: 80, y: -20 } };
    expect(penPathData([{ x: 0, y: 0 }, corner, { x: 120, y: 0 }], false)).toBe("M 0,0 C 0,0 40,-20 60,0 C 80,-20 120,0 120,0");
    expect(penPathData([smooth(0, 0, 10, 0), { x: 50, y: 0 }], false)).toBe("M 0,0 C 10,0 50,0 50,0");
  });

  it("closes with S when the last point is smooth", () => {
    const nodes: PenNode[] = [{ x: 0, y: 0 }, smooth(40, 0, 10, 10), smooth(40, 40, -10, 10)];
    expect(penPathData(nodes, true)).toBe("M 0,0 C 0,0 30,-10 40,0 S 50,30 40,40 S 0,0 0,0 Z");
  });

  it("keeps a smooth point smooth when its numbers are rounded", () => {
    const t = target(CANVAS);
    const nodes: PenNode[] = [{ x: 0, y: 0 }, { x: 10, y: 10, in: { x: 4.6, y: 10.2 }, out: { x: 15.4, y: 9.8 } }, { x: 20, y: 0 }];
    const out = applyEdits(CANVAS, insertPath(t, nodes, false, (n) => String(Math.round(n))).edits);
    expect(dOf(out)).toBe("M 0,0 C 0,0 5,10 10,10 S 20,0 20,0");
    expect(compile(out).diagnostics).toEqual([]);
  });
});

describe("editing a path with S", () => {
  const D = "M 0 0 C 20 -20 40 -20 60 0 S 100 20 120 0";

  it("shows the S curve's mirrored handle, opposite the handle before it", () => {
    expect(handles(D).map((h) => [h.kind, h.x, h.y])).toEqual([
      ["end", 0, 0],
      ["control", 20, -20],
      ["control", 40, -20],
      ["end", 60, 0],
      ["control", 80, 20],
      ["control", 100, 20],
      ["end", 120, 0],
    ]);
  });

  it("dragging the mirrored handle turns the one it mirrors, also when dragged freely", () => {
    expect(drag(D, 4, 5, 10)).toBe("M 0 0 C 20 -20 35 -30 60 0 S 100 20 120 0");
    expect(drag(D, 4, 5, 10, true)).toBe("M 0 0 C 20 -20 35 -30 60 0 S 100 20 120 0");
  });

  it("dragging the handle before an S changes only its own numbers: the S follows", () => {
    expect(drag(D, 2, 0, -10)).toBe("M 0 0 C 20 -20 40 -30 60 0 S 100 20 120 0");
  });

  it("moving the smooth point takes its handles along", () => {
    expect(drag(D, 3, 0, 5)).toBe("M 0 0 C 20 -20 40 -15 60 5 S 100 20 120 0");
  });

  it("works on relative commands too", () => {
    const rel = "M 0 0 c 20 -20 40 -20 60 0 s 40 20 60 0";
    expect(handles(rel)[4]).toMatchObject({ kind: "control", x: 80, y: 20 });
    expect(drag(rel, 4, 5, 10)).toBe("M 0 0 c 20 -20 35 -30 60 0 s 40 20 60 0");
  });

  it("shows the numbers it comes from in the text", () => {
    const t = target(src(D));
    const r = pointSourceRange(t, "p", 4)!;
    expect(t.source.slice(r.start, r.end)).toBe("40 -20");
  });

  it("an S after a line or a quadratic curve mirrors nothing: no extra handle", () => {
    expect(handles("M 0 0 L 60 0 S 100 20 120 0").filter((h) => h.kind === "control")).toHaveLength(1);
    expect(handles("M 0 0 Q 30 -30 60 0 S 100 20 120 0").filter((h) => h.kind === "control")).toHaveLength(2);
  });
});
