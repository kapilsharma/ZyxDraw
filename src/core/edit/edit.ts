/**
 * Canvas edits as text edits (two-way sync, see Docs/dev/Editor.md).
 *
 * The drawing view never changes itself. It asks for an operation (move `api` to x=120), and
 * these functions return minimal text edits against the source. Only the characters that must
 * change are touched, so comments and formatting survive.
 */
import { pathBounds, pointsBounds } from "../geometry";
import type { Box, Scene } from "../layout/layout";
import type { Shape } from "../resolve/resolve";
import type { Attr, SourceRange, Statement } from "../syntax/ast";

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface EditResult {
  edits: TextEdit[];
  /** Short messages for the user (e.g. an anchor was replaced by a position). */
  notices: string[];
  /** Path to select after the edit (new shapes). */
  select?: string;
  /** Point to select after the edit (a point just added), by index. */
  point?: number;
  /** Several shapes to select after the edit (pasted, duplicated, ungrouped). */
  selectPaths?: string[];
}

export type Unit = "percent" | "pixel";

export interface EditOptions {
  /** Unit for newly written positions and sizes. Percent needs a parent with a known size. */
  defaultUnit?: Unit;
}

/** What an edit needs: the source text and the scene compiled from exactly that text. */
export interface EditTarget {
  source: string;
  scene: Scene;
}

export interface Geometry {
  shape: Shape;
  /** Box in frame coordinates. */
  box: Box;
  /** Box in the parent's coordinates. */
  local: Box;
  /** Parent origin in frame coordinates. */
  origin: { x: number; y: number };
  /** Parent size per axis, or null if the parent has no fixed size (auto-sized group). */
  parentSize: [number | null, number | null];
}

type Axis = 0 | 1;

const AXIS = [
  { start: "x", end: "right", center: "cx", after: "right-of", before: "left-of", size: "width" },
  { start: "y", end: "bottom", center: "cy", after: "below", before: "above", size: "height" },
] as const;

// ---- finding shapes ---------------------------------------------------------------------------

export function allShapes(scene: Scene): Shape[] {
  const out: Shape[] = [];
  const walk = (s: Shape) => {
    out.push(s);
    s.children.forEach(walk);
  };
  scene.roots.forEach(walk);
  return out;
}

export function findShape(scene: Scene, path: string): Shape | undefined {
  return allShapes(scene).find((s) => s.path === path);
}

/** The shape the user can edit for a given path: parts of a custom shape map to the instance. */
export function editableShape(scene: Scene, path: string): Shape | undefined {
  let s = findShape(scene, path);
  while (s && s.generated) s = s.parent ?? undefined;
  return s;
}

export function geometry(scene: Scene, shape: Shape): Geometry | null {
  const placed = scene.placed.get(shape.id);
  if (!placed) return null;
  const origin = { x: 0, y: 0 };
  for (let p = shape.parent; p; p = p.parent) {
    const pb = scene.placed.get(p.id)?.box;
    if (pb) {
      origin.x += pb.x;
      origin.y += pb.y;
    }
  }
  const local = placed.box;
  const parentSize: [number | null, number | null] = [null, null];
  const p = shape.parent;
  for (const axis of [0, 1] as Axis[]) {
    // Top level: the canvas size (an infinite canvas has none, so new values are in pixels).
    if (!p) parentSize[axis] = scene.frame.infinite ? null : axis === 0 ? scene.frame.width : scene.frame.height;
    else if (p.attrs.has(AXIS[axis].size) || (p.attrs.has(AXIS[axis].start) && p.attrs.has(AXIS[axis].end)) || (p.layer && !scene.frame.infinite)) {
      const pb = scene.placed.get(p.id)?.box;
      parentSize[axis] = pb ? (axis === 0 ? pb.w : pb.h) : null;
    }
  }
  return { shape, local, origin, parentSize, box: { x: local.x + origin.x, y: local.y + origin.y, w: local.w, h: local.h } };
}

// ---- operations -------------------------------------------------------------------------------

/** Moves a shape so its box starts at (x, y) in frame coordinates. */
export function moveShape(target: EditTarget, path: string, x: number, y: number, options: EditOptions = {}): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  const g = shape && geometry(target.scene, shape);
  if (!shape || !g || !canEdit(shape, result)) return result;

  const se = new StatementEditor(target.source, shape.source, shape.spec.aliases);
  if (shape.type === "line") {
    moveLine(se, shape, g, x - g.box.x, y - g.box.y, result);
  } else {
    const local = [x - g.origin.x, y - g.origin.y];
    for (const axis of [0, 1] as Axis[]) {
      const oldStart = axis === 0 ? g.local.x : g.local.y;
      if (Math.abs(local[axis] - oldStart) < 0.01) continue; // untouched axis keeps its anchor
      writePosition(se, shape, g, axis, local[axis], axis === 0 ? g.local.w : g.local.h, options, result);
    }
  }
  result.edits = normalizeEdits(target.source, se.edits());
  return result;
}

