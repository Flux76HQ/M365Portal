// The wizard end to end (FR-B-211, FR-B-212, FR-B-214, FR-B-219, FR-B-221, FR-B-606; EB-02 to EB-10;
// SC-B-002, SC-B-003; US-B2, US-B3), on the empty instance B against the fake tenant: unlock, the
// environment, the device code approved through the fake's control endpoint, configure with the live
// log, verify, finish and the first sign-in. Every test starts from an empty B (`resetEmpty`), and the
// `guard` fixture asserts what the task demands of all of them: no `securitypolicyviolation`, no request
// from page scripts to a Microsoft host, no failed same-origin request; the tests add that no secret or
// token is in the DOM, the console or the storage, and that the proof list is green or an expected warning.
import { contextAs, expect, fakeOf, test } from '../fixtures.js';
import { readState, restartServer } from '../servers.js';
import { PRINCIPALS } from '../support/principals.js';
import {
  allowStaleCsrfAfterUnlock,
  approveDevice,
  expectNoSecrets,
  finishSetup,
  logLines,
  PROOF_KEYS,
  passEnvironment,
  proofStatuses,
  reachFinish,
  setupTokenOfB,
  startDeviceSignIn,
  unlock,
} from '../support/wizard-page.js';

test.use({ principal: 'anonymous', ownClientAddress: false });

const NO_PAGE_SECRETS = (): string[] => {
  const { secrets } = readState();
  return [secrets.setupToken.b, secrets.appKey.b];
};

test.beforeEach(async ({ app, guard }) => {
  allowStaleCsrfAfterUnlock(guard);
  await app.servers.resetEmpty();
});

test('the whole wizard: unlock, environment, device code, configure with the live log, verify, finish, first sign-in', async ({
  page,
  app,
}) => {
  test.slow();
  // Microsoft needs two calls to see what was created: each wait is a line of the log (FR-B-211).
  await fakeOf('b').replicationDelay(2);
  const console_: string[] = [];
  page.on('console', (message) => console_.push(message.text()));

  await app.goto('/setup', { instance: 'b' });
  await reachFinish(page);

  const lines = await logLines(page);
  expect(
    lines.filter((line) =>
      /Waiting for Microsoft to apply the changes \(attempt \d+ of \d+\)/.test(line),
    ).length,
  ).toBeGreaterThan(0);
  expect(
    lines.some((line) =>
      line.includes('The temporary sign-in of the administrator was discarded.'),
    ),
  ).toBe(true);

  // The proof list: every row is green.
  const proof = await proofStatuses(page);
  expect(Object.keys(proof).sort()).toEqual([...PROOF_KEYS].sort());
  expect(proof).toEqual(Object.fromEntries(PROOF_KEYS.map((key) => [key, 'ok'])));

  await finishSetup(page, { skipAppearance: true });
  await expectNoSecrets(page, NO_PAGE_SECRETS());
  expect(console_.join('\n')).not.toContain(setupTokenOfB());

  // "Sign in": the Owner comes back from Microsoft to the dashboard, and the setup is complete.
  await fakeOf('b').nextSignIn('owner');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await app.ready();
  await expect(page.getByRole('button', { name: 'Account menu of Olivia Owner' })).toBeVisible();
});

test('Exchange answers 403 for the whole propagation window: warning exchange_not_ready, everything else usable', async ({
  page,
  app,
}) => {
  test.setTimeout(240_000);
  // More refusals than the window (60 s of retries) can use up.
  await fakeOf('b').exchangePropagation(100_000);
  await app.goto('/setup', { instance: 'b' });
  await unlock(page);
  await passEnvironment(page);
  await startDeviceSignIn(page);
  await approveDevice();
  await expect(page.getByRole('heading', { level: 2, name: 'Finish the setup' })).toBeVisible({
    timeout: 150_000,
  });
  // The notice says what is not ready, and that the setup can be finished now.
  await expect(page.locator('[data-slot="exchange-notice"]')).toBeVisible();
  const proof = await proofStatuses(page);
  expect(proof.check_v5).toBe('warning');
  for (const key of PROOF_KEYS.filter((candidate) => candidate !== 'check_v5')) {
    expect(['ok', 'warning', 'not_checked'], key).toContain(proof[key]);
    expect(proof[key], key).not.toBe('failed');
  }
  expect(proof.check_v1).toBe('ok');
  expect(proof.graph_roles).toBe('ok');
  await expect(page.locator('[data-proof="check_v5"]')).toContainText(
    'Exchange Online does not accept the panel yet.',
  );
  await finishSetup(page, { skipAppearance: true });
  await expectNoSecrets(page, NO_PAGE_SECRETS());
});

test('a tenant without an Exchange service principal ends with the Exchange sub-actions skipped, as a warning', async ({
  page,
  app,
}) => {
  test.slow();
  await fakeOf('b').removeExchangeServicePrincipal();
  await app.goto('/setup', { instance: 'b' });
  await reachFinish(page);
  const lines = await logLines(page);
  expect(
    lines.some((line) =>
      line.includes(
        'Exchange Online was skipped, because this tenant has no Exchange service principal.',
      ),
    ),
  ).toBe(true);
  await expect(page.locator('[data-slot="exchange-notice"]')).toContainText(
    'Exchange Online was skipped',
  );
  const proof = await proofStatuses(page);
  expect(proof.graph_roles).toBe('ok');
  expect(['warning', 'not_checked']).toContain(proof.exchange_roles);
  expect(proof.check_v1).toBe('ok');
  await finishSetup(page, { skipAppearance: true });
});

