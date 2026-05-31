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
  r: number; // index into this.rows (display order)
  c: number; // column index
}

/**
 * A vanilla-TS spreadsheet grid for a single CSV file. Owns the data model,
 * rendering, keyboard navigation, range selection, clipboard, and sorting.
 * It reports edits through the `onChange` callback; persistence is the
 * caller's job.
 */
export class CSVGrid {
  private headers: string[] = [""];
  private rows: Row[] = [];
  private nextId = 0;

  private sortCol: number | null = null;
  private sortDir: "asc" | "desc" = "asc";

  private anchor: Cell = { r: 0, c: 0 };
  private active: Cell = { r: 0, c: 0 };

  private cellEls: HTMLElement[][] = [];
  private headerEls: HTMLElement[] = [];

  private root: HTMLElement;
  private scroller!: HTMLElement;
  private table!: HTMLTableElement;
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

  /** "Bake" the current display order into the canonical order. Called before
   *  structural edits so inserts/deletes apply to what the user actually sees. */
  private bake() {
    if (this.sortCol === null) return;
    this.rows.forEach((row, i) => (row.id = i));
    this.sortCol = null;
  }

  // ---- rendering --------------------------------------------------------

  private buildSkeleton() {
    this.scroller = this.root.createDiv({ cls: "csv-scroller" });
    this.scroller.tabIndex = 0;
    this.table = this.scroller.createEl("table", { cls: "csv-table" });
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

    // Body rows.
    const tbody = this.table.createEl("tbody");
    for (let r = 0; r < this.rows.length; r++) {
      const tr = tbody.createEl("tr");
      const gutter = tr.createEl("td", { cls: "csv-gutter", text: String(r + 1) });
      gutter.addEventListener("click", () => this.selectRow(r));

      const rowEls: HTMLElement[] = [];
      for (let c = 0; c < this.nCols; c++) {
        const td = tr.createEl("td", { cls: "csv-cell" });
        td.setText(this.rows[r].cells[c] ?? "");
        this.wireCell(td, r, c);
        rowEls.push(td);
      }
      this.cellEls.push(rowEls);
    }

    this.clampActive();
    this.paintSelection();
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
    const maxR = Math.max(0, this.rows.length - 1);
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
    if (this.rows.length === 0) return;
    this.anchor = { r: 0, c: 0 };
    this.active = { r: this.rows.length - 1, c: this.nCols - 1 };
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
    r = Math.min(Math.max(0, r), Math.max(0, this.rows.length - 1));
    c = Math.min(Math.max(0, c), Math.max(0, this.nCols - 1));
    this.active = { r, c };
    if (!extend) this.anchor = { r, c };
    this.paintSelection();
  }

  // ---- editing ----------------------------------------------------------

  private beginEdit(r: number, c: number, initial?: string) {
    this.finishEdit(true);
    this.anchor = { r, c };
    this.active = { r, c };
    const td = this.cellEls[r][c];
    td.empty();
    const input = td.createEl("input", { cls: "csv-cell-input", type: "text" });
    input.value = initial !== undefined ? initial : this.rows[r].cells[c] ?? "";
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
    // Otherwise let the input handle the keystroke.
    e.stopPropagation();
  }

  private finishEdit(commit: boolean) {
    if (!this.editing) return;
    const { input, r, c } = this.editing;
    const value = input.value;
    this.editing = null;
    const td = this.cellEls[r]?.[c];
    if (commit && this.rows[r] && this.rows[r].cells[c] !== value) {
      this.rows[r].cells[c] = value;
      this.onChange();
    }
    if (td) {
      td.empty();
      td.setText(this.rows[r]?.cells[c] ?? "");
    }
    this.scroller.focus();
  }

  // ---- keyboard ---------------------------------------------------------

