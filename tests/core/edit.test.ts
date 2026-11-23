import { describe, expect, it } from "vitest";
import {
  applyEdits,
  compile,
  deleteShape,
  insertShape,
  moveShape,
  reorderShape,
  resizeShape,
  toJsonCanvas,
  type EditResult,
} from "../../src/core";

const CANVAS = "canvas(width=400, height=200)\n";

/** Compiles, runs an edit, applies it, and checks the result still compiles cleanly. */
function edit(source: string, op: (t: { source: string; scene: ReturnType<typeof compile>["scene"] }) => EditResult) {
  const { scene } = compile(source);
  const result = op({ source, scene });
  const text = applyEdits(source, result.edits);
  return { text, result, after: compile(text) };
}

describe("move", () => {
  it("changes only the numbers, keeping comments and spacing", () => {
    const src = CANVAS + "# my box\na is rect(x=20,   y=30, width=10, height=10)  # keep me\n";
    const { text } = edit(src, (t) => moveShape(t, "a", 45, 30));
    expect(text).toBe(CANVAS + "# my box\na is rect(x=45,   y=30, width=10, height=10)  # keep me\n");
  });

  it("keeps the unit (percent stays percent) and the alias name", () => {
    const src = CANVAS + "a is rect(left=10%, top=20, width=10, height=10)";
    const { text } = edit(src, (t) => moveShape(t, "a", 80, 50));
    expect(text).toBe(CANVAS + "a is rect(left=20%, top=50, width=10, height=10)");
  });

  it("adds a position in the default unit when there is none", () => {
    const src = CANVAS + "a is rect(width=10, height=10)";
    expect(edit(src, (t) => moveShape(t, "a", 40, 20)).text).toBe(CANVAS + "a is rect(width=10, height=10, x=10%, y=10%)");
    expect(edit(src, (t) => moveShape(t, "a", 40, 20, { defaultUnit: "pixel" })).text).toBe(CANVAS + "a is rect(width=10, height=10, x=40, y=20)");
  });

  it("adds new attributes on their own line in the multi-line form", () => {
    const src = CANVAS + "a is rect(\n  width=10\n  height=10\n)";
    expect(edit(src, (t) => moveShape(t, "a", 40, 0, { defaultUnit: "pixel" })).text).toBe(CANVAS + "a is rect(\n  width=10\n  height=10\n  x=40\n)");
  });

  it("replaces an anchor only on the axis that moved, with a notice", () => {
    const src = CANVAS + "a is rect(x=0, y=0, width=10, height=10)\nb is rect(right-of=a 10, below=a 5, width=10, height=10)";
    const { text, result } = edit(src, (t) => moveShape(t, "b", 50, 15, { defaultUnit: "pixel" }));
    expect(text).toContain("b is rect(x=50, below=a 5, width=10, height=10)");
    expect(result.notices[0]).toMatch(/right-of/);
  });

  it("writes `right` for shapes placed from the right edge", () => {
    const src = CANVAS + "a is rect(right=20, y=0, width=100, height=10)";
    expect(edit(src, (t) => moveShape(t, "a", 250, 0)).text).toBe(CANVAS + "a is rect(right=50, y=0, width=100, height=10)");
  });

  it("keeps the size of a stretched shape", () => {
    const src = CANVAS + "a is rect(left=10%, right=10%, y=0, height=10)";
    const { text, after } = edit(src, (t) => moveShape(t, "a", 80, 0));
    expect(text).toBe(CANVAS + "a is rect(left=20%, right=0%, y=0, height=10)");
    expect(after.diagnostics).toEqual([]);
  });

  it("moves a child inside a group in the group's coordinates", () => {
    const src = CANVAS + "g is group(x=100, y=50):\n  r is rect(x=10, y=10, width=10, height=10)";
    expect(edit(src, (t) => moveShape(t, "g.r", 130, 60)).text).toBe(CANVAS + "g is group(x=100, y=50):\n  r is rect(x=30, y=10, width=10, height=10)");
  });

  it("writes cx for circles placed by center, and the anchor point for centered text", () => {
    expect(edit(CANVAS + "c is circle(cx=50, cy=50, r=10)", (t) => moveShape(t, "c", 60, 40)).text).toBe(CANVAS + "c is circle(cx=70, cy=50, r=10)");
    const txt = CANVAS + 't is text("Hi", x=100, y=10, align=middle)';
    // "Hi" is 19.2 wide in tests, so the box starts at 90.4. Moving the box to 140 puts the
    // middle (the written x) at 149.6, rounded to 150.
    const { text } = edit(txt, (t) => moveShape(t, "t", 140, 10));
    expect(text).toBe(CANVAS + 't is text("Hi", x=150, y=10, align=middle)');
  });

  it("moves a custom shape instance, not its parts", () => {
    const src = CANVAS + "s is shape():\n  r is rect(width=10, height=10)\none is s(x=5, y=5)";
    expect(edit(src, (t) => moveShape(t, "one.r", 25, 5)).text).toContain("one is s(x=25, y=5)");
  });

  it("moves free lines, not connected ones", () => {
    const free = CANVAS + "l is line(x1=10, y1=10, x2=50, y2=10)";
    expect(edit(free, (t) => moveShape(t, "l", 20, 30)).text).toBe(CANVAS + "l is line(x1=20, y1=30, x2=60, y2=30)");
    const conn = CANVAS + "a is rect(width=1, height=1)\nb is rect(x=10, width=1, height=1)\nl is line(from=a, to=b)";
    const { text, result } = edit(conn, (t) => moveShape(t, "l", 50, 50));
    expect(text).toBe(conn);
    expect(result.notices).toHaveLength(1);
  });
});

