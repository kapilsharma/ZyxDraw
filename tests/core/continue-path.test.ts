// Continuing an open path or polyline from either end (issue #34): only the new part is written,
// at the end of `d` / `points` or at its start.
import { describe, expect, it } from "vitest";
import { applyEdits, compile, continuePath, openEnds, type PenNode, type Shape } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const fmt = (n: number) => String(Math.round(n * 100) / 100);

function shapeOf(source: string, path: string): { source: string; shape: Shape; scene: ReturnType<typeof compile>["scene"] } {
  const { scene } = compile(source);
  const find = (list: Shape[]): Shape | undefined => {
    for (const s of list) {
      if (s.path === path) return s;
      const inner = find(s.children ?? []);
      if (inner) return inner;
    }
    return undefined;
  };
  const shape = find(scene.roots);
  if (!shape) throw new Error(`no shape ${path}`);
  return { source, shape, scene };
}

/** Continues `path` and returns the new text, failing on notices. */
function cont(body: string, path: string, at: "start" | "end", nodes: PenNode[], close = false): string {
  const source = CANVAS + body;
  const { scene } = compile(source);
  const edit = continuePath({ source, scene }, path, at, nodes, close, fmt);
  expect(edit.notices).toEqual([]);
  expect(edit.select).toBe(path);
  const out = applyEdits(source, edit.edits);
  expect(compile(out).diagnostics).toEqual([]);
  return out.slice(CANVAS.length);
}

const notices = (body: string, path: string, at: "start" | "end", nodes: PenNode[], close = false) => {
  const source = CANVAS + body;
  const edit = continuePath({ source, scene: compile(source).scene }, path, at, nodes, close, fmt);
  expect(edit.edits).toEqual([]);
  return edit.notices;
};

const LINE = 'p is path(d="M 10,10 L 50,10", fill=none, stroke=black)';

describe("continuing a path at its end", () => {
  it("adds straight sides after the last point", () => {
    expect(cont(LINE, "p", "end", [{ x: 50, y: 10 }, { x: 50, y: 50 }, { x: 90, y: 50 }])).toBe(
      'p is path(d="M 10,10 L 50,10 L 50,50 L 90,50", fill=none, stroke=black)',
    );
  });

  it("adds curves for smooth points, and for a handle pulled out of the end", () => {
    const smooth: PenNode = { x: 80, y: 40, in: { x: 70, y: 40 }, out: { x: 90, y: 40 } };
    expect(cont(LINE, "p", "end", [{ x: 50, y: 10, out: { x: 60, y: 10 } }, smooth, { x: 120, y: 10 }])).toBe(
      'p is path(d="M 10,10 L 50,10 C 60,10 70,40 80,40 S 120,10 120,10", fill=none, stroke=black)',
    );
  });

  it("closes the path on the other end", () => {
    expect(cont(LINE, "p", "end", [{ x: 50, y: 10 }, { x: 30, y: 40 }], true)).toBe('p is path(d="M 10,10 L 50,10 L 30,40 Z", fill=none, stroke=black)');
    expect(cont(LINE, "p", "end", [{ x: 50, y: 10 }, { x: 30, y: 40, in: { x: 40, y: 40 }, out: { x: 20, y: 40 } }], true)).toBe(
      'p is path(d="M 10,10 L 50,10 C 50,10 40,40 30,40 S 10,10 10,10 Z", fill=none, stroke=black)',
    );
  });

  it("keeps everything else as written: spacing, commas, comments", () => {
    const body = 'p is path(d="M10 10  L50 10", stroke=red)   # my path';
    expect(cont(body, "p", "end", [{ x: 50, y: 10 }, { x: 50, y: 50 }])).toBe('p is path(d="M10 10  L50 10 L 50,50", stroke=red)   # my path');
  });
});

