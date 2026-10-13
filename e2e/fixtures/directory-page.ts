// Drivers of the users and groups pages for the end-to-end specs (T-C-061 to T-C-064). They use the accessible
// names the web gate GC2 froze: the search field "Search by name or email address" and its button "Search",
// the filter groups "Account state", "User type" and "Group type" (radio buttons), the tables named by their
// captions, the sort button "Display name", "Previous page" and "Next page", the live region "{n} users
// shown", and `data-restricted="true"` on a row the actor may not see.
import type { Locator, Page } from '@playwright/test';
import { expect, fakeOf, type App, type Guard } from '../fixtures.js';
import type { DirectoryState } from '../routes.js';
import { expectedProblemsOf, pathOfState, type DirectoryWorld } from './directory.js';

/** The page heading (level 1). */
export const heading = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('heading', { level: 1, name });

export const searchField = (page: Page): Locator =>
  page.getByRole('searchbox', { name: 'Search by name or email address' });

export const searchButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Search', exact: true });

/** One radio of a filter group, for example `filterChoice(page, 'Account state', 'Disabled')`. */
export const filterChoice = (page: Page, group: string, choice: string): Locator =>
  page
    .getByRole('group', { name: group, exact: true })
    .getByRole('radio', { name: choice, exact: true });

export const nextPage = (scope: Page | Locator): Locator =>
  scope.getByRole('button', { name: 'Next page' });

export const previousPage = (scope: Page | Locator): Locator =>
  scope.getByRole('button', { name: 'Previous page' });

/** The polite live region that says how many rows the page shows. */
export const countStatus = (scope: Page | Locator): Locator =>
  scope.getByRole('status').filter({ hasText: /shown/ });

/** The semantic table with this caption (the region around it carries the same name, so ask for the table). */
export const tableNamed = (page: Page, caption: string | RegExp): Locator =>
  page.getByRole('table', { name: caption });

/** A section of a detail page by its heading ("Owners", "Members", "Manager", "Group memberships"). */
export const sectionNamed = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

/** The `href` of the link in the first cell of each row of the table, in order. */
export async function rowHrefs(table: Locator): Promise<string[]> {
  return table
    .locator('tbody tr th a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
}

/** The text of the link in the first cell of each row, in order. */
export async function rowNames(table: Locator): Promise<string[]> {
  return table.locator('tbody tr th a').allInnerTexts();
}

export interface WalkedPage {
  readonly hrefs: string[];
  readonly names: string[];
  readonly restricted: number;
}

async function readPage(table: Locator): Promise<WalkedPage> {
  return {
    hrefs: await rowHrefs(table),
    names: await rowNames(table),
    restricted: await table.locator('tbody tr[data-restricted="true"]').count(),
  };
}

/**
 * Clicks "Next page" until it is disabled and returns what each page showed. A page is "loaded" when the page
 * number is the expected one and "Previous page" is enabled again (both buttons are disabled while another page
 * loads, so this cannot be read early), and the live region says how many rows are shown.
 */
export async function walkPages(
  page: Page,
  table: Locator,
  scope: Page | Locator = page,
  maxPages = 80,
): Promise<WalkedPage[]> {
  const pages: WalkedPage[] = [];
  await expect(countStatus(scope).first()).toHaveText(/\d+ .* shown/);
  pages.push(await readPage(table));
  for (let number = 2; number <= maxPages; number += 1) {
    if (await nextPage(scope).isDisabled()) return pages;
    await nextPage(scope).click();
    await expect(scope.getByText(`Page ${String(number)}`, { exact: true })).toBeVisible();
    await expect(previousPage(scope)).toBeEnabled();
    await expect(countStatus(scope).first()).toHaveText(/\d+ .* shown/);
    pages.push(await readPage(table));
  }
  throw new Error(`the list had more than ${String(maxPages)} pages`);
}

/** Whether the names are in order (the comparison of the fake and of Graph for this list: lower case, by code unit). */
export function isSortedByName(
  names: readonly string[],
  direction: 'asc' | 'desc' = 'asc',
): boolean {
  for (let index = 1; index < names.length; index += 1) {
    const before = (names[index - 1] ?? '').toLowerCase();
    const after = (names[index] ?? '').toLowerCase();
    if (direction === 'asc' ? before > after : before < after) return false;
  }
  return true;
}

/** A problem+json answer of the product, for a spec that stands in for a failing server. */
export function problemBody(
  status: number,
  code: string,
  errors: readonly { pointer: string; code: string }[] = [],
): string {
  return JSON.stringify({
    type: `about:blank#${code}`,
    title: code,
    status,
    code,
    ...(errors.length === 0 ? {} : { errors }),
  });
}

/** Waits for the skeletons to go, the network to settle and the font to be in: the page a person sees. */
export async function settleDirectoryPage(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** The server stand-in of the state "users-error": the list fails as it does when a Graph permission is missing. */
export async function mockUsersUnavailable(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/users\?/, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: problemBody(503, 'graph_unavailable', [
        { pointer: '', code: 'graph_permission_missing' },
      ]),
    }),
  );
}

/**
 * Puts the browser on a state of `DIRECTORY_STATES`: the right person is signed in (the Owner is, at the start of
 * every test; the others sign in over it), the switches of the fake tenant the state needs are turned, the
 * answers that are the point of the state are allowed for the `guard`, and the page is open and ready. Returns
 * the address. `resetDirectorySwitches` undoes the switches.
 */
export async function visitState(
  fixtures: { readonly page: Page; readonly app: App; readonly guard: Guard },
  world: Pick<DirectoryWorld, 'facts' | 'actors'>,
  state: DirectoryState,
): Promise<string> {
  const { page, app, guard } = fixtures;
  const path = pathOfState(world.facts, state);
  for (const allowed of expectedProblemsOf(world.facts, state)) guard.allowResponse(allowed);
  if (state.mock === 'users-unavailable') await mockUsersUnavailable(page);
  if (state.managerForApps !== undefined) await fakeOf().managerForApps(state.managerForApps);
  if (state.actor === 'full') {
    await app.goto(path);
  } else {
    await page.context().clearCookies();
    await app.signInAs(world.actors[state.actor].principal, { returnTo: path });
    await app.ready();
  }
  return path;
}

/** The switches of the fake tenant a state may have turned, back to their defaults. */
export async function resetDirectorySwitches(): Promise<void> {
  await fakeOf().managerForApps('refused');
}
