// Manual mode (FR-B-218, FR-B-111; EB-04; SC-B-011; US-B3; OV-21 prerequisite): when the device code is not
// an option the person sets the application up by hand from a checklist. The checklist is compared with
// what the automatic mode really created in the other tenant of the fake; the certificate to upload
// is downloaded and parsed with openssl; the application is then made "in Microsoft Entra" exactly
// from the checklist; the three values are typed; checks V1 to V3 and V5 pass and V4 and V6 show
// "not checked" (they need a sign-in at Microsoft).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, fakeOf, test } from '../fixtures.js';
import { PRINCIPALS } from '../support/principals.js';
import {
  allowStaleCsrfAfterUnlock,
  expectNoRawKeys,
  expectNoSecrets,
  passEnvironment,
  proofStatuses,
  setupTokenOfB,
  unlock,
} from '../support/wizard-page.js';
import { readState } from '../servers.js';

test.use({ principal: 'anonymous', ownClientAddress: false });

const EXCHANGE_ADMINISTRATOR_TEMPLATE = '29232cdf-9323-42fd-ade2-1d097af3e4de';

/** The checklist as the page shows it: label to values. */
async function readChecklist(page: Page): Promise<Map<string, string[]>> {
  const items: Locator = page.getByRole('list', { name: 'Checklist' }).locator('> li');
  const count = await items.count();
  const checklist = new Map<string, string[]>();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const label = (await item.locator('> p').innerText()).trim();
    checklist.set(label, await item.locator('code').allInnerTexts());
  }
  return checklist;
}

