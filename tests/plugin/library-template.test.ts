// The text of a new library (issue #22) must be a working library.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/core";
import { libraryTemplate } from "../../src/plugin/library-template";

describe("new library template", () => {
  const text = libraryTemplate("cloud.aws");

  it("is a library without problems", () => {
    expect(compile(text, { path: "lib/cloud/aws.zyxdl" }).diagnostics).toEqual([]);
  });

  it("shows its card with an example value from preview()", () => {
    const r = compile(text, { path: "lib/cloud/aws.zyxdl" });
    expect(r.scene.gallery!.cells.map((c) => c.shape.preview)).toEqual([{ def: "card", placeholder: false }]);
    expect(r.svg).toContain(">Card</text>");
  });

  it("names the library in its import example, and has no export line", () => {
    expect(text).toContain("#   import card from cloud.aws\n");
    expect(text).not.toMatch(/^export /m);
  });

  it("can be imported by a drawing, as the comment says", () => {
    const result = compile('canvas(width=200, height=100)\nimport card from cloud.aws\nc is card(label="Hi")\n', {
      path: "lib/plan.zyxd",
      libraries: new Map([["lib/cloud/aws.zyxdl", text]]),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).toContain(">Hi</text>");
  });
});
