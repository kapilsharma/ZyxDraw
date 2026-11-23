/**
 * The drawing view: shows the compiled SVG and turns pointer and keyboard input into edit
 * operations (core/edit). It never changes the drawing itself: every change goes through the
 * text, then the drawing is recompiled. See Docs/dev/Editor.md.
 */
import { Menu, Notice, Platform, setIcon } from "obsidian";
import {
  allShapes,
  canAddPoints,
  copyText,
  deletePoint,
  deleteShapes,
  duplicateShapes,
  editableShape,
  groupShapes,
  moveShapes,
  pasteText,
  setProperty,
  ungroupShape,
  formatCoordinate,
  geometry,
  gridPath,
  gridSteps,
  hasPoints,
  insertedPointsText,
  insertLine,
  insertPath,
  insertPoint,
  insertPolygon,
  insertShape,
  isHiddenInDrawing,
  localOrigin,
  snapDelta,
  movePoint,
  movedPointsText,
  normalizeEdits,
  overlayTransforms,
  penPathData,
  pointHandles,
  previewGeometry,
  reorderShape,
  resizeShape,
  sideHandles,
  type Box,
  type PenNode,
  type CompileResult,
  type EditResult,
  type EditTarget,
  type GradientDef,
  type NewShapeType,
  type Reorder,
  type Shape,
} from "../core";
import { colorToHex, hasSyntaxErrors } from "./properties";
import type { Guide } from "./settings";
import { uniqueIds } from "./svg";

export interface DrawingHost {
  /** The text and its compile result, or null while the text is newer than the result. */
  current(): { source: string; result: CompileResult } | null;
  /** Applies an edit made against `source` (dropped if the text changed meanwhile). */
  apply(edit: EditResult, source: string): void;
  undo(): void;
  redo(): void;
  revealInSource(path: string): void;
  defaultUnit(): "percent" | "pixel";
  /** The selected shape changed (null = nothing, i.e. the canvas). */
  selectionChanged(path: string | null): void;
  /** Whether the grid / mouse coordinates are on (a plugin setting). */
  guideOn(guide: Guide): boolean;
  toggleGuide(guide: Guide): void;
  /** Shows the mouse position (null hides it). */
  showCoordinates(text: string | null): void;
  /** A point of the selected shape was clicked: select its numbers in the text (side by side). */
  pointSelected(path: string, index: number): void;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Tool = "select" | "hand" | "polygon" | "line" | "pen";
/** Tools that draw a new shape with clicks. */
const DRAWING_TOOLS: Tool[] = ["polygon", "line", "pen"];
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const SVG_NS = "http://www.w3.org/2000/svg";
/** Element attributes a point drag previews (restored on cancel). */
const GEOMETRY_ATTRS = ["d", "points", "x1", "y1", "x2", "y2"];
/** Pointer travel (screen px) before a press becomes a drag. */
const DRAG_THRESHOLD = 3;

interface DragState {
  /** `many`: moving several selected shapes; `marquee`: dragging a box to select shapes. */
  kind: "move" | "resize" | "point" | "insert" | "many" | "marquee";
  /** Kind "many": the shapes moved, and their elements with the transform they had. */
  paths?: string[];
  els?: { el: SVGGraphicsElement; transform: string | null }[];
  /** Kind "marquee": Shift held, so the shapes are added to the selection; the box drawn. */
  additive?: boolean;
  rect?: SVGRectElement;
  path: string;
  handle?: Handle;
  /** Point index (kind "point"). */
  point?: number;
  /** Side a new point is added on (kind "insert": dragging a side's middle dot). */
  side?: number;
  pointerId: number;
  /** Start in the drag's own coordinates (see `dragLayer`). */
  start: { x: number; y: number };
  startClient: { x: number; y: number };
  box: Box;
  el: SVGGraphicsElement | null;
  originalTransform: string | null;
  /** The element's geometry before a point drag (restored on cancel). */
  originalGeometry?: { attr: string; value: string | null }[];
  moved: boolean;
  /**
   * What snaps to the grid, in the drag's coordinates: the box corner (move), the dragged
   * edges (resize, null for an axis the handle does not change) or the point.
   */
  anchor: { x: number | null; y: number | null };
  /** Grid step at the start of the drag (the zoom does not change while dragging). */
  step: number;
}

/**
 * Overlay layers. `outer` shows what the enclosing groups' rotate / scale do, `mid` moves with
 * a drag, `inner` adds the shape's own rotate / scale. Selection and handles go in `inner`,
 * in frame coordinates.
 */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layers {
  outer: SVGGElement;
  mid: SVGGElement;
  inner: SVGGElement;
}

export class DrawingEditor {
  readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private svg: SVGSVGElement | null = null;
  private overlay: SVGGElement | null = null;
  private layers: Layers | null = null;
  private selected: string | null = null;
  /** Several shapes selected (Shift+click, box): all of them, `selected` being the last one. Empty otherwise. */
  private multi: string[] = [];
  /** Fill and stroke buttons in the toolbar, showing the selected shape's colors. */
  private readonly paintButtons = new Map<"fill" | "stroke", HTMLElement>();
  private colorInput: HTMLInputElement | null = null;
  /** Pixels per drawing unit, or null to fit the width of the pane. */
  private zoom: number | null = null;
  private drag: DragState | null = null;
  /** Select edits shapes; hand drags to scroll. */
  private tool: Tool = "select";
  private readonly toolButtons = new Map<Tool, HTMLElement>();
  /** Space held down: temporary hand tool. */
  private spaceHeld = false;
  private pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
  private grid: SVGGElement | null = null;
  /** The point of the selected path / polygon / polyline last clicked (index), shown in the text. */
  private selectedPoint: number | null = null;
  /** After a point drag, show the point's new numbers in the text once the drawing is redrawn. */
  private revealPointOnShow = false;
  /** Polygon tool: the points placed so far (frame coordinates), and the mouse. */
  private draft: { points: { x: number; y: number }[]; mouse: { x: number; y: number } | null } | null = null;
  /** Line tool: the first end once placed (`pressed`: the button is still down, so release finishes). */
  private lineDraft: { start: { x: number; y: number } | null; mouse: { x: number; y: number } | null; pressed: boolean } | null = null;
  /**
   * Pen tool: the nodes placed so far and the mouse. `press`: the button is down on node
   * `index` (dragging pulls out its curve handles); `closing`: it is the first node.
   */
  private pen: {
    nodes: PenNode[];
    mouse: { x: number; y: number } | null;
    press: { pointerId: number; index: number; closing: boolean; client: { x: number; y: number }; moved: boolean } | null;
  } | null = null;
  private readonly guideButtons = new Map<Guide, HTMLElement>();
  /** The selected shape's own coordinates, for the mouse position: its name and 0,0. */
  private local: { name: string; origin: { x: number; y: number } } | null = null;
  /** Last mouse position, shown on the next animation frame (at most one update per frame). */
  private mouse: { clientX: number; clientY: number } | null = null;
  private mouseFrame = 0;
  /** `canvas(infinite)`: the view shows the content with room around it (see `show`). */
  private infinite = false;
  /** The drawing's own area (its SVG viewBox): the canvas, or an infinite canvas's content. */
  private content: Rect = { x: 0, y: 0, w: 400, h: 300 };
  /** Infinite canvas: the area shown, which grows with the content but never shrinks while open. */
  private view: Rect | null = null;
  /** Infinite canvas shown while the pane had no size: fit it once the pane has one. */
  private needsFit = false;

  constructor(
    parent: HTMLElement,
    private readonly host: DrawingHost,
  ) {
    this.el = parent.createDiv({ cls: "zyxdraw-drawing" });
    this.buildToolbar(this.el.createDiv({ cls: "zyxdraw-toolbar" }));
    this.stage = this.el.createDiv({ cls: "zyxdraw-stage", attr: { tabindex: "0" } });

    this.stage.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.stage.addEventListener("pointermove", (e) => {
      this.trackMouse(e);
      this.onPointerMove(e);
    });
    this.stage.addEventListener("pointerleave", () => this.trackMouse(null));
    this.stage.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.stage.addEventListener("pointercancel", () => {
      this.cancelDrag();
      this.endPan();
    });
    this.stage.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    this.stage.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.stage.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.stage.addEventListener("keyup", (e) => {
      if (e.key === " ") this.setSpaceHeld(false);
    });
    this.stage.addEventListener("blur", () => this.setSpaceHeld(false));
    this.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Pane resized (drag handles, window): handles keep their on-screen size.
    new ResizeObserver(() => {
      if (this.needsFit && this.stage.clientWidth > 0) this.setZoom(null);
      this.drawGrid();
      if (!this.drag) this.drawOverlay();
    }).observe(this.stage);
    this.setTool("select");
    this.refreshGuides();
  }

  // ---- grid and mouse coordinates ---------------------------------------------------------

