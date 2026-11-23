import { describe, expect, it } from "vitest";
import { applyEdits, compile, findShape, movePoint, movedPointsText, overlayTransforms, pointHandles, previewGeometry } from "../../src/core";

const CANVAS = "canvas(width=200, height=200)\n";

function errors(source: string): string[] {
  return compile(source).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

describe("rotate and scale", () => {
  it("rotates around the center of the box", () => {
    const r = compile(CANVAS + "a is rect(x=10, y=20, width=40, height=20, rotate=45)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('transform="rotate(45 30 30)"');
  });

  it("scales (one or two numbers) and combines with rotate", () => {
    const one = compile(CANVAS + "a is rect(width=40, height=20, scale=2, rotate=-90)\n");
    expect(one.svg).toContain('transform="translate(20 10) rotate(-90) scale(2) translate(-20 -10)"');
    const two = compile(CANVAS + "a is rect(width=40, height=20, scale=-1 1)\n");
    expect(two.diagnostics).toEqual([]);
    expect(two.svg).toContain("scale(-1 1)");
    const flip = compile(CANVAS + "a is rect(width=40, height=20, scale=1 -1)\n");
    expect(flip.diagnostics).toEqual([]);
    expect(flip.svg).toContain("scale(1 -1)");
  });

  it("does not change the layout", () => {
    const r = compile(CANVAS + "a is rect(x=0, y=0, width=40, height=20, rotate=90)\nb is rect(right-of=a 10, y=0, width=10, height=10)\n");
    expect(r.svg).toContain('<rect x="50" y="0" width="10" height="10"');
  });

  it("turns a group around its own center, after moving it", () => {
    const r = compile(CANVAS + "g is group(x=100, y=50, width=40, height=20, rotate=180):\n  rect(width=40, height=20)\n");
    expect(r.svg).toContain('transform="translate(100,50) rotate(180 20 10)"');
  });

  it("works on custom shape instances", () => {
    const r = compile(CANVAS + "zee is shape(color):\n  rect(width=40, height=20, fill=color)\n\na is zee(color=red, rotate=30, scale=1.5)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain("rotate(30)");
    expect(r.svg).toContain("scale(1.5)");
  });

  it("rejects bad values", () => {
    expect(errors(CANVAS + "a is rect(width=4, height=4, scale=0)\n")[0]).toContain("cannot be 0");
    expect(errors(CANVAS + "a is rect(width=4, height=4, scale=1 2 3)\n")[0]).toContain("one number, or two");
    expect(errors(CANVAS + "a is rect(width=4, height=4, rotate=10%)\n").length).toBe(1);
  });

  it("gives the overlay the transforms of the shape and its groups", () => {
    const r = compile(CANVAS + "g is group(x=100, y=0, width=40, height=40, rotate=90):\n  a is rect(width=10, height=10, scale=2)\n");
    const shape = findShape(r.scene, "g.a")!;
    const t = overlayTransforms(r.scene, shape);
    expect(t.parent).toBe("rotate(90 120 20)");
    expect(t.own).toBe("translate(105 5) scale(2) translate(-105 -5)");
  });
});

describe("rounded polygons", () => {
  it("draws rounded corners as a path, with each corner as the curve's control point", () => {
    const r = compile(CANVAS + 'p is polygon(points="0,0 100,0 100,100", radius=10)\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<path d="M 7.071 7.071 Q 0 0 10 0 L 90 0 Q 100 0 100 10 L 100 90 Q 100 100 92.929 92.929 Z"');
  });

  it("limits the rounding to half of each edge", () => {
    const r = compile(CANVAS + 'p is polygon(points="0,0 10,0 10,10 0,10", radius=50)\n');
    expect(r.svg).toContain("M 0 5 Q 0 0 5 0 L 5 0 Q 10 0 10 5");
  });

  it("keeps a polyline's ends sharp", () => {
    const r = compile(CANVAS + 'p is polyline(points="0,0 50,0 50,50", radius=10, fill=none)\n');
    expect(r.svg).toContain('d="M 0 0 L 40 0 Q 50 0 50 10 L 50 50"');
  });

  it("without radius stays a polygon", () => {
    expect(compile(CANVAS + 'p is polygon(points="0,0 10,0 10,10")\n').svg).toContain("<polygon");
  });
});

describe("dragging points", () => {
  const PATH = CANVAS + 'p is path(d="M 10 10 L 50.5 10 Q 60 30 50 50 Z")\n';

  it("lists end points and control points with guides", () => {
    const r = compile(PATH);
    const hs = pointHandles(r.scene, findShape(r.scene, "p")!)!;
    expect(hs.map((h) => [h.kind, h.x, h.y])).toEqual([
      ["end", 10, 10],
      ["end", 50.5, 10],
      ["control", 60, 30],
      ["end", 50, 50],
    ]);
    expect(hs[2].guides).toEqual([
      { x: 50.5, y: 10 },
      { x: 50, y: 50 },
    ]);
  });

  it("changes only the dragged numbers, keeping their decimals", () => {
    const r = compile(PATH);
    const e = movePoint({ source: PATH, scene: r.scene }, "p", 1, 4.26, -2);
    expect(applyEdits(PATH, e.edits)).toContain('d="M 10 10 L 54.8 8 Q 60 30 50 50 Z"');
  });

  it("keeps the next relative command in place", () => {
    const src = CANVAS + 'p is path(d="M 10 10 l 20 0 l 0 20")\n';
    const r = compile(src);
    const e = movePoint({ source: src, scene: r.scene }, "p", 1, 5, 5);
    expect(applyEdits(src, e.edits)).toContain('d="M 10 10 l 25 5 l -5 15"');
  });

  it("handles points of shapes placed with x / y", () => {
    const src = CANVAS + 't is polygon(x=100, y=100, points="0,0 20,0 10,20")\n';
    const r = compile(src);
    const shape = findShape(r.scene, "t")!;
    expect(pointHandles(r.scene, shape)!.map((h) => [h.x, h.y])).toEqual([
      [100, 100],
      [120, 100],
      [110, 120],
    ]);
    const e = movePoint({ source: src, scene: r.scene }, "t", 2, 0, 10);
    expect(applyEdits(src, e.edits)).toContain('points="0,0 20,0 10,30"');
  });

  it("previews the new geometry where the shape is drawn", () => {
    const src = CANVAS + 't is polygon(x=100, y=100, points="0,0 20,0 10,20")\n';
    const r = compile(src);
    const shape = findShape(r.scene, "t")!;
    const text = movedPointsText(shape, 2, 0, 10)!;
    expect(text).toBe("0,0 20,0 10,30");
    expect(previewGeometry(r.scene, shape, text)).toEqual({ attr: "points", value: "100,100 120,100 110,130" });
  });

  it("refuses points that come from a parameter", () => {
    const src = CANVAS + 's is shape(d):\n  path(d=d)\n\na is s(d="M 0 0 L 10 10")\n';
    const r = compile(src);
    expect(pointHandles(r.scene, findShape(r.scene, "a")!)).toBeNull();
  });
});
