import { App, PluginSettingTab, Setting } from "obsidian";
import type ZyxDrawPlugin from "./main";

export type ViewMode = "split" | "source" | "drawing";

export interface ZyxSettings {
  /** Unit written for new positions and sizes from the drawing view. */
  defaultUnit: "percent" | "pixel";
  /** Mode a drawing opens in. */
  defaultMode: ViewMode;
  /** PNG export scale (2 = twice the drawing size). */
  pngScale: number;
  pngBackground: "transparent" | "white";
  /** Attributes panel under the drawing: last choice, used for newly opened drawings. */
  showProperties: boolean;
  /** Wrap long lines in the text editor. */
  wrapText: boolean;
  /** Eye icons in the text editor that hide and show shapes (`display=none`). */
  showLayerToggles: boolean;
  /** Width of the text pane in side by side mode, as a fraction of the view (drag to change). */
  sourceWidth: number;
  /** Height of the attributes panel, as a fraction of the drawing pane (drag to change). */
  propertiesHeight: number;
  /** Grid lines over the drawing view. */
  showGrid: boolean;
  /** Mouse position in the status bar while over the drawing view. */
  showCoordinates: boolean;
}

export type Guide = "grid" | "coordinates";

export const DEFAULT_SETTINGS: ZyxSettings = {
  defaultUnit: "percent",
  defaultMode: "split",
  showProperties: false,
  wrapText: true,
  showLayerToggles: true,
  sourceWidth: 0.5,
  propertiesHeight: 0.35,
  showGrid: false,
  showCoordinates: true,
  pngScale: 2,
  pngBackground: "transparent",
};

export class ZyxSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ZyxDrawPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default view")
      .setDesc("How a drawing opens. You can switch at any time with the button in the view header.")
      .addDropdown((d) =>
        d
          .addOption("split", "Text and drawing side by side")
          .addOption("source", "Text only")
          .addOption("drawing", "Drawing only")
          .setValue(s.defaultMode)
          .onChange(async (v) => {
            s.defaultMode = v as ViewMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Wrap long lines")
      .setDesc("In the text editor. Also the command \"Toggle text wrapping\".")
      .addToggle((t) =>
        t.setValue(s.wrapText).onChange(async (v) => {
          s.wrapText = v;
          await this.plugin.saveSettings();
          this.plugin.applyWrap();
        }),
      );

    new Setting(containerEl)
      .setName("Show layer toggles in the text editor")
      .setDesc("An eye next to the line number of each shape. Click it to hide the shape (writes `display=none`) or show it again.")
      .addToggle((t) =>
        t.setValue(s.showLayerToggles).onChange(async (v) => {
          s.showLayerToggles = v;
          await this.plugin.saveSettings();
          this.plugin.applyLayerToggles();
        }),
      );

    new Setting(containerEl)
      .setName("Show grid")
      .setDesc("Grid lines over the drawing, spaced to suit the zoom. Also the grid button in the drawing toolbar, or the command \"Toggle grid\".")
      .addToggle((t) => t.setValue(s.showGrid).onChange((v) => this.plugin.setGuide("grid", v)));

    new Setting(containerEl)
      .setName("Show mouse coordinates")
      .setDesc(
        "The mouse position over the drawing, in the status bar. Also the crosshair button in the drawing toolbar, or the command \"Toggle mouse coordinates\".",
      )
      .addToggle((t) => t.setValue(s.showCoordinates).onChange((v) => this.plugin.setGuide("coordinates", v)));

    new Setting(containerEl)
      .setName("Unit for new positions and sizes")
      .setDesc("Used when the drawing view writes a value that has no unit yet. Existing values keep their unit.")
      .addDropdown((d) =>
        d
          .addOption("percent", "Percent (adapts to the canvas size)")
          .addOption("pixel", "Pixels")
          .setValue(s.defaultUnit)
          .onChange(async (v) => {
            s.defaultUnit = v as ZyxSettings["defaultUnit"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("PNG export scale")
      .setDesc("Higher is sharper and larger.")
      .addDropdown((d) => {
        for (const n of [1, 2, 3, 4]) d.addOption(String(n), `${n}x`);
        d.setValue(String(s.pngScale)).onChange(async (v) => {
          s.pngScale = Number(v);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("PNG background")
      .setDesc("Drawings with their own `canvas(background=...)` always use that.")
      .addDropdown((d) =>
        d
          .addOption("transparent", "Transparent")
          .addOption("white", "White")
          .setValue(s.pngBackground)
          .onChange(async (v) => {
            s.pngBackground = v as ZyxSettings["pngBackground"];
            await this.plugin.saveSettings();
          }),
      );
  }
}
