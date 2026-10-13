// The delete dialog of a contact (T-D-152; FR-D-303, US-D2). It names the contact and says in how many lists it is,
// asks for the display name to be typed, sends it as the `confirmName` of the DELETE, and tells afterwards from
// which lists Exchange removed the contact. Nothing is sent before the name matches.
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import { makeUser } from './support/directory-handlers';
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
const ALL: Permission[] = ['contacts:read', 'contacts:delete', 'distributionlists:read'];

function world(listCount: number): PhaseDWorld {
  const w = emptyPhaseDWorld();
  w.users.push(makeUser(1));
  w.contacts.push({ detail: makeContact(1, { displayName: 'Ada Lovelace' }) });
  w.contactLists[contactGuid(1)] = [];
  for (let n = 1; n <= listCount; n += 1) {
    w.lists.push(listRecord(makeList(n, { displayName: `List ${String(n)}` }), [userMember(1)]));
    w.contactLists[contactGuid(1)]!.push(listGuid(n));
  }
  return w;
}

async function openDialog(
  listCount: number,
  options: {
    permissions?: Permission[];
    language?: 'en' | 'nl';
    setup?: (api: ReturnType<typeof createPhaseDApi>) => void;
  } = {},
) {
  const api = createPhaseDApi(world(listCount));
  options.setup?.(api);
  const language = options.language ?? 'en';
  const tr = language === 'en' ? en : nl;
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: options.permissions ?? ALL }),
    path: `/contacts/${contactGuid(1)}`,
    language,
    fetch: api.fetch,
  });
  await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
  await view.user.click(
    await screen.findByRole('button', { name: tr.t('contacts.actions.delete') }),
  );
  const dialog = await screen.findByRole('alertdialog', { name: tr.t('contacts.delete.title') });
  return { ...view, api, dialog, tr };
}

describe('the delete dialog', () => {
  it('names the contact and the number of lists it is in', async () => {
    const { dialog } = await openDialog(2);
    expect(dialog).toHaveTextContent('Ada Lovelace');
    await waitFor(() => {
      expect(dialog).toHaveTextContent(t('contacts.delete.lists', { count: 2 }));
    });
  });

  it('says one list in the singular, and none when there is none', async () => {
    const one = await openDialog(1);
    await waitFor(() => {
      expect(one.dialog).toHaveTextContent(t('contacts.delete.lists', { count: 1 }));
    });
    one.unmount();
    const none = await openDialog(0);
    await waitFor(() => {
      expect(none.dialog).toHaveTextContent(t('contacts.delete.lists.none'));
    });
  });

  it('says "more than" when the lists run over a page, and says so when they could not be read', async () => {
    const many = await openDialog(55);
    await waitFor(() => {
      expect(many.dialog).toHaveTextContent(t('contacts.delete.lists.more', { count: 50 }));
    });
    many.unmount();
    const failed = await openDialog(2, {
      setup: (a) => {
        a.override('GET', /contacts\/[^/]+\/lists$/, () => problem(503, 'exchange_throttled'));
      },
    });
    await waitFor(
      () => {
        expect(failed.dialog).toHaveTextContent(t('contacts.delete.lists.unknown'));
      },
      { timeout: 9000 },
    );
  }, 20_000);

  it('puts the focus on Cancel, and closes on Cancel and on Escape without a request', async () => {
    const { api, user, dialog } = await openDialog(1);
    expect(within(dialog).getByRole('button', { name: t('contacts.delete.cancel') })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: t('contacts.actions.delete') })).toHaveFocus();
    expect(api.callsTo('DELETE', /contacts/)).toHaveLength(0);
  });

  it('refuses a name that does not match and sends nothing', async () => {
    const { api, user, dialog } = await openDialog(1);
    await user.type(
      within(dialog).getByRole('textbox', { name: t('contacts.delete.confirmLabel') }),
      'Ada',
    );
    await user.click(within(dialog).getByRole('button', { name: t('contacts.delete.confirm') }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      t('contacts.validation.confirm_mismatch'),
    );
    expect(api.callsTo('DELETE', /contacts/)).toHaveLength(0);
  });

  it('deletes with the typed name, goes back to the list and says from how many lists the contact was removed', async () => {
    const { api, user, dialog, router } = await openDialog(2);
    await user.type(
      within(dialog).getByRole('textbox', { name: t('contacts.delete.confirmLabel') }),
      'Ada Lovelace',
    );
    await user.click(within(dialog).getByRole('button', { name: t('contacts.delete.confirm') }));
    await waitFor(() => {
      expect(api.callsTo('DELETE', /contacts\/[^/]+$/)).toHaveLength(1);
    });
    expect(api.callsTo('DELETE', /contacts\/[^/]+$/)[0]?.body).toEqual({
      confirmName: 'Ada Lovelace',
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/contacts');
    });
    expect(await screen.findByText(t('contacts.deleted.lists', { count: 2 }))).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ada Lovelace' })).toBeNull();
  });

  it('shows the translated error inside the dialog when Exchange refuses', async () => {
    const { user, dialog, router } = await openDialog(0, {
      setup: (a) => {
        a.override('DELETE', /contacts\/[^/]+$/, () => problem(409, 'read_only_object'));
      },
    });
    await user.type(
      within(dialog).getByRole('textbox', { name: t('contacts.delete.confirmLabel') }),
      'Ada Lovelace',
    );
    await user.click(within(dialog).getByRole('button', { name: t('contacts.delete.confirm') }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(t('contacts.delete.error'));
    expect(alert).toHaveTextContent(t('problem.read_only_object'));
    expect(router.state.location.pathname).toBe(`/contacts/${contactGuid(1)}`);
  });

  it('speaks Dutch', async () => {
    const { dialog } = await openDialog(2, { language: 'nl' });
    await waitFor(() => {
      expect(dialog).toHaveTextContent(nl.t('contacts.delete.lists', { count: 2 }));
    });
    expect(
      within(dialog).getByRole('button', { name: nl.t('contacts.delete.confirm') }),
    ).toBeInTheDocument();
  });

  it('offers no delete button without contacts:delete', async () => {
    const api = createPhaseDApi(world(1));
    await renderApp({
      me: sampleMe({ kind: 'user', permissions: ['contacts:read'] }),
      path: `/contacts/${contactGuid(1)}`,
      fetch: api.fetch,
    });
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    expect(screen.queryByRole('button', { name: t('contacts.actions.delete') })).toBeNull();
  });
});
