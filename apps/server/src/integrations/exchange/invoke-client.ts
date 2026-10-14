// `InvokeExchangeClient`: the Phase D implementation of the `ExchangeClient` port over the Exchange Online
// `InvokeCommand` REST endpoint (ADR 0182, which replaces the `pwsh` worker of ADR 0180/0181).
//
//   POST https://outlook.office365.com/adminapi/beta/<tid>/InvokeCommand
//   {"CmdletInput":{"CmdletName":"Get-MailContact","Parameters":{"Identity":"..."}}}
//
// It is the call the `ExchangeOnlineManagement` module makes under the hood, so the same ten cmdlets of the
// closed allow-list run without PowerShell, without Linux packages and without a worker process. It is NOT a
// documented endpoint (U101, docs/open-points.md): that is the deliberate, recorded exception of ADR 0182.
// Everything that keeps the exception small stays in force:
//
//   - the cmdlet and its parameters pass the allow-list (arguments.ts `checkedCall`) before a byte is sent;
//   - the token is the application token for `https://outlook.office365.com/.default` that the certificate
//     already gets for the Admin API probe (`appTokens.get('exchange')`); nothing new is stored;
//   - the URL is fixed to the origin and `/adminapi/beta/<tid>/`; a `@odata.nextLink` is followed only under it;
//   - what comes back is read defensively (rows.ts); an error is reduced to a closed code (error-class.ts) and
//     the text of Exchange never reaches a log or a response (FR-D-107).
//
// Retries: 429 honours `Retry-After`; 503/504 back off, for reads and idempotent writes only. `New-MailContact`
// is never repeated (EC-D1): the contact may exist already.
import { LIMITS } from '@m365portal/shared/limits';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import {
  ExchangeCommandError,
  ExchangeNetworkError,
  ExchangeThrottledError,
  ExchangeTransientError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  type ExchangeError,
} from '../../ports/errors.js';
import type {
  ExchangeCapabilities,
  ExchangeClient,
  ExchangeContactChanges,
  ExchangeContactCreate,
  ExchangeContactListQuery,
  ExchangeDistributionGroup,
  ExchangeGroupListQuery,
  ExchangeListResult,
  ExchangeMailContact,
  ExchangeMemberWriteOptions,
  ExchangeOrganizationConfig,
  ExchangeProbeResult,
  ExchangeRecipient,
} from '../../ports/exchange.js';
import type { AppTokenProvider } from '../../ports/identity.js';
import { createCallEngine, type CallEngine, type ErrorMeta } from '../http/call-engine.js';
import {
  MICROSOFT_ORIGINS,
  UrlRefusedError,
  guidSegment,
  resolveUnder,
} from '../http/url-guard.js';
import {
  contactCreateCall,
  contactGetCall,
  contactListCall,
  contactRemoveCall,
  contactUpdateCall,
  dynamicGroupGetCall,
  groupGetCall,
  groupListCalls,
  groupMembersCall,
  limitOf,
  memberWriteCall,
  membershipsCall,
  organizationConfigCall,
  type CmdletCall,
} from './arguments.js';
import { classifyCommandError, errorTextOf } from './error-class.js';
import {
  toDistributionGroup,
  toMailContact,
  toMember,
  toOrganizationConfig,
  type Row,
} from './rows.js';
import {
  DEFAULT_ORGANIZATION_SELECT,
  ORGANIZATION_CONFIG_PROPERTIES,
  readEnvelope,
  type OrganizationConfigProperty,
} from './schemas.js';

export const INVOKE_ORIGIN = MICROSOFT_ORIGINS.exchange;
/** The routing hint of an application caller; the GUID is the same in every organization (Learn). */
const SYSTEM_MAILBOX = 'bb558c35-97f1-4cb9-8ff7-d53741dc928c';
/** Answers are JSON of at most this size: a full list read (`listBufferMax` + 1 rows, about 700 bytes each) fits. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 50;

/** How a call may be repeated after a 5xx answer. */
type Repeat = 'read' | 'idempotent' | 'never';

