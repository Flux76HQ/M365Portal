// /contacts and /contacts/$id (T-D-152; FR-D-301 to FR-D-305, US-D2). The list, the detail with the lists the contact
// is in, the create and edit form with one plain translated message per rule of CONTACT_VALIDATION_CODES, the
// address normalised before it is sent, the read-only state of a synchronised contact. The delete dialog has its
// own file (`contacts-delete-dialog.test.tsx`).
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  contactGuid,
  createPhaseDApi,
  emptyPhaseDWorld,
  listGuid,
  listRecord,
  makeContact,
  makeList,
  userMember,
  type PhaseDWorld,
} from './support/phase-d-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;

const ALL: Permission[] = [
  'contacts:read',
  'contacts:create',
  'contacts:update',
  'contacts:delete',
  'distributionlists:read',
];

function world(): PhaseDWorld {
  const w = emptyPhaseDWorld();
  w.contacts.push(
    {
      detail: makeContact(1, {
        displayName: 'Ada Lovelace',
        alias: 'ada',
        externalEmailAddress: 'ada@elsewhere.test',
      }),
    },
    { detail: makeContact(2, { displayName: 'Bo Brown', synced: true }) },
    {
      detail: makeContact(3, {
        displayName: 'Cy Clark',
        synced: null,
        firstName: null,
        lastName: null,
      }),
    },
  );
  w.lists.push(
    listRecord(makeList(1, { displayName: 'Sales' }), [userMember(1)]),
    listRecord(makeList(2, { displayName: 'Everyone', kind: 'dynamic' }), []),
  );
  w.contactLists[contactGuid(1)] = [listGuid(1), listGuid(2)];
  return w;
}

async function open(
  path: string,
  options: {
    w?: PhaseDWorld;
    permissions?: Permission[];
    language?: 'en' | 'nl';
    setup?: (api: ReturnType<typeof createPhaseDApi>) => void;
  } = {},
) {
  const api = createPhaseDApi(options.w ?? world());
  options.setup?.(api);
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: options.permissions ?? ALL }),
    path,
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  return { ...view, api };
}

const ADA = `/contacts/${contactGuid(1)}`;
const BO = `/contacts/${contactGuid(2)}`;
const field = (label: string) => screen.getByRole('textbox', { name: new RegExp(`^${label}`) });

