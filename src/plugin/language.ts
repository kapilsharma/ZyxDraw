/** Syntax colors and autocomplete for the ZyxDraw editor (CodeMirror 6, provided by Obsidian). */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { GRADIENT, SHAPES, STEP_NAMES, STOP, isShapeType, stepSpec, type AttrSpec } from "../core";
import { zyxHighlighting } from "./highlight";

const BUILTINS = Object.keys(SHAPES);
/** `name is ...`: what can follow `is`. */
const DEFINE_KEYWORDS = ["style", "shape", "clip", "gradient"];
/** Lines without a name. */
const LINE_KEYWORDS = ["canvas", "import", "export"];
const NAME = "[A-Za-z_][\\w-]*";
/** One name in an import, maybe renamed: `lambda` or `lambda as ly`. */
const IMPORTED = `${NAME}(?:\\s+as\\s+${NAME})?`;

// ---- autocomplete ---------------------------------------------------------------------------

const COLORS = ["none", "black", "white", "gray", "red", "orange", "gold", "yellow", "green", "teal", "steelblue", "blue", "navy", "purple", "crimson", "lightgray", "lightblue", "lightgreen", "lightyellow"];
const REF_ATTRS = new Set(["from", "to", "right-of", "left-of", "above", "below"]);

/** Names found in the document, for suggestions. */
function namesIn(doc: string) {
  const shapes = new Set<string>();
  const styles = new Set<string>();
  const defs = new Set<string>();
  const clips = new Set<string>();
  const gradients = new Set<string>();
  // `name is type(`
  for (const m of doc.matchAll(new RegExp(`^[ \\t]*(${NAME})[ \\t]+is[ \\t]+(${NAME})[ \\t]*\\(`, "gm"))) {
    if (m[2] === "style") styles.add(m[1]);
    else if (m[2] === "shape") defs.add(m[1]);
    else if (m[2] === "clip") clips.add(m[1]);
    else if (m[2] === "gradient") gradients.add(m[1]);
    else shapes.add(m[1]);
  }
  // `import a, b as c from ...`: the names used in this file (after `as` when renamed).
  for (const m of doc.matchAll(/^[ \t]*import[ \t]+([\w, \t-]+?)[ \t]+from\b/gm)) {
    for (const n of m[1].split(",")) {
      const used = n.trim().split(/\s+as\s+/).pop();
      if (used) defs.add(used);
    }
  }
  return { shapes: [...shapes], styles: [...styles], defs: [...defs], clips: [...clips], gradients: [...gradients] };
}

/**
 * Whether the line starting at `lineStart` is in the block of a `path` (issue #41): the nearest
 * line above it that is less indented (blank lines and comments aside) begins a path.
 */
export function inPathBlock(text: string, lineStart: number): boolean {
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0].length;
  let end = lineStart - 1;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    end = start - 1;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^[ \t]*/.exec(line)![0].length >= indent) continue;
    return new RegExp(`^\\s*(?:${NAME}\\s+is\\s+)?path\\s*\\(`).test(line);
  }
  return false;
}

/** The steps, for the start of a line in a path's block. */
function stepOptions(): Completion[] {
  return STEP_NAMES.map((label) => {
    const spec = stepSpec(label)!.spec;
    return { label, type: "keyword", detail: "step", info: spec.about, apply: label === "close" ? "close" : `${label}(` };
  });
}

/** Paren depth at the end of `text`, the type of the statement whose `(` is open, and where its line starts. */
function context(text: string): { depth: number; type: string | null; lineStart: number } {
  let depth = 0;
  let type: string | null = null;
  let openLine = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"' || c === "\n") inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "#" && !/[=(,]\s*$/.test(text.slice(Math.max(0, i - 3), i))) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
    } else if (c === "(") {
      if (depth === 0) {
        const lineStart = text.lastIndexOf("\n", i - 1) + 1;
        openLine = lineStart;
        // The type: after `is` when the line has a name (`box is rect(`), else the first word.
        type = new RegExp(`^\\s*(?:${NAME}\\s+is\\s+)?(${NAME})`).exec(text.slice(lineStart, i))?.[1] ?? null;
      }
      depth++;
    } else if (c === ")") depth = Math.max(0, depth - 1);
  }
  return { depth, type, lineStart: openLine };
}

function attrSpecs(type: string | null): { names: string[]; spec: (n: string) => AttrSpec | undefined } {
  const s = type === "gradient" ? GRADIENT : type === "stop" ? STOP : SHAPES[type && isShapeType(type) ? type : "group"];
  return {
    names: [...Object.keys(s.attrs), ...Object.keys(s.aliases)],
    spec: (n) => s.attrs[s.aliases[n] ?? n],
  };
}

/** `preview():`, offered at the start of a line in a library only (issue #23). */
const PREVIEW: Completion = { label: "preview", type: "keyword", detail: "example uses, shown when the library is open", apply: "preview():\n  " };