  /** Applies the grid and coordinates settings (toolbar buttons, grid lines). */
  refreshGuides(): void {
    for (const [g, b] of this.guideButtons) {
      const on = this.host.guideOn(g);
      b.toggleClass("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    this.drawGrid();
    if (!this.host.guideOn("coordinates")) this.trackMouse(null);
  }

  /** Screen pixels per drawing unit. */
  private pxPerUnit(): number {
    const m = this.svg?.getScreenCTM();
    return (m && Math.hypot(m.a, m.b)) || 1;
  }

  /**
   * Grid lines over the whole canvas, under the selection. Spaced so they stay at least 8 px
   * apart; redrawn only when the zoom or the pane size changes.
   */
  private drawGrid(): void {
    this.grid?.remove();
    this.grid = null;
    const svg = this.svg;
    if (!svg || !this.host.guideOn("grid") || !svg.getScreenCTM()) return;
    const vb = svg.viewBox.baseVal;
    const { w, h } = this.frameSize();
    const x = vb?.x ?? 0;
    const y = vb?.y ?? 0;
    const { minor, major } = gridSteps(this.pxPerUnit());
    const g = svg.ownerDocument.createElementNS(SVG_NS, "g") as SVGGElement;
    g.classList.add("zyxdraw-grid");
    for (const [d, cls] of [
      [gridPath(x, y, w, h, minor, major), "is-minor"],
      [gridPath(x, y, w, h, major), "is-major"],
    ]) {
      if (!d) continue;
      const p = svg.ownerDocument.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("vector-effect", "non-scaling-stroke");
      p.classList.add(cls);
      g.appendChild(p);
    }
    // Over the shapes (a filled background would hide it), under the selection.
    svg.insertBefore(g, this.overlay);
    this.grid = g;
  }

  // ---- polygon tool -----------------------------------------------------------------------

  /** Numbers for new points: as many decimals as the zoom makes meaningful. */
  private readonly fmt = (n: number) => formatCoordinate(n, this.pxPerUnit());

  /** The mouse in frame coordinates, on the grid when it is shown (`Alt`: free). */
  private draftPoint(e: { clientX: number; clientY: number; altKey: boolean }): { x: number; y: number } | null {
    const p = this.toSvg(e);
    if (!p) return null;
    if (!this.host.guideOn("grid") || e.altKey) return p;
    const step = gridSteps(this.pxPerUnit()).minor;
    return { x: snapDelta(0, p.x, step), y: snapDelta(0, p.y, step) };
  }

  /** Screen distance between two frame points. */
  private screenDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y) * this.pxPerUnit();
  }

  /** Whether the mouse is on the first point, so a click closes the polygon. */
  private closesDraft(p: { x: number; y: number } | null): boolean {
    const pts = this.draft?.points ?? [];
    return !!p && pts.length >= 3 && this.screenDistance(p, pts[0]) <= 8;
  }

  private onDraftDown(e: PointerEvent): void {
    const d = this.draft;
    const p = this.draftPoint(e);
    if (!d || !p) return;
    e.preventDefault();
    if (this.closesDraft(p)) {
      this.finishDraft();
      return;
    }
    // A second click on the same spot (double-click) adds nothing; the double-click finishes.
    const last = d.points[d.points.length - 1];
    if (last && this.screenDistance(p, last) < 4) return;
    d.points.push(p);
    d.mouse = p;
    this.renderDraft();
  }

  /** Adds the polygon to the text and goes back to the select tool. */
  private finishDraft(): void {
    const pts = this.draft?.points ?? [];
    if (pts.length < 3) {
      new Notice(`ZyxDraw: a polygon needs at least 3 points (${pts.length} placed)`);
      return;
    }
    this.setTool("select");
    this.run((t) => insertPolygon(t, pts, this.fmt));
  }

  private endDraft(): void {
    this.draft = null;
    this.lineDraft = null;
    if (this.pen?.press && this.stage.hasPointerCapture(this.pen.press.pointerId)) this.stage.releasePointerCapture(this.pen.press.pointerId);
    this.pen = null;
    this.svg?.querySelector(".zyxdraw-draft")?.remove();
  }

  /** A fresh overlay group for the shape being drawn, and a helper adding elements to it. */
  private draftLayer(): { g: SVGGElement; add: (tag: string, attrs: Record<string, string | number>, cls: string) => void; r: number } | null {
    if (!this.svg) return null;
    const doc = this.svg.ownerDocument;
    const g = doc.createElementNS(SVG_NS, "g") as SVGGElement;
    g.classList.add("zyxdraw-draft", "zyxdraw-overlay");
    const add = (tag: string, attrs: Record<string, string | number>, cls: string) => {
      const el = doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      el.setAttribute("vector-effect", "non-scaling-stroke");
      el.classList.add(...cls.split(" "));
      g.appendChild(el);
    };
    this.svg.appendChild(g);
    return { g, add, r: 4 / this.pxPerUnit() };
  }

  /** Draws what the active drawing tool has placed so far. */
  private renderDraft(): void {
    this.svg?.querySelector(".zyxdraw-draft")?.remove();
    if (this.tool === "line") this.renderLineDraft();
    else if (this.tool === "pen") this.renderPenDraft();
    else this.renderPolygonDraft();
  }

  /** Draws the points placed so far, a line to the mouse, and the first point (click to close). */
  private renderPolygonDraft(): void {
    const d = this.draft;
    if (!d || d.points.length === 0) return;
    const layer = this.draftLayer();
    if (!layer) return;
    const { add, r } = layer;
    const closing = this.closesDraft(d.mouse);
    const pts = [...d.points, ...(d.mouse && !closing ? [d.mouse] : [])];
    const text = pts.map((p) => `${p.x},${p.y}`).join(" ");
    add(closing ? "polygon" : "polyline", { points: text }, "zyxdraw-draft-shape");
    d.points.forEach((p, i) => add("circle", { cx: p.x, cy: p.y, r: i === 0 ? r * 1.5 : r }, i === 0 ? `zyxdraw-point is-first${closing ? " is-selected" : ""}` : "zyxdraw-point"));
  }

  // ---- line tool --------------------------------------------------------------------------

  /** The line's second end: the mouse, at a multiple of 45 degrees from the first with `Shift`. */
  private lineEnd(e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): { x: number; y: number } | null {
    const p = this.draftPoint(e);
    const s = this.lineDraft?.start;
    if (!p || !s || !e.shiftKey) return p;
    const len = Math.hypot(p.x - s.x, p.y - s.y);
    const angle = Math.round(Math.atan2(p.y - s.y, p.x - s.x) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: s.x + len * Math.cos(angle), y: s.y + len * Math.sin(angle) };
  }

  private onLineDown(e: PointerEvent): void {
    const d = this.lineDraft;
    if (!d) return;
    e.preventDefault();
    if (d.start) {
      // Second click: the other end.
      const p = this.lineEnd(e);
      if (p) this.finishLine(d.start, p);
      return;
    }
    const p = this.draftPoint(e);
    if (!p) return;
    d.start = p;
    d.mouse = p;
    d.pressed = true;
    this.stage.setPointerCapture(e.pointerId);
    this.renderDraft();
  }

  private onLineUp(e: PointerEvent): void {
    const d = this.lineDraft;
    if (!d || !d.pressed) return;
    d.pressed = false;
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
    // Dragged: the line ends where the button is released. A click waits for a second click.
    const p = this.lineEnd(e);
    if (d.start && p && this.screenDistance(d.start, p) > 4) this.finishLine(d.start, p);
  }

  private finishLine(a: { x: number; y: number }, b: { x: number; y: number }): void {
    if (this.screenDistance(a, b) < 2) return;
    this.setTool("select");
    this.run((t) => insertLine(t, a, b, this.fmt));
  }

  private renderLineDraft(): void {
    const d = this.lineDraft;
    if (!d?.start) return;
    const layer = this.draftLayer();
    if (!layer) return;
    const end = d.mouse ?? d.start;
    layer.add("line", { x1: d.start.x, y1: d.start.y, x2: end.x, y2: end.y }, "zyxdraw-draft-shape");
    layer.add("circle", { cx: d.start.x, cy: d.start.y, r: layer.r }, "zyxdraw-point");
  }

  // ---- pen tool ---------------------------------------------------------------------------

  /** Whether `p` is on the pen's first node, so a click closes the path. */
  private closesPen(p: { x: number; y: number } | null): boolean {
    const nodes = this.pen?.nodes ?? [];
    return !!p && nodes.length >= 2 && this.screenDistance(p, nodes[0]) <= 8;
  }

