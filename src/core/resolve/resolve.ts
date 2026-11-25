import { GRADIENT, isShapeType, POSITION_ATTRS, SHAPES, STOP, type AttrSpec, type ShapeSpec, type ShapeType } from "../builtins/catalog";
import { Code, Diagnostics, ScopedDiagnostics } from "../diagnostics";
import { parsePath, parsePoints, type PathCommand } from "../geometry";
import type { Attr, Expr, SourceRange, Statement, SyntaxTree, Value } from "../syntax/ast";
import { parse } from "../syntax/parser";
import { drawingPath, importCandidates, isLibraryPath } from "./library";

const KEYWORDS = new Set(["style", "canvas", "shape", "import", "export", "clip", "gradient", "layer"]);

/** Attributes whose value may name a gradient. */
const PAINT_ATTRS = ["fill", "stroke"];

/** Shapes allowed inside a `clip` block (SVG clipPath cannot contain groups). */
const CLIP_SHAPES = new Set<ShapeType>(["rect", "circle", "ellipse", "polyline", "polygon", "path", "text"]);

/** Attributes an instance of a custom shape accepts besides its parameters. */
const INSTANCE_ATTRS = new Set([...Object.keys(SHAPES.group.attrs), ...Object.keys(SHAPES.group.aliases)]);

/** Nesting limit for custom shapes using custom shapes. */
const MAX_SHAPE_DEPTH = 20;

/** Pixels, or a percent of the parent's size. */
export interface Len {
  v: number;
  pct: boolean;
}

export type RValue =
  | { t: "len"; len: Len }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; path: string }
  | { t: "anchor"; path: string; gap: Len }
  | { t: "list"; v: string[] };

export interface RAttr {
  value: RValue;
  /** Range of the `name=value` text that set it (in a style, if it came from a style). */
  range: SourceRange;
  /** Name as written, before alias normalization (`left` for `x`). */
  written: string;
}

export interface Shape {
  id: number;
  type: ShapeType;
  spec: ShapeSpec;
  name?: string;
  /** Full path, e.g. `server1.box`. Unnamed shapes get `rect#3`. */
  path: string;
  parent: Shape | null;
  children: Shape[];
  attrs: Map<string, RAttr>;
  text?: string;
  points?: number[];
  pathData?: PathCommand[];
  stmt: Statement;
  /** The statement in the user's file (differs from `stmt` for custom shape instances). Used for edits. */
  source: Statement;
  /** Set on an instance of a custom shape: the definition name (`database`). */
  instanceOf?: string;
  /** Set on an instance: the definition's parameters, with their default as written (none = required). */
  params?: { name: string; default?: string; isString: boolean }[];
  /** Imported custom shape: inner parts cannot be referenced from outside. */
  sealed?: boolean;
  /** Part of a custom shape's body: not in the user's file, so not editable on its own. */
  generated?: boolean;
  /** Clip applied with `clip-path=name`: its shapes, laid out in this shape's box. */
  clip?: { name: string; shapes: Shape[] };
  /**
   * Written with `layer` (issue #11): a group at the top level of the drawing. Drawn as a group;
   * without a `width` / `height` it covers the canvas.
   */
  layer?: boolean;
  /**
   * A cell of a library's gallery (issues #24, #25): `def` is the custom shape it shows. Without a
   * line in `preview()` (`placeholder`), its statement is made up and points at the definition;
   * an edit then adds a line to `preview()` instead of changing the text it points at.
   */
  preview?: { def: string; placeholder: boolean };
}

/** A library opened in ZyxDraw (issue #24): its custom shapes, drawn in a grid. */
export interface Gallery {
  /** The library's own custom shapes, in file order (eye icons, issue #25). */
  defs: { name: string; range: SourceRange; blockRange: SourceRange; exported: boolean; hidden: boolean }[];
  /** One cell per shape drawn: the instance, and its name under it (generated). Laid out by `arrangeGallery`. */
  cells: { shape: Shape; label: Shape }[];
  /** The `preview():` block, if the library has one. */
  block: Statement | null;
}

/** `preview():` at the top level of a library (issue #23). */
export function isPreviewBlock(s: Statement): boolean {
  return s.kind === "shape" && s.keyword === "preview" && s.indent === 0;
}

/** A `name is clip():` block. Its shapes are resolved once, on first use. */
export interface ClipDef {
  name: string;
  stmt: Statement;
  shapes: Shape[] | null;
  resolving: boolean;
  /** The file it is written in: its shapes are resolved there, even when imported. */
  scope: FileScope;
}

/** A `name is gradient(...)` definition, ready for SVG. */
export interface GradientDef {
  name: string;
  type: "linear" | "radial";
  /** SVG attributes of the gradient element (`x1`, `cx`, `spreadMethod`, ...), as written in SVG. */
  attrs: [string, string][];
  stops: { offset: string; color: string; opacity?: string }[];
  /** SVG id, given on first use (unique in the drawing). */
  id?: string;
}

/** A `name is shape(params):` definition, with the file scope it was defined in. */
export interface ShapeDef {
  name: string;
  stmt: Statement;
  sealed: boolean;
  scope: FileScope;
}

export interface FileScope {
  path: string;
  source: string;
  defs: Map<string, ShapeDef>;
  styles: Map<string, Attr[]>;
  clips: Map<string, ClipDef>;
  gradients: Map<string, GradientDef>;
  /** Imported styles: the file each one is written in (for messages). Own styles are not here. */
  styleFrom: Map<string, FileScope>;
  /** A `.zyxdl` library: draws nothing, may export. */
  isLibrary: boolean;
  /** Names listed in `export` lines, or null when there are none (everything is exported). */
  exports: Set<string> | null;
}

export interface ResolveOptions {
  /** Vault path of the file being compiled (for relative imports). */
  path?: string;
  /** The file's own source text (line numbers in messages). */
  source?: string;
  /** Library and drawing sources by vault path, from `loadLibraries`. */
  libraries?: Map<string, string>;
  /** Vault path of the library folder from the settings (searched after the file's folder). */
  libraryFolder?: string;
  /** A library's custom shapes left out of its gallery (eye icons, issue #25). */
  galleryHidden?: readonly string[];
}

export interface Frame {
  /**
   * Top-left of the drawn area. 0, 0 for a fixed canvas; for `canvas(infinite)` the corner of
   * the content's bounds plus padding (may be negative), set after layout.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  background?: string;
  /** `canvas(infinite)`: no fixed size; the drawing is sized to its content. */
  infinite?: boolean;
}

export interface Model {
  frame: Frame;
  roots: Shape[];
  /** Gradients used in the drawing, in order of first use. */
  gradients?: GradientDef[];
  /** Set when a library is compiled: its shapes, to be laid out in a grid. */
  gallery?: Gallery;
}

export const DEFAULT_FRAME = { x: 0, y: 0, width: 1000, height: 600 };

