/**
 * Built-in shapes and their attributes, matching the shape docs
 * (Docs/CustomLanguage/Shapes/inbuild).
 */

export type AttrKind =
  /** Pixels or percent of the parent's width. */
  | "lenX"
  /** Pixels or percent of the parent's height. */
  | "lenY"
  /** Pixels only. */
  | "px"
  | "number"
  /** Color: name, #hex, rgb(...), none. */
  | "paint"
  | "string"
  /** `"8 4"` or `8 4`. */
  | "dash"
  /** Reference to a shape: `a`, `server1.box`. */
  | "ref"
  /** `shape gap`, horizontal (right-of, left-of). */
  | "anchorX"
  /** `shape gap`, vertical (above, below). */
  | "anchorY"
  /** One or more style names. */
  | "styles"
  | "enum"
  /** Font family name or quoted string. */
  | "font"
  /** One number (both axes) or two (`x y`); not 0. */
  | "scale";

export interface AttrSpec {
  kind: AttrKind;
  values?: readonly string[];
  min?: number;
  max?: number;
  /** Value must be greater than `min` (not equal). */
  exclusiveMin?: boolean;
}

export type ShapeType = "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" | "path" | "text" | "group";

export interface ShapeSpec {
  attrs: Record<string, AttrSpec>;
  aliases: Record<string, string>;
  /** The shape takes a first positional value (the text of `text`). */
  positional?: "text";
  /** `left` + `right` (or `top` + `bottom`) may set the size. */
  stretchable?: boolean;
  /** Box positioned through `x` / `y` and anchors. Lines are positioned by their end points. */
  boxed: boolean;
}

const presentation: Record<string, AttrSpec> = {
  fill: { kind: "paint" },
  "fill-opacity": { kind: "number", min: 0, max: 1 },
  "fill-rule": { kind: "enum", values: ["nonzero", "evenodd"] },
  stroke: { kind: "paint" },
  "stroke-width": { kind: "px", min: 0 },
  "stroke-opacity": { kind: "number", min: 0, max: 1 },
  "stroke-dasharray": { kind: "dash" },
  opacity: { kind: "number", min: 0, max: 1 },
  /** `none` hides the shape, like SVG. It is still laid out, so anchors and lines to it work. */
  display: { kind: "enum", values: ["inline", "none"] },
  style: { kind: "styles" },
  /** Name of a `name is clip():` block. */
  "clip-path": { kind: "ref" },
  /** Degrees, clockwise (like SVG), around the center of the shape's box. Layout ignores it. */
  rotate: { kind: "number" },
  /** Around the center of the shape's box. Layout ignores it. */
  scale: { kind: "scale" },
};

const position: Record<string, AttrSpec> = {
  x: { kind: "lenX" },
  y: { kind: "lenY" },
  right: { kind: "lenX" },
  bottom: { kind: "lenY" },
  "right-of": { kind: "anchorX" },
  "left-of": { kind: "anchorX" },
  above: { kind: "anchorY" },
  below: { kind: "anchorY" },
};

const font: Record<string, AttrSpec> = {
  "font-size": { kind: "px", min: 0, exclusiveMin: true },
  "font-family": { kind: "font" },
  "font-weight": { kind: "font" },
  "font-style": { kind: "enum", values: ["normal", "italic", "oblique"] },
};

const positionAliases = { left: "x", top: "y" };

