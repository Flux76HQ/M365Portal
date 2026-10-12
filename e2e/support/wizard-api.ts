// The wizard driven through the real setup API (CB17, T-B-370): unlock, environment, one run of the
// three steps with the device sign-in approved through the fake's control endpoint, finish. Used by
// global-setup to configure instance A, and by specs that need a configured instance B without
// testing the wizard itself.
import { ApiClient } from './api-client.js';
import { fakeControl } from './fake-control.js';
import type { InstanceName } from './ports.js';
import { PRINCIPALS } from './principals.js';

interface RunSnapshot {
  run: { status: string } | null;
  deviceCode: { state: string } | null;
}

const TERMINAL = new Set(['succeeded', 'warning', 'failed', 'cancelled']);

/** Unlocks the setup with the run's token; the returned client carries the setup cookie. */
export async function unlockSetup(instance: InstanceName, token: string): Promise<ApiClient> {
  const api = new ApiClient(instance, {}, null);
  const unlocked = await api.post('/api/v1/setup/unlock', { token });
  if (unlocked.status !== 200) {
    throw new Error(`setup unlock on instance ${instance} answered ${String(unlocked.status)}`);
  }
  return api;
}

/** Runs connect, configure and verify and waits for the end. Returns the final run status. */
export async function runWizard(
  instance: InstanceName,
  api: ApiClient,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const fake = fakeControl(instance);
  const environment = await api.post('/api/v1/setup/environment', {});
  if (environment.status !== 200) {
    throw new Error(`setup environment answered ${String(environment.status)}`);
  }
  const started = await api.post('/api/v1/connection/runs', {
    steps: ['connect', 'configure', 'verify'],
    mode: 'continue',
  });
  if (started.status !== 202 && started.status !== 200 && started.status !== 201) {
    throw new Error(`starting the run answered ${String(started.status)}: ${started.text.slice(0, 200)}`);
  }
  let approved = false;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const snapshot = (await api.get('/api/v1/connection/runs/current')).json<RunSnapshot>();
    if (!approved && snapshot.deviceCode?.state === 'waiting_for_user') {
      await fake.approveDevice('owner');
      approved = true;
    }
    if (snapshot.run !== null && TERMINAL.has(snapshot.run.status)) return snapshot.run.status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the wizard run on instance ${instance} did not end in time`);
}

/** Finishes the setup: the designated Owner becomes Owner at their first sign-in. */
export async function finishWizard(
  api: ApiClient,
  language: 'nl' | 'en' = 'en',
): Promise<void> {
  const state = (await api.get('/api/v1/setup/state')).json<{
    designatedOwner: { oid: string } | null;
  }>();
  const oid = state.designatedOwner?.oid;
  if (oid !== PRINCIPALS.owner.oid) {
    throw new Error('the designated Owner is not the owner principal of the e2e tenant');
  }
  const finished = await api.post('/api/v1/setup/finish', { confirmOwnerOid: oid, language });
  if (finished.status !== 200) {
    throw new Error(`setup finish answered ${String(finished.status)}: ${finished.text.slice(0, 200)}`);
  }
}
