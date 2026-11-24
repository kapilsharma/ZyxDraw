import { describe, expect, it } from "vitest";
import { Code, Diagnostics, libraryFile, libraryNameProblem, parse } from "../../src/core";

function parseOk(source: string) {
  const diags = new Diagnostics();
  const tree = parse(source, diags);
  return { tree, diags: diags.list };
}

const messages = (source: string) => parseOk(source).diags.map((d) => d.message);

describe("library names", () => {
  it("accepts dotted names of letters, digits, - and _", () => {
    for (const name of ["system", "shapes.system", "cloud.aws.serverless.lambda", "My-Lib_2.Shapes", "a.b-c.d_e"]) {
      expect(libraryNameProblem(name)).toBeNull();
    }
  });

  it("maps a name to its file, keeping the case", () => {
    expect(libraryFile("shapes.system")).toBe("shapes/system.zyxdl");
    expect(libraryFile("Cloud.AWS")).toBe("Cloud/AWS.zyxdl");
  });

  it("suggests dots for `/` paths", () => {
    expect(libraryNameProblem("shapes/system")).toBe("Folders are separated by dots: write `shapes.system`");
    expect(libraryNameProblem("/lib/icons")).toBe("Folders are separated by dots: write `lib.icons`");
    expect(libraryNameProblem("./lib/icons")).toBe("Folders are separated by dots: write `lib.icons`");
  });

  it("asks to leave out the extension", () => {
    expect(libraryNameProblem("icons.zyxd")).toBe("Leave out the extension: write `icons`. Only `.zyxdl` libraries can be imported");
    expect(libraryNameProblem("lib/shapes.zyxd")).toBe("Leave out the extension: write `lib.shapes`. Only `.zyxdl` libraries can be imported");
    expect(libraryNameProblem("shapes.system.zyxdl")).toContain("write `shapes.system`");
  });

  it("refuses parent folders", () => {
    expect(libraryNameProblem("../shapes/system")).toContain("cannot be in a parent folder");
  });

  it("refuses other characters and empty parts", () => {
    for (const name of ["my shapes", "a..b", ".a", "a.", "a$b", "café"]) {
      expect(libraryNameProblem(name)).toContain("only letters, digits, `-` and `_`");
    }
  });
});

describe("import", () => {
  it("reads named imports and the library name", () => {
    const { tree, diags } = parseOk("import service, database from shapes.system");
    expect(diags).toEqual([]);
    const [s] = tree.statements;
    expect(s.kind).toBe("import");
    expect(s.importAll).toBe(false);
    expect(s.importNames?.map((n) => n.name)).toEqual(["service", "database"]);
    expect(s.importPath).toBe("shapes.system");
  });

  it("keeps exact ranges for names, aliases and the library name", () => {
    const src = "import lambda as ly from cloud.aws";
    const [s] = parseOk(src).tree.statements;
    const n = s.importNames![0];
    expect(src.slice(n.range.start, n.range.end)).toBe("lambda");
    expect(src.slice(n.aliasRange!.start, n.aliasRange!.end)).toBe("ly");
    expect(src.slice(s.importPathRange!.start, s.importPathRange!.end)).toBe("cloud.aws");
  });

  it("reads `as` on some names only", () => {
    const { tree, diags } = parseOk("import lambda as ly, queue, topic as t from cloud.aws");
    expect(diags).toEqual([]);
    expect(tree.statements[0].importNames?.map((n) => [n.name, n.alias])).toEqual([
      ["lambda", "ly"],
      ["queue", undefined],
      ["topic", "t"],
    ]);
  });

  it("reads `import *`", () => {
    const { tree, diags } = parseOk("import * from shapes.system");
    expect(diags).toEqual([]);
    expect(tree.statements[0].importAll).toBe(true);
    expect(tree.statements[0].importNames).toEqual([]);
  });

  it("refuses `import * as`", () => {
    const { tree, diags } = parseOk("import * as b from shapes.boxes");
    expect(diags.map((d) => d.message)).toEqual(["`as` works only with named imports, like `import lambda as ly from cloud.aws`"]);
    expect(tree.statements[0].importAll).toBe(true);
    expect(tree.statements[0].importPath).toBe("shapes.boxes");
  });

  it("needs a new name after `as`", () => {
    expect(messages("import lambda as from cloud.aws")).toEqual(["Expected a new name after `as`, like `import lambda as ly from cloud.aws`"]);
  });

  it("refuses a reserved word as the new name", () => {
    const { diags } = parseOk("import box as rect from shapes");
    expect(diags.map((d) => d.code)).toEqual([Code.ReservedName]);
  });

  it("lets `as` be an imported name, since it is not reserved", () => {
    const { tree, diags } = parseOk("import as from shapes");
    expect(diags).toEqual([]);
    expect(tree.statements[0].importNames?.map((n) => n.name)).toEqual(["as"]);
  });

  it("refuses a dotted name before `from`", () => {
    expect(messages("import shapes.system from lib")[0]).toContain("`shapes.system` is not a name");
  });

  it("reports a bad library name on the name itself, and keeps the statement", () => {
    const src = "import database from lib/shapes.zyxd";
    const { tree, diags } = parseOk(src);
    expect(diags.map((d) => d.code)).toEqual([Code.InvalidLibraryName]);
    expect(src.slice(diags[0].range.start, diags[0].range.end)).toBe("lib/shapes.zyxd");
    expect(tree.statements[0].importPath).toBe("lib/shapes.zyxd");
  });

  it("checks quoted library names the same way", () => {
    expect(messages('import a from "shapes/system"')).toEqual(["Folders are separated by dots: write `shapes.system`"]);
    expect(messages('import a from "shapes.system"')).toEqual([]);
  });

  it("explains a broken import", () => {
    const expected = "Expected `import name from library` (for example `import database from shapes.system`)";
    for (const src of ["import", "import a", "import a from", "import from shapes", "import *", "import a b from c"]) {
      expect(messages(src)).toEqual([expected]);
    }
    expect(messages("import a from shapes extra")).toEqual(["Unexpected text after the library name"]);
  });
});

describe("export", () => {
  it("reads the exported names", () => {
    const src = "export outer_box, edge";
    const { tree, diags } = parseOk(src);
    expect(diags).toEqual([]);
    const [s] = tree.statements;
    expect(s.kind).toBe("export");
    expect(s.exportNames?.map((n) => src.slice(n.range.start, n.range.end))).toEqual(["outer_box", "edge"]);
  });

  it("reads several export lines among definitions", () => {
    const { tree, diags } = parseOk("export a\nb is style(fill=red)\nexport b");
    expect(diags).toEqual([]);
    expect(tree.statements.map((s) => s.kind)).toEqual(["export", "style", "export"]);
  });

  it("explains a broken export", () => {
    expect(messages("export")).toEqual(["Expected `export name, name` (for example `export database, primary`)"]);
    expect(messages("export(a)")).toEqual(["Expected `export name, name` (for example `export database, primary`)"]);
    expect(messages("export a b")).toEqual(["Unexpected text after the exported names"]);
    expect(messages("export a as b")).toEqual(["`as` is only for imports: export the name the library uses"]);
  });

  it("makes `export` a reserved word", () => {
    expect(parseOk("export is rect(width=10)").diags.map((d) => d.code)).toContain(Code.ReservedName);
    expect(messages("e is export a")[0]).toBe("`export` does not take a name: write `export ...` on its own");
  });
});
