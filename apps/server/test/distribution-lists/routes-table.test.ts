// T-D-120, T-D-122, T-D-123, FR-D-201, FR-D-301, FR-D-352, FR-D-804, SC-D-003: the routes P40 to P45 and P47
// to P54 are in the route table and the OpenAPI document exactly as table 6.11.1 of the spec says (read from
// the spec by a parser that shares no code with the application): method, path, permission, class, audit
// action. The only difference is the spelling of the id: lower case (the id of a route is the action of its
// denial entries; GD1-server-b). Then the *Bestuur* matrix over the routes (US-D4) on the real application.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '@m365portal/shared/rbac/roles';
import type { Grant } from '@m365portal/shared/rbac/effective';
import { PERMISSION_RESOURCE } from '@m365portal/shared/permissions';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { readJson } from '../helpers/http-client.js';
import { READ_LISTS, call, createListsFixture, listId, type ProblemBody } from './support.js';

const SPEC = fileURLToPath(new URL('../../../../specs/004-phase-d/spec.md', import.meta.url));

interface SpecRow {
  readonly number: string;
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string;
  readonly scoped: boolean;
  readonly rate: string;
  readonly audit: string | undefined;
}

const D1_NUMBERS = [
  'P40',
  'P41',
  'P42',
  'P43',
  'P44',
  'P45',
  'P47',
  'P48',
  'P49',
  'P50',
  'P51',
  'P52',
  'P53',
  'P54',
];

/** The route index of the spec (section 6.11.1), parsed as text. */
function specRows(): SpecRow[] {
  const rows: SpecRow[] = [];
  for (const line of readFileSync(SPEC, 'utf8').split('\n')) {
    const match =
      /^\| (P\d\d) \| `([^`]+)` \| `(GET|POST|PATCH|DELETE) ([^`]+)`[^|]* \| (.+?) \| (\w+) \| (.+?) \|$/.exec(
        line,
      );
    if (match === null || !D1_NUMBERS.includes(match[1] ?? '')) continue;
    const access = match[5] ?? '';
    const audit = /`([a-z]+(?:\.[a-z_]+)+)`/.exec(match[7] ?? '')?.[1];
    rows.push({
      number: match[1] ?? '',
      id: match[2] ?? '',
      method: match[3] ?? '',
      path: (match[4] ?? '').split('?')[0] ?? '',
      permission: /`([a-z]+:[a-z:]+)`/.exec(access)?.[1] ?? '',
      scoped: /scoped|on that|by proposed name/.test(access),
      rate: match[6] ?? '',
      audit,
    });
  }
  return rows;
}

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly access: unknown;
  readonly scoped: unknown;
  readonly rate: unknown;
  readonly audit: unknown;
  readonly permission: unknown;
}

async function operations(): Promise<Operation[]> {
  const f = await createListsFixture();
  const me = f.actor(READ_LISTS);
  const document = await readJson<{
    paths: Record<string, Record<string, Record<string, unknown>>>;
  }>(await me.client.get('/api/v1/openapi.json'));
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      id: String(operation['x-route-id']),
      method: method.toUpperCase(),
      path,
      access: operation['x-access'],
      scoped: operation['x-scoped'],
      rate: operation['x-rate-limit'],
      audit: operation['x-audit'],
      permission: operation['x-permission'],
    })),
  );
}

/** The guard: the table says what the spec says for every row. */
function checkAgainstSpec(rows: readonly SpecRow[], ops: readonly Operation[]): void {
  for (const row of rows) {
    const found = ops.find((op) => op.method === row.method && op.path === row.path);
    if (found === undefined)
      throw new Error(`${row.number}: ${row.method} ${row.path} is not in the table`);
    if (found.id !== row.id.toLowerCase())
      throw new Error(`${row.number}: id ${found.id}, spec ${row.id}`);
    if (found.rate !== row.rate)
      throw new Error(`${row.number}: class ${String(found.rate)}, spec ${row.rate}`);
    if (found.audit !== row.audit)
      throw new Error(`${row.number}: audit ${String(found.audit)}, spec ${String(row.audit)}`);
    if (row.scoped && found.scoped === undefined)
      throw new Error(`${row.number}: declares no scope`);
  }
}