/** Resizes a shape to `box` (frame coordinates). Shapes without a size only move. */
export function resizeShape(target: EditTarget, path: string, box: Box, options: EditOptions = {}): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  const g = shape && geometry(target.scene, shape);
  if (!shape || !g || !canEdit(shape, result)) return result;

  const sizable = shape.type === "rect" || shape.type === "circle" || shape.type === "ellipse" || (shape.type === "group" && shape.attrs.has("width") && shape.attrs.has("height"));
  if (!sizable) {
    const moved = moveShape(target, path, box.x, box.y, options);
    moved.notices.unshift(
      shape.type === "group"
        ? `The size of \`${shape.path}\` comes from its children: give it width and height to resize it`
        : `\`${shape.type}\` cannot be resized here; it was moved instead`,
    );
    return moved;
  }

  const se = new StatementEditor(target.source, shape.source, shape.spec.aliases);
  let w = Math.max(1, box.w);
  let h = Math.max(1, box.h);
  if (shape.type === "circle") {
    const r = Math.round(Math.min(w, h) / 2);
    w = h = 2 * r;
    se.set("r", String(r));
  } else if (shape.type === "ellipse") {
    se.set("rx", fmtPx(w / 2));
    se.set("ry", fmtPx(h / 2));
  }

  const local = [box.x - g.origin.x, box.y - g.origin.y];
  const sizes = [w, h];
  for (const axis of [0, 1] as Axis[]) {
    const oldStart = axis === 0 ? g.local.x : g.local.y;
    const oldSize = axis === 0 ? g.local.w : g.local.h;
    const startMoved = Math.abs(local[axis] - oldStart) > 0.01;
    const sizeChanged = Math.abs(sizes[axis] - oldSize) > 0.01;
    if (!startMoved && !sizeChanged) continue;

    const names = AXIS[axis];
    const stretch = se.find(names.start) && se.find(names.end);
    if (shape.type === "rect" || shape.type === "group") {
      if (sizeChanged && !stretch) writeLength(se, names.size, sizes[axis], g.parentSize[axis], options);
    }
    const after = se.find(names.after);
    const before = se.find(names.before);
    const endMoved = Math.abs(local[axis] + sizes[axis] - (oldStart + oldSize)) > 0.01;
    if (after && !startMoved) continue; // anchored start, only the far edge moved
    if (before && !endMoved) continue; // anchored end, only the near edge moved
    const endBased = se.find(names.end) || se.find(names.center);
    if (startMoved || endBased || before || stretch) {
      writePosition(se, shape, g, axis, local[axis], sizes[axis], options, result);
    }
  }
  result.edits = normalizeEdits(target.source, se.edits());
  return result;
}

/** Deletes a shape (and its children) by removing its lines. */
export function deleteShape(target: EditTarget, path: string): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || !canEdit(shape, result)) return result;

  const lines = fullLines(target.source, shape.source.blockRange);
  result.edits = [{ from: lines.from, to: lines.to, insert: "" }];

  if (shape.name) {
    const users = allShapes(target.scene).filter((s) => s !== shape && !s.generated && refersTo(s, shape));
    if (users.length > 0) {
      result.notices.push(`\`${shape.path}\` was used by ${users.map((u) => `\`${u.path}\``).join(", ")}: update those references`);
    }
  }
  return result;
}

export type Reorder = "front" | "back" | "forward" | "backward";

/** Changes drawing order (layers) among siblings by moving the statement's lines. */
export function reorderShape(target: EditTarget, path: string, where: Reorder): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || !canEdit(shape, result)) return result;

  const siblings = (shape.parent ? shape.parent.children : target.scene.roots).filter((s) => !s.generated);
  const i = siblings.indexOf(shape);
  const targetIndex = where === "front" ? siblings.length - 1 : where === "back" ? 0 : where === "forward" ? i + 1 : i - 1;
  if (targetIndex < 0 || targetIndex >= siblings.length || targetIndex === i) {
    result.notices.push(`\`${shape.path}\` is already ${where === "front" || where === "forward" ? "in front" : "at the back"}`);
    return result;
  }
  const other = siblings[targetIndex];
  const src = target.source;
  const block = fullLines(src, shape.source.blockRange);
  let text = src.slice(block.from, block.to);
  if (block.from < block.to && src[block.from] === "\n") text = text.slice(1); // took the previous newline (last line)
  if (!text.endsWith("\n")) text += "\n";

  let insertAt: number;
  if (targetIndex > i) {
    const o = fullLines(src, other.source.blockRange);
    insertAt = o.to;
    if (insertAt === src.length && !src.endsWith("\n")) text = "\n" + text.slice(0, -1);
  } else {
    insertAt = lineStart(src, other.source.blockRange.start);
  }
  result.edits = normalizeEdits(src, [
    { from: block.from, to: block.to, insert: "" },
    { from: insertAt, to: insertAt, insert: text },
  ]);
  return result;
}