/** Turns the syntax tree into shapes with checked, normalized attributes. No positions yet. */
export function resolve(tree: SyntaxTree, diags: Diagnostics, options: ResolveOptions = {}): Model {
  const libs: Libraries = {
    mainPath: options.path ?? "",
    sources: options.libraries ?? new Map<string, string>(),
    scopes: new Map(),
    loading: [],
    libraryFolder: options.libraryFolder ?? "",
  };
  const scope = buildFileScope(libs.mainPath, options.source ?? "", tree, diags, libs);
  const ctx: Ctx = { diags, styles: scope.styles, counter: { next: 1 }, scope, mainScope: scope, defStack: [], usedGradients: [] };
  const top = tree.statements;
  // A library draws nothing in a drawing. Opened itself, it shows its shapes (issue #24).
  if (scope.isLibrary) return galleryModel(top, scope, ctx, new Set(options.galleryHidden ?? []));

  const frame = resolveCanvas(top, diags);
  if (frame.background) frame.background = paintValue(frame.background, ctx);

  const roots: Shape[] = [];
  const names = new Map<string, Statement>();
  for (const s of top) {
    if (s.kind === "shape") {
      const shape = resolveShape(s, null, names, ctx);
      if (shape) roots.push(shape);
    }
  }
  return { frame, roots, gradients: ctx.usedGradients };
}

interface Ctx {
  diags: Diagnostics;
  styles: Map<string, Attr[]>;
  counter: { next: number };
  scope: FileScope;
  /** The file being compiled: its gradients also work inside imported custom shapes. */
  mainScope: FileScope;
  /** Custom shapes currently being expanded (cycle check). */
  defStack: ShapeDef[];
  /** Gradients used so far (shared by all contexts of one compile). */
  usedGradients: GradientDef[];
  /**
   * A gallery cell (issue #24): a required parameter left out shows its own name instead of
   * being an error. Only for the cell itself, not for custom shapes inside it.
   */
  previewFill?: boolean;
}

/**
 * A paint value: the name of a gradient becomes `url(#id)` (the gradient is then written to the
 * SVG); anything else (a color) is kept.
 */
function paintValue(value: string, ctx: Ctx): string {
  const def = ctx.scope.gradients.get(value) ?? ctx.mainScope.gradients.get(value);
  if (!def) return value;
  if (!def.id) {
    const taken = new Set(ctx.usedGradients.map((g) => g.id));
    let id = def.name;
    for (let n = 2; taken.has(id); n++) id = `${def.name}-${n}`;
    def.id = id;
    ctx.usedGradients.push(def);
  }
  return `url(#${def.id})`;
}

/** Reads the `name is gradient(...)` definitions of one file. */
function collectGradients(top: Statement[], diags: Diagnostics): Map<string, GradientDef> {
  const out = new Map<string, GradientDef>();
  const pct = (v: RValue | null): string | undefined => (v && v.t === "len" ? (v.len.pct ? `${fmtNum(v.len.v)}%` : fmtNum(v.len.v)) : undefined);
  for (const s of top) {
    if (s.kind !== "gradientDef") continue;
    if (!s.name) {
      diags.error(Code.InvalidGradient, "A gradient needs a name: `sky is gradient(from=white, to=blue)`", s.range);
      continue;
    }
    for (const extra of s.args) unexpectedPositional(extra, diags);
    const read = (stmt: Statement, spec: Pick<ShapeSpec, "attrs" | "aliases">, what: string) => {
      const values = new Map<string, { value: RValue; attr: Attr }>();
      for (const a of stmt.attrs) {
        const canonical = spec.aliases[a.name] ?? a.name;
        const attrSpec = spec.attrs[canonical];
        if (!attrSpec) {
          diags.error(Code.UnknownAttribute, `Unknown attribute \`${a.name}\` for \`${what}\` (it takes ${Object.keys(spec.attrs).map((k) => `\`${k}\``).join(", ")})`, a.nameRange);
          continue;
        }
        if (values.has(canonical)) {
          diags.error(Code.DuplicateAttribute, `\`${a.name}\` is set twice`, a.range);
          continue;
        }
        const v = convert(a.name, attrSpec, a, diags);
        if (v) values.set(canonical, { value: v, attr: a });
      }
      return values;
    };
    const g = read(s, GRADIENT, "gradient");
    const str = (k: string) => {
      const v = g.get(k)?.value;
      return v && v.t === "str" ? v.v : undefined;
    };
    const type = str("type") === "radial" ? "radial" : "linear";
    const def: GradientDef = { name: s.name, type, attrs: [], stops: [] };

    const radialOnly = ["cx", "cy", "r", "fx", "fy"];
    for (const k of type === "linear" ? radialOnly : ["angle"]) {
      const a = g.get(k)?.attr;
      if (a) diags.warning(Code.InvalidGradient, `\`${k}\` is for ${type === "linear" ? "radial" : "linear"} gradients; it is ignored`, a.range);
    }
    if (type === "linear") {
      // Through the middle of the box, long enough to reach its corners (like CSS).
      const angle = g.get("angle")?.value;
      const rad = ((angle && angle.t === "num" ? angle.v : 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const half = (Math.abs(cos) + Math.abs(sin)) / 2;
      def.attrs.push(["x1", fmtNum(0.5 - cos * half)], ["y1", fmtNum(0.5 - sin * half)], ["x2", fmtNum(0.5 + cos * half)], ["y2", fmtNum(0.5 + sin * half)]);
    } else {
      for (const k of radialOnly) {
        const v = pct(g.get(k)?.value ?? null);
        if (v !== undefined) def.attrs.push([k, v]);
      }
    }
    const spread = str("spread");
    if (spread && spread !== "pad") def.attrs.push(["spreadMethod", spread]);

    // Stops: `from` (0%), the block's `stop(...)` lines, `to` (100%).
    const stops: { at: number; offset: string; color: string; opacity?: string }[] = [];
    const from = str("from");
    if (from !== undefined) stops.push({ at: 0, offset: "0%", color: from });
    for (const c of s.children) {
      if (c.keyword !== "stop" || c.kind !== "shape" || c.name) {
        diags.error(Code.InvalidGradient, "A gradient block holds `stop(offset=50%, color=red)` lines only", c.range);
        continue;
      }
      if (c.hasBlock) diags.error(Code.ChildrenNotAllowed, "A stop cannot have children", c.range);
      for (const extra of c.args) unexpectedPositional(extra, diags);
      const st = read(c, STOP, "stop");
      const offset = st.get("offset");
      const color = st.get("color")?.value;
      if (!offset || offset.value.t !== "len" || !color || color.t !== "str") {
        diags.error(Code.MissingRequired, "A stop needs `offset` and `color`: `stop(offset=50%, color=red)`", c.range);
        continue;
      }
      const len = offset.value.len;
      const at = len.pct ? len.v / 100 : len.v;
      if (at > 1) {
        diags.error(Code.OutOfRange, "`offset` is a percent (0% to 100%) or a fraction (0 to 1)", offset.attr.valueRange);
        continue;
      }
      const opacity = st.get("opacity")?.value;
      stops.push({ at, offset: pct(offset.value)!, color: color.v, opacity: opacity && opacity.t === "num" ? fmtNum(opacity.v) : undefined });
    }
    const to = str("to");
    if (to !== undefined) stops.push({ at: 1, offset: "100%", color: to });
    if (stops.length < 2) {
      diags.error(Code.InvalidGradient, `Gradient \`${s.name}\` needs two colors: \`from\` and \`to\`, or \`stop(...)\` lines indented below \`:\``, s.range);
      continue;
    }
    // SVG takes stops in order; a stop written out of order would be moved anyway.
    stops.sort((a, b) => a.at - b.at);
    def.stops = stops.map(({ offset, color, opacity }) => (opacity === undefined ? { offset, color } : { offset, color, opacity }));
    out.set(s.name, def);
  }
  return out;
}

