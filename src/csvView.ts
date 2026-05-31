import { TextFileView, WorkspaceLeaf, Notice, setIcon, TFile } from "obsidian";
import type CSVEditorPlugin from "./main";
import { CSVGrid } from "./grid";
import { delimiterChar } from "./settings";

export const VIEW_TYPE_CSV = "csv-editor-view";

export class CSVView extends TextFileView {
  private grid: CSVGrid | null = null;
  private gridHost!: HTMLElement;
  private saveStatus!: HTMLElement;
  private saveTimer: number | null = null;
  private dirty = false;

  constructor(leaf: WorkspaceLeaf, private plugin: CSVEditorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CSV;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "CSV";
  }

  getIcon(): string {
    return "table";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("csv-editor-view");
    this.buildToolbar();
    this.gridHost = this.contentEl.createDiv({ cls: "csv-editor-host" });
  }

  async onClose(): Promise<void> {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.grid = null;
    this.contentEl.empty();
  }

  // ---- TextFileView contract -------------------------------------------

  getViewData(): string {
    return this.grid ? this.grid.getCSV() : this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear || !this.grid) {
      this.gridHost?.empty();
      this.grid = new CSVGrid(
        this.gridHost,
        data,
        delimiterChar(this.plugin.settings.delimiter),
        () => this.handleChange()
      );
      this.setDirty(false);
    }
  }

  clear(): void {
    this.data = "";
    this.grid = null;
    this.gridHost?.empty();
    this.setDirty(false);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    // Flush pending edits before the file is swapped out so nothing is lost.
    if (this.dirty) {
      if (this.saveTimer !== null) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.save();
      this.setDirty(false);
    }
    await super.onUnloadFile(file);
  }

  // ---- toolbar & save flow ---------------------------------------------

  private buildToolbar() {
    const bar = this.contentEl.createDiv({ cls: "csv-editor-toolbar" });

    const saveBtn = bar.createEl("button", { cls: "csv-toolbar-btn mod-cta" });
    setIcon(saveBtn.createSpan({ cls: "csv-toolbar-icon" }), "save");
    saveBtn.createSpan({ text: "Save" });
    saveBtn.addEventListener("click", async () => {
      if (this.saveTimer !== null) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.save();
      this.setDirty(false);
      new Notice("CSV saved");
    });

    this.saveStatus = bar.createSpan({ cls: "csv-save-status" });
    this.updateStatus();
  }

  private handleChange() {
    this.setDirty(true);
    this.requestSaveSettingsAware();
  }

  private requestSaveSettingsAware() {
    if (!this.plugin.settings.autoSave) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(async () => {
      this.saveTimer = null;
      await this.save();
      this.setDirty(false);
    }, this.plugin.settings.saveDebounce);
  }

  private setDirty(dirty: boolean) {
    this.dirty = dirty;
    this.updateStatus();
  }

  private updateStatus() {
    if (!this.saveStatus) return;
    if (this.dirty) {
      this.saveStatus.setText(
        this.plugin.settings.autoSave ? "Saving…" : "Unsaved changes"
      );
      this.saveStatus.toggleClass("is-dirty", true);
    } else {
      this.saveStatus.setText("Saved");
      this.saveStatus.toggleClass("is-dirty", false);
    }
  }
}
