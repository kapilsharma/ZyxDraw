// A path written as steps under `path(...):` instead of `d` (issue #41): it compiles to the same
// SVG, its points can be dragged, its numbers changed from the Steps list, and it can be
// rewritten as `d` and back.
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  canAddPoints,
  canWriteAsD,
  canWriteAsSteps,
  compile,
  deletePoint,
  findShape,
  movePoint,
  pointHandles,
  pointSourceRange,
  setPathNumber,
  stepsAt,
  stepsForD,
  writeAsD,
  writeAsSteps,
} from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const target = (source: string) => ({ source, scene: compile(source).scene });
const errors = (source: string) => compile(source).diagnostics.filter((d) => d.severity === "error");
const pathEl = (svg: string) => /<path [^>]*>/.exec(svg)?.[0];
const steps = (...lines: string[]) => `${CANVAS}p is path(fill=none, stroke=black):\n${lines.map((l) => `  ${l}\n`).join("")}`;
const withD = (d: string) => `${CANVAS}p is path(d="${d}", fill=none, stroke=black)\n`;

describe("a path written as steps", () => {
  it("draws the same SVG as the same path written with d", () => {
    const cases: [string[], string][] = [
      [["start(10, 20)", "line(50, 20)", "line(x=80)", "line(y=60)", "close"], "M 10 20 L 50 20 H 80 V 60 Z"],
      [["start(0, 0)", "curve(60, 0, 20, -20, 40, -20)", "smooth(120, 0, x2=100, y2=20)"], "M 0 0 C 20 -20 40 -20 60 0 S 100 20 120 0"],
      [["start(0, 0)", "curve(60, 0, hx=30, hy=-30)", "smooth(120, 0)"], "M 0 0 Q 30 -30 60 0 T 120 0"],
      [["start(0, 0)", "curve(60, 0, 30, -30)"], "M 0 0 Q 30 -30 60 0"],
      [["start(20, 100)", "arc(180, 100, r=80)", "arc(20, 100, 80, 40, 15, long=yes, clockwise=no)"], "M 20 100 A 80 80 0 0 1 180 100 A 80 40 15 1 0 20 100"],
      [["start(10, 10)", "line-relative(40, 0)", "curve-relative(10, 10, hx=10, hy=0)", "arc-relative(0, 20, r=10)", "jump-to(100, 100)", "jump-to-relative(5, 5)", "line-relative(y=-5)"], "M 10 10 l 40 0 q 10 0 10 10 a 10 10 0 0 1 0 20 M 100 100 m 5 5 v -5"],
    ];
    for (const [lines, d] of cases) {
      const a = compile(steps(...lines));
      expect(errors(steps(...lines)), lines.join("; ")).toEqual([]);
      expect(pathEl(a.svg)).toBe(pathEl(compile(withD(d)).svg));
    }
  });

  it("works out calculations, also with a custom shape's parameters", () => {
    expect(pathEl(compile(steps("start(0, 0)", "line(20 * 2, 10 + 5)")).svg)).toContain('d="M 0 0 L 40 15"');
    const src = `${CANVAS}ring is shape(size):\n  path(fill=gold):\n    start(0, size / 2)\n    arc(size, size / 2, r=size / 2)\n    arc(0, size / 2, r=size / 2)\n    close\nr1 is ring(size=40)\n`;
    expect(errors(src)).toEqual([]);
    expect(compile(src).svg).toContain('d="M 0 20 A 20 20 0 0 1 40 20 A 20 20 0 0 1 0 20 Z"');
  });

  it("reports each mistake clearly", () => {
    const one = (source: string) => errors(source).map((e) => `${e.code} ${e.message}`);
    expect(one(`${CANVAS}p is path(d="M 0 0 L 5 5"):\n  start(0, 0)\n`)).toEqual(["ZYX128 This path has both `d` and steps: keep one of them"]);
    expect(one(steps("line(10, 10)"))[0]).toMatch(/^ZYX129 .*begins with `start\(x, y\)`/);
    expect(one(steps("start(0, 0)", "start(5, 5)"))[0]).toMatch(/^ZYX129 .*use `jump-to\(x, y\)`/);
    expect(one(steps("start(0, 0)", "bend(1, 2)"))[0]).toMatch(/^ZYX129 `bend` is not a step of a path/);
    expect(one(steps("start(0, 0)", "start-relative(1, 2)"))[0]).toMatch(/^ZYX129 `start-relative` is not a step/);
    expect(one(steps("start(0, 0)", "close()"))[0]).toMatch(/^ZYX129 `close` takes nothing/);
    expect(one(steps("start(0, 0)", "a is line(1, 2)"))[0]).toMatch(/^ZYX129 A step of a path has no name/);
    expect(one(steps("start(0, 0)", "line(10)"))[0]).toMatch(/^ZYX109 One value is not clear: write `line\(x=\.\.\.\)`/);
    expect(one(steps("start(0, 0)", "line(1, 2, 3)"))[0]).toMatch(/^ZYX113 `line` takes at most 2 values/);
    expect(one(steps("start(0, 0)", "line(1px, 2)"))[0]).toMatch(/^ZYX106 .*plain number, without `px`/);
    expect(one(steps("start(0, 0)", "line(1, 2, z=3)"))[0]).toMatch(/^ZYX104 Unknown attribute `z` for the step `line`/);
    expect(one(steps("start(0, 0)", "curve(1, 2, x1=3, hx=4)"))[0]).toMatch(/^ZYX129 A `curve` has two handles/);
    expect(one(steps("start(0, 0)", "curve(1, 2, x1=3, y1=4)"))[0]).toMatch(/^ZYX109 `curve` needs `x2`, `y2`/);
    expect(one(steps("start(0, 0)", "arc(5, 5)"))[0]).toMatch(/^ZYX109 `arc` needs a radius/);
    expect(one(steps("start(0, 0)", "arc(5, 5, r=2, rx=3)"))[0]).toMatch(/^ZYX115 `r` sets both radii/);
    expect(one(steps("start(0, 0)", "arc(5, 5, r=2, long=maybe)"))[0]).toMatch(/^ZYX106 `long` is `yes` or `no`/);
    expect(one(`${CANVAS}close\n`)[0]).toMatch(/^ZYX129 `close` is a step of a path: write it in the indented block/);
    expect(one(`${CANVAS}start(1, 2)\n`)[0]).toMatch(/^ZYX129 `start` is a step of a path/);
    expect(one(`${CANVAS}p is path()\n`)[0]).toMatch(/^ZYX109 `d` \(path data\) is missing: .*or the steps/);
  });

  it("keeps `line` the shape outside a path", () => {
    expect(errors(`${CANVAS}l is line(x1=0, y1=0, x2=10, y2=10)\n`)).toEqual([]);
  });
});

