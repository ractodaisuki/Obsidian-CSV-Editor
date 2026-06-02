import { Menu } from "obsidian";
import { parseCSV, serializeCSV } from "./csvParser";
import { matrixToTSV, parseClipboard } from "./clipboardUtils";

interface Row {
  /** Stable id reflecting the original on-disk order, so a pure sort is
   *  non-destructive: we can always serialize back in id order. */
  id: number;
  cells: string[];
}

interface Cell {
  r: number; // index into this.visible (rendered display order)
  c: number; // column index
}

interface FilterState {
  text: string;
  textCol: number; // -1 = all columns
  dateCol: number; // -1 = none
  dateFrom: string; // yyyy-mm-dd
  dateTo: string; // yyyy-mm-dd
  catCol: number; // -1 = none
  catVal: string; // "" = all values
}

/**
 * A vanilla-TS spreadsheet grid for a single CSV file. Owns the data model,
 * rendering, keyboard navigation, range selection, clipboard, sorting, and
 * filtering. It reports edits through `onChange`; persistence is the caller's
 * job. Sorting and filtering are non-destructive (they never change what gets
 * written back to disk).
 */
export class CSVGrid {
  private headers: string[] = [""];
  private rows: Row[] = []; // all rows, in canonical display order
  private visible: Row[] = []; // rows passing the current filter (references)
  private nextId = 0;

  private sortCol: number | null = null;
  private sortDir: "asc" | "desc" = "asc";

  private filter: FilterState = {
    text: "",
    textCol: -1,
    dateCol: -1,
    dateFrom: "",
    dateTo: "",
    catCol: -1,
    catVal: "",
  };
  private fromTs: number | null = null;
  private toTs: number | null = null;

  private anchor: Cell = { r: 0, c: 0 };
  private active: Cell = { r: 0, c: 0 };

  private cellEls: HTMLElement[][] = [];
  private headerEls: HTMLElement[] = [];

  private root: HTMLElement;
  private filterBar!: HTMLElement;
  private scroller!: HTMLElement;
  private table!: HTMLTableElement;

  // filter controls (rebuilt when columns change)
  private elTextInput!: HTMLInputElement;
  private elTextCol!: HTMLSelectElement;
  private elDateCol!: HTMLSelectElement;
  private elDateFrom!: HTMLInputElement;
  private elDateTo!: HTMLInputElement;
  private elCatCol!: HTMLSelectElement;
  private elCatVal!: HTMLSelectElement;
  private elCount!: HTMLElement;

  private editing: { input: HTMLInputElement; r: number; c: number } | null = null;
  private dragging = false;
  /** Internal fallback buffer used when the async clipboard API is unavailable. */
  private internalClipboard: string[][] | null = null;

  constructor(
    container: HTMLElement,
    csvText: string,
    private delimiter: string,
    private onChange: () => void
  ) {
    this.root = container;
    this.root.addClass("csv-editor-root");
    this.load(csvText);
    this.buildSkeleton();
    this.applyFilter();
    this.refreshFilterControls();
    this.render();
    this.attachGlobalHandlers();
  }

  // ---- data model -------------------------------------------------------

  private load(csvText: string) {
    const matrix = parseCSV(csvText, this.delimiter);
    this.headers = matrix[0].slice();
    this.rows = matrix.slice(1).map((cells) => ({ id: this.nextId++, cells: cells.slice() }));
  }

  /** Serialize back to CSV text in the original (on-disk) row order. */
  getCSV(): string {
    const ordered =
      this.sortCol === null ? this.rows : [...this.rows].sort((a, b) => a.id - b.id);
    const matrix = [this.headers, ...ordered.map((row) => row.cells)];
    return serializeCSV(matrix, this.delimiter);
  }

  setDelimiter(delimiter: string) {
    this.delimiter = delimiter;
  }

  private get nCols(): number {
    return this.headers.length;
  }

  /** Index of a visible row within the canonical `rows` array. */
  private baseIndex(visibleRow: number): number {
    return this.rows.indexOf(this.visible[visibleRow]);
  }

  /** "Bake" the current display order into the canonical order. Called before
   *  structural edits so inserts/deletes apply to what the user actually sees. */
  private bake() {
    if (this.sortCol === null) return;
    this.rows.forEach((row, i) => (row.id = i));
    this.sortCol = null;
  }

  // ---- filtering --------------------------------------------------------