interface Data {
  readonly rows: readonly Row[];
  /** More rows exist than were read (the page limit was reached). */
  readonly cut: boolean;
}

const RESULT_SIZE_MAX = LIMITS.microsoft.exchangeResultSizeMax;

export interface InvokeExchangeClientDeps {
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

/** The typed error for a non-2xx answer: a closed code, never the text of Exchange. */
function errorFor(status: number, body: unknown, meta: ErrorMeta): ExchangeError {
  const details = {
    ...(meta.retryAfterMs === null ? {} : { retryAfterMs: meta.retryAfterMs }),
    ...(meta.requestId === null ? {} : { requestId: meta.requestId }),
    ...(meta.clientRequestId === null ? {} : { clientRequestId: meta.clientRequestId }),
  };
  if (status === 429) return new ExchangeThrottledError(details);
  const code = classifyCommandError(status, errorTextOf(body));
  if (code === 'throttled') return new ExchangeThrottledError(details);
  if (code === 'role_pending') {
    return new ExchangeUnavailableError({ ...details, status, reason: 'role_pending' });
  }
  if (code === 'invalid_argument')
    return new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
  if (status >= 500) return new ExchangeTransientError({ ...details, status });
  if (code === 'internal')
    return new ExchangeUnavailableError({ ...details, status, reason: 'internal' });
  return new ExchangeCommandError(
    code,
    meta.retryAfterMs === null ? undefined : { retryAfterMs: meta.retryAfterMs },
  );
}

function byDisplayName<T extends { displayName: string | null; guid: string }>(a: T, b: T): number {
  const left = (a.displayName ?? '￿').toLowerCase();
  const right = (b.displayName ?? '￿').toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
}

function matchesGroup(group: ExchangeDistributionGroup, identity: string): boolean {
  const wanted = identity.toLowerCase();
  return [
    group.guid,
    group.externalDirectoryObjectId,
    group.distinguishedName,
    group.primarySmtpAddress,
    group.name,
    group.alias,
    group.displayName,
  ].some((value) => value !== null && value.toLowerCase() === wanted);
}

/** The one word a log line says about a failure; `null` for a failure that is not an answer of Exchange. */
function resultOf(failure: unknown): string | null {
  if (failure instanceof ExchangeCommandError) return failure.commandCode;
  if (failure instanceof ExchangeUnavailableError) return failure.reason;
  return null;
}

export class InvokeExchangeClient implements ExchangeClient {
  readonly #engine: CallEngine;
  readonly #tenant: string;
  readonly #prefix: string;
  readonly #log: InvokeExchangeClientDeps['log'];