describe("resize", () => {
  it("changes position and size of a rect", () => {
    const src = CANVAS + "a is rect(x=20, y=20, width=100, height=50)";
    expect(edit(src, (t) => resizeShape(t, "a", { x: 10, y: 20, w: 110, h: 60 })).text).toBe(CANVAS + "a is rect(x=10, y=20, width=110, height=60)");
  });

  it("keeps a right-of anchor when only the far edge moves", () => {
    const src = CANVAS + "a is rect(width=10, height=10)\nb is rect(right-of=a 10, y=0, width=50, height=10)";
    const { text, result } = edit(src, (t) => resizeShape(t, "b", { x: 20, y: 0, w: 80, h: 10 }));
    expect(text).toContain("b is rect(right-of=a 10, y=0, width=80, height=10)");
    expect(result.notices).toEqual([]);
  });

  it("sets r for a circle", () => {
    expect(edit(CANVAS + "c is circle(x=0, y=0, r=10)", (t) => resizeShape(t, "c", { x: 0, y: 0, w: 40, h: 50 })).text).toBe(CANVAS + "c is circle(x=0, y=0, r=20)");
  });

  it("only moves an auto-sized group, with a notice", () => {
    const src = CANVAS + "g is group(x=0):\n  r is rect(width=10, height=10)";
    const { result } = edit(src, (t) => resizeShape(t, "g", { x: 0, y: 0, w: 50, h: 50 }));
    expect(result.notices[0]).toMatch(/comes from its children/);
  });
});

describe("delete", () => {
  it("removes the whole block with its children", () => {
    const src = CANVAS + "a is rect()\ng is group():\n  r is rect()\n  s is rect()\nb is rect()\n";
    expect(edit(src, (t) => deleteShape(t, "g")).text).toBe(CANVAS + "a is rect()\nb is rect()\n");
  });

  it("removes the last line without leaving a blank line", () => {
    const src = CANVAS + "a is rect()\nb is rect()";
    expect(edit(src, (t) => deleteShape(t, "b")).text).toBe(CANVAS + "a is rect()");
  });

  it("warns about references", () => {
    const src = CANVAS + "a is rect(width=1, height=1)\nb is rect(right-of=a 1)";
    expect(edit(src, (t) => deleteShape(t, "a")).result.notices[0]).toMatch(/used by `b`/);
  });
});

