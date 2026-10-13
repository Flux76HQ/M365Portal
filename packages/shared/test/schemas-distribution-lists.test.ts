// T-D-103, FR-D-201, FR-D-202, FR-D-203, FR-D-207, EC-D5: the wire schemas of the distribution list
// routes P40 to P45 (the contract frozen at gate GD1-0). Strict query objects, bounds, unknown
// properties are `null` (U79, U80), restricted member rows have no identity, no total on a list.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LIMITS } from '../src/limits.js';
import { PAGE_LIMIT_MAX } from '../src/schemas/common.js';
import * as dl from '../src/schemas/distribution-lists.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  DistributionListCandidatesQuerySchema,
  DistributionListCandidatesResponseSchema,
  DistributionListDetailSchema,
  DistributionListIdParamsSchema,
  DistributionListKindFilterSchema,
  DistributionListKindSchema,
  DistributionListListItemSchema,
  DistributionListListQuerySchema,
  DistributionListListResponseSchema,
  DistributionListMemberKindSchema,
  DistributionListMemberRowSchema,
  DistributionListMembersQuerySchema,
  DistributionListMembersResponseSchema,
  isRestrictedMemberRow,
} = dl;

const GUID = '8e0c2b8e-0000-4000-8000-0000000000aa';
const TS = '2026-10-11T12:00:00.000Z';
const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const item = {
  id: GUID,
  displayName: 'Generated List',
  primarySmtpAddress: 'generated-list@example.test',
  kind: 'standard',
  securityEnabled: false,
  memberCount: 3,
  managers: [{ displayName: 'Generated Owner', mail: 'owner@example.test' }],
};
const detail = { ...item, alias: 'generated-list', createdDateTime: TS };
const member = {
  kind: 'contact',
  id: GUID,
  displayName: 'Generated Contact',
  primarySmtpAddress: 'contact@example.test',
};

describe('vocabularies', () => {
  it('has the three kinds of FR-D-202 and the filter with all', () => {
    expect(DistributionListKindSchema.options).toEqual(['standard', 'dynamic', 'synced']);
    expect(DistributionListKindFilterSchema.options).toEqual([
      'all',
      'standard',
      'dynamic',
      'synced',
    ]);
    expect(DistributionListMemberKindSchema.options).toEqual(['user', 'contact', 'group', 'other']);
  });
});

describe('queries (strict)', () => {
  it('the list query defaults kind to all and order to asc and refuses unknown parameters', () => {
    const parsed = DistributionListListQuerySchema.parse({});
    expect(parsed.kind).toBe('all');
    expect(parsed.order).toBe('asc');
    expect(
      accepts(DistributionListListQuerySchema, { q: 'sal', kind: 'dynamic', limit: '50' }),
    ).toBe(true);
    expect(accepts(DistributionListListQuerySchema, { kind: 'unknown' })).toBe(false);
    expect(accepts(DistributionListListQuerySchema, { filter: 'x' })).toBe(false);
    expect(accepts(DistributionListListQuerySchema, { limit: String(PAGE_LIMIT_MAX + 1) })).toBe(
      false,
    );
    expect(accepts(DistributionListListQuerySchema, { q: '' })).toBe(false);
    expect(
      accepts(DistributionListListQuerySchema, {
        q: 'x'.repeat(LIMITS.directory.searchMaxChars + 1),
      }),
    ).toBe(false);
  });

  it('the members query is a page size and a cursor, nothing else', () => {
    expect(accepts(DistributionListMembersQuerySchema, { limit: '25', cursor: 'abc_DEF-1' })).toBe(
      true,
    );
    expect(accepts(DistributionListMembersQuerySchema, { q: 'x' })).toBe(false);
  });

  it('the candidates query needs q (P45) and takes a page size', () => {
    expect(accepts(DistributionListCandidatesQuerySchema, { q: 'jan' })).toBe(true);
    expect(accepts(DistributionListCandidatesQuerySchema, {})).toBe(false);
    expect(accepts(DistributionListCandidatesQuerySchema, { q: 'jan', extra: '1' })).toBe(false);
  });

  it('the id parameter is a lower-case GUID only, never a name or an address', () => {
    expect(accepts(DistributionListIdParamsSchema, { id: GUID })).toBe(true);
    expect(accepts(DistributionListIdParamsSchema, { id: 'sales@example.test' })).toBe(false);
    expect(accepts(DistributionListIdParamsSchema, { id: GUID.toUpperCase() })).toBe(false);
  });
});

