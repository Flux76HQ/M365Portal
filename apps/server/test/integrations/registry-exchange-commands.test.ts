// T-D-113, FR-D-102, FR-D-108, ADR 0182: the registry builds the `InvokeExchangeClient` with the other
// clients, on the same application tokens. There is no process to start or to end: the client is plain
// HTTP, built once per set of clients, replaced by a reload, and the Admin API client stays the
// verification path.
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientsRegistry, type ClientsRegistry } from '../../src/integrations/registry.js';
import { systemScheduler } from '../../src/lifecycle/sweepers.js';
import { FakeExchangeState, installFakeExchange } from '../fakes/fake-tenant/exchange/index.js';
import { fake, testClock } from '../support/msw.js';
import { sequenceRandom } from './support.js';
import { identityWorld } from './identity/support.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

function build() {
  const world = identityWorld();
  world.app.grantGraphRole('Organization.Read.All');
  world.app.grantGraphRole('User.Read.All');
  world.app.grantExchangeRole('Exchange.ManageAsAppV2');
  world.app.assignEntraRole(EXCHANGE_ROLES.exchange_administrator.templateId);
  const state = new FakeExchangeState();
  state.addDistributionGroup({
    name: 'Marketing',
    primarySmtpAddress: 'marketing@contoso-fake.example',
  });
  installFakeExchange(fake, world.graph.world, state);
  const registry: ClientsRegistry = createClientsRegistry({
    secrets: { state: () => ({ status: 'ok', holder: world.holder }) },
    pin: () => ({ tenantId: world.tenantId, clientId: world.app.appId }),
    publicBaseUrl: 'https://panel.example',
    bootstrapClientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
    clock: { now: () => Date.now() },
    random: sequenceRandom(),
    scheduler: systemScheduler,
  });
  return { registry, state };
}

describe('exchangeCommands() (T-D-113, ADR 0182)', () => {
  it('is the Phase D surface over InvokeCommand, on the application tokens of the registry', async () => {
    const h = build();
    const client = h.registry.exchangeCommands();
    expect(client.capabilities().write).toContain('addDistributionGroupMember');
    const groups = await client.listDistributionGroups();
    expect(groups.items.map((group) => group.displayName)).toEqual(['Marketing']);
    expect(fake.calls.all().some((call) => call.path.endsWith('/InvokeCommand'))).toBe(true);
    expect(h.registry.exchangeCommands()).toBe(client);
    h.registry.stop();
  });

  it('keeps the Admin API client as the read-only verification path', () => {
    const h = build();
    expect(h.registry.exchange().capabilities().write).toEqual([]);
    expect(h.registry.exchange()).not.toBe(h.registry.exchangeCommands());
    h.registry.stop();
  });

  it('builds a new client after reload(), and still answers', async () => {
    const h = build();
    const first = h.registry.exchangeCommands();
    await first.listDistributionGroups();
    h.registry.reload();
    const second = h.registry.exchangeCommands();
    expect(second).not.toBe(first);
    expect((await second.listDistributionGroups()).items).toHaveLength(1);
    h.registry.stop();
  });
});