  private onPenDown(e: PointerEvent): void {
    const pen = this.pen;
    const p = this.draftPoint(e);
    if (!pen || !p) return;
    e.preventDefault();
    const press = { pointerId: e.pointerId, client: { x: e.clientX, y: e.clientY }, moved: false };
    if (this.closesPen(p)) {
      pen.press = { ...press, index: 0, closing: true };
    } else {
      // A second click on the same spot (double-click) adds nothing; the double-click finishes.
      const last = pen.nodes[pen.nodes.length - 1];
      if (last && this.screenDistance(p, last) < 4) return;
      pen.nodes.push({ x: p.x, y: p.y });
      pen.press = { ...press, index: pen.nodes.length - 1, closing: false };
    }
    pen.mouse = p;
    this.stage.setPointerCapture(e.pointerId);
    this.renderDraft();
  }

  /** While the button is down on a node, dragging pulls out its curve handles (a smooth point). */
  private onPenMove(e: PointerEvent): void {
    const pen = this.pen;
    if (!pen) return;
    const p = this.draftPoint(e);
    pen.mouse = p;
    const press = pen.press;
    if (press && p && e.pointerId === press.pointerId) {
      if (!press.moved && Math.hypot(e.clientX - press.client.x, e.clientY - press.client.y) >= DRAG_THRESHOLD) press.moved = true;
      if (press.moved) {
        const node = pen.nodes[press.index];
        node.out = { x: p.x, y: p.y };
        node.in = { x: 2 * node.x - p.x, y: 2 * node.y - p.y };
      }
    }
    this.renderDraft();
  }

  private onPenUp(e: PointerEvent): void {
    const pen = this.pen;
    const press = pen?.press;
    if (!pen || !press || e.pointerId !== press.pointerId) return;
    pen.press = null;
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
    if (press.closing) this.finishPen(true);
    else this.renderDraft();
  }

  /** Adds the path to the text and goes back to the select tool. */
  private finishPen(closed: boolean): void {
    const nodes = this.pen?.nodes ?? [];
    if (nodes.length < 2) {
      new Notice(`ZyxDraw: a path needs at least 2 points (${nodes.length} placed)`);
      return;
    }
    this.setTool("select");
    this.run((t) => insertPath(t, nodes, closed, this.fmt));
  }

  /** Draws the path so far, the next side to the mouse, the points and the curve handles. */
  private renderPenDraft(): void {
    const pen = this.pen;
    if (!pen || pen.nodes.length === 0) return;
    const layer = this.draftLayer();
    if (!layer) return;
    const { add, r } = layer;
    const closing = !pen.press && this.closesPen(pen.mouse);
    let d = penPathData(pen.nodes, closing || !!pen.press?.closing);
    const last = pen.nodes[pen.nodes.length - 1];
    const m = pen.mouse;
    if (!pen.press && !closing && m) d += last.out ? ` C ${last.out.x},${last.out.y} ${m.x},${m.y} ${m.x},${m.y}` : ` L ${m.x},${m.y}`;
    add("path", { d }, `zyxdraw-draft-shape${closing || pen.press?.closing ? "" : " is-open"}`);
    for (const n of pen.nodes) {
      for (const h of [n.in, n.out]) {
        if (!h) continue;
        add("line", { x1: n.x, y1: n.y, x2: h.x, y2: h.y }, "zyxdraw-guide");
        add("circle", { cx: h.x, cy: h.y, r: r * 0.75 }, "zyxdraw-point is-control");
      }
    }
    pen.nodes.forEach((p, i) =>
      add("rect", { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r }, i === 0 ? `zyxdraw-point is-first${closing ? " is-selected" : ""}` : "zyxdraw-point"),
    );
  }

  /** Remembers the mouse position and shows it on the next frame (null: the mouse left). */
  private trackMouse(e: { clientX: number; clientY: number } | null): void {
    if (!e || !this.host.guideOn("coordinates")) {
      this.mouse = null;
      if (this.mouseFrame) cancelAnimationFrame(this.mouseFrame);
      this.mouseFrame = 0;
      this.host.showCoordinates(null);
      return;
    }
    this.mouse = { clientX: e.clientX, clientY: e.clientY };
    if (!this.mouseFrame) {
      this.mouseFrame = requestAnimationFrame(() => {
        this.mouseFrame = 0;
        if (this.mouse) this.host.showCoordinates(this.coordinatesText(this.mouse));
      });
    }
  }

  /**
   * "x 120.5, y 48 (60%, 24%)", plus the position in the selected group's, custom shape's or
   * path's own numbers: "· in nyxx: 12, 40".
   */
  private coordinatesText(e: { clientX: number; clientY: number }): string | null {
    const p = this.toSvg(e);
    if (!p || !this.svg) return null;
    const scale = this.pxPerUnit();
    const f = (n: number) => formatCoordinate(n, scale);
    // Percent of the canvas; an infinite canvas has no size to measure from.
    const { x, y, w, h } = this.content;
    let text = `x ${f(p.x)}, y ${f(p.y)}`;
    if (!this.infinite) text += ` (${Math.round(((p.x - x) / w) * 100)}%, ${Math.round(((p.y - y) / h) * 100)}%)`;
    const q = this.local && this.layers ? this.toSvg(e, this.layers.inner) : null;
    if (this.local && q) text += ` · in ${this.local.name}: ${f(q.x - this.local.origin.x)}, ${f(q.y - this.local.origin.y)}`;
    return text;
  }

  // ---- tools: select and hand -------------------------------------------------------------

  setTool(tool: Tool): void {
    if (tool !== this.tool) this.endDraft();
    if (tool === "polygon" && !this.draft) this.draft = { points: [], mouse: null };
    if (tool === "line" && !this.lineDraft) this.lineDraft = { start: null, mouse: null, pressed: false };
    if (tool === "pen" && !this.pen) this.pen = { nodes: [], mouse: null, press: null };
    this.tool = tool;
    for (const [t, b] of this.toolButtons) {
      b.toggleClass("is-active", t === tool);
      b.setAttribute("aria-pressed", String(t === tool));
    }
    this.updateCursor();
  }

  private handActive(): boolean {
    return this.tool === "hand" || this.spaceHeld;
  }

  private setSpaceHeld(held: boolean): void {
    if (this.spaceHeld === held) return;
    this.spaceHeld = held;
    this.updateCursor();
  }

  private updateCursor(): void {
    this.stage.toggleClass("is-hand", this.handActive());
    this.stage.toggleClass("is-drawing", DRAWING_TOOLS.includes(this.tool) && !this.handActive());
    this.stage.toggleClass("is-panning", this.pan !== null);
  }

  private startPan(e: PointerEvent): void {
    this.pan = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, left: this.stage.scrollLeft, top: this.stage.scrollTop };
    this.stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.updateCursor();
  }

  private endPan(): void {
    if (!this.pan) return;
    if (this.stage.hasPointerCapture(this.pan.pointerId)) this.stage.releasePointerCapture(this.pan.pointerId);
    this.pan = null;
    this.updateCursor();
  }

  /**
   * Shows a freshly compiled drawing and restores the selection by path. An infinite canvas is
   * shown with room around its content, and the point at the middle of the pane stays there.
   */
  show(svgText: string, infinite = false): void {
    this.cancelDrag();
    // Infinite: remember what is in the middle of the pane, to keep it there.
    const r = this.stage.getBoundingClientRect();
    const keep = this.infinite && infinite && this.svg ? this.toSvg({ clientX: r.left + this.stage.clientWidth / 2, clientY: r.top + this.stage.clientHeight / 2 }) : null;
    if (this.infinite !== infinite) {
      this.view = null;
      this.zoom = null;
    }
    this.infinite = infinite;
    this.stage.empty();
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (doc.querySelector("parsererror")) {
      this.stage.createEl("pre", { text: "ZyxDraw: invalid SVG output" });
      this.svg = null;
      return;
    }
    this.svg = this.stage.doc.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    uniqueIds(this.svg);
    this.svg.classList.add("zyxdraw-svg");
    this.stage.appendChild(this.svg);
    this.overlay = null;
    const vb = this.svg.viewBox.baseVal;
    this.content = { x: vb?.x ?? 0, y: vb?.y ?? 0, w: vb?.width || 400, h: vb?.height || 300 };
    if (infinite) {
      this.view = this.roomAround(this.content, this.view);
      const v = this.view;
      this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
      this.svg.classList.add("is-infinite");
    } else this.view = null;
    if (infinite && (this.zoom === null || !keep)) {
      this.setZoom(null); // first time: fit the content
    } else {
      this.applyZoom();
      if (keep) this.centerOn(keep);
    }
    this.drawGrid();
    this.dropHiddenFromSelection();
    this.drawOverlay();
    this.renderDraft();
    this.updatePaint();
    if (this.revealPointOnShow && this.selected && this.selectedPoint !== null) this.host.pointSelected(this.selected, this.selectedPoint);
    this.revealPointOnShow = false;
  }

  /** A shape just hidden (`display=none`) cannot stay selected: it is not on the drawing. */
  private dropHiddenFromSelection(): void {
    const t = this.target();
    const paths = this.selectionPaths();
    if (!t || paths.length === 0) return;
    const shapes = allShapes(t.scene);
    const visible = paths.filter((p) => {
      const s = shapes.find((x) => x.path === p);
      return !s || !isHiddenInDrawing(s);
    });
    if (visible.length !== paths.length) this.setSelection(visible);
  }

