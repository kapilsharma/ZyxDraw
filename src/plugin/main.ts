import { Notice, Plugin, TFile, TFolder, addIcon } from "obsidian";
import { ErrorLog, writeDebugReport } from "./debug";
import { registerEmbeds } from "./embed";
import { zyxCodeBlockHighlighting } from "./highlight";
import { runExport, type ExportKind } from "./export";
import { compileInVault } from "./host";
import { LOGO_ICON, logoIconContent } from "./logo";
import { createCanvasMeasurer } from "./measure";
import { NewDrawingModal } from "./new-drawing";
import { DEFAULT_SETTINGS, ZyxSettingTab, type Guide, type ViewMode, type ZyxSettings } from "./settings";
import { mountSvg, renderDiagnostics } from "./svg";
import { VIEW_TYPE_ZYX, ZyxView } from "./zyx-view";

const EXTENSION = "zyxd";

const SAMPLE = `# New ZyxDraw drawing
canvas(width=400, height=200)

primary is style(fill=steelblue, stroke=white, stroke-width=2)

api is rect(x=20, y=20, width=120, height=60, style=primary)
db is rect(right-of=api 60, y=20, width=120, height=60, style=primary)
line(from=api, to=db, arrow=end, label="SQL")
`;

const EXPORTS: { kind: ExportKind; id: string; name: string; menu?: string; icon: string }[] = [
  { kind: "svg", id: "export-svg", name: "Export as SVG", menu: "Export as SVG", icon: "image-down" },
  { kind: "png", id: "export-png", name: "Export as PNG", menu: "Export as PNG", icon: "image-down" },
  { kind: "canvas", id: "export-canvas", name: "Export as JSON Canvas", menu: "Export as JSON Canvas", icon: "layout-dashboard" },
  { kind: "copy-svg", id: "copy-svg", name: "Copy as SVG", icon: "copy" },
  { kind: "copy-png", id: "copy-png", name: "Copy as PNG", icon: "copy" },
];

export default class ZyxDrawPlugin extends Plugin {
  override settings: ZyxSettings = { ...DEFAULT_SETTINGS };
  readonly errors = new ErrorLog();
  /** Mouse coordinates over a drawing (desktop only: mobile has no status bar). */
  private coordinatesEl: HTMLElement | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    // The logo, drawn from its own ZyxDraw source: ribbon, tabs, commands.
    addIcon(LOGO_ICON, logoIconContent());
    this.addSettingTab(new ZyxSettingTab(this.app, this));

    this.coordinatesEl = this.addStatusBarItem();
    this.coordinatesEl.addClass("zyxdraw-coordinates");
    this.showCoordinates(null);
    const guides: [Guide, string, string][] = [
      ["grid", "toggle-grid", "Toggle grid"],
      ["coordinates", "toggle-coordinates", "Toggle mouse coordinates"],
    ];
    for (const [guide, id, name] of guides) {
      this.addCommand({ id, name, callback: () => this.setGuide(guide, !this.guideOn(guide)) });
    }

    // Collect errors for the debug report.
    this.registerDomEvent(window, "error", (e) => this.errors.add("error", e.error ?? e.message));
    this.registerDomEvent(window, "unhandledrejection", (e) => this.errors.add("unhandled promise", e.reason));
    this.addCommand({
      id: "debug-report",
      name: "Write debug report",
      callback: async () => {
        try {
          const file = await writeDebugReport(this.app, this.manifest, this.errors);
          new Notice(`ZyxDraw: wrote ${file.path}`);
        } catch (err) {
          this.errors.add("debug report", err);
          new Notice(`ZyxDraw: debug report failed: ${String(err)}`);
        }
      },
    });

    // Colors for ```zyxd blocks while editing notes.
    this.registerEditorExtension(zyxCodeBlockHighlighting());

    this.registerView(VIEW_TYPE_ZYX, (leaf) => new ZyxView(leaf, this));
    this.registerExtensions([EXTENSION], VIEW_TYPE_ZYX);

    // ```zyxd code blocks inside notes (read-only). Imports resolve relative to the note.
    this.registerMarkdownCodeBlockProcessor(EXTENSION, async (source, el, ctx) => {
      const result = await compileInVault(this.app, source, ctx.sourcePath, { measurer: createCanvasMeasurer() });
      mountSvg(el.createDiv({ cls: "zyxdraw-block" }), result.svg);
      renderDiagnostics(el.createDiv({ cls: "zyxdraw-problems" }), source, result.diagnostics);
    });

