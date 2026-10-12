// The setup gate (FR-B-201, FR-B-202, FR-B-203, FR-B-206, FR-B-207; EB-01; SC-B-001; US-B1), on the
// empty instance B: nothing of the setup answers without the setup token, five wrong tokens lock the
// client, the right token opens step 1, the token goes nowhere but the body of the unlock, and over
// plain http a request that names a foreign Host or carries a forwarding header is a 404.
import { ApiClient } from '../support/api-client.js';
import { expect, test } from '../fixtures.js';
import { restartServer } from '../servers.js';
import {
  allowStaleCsrfAfterUnlock,
  expectNoSecrets,
  setupTokenOfB,
  unlock,
} from '../support/wizard-page.js';
import { originOf } from '../support/ports.js';

test.use({ principal: 'anonymous', ownClientAddress: false });

test.beforeEach(async ({ app }) => {
  await app.servers.resetEmpty();
});

const SETUP_AND_CONNECTION_ROUTES: readonly (readonly [string, string, unknown?])[] = [
  ['GET', '/api/v1/setup/state'],
  ['POST', '/api/v1/setup/environment', {}],
  ['PUT', '/api/v1/setup/manual', {}],
  ['GET', '/api/v1/setup/certificate.cer'],
  ['GET', '/api/v1/setup/groups?q=a'],
  ['POST', '/api/v1/setup/finish', {}],
  ['DELETE', '/api/v1/setup/session'],
  ['GET', '/api/v1/connection'],
  ['GET', '/api/v1/connection/log'],
  ['GET', '/api/v1/connection/runs/current'],
  ['POST', '/api/v1/connection/runs', { steps: ['connect'], mode: 'continue' }],
  ['POST', '/api/v1/connection/runs/current/retry-now', {}],
  ['POST', '/api/v1/connection/runs/current/cancel', {}],
  ['POST', '/api/v1/connection/adopt', {}],
  ['POST', '/api/v1/connection/verify', {}],
];

test('every setup and connection route answers 401 without the setup cookie, with no tenant data', async () => {
  const api = new ApiClient('b', {}, null);
  for (const [method, path, body] of SETUP_AND_CONNECTION_ROUTES) {
    let response = await api.request(method, path, body === undefined ? {} : { json: body });
    if (response.status === 429) {
      // The setup rate class holds ten tokens; a restart starts with a full bucket.
      await restartServer('b');
      response = await api.request(method, path, body === undefined ? {} : { json: body });
    }
    expect(response.status, `${method} ${path}`).toBe(401);
    // A problem body names the failure and the request, and nothing about a tenant.
    expect(response.text.replace(/"requestId":"[^"]*"/, ''), `${method} ${path}`).not.toMatch(
      /tenant|contoso|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  }
});

test('five wrong tokens lock the client, and a correct token is refused during the lock', async () => {
  const api = new ApiClient('b', {}, null);
  const answers: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    answers.push(
      (await api.post('/api/v1/setup/unlock', { token: `wrong-token-${String(attempt)}` })).status,
    );
  }
  expect(answers.slice(0, 4)).toEqual([401, 401, 401, 401]);
  const locked = await api.post('/api/v1/setup/unlock', { token: setupTokenOfB() });
  expect(locked.status, 'the right token during the lock').toBe(429);
  expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(locked.text).toContain('setup_token_locked');
  // The refused token did not open anything.
  expect((await api.get('/api/v1/setup/state')).status).toBe(401);
});

test('the lock is shown in the form with the wait, and the button stays off', async ({
  page,
  app,
  guard,
}) => {
  guard.allowResponse({ status: 429, url: '/api/v1/setup/unlock' });
  await app.goto('/setup', { instance: 'b' });
  const api = new ApiClient('b', {}, null);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await api.post('/api/v1/setup/unlock', { token: `wrong-token-${String(attempt)}` });
  }
  await page.getByLabel('Setup token').fill(setupTokenOfB());
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('[data-slot="token-locked"]')).toContainText(
    /You can try again in \d+ s/,
  );
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();
});

test('the right token opens step 1, and the field is a password field', async ({
  page,
  app,
  guard,
}) => {
  allowStaleCsrfAfterUnlock(guard);
  await app.goto('/setup', { instance: 'b' });
  await expect(page.getByRole('heading', { level: 1, name: 'Unlock the setup' })).toBeVisible();
  const field = page.getByLabel('Setup token');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(setupTokenOfB());
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Check the environment' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Setup steps' })).toBeVisible();
});

test('the token appears nowhere except the request body of the unlock', async ({
  page,
  app,
  guard,
}) => {
  allowStaleCsrfAfterUnlock(guard);
  const token = setupTokenOfB();
  const sent: { method: string; url: string; headers: string; body: string }[] = [];
  const console_: string[] = [];
  page.on('request', (request) => {
    sent.push({
      method: request.method(),
      url: request.url(),
      headers: JSON.stringify(request.headers()),
      body: request.postData() ?? '',
    });
  });
  page.on('console', (message) => console_.push(message.text()));
  await app.goto('/setup', { instance: 'b' });
  await unlock(page, token);
  // Let the wizard fetch what it fetches after the unlock.
  await expect(
    page.getByRole('heading', { level: 2, name: 'Check the environment' }),
  ).toBeVisible();
  await page.waitForLoadState('networkidle');

  const carriers = sent.filter(
    (request) =>
      request.url.includes(token) ||
      request.headers.includes(token) ||
      request.body.includes(token),
  );
  expect(carriers.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    'POST /api/v1/setup/unlock',
  ]);
  const unlockRequest = carriers[0];
  expect(unlockRequest?.url.includes(token)).toBe(false);
  expect(unlockRequest?.headers.includes(token)).toBe(false);
  expect(console_.filter((line) => line.includes(token))).toEqual([]);
  expect(page.url().includes(token)).toBe(false);
  await expectNoSecrets(page, [token]);
  // The field was emptied the moment the token was sent.
  const history = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => entry.name),
  );
  expect(history.filter((name) => name.includes(token))).toEqual([]);
});

test.describe('over http', () => {
  test('a request that names a non-loopback Host is a 404', async ({ request }) => {
    const origin = originOf('b');
    for (const path of ['/api/v1/setup/status', '/setup']) {
      const response = await request.get(`${origin}${path}`, {
        headers: { Host: 'panel.example.com' },
      });
      expect(response.status(), path).toBe(404);
    }
    const unlock_ = await request.post(`${origin}/api/v1/setup/unlock`, {
      headers: { Host: 'panel.example.com', 'content-type': 'application/json' },
      data: { token: 'whatever-token-of-24-chars-x' },
    });
    expect(unlock_.status()).toBe(404);
  });

  test('a request that carries X-Forwarded-For is a 404', async ({ request }) => {
    const origin = originOf('b');
    const response = await request.get(`${origin}/api/v1/setup/status`, {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    expect(response.status()).toBe(404);
    const ok = await request.get(`${origin}/api/v1/setup/status`);
    expect(ok.status(), 'the same request without the header').toBe(200);
  });
});
