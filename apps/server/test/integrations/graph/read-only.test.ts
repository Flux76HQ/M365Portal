// T-C-017, FR-C-105, SC-C2 (Phase C) rewritten for Phase D by T-D-116, FR-D-351 (+ negative): the
// Graph client reads, and writes exactly two things. Phase C's guard failed on any method with a
// writing name; it is now an ALLOW-LIST of exactly `addGroupMember` and `removeGroupMember`, and it
// still fails on every other one. On the wire the same holds: GET everywhere, the one POST that is a
// read (`checkMemberGroups`), and the two member calls, each with a path from `memberRefPath`, which
// always ends in `/$ref` (without it Graph deletes the member object itself, R-D-08). The in-memory
// client has the same two writes and no others.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createHttpGraphClient,
  HttpGraphClient,
} from '../../../src/integrations/graph/graph-client.js';
import { GRAPH_METHOD_PERMISSIONS } from '../../../src/integrations/graph/permissions-map.js';
import { FakeGraphClient } from '../../fakes/fake-graph-client.js';
import { fakeGuid, installFakeGraph, seedDirectory } from '../../fakes/fake-tenant/graph/index.js';
import { fake } from '../../support/msw.js';
import { createTime, sequenceRandom, staticAppTokens } from '../support.js';

const WRITE_NAME =
  /^(create|update|delete|add|remove|set|reset|patch|put|post|write|grant|assign)/i;
/** The allow-list of write methods (FR-D-351): exactly these two, and no other. */
const WRITE_ALLOWED = ['addGroupMember', 'removeGroupMember'] as const;

/** The guard: every method with a writing name is on the allow-list, and the two are all there are. */
function checkNames(names: readonly string[]): void {
  const writing = names.filter(
    (name) => WRITE_NAME.test(name) && !(WRITE_ALLOWED as readonly string[]).includes(name),
  );
  if (writing.length > 0) throw new Error(`writing method: ${writing.join(', ')}`);
}

