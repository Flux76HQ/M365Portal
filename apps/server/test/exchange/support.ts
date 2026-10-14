// Test support for the Exchange client tests (T-D-113). Not a test file: Vitest runs `*.test.ts` only.
// Everything is deterministic: a fake clock and scheduler, a seeded random source, and the fake tenant
// (MSW) that serves the `InvokeCommand` endpoint over the fake Exchange state (ADR 0182).
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { InvokeExchangeClient } from '../../src/integrations/exchange/invoke-client.js';
import {
  FakeExchangeState,
  installFakeExchange,
  type FakeExchange,
} from '../fakes/fake-tenant/exchange/index.js';
import { fakeGuid, installFakeGraph } from '../fakes/fake-tenant/graph/index.js';
import {
  createTime,
  sequenceRandom,
  settle,
  staticAppTokens,
  track,
  type Time,
} from '../integrations/support.js';
import { fake } from '../support/msw.js';

const APP = fakeGuid('exchange-invoke-app', 1);

export interface LogEntry {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export interface CapturedLog {
  readonly entries: LogEntry[];
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export function captureLog(): CapturedLog {
  const entries: LogEntry[] = [];
  return {
    entries,
    debug(fields, message) {
      entries.push({ level: 'debug', fields: { ...fields }, message });
    },
    warn(fields, message) {
      entries.push({ level: 'warn', fields: { ...fields }, message });
    },
  };
}

export interface HarnessOptions {
  readonly state?: FakeExchangeState;
  /** The floats the random source plays (jitter). Default `[0]`. */
  readonly random?: readonly number[];
  /** The application roles of the token. Default: both Exchange roles. */
  readonly roles?: readonly string[];
  /** The Entra role templates of the service principal. Default: Exchange Administrator. */
  readonly entraRoleTemplateIds?: readonly string[];
}

export interface ClientHarness {
  readonly state: FakeExchangeState;
  readonly client: InvokeExchangeClient;
  readonly exchange: FakeExchange;
  readonly log: CapturedLog;
  readonly time: Time;
  /** The tenant id of the fake world (the path of every request carries it). */
  readonly tenantId: string;
  /** Requests that reached the fake tenant so far. */
  calls(): number;
  /** Lets pending promise chains run; no clock moves. */
  settle(): Promise<void>;
  /** Waits for a promise, letting fake time pass in small steps while it is not done. */
  drive<T>(promise: Promise<T>): Promise<T>;
}

export function clientHarness(options: HarnessOptions = {}): ClientHarness {
  fake.reset();
  const graph = installFakeGraph(fake);
  const state = options.state ?? new FakeExchangeState();
  const exchange = installFakeExchange(fake, graph.world, state);
  const token = graph.world.tokens.issue({
    audience: 'exchange',
    kind: 'app',
    appId: APP,
    roles: options.roles ?? ['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2'],
    entraRoleTemplateIds: options.entraRoleTemplateIds ?? [
      EXCHANGE_ROLES.exchange_administrator.templateId,
    ],
  });
  const time = createTime();
  const log = captureLog();
  const client = new InvokeExchangeClient({
    tenantId: graph.directory.tenantId,
    appTokens: staticAppTokens(token.value).provider,
    clock: time.clock,
    random: sequenceRandom(options.random ?? [0]),
    scheduler: time.scheduler,
    log,
  });
  return {
    state,
    client,
    exchange,
    log,
    time,
    tenantId: graph.directory.tenantId,
    calls: () => fake.calls.length,
    settle: () => settle(),
    async drive(promise) {
      const tracked = track(promise);
      for (let round = 0; round < 400 && !tracked.settled(); round += 1) {
        await settle();
        if (tracked.settled()) break;
        time.elapse(250);
      }
      return tracked.promise;
    },
  };
}
