import { Code, Diagnostics } from "../diagnostics";
import type { Attr, Expr, ImportName, SourceRange, Statement, StatementKind, SyntaxTree, Value } from "./ast";
import { libraryNameProblem } from "./library-name";
import { tokenize, type LineInfo, type Token } from "./tokenizer";
import { SHAPES } from "../builtins/catalog";

/** Words that cannot be names: keywords and the built-in shape types. */
const RESERVED = new Map<string, string>([
  ...["is", "style", "shape", "clip", "gradient", "canvas", "import", "export", "layer"].map((k): [string, string] => [k, "keyword"]),
  ...Object.keys(SHAPES).map((k): [string, string] => [k, "built-in shape type"]),
]);

/**
 * Parses ZyxDraw source into a syntax tree. Never throws: problems are reported in `diags`, and
 * parsing continues with the next statement.
 *
 * Structure:
 *   - A statement is one logical line. Inside `( )` newlines are ignored, so a statement may span
 *     several physical lines.
 *   - A statement ending with `:` owns the following, more indented statements (its children).
 */
export function parse(source: string, diags: Diagnostics): SyntaxTree {
  const { tokens, lines } = tokenize(source, diags);
  checkIndentStyle(lines, diags);
  const logical = splitLogicalLines(tokens, lines, diags);
  const statements: Statement[] = [];
  for (const line of logical) {
    const stmt = parseStatement(line.tokens, line.indent, source, diags);
    if (stmt) statements.push(stmt);
  }
  return { statements: buildTree(statements, diags) };
}

interface LogicalLine {
  tokens: Token[];
  indent: number;
}

function checkIndentStyle(lines: LineInfo[], diags: Diagnostics): void {
  let tabs = false;
  let spaces = false;
  for (const l of lines) {
    if (l.usesTab) tabs = true;
    if (l.usesSpace) spaces = true;
    if (tabs && spaces && l.indent > 0) {
      diags.error(Code.Indentation, "Inconsistent indentation: use either tabs or spaces, not both", {
        start: l.start,
        end: l.start + l.indent,
      });
      return;
    }
  }
}

function splitLogicalLines(tokens: Token[], lines: LineInfo[], diags: Diagnostics): LogicalLine[] {
  const result: LogicalLine[] = [];
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i];
    const indent = lines[first.line].indent;
    const toks: Token[] = [];
    let depth = 0;
    let firstOpen: Token | null = null;

    while (i < tokens.length) {
      const t = tokens[i];
      const prev = toks[toks.length - 1];
      if (prev && t.line !== prev.line) {
        if (depth === 0) break;
        // Still inside `( )`. A line that is not indented deeper (and is not the closing `)`)
        // means the `(` was never closed: stop here so one typo does not swallow the file.
        const isClose = t.kind === "punct" && t.text === ")";
        if (!isClose && lines[t.line].indent <= indent) {
          diags.error(Code.UnclosedParen, "Unclosed `(`", range(firstOpen!));
          depth = 0;
          break;
        }
      }
      if (t.kind === "punct" && t.text === "(") {
        if (depth === 0 && !firstOpen) firstOpen = t;
        depth++;
      } else if (t.kind === "punct" && t.text === ")") {
        if (depth === 0) {
          diags.error(Code.UnexpectedCloseParen, "Unexpected `)`", range(t));
          i++;
          continue;
        }
        depth--;
      }
      toks.push(t);
      i++;
    }
    if (depth > 0 && firstOpen) diags.error(Code.UnclosedParen, "Unclosed `(`", range(firstOpen));
    if (toks.length > 0) result.push({ tokens: toks, indent });
  }
  return result;
}