  select(path: string | null): void {
    const changed = path !== this.selected;
    this.selected = path;
    this.multi = [];
    if (changed) this.selectedPoint = null;
    this.drawOverlay();
    this.updatePaint();
    if (changed) this.host.selectionChanged(path);
  }

  get selection(): string | null {
    return this.selected;
  }

  /** Every selected shape (one, several, or none). */
  private selectionPaths(): string[] {
    return this.multi.length > 1 ? this.multi : this.selected ? [this.selected] : [];
  }

  /** Selects several shapes; the last one is shown in the attributes panel. */
  private setSelection(paths: string[]): void {
    const unique = [...new Set(paths)];
    if (unique.length <= 1) {
      this.select(unique[0] ?? null);
      return;
    }
    const primary = unique[unique.length - 1];
    const changed = primary !== this.selected;
    this.multi = unique;
    this.selected = primary;
    this.selectedPoint = null;
    this.drawOverlay();
    this.updatePaint();
    if (changed) this.host.selectionChanged(primary);
  }

  /** Shift+click: adds a shape to the selection, or takes it out. */
  private toggleSelected(path: string): void {
    const current = this.selectionPaths();
    this.setSelection(current.includes(path) ? current.filter((p) => p !== path) : [...current, path]);
  }

  /** Whether the keyboard is in the drawing (not the text or the attributes panel). */
  hasFocus(): boolean {
    const active = this.stage.doc.activeElement;
    return !!active && this.stage.contains(active);
  }

  // ---- toolbar and zoom -------------------------------------------------------------------

  private buildToolbar(bar: HTMLElement): void {
    const button = (icon: string, label: string, onClick: () => void, parent: HTMLElement = bar) => {
      const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      // Older Obsidian versions may lack an icon (e.g. "pentagon").
      if (b.childElementCount === 0) setIcon(b, "triangle");
      b.addEventListener("click", onClick);
      return b;
    };
    const tools = bar.createDiv({ cls: "zyxdraw-tool-group", attr: { role: "group", "aria-label": "Tool" } });
    this.toolButtons.set("select", button("mouse-pointer-2", "Select and move (V)", () => this.setTool("select"), tools));
    this.toolButtons.set("hand", button("hand", "Hand: drag to scroll (H, or hold Space)", () => this.setTool("hand"), tools));
    bar.createDiv({ cls: "zyxdraw-toolbar-separator" });
    const toggle = (tool: Tool) => () => this.setTool(this.tool === tool ? "select" : tool);
    button("square", "Add rectangle", () => this.add("rect"));
    button("circle", "Add circle", () => this.add("circle"));
    this.toolButtons.set("line", button("slash", "Draw a line (L): drag, or click both ends. Shift: 45° steps", toggle("line")));
    this.toolButtons.set(
      "polygon",
      button("pentagon", "Draw a polygon (P): click to place points, click the first point or press Enter to finish", toggle("polygon")),
    );
    this.toolButtons.set(
      "pen",
      button(
        "pen-tool",
        "Draw a path (B): click for a corner, drag for a curve. Click the first point to close, or press Enter / double-click to leave it open",
        toggle("pen"),
      ),
    );
    button("type", "Add text", () => this.add("text"));
    bar.createDiv({ cls: "zyxdraw-toolbar-separator" });
    for (const which of ["fill", "stroke"] as const) {
      const b = bar.createEl("button", { cls: `clickable-icon zyxdraw-paint is-${which}`, attr: { "aria-label": which === "fill" ? "Fill color of the selected shapes" : "Stroke (outline) color of the selected shapes" } });
      b.createSpan({ cls: "zyxdraw-paint-swatch" });
      b.addEventListener("click", (e) => this.paintMenu(which, e));
      this.paintButtons.set(which, b);
    }
    // One hidden color picker, opened from the fill / stroke menus.
    this.colorInput = bar.createEl("input", { type: "color", cls: "zyxdraw-paint-input", attr: { tabindex: "-1", "aria-hidden": "true" } });
    bar.createDiv({ cls: "zyxdraw-toolbar-gap" });
    this.guideButtons.set("grid", button("grid-3x3", "Show grid", () => this.host.toggleGuide("grid")));
    this.guideButtons.set("coordinates", button("crosshair", "Show mouse coordinates in the status bar", () => this.host.toggleGuide("coordinates")));
    bar.createDiv({ cls: "zyxdraw-toolbar-separator" });
    button("zoom-out", "Zoom out", () => this.setZoom((this.zoom ?? this.fitZoom()) / 1.25));
    button("zoom-in", "Zoom in", () => this.setZoom((this.zoom ?? this.fitZoom()) * 1.25));
    button("maximize", "Fit to pane", () => this.setZoom(null));
  }

  // ---- fill and stroke --------------------------------------------------------------------

  /** Shows the selected shape's fill and stroke on the toolbar buttons (disabled without a selection). */
  private updatePaint(): void {
    const t = this.target();
    const shape = t && this.selected ? allShapes(t.scene).find((s) => s.path === this.selected) : undefined;
    for (const [which, b] of this.paintButtons) {
      b.toggleClass("is-disabled", !shape);
      b.setAttribute("aria-disabled", String(!shape));
      const swatch = b.querySelector<HTMLElement>(".zyxdraw-paint-swatch");
      if (!swatch) continue;
      const css = t && shape ? cssPaint(paintOf(shape, which), t.scene.gradients ?? []) : null;
      swatch.toggleClass("is-none", css === null);
      swatch.style.background = css ?? "";
    }
  }