test('a Conditional Access block names the cause and offers the manual mode', async ({
  page,
  app,
}) => {
  await app.goto('/setup', { instance: 'b' });
  await unlock(page);
  await passEnvironment(page);
  await startDeviceSignIn(page);
  // The policy blocks the code while the panel is polling for it.
  await fakeOf('b').blockDevice();
  const summary = page.locator('[data-slot="error-summary"]');
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).toContainText('Your organisation blocks signing in with a device code.');
  await expect(summary).toContainText('Conditional Access');
  await expect(page.getByRole('button', { name: 'Set up by hand' })).toBeVisible();
  await expect(
    page.getByText('Your organisation seems to block this way of signing in.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Set up by hand' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Set up by hand' })).toBeVisible();
  await expectNoSecrets(page, NO_PAGE_SECRETS());
});

test('an application with the name of the wizard and no install tag asks for the explicit adoption', async ({
  page,
  app,
}) => {
  test.slow();
  const foreign = await fakeOf('b').addForeignApplication('M365Portal');
  await app.goto('/setup', { instance: 'b' });
  await unlock(page);
  await passEnvironment(page);
  await startDeviceSignIn(page);
  await approveDevice();
  const prompt = page.locator('[data-slot="adoption-prompt"]');
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await expect(prompt).toContainText('An application with this name already exists');
  await expect(prompt.getByRole('button', { name: 'Choose another name' })).toBeVisible();
  // Nothing was taken over before the person said so.
  expect((await fakeOf('b').panelApplicationOrNull()) ?? null).toBeNull();
  await prompt.getByRole('button', { name: 'Adopt the application' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Finish the setup' })).toBeVisible({
    timeout: 90_000,
  });
  const adopted = await fakeOf('b').panelApplication();
  expect(adopted.appId).toBe(foreign.appId);
  expect(adopted.tags.some((tag) => tag.startsWith('m365portal-install-'))).toBe(true);
  const inventory = await fakeOf('b').inventory();
  expect(inventory.applications, 'no second application was created').toBe(1);
});

test('a restart of the instance in the middle resumes after unlocking again and repeating the device sign-in', async ({
  page,
  app,
  guard,
}) => {
  test.slow();
  await app.goto('/setup', { instance: 'b' });
  await unlock(page);
  await passEnvironment(page);
  await startDeviceSignIn(page);
  await restartServer('b');
  // The setup session lived in memory: the form asks for the token again.
  await expect(page.getByLabel('Setup token')).toBeVisible({ timeout: 30_000 });
  // While the server was down the poll was refused, and after it came back it was answered with 401:
  // that is what the person's page shows as the token form, and the only thing the guard may see.
  guard.take('status');
  guard.take('console');
  await fakeOf('b').expireDevice();
  await page.getByLabel('Setup token').fill(setupTokenOfB());
  await page.getByRole('button', { name: 'Unlock' }).click();
  // The environment passed before; the sign-in step is the one that was interrupted.
  await expect(
    page.getByRole('heading', { level: 2, name: /Check the environment|Connect to Microsoft/ }),
  ).toBeVisible();
  if (await page.getByRole('button', { name: 'Continue' }).isVisible()) await passEnvironment(page);
  await startDeviceSignIn(page);
  await approveDevice();
  await expect(page.getByRole('heading', { level: 2, name: 'Finish the setup' })).toBeVisible({
    timeout: 60_000,
  });
  expect(Object.values(await proofStatuses(page)).every((status) => status === 'ok')).toBe(true);
});

test('two browser contexts racing to start the sign-in give one 409 setup_step_busy', async ({
  page,
  app,
  browser,
}) => {
  test.slow();
  await app.goto('/setup', { instance: 'b' });
  await unlock(page);
  await passEnvironment(page);

  const other = await contextAs(browser, 'anonymous', { ownClientAddress: false });
  try {
    const second = await other.newPage();
    await second.goto(app.url('/setup', 'b'));
    await unlock(second);
    await passEnvironment(second);

    const statuses: number[] = [];
    for (const target of [page, second]) {
      target.on('response', (response) => {
        if (
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/connection/runs'
        ) {
          statuses.push(response.status());
        }
      });
    }
    // The page that loses gets a 409 as a normal answer; the guard of the test must not call it a fault.
    await Promise.all([
      page.getByRole('button', { name: 'Sign in with Microsoft' }).click(),
      second.getByRole('button', { name: 'Sign in with Microsoft' }).click(),
    ]);
    // A 403 is the stale CSRF token after an unlock, replayed by the client; the runs are 202 and 409.
    await expect.poll(() => statuses.filter((status) => status !== 403).length).toBe(2);
    expect(statuses.filter((status) => status !== 403).sort()).toEqual([202, 409]);
  } finally {
    await other.close();
  }
});

test('the appearance step is optional: finish without touching it', async ({ page, app }) => {
  test.slow();
  await app.goto('/setup', { instance: 'b' });
  await reachFinish(page);
  await expect(page.getByRole('heading', { level: 3, name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
  // Not skipped, not filled: the finish button still works.
  await finishSetup(page);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(PRINCIPALS.owner.displayName).toBe('Olivia Owner');
});
