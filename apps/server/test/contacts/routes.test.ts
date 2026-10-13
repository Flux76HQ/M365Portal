// T-D-121, T-D-122, FR-D-301 to FR-D-305, EC-D9, EC-D10, US-D2: the contact routes P47 to P52 on the real
// application, with the in-memory Exchange client: validation, the derived Exchange name, duplicates
// without an id, the typed confirmation, synchronised contacts, the scope rule for a new contact, and the
// audit entries with field names only.
import {
  ContactDeleteResponseSchema,
  ContactDetailSchema,
  ContactListResponseSchema,
  ContactListsResponseSchema,
  type ContactListItem,
} from '@m365portal/shared/schemas/contacts';
import { describe, expect, it } from 'vitest';
import { deriveContactName } from '../../src/contacts/validation.js';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import { sequenceRandom } from '../integrations/support.js';
import {
  CREATE_CONTACTS,
  DELETE_CONTACTS,
  READ_CONTACTS,
  READ_LISTS,
  UPDATE_CONTACTS,
  call,
  contactPrefix,
  createListsFixture,
  failingOn,
  listPrefix,
  scoped,
  walkAll,
  type ListsFixture,
  type ProblemBody,
} from '../distribution-lists/support.js';

const ALL = [READ_CONTACTS, CREATE_CONTACTS, UPDATE_CONTACTS, DELETE_CONTACTS, READ_LISTS] as const;
const NEW_CONTACT = {
  displayName: 'Frank Newman',
  alias: 'frank.newman',
  externalEmailAddress: 'frank@newman.example',
};

const contactRows = (f: ListsFixture, action: string) =>
  f.rows().filter((row) => row.action === action);

describe('GET /api/v1/contacts (P47) and GET /api/v1/contacts/{id} (P48)', () => {
  it('lists contacts by name with a prefix search and pages them, no store', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_CONTACTS);
    const answer = await call(me.client, 'GET', '/api/v1/contacts');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    const body = ContactListResponseSchema.parse(answer.body);
    expect(body.items).toEqual([
      {
        id: f.world.contacts.dave.guid,
        displayName: 'Dave Outside',
        alias: 'dave.outside',
        externalEmailAddress: 'dave@elsewhere.example',
        synced: false,
      },
      {
        id: f.world.contacts.erin.guid,
        displayName: 'Erin Partner',
        alias: 'erin.partner',
        externalEmailAddress: 'erin@partner.example',
        synced: false,
      },
    ]);
    const paged = await walkAll<ContactListItem>(me.client, '/api/v1/contacts', { limit: '1' });
    expect(paged.pages).toBe(2);
    expect(paged.rows.map((row) => row.displayName)).toEqual(['Dave Outside', 'Erin Partner']);
    const found = await walkAll<ContactListItem>(me.client, '/api/v1/contacts', { q: 'erin' });
    expect(found.rows.map((row) => row.displayName)).toEqual(['Erin Partner']);
    const desc = await walkAll<ContactListItem>(me.client, '/api/v1/contacts', { order: 'desc' });
    expect(desc.rows.map((row) => row.displayName)).toEqual(['Erin Partner', 'Dave Outside']);
    expect(f.rows()).toEqual([]);
  });

  it('gives the detail with the synchronised flag and the first and last name, 404 for an unknown contact', async () => {
    const f = await createListsFixture();
    f.world.contacts.erin.isDirSynced = true;
    f.world.contacts.erin.firstName = 'Erin';
    const me = f.actor(READ_CONTACTS);
    const body = ContactDetailSchema.parse(
      (await call(me.client, 'GET', `/api/v1/contacts/${f.world.contacts.erin.guid}`)).body,
    );
    expect(body).toMatchObject({
      id: f.world.contacts.erin.guid,
      synced: true,
      firstName: 'Erin',
      lastName: null,
      hiddenFromAddressLists: false,
      createdDateTime: '2021-08-02T10:30:06.000Z',
    });
    expect(
      (await call(me.client, 'GET', '/api/v1/contacts/9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60'))
        .status,
    ).toBe(404);
    expect((await call(me.client, 'GET', '/api/v1/contacts/x')).status).toBe(422);
    // A user's GUID is no contact: the answer to a miss is "not found", never somebody else's row (R-D-09).
    expect(
      (await call(me.client, 'GET', `/api/v1/contacts/${f.world.users.alice.recipient.guid}`))
        .status,
    ).toBe(404);
  });

  it('shows only the contacts of the scope, and the detail agrees', async () => {
    const f = await createListsFixture();
    const me = f.actor(scoped('contacts:read', [contactPrefix('displayName', 'Erin')]));
    const rows = await walkAll<ContactListItem>(me.client, '/api/v1/contacts');
    expect(rows.rows.map((row) => row.displayName)).toEqual(['Erin Partner']);
    const out = await call<ProblemBody>(
      me.client,
      'GET',
      `/api/v1/contacts/${f.world.contacts.dave.guid}`,
    );
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('permission_denied');
    const byAlias = f.actor(scoped('contacts:read', [contactPrefix('alias', 'dave.')]));
    expect((await walkAll<ContactListItem>(byAlias.client, '/api/v1/contacts')).rows).toHaveLength(
      1,
    );
    const byMail = f.actor(scoped('contacts:read', [contactPrefix('mail', 'erin@')]));
    expect((await walkAll<ContactListItem>(byMail.client, '/api/v1/contacts')).rows).toHaveLength(
      1,
    );
  });
});

