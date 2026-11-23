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

const codes = (src: string, opts = {}) => compile(src, opts).diagnostics.map((d) => d.code);

describe("custom shapes (same file)", () => {
  it("expands an instance with defaults and arguments", () => {
    const { svg, diagnostics } = compile(CANVAS + DATABASE + 'users is database(label="Users", x=20, y=10)\norders is database(right-of=users 40, y=10, color=orange)');
    expect(diagnostics).toEqual([]);
    const groups = elements(svg, "g");
    expect(groups.map((g) => g.attrs.transform)).toEqual(["translate(20,10)", "translate(180,10)"]);
    const rects = elements(svg, "rect");
    expect(rects[0].attrs).toMatchObject({ width: "120", height: "80", fill: "steelblue" });
    expect(rects[1].attrs).toMatchObject({ fill: "orange" });
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["Users", "DB"]);
  });

  it("lets same-file instances expose inner parts", () => {
    const src = CANVAS + DATABASE + "users is database(x=20)\ntag is rect(below=users.body 5, x=20, width=10, height=10)";
    const { svg, diagnostics } = compile(src);
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")[1].attrs).toMatchObject({ y: "85" });
  });

  it("reports a missing required parameter", () => {
    expect(codes("box is shape(label):\n  t is text(label)\nb is box()")).toContain(Code.MissingRequired);
    expect(codes('box is shape(label):\n  t is text(label)\nb is box(label="ok")')).toEqual([]);
  });

  it("reports unknown parameters, listing the valid ones", () => {
    const { diagnostics } = compile(DATABASE + "d is database(colour=red)");
    expect(diagnostics[0].code).toBe(Code.UnknownAttribute);
    expect(diagnostics[0].message).toContain("`label`");
  });

  it("reports a circular definition and terminates", () => {
    const src = "a is shape():\n  inner is b()\nb is shape():\n  inner is a()\nx is a()";
    expect(codes(src)).toContain(Code.CircularShape);
  });

  it("maps errors inside a definition to the instance line", () => {
    const src = "bad is shape():\n  r is rect(width=abc)\nb is bad()";
    const { diagnostics } = compile(src);
    const d = diagnostics.find((x) => x.code === Code.InvalidValue)!;
    expect(src.slice(d.range.start, d.range.end)).toBe("b is bad()");
    expect(d.message).toMatch(/^In `bad`: .*\(line 2\)$/);
  });

  it("refuses to redefine a built-in", () => {
    expect(codes("rect is shape():\n  c is circle(r=1)")).toEqual([Code.ReservedName]);
  });

  it("does not let a parameter clash with a style of the same name", () => {
    const src = 'label is style(fill=red)\ns is shape(label):\n  t is text(label, style=label)\none is s(label="Hi")';
    const { svg, diagnostics } = compile(src);
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text")[0].attrs.fill).toBe("red");
    expect(elements(svg, "text")[0].text).toBe("Hi");
  });

  it("allows imports and definitions before canvas", () => {
    expect(codes("import a from x.zyxd\ncanvas(width=10, height=10)", { libraries: new Map([["x.zyxd", "a is shape():\n  r is rect()"]]) })).toEqual([]);
  });

  it("a later local definition wins", () => {
    const src = 's is shape():\n  r is rect(width=1, height=1)\ns is shape():\n  c is circle(r=3)\nx is s()';
    expect(elements(compile(src).svg, "circle")).toHaveLength(1);
  });

  it("the body cannot see shapes outside the instance", () => {
    const src = "outside is rect(width=5, height=5)\ns is shape():\n  r is rect(right-of=outside 1, width=1, height=1)\nx is s()";
    expect(codes(src)).toContain(Code.UnknownShape);
  });
});

