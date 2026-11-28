import { PASSTHROUGH } from "../builtins/catalog";
import { formatPath, formatPoints, offsetPath, pathBounds, pointsBounds, roundedPointsPath } from "../geometry";
import type { Placed, Scene } from "../layout/layout";
import type { Shape } from "../resolve/resolve";
import { shapeTransform, transformAbout } from "../transform";

export interface RenderOptions {
  /** Add `data-zyx-path` / `data-zyx-range` so the editor can map clicks back to the source. */
  metadata?: boolean;
}

/** Scene to SVG string. Pure string building. */
export function render(scene: Scene, options: RenderOptions = {}): string {
  const r = new Renderer(scene, options);
  return r.run();
}

class Renderer {
  private readonly markers = new Map<string, string>();
  private readonly clipDefs: string[] = [];
  private clipCount = 0;

  constructor(
    private readonly scene: Scene,
    private readonly options: RenderOptions,
  ) {}

  run(): string {
    const body: string[] = [];
    const { x, y, width, height, background } = this.scene.frame;
    // An infinite canvas may start at negative coordinates: the viewBox starts at its corner.
    const corner = x !== 0 || y !== 0 ? `x="${fmt(x)}" y="${fmt(y)}" ` : "";
    if (background) body.push(`  <rect ${corner}width="${fmt(width)}" height="${fmt(height)}" fill="${esc(background)}" />`);
    for (const s of this.scene.roots) this.shape(s, body, "  ");

    const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)}">`];
    const gradients = this.gradientDefs();
    if (this.markers.size > 0 || this.clipDefs.length > 0 || gradients.length > 0) {
      out.push("  <defs>");
      out.push(...gradients);
      for (const m of this.markers.values()) out.push(m);
      out.push(...this.clipDefs);
      out.push("  </defs>");
    }
    out.push(...body, "</svg>");
    return out.join("\n");
  }

  /** `<linearGradient>` / `<radialGradient>` for each gradient used, sized to each filled shape's box. */
  private gradientDefs(): string[] {
    const out: string[] = [];
    for (const g of this.scene.gradients ?? []) {
      if (!g.id) continue;
      const tag = g.type === "radial" ? "radialGradient" : "linearGradient";
      out.push(`    <${tag}${attrText([["id", g.id], ...g.attrs])}>`);
      for (const s of g.stops) {
        const a: [string, string][] = [["offset", s.offset], ["stop-color", s.color]];
        if (s.opacity !== undefined) a.push(["stop-opacity", s.opacity]);
        out.push(`      <stop${attrText(a)} />`);
      }
      out.push(`    </${tag}>`);
    }
    return out;
  }

  /**
   * `clip-path` for a clipped shape: writes a `<clipPath>` (one per use, since `%` inside depends
   * on the shape's box) and returns the attribute. Clip shapes are laid out in the shape's box,
   * so the clipPath is moved to the box's corner. A group's own transform already does that.
   */
  private clipAttr(s: Shape, box: { x: number; y: number }, ownTransform: boolean): [string, string][] {
    const sub = this.scene.clips.get(s.id);
    if (!sub || !s.clip) return [];
    const id = `clip-${s.clip.name}-${++this.clipCount}`;
    const tx = ownTransform ? 0 : box.x;
    const ty = ownTransform ? 0 : box.y;
    const inner: string[] = [];
    const r = new Renderer(sub, {});
    for (const c of sub.roots) r.shape(c, inner, "      ");
    this.clipDefs.push(
      `    <clipPath id="${esc(id)}" clipPathUnits="userSpaceOnUse" transform="translate(${fmt(tx)},${fmt(ty)})">`,
      ...inner,
      "    </clipPath>",
    );
    return [["clip-path", `url(#${id})`]];
  }

  private shape(s: Shape, out: string[], indent: string): void {
    const placed = this.scene.placed.get(s.id);
    if (!placed) return;
    const { box } = placed;
    const a: [string, string][] = [];
    const num = (k: string) => {
      const v = s.attrs.get(k);
      return v && v.value.t === "len" ? v.value.len.v : undefined;
    };
    const t = shapeTransform(s);
    /** `rotate` / `scale` around the box center (in the parent's coordinates). */
    const transform: [string, string][] = t ? [["transform", transformAbout(t, box.x + box.w / 2, box.y + box.h / 2, fmt)]] : [];
    let tag: string = s.type;

    switch (s.type) {
      case "rect": {
        a.push(["x", fmt(box.x)], ["y", fmt(box.y)], ["width", fmt(box.w)], ["height", fmt(box.h)]);
        const radius = num("radius");
        const rx = num("rx") ?? radius;
        const ry = num("ry") ?? radius;
        if (rx !== undefined) a.push(["rx", fmt(rx)]);
        if (ry !== undefined) a.push(["ry", fmt(ry)]);
        break;
      }
      case "circle":
        a.push(["cx", fmt(box.x + box.w / 2)], ["cy", fmt(box.y + box.h / 2)], ["r", fmt(box.w / 2)]);
        break;
      case "ellipse":
        a.push(["cx", fmt(box.x + box.w / 2)], ["cy", fmt(box.y + box.h / 2)], ["rx", fmt(box.w / 2)], ["ry", fmt(box.h / 2)]);
        break;
      case "line":
        this.line(s, placed, transform, out, indent);
        return;
      case "polyline":
      case "polygon": {
        const b = pointsBounds(s.points!);
        const radius = num("radius");
        if (radius) {
          // Rounded corners need curves: drawn as a path.
          tag = "path";
          a.push(["d", roundedPointsPath(s.points!, s.type === "polygon", radius, box.x - b.minX, box.y - b.minY, fmt)]);
        } else {
          a.push(["points", formatPoints(s.points!, box.x - b.minX, box.y - b.minY, fmt)]);
        }
        break;
      }
      case "path": {
        const b = pathBounds(s.pathData!);
        const dx = box.x - b.minX;
        const dy = box.y - b.minY;
        const attr = s.attrs.get("d");
        // A path written as steps has its compiled `d` (issue #41).
        const original = s.steps ? s.steps.d : attr?.value.t === "str" ? attr.value.v : undefined;
        const d =
          Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && original !== undefined && !original.includes("(")
            ? original // unchanged, without calculations: keep the user's formatting
            : formatPath(offsetPath(s.pathData!, dx, dy), fmt);
        a.push(["d", d]);
        break;
      }
      case "text":
        this.text(s, box.x, box.y, box.w, transform, out, indent);
        return;
      case "group": {
        const attrs: [string, string][] = [];
        // Children use the group's corner as origin, so its own transform is around (w/2, h/2).
        const parts: string[] = [];
        if (box.x !== 0 || box.y !== 0) parts.push(`translate(${fmt(box.x)},${fmt(box.y)})`);
        if (t) parts.push(transformAbout(t, box.w / 2, box.h / 2, fmt));
        if (parts.length > 0) attrs.push(["transform", parts.join(" ")]);
        attrs.push(...this.presentation(s), ...this.clipAttr(s, box, true), ...this.meta(s));
        out.push(`${indent}<g${attrText(attrs)}>`);
        for (const c of s.children) this.shape(c, out, indent + "  ");
        out.push(`${indent}</g>`);
        return;
      }
    }
    a.push(...transform, ...this.presentation(s), ...this.clipAttr(s, box, false), ...this.meta(s));
    out.push(`${indent}<${tag}${attrText(a)} />`);
  }

  private text(s: Shape, boxX: number, y: number, w: number, transform: [string, string][], out: string[], indent: string): void {
    const anchor = this.str(s, "text-anchor");
    const k = anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0;
    const x = boxX + k * w;
    const a: [string, string][] = [
      ["x", fmt(x)],
      ["y", fmt(y)],
      ...transform,
      ...this.presentation(s),
      ["dominant-baseline", "hanging"],
      ...this.clipAttr(s, { x: boxX, y }, false),
      ...this.meta(s),
    ];
    const lines = (s.text ?? "").split("\n");
    if (lines.length === 1) {
      out.push(`${indent}<text${attrText(a)}>${esc(lines[0])}</text>`);
      return;
    }
    out.push(`${indent}<text${attrText(a)}>`);
    lines.forEach((l, i) => out.push(`${indent}  <tspan x="${fmt(x)}" dy="${i === 0 ? "0" : "1.2em"}">${esc(l)}</tspan>`));
    out.push(`${indent}</text>`);
  }

  private line(s: Shape, placed: Placed, transform: [string, string][], out: string[], indent: string): void {
    const l = placed.line!;
    const stroke = this.str(s, "stroke") ?? "black";
    const a: [string, string][] = [["x1", fmt(l.x1)], ["y1", fmt(l.y1)], ["x2", fmt(l.x2)], ["y2", fmt(l.y2)], ...transform];
    const pres = this.presentation(s).filter(([k]) => k !== "stroke");
    a.push(["stroke", stroke], ...pres);
    const arrow = this.str(s, "arrow") ?? "none";
    if (arrow === "start" || arrow === "both") a.push(["marker-start", `url(#${this.marker("start", stroke)})`]);
    if (arrow === "end" || arrow === "both") a.push(["marker-end", `url(#${this.marker("end", stroke)})`]);
    a.push(...this.clipAttr(s, placed.box, false), ...this.meta(s));
    out.push(`${indent}<line${attrText(a)} />`);

    const label = this.str(s, "label");
    if (label !== undefined) {
      const mx = (l.x1 + l.x2) / 2;
      const my = (l.y1 + l.y2) / 2 - 6;
      // The label is its own element, so it hides with the line.
      const display = this.str(s, "display");
      const hide: [string, string][] = display === "none" ? [["display", "none"]] : [];
      out.push(`${indent}<text x="${fmt(mx)}" y="${fmt(my)}" text-anchor="middle"${attrText([...transform, ...hide])}>${esc(label)}</text>`);
    }
  }

  /** One shared arrow marker per direction and color. */
  private marker(dir: "start" | "end", color: string): string {
    const key = `${dir}:${color}`;
    const existing = this.markers.get(key);
    if (existing) {
      const m = /id="([^"]+)"/.exec(existing);
      if (m) return m[1];
    }
    const id = color === "black" ? `arrow-${dir}` : `arrow-${dir}-${this.markers.size + 1}`;
    const orient = dir === "end" ? "auto" : "auto-start-reverse";
    this.markers.set(
      key,
      [
        `    <marker id="${id}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="${orient}">`,
        `      <polygon points="0 0, 10 3.5, 0 7" fill="${esc(color)}" />`,
        `    </marker>`,
      ].join("\n"),
    );
    return id;
  }

  private presentation(s: Shape): [string, string][] {
    const out: [string, string][] = [];
    for (const k of PASSTHROUGH) {
      if (s.type === "text" && k === "text-anchor") {
        const v = this.str(s, k);
        if (v && v !== "start") out.push([k, v]);
        continue;
      }
      const v = s.attrs.get(k);
      if (!v) continue;
      if (v.value.t === "str") out.push([k, v.value.v]);
      else if (v.value.t === "num") out.push([k, fmt(v.value.v)]);
      else if (v.value.t === "len") out.push([k, fmt(v.value.len.v)]);
    }
    return out;
  }

  private meta(s: Shape): [string, string][] {
    if (!this.options.metadata) return [];
    return [
      ["data-zyx-path", s.path],
      ["data-zyx-range", `${s.stmt.range.start}-${s.stmt.range.end}`],
    ];
  }

  private str(s: Shape, k: string): string | undefined {
    const v = s.attrs.get(k);
    return v && v.value.t === "str" ? v.value.v : undefined;
  }
}

function attrText(attrs: [string, string][]): string {
  return attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
}

/** Numbers without float noise: 1.2000000001 -> 1.2, -0 -> 0. */
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