  private attachGlobalHandlers() {
    this.scroller.addEventListener("keydown", (e) => this.onKeydown(e));
    this.scroller.addEventListener("copy", (e) => this.onCopy(e));
    this.scroller.addEventListener("cut", (e) => this.onCut(e));
    this.scroller.addEventListener("paste", (e) => this.onPaste(e));
    // End a drag even if the pointer leaves the grid.
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
    // Let copy/cut/paste flow through to the native clipboard events.
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
        e.preventDefault();
        this.beginEdit(this.active.r, this.active.c);
        return;
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

    // Printable character → start editing with it.
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
      for (let c = s.c1; c <= s.c2; c++) line.push(this.rows[r]?.cells[c] ?? "");
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
    const needRows = startR + matrix.length;
    const needCols = startC + Math.max(...matrix.map((row) => row.length));

    while (this.nCols < needCols) this.addColumnAt(this.nCols, false);
    while (this.rows.length < needRows) {
      this.rows.push({ id: this.nextId++, cells: new Array(this.nCols).fill("") });
    }

    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        this.rows[startR + i].cells[startC + j] = matrix[i][j];
      }
    }
    this.anchor = { r: startR, c: startC };
    this.active = {
      r: Math.min(startR + matrix.length - 1, this.rows.length - 1),
      c: Math.min(needCols - 1, this.nCols - 1),
    };
    this.render();
    this.onChange();
  }

  private clearSelection() {
    const s = this.selRect();
    let changed = false;
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        if (this.rows[r]?.cells[c]) {
          this.rows[r].cells[c] = "";
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
    this.render();
  }

  private clearSort() {
    if (this.sortCol === null) return;
    this.sortCol = null;
    this.rows.sort((a, b) => a.id - b.id);
    this.render();
  }

  // ---- structural edits -------------------------------------------------

  private addRowAt(index: number, focus: boolean) {
    this.bake();
    const row: Row = { id: this.nextId++, cells: new Array(this.nCols).fill("") };
    this.rows.splice(index, 0, row);
    if (focus) {
      this.anchor = { r: index, c: 0 };
      this.active = { r: index, c: 0 };
    }
    this.render();
    this.onChange();
  }

  private deleteRowsInSelection() {
    this.bake();
    const s = this.selRect();
    this.rows.splice(s.r1, s.r2 - s.r1 + 1);
    if (this.rows.length === 0) {
      this.rows.push({ id: this.nextId++, cells: new Array(this.nCols).fill("") });
    }
    this.active = { r: Math.min(s.r1, this.rows.length - 1), c: this.active.c };
    this.anchor = { ...this.active };
    this.render();
    this.onChange();
  }

  private addColumnAt(index: number, focus: boolean) {
    this.headers.splice(index, 0, "");
    for (const row of this.rows) row.cells.splice(index, 0, "");
    if (focus) {
      this.anchor = { r: this.active.r, c: index };
      this.active = { r: this.active.r, c: index };
    }
    this.render();
    this.onChange();
  }

  private deleteColumnsInSelection() {
    const s = this.selRect();
    const count = s.c2 - s.c1 + 1;
    if (count >= this.nCols) return; // keep at least one column
    this.headers.splice(s.c1, count);
    for (const row of this.rows) row.cells.splice(s.c1, count);
    this.active = { r: this.active.r, c: Math.min(s.c1, this.nCols - 1) };
    this.anchor = { ...this.active };
    this.render();
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
    menu.addItem((i) =>
      i.setTitle("Copy").setIcon("copy").onClick(() => this.menuCopy(false))
    );
    menu.addItem((i) =>
      i.setTitle("Cut").setIcon("scissors").onClick(() => this.menuCopy(true))
    );
    menu.addItem((i) =>
      i.setTitle("Paste").setIcon("clipboard-paste").onClick(() => this.menuPaste())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Insert row above").setIcon("arrow-up").onClick(() => this.addRowAt(r, true))
    );
    menu.addItem((i) =>
      i.setTitle("Insert row below").setIcon("arrow-down").onClick(() => this.addRowAt(r + 1, true))
    );
    menu.addItem((i) =>
      i.setTitle("Delete row(s)").setIcon("trash").onClick(() => this.deleteRowsInSelection())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Insert column left").setIcon("arrow-left").onClick(() => this.addColumnAt(c, true))
    );
    menu.addItem((i) =>
      i.setTitle("Insert column right").setIcon("arrow-right").onClick(() => this.addColumnAt(c + 1, true))
    );
    menu.addItem((i) =>
      i.setTitle("Delete column(s)").setIcon("trash").onClick(() => this.deleteColumnsInSelection())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Clear cell(s)").setIcon("eraser").onClick(() => this.clearSelection())
    );
    menu.showAtMouseEvent(e);
  }

  private showHeaderMenu(e: MouseEvent, c: number) {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Rename column").setIcon("pencil").onClick(() => this.renameColumn(c))
    );
    menu.addItem((i) =>
      i.setTitle("Sort ascending").setIcon("arrow-up-narrow-wide").onClick(() => {
        this.sortCol = c;
        this.sortDir = "desc"; // toggleSort flips it to asc
        this.toggleSort(c);
      })
    );
    menu.addItem((i) =>
      i.setTitle("Sort descending").setIcon("arrow-down-wide-narrow").onClick(() => {
        this.sortCol = c;
        this.sortDir = "asc"; // toggleSort flips it to desc
        this.toggleSort(c);
      })
    );
    menu.addItem((i) =>
      i.setTitle("Clear sort").setIcon("x").onClick(() => this.clearSort())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Insert column left").setIcon("arrow-left").onClick(() => this.addColumnAt(c, true))
    );
    menu.addItem((i) =>
      i.setTitle("Insert column right").setIcon("arrow-right").onClick(() => this.addColumnAt(c + 1, true))
    );
    menu.addItem((i) =>
      i.setTitle("Delete column").setIcon("trash").onClick(() => {
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