export const SHAPES: Record<ShapeType, ShapeSpec> = {
  rect: {
    attrs: {
      ...presentation,
      ...position,
      width: { kind: "lenX", min: 0 },
      height: { kind: "lenY", min: 0 },
      rx: { kind: "px", min: 0 },
      ry: { kind: "px", min: 0 },
      radius: { kind: "px", min: 0 },
    },
    aliases: { ...positionAliases, radius_x: "rx", radius_y: "ry" },
    stretchable: true,
    boxed: true,
  },
  circle: {
    attrs: { ...presentation, ...position, r: { kind: "px", min: 0 }, cx: { kind: "lenX" }, cy: { kind: "lenY" } },
    aliases: { ...positionAliases, radius: "r", center_x: "cx", center_y: "cy" },
    boxed: true,
  },
  ellipse: {
    attrs: {
      ...presentation,
      ...position,
      rx: { kind: "px", min: 0 },
      ry: { kind: "px", min: 0 },
      cx: { kind: "lenX" },
      cy: { kind: "lenY" },
    },
    aliases: { ...positionAliases, radius_x: "rx", radius_y: "ry", center_x: "cx", center_y: "cy" },
    boxed: true,
  },
  line: {
    attrs: {
      ...presentation,
      x1: { kind: "lenX" },
      y1: { kind: "lenY" },
      x2: { kind: "lenX" },
      y2: { kind: "lenY" },
      from: { kind: "ref" },
      to: { kind: "ref" },
      arrow: { kind: "enum", values: ["none", "start", "end", "both"] },
      label: { kind: "string" },
    },
    aliases: {},
    boxed: false,
  },
  polyline: {
    attrs: { ...presentation, ...position, points: { kind: "string" }, radius: { kind: "px", min: 0 } },
    aliases: { ...positionAliases },
    boxed: true,
  },
  polygon: {
    attrs: { ...presentation, ...position, points: { kind: "string" }, radius: { kind: "px", min: 0 } },
    aliases: { ...positionAliases },
    boxed: true,
  },
  path: {
    attrs: { ...presentation, ...position, d: { kind: "string" } },
    aliases: { ...positionAliases },
    boxed: true,
  },
  text: {
    attrs: {
      ...presentation,
      ...position,
      ...font,
      "text-anchor": { kind: "enum", values: ["start", "middle", "end"] },
    },
    aliases: { ...positionAliases, align: "text-anchor" },
    positional: "text",
    boxed: true,
  },
  group: {
    attrs: {
      ...presentation,
      ...position,
      ...font,
      width: { kind: "lenX", min: 0 },
      height: { kind: "lenY", min: 0 },
    },
    aliases: { ...positionAliases },
    stretchable: true,
    boxed: true,
  },
};

/**
 * `name is gradient(...)`: a color blend used as `fill=name` / `stroke=name`. Positions (`cx`,
 * `cy`, `r`, `fx`, `fy`) are a fraction (0 to 1) or a percent of the filled shape's box, like SVG.
 */
export const GRADIENT: Pick<ShapeSpec, "attrs" | "aliases"> = {
  attrs: {
    type: { kind: "enum", values: ["linear", "radial"] },
    from: { kind: "paint" },
    to: { kind: "paint" },
    /** Linear: direction in degrees, clockwise from left-to-right (90: top to bottom). */
    angle: { kind: "number" },
    cx: { kind: "lenX" },
    cy: { kind: "lenY" },
    r: { kind: "lenX", min: 0 },
    fx: { kind: "lenX" },
    fy: { kind: "lenY" },
    spread: { kind: "enum", values: ["pad", "reflect", "repeat"] },
  },
  aliases: {},
};

/** `stop(offset=50%, color=red, opacity=0.5)` inside a gradient block. */
export const STOP: Pick<ShapeSpec, "attrs" | "aliases"> = {
  attrs: {
    offset: { kind: "lenX", min: 0 },
    color: { kind: "paint" },
    opacity: { kind: "number", min: 0, max: 1 },
  },
  aliases: { "stop-color": "color", "stop-opacity": "opacity" },
};

export function isShapeType(name: string): name is ShapeType {
  return Object.prototype.hasOwnProperty.call(SHAPES, name);
}

/** Attributes that place a shape. Styles may not set these. */
export const POSITION_ATTRS = new Set([...Object.keys(position), "cx", "cy", "x1", "y1", "x2", "y2", "from", "to"]);

/** Attributes copied as-is to SVG, in output order. */
export const PASSTHROUGH = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "opacity",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
] as const;