describe('POST /api/v1/contacts (P49)', () => {
  it('creates a contact, answers 201 with the contact as read back and a Location, and derives the Exchange name', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const answer = await call(me.client, 'POST', '/api/v1/contacts', {
      ...NEW_CONTACT,
      firstName: 'Frank',
      lastName: 'Newman',
    });
    expect(answer.status).toBe(201);
    const body = ContactDetailSchema.parse(answer.body);
    expect(body).toMatchObject({
      ...NEW_CONTACT,
      firstName: 'Frank',
      lastName: 'Newman',
      synced: false,
    });
    expect(answer.headers.get('location')).toBe(`/api/v1/contacts/${body.id}`);
    const made = f.exchangeState.contacts().find((contact) => contact.guid === body.id);
    // The name is the alias, a hyphen and six hex characters: never typed, never the display name.
    expect(made?.name).toMatch(/^frank\.newman-[0-9a-f]{6}$/);
    const create = f.exchange.calls.find((c) => c.method === 'createMailContact');
    expect(Object.keys(create?.args[0] as object).sort()).toEqual([
      'alias',
      'displayName',
      'externalEmailAddress',
      'firstName',
      'lastName',
      'name',
    ]);
    const rows = contactRows(f, 'contact.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', target_id: body.id });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
      fields: ['displayName', 'alias', 'externalEmailAddress'],
    });
    expect(rows[0]?.detail).not.toMatch(/Frank|newman/i);
  });

  it('is 409 conflict with the field as the pointer and NO id for a duplicate address or alias', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const sameAddress = await call<ProblemBody>(me.client, 'POST', '/api/v1/contacts', {
      ...NEW_CONTACT,
      externalEmailAddress: 'dave@elsewhere.example',
    });
    expect(sameAddress.status).toBe(409);
    expect(sameAddress.body.code).toBe('conflict');
    expect(sameAddress.body.errors).toEqual([
      { pointer: '/externalEmailAddress', code: 'conflict' },
    ]);
    const sameAlias = await call<ProblemBody>(me.client, 'POST', '/api/v1/contacts', {
      ...NEW_CONTACT,
      alias: 'Dave.Outside',
    });
    expect(sameAlias.status).toBe(409);
    expect(sameAlias.body.errors).toEqual([{ pointer: '/alias', code: 'conflict' }]);
    for (const answer of [sameAddress, sameAlias]) {
      expect(JSON.stringify(answer.body)).not.toContain(f.world.contacts.dave.guid);
    }
    expect(f.exchange.calls.filter((c) => c.method === 'createMailContact')).toEqual([]);
    expect(contactRows(f, 'contact.create')).toEqual([]);
  });

  it('answers conflict also when Exchange itself refuses a duplicate that the pre-check could not see', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    // An alias with a wildcard character cannot be searched; Exchange's own refusal decides.
    f.exchangeState.addMailContact({
      displayName: 'Star Contact',
      alias: 'star*alias',
      externalEmailAddress: 'star@star.example',
    });
    const answer = await call<ProblemBody>(me.client, 'POST', '/api/v1/contacts', {
      ...NEW_CONTACT,
      alias: 'star*alias',
    });
    expect(answer.status).toBe(409);
    expect(answer.body.errors).toEqual([{ pointer: '/alias', code: 'conflict' }]);
  });

  it('validates before any call: 422 with a pointer and the code of the rule (EC-D10)', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const cases: [object, string, string][] = [
      [{ ...NEW_CONTACT, displayName: '' }, '/displayName', 'display_name_empty'],
      [{ ...NEW_CONTACT, displayName: 'x'.repeat(257) }, '/displayName', 'display_name_too_long'],
      [{ ...NEW_CONTACT, alias: 'a$b' }, '/alias', 'alias_characters'],
      [{ ...NEW_CONTACT, alias: 'x'.repeat(65) }, '/alias', 'alias_too_long'],
      [{ ...NEW_CONTACT, alias: 'a..b' }, '/alias', 'alias_characters'],
      [
        { ...NEW_CONTACT, externalEmailAddress: 'not-an-address' },
        '/externalEmailAddress',
        'address_invalid',
      ],
      [
        { ...NEW_CONTACT, externalEmailAddress: 'Frank@Newman.Example' },
        '/externalEmailAddress',
        'address_not_normalised',
      ],
      [
        { ...NEW_CONTACT, externalEmailAddress: 'Frank <f@n.example>' },
        '/externalEmailAddress',
        'address_invalid',
      ],
      [{ ...NEW_CONTACT, firstName: 'y'.repeat(65) }, '/firstName', 'person_name_too_long'],
    ];
    for (const [body, pointer, code] of cases) {
      const answer = await call<ProblemBody>(me.client, 'POST', '/api/v1/contacts', body);
      expect(answer.status, code).toBe(422);
      expect(answer.body.errors?.[0], code).toEqual({ pointer, code });
    }
    expect(f.exchange.calls.filter((c) => c.method === 'createMailContact')).toEqual([]);
  });

  it('never takes Confirm or WhatIf (or any other key) from a caller', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    for (const extra of [{ Confirm: false }, { WhatIf: true }, { confirm: false }, { name: 'x' }]) {
      const answer = await call(me.client, 'POST', '/api/v1/contacts', {
        ...NEW_CONTACT,
        ...extra,
      });
      expect(answer.status, JSON.stringify(extra)).toBe(422);
    }
    expect(f.exchange.calls.filter((c) => c.method === 'createMailContact')).toEqual([]);
  });

  it('checks the scope against the proposed name, alias and address: 403 outside, 201 inside', async () => {
    const f = await createListsFixture();
    const byName = f.actor(scoped('contacts:create', [contactPrefix('displayName', 'Frank')]));
    const inside = await call(byName.client, 'POST', '/api/v1/contacts', NEW_CONTACT);
    expect(inside.status).toBe(201);
    const outside = await call<ProblemBody>(byName.client, 'POST', '/api/v1/contacts', {
      ...NEW_CONTACT,
      displayName: 'Gina Other',
      alias: 'gina',
      externalEmailAddress: 'gina@other.example',
    });
    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('permission_denied');
    // An id scope can never cover a contact that does not exist yet.
    const byId = f.actor(
      scoped('contacts:create', [
        { target: 'contact', match: { by: 'id', id: f.world.contacts.dave.guid } },
      ]),
    );
    expect(
      (
        await call(byId.client, 'POST', '/api/v1/contacts', {
          ...NEW_CONTACT,
          alias: 'frank2',
          externalEmailAddress: 'f2@n.example',
        })
      ).status,
    ).toBe(403);
    const byAlias = f.actor(scoped('contacts:create', [contactPrefix('alias', 'board.')]));
    expect(
      (
        await call(byAlias.client, 'POST', '/api/v1/contacts', {
          displayName: 'Board Member',
          alias: 'board.member',
          externalEmailAddress: 'bm@board.example',
        })
      ).status,
    ).toBe(201);
    expect(
      f
        .rows()
        .filter((row) => row.outcome === 'denied')
        .map((row) => [row.action, row.reason_code]),
    ).toEqual([
      ['contacts.create', 'scope_mismatch'],
      ['contacts.create', 'scope_mismatch'],
    ]);
  });

  it('fails as a problem, with no write claimed, when Exchange is not available', async () => {
    const f = await createListsFixture({
      exchange: failingOn(
        'createMailContact',
        1,
        new ExchangeUnavailableError({ reason: 'worker_crashed' }),
      ),
    });
    const me = f.actor(...ALL);
    const answer = await call<ProblemBody>(me.client, 'POST', '/api/v1/contacts', NEW_CONTACT);
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('exchange_unavailable');
    expect(contactRows(f, 'contact.create')).toEqual([]);
    expect(f.exchangeState.contacts()).toHaveLength(2);
  });
});

