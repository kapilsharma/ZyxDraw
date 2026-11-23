import type { Diagnostic } from "../core";

/** Replaces the content of `container` with the given SVG string, without using innerHTML. */
export function mountSvg(container: HTMLElement, svg: string): void {
  container.empty();
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    container.createEl("pre", { text: "ZyxDraw: invalid SVG output" });
    return;
  }
  const el = container.doc.importNode(doc.documentElement, true);
  uniqueIds(el);
  container.appendChild(el);
}

let idCounter = 0;
/** Attributes that point at an element by id: `url(#id)` (or `#id` for href). */
const REF_ATTRS = ["fill", "stroke", "clip-path", "marker-start", "marker-mid", "marker-end", "mask", "filter"];

/**
 * Gives every id in a drawing (gradients, clips, arrow markers) a prefix unique in the window.
 * All open notes and drawings share one document, so two drawings that both define `sky` would
 * otherwise both show the first one's colors. Exported SVG keeps the readable ids.
 */
export function uniqueIds(root: Element): void {
  const withId = Array.from(root.querySelectorAll("[id]"));
  if (withId.length === 0) return;
  const prefix = `zyx${++idCounter}-`;
  const ids = new Set<string>();
  for (const el of withId) {
    ids.add(el.id);
    el.id = prefix + el.id;
  }
  const fix = (value: string) => value.replace(/url\(#([^)]+)\)/g, (m: string, id: string) => (ids.has(id) ? `url(#${prefix}${id})` : m));
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of REF_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && v.includes("url(#")) el.setAttribute(attr, fix(v));
    }
    const href = el.getAttribute("href");
    if (href?.startsWith("#") && ids.has(href.slice(1))) el.setAttribute("href", `#${prefix}${href.slice(1)}`);
  }
}

/** Lists problems as "Line N: message". Clicking one calls `onClick` with its source offset. */
export function renderDiagnostics(
  container: HTMLElement,
  source: string,
  diagnostics: Diagnostic[],
  onClick?: (offset: number) => void,
): void {
  container.empty();
  if (diagnostics.length === 0) return;
  const list = container.createEl("ul");
  for (const d of diagnostics) {
    const line = source.slice(0, d.range.start).split("\n").length;
    const item = list.createEl("li", { cls: `zyxdraw-problem is-${d.severity}` });
    item.createSpan({ cls: "zyxdraw-problem-line", text: `Line ${line}` });
    item.createSpan({ text: ` ${d.message} ` });
    item.createSpan({ cls: "zyxdraw-problem-code", text: d.code });
    if (onClick) {
      item.addClass("is-clickable");
      item.addEventListener("click", () => onClick(d.range.start));
    }
  }
}
