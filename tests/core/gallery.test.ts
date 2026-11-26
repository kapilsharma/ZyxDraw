// A library opened in ZyxDraw: the `preview()` block (#23), the gallery (#24), and editing
// preview values and hiding shapes (#25).
import { describe, expect, it } from "vitest";
import { Code, compile, galleryLayers, propertySheet, setProperty, toggleHidden, type CompileOptions, type Shape } from "../../src/core";

const LIB = "lib/cloud.zyxdl";

const SHAPES = `export ec2, s3

ec2 is shape(label, width=100, height=60):
  body is rect(width=100%, height=100%)
  name is text(label, x=10, y=20)

s3 is shape(label="Bucket", width=80, height=80):
  body is rect(width=100%, height=100%)
  name is text(label, x=10, y=20)

helper is shape(width=40, height=40):
  body is rect(width=100%, height=100%)
`;

const lib = (text: string, options: CompileOptions = {}) => compile(text, { path: LIB, ...options });
const codes = (text: string) => lib(text).diagnostics.map((d) => d.code);
const messages = (text: string) => lib(text).diagnostics.map((d) => d.message);

/** Gallery cells as `def:placeholder`, in order. */
function cells(text: string, options: CompileOptions = {}): string[] {
  return lib(text, options).scene.gallery!.cells.map((c) => `${c.shape.preview!.def}${c.shape.preview!.placeholder ? "*" : ""}`);
}

/** The text of every `<text>` in the SVG. */
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe("preview() block (#23)", () => {
  it("is allowed in a library, without problems", () => {
    expect(lib(`${SHAPES}\npreview():\n  ec2(label="EC2")\n  s3()\n`).diagnostics).toEqual([]);
  });

  it("is an error in a drawing, but `preview` stays a free name there", () => {
    const drawing = compile('canvas(width=100, height=100)\npreview():\n  r is rect(width=1, height=1)\n', { path: "plan.zyxd" });
    expect(drawing.diagnostics.map((d) => d.code)).toEqual([Code.Preview]);
    expect(drawing.diagnostics[0].message).toContain("only for libraries");
    const named = 'canvas(width=100, height=100)\npreview is shape():\n  r is rect(width=10, height=10)\npreview()\nlook is rect(width=5, height=5)\n';
    expect(compile(named, { path: "plan.zyxd" }).diagnostics).toEqual([]);
  });

  it("is one block, without a name or attributes", () => {
    expect(codes(`${SHAPES}\npreview():\n  ec2(label="a")\npreview():\n  s3()\n`)).toEqual([Code.Preview]);
    expect(messages(`${SHAPES}\nexamples is preview():\n  s3()\n`)).toEqual(["`preview()` takes no name: write `preview():`"]);
    expect(codes(`${SHAPES}\npreview(x=1):\n  s3()\n`)).toEqual([Code.Preview]);
  });

  it("holds the library's custom shapes only, without positions", () => {
    expect(messages(`${SHAPES}\npreview():\n  rect(width=10, height=10)\n`)).toEqual(["`preview()` shows the library's custom shapes: use one, such as `ec2(...)`"]);
    expect(codes(`${SHAPES}\npreview():\n  nope()\n`)).toEqual([Code.UnknownType]);
    expect(messages(`${SHAPES}\npreview():\n  s3(x=10, right-of=a 5)\n`)).toEqual([
      "The preview places its shapes itself: leave out `x`",
      "The preview places its shapes itself: leave out `right-of`",
    ]);
  });

  it("can use imported shapes", () => {
    const libraries = new Map([["lib/base.zyxdl", "box is shape(width=20, height=20):\n  r is rect(width=100%, height=100%)\n"]]);
    const r = lib("import box from base\npreview():\n  box()\n", { libraries });
    expect(r.diagnostics).toEqual([]);
    expect(r.scene.gallery!.cells.map((c) => c.shape.preview!.def)).toEqual(["box"]);
  });

  it("reserves `preview` as a name in a library", () => {
    expect(codes(`${SHAPES}\npreview is style(fill=red)\n`)).toEqual([Code.Preview]);
  });

  it("is ignored when the library is imported", () => {
    const libraries = new Map([[LIB, `${SHAPES}\npreview():\n  ec2(label="Only in the gallery")\n`]]);
    const r = compile('canvas(width=300, height=200)\nimport ec2 from cloud\nweb is ec2(label="Web")\n', { path: "lib/plan.zyxd", libraries });
    expect(r.diagnostics).toEqual([]);
    expect(texts(r.svg)).toEqual(["Web"]);
  });
});

