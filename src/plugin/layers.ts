/**
 * Layer toggles in the text editor (issue #2): an eye next to the line number of each shape.
 * Clicking it hides or shows the shape through `display=none` in the text. The lines of a hidden
 * shape are faded. The layers come from the last compile and follow typing until the next one.
 */
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from "@codemirror/view";
import { setIcon } from "obsidian";
import type { Layer, SourceRange } from "../core";

/** The layers of the text just compiled. */
export const setLayers = StateEffect.define<Layer[]>();

const layerField = StateField.define<Layer[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLayers)) return e.value;
    if (!tr.docChanged || value.length === 0) return value;
    const map = (r: SourceRange): SourceRange => {
      const start = tr.changes.mapPos(r.start, 1);
      return { start, end: Math.max(start, tr.changes.mapPos(r.end, -1)) };
    };
    return value.map((l) => ({ ...l, range: map(l.range), blockRange: map(l.blockRange) }));
  },
});

class EyeMarker extends GutterMarker {
  constructor(
    readonly hidden: boolean,
    readonly byGroup: boolean,
    /** A library's definition (issue #25): hidden in the drawing area only, the text is not changed. */
    readonly viewOnly = false,
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof EyeMarker && other.hidden === this.hidden && other.byGroup === this.byGroup && other.viewOnly === this.viewOnly;
  }

  override toDOM(): Node {
    const el = createDiv({ cls: "zyxdraw-eye" });
    el.toggleClass("is-hidden-layer", this.hidden);
    el.toggleClass("is-hidden-by-group", this.byGroup && !this.hidden);
    setIcon(el, this.hidden ? "eye-off" : "eye");
    const label = this.viewOnly
      ? this.hidden
        ? "Show this shape in the drawing area"
        : "Hide this shape in the drawing area (the text does not change)"
      : this.hidden
        ? "Show this shape (removes display=none)"
        : this.byGroup
          ? "Hidden with its group. Click to hide this shape too"
          : "Hide this shape (display=none)";
    el.setAttribute("aria-label", label);
    return el;
  }
}

/** Placeholder that gives the gutter its width before the first compile. */
class Spacer extends GutterMarker {
  override toDOM(): Node {
    return createDiv({ cls: "zyxdraw-eye" });
  }
}

/** First line of each layer, one layer per line, in text order. */
function layersByLine(state: EditorState): { line: number; from: number; layer: Layer }[] {
  const out: { line: number; from: number; layer: Layer }[] = [];
  const len = state.doc.length;
  for (const l of state.field(layerField)) {
    if (l.range.start > len) continue;
    const line = state.doc.lineAt(l.range.start);
    if (out.length > 0 && out[out.length - 1].line >= line.number) continue;
    out.push({ line: line.number, from: line.from, layer: l });
  }
  return out;
}

/** Faded lines: each hidden shape, with its children. */
const fadedLines = EditorView.decorations.compute([layerField], (state): DecorationSet => {
  const lines = new Set<number>();
  const len = state.doc.length;
  for (const l of state.field(layerField)) {
    if (!l.hidden && !l.hiddenByGroup) continue;
    const r = l.hidden ? l.blockRange : l.range;
    if (r.start > len) continue;
    const first = state.doc.lineAt(r.start).number;
    const last = state.doc.lineAt(Math.min(len, Math.max(r.start, r.end - 1))).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  const b = new RangeSetBuilder<Decoration>();
  const deco = Decoration.line({ class: "zyxdraw-hidden-line" });
  for (const n of [...lines].sort((a, b) => a - b)) b.add(state.doc.line(n).from, state.doc.line(n).from, deco);
  return b.finish();
});

/** The layer list and the faded lines. Always on, so hidden shapes show even without the eyes. */
export function layerTracking(): Extension {
  return [layerField, fadedLines];
}

/** The eye gutter (the setting turns it off). `toggle` gets the shape's path when an eye is clicked. */
export function layerToggles(toggle: (path: string) => void): Extension {
  return [
    gutter({
      class: "zyxdraw-layer-gutter",
      markers: (view) => {
        const b = new RangeSetBuilder<GutterMarker>();
        for (const { from, layer } of layersByLine(view.state)) b.add(from, from, new EyeMarker(layer.hidden, layer.hiddenByGroup, layer.path.startsWith("def:")));
        return b.finish();
      },
      lineMarkerChange: (update) => update.startState.field(layerField) !== update.state.field(layerField),
      initialSpacer: () => new Spacer(),
      domEventHandlers: {
        mousedown: (view, line, event) => {
          const target = event.target as Node | null;
          if (!target?.instanceOf(Element) || !target.closest(".zyxdraw-eye")) return false;
          const hit = layersByLine(view.state).find((x) => x.from === line.from);
          if (!hit) return false;
          event.preventDefault();
          toggle(hit.layer.path);
          return true;
        },
      },
    }),
  ];
}