describe("editing a path written as steps", () => {
  const SRC = steps("start(10, 20)", "line(50.5, 20)", "line-relative(0, 30)", "arc(10, 20, r=25, clockwise=no)");

  it("drags a point: only the step's own numbers change, and a relative step after it is corrected", () => {
    const t = target(SRC);
    const shape = findShape(t.scene, "p")!;
    expect(pointHandles(t.scene, shape)).toHaveLength(4);
    const out = applyEdits(SRC, movePoint(t, "p", 1, 5, -2).edits);
    expect(out).toBe(SRC.replace("line(50.5, 20)", "line(55.5, 18)").replace("line-relative(0, 30)", "line-relative(-5, 32)"));
    // The point's numbers in the text.
    const r = pointSourceRange(t, "p", 1)!;
    expect(SRC.slice(r.start, r.end)).toBe("50.5, 20");
  });

  it("cannot add or delete points yet, and says how to", () => {
    const t = target(SRC);
    expect(canAddPoints(findShape(t.scene, "p")!)).toBe(false);
    const e = deletePoint(t, "p", 1);
    expect(e.edits).toEqual([]);
    expect(e.notices[0]).toMatch(/written as steps.*Write as d/);
  });

  it("changes one number from the Steps list, where the step writes it", () => {
    const t = target(SRC);
    // Numbers: M 10 20, L 50.5 20, l 0 30, A rx ry turn long clockwise x y.
    expect(applyEdits(SRC, setPathNumber(t, "p", 2, "60").edits)).toBe(SRC.replace("line(50.5, 20)", "line(60, 20)"));
    // `r` is both radii.
    expect(applyEdits(SRC, setPathNumber(t, "p", 7, "30").edits)).toContain("arc(10, 20, r=30, clockwise=no)");
    // A flag is yes or no; one left out is added.
    expect(applyEdits(SRC, setPathNumber(t, "p", 10, "1").edits)).toContain("arc(10, 20, r=25, clockwise=yes)");
    expect(applyEdits(SRC, setPathNumber(t, "p", 9, "yes").edits)).toContain("arc(10, 20, r=25, clockwise=no, long=yes)");
    expect(applyEdits(SRC, setPathNumber(t, "p", 8, "15").edits)).toContain("turn=15");
    expect(setPathNumber(t, "p", 9, "2").notices[0]).toMatch(/long: write yes or no/);
    const calc = steps("start(0, 0)", "line(10 + 5, 0)");
    expect(setPathNumber(target(calc), "p", 2, "3").notices[0]).toMatch(/calculation/);
  });

  it("hovering a step's line shows that step", () => {
    const t = target(SRC);
    const found = stepsAt(t, SRC.indexOf("line-relative"))!;
    expect(found.first).toBe(2);
    expect(found.asSteps).toBe(true);
    expect(found.steps.map((s) => s.words)).toEqual(["Straight line 30 down"]);
    expect(stepsAt(t, SRC.indexOf("fill=none"))).toBeNull();
  });
});

