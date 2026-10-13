// `AdminApiExchangeClient`: the Exchange Online Admin API read adapter (T-B-080, FR-B-314; plan
// 8.7). It implements the `ExchangeAdminApiClient` port for the two documented read calls and nothing else:
//
//   getOrganizationConfig  POST https://outlook.office365.com/adminapi/v2.0/<tid>/OrganizationConfig?$select=...
//                          {"CmdletInput":{"CmdletName":"Get-OrganizationConfig"}}
//   listDistributionGroupMembers
//                          POST .../DistributionGroupMember?$select=...
//                          {"CmdletInput":{"CmdletName":"Get-DistributionGroupMember",
//                                          "Parameters":{"Identity":"...","ResultSize":n}}}
//                          follows `@odata.nextLink` by POST with the same body
//   probe                  getOrganizationConfig(['Name','Guid']) with a freshly issued token
//
// Learn: https://learn.microsoft.com/exchange/reference/admin-api-get-started (request model, the
// mandatory X-AnchorMailbox, `$select`), .../admin-api-authentication (role, 401 and 403),
// .../admin-api-endpoints-organization-config and .../admin-api-endpoints-distribution-group-member.
//
// Rules this file keeps (FR-B-314, FR-B-316, FR-B-317):
//   - the app token is an application token for `https://outlook.office365.com/.default`; it is
//     opaque and never decoded;
//   - every request carries `X-AnchorMailbox: APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tid>`;
//   - an endpoint, cmdlet or parameter other than the two above is `ExchangeUnsupportedError` and
//     nothing is sent (`assertSupportedCall`); a property outside the documented list is the same;
//   - `ResultSize` is 1 to 1,000; a `@odata.nextLink` is followed only when it is an `https` URL on
//     `outlook.office365.com` under `/adminapi/v2.0/<tid>/`, and all pages must be read within 5
//     minutes of the first (the link lives 5 to 10): after that `ExchangeUnavailableError` with the
//     reason `paging_window_exceeded`; a link that fails the check is `invalid_next_link` and no
//     request is sent;
//   - `Retry-After` is honoured on 429 and on 401, 5xx are retried with backoff (every call is a
//     read), 400 and 403 are typed errors; the envelope of an answer is read tolerantly (U45);
//   - the Admin API is a Preview that is "not available in all organizations" (U25): `probe` maps
//     what comes back to `ok`, `not_ready` or `unavailable` and never throws for an HTTP answer.
import { LIMITS } from '@m365portal/shared/limits';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import {
  ExchangeBadRequestError,
  ExchangeForbiddenError,
  ExchangeNetworkError,
  ExchangeThrottledError,
  ExchangeTransientError,
  ExchangeUnauthorizedError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  type ExchangeError,
} from '../../ports/errors.js';
import type {
  ExchangeAdminApiClient,
  ExchangeCapabilities,
  ExchangeOrganizationConfig,
  ExchangeProbeResult,
  ExchangeRecipient,
} from '../../ports/exchange.js';
import type { AppTokenProvider } from '../../ports/identity.js';
import { createCallEngine, type CallEngine, type ErrorMeta } from '../http/call-engine.js';
import { mayRepeatAfter5xx } from '../http/retry.js';
import {
  MICROSOFT_ORIGINS,
  UrlRefusedError,
  guidSegment,
  resolveUnder,
} from '../http/url-guard.js';
import {
  DEFAULT_ORGANIZATION_SELECT,
  ORGANIZATION_CONFIG_PROPERTIES,
  RECIPIENT_PROPERTIES,
  readEnvelope,
  toOrganizationConfig,
  toRecipient,
  type OrganizationConfigProperty,
} from './schemas.js';

export const EXCHANGE_ORIGIN = MICROSOFT_ORIGINS.exchange;
/** The routing hint of an application caller; the GUID is the same in every organization (Learn). */
export const SYSTEM_MAILBOX = 'bb558c35-97f1-4cb9-8ff7-d53741dc928c';
/** Admin API answers are JSON of at most this size. */
export const EXCHANGE_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 500;
const RESULT_SIZE_MAX = LIMITS.microsoft.exchangeResultSizeMax;
const PAGING_WINDOW_MS = LIMITS.microsoft.exchangePagingWindowSeconds * 1000;

/** The two endpoints, their cmdlets and the parameters the REST endpoint accepts (Learn). */
const SUPPORTED: Readonly<Record<string, { cmdlet: string; parameters: readonly string[] }>> = {
  OrganizationConfig: { cmdlet: 'Get-OrganizationConfig', parameters: [] },
  DistributionGroupMember: {
    cmdlet: 'Get-DistributionGroupMember',
    parameters: ['Identity', 'ResultSize'],
  },
};

/**
 * Throws `ExchangeUnsupportedError` for any endpoint, cmdlet or parameter outside the two documented
 * read calls. The adapter runs it before it builds a request, so nothing else can ever be sent.
 */
