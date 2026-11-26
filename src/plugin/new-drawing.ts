// "New ZyxDraw drawing" and "New ZyxDraw library": ask for the name first, so the file never
// needs renaming.
import { App, Modal, normalizePath } from "obsidian";
import { drawingBaseName, freeName, libraryBaseName } from "./file-name";

/** What the dialog creates. */
export interface NewFileKind {
  title: string;
  extension: string;
  /** Shown under the folder line, such as how dots work in library names. */
  hint?: string;
  /** The checked name, or the problem with it. */
  check: (typed: string) => { name: string } | { problem: string };
  /** The file's path inside the folder, from a checked name. */
  file: (name: string) => string;
  /** Joins `Untitled` and a number when taken. */
  separator: string;
}

export const DRAWING: NewFileKind = {
  title: "New ZyxDraw drawing",
  extension: "zyxd",
  check: (typed) => drawingBaseName(typed, "zyxd"),
  file: (name) => `${name}.zyxd`,
  separator: " ",
};

export const LIBRARY: NewFileKind = {
  title: "New ZyxDraw library",
  extension: "zyxdl",
  hint: "A dot makes a folder: cloud.aws creates cloud/aws.zyxdl. Use letters, digits, - and _.",
  check: libraryBaseName,
  // `cloud.aws` -> `cloud/aws.zyxdl`
  file: (name) => `${name.split(".").join("/")}.zyxdl`,
  separator: "_",
};

export class NewDrawingModal extends Modal {
  private input!: HTMLInputElement;
  private problemEl!: HTMLElement;

  constructor(
    app: App,
    /** Vault path of the folder; "" or "/" is the vault root. It may not exist yet. */
    private readonly folder: string,
    private readonly kind: NewFileKind,
    /** Creates the file at the vault path. */
    private readonly create: (path: string, name: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { kind } = this;
    this.titleEl.setText(kind.title);
    const { contentEl } = this;
    contentEl.addClass("zyxdraw-new-drawing");
    const where = this.base() === "" ? "the vault root" : this.base().slice(0, -1);
    contentEl.createEl("p", { text: `In ${where}`, cls: "setting-item-description" });
    if (kind.hint) contentEl.createEl("p", { text: kind.hint, cls: "setting-item-description" });

    const row = contentEl.createDiv({ cls: "zyxdraw-new-drawing-name" });
    this.input = row.createEl("input", { type: "text", attr: { spellcheck: "false", "aria-label": "Name" } });
    row.createSpan({ text: `.${kind.extension}` });
    this.problemEl = contentEl.createDiv({ cls: "zyxdraw-new-drawing-problem" });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Create", cls: "mod-cta" }).addEventListener("click", () => void this.submit());
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

    this.input.value = freeName("Untitled", (n) => this.exists(n), kind.separator);
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

  /** The folder path with a trailing `/`, or "" for the vault root. */
  private base(): string {
    const folder = normalizePath(this.folder);
    return folder === "/" || folder === "" ? "" : `${folder}/`;
  }

  private pathFor(name: string): string {
    return normalizePath(`${this.base()}${this.kind.file(name)}`);
  }

  /** Case-insensitive, as on Windows and macOS. Also checks inside subfolders (`cloud.aws`). */
  private exists(name: string): boolean {
    const path = this.pathFor(name).toLowerCase();
    return this.app.vault.getAllLoadedFiles().some((f) => f.path.toLowerCase() === path);
  }

  private async submit(): Promise<void> {
    const checked = this.kind.check(this.input.value);
    if ("problem" in checked) return this.showProblem(checked.problem);
    if (this.exists(checked.name)) return this.showProblem(`${this.kind.file(checked.name)} already exists here`);
    try {
      await this.create(this.pathFor(checked.name), checked.name);
      this.close();
    } catch (err) {
      this.showProblem(String(err instanceof Error ? err.message : err));
    }
  }

  private showProblem(text: string): void {
    this.problemEl.setText(text);
  }
}
