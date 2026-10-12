// `FakeExchangeClient`: the in-memory `ExchangeClient` that service tests use (T-B-080, plan 8.7; a
// service test uses this and never MSW). It answers from a `FakeExchangeState`, the data the fake
// Admin API serves over HTTP, so one contract suite (test/exchange/exchange-client-contract.test.ts)
// runs against this class and against `AdminApiExchangeClient` on MSW and must see the same answers.
//
// It follows the adapter where a service can notice: `capabilities()` is the read-only pair, a
// property outside the documented list or a `ResultSize` outside 1 to 1,000 is
// `ExchangeUnsupportedError`, a group that does not exist is `ExchangeUnavailableError` (status 404),
// pages are `resultSize` long and must be read within 5 minutes of the first, `null` stands for a
// property the data lacks. `probe()` answers `ok` unless a test scripts another outcome with
// `scriptProbe`, and `failNext` makes the next calls throw a typed error (for the failure paths of a
// service). Every call is recorded in `calls`.
import { LIMITS } from '@m365portal/shared/limits';
import {
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  type ExchangeError,
} from '../../src/ports/errors.js';
import type {
  ExchangeClient,
  ExchangeOrganizationConfig,
  ExchangeProbeResult,
  ExchangeRecipient,
  ExchangeScalar,
} from '../../src/ports/exchange.js';
import type { Clock } from '../../src/ports/clock.js';
import {
  DEFAULT_ORGANIZATION_SELECT,
  ORGANIZATION_CONFIG_PROPERTIES,
  RECIPIENT_PROPERTIES,
  scalar,
  type OrganizationConfigProperty,
} from '../../src/integrations/exchange/schemas.js';
import {
  renderOrganizationConfig,
  renderRecipient,
  type FakeExchangeState,
} from './fake-tenant/exchange/index.js';

const RESULT_SIZE_MAX = LIMITS.microsoft.exchangeResultSizeMax;
const PAGING_WINDOW_MS = LIMITS.microsoft.exchangePagingWindowSeconds * 1000;

export type FakeExchangeMethod =
  'capabilities' | 'probe' | 'getOrganizationConfig' | 'listDistributionGroupMembers';

export interface RecordedExchangeCall {
  readonly method: FakeExchangeMethod;
  readonly args: readonly unknown[];
}

export class FakeExchangeClient implements ExchangeClient {
  readonly calls: RecordedExchangeCall[] = [];
  readonly #state: FakeExchangeState;
  readonly #clock: Clock;
  #probe: ExchangeProbeResult = {
    status: 'ok',
    httpStatus: 200,
    roleEffective: 'yes',
    previewAvailable: 'yes',
  };
  readonly #failures: {
    method: FakeExchangeMethod | undefined;
    error: ExchangeError;
    left: number;
  }[] = [];

  constructor(state: FakeExchangeState, options: { clock: Clock }) {
    this.#state = state;
    this.#clock = options.clock;
  }

  /** What the next `probe()` calls return (until scripted again). */
  scriptProbe(result: ExchangeProbeResult): void {
    this.#probe = result;
  }

  /** The next `times` calls (of one method, or any) throw `error`. */
  failNext(
    error: ExchangeError,
    options: { method?: FakeExchangeMethod; times?: number } = {},
  ): void {
    this.#failures.push({ method: options.method, error, left: options.times ?? 1 });
  }

  #enter(method: FakeExchangeMethod, args: readonly unknown[]): void {
    this.calls.push({ method, args });
    for (const failure of this.#failures) {
      if (failure.left > 0 && (failure.method === undefined || failure.method === method)) {
        failure.left -= 1;
        throw failure.error;
      }
    }
  }

  capabilities(): {
    read: readonly ('organizationConfig' | 'distributionGroupMembers')[];
    write: readonly [];
  } {
    this.calls.push({ method: 'capabilities', args: [] });
    return { read: ['organizationConfig', 'distributionGroupMembers'], write: [] };
  }

  probe(o?: { skipCache?: boolean }): Promise<ExchangeProbeResult> {
    try {
      this.#enter('probe', [o]);
      return Promise.resolve({ ...this.#probe });
    } catch (failure) {
      return Promise.reject(failure instanceof Error ? failure : new Error('unexpected'));
    }
  }

  getOrganizationConfig(select?: readonly string[]): Promise<ExchangeOrganizationConfig> {
    try {
      this.#enter('getOrganizationConfig', [select]);
      const names: readonly string[] =
        select === undefined || select.length === 0
          ? DEFAULT_ORGANIZATION_SELECT
          : [...new Set(select)];
      const allowed: readonly string[] = ORGANIZATION_CONFIG_PROPERTIES;
      if (names.some((name) => !allowed.includes(name))) {
        throw new ExchangeUnsupportedError({ reason: 'unknown_property' });
      }
      const row = renderOrganizationConfig(this.#state.organizationConfig);
      const out: Record<string, ExchangeScalar | null> = {};
      for (const name of names as OrganizationConfigProperty[]) {
        if (name !== 'Name' && name !== 'Guid') out[name] = scalar(row[name]);
      }
      const name = names.includes('Name') ? scalar(row.Name) : null;
      const guid = names.includes('Guid') ? scalar(row.Guid) : null;
      return Promise.resolve({
        ...out,
        name: typeof name === 'string' ? name : null,
        guid: typeof guid === 'string' ? guid : null,
      });
    } catch (failure) {
      return Promise.reject(failure instanceof Error ? failure : new Error('unexpected'));
    }
  }

  async *listDistributionGroupMembers(
    identity: string,
    o?: { resultSize?: number },
  ): AsyncIterable<ExchangeRecipient> {
    // Like the adapter, nothing happens (and nothing is validated) until the first read.
    await Promise.resolve();
    this.#enter('listDistributionGroupMembers', [identity, o]);
    const resultSize = o?.resultSize ?? RESULT_SIZE_MAX;
    if (
      !Number.isInteger(resultSize) ||
      resultSize < 1 ||
      resultSize > RESULT_SIZE_MAX ||
      identity.length === 0 ||
      identity.length > 512 ||
      Array.from(identity).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    ) {
      throw new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
    }
    const group = this.#state.findGroup(identity);
    if (group === undefined)
      throw new ExchangeUnavailableError({ status: 404, reason: 'not_found' });
    const startedAt = this.#clock.now();
    for (let offset = 0; offset < group.members.length; offset += resultSize) {
      if (offset > 0 && this.#clock.now() - startedAt > PAGING_WINDOW_MS) {
        throw new ExchangeUnavailableError({ reason: 'paging_window_exceeded' });
      }
      for (const member of group.members.slice(offset, offset + resultSize)) {
        const row = renderRecipient(member);
        const out: Record<string, ExchangeScalar | null> = {};
        for (const name of RECIPIENT_PROPERTIES) {
          if (name !== 'Name' && name !== 'Guid') out[name] = scalar(row[name]);
        }
        const name = scalar(row.Name);
        const guid = scalar(row.Guid);
        yield {
          ...out,
          name: typeof name === 'string' ? name : null,
          guid: typeof guid === 'string' ? guid : null,
        };
      }
    }
  }
}
