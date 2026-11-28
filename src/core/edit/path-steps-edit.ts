/**
 * Rewriting a path between `d` and steps (issue #41): **Write as steps** turns `d="M 0 0 L 10 0"`
 * into an indented block of steps, **Write as d** turns the steps back into `d`. The drawing
 * stays the same; the numbers keep how they are written.
 */
import type { Shape } from "../resolve/resolve";
import { indentUnit } from "./arrange";
import { blank, canEdit, editableShape, lineStart, normalizeEdits, StatementEditor, type EditResult, type EditTarget, type TextEdit } from "./edit";
import { parseSegs, type Seg } from "./path-nodes";

/** A number as Zyxd reads it (no `+`, no exponent). */
const ZYXD_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

const fmt = (n: number): string => String(Number(n.toFixed(6)));

/** The quoted `d` of a path as written in its statement, or null. */
function writtenD(shape: Shape): { text: string } | null {
  const attr = shape.source.attrs.find((a) => (shape.spec.aliases[a.name] ?? a.name) === "d");
  const v = attr?.values.length === 1 ? attr.values[0] : undefined;
  return v?.kind === "string" ? { text: v.value } : null;
}

/** Whether a path's `d` can be written as steps: written as text, without calculations. */
export function canWriteAsSteps(shape: Shape): boolean {
  if (shape.type !== "path" || shape.steps || shape.generated || shape.instanceOf || shape.source.hasBlock) return false;
  const d = writtenD(shape);
  return d !== null && !d.text.includes("(") && parseSegs(d.text) !== null;
}

/** Whether a path written as steps can be written as `d`: no calculations or parameters in it. */
export function canWriteAsD(shape: Shape): boolean {
  return shape.type === "path" && !!shape.steps && !shape.generated && !shape.instanceOf && shape.steps.numbers.every((n) => n.literal);
}

/** The steps for path text `d`, one line each; null when `d` cannot be read. */
export function stepsForD(d: string): string[] | null {
  const segs = parseSegs(d);
  if (!segs) return null;
  return segs.map((s, i) => stepLine(d, s, i === 0));
}

/** One step for one segment of `d`. */
function stepLine(d: string, s: Seg, first: boolean): string {
  const n = (k: number): string => {
    const written = d.slice(s.nums[k].start, s.nums[k].end).replace(/^\+/, "");
    return ZYXD_NUMBER.test(written) ? written : fmt(s.nums[k].value);
  };
  const rel = s.rel ? "-relative" : "";
  switch (s.upper) {
    case "M":
      // A first `m` is measured from 0, 0: the same as `M`.
      return first ? `start(${n(0)}, ${n(1)})` : `jump-to${rel}(${n(0)}, ${n(1)})`;
    case "L":
      return `line${rel}(${n(0)}, ${n(1)})`;
    case "H":
      return `line${rel}(x=${n(0)})`;
    case "V":
      return `line${rel}(y=${n(0)})`;
    case "C":
      return `curve${rel}(${n(4)}, ${n(5)}, x1=${n(0)}, y1=${n(1)}, x2=${n(2)}, y2=${n(3)})`;
    case "S":
      return `smooth${rel}(${n(2)}, ${n(3)}, x2=${n(0)}, y2=${n(1)})`;
    case "Q":
      return `curve${rel}(${n(2)}, ${n(3)}, hx=${n(0)}, hy=${n(1)})`;
    case "T":
      return `smooth${rel}(${n(0)}, ${n(1)})`;
    case "A": {
      const parts = [n(5), n(6)];
      parts.push(n(0) === n(1) ? `r=${n(0)}` : `rx=${n(0)}, ry=${n(1)}`);
      if (s.nums[2].value !== 0) parts.push(`turn=${n(2)}`);
      if (s.nums[3].value !== 0) parts.push("long=yes");
      if (s.nums[4].value === 0) parts.push("clockwise=no");
      return `arc${rel}(${parts.join(", ")})`;
    }
    default:
      return "close";
  }
}

/** Rewrites a path's `d` as steps, in an indented block under the path. */
export function writeAsSteps(target: EditTarget, path: string): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || shape.path !== path || !canEdit(shape, result)) return result;
  const d = writtenD(shape);
  const lines = d && !d.text.includes("(") && !shape.source.hasBlock ? stepsForD(d.text) : null;
  if (!lines || shape.source.closeParen === undefined) {
    result.notices.push(`\`${path}\`: its \`d\` cannot be written as steps (it must be text in quotes, without calculations)`);
    return result;
  }
  const src = target.source;
  const stmt = shape.source;
  const indent = src.slice(lineStart(src, stmt.range.start), stmt.range.start).match(/^[ \t]*/)![0] + indentUnit(src);
  const se = new StatementEditor(src, stmt, shape.spec.aliases);
  se.remove("d");
  const close = stmt.closeParen! + 1;
  const block: TextEdit = { from: close, to: close, insert: ":" + lines.map((l) => `\n${indent}${l}`).join("") };
  result.edits = normalizeEdits(src, [...se.edits(), block]);
  result.select = path;
  return result;
}

/** Rewrites a path written as steps as `d`, with the numbers as the steps write them. */
export function writeAsD(target: EditTarget, path: string): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || shape.path !== path || !canEdit(shape, result)) return result;
  if (!shape.steps || !canWriteAsD(shape) || shape.source.closeParen === undefined) {
    result.notices.push(`\`${path}\`: these steps cannot be written as \`d\` (a step has a calculation)`);
    return result;
  }
  const src = target.source;
  const stmt = shape.source;
  // The compiled `d`, with each number as it is written in its step.
  let d = shape.steps.d;
  for (const n of [...shape.steps.numbers].reverse()) {
    const written = n.range ? src.slice(n.range.start, n.range.end) : "";
    if (ZYXD_NUMBER.test(written)) d = d.slice(0, n.start) + written + d.slice(n.end);
  }
  const se = new StatementEditor(src, stmt, shape.spec.aliases);
  se.set("d", JSON.stringify(d));
  // The `:` and the block of steps go.
  const block: TextEdit = { from: stmt.closeParen! + 1, to: stmt.blockRange.end, insert: "" };
  result.edits = normalizeEdits(src, [...se.edits(), block]);
  result.select = path;
  return result;
}
