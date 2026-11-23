/**
 * Ctrl/Cmd + click on a name in the text editor goes to its definition. While Ctrl/Cmd is held,
 * the name under the mouse is underlined like a link. Nothing runs unless the key is held.
 */
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { Diagnostics, definitionAt, parse, type DefinitionLink, type SourceRange, type SyntaxTree } from "../core";

const setLink = StateEffect.define<SourceRange | null>();
const linkMark = Decoration.mark({ class: "zyxdraw-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLink)) return e.value ? Decoration.set([linkMark.range(e.value.start, e.value.end)]) : Decoration.none;
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Ctrl on Windows / Linux, Cmd on Mac. */
function modifier(e: MouseEvent | KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/** Parses once per document version (the tree is only needed while the modifier is held). */
function treeCache(): (doc: Text) => SyntaxTree {
  let last: { doc: Text; tree: SyntaxTree } | null = null;
  return (doc) => {
    if (last?.doc !== doc) last = { doc, tree: parse(doc.toString(), new Diagnostics()) };
    return last.tree;
  };
}

export function definitionAtCursor(view: EditorView): DefinitionLink | null {
  return definitionAt(parse(view.state.doc.toString(), new Diagnostics()), view.state.selection.main.head);
}

export function definitionLinks(go: (link: DefinitionLink) => void): Extension {
  const tree = treeCache();
  let shown: SourceRange | null = null;

  const show = (view: EditorView, range: SourceRange | null) => {
    if (shown?.start === range?.start && shown?.end === range?.end) return;
    shown = range;
    view.dispatch({ effects: setLink.of(range) });
  };
  const linkAt = (view: EditorView, e: MouseEvent): DefinitionLink | null => {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    return pos === null ? null : definitionAt(tree(view.state.doc), pos);
  };

  return [
    linkField,
    EditorView.domEventHandlers({
      mousemove(e, view) {
        if (modifier(e)) show(view, linkAt(view, e)?.range ?? null);
        else if (shown) show(view, null);
      },
      mousedown(e, view) {
        if (e.button !== 0 || !modifier(e)) return false;
        const link = linkAt(view, e);
        if (!link) return false;
        e.preventDefault();
        show(view, null);
        go(link);
        return true;
      },
      keyup(e, view) {
        if ((e.key === "Control" || e.key === "Meta") && shown) show(view, null);
        return false;
      },
      mouseleave(_e, view) {
        if (shown) show(view, null);
        return false;
      },
    }),
  ];
}
