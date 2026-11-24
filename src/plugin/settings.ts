import { App, PluginSettingTab, Setting, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
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
  /** Bottom panel (Attributes) under the drawing area: last choice, used for newly opened drawings. */
  showProperties: boolean;
  /** Wrap long lines in the text editor. */
  wrapText: boolean;
  /** Eye icons in the text editor that hide and show shapes (`display=none`). */
  showLayerToggles: boolean;
  /** Width of the left panel (text) in side by side mode, as a fraction of the view (drag to change). Key kept for saved settings. */
  sourceWidth: number;
  /** Height of the bottom panel, as a fraction of the drawing area's column (drag to change). Key kept for saved settings. */
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

type ControlKey = "defaultMode" | "wrapText" | "showLayerToggles" | "showGrid" | "showCoordinates" | "defaultUnit" | "pngScale" | "pngBackground";

/**
 * The settings tab. The settings are listed once, as definitions:
 * - Obsidian 1.13 and later renders them itself and includes them in the settings search;
 * - older versions call `display()`, which draws the same list with `Setting`.
 */
export class ZyxSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ZyxDrawPlugin,
  ) {
    super(app, plugin);
  }

  private definitions(): SettingDefinition<ControlKey>[] {
    return [
      {
        name: "Default view",
        desc: "How a drawing opens. You can switch at any time with the button in the view header.",
        control: {
          type: "dropdown",
          key: "defaultMode",
          options: { split: "Text and drawing side by side", source: "Text only", drawing: "Drawing only" },
        },
      },
      {
        name: "Wrap long lines",
        desc: 'In the text editor. Also the command "Toggle text wrapping".',
        control: { type: "toggle", key: "wrapText" },
      },
      {
        name: "Show layer toggles in the text editor",
        desc: "An eye next to the line number of each shape. Click it to hide the shape (writes `display=none`) or show it again.",
        aliases: ["hide", "layers", "eye"],
        control: { type: "toggle", key: "showLayerToggles" },
      },
      {
        name: "Show grid",
        desc: 'Grid lines over the drawing, spaced to suit the zoom. Also the grid button in the drawing toolbar, or the command "Toggle grid".',
        control: { type: "toggle", key: "showGrid" },
      },
      {
        name: "Show mouse coordinates",
        desc: 'The mouse position over the drawing, in the status bar. Also the crosshair button in the drawing toolbar, or the command "Toggle mouse coordinates".',
        control: { type: "toggle", key: "showCoordinates" },
      },
      {
        name: "Unit for new positions and sizes",
        desc: "Used when an edit in the drawing area writes a value that has no unit yet. Existing values keep their unit.",
        control: {
          type: "dropdown",
          key: "defaultUnit",
          options: { percent: "Percent (adapts to the canvas size)", pixel: "Pixels" },
        },
      },
      {
        name: "PNG export scale",
        desc: "Higher is sharper and larger.",
        aliases: ["export"],
        control: { type: "dropdown", key: "pngScale", options: { "1": "1x", "2": "2x", "3": "3x", "4": "4x" } },
      },
      {
        name: "PNG background",
        desc: "Drawings with their own `canvas(background=...)` always use that.",
        aliases: ["export"],
        control: { type: "dropdown", key: "pngBackground", options: { transparent: "Transparent", white: "White" } },
      },
    ];
  }

  /** Obsidian 1.13 and later: rendered by Obsidian and searchable. */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return this.definitions();
  }

  override getControlValue(key: string): unknown {
    const value = this.plugin.settings[key as ControlKey];
    // Dropdowns hold strings; the PNG scale is stored as a number.
    return key === "pngScale" ? String(value) : value;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key as ControlKey) {
      case "defaultMode":
        s.defaultMode = value as ViewMode;
        break;
      case "defaultUnit":
        s.defaultUnit = value as ZyxSettings["defaultUnit"];
        break;
      case "pngBackground":
        s.pngBackground = value as ZyxSettings["pngBackground"];
        break;
      case "pngScale":
        s.pngScale = Number(value);
        break;
      case "wrapText":
        s.wrapText = value === true;
        break;
      case "showLayerToggles":
        s.showLayerToggles = value === true;
        break;
      case "showGrid":
        this.plugin.setGuide("grid", value === true); // saves and refreshes the views
        return;
      case "showCoordinates":
        this.plugin.setGuide("coordinates", value === true);
        return;
    }
    await this.plugin.saveSettings();
    if (key === "wrapText") this.plugin.applyWrap();
    if (key === "showLayerToggles") this.plugin.applyLayerToggles();
  }

  /** Obsidian before 1.13: draws the same definitions. Not called when `getSettingDefinitions()` is used. */
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const def of this.definitions()) {
      if (!def.control) continue;
      const { control } = def;
      const setting = new Setting(containerEl).setName(def.name);
      if (def.desc) setting.setDesc(def.desc);
      const save = (v: unknown) => void this.setControlValue(control.key, v);
      if (control.type === "toggle") {
        setting.addToggle((t) => t.setValue(this.getControlValue(control.key) === true).onChange(save));
      } else if (control.type === "dropdown") {
        setting.addDropdown((d) => d.addOptions(control.options).setValue(String(this.getControlValue(control.key))).onChange(save));
      }
    }
  }
}