  private get filterActive(): boolean {
    const f = this.filter;
    return (
      f.text.trim() !== "" ||
      (f.dateCol !== -1 && (f.dateFrom !== "" || f.dateTo !== "")) ||
      (f.catCol !== -1 && f.catVal !== "")
    );
  }

  private applyFilter() {
    const f = this.filter;
    this.fromTs = f.dateFrom ? parseDate(f.dateFrom) : null;
    const endTs = f.dateTo ? parseDate(f.dateTo) : null;
    // Make the "to" date inclusive of the whole day.
    this.toTs = endTs === null ? null : endTs + 24 * 60 * 60 * 1000 - 1;

    if (!this.filterActive) {
      this.visible = this.rows.slice();
      return;
    }
    this.visible = this.rows.filter((row) => this.matches(row));
  }

  private matches(row: Row): boolean {
    const f = this.filter;

    if (f.text.trim() !== "") {
      const q = f.text.toLowerCase();
      const cells =
        f.textCol === -1 ? row.cells : [row.cells[f.textCol] ?? ""];
      if (!cells.some((v) => (v ?? "").toLowerCase().includes(q))) return false;
    }

    if (f.dateCol !== -1 && (this.fromTs !== null || this.toTs !== null)) {
      const ts = parseDate(row.cells[f.dateCol] ?? "");
      if (ts === null) return false;
      if (this.fromTs !== null && ts < this.fromTs) return false;
      if (this.toTs !== null && ts > this.toTs) return false;
    }

    if (f.catCol !== -1 && f.catVal !== "") {
      if ((row.cells[f.catCol] ?? "") !== f.catVal) return false;
    }

    return true;
  }

  private refilterAndRender() {
    this.applyFilter();
    this.render();
    this.updateCount();
  }

  // ---- rendering --------------------------------------------------------

  private buildSkeleton() {
    this.filterBar = this.root.createDiv({ cls: "csv-filter-bar" });
    this.buildFilterBar();
    this.scroller = this.root.createDiv({ cls: "csv-scroller" });
    this.scroller.tabIndex = 0;
    this.table = this.scroller.createEl("table", { cls: "csv-table" });
  }

  private buildFilterBar() {
    const bar = this.filterBar;
    bar.empty();

    // --- text search ---
    const g1 = bar.createDiv({ cls: "csv-filter-group" });
    g1.createSpan({ cls: "csv-filter-label", text: "検索" });
    this.elTextInput = g1.createEl("input", {
      cls: "csv-filter-input",
      type: "text",
      placeholder: "キーワード…",
    });
    this.elTextInput.value = this.filter.text;
    this.elTextInput.addEventListener("input", () => {
      this.filter.text = this.elTextInput.value;
      this.refilterAndRender();
    });
    this.elTextCol = g1.createEl("select", { cls: "csv-filter-select" });
    this.elTextCol.addEventListener("change", () => {
      this.filter.textCol = parseInt(this.elTextCol.value, 10);
      this.refilterAndRender();
    });

    // --- date range ---
    const g2 = bar.createDiv({ cls: "csv-filter-group" });
    g2.createSpan({ cls: "csv-filter-label", text: "期間" });
    this.elDateCol = g2.createEl("select", { cls: "csv-filter-select" });
    this.elDateCol.addEventListener("change", () => {
      this.filter.dateCol = parseInt(this.elDateCol.value, 10);
      this.refilterAndRender();
    });
    this.elDateFrom = g2.createEl("input", { cls: "csv-filter-date", type: "date" });
    this.elDateFrom.value = this.filter.dateFrom;
    this.elDateFrom.addEventListener("change", () => {
      this.filter.dateFrom = this.elDateFrom.value;
      this.refilterAndRender();
    });
    g2.createSpan({ cls: "csv-filter-tilde", text: "〜" });
    this.elDateTo = g2.createEl("input", { cls: "csv-filter-date", type: "date" });
    this.elDateTo.value = this.filter.dateTo;
    this.elDateTo.addEventListener("change", () => {
      this.filter.dateTo = this.elDateTo.value;
      this.refilterAndRender();
    });

    // --- category / value ---
    const g3 = bar.createDiv({ cls: "csv-filter-group" });
    g3.createSpan({ cls: "csv-filter-label", text: "絞り込み" });
    this.elCatCol = g3.createEl("select", { cls: "csv-filter-select" });
    this.elCatCol.addEventListener("change", () => {
      this.filter.catCol = parseInt(this.elCatCol.value, 10);
      this.filter.catVal = "";
      this.populateCatValues();
      this.refilterAndRender();
    });
    this.elCatVal = g3.createEl("select", { cls: "csv-filter-select" });
    this.elCatVal.addEventListener("change", () => {
      this.filter.catVal = this.elCatVal.value;
      this.refilterAndRender();
    });

    // --- clear + count ---
    const g4 = bar.createDiv({ cls: "csv-filter-group csv-filter-right" });
    const clearBtn = g4.createEl("button", { cls: "csv-filter-clear", text: "クリア" });
    clearBtn.addEventListener("click", () => this.clearFilters());
    this.elCount = g4.createSpan({ cls: "csv-filter-count" });
  }

