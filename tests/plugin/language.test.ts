// The highlight scanner is plain code: test it without an editor.
import { describe, expect, it } from "vitest";
import { scanHighlights, zyxdCodeBlocks } from "../../src/plugin/highlight";
import { inPathBlock } from "../../src/plugin/language";

function classes(doc: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of scanHighlights(doc)) map.set(doc.slice(t.from, t.to), t.cls);
  return map;
}

describe("editor highlighting", () => {
  it("classifies every kind of token", () => {
    const c = classes('# note\napi is rect(x=20, fill=#4a90d9, label="Hi", right-of=db 10%)\nbox is shape():\n  d is database(label="x")');
    expect(c.get("# note")).toBe("comment");
    expect(c.get("rect")).toBe("keyword");
    expect(c.get("api")).toBe("def");
    expect(c.get("x")).toBe("property");
    expect(c.get("20")).toBe("number");
    expect(c.get("#4a90d9")).toBe("atom");
    expect(c.get('"Hi"')).toBe("string");
    expect(c.get("right-of")).toBe("property");
    expect(c.get("db")).toBe("variable");
    expect(c.get("10%")).toBe("number");
    expect(c.get("shape")).toBe("keyword");
    expect(c.get("database")).toBe("type");
    expect(c.get("is")).toBe("keyword");
  });

  it("colors an unnamed shape's type, and imports", () => {
    const c = classes("rect(x=1)\nimport card from lib");
    expect(c.get("rect")).toBe("keyword");
    expect(c.get("import")).toBe("keyword");
    expect(c.get("card")).toBe("def");
  });

  it("colors import names, `as`, `from`, the library name and `export`", () => {
    const c = classes("import lambda as ly, queue from cloud.aws\nexport edge, db");
    expect(c.get("lambda")).toBe("def");
    expect(c.get("as")).toBe("keyword");
    expect(c.get("ly")).toBe("def");
    expect(c.get("queue")).toBe("def");
    expect(c.get("from")).toBe("keyword");
    expect(c.get("cloud.aws")).toBe("variable");
    expect(c.get("export")).toBe("keyword");
    expect(c.get("edge")).toBe("def");
    expect(c.get("db")).toBe("def");
  });

  it("colors `preview` as a keyword (library, #23)", () => {
    const c = classes('preview():\n  ec2(label="A")');
    expect(c.get("preview")).toBe("keyword");
    expect(c.get("ec2")).toBe("type");
  });

  it("handles multi-line attribute lists and trailing comments", () => {
    const c = classes("a is rect(\n  width=10\n  fill=red  # why\n)");
    expect(c.get("width")).toBe("property");
    expect(c.get("red")).toBe("variable");
    expect(c.get("# why")).toBe("comment");
  });

  it("finds ```zyxd blocks in a note, and only those", () => {
    const note = "# Title\n```zyxd\na is rect()\n```\ntext\n```python\nx = 1\n```\n~~~~zyxd\nc is circle(r=1)\n~~~~\n```zyxd\nunclosed()";
    const blocks = zyxdCodeBlocks(note).map((b) => note.slice(b.from, b.to));
    expect(blocks).toEqual(["a is rect()\n", "c is circle(r=1)\n", "unclosed()"]);
  });

  it("returns sorted, non-overlapping ranges (required by CodeMirror)", () => {
    const ranges = scanHighlights('g is group(x=1):\n  t is text("a\\"b", x=2) # c\nline(from=a, to=b)');
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBeGreaterThanOrEqual(ranges[i - 1].to);
  });
});

describe("a path written as steps (issue #41)", () => {
  const DOC = "p is path(fill=none):\n  # first\n  start(0, 0)\n  line-relative(10, 0)\n  close\nstart(1, 2)\nq is path(\n    fill=red):\n  jump-to(5, 5)\n";

  it("highlights the steps as keywords inside a path's block only", () => {
    const at = (word: string, from = 0) => {
      const i = DOC.indexOf(word, from);
      return scanHighlights(DOC).find((t) => t.from === i)?.cls;
    };
    expect(at("start")).toBe("keyword");
    expect(at("line-relative")).toBe("keyword");
    expect(at("close")).toBe("keyword");
    expect(at("start", DOC.indexOf("close"))).toBe("type");
    expect(at("jump-to")).toBe("keyword");
  });

  it("knows which lines are in a path's block", () => {
    const line = (word: string) => DOC.lastIndexOf("\n", DOC.indexOf(word)) + 1;
    expect(inPathBlock(DOC, line("start(0"))).toBe(true);
    expect(inPathBlock(DOC, line("close"))).toBe(true);
    expect(inPathBlock(DOC, line("start(1"))).toBe(false);
    expect(inPathBlock(DOC, line("jump-to"))).toBe(true);
    expect(inPathBlock("g is group():\n  start(0, 0)\n", 14)).toBe(false);
  });
});
