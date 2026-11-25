import { describe, expect, it } from "vitest";
import { Code, compile } from "../../src/core";
import { compareSvg, parseXml, type XNode } from "../docs/svg-compare";

const CANVAS = "canvas(width=400, height=200)\n";

function codes(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.code);
}

/** All elements of a given tag, in document order. */
function elements(svg: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const walk = (n: XNode) => {
    if (n.name === tag) out.push(n.attrs);
    n.children.forEach(walk);
  };
  walk(parseXml(svg));
  return out;
}

describe("first example (Docs/Examples/01_first_example.zyxd)", () => {
  const source = `# New ZyxDraw drawing
canvas(width=400, height=200)

primary is style(fill=steelblue, stroke=white, stroke-width=2)

api is rect(x=20, y=20, width=120, height=60, style=primary)
db is rect(right-of=api 60, y=20, width=120, height=60, style=primary)
line(from=api, to=db, arrow=end, label="SQL")
`;

  it("compiles without errors", () => {
    expect(compile(source).diagnostics).toEqual([]);
  });

  it("places db 60 px right of api and connects them", () => {
    const { svg } = compile(source);
    const [api, db] = elements(svg, "rect");
    expect(api).toMatchObject({ x: "20", y: "20", fill: "steelblue", stroke: "white", "stroke-width": "2" });
    expect(db).toMatchObject({ x: "200", y: "20" });
    // Line from api's right edge (140, 50) to db's left edge (200, 50).
    expect(elements(svg, "line")[0]).toMatchObject({ x1: "140", y1: "50", x2: "200", y2: "50" });
    expect(elements(svg, "text")[0]).toMatchObject({ x: "170", y: "44" });
  });
});

describe("anchors", () => {
  it("chains anchors in any order of definition", () => {
    const { svg, diagnostics } = compile(CANVAS + "c is rect(below=b 10, width=10, height=10)\nb is rect(right-of=a 5, width=10, height=10)\na is rect(x=1, y=1, width=10, height=10)");
    expect(diagnostics).toEqual([]);
    const [c, b] = elements(svg, "rect");
    expect(b).toMatchObject({ x: "16", y: "0" });
    expect(c).toMatchObject({ x: "0", y: "20" });
  });

  it("reports a self-anchor as a cycle", () => {
    expect(codes("a is rect(right-of=a 10)")).toContain(Code.CircularAnchor);
  });

  it("reports a 3-shape cycle once, naming every shape", () => {
    const { diagnostics } = compile("a is rect(right-of=c 1)\nb is rect(right-of=a 1)\nc is rect(right-of=b 1)");
    const cycles = diagnostics.filter((d) => d.code === Code.CircularAnchor);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].message).toBe("Circular anchor: a -> c -> b -> a");
  });

  it("does not treat different axes as a cycle", () => {
    expect(codes("a is rect(right-of=b 1, width=5, height=5)\nb is rect(below=a 1, width=5, height=5)")).toEqual([]);
  });

  it("reports a group anchored to its own child as a cycle (and terminates)", () => {
    expect(codes("g is group(right-of=g.box 10):\n  box is rect(width=10, height=10)")).toContain(Code.CircularAnchor);
  });

  it("resolves names through scopes and full paths", () => {
    const src = CANVAS + "s1 is group(x=20):\n  box is rect(width=100, height=60)\ns2 is group(right-of=s1 80):\n  box is rect(width=100, height=60)\n  inner is rect(below=box 5, width=10, height=10)\no is rect(below=s2.inner 1, x=0, width=1, height=1)";
    const { svg, diagnostics } = compile(src);
    expect(diagnostics).toEqual([]);
    expect(svg).toContain('transform="translate(200,0)"');
    const rects = elements(svg, "rect");
    expect(rects[2]).toMatchObject({ y: "65" }); // inner: below its sibling box
    expect(rects[3]).toMatchObject({ y: "76" }); // o: below s2.inner (65 + 10 + 1)
  });

  it("reports unknown shapes and anchoring to a line", () => {
    expect(codes("a is rect(right-of=nope 1)")).toContain(Code.UnknownShape);
    expect(codes("a is rect(x=1, width=1, height=1)\nl is line(from=a, x2=5, y2=5)\nb is rect(right-of=l 1)")).toContain(Code.AnchorToLine);
  });
});

describe("position conflicts", () => {
  it.each([
    ["rect(x=10, right-of=a 20)", Code.PositionConflict],
    ["rect(right-of=a 1, left-of=a 1)", Code.PositionConflict],
    ["rect(left=1, right=1, width=10)", Code.PositionConflict],
    ["circle(x=10, cx=5, r=1)", Code.PositionConflict],
    ["circle(x=1, right=1, r=1)", Code.PositionConflict],
    ["rect(x=1, left=2)", Code.ConflictingAttributes],
    ["rect(radius=1, rx=2)", Code.ConflictingAttributes],
  ])("%s", (source, code) => {
    expect(codes(source)).toContain(code);
  });
});