describe('the routes of step D1 are the routes of table 6.11.1', () => {
  it('parses 14 rows from the spec and the table has each: id (lower case), method, path, class, audit, scope', async () => {
    const rows = specRows();
    expect(rows.map((row) => row.number)).toEqual(D1_NUMBERS);
    const ops = await operations();
    expect(() => {
      checkAgainstSpec(rows, ops);
    }).not.toThrow();
    // The permission of each route is the one of the table, and it is scoped to its own resource type.
    for (const row of rows) {
      const op = ops.find(
        (candidate) => candidate.method === row.method && candidate.path === row.path,
      );
      const permission = op?.permission as keyof typeof PERMISSION_RESOURCE | undefined;
      // P52 declares contacts:read and asks distributionlists:read itself; the spec lists both.
      expect(permission, row.number).toBeDefined();
      expect(row.permission, row.number).not.toBe('');
      if (row.number !== 'P52') expect(permission, row.number).toBe(row.permission);
      expect(PERMISSION_RESOURCE[permission!], row.number).toBe(op?.scoped);
    }
  });

  it('every write route of step D1 is rated write and declares the audit action of the spec', async () => {
    const ops = (await operations()).filter((op) =>
      D1_NUMBERS.some((n) =>
        specRows().some((r) => r.number === n && r.path === op.path && r.method === op.method),
      ),
    );
    const writes = ops.filter((op) => op.method !== 'GET').sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(writes.map((op) => [op.id, op.rate, op.audit])).toEqual([
      ['contacts.create', 'write', 'contact.create'],
      ['contacts.delete', 'write', 'contact.delete'],
      ['contacts.update', 'write', 'contact.update'],
      ['distributionlists.members.add', 'write', 'dl.member.add'],
      ['distributionlists.members.remove', 'write', 'dl.member.remove'],
      ['groups.members.add', 'write', 'group.member.add'],
      ['groups.members.remove', 'write', 'group.member.remove'],
    ]);
  });

  it('negative: a table with a wrong class, a missing audit action or a different path fails the guard', async () => {
    const rows = specRows();
    const ops = await operations();
    const mutate = (change: (op: Operation) => Operation): Operation[] =>
      ops.map((op) => (op.id === 'contacts.delete' ? change(op) : op));
    expectGuardFails(
      () => {
        checkAgainstSpec(
          rows,
          mutate((op) => ({ ...op, rate: 'read' })),
        );
      },
      undefined,
      { reason: /class read/ },
    );
    expectGuardFails(
      () => {
        checkAgainstSpec(
          rows,
          mutate((op) => ({ ...op, audit: undefined })),
        );
      },
      undefined,
      { reason: /audit undefined/ },
    );
    expectGuardFails(
      () => {
        checkAgainstSpec(
          rows,
          mutate((op) => ({ ...op, path: '/api/v1/other' })),
        );
      },
      undefined,
      { reason: /not in the table/ },
    );
  });
});

