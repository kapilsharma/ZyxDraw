/**
 * A path written as steps (issue #41): an indented block under `path(...):`, one step per line,
 * instead of `d`. Steps compile to a plain `d`, so the SVG is the same.
 *
 *     p is path(fill=none, stroke=black):
 *       start(20, 100)
 *       line(100, 40)
 *       curve(180, 100, hx=140, hy=20)
 *       close
 *
 * Each number of the compiled `d` remembers where it is written in the text, so dragging a point
 * on the drawing changes the step's own number.
 */
import { Code, type Diagnostics } from "../diagnostics";
import type { Expr, SourceRange, Statement, Value } from "../syntax/ast";

/** One kind of step: the attributes positional values fill (in order), and the named-only ones. */
export interface StepSpec {
  /** Filled by positional values, in this order. */
  attrs: string[];
  /** Only by name. */
  named: string[];
  /** One line for autocomplete and hover. */
  about: string;
  /** The SVG commands it writes. */
  svg: string;
  /** What to insert from autocomplete. */
  example: string;
}

/** The steps (without the `-relative` forms). */
export const PATH_STEPS: Record<string, StepSpec> = {
  start: { attrs: ["x", "y"], named: [], svg: "M", example: "start(x, y)", about: "The first point of the path. Every path written as steps begins with it." },
  "jump-to": { attrs: ["x", "y"], named: [], svg: "M", example: "jump-to(x, y)", about: "Begins a new part of the path at x, y, without drawing a line there." },
  line: { attrs: ["x", "y"], named: [], svg: "L H V", example: "line(x, y)", about: "A straight line to x, y. Only `x=` goes across, only `y=` goes up or down." },
  curve: {
    attrs: ["x", "y", "x1", "y1", "x2", "y2"],
    named: ["hx", "hy"],
    svg: "C Q",
    example: "curve(x, y, x1, y1, x2, y2)",
    about: "A curve to x, y, pulled by two handles (x1, y1 and x2, y2), or by one handle (hx, hy).",
  },
  smooth: {
    attrs: ["x", "y", "x2", "y2"],
    named: [],
    svg: "S T",
    example: "smooth(x, y, x2, y2)",
    about: "A curve to x, y that goes on smoothly from the curve before: its first handle mirrors the one before. Give x2, y2 for a second handle.",
  },
  arc: {
    attrs: ["x", "y", "rx", "ry", "turn"],
    named: ["r", "long", "clockwise"],
    svg: "A",
    example: "arc(x, y, r)",
    about: "Part of a circle to x, y with radius r (or an ellipse: rx, ry, turned by turn degrees). `long=yes` takes the long way round, `clockwise=no` goes the other way.",
  },
  close: { attrs: [], named: [], svg: "Z", example: "close", about: "A straight line back to where this part began. Written on its own, without `( )`." },
};

/** Steps that have a `-relative` form: its numbers count from where the step starts. */
const HAS_RELATIVE = new Set(["jump-to", "line", "curve", "smooth", "arc"]);

/** Every step name, `-relative` forms included. */
export const STEP_NAMES: string[] = Object.keys(PATH_STEPS).flatMap((n) => (HAS_RELATIVE.has(n) ? [n, `${n}-relative`] : [n]));

/** The step spec for a name (`line-relative` gives `line`), or undefined. */
export function stepSpec(name: string): { base: string; relative: boolean; spec: StepSpec } | undefined {
  const relative = name.endsWith("-relative");
  const base = relative ? name.slice(0, -"-relative".length) : name;
  const spec = PATH_STEPS[base];
  if (!spec || (relative && !HAS_RELATIVE.has(base))) return undefined;
  return { base, relative, spec };
}

/** One number of the compiled `d`: where it is in `d`, and where it is written in the text. */
export interface CompiledNumber {
  /** Offsets in the compiled `d`. */
  start: number;
  end: number;
  value: number;
  /** The step it belongs to (index in `steps`). */
  step: number;
  /** The attribute it is written as (`x`, `hx`, `r`, `clockwise`...). */
  name: string;
  /** Where its value is written; undefined for a default (`turn`, `long`, `clockwise`). */
  range?: SourceRange;
  /** Written as a plain number (or yes / no), not a calculation or a parameter. */
  literal: boolean;
}

/** A path's steps compiled to `d`. */
export interface CompiledSteps {
  d: string;
  numbers: CompiledNumber[];
  /** The step statements, in order: one `d` command each. */
  steps: Statement[];
}

