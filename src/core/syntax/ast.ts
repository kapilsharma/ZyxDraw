/** Character offsets into the source text, `end` exclusive. */
export interface SourceRange {
  start: number;
  end: number;
}

export type Value =
  | { kind: "number"; value: number; unit: "" | "px" | "%"; range: SourceRange }
  | { kind: "string"; value: string; range: SourceRange }
  | { kind: "color"; value: string; range: SourceRange }
  | { kind: "ident"; value: string; range: SourceRange }
  /** Function-like value such as `rgb(0, 128, 0)`. `text` is the exact source text. */
  | { kind: "func"; name: string; text: string; range: SourceRange }
  /** A calculation such as `width / 2` (only parameters of a custom shape can be named). */
  | { kind: "expr"; node: Expr; text: string; range: SourceRange };

export type Expr =
  | { k: "num"; v: number; unit: "" | "px" | "%" }
  | { k: "ref"; name: string; range: SourceRange }
  | { k: "neg"; e: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr }
  /** A parameter that cannot be used in a calculation (substituted with an error message). */
  | { k: "err"; message: string; range: SourceRange };

export interface Attr {
  name: string;
  nameRange: SourceRange;
  values: Value[];
  /** The whole `name=value` text. */
  range: SourceRange;
  /** Just the value part, for replacing it later (two-way sync). */
  valueRange: SourceRange;
}

export type StatementKind = "shape" | "style" | "canvas" | "import" | "export" | "shapeDef" | "clipDef" | "gradientDef";

/** A name in `import a, b as c from ...` or `export a, b`. */
export interface ImportName {
  name: string;
  range: SourceRange;
  /** `b as c`: the name used in the importing file. */
  alias?: string;
  aliasRange?: SourceRange;
}

export interface Statement {
  kind: StatementKind;
  /** `rect`, `style`, `canvas`, ... */
  keyword: string;
  keywordRange: SourceRange;
  name?: string;
  nameRange?: SourceRange;
  /** Positional values, one list per item (e.g. the text of `t is text("Hello", x=1)`). */
  args: Value[][];
  attrs: Attr[];
  /** True when the statement ends with `:` and owns an indented block. */
  hasBlock: boolean;
  children: Statement[];
  /** Whole statement, including a multi-line attribute list (not its children). */
  range: SourceRange;
  /** Statement plus all its children. */
  blockRange: SourceRange;
  /** Offset of `(` and of the matching `)` (undefined if never closed). */
  openParen?: number;
  closeParen?: number;
  indent: number;
  /** Only for `import a, b as c from library`. Empty for `import *`. */
  importNames?: ImportName[];
  /** `import * from library`. */
  importAll?: boolean;
  /** The library name as written, such as `shapes.system`. May have a problem (reported). */
  importPath?: string;
  importPathRange?: SourceRange;
  /** Only for `export a, b`. */
  exportNames?: ImportName[];
}

export interface SyntaxTree {
  statements: Statement[];
}
