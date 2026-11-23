/** Syntax colors and autocomplete for the ZyxDraw editor (CodeMirror 6, provided by Obsidian). */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { GRADIENT, SHAPES, STOP, isShapeType, type AttrSpec } from "../core";
import { zyxHighlighting } from "./highlight";

const BUILTINS = Object.keys(SHAPES);
/** `name is ...`: what can follow `is`. */
const DEFINE_KEYWORDS = ["style", "shape", "clip", "gradient"];
/** Lines without a name. */
const LINE_KEYWORDS = ["canvas", "import"];
const NAME = "[A-Za-z_][\\w-]*";

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
  for (const m of doc.matchAll(/^[ \t]*import[ \t]+([\w, \t-]+?)[ \t]+from\b/gm)) {
    for (const n of m[1].split(",")) if (n.trim()) defs.add(n.trim());
  }
  return { shapes: [...shapes], styles: [...styles], defs: [...defs], clips: [...clips], gradients: [...gradients] };
}

/** Paren depth at the end of `text`, and the type of the statement whose `(` is open. */
function context(text: string): { depth: number; type: string | null } {
  let depth = 0;
  let type: string | null = null;
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
        // The type: after `is` when the line has a name (`box is rect(`), else the first word.
        type = new RegExp(`^\\s*(?:${NAME}\\s+is\\s+)?(${NAME})`).exec(text.slice(lineStart, i))?.[1] ?? null;
      }
      depth++;
    } else if (c === ")") depth = Math.max(0, depth - 1);
  }
  return { depth, type };
}

function attrSpecs(type: string | null): { names: string[]; spec: (n: string) => AttrSpec | undefined } {
  const s = type === "gradient" ? GRADIENT : type === "stop" ? STOP : SHAPES[type && isShapeType(type) ? type : "group"];
  return {
    names: [...Object.keys(s.attrs), ...Object.keys(s.aliases)],
    spec: (n) => s.attrs[s.aliases[n] ?? n],
  };
}

function complete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[\w.-]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const doc = ctx.state.doc.toString();
  const before = doc.slice(0, word.from);
  const { depth, type } = context(before);
  const names = namesIn(doc);
  let options: Completion[] = [];

  if (depth === 0) {
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const types = [
      ...BUILTINS.map((label) => ({ label, type: "class", detail: "shape" })),
      ...names.defs.map((label) => ({ label, type: "class", detail: "custom shape" })),
    ];
    if (line.trim() === "") {
      // Start of a line: a new name (nothing to suggest), an unnamed shape, `canvas` or `import`.
      options = [...types, ...LINE_KEYWORDS.map((label) => ({ label, type: "keyword" }))];
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

export function zyxLanguageSupport(): Extension[] {
  return [
    zyxHighlighting(),
    autocompletion({ override: [complete] }),
    // Ctrl/Cmd+/ (toggle comment) needs to know the comment marker.
    EditorState.languageData.of(() => [{ commentTokens: { line: "#" } }]),
  ];
}
