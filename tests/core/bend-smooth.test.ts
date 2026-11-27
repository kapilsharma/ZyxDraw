// Bending a side by dragging it, and switching a point between corner and smooth (issue #35).
// Only the sides touched change, in their own case.
import { describe, expect, it } from "vitest";
import { applyEdits, bendableSides, bendSide, compile, pointHandles, pointKind, setPointSmooth, type Shape } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const dOf = (text: string) => /d="([^"]*)"/.exec(text)![1];

function load(body: string, path = "p") {
  const source = CANVAS + body;
  const r = compile(source);
  expect(r.diagnostics).toEqual([]);
  const find = (list: Shape[]): Shape | undefined => {
    for (const s of list) {
      if (s.path === path) return s;
      const inner = find(s.children ?? []);
      if (inner) return inner;
    }
    return undefined;
  };
  return { t: { source, scene: r.scene }, shape: find(r.scene.roots)! };
}

const path = (d: string) => `p is path(d="${d}", fill=none, stroke=black)\n`;

function bend(d: string, side: number, grab: { x: number; y: number }, dx: number, dy: number): string {
  const { t } = load(path(d));
  const e = bendSide(t, "p", side, grab, dx, dy, fmt);
  expect(e.notices).toEqual([]);
  const out = applyEdits(t.source, e.edits);
  expect(compile(out).diagnostics).toEqual([]);
  return dOf(out);
}

/** Handle index of node `node` (the points on the outline only). */
const endIndex = (shape: Shape, scene: ReturnType<typeof compile>["scene"], node: number) =>
  pointHandles(scene, shape)!.map((h, i) => (h.kind === "end" ? i : -1)).filter((i) => i >= 0)[node];

function kind(d: string, node: number) {
  const { t, shape } = load(path(d));
  return pointKind(shape, endIndex(shape, t.scene, node));
}

function smooth(d: string, node: number, on: boolean): string {
  const { t, shape } = load(path(d));
  const e = setPointSmooth(t, "p", endIndex(shape, t.scene, node), on, fmt);
  expect(e.notices).toEqual([]);
  const out = applyEdits(t.source, e.edits);
  expect(compile(out).diagnostics).toEqual([]);
  return dOf(out);
}

describe("bending a side", () => {
  it("turns a straight side into a curve through the dragged spot, in its own case", () => {
    expect(bend("M 0,0 L 30,0", 0, { x: 15, y: 0 }, 0, 30)).toBe("M 0,0 C 10,40 20,40 30,0");
    expect(bend("M 0,0 l 30,0", 0, { x: 15, y: 0 }, 0, 30)).toBe("M 0,0 c 10,40 20,40 30,0");
    expect(bend("M 0 0 H 30", 0, { x: 15, y: 0 }, 0, 30)).toBe("M 0 0 C 10 40 20 40 30 0");
  });

  it("reshapes a curve", () => {
    expect(bend("M 0,0 C 0,20 30,20 30,0", 0, { x: 15, y: 15 }, 0, 10)).toBe("M 0,0 C 0,33.333 30,33.333 30,0");
  });

  it("bends the line drawn by Z: a curve comes before it", () => {
    expect(bend("M 0,0 L 30,0 L 30,30 Z", 2, { x: 15, y: 15 }, -10, 10)).toBe("M 0,0 L 30,0 L 30,30 C 6.667,33.333 -3.333,23.333 0,0 Z");
  });

  it("keeps a following S drawing as before", () => {
    expect(bend("M 0,0 L 30,0 S 60,10 60,0", 0, { x: 15, y: 0 }, 0, 30)).toBe("M 0,0 C 10,40 20,40 30,0 C 30,0 60,10 60,0");
  });

  it("does not bend arcs", () => {
    const { t, shape } = load(path("M 0,0 A 10 10 0 0 1 20,0"));
    expect(bendableSides(t.scene, shape)!.curves).toEqual([null]);
    expect(bendSide(t, "p", 0, { x: 10, y: -10 }, 0, 5, fmt).notices[0]).toMatch(/arc cannot be bent/);
  });

  it("measures the grab from where the path is drawn (a path in a moved group)", () => {
    const { t } = load('g is group(x=100, y=50):\n  p is path(d="M 0,0 L 30,0", fill=none, stroke=black)\n', "g.p");
    const out = applyEdits(t.source, bendSide(t, "g.p", 0, { x: 115, y: 50 }, 0, 30, fmt).edits);
    expect(dOf(out)).toBe("M 0,0 C 10,40 20,40 30,0");
  });
});

describe("corner and smooth points", () => {
  const CORNER = "M 0,0 L 30,0 L 30,30";
  const SMOOTH = "M 0,0 C 0,0 22.929,-7.071 30,0 C 37.071,7.071 30,30 30,30";

  it("makes a corner smooth: handles along the line between its neighbours", () => {
    expect(kind(CORNER, 1)).toBe("corner");
    expect(smooth(CORNER, 1, true)).toBe(SMOOTH);
    expect(kind(SMOOTH, 1)).toBe("smooth");
  });

  it("makes a smooth point a corner: sides with no handle left are lines again", () => {
    expect(smooth(SMOOTH, 1, false)).toBe(CORNER);
  });

  it("keeps a relative path relative", () => {
    expect(smooth("m 0 0 l 30 0 l 0 30", 1, true)).toBe("m 0 0 c 0 0 22.929 -7.071 30 0 c 7.071 7.071 0 30 0 30");
  });

  it("works on the start of a closed path, where Z draws the line back", () => {
    const out = smooth("M 0,0 L 30,0 L 30,30 Z", 0, true);
    expect(out).toBe("M 0,0 C 0,-10 30,0 30,0 L 30,30 C 30,30 0,14.142 0,0 Z");
    expect(kind(out, 0)).toBe("smooth");
  });

  it("cannot switch an end of an open path, or a point next to an arc", () => {
    expect(kind(CORNER, 0)).toBeNull();
    expect(kind(CORNER, 2)).toBeNull();
    expect(kind("M 0,0 A 10 10 0 0 1 20,0 L 40,0", 1)).toBeNull();
    const { t, shape } = load(path(CORNER));
    expect(setPointSmooth(t, "p", endIndex(shape, t.scene, 0), true, fmt).notices[0]).toMatch(/only one side/);
  });

  it("only works on paths", () => {
    const { shape } = load('p is polygon(points="0,0 30,0 30,30")\n');
    expect(pointKind(shape, 1)).toBeNull();
  });
});
