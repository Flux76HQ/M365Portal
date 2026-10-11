// The four CHECK shapes that recur dozens of times in the Phase B migration (data-model section 4,
// FR-B-701, PB-26). They are functions that return the SQL fragment, so the text drizzle-kit writes
// into `0001_phase_b.sql` comes from the same code the Drizzle schema (`schema/phase-b.ts`) uses,
// and the two cannot differ.
//
// An argument `c` is an SQL expression exactly as it is to appear (a backtick-quoted column name in
// the schema); the functions neither quote nor check it. The definitions are normative and copied
// from data-model section 4:
//
//   GUID(c)       lower-case canonical GUID text, any version (GLOB is case-sensitive)
//   ISO(c)        the Phase A time shape: UTC, milliseconds, trailing Z (a shape, not a calendar check)
//   HEX(c, n)     exactly n lower-case hexadecimal characters
//   JSONOBJ(c, m) a JSON object of at most m UTF-8 bytes (CAST to BLOB counts bytes)
//
// `expandCheckMacros` turns the notation of data-model section 5 (`GUID(`oid`)`) into the expanded
// SQL; the document test (`migrations.doc.test.ts`) uses it to compare the document with the
// committed migration. It expands those four macros and nothing else.

const HEX_DIGIT = '[0-9a-f]';

function repeat(pattern: string, count: number): string {
  return pattern.repeat(count);
}

const GUID_GLOB = [8, 4, 4, 4, 12].map((count) => repeat(HEX_DIGIT, count)).join('-');
const ISO_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';

/** `(length(c) = 36 AND c GLOB '<8-4-4-4-12 lower-case hex>')` */
export function guid(c: string): string {
  return `(length(${c}) = 36 AND ${c} GLOB '${GUID_GLOB}')`;
}

/** `c GLOB '<yyyy-mm-ddThh:mm:ss.mmmZ>'` */
export function iso(c: string): string {
  return `${c} GLOB '${ISO_GLOB}'`;
}

/** `(length(c) = n AND c NOT GLOB '*[^0-9a-f]*')` */
export function hex(c: string, n: number): string {
  return `(length(${c}) = ${String(n)} AND ${c} NOT GLOB '*[^0-9a-f]*')`;
}

/** `(json_valid(c) = 1 AND json_type(c) = 'object' AND length(CAST(c AS BLOB)) <= m)` */
export function jsonObject(c: string, m: number): string {
  return `(json_valid(${c}) = 1 AND json_type(${c}) = 'object' AND length(CAST(${c} AS BLOB)) <= ${String(m)})`;
}

/** The notation of data-model section 5: `GUID(x)`, `ISO(x)`, `HEX(x, n)`, `JSONOBJ(x, m)`. */
const MACRO = /\b(GUID|ISO|HEX|JSONOBJ)\(([^(),]+)(?:,\s*(\d+))?\)/g;

/**
 * Replace every macro of the notation with its expansion. Text that is not one of the four macros
 * (including lower-case SQL functions such as `hex(...)`) is left alone, and so is a macro with the
 * wrong number of arguments.
 */
export function expandCheckMacros(text: string): string {
  return text.replace(MACRO, (whole, name: string, column: string, number: string | undefined) => {
    const c = column.trim();
    switch (name) {
      case 'GUID':
        return number === undefined ? guid(c) : whole;
      case 'ISO':
        return number === undefined ? iso(c) : whole;
      case 'HEX':
        return number === undefined ? whole : hex(c, Number(number));
      case 'JSONOBJ':
        return number === undefined ? whole : jsonObject(c, Number(number));
      default:
        return whole;
    }
  });
}
