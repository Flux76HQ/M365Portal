// T-C-025, FR-C-405, AC-03: logs and errors carry no display name, address, user principal name, search
// text or id from a Graph answer. Canary people in the fake directory, a mix of requests (successes,
// refusals, failures of Graph, a failed manager call) and a scan of everything the server logged.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { GraphForbiddenError, GraphTransientError } from '../../src/ports/errors.js';
import { ALL_GROUPS, FULL_USERS, createDirectoryFixture, getJson } from './support.js';

const CANARY = {
  userName: 'Zanzibar Quxington',
  userMail: 'zanzibar.quxington@canary-mail.example',
  userUpn: 'zq-upn-canary@canary-mail.example',
  groupName: 'Canary Borealis Guild',
  groupMail: 'borealis-guild@canary-mail.example',
  search: 'canary-search-text-xyzzy',
} as const;

/** The guard: a log text names none of the canary values. */
function checkLogs(text: string, values: readonly string[]): void {
  for (const value of values) {
    if (text.includes(value)) throw new Error(`the log holds ${value.slice(0, 12)}...`);
  }
}

describe('nothing personal is logged (FR-C-405)', () => {
  it('keeps every name, address, id and search text out of the log, whatever the request', async () => {
    const f = await createDirectoryFixture();
    const person = f.directory.addUser({
      userPrincipalName: CANARY.userUpn,
      displayName: CANARY.userName,
      mail: CANARY.userMail,
      department: 'Canary',
    });
    const guild = f.directory.addGroup({
      displayName: CANARY.groupName,
      mail: CANARY.groupMail,
      groupTypes: ['Unified'],
      mailEnabled: true,
      securityEnabled: false,
    });
    f.directory.addMember(guild.id, person.id);
    f.directory.addOwner(guild.id, person.id);
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const scoped = f.actor({
      permission: 'users:read',
      qualifier: 'full',
      scope: [{ target: 'user', match: { by: 'department', value: 'Other' } }],
    });
    await f.settle();
    f.logs.clear();

    const calls: [string, Record<string, string>][] = [
      ['/api/v1/users', { q: CANARY.userName.slice(0, 8) }],
      ['/api/v1/users', { q: CANARY.search }],
      ['/api/v1/users', { q: CANARY.userMail }],
      [`/api/v1/users/${person.id}`, {}],
      [`/api/v1/users/${person.id}/groups`, {}],
      ['/api/v1/groups', { q: CANARY.groupName }],
      [`/api/v1/groups/${guild.id}`, {}],
      [`/api/v1/groups/${guild.id}/members`, {}],
      [`/api/v1/groups/${guild.id}/owners`, {}],
    ];
    for (const [path, params] of calls) await getJson(me.client, path, params);
    // A refusal by scope (the denial is audited, not logged with a name).
    await getJson(scoped.client, `/api/v1/users/${person.id}`);
    // A failed manager call, a Graph refusal and an outage.
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: 'getUserManager' });
    await getJson(me.client, `/api/v1/users/${person.id}`);
    f.fake.failNext(new GraphForbiddenError({ graphCode: 'Authorization_RequestDenied' }), {
      method: 'listUsers',
    });
    await getJson(me.client, '/api/v1/users', { q: CANARY.search });
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: 'listGroupMembers' });
    await getJson(me.client, `/api/v1/groups/${guild.id}/members`);
    // A bad query and a bad cursor.
    await getJson(me.client, '/api/v1/users', { q: `${CANARY.search}\n` });
    await getJson(me.client, '/api/v1/users', { cursor: CANARY.search });

    const text = f.logs.text();
    expect(text.length).toBeGreaterThan(200);
    const values = [...Object.values(CANARY), person.id, guild.id];
    expect(() => {
      checkLogs(text, values);
    }).not.toThrow();
    // What IS logged per request: the request id, the method, the route template, the status, the duration.
    const requests = f.logs.lines().filter((line) => line.msg === 'request');
    expect(requests.length).toBeGreaterThanOrEqual(calls.length);
    for (const line of requests) {
      expect(Object.keys(line).sort()).toEqual(
        expect.arrayContaining(['durationMs', 'method', 'requestId', 'route', 'status']),
      );
    }
    // The audit entry of the denial names the route and the permission, not the person.
    const audit = JSON.stringify(f.rows());
    expect(audit).not.toContain(CANARY.userName);
    expect(audit).not.toContain(person.id);
  });

  it('negative: a log line that holds a name, an address, a search text or an id fails the guard', () => {
    const values = Object.values(CANARY);
    expectGuardFails(
      (text: string) => {
        checkLogs(text, values);
      },
      `{"msg":"listed ${CANARY.userName}"}`,
      { reason: 'the log holds' },
    );
    expectGuardFails(
      (text: string) => {
        checkLogs(text, values);
      },
      `{"q":"${CANARY.search}"}`,
      { reason: 'the log holds' },
    );
    expectGuardFails(
      (text: string) => {
        checkLogs(text, values);
      },
      `mail ${CANARY.groupMail}`,
      { reason: 'the log holds' },
    );
    expect(() => {
      checkLogs('{"msg":"request","route":"/api/v1/users/{id}","status":200}', values);
    }).not.toThrow();
  });
});
