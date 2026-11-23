/**
 * Scene to JSON Canvas (https://jsoncanvas.org, Obsidian's open canvas format).
 *
 * JSON Canvas only knows boxes (text, group) and edges between boxes, so the mapping is lossy:
 *   rect, circle, ellipse -> text node (empty, colored by its fill)
 *   text                  -> text node with the text
 *   group / custom shape  -> group node (children are included)
 *   line with from + to   -> edge (arrow and label kept)
 *   anything else         -> skipped, with a warning
 */
import { allShapes, geometry } from "../edit/edit";
import type { Scene } from "../layout/layout";
import type { Shape } from "../resolve/resolve";
import { shapeTransform } from "../transform";

export interface JsonCanvasNode {
  id: string;
  type: "text" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: string;
  color?: string;
}

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  label?: string;
  color?: string;
}

export interface JsonCanvas {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

export function toJsonCanvas(scene: Scene): { canvas: JsonCanvas; warnings: string[] } {
  const nodes: JsonCanvasNode[] = [];
  const edges: JsonCanvasEdge[] = [];
  const warnings: string[] = [];
  const ids = new Map<Shape, string>();
  const id = (s: Shape) => {
    let v = ids.get(s);
    if (!v) {
      v = `zyx-${s.path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
      ids.set(s, v);
    }
    return v;
  };
  const str = (s: Shape, k: string) => {
    const a = s.attrs.get(k);
    return a && a.value.t === "str" ? a.value.v : undefined;
  };

  const shapes = allShapes(scene);
  for (const s of shapes) {
    if (s.type === "line") continue;
    const g = geometry(scene, s);
    if (!g) continue;
    const base = {
      id: id(s),
      x: Math.round(g.box.x),
      y: Math.round(g.box.y),
      width: Math.max(1, Math.round(g.box.w)),
      height: Math.max(1, Math.round(g.box.h)),
    };
    const color = hexColor(str(s, "fill"));
    if (shapeTransform(s) && ["rect", "circle", "ellipse", "text", "group"].includes(s.type)) {
      warnings.push(`\`${s.path}\` is rotated or scaled; JSON Canvas cannot show that, so it is exported unturned`);
    }
    switch (s.type) {
      case "rect":
      case "circle":
      case "ellipse":
        nodes.push({ ...base, type: "text", text: "", ...(color ? { color } : {}) });
        break;
      case "text":
        nodes.push({ ...base, type: "text", text: s.text ?? "" });
        break;
      case "group":
        nodes.push({ ...base, type: "group", label: s.instanceOf ? `${s.name ?? s.instanceOf} (${s.instanceOf})` : s.name ?? "" });
        break;
      default:
        warnings.push(`\`${s.path}\` (${s.type}) has no JSON Canvas equivalent and was skipped`);
    }
  }

  for (const s of shapes) {
    if (s.type !== "line") continue;
    const from = s.attrs.get("from");
    const to = s.attrs.get("to");
    const lookup = (p: string) => shapes.find((x) => x.path === p || (x.name === p && x.parent === s.parent));
    const a = from && from.value.t === "ref" ? lookup(from.value.path) : undefined;
    const b = to && to.value.t === "ref" ? lookup(to.value.path) : undefined;
    if (!a || !b || !ids.has(a) || !ids.has(b)) {
      warnings.push(`Line \`${s.path}\` is not connected to two shapes and was skipped`);
      continue;
    }
    const arrow = str(s, "arrow") ?? "none";
    const label = str(s, "label");
    const color = hexColor(str(s, "stroke"));
    edges.push({
      id: id(s),
      fromNode: id(a),
      toNode: id(b),
      fromEnd: arrow === "start" || arrow === "both" ? "arrow" : "none",
      toEnd: arrow === "end" || arrow === "both" ? "arrow" : "none",
      ...(label ? { label } : {}),
      ...(color ? { color } : {}),
    });
  }

  return { canvas: { nodes, edges }, warnings };
}

/** JSON Canvas colors are hex (#rrggbb) or presets "1".."6". Named colors are not mapped. */
function hexColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : undefined;
}