function openssl(args: string[], input?: Buffer): string {
  const result = spawnSync('openssl', args, {
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`openssl ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

test('the checklist equals the automatic mode, the certificate parses, and the hand-made application passes V1 to V3 and V5', async ({
  page,
  app,
  guard,
}) => {
  test.setTimeout(240_000);
  allowStaleCsrfAfterUnlock(guard);
  await app.servers.resetEmpty();
  const automatic = await fakeOf('a').panelApplication();

  await app.goto('/setup', { instance: 'b' });
  await unlock(page);
  await passEnvironment(page);
  await page.getByRole('button', { name: 'Set up by hand' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Set up by hand' })).toBeVisible();

  // 1. The checklist equals what the automatic mode sent to Microsoft (the other tenant of the fake).
  const checklist = await readChecklist(page);
  const values = (label: string): string[] => checklist.get(label) ?? [];
  expect(values('Application name')).toEqual([automatic.displayName]);
  expect(values('Application description (exactly this text)')[0]).toMatch(
    /^Created by the M365Portal setup wizard \(install [0-9a-f]{8}\)$/,
  );
  expect(automatic.description).toMatch(
    /^Created by the M365Portal setup wizard \(install [0-9a-f]{8}\)$/,
  );
  const tags = values('Tags (both, exactly as written)');
  expect(tags[0]).toBe(automatic.tags[0]);
  expect(tags[1]).toMatch(/^m365portal-install-[0-9a-f]{32}$/);
  expect(automatic.tags[1]).toMatch(/^m365portal-install-[0-9a-f]{32}$/);
  const normalised = (uris: readonly string[]): string[] =>
    uris.map((uri) => uri.replace(/^https?:\/\/[^/]+/, '')).sort();
  expect(normalised(values('Redirect addresses (web)'))).toEqual(
    normalised(automatic.redirectUris),
  );
  expect([...values('Application permissions of Microsoft Graph')].sort()).toEqual(
    [...automatic.graphRoles].sort(),
  );
  // The checklist asks for the permission that is always needed; the automatic mode also grants
  // `Exchange.ManageAsAppV2` when the tenant exposes it (an open point of the docs: U-number in the gate note).
  const exchangeAsked = values('Application permissions of Exchange Online');
  expect(exchangeAsked).toEqual(['Exchange.ManageAsApp']);
  expect(automatic.exchangeRoles).toEqual(expect.arrayContaining(exchangeAsked));
  expect(automatic.exchangeRoles.filter((role) => !exchangeAsked.includes(role))).toEqual([
    'Exchange.ManageAsAppV2',
  ]);
  expect([...values('Optional claims in the ID token')].sort()).toEqual(
    [...automatic.optionalClaimNames].sort(),
  );
  expect(checklist.has('Implicit grant and hybrid flows: off')).toBe(true);
  expect(checklist.has('Grant admin consent for the permissions')).toBe(true);
  expect(checklist.has('Entra role for the service principal')).toBe(true);

  // 2. The certificate to upload: the public part only, parsed by openssl.
  const download = await page.request.get(app.url('/api/v1/setup/certificate.cer', 'b'));
  expect(download.status()).toBe(200);
  const der = Buffer.from(await download.body());
  const text = openssl(['x509', '-inform', 'DER', '-noout', '-text'], der);
  expect(text).toContain('Public-Key: (2048 bit)');
  expect(text).toContain('rsaEncryption');
  const dates = openssl(['x509', '-inform', 'DER', '-noout', '-startdate', '-enddate'], der);
  const start = Date.parse(/notBefore=(.*)/.exec(dates)?.[1] ?? '');
  const end = Date.parse(/notAfter=(.*)/.exec(dates)?.[1] ?? '');
  const days = (end - start) / 86_400_000;
  expect(days).toBeGreaterThan(359);
  expect(days).toBeLessThanOrEqual(361);
  const fingerprint = openssl(['x509', '-inform', 'DER', '-noout', '-fingerprint', '-sha1'], der)
    .replace(/^.*=/, '')
    .replace(/[:\s]/g, '')
    .toLowerCase();
  // The certificate exists from the first download; the checklist names its thumbprint once the page
  // knows it (a reload shows the setup as it now is).
  await page.reload();
  await passEnvironment(page);
  await page.getByRole('button', { name: 'Set up by hand' }).click();
  expect((await readChecklist(page)).get('Certificate thumbprints')).toEqual([fingerprint]);
  // The key never leaves: the download holds a certificate and nothing else.
  expect(download.headers()['content-type']).toMatch(/x-x509-ca-cert|pkix-cert|octet-stream/);
  const directory = mkdtempSync(join(tmpdir(), 'm365portal-cer-'));
  try {
    writeFileSync(join(directory, 'panel.cer'), der);
    const asPem = openssl(['x509', '-inform', 'DER', '-in', join(directory, 'panel.cer')]);
    expect(asPem).not.toMatch(/PRIVATE KEY/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  // 3. "In Microsoft Entra": the application is made by hand, exactly from the checklist.
  const made = await fakeOf('b').seedManualApplication({
    displayName: values('Application name')[0] ?? '',
    description: values('Application description (exactly this text)')[0] ?? '',
    tags,
    redirectUris: values('Redirect addresses (web)'),
    optionalClaimNames: values('Optional claims in the ID token'),
    graphRoles: values('Application permissions of Microsoft Graph'),
    // The checklist names `Exchange.ManageAsApp`; the Admin API probe (V5) needs `Exchange.ManageAsAppV2` in a
    // tenant that exposes it, which the person sees in the portal and adds (found by this spec: the checklist
    // does not say so, see the gate note).
    exchangeRoles: [
      ...values('Application permissions of Exchange Online'),
      'Exchange.ManageAsAppV2',
    ],
    entraRoleTemplateId: EXCHANGE_ADMINISTRATOR_TEMPLATE,
    certificateBase64: der.toString('base64'),
  });

  // 4. The three values, then "Check".
  await page.getByLabel('Application (client) ID').fill(made.appId);
  await page.getByLabel('Tenant ID').fill(made.tenantId);
  await page.getByLabel('First Owner (user ID or user principal name)').fill(PRINCIPALS.owner.oid);
  await page.getByRole('button', { name: 'Check', exact: true }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Finish the setup' })).toBeVisible({
    timeout: 90_000,
  });
  const proof = await proofStatuses(page);
  expect(proof.check_v1, 'an access token with the certificate').toBe('ok');
  expect(proof.check_v2, 'the organisation of the tenant').toBe('ok');
  expect(proof.check_v3, 'users can be read').toBe('ok');
  expect(proof.check_v5, 'Exchange Online answers').toBe('ok');
  expect(proof.check_v4, 'needs a Microsoft sign-in').toBe('not_checked');
  expect(proof.check_v6, 'needs a Microsoft sign-in').toBe('not_checked');
  await expect(page.locator('[data-proof="check_v4"]')).toContainText(
    'Not checked. This needs a fresh sign-in at Microsoft.',
  );
  await expect(
    page.getByText('Set up by hand', { exact: true }).or(page.getByText('By hand')),
  ).toBeVisible();
  await expectNoRawKeys(page);
  await expectNoSecrets(page, [setupTokenOfB(), readState().secrets.appKey.b]);
});
