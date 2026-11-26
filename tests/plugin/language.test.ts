// The highlight scanner is plain code: test it without an editor.
import { describe, expect, it } from "vitest";
import { scanHighlights, zyxdCodeBlocks } from "../../src/plugin/highlight";

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