describe('rows and details', () => {
  it('accepts a list row and a detail', () => {
    expect(accepts(DistributionListListItemSchema, item)).toBe(true);
    expect(accepts(DistributionListDetailSchema, detail)).toBe(true);
  });

  it('writes an unknown property as null, never as an absent key (U79, U80)', () => {
    const unknown = {
      ...item,
      displayName: null,
      primarySmtpAddress: null,
      securityEnabled: null,
      memberCount: null,
      managers: null,
    };
    expect(accepts(DistributionListListItemSchema, unknown)).toBe(true);
    const absent = Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== 'memberCount'),
    );
    expect(accepts(DistributionListListItemSchema, absent)).toBe(false);
  });

  it('bounds text to 256 bytes, the member count to a whole number from 0, the managers to 25', () => {
    expect(accepts(DistributionListListItemSchema, { ...item, displayName: 'x'.repeat(257) })).toBe(
      false,
    );
    expect(accepts(DistributionListListItemSchema, { ...item, memberCount: -1 })).toBe(false);
    expect(accepts(DistributionListListItemSchema, { ...item, memberCount: 1.5 })).toBe(false);
    const managers = Array.from({ length: 26 }, () => ({ displayName: 'x', mail: null }));
    expect(accepts(DistributionListListItemSchema, { ...item, managers })).toBe(false);
  });

  it('refuses an unknown kind and extra fields (strict)', () => {
    expect(accepts(DistributionListListItemSchema, { ...item, kind: 'm365' })).toBe(false);
    expect(accepts(DistributionListListItemSchema, { ...item, managedBy: [] })).toBe(false);
    expect(
      accepts(DistributionListDetailSchema, { ...detail, createdDateTime: '2026-10-11' }),
    ).toBe(false);
  });
});

describe('member rows', () => {
  it('a member is a user, contact, group or other object with an id', () => {
    for (const kind of ['user', 'contact', 'group', 'other']) {
      expect(accepts(DistributionListMemberRowSchema, { ...member, kind })).toBe(true);
    }
    expect(accepts(DistributionListMemberRowSchema, { ...member, kind: 'device' })).toBe(false);
  });

  it('a restricted row has the kind and the fact, no id, no name, no address (negative fixture)', () => {
    const restricted = { kind: 'user', restricted: true };
    expect(accepts(DistributionListMemberRowSchema, restricted)).toBe(true);
    expect(isRestrictedMemberRow(restricted as never)).toBe(true);
    expect(isRestrictedMemberRow(member as never)).toBe(false);
    const guard = (row: unknown): void => {
      const parsed = DistributionListMemberRowSchema.parse(row);
      if ('restricted' in parsed && ('id' in parsed || 'displayName' in parsed)) {
        throw new Error('restricted row leaks');
      }
    };
    expect(() => {
      guard(restricted);
    }).not.toThrow();
    expect(accepts(DistributionListMemberRowSchema, { ...restricted, id: GUID })).toBe(false);
    expect(accepts(DistributionListMemberRowSchema, { ...restricted, displayName: 'x' })).toBe(
      false,
    );
    expectGuardFails(
      () => {
        throw new Error('restricted row leaks');
      },
      restricted,
      { reason: 'restricted row leaks' },
    );
  });
});

describe('responses', () => {
  it('has no total or count on a list or on the members (a count would leak the size of a scope)', () => {
    expect(accepts(DistributionListListResponseSchema, { items: [item] })).toBe(true);
    expect(accepts(DistributionListListResponseSchema, { items: [item], total: 1 })).toBe(false);
    expect(
      accepts(DistributionListMembersResponseSchema, { items: [member], nextCursor: 'abc' }),
    ).toBe(true);
    expect(accepts(DistributionListMembersResponseSchema, { items: [member], count: 1 })).toBe(
      false,
    );
  });

  it('caps a page at the list convention of 200 rows and the cursor is absent at the end, never null', () => {
    const many = Array.from({ length: PAGE_LIMIT_MAX + 1 }, () => item);
    expect(accepts(DistributionListListResponseSchema, { items: many })).toBe(false);
    expect(accepts(DistributionListListResponseSchema, { items: [item], nextCursor: null })).toBe(
      false,
    );
  });

  it('candidates are users or contacts with an id, and may say whether they are a member', () => {
    const candidate = {
      kind: 'user',
      id: GUID,
      displayName: 'Jan',
      mail: 'jan@example.test',
      alreadyMember: false,
    };
    expect(accepts(DistributionListCandidatesResponseSchema, { items: [candidate] })).toBe(true);
    expect(
      accepts(DistributionListCandidatesResponseSchema, {
        items: [{ ...candidate, alreadyMember: null }],
      }),
    ).toBe(true);
    expect(
      accepts(DistributionListCandidatesResponseSchema, {
        items: [{ ...candidate, kind: 'group' }],
      }),
    ).toBe(false);
  });
});