/** Numbers without float noise. */
function fmtNum(n: number): string {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
}

interface Libraries {
  mainPath: string;
  sources: Map<string, string>;
  scopes: Map<string, FileScope>;
  /** Files whose scope is being built (circular import check). */
  loading: string[];
  libraryFolder: string;
}

function collectStyles(top: Statement[], diags: Diagnostics): Map<string, Attr[]> {
  const styles = new Map<string, Attr[]>();
  for (const s of top) {
    if (s.kind !== "style") continue;
    if (!s.name) {
      diags.error(Code.MissingRequired, "A style needs a name: `primary is style(fill=blue)`", s.range);
      continue;
    }
    if (s.hasBlock) diags.error(Code.ChildrenNotAllowed, "A style cannot have children", s.range);
    styles.set(s.name, s.attrs);
  }
  return styles;
}

/**
 * Collects the definitions visible in one file: imported ones first (later imports override
 * earlier ones), then the file's own definitions (which always win).
 */
function buildFileScope(path: string, source: string, tree: SyntaxTree, report: Diagnostics, libs: Libraries): FileScope {
  const scope: FileScope = {
    path,
    source,
    defs: new Map(),
    styles: collectStyles(tree.statements, report),
    clips: new Map(),
    gradients: collectGradients(tree.statements, report),
    styleFrom: new Map(),
    isLibrary: isLibraryPath(path),
    exports: null,
  };
  libs.loading.push(path);

  let previewBlock: Statement | null = null;
  if (scope.isLibrary) {
    for (const s of tree.statements) {
      if (s.kind === "canvas") {
        report.error(Code.LibraryDraws, "A library draws nothing: `canvas` is only for drawings", s.range);
      } else if (isPreviewBlock(s)) {
        // Example uses of the library's shapes, shown only when the library is open (issue #23).
        if (s.name) report.error(Code.Preview, "`preview()` takes no name: write `preview():`", s.nameRange!);
        if (s.attrs.length > 0 || s.args.length > 0) report.error(Code.Preview, "`preview()` takes no attributes: write `preview():`", s.range);
        if (previewBlock) report.error(Code.Preview, "A library has one `preview()` block. Add the lines to the first one", s.keywordRange);
        else previewBlock = s;
      } else if (s.kind === "shape") {
        report.error(Code.LibraryDraws, "A library draws nothing: put shapes inside a custom shape (`name is shape():`)", s.range);
      } else if (s.name === "preview") {
        report.error(Code.Preview, "In a library, `preview` is the name of the `preview():` block: choose another name", s.nameRange!);
      }
    }
  }

  for (const s of tree.statements) {
    if (s.kind !== "clipDef") continue;
    if (!s.name) {
      report.error(Code.InvalidClip, "A clip needs a name: `top-half is clip():`", s.range);
    } else if (s.children.length === 0) {
      report.error(Code.InvalidClip, `Clip \`${s.name}\` has no shapes: indent them below \`:\``, s.range);
    } else {
      if (s.attrs.length > 0 || s.args.length > 0) report.error(Code.InvalidClip, "A clip takes no attributes: `name is clip():`", s.range);
      scope.clips.set(s.name, { name: s.name, stmt: s, shapes: null, resolving: false, scope });
    }
  }

  // Own styles, gradients and clips win over imported ones (custom shapes: below, set last).
  const own = { styles: new Set(scope.styles.keys()), gradients: new Set(scope.gradients.keys()), clips: new Set(scope.clips.keys()) };
  for (const s of tree.statements) {
    if (s.kind !== "import" || !s.importPath) continue;
    const lib = importedScope(s, path, report, libs);
    if (!lib) continue;
    const name = s.importPath;
    const take = (from: string, as: string) => {
      const def = lib.defs.get(from);
      if (def) scope.defs.set(as, { ...def, sealed: true });
      const style = lib.styles.get(from);
      if (style && !own.styles.has(as)) {
        scope.styles.set(as, style);
        scope.styleFrom.set(as, lib.styleFrom.get(from) ?? lib);
      }
      const gradient = lib.gradients.get(from);
      if (gradient && !own.gradients.has(as)) scope.gradients.set(as, gradient);
      const clip = lib.clips.get(from);
      if (clip && !own.clips.has(as)) scope.clips.set(as, clip);
    };
    if (s.importAll) {
      for (const n of exportedNames(lib)) take(n, n);
      continue;
    }
    for (const n of s.importNames ?? []) {
      if (!definedIn(lib, n.name)) {
        report.error(Code.ImportNotFound, `\`${n.name}\` is not defined in \`${name}\``, n.range);
      } else if (lib.exports && !lib.exports.has(n.name)) {
        const list = [...lib.exports].map((e) => `\`${e}\``).join(", ");
        report.error(Code.ImportNotFound, `\`${n.name}\` is not exported by \`${name}\`. It exports: ${list}`, n.range);
      } else {
        take(n.name, n.alias ?? n.name);
      }
    }
  }

  for (const s of tree.statements) {
    if (s.kind !== "shapeDef") continue;
    if (!s.name) {
      report.error(Code.InvalidDefinition, "A shape definition needs a name: `database is shape(label=\"DB\"):`", s.range);
      continue;
    }
    // Reported by the parser (reserved name).
    if (isShapeType(s.name) || KEYWORDS.has(s.name)) continue;
    if (s.children.length === 0) {
      report.error(Code.InvalidDefinition, `Shape \`${s.name}\` has no body: indent its shapes below \`:\``, s.range);
      continue;
    }
    for (const item of s.args) {
      if (item.length !== 1 || item[0].kind !== "ident") {
        report.error(Code.InvalidDefinition, "A parameter is a name (required) or `name=default`", item[0]?.range ?? s.range);
      }
    }
    for (const p of paramNames(s)) {
      if (INSTANCE_ATTRS.has(p) && p !== "width" && p !== "height") {
        report.error(Code.InvalidDefinition, `\`${p}\` cannot be a parameter name (it places or styles the shape)`, s.range);
      }
    }
    scope.defs.set(s.name, { name: s.name, stmt: s, sealed: false, scope });
  }

  // `export a, b`: only in a library, only names it can see (its own or imported).
  for (const s of tree.statements) {
    if (s.kind !== "export") continue;
    if (!scope.isLibrary) {
      report.error(Code.Export, "A drawing cannot be imported, so it cannot export. Move the definitions to a `.zyxdl` library", s.range);
      continue;
    }
    scope.exports ??= new Set();
    for (const n of s.exportNames ?? []) {
      if (definedIn(scope, n.name)) scope.exports.add(n.name);
      else report.error(Code.Export, `\`${n.name}\` is not defined in this library`, n.range);
    }
  }

  // The lines of `preview()`: uses of custom shapes this library can see, placed by the gallery.
  for (const line of previewBlock?.children ?? []) {
    if (line.kind !== "shape" || isShapeType(line.keyword) || line.keyword === "layer") {
      const example = [...scope.defs.keys()][0] ?? "name";
      report.error(Code.Preview, `\`preview()\` shows the library's custom shapes: use one, such as \`${example}(...)\``, line.keywordRange);
      continue;
    }
    if (!scope.defs.has(line.keyword)) {
      report.error(Code.UnknownType, `Unknown custom shape \`${line.keyword}\` (define it with \`${line.keyword} is shape(...):\` or import it)`, line.keywordRange);
      continue;
    }
    if (line.hasBlock) report.error(Code.ChildrenNotAllowed, "A line in `preview()` cannot have children", line.range);
    for (const a of line.attrs) {
      const canonical = SHAPES.group.aliases[a.name] ?? a.name;
      if (POSITION_ATTRS.has(canonical)) report.error(Code.Preview, `The preview places its shapes itself: leave out \`${a.name}\``, a.range);
    }
  }

  libs.loading.pop();
  return scope;
}

