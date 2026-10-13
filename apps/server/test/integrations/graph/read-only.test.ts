// T-C-017, FR-C-105, SC-C2: the Graph client of Phase C is read only. The port has no method that
// creates, updates, deletes, adds, removes, sets or resets; `HttpGraphClient` sends no request with a
// method other than GET (the existing `checkMemberGroups` POST is a read and is the one exception,
// allowed by name); and a fixture method `addMember` fails the guard.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
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
/** The one POST of the client: a read that uses POST (directoryobject-checkmembergroups). */
const POST_ALLOWED = new Set(['checkMemberGroups']);

/** The guard: no method of the surface has a writing name. */
function checkNames(names: readonly string[]): void {
  const writing = names.filter((name) => WRITE_NAME.test(name));
  if (writing.length > 0) throw new Error(`writing method: ${writing.join(', ')}`);
}

/** The guard: a source file sends no HTTP method other than GET, but the allowed POST. */
function checkSource(text: string): void {
  const methods = [...text.matchAll(/method:\s*'([A-Z]+)'/g)].map((match) => match[1] ?? '');
  const other = methods.filter((method) => method !== 'GET' && method !== 'POST');
  if (other.length > 0) throw new Error(`a ${other.join(', ')} request is sent`);
  const posts = methods.filter((method) => method === 'POST').length;
  if (posts !== POST_ALLOWED.size)
    throw new Error(`${String(posts)} POST requests, expected ${String(POST_ALLOWED.size)}`);
}

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

describe('the surface of the Graph client has no write method (FR-C-105)', () => {
  it('names no method of the port, the map or the real client like a write', () => {
    const real = Object.getOwnPropertyNames(HttpGraphClient.prototype).filter(
      (name) => name !== 'constructor',
    );
    const mapped = Object.keys(GRAPH_METHOD_PERMISSIONS);
    expect(mapped.length).toBe(12);
    expect(() => {
      checkNames([...real, ...mapped]);
    }).not.toThrow();
  });

  it('negative: a fixture method addMember (or any writing name) fails the guard', () => {
    class Fixture {
      addMember(): void {
        /* a fixture: the name is what the guard reads */
      }
    }
    const names = Object.getOwnPropertyNames(Fixture.prototype);
    expectGuardFails(checkNames, names, { reason: 'writing method: addMember' });
    for (const name of [
      'createUser',
      'updateGroup',
      'deleteGroup',
      'removeMember',
      'setManager',
      'resetPassword',
    ]) {
      expectGuardFails(checkNames, [name], { reason: 'writing method' });
    }
    expect(() => {
      checkNames(['listGroupMembers', 'getUserManager', 'checkMemberGroups']);
    }).not.toThrow();
  });
});

describe('the real client sends GET only, with the one allowed POST (FR-C-105)', () => {
  it('has no write verb in graph-client.ts and a single POST: checkMemberGroups', () => {
    const text = readFileSync(`${SRC}/integrations/graph/graph-client.ts`, 'utf8');
    expect(() => {
      checkSource(text);
    }).not.toThrow();
    expect(text).toMatch(/route: 'users\.check_member_groups'/);
  });

  it('negative: a PATCH, a DELETE or a second POST fails the guard', () => {
    const fine = "method: 'GET'\nmethod: 'POST'";
    expectGuardFails(checkSource, `${fine}\nmethod: 'PATCH'`, { reason: 'PATCH request is sent' });
    expectGuardFails(checkSource, `${fine}\nmethod: 'DELETE'`, {
      reason: 'DELETE request is sent',
    });
    expectGuardFails(checkSource, `${fine}\nmethod: 'POST'`, { reason: '2 POST requests' });
  });

  it('puts nothing but GET on the wire when every read method runs, and POST only for checkMemberGroups', async () => {
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
    const calls = fake.calls.all();
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls.slice(0, before)) expect(call.method, call.path).toBe('GET');
    expect(calls.slice(before).map((call) => call.method)).toEqual(['POST']);
    expect(fake.calls.mutating()).toHaveLength(0);
  });

  it('the in-memory client has the same read methods and no write one', () => {
    const names = Object.getOwnPropertyNames(FakeGraphClient.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('#'),
    );
    expect(() => {
      checkNames(names);
    }).not.toThrow();
    for (const method of Object.keys(GRAPH_METHOD_PERMISSIONS)) expect(names).toContain(method);
  });
});
