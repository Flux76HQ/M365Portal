// T-D-201, FR-D-402, FR-D-403, EC-D12, SC-D-004, ADR-0184: the CSV writer. Every leading character that a
// spreadsheet reads as a formula, quoting and separators, and a seeded property test (20,000 cases) that
// parses the output with a parser written HERE, independent of the writer, and checks that every value comes
// back as itself plus the one documented space.
import { describe, expect, it } from 'vitest';
import { EXPORT_COLUMNS, EXPORT_HEADERS, resolveExportOptions } from '../src/csv/presets.js';
import {
  CSV_BOM,
  csvField,
  csvRow,
  neutraliseFormula,
  type CsvSeparator,
} from '../src/csv/write.js';
import { ExportOptionsSchema } from '../src/schemas/export.js';

/** A strict RFC 4180 reader: quoted fields with doubled quotes, CRLF rows, any character inside quotes. */
function parseCsv(text: string, separator: CsvSeparator): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\r' && text.charAt(index + 1) === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else {
      field += char;
    }
  }
  if (quoted || field !== '' || row.length > 0) throw new Error('the text does not end in CRLF');
  return rows;
}

describe('neutraliseFormula (FR-D-403, EC-D12)', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'puts one space in front of a value that starts with %j',
    (lead) => {
      expect(neutraliseFormula(`${lead}1+1`)).toBe(` ${lead}1+1`);
      expect(neutraliseFormula(lead)).toBe(` ${lead}`);
    },
  );

  it('leaves everything else as it is, including a lead in the middle', () => {
    for (const value of [
      '',
      'Alice',
      'a=b',
      'x@y.nl',
      ' =already',
      '1+1',
      "'=a",
      '#a',
      '|cmd',
      '%a',
    ]) {
      expect(neutraliseFormula(value)).toBe(value);
    }
  });

  it('makes =HYPERLINK(...) text', () => {
    const value = '=HYPERLINK("http://evil.example","x")';
    expect(csvField(value, ',')).toBe('" =HYPERLINK(""http://evil.example"",""x"")"');
    expect(csvRow([value, 'a'], ';')).toBe('" =HYPERLINK(""http://evil.example"",""x"")";a\r\n');
  });
});

describe('csvField and csvRow (RFC 4180)', () => {
  it('quotes a field with the separator, a quote, a line break or a space at an end, and no other', () => {
    expect(csvField('plain', ',')).toBe('plain');
    expect(csvField('a;b', ',')).toBe('a;b');
    expect(csvField('a;b', ';')).toBe('"a;b"');
    expect(csvField('a,b', ',')).toBe('"a,b"');
    expect(csvField('say "hi"', ',')).toBe('"say ""hi"""');
    expect(csvField('one\ntwo', ',')).toBe('"one\ntwo"');
    expect(csvField('one\r\ntwo', ',')).toBe('"one\r\ntwo"');
    expect(csvField(' padded ', ',')).toBe('" padded "');
    expect(csvField('', ',')).toBe('');
  });

  it('ends a row with CRLF and joins with the separator', () => {
    expect(csvRow(['a', 'b', ''], ',')).toBe('a,b,\r\n');
    expect(csvRow(['a', 'b'], ';')).toBe('a;b\r\n');
    expect(CSV_BOM).toBe('﻿');
  });
});