  /** Rebuild the column option lists; call whenever headers change. */
  private refreshFilterControls() {
    const colOptions = (sel: HTMLSelectElement, includeAll: string, current: number) => {
      sel.empty();
      sel.createEl("option", { value: "-1", text: includeAll });
      for (let c = 0; c < this.nCols; c++) {
        sel.createEl("option", { value: String(c), text: this.headers[c] || `列${c + 1}` });
      }
      sel.value = current < this.nCols ? String(current) : "-1";
    };
    colOptions(this.elTextCol, "全列", this.filter.textCol);
    colOptions(this.elDateCol, "日付列…", this.filter.dateCol);
    colOptions(this.elCatCol, "列…", this.filter.catCol);
    this.filter.textCol = parseInt(this.elTextCol.value, 10);
    this.filter.dateCol = parseInt(this.elDateCol.value, 10);
    this.filter.catCol = parseInt(this.elCatCol.value, 10);
    this.populateCatValues();
  }

  /** Populate the category value dropdown with distinct values of the chosen column. */
  private populateCatValues() {
    this.elCatVal.empty();
    this.elCatVal.createEl("option", { value: "", text: "すべて" });
    if (this.filter.catCol === -1) {
      this.elCatVal.disabled = true;
      return;
    }
    this.elCatVal.disabled = false;
    const seen = new Set<string>();
    for (const row of this.rows) {
      const v = row.cells[this.filter.catCol] ?? "";
      if (v !== "" && !seen.has(v)) seen.add(v);
    }
    const values = Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of values) this.elCatVal.createEl("option", { value: v, text: v });
    if (!seen.has(this.filter.catVal)) this.filter.catVal = "";
    this.elCatVal.value = this.filter.catVal;
  }

  private clearFilters() {
    this.filter = { text: "", textCol: -1, dateCol: -1, dateFrom: "", dateTo: "", catCol: -1, catVal: "" };
    this.elTextInput.value = "";
    this.elDateFrom.value = "";
    this.elDateTo.value = "";
    this.refreshFilterControls();
    this.refilterAndRender();
  }

  private updateCount() {
    const total = this.rows.length;
    const shown = this.visible.length;
    if (this.filterActive) {
      this.elCount.setText(`表示 ${shown} / 全 ${total} 行`);
      this.elCount.toggleClass("is-filtering", true);
    } else {
      this.elCount.setText(`全 ${total} 行`);
      this.elCount.toggleClass("is-filtering", false);
    }
  }

  private render() {
    this.table.empty();
    this.cellEls = [];
    this.headerEls = [];

    // Header row: corner + column headers.
    const thead = this.table.createEl("thead");
    const htr = thead.createEl("tr");
    const corner = htr.createEl("th", { cls: "csv-corner" });
    corner.addEventListener("click", () => this.selectAll());

    for (let c = 0; c < this.nCols; c++) {
      const th = htr.createEl("th", { cls: "csv-header" });
      const label = th.createSpan({ cls: "csv-header-label", text: this.headers[c] || "" });
      label.title = this.headers[c] || "";
      if (this.sortCol === c) {
        th.createSpan({ cls: "csv-sort-ind", text: this.sortDir === "asc" ? " ▲" : " ▼" });
      }
      th.addEventListener("click", () => this.toggleSort(c));
      th.addEventListener("contextmenu", (e) => this.showHeaderMenu(e, c));
      this.headerEls.push(th);
    }

    // Body rows (filtered view).
    const tbody = this.table.createEl("tbody");
    if (this.visible.length === 0) {
      const tr = tbody.createEl("tr");
      const td = tr.createEl("td", { cls: "csv-empty", attr: { colspan: String(this.nCols + 1) } });
      td.setText(this.filterActive ? "条件に一致する行がありません" : "（空）");
    }
    for (let r = 0; r < this.visible.length; r++) {
      const tr = tbody.createEl("tr");
      const gutter = tr.createEl("td", { cls: "csv-gutter", text: String(r + 1) });
      gutter.addEventListener("click", () => this.selectRow(r));

      const rowEls: HTMLElement[] = [];
      for (let c = 0; c < this.nCols; c++) {
        const td = tr.createEl("td", { cls: "csv-cell" });
        td.setText(this.visible[r].cells[c] ?? "");
        this.wireCell(td, r, c);
        rowEls.push(td);
      }
      this.cellEls.push(rowEls);
    }

    this.clampActive();
    this.paintSelection();
    this.updateCount();
  }

  private wireCell(td: HTMLElement, r: number, c: number) {
    td.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.finishEdit(true);
      if (e.shiftKey) {
        this.active = { r, c };
      } else {
        this.anchor = { r, c };
        this.active = { r, c };
      }
      this.dragging = true;
      this.scroller.focus();
      this.paintSelection();
    });
    td.addEventListener("mouseenter", () => {
      if (this.dragging) {
        this.active = { r, c };
        this.paintSelection();
      }
    });
    td.addEventListener("dblclick", () => this.beginEdit(r, c));
    td.addEventListener("contextmenu", (e) => {
      if (!this.inSelection(r, c)) {
        this.anchor = { r, c };
        this.active = { r, c };
        this.paintSelection();
      }
      this.showCellMenu(e, r, c);
    });
  }

  // ---- selection --------------------------------------------------------

  private selRect() {
    return {
      r1: Math.min(this.anchor.r, this.active.r),
      r2: Math.max(this.anchor.r, this.active.r),
      c1: Math.min(this.anchor.c, this.active.c),
      c2: Math.max(this.anchor.c, this.active.c),
    };
  }

  private inSelection(r: number, c: number): boolean {
    const s = this.selRect();
    return r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
  }

  private clampActive() {
    const maxR = Math.max(0, this.visible.length - 1);
    const maxC = Math.max(0, this.nCols - 1);
    this.active.r = Math.min(Math.max(0, this.active.r), maxR);
    this.active.c = Math.min(Math.max(0, this.active.c), maxC);
    this.anchor.r = Math.min(Math.max(0, this.anchor.r), maxR);
    this.anchor.c = Math.min(Math.max(0, this.anchor.c), maxC);
  }

  private paintSelection() {
    const s = this.selRect();
    for (let r = 0; r < this.cellEls.length; r++) {
      for (let c = 0; c < this.cellEls[r].length; c++) {
        const el = this.cellEls[r][c];
        const selected = r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
        el.toggleClass("csv-selected", selected);
        el.toggleClass("csv-active", r === this.active.r && c === this.active.c);
      }
    }
    this.scrollActiveIntoView();
  }

  private scrollActiveIntoView() {
    const el = this.cellEls[this.active.r]?.[this.active.c];
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private selectAll() {
    if (this.visible.length === 0) return;
    this.anchor = { r: 0, c: 0 };
    this.active = { r: this.visible.length - 1, c: this.nCols - 1 };
    this.scroller.focus();
    this.paintSelection();
  }

  private selectRow(r: number) {
    this.anchor = { r, c: 0 };
    this.active = { r, c: this.nCols - 1 };
    this.scroller.focus();
    this.paintSelection();
  }

  private moveActive(dr: number, dc: number, extend: boolean) {
    let r = this.active.r + dr;
    let c = this.active.c + dc;
    r = Math.min(Math.max(0, r), Math.max(0, this.visible.length - 1));
    c = Math.min(Math.max(0, c), Math.max(0, this.nCols - 1));
    this.active = { r, c };
    if (!extend) this.anchor = { r, c };
    this.paintSelection();
  }

  // ---- editing ----------------------------------------------------------

  private beginEdit(r: number, c: number, initial?: string) {
    if (this.visible.length === 0) return;
    this.finishEdit(true);
    this.anchor = { r, c };
    this.active = { r, c };
    const td = this.cellEls[r][c];
    td.empty();
    const input = td.createEl("input", { cls: "csv-cell-input", type: "text" });
    input.value = initial !== undefined ? initial : this.visible[r].cells[c] ?? "";
    this.editing = { input, r, c };
    input.focus();
    if (initial === undefined) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);

    input.addEventListener("keydown", (e) => this.onEditKeydown(e));
    input.addEventListener("blur", () => this.finishEdit(true));
  }

  private onEditKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.finishEdit(true);
      this.moveActive(e.shiftKey ? -1 : 1, 0, false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.finishEdit(true);
      this.moveActive(0, e.shiftKey ? -1 : 1, false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.finishEdit(false);
    }
    e.stopPropagation();
  }

  private finishEdit(commit: boolean) {
    if (!this.editing) return;
    const { input, r, c } = this.editing;
    const value = input.value;
    this.editing = null;
    const td = this.cellEls[r]?.[c];
    const row = this.visible[r];
    // Editing does not re-apply the filter, so a row never vanishes mid-edit.
    if (commit && row && row.cells[c] !== value) {
      row.cells[c] = value;
      this.onChange();
    }
    if (td) {
      td.empty();
      td.setText(row?.cells[c] ?? "");
    }
    this.scroller.focus();
  }

  // ---- keyboard ---------------------------------------------------------

  private attachGlobalHandlers() {
    this.scroller.addEventListener("keydown", (e) => this.onKeydown(e));
    this.scroller.addEventListener("copy", (e) => this.onCopy(e));
    this.scroller.addEventListener("cut", (e) => this.onCut(e));
    this.scroller.addEventListener("paste", (e) => this.onPaste(e));
    this.root.addEventListener("mouseup", () => (this.dragging = false));
  }

  private onKeydown(e: KeyboardEvent) {
    if (this.editing) return;
    const ctrl = e.metaKey || e.ctrlKey;

    if (ctrl && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (ctrl && ["c", "x", "v"].includes(e.key.toLowerCase())) return;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        this.moveActive(-1, 0, e.shiftKey);
        return;
      case "ArrowDown":
        e.preventDefault();
        this.moveActive(1, 0, e.shiftKey);
        return;
      case "ArrowLeft":
        e.preventDefault();
        this.moveActive(0, -1, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        this.moveActive(0, 1, e.shiftKey);
        return;
      case "Tab":
        e.preventDefault();
        this.moveActive(0, e.shiftKey ? -1 : 1, false);
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        this.beginEdit(this.active.r, this.active.c);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        this.clearSelection();
        return;
    }

    if (e.key.length === 1 && !ctrl && !e.altKey) {
      e.preventDefault();
      this.beginEdit(this.active.r, this.active.c, e.key);
    }
  }

  // ---- clipboard --------------------------------------------------------

  private selectionMatrix(): string[][] {
    const s = this.selRect();
    const out: string[][] = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const line: string[] = [];
      for (let c = s.c1; c <= s.c2; c++) line.push(this.visible[r]?.cells[c] ?? "");
      out.push(line);
    }
    return out;
  }

  private onCopy(e: ClipboardEvent) {
    if (this.editing) return;
    e.preventDefault();
    const matrix = this.selectionMatrix();
    this.internalClipboard = matrix;
    e.clipboardData?.setData("text/plain", matrixToTSV(matrix));
  }

  private onCut(e: ClipboardEvent) {
    if (this.editing) return;
    this.onCopy(e);
    this.clearSelection();
  }

  private onPaste(e: ClipboardEvent) {
    if (this.editing) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain");
    const matrix = text ? parseClipboard(text) : this.internalClipboard;
    if (matrix) this.pasteMatrix(matrix);
  }

  private pasteMatrix(matrix: string[][]) {
    const s = this.selRect();
    const startR = s.r1;
    const startC = s.c1;
    const pasteCols = Math.max(...matrix.map((row) => row.length));
    const needCols = startC + pasteCols;

    while (this.nCols < needCols) this.addColumnAt(this.nCols, false, false);

    // Fill into existing visible rows; append new canonical rows if needed.
    for (let i = 0; i < matrix.length; i++) {
      const vr = startR + i;
      let row = this.visible[vr];
      if (!row) {
        row = { id: this.nextId++, cells: new Array(this.nCols).fill("") };
        this.rows.push(row);
        this.visible.push(row);
      }
      for (let j = 0; j < matrix[i].length; j++) {
        row.cells[startC + j] = matrix[i][j];
      }
    }
    this.anchor = { r: startR, c: startC };
    this.active = {
      r: Math.min(startR + matrix.length - 1, this.visible.length - 1),
      c: Math.min(needCols - 1, this.nCols - 1),
    };
    this.refilterAndRender();
    this.onChange();
  }

  private clearSelection() {
    const s = this.selRect();
    let changed = false;
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        const row = this.visible[r];
        if (row?.cells[c]) {
          row.cells[c] = "";
          this.cellEls[r][c].setText("");
          changed = true;
        }
      }
    }
    if (changed) this.onChange();
  }

  // ---- sorting ----------------------------------------------------------

  private toggleSort(col: number) {
    if (this.sortCol === col) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortCol = col;
      this.sortDir = "asc";
    }
    const dir = this.sortDir === "asc" ? 1 : -1;
    this.rows.sort((a, b) => compareValues(a.cells[col] ?? "", b.cells[col] ?? "") * dir);
    this.refilterAndRender();
  }

  private clearSort() {
    if (this.sortCol === null) return;
    this.sortCol = null;
    this.rows.sort((a, b) => a.id - b.id);
    this.refilterAndRender();
  }

  // ---- structural edits -------------------------------------------------

  private addRowAt(visibleIndex: number, below: boolean, focus: boolean) {
    this.bake();
    const row: Row = { id: this.nextId++, cells: new Array(this.nCols).fill("") };
    let insertAt: number;
    if (this.visible.length === 0) {
      insertAt = this.rows.length;
    } else {
      const ref = Math.min(visibleIndex, this.visible.length - 1);
      insertAt = this.baseIndex(ref) + (below ? 1 : 0);
    }
    this.rows.splice(insertAt, 0, row);
    this.applyFilter();
    if (focus) {
      const vr = this.visible.indexOf(row);
      if (vr !== -1) {
        this.anchor = { r: vr, c: 0 };
        this.active = { r: vr, c: 0 };
      }
    }
    this.render();
    this.populateCatValues();
    this.onChange();
  }

  private deleteRowsInSelection() {
    this.bake();
    const s = this.selRect();
    const toRemove = new Set<Row>();
    for (let r = s.r1; r <= s.r2; r++) {
      if (this.visible[r]) toRemove.add(this.visible[r]);
    }
    this.rows = this.rows.filter((row) => !toRemove.has(row));
    if (this.rows.length === 0) {
      this.rows.push({ id: this.nextId++, cells: new Array(this.nCols).fill("") });
    }
    this.applyFilter();
    this.active = { r: Math.min(s.r1, Math.max(0, this.visible.length - 1)), c: this.active.c };
    this.anchor = { ...this.active };
    this.render();
    this.populateCatValues();
    this.onChange();
  }

  private addColumnAt(index: number, focus: boolean, rerender = true) {
    this.headers.splice(index, 0, "");
    for (const row of this.rows) row.cells.splice(index, 0, "");
    // Shift filter column references that sit at/after the insertion point.
    if (this.filter.textCol >= index) this.filter.textCol++;
    if (this.filter.dateCol >= index) this.filter.dateCol++;
    if (this.filter.catCol >= index) this.filter.catCol++;
    if (focus) {
      this.anchor = { r: this.active.r, c: index };
      this.active = { r: this.active.r, c: index };
    }
    if (rerender) {
      this.refreshFilterControls();
      this.render();
      this.onChange();
    }
  }

  private deleteColumnsInSelection() {
    const s = this.selRect();
    const count = s.c2 - s.c1 + 1;
    if (count >= this.nCols) return; // keep at least one column
    this.headers.splice(s.c1, count);
    for (const row of this.rows) row.cells.splice(s.c1, count);
    // Reset any filter column that pointed into the removed range.
    const fix = (col: number) => {
      if (col === -1) return -1;
      if (col >= s.c1 && col <= s.c2) return -1;
      return col > s.c2 ? col - count : col;
    };
    this.filter.textCol = fix(this.filter.textCol);
    this.filter.dateCol = fix(this.filter.dateCol);
    this.filter.catCol = fix(this.filter.catCol);
    this.active = { r: this.active.r, c: Math.min(s.c1, this.nCols - 1) };
    this.anchor = { ...this.active };
    this.refreshFilterControls();
    this.refilterAndRender();
    this.onChange();
  }

  private renameColumn(col: number) {
    const th = this.headerEls[col];
    th.empty();
    const input = th.createEl("input", { cls: "csv-cell-input", type: "text" });
    input.value = this.headers[col] ?? "";
    input.focus();
    input.select();
    const commit = (save: boolean) => {
      if (save && this.headers[col] !== input.value) {
        this.headers[col] = input.value;
        this.onChange();
      }
      this.refreshFilterControls();
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
  }

  // ---- context menus ----------------------------------------------------

  private showCellMenu(e: MouseEvent, r: number, c: number) {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("コピー").setIcon("copy").onClick(() => this.menuCopy(false)));
    menu.addItem((i) => i.setTitle("切り取り").setIcon("scissors").onClick(() => this.menuCopy(true)));
    menu.addItem((i) => i.setTitle("貼り付け").setIcon("clipboard-paste").onClick(() => this.menuPaste()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("上に行を挿入").setIcon("arrow-up").onClick(() => this.addRowAt(r, false, true)));
    menu.addItem((i) => i.setTitle("下に行を挿入").setIcon("arrow-down").onClick(() => this.addRowAt(r, true, true)));
    menu.addItem((i) => i.setTitle("行を削除").setIcon("trash").onClick(() => this.deleteRowsInSelection()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("左に列を挿入").setIcon("arrow-left").onClick(() => this.addColumnAt(c, true)));
    menu.addItem((i) => i.setTitle("右に列を挿入").setIcon("arrow-right").onClick(() => this.addColumnAt(c + 1, true)));
    menu.addItem((i) => i.setTitle("列を削除").setIcon("trash").onClick(() => this.deleteColumnsInSelection()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("セルをクリア").setIcon("eraser").onClick(() => this.clearSelection()));
    menu.showAtMouseEvent(e);
  }

  private showHeaderMenu(e: MouseEvent, c: number) {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("列名を変更").setIcon("pencil").onClick(() => this.renameColumn(c)));
    menu.addItem((i) =>
      i.setTitle("昇順で並べ替え").setIcon("arrow-up-narrow-wide").onClick(() => {
        this.sortCol = c;
        this.sortDir = "desc"; // toggleSort flips it to asc
        this.toggleSort(c);
      })
    );
    menu.addItem((i) =>
      i.setTitle("降順で並べ替え").setIcon("arrow-down-wide-narrow").onClick(() => {
        this.sortCol = c;
        this.sortDir = "asc"; // toggleSort flips it to desc
        this.toggleSort(c);
      })
    );
    menu.addItem((i) => i.setTitle("並べ替えを解除").setIcon("x").onClick(() => this.clearSort()));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("この列で絞り込み").setIcon("filter").onClick(() => {
        this.filter.catCol = c;
        this.filter.catVal = "";
        this.refreshFilterControls();
        this.elCatCol.value = String(c);
        this.refilterAndRender();
      })
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("左に列を挿入").setIcon("arrow-left").onClick(() => this.addColumnAt(c, true)));
    menu.addItem((i) => i.setTitle("右に列を挿入").setIcon("arrow-right").onClick(() => this.addColumnAt(c + 1, true)));
    menu.addItem((i) =>
      i.setTitle("列を削除").setIcon("trash").onClick(() => {
        this.anchor = { r: this.active.r, c };
        this.active = { r: this.active.r, c };
        this.deleteColumnsInSelection();
      })
    );
    menu.showAtMouseEvent(e);
  }

  // ---- menu-driven clipboard (async API with internal fallback) ---------

  private async menuCopy(cut: boolean) {
    const matrix = this.selectionMatrix();
    this.internalClipboard = matrix;
    try {
      await navigator.clipboard.writeText(matrixToTSV(matrix));
    } catch {
      /* fall back to the internal buffer */
    }
    if (cut) this.clearSelection();
  }

  private async menuPaste() {
    let matrix = this.internalClipboard;
    try {
      const text = await navigator.clipboard.readText();
      if (text) matrix = parseClipboard(text);
    } catch {
      /* fall back to the internal buffer */
    }
    if (matrix) this.pasteMatrix(matrix);
  }
}

/** Numbers sort numerically; everything else sorts as case-insensitive text. */
function compareValues(a: string, b: string): number {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  const aNum = a.trim() !== "" && !isNaN(na);
  const bNum = b.trim() !== "" && !isNaN(nb);
  if (aNum && bNum) return na - nb;
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/** Parse a date-ish string to a local-midnight timestamp, or null. */
function parseDate(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.getTime();
}
