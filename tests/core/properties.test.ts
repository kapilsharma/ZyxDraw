import { describe, expect, it } from "vitest";
import { applyEdits, compile, propertySheet, setProperty } from "../../src/core";

const CANVAS = "canvas(width=400, height=200)\n";

function target(source: string) {
  const r = compile(source);
  return { source, scene: r.scene, tree: r.tree, diagnostics: r.diagnostics };
}

function sheet(source: string, path: string | null) {
  return propertySheet(target(source), path)!;
}

function field(source: string, path: string | null, name: string) {
  return sheet(source, path).fields.find((f) => f.name === name)!;
}

/** Sets a property, applies the edit, and returns the new text and its problems. */
function set(source: string, path: string | null, name: string, value: string) {
  const result = setProperty(target(source), path, name, value);
  const text = applyEdits(source, result.edits);
  return { text, result, problems: compile(text).diagnostics.map((d) => d.message) };
}

describe("property sheet", () => {
  it("lists every attribute of the shape, in sections, with the values as written", () => {
    const s = sheet(CANVAS + "a is rect(left=10%, y=20, width=50, height=30, fill=red)", "a");
    expect(s.type).toBe("rect");
    expect(s.box).toEqual({ x: 40, y: 20, w: 50, h: 30 });
    const names = s.fields.map((f) => f.name);
    for (const n of ["x", "y", "right-of", "width", "rx", "fill", "stroke-dasharray", "style", "clip-path"]) expect(names).toContain(n);
    expect(field(CANVAS + "a is rect(left=10%, y=20)", "a", "x")).toMatchObject({ value: "10%", written: "left", section: "Position" });
    expect(field(CANVAS + "a is rect(fill=red)", "a", "stroke")).toMatchObject({ value: "", placeholder: "none", section: "Fill and stroke" });
    // Sections come in a fixed order.
    expect(s.fields.findIndex((f) => f.section === "Position")).toBeLessThan(s.fields.findIndex((f) => f.section === "Fill and stroke"));
  });

  it("shows strings without quotes, calculations and anchors as written", () => {
    const src = CANVAS + 'a is rect(width=10, height=10)\nt is text("Hi there", right-of=a 20, font-family="Comic Sans")';
    expect(field(src, "t", "text")).toMatchObject({ value: "Hi there", section: "Content" });
    expect(field(src, "t", "right-of").value).toBe("a 20");
    expect(field(src, "t", "font-family").value).toBe("Comic Sans");
    expect(field(src, "t", "text-anchor").options).toEqual(["start", "middle", "end"]);
  });

  it("shows a value coming from a style as the placeholder", () => {
    const src = CANVAS + "s is style(fill=gold)\na is rect(width=10, height=10, style=s)";
    expect(field(src, "a", "fill")).toMatchObject({ value: "", placeholder: "gold (style)" });
  });

  it("lists the parameters of a custom shape, with defaults and required ones", () => {
    const src = CANVAS + 'db is shape(label, width=120, color=#eee):\n  body is rect(width=100%, height=40, fill=color)\n  t is text(label)\nd is db(label="Orders", x=10)';
    const s = sheet(src, "d");
    expect(s.type).toBe("db");
    expect(field(src, "d", "label")).toMatchObject({ section: "Parameters", value: "Orders", required: true });
    expect(field(src, "d", "width")).toMatchObject({ section: "Parameters", value: "", placeholder: "120" });
    expect(field(src, "d", "color")).toMatchObject({ placeholder: "#eee" });
    expect(s.fields.filter((f) => f.name === "width")).toHaveLength(1);
    // A part of the instance shows the instance.
    expect(sheet(src, "d.body").path).toBe("d");
  });

  it("marks a field with its problem", () => {
    expect(field(CANVAS + "a is rect(fill-opacity=5)", "a", "fill-opacity").problem).toBeTruthy();
  });

  it("shows the canvas when nothing is selected", () => {
    expect(sheet(CANVAS, null).fields.map((f) => [f.name, f.value])).toEqual([["width", "400"], ["height", "200"], ["background", ""]]);
    expect(field("a is rect()", null, "width")).toMatchObject({ value: "", placeholder: "1000" });
  });
});

