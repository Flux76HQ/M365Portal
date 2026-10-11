// Small Markdown readers shared by `docs-contract.test.ts` and `limits-doc.test.ts` (T-A-270). They
// read the documents as data and know nothing about what the documents must say; every rule lives
// in the two test files. Headings and tables inside fenced code blocks are not headings or tables.

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

export interface MarkdownTable {
  /** Header cells with markup removed. */
  readonly header: readonly string[];
  /** Body rows, cells with markup removed (`**`, backticks) and trimmed. */
  readonly rows: readonly (readonly string[])[];
  /** Body rows with the markup kept (backticks matter for name lists). */
  readonly rawRows: readonly (readonly string[])[];
}

/** Lines of `markdown` outside fenced code blocks, as `[lineNumber, text]` (1-based). */
function proseLines(markdown: string): [number, string][] {
  const out: [number, string][] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((text, index) => {
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker.startsWith(fence)) fence = undefined;
      return;
    }
    if (fence === undefined) out.push([index + 1, text]);
  });
  return out;
}

export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  for (const [line, text] of proseLines(markdown)) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      out.push({ level: match[1].length, text: stripMarkup(match[2]), line });
    }
  }
  return out;
}

/** GitHub's anchor for a heading text (lower case, punctuation dropped, spaces to hyphens). */
export function slugOf(text: string): string {
  return stripMarkup(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Every anchor a document offers; a repeated heading gets `-1`, `-2` as GitHub does. */
export function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const heading of headingsOf(markdown)) {
    const base = slugOf(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return out;
}

export function stripMarkup(text: string): string {
  return text.replace(/\*\*|__|`/g, '').trim();
}

/**
 * The text of the section whose heading matches `title`, up to the next heading of the same or a
 * higher level. Returns `undefined` when there is no such heading.
 */
export function sectionOf(markdown: string, title: RegExp): string | undefined {
  const headings = headingsOf(markdown);
  const lines = markdown.split('\n');
  const index = headings.findIndex((heading) => title.test(heading.text));
  const start = headings[index];
  if (start === undefined) return undefined;
  const next = headings.slice(index + 1).find((heading) => heading.level <= start.level);
  return lines.slice(start.line, next === undefined ? lines.length : next.line - 1).join('\n');
}

/** Splits a table row on `|` that is neither escaped nor inside a code span (any backtick run length). */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let i = 0;
  while (i < line.length) {
    const char = line.charAt(i);
    if (char === '\\' && line.charAt(i + 1) === '|') {
      current += '|';
      i += 2;
    } else if (char === '`') {
      let run = 0;
      while (line.charAt(i + run) === '`') run += 1;
      const opener = '`'.repeat(run);
      let close = line.indexOf(opener, i + run);
      while (close !== -1 && line.charAt(close + run) === '`') {
        close = line.indexOf(opener, close + run + 1);
      }
      if (close === -1) {
        current += opener;
        i += run;
      } else {
        current += line.slice(i, close + run);
        i = close + run;
      }
    } else if (char === '|') {
      cells.push(current);
      current = '';
      i += 1;
    } else {
      current += char;
      i += 1;
    }
  }
  cells.push(current);
  if (cells[0]?.trim() === '') cells.shift();
  if (cells[cells.length - 1]?.trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

export function tablesIn(markdown: string): MarkdownTable[] {
  const lines = proseLines(markdown).map(([, text]) => text);
  const tables: MarkdownTable[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const head = lines[i] ?? '';
    const rule = lines[i + 1] ?? '';
    if (!head.includes('|') || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(rule)) {
      continue;
    }
    const rawRows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && (lines[j] ?? '').includes('|') && (lines[j] ?? '').trim() !== '') {
      rawRows.push(splitRow(lines[j] ?? ''));
      j += 1;
    }
    tables.push({
      header: splitRow(head).map(stripMarkup),
      rows: rawRows.map((row) => row.map(stripMarkup)),
      rawRows,
    });
    i = j - 1;
  }
  return tables;
}

/** The first table of `markdown` whose header cells satisfy `matches`. */
export function findTable(
  markdown: string,
  matches: (header: readonly string[]) => boolean,
): MarkdownTable | undefined {
  return tablesIn(markdown).find((table) => matches(table.header));
}

export interface MarkdownLink {
  readonly target: string;
  readonly image: boolean;
}

/** Inline links and images, outside code fences and inline code. */
export function linksOf(markdown: string): MarkdownLink[] {
  const out: MarkdownLink[] = [];
  for (const [, text] of proseLines(markdown)) {
    const withoutCode = text.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      out.push({ image: match[1] === '!', target: match[2] ?? '' });
    }
  }
  return out;
}

/** Backticked tokens of `text`, in order of appearance. */
export function codeTokens(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

/** Numbers of a table cell as numbers: `262,144` is 262144, `0.5` is 0.5, `10,000 and 64` is two. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0].replace(/,/g, '')),
  );
}
