import { describe, expect, it } from "vitest";
import { drawingBaseName, freeName } from "../../src/plugin/file-name";

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
