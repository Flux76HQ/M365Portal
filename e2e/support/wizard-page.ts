// The wizard as a person drives it in the browser (T-B-372 to T-B-374): small helpers so that the
// specs read as steps. English labels (the project's locale is en-US); every control is found by its
// role and name, never by position.
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { fakeControl } from './fake-control.js';
import { portOf } from './ports.js';
import { PRINCIPALS, type PrincipalName } from './principals.js';
import type { Guard } from '../fixtures.js';
import { readState } from '../servers.js';

export function bOrigin(): string {
  return `http://localhost:${String(portOf('b'))}`;
}

/** The setup token of instance B in this run (a throwaway value in the run directory only). */
export function setupTokenOfB(): string {
  return readState().secrets.setupToken.b;
}

/**
 * The first write after an unlock answers 403 `csrf_invalid`: the CSRF token the page fetched before the
 * setup cookie existed is bound to no session. The web client fetches a new token and replays the write
 * once (lib/api.ts), so the person sees nothing; the guard would see the 403 and fail the test. Wizard
 * specs call this once and then still catch every other 4xx.
 */
export function allowStaleCsrfAfterUnlock(guard: Guard): void {
  guard.allowResponse({ status: 403, url: /\/api\/v1\/(setup|connection)\// });
}

export function stepPanel(page: Page, step: string): Locator {
  return page.locator(`[data-step-panel="${step}"]`);
}

/** Types the token into the (password) field and unlocks; waits for the wizard's first step. */
export async function unlock(page: Page, token = setupTokenOfB()): Promise<void> {
  await page.getByLabel('Setup token').fill(token);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Check the environment' }),
  ).toBeVisible();
}

/** Waits for the environment checks to finish and continues to the sign-in step. */
export async function passEnvironment(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByRole('heading', { level: 2, name: 'Connect to Microsoft' })).toBeVisible();
}

/** Starts the device sign-in: the code appears. */
export async function startDeviceSignIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  await expect(page.locator('[data-slot="device-code-panel"]')).toBeVisible();
}

/** The person at the Microsoft page signs in and consents: the fake approves the waiting flow. */
export async function approveDevice(principal: PrincipalName = 'owner'): Promise<void> {
  await fakeControl('b').approveWhenPending(principal);
}

/** Runs the wizard in the browser as far as the finish step. */
export async function reachFinish(page: Page): Promise<void> {
  await unlock(page);
  await passEnvironment(page);
  await startDeviceSignIn(page);
  await approveDevice();
  await expect(page.getByRole('heading', { level: 2, name: 'Finish the setup' })).toBeVisible({
    timeout: 60_000,
  });
}

/** The visible text of the activity log, line by line. */
export async function logLines(page: Page): Promise<string[]> {
  return page.locator('[role="log"] li').allInnerTexts();
}

/**
 * Nothing secret is in the page: no setup token, no key, no token of Microsoft's, in the DOM, in
 * `localStorage`, `sessionStorage` or the cookies a script can read (SC-B-013, FR-B-715).
 */
export async function expectNoSecrets(page: Page, secrets: readonly string[]): Promise<void> {
  const seen = await page.evaluate(() => {
    const storage = (area: Storage): string => {
      try {
        return JSON.stringify(Object.fromEntries(Object.entries(area)));
      } catch {
        return '';
      }
    };
    return {
      html: document.documentElement.outerHTML,
      local: storage(window.localStorage),
      session: storage(window.sessionStorage),
      cookie: document.cookie,
    };
  });
  const everything = [seen.html, seen.local, seen.session, seen.cookie].join('\n');
  for (const secret of secrets) {
    expect(everything.includes(secret), 'a secret is in the page').toBe(false);
  }
  expect(everything, 'a JWT-shaped token is in the page').not.toMatch(
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  );
  // The marker of a PEM block, built from parts so that no file of the repository holds one.
  expect(everything, 'a PEM block is in the page').not.toMatch(
    new RegExp(`${'-'.repeat(5)}BEGIN [A-Z ]+${'-'.repeat(5)}`),
  );
}

/** The proof list on the page, as `key -> status` (`ok`, `warning`, `failed`, `not_checked`). */
export async function proofStatuses(page: Page): Promise<Record<string, string>> {
  const rows = page.locator('[data-slot="proof-list"] [data-proof]');
  await expect(rows.first()).toBeVisible();
  const entries = await rows.evaluateAll((elements) =>
    elements.map((element) => [
      element.getAttribute('data-proof') ?? '',
      element.getAttribute('data-status') ?? '',
    ]),
  );
  return Object.fromEntries(entries as [string, string][]);
}

export const PROOF_KEYS = [
  'application',
  'service_principal',
  'certificate',
  'graph_roles',
  'exchange_roles',
  'entra_role',
  'check_v1',
  'check_v2',
  'check_v3',
  'check_v4',
  'check_v5',
  'check_v6',
] as const;

/** Ticks "I confirm that this person should become the Owner" and presses Finish. */
export async function finishSetup(
  page: Page,
  options: { skipAppearance?: boolean } = {},
): Promise<void> {
  if (options.skipAppearance === true) {
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }
  await page.getByLabel('I confirm that this person should become the Owner.').check();
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(page.getByText('The setup is ready')).toBeVisible();
}

/**
 * No catalogue key shows through as text: a namespace that was not loaded makes the page print the key
 * (`connection.proof.check_v5`) instead of the words. Every namespace of the panel is named here.
 */
export async function expectNoRawKeys(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  const raw = text.match(
    /\b(setup|connection|session|signin|noaccess|access|breakglass|appearance|role|permission|scope|origin|qualifier|resource|nav|pages|common|errors|problem|a11y|shell|palette|dashboard)\.[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+/g,
  );
  expect(raw ?? [], 'a catalogue key is shown instead of its text').toEqual([]);
}

/** The checklist as the page shows it: label to values. */
export async function readChecklist(page: Page): Promise<Map<string, string[]>> {
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

export const EXCHANGE_ADMINISTRATOR_TEMPLATE = '29232cdf-9323-42fd-ade2-1d097af3e4de';

/**
 * Does by hand what the checklist says, in the fake tenant of instance B, and hands the three values over.
 * The certificate is downloaded as a person would. Returns when "Check" has been pressed.
 */
export async function handOverManualApplication(page: Page): Promise<void> {
  const checklist = await readChecklist(page);
  const values = (label: string): string[] => checklist.get(label) ?? [];
  const download = await page.request.get(`${bOrigin()}/api/v1/setup/certificate.cer`);
  expect(download.status()).toBe(200);
  const made = await fakeControl('b').seedManualApplication({
    displayName: values('Application name')[0] ?? '',
    description: values('Application description (exactly this text)')[0] ?? '',
    tags: values('Tags (both, exactly as written)'),
    redirectUris: values('Redirect addresses (web)'),
    optionalClaimNames: values('Optional claims in the ID token'),
    graphRoles: values('Application permissions of Microsoft Graph'),
    exchangeRoles: [
      ...values('Application permissions of Exchange Online'),
      'Exchange.ManageAsAppV2',
    ],
    entraRoleTemplateId: EXCHANGE_ADMINISTRATOR_TEMPLATE,
    certificateBase64: Buffer.from(await download.body()).toString('base64'),
  });
  await page.getByLabel('Application (client) ID').fill(made.appId);
  await page.getByLabel('Tenant ID').fill(made.tenantId);
  await page.getByLabel('First Owner (user ID or user principal name)').fill(PRINCIPALS.owner.oid);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
}