  constructor(deps: InvokeExchangeClientDeps) {
    try {
      this.#tenant = guidSegment(deps.tenantId);
    } catch (failure) {
      if (failure instanceof UrlRefusedError)
        throw new TypeError('the tenant id is a GUID', { cause: failure });
      throw failure;
    }
    this.#log = deps.log;
    this.#prefix = `/adminapi/beta/${this.#tenant}/`;
    this.#engine = createCallEngine({
      origin: INVOKE_ORIGIN,
      pathPrefix: this.#prefix,
      maxResponseBytes: MAX_RESPONSE_BYTES,
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
      // Only a call that certainly did not run is repeated here (429, a 401 that says when to come back).
      // A 5xx or a lost connection may have run: `#run` decides.
      retryPolicy: (answer) => {
        if (answer.status === 429) return 'retry_after';
        if (answer.status === 401 && answer.retryAfterMs !== null) return 'retry_after';
        return null;
      },
      sendClientRequestId: false,
      logMessage: 'exchange_call',
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  capabilities(): ExchangeCapabilities {
    return {
      read: [
        'organizationConfig',
        'distributionGroupMembers',
        'distributionGroups',
        'mailContacts',
        'recipientMemberships',
      ],
      write: [
        'addDistributionGroupMember',
        'removeDistributionGroupMember',
        'createMailContact',
        'updateMailContact',
        'removeMailContact',
      ],
    };
  }

  // ---- the Admin API surface ---------------------------------------------------------------

  async probe(): Promise<ExchangeProbeResult> {
    const result = (
      status: ExchangeProbeResult['status'],
      role: ExchangeProbeResult['roleEffective'],
    ): ExchangeProbeResult => ({
      status,
      httpStatus: null,
      roleEffective: role,
      previewAvailable: 'unknown',
    });
    try {
      await this.#run(organizationConfigCall(), 'read');
      return result('ok', 'yes');
    } catch (failure) {
      if (failure instanceof ExchangeUnavailableError && failure.reason === 'role_pending') {
        return result('not_ready', 'no');
      }
      if (failure instanceof ExchangeCommandError && failure.commandCode === 'permission_denied') {
        return result('not_ready', 'no');
      }
      if (
        failure instanceof ExchangeUnavailableError ||
        failure instanceof ExchangeThrottledError
      ) {
        return result('unavailable', 'unknown');
      }
      throw failure;
    }
  }

  async getOrganizationConfig(select?: readonly string[]): Promise<ExchangeOrganizationConfig> {
    const names: readonly string[] =
      select === undefined || select.length === 0
        ? DEFAULT_ORGANIZATION_SELECT
        : [...new Set(select)];
    const allowed: readonly string[] = ORGANIZATION_CONFIG_PROPERTIES;
    if (names.some((name) => !allowed.includes(name))) {
      throw new ExchangeUnsupportedError({ reason: 'unknown_property' });
    }
    const data = await this.#run(organizationConfigCall(), 'read');
    const row = data.rows[0];
    if (row === undefined) throw new ExchangeUnavailableError({ reason: 'unexpected_answer' });
    return toOrganizationConfig(row, names as OrganizationConfigProperty[]);
  }

  async *listDistributionGroupMembers(
    identity: string,
    o?: { resultSize?: number },
  ): AsyncIterable<ExchangeRecipient> {
    // Like the Admin API adapter, nothing happens (and nothing is validated) until the first read.
    await Promise.resolve();
    const resultSize = o?.resultSize ?? RESULT_SIZE_MAX;
    if (!Number.isInteger(resultSize) || resultSize < 1 || resultSize > RESULT_SIZE_MAX) {
      throw new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
    }
    const call = groupMembersCall(identity);
    let data: Data;
    try {
      data = await this.#run(call, 'read');
    } catch (failure) {
      if (failure instanceof ExchangeCommandError && failure.commandCode === 'not_found') {
        throw new ExchangeUnavailableError({ status: 404, reason: 'not_found' });
      }
      throw failure;
    }
    // The script cut the rows to fit one protocol line: a short member list is never handed out as the list.
    if (data.cut) throw new ExchangeUnavailableError({ reason: 'too_many_rows' });
    for (const row of data.rows) {
      const member = toMember(row);
      if (member !== null) yield member;
    }
  }

  // ---- Phase D: lists ------------------------------------------------------------------------

  async listDistributionGroups(
    query: ExchangeGroupListQuery = {},
  ): Promise<ExchangeListResult<ExchangeDistributionGroup>> {
    const limit = limitOf(query.limit);
    const calls = groupListCalls(query);
    const kind = query.kind ?? 'all';
    const seen = new Map<string, ExchangeDistributionGroup>();
    let cut = false;
    for (const call of calls) {
      const data = await this.#run(call, 'read');
      cut = cut || data.cut || data.rows.length > limit;
      for (const row of data.rows) {
        const group = toDistributionGroup(row);
        if (group !== null && (kind === 'all' || group.kind === kind)) seen.set(group.guid, group);
      }
    }
    const sorted = [...seen.values()].sort(byDisplayName);
    return { items: sorted.slice(0, limit), truncated: cut || sorted.length > limit };
  }

  async getDistributionGroup(identity: string): Promise<ExchangeDistributionGroup | null> {
    const fromRows = (data: Data): ExchangeDistributionGroup | null => {
      for (const row of data.rows) {
        const group = toDistributionGroup(row);
        // A lone -Identity that misses may answer everything (R-D-09): the answer must be the one asked for.
        if (group !== null && matchesGroup(group, identity)) return group;
      }
      return null;
    };
    const first = await this.#orNotFound(groupGetCall(identity));
    const found = first === null ? null : fromRows(first);
    if (found !== null) return found;
    const dynamic = await this.#orNotFound(dynamicGroupGetCall(identity));
    return dynamic === null ? null : fromRows(dynamic);
  }

  async listRecipientMemberships(
    distinguishedName: string,
    o?: { limit?: number },
  ): Promise<ExchangeListResult<ExchangeDistributionGroup>> {
    const limit = limitOf(o?.limit);
    const data = await this.#run(membershipsCall(distinguishedName, o?.limit), 'read');
    const groups = data.rows
      .map(toDistributionGroup)
      .filter((group): group is ExchangeDistributionGroup => group !== null)
      .sort(byDisplayName);
    return {
      items: groups.slice(0, limit),
      truncated: data.cut || data.rows.length > limit,
    };
  }

  async addDistributionGroupMember(
    group: string,
    member: string,
    o?: ExchangeMemberWriteOptions,
  ): Promise<'added' | 'already'> {
    try {
      await this.#run(
        memberWriteCall('Add-DistributionGroupMember', group, member, o),
        'idempotent',
      );
      return 'added';
    } catch (failure) {
      if (failure instanceof ExchangeCommandError && failure.commandCode === 'already_member') {
        return 'already';
      }
      throw failure;
    }
  }