describe('PATCH /api/v1/contacts/{id} (P50)', () => {
  it('sends and audits only the fields that differ, by name, and answers the contact as read back', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const id = f.world.contacts.dave.guid;
    const answer = await call(me.client, 'PATCH', `/api/v1/contacts/${id}`, {
      displayName: 'Dave Outside',
      alias: 'dave.renamed',
      externalEmailAddress: 'dave@elsewhere.example',
    });
    expect(answer.status).toBe(200);
    expect(ContactDetailSchema.parse(answer.body)).toMatchObject({
      alias: 'dave.renamed',
      displayName: 'Dave Outside',
      externalEmailAddress: 'dave@elsewhere.example',
    });
    const update = f.exchange.calls.find((c) => c.method === 'updateMailContact');
    expect(update?.args[1]).toEqual({ alias: 'dave.renamed' });
    const rows = contactRows(f, 'contact.update');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ fields: ['alias'] });
    expect(rows[0]?.detail).not.toMatch(/renamed/);
  });

  it('is a no-op that changes and audits nothing when no field differs', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const answer = await call(
      me.client,
      'PATCH',
      `/api/v1/contacts/${f.world.contacts.dave.guid}`,
      {
        alias: 'dave.outside',
      },
    );
    expect(answer.status).toBe(200);
    expect(f.exchange.calls.filter((c) => c.method === 'updateMailContact')).toEqual([]);
    expect(contactRows(f, 'contact.update')).toEqual([]);
  });

  it('is 409 read_only_object for a synchronised contact and 409 conflict for a taken address or alias', async () => {
    const f = await createListsFixture();
    f.world.contacts.erin.isDirSynced = true;
    const me = f.actor(...ALL);
    const synced = await call<ProblemBody>(
      me.client,
      'PATCH',
      `/api/v1/contacts/${f.world.contacts.erin.guid}`,
      {
        alias: 'erin.new',
      },
    );
    expect(synced.status).toBe(409);
    expect(synced.body.code).toBe('read_only_object');
    const taken = await call<ProblemBody>(
      me.client,
      'PATCH',
      `/api/v1/contacts/${f.world.contacts.dave.guid}`,
      {
        externalEmailAddress: 'erin@partner.example',
      },
    );
    expect(taken.status).toBe(409);
    expect(taken.body.errors).toEqual([{ pointer: '/externalEmailAddress', code: 'conflict' }]);
    expect(JSON.stringify(taken.body)).not.toContain(f.world.contacts.erin.guid);
    const takenAlias = await call<ProblemBody>(
      me.client,
      'PATCH',
      `/api/v1/contacts/${f.world.contacts.dave.guid}`,
      {
        alias: 'erin.partner',
      },
    );
    expect(takenAlias.body.errors).toEqual([{ pointer: '/alias', code: 'conflict' }]);
    expect(f.exchange.calls.filter((c) => c.method === 'updateMailContact')).toEqual([]);
  });

  it('is 422 for an empty change, a name field and an unknown key; 404 for an unknown contact', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const id = f.world.contacts.dave.guid;
    for (const body of [{}, { firstName: 'Dave' }, { alias: 'x', Confirm: false }]) {
      expect(
        (await call(me.client, 'PATCH', `/api/v1/contacts/${id}`, body)).status,
        JSON.stringify(body),
      ).toBe(422);
    }
    expect(
      (
        await call(me.client, 'PATCH', '/api/v1/contacts/9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60', {
          alias: 'x',
        })
      ).status,
    ).toBe(404);
  });

  it('refuses a change that takes the contact out of the caller’s scope, and one on a contact outside it', async () => {
    const f = await createListsFixture();
    const me = f.actor(
      scoped('contacts:update', [contactPrefix('displayName', 'Dave')]),
      READ_CONTACTS,
    );
    const id = f.world.contacts.dave.guid;
    expect(
      (await call(me.client, 'PATCH', `/api/v1/contacts/${id}`, { displayName: 'Dave Renamed' }))
        .status,
    ).toBe(200);
    expect(
      (await call(me.client, 'PATCH', `/api/v1/contacts/${id}`, { displayName: 'Someone Else' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(me.client, 'PATCH', `/api/v1/contacts/${f.world.contacts.erin.guid}`, {
          alias: 'e',
        })
      ).status,
    ).toBe(403);
  });
});