export function assertSupportedCall(
  endpoint: string,
  cmdlet: string,
  parameters: readonly string[] = [],
): void {
  const supported = Object.hasOwn(SUPPORTED, endpoint) ? SUPPORTED[endpoint] : undefined;
  if (supported === undefined)
    throw new ExchangeUnsupportedError({ reason: 'unsupported_endpoint' });
  if (supported.cmdlet !== cmdlet)
    throw new ExchangeUnsupportedError({ reason: 'unsupported_cmdlet' });
  if (parameters.some((name) => !supported.parameters.includes(name))) {
    throw new ExchangeUnsupportedError({ reason: 'unsupported_parameter' });
  }
}

function errorFor(status: number, body: unknown, meta: ErrorMeta): ExchangeError {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  const details = {
    ...(meta.retryAfterMs === null ? {} : { retryAfterMs: meta.retryAfterMs }),
    ...(meta.requestId === null ? {} : { requestId: meta.requestId }),
    ...(meta.clientRequestId === null ? {} : { clientRequestId: meta.clientRequestId }),
    ...(typeof code === 'string' ? { graphCode: code } : {}),
  };
  if (status === 400) return new ExchangeBadRequestError(details);
  if (status === 401) return new ExchangeUnauthorizedError(details);
  if (status === 403) return new ExchangeForbiddenError(details);
  if (status === 429) return new ExchangeThrottledError(details);
  if (status >= 500) return new ExchangeTransientError({ ...details, status });
  // 404 is also what an organization without the Preview may answer (U25).
  return new ExchangeUnavailableError({
    ...details,
    status,
    reason: status === 404 ? 'not_found' : 'rejected',
  });
}

export interface AdminApiExchangeClientDeps {
  /** The tenant id (lower-case GUID): the path and the routing hint carry it. */
  readonly tenantId: string;
  readonly appTokens: AppTokenProvider;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: {
    debug(fields: Readonly<Record<string, unknown>>, message: string): void;
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
}

export class AdminApiExchangeClient implements ExchangeAdminApiClient {
  readonly #engine: CallEngine;
  readonly #clock: Clock;
  readonly #tenant: string;
  readonly #prefix: string;

