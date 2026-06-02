# Obsidian CSV Editor

Open and edit `.csv` files inside Obsidian as a spreadsheet-like grid instead
of plain text. Inspired by [Brian Sunter's Obsidian CSV Editor](https://briansunter.com/projects/obsidian-csv-editor),
re-implemented in dependency-free TypeScript (no React).

## Features

- **Native CSV view** – `.csv` files open in the grid automatically; no command needed.
- **Keyboard-first editing**
  - Arrow keys to navigate
  - `Tab` / `Shift+Tab` to move between cells
  - `Enter` / `Shift+Enter` to commit and move down/up
  - Type to start editing; `F2` / `Enter` to edit explicitly; `Esc` to cancel
- **Range selection & clipboard** – Shift+Click, Shift+Arrow, or click-and-drag to
  select a rectangle. `Cmd/Ctrl+C/X/V` act on the whole range. Pasting tab-separated
  content from Excel / Google Sheets / Numbers fills from the active cell, expanding
  rows and columns as needed.
- **Right-click context menu** – insert / delete rows and columns, clear cells,
  copy / cut / paste, rename / sort columns.
- **Column sorting** – click a header to sort asc/desc. Sorting is non-destructive:
  saving writes back the original on-disk row order (until you make a structural edit).
- **Search & filter** – a filter bar above the grid combines three filters (AND):
  - **検索 (search)**: substring match across all columns or one chosen column
  - **期間 (date range)**: pick a date column and a from/to range (parses
    `yyyy-mm-dd`, `yyyy/mm/dd`, etc.)
  - **絞り込み (value filter)**: pick a column and choose one of its distinct
    values (e.g. a category)

  Filtering is non-destructive like sorting: hidden rows are still saved, and
  editing a visible cell updates the underlying row without re-hiding it.
- **Configurable delimiter** – comma, semicolon, tab, or pipe (RFC 4180 quoting on save).
- **Auto-save** – debounced (default 300 ms, configurable 100–2000 ms), or toggle it
  off and use the toolbar **Save** button / `Cmd+S`.
- **Theme-aware** – colors follow your Obsidian theme via CSS variables.
- **Mobile compatible** – no desktop-only APIs.

## Project structure

```
src/
├── main.ts            # Plugin entry: registers the view + settings tab
├── csvView.ts         # TextFileView that hosts the grid + toolbar / auto-save
├── grid.ts            # Grid: rendering, selection, clipboard, sorting, edits
├── csvParser.ts       # RFC 4180 parse / serialize
├── clipboardUtils.ts  # Range <-> TSV helpers for copy/paste
└── settings.ts        # Settings tab and defaults
```

## Build

```bash
npm install
npm run build      # type-check + bundle to main.js
npm run dev        # watch mode
```

The build produces `main.js`. Together with `manifest.json` and `styles.css` it
forms the installable plugin.

## Install into a vault (manual)

1. Run `npm run build`.
2. Create a folder `<your-vault>/.obsidian/plugins/csv-editor/`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into it.
4. In Obsidian: **Settings → Community plugins**, enable *Community plugins* if
   needed, then toggle on **CSV Editor**.
5. Open any `.csv` file in your vault.

> Tip for development: symlink the repo into the plugins folder so a rebuild is
> picked up by Obsidian's reload (Cmd+R or the Hot-Reload plugin):
> ```bash
> ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/csv-editor"
> ```

## License

MIT