  private paintMenu(which: "fill" | "stroke", e: MouseEvent): void {
    if (this.selectionPaths().length === 0) {
      new Notice("ZyxDraw: select a shape first");
      return;
    }
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Pick a color…").setIcon("palette").onClick(() => this.pickColor(which)));
    menu.addItem((i) => i.setTitle("None").setIcon("circle-slash").onClick(() => this.applyPaint(which, "none")));
    const cur = this.host.current();
    const gradients = cur?.result.tree.statements.filter((s) => s.kind === "gradientDef" && s.name).map((s) => s.name!) ?? [];
    if (gradients.length > 0) {
      menu.addSeparator();
      for (const g of gradients) menu.addItem((i) => i.setTitle(`Gradient \`${g}\``).setIcon("blend").onClick(() => this.applyPaint(which, g)));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Default (remove from the text)").setIcon("eraser").onClick(() => this.applyPaint(which, "")));
    menu.showAtMouseEvent(e);
  }

  /** Which paint the hidden color picker is open for. */
  private picking: "fill" | "stroke" | null = null;

  private pickColor(which: "fill" | "stroke"): void {
    const input = this.colorInput;
    const t = this.target();
    const shape = t && this.selected ? allShapes(t.scene).find((s) => s.path === this.selected) : undefined;
    if (!input) return;
    input.value = (shape && colorToHex(this.stage.doc, paintOf(shape, which))) ?? "#000000";
    if (!input.dataset.ready) {
      input.dataset.ready = "1";
      input.addEventListener("change", () => {
        if (this.picking) this.applyPaint(this.picking, input.value);
      });
    }
    this.picking = which;
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  }

  /** Sets fill or stroke on every selected shape ("" removes it). */
  private applyPaint(which: "fill" | "stroke", value: string): void {
    const cur = this.host.current();
    if (!cur) return;
    if (hasSyntaxErrors(cur.result)) {
      new Notice("ZyxDraw: fix the syntax errors in the text first");
      return;
    }
    const target = { source: cur.source, scene: cur.result.scene, tree: cur.result.tree, diagnostics: cur.result.diagnostics };
    const edit: EditResult = { edits: [], notices: [] };
    for (const path of this.selectionPaths()) {
      const r = setProperty(target, path, which, value);
      edit.edits.push(...r.edits);
      edit.notices.push(...r.notices);
    }
    edit.edits = normalizeEdits(cur.source, edit.edits);
    this.host.apply(edit, cur.source);
  }

  private frameSize(): { w: number; h: number } {
    const vb = this.svg?.viewBox.baseVal;
    return { w: vb?.width || 400, h: vb?.height || 300 };
  }

  private fitZoom(): number {
    if (this.infinite) {
      // Fit the content (not the room around it) into the pane, at most twice its size.
      const c = this.content;
      const z = Math.min((this.stage.clientWidth - 32) / c.w, (this.stage.clientHeight - 32) / c.h);
      return Math.min(2, Math.max(0.05, z));
    }
    return Math.max(0.05, (this.stage.clientWidth - 16) / this.frameSize().w);
  }

  /**
   * Infinite canvas: the area to show, the content with room on every side (at least 800 units,
   * or the content's size), including everything shown before so nothing jumps.
   */
  private roomAround(c: Rect, old: Rect | null): Rect {
    const m = Math.max(c.w, c.h, 800);
    const v = { x: c.x - m, y: c.y - m, w: c.w + 2 * m, h: c.h + 2 * m };
    if (!old) return v;
    const x = Math.min(v.x, old.x);
    const y = Math.min(v.y, old.y);
    return { x, y, w: Math.max(v.x + v.w, old.x + old.w) - x, h: Math.max(v.y + v.h, old.y + old.h) - y };
  }

  /** Scrolls so frame point `p` is in the middle of the pane. */
  private centerOn(p: { x: number; y: number }): void {
    const m = this.svg?.getScreenCTM();
    if (!m) return;
    const r = this.stage.getBoundingClientRect();
    this.stage.scrollLeft += m.a * p.x + m.c * p.y + m.e - (r.left + this.stage.clientWidth / 2);
    this.stage.scrollTop += m.b * p.x + m.d * p.y + m.f - (r.top + this.stage.clientHeight / 2);
  }

  /**
   * Changes the zoom, keeping the point under `anchor` (client coordinates) in place.
   * Without an anchor, the center of the visible area stays in place.
   */
  private setZoom(z: number | null, anchor?: { clientX: number; clientY: number }): void {
    const s = this.stage;
    if (this.infinite && z === null) {
      // Fit: the content, centered. Wait for the pane to have a size.
      this.needsFit = s.clientWidth === 0;
      this.zoom = this.needsFit ? (this.zoom ?? 1) : this.fitZoom();
      this.applyZoom();
      const c = this.content;
      if (!this.needsFit) this.centerOn({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
      this.drawGrid();
      this.drawOverlay();
      this.renderDraft();
      return;
    }
    const rect = s.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - rect.left : s.clientWidth / 2;
    const ay = anchor ? anchor.clientY - rect.top : s.clientHeight / 2;
    const fx = s.scrollWidth > 0 ? (s.scrollLeft + ax) / s.scrollWidth : 0;
    const fy = s.scrollHeight > 0 ? (s.scrollTop + ay) / s.scrollHeight : 0;

    this.zoom = z === null ? null : Math.min(20, Math.max(0.05, z));
    this.applyZoom();
    s.scrollLeft = fx * s.scrollWidth - ax;
    s.scrollTop = fy * s.scrollHeight - ay;
    this.drawGrid();
    this.drawOverlay();
    this.renderDraft();
  }

  private applyZoom(): void {
    if (!this.svg) return;
    if (this.zoom === null) {
      this.svg.style.width = "100%";
      this.svg.style.maxWidth = "100%";
    } else {
      this.svg.style.width = `${this.frameSize().w * this.zoom}px`;
      this.svg.style.maxWidth = "none";
    }
    this.svg.style.height = "auto";
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.setZoom((this.zoom ?? this.fitZoom()) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e);
  }

  // ---- selection --------------------------------------------------------------------------

  private target(): (EditTarget & { result: CompileResult }) | null {
    const cur = this.host.current();
    return cur ? { source: cur.source, scene: cur.result.scene, result: cur.result } : null;
  }

  /** Editing needs exact source ranges, so it is off while the text has syntax errors. */
  private editable(t: { result: CompileResult }): boolean {
    if (hasSyntaxErrors(t.result)) {
      new Notice("ZyxDraw: fix the syntax errors in the text first");
      return false;
    }
    return true;
  }

  /** The innermost editable shape under a pointer event. */
  private shapeAt(e: MouseEvent): Shape | null {
    const t = this.target();
    const el = (e.target as Element | null)?.closest?.("[data-zyx-path]");
    const path = el?.getAttribute("data-zyx-path");
    if (!t || !path) return null;
    return editableShape(t.scene, path) ?? null;
  }

  /**
   * Click selects the outermost group first. Clicking again inside the selected group selects
   * the next level down (double-click goes straight to the innermost shape).
   */
  private pick(innermost: Shape): Shape {
    const chain: Shape[] = [];
    for (let s: Shape | null = innermost; s; s = s.parent) if (!s.generated) chain.push(s);
    const at = chain.findIndex((s) => s.path === this.selected);
    if (at > 0) return chain[at - 1];
    if (at === 0) return chain[0];
    return chain[chain.length - 1];
  }

  private drawOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.layers = null;
    this.local = null;
    const t = this.target();
    if (!this.svg || !t || !this.selected) return;
    const doc = this.svg.ownerDocument;
    const group = (parent: Element, transform: string) => {
      const el = doc.createElementNS(SVG_NS, "g") as SVGGElement;
      if (transform) el.setAttribute("transform", transform);
      parent.appendChild(el);
      return el;
    };

    if (this.multi.length > 1) {
      // Several shapes: an outline around each, no handles.
      const overlay = group(this.svg, "");
      overlay.classList.add("zyxdraw-overlay");
      this.overlay = overlay;
      for (const path of this.multi) {
        const s = allShapes(t.scene).find((x) => x.path === path);
        const g = s && geometry(t.scene, s);
        if (!s || !g) continue;
        const tr = overlayTransforms(t.scene, s);
        const inner = group(group(overlay, tr.parent), tr.own);
        const r = doc.createElementNS(SVG_NS, "rect");
        for (const [k, v] of Object.entries({ x: g.box.x, y: g.box.y, width: Math.max(0, g.box.w), height: Math.max(0, g.box.h) })) r.setAttribute(k, String(v));
        r.setAttribute("vector-effect", "non-scaling-stroke");
        r.classList.add("zyxdraw-selection");
        inner.appendChild(r);
      }
      return;
    }

    const shape = allShapes(t.scene).find((s) => s.path === this.selected);
    const g = shape && geometry(t.scene, shape);
    if (!shape || !g) return;
    const origin = localOrigin(t.scene, shape);
    if (origin) this.local = { name: shape.name ?? shape.path, origin };

    const overlay = group(this.svg, "");
    overlay.classList.add("zyxdraw-overlay");
    this.overlay = overlay;
    const tr = overlayTransforms(t.scene, shape);
    const outer = group(overlay, tr.parent);
    const mid = group(outer, "");
    this.layers = { outer, mid, inner: group(mid, tr.own) };
    this.drawSelectionBox(g.box, shape);
  }

  private drawSelectionBox(box: Box, shape: Shape): void {
    const layer = this.layers?.inner;
    if (!layer || !this.svg) return;
    layer.empty();
    const doc = layer.ownerDocument;
    const el = (tag: string, attrs: Record<string, number | string>, cls: string) => {
      const e = doc.createElementNS(SVG_NS, tag) as SVGElement;
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      e.setAttribute("vector-effect", "non-scaling-stroke");
      e.classList.add(...cls.split(" "));
      layer.appendChild(e);
      return e;
    };
    const rect = (x: number, y: number, w: number, h: number, cls: string) =>
      el("rect", { x, y, width: Math.max(0, w), height: Math.max(0, h) }, cls);
    rect(box.x, box.y, box.w, box.h, "zyxdraw-selection");

    // Handles keep their size on screen, whatever the zoom and the shape's own scale.
    const m = layer.getScreenCTM();
    const scale = (m && Math.hypot(m.a, m.b)) || 1;
    const size = 8 / scale;

    const t = this.target();
    const points = t && hasPoints(shape) ? pointHandles(t.scene, shape) : null;
    if (points) {
      for (const p of points) for (const q of p.guides) el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y }, "zyxdraw-guide");
      // Polygon / polyline / path: a dot in the middle of each side adds a point (click or drag).
      ((t && sideHandles(t.scene, shape)) ?? []).forEach((p, i) => {
        const m = el("circle", { cx: p.x, cy: p.y, r: size / 2.5 }, "zyxdraw-midpoint");
        m.dataset.side = String(i);
      });
      points.forEach((p, i) => {
        const h =
          p.kind === "control"
            ? el("circle", { cx: p.x, cy: p.y, r: size / 2 }, "zyxdraw-point is-control")
            : rect(p.x - size / 2, p.y - size / 2, size, size, "zyxdraw-point");
        h.dataset.point = String(i);
        if (i === this.selectedPoint) h.classList.add("is-selected");
      });
      return;
    }

    const resizable = shape.type === "rect" || shape.type === "circle" || shape.type === "ellipse" || (shape.type === "group" && shape.attrs.has("width"));
    if (!resizable) return;
    for (const h of HANDLES) {
      const hx = h.includes("w") ? box.x : h.includes("e") ? box.x + box.w : box.x + box.w / 2;
      const hy = h.includes("n") ? box.y : h.includes("s") ? box.y + box.h : box.y + box.h / 2;
      const r = rect(hx - size / 2, hy - size / 2, size, size, `zyxdraw-handle is-${h}`);
      r.dataset.handle = h;
    }
  }