describe("calculations", () => {
  const DB = `database is shape(label, width=120, height=80):
  body is rect(width=100%, height=100%, rx=width/2, ry=10)
  lid is ellipse(x=0, y=0, rx=width / 2, ry=10)
  name is text(label, x=50%, y=(height - 20) / 2)
`;

  it("uses parameters: each instance gets its own values", () => {
    const { svg, diagnostics } = compile(DB + 'a is database(label="A")\nb is database(label="B", width=200, height=100, x=150)');
    expect(diagnostics).toEqual([]);
    const rects = elements(svg, "rect");
    expect(rects[0].attrs).toMatchObject({ width: "120", rx: "60" });
    expect(rects[1].attrs).toMatchObject({ width: "200", rx: "100" });
    expect(elements(svg, "ellipse")[1].attrs).toMatchObject({ rx: "100", cx: "100" });
    expect(elements(svg, "text").map((t) => t.attrs.y)).toEqual(["30", "40"]);
  });

  it("follows precedence, parentheses and unary minus", () => {
    const { svg, diagnostics } = compile("rect(x=2 + 3 * 4, y=(2 + 3) * 4, width=-(2 - 12), height=10 / 4)");
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")[0].attrs).toMatchObject({ x: "14", y: "20", width: "10", height: "2.5" });
  });

  it("passes a calculation as an argument", () => {
    const { svg } = compile(DB + "d is database(label=\"x\", width=100 + 100)");
    expect(elements(svg, "rect")[0].attrs).toMatchObject({ rx: "100" });
  });

  it.each([
    ["rect(width=foo / 2)", /Unknown name `foo`/],
    ["rect(width=10 / 0)", /Division by zero/],
    ["rect(width=50% / 2)", /Percent cannot be used/],
    ["rect(width=(10 + 2)", /Unclosed|Missing `\)`/],
    ["rect(width=10 +)", /ends too early/],
    ['s is shape(label):\n  rect(width=label * 2)\none is s(label="x")', /not a number/],
    ["s is shape(w=10):\n  rect(width=w-2)\none is s()", /put spaces around `-`/],
  ])("reports %s", (src, message) => {
    const msgs = compile(src).diagnostics.map((d) => d.message).join("\n");
    expect(msgs).toMatch(message);
  });

  it("keeps negative numbers and anchor gaps working", () => {
    const { svg, diagnostics } = compile("a is rect(x=50, width=10, height=10)\nb is rect(left-of=a -5, width=10, height=10, y=-3)");
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")[1].attrs).toMatchObject({ x: "45", y: "-3" });
  });
});

describe("imports", () => {
  const libs = new Map([
    ["lib/shapes.zyxd", DATABASE + "secret is shape():\n  r is rect(width=1, height=1)\n"],
    ["lib/icons.zyxd", 'import database from shapes.zyxd\nicon is shape(label="i"):\n  inner is database(label=label)\n'],
  ]);

  it("resolves import paths relative to the file, then from the vault root", () => {
    expect(importCandidates("notes/a.zyxd", "lib/shapes")).toEqual(["notes/lib/shapes.zyxd", "lib/shapes.zyxd"]);
    expect(importCandidates("a.zyxd", "../x.zyxd")).toEqual(["x.zyxd"]);
    expect(importCandidates("notes/a.zyxd", "/lib/x")).toEqual(["lib/x.zyxd"]);
  });

  it("imports a shape and draws it", () => {
    const src = CANVAS + 'import database from lib/shapes.zyxd\nusers is database(label="Users")';
    const { svg, diagnostics } = compile(src, { path: "main.zyxd", libraries: libs });
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["Users"]);
  });

  it("follows imports inside libraries", () => {
    const src = 'import icon from lib/icons.zyxd\ni is icon(label="x")';
    const { diagnostics, svg } = compile(src, { path: "main.zyxd", libraries: libs });
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "text").map((t) => t.text)).toEqual(["x"]);
  });

  it("keeps imported shapes sealed", () => {
    const src = "import database from lib/shapes.zyxd\nd is database()\nt is rect(below=d.body 1)";
    expect(codes(src, { path: "main.zyxd", libraries: libs })).toContain(Code.PrivatePart);
  });

  it("reports a name the library does not define", () => {
    expect(codes("import nope from lib/shapes.zyxd", { path: "main.zyxd", libraries: libs })).toContain(Code.ImportNotFound);
  });

  it("a local definition wins over an import", () => {
    const src = "import database from lib/shapes.zyxd\ndatabase is shape():\n  c is circle(r=2)\nd is database()";
    const { svg } = compile(src, { path: "main.zyxd", libraries: libs });
    expect(elements(svg, "circle")).toHaveLength(1);
  });

  it("reports circular imports and terminates", () => {
    const cyc = new Map([
      ["a.zyxd", "import y from b.zyxd\nx is shape():\n  r is rect()\n"],
      ["b.zyxd", "import x from a.zyxd\ny is shape():\n  r is rect()\n"],
    ]);
    const { diagnostics } = compile("import x from a.zyxd\none is x()", { path: "main.zyxd", libraries: cyc });
    expect(diagnostics.some((d) => d.message.includes("Circular import: a.zyxd -> b.zyxd -> a.zyxd"))).toBe(true);
  });

  it("reports a file importing itself", () => {
    expect(codes("import x from main.zyxd\nx is shape():\n  r is rect()", { path: "main.zyxd" })).toContain(Code.CircularImport);
  });

  it("loads libraries asynchronously, each file once", async () => {
    const reads: string[] = [];
    const read = async (p: string) => {
      reads.push(p);
      return libs.get(p) ?? null;
    };
    const loaded = await loadLibraries("import icon from lib/icons.zyxd\nimport database from lib/shapes.zyxd", "main.zyxd", read);
    expect([...loaded.keys()].sort()).toEqual(["lib/icons.zyxd", "lib/shapes.zyxd"]);
    expect(reads.filter((r) => r === "lib/shapes.zyxd")).toHaveLength(1);

    const result = await compileWithImports('import icon from lib/icons.zyxd\ni is icon(label="z")', read, { path: "main.zyxd" });
    expect(result.diagnostics).toEqual([]);
  });
});
