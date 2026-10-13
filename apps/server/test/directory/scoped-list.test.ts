// T-C-019, FR-C-203, SC-C1, EC-C4: the scoped scan against a naive reference. A seeded property test
// (20,000 cases) over random data, page sizes, limits and selectors proves that following the resume
// position gives exactly the naive filter: no duplicate, no gap, in order, with at most `maxPages`
// Graph pages per step. Examples cover a resume after a partly used page and the stop at five pages.
import { LIMITS } from '@m365portal/shared/limits';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { describe, expect, it } from 'vitest';
import {
  scanList,
  seesAll,
  seesNothing,
  visibilityOf,
  type ScanPosition,
  type ScanResult,
} from '../../src/directory/scoped-list.js';
import type { PageToken } from '../../src/ports/graph.js';

const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

/** A seeded generator (mulberry32), so a failing case can be repeated from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function source(items: readonly number[], size: number) {
  const fetched: number[] = [];
  return {
    fetched,
    readPage: (after: PageToken | null) => {
      const offset = after === null ? 0 : Number(after.slice(1));
      fetched.push(offset);
      const end = offset + size;
      return Promise.resolve({
        items: items.slice(offset, end),
        next: end < items.length ? (`t${String(end)}` as PageToken) : null,
      });
    },
  };
}

/** Walks the whole list in steps of `limit`, checking each step on the way. */
async function walk(options: {
  items: readonly number[];
  pageSize: number;
  limit: number;
  maxPages: number;
  keep: (item: number) => boolean;
}): Promise<{ rows: number[]; steps: number }> {
  const { items, pageSize, limit, maxPages, keep } = options;
  const rows: number[] = [];
  let start: ScanPosition | null = null;
  let steps = 0;
  do {
    const origin = source(items, pageSize);
    const result: ScanResult<number> = await scanList({
      readPage: origin.readPage,
      select: (item: number) => (keep(item) ? item : null),
      limit,
      start,
      maxPages,
    });
    steps += 1;
    if (result.rows.length > limit) throw new Error('more rows than the limit');
    if (origin.fetched.length > maxPages) throw new Error('more Graph pages than maxPages');
    // A step that is not full ended because the list ended or the page budget was used.
    if (
      result.rows.length < limit &&
      result.resume !== null &&
      origin.fetched.length !== maxPages
    ) {
      throw new Error('stopped early without a reason');
    }
    rows.push(...result.rows);
    start = result.resume;
    if (steps > items.length + 10) throw new Error('the scan does not advance');
  } while (start !== null);
  return { rows, steps };
}

describe('scanList against a naive filter (FR-C-203, SC-C1)', () => {
  it('returns exactly the naive filter for 20,000 seeded cases: no duplicate, no gap, in order', async () => {
    const SEED = 20_261_013;
    for (let index = 0; index < 20_000; index += 1) {
      const seed = SEED + index;
      const next = generator(seed);
      const count = Math.floor(next() * 120);
      const items = Array.from({ length: count }, (_, i) => i);
      const density = [0, 0.02, 0.1, 0.5, 0.9, 1][Math.floor(next() * 6)] ?? 1;
      const kept = new Set(items.filter(() => next() < density));
      const pageSize = 1 + Math.floor(next() * 30);
      const limit = 1 + Math.floor(next() * 25);
      const maxPages = 1 + Math.floor(next() * 5);
      let outcome: { rows: number[] };
      try {
        outcome = await walk({ items, pageSize, limit, maxPages, keep: (item) => kept.has(item) });
      } catch (failure) {
        throw new Error(
          `case ${String(index)} (seed ${String(seed)}, count ${String(count)}, page ${String(pageSize)}, limit ${String(limit)}, maxPages ${String(maxPages)}): ${(failure as Error).message}`,
          { cause: failure },
        );
      }
      const naive = items.filter((item) => kept.has(item));
      if (JSON.stringify(outcome.rows) !== JSON.stringify(naive)) {
        throw new Error(
          `case ${String(index)} (seed ${String(seed)}) differs from the naive filter: got ${String(outcome.rows.length)} rows, expected ${String(naive.length)}`,
        );
      }
    }
  }, 120_000);
});

