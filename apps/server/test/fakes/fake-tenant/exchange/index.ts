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
export type {
  FakeDistributionGroup,
  FakeOrganizationConfig,
  FakeReadView,
  FakeRecipient,
} from './state.js';
// Phase D (T-D-115): the write rules, the cmdlet interpreter and the worker stand-in.
export {
  MEMBER_TYPES,
  addMember,
  createContact,
  groupMatches,
  recipientMatches,
  removeContact,
  removeMember,
  updateContact,
} from './writes.js';
export type { Outcome, Refusal } from './writes.js';
export { groupRow, parseOpath, recipientRow, runCmdlet } from './cmdlets.js';
export type { CmdletOutcome } from './cmdlets.js';
export { createStandInLauncher } from './worker-standin.js';
export type {
  StandInAction,
  StandInCall,
  StandInConnect,
  StandInFiles,
  StandInLauncher,
  StandInProcess,
} from './worker-standin.js';

export function installFakeExchange(
  tenant: FakeTenant,
  world: FakeWorld,
  state?: FakeExchangeState,
): FakeExchange {
  const exchange = exchangeModule(world, state ?? new FakeExchangeState());
  tenant.mount(exchange.module);
  return exchange;
}
