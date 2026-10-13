// T-D-103, FR-D-203, FR-D-204, FR-D-206, FR-D-352, FR-D-353, EC-D7, EC-D8: the member write request
// and response schemas shared by the distribution list routes (P43, P44) and the group routes (P53,
// P54). Per-member result enum added | removed | already | failed, reason codes for a failure,
// `readBackPending` on lists only, and bounds taken from `LIMITS`.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LIMITS } from '../src/limits.js';
import * as memberWrites from '../src/schemas/member-writes.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  DistributionListMemberWriteRequestSchema,
  DistributionListMemberWriteResponseSchema,
  GroupMemberWriteRequestSchema,
  GroupMemberWriteResponseSchema,
  MEMBER_FAIL_REASONS,
  MEMBER_WRITE_RESULTS,
  MemberFailReasonSchema,
  MemberWriteItemSchema,
  MemberWriteResultSchema,
  MemberWriteSummarySchema,
  summariseMemberResults,
} = memberWrites;

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const guid = (n: number): string => `8e0c2b8e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => guid(index + 1));

describe('the vocabularies', () => {
  it('has exactly the four results of FR-D-203, in this order', () => {
    expect([...MEMBER_WRITE_RESULTS]).toEqual(['added', 'removed', 'already', 'failed']);
    expect(MemberWriteResultSchema.options).toEqual(['added', 'removed', 'already', 'failed']);
  });

  it('has a closed list of failure reasons, each with a message key in the shell (distributionLists.reason.<code>)', () => {
    expect([...MEMBER_FAIL_REASONS]).toEqual([
      'not_found',
      'member_type_not_allowed',
      'mail_disabled',
      'rejected',
      'permission_missing',
      'throttled',
      'unavailable',
      'timeout',
    ]);
    expect(accepts(MemberFailReasonSchema, 'mail_disabled')).toBe(true);
    expect(accepts(MemberFailReasonSchema, 'because i said so')).toBe(false);
  });
});

describe.each([
  ['distribution list', DistributionListMemberWriteRequestSchema, LIMITS.distributionLists.bulkMax],
  ['group', GroupMemberWriteRequestSchema, LIMITS.groupMembers.bulkMax],
])('the %s member write request', (_name, schema, max) => {
  it('takes 1 to bulkMax GUIDs and nothing else', () => {
    expect(accepts(schema, { members: [guid(1)] })).toBe(true);
    expect(accepts(schema, { members: ids(max) })).toBe(true);
    expect(accepts(schema, { members: ids(max + 1) })).toBe(false);
    expect(accepts(schema, { members: [] })).toBe(false);
    expect(accepts(schema, {})).toBe(false);
  });

  it('refuses a duplicate id, a non-GUID and an extra member (strict)', () => {
    expect(accepts(schema, { members: [guid(1), guid(1)] })).toBe(false);
    expect(accepts(schema, { members: ['jane@example.test'] })).toBe(false);
    expect(accepts(schema, { members: [guid(1).toUpperCase()] })).toBe(false);
    expect(accepts(schema, { members: [guid(1)], force: true })).toBe(false);
  });
});

describe('MemberWriteItemSchema', () => {
  it('has a reason when and only when the result is failed', () => {
    expect(accepts(MemberWriteItemSchema, { id: guid(1), result: 'added' })).toBe(true);
    expect(accepts(MemberWriteItemSchema, { id: guid(1), result: 'already' })).toBe(true);
    expect(
      accepts(MemberWriteItemSchema, { id: guid(1), result: 'failed', reason: 'timeout' }),
    ).toBe(true);
    expect(accepts(MemberWriteItemSchema, { id: guid(1), result: 'failed' })).toBe(false);
    expect(
      accepts(MemberWriteItemSchema, { id: guid(1), result: 'added', reason: 'timeout' }),
    ).toBe(false);
  });

  it('carries no display name or address (audit and logs use ids only, FR-D-205)', () => {
    expect(
      accepts(MemberWriteItemSchema, { id: guid(1), result: 'added', displayName: 'Someone' }),
    ).toBe(false);
  });
});

describe('summariseMemberResults and MemberWriteSummarySchema', () => {
  const results = [
    { id: guid(1), result: 'added' },
    { id: guid(2), result: 'added' },
    { id: guid(3), result: 'already' },
    { id: guid(4), result: 'failed', reason: 'not_found' },
  ] as const;

  it('counts every result', () => {
    expect(summariseMemberResults(results)).toEqual({
      added: 2,
      removed: 0,
      already: 1,
      failed: 1,
    });
    expect(accepts(MemberWriteSummarySchema, summariseMemberResults(results))).toBe(true);
    expect(
      accepts(MemberWriteSummarySchema, { added: -1, removed: 0, already: 0, failed: 0 }),
    ).toBe(false);
  });
});

describe('the responses', () => {
  const results = [
    { id: guid(1), result: 'removed' },
    { id: guid(2), result: 'failed', reason: 'throttled' },
  ] as const;
  const summary = { added: 0, removed: 1, already: 0, failed: 1 };

  it('the list response carries readBackPending (EC-D7); the group response does not', () => {
    expect(
      accepts(DistributionListMemberWriteResponseSchema, {
        results,
        summary,
        readBackPending: true,
      }),
    ).toBe(true);
    expect(accepts(DistributionListMemberWriteResponseSchema, { results, summary })).toBe(false);
    expect(accepts(GroupMemberWriteResponseSchema, { results, summary })).toBe(true);
    expect(
      accepts(GroupMemberWriteResponseSchema, { results, summary, readBackPending: false }),
    ).toBe(false);
  });

  it('refuses a summary that does not match the results (negative fixture)', () => {
    const guard = (value: unknown): void => {
      if (!accepts(GroupMemberWriteResponseSchema, value)) throw new Error('summary differs');
    };
    expect(() => {
      guard({ results, summary });
    }).not.toThrow();
    expectGuardFails(
      guard,
      { results, summary: { ...summary, removed: 2 } },
      { reason: 'summary differs' },
    );
  });

  it('refuses a repeated id and more results than the ceiling', () => {
    expect(
      accepts(GroupMemberWriteResponseSchema, {
        results: [results[0], results[0]],
        summary: { added: 0, removed: 2, already: 0, failed: 0 },
      }),
    ).toBe(false);
    const many = ids(LIMITS.groupMembers.bulkMax + 1).map((id) => ({ id, result: 'added' }));
    expect(
      accepts(GroupMemberWriteResponseSchema, {
        results: many,
        summary: { added: many.length, removed: 0, already: 0, failed: 0 },
      }),
    ).toBe(false);
  });

  it('is strict: an unknown member is an error', () => {
    expect(accepts(GroupMemberWriteResponseSchema, { results, summary, total: 2 })).toBe(false);
  });
});