/** Mulberry32: a small seeded generator, so a failure can be repeated. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the round trip (SC-D-004)', () => {
  const SEED = Number(process.env.CSV_PROPERTY_SEED ?? 20261019);
  const CASES = Math.max(20_000, Number(process.env.CSV_PROPERTY_CASES ?? 0));
  const ATOMS = [
    '=',
    '+',
    '-',
    '@',
    '\t',
    '\r',
    '\n',
    '"',
    ',',
    ';',
    ' ',
    'a',
    'Z',
    '1',
    'é',
    '日',
    '😀',
    '|',
    "'",
    '\\',
    '\u0000',
  ];

  it(`parses ${String(CASES)} generated rows back to the values plus the documented space (seed ${String(SEED)})`, () => {
    const random = generator(SEED);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    for (let index = 0; index < CASES; index += 1) {
      const separator = pick([',', ';'] as const);
      const columns = 1 + Math.floor(random() * 5);
      const rowCount = 1 + Math.floor(random() * 3);
      const values: string[][] = [];
      for (let r = 0; r < rowCount; r += 1) {
        const row: string[] = [];
        for (let c = 0; c < columns; c += 1) {
          const length = Math.floor(random() * 8);
          row.push(Array.from({ length }, () => pick(ATOMS)).join(''));
        }
        values.push(row);
      }
      const text = values.map((row) => csvRow(row, separator)).join('');
      let parsed: string[][];
      try {
        parsed = parseCsv(text, separator);
      } catch (error) {
        throw new Error(
          `case ${String(index)} (seed ${String(SEED)}) did not parse: ${JSON.stringify(values)}`,
          {
            cause: error,
          },
        );
      }
      const expected = values.map((row) => row.map(neutraliseFormula));
      expect(parsed, `case ${String(index)} (seed ${String(SEED)})`).toEqual(expected);
      // No cell a spreadsheet could read as a formula survives.
      for (const cell of parsed.flat()) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it('is caught when the neutralisation is taken out (a negative control)', () => {
    const broken = (value: string): string =>
      /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    expect(broken('=1+1')).toBe('=1+1');
    expect(broken('=1+1')).toMatch(/^[=+\-@]/);
    expect(csvField('=1+1', ',')).not.toMatch(/^[=+\-@]/);
  });
});

describe('the presets and the options (FR-D-402)', () => {
  const base = { dedupe: true, skipWithoutEmail: true } as const;

  it('fixes the Laposta preset: e-mail, first and last name, semicolon, BOM', () => {
    expect(resolveExportOptions({ preset: 'laposta', ...base })).toEqual({
      columns: ['email', 'firstName', 'lastName'],
      separator: ';',
      bom: true,
      dedupe: true,
      skipWithoutEmail: true,
    });
  });

  it('fixes the generic preset: five columns, comma, no BOM', () => {
    expect(resolveExportOptions({ preset: 'generic', ...base })).toMatchObject({
      columns: EXPORT_COLUMNS,
      separator: ',',
      bom: false,
    });
  });

  it('takes the columns, separator and BOM of a custom preset, with the five columns, a semicolon and a BOM as defaults', () => {
    expect(
      resolveExportOptions({
        preset: 'custom',
        columns: ['email'],
        separator: ',',
        bom: false,
        ...base,
      }),
    ).toMatchObject({ columns: ['email'], separator: ',', bom: false });
    expect(resolveExportOptions({ preset: 'custom', ...base })).toMatchObject({
      columns: EXPORT_COLUMNS,
      separator: ';',
      bom: true,
    });
  });

  it('has a header for every column, in plain ASCII words', () => {
    for (const column of EXPORT_COLUMNS) expect(EXPORT_HEADERS[column]).toMatch(/^[a-z_]+$/);
  });

  it('accepts the options of the wire and fills in the two switches', () => {
    expect(ExportOptionsSchema.parse({ preset: 'laposta' })).toEqual({
      preset: 'laposta',
      dedupe: true,
      skipWithoutEmail: true,
    });
    expect(
      ExportOptionsSchema.parse({
        preset: 'custom',
        columns: ['type', 'email'],
        separator: ',',
        bom: false,
        dedupe: false,
      }),
    ).toMatchObject({ columns: ['type', 'email'], dedupe: false, skipWithoutEmail: true });
  });

  it('refuses what fights a preset, repeats a column, or is not in the vocabulary', () => {
    for (const body of [
      { preset: 'laposta', columns: ['email'] },
      { preset: 'generic', separator: ';' },
      { preset: 'laposta', bom: false },
      { preset: 'custom', columns: [] },
      { preset: 'custom', columns: ['email', 'email'] },
      { preset: 'custom', columns: ['phone'] },
      { preset: 'custom', separator: '\t' },
      { preset: 'excel' },
      { preset: 'laposta', extra: true },
      {},
    ]) {
      expect(ExportOptionsSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