  /** The middle of side `side` of a polygon / polyline / path (frame coordinates). */
  private sideMiddle(path: string, side: number): { x: number; y: number } | null {
    const t = this.target();
    const shape = t && allShapes(t.scene).find((s) => s.path === path);
    return (t && shape && sideHandles(t.scene, shape)?.[side]) || null;
  }

  /** Marks point `index` of the selected shape and shows its numbers in the text. */
  private selectPoint(index: number): void {
    if (!this.selected) return;
    this.selectedPoint = index;
    this.layers?.inner.querySelectorAll("[data-point]").forEach((h) => h.classList.toggle("is-selected", h.getAttribute("data-point") === String(index)));
    this.host.pointSelected(this.selected, index);
  }

  /**
   * Where a drag measures its movement: moving happens in the parent's (turned) space,
   * resizing and point dragging in the shape's own.
   */
  private dragLayer(kind: DragState["kind"]): SVGGElement | null {
    // Several shapes and the selection box: the drawing's own coordinates.
    if (!this.layers || kind === "many" || kind === "marquee") return null;
    return kind === "move" ? this.layers.outer : this.layers.inner;
  }

  // ---- pointer ----------------------------------------------------------------------------

  /** Client coordinates in drawing units: of `layer` when given, else of the whole drawing. */
  private toSvg(e: { clientX: number; clientY: number }, layer?: SVGGraphicsElement | null): { x: number; y: number } | null {
    const m = (layer ?? this.svg)?.getScreenCTM();
    if (!this.svg || !m) return null;
    const p = this.svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const r = p.matrixTransform(m.inverse());
    return { x: r.x, y: r.y };
  }

