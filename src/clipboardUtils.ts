/**
 * Helpers for moving rectangular ranges in and out of the clipboard as
 * tab-separated values (the format Excel / Google Sheets / Numbers use).
 */

/** Convert a matrix to TSV text, quoting fields that need it. */
export function matrixToTSV(matrix: string[][]): string {
  return matrix
    .map((row) => row.map(quoteTSVField).join("\t"))
    .join("\n");
}

function quoteTSVField(field: string): string {
  if (field.includes("\t") || field.includes("\n") || field.includes("\r") || field.includes('"')) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

/**
 * Parse clipboard text (TSV, or CSV-ish) into a matrix. Splits on tabs and
 * newlines while respecting double-quoted fields so pasted blocks that
 * contain newlines inside a cell stay intact.
 */
export function parseClipboard(text: string): string[][] {
  // Strip a single trailing newline so a copied block doesn't gain a blank row.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < normalized.length) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      endField();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  endRow();

  if (rows.length === 0) rows.push([""]);
  return rows;
}
