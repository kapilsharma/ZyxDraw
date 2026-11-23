/**
 * "Write debug report": a note with what ZyxDraw sees inside Obsidian (versions, theme
 * variables, highlight spans and their computed colors, previews, recent errors).
 * Made for reviewing the plugin without screenshots. Contains no note content except short
 * snippets of open ZyxDraw code.
 */
import { App, Platform, TFile, apiVersion, type PluginManifest } from "obsidian";

const MAX_ERRORS = 50;

export class ErrorLog {
  readonly entries: string[] = [];

  add(context: string, err: unknown): void {
    const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    this.entries.push(`${new Date().toISOString()} ${context}: ${text}`);
    if (this.entries.length > MAX_ERRORS) this.entries.shift();
  }
}

const VARS = [
  "--text-normal",
  "--background-primary",
  "--caret-color",
  "--text-selection",
  "--code-normal",
  "--code-keyword",
  "--code-tag",
  "--code-function",
  "--code-property",
  "--code-string",
  "--code-value",
  "--code-comment",
  "--code-operator",
];

export async function writeDebugReport(app: App, manifest: PluginManifest, log: ErrorLog): Promise<TFile> {
  const doc = activeDocument;
  const body = doc.body;
  const style = (el: Element) => doc.defaultView!.getComputedStyle(el);
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const code = (s: string) => "`" + s.replace(/`/g, "'").replace(/\n/g, "\\n") + "`";

  line("# ZyxDraw debug report");
  line();
  line(`- Date: ${new Date().toISOString()}`);
  line(`- ZyxDraw: ${manifest.version}`);
  line(`- Obsidian API: ${apiVersion}`);
  line(`- Platform: ${Platform.isMobile ? "mobile" : "desktop"}${Platform.isWin ? ", Windows" : Platform.isMacOS ? ", macOS" : Platform.isLinux ? ", Linux" : ""}`);
  line(`- Theme: ${body.classList.contains("theme-dark") ? "dark" : "light"}`);
  line(`- Body classes: ${code(Array.from(body.classList).join(" "))}`);
  line();

  line("## Theme variables (on body)");
  line();
  line("| Variable | Value |");
  line("| -------- | ----- |");
  for (const v of VARS) line(`| ${code(v)} | ${code(style(body).getPropertyValue(v).trim() || "(not set)")} |`);
  line();

  const editors: [string, Element[]][] = [
    ["ZyxDraw editors (.zyxd)", Array.from(doc.querySelectorAll(".zyxdraw-source .cm-content"))],
    ["Markdown editors", Array.from(doc.querySelectorAll(".markdown-source-view .cm-content"))],
  ];
  for (const [title, list] of editors) {
    line(`## ${title}: ${list.length}`);
    line();
    list.slice(0, 3).forEach((content, n) => {
      const spans = Array.from(content.querySelectorAll('[class*="zyxdraw-tok-"]'));
      line(`### ${title} #${n + 1}: ${spans.length} highlighted spans`);
      line();
      line(`- Editor text color: ${code(style(content).color)}, caret: ${code(style(content).caretColor)}`);
      const cursor = content.parentElement?.querySelector(".cm-cursor");
      if (cursor) line(`- Cursor border: ${code(style(cursor).borderLeftColor)} ${code(style(cursor).borderLeftWidth)}`);
      if (spans.length > 0) {
        line();
        line("| Text | Classes | Computed color | Parent classes |");
        line("| ---- | ------- | -------------- | -------------- |");
        for (const s of spans.slice(0, 15)) {
          line(`| ${code((s.textContent ?? "").slice(0, 30))} | ${code(s.className)} | ${code(style(s).color)} | ${code(s.parentElement?.className ?? "")} |`);
        }
      }
      const sample = spans[0]?.closest(".cm-line") ?? content.querySelector(".cm-line");
      if (sample) {
        line();
        line("Sample line HTML:");
        line();
        line("```html");
        line(sample.outerHTML.slice(0, 1200));
        line("```");
      }
      line();
    });
  }

  const previews = Array.from(doc.querySelectorAll(".zyxdraw-svg, .zyxdraw-block svg"));
  line(`## Drawings shown: ${previews.length}`);
  line();
  for (const svg of previews.slice(0, 5)) {
    const box = svg.getBoundingClientRect();
    line(`- ${code(svg.getAttribute("class") ?? "svg")} in ${code(svg.parentElement?.className ?? "")}: background ${code(style(svg).backgroundColor)}, ${Math.round(box.width)} x ${Math.round(box.height)} px, ${svg.querySelectorAll("*").length} elements`);
  }
  line();

  line(`## Recent errors: ${log.entries.length}`);
  line();
  if (log.entries.length > 0) {
    line("```");
    for (const e of log.entries) line(e);
    line("```");
  }

  const path = "ZyxDraw debug report.md";
  const text = out.join("\n") + "\n";
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, text);
    return existing;
  }
  return app.vault.create(path, text);
}