/**
 * A library opened in ZyxDraw (issue #24): one cell per line of `preview()`, and one with the
 * default values for each own custom shape that has no line. Positions come later, from
 * `arrangeGallery`, once the cells' sizes are known.
 */
function galleryModel(top: Statement[], scope: FileScope, ctx: Ctx, hidden: Set<string>): Model {
  const block = top.find(isPreviewBlock) ?? null;
  const lines = (block?.children ?? []).filter((l) => l.kind === "shape" && scope.defs.has(l.keyword) && !l.hasBlock);
  const exported = exportedNames(scope);
  const own = top.filter((s): s is Statement & { name: string } => s.kind === "shapeDef" && !!s.name && scope.defs.get(s.name)?.stmt === s);
  const gallery: Gallery = {
    defs: own.map((d) => ({ name: d.name, range: d.range, blockRange: d.blockRange, exported: exported.has(d.name), hidden: hidden.has(d.name) })),
    cells: [],
    block,
  };
  const roots: Shape[] = [];
  const names = new Map<string, Statement>();
  const cellCtx: Ctx = { ...ctx, previewFill: true };

  const add = (stmt: Statement, def: string, placeholder: boolean) => {
    const shape = resolveShape(stmt, null, names, cellCtx);
    if (!shape) return;
    shape.preview = { def, placeholder };
    // An own shape left out of `export` cannot be imported: say so under it.
    const isPrivate = scope.defs.get(def)?.scope === scope && !exported.has(def);
    const label = resolveShape(labelStatement(isPrivate ? `${def} (not exported)` : def, isPrivate, stmt.range), null, new Map(), ctx);
    if (!label) return;
    label.generated = true;
    roots.push(shape, label);
    gallery.cells.push({ shape, label });
  };

  const placed = new Set<Statement>();
  for (const d of own) {
    const mine = lines.filter((l) => l.keyword === d.name);
    mine.forEach((l) => placed.add(l));
    if (hidden.has(d.name)) continue;
    if (mine.length > 0) for (const l of mine) add(l, d.name, false);
    else add(placeholderStatement(d), d.name, true);
  }
  // Lines that use imported shapes come after the library's own shapes.
  for (const l of lines) if (!placed.has(l) && !hidden.has(l.keyword)) add(l, l.keyword, false);

  return { frame: { ...DEFAULT_FRAME, infinite: true }, roots, gradients: ctx.usedGradients, gallery };
}

/** `database()` for a custom shape without a line in `preview()`. It points at the definition. */
function placeholderStatement(def: Statement & { name: string }): Statement {
  return {
    kind: "shape",
    keyword: def.name,
    keywordRange: def.nameRange ?? def.keywordRange,
    args: [],
    attrs: [],
    hasBlock: false,
    children: [],
    range: def.range,
    blockRange: def.range,
    indent: 0,
  };
}

/** The name under a gallery cell: small and grey, in italics when it is not exported. */
function labelStatement(text: string, faded: boolean, r: SourceRange): Statement {
  const attr = (name: string, value: Value): Attr => ({ name, nameRange: r, values: [value], range: r, valueRange: r });
  const attrs = [attr("font-size", { kind: "number", value: 12, unit: "", range: r }), attr("fill", { kind: "color", value: "#888888", range: r })];
  if (faded) attrs.push(attr("font-style", { kind: "ident", value: "italic", range: r }));
  return { kind: "shape", keyword: "text", keywordRange: r, args: [[{ kind: "string", value: text, range: r }]], attrs, hasBlock: false, children: [], range: r, blockRange: r, indent: 0 };
}

/** Finds and builds the library an import points to. Reports why when it cannot. */
function importedScope(s: Statement, path: string, report: Diagnostics, libs: Libraries): FileScope | null {
  const name = s.importPath!;
  const candidates = importCandidates(path, name, libs.libraryFolder);
  if (candidates.length === 0) return null; // a bad library name, reported by the parser
  const target = candidates.find((c) => c === libs.mainPath || libs.sources.has(c));
  if (target === undefined) {
    const drawing = candidates.map(drawingPath).find((c) => libs.sources.has(c));
    if (drawing) {
      const file = drawing.slice(drawing.lastIndexOf("/") + 1);
      report.error(Code.ImportNotFound, `\`${drawing}\` is a drawing. Only \`.zyxdl\` libraries can be imported. Rename it to \`${file}l\``, s.importPathRange!);
    } else {
      const looked = candidates.map((c) => `\`${c}\``).join(" and ");
      report.error(Code.ImportNotFound, `Zyxd library \`${name}\` not found. Looked for ${looked}. Folder and file names of libraries cannot contain dots`, s.importPathRange!);
    }
    return null;
  }
  const at = libs.loading.indexOf(target);
  if (at !== -1) {
    report.error(Code.CircularImport, `Circular import: ${[...libs.loading.slice(at), target].join(" -> ")}`, s.range);
    return null;
  }
  let lib = libs.scopes.get(target);
  if (!lib) {
    const libSource = libs.sources.get(target) ?? "";
    const scoped = new ScopedDiagnostics(report, s.range, `In \`${target}\`: `, libSource);
    lib = buildFileScope(target, libSource, parse(libSource, scoped), scoped, libs);
    libs.scopes.set(target, lib);
  }
  return lib;
}