function parseStatement(tokens: Token[], indent: number, source: string, diags: Diagnostics): Statement | null {
  const first = tokens[0];
  const whole: SourceRange = { start: first.start, end: tokens[tokens.length - 1].end };
  if (first.kind !== "ident") {
    diags.error(Code.ExpectedStatement, "Expected a shape type (like `rect`) or a keyword", whole);
    return null;
  }

  // `export is rect()` falls through, to be reported as a reserved name.
  const named = tokens[1]?.kind === "ident" && tokens[1].text === "is";
  if (first.text === "import" && !named) return parseImport(tokens, indent, whole, diags);
  if (first.text === "export" && !named) return parseExport(tokens, indent, whole, diags);
  if (first.text === "is") {
    diags.error(Code.ExpectedStatement, "`is` needs a name before it, like `box is rect(...)`", range(first));
    return null;
  }

  // `name is type(...)`, or just `type(...)` without a name.
  let name: string | undefined;
  let nameRange: SourceRange | undefined;
  let typeTok = first;
  let p = 1;
  if (tokens[1]?.kind === "ident" && tokens[1].text === "is") {
    name = first.text;
    nameRange = range(first);
    const t = tokens[2];
    if (!t || t.kind !== "ident") {
      diags.error(Code.ExpectedStatement, `Expected a shape type after \`is\`, like \`${name} is rect(...)\``, t ? range(t) : range(tokens[1]));
      return null;
    }
    typeTok = t;
    p = 3;
    if (RESERVED.has(name)) {
      diags.error(Code.ReservedName, `\`${name}\` is a ${RESERVED.get(name)} and cannot be used as a name`, nameRange);
    }
    if (t.text === "import" || t.text === "export" || t.text === "canvas") {
      const line = t.text === "canvas" ? "(...)" : " ...";
      diags.error(Code.ExpectedStatement, `\`${t.text}\` does not take a name: write \`${t.text}${line}\` on its own`, range(first));
      if (t.text !== "canvas") return null;
    }
  } else if (tokens[1]?.kind === "ident" && tokens[2]?.kind === "punct" && tokens[2].text === "(") {
    // The old form `rect box(...)`: report it, then read it as `box is rect(...)` so the rest
    // of the file still makes sense.
    name = tokens[1].text;
    nameRange = range(tokens[1]);
    diags.error(Code.OldSyntax, `Write the name first: \`${name} is ${first.text}(...)\``, { start: first.start, end: tokens[1].end });
    p = 2;
  }

  const keyword = typeTok.text;
  const open = tokens[p];
  if (!open || open.kind !== "punct" || open.text !== "(") {
    const at = open ?? tokens[tokens.length - 1];
    diags.error(Code.ExpectedParen, `Expected \`(\` after \`${name ?? keyword}\``, range(at));
    return null;
  }

  // Find the matching `)`.
  let depth = 0;
  let close = -1;
  for (let k = p; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== "punct") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")" && --depth === 0) {
      close = k;
      break;
    }
  }
  const inner = tokens.slice(p + 1, close === -1 ? tokens.length : close);
  const after = close === -1 ? [] : tokens.slice(close + 1);

  let hasBlock = false;
  if (after.length > 0) {
    if (after[0].kind === "punct" && after[0].text === ":") {
      hasBlock = true;
      if (after.length > 1) diags.error(Code.TrailingText, "Unexpected text after `:`", spanOf(after.slice(1)));
    } else {
      diags.error(Code.TrailingText, "Unexpected text after `)`", spanOf(after));
    }
  }

  const kind: StatementKind =
    keyword === "style"
      ? "style"
      : keyword === "canvas"
        ? "canvas"
        : keyword === "shape"
          ? "shapeDef"
          : keyword === "clip"
            ? "clipDef"
            : keyword === "gradient"
              ? "gradientDef"
              : "shape";

  const { args, attrs } = parseItems(inner, source, diags);
  return {
    kind,
    keyword,
    keywordRange: range(typeTok),
    name,
    nameRange,
    args,
    attrs,
    hasBlock,
    children: [],
    range: whole,
    blockRange: whole,
    openParen: open.start,
    closeParen: close === -1 ? undefined : tokens[close].start,
    indent,
  };
}

/**
 * `import a, b as c from library` or `import * from library`. The library name is dotted
 * (`shapes.system`); the tokenizer hands it over as one string token.
 */