describe("Write as steps and Write as d", () => {
  it("writes every command as a step", () => {
    expect(stepsForD("M 10 20 L 30 40 H 50 V 60 C 1 2 3 4 5 6 S 7 8 9 10 Q 11 12 13 14 T 15 16 A 5 5 0 0 1 17 18 A 4 3 30 1 0 19 20 Z")).toEqual([
      "start(10, 20)",
      "line(30, 40)",
      "line(x=50)",
      "line(y=60)",
      "curve(5, 6, x1=1, y1=2, x2=3, y2=4)",
      "smooth(9, 10, x2=7, y2=8)",
      "curve(13, 14, hx=11, hy=12)",
      "smooth(15, 16)",
      "arc(17, 18, r=5)",
      "arc(19, 20, rx=4, ry=3, turn=30, long=yes, clockwise=no)",
      "close",
    ]);
    expect(stepsForD("m 1 2 3 4 m 5 6 z")).toEqual(["start(1, 2)", "line-relative(3, 4)", "jump-to-relative(5, 6)", "close"]);
  });

  it("goes from d to steps and back without changing the drawing or the numbers", () => {
    const d = "M 20 20 L 180 20 Q 180 160 100 180 a 80 80 0 0 0 -80 -80 Z";
    const src = `${CANVAS}  # a path\np is path(d="${d}", fill=lightblue)\nr is rect(width=10, height=10)\n`;
    const t = target(src);
    expect(canWriteAsSteps(findShape(t.scene, "p")!)).toBe(true);
    const asSteps = applyEdits(src, writeAsSteps(t, "p").edits);
    expect(asSteps).toContain(
      "p is path(fill=lightblue):\n  start(20, 20)\n  line(180, 20)\n  curve(100, 180, hx=180, hy=160)\n  arc-relative(-80, -80, r=80, clockwise=no)\n  close\nr is rect",
    );
    expect(errors(asSteps)).toEqual([]);
    expect(compile(asSteps).svg).toBe(compile(src).svg);

    const t2 = target(asSteps);
    expect(canWriteAsD(findShape(t2.scene, "p")!)).toBe(true);
    const back = applyEdits(asSteps, writeAsD(t2, "p").edits);
    expect(back).toBe(`${CANVAS}  # a path\np is path(fill=lightblue, d="${d}")\nr is rect(width=10, height=10)\n`);
  });

  it("keeps a path inside a group at its depth, and refuses calculations", () => {
    const src = `${CANVAS}g is group():\n  p is path(d="M 0 0 L 10 0")\n`;
    expect(applyEdits(src, writeAsSteps(target(src), "g.p").edits)).toBe(`${CANVAS}g is group():\n  p is path():\n    start(0, 0)\n    line(10, 0)\n`);
    const calc = `${CANVAS}p is path(d="M 0 0 L (5 + 5) 0")\n`;
    expect(canWriteAsSteps(findShape(target(calc).scene, "p")!)).toBe(false);
    const stepsCalc = steps("start(0, 0)", "line(5 + 5, 0)");
    expect(canWriteAsD(findShape(target(stepsCalc).scene, "p")!)).toBe(false);
    expect(writeAsD(target(stepsCalc), "p").notices[0]).toMatch(/calculation/);
  });
});
