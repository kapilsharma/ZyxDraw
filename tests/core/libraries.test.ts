import { describe, expect, it } from "vitest";
import { Code, compile, compileWithImports, importCandidates, loadLibraries } from "../../src/core";
import { parseXml, type XNode } from "../docs/svg-compare";

const CANVAS = "canvas(width=400, height=200)\n";

const DATABASE = `database is shape(label="DB", width=120, height=80, color=steelblue):
  body is rect(width=100%, height=100%, fill=color)
  name is text(label, x=10, y=30)
`;

function elements(svg: string, tag: string): XNode[] {
  const out: XNode[] = [];
  const walk = (n: XNode) => {
    if (n.name === tag) out.push(n);
    n.children.forEach(walk);
  };
  walk(parseXml(svg));
  return out;
}

type Opts = Parameters<typeof compile>[1];
const messages = (src: string, opts: Opts = {}) => compile(src, opts).diagnostics.map((d) => d.message);
const codes = (src: string, opts: Opts = {}) => compile(src, opts).diagnostics.map((d) => d.code);

const libs = new Map([
  ["lib/shapes.zyxdl", DATABASE + "secret is shape():\n  r is rect(width=1, height=1)\n"],
  ["lib/icons.zyxdl", 'import database from shapes\nicon is shape(label="i"):\n  inner is database(label=label)\n'],
]);
const inLib = (extra: Record<string, string> = {}): Opts => ({
  path: "main.zyxd",
  libraries: new Map([...libs, ...Object.entries(extra)]),
});

describe("where an import looks", () => {
  it("looks in the importing file's folder, then in the library folder", () => {
    expect(importCandidates("notes/a.zyxd", "lib.shapes")).toEqual(["notes/lib/shapes.zyxdl"]);
    expect(importCandidates("notes/a.zyxd", "lib.shapes", "ZyxDrawLibrary")).toEqual(["notes/lib/shapes.zyxdl", "ZyxDrawLibrary/lib/shapes.zyxdl"]);
    expect(importCandidates("a.zyxd", "shapes", "/Libs/")).toEqual(["shapes.zyxdl", "Libs/shapes.zyxdl"]);
  });

  it("does not look twice when the file is in the library folder", () => {
    expect(importCandidates("ZyxDrawLibrary/a.zyxdl", "b", "ZyxDrawLibrary")).toEqual(["ZyxDrawLibrary/b.zyxdl"]);
  });

  it("gives no place for a bad library name (the parser reports it)", () => {
    expect(importCandidates("a.zyxd", "lib/shapes")).toEqual([]);
    expect(importCandidates("a.zyxd", "icons.zyxd")).toEqual([]);
  });

  it("finds a library in the library folder", () => {
    const src = 'import database from cloud.db\nd is database(label="Q")';
    const opts = { path: "notes/main.zyxd", libraryFolder: "Libs", libraries: new Map([["Libs/cloud/db.zyxdl", DATABASE]]) };
    const { diagnostics, svg } = compile(src, opts);
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["Q"]);
  });

  it("prefers the library next to the file over the library folder", () => {
    const src = "import box from shapes\nb is box()";
    const opts = {
      path: "main.zyxd",
      libraryFolder: "Libs",
      libraries: new Map([
        ["shapes.zyxdl", "box is shape():\n  c is circle(r=2)\n"],
        ["Libs/shapes.zyxdl", "box is shape():\n  r is rect(width=1, height=1)\n"],
      ]),
    };
    expect(elements(compile(src, opts).svg, "circle")).toHaveLength(1);
  });

  it("matches upper and lower case exactly", () => {
    expect(codes("import database from Lib.Shapes", inLib())).toEqual([Code.ImportNotFound]);
  });

  it("names every place it looked when a library is not found", () => {
    expect(messages("import a from cloud.aws", { path: "notes/main.zyxd", libraryFolder: "Libs" })).toEqual([
      "Zyxd library `cloud.aws` not found. Looked for `notes/cloud/aws.zyxdl` and `Libs/cloud/aws.zyxdl`. Folder and file names of libraries cannot contain dots",
    ]);
  });

  it("says when the import points to a drawing", () => {
    const opts = { path: "main.zyxd", libraries: new Map([["shapes/system.zyxd", DATABASE]]) };
    expect(messages("import database from shapes.system", opts)).toEqual([
      "`shapes/system.zyxd` is a drawing. Only `.zyxdl` libraries can be imported. Rename it to `system.zyxdl`",
    ]);
  });

  it("reports a bad library name once, from the parser", () => {
    expect(codes("import database from lib/shapes.zyxd", inLib())).toEqual([Code.InvalidLibraryName]);
  });
});

