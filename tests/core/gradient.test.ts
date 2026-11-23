import { describe, expect, it } from "vitest";
import { compile, definitionAt, parse, Diagnostics } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";

function svg(src: string) {
  const r = compile(CANVAS + src);
  return { svg: r.svg, problems: r.diagnostics.map((d) => `${d.code} ${d.message}`) };
}

describe("gradients", () => {
  it("writes a linear gradient from `from` / `to`, used as a fill", () => {
    const r = svg("sky is gradient(from=white, to=#336699, angle=90)\nbox is rect(width=100, height=50, fill=sky)\n");
    expect(r.problems).toEqual([]);
    expect(r.svg).toContain('<linearGradient id="sky" x1="0.5" y1="0" x2="0.5" y2="1">');
    expect(r.svg).toContain('<stop offset="0%" stop-color="white" />');
    expect(r.svg).toContain('<stop offset="100%" stop-color="#336699" />');
    expect(r.svg).toContain('fill="url(#sky)"');
  });

  it("goes left to right by default and corner to corner at 45 degrees", () => {
    expect(svg("g is gradient(from=red, to=blue)\nrect(width=10, height=10, fill=g)\n").svg).toContain('x1="0" y1="0.5" x2="1" y2="0.5"');
    expect(svg("g is gradient(from=red, to=blue, angle=45)\nrect(width=10, height=10, fill=g)\n").svg).toContain('x1="0" y1="0" x2="1" y2="1"');
  });

  it("takes stops in a block, sorted, with opacity, between from and to", () => {
    const src = "g is gradient(from=red, to=blue):\n  stop(offset=0.8, color=green, opacity=0.5)\n  stop(offset=20%, stop-color=gold)\nrect(width=10, height=10, fill=g)\n";
    const r = svg(src);
    expect(r.problems).toEqual([]);
    const stops = [...r.svg.matchAll(/<stop [^>]*\/>/g)].map((m) => m[0]);
    expect(stops).toEqual([
      '<stop offset="0%" stop-color="red" />',
      '<stop offset="20%" stop-color="gold" />',
      '<stop offset="0.8" stop-color="green" stop-opacity="0.5" />',
      '<stop offset="100%" stop-color="blue" />',
    ]);
  });

  it("writes a radial gradient with its center and radius", () => {
    const r = svg("glow is gradient(type=radial, from=white, to=orange, cx=30%, cy=0.4, r=60%)\nc is circle(r=20, fill=glow)\n");
    expect(r.problems).toEqual([]);
    expect(r.svg).toContain('<radialGradient id="glow" cx="30%" cy="0.4" r="60%">');
  });

  it("works for stroke, canvas background, styles and custom shapes; unused gradients are left out", () => {
    const src = [
      "canvas(width=400, height=300, background=sky)",
      "sky is gradient(from=white, to=blue, angle=90)",
      "warm is gradient(from=red, to=gold)",
      "unused is gradient(from=red, to=gold)",
      "hot is style(fill=warm)",
      "blob is shape(color=black):",
      "  circle(r=5, fill=color)",
      "a is rect(width=10, height=10, style=hot, stroke=sky)",
      "b is blob(color=warm)",
      "",
    ].join("\n");
    const r = compile(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.svg).toContain('<rect width="400" height="300" fill="url(#sky)" />');
    expect(r.svg).toContain('fill="url(#warm)" stroke="url(#sky)"');
    expect(r.svg).toContain('<circle cx="5" cy="5" r="5" fill="url(#warm)"');
    expect(r.svg).not.toContain("unused");
    expect(r.svg.match(/<linearGradient id="warm"/g)).toHaveLength(1);
  });

  it("reports mistakes", () => {
    expect(svg("g is gradient(from=red)\n").problems[0]).toMatch(/ZYX123 Gradient `g` needs two colors/);
    expect(svg("gradient(from=red, to=blue)\n").problems[0]).toMatch(/ZYX123 A gradient needs a name/);
    expect(svg("g is gradient(from=red, to=blue, size=3)\n").problems[0]).toMatch(/ZYX104 Unknown attribute `size` for `gradient`/);
    expect(svg("g is gradient(from=red, to=blue, r=50%)\n").problems[0]).toMatch(/ZYX123 `r` is for radial gradients/);
    expect(svg("g is gradient(from=red, to=blue):\n  rect(width=1)\n").problems[0]).toMatch(/holds `stop/);
    expect(svg("g is gradient(from=red, to=blue):\n  stop(color=red)\n").problems[0]).toMatch(/ZYX109 A stop needs `offset` and `color`/);
    expect(svg("g is gradient(from=red, to=blue):\n  stop(offset=150%, color=red)\n").problems[0]).toMatch(/ZYX107/);
    expect(svg("gradient is rect(width=1)\n").problems[0]).toMatch(/ZYX014/);
  });

  it("ignores a byte order mark at the start of the file", () => {
    expect(compile("﻿canvas(width=10, height=10)\nrect(width=1, height=1)\n").diagnostics).toEqual([]);
  });

  it("links a gradient name to its definition", () => {
    const src = "sky is gradient(from=red, to=blue)\nrect(width=1, height=1, fill=sky)\n";
    const tree = parse(src, new Diagnostics());
    const link = definitionAt(tree, src.lastIndexOf("sky") + 1);
    expect(link?.target).toEqual({ file: null, range: { start: 0, end: 3 } });
  });
});
