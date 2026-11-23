import { describe, expect, it } from "vitest";
import { applyEdits, compile, layers, toggleHidden } from "../../src/core";

const CANVAS = "canvas(width=400, height=200)\n";

function target(source: string) {
  const r = compile(source);
  return { source, scene: r.scene, tree: r.tree, diagnostics: r.diagnostics };
}

/** Toggles one shape, and returns the new text and its problems. */
function toggle(source: string, path: string) {
  const text = applyEdits(source, toggleHidden(target(source), path).edits);
  return { text, problems: compile(text).diagnostics.map((d) => d.message) };
}

describe("display=none", () => {
  it("is written to the SVG and the shape is still laid out", () => {
    const src = CANVAS + "a is rect(x=10, y=10, width=50, height=30, display=none)\nb is rect(right-of=a 20, y=10, width=50, height=30)\nline(from=a, to=b)";
    const r = compile(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<rect x="10" y="10" width="50" height="30" display="none" />');
    // `b` is still placed after the hidden `a`.
    expect(r.svg).toContain('<rect x="80" y="10" width="50" height="30" />');
  });

  it("hides a group with its children, a custom shape instance, and a line with its label", () => {
    const src =
      CANVAS +
      "box is shape(color=red):\n  rect(width=20, height=20, fill=color)\n" +
      "g is group(display=none):\n  rect(width=10, height=10)\n" +
      "i is box(x=50, display=none)\n" +
      'a is rect(width=10, height=10)\nb is rect(x=100, width=10, height=10)\nline(from=a, to=b, label="L", display=none)';
    const r = compile(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toMatch(/<g display="none">/);
    expect(r.svg).toMatch(/<g transform="translate\(50,0\)" display="none">/);
    expect(r.svg).toMatch(/<line [^>]*display="none" \/>/);
    expect(r.svg).toMatch(/<text [^>]*display="none">L<\/text>/);
  });

  it("can come from a style, and only takes inline or none", () => {
    expect(compile(CANVAS + "off is style(display=none)\na is rect(width=10, style=off)").svg).toContain('display="none"');
    expect(compile(CANVAS + "a is rect(display=hidden)").diagnostics[0].message).toBe("`display` must be one of: inline, none");
  });
});

describe("layers", () => {
  it("lists the shape statements of the file in text order, with their hidden state", () => {
    const src =
      CANVAS +
      "box is shape():\n  rect(width=20, height=20)\n" +
      "g is group(display=none):\n  c is rect(width=10, height=10)\n" +
      "i is box()\n" +
      "a is rect(width=10)";
    const l = layers(compile(src).scene);
    expect(l.map((x) => [x.path, x.hidden, x.hiddenByGroup])).toEqual([
      ["g", true, false],
      ["g.c", false, true],
      ["i", false, false],
      ["a", false, false],
    ]);
    // The group's block covers its child; its own range is its first line only.
    expect(src.slice(l[0].range.start, l[0].range.end)).toBe("g is group(display=none):");
    expect(src.slice(l[0].blockRange.start, l[0].blockRange.end)).toContain("c is rect");
  });
});

describe("toggleHidden", () => {
  it("adds display=none, and removes it again", () => {
    const src = CANVAS + "a is rect(width=10, height=10)";
    const hidden = toggle(src, "a");
    expect(hidden.text).toBe(CANVAS + "a is rect(width=10, height=10, display=none)");
    expect(hidden.problems).toEqual([]);
    expect(toggle(hidden.text, "a").text).toBe(src);
  });

  it("replaces display=inline, and keeps a multi-line form", () => {
    expect(toggle(CANVAS + "a is rect(display=inline, width=10)", "a").text).toBe(CANVAS + "a is rect(display=none, width=10)");
    const multi = CANVAS + "a is rect(\n  width=10\n  height=10\n)";
    const hidden = toggle(multi, "a");
    expect(hidden.text).toBe(CANVAS + "a is rect(\n  width=10\n  height=10\n  display=none\n)");
    expect(hidden.problems).toEqual([]);
    expect(toggle(hidden.text, "a").text).toBe(multi);
  });

  it("shows a shape hidden by its style with display=inline", () => {
    const src = CANVAS + "off is style(display=none)\na is rect(width=10, style=off)";
    const shown = toggle(src, "a");
    expect(shown.text).toBe(CANVAS + "off is style(display=none)\na is rect(width=10, style=off, display=inline)");
    expect(compile(shown.text).svg).not.toContain('display="none"');
    // Hiding again writes none over inline.
    expect(toggle(shown.text, "a").text).toBe(CANVAS + "off is style(display=none)\na is rect(width=10, style=off, display=none)");
  });

  it("hides a custom shape instance and a group as one unit", () => {
    const src = CANVAS + "box is shape():\n  rect(width=20, height=20)\ni is box(x=5)\ng is group():\n  rect(width=10, height=10)";
    expect(toggle(src, "i").text).toContain("i is box(x=5, display=none)");
    expect(toggle(src, "g").text).toContain("g is group(display=none):\n  rect(width=10, height=10)");
  });

  it("refuses a shape with a syntax error", () => {
    const src = CANVAS + "a is rect(width=10";
    const r = toggleHidden(target(src), "a");
    expect(r.edits).toEqual([]);
  });
});
