/**
 * Minimal, strict RFC-4180-style CSV parsing for the import pipeline
 * (#imports). Only what the pipeline needs:
 *
 * - quoted fields with doubled-quote escapes
 * - CRLF / LF line endings and a UTF-8 BOM
 * - row/line tracking so quarantine reports point at the source
 *
 * Malformed input (unterminated quote, oversized row) is reported as a parse
 * error instead of being guessed at, so operators get a deterministic
 * preview.
 */

export type CsvRow = {
  /** 1-based row number in the source file, counting the header row. */
  row_number: number;
  cells: string[];
};

export type CsvParseResult = {
  headers: string[];
  rows: CsvRow[];
  error?: string;
};

const MAX_CELL_CHARS = 200_000;

export function parseCsv(text: string, options: { maxRows?: number } = {}): CsvParseResult {
  const maxRows = options.maxRows ?? Number.MAX_SAFE_INTEGER;

  // Strip a UTF-8 BOM if present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldLength = 0;
  let sawAnyCharInRow = false;

  const pushField = () => {
    row.push(field);
    field = "";
    fieldLength = 0;
  };
  const pushRow = () => {
    pushField();
    // Skip fully empty lines (e.g. trailing newline or blank separator).
    const isEmpty = row.length === 1 && row[0] === "" && !sawAnyCharInRow;
    if (!isEmpty) rows.push(row);
    row = [];
    sawAnyCharInRow = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          fieldLength += 1;
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
        fieldLength += 1;
      }
    } else if (char === '"' && field.length === 0) {
      inQuotes = true;
      sawAnyCharInRow = true;
    } else if (char === ",") {
      pushField();
      sawAnyCharInRow = true;
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // Swallow CR; the following LF terminates the row. A lone CR also ends
      // the row so CR-only files still parse.
      if (input[i + 1] !== "\n") pushRow();
    } else {
      field += char;
      fieldLength += 1;
      sawAnyCharInRow = true;
    }

    if (fieldLength > MAX_CELL_CHARS) {
      return { headers: [], rows: [], error: `cell exceeds ${MAX_CELL_CHARS} characters` };
    }
    if (rows.length > maxRows + 1) {
      return { headers: [], rows: [], error: `more than ${maxRows} data rows` };
    }
  }

  if (inQuotes) {
    return { headers: [], rows: [], error: "unterminated quoted field" };
  }

  // Flush the final field/row when the file does not end with a newline.
  if (field.length > 0 || row.length > 0 || sawAnyCharInRow) {
    pushRow();
  }

  if (rows.length > maxRows + 1) {
    return { headers: [], rows: [], error: `more than ${maxRows} data rows` };
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], error: "file contains no rows" };
  }

  const headerRow = rows[0] as string[];
  const headers = headerRow.map((h) => h.trim().toLowerCase());
  const dataRows: CsvRow[] = rows.slice(1).map((cells, index) => ({
    row_number: index + 2,
    cells
  }));

  return { headers, rows: dataRows };
}
