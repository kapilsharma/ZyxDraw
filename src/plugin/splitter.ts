/**
 * A drag handle between two panes. `axis: "x"` resizes side by side panes (a vertical bar),
 * `axis: "y"` stacked ones (a horizontal bar). The handle reports the pointer position as a
 * fraction of the container; the caller decides what it sizes. Double-click resets.
 */
export interface SplitterOptions {
  axis: "x" | "y";
  /** Element whose size the fraction refers to. */
  container: () => HTMLElement;
  /** Fraction of the container, measured from the left (x) or from the bottom (y). */
  onMove(fraction: number): void;
  /** Drag finished (save the size). */
  onEnd(): void;
  onReset(): void;
  label: string;
}

export function createSplitter(parent: HTMLElement, before: Element | null, opts: SplitterOptions): HTMLElement {
  const el = createDiv({
    cls: ["zyxdraw-splitter", opts.axis === "x" ? "is-vertical" : "is-horizontal"],
    attr: { role: "separator", "aria-orientation": opts.axis === "x" ? "vertical" : "horizontal", "aria-label": opts.label },
  });
  parent.insertBefore(el, before);

  let dragging: number | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.addClass("is-dragging");
    el.doc.body.addClass(opts.axis === "x" ? "zyxdraw-resizing-x" : "zyxdraw-resizing-y");
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (dragging !== e.pointerId) return;
    const r = opts.container().getBoundingClientRect();
    const f = opts.axis === "x" ? (e.clientX - r.left) / r.width : (r.bottom - e.clientY) / r.height;
    if (Number.isFinite(f)) opts.onMove(f);
  });
  const end = (e: PointerEvent) => {
    if (dragging !== e.pointerId) return;
    dragging = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    el.removeClass("is-dragging");
    el.doc.body.removeClass("zyxdraw-resizing-x", "zyxdraw-resizing-y");
    opts.onEnd();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", () => {
    opts.onReset();
    opts.onEnd();
  });
  return el;
}
