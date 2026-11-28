/**
 * Editing several shapes at once: move, delete, copy / cut / paste, duplicate, group and ungroup.
 * Like every edit, these return text edits. Copied shapes are plain ZyxDraw text, so they can be
 * pasted into the drawing, the text editor or another file.
 */
import { isShapeType, PASSTHROUGH, SHAPES } from "../builtins/catalog";
import { Diagnostics } from "../diagnostics";
import type { Shape } from "../resolve/resolve";
import type { Attr, Statement } from "../syntax/ast";
import { parse } from "../syntax/parser";
import {
  allShapes,
  appendLine,
  applyEdits,
  blank,
  canEdit,
  deleteShape,
  editableShape,
  fullLines,
  geometry,
  moveShape,
  normalizeEdits,
  StatementEditor,
  type EditOptions,
  type EditResult,
  type EditTarget,
  type TextEdit,
} from "./edit";

type Base = [number | null, number | null];

const AXIS = [
  { start: "x", end: "right", center: "cx", after: "right-of", before: "left-of", size: "width", a: "x1", b: "x2" },
  { start: "y", end: "bottom", center: "cy", after: "below", before: "above", size: "height", a: "y1", b: "y2" },
] as const;

/** Attributes whose first value names another shape. */
const REF_ATTRS = new Set(["from", "to", "right-of", "left-of", "above", "below"]);

/** How far a duplicate (or a paste next to its original) is moved, in pixels. */
export const COPY_OFFSET = 10;

// ---- selection --------------------------------------------------------------------------------

/**
 * The editable shapes for `paths`, without duplicates and without shapes whose group is also
 * selected (the group already includes them), in text order.
 */
export function topSelection(target: EditTarget, paths: string[]): Shape[] {
  const shapes = new Set<Shape>();
  for (const p of paths) {
    const s = editableShape(target.scene, p);
    if (s) shapes.add(s);
  }
  const inSelectedGroup = (s: Shape) => {
    for (let p = s.parent; p; p = p.parent) if (shapes.has(p)) return true;
    return false;
  };
  return [...shapes].filter((s) => !inSelectedGroup(s)).sort((a, b) => a.source.range.start - b.source.range.start);
}

/** Moves every shape by (dx, dy) frame pixels. */
export function moveShapes(target: EditTarget, paths: string[], dx: number, dy: number, options: EditOptions = {}): EditResult {
  const result = blank();
  for (const s of topSelection(target, paths)) {
    const g = geometry(target.scene, s);
    if (!g) continue;
    const r = moveShape(target, s.path, g.box.x + dx, g.box.y + dy, options);
    result.edits.push(...r.edits);
    result.notices.push(...r.notices);
  }
  result.edits = normalizeEdits(target.source, result.edits);
  return result;
}

/** Deletes every shape. */
export function deleteShapes(target: EditTarget, paths: string[]): EditResult {
  const result = blank();
  for (const s of topSelection(target, paths)) {
    const r = deleteShape(target, s.path);
    result.edits.push(...r.edits);
    result.notices.push(...r.notices);
  }
  result.edits = normalizeEdits(target.source, result.edits);
  return result;
}

// ---- copy, paste, duplicate -------------------------------------------------------------------

/**
 * The text of the shapes, ready to paste at the top level of a drawing: shapes inside a group
 * get the group's position added and their percent values turned into pixels.
 */
export function copyText(target: EditTarget, paths: string[]): string | null {
  const shapes = topSelection(target, paths);
  if (shapes.length === 0) return null;
  const parts = shapes.map((s) => {
    let text = blockText(target.source, s.source).text;
    const g = geometry(target.scene, s);
    if (s.parent && g) {
      text = rewriteTop(text, (src, stmt, se) => percentToPx(src, stmt, se, g.parentSize));
      text = rewriteTop(text, (_src, stmt, se) => offsetPosition(stmt, se, g.origin.x, g.origin.y, [null, null]));
    }
    return text;
  });
  return parts.join("\n") + "\n";
}

