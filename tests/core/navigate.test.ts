import { describe, expect, it } from "vitest";
import { Diagnostics, definitionAt, parse } from "../../src/core";

/** Definition for the first occurrence of `word` after `after` (or from the start). */
function at(source: string, word: string, after = "") {
  const offset = source.indexOf(word, after ? source.indexOf(after) + after.length : 0);
  if (offset < 0) throw new Error(`no ${word}`);
  const link = definitionAt(parse(source, new Diagnostics()), offset + 1);
  if (!link) return null;
  const t = link.target;
  return {
    word: source.slice(link.range.start, link.range.end),
    target: t.file === null ? { line: source.slice(0, t.range.start).split("\n").length, text: source.slice(t.range.start, t.range.end) } : t,
  };
}

const SRC = `import service, database from shapes.system
card is style(fill=white)
half is clip():
  rect(width=100%, height=50%)
box is shape(label):
  body is rect(width=10, height=10)
  t is text(label, below=body 4)
web is service(label="Web", x=0)
b is box(label="B", right-of=web 20)
g is group(x=0):
  inner is rect(width=5, height=5, style=card, clip-path=half)
  other is rect(right-of=inner 5, width=5, height=5)
line(from=g.inner, to=b)
`;

describe("go to definition", () => {
  it("import names and the import path go to the library", () => {
    expect(at(SRC, "service")).toEqual({ word: "service", target: { file: "shapes.system", name: "service" } });
    expect(at(SRC, "database")).toEqual({ word: "database", target: { file: "shapes.system", name: "database" } });
    expect(at(SRC, "shapes.system")).toEqual({ word: "shapes.system", target: { file: "shapes.system" } });
  });

  it("a custom shape type goes to its definition (imported or local)", () => {
    expect(at(SRC, "service", "web is ")).toEqual({ word: "service", target: { file: "shapes.system", name: "service" } });
    expect(at(SRC, "box", "b is ")).toEqual({ word: "box", target: { line: 5, text: "box" } });
  });

  it("a local definition wins over an import", () => {
    expect(at("import box from lib\nbox is shape(a):\n  rect(width=1)\nx is box(a=1)", "box", "rect(width=1)\n")?.target).toEqual({ line: 2, text: "box" });
  });

  it("shape references go to the shape, looking in enclosing blocks", () => {
    expect(at(SRC, "web", "right-of=")).toEqual({ word: "web", target: { line: 8, text: "web" } });
    expect(at(SRC, "inner", "other is rect(right-of=")?.target).toEqual({ line: 11, text: "inner" });
    expect(at(SRC, "g.inner")?.target).toEqual({ line: 11, text: "inner" });
    expect(at(SRC, "b", "to=")?.target).toEqual({ line: 9, text: "b" });
    // Inside a custom shape body: its own parts.
    expect(at(SRC, "body", "below=")?.target).toEqual({ line: 6, text: "body" });
  });

  it("styles and clips go to their definition", () => {
    expect(at(SRC, "card", "style=")?.target).toEqual({ line: 2, text: "card" });
    expect(at(SRC, "half", "clip-path=")?.target).toEqual({ line: 3, text: "half" });
  });

  it("other words are not links", () => {
    expect(at(SRC, "rect")).toBeNull();
    expect(at(SRC, "20", "web ")).toBeNull();
    expect(at(SRC, "white")).toBeNull();
  });

  it("`as` names go to the original name in the library", () => {
    const src = "import lambda as ly from cloud.aws\nf is ly()";
    expect(at(src, "ly")).toEqual({ word: "ly", target: { file: "cloud.aws", name: "lambda" } });
    expect(at(src, "ly", "f is ")).toEqual({ word: "ly", target: { file: "cloud.aws", name: "lambda" } });
  });

  it("names from `import *` go to that library; a named import wins", () => {
    const src = "import * from shapes.system\nimport box from lib\nweb is service()\nb is box()";
    expect(at(src, "service")?.target).toEqual({ file: "shapes.system", name: "service" });
    expect(at(src, "box", "b is ")?.target).toEqual({ file: "lib", name: "box" });
  });

  it("imported styles, gradients and clips go to their library", () => {
    const src = "import primary, sky, half from look\nr is rect(style=primary, fill=sky, clip-path=half)";
    expect(at(src, "primary", "style=")?.target).toEqual({ file: "look", name: "primary" });
    expect(at(src, "sky", "fill=")?.target).toEqual({ file: "look", name: "sky" });
    expect(at(src, "half", "clip-path=")?.target).toEqual({ file: "look", name: "half" });
  });

  it("exported names go to their definition", () => {
    const src = "import db from cloud\nedge is style(stroke=red)\nexport edge, db";
    expect(at(src, "edge", "export ")?.target).toEqual({ line: 2, text: "edge" });
    expect(at(src, "db", "export edge, ")?.target).toEqual({ file: "cloud", name: "db" });
  });
});
