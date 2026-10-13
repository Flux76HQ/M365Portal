// Puts the browser on a state of `MEMBER_STATES` (routes.ts, Phase D step D1) for the axe, keyboard, responsive and
// visual specs: the fake Exchange behind the `pwsh` shim is seeded, the object the path names is looked up, the
// steps the person takes are taken, and the answers that are the point of the state are allowed for the `guard`.
// The Owner is signed in at the start of every test (the default principal).
import type { Locator, Page } from '@playwright/test';
import { expect, type App, type Guard } from '../fixtures.js';
import type { ExchangeSeed } from '../support/exchange-seed.js';
import { seedExchange, standardSeed } from '../support/exchange-seed.js';
import { PRINCIPALS } from '../support/principals.js';
import type { MemberState } from '../routes.js';
import { apiOf } from './directory.js';
import { contactId, listId } from './lists.js';

function seedFor(data: MemberState['data']): ExchangeSeed {
  if (data === 'empty') return { recipients: [], contacts: [], groups: [] };
  if (data === 'narrow') return { ...standardSeed(), bulk: { groups: 4000 } };
  return standardSeed();
}

/** Looks the names in a path up: `{list:Name}`, `{contact:Name}` and `{group:key}`. */
export async function resolvePath(
  page: Page,
  groupIds: Readonly<Record<string, string | undefined>>,
  path: string,
): Promise<string> {
  let resolved = path;
  for (const match of path.matchAll(/\{(list|contact|group):([^}]+)\}/g)) {
    const token = match[0];
    const kind = match[1];
    const name = match[2];
    if (name === undefined) continue;
    let id: string;
    if (kind === 'list') id = await listId(page.context(), name);
    else if (kind === 'contact') id = await contactId(page.context(), name);
    else {
      const key = groupIds[name];
      if (key === undefined) throw new Error(`the seed has no group ${name}`);
      id = key;
    }
    resolved = resolved.replace(token, id);
  }
  return resolved;
}

/** The first dialog of the page, whatever its role. */
const overlay = (page: Page): Locator =>
  page.locator('[role="dialog"], [role="alertdialog"]').first();

export interface VisitedMemberState {
  readonly path: string;
  /** Undoes what the state changed outside the fake Exchange (the Graph groups keep their members). */
  cleanup(): Promise<void>;
}

/**
 * Visits a state. `groupIds` maps the keys of `{group:key}` to ids (`DirectoryWorld.facts.ids` of the seeded
 * directory); a spec that has no group state passes `{}`.
 */
export async function visitMemberState(
  fixtures: { readonly page: Page; readonly app: App; readonly guard: Guard },
  groupIds: Readonly<Record<string, string | undefined>>,
  state: MemberState,
): Promise<VisitedMemberState> {
  const { page, app, guard } = fixtures;
  seedExchange(seedFor(state.data));
  for (const allowed of state.expect ?? []) guard.allowResponse(allowed);
  // The ids come from the API of the signed-in person (the cookies of the context), before the page opens.
  const path = await resolvePath(page, groupIds, state.path);
  const api = await apiOf(page.context());
  if (state.contactInLists === true) {
    const carol = await contactId(page.context(), 'Carol Bakker');
    for (const name of ['Marketing', 'Sales']) {
      const added = await api.post(
        `/api/v1/distribution-lists/${await listId(page.context(), name)}/members`,
        { members: [carol] },
      );
      expect(added.status, `Carol joins ${name}`).toBe(200);
    }
  }
  await app.goto(path);
  const isGroup = path.startsWith('/groups/');
  let touchedGroup: string | undefined;

  const step = state.step;
  if (step === 'picker' || step === 'picked' || step === 'result') {
    await expect(page.getByRole('button', { name: 'Add members', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add members', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add members' });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole('searchbox');
    await box.fill(isGroup ? 'Rita' : 'Ad');
    await box.press('Enter');
    const first = dialog.getByRole('checkbox').first();
    await expect(first).toBeVisible();
    if (step !== 'picker') {
      await first.check();
      await expect(dialog.getByText('1 selected')).toBeVisible();
    }
    if (step === 'result') {
      await dialog.getByRole('button', { name: 'Add 1 member' }).click();
      await expect(page.getByRole('region', { name: 'Result of the last change' })).toBeVisible();
      if (isGroup) touchedGroup = path.split('/').at(-1);
    }
  } else if (step === 'remove-confirm') {
    const checkbox = page.getByRole('checkbox').first();
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await page.getByRole('button', { name: 'Remove selected', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
  } else if (step === 'form-errors') {
    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByRole('button', { name: 'Create contact' }).click();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
  } else if (step === 'form-edit') {
    await page.getByRole('button', { name: 'Edit contact' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
  } else if (step === 'delete-confirm') {
    await page.getByRole('button', { name: 'Delete contact' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete this contact?' });
    await expect(dialog).toBeVisible();
    // The dialog counts the lists first ("Checking ...") and then says how many.
    await expect(dialog.getByText(/This contact is in \d+ distribution lists?/)).toBeVisible();
  }
  if (step !== undefined)
    await expect(
      overlay(page).or(page.getByRole('region', { name: 'Result of the last change' })),
    ).toBeVisible();

  return {
    path,
    async cleanup() {
      if (touchedGroup === undefined) return;
      await api.request('DELETE', `/api/v1/groups/${touchedGroup}/members`, {
        json: { members: [PRINCIPALS.reader.oid] },
      });
    },
  };
}
