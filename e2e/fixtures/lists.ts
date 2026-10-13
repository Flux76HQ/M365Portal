// Drivers and readers for the distribution list, contact and group member specs of Phase D step D1
// (T-D-180, T-D-181). The fake Exchange behind the `pwsh` shim is seeded by `support/exchange-seed.ts`; what
// the panel did is read through its own API (as the person in the page) and through the audit log in the
// database (the audit screen arrives in step D2).
//
// Names used here are the ones the web gate GD1-web froze (`distributionLists.*`, `contacts.*` in English):
// the buttons "Add members", "Remove selected", the dialog "Add members", the confirmation "Remove 2
// members?", the region "Result of the last change", the picker's search "Search users and contacts".
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { readState } from '../servers.js';
import { auditRowsAfter, lastAuditSeq, type AuditRow } from '../support/database.js';
import { expect } from '../fixtures.js';
import { apiOf } from './directory.js';

export interface ListRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly kind: string;
  readonly memberCount: number | null;
}

export interface MemberRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly kind: string;
  readonly primarySmtpAddress?: string | null;
}

export interface ContactRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly alias: string | null;
  readonly externalEmailAddress: string | null;
}

export const dataDirOfA = (): string => readState().instances.a.dataDir;

/** The id of the list with this name, as the panel knows it (the Exchange GUID). */
export async function listId(context: BrowserContext, name: string): Promise<string> {
  const api = await apiOf(context);
  const answer = await api.get(`/api/v1/distribution-lists?q=${encodeURIComponent(name)}&limit=50`);
  if (answer.status !== 200) throw new Error(`the list search answered ${String(answer.status)}`);
  const row = (answer.json() as { items: ListRow[] }).items.find((r) => r.displayName === name);
  if (row === undefined) throw new Error(`no list named ${name}`);
  return row.id;
}

/** The members of a list as the API reads them (the first page, 200 at most). */
export async function membersOf(context: BrowserContext, id: string): Promise<MemberRow[]> {
  const api = await apiOf(context);
  const answer = await api.get(`/api/v1/distribution-lists/${id}/members?limit=200`);
  if (answer.status !== 200) throw new Error(`the members answered ${String(answer.status)}`);
  return (answer.json() as { items: MemberRow[] }).items;
}

export async function contactId(context: BrowserContext, name: string): Promise<string> {
  const api = await apiOf(context);
  const answer = await api.get(`/api/v1/contacts?q=${encodeURIComponent(name)}&limit=50`);
  if (answer.status !== 200)
    throw new Error(`the contact search answered ${String(answer.status)}`);
  const row = (answer.json() as { items: ContactRow[] }).items.find((r) => r.displayName === name);
  if (row === undefined) throw new Error(`no contact named ${name}`);
  return row.id;
}

/** A mark in the audit log; `since()` are the rows written after it. */
export function auditMark(): { since(): AuditRow[] } {
  const dataDir = dataDirOfA();
  const mark = lastAuditSeq(dataDir);
  return { since: () => auditRowsAfter(dataDir, mark) };
}

/** The per-member rows and the summary row of a member write, from the rows after a mark. */
export function memberAudit(
  rows: readonly AuditRow[],
  action: string,
): { members: AuditRow[]; summary: AuditRow | undefined } {
  const mine = rows.filter((row) => row.action === action);
  return {
    members: mine.filter((row) => row.detail.summary !== true),
    summary: mine.find((row) => row.detail.summary === true),
  };
}

// ---- the pages ----------------------------------------------------------------------------------------

export const addButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Add members', exact: true });

export const removeButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Remove selected', exact: true });

export const resultRegion = (page: Page): Locator =>
  page.getByRole('region', { name: 'Result of the last change' });

export const membersTable = (page: Page, listName: string): Locator =>
  page.getByRole('table', { name: `Members of ${listName}` });

/** The checkbox in front of a member of the members table. */
export const memberCheckbox = (page: Page, memberName: string): Locator =>
  page.getByRole('checkbox', { name: `Select ${memberName}`, exact: true });

/** Opens the add dialog of a list or group page and searches. Returns the dialog. */
export async function openPicker(page: Page, search?: string): Promise<Locator> {
  await addButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Add members' });
  await expect(dialog).toBeVisible();
  if (search !== undefined) {
    const box = dialog.getByRole('searchbox');
    await box.fill(search);
    await box.press('Enter');
  }
  return dialog;
}

/** The checkbox of a candidate in the picker (its name holds the person's name and address). */
export const candidate = (dialog: Locator, name: string | RegExp): Locator =>
  dialog.getByRole('checkbox', { name });

export function confirmAdd(dialog: Locator, count: number): Locator {
  return dialog.getByRole('button', {
    name: count === 1 ? 'Add 1 member' : `Add ${String(count)} members`,
  });
}

export function removeDialog(page: Page, count: number): Locator {
  return page.getByRole('alertdialog', {
    name: count === 1 ? 'Remove 1 member?' : `Remove ${String(count)} members?`,
  });
}
