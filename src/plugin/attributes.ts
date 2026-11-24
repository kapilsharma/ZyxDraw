/**
 * Attributes, shown in the bottom panel (under the drawing area): a form with every attribute of
 * the selected shape, or of the canvas when nothing is selected. Like the drawing, it never changes anything itself: each
 * committed field becomes a text edit (core/edit/properties), then everything is recompiled.
 */
import { Notice, setIcon } from "obsidian";
import {
  SECTION_ORDER,
  allShapes,
  propertySheet,
  setProperty,
  type CompileResult,
  type EditResult,
  type PropertyField,
  type PropertySection,
  type PropertySheet,
} from "../core";

export interface AttributesHost {
  current(): { source: string; result: CompileResult } | null;
  apply(edit: EditResult, source: string): void;
  revealInSource(path: string): void;
  /** Selects a shape in the drawing (null = canvas). */
  select(path: string | null): void;
}

/** Edits need exact source ranges, so they are off while the text has syntax errors. */
export function hasSyntaxErrors(result: CompileResult): boolean {
  return result.diagnostics.some((d) => d.severity === "error" && d.code.startsWith("ZYX0"));
}

const COLOR_KINDS = new Set(["paint"]);

export class AttributesForm {
  readonly el: HTMLElement;
  private path: string | null = null;
  /** Sections the user closed, kept while switching shapes. */
  private readonly closed = new Set<PropertySection>();
  /** Whether the bottom panel is showing the form; while hidden, it is not rebuilt. */
  private shown = false;