describe('the list of contacts', () => {
  it('shows each contact with its alias, its external address and where it comes from', async () => {
    await open('/contacts');
    expect(
      await screen.findByRole('heading', { level: 1, name: t('nav.contacts') }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: t('contacts.table.caption') });
    const link = await within(table).findByRole('link', { name: 'Ada Lovelace' });
    expect(link).toHaveAttribute('href', ADA);
    const row = link.closest('tr')!;
    expect(row).toHaveTextContent('ada');
    expect(row).toHaveTextContent('ada@elsewhere.test');
    expect(row).toHaveTextContent(t('contacts.source.local'));
    expect(within(table).getByRole('link', { name: 'Bo Brown' }).closest('tr')).toHaveTextContent(
      t('contacts.source.synced'),
    );
  });

  it('searches by the first letters, in the address', async () => {
    const { api, router, user } = await open('/contacts');
    await screen.findByRole('link', { name: 'Ada Lovelace' });
    await user.type(
      screen.getByRole('searchbox', { name: t('contacts.search.label') }),
      'bo{Enter}',
    );
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: 'bo' });
    });
    expect(await screen.findByRole('link', { name: 'Bo Brown' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ada Lovelace' })).toBeNull();
    expect(
      api
        .callsTo('GET', /contacts$/)
        .at(-1)
        ?.query.get('q'),
    ).toBe('bo');
  });

  it('says there are no contacts, and no matches', async () => {
    const view = await open('/contacts', { w: emptyPhaseDWorld() });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('contacts.empty.title') }),
    ).toBeInTheDocument();
    view.unmount();
    await open('/contacts?q=zzz');
    expect(
      await screen.findByRole('heading', { level: 2, name: t('contacts.empty.filteredTitle') }),
    ).toBeInTheDocument();
  });

  it('shows a translated error with a retry', async () => {
    const { api, user } = await open('/contacts', {
      setup: (a) => {
        a.override('GET', /contacts$/, () => problem(503, 'exchange_unavailable'));
      },
    });
    expect(
      await screen.findByText(t('contacts.error.title'), undefined, { timeout: 9000 }),
    ).toBeInTheDocument();
    api.override('GET', /contacts$/, null);
    await user.click(screen.getByRole('button', { name: t('contacts.error.retry') }));
    expect(await screen.findByRole('link', { name: 'Ada Lovelace' })).toBeInTheDocument();
  }, 15_000);

  it('offers "New contact" only to an actor who may create, and is gated by contacts:read', async () => {
    const view = await open('/contacts', { permissions: ['contacts:read'] });
    await screen.findByRole('link', { name: 'Ada Lovelace' });
    expect(screen.queryByRole('button', { name: t('contacts.actions.new') })).toBeNull();
    view.unmount();
    const denied = await open('/contacts', { permissions: ['distributionlists:read'] });
    expect(
      await screen.findByRole('heading', { level: 1, name: t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    denied.unmount();
    await open('/contacts', { language: 'nl' });
    expect(
      await screen.findByRole('button', { name: nl.t('contacts.actions.new') }),
    ).toBeInTheDocument();
  });
});

describe('creating a contact', () => {
  async function openForm(setup?: (api: ReturnType<typeof createPhaseDApi>) => void) {
    const view = await open('/contacts', setup === undefined ? {} : { setup });
    await screen.findByRole('link', { name: 'Ada Lovelace' });
    await view.user.click(screen.getByRole('button', { name: t('contacts.actions.new') }));
    const dialog = await screen.findByRole('dialog', { name: t('contacts.form.create.title') });
    return { ...view, dialog };
  }

  it('says what is missing in plain words, per field, and sends nothing', async () => {
    const { api, user, dialog } = await openForm();
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
    const messages = within(dialog)
      .getAllByRole('alert')
      .map((alert) => alert.textContent);
    expect(messages).toEqual([
      t('contacts.validation.display_name_empty'),
      t('contacts.validation.alias_empty'),
      t('contacts.validation.address_invalid'),
    ]);
    expect(field('Display name')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Display name')).toHaveFocus();
    expect(api.callsTo('POST', /contacts$/)).toHaveLength(0);
  });

  it.each([
    ['Display name', 'x'.repeat(257), 'display_name_too_long'],
    ['Alias', 'a'.repeat(65), 'alias_too_long'],
    ['Alias', 'no spaces', 'alias_characters'],
    ['Alias', '.dot', 'alias_characters'],
    ['External email address', 'not-an-address', 'address_invalid'],
    ['External email address', `${'a'.repeat(250)}@x.test`, 'address_too_long'],
  ])('%s "%s" gives %s', async (label, text, code) => {
    const { user, dialog } = await openForm();
    await user.click(within(dialog).getByRole('textbox', { name: new RegExp(`^${label}`) }));
    await user.paste(text);
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
    expect(
      within(dialog).getByText(t(`contacts.validation.${code}` as Parameters<typeof t>[0])),
    ).toBeInTheDocument();
  });

  it('refuses a first or last name that is too long', async () => {
    const { user, dialog } = await openForm();
    await user.click(within(dialog).getByRole('textbox', { name: /^First name/ }));
    await user.paste('n'.repeat(65));
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
    expect(
      within(dialog).getByText(t('contacts.validation.person_name_too_long')),
    ).toBeInTheDocument();
  });

  it('normalises the address (trimmed, lower case) before it is sent, and opens the new contact', async () => {
    const { api, user, dialog, router } = await openForm();
    await user.click(within(dialog).getByRole('textbox', { name: /^Display name/ }));
    await user.paste('Dee Dunn');
    await user.click(within(dialog).getByRole('textbox', { name: /^Alias/ }));
    await user.paste('dee.dunn');
    await user.click(within(dialog).getByRole('textbox', { name: /^External email address/ }));
    await user.paste('  Dee.Dunn@Example.COM ');
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );

    await waitFor(() => {
      expect(api.callsTo('POST', /contacts$/)).toHaveLength(1);
    });
    expect(api.callsTo('POST', /contacts$/)[0]?.body).toEqual({
      displayName: 'Dee Dunn',
      alias: 'dee.dunn',
      externalEmailAddress: 'dee.dunn@example.com',
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/contacts\/[0-9a-f-]{36}$/);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Dee Dunn' })).toBeInTheDocument();
  });

  it('sends the names when they are given', async () => {
    const { api, user, dialog } = await openForm();
    await user.click(within(dialog).getByRole('textbox', { name: /^Display name/ }));
    await user.paste('Dee Dunn');
    await user.click(within(dialog).getByRole('textbox', { name: /^Alias/ }));
    await user.paste('dee');
    await user.click(within(dialog).getByRole('textbox', { name: /^External email address/ }));
    await user.paste('dee@example.com');
    await user.click(within(dialog).getByRole('textbox', { name: /^First name/ }));
    await user.paste('Dee');
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
    await waitFor(() => {
      expect(api.callsTo('POST', /contacts$/)[0]?.body).toMatchObject({ firstName: 'Dee' });
    });
    expect(api.callsTo('POST', /contacts$/)[0]?.body).not.toHaveProperty('lastName');
  });

  it('shows a conflict at the field the server names', async () => {
    const { user, dialog } = await openForm();
    await user.click(within(dialog).getByRole('textbox', { name: /^Display name/ }));
    await user.paste('Another Ada');
    await user.click(within(dialog).getByRole('textbox', { name: /^Alias/ }));
    await user.paste('another');
    await user.click(within(dialog).getByRole('textbox', { name: /^External email address/ }));
    await user.paste('ADA@elsewhere.test');
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(t('problem.conflict'));
    expect(field('External email address')).toHaveAttribute('aria-invalid', 'true');
    expect(field('External email address')).toHaveAccessibleDescription(
      new RegExp(t('problem.conflict').slice(0, 20)),
    );
  });

  async function fill(
    user: Awaited<ReturnType<typeof openForm>>['user'],
    dialog: HTMLElement,
    values: { name: string; alias: string; address: string },
  ) {
    await user.click(within(dialog).getByRole('textbox', { name: /^Display name/ }));
    await user.paste(values.name);
    await user.click(within(dialog).getByRole('textbox', { name: /^Alias/ }));
    await user.paste(values.alias);
    await user.click(within(dialog).getByRole('textbox', { name: /^External email address/ }));
    await user.paste(values.address);
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
  }

  it('shows the message of a validation code that only the server found, at its field', async () => {
    const { user, dialog } = await openForm((a) => {
      a.override('POST', /contacts$/, () =>
        problem(422, 'validation_failed', {
          errors: [{ pointer: '/alias', code: 'alias_characters' }],
        }),
      );
    });
    await fill(user, dialog, { name: 'Dee', alias: 'dee', address: 'dee@example.com' });
    expect(
      await within(dialog).findByText(t('contacts.validation.alias_characters')),
    ).toBeInTheDocument();
    expect(field('Alias')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a general error, translated, when the request fails, and keeps what was typed', async () => {
    const { user, dialog } = await openForm((a) => {
      a.override('POST', /contacts$/, () => problem(503, 'exchange_unavailable'));
    });
    await fill(user, dialog, { name: 'Dee', alias: 'dee', address: 'dee@example.com' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(t('contacts.form.error'));
    expect(alert).toHaveTextContent(t('problem.exchange_unavailable'));
    expect(field('Display name')).toHaveValue('Dee');
  });

  it('closes with Cancel and Escape and changes nothing', async () => {
    const { api, user, dialog } = await openForm();
    await user.click(within(dialog).getByRole('button', { name: t('contacts.form.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: t('contacts.actions.new') })).toHaveFocus();
    expect(api.callsTo('POST', /contacts$/)).toHaveLength(0);
  });
});

describe('the detail of a contact', () => {
  it('shows the properties, the lists the contact is in and a way back', async () => {
    await open(ADA);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('contacts.detail.back') })).toHaveAttribute(
      'href',
      '/contacts',
    );
    expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual([
      t('contacts.field.displayName'),
      t('contacts.field.alias'),
      t('contacts.field.address'),
      t('contacts.field.firstName'),
      t('contacts.field.lastName'),
      t('contacts.field.hidden'),
      t('contacts.field.synced'),
      t('contacts.field.created'),
    ]);
    const table = await screen.findByRole('table', {
      name: t('contacts.lists.caption', { name: 'Ada Lovelace' }),
    });
    const sales = await within(table).findByRole('link', { name: 'Sales' });
    expect(sales).toHaveAttribute('href', `/distribution-lists/${listGuid(1)}`);
    expect(within(table).getByRole('link', { name: 'Everyone' }).closest('tr')).toHaveTextContent(
      t('distributionLists.kind.dynamic'),
    );
  });

  it('says the contact is in no list', async () => {
    await open(`/contacts/${contactGuid(3)}`);
    expect(await screen.findByText(t('contacts.lists.empty'))).toBeInTheDocument();
  });

  it('keeps the contact when only the lists fail', async () => {
    await open(ADA, {
      setup: (a) => {
        a.override('GET', /contacts\/[^/]+\/lists$/, () => problem(503, 'exchange_throttled'));
      },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(t('contacts.lists.error'), undefined, { timeout: 9000 }),
    ).toBeInTheDocument();
  }, 15_000);

  it('shows an error for a contact that is not found and for an address that is no id', async () => {
    const view = await open(`/contacts/${contactGuid(99)}`);
    expect(await screen.findByText(t('contacts.detail.error'))).toBeInTheDocument();
    view.unmount();
    const { api } = await open('/contacts/nope');
    expect(await screen.findByText(t('contacts.detail.error'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('offers edit and delete only to an actor who may', async () => {
    const view = await open(ADA, { permissions: ['contacts:read', 'contacts:update'] });
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    expect(screen.getByRole('button', { name: t('contacts.actions.edit') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('contacts.actions.delete') })).toBeNull();
    view.unmount();
    await open(ADA, { permissions: ['contacts:read'] });
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    expect(screen.queryByRole('button', { name: t('contacts.actions.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('contacts.actions.delete') })).toBeNull();
  });

  it('offers neither for a synchronised contact and says why', async () => {
    await open(BO);
    await screen.findByRole('heading', { level: 1, name: 'Bo Brown' });
    expect(screen.getByText(t('contacts.readOnly.synced'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('contacts.actions.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('contacts.actions.delete') })).toBeNull();
  });
});

describe('editing a contact', () => {
  async function openEdit() {
    const view = await open(ADA);
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    await view.user.click(screen.getByRole('button', { name: t('contacts.actions.edit') }));
    const dialog = await screen.findByRole('dialog', { name: t('contacts.form.edit.title') });
    return { ...view, dialog };
  }

  it('starts with the current values and has no name fields (Set-MailContact has none)', async () => {
    const { dialog } = await openEdit();
    expect(within(dialog).getByRole('textbox', { name: /^Display name/ })).toHaveValue(
      'Ada Lovelace',
    );
    expect(within(dialog).getByRole('textbox', { name: /^Alias/ })).toHaveValue('ada');
    expect(within(dialog).getByRole('textbox', { name: /^External email address/ })).toHaveValue(
      'ada@elsewhere.test',
    );
    expect(within(dialog).queryByRole('textbox', { name: /^First name/ })).toBeNull();
  });

  it('sends only what changed', async () => {
    const { api, user, dialog } = await openEdit();
    const name = within(dialog).getByRole('textbox', { name: /^Display name/ });
    await user.clear(name);
    await user.type(name, 'Ada King');
    await user.click(within(dialog).getByRole('button', { name: t('contacts.form.edit.submit') }));
    await waitFor(() => {
      expect(api.callsTo('PATCH', /contacts\/[^/]+$/)).toHaveLength(1);
    });
    expect(api.callsTo('PATCH', /contacts\/[^/]+$/)[0]?.body).toEqual({ displayName: 'Ada King' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ada King' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('normalises a changed address', async () => {
    const { api, user, dialog } = await openEdit();
    const address = within(dialog).getByRole('textbox', { name: /^External email address/ });
    await user.clear(address);
    await user.type(address, ' ADA@New.Test ');
    await user.click(within(dialog).getByRole('button', { name: t('contacts.form.edit.submit') }));
    await waitFor(() => {
      expect(api.callsTo('PATCH', /contacts\/[^/]+$/)[0]?.body).toEqual({
        externalEmailAddress: 'ada@new.test',
      });
    });
  });

  it('asks for a change when nothing changed, and sends nothing', async () => {
    const { api, user, dialog } = await openEdit();
    await user.click(within(dialog).getByRole('button', { name: t('contacts.form.edit.submit') }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      t('contacts.validation.nothing_to_change'),
    );
    expect(api.callsTo('PATCH', /contacts\/[^/]+$/)).toHaveLength(0);
  });

  it('shows a conflict at the alias, translated, and keeps the dialog', async () => {
    const { user, dialog } = await openEdit();
    const alias = within(dialog).getByRole('textbox', { name: /^Alias/ });
    await user.clear(alias);
    await user.type(alias, 'contact2');
    await user.click(within(dialog).getByRole('button', { name: t('contacts.form.edit.submit') }));
    expect(await within(dialog).findByText(t('problem.conflict'))).toBeInTheDocument();
    expect(alias).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