describe("gallery (#24)", () => {
  it("shows each own shape in file order: its preview lines, or one cell with default values", () => {
    expect(cells(`${SHAPES}\npreview():\n  s3(label="Logs")\n  s3(label="Data", width=120)\n`)).toEqual(["ec2*", "s3", "s3", "helper*"]);
  });

  it("draws parameters without a default as their name, and names each cell", () => {
    const r = lib(SHAPES);
    expect(r.diagnostics).toEqual([]);
    expect(texts(r.svg)).toEqual(["label", "ec2", "Bucket", "s3", "helper (not exported)"]);
    expect(r.scene.frame.infinite).toBe(true);
  });

  it("marks shapes that are not exported", () => {
    const r = lib(SHAPES);
    const label = r.scene.gallery!.cells[2].label;
    expect(label.attrs.get("font-style")?.value).toEqual({ t: "str", v: "italic" });
  });

  it("places cells in rows that fit the width", () => {
    const x = (s: Shape, r = lib(SHAPES, { galleryWidth: 2000 })) => r.scene.placed.get(s.id)!.box;
    const wide = lib(SHAPES, { galleryWidth: 2000 });
    const [a, b, c] = wide.scene.gallery!.cells.map((cell) => x(cell.shape, wide));
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
    expect(b.x).toBeGreaterThan(a.x + a.w);

    const narrow = lib(SHAPES, { galleryWidth: 100 });
    const [p, q] = narrow.scene.gallery!.cells.map((cell) => narrow.scene.placed.get(cell.shape.id)!.box);
    expect(q.y).toBeGreaterThan(p.y + p.h);
  });

  it("puts each name under its shape", () => {
    const r = lib(SHAPES);
    const { shape, label } = r.scene.gallery!.cells[0];
    const s = r.scene.placed.get(shape.id)!.box;
    expect(r.scene.placed.get(label.id)!.box.y).toBeGreaterThan(s.y + s.h);
  });

  it("has no cells for a library without custom shapes", () => {
    const r = lib("edge is style(stroke=red)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.scene.gallery!.cells).toEqual([]);
  });

  it("draws 300 shapes in one compile, quickly", () => {
    let text = "";
    for (let i = 0; i < 300; i++) text += `icon${i} is shape(label="L${i}", width=60, height=60):\n  r is rect(width=100%, height=100%)\n  t is text(label, x=5, y=5)\n`;
    const start = performance.now();
    const r = lib(text);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(r.scene.gallery!.cells).toHaveLength(300);
  });
});

describe("preview values and eye icons (#25)", () => {
  const target = (text: string, options: CompileOptions = {}) => {
    const r = lib(text, options);
    return { source: text, scene: r.scene, tree: r.tree, diagnostics: r.diagnostics };
  };
  const apply = (text: string, edits: { from: number; to: number; insert: string }[]) =>
    [...edits].sort((a, b) => b.from - a.from).reduce((s, e) => s.slice(0, e.from) + e.insert + s.slice(e.to), text);
  const cell = (t: ReturnType<typeof target>, i: number) => t.scene.gallery!.cells[i].shape.path;

  it("shows the parameters, width and height of a cell", () => {
    const t = target(SHAPES);
    const sheet = propertySheet(t, cell(t, 0))!;
    expect(sheet.fields.map((f) => f.name)).toEqual(["label", "width", "height", "display"]);
    expect(sheet.fields[0].placeholder).toBe("label (preview)");
    expect(sheet.readOnly).toBeUndefined();
  });

  it("shows a hint when nothing is selected", () => {
    const sheet = propertySheet(target(SHAPES), null)!;
    expect(sheet.fields).toEqual([]);
    expect(sheet.readOnly).toContain("preview():");
  });

  it("adds the preview() block with a line on the first value", () => {
    const t = target(SHAPES);
    const out = apply(SHAPES, setProperty(t, cell(t, 0), "label", "Web").edits);
    expect(out).toBe(`${SHAPES}\npreview():\n  ec2(label="Web")\n`);
    expect(cells(out)).toEqual(["ec2", "s3*", "helper*"]);
  });

  it("adds a line to an existing block", () => {
    const text = `${SHAPES}\npreview():\n  s3(label="Logs")\n`;
    const t = target(text);
    expect(apply(text, setProperty(t, cell(t, 0), "width", "200").edits)).toBe(`${text.trimEnd()}\n  ec2(width=200)\n`);
  });

  it("changes the value on an existing line", () => {
    const text = `${SHAPES}\npreview():\n  s3(label="Logs")\n`;
    const t = target(text);
    expect(apply(text, setProperty(t, cell(t, 1), "label", "Data").edits)).toBe(`${SHAPES}\npreview():\n  s3(label="Data")\n`);
    // A parameter without a default may be left out in preview().
    const e = `${SHAPES}\npreview():\n  ec2(label="x")\n`;
    const te = target(e);
    expect(apply(e, setProperty(te, cell(te, 0), "label", "").edits)).toBe(`${SHAPES}\npreview():\n  ec2()\n`);
  });

  it("has an eye per definition, and per preview line", () => {
    const text = `${SHAPES}\npreview():\n  s3(label="Logs")\n`;
    const layers = galleryLayers(lib(text).scene);
    expect(layers.map((l) => l.path.startsWith("def:") ? l.path : "line")).toEqual(["def:ec2", "def:s3", "def:helper", "line"]);
  });

  it("hides a definition in the gallery only", () => {
    const r = lib(SHAPES, { galleryHidden: ["s3"] });
    expect(r.scene.gallery!.cells.map((c) => c.shape.preview!.def)).toEqual(["ec2", "helper"]);
    expect(galleryLayers(r.scene).find((l) => l.path === "def:s3")?.hidden).toBe(true);
  });

  it("hides a preview line with display=none, as in a drawing", () => {
    const text = `${SHAPES}\npreview():\n  s3(label="Logs")\n`;
    const t = target(text);
    const out = apply(text, toggleHidden(t, cell(t, 1)).edits);
    expect(out).toContain('s3(label="Logs", display=none)');
    const hidden = lib(out);
    expect(hidden.diagnostics).toEqual([]);
    const { shape, label } = hidden.scene.gallery!.cells[1];
    expect(shape.attrs.get("display")?.value).toEqual({ t: "str", v: "none" });
    expect(label.attrs.get("display")?.value).toEqual({ t: "str", v: "none" });
    expect(galleryLayers(hidden.scene).find((l) => l.path === shape.path)?.hidden).toBe(true);
  });
});