  constructor(deps: AdminApiExchangeClientDeps) {
    try {
      this.#tenant = guidSegment(deps.tenantId);
    } catch (failure) {
      if (failure instanceof UrlRefusedError)
        throw new TypeError('the tenant id is a GUID', { cause: failure });
      throw failure;
    }
    this.#clock = deps.clock;
    this.#prefix = `/adminapi/v2.0/${this.#tenant}/`;
    this.#engine = createCallEngine({
      origin: EXCHANGE_ORIGIN,
      pathPrefix: this.#prefix,
      maxResponseBytes: EXCHANGE_MAX_RESPONSE_BYTES,
      token: async (options) => (await deps.appTokens.get('exchange', options)).reveal(),
      clock: deps.clock,
      random: deps.random,
      scheduler: deps.scheduler,
      errors: {
        network: (clientRequestId) =>
          new ExchangeNetworkError(clientRequestId === undefined ? undefined : { clientRequestId }),
        refused: () => new ExchangeUnsupportedError({ reason: 'request_refused' }),
        queueFull: () => new ExchangeTransientError({ status: 503 }),
        answer: errorFor,
      },
      aborted: () => new ExchangeNetworkError(),
      // 429, and 401 when it says how long to wait, honour Retry-After; 503 and 504 back off (all
      // calls are reads, sent as POST with `idempotent`).
      retryPolicy: (answer, request) => {
        if (answer.status === 429) return 'retry_after';
        if (answer.status === 401 && answer.retryAfterMs !== null) return 'retry_after';
        if (
          (answer.status === 503 || answer.status === 504) &&
          mayRepeatAfter5xx(request.method, request.idempotent)
        ) {
          return 'backoff';
        }
        return null;
      },
      sendClientRequestId: false,
      logMessage: 'exchange_call',
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  capabilities(): ExchangeCapabilities {
    return { read: ['organizationConfig', 'distributionGroupMembers'], write: [] };
  }

  async probe(o?: { skipCache?: boolean }): Promise<ExchangeProbeResult> {
    try {
      await this.#organizationConfig(['Name', 'Guid'], { freshToken: o?.skipCache !== false });
      return { status: 'ok', httpStatus: 200, roleEffective: 'yes', previewAvailable: 'yes' };
    } catch (failure) {
      if (failure instanceof ExchangeUnauthorizedError) {
        return {
          status: 'not_ready',
          httpStatus: 401,
          roleEffective: 'unknown',
          previewAvailable: 'unknown',
        };
      }
      if (failure instanceof ExchangeForbiddenError) {
        return {
          status: 'not_ready',
          httpStatus: 403,
          roleEffective: 'no',
          previewAvailable: 'unknown',
        };
      }
      // Anything else that came from the Admin API: the Preview may be missing, or it is down.
      // A failure of the token source (secrets, not connected, token endpoint) is not an answer of
      // Exchange and goes up unchanged.
      if (failure instanceof ExchangeUnsupportedError) throw failure;
      if (failure instanceof ExchangeNetworkError) {
        return {
          status: 'unavailable',
          httpStatus: null,
          roleEffective: 'unknown',
          previewAvailable: 'unknown',
        };
      }
      if (
        failure instanceof ExchangeBadRequestError ||
        failure instanceof ExchangeUnavailableError ||
        failure instanceof ExchangeThrottledError ||
        failure instanceof ExchangeTransientError
      ) {
        return {
          status: 'unavailable',
          httpStatus: failure.status ?? null,
          roleEffective: 'unknown',
          previewAvailable: 'unknown',
        };
      }
      throw failure;
    }
  }

  async getOrganizationConfig(select?: readonly string[]): Promise<ExchangeOrganizationConfig> {
    const names = this.#checkedSelect(select);
    return await this.#organizationConfig(names, {});
  }

  async *listDistributionGroupMembers(
    identity: string,
    o?: { resultSize?: number },
  ): AsyncIterable<ExchangeRecipient> {
    const resultSize = o?.resultSize ?? RESULT_SIZE_MAX;
    if (
      !Number.isInteger(resultSize) ||
      resultSize < 1 ||
      resultSize > RESULT_SIZE_MAX ||
      typeof identity !== 'string' ||
      identity.length === 0 ||
      identity.length > 512 ||
      Array.from(identity).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    ) {
      throw new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
    }
    assertSupportedCall('DistributionGroupMember', 'Get-DistributionGroupMember', [
      'Identity',
      'ResultSize',
    ]);
    const body = {
      CmdletInput: {
        CmdletName: 'Get-DistributionGroupMember',
        Parameters: { Identity: identity, ResultSize: resultSize },
      },
    };
    const startedAt = this.#clock.now();
    let href = this.#href('DistributionGroupMember', RECIPIENT_PROPERTIES);
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (page > 1 && this.#clock.now() - startedAt > PAGING_WINDOW_MS) {
        throw new ExchangeUnavailableError({ reason: 'paging_window_exceeded' });
      }
      const { body: answer } = await this.#engine.send({
        method: 'POST',
        route: 'distribution_group_member.list',
        href,
        json: body,
        headers: this.#headers(),
        // A read that uses POST: safe to repeat.
        idempotent: true,
      });
      const parsed = readEnvelope(answer);
      if (parsed === null) throw new ExchangeUnavailableError({ reason: 'unexpected_shape' });
      for (const row of parsed.rows) yield toRecipient(row);
      if (parsed.nextLink === null) return;
      try {
        href = resolveUnder(EXCHANGE_ORIGIN, this.#prefix, parsed.nextLink).href;
      } catch (failure) {
        if (failure instanceof UrlRefusedError)
          throw new ExchangeUnavailableError({ reason: 'invalid_next_link' });
        throw failure;
      }
    }
    throw new ExchangeUnavailableError({ reason: 'too_many_pages' });
  }

  // ---- internals -------------------------------------------------------------------------

  #headers(): Record<string, string> {
    return { 'x-anchormailbox': `APP:SystemMailbox{${SYSTEM_MAILBOX}}@${this.#tenant}` };
  }

  /** `https://outlook.office365.com/adminapi/v2.0/<tid>/<Endpoint>?$select=A,B` (names are plain identifiers). */
  #href(endpoint: string, select: readonly string[]): string {
    const query = select.length === 0 ? '' : `?$select=${select.join(',')}`;
    return `${EXCHANGE_ORIGIN}${this.#prefix}${endpoint}${query}`;
  }

  #checkedSelect(select: readonly string[] | undefined): readonly OrganizationConfigProperty[] {
    if (select === undefined || select.length === 0) return DEFAULT_ORGANIZATION_SELECT;
    const allowed: readonly string[] = ORGANIZATION_CONFIG_PROPERTIES;
    const names = [...new Set(select)];
    if (names.some((name) => !allowed.includes(name))) {
      throw new ExchangeUnsupportedError({ reason: 'unknown_property' });
    }
    return names as OrganizationConfigProperty[];
  }

  async #organizationConfig(
    select: readonly OrganizationConfigProperty[],
    options: { freshToken?: boolean },
  ): Promise<ExchangeOrganizationConfig> {
    assertSupportedCall('OrganizationConfig', 'Get-OrganizationConfig');
    const { body } = await this.#engine.send({
      method: 'POST',
      route: 'organization_config.get',
      href: this.#href('OrganizationConfig', select),
      json: { CmdletInput: { CmdletName: 'Get-OrganizationConfig' } },
      headers: this.#headers(),
      idempotent: true,
      ...(options.freshToken === true ? { freshToken: true } : {}),
    });
    const parsed = readEnvelope(body);
    const row = parsed?.rows[0];
    if (row === undefined) throw new ExchangeUnavailableError({ reason: 'unexpected_shape' });
    return toOrganizationConfig(row, select);
  }
}
