/**
 * Help view (issue #42), shown in the Help tab of the right panel: short help for the tool in
 * use, from the table in `tool-help.ts`. It follows the tool even while hidden, but never opens
 * or switches tabs by itself.
 */
import { Platform } from "obsidian";
import type { PanelView } from "./panels";
import { TOOL_HELP, docsUrl, forPlatform, type Tool } from "./tool-help";

export class HelpView implements PanelView {
  readonly el: HTMLElement;
  private shown = false;
  private tool: Tool = "select";
  /** The tool the content was last drawn for (null: draw again). */
  private drawn: Tool | null = null;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: "zyxdraw-help" });
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown) this.refresh();
  }

  /** The tool changed in the drawing area. */
  setTool(tool: Tool): void {
    this.tool = tool;
    this.refresh();
  }

  refresh(): void {
    if (!this.shown || this.drawn === this.tool) return;
    this.drawn = this.tool;
    const help = TOOL_HELP[this.tool];
    const text = (s: string) => forPlatform(s, Platform.isMacOS);
    this.el.empty();
    this.el.createDiv({ cls: "zyxdraw-help-title", text: `${help.name} (${help.key})` });
    this.el.createDiv({ cls: "zyxdraw-help-about", text: text(help.about) });
    const list = this.el.createEl("dl", { cls: "zyxdraw-help-steps" });
    for (const step of help.steps) {
      list.createEl("dt", { text: text(step.how) });
      list.createEl("dd", { text: text(step.does) });
    }
    this.el.createEl("a", { cls: "zyxdraw-help-more", text: "More in the docs", href: docsUrl(this.tool), attr: { target: "_blank", rel: "noopener" } });
  }
}