describe('DELETE /api/v1/contacts/{id} (P51)', () => {
  it('needs the typed display name: 422 at /confirmName with confirm_mismatch, and nothing is deleted', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const id = f.world.contacts.dave.guid;
    for (const confirmName of ['dave outside', 'Dave Outside ', 'Dave', 'Erin Partner']) {
      const answer = await call<ProblemBody>(me.client, 'DELETE', `/api/v1/contacts/${id}`, {
        confirmName,
      });
      expect(answer.status, confirmName).toBe(422);
      expect(answer.body.code).toBe('validation_failed');
      expect(answer.body.errors?.[0]?.pointer).toBe('/confirmName');
      expect(answer.body.errors?.[0]?.code).toMatch(/^(confirm_mismatch|display_name_characters)$/);
    }
    const exact = await call<ProblemBody>(me.client, 'DELETE', `/api/v1/contacts/${id}`, {
      confirmName: 'Dave outside',
    });
    expect(exact.body.errors).toEqual([{ pointer: '/confirmName', code: 'confirm_mismatch' }]);
    expect(f.exchangeState.contacts()).toHaveLength(2);
    expect((await call(me.client, 'DELETE', `/api/v1/contacts/${id}`, {})).status).toBe(422);
  });

  it('deletes the contact, names the lists Exchange removed it from, and audits the number only', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const id = f.world.contacts.dave.guid;
    const answer = await call(me.client, 'DELETE', `/api/v1/contacts/${id}`, {
      confirmName: 'Dave Outside',
    });
    expect(answer.status).toBe(200);
    expect(ContactDeleteResponseSchema.parse(answer.body)).toEqual({
      removedFromLists: [{ id: f.world.lists.marketing.guid, displayName: 'Marketing' }],
    });
    expect(f.exchangeState.contacts().map((contact) => contact.displayName)).toEqual([
      'Erin Partner',
    ]);
    expect(
      f.exchangeState
        .groupMembers(f.world.lists.marketing.guid)
        .map((member) => member.displayName),
    ).toEqual(['Alice Example']);
    const rows = contactRows(f, 'contact.delete');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ removed: 1 });
    expect((await call(me.client, 'GET', `/api/v1/contacts/${id}`)).status).toBe(404);
  });

  it('names only the lists the caller may see, and a contact in none answers an empty list', async () => {
    const f = await createListsFixture();
    const me = f.actor(
      DELETE_CONTACTS,
      READ_CONTACTS,
      scoped('distributionlists:read', [listPrefix('Sales')]),
    );
    const answer = await call(
      me.client,
      'DELETE',
      `/api/v1/contacts/${f.world.contacts.dave.guid}`,
      {
        confirmName: 'Dave Outside',
      },
    );
    expect(ContactDeleteResponseSchema.parse(answer.body).removedFromLists).toEqual([]);
    const erin = await call(me.client, 'DELETE', `/api/v1/contacts/${f.world.contacts.erin.guid}`, {
      confirmName: 'Erin Partner',
    });
    expect(ContactDeleteResponseSchema.parse(erin.body)).toEqual({ removedFromLists: [] });
  });

  it('is 409 read_only_object for a synchronised contact, 403 outside the scope, 404 for an unknown one', async () => {
    const f = await createListsFixture();
    f.world.contacts.erin.isDirSynced = true;
    const me = f.actor(...ALL);
    const synced = await call<ProblemBody>(
      me.client,
      'DELETE',
      `/api/v1/contacts/${f.world.contacts.erin.guid}`,
      {
        confirmName: 'Erin Partner',
      },
    );
    expect(synced.status).toBe(409);
    expect(synced.body.code).toBe('read_only_object');
    const narrow = f.actor(scoped('contacts:delete', [contactPrefix('displayName', 'Erin')]));
    expect(
      (
        await call(narrow.client, 'DELETE', `/api/v1/contacts/${f.world.contacts.dave.guid}`, {
          confirmName: 'Dave Outside',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(me.client, 'DELETE', '/api/v1/contacts/9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60', {
          confirmName: 'x',
        })
      ).status,
    ).toBe(404);
    expect(f.exchangeState.contacts()).toHaveLength(2);
  });
});

