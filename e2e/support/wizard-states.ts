// The states of the wizard, reached on purpose (T-B-378, T-B-379). Instance B starts empty for each one
// (`resetEmpty`), the fake tenant is toggled so that a step ends the way the state asks, and the page is
// left standing in it. `WIZARD_STATES` in `routes.ts` lists them; the `status` words are those of a step
// (`running`, `waiting`, `succeeded`, `warning`, `failed`, `skipped`), plus the token form, its lock, the
// environment check, manual mode and the finish step.
import { expect, type Page } from '@playwright/test';
import { ApiClient } from './api-client.js';
import { fakeControl } from './fake-control.js';
import type { WizardState } from '../routes.js';
import { resetEmptyInstance, takeSetupBudget } from '../servers.js';
import { portOf } from './ports.js';
import {
  approveDevice,
  handOverManualApplication,
  passEnvironment,
  reachFinish,
  setupTokenOfB,
  startDeviceSignIn,
  unlock,
} from './wizard-page.js';

/** Waits until a step or sub-action on the page shows this status. */
async function showsStatus(page: Page, status: string): Promise<void> {
  await expect(page.locator(`[data-status="${status}"]`).first()).toBeVisible({ timeout: 90_000 });
}

/**
 * Opens `/setup` on instance B in the given state. The caller has not touched B before (this empties it).
 * Returns when the state is on screen and still.
 */
export async function reachWizardState(page: Page, state: WizardState): Promise<void> {
  await resetEmptyInstance();
  const fake = fakeControl('b');
  const origin = `http://localhost:${String(portOf('b'))}`;
  const open = async (): Promise<void> => {
    await takeSetupBudget();
    await page.goto(`${origin}/setup`, { waitUntil: 'load' });
  };

  switch (state) {
    case 'token':
      await open();
      await expect(page.getByLabel('Setup token')).toBeVisible();
      return;
    case 'token-locked': {
      await open();
      const api = new ApiClient('b', {}, null);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await api.post('/api/v1/setup/unlock', { token: `wrong-token-${String(attempt)}` });
      }
      await page.getByLabel('Setup token').fill(setupTokenOfB());
      await page.getByRole('button', { name: 'Unlock' }).click();
      await expect(page.locator('[data-slot="token-locked"]')).toBeVisible();
      return;
    }
    case 'environment':
      await open();
      await unlock(page);
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
      return;
    case 'running':
      await open();
      await unlock(page);
      await passEnvironment(page);
      await startDeviceSignIn(page);
      await showsStatus(page, 'running');
      return;
    case 'waiting':
      // New objects are "not found" for many calls: the configure step waits, with a countdown.
      await fake.replicationDelay(500);
      await open();
      await unlock(page);
      await passEnvironment(page);
      await startDeviceSignIn(page);
      await approveDevice();
      await showsStatus(page, 'waiting');
      await expect(page.getByText(/Next attempt in \d+ s/).first()).toBeVisible();
      return;
    case 'succeeded':
      await open();
      await reachFinish(page);
      await showsStatus(page, 'succeeded');
      return;
    case 'warning':
      // No Exchange service principal: the Exchange parts are skipped and the run ends with a warning.
      await fake.removeExchangeServicePrincipal();
      await open();
      await reachFinish(page);
      await showsStatus(page, 'warning');
      return;
    case 'failed':
      await open();
      await unlock(page);
      await passEnvironment(page);
      await startDeviceSignIn(page);
      await fake.blockDevice();
      await showsStatus(page, 'failed');
      await expect(page.locator('[data-slot="error-summary"]')).toBeVisible();
      return;
    case 'skipped':
      // Set up by hand: the part that needs a sign-in at Microsoft ("Read the configuration back") is
      // skipped and the list stands still, because the organisation check then fails (Graph answers 503).
      await fake.failGraph(1000, 503, 'GET /v1\\.0/organization');
      await open();
      await unlock(page);
      await passEnvironment(page);
      await page.getByRole('button', { name: 'Set up by hand' }).click();
      await handOverManualApplication(page);
      await showsStatus(page, 'skipped');
      return;
    case 'manual':
      await open();
      await unlock(page);
      await passEnvironment(page);
      await page.getByRole('button', { name: 'Set up by hand' }).click();
      await expect(page.getByRole('heading', { level: 3, name: 'Set up by hand' })).toBeVisible();
      return;
    case 'finish':
      await open();
      await reachFinish(page);
      return;
  }
}
