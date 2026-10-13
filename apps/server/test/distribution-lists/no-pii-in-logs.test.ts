// T-D-113, T-D-118 to T-D-123, FR-D-107, SC-D-008: logs and entries carry no display name, address, search
// text or id from an Exchange or Graph answer. Canary people, lists and contacts, a mix of requests
// (successes, refusals, failures of Exchange and Graph, a throttle, a duplicate, a wrong confirmation) and a
// scan of everything the server logged and of every audit entry.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
  GraphForbiddenError,
} from '../../src/ports/errors.js';
import {
  CREATE_CONTACTS,
  DELETE_CONTACTS,
  READ_CONTACTS,
  READ_GROUPS,
  READ_LISTS,
  READ_USERS,
  UPDATE_CONTACTS,
  WRITE_GROUP_MEMBERS,
  WRITE_MEMBERS,
  call,
  createListsFixture,
} from './support.js';

const CANARY = {
  userName: 'Zanzibar Quxington',
  userMail: 'zanzibar.quxington@canary-mail.example',
  listName: 'Canary Borealis Guild',
  listMail: 'borealis-guild@canary-mail.example',
  contactName: 'Xylophone Marlowe',
  contactMail: 'xylophone.marlowe@canary-outside.example',
  contactAlias: 'xylophone.canary',
  search: 'canary-search-text-xyzzy',
} as const;

function checkLogs(text: string, values: readonly string[]): void {
  for (const value of values) {
    if (text.includes(value)) throw new Error(`the log holds ${value.slice(0, 12)}...`);
  }
}

describe('nothing personal is logged or audited (FR-D-107)', () => {
  it('keeps every name, address, id and search text out of the log, whatever the request', async () => {
    const f = await createListsFixture();
    const person = f.directory.addUser({
      userPrincipalName: CANARY.userMail,
      displayName: CANARY.userName,
      mail: CANARY.userMail,
    });
    const recipient = f.exchangeState.addRecipient({
      displayName: CANARY.userName,
      primarySmtpAddress: CANARY.userMail,
      externalDirectoryObjectId: person.id,
    });
    const list = f.exchangeState.addDistributionGroup({
      name: CANARY.listName,
      primarySmtpAddress: CANARY.listMail,
      managedByApp: true,
      members: [recipient],
    });
    const contact = f.exchangeState.addMailContact({
      displayName: CANARY.contactName,
      alias: CANARY.contactAlias,
      externalEmailAddress: CANARY.contactMail,
    });
    const group = f.directory.addGroup({
      displayName: CANARY.listName,
      groupTypes: [],
      securityEnabled: true,
    });
    const me = f.actor(
      READ_LISTS,
      WRITE_MEMBERS,
      READ_USERS,
      READ_CONTACTS,
      CREATE_CONTACTS,
      UPDATE_CONTACTS,
      DELETE_CONTACTS,
      WRITE_GROUP_MEMBERS,
      READ_GROUPS,
    );
    const reader = f.actor(READ_USERS);
    await f.settle();
    f.logs.clear();

    const lists = '/api/v1/distribution-lists';
    await call(me.client, 'GET', `${lists}?q=${encodeURIComponent(CANARY.search)}`);
    await call(me.client, 'GET', `${lists}?q=canary`);
    await call(me.client, 'GET', `${lists}/${list.guid}`);
    await call(me.client, 'GET', `${lists}/${list.guid}/members`);
    await call(
      me.client,
      'GET',
      `${lists}/${list.guid}/candidates?q=${encodeURIComponent(CANARY.userName.slice(0, 6))}`,
    );
    await call(me.client, 'POST', `${lists}/${list.guid}/members`, {
      members: [f.world.users.bob.id, contact.guid],
    });
    await call(me.client, 'DELETE', `${lists}/${list.guid}/members`, {
      members: [person.id, contact.guid],
    });
    await call(
      me.client,
      'GET',
      `/api/v1/contacts?q=${encodeURIComponent(CANARY.contactName.slice(0, 5))}`,
    );
    await call(me.client, 'GET', `/api/v1/contacts/${contact.guid}`);
    await call(me.client, 'GET', `/api/v1/contacts/${contact.guid}/lists`);
    await call(me.client, 'POST', '/api/v1/contacts', {
      displayName: 'Other Canary',
      alias: 'other.canary',
      externalEmailAddress: CANARY.contactMail,
    });
    await call(me.client, 'PATCH', `/api/v1/contacts/${contact.guid}`, {
      alias: 'xylophone.renamed',
    });
    await call(me.client, 'DELETE', `/api/v1/contacts/${contact.guid}`, {
      confirmName: 'wrong name',
    });
    await call(me.client, 'DELETE', `/api/v1/contacts/${contact.guid}`, {
      confirmName: CANARY.contactName,
    });
    await call(me.client, 'POST', `/api/v1/groups/${group.id}/members`, { members: [person.id] });
    await call(me.client, 'DELETE', `/api/v1/groups/${group.id}/members`, { members: [person.id] });
    // Refusals, failures of Exchange and of Graph.
    await call(reader.client, 'GET', `${lists}/${list.guid}`);
    f.exchange.failNext(new ExchangeUnavailableError({ reason: 'role_pending' }));
    await call(me.client, 'GET', `${lists}/${list.guid}/members`);
    f.exchange.failNext(new ExchangeThrottledError({ retryAfterMs: 4_000 }), {
      method: 'addDistributionGroupMember',
    });
    await call(me.client, 'POST', `${lists}/${list.guid}/members`, {
      members: [f.world.users.carol.id],
    });
    f.exchange.failNext(new ExchangeCommandError('permission_denied'), {
      method: 'removeMailContact',
    });
    await call(me.client, 'DELETE', `/api/v1/contacts/${f.world.contacts.erin.guid}`, {
      confirmName: 'Erin Partner',
    });
    f.fake.failNext(new GraphForbiddenError(), { method: 'addGroupMember' });
    await call(me.client, 'POST', `/api/v1/groups/${group.id}/members`, {
      members: [f.world.users.bob.id],
    });
    await call(me.client, 'GET', `${lists}?q=${encodeURIComponent(`${CANARY.search}*`)}`);

    const text = f.logs.text();
    expect(text.length).toBeGreaterThan(200);
    const values = [
      ...Object.values(CANARY),
      person.id,
      list.guid,
      contact.guid,
      group.id,
      f.world.users.bob.id,
      f.world.users.carol.id,
    ];
    expect(() => {
      checkLogs(text, values);
    }).not.toThrow();
    // The request lines name the route template, never the path.
    const requests = f.logs.lines().filter((line) => line.msg === 'request');
    expect(requests.length).toBeGreaterThanOrEqual(20);
    // Not one audit entry holds a name or an address either (ids are object ids, by design).
    const audit = JSON.stringify(f.rows());
    for (const value of Object.values(CANARY)) expect(audit).not.toContain(value);
    expect(audit).not.toMatch(/@/);
    // The worker's own log lines (session, client) carry the request id, cmdlet, outcome and duration only.
    expect(text).not.toMatch(/Add-DistributionGroupMember|New-MailContact/);
  });

  it('negative: a log line that holds a name, an address or a search text fails the guard', () => {
    const values = Object.values(CANARY);
    for (const text of [
      `{"msg":"listed ${CANARY.listName}"}`,
      `{"q":"${CANARY.search}"}`,
      `mail ${CANARY.contactMail}`,
    ]) {
      expectGuardFails(
        (line: string) => {
          checkLogs(line, values);
        },
        text,
        { reason: 'the log holds' },
      );
    }
  });
});