describe('the Bestuur template over the routes of step D1 (US-D4, SC-D-003, brief criterion 12)', () => {
  /** The grants of the template, the list permissions scoped to one list as the template suggests. */
  function boardGrants(listGuid: string): Grant[] {
    const template = TEMPLATES.find((candidate) => candidate.key === 'board');
    if (template === undefined) throw new Error('no board template');
    return template.permissions.map((entry): Grant => {
      const resource = PERMISSION_RESOURCE[entry.permission];
      return {
        permission: entry.permission,
        qualifier: entry.qualifier,
        scope: resource === 'distributionList' ? [listId(listGuid)] : 'all',
      };
    });
  }

  it('does what the template says and refuses everything else with 403 and an audit row', async () => {
    const f = await createListsFixture();
    const mine = f.world.lists.marketing;
    const other = f.world.lists.sales;
    const me = f.actor(...boardGrants(mine.guid));
    const contact = f.world.contacts.erin;
    const bob = f.world.users.bob.id;

    const expected: [string, string, string, unknown, number][] = [
      ['P40', 'GET', '/api/v1/distribution-lists', undefined, 200],
      ['P41', 'GET', `/api/v1/distribution-lists/${mine.guid}`, undefined, 200],
      ['P41', 'GET', `/api/v1/distribution-lists/${other.guid}`, undefined, 403],
      ['P42', 'GET', `/api/v1/distribution-lists/${mine.guid}/members`, undefined, 200],
      ['P42', 'GET', `/api/v1/distribution-lists/${other.guid}/members`, undefined, 403],
      ['P45', 'GET', `/api/v1/distribution-lists/${mine.guid}/candidates?q=bob`, undefined, 200],
      ['P43', 'POST', `/api/v1/distribution-lists/${mine.guid}/members`, { members: [bob] }, 200],
      ['P43', 'POST', `/api/v1/distribution-lists/${other.guid}/members`, { members: [bob] }, 403],
      ['P44', 'DELETE', `/api/v1/distribution-lists/${mine.guid}/members`, { members: [bob] }, 200],
      [
        'P44',
        'DELETE',
        `/api/v1/distribution-lists/${other.guid}/members`,
        { members: [bob] },
        403,
      ],
      ['P47', 'GET', '/api/v1/contacts', undefined, 200],
      ['P48', 'GET', `/api/v1/contacts/${contact.guid}`, undefined, 200],
      [
        'P49',
        'POST',
        '/api/v1/contacts',
        {
          displayName: 'Board Guest',
          alias: 'board.guest',
          externalEmailAddress: 'guest@board.example',
        },
        201,
      ],
      ['P50', 'PATCH', `/api/v1/contacts/${contact.guid}`, { alias: 'erin.board' }, 403],
      ['P51', 'DELETE', `/api/v1/contacts/${contact.guid}`, { confirmName: 'Erin Partner' }, 403],
      ['P52', 'GET', `/api/v1/contacts/${contact.guid}/lists`, undefined, 200],
      [
        'P53',
        'POST',
        '/api/v1/groups/3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10/members',
        { members: [bob] },
        403,
      ],
      [
        'P54',
        'DELETE',
        '/api/v1/groups/3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10/members',
        { members: [bob] },
        403,
      ],
      ['export', 'POST', `/api/v1/distribution-lists/${mine.guid}/export`, {}, 404],
      ['settings', 'GET', '/api/v1/connection', undefined, 403],
      ['rbac', 'GET', '/api/v1/rbac/roles', undefined, 403],
    ];
    for (const [name, method, path, body, status] of expected) {
      const answer = await call<ProblemBody>(me.client, method as 'GET', path, body);
      expect(answer.status, `${name} ${method} ${path}`).toBe(status);
    }
    // The list shows only the assigned list; every refused write left an audit row under its route id.
    const list = await call<{ items: { id: string }[] }>(
      me.client,
      'GET',
      '/api/v1/distribution-lists',
    );
    expect(list.body.items.map((row) => row.id)).toEqual([mine.guid]);
    const denied = f
      .rows()
      .filter((row) => row.outcome === 'denied')
      .map((row) => row.action);
    expect(denied).toEqual(
      expect.arrayContaining([
        'distributionlists.members.add',
        'distributionlists.members.remove',
        'contacts.update',
        'contacts.delete',
        'groups.members.add',
        'groups.members.remove',
      ]),
    );
    // The users of the candidate search are the `basic` projection: id, name and mail, nothing more.
    const candidates = await call<{ items: Record<string, unknown>[] }>(
      me.client,
      'GET',
      `/api/v1/distribution-lists/${mine.guid}/candidates?q=carol`,
    );
    expect(Object.keys(candidates.body.items[0] ?? {}).sort()).toEqual([
      'alreadyMember',
      'displayName',
      'id',
      'kind',
      'mail',
    ]);
  });
});