  async removeDistributionGroupMember(
    group: string,
    member: string,
    o?: ExchangeMemberWriteOptions,
  ): Promise<'removed' | 'already'> {
    try {
      await this.#run(
        memberWriteCall('Remove-DistributionGroupMember', group, member, o),
        'idempotent',
      );
      return 'removed';
    } catch (failure) {
      if (failure instanceof ExchangeCommandError && failure.commandCode === 'not_a_member') {
        return 'already';
      }
      throw failure;
    }
  }

  // ---- Phase D: contacts ---------------------------------------------------------------------

  async listMailContacts(
    query: ExchangeContactListQuery = {},
  ): Promise<ExchangeListResult<ExchangeMailContact>> {
    const limit = limitOf(query.limit);
    const data = await this.#run(contactListCall(query), 'read');
    const contacts = data.rows
      .map(toMailContact)
      .filter((contact): contact is ExchangeMailContact => contact !== null)
      .sort(byDisplayName);
    return { items: contacts.slice(0, limit), truncated: data.cut || data.rows.length > limit };
  }

  async getMailContact(guid: string): Promise<ExchangeMailContact | null> {
    const call = contactGetCall(guid);
    const wanted = String(call.args.Identity);
    const data = await this.#orNotFound(call);
    if (data === null) return null;
    // `Get-MailContact` answers a miss with ALL contacts (R-D-09): only the row with this GUID is the contact.
    for (const row of data.rows) {
      const contact = toMailContact(row);
      if (contact !== null && contact.guid === wanted) return contact;
    }
    return null;
  }

  async createMailContact(input: ExchangeContactCreate): Promise<ExchangeMailContact> {
    // Never repeated after a lost worker: the contact may exist already.
    const data = await this.#run(contactCreateCall(input), 'never');
    for (const row of data.rows) {
      const contact = toMailContact(row);
      if (contact !== null) return contact;
    }
    throw new ExchangeUnavailableError({ reason: 'unexpected_answer' });
  }

  async updateMailContact(
    guid: string,
    changes: ExchangeContactChanges,
  ): Promise<ExchangeMailContact> {
    await this.#run(contactUpdateCall(guid, changes), 'idempotent');
    const contact = await this.getMailContact(guid);
    // Written and not yet readable (U82): the caller is told, and may read again.
    if (contact === null) throw new ExchangeUnavailableError({ reason: 'read_back_pending' });
    return contact;
  }

