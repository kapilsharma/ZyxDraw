import { describe, expect, it } from "vitest";
import { Code, Diagnostics, parse } from "../../src/core";

function parseOk(source: string) {
  const diags = new Diagnostics();
  const tree = parse(source, diags);
  return { tree, diags: diags.list };
}

describe("parser", () => {
  it("parses a one-line shape with name and attributes", () => {
    const { tree, diags } = parseOk("api is rect(width=300, height=200)");
    expect(diags).toEqual([]);
    const [s] = tree.statements;
    expect(s.keyword).toBe("rect");
    expect(s.name).toBe("api");
    expect(s.attrs.map((a) => a.name)).toEqual(["width", "height"]);
  });

  it("reads `name is type(...)` with exact name and type ranges, and unnamed `type(...)`", () => {
    const source = "box_a  is   rect(x=1)\ngroup(x=2):\n  r is rect()";
    const { tree, diags } = parseOk(source);
    expect(diags).toEqual([]);
    const [a, g] = tree.statements;
    expect(source.slice(a.nameRange!.start, a.nameRange!.end)).toBe("box_a");
    expect(source.slice(a.keywordRange.start, a.keywordRange.end)).toBe("rect");
    expect(g.name).toBeUndefined();
    expect(g.keyword).toBe("group");
    expect(g.children[0].name).toBe("r");
  });

  it("uses `is` for definitions too", () => {
    const { tree, diags } = parseOk('card is style(fill=white)\ntop is clip():\n  rect()\ndb is shape(label):\n  rect()\nusers is db(label="U")');
    expect(diags).toEqual([]);
    expect(tree.statements.map((s) => [s.kind, s.name, s.keyword])).toEqual([
      ["style", "card", "style"],
      ["clipDef", "top", "clip"],
      ["shapeDef", "db", "shape"],
      ["shape", "users", "db"],
    ]);
  });

  it("reports the old form, but still reads it", () => {
    const { tree, diags } = parseOk("rect api(x=1)\nstyle card(fill=red)");
    expect(diags.map((d) => [d.code, d.message])).toEqual([
      [Code.OldSyntax, "Write the name first: `api is rect(...)`"],
      [Code.OldSyntax, "Write the name first: `card is style(...)`"],
    ]);
    expect(tree.statements.map((s) => [s.name, s.keyword])).toEqual([
      ["api", "rect"],
      ["card", "style"],
    ]);
  });

  it("refuses keywords and shape types as names", () => {
    const msg = (src: string) => parseOk(src).diags.map((d) => [d.code, d.message]);
    expect(msg("rect is rect()")).toEqual([[Code.ReservedName, "`rect` is a built-in shape type and cannot be used as a name"]]);
    expect(msg("style is style(fill=red)")).toEqual([[Code.ReservedName, "`style` is a keyword and cannot be used as a name"]]);
    expect(msg("group is shape():\n  rect()")[0][0]).toBe(Code.ReservedName);
  });

  it("explains a broken `is`", () => {
    const msg = (src: string) => parseOk(src).diags.map((d) => d.message);
    expect(msg("is rect()")).toEqual(["`is` needs a name before it, like `box is rect(...)`"]);
    expect(msg("box is")).toEqual(["Expected a shape type after `is`, like `box is rect(...)`"]);
    expect(msg("box is (x=1)")).toEqual(["Expected a shape type after `is`, like `box is rect(...)`"]);
    expect(msg("box is rect")[0]).toContain("Expected `(`");
    expect(msg("c is canvas(width=10)")).toEqual(["`canvas` does not take a name: write `canvas(...)` on its own"]);
    expect(msg("i is import a from b")[0]).toContain("`import` does not take a name");
  });

  it("treats newlines inside ( ) as separators, commas optional", () => {
    const { tree, diags } = parseOk("api is rect(\n  width=300\n  height=200,\n  fill=blue\n)");
    expect(diags).toEqual([]);
    expect(tree.statements[0].attrs.map((a) => a.name)).toEqual(["width", "height", "fill"]);
  });

  it("tells colors from comments", () => {
    const { tree, diags } = parseOk("# a comment\na is rect(fill=#4a90d9)   # trailing comment");
    expect(diags).toEqual([]);
    expect(tree.statements).toHaveLength(1);
    expect(tree.statements[0].attrs[0].values[0]).toMatchObject({ kind: "color", value: "#4a90d9" });
  });

  it("keeps value ranges exact (needed for two-way sync)", () => {
    const source = "a is rect(x=20, y=30)";
    const { tree } = parseOk(source);
    const x = tree.statements[0].attrs[0];
    expect(source.slice(x.valueRange.start, x.valueRange.end)).toBe("20");
    expect(source.slice(x.range.start, x.range.end)).toBe("x=20");
  });

  it("reads multi-part values: anchors, percent, functions, style lists", () => {
    const { tree, diags } = parseOk("b is rect(right-of=server1.box 20%, fill=rgb(0, 128, 0), style=primary bold)");
    expect(diags).toEqual([]);
    const [anchor, fill, style] = tree.statements[0].attrs;
    expect(anchor.values).toMatchObject([
      { kind: "ident", value: "server1.box" },
      { kind: "number", value: 20, unit: "%" },
    ]);
    expect(fill.values[0]).toMatchObject({ kind: "func", text: "rgb(0, 128, 0)" });
    expect(style.values.map((v) => (v.kind === "ident" ? v.value : ""))).toEqual(["primary", "bold"]);
  });

  it("nests children under a statement ending with `:`", () => {
    const { tree, diags } = parseOk("g is group(x=1):\n  a is rect()\n  h is group():\n    c is circle(r=1)\nafter is rect()");
    expect(diags).toEqual([]);
    expect(tree.statements.map((s) => s.name)).toEqual(["g", "after"]);
    const g = tree.statements[0];
    expect(g.children.map((s) => s.name)).toEqual(["a", "h"]);
    expect(g.children[1].children.map((s) => s.name)).toEqual(["c"]);
  });

  it("reports an unclosed ( and keeps parsing the next lines", () => {
    const { tree, diags } = parseOk("a is rect(width=10\nb is rect(width=20)");
    expect(diags.map((d) => d.code)).toContain(Code.UnclosedParen);
    expect(tree.statements.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("reports an unexpected indent", () => {
    const { diags } = parseOk("a is rect()\n  b is rect()");
    expect(diags.map((d) => d.code)).toContain(Code.UnexpectedIndent);
  });

  it("reports mixed tabs and spaces", () => {
    const { diags } = parseOk("g is group():\n  a is rect()\n\trect b()");
    expect(diags.map((d) => d.code)).toContain(Code.Indentation);
  });

  it("reports an unterminated string", () => {
    const { diags } = parseOk('t is text("Hello)');
    expect(diags.map((d) => d.code)).toContain(Code.UnterminatedString);
  });

  it("never throws on garbage", () => {
    for (const junk of ["(((", ")))", "= = =", '"', "rect(", "a is rect(x=)", ":::", "\t\t\t", "#", "a is rect(b c d e)"]) {
      expect(() => parseOk(junk)).not.toThrow();
    }
  });
});