describe("importing", () => {
  it("imports a custom shape and draws it", () => {
    const { svg, diagnostics } = compile(CANVAS + 'import database from lib.shapes\nusers is database(label="Users")', inLib());
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["Users"]);
  });

  it("follows imports inside libraries, from the library's own folder", () => {
    const { diagnostics, svg } = compile('import icon from lib.icons\ni is icon(label="x")', inLib());
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["x"]);
  });

  it("keeps imported shapes sealed", () => {
    expect(codes("import database from lib.shapes\nd is database()\nt is rect(below=d.body 1)", inLib())).toContain(Code.PrivatePart);
  });

  it("reports a name the library does not define", () => {
    expect(messages("import nope from lib.shapes", inLib())).toEqual(["`nope` is not defined in `lib.shapes`"]);
  });

  it("lets a local definition win over an import", () => {
    const src = "import database from lib.shapes\ndatabase is shape():\n  c is circle(r=2)\nd is database()";
    expect(elements(compile(src, inLib()).svg, "circle")).toHaveLength(1);
  });

  it("lets a later import win over an earlier one, silently", () => {
    const extra = { "a.zyxdl": "box is shape():\n  r is rect(width=1, height=1)\n", "b.zyxdl": "box is shape():\n  c is circle(r=2)\n" };
    const { svg, diagnostics } = compile("import * from a\nimport * from b\nx is box()", inLib(extra));
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "circle")).toHaveLength(1);
  });

  it("renames with `as`, so two libraries can share a name", () => {
    const extra = { "a.zyxdl": "box is shape():\n  r is rect(width=1, height=1)\n", "b.zyxdl": "box is shape():\n  c is circle(r=2)\n" };
    const src = "import box as square from a\nimport box as round from b\nx is square()\ny is round()";
    const { svg, diagnostics } = compile(src, inLib(extra));
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")).toHaveLength(1);
    expect(elements(svg, "circle")).toHaveLength(1);
    expect(codes("import box as square from a\nx is box()", inLib(extra))).toEqual([Code.UnknownType]);
  });

  it("imports everything with `*`", () => {
    const { svg, diagnostics } = compile('import * from lib.shapes\nd is database(label="A")\ns is secret()', inLib());
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["A"]);
  });

  it("imports styles, gradients and clips by name", () => {
    const lib = "primary is style(fill=red)\nsky is gradient(from=white, to=blue)\nhalf is clip():\n  rect(width=50%, height=100%)\n";
    const src = "import primary, sky, half from look\na is rect(width=10, height=10, style=primary)\nb is rect(width=10, height=10, fill=sky, clip-path=half)";
    const { svg, diagnostics } = compile(src, inLib({ "look.zyxdl": lib }));
    expect(diagnostics).toEqual([]);
    const rects = elements(svg, "rect").filter((r) => r.attrs.fill); // not the clip's own rect
    expect(rects.map((r) => r.attrs.fill)).toEqual(["red", "url(#sky)"]);
    expect(elements(svg, "linearGradient")).toHaveLength(1);
    expect(elements(svg, "clipPath")).toHaveLength(1);
  });

  it("keeps the drawing's own style when an import has the same name", () => {
    const src = "import primary from look\nprimary is style(fill=green)\na is rect(width=10, height=10, style=primary)";
    const { svg } = compile(src, inLib({ "look.zyxdl": "primary is style(fill=red)\n" }));
    expect(elements(svg, "rect")[0].attrs.fill).toBe("green");
  });

  it("reports problems of an imported style on `style=` in the drawing", () => {
    const src = "import primary from look\na is rect(width=10, height=10, style=primary)";
    const { diagnostics } = compile(src, inLib({ "look.zyxdl": "\nprimary is style(opacity=7)\n" }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/^In style `primary` \(`look.zyxdl`\): .*\(line 2\)$/);
    expect(src.slice(diagnostics[0].range.start, diagnostics[0].range.end)).toBe("style=primary");
  });

  it("reports problems of an imported clip where it is used", () => {
    const src = "import half from look\nb is rect(width=10, height=10, clip-path=half)";
    const { diagnostics } = compile(src, inLib({ "look.zyxdl": "half is clip():\n  line(x1=0, y1=0, x2=1, y2=1)\n" }));
    expect(diagnostics.map((d) => d.code)).toEqual([Code.InvalidClip]);
    expect(diagnostics[0].message).toMatch(/^In clip `half` \(`look.zyxdl`\): /);
    expect(src.slice(diagnostics[0].range.start, diagnostics[0].range.end)).toBe("clip-path=half");
  });

  it("reports circular imports and terminates", () => {
    const cyc = new Map([
      ["a.zyxdl", "import y from b\nx is shape():\n  r is rect()\n"],
      ["b.zyxdl", "import x from a\ny is shape():\n  r is rect()\n"],
    ]);
    const { diagnostics } = compile("import x from a\none is x()", { path: "main.zyxd", libraries: cyc });
    expect(diagnostics.some((d) => d.message.includes("Circular import: a.zyxdl -> b.zyxdl -> a.zyxdl"))).toBe(true);
  });

  it("reports a library importing itself", () => {
    expect(codes("import x from main\nx is shape():\n  r is rect()", { path: "main.zyxdl" })).toContain(Code.CircularImport);
  });
});

