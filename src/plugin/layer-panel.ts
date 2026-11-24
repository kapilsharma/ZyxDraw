/**
 * Layers view (issue #11), shown in the right panel: the drawing as a tree, front-most first.
 * Like the drawing and the Attributes, it never changes anything itself: hiding, adding,
 * deleting and moving (drag a row) become text edits through the host, and the view is rebuilt
 * after each compile. Right-click a row for the layer right-click menu (issue #12).
 */
import { Menu, setIcon } from "obsidian";
import { layerTree, type CompileResult, type DropPlace, type LayerNode } from "../core";
import type { PanelView } from "./panels";

export interface LayersHost {
  current(): { source: string; result: CompileResult } | null;
  /** The active layer: new shapes go into it. */
  activeLayer(): string | null;
  /** A row was clicked: select the shape (and make its layer active). */
  select(path: string): void;
  toggleHidden(path: string): void;
  revealInSource(path: string): void;
  newLayer(): void;
  delete(path: string): void;
  /** A row was dragged and dropped. */
  move(path: string, place: DropPlace): void;
}

type Zone = "above" | "below" | "into";

const ICON: Record<string, string> = {
  layer: "layers",
  group: "group",
  instance: "component",
  rect: "square",
  circle: "circle",
  ellipse: "circle",
  line: "minus",
  polyline: "spline",
  polygon: "pentagon",
  path: "pen-tool",
  text: "type",
};