  constructor(
    parent: HTMLElement,
    private readonly host: AttributesHost,
  ) {
    this.el = parent.createDiv({ cls: "zyxdraw-attributes" });
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown) this.render();
  }

  /** Shows a shape (or the canvas for null). */
  show(path: string | null): void {
    this.path = path;
    this.render();
  }

  /** Re-reads the values after the text changed. */
  refresh(): void {
    this.render();
  }

  private render(): void {
    if (!this.shown) return;
    const cur = this.host.current();
    if (!cur) return; // a newer compile is on its way; it will call refresh()
    const target = { source: cur.source, scene: cur.result.scene, tree: cur.result.tree, diagnostics: cur.result.diagnostics };
    const sheet = propertySheet(target, this.path) ?? propertySheet(target, null)!;

    // Keep focus, and anything typed but not committed yet, across the rebuild.
    const active = this.el.ownerDocument.activeElement as HTMLInputElement | HTMLSelectElement | null;
    const focusName = active && this.el.contains(active) ? active.dataset.field : undefined;
    const typed = focusName && active instanceof HTMLInputElement && active.dataset.committed !== active.value ? active.value : undefined;
    const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
    const scroll = this.el.scrollTop;

    this.el.empty();
    this.renderHeader(sheet);
    const lists = this.datalists(cur.result);
    const bySection = new Map<PropertySection, PropertyField[]>();
    for (const f of sheet.fields) {
      if (!bySection.has(f.section)) bySection.set(f.section, []);
      bySection.get(f.section)!.push(f);
    }
    for (const section of SECTION_ORDER) {
      const fields = bySection.get(section);
      if (!fields) continue;
      const details = this.el.createEl("details", { cls: "zyxdraw-prop-section" });
      details.open = !this.closed.has(section);
      const summary = details.createEl("summary", { text: section });
      const set = fields.filter((f) => f.value !== "").length;
      if (set > 0) summary.createSpan({ cls: "zyxdraw-prop-count", text: String(set) });
      details.addEventListener("toggle", () => (details.open ? this.closed.delete(section) : this.closed.add(section)));
      const grid = details.createDiv({ cls: "zyxdraw-prop-grid" });
      for (const f of fields) this.renderField(grid, sheet, f, lists);
    }

    this.el.scrollTop = scroll;
    if (focusName) {
      const el = this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${CSS.escape(focusName)}"]`);
      if (el) {
        if (typed !== undefined && el instanceof HTMLInputElement) el.value = typed;
        el.focus();
        if (el instanceof HTMLInputElement && caret !== null) el.setSelectionRange(caret, caret);
      }
    }
  }

  private renderHeader(sheet: PropertySheet): void {
    const head = this.el.createDiv({ cls: "zyxdraw-prop-header" });
    const title = head.createDiv({ cls: "zyxdraw-prop-title" });
    if (sheet.path === null) {
      title.createSpan({ cls: "zyxdraw-prop-type", text: "Canvas" });
    } else {
      title.createSpan({ cls: "zyxdraw-prop-type", text: sheet.type });
      title.createSpan({ cls: "zyxdraw-prop-name", text: sheet.name ?? "(no name)" });
    }
    const b = sheet.box;
    if (b) {
      const round = (n: number) => Math.round(n * 10) / 10;
      const text = sheet.path === null ? `${round(b.w)} × ${round(b.h)}` : `x ${round(b.x)}, y ${round(b.y)}, ${round(b.w)} × ${round(b.h)}`;
      head.createDiv({ cls: "zyxdraw-prop-box", text, attr: { "aria-label": "Position and size on the canvas, in pixels" } });
    }
    head.createDiv({ cls: "zyxdraw-toolbar-gap" });
    if (sheet.path !== null) {
      const path = sheet.path;
      this.iconButton(head, "file-code", "Show in text", () => this.host.revealInSource(path));
      this.iconButton(head, "frame", "Canvas attributes", () => this.host.select(null));
    }
    if (sheet.readOnly) this.el.createDiv({ cls: "zyxdraw-prop-readonly", text: sheet.readOnly });
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
  }

  private renderField(grid: HTMLElement, sheet: PropertySheet, f: PropertyField, lists: Record<string, string>): void {
    const row = grid.createDiv({ cls: "zyxdraw-prop-row" });
    if (f.problem) row.addClass("is-invalid");
    if (f.value !== "") row.addClass("is-set");
    const id = `zyxdraw-prop-${Math.random().toString(36).slice(2)}`;
    const label = row.createEl("label", { cls: "zyxdraw-prop-label", text: f.name, attr: { for: id } });
    if (f.required) label.createSpan({ cls: "zyxdraw-prop-required", text: "*" });
    if (f.written) label.setAttribute("aria-label", `Written as \`${f.written}\``);
    const control = row.createDiv({ cls: "zyxdraw-prop-control" });
    const commit = (value: string) => this.commit(sheet.path, f.name, value);

    if (f.kind === "enum" && f.options) {
      const select = control.createEl("select", { cls: "dropdown", attr: { id, "data-field": f.name } });
      select.createEl("option", { value: "", text: f.placeholder ? `${f.placeholder} (default)` : "(default)" });
      for (const o of f.options) select.createEl("option", { value: o, text: o });
      if (f.value && !f.options.includes(f.value)) select.createEl("option", { value: f.value, text: f.value });
      select.value = f.value;
      select.addEventListener("change", () => commit(select.value));
    } else {
      const input = control.createEl("input", {
        type: "text",
        attr: { id, "data-field": f.name, spellcheck: "false", placeholder: f.placeholder ?? "" },
      });
      input.value = f.value;
      input.dataset.committed = f.value;
      const list = listFor(f);
      if (list && lists[list]) input.setAttribute("list", lists[list]);
      // Once per value: Enter commits, and the blur that may follow must not commit again.
      const commitInput = () => {
        if (!input.isConnected || input.value === input.dataset.committed) return;
        input.dataset.committed = input.value;
        commit(input.value);
      };
      input.addEventListener("change", commitInput);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitInput();
        } else if (e.key === "Escape") {
          e.preventDefault();
          input.value = f.value;
          input.blur();
        }
      });
      if (COLOR_KINDS.has(f.kind)) this.colorSwatch(control, f, (hex) => commit(hex));
    }
    if (f.problem) {
      row.setAttribute("aria-label", f.problem);
      row.createDiv({ cls: "zyxdraw-prop-problem", text: f.problem });
    }
  }

  /** A native color picker next to a color field. Named colors are shown as their hex value. */
  private colorSwatch(parent: HTMLElement, f: PropertyField, onPick: (hex: string) => void): void {
    const picker = parent.createEl("input", { type: "color", cls: "zyxdraw-prop-color", attr: { "aria-label": "Pick a color" } });
    const shown = f.value || (f.placeholder ?? "").replace(/ \(style\)$/, "");
    const hex = colorToHex(shown);
    picker.value = hex ?? "#000000";
    if (!hex) picker.addClass("is-none");
    picker.addEventListener("change", () => onPick(picker.value));
  }

  /** Suggestions for fields that name things: shapes, styles, clips, gradients. Returns datalist ids. */
  private datalists(result: CompileResult): Record<string, string> {
    const make = (key: string, values: string[]): [string, string] => {
      const id = `zyxdraw-list-${key}-${Math.random().toString(36).slice(2)}`;
      const dl = this.el.createEl("datalist", { attr: { id } });
      for (const v of [...new Set(values)].sort()) dl.createEl("option", { value: v });
      return [key, id];
    };
    const shapes = allShapes(result.scene).filter((s) => !s.generated && s.name).map((s) => s.path);
    const styles = result.tree.statements.filter((s) => s.kind === "style" && s.name).map((s) => s.name!);
    const clips = result.tree.statements.filter((s) => s.kind === "clipDef" && s.name).map((s) => s.name!);
    const gradients = result.tree.statements.filter((s) => s.kind === "gradientDef" && s.name).map((s) => s.name!);
    return Object.fromEntries([make("shapes", shapes), make("styles", styles), make("clips", clips), make("paints", gradients)]);
  }

  private commit(path: string | null, name: string, value: string): void {
    const cur = this.host.current();
    if (!cur) return;
    if (hasSyntaxErrors(cur.result)) {
      new Notice("ZyxDraw: fix the syntax errors in the text first");
      this.render();
      return;
    }
    const target = { source: cur.source, scene: cur.result.scene, tree: cur.result.tree, diagnostics: cur.result.diagnostics };
    const edit = setProperty(target, path, name, value);
    if (edit.edits.length === 0 && edit.notices.length > 0) {
      for (const n of edit.notices) new Notice(`ZyxDraw: ${n}`);
      this.render();
      return;
    }
    this.host.apply(edit, cur.source);
  }
}

function listFor(f: PropertyField): string | null {
  if (f.name === "style") return "styles";
  if (f.name === "clip-path") return "clips";
  if (f.kind === "paint") return "paints";
  if (f.kind === "ref" || f.kind === "anchorX" || f.kind === "anchorY") return "shapes";
  return null;
}

let colorCtx: CanvasRenderingContext2D | null = null;

/** A CSS color as `#rrggbb` (for a color picker), or null for none, gradients and unknown names. */
export function colorToHex(color: string): string | null {
  if (!color || color === "none" || color === "transparent") return null;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  colorCtx ??= createEl("canvas").getContext("2d");
  const ctx = colorCtx;
  if (!ctx) return null;
  // An unknown color leaves the previous one: two different starting colors tell it apart.
  const read = (start: string) => {
    ctx.fillStyle = start;
    ctx.fillStyle = color;
    return String(ctx.fillStyle);
  };
  const a = read("#000001");
  if (a !== read("#000002")) return null;
  return /^#[0-9a-f]{6}$/i.test(a) ? a : null;
}
