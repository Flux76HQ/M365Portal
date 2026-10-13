// T-D-120, T-D-122, T-D-123, FR-D-201, FR-D-301, FR-D-352, SC-D-003: the policy matrix over the routes of step
// D1. For each built-in role and each route P40 to P45 and P47 to P54, the answer is 403 exactly when the
// role lacks the permission the route needs, and a success otherwise. The expectation is read from the role
// matrix of `docs/permissions.md` by a parser that shares no code with the application (the same source the
// policy matrix of Phase B uses), not from `BUILTIN_ROLES`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { call, createListsFixture, type ListsFixture } from './support.js';

const DOC = fileURLToPath(new URL('../../../../docs/permissions.md', import.meta.url));
const ROLES = ['owner', 'admin', 'operator', 'helpdesk', 'reader'] as const;

/** The role matrix: permission -> the role keys that hold it (an "x" in the column of the role). */
function matrix(): Map<string, Set<string>> {
  const rows = new Map<string, Set<string>>();
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const permission = /^`([a-z]+:[a-z:]+)`$/.exec(cells[1] ?? '')?.[1];
    if (permission === undefined || cells.length < 9) continue;
    const held = new Set<string>();
    ROLES.forEach((role, index) => {
      if (cells[3 + index] === 'x') held.add(role);
    });
    rows.set(permission, held);
  }
  return rows;
}

interface Case {
  readonly number: string;
  readonly needs: readonly string[];
  readonly success: number;
  readonly request: (f: ListsFixture, group: string) => [string, string, unknown?];
}

const CASES: readonly Case[] = [
  {
    number: 'P40',
    needs: ['distributionlists:read'],
    success: 200,
    request: () => ['GET', '/api/v1/distribution-lists'],
  },
  {
    number: 'P41',
    needs: ['distributionlists:read'],
    success: 200,
    request: (f) => ['GET', `/api/v1/distribution-lists/${f.world.lists.marketing.guid}`],
  },
  {
    number: 'P42',
    needs: ['distributionlists:read'],
    success: 200,
    request: (f) => ['GET', `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members`],
  },
  {
    number: 'P43',
    needs: ['distributionlists:members:write'],
    success: 200,
    request: (f) => [
      'POST',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members`,
      { members: [f.world.users.bob.id] },
    ],
  },
  {
    number: 'P44',
    needs: ['distributionlists:members:write'],
    success: 200,
    request: (f) => [
      'DELETE',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members`,
      { members: [f.world.users.alice.id] },
    ],
  },
  {
    number: 'P45',
    needs: ['distributionlists:members:write'],
    success: 200,
    request: (f) => [
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/candidates?q=bob`,
    ],
  },
  {
    number: 'P47',
    needs: ['contacts:read'],
    success: 200,
    request: () => ['GET', '/api/v1/contacts'],
  },
  {
    number: 'P48',
    needs: ['contacts:read'],
    success: 200,
    request: (f) => ['GET', `/api/v1/contacts/${f.world.contacts.erin.guid}`],
  },
  {
    number: 'P49',
    needs: ['contacts:create'],
    success: 201,
    request: () => [
      'POST',
      '/api/v1/contacts',
      {
        displayName: 'Frank Newman',
        alias: 'frank.newman',
        externalEmailAddress: 'frank@newman.example',
      },
    ],
  },
  {
    number: 'P50',
    needs: ['contacts:update'],
    success: 200,
    request: (f) => [
      'PATCH',
      `/api/v1/contacts/${f.world.contacts.erin.guid}`,
      { alias: 'erin.matrix' },
    ],
  },
  {
    number: 'P51',
    needs: ['contacts:delete'],
    success: 200,
    request: (f) => [
      'DELETE',
      `/api/v1/contacts/${f.world.contacts.erin.guid}`,
      { confirmName: 'Erin Partner' },
    ],
  },
  {
    number: 'P52',
    needs: ['contacts:read', 'distributionlists:read'],
    success: 200,
    request: (f) => ['GET', `/api/v1/contacts/${f.world.contacts.dave.guid}/lists`],
  },
  {
    number: 'P53',
    needs: ['groups:members:write'],
    success: 200,
    request: (f, group) => [
      'POST',
      `/api/v1/groups/${group}/members`,
      { members: [f.world.users.bob.id] },
    ],
  },
  {
    number: 'P54',
    needs: ['groups:members:write'],
    success: 200,
    request: (f, group) => [
      'DELETE',
      `/api/v1/groups/${group}/members`,
      { members: [f.world.users.bob.id] },
    ],
  },
];

describe('the built-in roles over the routes of step D1 (the matrix of docs/permissions.md)', () => {
  it('parses the matrix: 15 permissions, the totals of the document', () => {
    const rows = matrix();
    expect(rows.size).toBe(15);
    expect(
      [...ROLES].map((role) => [...rows.values()].filter((held) => held.has(role)).length),
    ).toEqual([15, 13, 9, 6, 4]);
  });

  for (const role of ROLES) {
    it(`${role}: 403 where the permission is missing, a success where it is held`, async () => {
      const rows = matrix();
      const f = await createListsFixture();
      const group = f.directory.addGroup({
        displayName: 'Matrix Crew',
        groupTypes: [],
        securityEnabled: true,
      });
      f.directory.addMember(group.id, f.world.users.bob.id);
      const me = f.signIn({ kind: 'user', roles: [role], stepUpAgoMs: 60_000 });
      for (const entry of CASES) {
        const [method, path, body] = entry.request(f, group.id);
        const holds = entry.needs.every((permission) => rows.get(permission)?.has(role) === true);
        const answer = await call(me.client, method as 'GET', path, body);
        expect(answer.status, `${role} ${entry.number} ${method} ${path}`).toBe(
          holds ? entry.success : 403,
        );
      }
      // Every refusal is audited under its route id; a read of a role that reads is not audited at all.
      const denied = f.rows().filter((row) => row.outcome === 'denied');
      const expectedDenied = CASES.filter(
        (entry) => !entry.needs.every((permission) => rows.get(permission)?.has(role) === true),
      );
      expect(denied).toHaveLength(expectedDenied.length);
    });
  }
});