/** Works out a calculation (in pixels), or says why it cannot. */
export type Evaluate = (e: Expr) => { ok: true; value: number } | { ok: false; error: string };

const fmt = (n: number): string => String(Number(n.toFixed(6)));

/** One value of a step: a number (or a flag as 0 / 1), with where it is written. */
interface StepValue {
  value: number;
  name: string;
  range?: SourceRange;
  literal: boolean;
}

/**
 * Compiles a path's step statements to `d`. Problems are reported in `diags`; null when the
 * path cannot be drawn.
 */
export function compileSteps(steps: Statement[], diags: Diagnostics, evaluate: Evaluate): CompiledSteps | null {
  let d = "";
  const numbers: CompiledNumber[] = [];
  let ok = true;
  const fail = (range: SourceRange, message: string, code: string = Code.InvalidStep) => {
    diags.error(code, message, range);
    ok = false;
  };

  steps.forEach((s, index) => {
    const name = s.keyword;
    if (s.kind !== "shape") {
      fail(s.keywordRange, `\`${name}\` cannot be inside a path: only its steps can (${stepList()})`);
      return;
    }
    if (s.hasBlock) fail(s.range, "A step of a path cannot have a block of its own", Code.ChildrenNotAllowed);
    if (s.name) fail(s.nameRange!, `A step of a path has no name: write \`${name}(...)\` without \`${s.name} is\``);
    const found = stepSpec(name);
    if (!found) {
      fail(s.keywordRange, `\`${name}\` is not a step of a path. Steps: ${stepList()}`);
      return;
    }
    const { base, relative, spec } = found;
    if (index === 0 && base !== "start") fail(s.keywordRange, "A path written as steps begins with `start(x, y)`");
    if (index > 0 && base === "start") fail(s.keywordRange, "`start` is only the first step: use `jump-to(x, y)` to begin a new part of the path");
    if (base === "close") {
      if (s.openParen !== undefined) fail(s.range, "`close` takes nothing: write it on its own, without `( )`");
      d += `${d ? " " : ""}${relative ? "z" : "Z"}`;
      return;
    }

    // Positional values fill the attributes in order, then the named ones.
    const given = new Map<string, { values: Value[]; range: SourceRange }>();
    let order = spec.attrs;
    // `curve(x, y, hx, hy)`: four values are a curve with one handle.
    if (base === "curve" && s.args.length === 4 && !s.attrs.some((a) => /^[xy][12]$/.test(a.name))) order = ["x", "y", "hx", "hy"];
    s.args.forEach((values, i) => {
      if (values.length === 0) return;
      const r = { start: values[0].range.start, end: values[values.length - 1].range.end };
      if (i >= order.length) fail(r, `\`${name}\` takes at most ${order.length} values without names (${order.join(", ")})`, Code.UnexpectedPositional);
      else given.set(order[i], { values, range: r });
    });
    const known = [...spec.attrs, ...spec.named];
    for (const a of s.attrs) {
      if (!known.includes(a.name)) {
        fail(a.nameRange, `Unknown attribute \`${a.name}\` for the step \`${name}\` (attributes: ${known.join(", ")})`, Code.UnknownAttribute);
      } else if (given.has(a.name)) {
        fail(a.range, `\`${a.name}\` is set twice`, Code.DuplicateAttribute);
      } else {
        given.set(a.name, { values: a.values, range: a.valueRange });
      }
    }

    const num = (key: string): StepValue | null => {
      const g = given.get(key);
      if (!g) return null;
      const v = g.values;
      if (v.length !== 1) {
        fail(g.range, `\`${key}\` of \`${name}\` must be one number`, Code.InvalidValue);
        return null;
      }
      const only = v[0];
      if (only.kind === "number") {
        if (only.unit !== "") fail(only.range, `\`${key}\` of \`${name}\` is a plain number, without \`${only.unit}\``, Code.InvalidValue);
        return { value: only.value, name: key, range: g.range, literal: true };
      }
      if (only.kind === "expr") {
        const r = evaluate(only.node);
        if (!r.ok) {
          fail(g.range, r.error, Code.InvalidValue);
          return null;
        }
        return { value: r.value, name: key, range: g.range, literal: false };
      }
      fail(g.range, `\`${key}\` of \`${name}\` must be a number, not \`${only.kind === "string" ? `"${only.value}"` : only.kind === "func" ? only.text : String(only.value)}\``, Code.InvalidValue);
      return null;
    };
    const flag = (key: string, fallback: 0 | 1): StepValue | null => {
      const g = given.get(key);
      if (!g) return { value: fallback, name: key, literal: true };
      const v = g.values;
      const word = v.length === 1 && (v[0].kind === "ident" || v[0].kind === "string") ? String(v[0].value) : "";
      if (word !== "yes" && word !== "no") {
        fail(g.range, `\`${key}\` is \`yes\` or \`no\``, Code.InvalidValue);
        return null;
      }
      return { value: word === "yes" ? 1 : 0, name: key, range: g.range, literal: true };
    };
    const need = (...keys: string[]): boolean => {
      const missing = keys.filter((k) => !given.has(k));
      if (missing.length > 0) fail(s.range, `\`${name}\` needs ${missing.map((k) => `\`${k}\``).join(", ")}`, Code.MissingRequired);
      return missing.length === 0;
    };

    let letter: string;
    let values: (StepValue | null)[];
    switch (base) {
      case "start":
      case "jump-to":
        if (!need("x", "y")) return;
        letter = "M";
        values = [num("x"), num("y")];
        break;
      case "line":
        if (s.args.length === 1 && !given.has("y")) {
          fail(s.range, `One value is not clear: write \`${name}(x=...)\` to go across, or \`${name}(y=...)\` to go up or down`, Code.MissingRequired);
          return;
        }
        if (given.has("x") && given.has("y")) {
          letter = "L";
          values = [num("x"), num("y")];
        } else if (given.has("x")) {
          letter = "H";
          values = [num("x")];
        } else if (given.has("y")) {
          letter = "V";
          values = [num("y")];
        } else {
          fail(s.range, `\`${name}\` needs \`x\` and \`y\` (or only \`x=\` to go across, only \`y=\` to go up or down)`, Code.MissingRequired);
          return;
        }
        break;
      case "curve": {
        const one = given.has("hx") || given.has("hy");
        const two = ["x1", "y1", "x2", "y2"].some((k) => given.has(k));
        if (one && two) {
          fail(s.range, "A `curve` has two handles (`x1`, `y1`, `x2`, `y2`) or one (`hx`, `hy`), not both");
          return;
        }
        if (one) {
          if (!need("x", "y", "hx", "hy")) return;
          letter = "Q";
          values = [num("hx"), num("hy"), num("x"), num("y")];
        } else {
          if (!need("x", "y", "x1", "y1", "x2", "y2")) return;
          letter = "C";
          values = [num("x1"), num("y1"), num("x2"), num("y2"), num("x"), num("y")];
        }
        break;
      }
      case "smooth":
        if (given.has("x2") || given.has("y2")) {
          if (!need("x", "y", "x2", "y2")) return;
          letter = "S";
          values = [num("x2"), num("y2"), num("x"), num("y")];
        } else {
          if (!need("x", "y")) return;
          letter = "T";
          values = [num("x"), num("y")];
        }
        break;
      default: {
        // arc
        if (!need("x", "y")) return;
        if (given.has("r") && (given.has("rx") || given.has("ry"))) {
          fail(given.get("r")!.range, "`r` sets both radii: write `r`, or `rx` and `ry`, not both", Code.ConflictingAttributes);
          return;
        }
        const r = num("r");
        const rx = given.has("r") ? r : num("rx");
        if (!given.has("r") && !given.has("rx")) {
          fail(s.range, "`arc` needs a radius: `r` (or `rx` and `ry` for an ellipse)", Code.MissingRequired);
          return;
        }
        const ry = given.has("ry") ? num("ry") : rx;
        const turn = given.has("turn") ? num("turn") : { value: 0, name: "turn", literal: true };
        letter = "A";
        values = [rx, ry, turn, flag("long", 0), flag("clockwise", 1), num("x"), num("y")];
      }
    }
    if (values.some((v) => v === null)) {
      ok = false;
      return;
    }
    d += `${d ? " " : ""}${relative ? letter.toLowerCase() : letter}`;
    for (const v of values as StepValue[]) {
      const text = fmt(v.value);
      const start = d.length + 1;
      d += ` ${text}`;
      numbers.push({ start, end: start + text.length, value: Number(text), step: index, name: v.name, range: v.range, literal: v.literal });
    }
  });
  return ok ? { d, numbers, steps } : null;
}

function stepList(): string {
  return `${Object.keys(PATH_STEPS).map((n) => `\`${n}\``).join(", ")}, and \`-relative\` forms such as \`line-relative\``;
}
