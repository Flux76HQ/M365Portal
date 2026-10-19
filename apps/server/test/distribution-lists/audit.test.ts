// T-D-120, T-D-122, T-D-123, FR-D-205, FR-D-304, FR-D-354, FR-D-405: the audit vocabulary of step D1 (seven actions)
// and the `dl.export` of step D2,
// kept apart from the 19 of Phase B; every write route declares one of them and every action has a route;
// the detail keys they use are on the allow-list with the types the entries need; a name, an address or a
// value of a field cannot get into an entry.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_D,
  AUDIT_ACTION_NAMES_D,
  AUDIT_DETAIL_KEYS,
  AUDIT_DETAIL_KEYS_D,
  AuditDetailError,
  buildDetail,
} from '../../src/audit/index.js';
import { readJson } from '../helpers/http-client.js';
import { READ_LISTS, createListsFixture } from './support.js';

const GUID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

describe('the vocabulary of steps D1 and D2', () => {
  it('has the seven actions of D1 and the export of D2, none of them in the vocabulary of Phase B', () => {
    expect([...AUDIT_ACTION_NAMES_D]).toEqual([
      'dl.member.add',
      'dl.member.remove',
      'group.member.add',
      'group.member.remove',
      'contact.create',
      'contact.update',
      'contact.delete',
      'dl.export',
    ]);
    for (const name of AUDIT_ACTION_NAMES_D) expect(AUDIT_ACTIONS, name).not.toHaveProperty(name);
    expect(Object.keys(AUDIT_ACTIONS)).toHaveLength(19);
    expect(Object.keys(AUDIT_DETAIL_KEYS)).toHaveLength(64);
  });

  it('uses only detail keys that are on the allow-list, and no key that could hold a name or an address', () => {
    const all = new Set([...Object.keys(AUDIT_DETAIL_KEYS), ...Object.keys(AUDIT_DETAIL_KEYS_D)]);
    for (const [name, definition] of Object.entries(AUDIT_ACTIONS_D)) {
      for (const key of definition.detailKeys) expect(all.has(key), `${name} ${key}`).toBe(true);
      expect(
        definition.detailKeys.every(
          (key) => !/name|mail|address|upn|value/i.test(key.replace('removed', '')),
        ),
      ).toBe(true);
      expect(definition.actorKinds).toEqual(['user']);
    }
    expect(Object.keys(AUDIT_DETAIL_KEYS_D).sort()).toEqual([
      'added',
      'already',
      'columns',
      'failed',
      'fields',
      'memberId',
      'options',
      'preset',
      'removed',
      'result',
      'skipped',
      'summary',
      'total',
    ]);
  });

  it('is declared by exactly the write routes of the table, and every declaration is in the vocabulary', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    const document = await readJson<{
      paths: Record<string, Record<string, Record<string, unknown>>>;
    }>(await me.client.get('/api/v1/openapi.json'));
    const declared = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .map((operation) => operation['x-audit'])
      .filter((audit): audit is string => typeof audit === 'string');
    for (const name of AUDIT_ACTION_NAMES_D) expect(declared, name).toContain(name);
    expect(declared.filter((audit) => audit in AUDIT_ACTIONS_D).sort()).toEqual(
      [...AUDIT_ACTION_NAMES_D].sort(),
    );
  });
});

describe('the detail of an entry (FR-D-205)', () => {
  it('takes object ids, results and counts', () => {
    expect(JSON.parse(buildDetail({ memberId: GUID, result: 'added' }))).toEqual({
      memberId: GUID,
      result: 'added',
    });
    expect(
      JSON.parse(
        buildDetail({ summary: true, total: 3, added: 1, removed: 0, already: 1, failed: 1 }),
      ),
    ).toEqual({ summary: true, total: 3, added: 1, removed: 0, already: 1, failed: 1 });
    expect(JSON.parse(buildDetail({ fields: ['displayName', 'alias'] }))).toEqual({
      fields: ['displayName', 'alias'],
    });
  });

  it('refuses a display name, an address, a member that is not a GUID and a result of no registry', () => {
    const refuse = (detail: Record<string, unknown>): void => {
      buildDetail(detail);
    };
    for (const [detail, reason] of [
      [{ displayName: 'Alice Example' }, /displayName/],
      [{ mail: 'alice@contoso-fake.example' }, /mail/],
      [{ memberId: 'alice@contoso-fake.example' }, /memberId/],
      [{ memberId: GUID.toUpperCase() }, /memberId/],
      [{ result: 'exploded' }, /result/],
    ] as const) {
      expectGuardFails(refuse, detail, { reason });
    }
    expect(() => {
      refuse({ memberId: 5 });
    }).toThrow(AuditDetailError);
  });
});
