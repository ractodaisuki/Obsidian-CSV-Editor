import { App, PluginSettingTab, Setting } from "obsidian";
import type CSVEditorPlugin from "./main";

export type DelimiterKey = "comma" | "semicolon" | "tab" | "pipe";

export interface CSVEditorSettings {
  /** Field delimiter used when parsing and saving. */
  delimiter: DelimiterKey;
  /** Write changes back to disk automatically. */
  autoSave: boolean;
  /** Debounce window (ms) before an auto-save fires. */
  saveDebounce: number;
}

export const DEFAULT_SETTINGS: CSVEditorSettings = {
  delimiter: "comma",
  autoSave: true,
  saveDebounce: 300,
};

const DELIMITER_CHARS: Record<DelimiterKey, string> = {
  comma: ",",
  semicolon: ";",
  tab: "\t",
  pipe: "|",
};

export function delimiterChar(key: DelimiterKey): string {
  return DELIMITER_CHARS[key] ?? ",";
}

export class CSVSettingTab extends PluginSettingTab {
  plugin: CSVEditorPlugin;

  constructor(app: App, plugin: CSVEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Delimiter")
      .setDesc("Character that separates fields. Applies to open files after they are reopened.")
      .addDropdown((dd) =>
        dd
          .addOption("comma", "Comma  ,")
          .addOption("semicolon", "Semicolon  ;")
          .addOption("tab", "Tab")
          .addOption("pipe", "Pipe  |")
          .setValue(this.plugin.settings.delimiter)
          .onChange(async (value) => {
            this.plugin.settings.delimiter = value as DelimiterKey;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-save")
      .setDesc("Write edits back to disk automatically. When off, use the Save button in the grid toolbar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSave).onChange(async (value) => {
          this.plugin.settings.autoSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-save delay")
      .setDesc("How long to wait after the last edit before saving (100–2000 ms).")
      .addSlider((slider) =>
        slider
          .setLimits(100, 2000, 50)
          .setValue(this.plugin.settings.saveDebounce)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.saveDebounce = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
