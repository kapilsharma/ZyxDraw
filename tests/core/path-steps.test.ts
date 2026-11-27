// A path's `d` explained in plain words, step by step (issue #40), and editing one number.
import { describe, expect, it } from "vitest";
import { applyEdits, compile, pathSteps, setPathNumber, stepsAt } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const words = (d: string) => pathSteps(d)!.map((s) => s.words);

describe("steps in plain words", () => {
  it("reads the example from the issue", () => {
    expect(words("M 100 100 L 150 50 Z")).toEqual(["Start at 100, 100", "Straight line to 150, 50", "Close the shape: a straight line back to the start"]);
  });

  it("says relative moves as right / left and up / down", () => {
    expect(words("m 0 0 l 50 -50 h -20 v 30 l 0 0")).toEqual([
      "Start at 0, 0",
      "Straight line 50 right and 50 up",
      "Straight line 20 left",
      "Straight line 30 down",
      "Straight line nowhere (0, 0)",
    ]);
    expect(words("M 0 0 L 10 0 m 5 5 l 1 1")[2]).toBe("Jump 5 right and 5 down (a new part)");
    expect(words("M 0 0 L 10 0 M 50 50")[2]).toBe("Jump to 50, 50 (a new part)");
  });

  it("covers every command", () => {
    expect(words("M 0 0 H 10 V 20 C 0 30 10 40 20 20 S 40 0 50 20 Q 60 40 70 20 T 90 20 A 10 10 0 0 1 110 20 Z")).toEqual([
      "Start at 0, 0",
      "Straight line across to x 10",
      "Straight line up or down to y 20",
      "Curve to 20, 20 (handles at 0, 30 and 10, 40)",
      "Smooth curve to 50, 20 (its first handle mirrors the curve before; second handle at 40, 0)",
      "Curve to 70, 20 (pulled toward 60, 40)",
      "Smooth curve to 90, 20 (pulled the way the curve before was)",
      "Arc to 110, 20 (radius 10, the short way, clockwise)",
      "Close the shape: a straight line back to the start",
    ]);
    expect(words("M 0 0 c 0 10 10 10 10 0 a 5 10 30 1 0 10 0")).toEqual([
      "Start at 0, 0",
      "Curve 10 right (handles at 0, 10 from its start and 10, 10 from its start)",
      "Arc 10 right (radius 5 by 10, turned 30°, the long way, counterclockwise)",
    ]);
    // Pairs written after `M` are lines.
    expect(words("M 0 0 10 0 10 10")).toEqual(["Start at 0, 0", "Straight line to 10, 0", "Straight line to 10, 10"]);
  });

  it("gives each number its label and its place in the text", () => {
    const d = "M 1,2 C 3,4 5,6 7,8 a 9 10 11 0 1 12,13";
    const steps = pathSteps(d)!;
    expect(steps[1].numbers.map((n) => [n.label, d.slice(n.start, n.end)])).toEqual([
      ["handle 1 x", "3"],
      ["handle 1 y", "4"],
      ["handle 2 x", "5"],
      ["handle 2 y", "6"],
      ["x", "7"],
      ["y", "8"],
    ]);
    expect(steps[2].numbers.map((n) => n.label)).toEqual(["radius x", "radius y", "turn", "long way (1) or short (0)", "clockwise (1) or not (0)", "x", "y"]);
    expect(steps.map((s) => s.command)).toEqual(["M", "C", "a"]);
  });

  it("draws each step on its own, in absolute numbers", () => {
    expect(pathSteps("M 0,0 l 10,0 q 5,5 10,0 z")!.map((s) => s.highlight)).toEqual(["", "M 0,0 L 10,0", "M 10,0 Q 15,5 20,0", "M 20,0 L 0,0"]);
  });

  it("cannot read calculations", () => {
    expect(pathSteps("M 0 0 L (10 + 5) 0")).toBeNull();
  });
});

describe("in the drawing", () => {
  const SRC = CANVAS + 'g is group(x=10):\n  p is path(d="M 10 10 L 50 10", fill=none, stroke=black)\nr is rect(width=10, height=10)\n';
  const target = () => ({ source: SRC, scene: compile(SRC).scene });

  it("finds the path whose d is at a text position", () => {
    const inText = SRC.indexOf("L 50");
    expect(stepsAt(target(), inText)?.path).toBe("g.p");
    expect(stepsAt(target(), SRC.indexOf('d="'))?.steps).toHaveLength(2);
    expect(stepsAt(target(), SRC.indexOf("fill=none"))).toBeNull();
    expect(stepsAt(target(), SRC.indexOf("rect"))).toBeNull();
  });

  it("changes one number, and only that number", () => {
    const e = setPathNumber(target(), "g.p", 2, "70");
    expect(applyEdits(SRC, e.edits)).toBe(SRC.replace("L 50 10", "L 70 10"));
    expect(e.edits[0].to - e.edits[0].from).toBe(2);
  });

  it("keeps numbers apart, and refuses what is not a number", () => {
    const src = CANVAS + 'p is path(d="M 10-5 L 50 10", fill=none)\n';
    const t = { source: src, scene: compile(src).scene };
    expect(applyEdits(src, setPathNumber(t, "p", 1, "5").edits)).toContain('d="M 10 5 L 50 10"');
    expect(setPathNumber(t, "p", 1, "five").notices[0]).toMatch(/not a number/);
    const arc = CANVAS + 'p is path(d="M 0 0 A 5 5 0 0 1 10 0", fill=none)\n';
    expect(setPathNumber({ source: arc, scene: compile(arc).scene }, "p", 5, "2").notices[0]).toMatch(/write 1 or 0/);
  });
});