function parseImport(tokens: Token[], indent: number, whole: SourceRange, diags: Diagnostics): Statement | null {
  let names: ImportName[] = [];
  let all = false;
  let p = 1;
  if (tokens[p]?.kind === "punct" && tokens[p].text === "*") {
    all = true;
    p++;
    if (tokens[p]?.kind === "ident" && tokens[p].text === "as") {
      const alias = tokens[p + 1]?.kind === "ident" && tokens[p + 1].text !== "from" ? tokens[p + 1] : undefined;
      diags.error(Code.ExpectedStatement, "`as` works only with named imports, like `import lambda as ly from cloud.aws`", spanOf(tokens.slice(p, alias ? p + 2 : p + 1)));
      p += alias ? 2 : 1;
    }
  } else {
    ({ names, next: p } = parseNameList(tokens, p, true, diags));
  }
  const fromTok = tokens[p];
  const pathTok = tokens[p + 1];
  if ((!all && names.length === 0) || !fromTok || fromTok.text !== "from" || !pathTok || (pathTok.kind !== "ident" && pathTok.kind !== "string")) {
    diags.error(Code.ExpectedStatement, "Expected `import name from library` (for example `import database from shapes.system`)", whole);
    return null;
  }
  if (tokens.length > p + 2) diags.error(Code.TrailingText, "Unexpected text after the library name", spanOf(tokens.slice(p + 2)));
  const problem = libraryNameProblem(String(pathTok.value));
  if (problem) diags.error(Code.InvalidLibraryName, problem, range(pathTok));
  return {
    kind: "import",
    keyword: "import",
    keywordRange: range(tokens[0]),
    args: [],
    attrs: [],
    hasBlock: false,
    children: [],
    range: whole,
    blockRange: whole,
    indent,
    importNames: names,
    importAll: all,
    importPath: String(pathTok.value),
    importPathRange: range(pathTok),
  };
}

/** `export a, b`: the names a library lets other files import. */
function parseExport(tokens: Token[], indent: number, whole: SourceRange, diags: Diagnostics): Statement | null {
  const { names, next } = parseNameList(tokens, 1, false, diags);
  if (names.length === 0) {
    diags.error(Code.ExpectedStatement, "Expected `export name, name` (for example `export database, primary`)", whole);
    return null;
  }
  if (tokens.length > next) diags.error(Code.TrailingText, "Unexpected text after the exported names", spanOf(tokens.slice(next)));
  return {
    kind: "export",
    keyword: "export",
    keywordRange: range(tokens[0]),
    args: [],
    attrs: [],
    hasBlock: false,
    children: [],
    range: whole,
    blockRange: whole,
    indent,
    exportNames: names,
  };
}

/** `a, b as c, d` from `tokens[p]` on, stopping before `from` or anything else. */
function parseNameList(tokens: Token[], p: number, allowAlias: boolean, diags: Diagnostics): { names: ImportName[]; next: number } {
  const names: ImportName[] = [];
  for (;;) {
    const t = tokens[p];
    if (!t || t.kind !== "ident" || t.text === "from") break;
    if (t.text.includes(".")) {
      diags.error(Code.ExpectedStatement, `\`${t.text}\` is not a name: a library name comes after \`from\`, like \`import database from shapes.system\``, range(t));
    }
    const item: ImportName = { name: t.text, range: range(t) };
    p++;
    const as = tokens[p];
    if (as?.kind === "ident" && as.text === "as") {
      const alias = tokens[p + 1];
      if (!allowAlias) {
        diags.error(Code.ExpectedStatement, "`as` is only for imports: export the name the library uses", range(as));
        p += alias?.kind === "ident" ? 2 : 1;
      } else if (alias?.kind === "ident" && alias.text !== "from") {
        item.alias = alias.text;
        item.aliasRange = range(alias);
        if (RESERVED.has(alias.text)) {
          diags.error(Code.ReservedName, `\`${alias.text}\` is a ${RESERVED.get(alias.text)} and cannot be used as a name`, range(alias));
        }
        p += 2;
      } else {
        diags.error(Code.ExpectedStatement, "Expected a new name after `as`, like `import lambda as ly from cloud.aws`", range(as));
        p++;
      }
    }
    names.push(item);
    if (tokens[p]?.kind === "punct" && tokens[p].text === ",") p++;
    else break;
  }
  return { names, next: p };
}