describe('GET /api/v1/contacts/{id}/lists (P52)', () => {
  it('lists the distribution lists of a contact for a caller who reads both', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_CONTACTS, READ_LISTS);
    const answer = await call(
      me.client,
      'GET',
      `/api/v1/contacts/${f.world.contacts.dave.guid}/lists`,
    );
    expect(answer.status).toBe(200);
    const body = ContactListsResponseSchema.parse(answer.body);
    expect(body.items.map((item) => [item.displayName, item.kind])).toEqual([
      ['Marketing', 'standard'],
    ]);
    const none = await call(
      me.client,
      'GET',
      `/api/v1/contacts/${f.world.contacts.erin.guid}/lists`,
    );
    expect(none.body).toEqual({ items: [] });
  });

  it('needs distributionlists:read as well, and cuts the lists to the scope', async () => {
    const f = await createListsFixture();
    const onlyContacts = f.actor(READ_CONTACTS);
    expect(
      (
        await call(
          onlyContacts.client,
          'GET',
          `/api/v1/contacts/${f.world.contacts.dave.guid}/lists`,
        )
      ).status,
    ).toBe(403);
    expect(f.rows().map((row) => [row.action, row.reason_code])).toEqual([
      ['contacts.memberships', 'permission_missing'],
    ]);
    const salesOnly = f.actor(
      READ_CONTACTS,
      scoped('distributionlists:read', [listPrefix('Sales')]),
    );
    const body = await call(
      salesOnly.client,
      'GET',
      `/api/v1/contacts/${f.world.contacts.dave.guid}/lists`,
    );
    expect(body.body).toEqual({ items: [] });
  });
});

describe('the Exchange name of a new contact (U95)', () => {
  it('is the alias, a hyphen and six hex characters, at most 64 characters, whatever the alias', () => {
    const random = sequenceRandom();
    const short = deriveContactName('frank.newman', random);
    expect(short).toMatch(/^frank\.newman-[0-9a-f]{6}$/);
    const long = deriveContactName('a'.repeat(64), random);
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^a{57}-[0-9a-f]{6}$/);
    expect(deriveContactName('x', random)).not.toBe(deriveContactName('x', random));
  });
});
