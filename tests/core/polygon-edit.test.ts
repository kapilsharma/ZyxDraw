import { describe, expect, it } from "vitest";
import { applyEdits, compile, deletePoint, insertedPointsText, insertPoint, insertPolygon, findShape, type EditResult } from "../../src/core";

const CANVAS = "canvas(width=200, height=200)\n";
const fmt = (n: number) => String(Math.round(n * 10) / 10);

function run(source: string, op: (t: { source: string; scene: ReturnType<typeof compile>["scene"] }) => EditResult): { text: string; notices: string[] } {
  const r = compile(source);
  const e = op({ source, scene: r.scene });
  return { text: applyEdits(source, e.edits), notices: e.notices };
}

describe("new polygon", () => {
  it("adds a named polygon at the end and selects it", () => {
    const src = CANVAS + "polygon1 is polygon(points=\"0,0 1,0 1,1\")";
    const r = compile(src);
    const e = insertPolygon({ source: src, scene: r.scene }, [{ x: 10, y: 10 }, { x: 100.04, y: 10 }, { x: 55, y: 90.25 }], fmt);
    expect(applyEdits(src, e.edits)).toBe(src + '\npolygon2 is polygon(points="10,10 100,10 55,90.3")\n');
    expect(e.select).toBe("polygon2");
    expect(compile(applyEdits(src, e.edits)).diagnostics).toEqual([]);
  });

  it("needs 3 points", () => {
    const r = compile(CANVAS);
    const e = insertPolygon({ source: CANVAS, scene: r.scene }, [{ x: 0, y: 0 }, { x: 5, y: 5 }], fmt);
    expect(e.edits).toEqual([]);
    expect(e.notices[0]).toContain("at least 3 points");
  });
});

describe("adding points", () => {
  const SRC = CANVAS + 'p is polygon(fill=red, points="10,10 100,10 100,90")\n';

  it("adds a point in the middle of a side, keeping the text's separators", () => {
    expect(run(SRC, (t) => insertPoint(t, "p", 0, 0, 0, fmt)).text).toContain('points="10,10 55,10 100,10 100,90"');
    expect(run(SRC, (t) => insertPoint(t, "p", 1, -3, 0, fmt)).text).toContain('points="10,10 100,10 97,50 100,90"');
  });

  it("adds a point on the closing side of a polygon", () => {
    expect(run(SRC, (t) => insertPoint(t, "p", 2, 0, 0, fmt)).text).toContain('points="10,10 100,10 100,90 55,50"');
  });

  it("uses spaces when the points are written with spaces", () => {
    const src = CANVAS + 'q is polyline(points="0 0  40 0")\n';
    expect(run(src, (t) => insertPoint(t, "q", 0, 0, 5, fmt)).text).toContain('points="0 0  20 5  40 0"');
    // A polyline has no closing side.
    expect(run(src, (t) => insertPoint(t, "q", 1, 0, 0, fmt)).notices[0]).toContain("side cannot be found");
  });

  it("previews the new text", () => {
    const shape = findShape(compile(SRC).scene, "p")!;
    expect(insertedPointsText(shape, 0, 0, 5, fmt)).toBe("10,10 55,15 100,10 100,90");
  });

  it("refuses paths with relative commands and points that come from a parameter", () => {
    const path = CANVAS + 'a is path(d="M 0 0 l 10 10")\n';
    expect(run(path, (t) => insertPoint(t, "a", 0, 0, 0, fmt)).text).toBe(path);
    const param = CANVAS + 'tri is shape(pts="0,0 10,0 5,5"):\n  polygon(points=pts)\nt is tri()\n';
    expect(run(param, (t) => insertPoint(t, "t", 0, 0, 0, fmt)).text).toBe(param);
  });
});

describe("deleting points", () => {
  const SRC = CANVAS + 'p is polygon(points="10,10 100,10 100,90 10,90")\n';

  it("removes a point and its space", () => {
    expect(run(SRC, (t) => deletePoint(t, "p", 0)).text).toContain('points="100,10 100,90 10,90"');
    expect(run(SRC, (t) => deletePoint(t, "p", 1)).text).toContain('points="10,10 100,90 10,90"');
    expect(run(SRC, (t) => deletePoint(t, "p", 3)).text).toContain('points="10,10 100,10 100,90"');
  });

  it("keeps at least 3 points on a polygon and 2 on a polyline", () => {
    const tri = CANVAS + 'p is polygon(points="0,0 10,0 5,5")\n';
    const r = run(tri, (t) => deletePoint(t, "p", 1));
    expect(r.text).toBe(tri);
    expect(r.notices[0]).toContain("at least 3 points");
    const line = CANVAS + 'q is polyline(points="0,0 10,0 20,5")\n';
    expect(run(line, (t) => deletePoint(t, "q", 2)).text).toContain('points="0,0 10,0"');
    expect(run(CANVAS + 'q is polyline(points="0,0 10,0")\n', (t) => deletePoint(t, "q", 0)).notices[0]).toContain("at least 2 points");
  });
});
