import { describe, expect, it } from "vitest";
import { applyEdits, compile, copyText, deleteShapes, duplicateShapes, findShape, geometry, groupShapes, moveShapes, pasteText, ungroupShape } from "../../src/core";

const CANVAS = "canvas(width=400, height=200)\n";

function target(src: string) {
  return { source: src, scene: compile(src).scene };
}

/** Frame boxes of named shapes, rounded, to check that nothing moved on the canvas. */
function boxes(src: string, paths: string[]) {
  const r = compile(src);
  expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  return paths.map((p) => {
    const s = findShape(r.scene, p);
    const b = s && geometry(r.scene, s)?.box;
    return b && [b.x, b.y, b.w, b.h].map((n) => Math.round(n * 100) / 100);
  });
}

describe("several shapes", () => {
  it("moves and deletes them together", () => {
    const src = CANVAS + "a is rect(x=10, y=10, width=20, height=20)\nb is circle(cx=100, cy=50, r=5)\nc is rect(x=0, y=0, width=1, height=1)\n";
    const moved = applyEdits(src, moveShapes(target(src), ["a", "b"], 5, -5).edits);
    expect(moved).toBe(CANVAS + "a is rect(x=15, y=5, width=20, height=20)\nb is circle(cx=105, cy=45, r=5)\nc is rect(x=0, y=0, width=1, height=1)\n");
    expect(applyEdits(src, deleteShapes(target(src), ["a", "b"]).edits)).toBe(CANVAS + "c is rect(x=0, y=0, width=1, height=1)\n");
  });

  it("skips a shape whose group is also selected", () => {
    const src = CANVAS + "g is group(x=10):\n  a is rect(width=5, height=5)\n";
    expect(applyEdits(src, deleteShapes(target(src), ["g", "g.a"]).edits)).toBe(CANVAS);
  });
});

describe("copy and paste", () => {
  it("copies the text of shapes, children included", () => {
    const src = CANVAS + "# note\ng is group(x=10):\n  a is rect(width=5, height=5)\nb is circle(r=5)\n";
    expect(copyText(target(src), ["b", "g"])).toBe("g is group(x=10):\n  a is rect(width=5, height=5)\nb is circle(r=5)\n");
  });

  it("copies a shape inside a group at its place on the canvas, in pixels", () => {
    const src = CANVAS + "g is group(x=100, y=20, width=200, height=100):\n  a is rect(x=10%, y=10, width=50%, height=20)\n";
    const text = copyText(target(src), ["g.a"])!;
    expect(text).toBe("a is rect(x=120, y=30, width=100, height=20)\n");
  });

  it("pastes next to the originals with new names, and keeps references between pasted shapes", () => {
    const src = CANVAS + "a is rect(x=10, y=10, width=20, height=20)\nb is rect(right-of=a 10, y=10, width=20, height=20)\n";
    const t = target(src);
    const edit = pasteText(t, copyText(t, ["a", "b"])!);
    const out = applyEdits(src, edit.edits);
    expect(out).toBe(src + "a1 is rect(x=20, y=20, width=20, height=20)\nb1 is rect(right-of=a1 10, y=20, width=20, height=20)\n");
    expect(edit.selectPaths).toEqual(["a1", "b1"]);
    expect(boxes(out, ["a1", "b1"])).toEqual([
      [20, 20, 20, 20],
      [50, 20, 20, 20],
    ]);
  });

  it("pastes into another drawing in place, keeping free names, and offsets percent by the canvas", () => {
    const other = CANVAS + "z is rect(width=1, height=1)\n";
    const out = applyEdits(other, pasteText(target(other), "a is rect(x=10%, y=5, width=20, height=20)\n").edits);
    expect(out).toBe(other + "a is rect(x=10%, y=5, width=20, height=20)\n");
    const same = CANVAS + "a is rect(x=10%, y=5, width=20, height=20)\n";
    expect(applyEdits(same, pasteText(target(same), "a is rect(x=10%, y=5, width=20, height=20)").edits)).toBe(same + "a1 is rect(x=12.5%, y=15, width=20, height=20)\n");
  });

  it("gives a path without a position one, moved by the offset", () => {
    const src = CANVAS + 'p is path(d="M 40,50 L 60,80")\n';
    const out = applyEdits(src, pasteText(target(src), 'p is path(d="M 40,50 L 60,80")').edits);
    expect(out).toBe(src + 'p1 is path(d="M 40,50 L 60,80", x=10, y=10)\n');
    expect(boxes(out, ["p1"])).toEqual([[50, 60, 20, 30]]);
  });

  it("moves both ends of a line, and refuses text that is not shapes", () => {
    const src = CANVAS + "l is line(x1=0, y1=0, x2=10, y2=10)\n";
    expect(applyEdits(src, pasteText(target(src), "l is line(x1=0, y1=0, x2=10, y2=10)").edits)).toBe(src + "l1 is line(x1=10, y1=10, x2=20, y2=20)\n");
    expect(pasteText(target(src), "hello there").notices).toEqual(["The clipboard has no ZyxDraw shapes to paste"]);
    expect(pasteText(target(src), "s is style(fill=red)").edits).toEqual([]);
  });
});

