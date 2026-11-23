// "New ZyxDraw drawing": asks for the name first, so the file never needs renaming.
import { App, Modal, TFolder, normalizePath } from "obsidian";
import { drawingBaseName, freeName } from "./file-name";

export class NewDrawingModal extends Modal {
  private input!: HTMLInputElement;
  private problemEl!: HTMLElement;

  constructor(
    app: App,
    private readonly folder: TFolder,
    private readonly extension: string,
    /** Creates the file at the vault path. */
    private readonly create: (path: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("New ZyxDraw drawing");
    const { contentEl } = this;
    contentEl.addClass("zyxdraw-new-drawing");
    const where = this.folder.isRoot() ? "the vault root" : this.folder.path;
    contentEl.createEl("p", { text: `In ${where}`, cls: "setting-item-description" });

    const row = contentEl.createDiv({ cls: "zyxdraw-new-drawing-name" });
    this.input = row.createEl("input", { type: "text", attr: { spellcheck: "false", "aria-label": "Name" } });
    row.createSpan({ text: `.${this.extension}` });
    this.problemEl = contentEl.createDiv({ cls: "zyxdraw-new-drawing-problem" });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Create", cls: "mod-cta" }).addEventListener("click", () => void this.submit());
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

    this.input.value = freeName("Untitled", (n) => this.exists(n));
    this.input.addEventListener("input", () => this.showProblem(""));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.input.focus();
    this.input.select();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private pathFor(name: string): string {
    const base = this.folder.isRoot() ? "" : `${this.folder.path}/`;
    return normalizePath(`${base}${name}.${this.extension}`);
  }

  /** Case-insensitive, as on Windows and macOS. */
  private exists(name: string): boolean {
    const path = this.pathFor(name).toLowerCase();
    return this.folder.children.some((f) => f.path.toLowerCase() === path);
  }

  private async submit(): Promise<void> {
    const checked = drawingBaseName(this.input.value, this.extension);
    if ("problem" in checked) return this.showProblem(checked.problem);
    if (this.exists(checked.name)) return this.showProblem(`${checked.name}.${this.extension} already exists here`);
    try {
      await this.create(this.pathFor(checked.name));
      this.close();
    } catch (err) {
      this.showProblem(String(err instanceof Error ? err.message : err));
    }
  }

  private showProblem(text: string): void {
    this.problemEl.setText(text);
  }
}
