/**
 * Renders `![[diagram.zyxd]]` embeds in notes as drawings (read-only).
 *
 * Obsidian has no public API for embedding custom file types, so this finds the embed element
 * after rendering and fills it. Obsidian may fill the element itself a moment later, so a
 * MutationObserver re-renders a few times if our drawing gets replaced.
 */
import { MarkdownRenderChild, TFile } from "obsidian";
import { compileInVault } from "./host";
import type ZyxDrawPlugin from "./main";
import { createCanvasMeasurer } from "./measure";
import { mountSvg, renderDiagnostics } from "./svg";

const MAX_RERENDERS = 3;

export function registerEmbeds(plugin: ZyxDrawPlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    for (const embed of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
      const src = embed.getAttribute("src");
      const linkpath = src?.split("#")[0] ?? "";
      if (!linkpath.toLowerCase().endsWith(".zyxd")) continue;
      const file = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, ctx.sourcePath);
      if (!(file instanceof TFile)) continue;
      ctx.addChild(new EmbedChild(embed, plugin, file));
    }
  });
}

class EmbedChild extends MarkdownRenderChild {
  private observer: MutationObserver | null = null;
  private renders = 0;
  private rendering = false;

  constructor(
    containerEl: HTMLElement,
    private readonly plugin: ZyxDrawPlugin,
    private readonly file: TFile,
  ) {
    super(containerEl);
  }

  override onload(): void {
    void this.render();
    this.observer = new MutationObserver(() => {
      if (this.rendering || this.containerEl.querySelector(".zyxdraw-block")) return;
      if (this.renders < MAX_RERENDERS) void this.render();
    });
    this.observer.observe(this.containerEl, { childList: true });
    this.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        // The drawing itself, or a library it may import.
        if (f === this.file || (f instanceof TFile && f.extension === "zyxdl")) void this.render();
      }),
    );
  }

  override onunload(): void {
    this.observer?.disconnect();
  }

  private async render(): Promise<void> {
    this.renders++;
    const source = await this.plugin.app.vault.cachedRead(this.file);
    const result = await compileInVault(this.plugin.app, source, this.file.path, {
      measurer: createCanvasMeasurer(),
      libraryFolder: this.plugin.settings.libraryFolder,
    });
    this.rendering = true;
    this.containerEl.empty();
    this.containerEl.addClass("zyxdraw-embed");
    mountSvg(this.containerEl.createDiv({ cls: "zyxdraw-block" }), result.svg);
    renderDiagnostics(this.containerEl.createDiv({ cls: "zyxdraw-problems" }), source, result.diagnostics);
    this.rendering = false;
  }
}