describe("exporting", () => {
  const BOXES = `edge is style(stroke=#333, stroke-width=2)

inner_box is shape(width=40, height=40):
  rect(width=100%, height=100%, style=edge)

outer_box is shape(width=120, height=80):
  rect(width=100%, height=100%, style=edge)
  inner_box(x=10, y=10)

export outer_box, edge
`;
  const opts = inLib({ "shapes/boxes.zyxdl": BOXES });

  it("lets a drawing use what is exported, and the library use the rest", () => {
    const { svg, diagnostics } = compile("import outer_box, edge from shapes.boxes\nb is outer_box()\nr is rect(width=5, height=5, style=edge)", opts);
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")).toHaveLength(3);
  });

  it("refuses a name that is not exported, listing what is", () => {
    expect(messages("import inner_box from shapes.boxes", opts)).toEqual(["`inner_box` is not exported by `shapes.boxes`. It exports: `outer_box`, `edge`"]);
  });

  it("brings in only exported names with `*`", () => {
    expect(codes("import * from shapes.boxes\nb is outer_box()", opts)).toEqual([]);
    expect(codes("import * from shapes.boxes\nb is inner_box()", opts)).toEqual([Code.UnknownType]);
  });

  it("adds up several export lines", () => {
    const lib = "a is shape():\n  r is rect()\nb is shape():\n  r is rect()\nc is shape():\n  r is rect()\nexport a\nexport b\n";
    const o = inLib({ "l.zyxdl": lib });
    expect(codes("import a, b from l", o)).toEqual([]);
    expect(codes("import c from l", o)).toEqual([Code.ImportNotFound]);
  });

  it("can export what the library imported", () => {
    const o = inLib({ "cloud/aws.zyxdl": "import database as db from lambda\nexport db\n", "cloud/lambda.zyxdl": DATABASE });
    const { svg, diagnostics } = compile('import db from cloud.aws\nd is db(label="L")', o);
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["L"]);
  });

  it("reports an exported name the library does not have", () => {
    const { diagnostics } = compile("a is shape():\n  r is rect()\nexport a, nope", { path: "l.zyxdl" });
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([[Code.Export, "`nope` is not defined in this library"]]);
  });

  it("refuses `export` in a drawing", () => {
    expect(messages("a is shape():\n  r is rect()\nexport a", { path: "main.zyxd" })).toEqual([
      "A drawing cannot be imported, so it cannot export. Move the definitions to a `.zyxdl` library",
    ]);
  });
});

