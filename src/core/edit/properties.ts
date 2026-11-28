/**
 * Property sheet for the drawing view: every attribute a shape (or the canvas) can take, with the
 * value as written in the text, and an edit that writes one property back as a minimal text change.
 */
import type { AttrKind, AttrSpec } from "../builtins/catalog";
import type { Diagnostic } from "../diagnostics";
import type { Box } from "../layout/layout";
import type { Shape } from "../resolve/resolve";
import type { Attr, SyntaxTree, Value } from "../syntax/ast";
import { blank, canEdit, editableShape, geometry, normalizeEdits, StatementEditor, type EditResult, type EditTarget } from "./edit";

export interface PropertyTarget extends EditTarget {
  tree: SyntaxTree;
  diagnostics: Diagnostic[];
}

export type PropertySection =
  | "Canvas"
  | "Content"
  | "Parameters"
  | "Position"
  | "Size"
  | "Rotate and scale"
  | "Fill and stroke"
  | "Text"
  | "Line"
  | "Other";

export const SECTION_ORDER: PropertySection[] = ["Canvas", "Content", "Parameters", "Position", "Size", "Rotate and scale", "Fill and stroke", "Text", "Line", "Other"];

export interface PropertyField {
  /** Canonical attribute name (`x`, not `left`). `text` for the content of a text shape. */
  name: string;
  /** Name as written in the text when it is an alias (`left`). */
  written?: string;
  /** Value kind, `content` for the text of a text shape, `param` for a custom shape parameter. */
  kind: AttrKind | "content" | "param";
  section: PropertySection;
  /** Current value as written (strings without their quotes). Empty when not set. */
  value: string;
  /** Hint shown when not set: the default, or the value coming from a style. */
  placeholder?: string;
  /** Choices for `enum` attributes. */
  options?: readonly string[];
  /** A problem reported on this attribute. */
  problem?: string;
  /** Required parameter. */
  required?: boolean;
}

export interface PropertySheet {
  /** Path of the shape, or null for the canvas. */
  path: string | null;
  /** `rect`, `database`, `canvas`. */
  type: string;
  name?: string;
  fields: PropertyField[];
  /** Box in frame coordinates, for display. */
  box?: Box;
  /** Why the sheet cannot be edited, if so. */
  readOnly?: string;
}

const SECTION: Record<string, PropertySection> = {};
for (const n of ["x", "y", "right", "bottom", "right-of", "left-of", "above", "below", "cx", "cy", "x1", "y1", "x2", "y2"]) SECTION[n] = "Position";
for (const n of ["width", "height", "r", "rx", "ry", "radius"]) SECTION[n] = "Size";
for (const n of ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "opacity", "display"]) SECTION[n] = "Fill and stroke";
for (const n of ["font-size", "font-family", "font-weight", "font-style", "text-anchor"]) SECTION[n] = "Text";
for (const n of ["from", "to", "arrow", "label"]) SECTION[n] = "Line";
for (const n of ["rotate", "scale"]) SECTION[n] = "Rotate and scale";

/** What an unset attribute means (SVG defaults and ours). */
const DEFAULTS: Record<string, string> = {
  x: "0",
  y: "0",
  x1: "0",
  y1: "0",
  x2: "0",
  y2: "0",
  fill: "black",
  stroke: "none",
  "stroke-width": "1",
  opacity: "1",
  display: "inline",
  "fill-opacity": "1",
  "stroke-opacity": "1",
  "font-size": "16",
  "text-anchor": "start",
  arrow: "none",
  rotate: "0",
  scale: "1",
};

const CANVAS_SPECS: Record<string, AttrSpec> = {
  width: { kind: "px", min: 0, exclusiveMin: true },
  height: { kind: "px", min: 0, exclusiveMin: true },
  background: { kind: "paint" },
};
const CANVAS_DEFAULTS: Record<string, string> = { width: "1000", height: "600", background: "none" };

