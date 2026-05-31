import { Plugin } from "obsidian";
import { CSVView, VIEW_TYPE_CSV } from "./csvView";
import { CSVEditorSettings, CSVSettingTab, DEFAULT_SETTINGS } from "./settings";

export default class CSVEditorPlugin extends Plugin {
  settings: CSVEditorSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CSV, (leaf) => new CSVView(leaf, this));
    // Route .csv files to our grid view instead of the plain-text reader.
    this.registerExtensions(["csv"], VIEW_TYPE_CSV);

    this.addSettingTab(new CSVSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
