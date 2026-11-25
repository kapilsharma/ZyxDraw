import { describe, expect, it } from "vitest";
import { drawingBaseName, freeName, libraryBaseName } from "../../src/plugin/file-name";

describe("new drawing name", () => {
  it("trims, and drops a typed extension", () => {
    expect(drawingBaseName("  Order flow ", "zyxd")).toEqual({ name: "Order flow" });
    expect(drawingBaseName("plan.ZYXD", "zyxd")).toEqual({ name: "plan" });
  });

  it("refuses empty names, file-system characters, link-breaking characters and hidden files", () => {
    expect(drawingBaseName("   ", "zyxd")).toEqual({ problem: "Enter a name" });
    expect(drawingBaseName(".zyxd", "zyxd")).toEqual({ problem: "Enter a name" });
    expect(drawingBaseName("a/b", "zyxd")).toEqual({ problem: "`/` cannot be used in file names" });
    expect(drawingBaseName("what?", "zyxd")).toEqual({ problem: "`?` cannot be used in file names" });
    expect(drawingBaseName("v2#draft", "zyxd")).toEqual({ problem: "`#` would break links to the file" });
    expect(drawingBaseName("[x]", "zyxd")).toEqual({ problem: "`[` would break links to the file" });
    expect(drawingBaseName(".hidden", "zyxd")).toEqual({ problem: "A name starting with `.` makes a hidden file" });
  });

  it("numbers Untitled when taken", () => {
    expect(freeName("Untitled", () => false)).toBe("Untitled");
    const taken = new Set(["Untitled", "Untitled 1"]);
    expect(freeName("Untitled", (n) => taken.has(n))).toBe("Untitled 2");
  });
});

describe("new library name (issue #22)", () => {
  it("is a library name: a dot makes a folder, a typed .zyxdl is dropped", () => {
    expect(libraryBaseName(" shapes ")).toEqual({ name: "shapes" });
    expect(libraryBaseName("cloud.aws")).toEqual({ name: "cloud.aws" });
    expect(libraryBaseName("my-icons_2.ZYXDL")).toEqual({ name: "my-icons_2" });
  });

  it("refuses what an import could not use, saying how to fix it", () => {
    expect(libraryBaseName("")).toEqual({ problem: "Enter a name" });
    expect(libraryBaseName("my shapes")).toEqual({ problem: "A library name cannot contain spaces: use `_`, like `my_shapes`" });
    expect(libraryBaseName("cloud/aws")).toEqual({ problem: "Folders are separated by dots: write `cloud.aws`" });
    expect(libraryBaseName("icons.zyxd")).toEqual({ problem: "Leave out the extension: write `icons`. Only `.zyxdl` libraries can be imported" });
    expect(libraryBaseName("../up")).toHaveProperty("problem");
    expect(libraryBaseName("a..b")).toHaveProperty("problem");
    expect(libraryBaseName(".hidden")).toHaveProperty("problem");
    expect(libraryBaseName("v2#x")).toHaveProperty("problem");
  });

  it("numbers Untitled with _ (no spaces in library names)", () => {
    expect(freeName("Untitled", (n) => n === "Untitled", "_")).toBe("Untitled_1");
  });
});