describe("continuing a path at its start", () => {
  it("puts the new points first, drawn towards the old start", () => {
    expect(cont(LINE, "p", "start", [{ x: 10, y: 10 }, { x: 10, y: 50 }, { x: 40, y: 80 }])).toBe(
      'p is path(d="M 40,80 L 10,50 L 10,10 L 50,10", fill=none, stroke=black)',
    );
  });

  it("turns handles around, so curves look the same as drawn", () => {
    const smooth: PenNode = { x: 10, y: 50, in: { x: 0, y: 40 }, out: { x: 20, y: 60 } };
    expect(cont(LINE, "p", "start", [{ x: 10, y: 10, out: { x: 0, y: 20 } }, smooth])).toBe(
      'p is path(d="M 10,50 C 0,40 0,20 10,10 L 50,10", fill=none, stroke=black)',
    );
  });

  it("keeps pairs written after `M` as lines", () => {
    expect(cont('p is path(d="M 10,10 50,10 50,40", fill=none)', "p", "start", [{ x: 10, y: 10 }, { x: 10, y: 50 }])).toBe(
      'p is path(d="M 10,50 L 10,10 L 50,10 50,40", fill=none)',
    );
  });

  it("closes the path on the other end", () => {
    expect(cont(LINE, "p", "start", [{ x: 10, y: 10 }, { x: 30, y: 40 }], true)).toBe('p is path(d="M 30,40 L 10,10 L 50,10 Z", fill=none, stroke=black)');
  });
});

describe("continuing a polyline", () => {
  it("adds points at the end or the start, with the separators already used", () => {
    expect(cont('w is polyline(points="10,10 50,10")', "w", "end", [{ x: 50, y: 10 }, { x: 50, y: 50 }, { x: 90, y: 50 }])).toBe(
      'w is polyline(points="10,10 50,10 50,50 90,50")',
    );
    expect(cont('w is polyline(points="10 10, 50 10")', "w", "start", [{ x: 10, y: 10 }, { x: 10, y: 50 }, { x: 40, y: 80 }])).toBe(
      'w is polyline(points="40 80, 10 50, 10 10, 50 10")',
    );
  });

  it("cannot be closed", () => {
    expect(notices('w is polyline(points="10,10 50,10")', "w", "end", [{ x: 50, y: 10 }, { x: 30, y: 40 }], true)[0]).toMatch(/change `polyline` to `polygon`/);
  });
});

describe("where a shape is placed", () => {
  it("measures new points from the shape's own numbers (a path in a moved group)", () => {
    const body = 'g is group(x=100, y=20):\n  p is path(d="M 0,0 L 20,0", fill=none, stroke=black)';
    const { shape, scene } = shapeOf(CANVAS + body, "g.p");
    const ends = openEnds(scene, shape)!;
    expect(ends.map((e) => [e.at, e.x, e.y])).toEqual([
      ["start", 100, 20],
      ["end", 120, 20],
    ]);
    expect(cont(body, "g.p", "end", [{ x: 120, y: 20 }, { x: 120, y: 60 }])).toBe(
      'g is group(x=100, y=20):\n  p is path(d="M 0,0 L 20,0 L 20,40", fill=none, stroke=black)',
    );
  });

  it("gives the ends' point indexes, past curve handles", () => {
    const { shape, scene } = shapeOf(CANVAS + 'p is path(d="M 10,10 C 20,0 40,0 50,10 L 80,10", fill=none)', "p");
    expect(openEnds(scene, shape)!.map((e) => e.point)).toEqual([0, 4]);
  });
});

describe("shapes that cannot be continued", () => {
  const none = (body: string, path: string) => {
    const { shape, scene } = shapeOf(CANVAS + body, path);
    return openEnds(scene, shape);
  };

  it("has no open ends: closed paths, polygons, several parts, calculations, turned shapes", () => {
    expect(none('p is path(d="M 10,10 L 50,10 L 30,40 Z")', "p")).toBeNull();
    expect(none('p is polygon(points="10,10 50,10 30,40")', "p")).toBeNull();
    expect(none('p is path(d="M 10,10 L 50,10 M 60,60 L 80,80", fill=none)', "p")).toBeNull();
    expect(none('p is path(d="M 10,10 L (20 + 30),10", fill=none)', "p")).toBeNull();
    expect(none('p is path(d="M 10,10 L 50,10", fill=none, rotate=30)', "p")).toBeNull();
    expect(none('p is rect(width=20, height=20)', "p")).toBeNull();
  });

  it("explains why, and changes nothing", () => {
    expect(notices('p is path(d="M 10,10 L 50,10 L 30,40 Z")', "p", "end", [{ x: 30, y: 40 }, { x: 0, y: 0 }])[0]).toMatch(/cannot|can be continued/);
    expect(notices(LINE, "p", "end", [{ x: 50, y: 10 }])[0]).toMatch(/at least one new point/);
  });
});
