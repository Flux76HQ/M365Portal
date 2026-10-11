// The sample data of the showcase (FR-A-131, plan 9.6): a made-up directory of 120 people and a source
// that behaves like a server (it sorts, filters, searches and slices, and it takes a while) without
// being one. Nothing here is read from or sent to the network; the page labels every row as sample
// data. The latency is simulated through an injected `wait`, so a test needs no timer.

export const DEPARTMENTS = ['design', 'engineering', 'finance', 'sales', 'support'] as const;
export type DepartmentId = (typeof DEPARTMENTS)[number];

export const ROLES = ['lead', 'member', 'guest'] as const;
export type RoleId = (typeof ROLES)[number];

export interface SamplePerson {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly department: DepartmentId;
  readonly role: RoleId;
}

// 12 first names and 10 last names, all invented, give 120 distinct people.
const FIRST_NAMES = [
  'Alder',
  'Briar',
  'Cedar',
  'Dune',
  'Ember',
  'Fern',
  'Gale',
  'Heath',
  'Iris',
  'Juniper',
  'Kestrel',
  'Linden',
] as const;
const LAST_NAMES = [
  'Vance',
  'Holloway',
  'Marsh',
  'Quill',
  'Ashby',
  'Thorne',
  'Wren',
  'Calloway',
  'Rowan',
  'Sterling',
] as const;

export const SAMPLE_PEOPLE: readonly SamplePerson[] = Object.freeze(
  Array.from({ length: FIRST_NAMES.length * LAST_NAMES.length }, (_unused, index) => {
    const first = FIRST_NAMES[index % FIRST_NAMES.length] ?? '';
    const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length)] ?? '';
    return Object.freeze({
      id: `sample-${String(index + 1).padStart(3, '0')}`,
      name: `${first} ${last}`,
      email: `${first}.${last}@example.test`.toLowerCase(),
      department: DEPARTMENTS[(index * 3) % DEPARTMENTS.length] ?? 'design',
      role: ROLES[(index * 5) % ROLES.length] ?? 'member',
    });
  }),
);

/** `normal` answers with data, `empty` with none (the "no data" state), `error` fails (the error state). */
export type SampleScenario = 'normal' | 'empty' | 'error';

export interface SampleQuery {
  readonly q: string;
  /** A sort token: a column id, `-` in front for descending. Null: the source's own order. */
  readonly sort: string | null;
  /** One-based. */
  readonly page: number;
  readonly size: number;
  readonly department: DepartmentId | null;
  readonly scenario: SampleScenario;
}

export interface SamplePage {
  readonly rows: readonly SamplePerson[];
  /** The number of results over all pages. */
  readonly total: number;
}

export interface SampleSource {
  fetchPage(query: SampleQuery, signal?: AbortSignal): Promise<SamplePage>;
}

/** What the `error` scenario throws. It carries no detail on purpose: the page shows the generic state. */
export class SampleSourceError extends Error {
  constructor() {
    super('the sample source was asked to fail');
    this.name = 'SampleSourceError';
  }
}

export interface SampleSourceOptions {
  /** The simulated latency of one request. */
  readonly delayMs?: number;
  /** How the latency passes. The default is a timer that an abort cancels; a test passes its own. */
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_LATENCY_MS = 350;

function timerWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function compare(a: SamplePerson, b: SamplePerson, column: string): number {
  switch (column) {
    case 'email':
      return a.email.localeCompare(b.email, 'en');
    case 'department':
      return a.department.localeCompare(b.department, 'en') || a.name.localeCompare(b.name, 'en');
    case 'role':
      return a.role.localeCompare(b.role, 'en') || a.name.localeCompare(b.name, 'en');
    default:
      return a.name.localeCompare(b.name, 'en');
  }
}

/** A source that answers like a server would, after `delayMs`. */
export function createSampleSource(options: SampleSourceOptions = {}): SampleSource {
  const delayMs = options.delayMs ?? DEFAULT_LATENCY_MS;
  const wait = options.wait ?? timerWait;
  return {
    async fetchPage(query, signal) {
      await wait(delayMs, signal);
      if (query.scenario === 'error') throw new SampleSourceError();
      if (query.scenario === 'empty') return { rows: [], total: 0 };

      const needle = query.q.trim().toLowerCase();
      let matches = SAMPLE_PEOPLE.filter(
        (person) =>
          (query.department === null || person.department === query.department) &&
          (needle === '' ||
            person.name.toLowerCase().includes(needle) ||
            person.email.includes(needle)),
      );
      if (query.sort !== null) {
        const descending = query.sort.startsWith('-');
        const column = query.sort.replace(/^-/, '');
        matches = [...matches].sort((a, b) => (descending ? -1 : 1) * compare(a, b, column));
      }
      const start = (Math.max(1, query.page) - 1) * query.size;
      return { rows: matches.slice(start, start + query.size), total: matches.length };
    },
  };
}
