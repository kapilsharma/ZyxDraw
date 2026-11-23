/**
 * Go to definition (Ctrl/Cmd + click in the text editor): what a word in the source refers to.
 * Works on the syntax tree only, so it is cheap and works even when the drawing has errors.
 */
import type { SourceRange, Statement, SyntaxTree } from "./syntax/ast";

/** Where a name is defined. */
export type DefinitionTarget =
  /** In this file. */
  | { file: null; range: SourceRange }
  /** In an imported file: the definition `name` there, or the top of the file when no name. */
  | { file: string; name?: string };

export interface DefinitionLink {
  /** The clickable word. */
  range: SourceRange;
  target: DefinitionTarget;
}

/** Attributes whose (first) value names a shape. */
const SHAPE_REFS = new Set(["from", "to", "right-of", "left-of", "above", "below"]);
/** Attributes whose value may name a gradient. */
const PAINT_REFS = new Set(["fill", "stroke", "background"]);

/** The name at `offset` and where it is defined, or null if the offset is not on such a name. */
export function definitionAt(tree: SyntaxTree, offset: number): DefinitionLink | null {
  const top = tree.statements;
  const inside = (r: SourceRange | undefined) => !!r && offset >= r.start && offset <= r.end;

  for (const s of top) {
    if (s.kind !== "import") continue;
    for (const n of s.importNames ?? []) {
      if (inside(n.range) && s.importPath) return { range: n.range, target: { file: s.importPath, name: n.name } };
    }
    if (inside(s.importPathRange) && s.importPath) return { range: s.importPathRange!, target: { file: s.importPath } };
  }

  const stmt = statementAt(top, offset, []);
  if (!stmt) return null;
  const [s, ancestors] = stmt;

  // `service web(...)`: the custom shape's definition.
  if (s.kind === "shape" && inside(s.keywordRange)) {
    const target = shapeDefinition(top, s.keyword);
    return target ? { range: s.keywordRange, target } : null;
  }

  for (const a of s.attrs) {
    if (!inside(a.range)) continue;
    for (const [i, v] of a.values.entries()) {
      if (v.kind !== "ident" || !inside(v.range)) continue;
      let range: SourceRange | undefined;
      if (a.name === "style") range = topLevel(top, "style", v.value)?.nameRange;
      else if (a.name === "clip-path") range = topLevel(top, "clipDef", v.value)?.nameRange;
      else if (PAINT_REFS.has(a.name)) range = topLevel(top, "gradientDef", v.value)?.nameRange;
      else if (SHAPE_REFS.has(a.name) && i === 0) range = resolveShapePath(top, ancestors, v.value)?.nameRange;
      return range ? { range: v.range, target: { file: null, range } } : null;
    }
  }
  return null;
}

/** The top-level definition of `kind` called `name` (`name is shape(...)`: kind `shapeDef`). */
export function topLevel(top: Statement[], kind: Statement["kind"], name: string): Statement | undefined {
  return top.find((s) => s.kind === kind && s.name === name);
}

/** Where the custom shape `name` is defined: in this file (wins), else the last import naming it. */
export function shapeDefinition(top: Statement[], name: string): DefinitionTarget | null {
  const local = topLevel(top, "shapeDef", name);
  if (local?.nameRange) return { file: null, range: local.nameRange };
  const imp = [...top].reverse().find((s) => s.kind === "import" && s.importNames?.some((n) => n.name === name));
  return imp?.importPath ? { file: imp.importPath, name } : null;
}

/** The innermost statement whose own text (not its children) contains `offset`, with its ancestors. */
function statementAt(list: Statement[], offset: number, ancestors: Statement[]): [Statement, Statement[]] | null {
  for (const s of list) {
    if (offset < s.blockRange.start || offset > s.blockRange.end) continue;
    if (offset >= s.range.start && offset <= s.range.end) return [s, ancestors];
    const inner = statementAt(s.children, offset, [...ancestors, s]);
    if (inner) return inner;
  }
  return null;
}

/**
 * A shape path (`api`, `server1.box`) as seen from a statement: the first part is looked up
 * among the siblings, then in each enclosing block outwards, then at the top level.
 */
function resolveShapePath(top: Statement[], ancestors: Statement[], path: string): Statement | undefined {
  const [first, ...rest] = path.split(".");
  const scopes = [...ancestors.map((a) => a.children).reverse(), top];
  for (const scope of scopes) {
    let s = scope.find((x) => x.kind === "shape" && x.name === first);
    for (const part of rest) s = s?.children.find((x) => x.name === part);
    if (s) return s;
  }
  return undefined;
}