/** The requests of a source that are not reads, as `METHOD route` with the path expression. */
function writesOf(text: string): { method: string; route: string; path: string }[] {
  const source = ts.createSourceFile('graph-client.ts', text, ts.ScriptTarget.Latest, true);
  const found: { method: string; route: string; path: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const read = (name: string): ts.Expression | undefined => {
        const property = node.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) && candidate.name.getText(source) === name,
        );
        return property?.initializer;
      };
      const method = read('method');
      const route = read('route');
      if (method !== undefined && ts.isStringLiteral(method) && method.text !== 'GET') {
        found.push({
          method: method.text,
          route: route !== undefined && ts.isStringLiteral(route) ? route.text : '?',
          path: read('path')?.getText(source) ?? '?',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The writes the real client may send: method, route and where the path comes from. */
const WIRE_ALLOWED = [
  { method: 'POST', route: 'users.check_member_groups', pathStartsWith: '`/users/' },
  { method: 'POST', route: 'groups.members.add', pathStartsWith: 'memberRefPath(' },
  { method: 'DELETE', route: 'groups.members.remove', pathStartsWith: 'memberRefPath(' },
] as const;

/** The guard: a source sends no write but the three, and the member calls take their path from `memberRefPath`. */
function checkSource(text: string): void {
  const writes = writesOf(text);
  for (const write of writes) {
    const allowed = WIRE_ALLOWED.find(
      (candidate) => candidate.method === write.method && candidate.route === write.route,
    );
    if (allowed === undefined)
      throw new Error(`a ${write.method} request is sent (${write.route})`);
    if (!write.path.startsWith(allowed.pathStartsWith)) {
      throw new Error(`${write.route}: the path does not come from memberRefPath`);
    }
  }
  for (const allowed of WIRE_ALLOWED) {
    const count = writes.filter(
      (write) => write.method === allowed.method && write.route === allowed.route,
    ).length;
    if (count !== 1)
      throw new Error(`${String(count)} ${allowed.method} ${allowed.route} requests, expected 1`);
  }
}

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

describe('the surface of the Graph client has two write methods and no other (FR-D-351)', () => {
  it('names no method of the port, the map or the real client like a write, but the two', () => {
    const real = Object.getOwnPropertyNames(HttpGraphClient.prototype).filter(
      (name) => name !== 'constructor',
    );
    const mapped = Object.keys(GRAPH_METHOD_PERMISSIONS);
    expect(mapped.length).toBe(14);
    expect(() => {
      checkNames([...real, ...mapped]);
    }).not.toThrow();
    for (const name of WRITE_ALLOWED) {
      expect(real).toContain(name);
      expect(mapped).toContain(name);
    }
    expect([...real, ...mapped].filter((name) => WRITE_NAME.test(name)).sort()).toEqual(
      [...WRITE_ALLOWED, ...WRITE_ALLOWED].sort(),
    );
  });

  it('negative: any other writing name fails the guard, and the two names still pass', () => {
    class Fixture {
      addMember(): void {
        /* a fixture: the name is what the guard reads */
      }
    }
    expectGuardFails(checkNames, Object.getOwnPropertyNames(Fixture.prototype), {
      reason: 'writing method: addMember',
    });
    for (const name of [
      'createUser',
      'updateGroup',
      'deleteGroup',
      'removeMember',
      'removeGroupOwner',
      'addGroupOwner',
      'addGroupMembers',
      'removeGroupMemberBulk',
      'setManager',
      'resetPassword',
      'patchGroup',
    ]) {
      expectGuardFails(checkNames, [name], { reason: 'writing method' });
    }
    expect(() => {
      checkNames(['addGroupMember', 'removeGroupMember', 'listGroupMembers', 'checkMemberGroups']);
    }).not.toThrow();
  });
});

describe('the real client sends GET, the one POST that reads, and the two member calls (FR-D-351)', () => {
  const text = readFileSync(`${SRC}/integrations/graph/graph-client.ts`, 'utf8');

  it('has exactly three non-GET requests: checkMemberGroups, add and remove', () => {
    expect(() => {
      checkSource(text);
    }).not.toThrow();
    expect(
      writesOf(text)
        .map((write) => `${write.method} ${write.route}`)
        .sort(),
    ).toEqual([
      'DELETE groups.members.remove',
      'POST groups.members.add',
      'POST users.check_member_groups',
    ]);
  });

  it('negative: a PATCH, a PUT, another DELETE or POST, a path that does not come from memberRefPath, or a missing call fails the guard', () => {
    const append = (code: string): string => `${text}\n${code}`;
    expectGuardFails(
      checkSource,
      append("const x = { method: 'PATCH', route: 'groups.patch', path: p };"),
      {
        name: 'PATCH',
        reason: 'a PATCH request is sent',
      },
    );
    expectGuardFails(
      checkSource,
      append("const x = { method: 'PUT', route: 'groups.put', path: p };"),
      {
        name: 'PUT',
        reason: 'a PUT request is sent',
      },
    );
    expectGuardFails(
      checkSource,
      append("const x = { method: 'DELETE', route: 'groups.delete', path: `/groups/${g}` };"),
      { name: 'DELETE', reason: 'a DELETE request is sent (groups.delete)' },
    );
    expectGuardFails(
      checkSource,
      append("const x = { method: 'POST', route: 'users.create', path: '/users' };"),
      { name: 'POST', reason: 'a POST request is sent (users.create)' },
    );
    expectGuardFails(
      checkSource,
      text.replace(
        /path: memberRefPath\(groupId, memberId\)/,
        'path: `/groups/${groupId}/members/${memberId}`',
      ),
      { name: 'path without memberRefPath', reason: 'does not come from memberRefPath' },
    );
    expectGuardFails(checkSource, text.replace("method: 'DELETE'", "method: 'GET'"), {
      name: 'missing call',
      reason: '0 DELETE groups.members.remove requests, expected 1',
    });
  });

  it('puts GET only on the wire when every read method runs, then exactly one POST and one DELETE for the two writes', async () => {
    fake.reset();
    const graph = installFakeGraph(fake);
    const seeded = seedDirectory(graph.directory, { users: 300, groups: 40 });
    graph.control.managerForApps('allowed');
    const token = graph.world.tokens.issue({
      audience: 'graph',
      kind: 'app',
      appId: fakeGuid('read-only-app', 1),
      roles: GRAPH_APP_ROLES,
    });
    const time = createTime();
    const client = createHttpGraphClient({
      appTokens: staticAppTokens(token.value).provider,
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    });
    const { ids } = seeded;
    await client.getOrganization();
    await client.probeUsers();
    await client.getUser(ids.noManagerUser);
    await client.searchGroups('Fin', 5);
    await client.getGroup(ids.m365Group);
    await client.listUsers({ enabled: 'all', type: 'all', order: 'asc', top: 5 });
    await client.getUserManager(ids.userWithManager);
    await client.listUserGroups(ids.noManagerUser, { top: 5 });
    await client.listGroups({ kind: 'all', order: 'asc', top: 5 });
    await client.listGroupMembers(ids.bigGroup, { top: 5 });
    await client.listGroupOwners(ids.bigGroup, { top: 5 });
    const before = fake.calls.all().length;
    await client.checkMemberGroups(ids.noManagerUser, [ids.m365Group]);
    const reads = fake.calls.all();
    expect(reads.length).toBeGreaterThan(10);
    for (const call of reads.slice(0, before)) expect(call.method, call.path).toBe('GET');
    expect(reads.slice(before).map((call) => call.method)).toEqual(['POST']);
    expect(fake.calls.mutating()).toHaveLength(0);

    // The two writes, on a security group that is not dynamic, not synced and has no hidden membership.
    const group = graph.directory.addGroup({ displayName: 'Write target', mailEnabled: false });
    const user = graph.directory.addUser({ userPrincipalName: 'writer@contoso-fake.example' });
    const start = fake.calls.all().length;
    await client.addGroupMember(group.id, user.id);
    await client.removeGroupMember(group.id, user.id);
    const writes = fake.calls.all().slice(start);
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /v1.0/groups/${group.id}/members/$ref`,
      `DELETE /v1.0/groups/${group.id}/members/${user.id}/$ref`,
    ]);
    expect(fake.calls.mutating()).toHaveLength(2);
    for (const call of writes) expect(call.path.endsWith('/$ref')).toBe(true);
  });

  it('the in-memory client has the same two writes, the same read methods, and no other writing name', () => {
    const names = Object.getOwnPropertyNames(FakeGraphClient.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('#'),
    );
    expect(() => {
      checkNames(names);
    }).not.toThrow();
    for (const method of Object.keys(GRAPH_METHOD_PERMISSIONS)) expect(names).toContain(method);
  });
});