/** True when a file defines or imports `name` (a custom shape, style, gradient or clip). */
function definedIn(scope: FileScope, name: string): boolean {
  return scope.defs.has(name) || scope.styles.has(name) || scope.gradients.has(name) || scope.clips.has(name);
}

/** What `import *` brings in: the `export` list, or everything the library can see. */
function exportedNames(scope: FileScope): Set<string> {
  return scope.exports ?? new Set([...scope.defs.keys(), ...scope.styles.keys(), ...scope.gradients.keys(), ...scope.clips.keys()]);
}

function paramNames(def: Statement): string[] {
  const required: string[] = [];
  for (const a of def.args) if (a.length === 1 && a[0].kind === "ident") required.push(a[0].value);
  return [...required, ...def.attrs.map((a) => a.name)];
}

/** Expands `users is database(label="Users")` into a group holding the definition's body. */
function expandInstance(stmt: Statement, def: ShapeDef, parent: Shape | null, names: Map<string, Statement>, ctx: Ctx): Shape | null {
  const { diags } = ctx;
  if (ctx.defStack.includes(def)) {
    const chain = [...ctx.defStack.slice(ctx.defStack.indexOf(def)), def].map((d) => d.name).join(" -> ");
    diags.error(Code.CircularShape, `Circular shape definition: ${chain}`, stmt.range);
    return null;
  }
  if (ctx.defStack.length >= MAX_SHAPE_DEPTH) {
    diags.error(Code.CircularShape, "Custom shapes are nested too deeply", stmt.range);
    return null;
  }

  // Parameters: required (no default) and with defaults.
  const defaults = new Map<string, Value[] | null>();
  for (const item of def.stmt.args) {
    if (item.length === 1 && item[0].kind === "ident") defaults.set(String(item[0].value), null);
  }
  for (const a of def.stmt.attrs) defaults.set(a.name, a.values);

  const args = new Map<string, Value[]>();
  const groupAttrs: Attr[] = [];
  for (const a of stmt.attrs) {
    if (defaults.has(a.name)) {
      if (args.has(a.name)) diags.error(Code.DuplicateAttribute, `\`${a.name}\` is set twice`, a.range);
      else args.set(a.name, a.values);
    } else if (INSTANCE_ATTRS.has(a.name)) {
      groupAttrs.push(a);
    } else {
      const list = [...defaults.keys()].map((p) => `\`${p}\``).join(", ") || "none";
      diags.error(Code.UnknownAttribute, `\`${a.name}\` is not a parameter of \`${def.name}\` (parameters: ${list})`, a.nameRange);
    }
  }
  for (const extra of stmt.args) unexpectedPositional(extra, diags);

  const values = new Map<string, Value[]>();
  let missing = false;
  for (const [name, fallback] of defaults) {
    const v = args.get(name) ?? fallback;
    if (!v && ctx.previewFill) {
      values.set(name, [{ kind: "string", value: name, range: stmt.range }]);
    } else if (!v) {
      diags.error(Code.MissingRequired, `Missing parameter \`${name}\` for \`${def.name}\``, stmt.range);
      missing = true;
    } else {
      values.set(name, v);
    }
  }
  if (missing) return null;

  // Substitute parameters: an identifier equal to a parameter name becomes the argument value.
  // In `style=...`, a parameter is only substituted when its value is a style name, so a
  // parameter `label` does not clash with a style also called `label`.
  // In a calculation, a parameter must be a number (or a calculation itself).
  const substExpr = (e: Expr): Expr => {
    switch (e.k) {
      case "ref": {
        const arg = values.get(e.name);
        if (!arg) return e;
        if (arg.length === 1 && arg[0].kind === "number") return { k: "num", v: arg[0].value, unit: arg[0].unit };
        if (arg.length === 1 && arg[0].kind === "expr") return arg[0].node;
        return { k: "err", message: `Parameter \`${e.name}\` is not a number, so it cannot be used in a calculation`, range: e.range };
      }
      case "neg":
        return { k: "neg", e: substExpr(e.e) };
      case "bin":
        return { ...e, a: substExpr(e.a), b: substExpr(e.b) };
      default:
        return e;
    }
  };
  const subst = (vals: Value[], styleList = false): Value[] =>
    vals.flatMap((v) => {
      if (v.kind === "expr") return [{ ...v, node: substExpr(v.node) }];
      if (v.kind !== "ident" || !values.has(v.value)) return [v];
      const arg = values.get(v.value)!;
      return styleList && !arg.every((x) => x.kind === "ident") ? [v] : arg;
    });
  const clone = (s: Statement): Statement => ({
    ...s,
    args: s.args.map((a) => subst(a)),
    attrs: s.attrs.map((a) => ({ ...a, values: subst(a.values, a.name === "style") })),
    children: s.children.map(clone),
  });

  // `width` / `height` parameters also give the instance its box, so `%` inside works.
  const sizeAttrs: Attr[] = ["width", "height"]
    .filter((k) => values.has(k) && !groupAttrs.some((a) => a.name === k))
    .map((k) => ({ name: k, nameRange: stmt.range, values: values.get(k)!, range: stmt.range, valueRange: stmt.range }));

  const synthetic: Statement = {
    ...stmt,
    kind: "shape",
    keyword: "group",
    args: [],
    attrs: [...groupAttrs, ...sizeAttrs],
    hasBlock: true,
    children: def.stmt.children.map(clone),
  };
  const childCtx: Ctx = {
    diags: new ScopedDiagnostics(diags, stmt.range, `In \`${def.name}\`: `, def.scope.source),
    styles: def.scope.styles,
    counter: ctx.counter,
    scope: def.scope,
    mainScope: ctx.mainScope,
    defStack: [...ctx.defStack, def],
    usedGradients: ctx.usedGradients,
  };
  const shape = resolveShape(synthetic, parent, names, ctx, childCtx);
  if (!shape) return null;
  shape.source = stmt;
  shape.instanceOf = def.name;
  shape.params = [...defaults].map(([name, vals]) => ({
    name,
    default: vals && vals.length > 0 ? def.scope.source.slice(vals[0].range.start, vals[vals.length - 1].range.end) : undefined,
    isString: !!vals && vals.length === 1 && vals[0].kind === "string",
  }));
  shape.sealed = def.sealed;
  const markGenerated = (s: Shape) => {
    for (const c of s.children) {
      c.generated = true;
      markGenerated(c);
    }
  };
  markGenerated(shape);
  return shape;
}