describe("percent", () => {
  it("uses the frame for top-level shapes", () => {
    const [r] = elements(compile(CANVAS + "rect(left=10%, top=10%, width=50%, height=40%)").svg, "rect");
    expect(r).toMatchObject({ x: "40", y: "20", width: "200", height: "80" });
  });

  it("needs a group with a size", () => {
    expect(codes("g is group():\n  rect(width=50%)")).toContain(Code.PercentNeedsSize);
    expect(codes("g is group(width=100, height=100):\n  rect(width=50%, height=10)")).toEqual([]);
  });

  it("percent gap is of the parent", () => {
    const rects = elements(compile(CANVAS + "a is rect(width=10, height=10)\nb is rect(right-of=a 10%, width=10, height=10)").svg, "rect");
    expect(rects[1]).toMatchObject({ x: "50" });
  });
});

describe("styles", () => {
  it("applies styles left to right, own attributes win, and positions in styles are ignored", () => {
    const src = "a is style(fill=red, stroke=blue, x=99)\nb is style(fill=green)\nr is rect(width=1, height=1, style=a b, stroke=black)";
    const { svg, diagnostics } = compile(src);
    expect(elements(svg, "rect")[0]).toMatchObject({ fill: "green", stroke: "black" });
    expect(elements(svg, "rect")[0].x).toBe("0");
    expect(diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });

  it("reports unknown styles", () => {
    expect(codes("rect(style=nope)")).toContain(Code.UnknownStyle);
  });
});

describe("names", () => {
  it("allows the same name in different groups, not among siblings", () => {
    expect(codes("a is group():\n  box is rect()\nb is group():\n  box is rect()")).toEqual([]);
    expect(codes("box is rect()\nbox is rect()")).toContain(Code.DuplicateName);
  });

  it("reports a missing import file", () => {
    expect(codes("import facebook from icons")).toContain(Code.ImportNotFound);
  });
});

describe("clip", () => {
  it("rejects groups, lines and clipped shapes inside a clip", () => {
    expect(codes("c is clip():\n  g is group():\n    r is rect()\nrect(clip-path=c)")).toContain(Code.InvalidClip);
    expect(codes("c is clip():\n  line(x1=0, y1=0, x2=1, y2=1)\nrect(clip-path=c)")).toContain(Code.InvalidClip);
    expect(codes("a is clip():\n  rect(width=1, height=1, clip-path=a)\nrect(clip-path=a)")).toContain(Code.InvalidClip);
  });

  it("must be defined at the top level", () => {
    expect(codes("g is group():\n  c is clip():\n    rect()")).toContain(Code.ChildrenNotAllowed);
  });

  it("lets library shapes use their own file's clips", () => {
    const lib = "half is clip():\n  rect(width=50%, height=100%)\ns is shape():\n  r is rect(width=10, height=10, clip-path=half)\n";
    const { svg, diagnostics } = compile("import s from lib\none is s()", { path: "main.zyxd", libraries: new Map([["lib.zyxdl", lib]]) });
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "clipPath")).toHaveLength(1);
    expect(elements(svg, "rect")[0]).toMatchObject({ width: "5" });
  });

  it("anchors work between shapes inside a clip", () => {
    const { svg, diagnostics } = compile("two is clip():\n  a is rect(width=10, height=10)\n  b is rect(right-of=a 5, width=10, height=10)\nrect(width=100, height=20, clip-path=two)");
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")[1]).toMatchObject({ x: "15" });
  });
});

describe("robustness", () => {
  it("draws the valid shapes when others have errors", () => {
    const { svg, diagnostics } = compile("good is rect(width=10, height=10)\nbad is rect(width=abc)\nx is blob()\nok is circle(r=5)");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(elements(svg, "rect")).toHaveLength(2);
    expect(elements(svg, "circle")).toHaveLength(1);
  });

  it("escapes user text", () => {
    const { svg } = compile('t is text("<script>&")');
    expect(svg).toContain("&lt;script&gt;&amp;");
    expect(svg).not.toContain("<script>");
  });

  it("finishes on a long anchor chain", () => {
    const lines = ["s0 is rect(width=1, height=1)"];
    for (let i = 1; i < 500; i++) lines.push(`s${i} is rect(right-of=s${i - 1} 1, width=1, height=1)`);
    const { diagnostics, svg } = compile(lines.join("\n"));
    expect(diagnostics).toEqual([]);
    expect(elements(svg, "rect")[499]).toMatchObject({ x: "998" });
  });
});

describe("svg comparator (test helper)", () => {
  const actual = '<svg xmlns="x"><rect x="20" width="200" height="100" rx="5" data-zyx-path="a" /></svg>';

  it("accepts equivalent SVG", () => {
    expect(compareSvg(actual, '<rect width="200.001" height="100" x="20" rx="5" ry="5" y="0" />')).toBeNull();
  });

  it("catches a wrong number, a missing attribute, and a missing element", () => {
    expect(compareSvg(actual, '<rect x="21" width="200" height="100" rx="5" />')).toMatch(/attribute x/);
    expect(compareSvg(actual, '<rect x="20" width="200" height="100" rx="5" fill="red" />')).toMatch(/attribute fill/);
    expect(compareSvg(actual, '<rect x="20" width="200" height="100" rx="5" /><circle r="1" />')).toMatch(/children/);
  });
});