    // ![[diagram.zyxd]] embeds in notes.
    registerEmbeds(this);

    this.addRibbonIcon(LOGO_ICON, "New ZyxDraw drawing", () => this.createDrawing());
    this.addCommand({ id: "new-drawing", name: "New drawing", icon: LOGO_ICON, callback: () => this.createDrawing() });

    this.addCommand({
      id: "go-to-definition",
      name: "Go to definition",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(ZyxView);
        if (!view) return false;
        if (!checking) view.goToDefinitionAtCursor();
        return true;
      },
    });

    this.addCommand({
      id: "toggle-wrap",
      name: "Toggle text wrapping",
      callback: () => {
        this.settings.wrapText = !this.settings.wrapText;
        void this.saveSettings();
        this.applyWrap();
        new Notice(`ZyxDraw: text wrapping ${this.settings.wrapText ? "on" : "off"}`);
      },
    });

    const modes: [ViewMode, string][] = [
      ["split", "Show text and drawing"],
      ["source", "Show text only"],
      ["drawing", "Show drawing only"],
    ];
    for (const [mode, name] of modes) {
      this.addCommand({
        id: `mode-${mode}`,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(ZyxView);
          if (!view) return false;
          if (!checking) view.setMode(mode);
          return true;
        },
      });
    }

    for (const e of EXPORTS) {
      this.addCommand({
        id: e.id,
        name: e.name,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== EXTENSION) return false;
          if (!checking) void this.export(file, e.kind);
          return true;
        },
      });
    }

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((i) => i.setTitle("New ZyxDraw drawing").setIcon(LOGO_ICON).setSection("action-primary").onClick(() => this.createDrawing(file)));
          return;
        }
        if (!(file instanceof TFile) || file.extension !== EXTENSION) return;
        for (const e of EXPORTS) {
          if (!e.menu) continue;
          menu.addItem((i) => i.setTitle(e.menu!).setIcon(e.icon).onClick(() => void this.export(file, e.kind)));
        }
      }),
    );

    // A library file changed: other open drawings may import it.
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile) || f.extension !== EXTENSION) return;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ZYX)) {
          const view = leaf.view;
          if (view instanceof ZyxView && view.file !== f) view.refresh();
        }
      }),
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ZyxSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Applies the wrapping setting to every open drawing. */
  applyWrap(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ZYX)) {
      if (leaf.view instanceof ZyxView) leaf.view.setWrap(this.settings.wrapText);
    }
  }

  guideOn(guide: Guide): boolean {
    return guide === "grid" ? this.settings.showGrid : this.settings.showCoordinates;
  }

  /** Turns the grid or the mouse coordinates on or off, in every open drawing. */
  setGuide(guide: Guide, on: boolean): void {
    if (guide === "grid") this.settings.showGrid = on;
    else this.settings.showCoordinates = on;
    void this.saveSettings();
    if (!this.settings.showCoordinates) this.showCoordinates(null);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ZYX)) {
      if (leaf.view instanceof ZyxView) leaf.view.refreshGuides();
    }
  }

  /** Text for the status bar, or null to hide it (the mouse left the drawing). */
  showCoordinates(text: string | null): void {
    if (!this.coordinatesEl) return;
    this.coordinatesEl.setText(text ?? "");
    this.coordinatesEl.toggleClass("is-hidden", !text);
  }

  /** Exports the saved file, or the open view's text when it has unsaved changes. */
  private async export(file: TFile, kind: ExportKind): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(ZyxView);
    const source = view && view.file === file ? view.getViewData() : await this.app.vault.read(file);
    const result = await compileInVault(this.app, source, file.path, { measurer: createCanvasMeasurer() });
    await runExport(this.app, file, result, kind, this.settings);
  }

  /**
   * Asks for a name, then creates and opens the drawing. Without a folder (ribbon, command) it
   * goes where Obsidian puts new files (setting "Default location for new notes").
   */
  private createDrawing(folder?: TFolder): void {
    const active = this.app.workspace.getActiveFile();
    const parent = folder ?? this.app.fileManager.getNewFileParent(active?.path ?? "");
    new NewDrawingModal(this.app, parent, EXTENSION, async (path) => {
      const file: TFile = await this.app.vault.create(path, SAMPLE);
      await this.app.workspace.getLeaf(true).openFile(file);
    }).open();
  }
}