export type NewShapeType = "rect" | "circle" | "ellipse" | "text";

/** Adds a new top-level shape at `box` (frame coordinates), at the end of the file. */
export function insertShape(target: EditTarget, type: NewShapeType, box: Box, options: EditOptions = {}): EditResult {
  const result = blank();
  const name = newShapeName(target, type);

  const { width, height, infinite } = target.scene.frame;
  const pct = options.defaultUnit !== "pixel" && !infinite;
  const pos = (v: number, base: number) => formatLength(v, pct, base);
  const x = pos(box.x, width);
  const y = pos(box.y, height);
  let line: string;
  switch (type) {
    case "rect":
      line = `${name} is rect(x=${x}, y=${y}, width=${pos(box.w, width)}, height=${pos(box.h, height)})`;
      break;
    case "circle":
      line = `${name} is circle(x=${x}, y=${y}, r=${Math.round(Math.min(box.w, box.h) / 2)})`;
      break;
    case "ellipse":
      line = `${name} is ellipse(x=${x}, y=${y}, rx=${Math.round(box.w / 2)}, ry=${Math.round(box.h / 2)})`;
      break;
    case "text":
      line = `${name} is text("Text", x=${x}, y=${y}, font-size=20)`;
      break;
  }
  result.edits = [appendLine(target.source, line)];
  result.select = name;
  return result;
}

/** A free top-level name for a new shape: `rect1`, `rect2`, ... */
export function newShapeName(target: EditTarget, type: string): string {
  const used = new Set(target.scene.roots.map((s) => s.name));
  let n = 1;
  while (used.has(`${type}${n}`)) n++;
  return `${type}${n}`;
}

/** An edit adding `line` at the end of the file. */
export function appendLine(source: string, line: string): TextEdit {
  const prefix = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
  return { from: source.length, to: source.length, insert: `${prefix}${line}\n` };
}

// ---- applying edits ---------------------------------------------------------------------------

/**
 * Sorts edits and merges ones that touch or overlap, so the result is safe to apply in one
 * transaction (CodeMirror requires non-overlapping changes).
 */
