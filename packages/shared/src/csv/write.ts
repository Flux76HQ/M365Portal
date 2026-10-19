// The CSV writer of the exports (T-D-201, FR-D-403, ADR 0182): pure functions, no dependency. The writer is
// ours because the library would add weight and the injection rule is the panel's own.
//
//   - a field that a spreadsheet would read as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a
//     carriage return) gets ONE space in front of it, so that it is text in Excel, LibreOffice and Google
//     Sheets, and no apostrophe ends up in an importer. The rule is applied to every field, the header
//     included, before the field is quoted;
//   - a field is quoted (RFC 4180) when it holds the separator, a quote, a line break, or starts or ends
//     with a space; a quote inside is doubled;
//   - a row ends with CRLF, as RFC 4180 has it. A value is data: it never changes a separator or a row.
//
// `parseCsv` is NOT here: the property test brings its own, independent parser, so that the writer is
// not checked against itself.

/** The two separators of an export: the comma, and the semicolon that Dutch Excel opens as columns. */
export type CsvSeparator = ',' | ';';

/** The first characters that make a spreadsheet read a field as a formula (OWASP "CSV injection"). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** The field as text for a spreadsheet: one space in front of anything that could be a formula. */
export function neutraliseFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? ` ${value}` : value;
}

/** One field, neutralised and quoted when RFC 4180 needs it. */
export function csvField(value: string, separator: CsvSeparator): string {
  const safe = neutraliseFormula(value);
  const needsQuotes =
    safe.includes(separator) ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r') ||
    safe.startsWith(' ') ||
    safe.endsWith(' ');
  return needsQuotes ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One row with its line break. */
export function csvRow(values: readonly string[], separator: CsvSeparator): string {
  return `${values.map((value) => csvField(value, separator)).join(separator)}\r\n`;
}

/** The byte order mark of UTF-8: Excel opens a file with it as UTF-8 instead of the system code page. */
export const CSV_BOM = '﻿';