  private elementFor(path: string): SVGGraphicsElement | null {
    if (!this.svg) return null;
    for (const el of Array.from(this.svg.querySelectorAll("[data-zyx-path]"))) {
      if (el.getAttribute("data-zyx-path") === path) return el as SVGGraphicsElement;
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    // Hand tool, Space held, or middle button: drag to scroll.
    if (e.button === 1 || (e.button === 0 && this.handActive())) {
      this.stage.focus();
      this.startPan(e);
      return;
    }
    if (e.button !== 0) return;
    this.stage.focus();
    if (this.tool === "polygon") {
      this.onDraftDown(e);
      return;
    }
    if (this.tool === "line") {
      this.onLineDown(e);
      return;
    }
    if (this.tool === "pen") {
      this.onPenDown(e);
      return;
    }
    const t = this.target();
    if (!t) return;
    const selectedShape = this.selected ? allShapes(t.scene).find((s) => s.path === this.selected) : undefined;
    const selectedBox = selectedShape && geometry(t.scene, selectedShape)?.box;

    const on = (attr: string) => (e.target as Element | null)?.closest?.(`[${attr}]`)?.getAttribute(attr) ?? undefined;
    const point = on("data-point");
    if (point !== undefined && this.selected && selectedBox) {
      this.selectPoint(Number(point));
      const el = this.elementFor(this.selected);
      const originalGeometry = GEOMETRY_ATTRS.map((attr) => ({ attr, value: el?.getAttribute(attr) ?? null }));
      this.beginDrag(e, { kind: "point", path: this.selected, point: Number(point), box: selectedBox, el, originalGeometry });
      return;
    }
    const side = on("data-side");
    if (side !== undefined && this.selected && selectedBox) {
      const el = this.elementFor(this.selected);
      const originalGeometry = GEOMETRY_ATTRS.map((attr) => ({ attr, value: el?.getAttribute(attr) ?? null }));
      this.beginDrag(e, { kind: "insert", path: this.selected, side: Number(side), box: selectedBox, el, originalGeometry });
      return;
    }
    const handle = on("data-handle") as Handle | undefined;
    if (handle && this.selected && selectedBox) {
      this.beginDrag(e, { kind: "resize", path: this.selected, handle, box: selectedBox, el: null });
      return;
    }

    const hit = this.shapeAt(e);
    if (!hit) {
      // Empty space: drag a box to select the shapes inside it (a click clears the selection).
      const p = this.toSvg(e);
      if (p) this.beginDrag(e, { kind: "marquee", path: "", box: { x: p.x, y: p.y, w: 0, h: 0 }, el: null, additive: e.shiftKey });
      return;
    }
    const shape = this.pick(hit);
    if (e.shiftKey) {
      this.toggleSelected(shape.path);
      return;
    }
    const many = this.selectionPaths();
    if (many.length > 1 && many.includes(shape.path)) {
      // Drag all selected shapes.
      const box = geometry(t.scene, shape)?.box;
      if (!box) return;
      const els = many.map((p) => this.elementFor(p)).filter((el): el is SVGGraphicsElement => !!el);
      this.beginDrag(e, { kind: "many", path: shape.path, box, el: null, paths: many, els: els.map((el) => ({ el, transform: el.getAttribute("transform") })) });
      return;
    }
    if (shape.path !== this.selected) this.select(shape.path);
    const g = geometry(t.scene, shape);
    if (!g) return;
    this.beginDrag(e, { kind: "move", path: shape.path, box: g.box, el: this.elementFor(shape.path) });
  }

  private beginDrag(
    e: PointerEvent,
    d: Pick<DragState, "kind" | "path" | "handle" | "point" | "side" | "box" | "el" | "originalGeometry" | "paths" | "els" | "additive">,
  ): void {
    const start = this.toSvg(e, this.dragLayer(d.kind));
    if (!start) return;
    const b = d.box;
    let anchor: DragState["anchor"] = { x: b.x, y: b.y };
    if (d.kind === "resize") {
      const h = d.handle ?? "";
      anchor = {
        x: h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : null,
        y: h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : null,
      };
    } else if (d.kind === "point") {
      const t = this.target();
      const shape = t && allShapes(t.scene).find((s) => s.path === d.path);
      const p = t && shape ? pointHandles(t.scene, shape)?.[d.point!] : undefined;
      anchor = p ? { x: p.x, y: p.y } : { x: null, y: null };
    } else if (d.kind === "insert") {
      const m = this.sideMiddle(d.path, d.side!);
      anchor = m ? { x: m.x, y: m.y } : { x: null, y: null };
    } else if (d.kind === "marquee") {
      anchor = { x: null, y: null };
    }
    this.drag = {
      ...d,
      start,
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      originalTransform: d.el?.getAttribute("transform") ?? null,
      moved: false,
      anchor,
      step: gridSteps(this.pxPerUnit()).minor,
    };
    this.stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  /**
   * How far the drag has moved, in the drag's coordinates. While the grid is shown the dragged
   * corner, edge or point lands on a grid line; `Alt` held drags freely.
   */
  private dragDelta(e: PointerEvent, d: DragState): { dx: number; dy: number } | null {
    const p = this.toSvg(e, this.dragLayer(d.kind));
    if (!p) return null;
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (!this.host.guideOn("grid") || e.altKey) return { dx, dy };
    return { dx: snapDelta(d.anchor.x, dx, d.step), dy: snapDelta(d.anchor.y, dy, d.step) };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pan && e.pointerId === this.pan.pointerId) {
      this.stage.scrollLeft = this.pan.left - (e.clientX - this.pan.x);
      this.stage.scrollTop = this.pan.top - (e.clientY - this.pan.y);
      return;
    }
    if (this.tool === "polygon" && this.draft) {
      this.draft.mouse = this.draftPoint(e);
      this.renderDraft();
      return;
    }
    if (this.tool === "line" && this.lineDraft) {
      if (this.lineDraft.start) {
        this.lineDraft.mouse = this.lineEnd(e);
        this.renderDraft();
      }
      return;
    }
    if (this.tool === "pen") {
      this.onPenMove(e);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < DRAG_THRESHOLD) return;
    d.moved = true;
    const delta = this.dragDelta(e, d);
    if (!delta) return;
    const { dx, dy } = delta;
    if (d.kind === "many") {
      for (const { el, transform } of d.els ?? []) el.setAttribute("transform", `translate(${dx},${dy})${transform ? " " + transform : ""}`);
      this.overlay?.setAttribute("transform", `translate(${dx},${dy})`);
      return;
    }
    if (d.kind === "marquee") {
      if (!d.rect && this.svg) {
        d.rect = this.svg.ownerDocument.createElementNS(SVG_NS, "rect") as SVGRectElement;
        d.rect.setAttribute("vector-effect", "non-scaling-stroke");
        d.rect.classList.add("zyxdraw-marquee");
        this.svg.appendChild(d.rect);
      }
      const r = marqueeBox(d.start, dx, dy);
      for (const [k, v] of Object.entries({ x: r.x, y: r.y, width: r.w, height: r.h })) d.rect?.setAttribute(k, String(v));
      return;
    }
    const t = this.target();
    const shape = t && allShapes(t.scene).find((s) => s.path === d.path);
    if (!t || !shape) return;

    // Previews only: the real change happens through the text on release.
    if (d.kind === "move") {
      d.el?.setAttribute("transform", `translate(${dx},${dy})${d.originalTransform ? " " + d.originalTransform : ""}`);
      this.layers?.mid.setAttribute("transform", `translate(${dx},${dy})`);
    } else if (d.kind === "resize") {
      this.drawSelectionBox(resizedBox(d.box, d.handle!, dx, dy), shape);
    } else if (d.kind === "insert") {
      const text = insertedPointsText(shape, d.side!, dx, dy, this.fmt);
      const geo = text !== null ? previewGeometry(t.scene, shape, text) : null;
      if (geo && d.el) d.el.setAttribute(geo.attr, geo.value);
      const m = this.layers?.inner.querySelector(`[data-side="${d.side}"]`);
      if (m && d.anchor.x !== null && d.anchor.y !== null) {
        m.setAttribute("cx", String(d.anchor.x + dx));
        m.setAttribute("cy", String(d.anchor.y + dy));
        m.classList.add("is-dragging");
      }
    } else {
      if (shape.type === "line") {
        // The dragged end of a line: its own attributes, from where it was drawn.
        const n = d.point === 0 ? "1" : "2";
        for (const [axis, delta] of [["x", dx], ["y", dy]] as const) {
          const was = d.originalGeometry?.find((g) => g.attr === `${axis}${n}`)?.value;
          if (was != null && d.el) d.el.setAttribute(`${axis}${n}`, String(Number(was) + delta));
        }
      }
      const text = movedPointsText(shape, d.point!, dx, dy, { free: e.altKey });
      const geo = text !== null ? previewGeometry(t.scene, shape, text) : null;
      if (geo && d.el) d.el.setAttribute(geo.attr, geo.value);
      const h = this.layers?.inner.querySelector(`[data-point="${d.point}"]`);
      const orig = t && pointHandles(t.scene, shape)?.[d.point!];
      if (h && orig) {
        if (h.tagName === "circle") {
          h.setAttribute("cx", String(orig.x + dx));
          h.setAttribute("cy", String(orig.y + dy));
        } else {
          const w = Number(h.getAttribute("width"));
          h.setAttribute("x", String(orig.x + dx - w / 2));
          h.setAttribute("y", String(orig.y + dy - w / 2));
        }
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.pan && e.pointerId === this.pan.pointerId) {
      this.endPan();
      return;
    }
    if (this.tool === "line") {
      this.onLineUp(e);
      return;
    }
    if (this.tool === "pen") {
      this.onPenUp(e);
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
    if (d.kind === "marquee") {
      d.rect?.remove();
      this.finishMarquee(d, d.moved ? this.dragDelta(e, d) : null);
      return;
    }
    // A click on a side's middle dot adds a point there; other clicks change nothing.
    if (!d.moved && d.kind !== "insert") return;
    const delta = d.moved ? this.dragDelta(e, d) : { dx: 0, dy: 0 };
    const t = this.target();
    if (!delta || !t) return;
    if (!this.editable(t)) {
      this.restore(d);
      return;
    }
    const { dx, dy } = delta;
    const opts = { defaultUnit: this.host.defaultUnit() };
    const edit =
      d.kind === "many"
        ? moveShapes(t, d.paths ?? [], dx, dy, opts)
        : d.kind === "move"
        ? moveShapes(t, [d.path], dx, dy, opts)
        : d.kind === "resize"
          ? resizeShape(t, d.path, resizedBox(d.box, d.handle!, dx, dy), opts)
          : d.kind === "insert"
            ? insertPoint(t, d.path, d.side!, dx, dy, this.fmt)
            : movePoint(t, d.path, d.point!, dx, dy, { free: e.altKey });
    if (edit.edits.length === 0) this.restore(d);
    else if (d.kind === "point" || d.kind === "insert") {
      // The new point is selected, and its numbers shown in the text.
      if (d.kind === "insert") this.selectedPoint = edit.point ?? d.side! + 1;
      this.revealPointOnShow = true;
    }
    this.host.apply(edit, t.source);
  }

  /** Selects the top-level shapes entirely inside the box (added to the selection with Shift). */
  private finishMarquee(d: DragState, delta: { dx: number; dy: number } | null): void {
    if (!delta) {
      if (!d.additive) this.select(null);
      return;
    }
    const t = this.target();
    if (!t) return;
    const r = marqueeBox(d.start, delta.dx, delta.dy);
    const inside = t.scene.roots
      .filter((s) => !isHiddenInDrawing(s))
      .map((s) => ({ s, b: geometry(t.scene, s)?.box }))
      .filter(({ b }) => b && b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h)
      .map(({ s }) => s.path);
    this.setSelection(d.additive ? [...this.selectionPaths(), ...inside] : inside);
  }

  private restore(d: DragState): void {
    d.rect?.remove();
    for (const { el, transform } of d.els ?? []) {
      if (transform === null) el.removeAttribute("transform");
      else el.setAttribute("transform", transform);
    }
    if (d.originalTransform === null) d.el?.removeAttribute("transform");
    else d.el?.setAttribute("transform", d.originalTransform);
    for (const g of d.originalGeometry ?? []) {
      if (g.value === null) d.el?.removeAttribute(g.attr);
      else d.el?.setAttribute(g.attr, g.value);
    }
    this.drawOverlay();
  }

  private cancelDrag(): void {
    if (this.drag) this.restore(this.drag);
    this.drag = null;
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.tool === "polygon") {
      this.finishDraft();
      return;
    }
    if (this.tool === "pen") {
      this.finishPen(false);
      return;
    }
    if (this.tool === "line") return;
    const hit = this.shapeAt(e);
    if (hit) this.select(hit.path);
  }

  // ---- menu and keyboard ------------------------------------------------------------------

  private onContextMenu(e: MouseEvent): void {
    if (DRAWING_TOOLS.includes(this.tool)) {
      e.preventDefault();
      return;
    }
    // Right-click on a point of the selected polygon / polyline.
    const point = (e.target as Element | null)?.closest?.("[data-point]")?.getAttribute("data-point");
    const t = this.target();
    const selectedShape = t && this.selected ? allShapes(t.scene).find((s) => s.path === this.selected) : undefined;
    if (point && selectedShape && canAddPoints(selectedShape)) {
      e.preventDefault();
      this.selectPoint(Number(point));
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Delete point").setIcon("trash").onClick(() => this.deleteSelectedPoint()));
      menu.showAtMouseEvent(e);
      return;
    }
    const hit = this.shapeAt(e);
    const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
    const menu = new Menu();
    if (!hit) {
      e.preventDefault();
      menu.addItem((i) => i.setTitle(`Paste (${mod}+V)`).setIcon("clipboard-paste").onClick(() => void this.paste()));
      menu.showAtMouseEvent(e);
      return;
    }
    e.preventDefault();
    const shape = this.pick(hit);
    // Right-click on one of several selected shapes keeps them all selected.
    if (!(this.multi.length > 1 && this.multi.includes(shape.path))) this.select(shape.path);
    const path = shape.path;
    const many = this.selectionPaths().length > 1;
    if (!many) {
      const order = (title: string, icon: string, where: Reorder) =>
        menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => this.run((t) => reorderShape(t, path, where))));
      order("Bring to front", "chevrons-up", "front");
      order("Bring forward", "chevron-up", "forward");
      order("Send backward", "chevron-down", "backward");
      order("Send to back", "chevrons-down", "back");
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle(`Copy (${mod}+C)`).setIcon("copy").onClick(() => void this.copy(false)));
    menu.addItem((i) => i.setTitle(`Cut (${mod}+X)`).setIcon("scissors").onClick(() => void this.copy(true)));
    menu.addItem((i) => i.setTitle(`Paste (${mod}+V)`).setIcon("clipboard-paste").onClick(() => void this.paste()));
    menu.addItem((i) => i.setTitle(`Duplicate (${mod}+D)`).setIcon("copy-plus").onClick(() => this.duplicate()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(`Group (${mod}+G)`).setIcon("group").onClick(() => this.group()));
    if (!many && shape.type === "group" && !shape.instanceOf) {
      menu.addItem((i) => i.setTitle(`Ungroup (${mod}+Shift+G)`).setIcon("ungroup").onClick(() => this.ungroup()));
    }
    menu.addSeparator();
    if (!many) menu.addItem((i) => i.setTitle("Show in text").setIcon("file-code").onClick(() => this.host.revealInSource(path)));
    menu.addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => this.deleteSelected()));
    menu.showAtMouseEvent(e);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.host.redo();
      else this.host.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.host.redo();
      return;
    }
    if (mod && !e.altKey && !e.defaultPrevented && this.shortcut(e.key.toLowerCase(), e.shiftKey)) {
      e.preventDefault();
      return;
    }
    if (e.key === " ") {
      e.preventDefault(); // no page scroll
      this.setSpaceHeld(true);
      return;
    }
    if (!mod && !e.altKey && (e.key === "v" || e.key === "V")) {
      this.setTool("select");
      return;
    }
    if (!mod && !e.altKey && (e.key === "h" || e.key === "H")) {
      this.setTool("hand");
      return;
    }
    if (!mod && !e.altKey && (e.key === "p" || e.key === "P")) {
      this.setTool("polygon");
      return;
    }
    if (!mod && !e.altKey && (e.key === "l" || e.key === "L")) {
      this.setTool("line");
      return;
    }
    if (!mod && !e.altKey && (e.key === "b" || e.key === "B")) {
      this.setTool("pen");
      return;
    }
    if (this.tool === "line" && this.lineDraft) {
      if (e.key !== "Escape") return;
      // First Escape drops the first end, the second leaves the tool.
      if (this.lineDraft.start) this.lineDraft = { start: null, mouse: null, pressed: false };
      else this.setTool("select");
      this.renderDraft();
      e.preventDefault();
      return;
    }
    if (this.tool === "pen" && this.pen) {
      const pen = this.pen;
      if (e.key === "Enter") this.finishPen(false);
      else if (e.key === "Escape") {
        // First Escape drops the points placed, the second leaves the tool.
        if (pen.nodes.length > 0) {
          pen.nodes = [];
          pen.press = null;
        } else this.setTool("select");
        this.renderDraft();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        pen.nodes.pop();
        pen.press = null;
        this.renderDraft();
      } else return;
      e.preventDefault();
      return;
    }
    if (this.tool === "polygon" && this.draft) {
      if (e.key === "Enter") this.finishDraft();
      else if (e.key === "Escape") {
        // First Escape drops the points placed, the second leaves the tool.
        if (this.draft.points.length > 0) this.draft.points = [];
        else this.setTool("select");
        this.renderDraft();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        this.draft.points.pop();
        this.renderDraft();
      } else return;
      e.preventDefault();
      return;
    }
    if (!this.selected) return;
    if (e.key === "Escape") {
      if (this.selectedPoint !== null) {
        this.selectedPoint = null;
        this.drawOverlay();
      } else this.select(null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (this.selectedPoint !== null) this.deleteSelectedPoint();
      else this.deleteSelected();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const paths = this.selectionPaths();
      this.run((t) => moveShapes(t, paths, dx, dy, { defaultUnit: this.host.defaultUnit() }));
    }
  }

  /**
   * `Ctrl` / `Cmd` + key in the drawing: C copy, X cut, V paste, D duplicate, G group,
   * Shift+G ungroup, A select all. Returns whether the key was one of these.
   */
  shortcut(key: string, shift: boolean): boolean {
    if (!["c", "x", "v", "d", "g", "a"].includes(key)) return false;
    if (DRAWING_TOOLS.includes(this.tool)) this.setTool("select");
    if (key === "c") void this.copy(false);
    else if (key === "x") void this.copy(true);
    else if (key === "v") void this.paste();
    else if (key === "d") this.duplicate();
    else if (key === "g") {
      if (shift) this.ungroup();
      else this.group();
    } else {
      const t = this.target();
      if (t) this.setSelection(t.scene.roots.filter((s) => !isHiddenInDrawing(s)).map((s) => s.path));
    }
    return true;
  }

  /** Copies the selected shapes as text to the system clipboard (and deletes them for cut). */
  private async copy(cut: boolean): Promise<void> {
    const paths = this.selectionPaths();
    const t = this.target();
    if (!t || paths.length === 0) return;
    const text = copyText(t, paths);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      new Notice("ZyxDraw: could not write to the clipboard");
      return;
    }
    if (cut) this.run((t2) => deleteShapes(t2, paths), () => this.select(null));
  }

  private async paste(): Promise<void> {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      new Notice("ZyxDraw: could not read the clipboard");
      return;
    }
    this.run((t) => pasteText(t, text));
  }

  private duplicate(): void {
    const paths = this.selectionPaths();
    if (paths.length > 0) this.run((t) => duplicateShapes(t, paths));
  }

  private group(): void {
    const paths = this.selectionPaths();
    if (paths.length === 0) new Notice("ZyxDraw: select the shapes to group first (Shift+click, or drag a box)");
    else this.run((t) => groupShapes(t, paths));
  }

  private ungroup(): void {
    const path = this.selected;
    if (path) this.run((t) => ungroupShape(t, path));
  }

  private deleteSelected(): void {
    const paths = this.selectionPaths();
    if (paths.length === 0) return;
    this.run((t) => deleteShapes(t, paths), () => this.select(null));
  }

  /** Deletes the selected point of a polygon / polyline. */
  private deleteSelectedPoint(): void {
    const path = this.selected;
    const index = this.selectedPoint;
    if (!path || index === null) return;
    const t = this.target();
    const shape = t && allShapes(t.scene).find((s) => s.path === path);
    if (shape && !canAddPoints(shape)) {
      new Notice(
        shape.type === "path"
          ? "ZyxDraw: points can be deleted from paths written with absolute M, L, H, V, C and Z only. Press Escape, then Delete, to delete the whole shape"
          : "ZyxDraw: points can be deleted from polygons, polylines and paths. Press Escape, then Delete, to delete the whole shape",
      );
      return;
    }
    this.run(
      (t) => deletePoint(t, path, index),
      () => {
        this.selectedPoint = null;
      },
    );
  }

  private add(type: NewShapeType): void {
    // Fixed canvas: in its middle, sized from it. Infinite: in the middle of the pane, a fixed size.
    let center = { x: this.content.x + this.content.w / 2, y: this.content.y + this.content.h / 2 };
    let { w, h } = this.content;
    if (this.infinite) {
      const r = this.stage.getBoundingClientRect();
      center = this.toSvg({ clientX: r.left + this.stage.clientWidth / 2, clientY: r.top + this.stage.clientHeight / 2 }) ?? center;
      w = 600;
      h = 400;
    }
    const size = type === "text" ? { w: w * 0.2, h: h * 0.1 } : { w: w * 0.2, h: type === "circle" ? w * 0.2 : h * 0.2 };
    const box = { x: Math.round(center.x - size.w / 2), y: Math.round(center.y - size.h / 2), ...size };
    this.run((t) => insertShape(t, type, box, { defaultUnit: this.host.defaultUnit() }));
  }

  /** Runs an edit against the current text (if the text is editable) and applies it. */
  private run(op: (t: EditTarget) => EditResult | null, after?: () => void): void {
    const t = this.target();
    if (!t || !this.editable(t)) return;
    const edit = op(t);
    if (!edit) return;
    // Shapes added by the edit are selected; they are drawn once the text is recompiled.
    if (edit.selectPaths && edit.selectPaths.length > 0 && edit.edits.length > 0) {
      const paths = edit.selectPaths;
      this.multi = paths.length > 1 ? paths : [];
      if (paths[paths.length - 1] !== this.selected) {
        this.selected = paths[paths.length - 1];
        this.selectedPoint = null;
        this.host.selectionChanged(this.selected);
      }
    } else if (edit.select && edit.select !== this.selected) {
      this.selected = edit.select;
      this.multi = [];
      this.selectedPoint = null;
      this.host.selectionChanged(edit.select);
    }
    this.host.apply(edit, t.source);
    after?.();
  }
}