function resolveCanvas(top: Statement[], diags: Diagnostics): Frame {
  const canvases = top.filter((s) => s.kind === "canvas");
  const frame: Frame = { ...DEFAULT_FRAME };
  if (canvases.length === 0) return frame;

  const canvas = canvases[0];
  for (const extra of canvases.slice(1)) diags.error(Code.Canvas, "Only one `canvas` is allowed per file", extra.range);
  const firstReal = top.find((s) => s.kind === "shape" || s.kind === "canvas");
  if (firstReal !== canvas) diags.warning(Code.Canvas, "`canvas` should be the first statement", canvas.range);
  if (canvas.name) diags.error(Code.Canvas, "`canvas` does not take a name", canvas.nameRange!);
  if (canvas.hasBlock) diags.error(Code.ChildrenNotAllowed, "`canvas` cannot have children", canvas.range);

  // `canvas(infinite)`: the only word `canvas` takes.
  for (const arg of canvas.args) {
    if (arg.length === 1 && arg[0].kind === "ident" && arg[0].value === "infinite") frame.infinite = true;
    else {
      const range = arg.length ? { start: arg[0].range.start, end: arg[arg.length - 1].range.end } : canvas.range;
      diags.error(Code.Canvas, "`canvas` takes `infinite`, or `width`, `height` and `background`, like `canvas(infinite)` or `canvas(width=400, height=200)`", range);
    }
  }
  if (frame.infinite) {
    for (const a of canvas.attrs) {
      if (a.name === "width" || a.name === "height") {
        diags.error(Code.Canvas, `An infinite canvas has no \`${a.name}\`: remove it, or remove \`infinite\` for a fixed size`, a.range);
      }
    }
  }

  const specs: Record<string, AttrSpec> = {
    width: { kind: "px", min: 0, exclusiveMin: true },
    height: { kind: "px", min: 0, exclusiveMin: true },
    background: { kind: "paint" },
    image: { kind: "string" },
  };
  for (const a of canvas.attrs) {
    const spec = specs[a.name];
    if (!spec) {
      diags.error(Code.UnknownAttribute, `Unknown attribute \`${a.name}\` for \`canvas\``, a.nameRange);
      continue;
    }
    if (a.name === "image") {
      diags.warning(Code.NotSupportedYet, "Background images are not supported yet", a.range);
      continue;
    }
    if (frame.infinite && (a.name === "width" || a.name === "height")) continue;
    const v = convert(a.name, spec, a, diags);
    if (!v) continue;
    if (a.name === "width" && v.t === "num") frame.width = v.v;
    if (a.name === "height" && v.t === "num") frame.height = v.v;
    if (a.name === "background" && v.t === "str") frame.background = v.v;
  }
  return frame;
}

