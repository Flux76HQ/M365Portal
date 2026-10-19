// The CSV export of a distribution list, end to end (T-D-280; US-D5, FR-D-401 to FR-D-406, EC-D12, SC-D-004): the
// production build, the fake tenant and the fake Exchange. The file is downloaded by the browser and read back
// in the test: the byte order mark, the semicolons, a member whose name is a formula, and the audit row.
import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, fakeOf, test } from '../fixtures.js';
import { heading } from '../fixtures/directory-page.js';
import { auditMark, listId } from '../fixtures/lists.js';
import { apiOf } from '../fixtures/directory.js';
import {
  clearExchangeSeed,
  PEOPLE,
  seedExchange,
  SEEDED_LISTS,
  standardSeed,
} from '../support/exchange-seed.js';

test.describe.configure({ mode: 'serial' });

const FORMULA = '=HYPERLINK("http://evil.example","click")';

test.beforeEach(async () => {
  const seed = standardSeed();
  await seedExchange({
    ...seed,
    recipients: [
      ...(seed.recipients ?? []),
      { key: 'evil', displayName: FORMULA, primarySmtpAddress: 'evil@partner.example' },
    ],
    groups: (seed.groups ?? []).map((group) =>
      group.name === SEEDED_LISTS.marketing
        ? { ...group, members: [...(group.members ?? []), 'evil'] }
        : group,
    ),
  });
});

test.afterAll(async () => {
  await clearExchangeSeed();
});

/** Presses Download, goes through the step-up the server asks for, opens the dialog again and downloads. */
async function downloadAfterStepUp(page: Page, id: string, choose?: () => Promise<void>) {
  const dialogName = 'Export Marketing as CSV';
  const open = async () => {
    await page.getByRole('button', { name: 'Export as CSV' }).click();
    const dialog = page.getByRole('dialog', { name: dialogName });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('The first rows of the file')).toBeVisible();
    return dialog;
  };
  let dialog = await open();
  await choose?.();
  await dialog.getByRole('button', { name: 'Download CSV' }).click();
  // A download needs a fresh sign-in: the refusal is a denial, nothing was sent.
  const stepUp = page.getByRole('dialog', { name: 'Confirm with a new sign-in' });
  await expect(stepUp).toBeVisible();
  await fakeOf().nextSignIn('deputy');
  await stepUp.getByRole('button', { name: 'Sign in again' }).click();
  await page.waitForURL((url) => url.pathname === `/distribution-lists/${id}`);
  dialog = await open();
  await choose?.();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download CSV' }).click();
  return { dialog, download: await downloading };
}

test.describe('the Owner exports a list', () => {
  // `deputy` is a disposable owner: a step-up rotates the session, which must not touch the shared one.
  test.use({ principal: 'anonymous' });

  test.beforeAll(async () => {
    await fakeOf().seedDirectory();
  });

  test.afterAll(async () => {
    await fakeOf().unseedDirectory();
  });

  test('downloads the Laposta file after the step-up: BOM, semicolons, one audit row', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    guard.allowResponse({ status: 403, url: '/export' });
    await app.signInAs('deputy', { returnTo: '/distribution-lists' });
    await app.ready();
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    await expect(heading(page, 'Marketing')).toBeVisible();
    const audit = auditMark();

    await page.getByRole('button', { name: 'Export as CSV' }).click();
    const first = page.getByRole('dialog', { name: 'Export Marketing as CSV' });
    await expect(first.getByText(/names and email addresses of people/)).toBeVisible();
    await expect(first.getByRole('radio', { name: 'Laposta' })).toBeChecked();
    const preview = first.getByLabel('The first rows of the file');
    await expect(preview).toContainText('email;first_name;last_name');
    await expect(preview).toContainText('rita.reader@contoso-fake.example');
    await expect(first.getByText('The whole file: 3 rows.')).toBeVisible();
    await page.keyboard.press('Escape');

    const { dialog, download } = await downloadAfterStepUp(page, id);
    expect(download.suggestedFilename()).toMatch(/^Marketing-\d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = readFileSync(await download.path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString('utf8').split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0]).toBe('email;first_name;last_name');
    expect(lines).toContain(`${PEOPLE.rita.primarySmtpAddress};;`);
    expect(lines).toContain(`${PEOPLE.hanna.primarySmtpAddress};;`);
    expect(lines).toContain('evil@partner.example;;');
    expect(lines).toHaveLength(4);
    await expect(dialog.getByRole('status')).toHaveText('The file was downloaded.');

    // The refusal before the step-up is a denial under the route id; the export itself is one success row.
    const rows = audit.since().filter((row) => row.action.includes('export'));
    expect(rows.map((row) => [row.action, row.outcome])).toEqual([
      ['distributionlists.export', 'denied'],
      ['dl.export', 'success'],
    ]);
    expect(rows[1]?.targetId).toBe(id);
    expect(rows[1]?.detail).toMatchObject({ rows: 3, skipped: 0, preset: 'laposta' });
    expect(JSON.stringify(rows[1]?.detail)).not.toMatch(/rita|hanna|evil|partner|contoso/i);
  });

  test('a member whose name is a formula is text in the file, and the dialog has no axe violations', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    guard.allowResponse({ status: 403, url: '/export' });
    await app.signInAs('deputy', { returnTo: '/distribution-lists' });
    await app.ready();
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    await expect(heading(page, 'Marketing')).toBeVisible();

    const generic = async () => {
      const dialog = page.getByRole('dialog', { name: 'Export Marketing as CSV' });
      await dialog.getByRole('radio', { name: 'All columns' }).click();
      const preview = dialog.getByLabel('The first rows of the file');
      await expect(preview).toContainText('email,first_name,last_name,display_name,type');
      await expect(preview).toContainText('" =HYPERLINK(""http://evil.example"",""click"")"');
    };
    await page.getByRole('button', { name: 'Export as CSV' }).click();
    await generic();
    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    await page.keyboard.press('Escape');

    const { download } = await downloadAfterStepUp(page, id, generic);
    const text = readFileSync(await download.path(), 'utf8');
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text).toContain(
      'evil@partner.example,,," =HYPERLINK(""http://evil.example"",""click"")",user\r\n',
    );
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});

test.describe('who may not export', () => {
  test('a Reader sees no button and the server refuses the export with an audit row', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 403, url: '/export' });
    await app.signInAs('reader', { returnTo: '/distribution-lists' });
    await app.ready();
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    await expect(heading(page, 'Marketing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export as CSV' })).toHaveCount(0);

    const audit = auditMark();
    const api = await apiOf(page.context());
    const answer = await api.post(`/api/v1/distribution-lists/${id}/export`, {
      preset: 'generic',
    });
    expect(answer.status).toBe(403);
    const denied = audit.since().filter((row) => row.outcome === 'denied');
    expect(denied.map((row) => row.action)).toEqual(['distributionlists.export']);
  });
});