/** The property sheet of a shape (by path) or of the canvas (null). */
export function propertySheet(target: PropertyTarget, path: string | null): PropertySheet | null {
  if (target.scene.gallery) return previewSheet(target, path);
  if (path === null) return canvasSheet(target);
  const shape = editableShape(target.scene, path);
  if (!shape) return null;
  const stmt = shape.source;
  const g = geometry(target.scene, shape);
  const sheet: PropertySheet = { path: shape.path, type: shape.instanceOf ?? shape.type, name: shape.name, fields: [], box: g?.box };
  if (stmt.closeParen === undefined && !shape.preview?.placeholder) sheet.readOnly = "Fix the syntax of this shape first (missing `)`)";

  if (shape.spec.positional === "text") {
    const first = stmt.args[0];
    const v = first && first.length === 1 && first[0].kind === "string" ? first[0].value : first ? slice(target.source, first) : "";
    sheet.fields.push({ name: "text", kind: "content", section: "Content", value: v, problem: problemIn(target, first?.length ? rangeOf(first) : undefined) });
  }

  const params = new Set<string>();
  for (const p of shape.params ?? []) {
    params.add(p.name);
    const a = stmt.attrs.find((x) => x.name === p.name);
    sheet.fields.push({
      name: p.name,
      kind: "param",
      section: "Parameters",
      value: a ? valueText(target.source, a) : "",
      placeholder: p.default ?? "required",
      required: p.default === undefined,
      problem: a && problemIn(target, a.range),
    });
  }

  const aliases = shape.spec.aliases;
  for (const [name, spec] of Object.entries(shape.spec.attrs)) {
    if (params.has(name)) continue;
    // A path written as steps has no `d` to fill in: its steps are in the Steps section (issue #41).
    if (name === "d" && shape.steps) continue;
    // Instances are groups; their width / height come from parameters when the shape has them.
    const written = stmt.attrs.find((a) => (aliases[a.name] ?? a.name) === name);
    const effective = shape.attrs.get(name);
    let placeholder = DEFAULTS[name];
    if (!written && effective) {
      const fromStyle = styleValue(target.source, effective.range, effective.written);
      if (fromStyle !== null) placeholder = `${fromStyle} (style)`;
    }
    sheet.fields.push({
      name,
      written: written && written.name !== name ? written.name : undefined,
      kind: spec.kind,
      section: SECTION[name] ?? "Other",
      value: written ? valueText(target.source, written) : "",
      placeholder,
      options: spec.values,
      problem: written && problemIn(target, written.range),
    });
  }
  sortFields(sheet.fields);
  return sheet;
}

/** Fields of a gallery cell: what a line in `preview()` can set (issue #25). */
const PREVIEW_FIELDS = new Set(["width", "height", "display"]);

/**
 * A library (issue #25): the Attributes of a gallery cell are its line in `preview()`: the
 * parameters, `width` and `height`. Nothing selected: a hint instead of the canvas.
 */
function previewSheet(target: PropertyTarget, path: string | null): PropertySheet | null {
  const shape = path === null ? undefined : editableShape(target.scene, path);
  if (!shape?.preview) {
    return { path: null, type: "Library", fields: [], readOnly: "Select a shape to try it with other values. They are written to the `preview():` block, never to the shape itself." };
  }
  const sheet = propertySheet({ ...target, scene: { ...target.scene, gallery: undefined } }, shape.path);
  if (!sheet) return null;
  sheet.fields = sheet.fields.filter((f) => f.section === "Parameters" || PREVIEW_FIELDS.has(f.name));
  for (const f of sheet.fields) if (f.required && !f.value) f.placeholder = `${f.name} (preview)`;
  if (shape.preview.placeholder) sheet.name = "(no line in preview yet)";
  return sheet;
}

/**
 * The first value set on a gallery cell without a line in `preview()` (issue #25): adds the line,
 * `database(label="Orders")`, at the end of the block, or adds the block at the end of the file.
 */
function addPreviewLine(target: PropertyTarget, shape: Shape, field: PropertyField, value: string, result: EditResult): EditResult {
  if (value === "") return result;
  const line = `${shape.preview!.def}(${field.name}=${formatValue(field, value, shape)})`;
  const src = target.source;
  const block = target.scene.gallery?.block;
  if (block) {
    const last = block.children[block.children.length - 1];
    const indent = last ? " ".repeat(last.indent) : "  ";
    const after = last ? last.blockRange.end : block.range.end;
    result.edits = [{ from: after, to: after, insert: `\n${indent}${line}` }];
  } else {
    const gap = src.length === 0 ? "" : src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n";
    result.edits = [{ from: src.length, to: src.length, insert: `${gap}preview():\n  ${line}\n` }];
  }
  return result;
}

function canvasSheet(target: PropertyTarget): PropertySheet {
  const stmt = target.tree.statements.find((s) => s.kind === "canvas");
  const { x, y, width, height, infinite } = target.scene.frame;
  const sheet: PropertySheet = { path: null, type: infinite ? "canvas (infinite)" : "canvas", fields: [], box: { x, y, w: width, h: height } };
  if (stmt && stmt.closeParen === undefined) sheet.readOnly = "Fix the syntax of `canvas` first (missing `)`)";
  for (const [name, spec] of Object.entries(CANVAS_SPECS)) {
    // An infinite canvas is sized by its content.
    if (infinite && (name === "width" || name === "height")) continue;
    const a = stmt?.attrs.find((x) => x.name === name);
    sheet.fields.push({
      name,
      kind: spec.kind,
      section: "Canvas",
      value: a ? valueText(target.source, a) : "",
      placeholder: CANVAS_DEFAULTS[name],
      problem: a && problemIn(target, a.range),
    });
  }
  return sheet;
}

/**
 * Sets one property. An empty value removes the attribute (back to its default or style).
 * The value is written as typed, except that text is quoted where the language needs quotes.
 */