export function normalizeEdits(source: string, edits: TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: TextEdit[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.from <= last.to) {
      // Merge: keep the source between the two edits.
      last.insert += source.slice(last.to, Math.max(last.to, e.from)) + e.insert;
      last.to = Math.max(last.to, e.to);
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

/** Applies edits (positions refer to the original source). */
export function applyEdits(source: string, edits: TextEdit[]): string {
  let out = source;
  for (const e of normalizeEdits(source, edits).reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

// ---- helpers ----------------------------------------------------------------------------------

export function blank(): EditResult {
  return { edits: [], notices: [] };
}

export function canEdit(shape: Shape, result: EditResult): boolean {
  if (shape.source.closeParen === undefined) {
    result.notices.push(`Fix the syntax of \`${shape.path}\` first (missing \`)\`)`);
    return false;
  }
  return true;
}

function refersTo(s: Shape, target: Shape): boolean {
  for (const a of s.attrs.values()) {
    const v = a.value;
    if ((v.t === "ref" || v.t === "anchor") && (v.path === target.name || v.path === target.path)) return true;
  }
  return false;
}

/** Writes the position of one axis, keeping the way it is expressed when possible. */
function writePosition(se: StatementEditor, shape: Shape, g: Geometry, axis: Axis, start: number, size: number, options: EditOptions, result: EditResult): void {
  const names = AXIS[axis];
  const base = g.parentSize[axis];
  const startAttr = se.find(names.start);
  const endAttr = se.find(names.end);
  const centerAttr = se.find(names.center);
  const anchor = se.find(names.after) ?? se.find(names.before);

  // `x` means different points for some shapes (see layout.fromAnchorPoint).
  let startValue = start;
  if (shape.type === "text" && axis === 0) {
    const a = shape.attrs.get("text-anchor");
    const k = a && a.value.t === "str" ? (a.value.v === "middle" ? 0.5 : a.value.v === "end" ? 1 : 0) : 0;
    startValue = start + k * size;
  } else if (shape.points || shape.pathData) {
    const b = shape.points ? pointsBounds(shape.points) : pathBounds(shape.pathData!);
    if (Number.isFinite(b.minX)) startValue = start - (axis === 0 ? b.minX : b.minY);
  }

  if (anchor) {
    const pct = options.defaultUnit !== "pixel" && base !== null;
    se.replaceAttr(anchor, names.start, formatLength(startValue, pct, base));
    result.notices.push(`\`${shape.path}\` was anchored with \`${anchor.name}\`; dragging replaced it with \`${names.start}\``);
    return;
  }
  if (startAttr && endAttr) {
    writeLength(se, names.start, startValue, base, options);
    if (base !== null) writeLength(se, names.end, base - start - size, base, options);
    return;
  }
  if (endAttr) {
    if (base !== null) writeLength(se, names.end, base - start - size, base, options);
    return;
  }
  if (centerAttr) {
    writeLength(se, names.center, start + size / 2, base, options);
    return;
  }
  writeLength(se, names.start, startValue, base, options);
}

/** Writes a length, keeping the unit already used by that attribute (or the default unit). */
function writeLength(se: StatementEditor, name: string, value: number, base: number | null, options: EditOptions): void {
  const existing = se.find(name);
  const pct = existing ? existing.values[0]?.kind === "number" && existing.values[0].unit === "%" : options.defaultUnit !== "pixel";
  se.set(name, formatLength(value, pct && base !== null && base > 0, base));
}

/** Moves one end of a line (0: `x1` / `y1`, 1: `x2` / `y2`) by (dx, dy), keeping each number's unit. */
export function moveLineEnd(target: EditTarget, path: string, end: 0 | 1, dx: number, dy: number): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  const g = shape && geometry(target.scene, shape);
  if (!shape || !g || shape.type !== "line" || !canEdit(shape, result)) return result;
  const se = new StatementEditor(target.source, shape.source, shape.spec.aliases);
  moveLine(se, shape, g, dx, dy, result, end === 0 ? ["x1", "y1"] : ["x2", "y2"]);
  result.edits = normalizeEdits(target.source, se.edits());
  return result;
}

function moveLine(se: StatementEditor, shape: Shape, g: Geometry, dx: number, dy: number, result: EditResult, only?: string[]): void {
  if (shape.attrs.has("from") || shape.attrs.has("to")) {
    result.notices.push("A line connected to shapes moves with them: move the shapes instead");
    return;
  }
  for (const [k, axis, d] of [["x1", 0, dx], ["x2", 0, dx], ["y1", 1, dy], ["y2", 1, dy]] as const) {
    if (only && !only.includes(k)) continue;
    const a = se.find(k);
    const line = shape.attrs.get(k);
    const current = line && line.value.t === "len" ? line.value.len : { v: 0, pct: false };
    const base = g.parentSize[axis];
    const px = current.pct && base ? (current.v / 100) * base : current.v;
    const pct = a ? current.pct : false;
    se.set(k, formatLength(px + d, pct && base !== null, base));
  }
}

function formatLength(px: number, pct: boolean, base: number | null): string {
  if (pct && base) return `${Math.round((px / base) * 1000) / 10}%`;
  return fmtPx(px);
}

function fmtPx(v: number): string {
  const r = Math.round(v);
  return Object.is(r, -0) ? "0" : String(r);
}

function lineStart(src: string, pos: number): number {
  return src.lastIndexOf("\n", pos - 1) + 1;
}

/** Whole lines covering `range`, including the final newline (or the previous one at the end). */
export function fullLines(src: string, range: SourceRange): { from: number; to: number } {
  let from = lineStart(src, range.start);
  if (src.slice(from, range.start).trim() !== "") from = range.start;
  const nl = src.indexOf("\n", range.end);
  let to = nl === -1 ? src.length : nl + 1;
  if (nl === -1 && from > 0) from -= 1; // last line: take the newline before it instead
  if (to < from) to = from;
  return { from, to };
}

/** Collects attribute changes for one statement and turns them into text edits. */
export class StatementEditor {
  private readonly replaced = new Map<Attr, string>();
  private readonly added: { name: string; value: string }[] = [];
  private readonly valueChanges = new Map<Attr, string>();
  private readonly removed = new Set<Attr>();
  private content: string | null = null;

  constructor(
    private readonly src: string,
    private readonly stmt: Statement,
    /** Alias -> canonical attribute name (`left` -> `x`). */
    private readonly aliases: Record<string, string>,
  ) {}

  /** The attribute as written in the source for a canonical name (`left` for `x`). */
  find(canonical: string): Attr | undefined {
    return this.stmt.attrs.find((a) => (this.aliases[a.name] ?? a.name) === canonical && !this.replaced.has(a) && !this.removed.has(a));
  }

  /** Removes every attribute written for a canonical name. */
  remove(canonical: string): void {
    for (let a = this.find(canonical); a; a = this.find(canonical)) {
      this.removed.add(a);
      this.valueChanges.delete(a);
    }
  }

  /** Replaces the first positional value (the text of `text`), e.g. with `"Hello"`. */
  setContent(text: string): void {
    this.content = text;
  }

  set(canonical: string, value: string): void {
    const a = this.find(canonical);
    if (a) {
      this.valueChanges.set(a, value);
      return;
    }
    const pending = this.added.find((x) => x.name === canonical);
    if (pending) pending.value = value;
    else this.added.push({ name: canonical, value });
  }

  /** Replaces a whole attribute (`right-of=a 40` -> `x=120`). */
  replaceAttr(attr: Attr, name: string, value: string): void {
    this.replaced.set(attr, `${name}=${value}`);
  }

  edits(): TextEdit[] {
    const out: TextEdit[] = [];
    for (const [a, text] of this.replaced) out.push({ from: a.range.start, to: a.range.end, insert: text });
    for (const [a, value] of this.valueChanges) out.push({ from: a.valueRange.start, to: a.valueRange.end, insert: value });
    for (const a of this.removed) out.push(this.removal(a));
    if (this.content !== null) out.push(this.contentEdit(this.content));
    if (this.added.length > 0) out.push(this.insertion());
    return out;
  }

  private contentEdit(text: string): TextEdit {
    const first = this.stmt.args[0];
    if (first && first.length > 0) return { from: first[0].range.start, to: first[first.length - 1].range.end, insert: text };
    const open = this.stmt.openParen!;
    return { from: open + 1, to: open + 1, insert: text + (this.stmt.attrs.length > 0 ? ", " : "") };
  }

  /** Text to delete for one attribute: its own line, or the attribute and one separating comma. */
  private removal(a: Attr): TextEdit {
    const { src, stmt } = this;
    const ls = lineStart(src, a.range.start);
    const nl = src.indexOf("\n", a.range.end);
    const le = nl === -1 ? src.length : nl;
    const blank = /^[\s,]*$/;
    if (blank.test(src.slice(ls, a.range.start)) && blank.test(src.slice(a.range.end, le)) && ls > (stmt.openParen ?? 0) && le < (stmt.closeParen ?? 0)) {
      return { from: ls, to: Math.min(le + 1, src.length), insert: "" };
    }
    const items = [...stmt.args.filter((v) => v.length > 0).map((v) => ({ start: v[0].range.start, end: v[v.length - 1].range.end })), ...stmt.attrs.map((x) => x.range)]
      .filter((r) => !(r.start === a.range.start && r.end === a.range.end))
      .sort((x, y) => x.start - y.start);
    const sep = /^[ \t]*,?[ \t]*$/;
    const next = items.find((r) => r.start >= a.range.end);
    if (next && sep.test(src.slice(a.range.end, next.start))) return { from: a.range.start, to: next.start, insert: "" };
    const prev = [...items].reverse().find((r) => r.end <= a.range.start);
    if (prev && sep.test(src.slice(prev.end, a.range.start))) return { from: prev.end, to: a.range.end, insert: "" };
    return { from: a.range.start, to: a.range.end, insert: "" };
  }

  private insertion(): TextEdit {
    const { stmt, src } = this;
    const close = stmt.closeParen!;
    const text = this.added.map((x) => `${x.name}=${x.value}`);
    const kept = stmt.attrs.filter((a) => !this.removed.has(a));
    const last = kept[kept.length - 1];
    const multiLine = stmt.openParen !== undefined && src.slice(stmt.openParen, close).includes("\n");
    if (multiLine && last) {
      const ls = lineStart(src, last.range.start);
      const indent = src.slice(ls, last.range.start).match(/^\s*/)?.[0] ?? "  ";
      return { from: last.range.end, to: last.range.end, insert: text.map((t) => `\n${indent}${t}`).join("") };
    }
    const hasContent = kept.length > 0 || stmt.args.length > 0 || this.content !== null;
    return { from: close, to: close, insert: (hasContent ? ", " : "") + text.join(", ") };
  }
}