function complete(ctx: CompletionContext, library: boolean): CompletionResult | null {
  const word = ctx.matchBefore(/[\w.-]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const doc = ctx.state.doc.toString();
  const before = doc.slice(0, word.from);
  const { depth, type, lineStart } = context(before);
  const names = namesIn(doc);
  let options: Completion[];

  // In the block of a path written as steps (issue #41): its steps, and their attributes.
  if (depth === 0) {
    const ls = before.lastIndexOf("\n") + 1;
    if (before.slice(ls).trim() === "" && inPathBlock(doc, ls)) return { from: word.from, options: stepOptions(), validFor: /^[\w.-]*$/ };
  } else if (type && stepSpec(type) && inPathBlock(doc, lineStart)) {
    const spec = stepSpec(type)!.spec;
    const eq = /([A-Za-z_][\w-]*)=\s*$/.exec(before);
    if (eq) {
      if (eq[1] !== "long" && eq[1] !== "clockwise") return null;
      options = ["yes", "no"].map((label) => ({ label, type: "enum" }));
    } else {
      options = [...spec.attrs, ...spec.named].map((label) => ({ label, type: "property", apply: `${label}=` }));
    }
    return { from: word.from, options, validFor: /^[\w.-]*$/ };
  }

  if (depth === 0) {
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const types = [
      ...BUILTINS.map((label) => ({ label, type: "class", detail: "shape" })),
      { label: "layer", type: "class", detail: "layer (top level)" },
      ...names.defs.map((label) => ({ label, type: "class", detail: "custom shape" })),
    ];
    if (line.trim() === "") {
      // Start of a line: a new name (nothing to suggest), an unnamed shape, `canvas` or `import`.
      options = [...types, ...LINE_KEYWORDS.map((label) => ({ label, type: "keyword" })), ...(library ? [PREVIEW] : [])];
    } else if (/^\s*export\s+(?:[\w-]+\s*,\s*)*$/.test(line)) {
      // `export |`: the names this file defines or imports.
      const all = new Set([...names.defs, ...names.styles, ...names.gradients, ...names.clips]);
      options = [...all].map((label) => ({ label, type: "variable" }));
    } else if (/^\s*import\s+\*\s+$/.test(line)) {
      options = [{ label: "from", type: "keyword", apply: "from " }];
    } else if (new RegExp(`^\\s*import\\s+${IMPORTED}(?:\\s*,\\s*${IMPORTED})*\\s+$`).test(line)) {
      // `import a |`: `from`, or `as` to give it another name.
      options = [
        { label: "from", type: "keyword", apply: "from " },
        { label: "as", type: "keyword", detail: "new name", apply: "as " },
      ];
    } else if (new RegExp(`^\\s*${NAME}\\s+is\\s+$`).test(line)) {
      // `box is |`: the type, or a definition.
      options = [...types, ...DEFINE_KEYWORDS.map((label) => ({ label, type: "keyword", detail: "definition" }))];
    } else if (new RegExp(`^\\s*${NAME}\\s+$`).test(line) && !LINE_KEYWORDS.includes(line.trim())) {
      // `box |`: the name is written, `is` comes next.
      options = [{ label: "is", type: "keyword", detail: "name is type(...)", apply: "is " }];
    } else return null;
  } else {
    const eq = /([A-Za-z_][\w-]*)=\s*$/.exec(before);
    const { names: attrNames, spec } = attrSpecs(type);
    if (eq) {
      const attr = eq[1];
      const sp = type === "canvas" && attr === "background" ? ({ kind: "paint" } as AttrSpec) : spec(attr);
      if (REF_ATTRS.has(attr)) options = names.shapes.map((label) => ({ label, type: "variable" }));
      else if (attr === "style") options = names.styles.map((label) => ({ label, type: "variable" }));
      else if (attr === "clip-path") options = names.clips.map((label) => ({ label, type: "variable" }));
      else if (sp?.kind === "enum") options = (sp.values ?? []).map((label) => ({ label, type: "enum" }));
      else if (sp?.kind === "paint") {
        options = [
          ...(type === "gradient" || type === "stop" ? [] : names.gradients.map((label) => ({ label, type: "variable", detail: "gradient" }))),
          ...COLORS.map((label) => ({ label, type: "constant" })),
        ];
      }
      else return null;
    } else if (type === "canvas") {
      options = [
        { label: "infinite", type: "keyword", detail: "no fixed size" },
        ...["width", "height", "background"].map((label) => ({ label, type: "property", apply: `${label}=` })),
      ];
    } else {
      options = attrNames.map((label) => ({ label, type: "property", apply: `${label}=` }));
    }
  }
  return { from: word.from, options, validFor: /^[\w.-]*$/ };
}

/** `library`: the file is a `.zyxdl` library, where `preview():` is offered too. */
export function zyxLanguageSupport(options: { library?: boolean } = {}): Extension[] {
  const library = options.library ?? false;
  return [
    zyxHighlighting(),
    autocompletion({ override: [(ctx) => complete(ctx, library)] }),
    // Ctrl/Cmd+/ (toggle comment) needs to know the comment marker.
    EditorState.languageData.of(() => [{ commentTokens: { line: "#" } }]),
  ];
}