export function setProperty(target: PropertyTarget, path: string | null, name: string, raw: string): EditResult {
  const result = blank();
  const sheet = propertySheet(target, path);
  const field = sheet?.fields.find((f) => f.name === name);
  if (!sheet || !field) return result;
  const value = raw.trim();
  if (value === field.value) return result;
  if (sheet.readOnly) {
    result.notices.push(sheet.readOnly);
    return result;
  }

  if (path === null) return setCanvasProperty(target, name, value, result);

  const shape = editableShape(target.scene, path)!;
  if (shape.preview?.placeholder) return addPreviewLine(target, shape, field, value, result);
  if (!canEdit(shape, result)) return result;
  const se = new StatementEditor(target.source, shape.source, shape.spec.aliases);
  if (field.kind === "content") {
    se.setContent(quote(value));
  } else if (value === "") {
    // In `preview()` a left-out parameter shows its name (issue #23), so it may be removed.
    if (field.required && !shape.preview) {
      result.notices.push(`\`${name}\` is required for \`${sheet.type}\``);
      return result;
    }
    se.remove(name);
  } else {
    se.set(name, formatValue(field, value, shape));
  }
  result.edits = normalizeEdits(target.source, se.edits());
  return result;
}

function setCanvasProperty(target: PropertyTarget, name: string, value: string, result: EditResult): EditResult {
  const stmt = target.tree.statements.find((s) => s.kind === "canvas");
  if (!stmt) {
    if (value === "") return result;
    // No canvas yet: add one before the first drawing statement (after imports and leading comments).
    const first = target.tree.statements.find((s) => s.kind !== "import");
    const src = target.source;
    const line = `canvas(${name}=${value})\n`;
    if (first) {
      const at = src.lastIndexOf("\n", first.range.start - 1) + 1;
      result.edits = [{ from: at, to: at, insert: line }];
    } else {
      const prefix = src.length > 0 && !src.endsWith("\n") ? "\n" : "";
      result.edits = [{ from: src.length, to: src.length, insert: prefix + line }];
    }
    return result;
  }
  const se = new StatementEditor(target.source, stmt, {});
  if (value === "") se.remove(name);
  else se.set(name, value);
  result.edits = normalizeEdits(target.source, se.edits());
  return result;
}

// ---- helpers ----------------------------------------------------------------------------------

function sortFields(fields: PropertyField[]): void {
  const order = new Map(fields.map((f, i) => [f, i]));
  fields.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || order.get(a)! - order.get(b)!);
}

function rangeOf(vals: Value[]): { start: number; end: number } {
  return { start: vals[0].range.start, end: vals[vals.length - 1].range.end };
}

function slice(src: string, vals: Value[]): string {
  if (vals.length === 0) return "";
  const r = rangeOf(vals);
  return src.slice(r.start, r.end);
}

/** The value as the user sees it: a single string without quotes, anything else as written. */
function valueText(src: string, a: Attr): string {
  if (a.values.length === 1 && a.values[0].kind === "string") return a.values[0].value;
  return src.slice(a.valueRange.start, a.valueRange.end);
}

/** The value written in a style for an attribute (`name=value` at `range`), or null. */
function styleValue(src: string, range: { start: number; end: number }, written: string): string | null {
  const text = src.slice(range.start, range.end);
  if (!text.startsWith(`${written}=`) && !text.startsWith(`${written} =`)) return null;
  return text.slice(text.indexOf("=") + 1).trim();
}

function problemIn(target: PropertyTarget, range: { start: number; end: number } | undefined): string | undefined {
  if (!range) return undefined;
  return target.diagnostics.find((d) => d.range.start >= range.start && d.range.end <= range.end && d.range.end > d.range.start)?.message;
}

/** Writes a value with quotes where the language needs them. */
function formatValue(field: PropertyField, value: string, shape: Shape): string {
  if (value.startsWith('"')) return value;
  switch (field.kind) {
    case "string":
      return quote(value);
    case "font":
      return /^[A-Za-z_][\w-]*$/.test(value) ? value : quote(value);
    case "param": {
      const p = shape.params?.find((x) => x.name === field.name);
      const current = shape.source.attrs.find((a) => a.name === field.name);
      const wasString = current?.values.length === 1 && current.values[0].kind === "string";
      // No default to tell the kind: a word is most likely text (`label=Web` would not be). Quoted
      // colors work too; numbers and `#hex` colors stay as typed.
      const guessText = p?.default === undefined && !current && !/^[-+]?(\d+\.?\d*|\.\d+)(px|%)?$/.test(value) && !/^#[0-9a-fA-F]{3,8}$/.test(value);
      return p?.isString || wasString || guessText || !looksLikeValue(value) ? quote(value) : value;
    }
    default:
      return value;
  }
}

/** A number, percent, color, name, `rgb(...)` or calculation: written without quotes. */
function looksLikeValue(v: string): boolean {
  return /^[-+]?(\d+\.?\d*|\.\d+)(px|%)?$/.test(v) || /^#[0-9a-fA-F]{3,8}$/.test(v) || /^[A-Za-z_][\w-]*$/.test(v) || /^\w+\(.*\)$/.test(v) || /^[\w\s.%()+\-*/]+$/.test(v) && /[+*/]|\s-\s/.test(v);
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