/** Splits the tokens between `( )` into items: separated by `,` or by a line break. */
function parseItems(tokens: Token[], source: string, diags: Diagnostics): { args: Value[][]; attrs: Attr[] } {
  const items: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    const prev = current[current.length - 1];
    if (depth === 0 && prev && t.line !== prev.line && !(t.kind === "punct" && t.text === ",")) {
      items.push(current);
      current = [];
    }
    if (t.kind === "punct" && t.text === "(") depth++;
    if (t.kind === "punct" && t.text === ")") depth--;
    if (depth === 0 && t.kind === "punct" && t.text === ",") {
      items.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  items.push(current);

  const args: Value[][] = [];
  const attrs: Attr[] = [];
  for (const item of items) {
    if (item.length === 0) continue;
    const isAttr = item.length >= 2 && item[1].kind === "punct" && item[1].text === "=";
    if (isAttr) {
      if (item[0].kind !== "ident") {
        diags.error(Code.ExpectedEquals, "Attribute name expected before `=`", range(item[0]));
        continue;
      }
      const valueTokens = item.slice(2);
      const whole = spanOf(item);
      if (valueTokens.length === 0) {
        diags.error(Code.MissingValue, `Missing value after \`${item[0].text}=\``, whole);
        continue;
      }
      attrs.push({
        name: item[0].text,
        nameRange: range(item[0]),
        values: parseValues(valueTokens, source, diags),
        range: whole,
        valueRange: spanOf(valueTokens),
      });
    } else {
      args.push(parseValues(item, source, diags));
    }
  }
  return { args, attrs };
}

const isOp = (t: Token | undefined, ops: string) => !!t && t.kind === "punct" && t.text.length === 1 && ops.includes(t.text);

function parseValues(tokens: Token[], source: string, diags: Diagnostics): Value[] {
  // A value with an operator is one calculation: `width / 2`, `(height - 20) / 2`.
  if (tokens.some((t) => isOp(t, "+-*/"))) {
    const node = parseExpr(tokens, diags);
    if (!node) return [];
    const r = spanOf(tokens);
    return [{ kind: "expr", node, text: source.slice(r.start, r.end), range: r }];
  }
  const values: Value[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.kind === "ident" && next?.kind === "punct" && next.text === "(" && next.start === t.end) {
      // Function-like value: rgb(0, 128, 0). Keep the exact text.
      let depth = 0;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j].kind !== "punct") continue;
        if (tokens[j].text === "(") depth++;
        else if (tokens[j].text === ")" && --depth === 0) break;
      }
      const end = j < tokens.length ? tokens[j].end : tokens[tokens.length - 1].end;
      values.push({ kind: "func", name: t.text, text: source.slice(t.start, end), range: { start: t.start, end } });
      i = j;
      continue;
    }
    switch (t.kind) {
      case "number":
        values.push({ kind: "number", value: t.value as number, unit: t.unit, range: range(t) });
        break;
      case "string":
        values.push({ kind: "string", value: t.value as string, range: range(t) });
        break;
      case "color":
        values.push({ kind: "color", value: t.text, range: range(t) });
        break;
      case "ident":
        values.push({ kind: "ident", value: t.text, range: range(t) });
        break;
      case "punct":
        diags.error(Code.ExpectedEquals, `Unexpected \`${t.text}\``, range(t));
        break;
    }
  }
  return values;
}

/**
 * One calculation written on its own, such as the inside of a `( )` group in `points` or `d`.
 * Token offsets are relative to `text`.
 */