describe("set property", () => {
  it("changes only the value", () => {
    expect(set(CANVAS + "a is rect(x=1,  fill=red)  # c", "a", "fill", "blue").text).toBe(CANVAS + "a is rect(x=1,  fill=blue)  # c");
  });

  it("keeps an alias", () => {
    expect(set(CANVAS + "a is rect(left=1)", "a", "x", "5%").text).toBe(CANVAS + "a is rect(left=5%)");
  });

  it("adds a missing attribute", () => {
    expect(set(CANVAS + "a is rect(x=1)", "a", "stroke", "navy").text).toBe(CANVAS + "a is rect(x=1, stroke=navy)");
    expect(set(CANVAS + "a is rect()", "a", "stroke", "navy").text).toBe(CANVAS + "a is rect(stroke=navy)");
  });

  it("removes an attribute when the value is cleared", () => {
    const src = CANVAS + "a is rect(x=1, y=2, fill=red)";
    expect(set(src, "a", "x", "").text).toBe(CANVAS + "a is rect(y=2, fill=red)");
    expect(set(src, "a", "y", "").text).toBe(CANVAS + "a is rect(x=1, fill=red)");
    expect(set(src, "a", "fill", "").text).toBe(CANVAS + "a is rect(x=1, y=2)");
    expect(set(CANVAS + "a is rect(fill=red)", "a", "fill", "").text).toBe(CANVAS + "a is rect()");
  });

  it("removes a whole line in a multi-line attribute list, keeping comments", () => {
    const src = CANVAS + "a is rect(\n  x=1   # left\n  fill=red\n  stroke=blue\n)";
    expect(set(src, "a", "fill", "").text).toBe(CANVAS + "a is rect(\n  x=1   # left\n  stroke=blue\n)");
    expect(set(src, "a", "opacity", "0.5").text).toBe(CANVAS + "a is rect(\n  x=1   # left\n  fill=red\n  stroke=blue\n  opacity=0.5\n)");
  });

  it("quotes text where needed", () => {
    const src = CANVAS + 't is text("Hi", x=1)\nl is line(x1=0, y1=0, x2=10, y2=10)';
    expect(set(src, "t", "text", 'Say "hi"').text).toBe(CANVAS + 't is text("Say \\"hi\\"", x=1)\nl is line(x1=0, y1=0, x2=10, y2=10)');
    expect(set(src, "t", "font-family", "Comic Sans").text).toContain('font-family="Comic Sans"');
    expect(set(src, "t", "font-family", "serif").text).toContain("font-family=serif");
    expect(set(src, "l", "label", "SQL").text).toContain('label="SQL"');
    expect(set(CANVAS + 't is text("", x=1)', "t", "text", "New").text).toBe(CANVAS + 't is text("New", x=1)');
  });

  it("writes custom shape parameters, quoting text ones", () => {
    const def = 'db is shape(label, width=120):\n  body is rect(width=100%, height=40)\n  t is text(label)\n';
    const src = CANVAS + def + 'd is db(label="A", x=10)';
    const r1 = set(src, "d", "label", "Orders DB");
    expect(r1.text).toBe(CANVAS + def + 'd is db(label="Orders DB", x=10)');
    const r2 = set(src, "d", "width", "200");
    expect(r2.text).toBe(CANVAS + def + 'd is db(label="A", x=10, width=200)');
    expect(r2.problems).toEqual([]);
    expect(set(src, "d", "label", "").result.notices[0]).toMatch(/required/);
  });

  it("writes the canvas, adding one if missing", () => {
    expect(set(CANVAS + "a is rect()", null, "background", "#fafafa").text).toBe("canvas(width=400, height=200, background=#fafafa)\na is rect()");
    expect(set(CANVAS, null, "height", "").text).toBe("canvas(width=400)\n");
    expect(set("# title\nimport a from lib\na is rect()", null, "width", "800").text).toBe("# title\nimport a from lib\ncanvas(width=800)\na is rect()");
    expect(set("", null, "width", "800").text).toBe("canvas(width=800)\n");
  });

  it("does nothing when the value did not change", () => {
    expect(setProperty(target(CANVAS + "a is rect(x=1)"), "a", "x", " 1 ").edits).toEqual([]);
  });
});