describe('scanList by example', () => {
  it('resumes exactly after a partly used Graph page', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const first = source(items, 5);
    const one = await scanList({
      readPage: first.readPage,
      select: (n: number) => n,
      limit: 3,
      start: null,
      maxPages: 5,
    });
    expect(one.rows).toEqual([0, 1, 2]);
    expect(one.resume).toEqual({ pageToken: null, skip: 3 });
    const two = await scanList({
      readPage: first.readPage,
      select: (n: number) => n,
      limit: 3,
      start: one.resume,
      maxPages: 5,
    });
    expect(two.rows).toEqual([3, 4, 5]);
    expect(two.resume).toEqual({ pageToken: 't5', skip: 1 });
    const three = await scanList({
      readPage: first.readPage,
      select: (n: number) => n,
      limit: 3,
      start: two.resume,
      maxPages: 5,
    });
    expect(three.rows).toEqual([6, 7, 8]);
    const four = await scanList({
      readPage: first.readPage,
      select: (n: number) => n,
      limit: 3,
      start: three.resume,
      maxPages: 5,
    });
    expect(four.rows).toEqual([9]);
    expect(four.resume).toBeNull();
  });

  it('points at the next page when the step ends exactly at the end of a Graph page', async () => {
    const origin = source(
      Array.from({ length: 10 }, (_, i) => i),
      5,
    );
    const result = await scanList({
      readPage: origin.readPage,
      select: (n: number) => n,
      limit: 5,
      start: null,
      maxPages: 5,
    });
    expect(result.rows).toEqual([0, 1, 2, 3, 4]);
    expect(result.resume).toEqual({ pageToken: 't5', skip: 0 });
  });

  it('ends with no resume when the last row of the list fills the page', async () => {
    const origin = source([0, 1, 2], 5);
    const result = await scanList({
      readPage: origin.readPage,
      select: (n: number) => n,
      limit: 3,
      start: null,
      maxPages: 5,
    });
    expect(result.rows).toEqual([0, 1, 2]);
    expect(result.resume).toBeNull();
  });

  it('stops after five Graph pages with what it found and the position of the sixth (EC-C4)', async () => {
    expect(LIMITS.directory.scanPagesMax).toBe(5);
    const items = Array.from({ length: 100 }, (_, i) => i);
    const origin = source(items, 10);
    const result = await scanList({
      readPage: origin.readPage,
      select: (n: number) => (n === 3 || n === 77 ? n : null),
      limit: 50,
      start: null,
      maxPages: LIMITS.directory.scanPagesMax,
    });
    expect(origin.fetched).toEqual([0, 10, 20, 30, 40]);
    expect(result.rows).toEqual([3]);
    expect(result.resume).toEqual({ pageToken: 't50', skip: 0 });
    const rest = await scanList({
      readPage: origin.readPage,
      select: (n: number) => (n === 3 || n === 77 ? n : null),
      limit: 50,
      start: result.resume,
      maxPages: 5,
    });
    expect(rest.rows).toEqual([77]);
    expect(rest.resume).toBeNull();
  });

  it('handles an empty list, an empty Graph page with a next link, and a selector that accepts nothing', async () => {
    const empty = await scanList({
      readPage: source([], 5).readPage,
      select: (n: number) => n,
      limit: 3,
      start: null,
      maxPages: 5,
    });
    expect(empty).toEqual({ rows: [], resume: null });
    const none = await scanList({
      readPage: source([1, 2, 3], 2).readPage,
      select: () => null,
      limit: 3,
      start: null,
      maxPages: 5,
    });
    expect(none).toEqual({ rows: [], resume: null });
    let calls = 0;
    const gappy = await scanList({
      readPage: (after) => {
        calls += 1;
        return Promise.resolve(
          after === null ? { items: [], next: 'p2' as PageToken } : { items: [9], next: null },
        );
      },
      select: (n: number) => n,
      limit: 3,
      start: null,
      maxPages: 5,
    });
    expect(gappy.rows).toEqual([9]);
    expect(calls).toBe(2);
  });

  it('rejects a limit or a page budget that is not a whole number of 1 or more', async () => {
    const origin = source([1], 5);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        scanList({
          readPage: origin.readPage,
          select: (n: number) => n,
          limit,
          start: null,
          maxPages: 5,
        }),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      scanList({
        readPage: origin.readPage,
        select: (n: number) => n,
        limit: 1,
        start: null,
        maxPages: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('negative: a scan that drops the skip loses or repeats rows, and the walk detects it', async () => {
    // A broken resume that restarts the Graph page from its first row repeats rows.
    const items = Array.from({ length: 10 }, (_, i) => i);
    const broken = async (): Promise<number[]> => {
      const rows: number[] = [];
      let start: ScanPosition | null = null;
      for (let step = 0; step < 6; step += 1) {
        const result: ScanResult<number> = await scanList({
          readPage: source(items, 5).readPage,
          select: (n: number) => n,
          limit: 3,
          start,
          maxPages: 5,
        });
        rows.push(...result.rows);
        start = result.resume === null ? null : { pageToken: result.resume.pageToken, skip: 0 };
        if (start === null) break;
      }
      return rows;
    };
    const rows = await broken();
    expect(new Set(rows).size).not.toBe(rows.length);
  });
});

describe('visibilityOf (FR-C-203, FR-B-513)', () => {
  const sales: ScopeItem = { target: 'user', match: { by: 'department', value: 'Sales' } };
  const ann: ScopeItem = {
    target: 'user',
    match: { by: 'prefix', attr: 'displayName', value: 'ann' },
  };

  it('is full for all, basic for a basic grant, and null for nothing', () => {
    const user = { type: 'user', id: ID, displayName: 'Bob', department: 'Sales' } as const;
    expect(visibilityOf({ full: 'all', basic: 'none' }, user)).toBe('full');
    expect(visibilityOf({ full: 'none', basic: 'all' }, user)).toBe('basic');
    expect(visibilityOf({ full: 'none', basic: 'none' }, user)).toBeNull();
    expect(visibilityOf({ full: [sales], basic: 'none' }, user)).toBe('full');
    expect(visibilityOf({ full: [ann], basic: [sales] }, user)).toBe('basic');
    expect(visibilityOf({ full: [ann], basic: [ann] }, user)).toBeNull();
  });

  it('never matches a missing attribute (fail closed)', () => {
    const noDepartment = { type: 'user', id: ID, displayName: 'Bob', department: null } as const;
    const noName = { type: 'user', id: ID, displayName: null } as const;
    expect(visibilityOf({ full: [sales], basic: 'none' }, noDepartment)).toBeNull();
    expect(visibilityOf({ full: [ann], basic: 'none' }, noName)).toBeNull();
  });

  it('full wins over basic, and a scope item of another type matches nothing', () => {
    const user = { type: 'user', id: ID, displayName: 'Anna' } as const;
    expect(visibilityOf({ full: [ann], basic: 'all' }, user)).toBe('full');
    const group: ScopeItem = {
      target: 'group',
      match: { by: 'prefix', attr: 'displayName', value: 'ann' },
    };
    expect(visibilityOf({ full: [group], basic: 'none' }, user)).toBeNull();
  });

  it('knows when an actor sees everything and when nothing', () => {
    expect(seesAll({ full: 'all', basic: 'none' })).toBe(true);
    expect(seesAll({ full: 'none', basic: 'all' })).toBe(true);
    expect(seesAll({ full: [sales], basic: [ann] })).toBe(false);
    expect(seesNothing({ full: 'none', basic: 'none' })).toBe(true);
    expect(seesNothing({ full: [sales], basic: 'none' })).toBe(false);
  });
});
