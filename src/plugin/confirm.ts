// Asks before an edit that would break references (issue #11): moving or deleting a shape that
// other shapes refer to. The user can go ahead anyway, or cancel.
import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    /** One line each, shown as a list. */
    private readonly items: string[],
    private readonly action: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.addClass("zyxdraw-confirm");
    contentEl.createEl("p", { text: this.message });
    const list = contentEl.createEl("ul");
    for (const item of this.items) list.createEl("li", { text: item });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const go = buttons.createEl("button", { text: this.action, cls: "mod-warning" });
    go.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    cancel.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