describe("duplicate", () => {
  it("adds the copies after the last selected shape, moved and renamed", () => {
    const src = CANVAS + "a is rect(x=10, y=10, width=20, height=20)\nb is circle(cx=50, cy=50, r=5)\nc is rect(x=0, y=0, width=1, height=1)\n";
    const edit = duplicateShapes(target(src), ["a", "b"]);
    expect(applyEdits(src, edit.edits)).toBe(
      CANVAS + "a is rect(x=10, y=10, width=20, height=20)\nb is circle(cx=50, cy=50, r=5)\na1 is rect(x=20, y=20, width=20, height=20)\nb1 is circle(cx=60, cy=60, r=5)\nc is rect(x=0, y=0, width=1, height=1)\n",
    );
    expect(edit.selectPaths).toEqual(["a1", "b1"]);
  });

  it("duplicates inside a group, with the group's indentation", () => {
    const src = CANVAS + "g is group(x=10):\n  box1 is rect(width=5, height=5)\n";
    const edit = duplicateShapes(target(src), ["g.box1"]);
    expect(applyEdits(src, edit.edits)).toBe(CANVAS + "g is group(x=10):\n  box1 is rect(width=5, height=5)\n  box2 is rect(width=5, height=5, x=10, y=10)\n");
    expect(edit.selectPaths).toEqual(["g.box2"]);
  });
});

describe("group and ungroup", () => {
  const src = CANVAS + "a is rect(x=10%, y=10, width=20, height=20)\nmid is circle(r=3)\nb is circle(cx=100, cy=50, r=5)\n";

  it("groups shapes at the frontmost one's place; percent becomes pixels; nothing moves", () => {
    const edit = groupShapes(target(src), ["b", "a"]);
    const out = applyEdits(src, edit.edits);
    expect(out).toBe(CANVAS + "mid is circle(r=3)\ngroup1 is group():\n  a is rect(x=40, y=10, width=20, height=20)\n  b is circle(cx=100, cy=50, r=5)\n");
    expect(edit.select).toBe("group1");
    expect(boxes(out, ["group1.a", "group1.b"])).toEqual(boxes(src, ["a", "b"]));
  });

  it("refuses shapes from different groups", () => {
    const s = CANVAS + "g is group():\n  a is rect(width=5, height=5)\nb is rect(width=5, height=5)\n";
    expect(groupShapes(target(s), ["g.a", "b"]).notices).toEqual(["Shapes in different groups cannot be grouped together"]);
  });

  it("ungroups: children keep their place, get the group's colors, and are renamed when needed", () => {
    const s = CANVAS + "a is rect(width=1, height=1)\ng is group(x=100, y=20, width=200, height=100, fill=red):\n  a is rect(x=10%, y=10, width=20, height=20)\n  b is circle(cx=5, cy=5, r=5, fill=blue)\n";
    const edit = ungroupShape(target(s), "g");
    const out = applyEdits(s, edit.edits);
    expect(out).toBe(CANVAS + "a is rect(width=1, height=1)\na1 is rect(x=120, y=30, width=20, height=20, fill=red)\nb is circle(cx=105, cy=25, r=5, fill=blue)\n");
    expect(edit.selectPaths).toEqual(["a1", "b"]);
    expect(edit.notices).toEqual(["`g.a` is now `a1` (the name was taken)"]);
    expect(boxes(out, ["a1", "b"])).toEqual(boxes(s, ["g.a", "g.b"]));
  });

  it("does not ungroup a turned group or a custom shape", () => {
    const s = CANVAS + "dot is shape():\n  circle(r=2)\ng is group(rotate=10):\n  a is rect(width=5, height=5)\nd is dot()\n";
    expect(ungroupShape(target(s), "g").notices[0]).toMatch(/has `rotate`/);
    expect(ungroupShape(target(s), "d").notices[0]).toMatch(/is a `dot`, not a group/);
  });
});
