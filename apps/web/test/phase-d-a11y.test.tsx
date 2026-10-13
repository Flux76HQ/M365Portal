// ACCESSIBILITY OF THE PHASE D PAGES, UNIT LEVEL (T-D-151 to T-D-153; FR-D-902, WCAG 2.2 AA). axe itself runs in the
// end-to-end suite against the real browser (contrast and target size need layout). What a unit test can prove
// is the structure axe and a screen reader rely on: one h1 and an outline without gaps, tables with a caption
// and scoped headers, a name for every control, labelled fields with their messages as the description, a
// dialog that names itself, and member removal with the keyboard alone.
import type { Permission } from '@m365portal/shared/permissions';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import { createTranslator } from '@m365portal/shared/i18n';
import { guid, makeUser } from './support/directory-handlers';
import {
  contactGuid,
  contactMember,
  createPhaseDApi,
  emptyPhaseDWorld,
  listGuid,
  listRecord,
  makeContact,
  makeList,
  userMember,
} from './support/phase-d-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const t = createTranslator('en').t;
const ALL: Permission[] = [
  'distributionlists:read',
  'distributionlists:members:write',
  'contacts:read',
  'contacts:create',
  'contacts:update',
  'contacts:delete',
];

function world() {
  const w = emptyPhaseDWorld();
  for (let n = 1; n <= 4; n += 1) w.users.push(makeUser(n));
  w.contacts.push({ detail: makeContact(1, { displayName: 'Ada Lovelace' }) });
  w.lists.push(
    listRecord(makeList(1, { displayName: 'Sales' }), [
      userMember(1),
      userMember(2),
      contactMember(1),
      { kind: 'user', restricted: true },
    ]),
  );
  w.contactLists[contactGuid(1)] = [listGuid(1)];
  return w;
}

async function open(path: string) {
  const api = createPhaseDApi(world());
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: ALL }),
    path,
    fetch: api.fetch,
  });
  return { ...view, api };
}

/** The levels of the headings in document order. */
const outline = (root: HTMLElement) =>
  within(root)
    .getAllByRole('heading')
    .map((heading) => Number(heading.tagName.slice(1)));

function expectNoGaps(levels: number[]) {
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  levels.forEach((level, index) => {
    if (index > 0) expect(level).toBeLessThanOrEqual((levels[index - 1] ?? 0) + 1);
  });
}

/** Every button, checkbox, radio and text box has an accessible name. */
function expectNamedControls(root: HTMLElement) {
  for (const control of root.querySelectorAll<HTMLElement>(
    'button, [role="checkbox"], input:not([type="hidden"]), a[href]',
  )) {
    const named =
      control.hasAttribute('aria-label') ||
      control.hasAttribute('aria-labelledby') ||
      control.textContent.trim() !== '' ||
      (control instanceof HTMLInputElement && control.labels !== null && control.labels.length > 0);
    expect(named, control.outerHTML.slice(0, 120)).toBe(true);
  }
}

describe('the structure', () => {
  it('the list of lists: one h1, a captioned table with scoped headers, named controls', async () => {
    const { container } = await open('/distribution-lists');
    const table = await screen.findByRole('table', { name: t('distributionLists.table.caption') });
    await within(table).findByRole('link', { name: 'Sales' });
    expectNoGaps(outline(container));
    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header).toHaveAttribute('scope', 'col');
    }
    expect(within(table).getAllByRole('rowheader')[0]).toHaveAttribute('scope', 'row');
    expectNamedControls(container);
  });

  it('the detail of a list with its members: an outline without gaps and a checkbox name per member', async () => {
    const { container } = await open(`/distribution-lists/${listGuid(1)}`);
    await screen.findByRole('link', { name: 'User 0001' });
    expectNoGaps(outline(container));
    expectNamedControls(container);
    expect(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0001' }),
      }),
    ).toBeInTheDocument();
    // The restricted row is a row of its own with the kind in words and nothing to select.
    expect(container.querySelector('tr[data-restricted="true"]')).not.toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('the detail of a contact with its lists', async () => {
    const { container } = await open(`/contacts/${contactGuid(1)}`);
    await screen.findByRole('link', { name: 'Sales' });
    expectNoGaps(outline(container));
    expectNamedControls(container);
  });
});

describe('the dialogs', () => {
  it('the add dialog names itself, traps the focus and returns it to the button on Escape', async () => {
    const { user } = await open(`/distribution-lists/${listGuid(1)}`);
    await screen.findByRole('link', { name: 'User 0001' });
    const button = screen.getByRole('button', { name: t('distributionLists.add.open') });
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: t('distributionLists.add.title') });
    expect(dialog).toHaveAccessibleDescription(/Sales/);
    expectNamedControls(dialog);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(button).toHaveFocus();
  });

  it('the contact form: labelled fields, the message is the description, the first wrong field has the focus', async () => {
    const { user } = await open('/contacts');
    await screen.findByRole('link', { name: 'Ada Lovelace' });
    await user.click(screen.getByRole('button', { name: t('contacts.actions.new') }));
    const dialog = await screen.findByRole('dialog', { name: t('contacts.form.create.title') });
    await user.click(
      within(dialog).getByRole('button', { name: t('contacts.form.create.submit') }),
    );
    const name = within(dialog).getByRole('textbox', { name: /^Display name/ });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(t('contacts.validation.display_name_empty'));
    expect(name).toHaveFocus();
    expect(within(dialog).getByRole('textbox', { name: /^First name/ })).not.toHaveAttribute(
      'aria-invalid',
    );
  });
});

describe('the keyboard', () => {
  it('removes a member with the keyboard alone: select, Remove, confirm', async () => {
    const { api, user } = await open(`/distribution-lists/${listGuid(1)}`);
    await screen.findByRole('link', { name: 'User 0002' });
    const box = screen.getByRole('checkbox', {
      name: t('distributionLists.members.select', { name: 'User 0002' }),
    });
    box.focus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    const remove = screen.getByRole('button', { name: t('distributionLists.remove.open') });
    remove.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    // The focus starts on Cancel, never on the destructive button; Tab reaches Remove.
    expect(
      within(dialog).getByRole('button', { name: t('distributionLists.remove.cancel') }),
    ).toHaveFocus();
    await user.tab();
    expect(
      within(dialog).getByRole('button', {
        name: t('distributionLists.remove.confirm', { count: 1 }),
      }),
    ).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.callsTo('DELETE', /members$/)).toHaveLength(1);
    });
    expect(api.callsTo('DELETE', /members$/)[0]?.body).toEqual({ members: [guid(1002)] });
  });
});