/**
 * Pastes copied text at the end of the drawing. Names already used get a number (`box` ->
 * `box1`), and references between pasted shapes follow. Pasted next to the originals when they
 * are still in this drawing, else in place.
 */
export function pasteText(target: EditTarget, text: string): EditResult {
  const result = blank();
  const snippet = dedent(text.replace(/\r\n?/g, "\n"));
  const diags = new Diagnostics();
  const tree = parse(snippet, diags);
  const top = tree.statements;
  if (top.length === 0 || diags.list.some((d) => d.severity === "error") || top.some((s) => s.kind !== "shape" || s.closeParen === undefined)) {
    result.notices.push("The clipboard has no ZyxDraw shapes to paste");
    return result;
  }
  const original = top.some((s) => target.source.includes(snippet.slice(s.range.start, s.range.end)));
  const d = original ? COPY_OFFSET : 0;
  const { width, height, infinite } = target.scene.frame;
  const base: Base = infinite ? [null, null] : [width, height];
  const used = new Set(target.scene.roots.map((s) => s.name).filter((n): n is string => !!n));
  const renames = newNames(top, used);
  let out = snippet;
  if (d !== 0) out = rewriteTop(out, (_src, stmt, se) => offsetPosition(stmt, se, d, d, base));
  out = renameTop(out, renames);
  result.edits = [appendLine(target.source, out.replace(/\n+$/, ""))];
  result.selectPaths = top.map((s) => (s.name ? (renames.get(s.name) ?? s.name) : null)).filter((n): n is string => !!n);
  return result;
}

/**
 * Copies the shapes in place, moved by `COPY_OFFSET`: each copy goes right after the last
 * selected shape of its group (so it is drawn on top), with a free name.
 */
export function duplicateShapes(target: EditTarget, paths: string[]): EditResult {
  const result = blank();
  const shapes = topSelection(target, paths).filter((s) => canEdit(s, result));
  const byParent = new Map<Shape | null, Shape[]>();
  for (const s of shapes) byParent.set(s.parent, [...(byParent.get(s.parent) ?? []), s]);
  result.selectPaths = [];
  for (const [parent, group] of byParent) {
    const used = siblingNames(target, parent);
    const last = group[group.length - 1];
    const { indent } = blockText(target.source, last.source);
    const base = geometry(target.scene, last)?.parentSize ?? [null, null];
    const copies = group.map((s) => {
      let text = blockText(target.source, s.source).text;
      text = rewriteTop(text, (_src, stmt, se) => offsetPosition(stmt, se, COPY_OFFSET, COPY_OFFSET, base));
      const renames = newNames(parse(text, new Diagnostics()).statements, used);
      for (const n of renames.values()) result.selectPaths!.push(parent ? `${parent.path}.${n}` : n);
      if (renames.size === 0 && s.name) result.selectPaths!.push(parent ? `${parent.path}.${s.name}` : s.name);
      return indentText(renameTop(text, renames), indent);
    });
    const at = lineEnd(target.source, last.source.blockRange.end);
    result.edits.push({ from: at, to: at, insert: "\n" + copies.join("\n") });
  }
  result.edits = normalizeEdits(target.source, result.edits);
  return result;
}

// ---- group and ungroup ------------------------------------------------------------------------

/**
 * Puts the shapes in a new group, written where the frontmost of them was (so the group is
 * drawn at that layer). They keep their place on the canvas: the group has no position of its
 * own, and percent values become pixels (a group without a size has nothing to take a percent of).
 */
