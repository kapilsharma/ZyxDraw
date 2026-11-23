import { describe, expect, it } from "vitest";
import { applyEdits, compile, insertShape, moveShape } from "../../src/core";

const errors = (source: string) =>
  compile(source)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);

describe("canvas(infinite)", () => {
  it("sizes the SVG to the content plus padding", () => {
    const r = compile("canvas(infinite)\na is rect(x=100, y=50, width=40, height=20)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.scene.frame).toMatchObject({ infinite: true, x: 80, y: 30, width: 80, height: 60 });
    expect(r.svg).toContain('width="80" height="60" viewBox="80 30 80 60"');
  });

  it("allows negative coordinates", () => {
    const r = compile("canvas(infinite)\na is rect(x=-200, y=-100, width=50, height=50)\nb is rect(x=10, y=10, width=10, height=10)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('viewBox="-220 -120 260 160"');
  });

  it("counts strokes and rotation", () => {
    const stroke = compile("canvas(infinite)\na is rect(x=0, y=0, width=100, height=100, stroke=black, stroke-width=10)\n");
    expect(stroke.scene.frame).toMatchObject({ x: -25, y: -25, width: 150, height: 150 });
    // A 100 x 1 bar turned 90 degrees around its center (50, 0.5) stands from y = -49.5 to 50.5,
    // rounded outwards to -50 .. 51, plus 20 padding on each side.
    const turned = compile("canvas(infinite)\na is rect(x=0, y=0, width=100, height=1, rotate=90)\n");
    expect(turned.scene.frame.y).toBe(-70);
    expect(turned.scene.frame.height).toBe(141);
  });

  it("draws the background behind the content area", () => {
    const r = compile("canvas(infinite, background=white)\na is rect(x=-10, y=0, width=10, height=10)\n");
    expect(r.svg).toContain('<rect x="-30" y="-20" width="50" height="50" fill="white" />');
  });

  it("keeps a default size when empty", () => {
    const r = compile("canvas(infinite)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.scene.frame).toMatchObject({ x: 0, y: 0, width: 1000, height: 600 });
  });

  it("refuses width / height and other words", () => {
    expect(errors("canvas(infinite, width=400)\n")[0]).toContain("An infinite canvas has no `width`");
    expect(errors("canvas(endless)\n")[0]).toContain("`canvas` takes `infinite`");
  });

  it("refuses percent and edge positions at the top level, but not in a sized group", () => {
    expect(errors("canvas(infinite)\na is rect(x=10%, y=0, width=10, height=10)\n")[0]).toContain("needs a canvas size");
    expect(errors("canvas(infinite)\na is rect(right=10, y=0, width=10, height=10)\n")[0]).toContain("needs a canvas size");
    expect(errors("canvas(infinite)\ng is group(x=0, y=0, width=200, height=100):\n  a is rect(x=10%, right=10, height=10)\n")).toEqual([]);
  });

  it("writes pixels for new and moved shapes", () => {
    const src = "canvas(infinite)\na is rect(x=10, y=10, width=40, height=20)\n";
    const r = compile(src);
    const t = { source: src, scene: r.scene };
    const add = insertShape(t, "rect", { x: 300, y: -50, w: 100, h: 60 }, { defaultUnit: "percent" });
    expect(applyEdits(src, add.edits)).toContain("rect1 is rect(x=300, y=-50, width=100, height=60)");
    const move = moveShape(t, "a", -40, 25, { defaultUnit: "percent" });
    expect(applyEdits(src, move.edits)).toContain("a is rect(x=-40, y=25, width=40, height=20)");
  });

  it("leaves a fixed canvas as it was", () => {
    const r = compile("canvas(width=160, height=100)\na is rect(x=10%, y=0, width=10, height=10)\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('width="160" height="100" viewBox="0 0 160 100"');
  });
});