export function parseCalculation(text: string): { ok: true; expr: Expr } | { ok: false; error: string } {
  const diags = new Diagnostics();
  const { tokens } = tokenize(text, diags);
  if (tokens.length === 0) return { ok: false, error: "Empty `( )`: write a calculation inside, like `(width - 10)`" };
  const expr = diags.list.length === 0 ? parseExpr(tokens, diags) : null;
  return expr ? { ok: true, expr } : { ok: false, error: diags.list[0]?.message ?? "Not a calculation" };
}

/** Calculation: `+ -` then `* /`, unary minus, parentheses, numbers and names. */
function parseExpr(tokens: Token[], diags: Diagnostics): Expr | null {
  let i = 0;
  let failed = false;
  const zero: Expr = { k: "num", v: 0, unit: "" };
  const fail = (t: Token, msg: string) => {
    if (!failed) diags.error(Code.InvalidValue, msg, range(t));
    failed = true;
  };

  const expr = (): Expr => {
    let a = term();
    while (isOp(tokens[i], "+-")) {
      const op = tokens[i++].text as "+" | "-";
      a = { k: "bin", op, a, b: term() };
    }
    return a;
  };
  const term = (): Expr => {
    let a = factor();
    while (isOp(tokens[i], "*/")) {
      const op = tokens[i++].text as "*" | "/";
      a = { k: "bin", op, a, b: factor() };
    }
    return a;
  };
  const factor = (): Expr => {
    const t = tokens[i];
    if (!t) {
      fail(tokens[tokens.length - 1], "The calculation ends too early");
      return zero;
    }
    if (isOp(t, "-")) {
      i++;
      return { k: "neg", e: factor() };
    }
    if (t.kind === "punct" && t.text === "(") {
      i++;
      const e = expr();
      if (tokens[i]?.kind === "punct" && tokens[i].text === ")") i++;
      else fail(t, "Missing `)` in the calculation");
      return e;
    }
    if (t.kind === "number") {
      i++;
      return { k: "num", v: t.value as number, unit: t.unit };
    }
    if (t.kind === "ident") {
      i++;
      return { k: "ref", name: t.text, range: range(t) };
    }
    fail(t, `Unexpected \`${t.text}\` in the calculation`);
    i++;
    return zero;
  };

  const e = expr();
  if (i < tokens.length) fail(tokens[i], `Unexpected \`${tokens[i].text}\` in the calculation`);
  return failed ? null : e;
}

/** Arranges statements into parent/child blocks using indentation. */
function buildTree(statements: Statement[], diags: Diagnostics): Statement[] {
  const root: Statement[] = [];
  interface Frame {
    indent: number;
    childIndent: number | undefined;
    list: Statement[];
  }
  const stack: Frame[] = [{ indent: -1, childIndent: 0, list: root }];

  for (const s of statements) {
    while (stack.length > 1 && s.indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    if (top.childIndent === undefined) {
      top.childIndent = s.indent;
    } else if (s.indent !== top.childIndent) {
      if (s.indent > top.childIndent) {
        diags.error(Code.UnexpectedIndent, "Unexpected indented line (only a statement ending with `:` can have children)", s.range);
      } else {
        diags.error(Code.Indentation, "Indentation does not match any outer block", s.range);
      }
    }
    top.list.push(s);
    if (s.hasBlock) stack.push({ indent: s.indent, childIndent: undefined, list: s.children });
  }

  const finish = (list: Statement[]) => {
    for (const s of list) {
      if (s.hasBlock && s.children.length === 0) diags.warning(Code.EmptyBlock, "Empty block: nothing is indented below `:`", s.range);
      finish(s.children);
      const last = s.children[s.children.length - 1];
      s.blockRange = { start: s.range.start, end: last ? Math.max(s.range.end, last.blockRange.end) : s.range.end };
    }
  };
  finish(root);
  return root;
}

function range(t: Token): SourceRange {
  return { start: t.start, end: t.end };
}

function spanOf(tokens: Token[]): SourceRange {
  return { start: tokens[0].start, end: tokens[tokens.length - 1].end };
}
