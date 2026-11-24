import { describe, expect, it } from "vitest";
import { applyEdits, brokenReferences, compile, insertShape, intoLayer, layerTree, moveShapeTo, newLayer, type DropPlace } from "../../src/core";

const CANVAS = "canvas(width=400, height=200)\n";

function codes(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.code);
}

describe("layer", () => {
  it("is drawn as a plain group", () => {
    const r = compile(CANVAS + "back is layer(fill=red):\n  a is rect(x=10, y=10, width=50, height=30)");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<g fill="red">\n    <rect x="10" y="10" width="50" height="30" />\n  </g>');
    expect(r.scene.roots[0].layer).toBe(true);
    expect(r.scene.roots[0].type).toBe("group");
  });

  it("covers the canvas without a size, so percent works inside", () => {
    const r = compile(CANVAS + "back is layer():\n  sky is rect(width=100%, height=50%)\n  dot is circle(x=50%, y=50%, r=5)");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<rect x="0" y="0" width="400" height="100" />');
    expect(r.svg).toContain('<circle cx="205" cy="105" r="5" />');
  });

  it("keeps a written size and position", () => {
    const r = compile(CANVAS + "side is layer(x=200, width=200, height=100):\n  r is rect(width=50%, height=100%)");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<g transform="translate(200,0)">');
    expect(r.svg).toContain('<rect x="0" y="0" width="100" height="100" />');
  });

  it("has no size on an infinite canvas (like a group)", () => {
    const r = compile("canvas(infinite)\nback is layer():\n  r is rect(width=50%, height=10)");
    expect(r.diagnostics.map((d) => d.code)).toContain("ZYX204");
  });

  it("can hold groups, and unnamed layers get a layer path", () => {
    const r = compile(CANVAS + "layer():\n  g is group():\n    r is rect(width=10, height=10)");
    expect(r.diagnostics).toEqual([]);
    expect(r.scene.roots[0].path).toMatch(/^layer#\d+$/);
    expect(r.scene.roots[0].children[0].name).toBe("g");
  });

  it("is refused inside a group, another layer or a custom shape, and still drawn as a group", () => {
    expect(codes(CANVAS + "g is group():\n  l is layer()")).toEqual(["ZYX124"]);
    const nested = compile(CANVAS + "a is layer():\n  b is layer():\n    r is rect(width=10, height=10)");
    expect(nested.diagnostics.map((d) => d.message)[0]).toContain("not inside another layer");
    expect(nested.svg).toContain('<rect x="0" y="0" width="10" height="10" />');
    expect(nested.scene.roots[0].children[0].layer).toBeUndefined();
    expect(codes(CANVAS + "card is shape():\n  l is layer()\n  r is rect(width=10, height=10)\nc is card()")).toEqual(["ZYX124"]);
  });

  it("is a reserved word", () => {
    expect(codes(CANVAS + "layer is rect(width=10, height=10)")).toEqual(["ZYX014"]);
  });
});

function target(source: string) {
  const r = compile(source);
  return { source, scene: r.scene, tree: r.tree, diagnostics: r.diagnostics };
}

describe("new shapes in the active layer", () => {
  it("go at the end of the layer's block, indented, with the same place on the canvas", () => {
    const src = CANVAS + "back is layer():\n  sky is rect(width=100%, height=50%)\nfront is rect(x=0, y=0, width=10, height=10)\n";
    const t = target(src);
    const r = intoLayer(t, insertShape(t, "rect", { x: 40, y: 20, w: 80, h: 40 }), "back");
    const text = applyEdits(src, r.edits);
    expect(text).toBe(
      CANVAS + "back is layer():\n  sky is rect(width=100%, height=50%)\n  rect1 is rect(x=10%, y=10%, width=20%, height=20%)\nfront is rect(x=0, y=0, width=10, height=10)\n",
    );
    expect(r.select).toBe("back.rect1");
    expect(compile(text).diagnostics).toEqual([]);
  });

  it("open the block of an empty layer, and take a free name inside it", () => {
    const src = CANVAS + "rect1 is rect(width=5, height=5)\nempty is layer()\n";
    const t = target(src);
    const text = applyEdits(src, intoLayer(t, insertShape(t, "rect", { x: 0, y: 0, w: 40, h: 20 }), "empty").edits);
    expect(text).toContain("empty is layer():\n  rect2 is rect(");
    const busy = CANVAS + "l is layer():\n  rect1 is rect(width=5, height=5)\n";
    const tb = target(busy);
    const r = intoLayer(tb, insertShape(tb, "rect", { x: 0, y: 0, w: 40, h: 20 }), "l");
    expect(r.select).toBe("l.rect2");
  });

  it("keep their place in a layer that is moved and sized", () => {
    const src = CANVAS + "side is layer(x=200, y=100, width=200, height=100)\n";
    const t = target(src);
    const text = applyEdits(src, intoLayer(t, insertShape(t, "rect", { x: 240, y: 120, w: 40, h: 20 }), "side").edits);
    const r = compile(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<g transform="translate(200,100)">');
    expect(r.svg).toContain('<rect x="40" y="20" width="40" height="20" />');
  });

  it("leaves the edit alone for a path that is not a layer", () => {
    const src = CANVAS + "g is group():\n  a is rect(width=5, height=5)\n";
    const t = target(src);
    const ins = insertShape(t, "rect", { x: 0, y: 0, w: 4, h: 4 });
    expect(intoLayer(t, ins, "g")).toBe(ins);
  });

  it("newLayer appends a free layer name", () => {
    const src = CANVAS + "layer1 is layer()\n";
    const r = newLayer(target(src));
    expect(applyEdits(src, r.edits)).toBe(src + "layer2 is layer()\n");
    expect(compile(applyEdits(src, r.edits)).diagnostics).toEqual([]);
  });
});

describe("layerTree", () => {
  it("lists top-level items front-most first, with layers and groups opened", () => {
    const src =
      CANVAS +
      "box is shape():\n  rect(width=10, height=10)\n" +
      "back is layer(display=none):\n  sky is rect(width=10, height=10)\n  g is group():\n    rect(width=5, height=5)\n" +
      "b is box()\n";
    const tree = layerTree(compile(src).scene);
    expect(tree.map((n) => [n.label, n.kind])).toEqual([
      ["b", "instance"],
      ["back", "layer"],
    ]);
    expect(tree[0].children).toEqual([]);
    const back = tree[1];
    expect(back.hidden).toBe(true);
    expect(back.children.map((n) => n.label)).toEqual(["g", "sky"]);
    expect(back.children[0].children[0]).toMatchObject({ label: "rect", unnamed: true, hiddenByGroup: true });
  });
});

/** Moves a shape and returns the new text, its problems and the SVG. */
function move(source: string, path: string, place: DropPlace) {
  const r = moveShapeTo(target(source), path, place);
  const text = applyEdits(source, r.edits);
  const c = compile(text);
  return { text, r, problems: c.diagnostics.map((d) => d.message), svg: c.svg };
}

describe("moving rows (drag in the layers view)", () => {
  const SRC = CANVAS + "back is layer():\n  sky is rect(width=100%, height=50%)\n  sea is rect(y=50%, width=100%, height=50%)\nfront is layer():\n  sun is circle(x=10, y=10, r=5)\n";

  it("reorders within a layer: after a sibling is in front of it", () => {
    const m = move(SRC, "back.sky", { parent: "back", after: "back.sea" });
    expect(m.text).toBe(CANVAS + "back is layer():\n  sea is rect(y=50%, width=100%, height=50%)\n  sky is rect(width=100%, height=50%)\nfront is layer():\n  sun is circle(x=10, y=10, r=5)\n");
    expect(m.r.select).toBe("back.sky");
  });

  it("reorders top-level layers, and a drop that changes nothing has no edit", () => {
    const m = move(SRC, "front", { parent: null, before: "back" });
    expect(m.text.indexOf("front is layer")).toBeLessThan(m.text.indexOf("back is layer"));
    expect(m.problems).toEqual([]);
    expect(moveShapeTo(target(SRC), "back.sea", { parent: "back", after: "back.sky" }).edits).toEqual([]);
  });

  it("moves into another layer, keeping percent between canvas-sized layers, and closes the emptied block", () => {
    const one = CANVAS + "a is layer():\n  dot is rect(x=10%, y=10%, width=5, height=5)\nb is layer():\n  sun is circle(r=5)\n";
    const m = move(one, "a.dot", { parent: "b" });
    expect(m.text).toBe(CANVAS + "a is layer()\nb is layer():\n  sun is circle(r=5)\n  dot is rect(x=10%, y=10%, width=5, height=5)\n");
    expect(m.r.select).toBe("b.dot");
    expect(m.problems).toEqual([]);
  });

  it("keeps the place on the canvas when the new parent is moved, and takes a free name", () => {
    const src = CANVAS + "dot is rect(x=50, y=40, width=10, height=10)\ng is group(x=30, y=20):\n  dot is rect(width=5, height=5)\n";
    const before = compile(src).svg;
    const m = move(src, "dot", { parent: "g", before: "g.dot" });
    expect(m.text).toContain("  dot1 is rect(x=20, y=20, width=10, height=10)\n  dot is rect(");
    expect(m.problems).toEqual([]);
    expect(before).toContain('<rect x="50" y="40" width="10" height="10" />');
    expect(m.svg).toContain('<rect x="20" y="20" width="10" height="10" />');
    expect(m.svg).toContain('<g transform="translate(30,20)">');
  });

  it("opens an empty layer's block", () => {
    const src = CANVAS + "dot is rect(width=5, height=5)\nempty is layer()\nother is rect(width=1, height=1)\n";
    const m = move(src, "dot", { parent: "empty" });
    expect(m.text).toBe(CANVAS + "empty is layer():\n  dot is rect(width=5, height=5)\nother is rect(width=1, height=1)\n");
  });

  it("refuses a layer into a group, a group into itself, and a shape into a non-group", () => {
    const src = CANVAS + "l is layer()\ng is group():\n  h is group():\n    r is rect(width=1, height=1)\nx is rect(width=1, height=1)\n";
    expect(moveShapeTo(target(src), "l", { parent: "g" }).notices[0]).toContain("top level");
    expect(moveShapeTo(target(src), "g", { parent: "g.h" }).notices[0]).toContain("inside itself");
    expect(moveShapeTo(target(src), "g.h.r", { parent: "x" }).notices[0]).toContain("Only a layer or a group");
  });
});

describe("brokenReferences", () => {
  const SRC = CANVAS + "back is layer():\n  sky is rect(width=50, height=20)\nfront is layer():\n  box is rect(right-of=back.sky 10, width=20, height=20)\n";

  it("is empty for a reorder, and lists references a move to another layer breaks", () => {
    const reorder = applyEdits(SRC, moveShapeTo(target(SRC), "front", { parent: null, before: "back" }).edits);
    expect(brokenReferences(SRC, reorder)).toEqual([]);
    const moved = applyEdits(SRC, moveShapeTo(target(SRC), "back.sky", { parent: "front" }).edits);
    const broken = brokenReferences(SRC, moved);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatch(/^Line \d+: Unknown shape `back.sky`/);
  });

  it("does not repeat problems the text already had", () => {
    const bad = SRC + "x is rect(right-of=nothing, width=1, height=1)\n";
    expect(brokenReferences(bad, bad)).toEqual([]);
  });
});