export function groupShapes(target: EditTarget, paths: string[]): EditResult {
  const result = blank();
  const shapes = topSelection(target, paths);
  if (shapes.length === 0 || !shapes.every((s) => canEdit(s, result))) return result;
  const parent = shapes[0].parent;
  if (shapes.some((s) => s.parent !== parent)) {
    result.notices.push("Shapes in different groups cannot be grouped together");
    return result;
  }
  const src = target.source;
  const last = shapes[shapes.length - 1];
  const { indent } = blockText(src, last.source);
  const childIndent = indent + indentUnit(src);
  const base = geometry(target.scene, last)?.parentSize ?? [null, null];
  const name = freeName("group", siblingNames(target, parent));
  const children = shapes.map((s) => indentText(rewriteTop(blockText(src, s.source).text, (t, stmt, se) => percentToPx(t, stmt, se, base)), childIndent));

  for (const s of shapes.slice(0, -1)) {
    const from = lineStart(src, s.source.blockRange.start);
    result.edits.push({ from, to: Math.min(src.length, lineEnd(src, s.source.blockRange.end) + 1), insert: "" });
  }
  const from = lineStart(src, last.source.blockRange.start);
  result.edits.push({ from, to: lineEnd(src, last.source.blockRange.end), insert: `${indent}${name} is group():\n${children.join("\n")}` });
  result.edits = normalizeEdits(src, result.edits);
  result.select = parent ? `${parent.path}.${name}` : name;
  return result;
}

/**
 * Replaces a group by its shapes, at the group's place and layer. They keep their place on the
 * canvas (the group's position is added to theirs) and the group's colors and fonts are written
 * on the shapes that do not set their own.
 */
export function ungroupShape(target: EditTarget, path: string): EditResult {
  const result = blank();
  const group = editableShape(target.scene, path);
  if (!group || !canEdit(group, result)) return result;
  if (group.type !== "group" || group.instanceOf) {
    result.notices.push(group.instanceOf ? `\`${group.path}\` is a \`${group.instanceOf}\`, not a group: it cannot be ungrouped` : `\`${group.path}\` is not a group`);
    return result;
  }
  const kept = ["rotate", "scale"].filter((k) => group.attrs.has(k));
  if (group.clip) kept.push("clip-path");
  if (kept.length > 0) {
    result.notices.push(`\`${group.path}\` has ${kept.map((k) => `\`${k}\``).join(" and ")}, which would be lost: remove it first to ungroup`);
    return result;
  }
  const children = group.children.filter((c) => !c.generated);
  const g = geometry(target.scene, group);
  if (children.length === 0 || !g) return result;
  const src = target.source;
  const { indent } = blockText(src, group.source);

  // Colors and fonts the children inherit from the group.
  const inherited = PASSTHROUGH.filter((k) => group.attrs.has(k)).map((k) => {
    const written = src.slice(group.attrs.get(k)!.range.start, group.attrs.get(k)!.range.end);
    return { name: k, value: written.slice(written.indexOf("=") + 1).trim() };
  });

  const used = siblingNames(target, group.parent);
  used.delete(group.name ?? "");
  const renames = new Map<string, string>();
  for (const c of children) {
    if (!c.name) continue;
    const n = used.has(c.name) ? freeName(c.name.replace(/\d+$/, "") || c.name, used) : c.name;
    used.add(n);
    if (n !== c.name) {
      renames.set(c.name, n);
      result.notices.push(`\`${c.path}\` is now \`${n}\` (the name was taken)`);
    }
  }
  const texts = children.map((c) => {
    const childBase = geometry(target.scene, c)?.parentSize ?? [null, null];
    let text = rewriteTop(blockText(src, c.source).text, (t, stmt, se) => percentToPx(t, stmt, se, childBase));
    text = rewriteTop(text, (_src, stmt, se) => {
      offsetPosition(stmt, se, g.local.x, g.local.y, [null, null]);
      for (const { name, value } of inherited) if (!c.attrs.has(name) && !se.find(name)) se.set(name, value);
    });
    return indentText(renameTop(text, renames), indent);
  });

  const outside = allShapes(target.scene).filter((s) => !s.generated && !isInside(s, group) && refersInto(s, group));
  if (outside.length > 0) result.notices.push(`${outside.map((s) => `\`${s.path}\``).join(", ")} referred to \`${group.path}\`: update those references`);

  result.edits = [{ from: lineStart(src, group.source.blockRange.start), to: lineEnd(src, group.source.blockRange.end), insert: texts.join("\n") }];
  const prefix = group.parent ? `${group.parent.path}.` : "";
  result.selectPaths = children.filter((c) => c.name).map((c) => prefix + (renames.get(c.name!) ?? c.name!));
  return result;
}