describe("a library draws nothing", () => {
  it("refuses `canvas` and shapes at the top level", () => {
    const { diagnostics, svg } = compile("canvas(width=10, height=10)\nbox is rect(width=5, height=5)\ns is shape():\n  r is rect()", { path: "l.zyxdl" });
    expect(diagnostics.map((d) => d.message)).toEqual([
      "A library draws nothing: `canvas` is only for drawings",
      "A library draws nothing: put shapes inside a custom shape (`name is shape():`)",
    ]);
    expect(elements(svg, "rect")).toHaveLength(0);
  });

  it("shows a library's problems on the import line", () => {
    const src = "import s from l\nx is s()";
    const { diagnostics } = compile(src, inLib({ "l.zyxdl": "s is shape():\n  r is rect()\nbox is rect()\n" }));
    expect(diagnostics.map((d) => d.code)).toEqual([Code.LibraryDraws]);
    expect(diagnostics[0].message).toBe("In `l.zyxdl`: A library draws nothing: put shapes inside a custom shape (`name is shape():`) (line 3)");
    expect(src.slice(diagnostics[0].range.start, diagnostics[0].range.end)).toBe("import s from l");
  });

  it("lets a code block in a note import from the note's folder", () => {
    const opts = { path: "notes/today.md", libraries: new Map([["notes/shapes.zyxdl", DATABASE]]) };
    expect(codes('import database from shapes\nd is database(label="x")', opts)).toEqual([]);
  });
});

describe("loading", () => {
  it("loads libraries asynchronously, each file once", async () => {
    const reads: string[] = [];
    const read = async (p: string) => {
      reads.push(p);
      return libs.get(p) ?? null;
    };
    const loaded = await loadLibraries("import icon from lib.icons\nimport database from lib.shapes", "main.zyxd", read);
    expect([...loaded.keys()].sort()).toEqual(["lib/icons.zyxdl", "lib/shapes.zyxdl"]);
    expect(reads.filter((r) => r === "lib/shapes.zyxdl")).toHaveLength(1);

    const result = await compileWithImports('import icon from lib.icons\ni is icon(label="z")', read, { path: "main.zyxd" });
    expect(result.diagnostics).toEqual([]);
  });

  it("searches the library folder, and reads the drawing only when the library is missing", async () => {
    const files = new Map([
      ["Libs/cloud.zyxdl", DATABASE],
      ["shapes.zyxd", DATABASE],
    ]);
    const reads: string[] = [];
    const read = async (p: string) => {
      reads.push(p);
      return files.get(p) ?? null;
    };
    const loaded = await loadLibraries("import database from cloud\nimport database from shapes", "main.zyxd", read, "Libs");
    expect(reads).toEqual(["cloud.zyxdl", "Libs/cloud.zyxdl", "shapes.zyxdl", "Libs/shapes.zyxdl", "shapes.zyxd", "Libs/shapes.zyxd"]);
    expect([...loaded.keys()].sort()).toEqual(["Libs/cloud.zyxdl", "shapes.zyxd"]);

    const result = await compileWithImports("import database from shapes", read, { path: "main.zyxd", libraryFolder: "Libs" });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "`shapes.zyxd` is a drawing. Only `.zyxdl` libraries can be imported. Rename it to `shapes.zyxdl`",
    ]);
  });
});
