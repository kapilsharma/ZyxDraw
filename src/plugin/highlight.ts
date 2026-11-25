/**
 * Syntax highlighting for the ZyxDraw editor.
 *
 * A small scanner marks token ranges, and a CodeMirror view plugin adds a CSS class to each
 * (`zyxdraw-tok-keyword`, ...). styles.css colors them with the theme's code colors.
 * This only depends on `@codemirror/view` (no language package), which keeps it independent
 * of how Obsidian ships CodeMirror's language and highlighting modules.
 */
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { SHAPES } from "../core";

export type TokenClass = "keyword" | "type" | "def" | "property" | "string" | "number" | "atom" | "comment" | "operator" | "variable";

export interface HighlightRange {
  from: number;
  to: number;
  cls: TokenClass;
}

const KEYWORDS = new Set(["style", "canvas", "shape", "clip", "gradient", "stop", "import", "export", "from", "is", "layer", ...Object.keys(SHAPES)]);
/** `name is type(`: the word at the start of a line is a name when `is` follows it. */
const IS_FOLLOWS = /[ \t]+is\b/y;

const STRING = /"(?:[^"\\\n]|\\.)*"?/y;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:%|px)?/y;
const COLOR = /#[0-9a-fA-F]{3,8}(?![\w])/y;
const IDENT = /[A-Za-z_][\w.-]*/y;
const ATTR_FOLLOWS = /\s*=/y;

/** Classifies the tokens of a whole document. Ranges are sorted and do not overlap. */
export function scanHighlights(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let depth = 0;
  let atStart = true;
  /** An `import` or `export` line: its names, then `from` and the library name. */
  let listLine = false;
  let afterFrom = false;
  /** After a name: `is`, then the type. */
  let expectIs = false;
  let expectType = false;
  let afterEq = false;
  let i = 0;

  const match = (re: RegExp): string | null => {
    re.lastIndex = i;
    const m = re.exec(text);
    return m ? m[0] : null;
  };
  const push = (len: number, cls: TokenClass) => {
    out.push({ from: i, to: i + len, cls });
    i += len;
  };

  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      i++;
      if (depth === 0) {
        atStart = true;
        listLine = afterFrom = expectIs = expectType = false;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    let m: string | null;
    if (afterEq && (m = match(COLOR))) {
      afterEq = false;
      push(m.length, "atom");
    } else if (c === "#") {
      const nl = text.indexOf("\n", i);
      push((nl === -1 ? text.length : nl) - i, "comment");
    } else if ((m = match(STRING))) {
      afterEq = false;
      push(m.length, "string");
    } else if ((m = match(NUMBER))) {
      afterEq = false;
      push(m.length, "number");
    } else if ((m = match(IDENT))) {
      afterEq = false;
      if (depth === 0 && atStart) {
        atStart = false;
        IS_FOLLOWS.lastIndex = i + m.length;
        if (IS_FOLLOWS.test(text)) {
          expectIs = true;
          push(m.length, "def");
        } else {
          listLine = m === "import" || m === "export";
          push(m.length, KEYWORDS.has(m) ? "keyword" : "type");
        }
      } else if (depth === 0 && expectIs && m === "is") {
        expectIs = false;
        expectType = true;
        push(m.length, "keyword");
      } else if (depth === 0 && expectType) {
        expectType = false;
        push(m.length, KEYWORDS.has(m) ? "keyword" : "type");
      } else if (depth === 0 && listLine) {
        if (m === "from") afterFrom = true;
        push(m.length, m === "from" || m === "as" ? "keyword" : afterFrom ? "variable" : "def");
      } else {
        ATTR_FOLLOWS.lastIndex = i + m.length;
        const isAttr = depth > 0 && ATTR_FOLLOWS.test(text);
        push(m.length, isAttr ? "property" : "variable");
      }
    } else {
      atStart = false;
      expectIs = expectType = false; // an import or export line keeps going after `,` and `*`
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      if (c === "=") {
        afterEq = true;
        push(1, "operator");
      } else {
        i++;
      }
    }
  }
  return out;
}

const MARKS: Record<TokenClass, Decoration> = Object.fromEntries(
  (["keyword", "type", "def", "property", "string", "number", "atom", "comment", "operator", "variable"] as TokenClass[]).map((c) => [
    c,
    Decoration.mark({ class: `zyxdraw-tok-${c}` }),
  ]),
) as Record<TokenClass, Decoration>;

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const t of scanHighlights(view.state.doc.toString())) {
    if (t.to > t.from) builder.add(t.from, t.to, MARKS[t.cls]);
  }
  return builder.finish();
}

/** Ranges of the content of ```zyxd (or ~~~zyxd) fenced blocks in a markdown document. */
export function zyxdCodeBlocks(text: string): { from: number; to: number }[] {
  const blocks: { from: number; to: number }[] = [];
  const open = /^[ \t]*(`{3,}|~{3,})[ \t]*zyxd\b[^\n]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text)) !== null) {
    const from = Math.min(text.length, m.index + m[0].length + 1);
    const fence = m[1];
    const close = new RegExp(`^[ \\t]*${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`, "gm");
    close.lastIndex = from;
    const c = close.exec(text);
    const to = c ? c.index : text.length;
    blocks.push({ from, to });
    open.lastIndex = c ? c.index + c[0].length : text.length;
  }
  return blocks;
}

function buildCodeBlocks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  for (const block of zyxdCodeBlocks(text)) {
    for (const t of scanHighlights(text.slice(block.from, block.to))) {
      if (t.to > t.from) builder.add(block.from + t.from, block.from + t.to, MARKS[t.cls]);
    }
  }
  return builder.finish();
}

function highlighter(fn: (view: EditorView) => DecorationSet): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = fn(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = fn(update.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Highlighting for the whole document (the .zyxd editor). */
export function zyxHighlighting(): Extension {
  return highlighter(build);
}

/** Highlighting for ```zyxd blocks inside Obsidian's markdown editor. */
export function zyxCodeBlockHighlighting(): Extension {
  return highlighter(buildCodeBlocks);
}