/** The box between a drag's start and (start + delta), whichever way it was dragged. */
function marqueeBox(start: { x: number; y: number }, dx: number, dy: number): Box {
  return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

/** A shape's fill or stroke as drawn: its own, else its groups', else the SVG default. */
function paintOf(shape: Shape, which: "fill" | "stroke"): string {
  for (let s: Shape | null = shape; s; s = s.parent) {
    const v = s.attrs.get(which)?.value;
    if (v && v.t === "str") return v.v;
  }
  return (which === "fill") === (shape.type !== "line") ? "black" : "none";
}

/** A paint for CSS: a color as is, a gradient as a CSS gradient, null for none. */
function cssPaint(value: string, gradients: GradientDef[]): string | null {
  if (value === "none" || value === "transparent") return null;
  const id = /^url\(#(.+)\)$/.exec(value)?.[1];
  if (!id) return value;
  const g = gradients.find((x) => x.id === id);
  if (!g) return null;
  const at = (o: string) => (o.endsWith("%") ? o : `${Number(o) * 100}%`);
  return `linear-gradient(90deg, ${g.stops.map((s) => `${s.color} ${at(s.offset)}`).join(", ")})`;
}

/** New box when dragging a resize handle by (dx, dy). Size never goes below 1. */
function resizedBox(b: Box, h: Handle, dx: number, dy: number): Box {
  let { x, y, w, h: height } = b;
  if (h.includes("w")) {
    w = Math.max(1, b.w - dx);
    x = b.x + b.w - w;
  }
  if (h.includes("e")) w = Math.max(1, b.w + dx);
  if (h.includes("n")) {
    height = Math.max(1, b.h - dy);
    y = b.y + b.h - height;
  }
  if (h.includes("s")) height = Math.max(1, b.h + dy);
  return { x, y, w, h: height };
}