describe("reorder", () => {
  const src = CANVAS + "a is rect()\nb is rect()\nc is rect()\n";

  it.each([
    ["a", "front", "b is rect()\nc is rect()\na is rect()\n"],
    ["c", "back", "c is rect()\na is rect()\nb is rect()\n"],
    ["a", "forward", "b is rect()\na is rect()\nc is rect()\n"],
    ["c", "backward", "a is rect()\nc is rect()\nb is rect()\n"],
  ] as const)("%s to %s", (name, where, expected) => {
    expect(edit(src, (t) => reorderShape(t, name, where)).text).toBe(CANVAS + expected);
  });

  it("works when the last line has no newline", () => {
    const s = CANVAS + "a is rect()\nb is rect()";
    expect(edit(s, (t) => reorderShape(t, "a", "front")).text).toBe(CANVAS + "b is rect()\na is rect()");
    expect(edit(s, (t) => reorderShape(t, "b", "back")).text).toBe(CANVAS + "b is rect()\na is rect()");
  });

  it("moves a group with its children and keeps them indented", () => {
    const s = CANVAS + "g is group():\n  r is rect()\nb is rect()\n";
    expect(edit(s, (t) => reorderShape(t, "g", "front")).text).toBe(CANVAS + "b is rect()\ng is group():\n  r is rect()\n");
  });

  it("does nothing at the end, with a notice", () => {
    const { text, result } = edit(src, (t) => reorderShape(t, "c", "front"));
    expect(text).toBe(src);
    expect(result.notices).toHaveLength(1);
  });
});

describe("insert", () => {
  it("adds a uniquely named shape in percent", () => {
    const src = CANVAS + "rect1 is rect()";
    const { text, result, after } = edit(src, (t) => insertShape(t, "rect", { x: 40, y: 20, w: 80, h: 40 }));
    expect(text).toBe(CANVAS + "rect1 is rect()\nrect2 is rect(x=10%, y=10%, width=20%, height=20%)\n");
    expect(result.select).toBe("rect2");
    expect(after.diagnostics).toEqual([]);
  });
});

describe("json canvas", () => {
  it("maps boxes to nodes and connected lines to edges", () => {
    const src = CANVAS + 'a is rect(x=10, y=10, width=50, height=20, fill=#f00)\nt is text("Hello", x=100, y=10)\nline(from=a, to=t, arrow=end, label="x")\np is path(d="M 0 0 L 5 5")';
    const { canvas, warnings } = toJsonCanvas(compile(src).scene);
    expect(canvas.nodes[0]).toMatchObject({ type: "text", x: 10, y: 10, width: 50, height: 20, color: "#ff0000" });
    expect(canvas.nodes[1]).toMatchObject({ type: "text", text: "Hello" });
    expect(canvas.edges[0]).toMatchObject({ fromNode: canvas.nodes[0].id, toNode: canvas.nodes[1].id, toEnd: "arrow", label: "x" });
    expect(warnings).toHaveLength(1);
  });
});

describe("performance", () => {
  it("compiles 2000 shapes quickly", () => {
    const lines = [CANVAS];
    for (let i = 0; i < 2000; i++) lines.push(i % 2 ? `r${i} is rect(right-of=r${i - 1} 2, y=${i % 50}, width=5, height=5)` : `r${i} is rect(x=${i}, y=0, width=5, height=5)`);
    const start = performance.now();
    const { diagnostics } = compile(lines.join("\n"));
    const ms = performance.now() - start;
    expect(diagnostics).toEqual([]);
    expect(ms).toBeLessThan(1500);
  });
});