  async removeMailContact(guid: string): Promise<void> {
    await this.#run(contactRemoveCall(guid), 'idempotent', { notFoundAfterLossIsDone: true });
  }

  // ---- the call -------------------------------------------------------------------------------

  /** `null` when the cmdlet answered `not_found` (a miss of a lone identity), the rows otherwise. */
  async #orNotFound(call: CmdletCall): Promise<Data | null> {
    try {
      return await this.#run(call, 'read');
    } catch (failure) {
      if (failure instanceof ExchangeCommandError && failure.commandCode === 'not_found')
        return null;
      throw failure;
    }
  }

  async #run(
    call: CmdletCall,
    repeat: Repeat,
    options: { notFoundAfterLossIsDone?: boolean } = {},
  ): Promise<Data> {
    let lost = false;
    for (;;) {
      try {
        return await this.#send(call);
      } catch (failure) {
        // A 5xx or a dropped connection: the call may or may not have run. Reads and idempotent writes are
        // repeated ONCE; `New-MailContact` never is (the contact may exist already, EC-D1).
        if (
          (failure instanceof ExchangeTransientError || failure instanceof ExchangeNetworkError) &&
          repeat !== 'never' &&
          !lost
        ) {
          lost = true;
          this.#log?.warn(
            { event: 'exchange_retry', cmdlet: call.cmdlet, attempt: 1, reason: 'lost', waitMs: 0 },
            'exchange call repeated',
          );
          continue;
        }
        if (
          lost &&
          options.notFoundAfterLossIsDone === true &&
          failure instanceof ExchangeCommandError &&
          failure.commandCode === 'not_found'
        ) {
          // The attempt that was lost had removed it: the repeat finds nothing, and that is the result wanted.
          return { rows: [], cut: false };
        }
        // Exchange could not be reached or answered with a 5xx twice: the services know ONE word for that.
        if (failure instanceof ExchangeTransientError || failure instanceof ExchangeNetworkError) {
          this.#log?.warn(
            { event: 'exchange_fault', cmdlet: call.cmdlet, result: 'transient' },
            'exchange call failed',
          );
          throw new ExchangeUnavailableError({
            reason: failure instanceof ExchangeNetworkError ? 'network' : 'upstream_error',
          });
        }
        const result = resultOf(failure);
        if (result !== null) {
          this.#log?.warn(
            { event: 'exchange_fault', cmdlet: call.cmdlet, result },
            'exchange call failed',
          );
        }
        throw failure;
      }
    }
  }

  async #send(call: CmdletCall): Promise<Data> {
    const body = { CmdletInput: { CmdletName: call.cmdlet, Parameters: call.args } };
    const rows: Row[] = [];
    let href = `${INVOKE_ORIGIN}${this.#prefix}InvokeCommand`;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { body: answer } = await this.#engine.send({
        method: 'POST',
        route: 'invoke_command',
        href,
        json: body,
        headers: { 'x-anchormailbox': `APP:SystemMailbox{${SYSTEM_MAILBOX}}@${this.#tenant}` },
        // Repeats after a 5xx are decided by `#run`, which knows whether the call may run twice.
        idempotent: false,
      });
      const parsed = readEnvelope(answer);
      if (parsed === null) throw new ExchangeUnavailableError({ reason: 'unexpected_shape' });
      rows.push(...parsed.rows.filter((row): row is Row => typeof row === 'object'));
      if (parsed.nextLink === null) return { rows, cut: false };
      try {
        href = resolveUnder(INVOKE_ORIGIN, this.#prefix, parsed.nextLink).href;
      } catch (failure) {
        if (failure instanceof UrlRefusedError)
          throw new ExchangeUnavailableError({ reason: 'invalid_next_link' });
        throw failure;
      }
    }
    return { rows, cut: true };
  }
}
