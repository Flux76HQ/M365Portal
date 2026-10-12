// The connection page (FR-B-111, FR-B-220, FR-B-319; SC-B-011; US-B9, US-B12): "Settings, Connection" shows
// the owner the tenant, the application, the thumbprint, the days left, the proof list and the latest
// activity; a reader gets the No-access content at the same address. What the page says is compared
// with what the fake tenant holds, so a page that invented a value would fail.
import { expect, fakeOf, test } from '../fixtures.js';
import { PROOF_KEYS, proofStatuses } from '../support/wizard-page.js';

test.describe('the owner', () => {
  test('sees the tenant, the application, the certificate, the proof list and the log', async ({
    page,
    app,
    guard,
  }) => {
    void guard;
    const application = await fakeOf('a').panelApplication();
    const tenantId = await fakeOf('a').tenantId();
    await app.goto('/settings/connection');
    await expect(page.getByRole('heading', { level: 1, name: 'Connection' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Tenant' })).toBeVisible();

    const tenant = page.getByRole('region', { name: 'Tenant' });
    await expect(tenant).toContainText(tenantId);
    await expect(tenant).toContainText('Contoso Fake Tenant');
    await expect(tenant).toContainText('contoso-fake.onmicrosoft.com');
    await expect(tenant).toContainText('Automatic');

    const section = page.getByRole('region', { name: 'Application' });
    await expect(section).toContainText(application.displayName);
    await expect(section).toContainText(application.appId);
    // Microsoft ignores the port of a registered http://localhost address, so none is registered.
    await expect(section).toContainText('http://localhost/auth/callback');
    expect(application.redirectUris).toContain('http://localhost/auth/callback');
    await expect(section).toContainText('Connected');

    const certificate = page.getByRole('region', { name: 'Certificate' });
    const thumbprint = application.thumbprintsSha1[0] ?? '';
    expect(thumbprint).toMatch(/^[0-9a-f]{40}$/);
    await expect(certificate).toContainText(new RegExp(thumbprint, 'i'));
    await expect(certificate.getByText(/^(359|360) days$/)).toBeVisible();
    await expect(certificate).toContainText('The certificate is valid.');

    // Every row of the proof list, green.
    const proof = await proofStatuses(page);
    expect(Object.keys(proof).sort()).toEqual([...PROOF_KEYS].sort());
    for (const key of PROOF_KEYS) expect(proof[key], key).toBe('ok');
    await expect(page.getByRole('region', { name: 'Proof that it works' })).toContainText(
      'Last verified',
    );

    // The latest activity: lines from the setup run, in the panel's words.
    const log = page.getByRole('region', { name: 'Latest activity' });
    await expect(log).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Repair the connection' }),
    ).toBeVisible();
  });

  test('the page shows no secret: no key, no token, no certificate body', async ({ page, app }) => {
    await app.goto('/settings/connection');
    await expect(page.getByRole('region', { name: 'Certificate' })).toBeVisible();
    const text = await page.content();
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./);
    expect(text).not.toMatch(new RegExp(`${'-'.repeat(5)}BEGIN `));
    const { secrets } = (await import('../servers.js')).readState();
    expect(text).not.toContain(secrets.appKey.a);
    expect(text).not.toContain(secrets.setupToken.a);
  });
});

test.describe('a reader', () => {
  test.use({ principal: 'reader' });

  test('gets the No-access content at the same address, and no tenant data', async ({
    page,
    app,
  }) => {
    const application = await fakeOf('a').panelApplication();
    await app.goto('/settings/connection');
    await expect(page).toHaveURL(/\/settings\/connection$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text).not.toContain(application.appId);
    expect(text).not.toContain('Contoso');
    // ... and the server refuses the call behind it.
    const response = await page.request.get(app.url('/api/v1/connection'));
    expect(response.status()).toBe(403);
  });
});
