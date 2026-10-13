// T-D-113, T-D-114, FR-D-102, FR-D-103, FR-D-108 (part B of GD1-server): the registry builds the
// `PwshExchangeClient` over `ExchangeWorkerSession` lazily. A process that never calls an Exchange feature
// never starts `pwsh`; the Admin API client stays the verification path; a reload or a stop ends the worker;
// the key hand-over mode of the configuration reaches the launcher; a deployment without a credential source
// answers "not available", not a stack.
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_EXCHANGE_CREDENTIAL,
  createClientsRegistry,
  type ClientsRegistry,
  type ExchangeWorkerSettings,
} from '../../src/integrations/registry.js';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import { systemScheduler } from '../../src/lifecycle/sweepers.js';
import { FakeExchangeState, createStandInLauncher } from '../fakes/fake-tenant/exchange/index.js';
import { CountingCredentials, MemoryScratch } from '../exchange/support.js';
import { fake, testClock } from '../support/msw.js';
import { installFakeExchange } from '../fakes/fake-tenant/exchange/index.js';
import { sequenceRandom } from './support.js';
import { identityWorld } from './identity/support.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

function build(settings: Partial<ExchangeWorkerSettings> | undefined) {
  const world = identityWorld();
  world.app.grantGraphRole('Organization.Read.All');
  world.app.grantGraphRole('User.Read.All');
  world.app.grantExchangeRole('Exchange.ManageAsAppV2');
  world.app.assignEntraRole(EXCHANGE_ROLES.exchange_administrator.templateId);
  installFakeExchange(fake, world.graph.world);
  const state = new FakeExchangeState();
  state.addDistributionGroup({
    name: 'Marketing',
    primarySmtpAddress: 'marketing@contoso-fake.example',
  });
  const scratch = new MemoryScratch();
  const launcher = createStandInLauncher(state, { files: scratch });
  const credentials = new CountingCredentials();
  const registry: ClientsRegistry = createClientsRegistry({
    secrets: { state: () => ({ status: 'ok', holder: world.holder }) },
    pin: () => ({ tenantId: world.tenantId, clientId: world.app.appId }),
    publicBaseUrl: 'https://panel.example',
    bootstrapClientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
    clock: { now: () => Date.now() },
    random: sequenceRandom(),
    scheduler: systemScheduler,
    ...(settings === undefined
      ? {}
      : {
          exchangeWorker: {
            command: 'pwsh',
            scriptPath: '/app/dist/exchange/worker-script.ps1',
            homeDir: '/tmp/m365portal-pwsh',
            parentEnv: {},
            launcher,
            credentials: () => credentials,
            ...settings,
          },
        }),
  });
  return { registry, launcher, credentials, state, scratch };
}

describe('exchangeWorker() (T-D-113)', () => {
  it('starts no process when the registry starts or when the other clients are used', async () => {
    const h = build({});
    h.registry.start();
    await h.registry.graph().getOrganization();
    await h.registry.exchange().probe();
    expect(h.launcher.launches).toBe(0);
    expect(h.credentials.loads).toBe(0);
    // Asking for the client does not start it either: the first call does.
    h.registry.exchangeWorker();
    expect(h.launcher.launches).toBe(0);
    h.registry.stop();
  });

  it('is the Phase D surface over the worker: the first call starts it once, the next ones reuse it', async () => {
    const h = build({});
    const client = h.registry.exchangeWorker();
    expect(client.capabilities().write).toContain('addDistributionGroupMember');
    const first = await client.listDistributionGroups();
    expect(first.items.map((group) => group.displayName)).toEqual(['Marketing']);
    expect(h.launcher.launchOptions.map((options) => options.certificateMode)).toEqual(['memory']);
    await client.listDistributionGroups();
    expect(h.launcher.launches).toBe(1);
    expect(h.credentials.loads).toBe(1);
    expect(h.registry.exchangeWorker()).toBe(client);
    h.registry.stop();
  });

  it('keeps the Admin API client as the read-only verification path', () => {
    const h = build({});
    expect(h.registry.exchange().capabilities().write).toEqual([]);
    expect(h.registry.exchange()).not.toBe(h.registry.exchangeWorker());
    h.registry.stop();
  });

  it('ends the worker on reload() and on stop(), and starts a new one on the next use', async () => {
    const h = build({});
    await h.registry.exchangeWorker().listDistributionGroups();
    expect(h.launcher.processes[0]?.killed).toBe(false);
    h.registry.reload();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([h.launcher.processes[0]?.exited, h.launcher.processes[0]?.stdinClosed]).toContain(true);
    await h.registry.exchangeWorker().listDistributionGroups();
    expect(h.launcher.launches).toBe(2);
    h.registry.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([h.launcher.processes[1]?.exited, h.launcher.processes[1]?.stdinClosed]).toContain(true);
  });

  it('hands the configured key hand-over mode to the launcher (the tmpfs fallback)', async () => {
    const h = build({ handover: { mode: 'tmpfs' } });
    await h.registry
      .exchangeWorker()
      .listDistributionGroups()
      .catch(() => undefined);
    // On a machine whose /dev/shm is a tmpfs the worker starts in the fallback mode; on one where it is not,
    // the session refuses to start and nothing is written. Either way no process ran in memory mode.
    for (const options of h.launcher.launchOptions) expect(options.certificateMode).toBe('tmpfs');
    h.registry.stop();
  });

  it('says "not available" with a reason, without text, when there is no credential source or no worker settings', async () => {
    const none = build({ credentials: () => NO_EXCHANGE_CREDENTIAL });
    const failure = await none.registry
      .exchangeWorker()
      .listDistributionGroups()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    // The session reports a worker that could not start; the credential source said it has nothing.
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_start_failed');
    expect(none.launcher.launches).toBe(0);
    none.registry.stop();

    const unset = build(undefined);
    expect(() => unset.registry.exchangeWorker()).toThrow(ExchangeUnavailableError);
    unset.registry.stop();
  });
});