function resolveShape(
  stmt: Statement,
  parent: Shape | null,
  names: Map<string, Statement>,
  ctx: Ctx,
  /** Context for the children (differs for custom shape instances). */
  childCtx: Ctx = ctx,
): Shape | null {
  const { diags } = ctx;
  // `layer` is a group with rules: top level of the drawing only.
  let isLayer = stmt.keyword === "layer";
  if (isLayer && (parent || ctx.defStack.length > 0)) {
    const where = ctx.defStack.length > 0 ? "a custom shape" : parent?.layer ? "another layer" : `\`${parent!.path}\``;
    diags.error(Code.LayerNotTopLevel, `A layer must be at the top level of the drawing, not inside ${where}. Use \`group\` there`, stmt.keywordRange);
    isLayer = false; // still drawn, as a group
  }
  const keyword = stmt.keyword === "layer" ? "group" : stmt.keyword;
  if (!isShapeType(keyword)) {
    const def = ctx.scope.defs.get(stmt.keyword);
    if (def) return expandInstance(stmt, def, parent, names, ctx);
    if (stmt.keyword === "preview" && !ctx.mainScope.isLibrary) {
      diags.error(Code.Preview, "`preview()` is only for libraries (`.zyxdl`): it shows example uses of a library's shapes", stmt.keywordRange);
      return null;
    }
    diags.error(
      Code.UnknownType,
      `Unknown shape type \`${stmt.keyword}\` (define it with \`${stmt.keyword} is shape(...):\` or import it)`,
      stmt.keywordRange,
    );
    return null;
  }
  const type: ShapeType = keyword;
  const spec = SHAPES[type];

  // Name: unique among siblings only.
  if (stmt.name) {
    if (names.has(stmt.name)) {
      diags.error(Code.DuplicateName, `Name \`${stmt.name}\` is already used ${parent ? `in \`${parent.path}\`` : "at this level"}`, stmt.nameRange!);
    } else {
      names.set(stmt.name, stmt);
    }
  }
  const id = ctx.counter.next++;
  const local = stmt.name ?? `${stmt.keyword === "layer" ? "layer" : type}#${id}`;
  const path = parent ? `${parent.path}.${local}` : local;

  // Own attributes.
  const own = new Map<string, RAttr>();
  for (const a of stmt.attrs) {
    const canonical = spec.aliases[a.name] ?? a.name;
    const attrSpec = spec.attrs[canonical];
    if (!attrSpec) {
      const hint =
        type === "line" && POSITION_ATTRS.has(canonical) ? " (a line is placed with `x1`/`y1`/`x2`/`y2` or `from`/`to`)" : "";
      diags.error(Code.UnknownAttribute, `Unknown attribute \`${a.name}\` for \`${type}\`${hint}`, a.nameRange);
      continue;
    }
    const previous = own.get(canonical);
    if (previous) {
      const msg =
        previous.written === a.name
          ? `\`${a.name}\` is set twice`
          : `\`${previous.written}\` and \`${a.name}\` set the same thing`;
      diags.error(previous.written === a.name ? Code.DuplicateAttribute : Code.ConflictingAttributes, msg, a.range);
      continue;
    }
    const v = convert(a.name, attrSpec, a, diags);
    if (v) own.set(canonical, { value: v, range: a.range, written: a.name });
  }

  // Styles first (left to right, later wins), then own attributes win.
  const attrs = new Map<string, RAttr>();
  const styleAttr = own.get("style");
  if (styleAttr && styleAttr.value.t === "list") {
    for (const styleName of styleAttr.value.v) {
      const styleAttrs = ctx.styles.get(styleName);
      if (!styleAttrs) {
        diags.error(Code.UnknownStyle, `Unknown style \`${styleName}\``, styleAttr.range);
        continue;
      }
      // An imported style's text is in its library: its problems go on `style=...` here, and
      // its values point there too (they cannot be edited in this file).
      const from = ctx.scope.styleFrom.get(styleName);
      const styleDiags = from ? new ScopedDiagnostics(diags, styleAttr.range, `In style \`${styleName}\` (\`${from.path}\`): `, from.source) : diags;
      for (const a of styleAttrs) {
        const canonical = spec.aliases[a.name] ?? a.name;
        const attrSpec = spec.attrs[canonical];
        if (!attrSpec) continue; // the style may target other shape types
        if (POSITION_ATTRS.has(canonical) || canonical === "style") {
          styleDiags.warning(Code.UnknownAttribute, `Styles cannot set \`${a.name}\` (position); it is ignored`, a.range);
          continue;
        }
        const v = convert(a.name, attrSpec, a, styleDiags);
        if (v) attrs.set(canonical, { value: v, range: from ? styleAttr.range : a.range, written: a.name });
      }
    }
  }
  for (const [k, v] of own) attrs.set(k, v);
  attrs.delete("style");
  for (const k of PAINT_ATTRS) {
    const a = attrs.get(k);
    if (a && a.value.t === "str") attrs.set(k, { ...a, value: { t: "str", v: paintValue(a.value.v, ctx) } });
  }

  const shape: Shape = { id, type, spec, name: stmt.name, path, parent, children: [], attrs, stmt, source: stmt };
  if (isLayer) shape.layer = true;

  if (!checkShape(shape, stmt, own, diags)) return null;

  const clipAttr = attrs.get("clip-path");
  attrs.delete("clip-path");
  if (clipAttr && clipAttr.value.t === "ref") {
    const def = ctx.scope.clips.get(clipAttr.value.path);
    if (!def) {
      diags.error(Code.UnknownClip, `Unknown clip \`${clipAttr.value.path}\` (define it with \`${clipAttr.value.path} is clip():\`)`, clipAttr.range);
    } else {
      const shapes = resolveClip(def, ctx, clipAttr.range);
      if (shapes) shape.clip = { name: def.name, shapes };
    }
  }

  // Children.
  if (stmt.children.length > 0) {
    if (type !== "group") {
      diags.error(Code.ChildrenNotAllowed, `Only \`group\` can contain shapes, not \`${type}\``, stmt.range);
    } else {
      const childNames = new Map<string, Statement>();
      for (const c of stmt.children) {
        if (c.kind !== "shape") {
          childCtx.diags.error(Code.ChildrenNotAllowed, `\`${c.keyword}\` must be at the top level, not inside a group`, c.range);
          continue;
        }
        const child = resolveShape(c, shape, childNames, childCtx);
        if (child) shape.children.push(child);
      }
    }
  }
  return shape;
}

type Evaluated = { ok: true; value: number } | { ok: false; error: string; range?: SourceRange };

/** Evaluates a calculation. Names left after parameter substitution are errors. Result in pixels. */
export function evaluate(e: Expr): Evaluated {
  switch (e.k) {
    case "num":
      if (e.unit === "%") return { ok: false, error: "Percent cannot be used in a calculation (use pixels)" };
      return { ok: true, value: e.v };
    case "err":
      return { ok: false, error: e.message, range: e.range };
    case "ref": {
      const hint = e.name.includes("-") ? ` (for subtraction, put spaces around \`-\`: \`${e.name.replace(/-/g, " - ")}\`)` : "";
      return { ok: false, error: `Unknown name \`${e.name}\` in the calculation: only parameters of a custom shape can be used${hint}`, range: e.range };
    }
    case "neg": {
      const r = evaluate(e.e);
      return r.ok ? { ok: true, value: -r.value } : r;
    }
    case "bin": {
      const a = evaluate(e.a);
      if (!a.ok) return a;
      const b = evaluate(e.b);
      if (!b.ok) return b;
      switch (e.op) {
        case "+":
          return { ok: true, value: a.value + b.value };
        case "-":
          return { ok: true, value: a.value - b.value };
        case "*":
          return { ok: true, value: a.value * b.value };
        case "/":
          return b.value === 0 ? { ok: false, error: "Division by zero in the calculation" } : { ok: true, value: a.value / b.value };
      }
    }
  }
}

/** Resolves the shapes of a clip block once. Clip shapes cannot be clipped themselves. */
function resolveClip(def: ClipDef, usingCtx: Ctx, usedAt: SourceRange): Shape[] | null {
  if (def.shapes) return def.shapes;
  if (def.resolving) {
    usingCtx.diags.error(Code.InvalidClip, `Shapes inside clip \`${def.name}\` cannot use a clip`, usedAt);
    return null;
  }
  // An imported clip is resolved in its own file, with problems shown where it is used.
  const ctx: Ctx =
    def.scope === usingCtx.scope
      ? usingCtx
      : {
          ...usingCtx,
          diags: new ScopedDiagnostics(usingCtx.diags, usedAt, `In clip \`${def.name}\` (\`${def.scope.path}\`): `, def.scope.source),
          styles: def.scope.styles,
          scope: def.scope,
        };
  def.resolving = true;
  const names = new Map<string, Statement>();
  const shapes: Shape[] = [];
  for (const c of def.stmt.children) {
    if (c.kind !== "shape") {
      ctx.diags.error(Code.InvalidClip, `\`${c.keyword}\` cannot be inside a clip`, c.range);
      continue;
    }
    const s = resolveShape(c, null, names, ctx);
    if (!s) continue;
    if (!CLIP_SHAPES.has(s.type) || s.instanceOf) {
      ctx.diags.error(Code.InvalidClip, `A clip can contain ${[...CLIP_SHAPES].join(", ")}; not \`${c.keyword}\``, c.range);
      continue;
    }
    if (s.clip) {
      ctx.diags.error(Code.InvalidClip, `Shapes inside clip \`${def.name}\` cannot use a clip`, c.range);
      continue;
    }
    shapes.push(s);
  }
  def.resolving = false;
  def.shapes = shapes;
  return shapes;
}

/** Type-specific checks. Returns false when the shape cannot be drawn at all. */
function checkShape(shape: Shape, stmt: Statement, own: Map<string, RAttr>, diags: Diagnostics): boolean {
  const { type, attrs } = shape;

  // Positional values.
  const args = stmt.args;
  if (shape.spec.positional === "text") {
    const first = args[0];
    if (first && first.length === 1 && first[0].kind === "string") {
      shape.text = first[0].value;
    } else if (first) {
      diags.error(Code.InvalidValue, "The text must be in quotes: `text(\"Hello\")`", first[0].range);
    }
    for (const extra of args.slice(1)) unexpectedPositional(extra, diags);
  } else {
    for (const extra of args) unexpectedPositional(extra, diags);
  }

  const str = (k: string) => {
    const a = attrs.get(k);
    return a && a.value.t === "str" ? a.value.v : undefined;
  };

  switch (type) {
    case "text":
      if (shape.text === undefined) {
        diags.error(Code.MissingRequired, "Text is missing: write it first, in quotes: `text(\"Hello\")`", stmt.range);
        return false;
      }
      return true;

    case "polyline":
    case "polygon": {
      const pts = str("points");
      if (pts === undefined) {
        diags.error(Code.MissingRequired, "`points` is missing", stmt.range);
        return false;
      }
      const parsed = parsePoints(pts, type === "polygon" ? 3 : 2);
      if (!parsed.ok) {
        diags.error(Code.InvalidGeometry, parsed.error, attrs.get("points")!.range);
        return false;
      }
      shape.points = parsed.value;
      return true;
    }

    case "path": {
      const d = str("d");
      if (d === undefined) {
        diags.error(Code.MissingRequired, "`d` (path data) is missing", stmt.range);
        return false;
      }
      const parsed = parsePath(d);
      if (!parsed.ok) {
        diags.error(Code.InvalidGeometry, parsed.error, attrs.get("d")!.range);
        return false;
      }
      shape.pathData = parsed.value;
      return true;
    }

    case "line": {
      let ok = true;
      for (const [ref, x, y] of [
        ["from", "x1", "y1"],
        ["to", "x2", "y2"],
      ] as const) {
        const r = own.get(ref);
        const p = own.get(x) ?? own.get(y);
        if (r && p) {
          diags.error(Code.ConflictingAttributes, `\`${ref}\` and \`${p.written}\` both set the same end of the line`, p.range);
          attrs.delete(x);
          attrs.delete(y);
        }
        if (!r && !p) {
          diags.error(Code.MissingRequired, `Line ${ref === "from" ? "start" : "end"} is missing: give \`${ref}\` or \`${x}\` / \`${y}\``, stmt.range);
          ok = false;
        }
      }
      return ok;
    }

    case "rect": {
      const radius = own.get("radius");
      const corner = own.get("rx") ?? own.get("ry");
      if (radius && corner) {
        diags.error(Code.ConflictingAttributes, `\`radius\` and \`${corner.written}\` both set the corner radius`, corner.range);
      }
      return true;
    }

    default:
      return true;
  }
}

function unexpectedPositional(values: Value[], diags: Diagnostics): void {
  if (values.length === 0) return;
  diags.error(
    Code.UnexpectedPositional,
    "Unexpected value: attributes are written as `name=value`",
    { start: values[0].range.start, end: values[values.length - 1].range.end },
  );
}

/** Checks and converts one attribute value. Reports a diagnostic and returns null if invalid. */
export function convert(name: string, spec: AttrSpec, a: Attr, diags: Diagnostics): RValue | null {
  // Calculations become plain numbers first.
  const vals: Value[] = [];
  for (const v of a.values) {
    if (v.kind !== "expr") {
      vals.push(v);
      continue;
    }
    const r = evaluate(v.node);
    if (!r.ok) {
      diags.error(Code.InvalidValue, r.error, r.range ?? v.range);
      return null;
    }
    vals.push({ kind: "number", value: r.value, unit: "", range: v.range });
  }
  const fail = (msg: string, code: string = Code.InvalidValue): null => {
    diags.error(code, msg, a.valueRange);
    return null;
  };
  const single = (): Value | null => {
    if (vals.length !== 1) {
      fail(`\`${name}\` takes one value`);
      return null;
    }
    return vals[0];
  };
  const checkRange = (n: number): boolean => {
    if (spec.min !== undefined && (spec.exclusiveMin ? n <= spec.min : n < spec.min)) {
      fail(`\`${name}\` must be ${spec.exclusiveMin ? "more than" : "at least"} ${spec.min}`, Code.OutOfRange);
      return false;
    }
    if (spec.max !== undefined && n > spec.max) {
      fail(`\`${name}\` must be at most ${spec.max}`, Code.OutOfRange);
      return false;
    }
    return true;
  };
  const describe = (v: Value) =>
    v.kind === "func" || v.kind === "expr" ? v.text : v.kind === "string" ? `"${v.value}"` : String(v.value);

  switch (spec.kind) {
    case "lenX":
    case "lenY":
    case "px":
    case "number": {
      const v = single();
      if (!v) return null;
      if (v.kind !== "number") {
        const hint =
          v.kind === "ident" && v.value.includes("-")
            ? ` (for subtraction, put spaces around \`-\`: \`${v.value.replace(/-/g, " - ")}\`)`
            : "";
        return fail(`\`${name}\` must be a number, not \`${describe(v)}\`${hint}`);
      }
      if (v.unit === "%" && spec.kind !== "lenX" && spec.kind !== "lenY") {
        return fail(`Percent is not supported for \`${name}\``, Code.PercentNotSupported);
      }
      if (v.unit !== "" && spec.kind === "number") return fail(`\`${name}\` is a plain number (no unit)`);
      if (!checkRange(v.value)) return null;
      if (spec.kind === "number") return { t: "num", v: v.value };
      if (spec.kind === "px" && (name === "width" || name === "height")) return { t: "num", v: v.value }; // canvas
      if (spec.kind === "px") return { t: "len", len: { v: v.value, pct: false } };
      return { t: "len", len: { v: v.value, pct: v.unit === "%" } };
    }

    case "paint": {
      const v = single();
      if (!v) return null;
      if (v.kind === "number") return fail(`\`${name}\` must be a color, not \`${describe(v)}\``);
      return { t: "str", v: v.kind === "func" || v.kind === "expr" ? v.text : String(v.value) };
    }

    case "string": {
      const v = single();
      if (!v) return null;
      if (v.kind !== "string") return fail(`\`${name}\` must be text in quotes, like \`${name}="..."\``);
      return { t: "str", v: v.value };
    }

    case "font": {
      const v = single();
      if (!v) return null;
      if (v.kind === "func" || v.kind === "expr") return fail(`Invalid value for \`${name}\``);
      return { t: "str", v: String(v.value) };
    }

    case "dash": {
      if (vals.length === 1 && vals[0].kind === "string") return { t: "str", v: vals[0].value };
      if (vals.length > 0 && vals.every((v) => v.kind === "number" && v.unit !== "%")) {
        return { t: "str", v: vals.map((v) => String(v.kind === "number" ? v.value : "")).join(" ") };
      }
      return fail(`\`${name}\` must be numbers, like \`"8 4"\``);
    }

    case "scale": {
      if (vals.length < 1 || vals.length > 2 || !vals.every((v) => v.kind === "number" && v.unit === "")) {
        return fail(`\`${name}\` must be one number, or two (horizontal and vertical), like \`${name}=1.5\` or \`${name}=-1 1\``);
      }
      const nums = vals.map((v) => (v.kind === "number" ? v.value : 0));
      if (nums.some((n) => n === 0)) return fail(`\`${name}\` cannot be 0 (the shape would disappear)`, Code.OutOfRange);
      return { t: "str", v: nums.join(" ") };
    }

    case "enum": {
      const v = single();
      if (!v) return null;
      const s = v.kind === "ident" || v.kind === "string" ? String(v.value) : "";
      if (!spec.values!.includes(s)) {
        return fail(`\`${name}\` must be one of: ${spec.values!.join(", ")}`);
      }
      return { t: "str", v: s };
    }

    case "ref": {
      const v = single();
      if (!v) return null;
      if (v.kind !== "ident") return fail(`\`${name}\` must be the name of a shape`);
      return { t: "ref", path: v.value };
    }

    case "anchorX":
    case "anchorY": {
      const [target, gap, ...rest] = vals;
      if (!target || target.kind !== "ident") return fail(`\`${name}\` needs a shape name, like \`${name}=api 40\``);
      if (rest.length > 0) return fail(`\`${name}\` takes a shape name and one gap`);
      if (gap && gap.kind !== "number") return fail(`The gap in \`${name}\` must be a number`);
      return { t: "anchor", path: target.value, gap: gap && gap.kind === "number" ? { v: gap.value, pct: gap.unit === "%" } : { v: 0, pct: false } };
    }

    case "styles": {
      if (vals.length === 0 || vals.some((v) => v.kind !== "ident")) return fail("`style` must be one or more style names");
      return { t: "list", v: vals.map((v) => String(v.kind === "ident" ? v.value : "")) };
    }
  }
}
