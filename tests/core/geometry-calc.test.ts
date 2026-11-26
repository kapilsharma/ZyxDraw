// Calculations in `points` and `d`: `( )` groups worked out at compile time, with a custom
// shape's parameters. The SVG gets plain numbers.
import { describe, expect, it } from "vitest";
import { compile, hasPoints, type Shape } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const svgOf = (src: string) => compile(CANVAS + src).svg;
const errors = (src: string) => compile(CANVAS + src).diagnostics.map((d) => d.message);
const attr = (svg: string, tag: string, name: string) => [...svg.matchAll(new RegExp(`<${tag}[^>]* ${name}="([^"]*)"`, "g"))].map((m) => m[1]);

const TAIL = `bubble is shape(width=100, height=50, aim=10, length=20):
  tip is polygon(points="0,(height) (aim),(height + length) 20,(height)")
`;

describe("calculations in points", () => {
  it("works out each ( ) group", () => {
    expect(attr(svgOf('t is polygon(points="20,20 (20 + 100),20 (20 + 100 / 2),(20 * 4)")'), "polygon", "points")).toEqual(["20,20 120,20 70,80"]);
  });

  it("uses a custom shape's parameters, per instance", () => {
    const svg = svgOf(`${TAIL}a is bubble(x=0, y=0)\nb is bubble(x=200, y=0, aim=-30, length=60, height=80)`);
    expect(attr(svg, "polygon", "points")).toEqual(["0,50 10,70 20,50", "0,80 -30,140 20,80"]);
  });

  it("takes a calculation as an argument, and negative results", () => {
    const svg = svgOf(`${TAIL}a is bubble(aim=-20 * 2)`);
    expect(attr(svg, "polygon", "points")).toEqual(["0,50 -40,70 20,50"]);
  });

  it("passes parameters through a custom shape used inside another", () => {
    const svg = svgOf(`${TAIL}pair is shape(shift=5):\n  one is bubble(aim=shift * 3)\nx is pair(shift=4)`);
    expect(attr(svg, "polygon", "points")).toEqual(["0,50 12,70 20,50"]);
  });

  it("leaves plain points as they were", () => {
    expect(attr(svgOf('t is polygon(points="1,2 3,4 5,6")'), "polygon", "points")).toEqual(["1,2 3,4 5,6"]);
  });

  it("explains unknown names, a missing `)` and an empty group", () => {
    expect(errors('t is polygon(points="0,0 (size),0 5,5")')[0]).toMatch(/In `points`: Unknown name `size`/);
    expect(errors('t is polygon(points="0,0 (10 + 5,0 5,5")')[0]).toMatch(/Missing `\)`/);
    expect(errors('t is polygon(points="0,0 10),0 5,5")')[0]).toMatch(/no matching `\(`/);
    expect(errors('t is polygon(points="0,0 (),0 5,5")')[0]).toMatch(/Empty `\( \)`/);
    expect(errors(`${TAIL}b is shape(label):\n  t is polygon(points="0,0 (label),0 5,5")\nx is b(label="Hi")`)[0]).toMatch(/Unknown name `label`/);
  });
});

describe("calculations in d", () => {
  it("works out each group, and writes a plain path", () => {
    const d = attr(svgOf('p is path(d="M 20 20 L (20 + 100) 20 L (20 + 50) (20 * 4) Z")'), "path", "d")[0];
    expect(d).toBe("M 20 20 L 120 20 L 70 80 Z");
  });

  it("uses parameters", () => {
    const svg = svgOf('arc is shape(w=100):\n  p is path(d="M 0 0 L (w) 0 L (w / 2) (w) Z")\na is arc(w=60)');
    expect(attr(svg, "path", "d")[0]).toBe("M 0 0 L 60 0 L 30 60 Z");
  });

  it("reports errors with the attribute name", () => {
    expect(errors('p is path(d="M 0 0 L (width) 10")')[0]).toMatch(/In `d`: Unknown name `width`/);
  });
});

describe("dragging points written as calculations", () => {
  it("is not offered, so the calculations are kept", () => {
    const shapes = (src: string): Shape[] => compile(CANVAS + src).scene.roots;
    expect(hasPoints(shapes('t is polygon(points="0,0 (10 + 10),0 5,5")')[0])).toBe(false);
    expect(hasPoints(shapes('t is polygon(points="0,0 20,0 5,5")')[0])).toBe(true);
    expect(hasPoints(shapes('p is path(d="M 0 0 L (5 * 2) 10")')[0])).toBe(false);
  });
});