export class LayersView implements PanelView {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly deleteButton: HTMLElement;
  private shown = false;
  private selected: string | null = null;
  /** Rows opened or closed by the user. Layers start open, groups closed. */
  private readonly open = new Map<string, boolean>();
  /** The row being dragged. */
  private dragging: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: LayersHost,
  ) {
    this.el = parent.createDiv({ cls: "zyxdraw-layers" });
    const head = this.el.createDiv({ cls: "zyxdraw-layers-header" });
    head.createSpan({ cls: "zyxdraw-layers-title", text: "Layers" });
    const button = (icon: string, label: string, onClick: () => void) => {
      const b = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", onClick);
      return b;
    };
    button("plus", "New layer (in front of everything; new shapes go into it)", () => this.host.newLayer());
    this.deleteButton = button("trash-2", "Delete the selected shape, group or layer", () => {
      if (this.selected) this.host.delete(this.selected);
    });
    this.list = this.el.createDiv({ cls: "zyxdraw-layers-list", attr: { role: "tree", "aria-label": "Layers" } });
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown) this.refresh();
  }

  /** The selection changed (in the drawing, the text or here): highlight its row, with its groups open. */
  showSelection(path: string | null): void {
    this.selected = path;
    if (path) {
      const parts = path.split(".");
      for (let i = 1; i < parts.length; i++) this.open.set(parts.slice(0, i).join("."), true);
    }
    this.refresh();
    if (path) this.list.querySelector(".zyxdraw-layer-row.is-selected")?.scrollIntoView({ block: "nearest" });
  }

  refresh(): void {
    if (!this.shown) return;
    const cur = this.host.current();
    if (!cur) return; // a newer compile is on its way; it will call refresh()
    const tree = layerTree(cur.result.scene);
    const active = this.host.activeLayer();
    const scroll = this.list.scrollTop;
    this.list.empty();
    if (tree.length === 0) {
      this.list.createDiv({ cls: "zyxdraw-layers-empty", text: "No shapes yet. Draw one, or add a layer with +." });
    }
    for (const n of tree) this.row(n, null, 0, active);
    this.list.scrollTop = scroll;
    this.deleteButton.toggleClass("is-disabled", this.selected === null);
  }

  private row(n: LayerNode, parent: string | null, depth: number, active: string | null): void {
    const hasChildren = n.children.length > 0;
    const isOpen = hasChildren && (this.open.get(n.path) ?? n.kind === "layer");
    const r = this.list.createDiv({
      cls: "zyxdraw-layer-row",
      attr: { role: "treeitem", "aria-level": String(depth + 1), "aria-selected": String(n.path === this.selected), "data-path": n.path, draggable: "true" },
    });
    if (hasChildren) r.setAttribute("aria-expanded", String(isOpen));
    r.toggleClass("is-selected", n.path === this.selected);
    r.toggleClass("is-active-layer", n.path === active);
    r.toggleClass("is-layer", n.kind === "layer");
    r.toggleClass("is-hidden", n.hidden || n.hiddenByGroup);
    r.setCssProps({ "--zyxdraw-layer-depth": String(depth) });

    const twisty = r.createSpan({ cls: "zyxdraw-layer-twisty" });
    if (hasChildren) {
      setIcon(twisty, isOpen ? "chevron-down" : "chevron-right");
      twisty.setAttribute("aria-label", isOpen ? "Close" : "Open");
      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        this.open.set(n.path, !isOpen);
        this.refresh();
      });
    }
    setIcon(r.createSpan({ cls: "zyxdraw-layer-icon" }), ICON[n.kind] ?? "shapes");
    const label = r.createSpan({ cls: "zyxdraw-layer-label", text: n.label });
    label.toggleClass("is-unnamed", n.unnamed);
    if (n.kind === "instance" && !n.unnamed && n.instanceOf) r.createSpan({ cls: "zyxdraw-layer-detail", text: n.instanceOf });
    if (n.path === active) r.createSpan({ cls: "zyxdraw-layer-detail", text: "active" });

    const eye = r.createEl("button", {
      cls: "clickable-icon zyxdraw-layer-eye",
      attr: { "aria-label": n.hidden ? "Show (removes display=none)" : "Hide (display=none)" },
    });
    eye.toggleClass("is-off", n.hidden);
    setIcon(eye, n.hidden ? "eye-off" : "eye");
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.host.toggleHidden(n.path);
    });

    r.addEventListener("click", () => this.host.select(n.path));
    r.addEventListener("dblclick", () => this.host.revealInSource(n.path));
    r.addEventListener("contextmenu", (e) => this.rowMenu(n, e));
    this.dragAndDrop(r, n, parent);
    if (isOpen) for (const c of n.children) this.row(c, n.path, depth + 1, active);
  }

  /** Layer right-click menu (issue #12). More items will follow. */
  private rowMenu(n: LayerNode, e: MouseEvent): void {
    e.preventDefault();
    this.host.select(n.path);
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(n.kind === "layer" ? "Delete layer" : "Delete")
        .setIcon("trash-2")
        .onClick(() => this.host.delete(n.path)),
    );
    menu.showAtMouseEvent(e);
  }

  /**
   * Dragging a row: drop on the top part of a row to put it in front of that row, on the bottom
   * part to put it behind, and on the middle of a layer or group to put it inside (in front).
   */
  private dragAndDrop(r: HTMLElement, n: LayerNode, parent: string | null): void {
    const container = n.kind === "layer" || n.kind === "group";
    const zoneAt = (e: DragEvent): Zone => {
      const box = r.getBoundingClientRect();
      const f = (e.clientY - box.top) / Math.max(1, box.height);
      if (!container) return f < 0.5 ? "above" : "below";
      return f < 0.25 ? "above" : f > 0.75 ? "below" : "into";
    };
    const clear = () => r.removeClass("is-drop-above", "is-drop-below", "is-drop-into");
    r.addEventListener("dragstart", (e) => {
      this.dragging = n.path;
      e.dataTransfer?.setData("text/plain", n.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      r.addClass("is-dragging");
    });
    r.addEventListener("dragend", () => {
      this.dragging = null;
      r.removeClass("is-dragging");
    });
    r.addEventListener("dragover", (e) => {
      if (!this.dragging || this.dragging === n.path) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const zone = zoneAt(e);
      clear();
      r.addClass(`is-drop-${zone}`);
    });
    r.addEventListener("dragleave", clear);
    r.addEventListener("drop", (e) => {
      const path = this.dragging;
      clear();
      if (!path || path === n.path) return;
      e.preventDefault();
      this.dragging = null;
      const zone = zoneAt(e);
      // The list is front-most first: above a row means later in the text.
      const place: DropPlace = zone === "into" ? { parent: n.path } : zone === "above" ? { parent, after: n.path } : { parent, before: n.path };
      this.host.move(path, place);
    });
  }
}