// ---- text helpers -----------------------------------------------------------------------------

/** A statement with its children, from the start of its first line, and that line's indentation. */
function blockText(src: string, stmt: Statement): { text: string; indent: string } {
  const from = lineStart(src, stmt.blockRange.start);
  const indent = src.slice(from, stmt.range.start);
  const raw = src.slice(from, lineEnd(src, stmt.blockRange.end));
  return { text: /^\s*$/.test(indent) ? dedent(raw) : raw.slice(indent.length), indent: /^\s*$/.test(indent) ? indent : "" };
}

function lineStart(src: string, pos: number): number {
  return src.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(src: string, pos: number): number {
  const nl = src.indexOf("\n", pos);
  return nl === -1 ? src.length : nl;
}

/** Removes the first line's indentation from every line. */
function dedent(text: string): string {
  const lines = text.replace(/^\s*\n/, "").split("\n");
  const indent = /^[ \t]*/.exec(lines[0])![0];
  return lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join("\n");
}

function indentText(text: string, indent: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : indent + l))
    .join("\n");
}

/** One level of indentation as the file writes it (a tab, or two spaces). */
export function indentUnit(src: string): string {
  const m = /\n([ \t]+)\S/.exec(src);
  if (!m) return "  ";
  return m[1].startsWith("\t") ? "\t" : m[1];
}

/** Parses `text` and applies `fn` to each top-level statement; returns the changed text. */
function rewriteTop(text: string, fn: (src: string, stmt: Statement, se: StatementEditor) => void): string {
  const top = parse(text, new Diagnostics()).statements;
  const edits: TextEdit[] = [];
  for (const stmt of top) {
    if (stmt.kind !== "shape" || stmt.closeParen === undefined) continue;
    const se = new StatementEditor(text, stmt, specOf(stmt).aliases);
    fn(text, stmt, se);
    edits.push(...se.edits());
  }
  return applyEdits(text, edits);
}

function specOf(stmt: Statement) {
  return isShapeType(stmt.keyword) ? SHAPES[stmt.keyword] : SHAPES.group;
}

// ---- names ------------------------------------------------------------------------------------

function siblingNames(target: EditTarget, parent: Shape | null): Set<string> {
  const list = parent ? parent.children : target.scene.roots;
  return new Set(list.map((s) => s.name).filter((n): n is string => !!n));
}

