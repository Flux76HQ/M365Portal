// The fake Exchange Admin API (T-B-066). In a test:
//
//   const graph = installFakeGraph(fake);                    // the world: directory and tokens
//   const exchange = installFakeExchange(fake, graph.world); // the Admin API over the same world
//   exchange.state.addDistributionGroup({ name: 'Marketing', primarySmtpAddress: 'marketing@...' });
import type { FakeTenant } from '../types.js';
import type { FakeWorld } from '../graph/tokens.js';
import { exchangeModule, type FakeExchange } from './module.js';
import { FakeExchangeState } from './state.js';

export { exchangeModule } from './module.js';
export type { Envelope, ExchangeFaultSpec, FakeExchange, FakeExchangeControl } from './module.js';
export {
  FakeExchangeState,
  ORGANIZATION_CONFIG_DOCUMENTED,
  RECIPIENT_DOCUMENTED,
  renderOrganizationConfig,
  renderRecipient,
} from './state.js';
export type { FakeDistributionGroup, FakeOrganizationConfig, FakeRecipient } from './state.js';

export function installFakeExchange(
  tenant: FakeTenant,
  world: FakeWorld,
  state?: FakeExchangeState,
): FakeExchange {
  const exchange = exchangeModule(world, state ?? new FakeExchangeState());
  tenant.mount(exchange.module);
  return exchange;
}
