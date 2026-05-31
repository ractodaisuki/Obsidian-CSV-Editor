/**
 * RFC 4180 compliant CSV parse / serialize.
 *
 * The parser handles quoted fields, embedded delimiters / quotes / newlines,
 * and both LF and CRLF line endings. The serializer quotes any field that
 * contains the delimiter, a double quote, or a line break, and doubles
 * embedded quotes.
 */

/** Parse CSV text into a matrix of rows. Always returns at least one row. */
export function parseCSV(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
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
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      endRow();
      if (text[i + 1] === "\n") i += 2;
      else i++;
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

  // Flush the trailing field/row (the file may not end with a newline).
  endRow();

  // A file ending in a newline produces a spurious final [""] row; drop it.
  if (
    rows.length > 1 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === ""
  ) {
    rows.pop();
  }

  if (rows.length === 0) rows.push([""]);

  return normalizeWidth(rows);
}

/** Pad every row to the width of the widest row so the grid is rectangular. */
export function normalizeWidth(rows: string[][]): string[][] {
  let cols = 0;
  for (const r of rows) cols = Math.max(cols, r.length);
  if (cols === 0) cols = 1;
  for (const r of rows) {
    while (r.length < cols) r.push("");
  }
  return rows;
}

/** Serialize a matrix back to CSV text. */
export function serializeCSV(rows: string[][], delimiter: string): string {
  return rows
    .map((row) => row.map((field) => quoteField(field, delimiter)).join(delimiter))
    .join("\n");
}

function quoteField(field: string, delimiter: string): string {
  const needsQuote =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r");
  if (!needsQuote) return field;
  return '"' + field.replace(/"/g, '""') + '"';
}