/** `base1`, `base2`, ...: the first one not in `used`. */
function freeName(base: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** New names for top-level statements whose name is taken (`used` is updated). */
function newNames(top: Statement[], used: Set<string>): Map<string, string> {
  const renames = new Map<string, string>();
  for (const s of top) {
    if (!s.name) continue;
    const n = used.has(s.name) ? freeName(s.name.replace(/\d+$/, "") || s.name, used) : s.name;
    used.add(n);
    if (n !== s.name) renames.set(s.name, n);
  }
  return renames;
}

/** Renames top-level statements, and references to them from the other top-level statements. */
function renameTop(text: string, renames: Map<string, string>): string {
  if (renames.size === 0) return text;
  const edits: TextEdit[] = [];
  for (const s of parse(text, new Diagnostics()).statements) {
    if (s.name && s.nameRange && renames.has(s.name)) edits.push({ from: s.nameRange.start, to: s.nameRange.end, insert: renames.get(s.name)! });
    for (const a of s.attrs) {
      const v = a.values[0];
      if (!REF_ATTRS.has(a.name) || v?.kind !== "ident") continue;
      const [first, ...rest] = v.value.split(".");
      const n = renames.get(first);
      if (n) edits.push({ from: v.range.start, to: v.range.end, insert: [n, ...rest].join(".") });
    }
  }
  return applyEdits(text, edits);
}

function isInside(s: Shape, group: Shape): boolean {
  for (let p: Shape | null = s; p; p = p.parent) if (p === group) return true;
  return false;
}

/** Whether `s` refers to a shape inside `group` (`group.box`), which stops existing on ungroup. */
function refersInto(s: Shape, group: Shape): boolean {
  for (const a of s.attrs.values()) {
    const v = a.value;
    if ((v.t === "ref" || v.t === "anchor") && (v.path.startsWith(`${group.path}.`) || (group.name && v.path.startsWith(`${group.name}.`)))) return true;
  }
  return false;
}

// ---- numbers ----------------------------------------------------------------------------------

function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

/** The single plain number of an attribute (not a calculation), or null. */
function numberOf(a: Attr | undefined): { v: number; unit: "" | "px" | "%" } | null {
  const v = a?.values.length === 1 ? a.values[0] : undefined;
  return v?.kind === "number" ? { v: v.value, unit: v.unit } : null;
}

/** Adds `d` pixels to a number attribute, keeping its unit. False when it cannot (percent without a size). */
function shift(se: StatementEditor, name: string, a: Attr, d: number, base: number | null): boolean {
  const n = numberOf(a);
  if (!n) return false;
  if (n.unit === "%") {
    if (!base) return false;
    se.set(name, `${fmt(n.v + (d / base) * 100)}%`);
  } else se.set(name, fmt(n.v + d) + n.unit);
  return true;
}

/**
 * Moves a statement by (dx, dy) by changing its position numbers. A shape placed next to another
 * (`right-of`, `below`, ...) follows that one instead. A shape without a position gets one.
 */
function offsetPosition(stmt: Statement, se: StatementEditor, dx: number, dy: number, base: Base): void {
  if (stmt.keyword === "line") {
    for (const axis of [0, 1] as const) {
      const d = axis === 0 ? dx : dy;
      for (const k of [AXIS[axis].a, AXIS[axis].b]) {
        const a = se.find(k);
        if (a) shift(se, k, a, d, base[axis]);
      }
    }
    return;
  }
  for (const axis of [0, 1] as const) {
    const d = axis === 0 ? dx : dy;
    if (d === 0) continue;
    const n = AXIS[axis];
    if (se.find(n.after) || se.find(n.before)) continue;
    const start = se.find(n.start);
    const end = se.find(n.end);
    const center = se.find(n.center);
    if (start || center || end) {
      if (start) shift(se, n.start, start, d, base[axis]);
      else if (center) shift(se, n.center, center, d, base[axis]);
      if (end) shift(se, n.end, end, -d, base[axis]);
      continue;
    }
    // Not placed: at 0 (for a path or polygon, `x` / `y` move its own numbers).
    se.set(n.start, fmt(d));
  }
}

/** Turns percent positions and sizes into pixels of `base` (the parent's size). */
function percentToPx(src: string, stmt: Statement, se: StatementEditor, base: Base): void {
  const spec = specOf(stmt);
  for (const a of stmt.attrs) {
    const canonical = spec.aliases[a.name] ?? a.name;
    const kind = spec.attrs[canonical]?.kind;
    const axis = kind === "lenX" || kind === "anchorX" ? 0 : kind === "lenY" || kind === "anchorY" ? 1 : null;
    const b = axis === null ? null : base[axis];
    if (!b) continue;
    if (kind === "anchorX" || kind === "anchorY") {
      const gap = a.values[1];
      if (gap?.kind === "number" && gap.unit === "%") se.set(canonical, `${src.slice(a.values[0].range.start, a.values[0].range.end)} ${fmt((gap.value / 100) * b)}`);
      continue;
    }
    const n = numberOf(a);
    if (n && n.unit === "%") se.set(canonical, fmt((n.v / 100) * b));
  }
}

// ---- layers (issue #11) -----------------------------------------------------------------------

/**
 * Moves a new shape into a layer: `result` is the edit of an insert (`insertShape`, `insertPath`,
 * `pasteText`, ...), which appends at the end of the file. Its text goes to the end of the
 * layer's block instead, indented, with names free inside the layer. Positions keep their place
 * on the canvas: for a layer that does not cover the canvas, they are moved and percent becomes
 * pixels. Anything else is returned unchanged.
 */
export function intoLayer(target: EditTarget, result: EditResult, layerPath: string): EditResult {
  const layer = editableShape(target.scene, layerPath);
  const src = target.source;
  if (!layer?.layer || result.edits.length !== 1) return result;
  const add = result.edits[0];
  if (add.from !== src.length || add.to !== add.from) return result;
  const g = geometry(target.scene, layer);
  if (!g) return result;

  let text = add.insert.replace(/^\n/, "").replace(/\n+$/, "");
  const { width, height, infinite } = target.scene.frame;
  const coversCanvas = !infinite && g.box.x === 0 && g.box.y === 0 && g.box.w === width && g.box.h === height;
  if (!coversCanvas) {
    if (!infinite) text = rewriteTop(text, (s, stmt, se) => percentToPx(s, stmt, se, [width, height]));
    if (g.box.x !== 0 || g.box.y !== 0) text = rewriteTop(text, (_s, stmt, se) => offsetPosition(stmt, se, -g.box.x, -g.box.y, [null, null]));
  }
  const renames = newNames(parse(text, new Diagnostics()).statements, siblingNames(target, layer));
  text = renameTop(text, renames);

  const first = layer.children.find((c) => !c.generated);
  const indent = first
    ? src.slice(lineStart(src, first.source.range.start), first.source.range.start)
    : blockText(src, layer.source).indent + indentUnit(src);
  const edits: TextEdit[] = [];
  if (!layer.source.hasBlock) {
    if (layer.source.closeParen === undefined) return result;
    edits.push({ from: layer.source.closeParen + 1, to: layer.source.closeParen + 1, insert: ":" });
  }
  const at = lineEnd(src, layer.source.blockRange.end);
  edits.push({ from: at, to: at, insert: "\n" + indentText(text, indent) });

  const inLayer = (name: string) => `${layer.path}.${renames.get(name) ?? name}`;
  return {
    ...result,
    edits: normalizeEdits(src, edits),
    select: result.select ? inLayer(result.select) : undefined,
    selectPaths: result.selectPaths?.map(inLayer),
  };
}

/** Adds an empty layer at the end of the drawing (in front of everything): `layer1 is layer()`. */
export function newLayer(target: EditTarget): EditResult {
  const result = blank();
  const name = freeName("layer", siblingNames(target, null));
  result.edits = [appendLine(target.source, `${name} is layer()`)];
  result.select = name;
  return result;
}

/** Where a dragged row is dropped in the layers view. */
export interface DropPlace {
  /** The new layer or group (null = top level of the drawing). */
  parent: string | null;
  /** Right after this sibling in the text: drawn just in front of it. */
  after?: string;
  /** Right before this sibling in the text: drawn just behind it. */
  before?: string;
  // Neither: at the end of the parent's block, in front of all its shapes.
}

/**
 * Moves a shape (with its children) to another place in the drawing order, possibly into another
 * layer or group, by moving its block of text. It keeps its place on the canvas: when the parent
 * changes, positions are moved by the difference and percent becomes pixels where the sizes
 * differ. A name taken in the new parent gets a number. A layer stays at the top level.
 * References to the shape by its old path are not rewritten: see `brokenReferences`.
 */
export function moveShapeTo(target: EditTarget, path: string, place: DropPlace): EditResult {
  const result = blank();
  const src = target.source;
  const shape = editableShape(target.scene, path);
  if (!shape || !canEdit(shape, result)) return result;
  const parent = place.parent === null ? null : (editableShape(target.scene, place.parent) ?? undefined);
  if (parent === undefined) return result;
  if (parent) {
    if (shape.layer) {
      result.notices.push("A layer stays at the top level of the drawing");
      return result;
    }
    if (parent.type !== "group" || parent.instanceOf) {
      result.notices.push(`Only a layer or a group can hold shapes, not \`${parent.path}\``);
      return result;
    }
    if (isInside(parent, shape)) {
      result.notices.push(`\`${shape.path}\` cannot go inside itself`);
      return result;
    }
    if (!canEdit(parent, result)) return result;
  }
  const siblings = (parent ? parent.children : target.scene.roots).filter((s) => !s.generated && s !== shape);
  const ref = place.after ?? place.before;
  const anchor = ref ? siblings.find((s) => s.path === ref) : undefined;
  if (ref && !anchor) return result; // dropped on itself

  // The block, as it will read in its new place.
  const sameParent = shape.parent === parent;
  let text = blockText(src, shape.source).text.replace(/\n+$/, "");
  let name = shape.name;
  let indent = blockText(src, shape.source).indent;
  if (!sameParent) {
    const g = geometry(target.scene, shape);
    const pg = parent ? geometry(target.scene, parent) : null;
    if (!g || (parent && !pg)) return result;
    const dx = g.origin.x - (pg?.box.x ?? 0);
    const dy = g.origin.y - (pg?.box.y ?? 0);
    const base = contentSize(target, parent);
    if (dx !== 0 || dy !== 0 || base[0] !== g.parentSize[0] || base[1] !== g.parentSize[1]) {
      text = rewriteTop(text, (s, stmt, se) => percentToPx(s, stmt, se, g.parentSize));
      if (dx !== 0 || dy !== 0) text = rewriteTop(text, (_s, stmt, se) => offsetPosition(stmt, se, dx, dy, [null, null]));
    }
    const renames = newNames(parse(text, new Diagnostics()).statements, siblingNames(target, parent));
    text = renameTop(text, renames);
    if (name) name = renames.get(name) ?? name;
    const first = siblings[0];
    indent = !parent ? "" : first ? src.slice(lineStart(src, first.source.range.start), first.source.range.start) : blockText(src, parent.source).indent + indentUnit(src);
  }
  const moved = indentText(text, indent);

  const edits: TextEdit[] = [];
  const removed = fullLines(src, shape.source.blockRange);
  edits.push({ from: removed.from, to: removed.to, insert: "" });
  if (anchor && place.before) {
    const at = lineStart(src, anchor.source.blockRange.start);
    edits.push({ from: at, to: at, insert: moved + "\n" });
  } else {
    const last = anchor ?? siblings[siblings.length - 1];
    if (last) {
      const at = lineEnd(src, last.source.blockRange.end);
      edits.push({ from: at, to: at, insert: "\n" + moved });
    } else if (parent) {
      // An empty layer or group: open its block.
      if (!parent.source.hasBlock) edits.push({ from: parent.source.closeParen! + 1, to: parent.source.closeParen! + 1, insert: ":" });
      const at = lineEnd(src, parent.source.blockRange.end);
      edits.push({ from: at, to: at, insert: "\n" + moved });
    } else {
      return result; // alone at the top level: nowhere else to go
    }
  }
  // The old layer or group is left empty: close its block.
  const old = shape.parent;
  if (old && !sameParent && old.children.filter((c) => !c.generated).length === 1 && old.source.closeParen !== undefined) {
    const colon = src.indexOf(":", old.source.closeParen);
    if (colon !== -1 && colon < lineEnd(src, old.source.closeParen)) edits.push({ from: colon, to: colon + 1, insert: "" });
  }

  result.edits = normalizeEdits(src, edits);
  if (applyEdits(src, result.edits) === src) result.edits = [];
  if (name) result.select = parent ? `${parent.path}.${name}` : name;
  return result;
}

/** Size that `%` refers to inside `parent` (the canvas at the top level), per axis; null if none. */
function contentSize(target: EditTarget, parent: Shape | null): Base {
  const { width, height, infinite } = target.scene.frame;
  if (!parent) return infinite ? [null, null] : [width, height];
  const box = geometry(target.scene, parent)?.box;
  const known = (size: string, start: string, end: string) =>
    parent.attrs.has(size) || (parent.attrs.has(start) && parent.attrs.has(end)) || (!!parent.layer && !infinite);
  return [box && known("width", "x", "right") ? box.w : null, box && known("height", "y", "bottom") ? box.h : null];
}
