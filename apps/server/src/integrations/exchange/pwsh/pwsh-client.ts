// `PwshExchangeClient`: the Phase D implementation of the `ExchangeClient` port over the `pwsh` worker
// (T-D-113, FR-D-101, FR-D-105, FR-D-107). It builds the cmdlet calls (arguments.ts, all validated by
// the allow-list), sends them through the session (session.ts), reads the rows (rows.ts) and decides
// what a failure means:
//
//   throttled          wait `Retry-After` (0 to 20 per cent jitter, at most a minute: longer fails at
//                      once) or back off 1 s doubling to 15 s with full jitter, at most `retryMax`
//                      repeats, then `ExchangeThrottledError` with the hint. Every call is repeated:
//                      a throttled call did not run.
//   worker lost        the worker timed out or crashed (or Exchange reported a timeout): restart and
//                      repeat ONCE, and only when repeating is safe: reads and idempotent writes
//                      (add and remove of a member, set and remove of a contact). `New-MailContact`
//                      is never repeated: the contact may exist already (EC-D1).
//   not_connected      the worker lost its connection: reset it and repeat once.
//   anything else      a typed error with a fixed code (errors.ts); no text of Exchange, no argument.
//
// What is logged is the request id, the cmdlet, the outcome and the duration (session.ts), and for a
// repeat the attempt, the reason and the wait: never a name, an address or a member list.
import { LIMITS } from '@m365portal/shared/limits';
import type { RandomSource, Scheduler } from '../../../ports/clock.js';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
} from '../../../ports/errors.js';
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
} from '../../../ports/exchange.js';
import { retryAfterWaitMs } from '../../http/retry.js';
import {
  DEFAULT_ORGANIZATION_SELECT,
  ORGANIZATION_CONFIG_PROPERTIES,
  type OrganizationConfigProperty,
} from '../schemas.js';
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
import {
  toDistributionGroup,
  toMailContact,
  toMember,
  toOrganizationConfig,
  type Row,
} from './rows.js';
import type { ExchangeLog, ExchangeSession } from './session.js';

export interface PwshExchangeClientDeps {
  readonly session: ExchangeSession;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: ExchangeLog;
}

/** How a call may be repeated after the worker was lost. */
type Repeat = 'read' | 'idempotent' | 'never';

interface Data {
  readonly rows: readonly Row[];
  /** The script cut the rows to fit one protocol line. */
  readonly cut: boolean;
}

const RESULT_SIZE_MAX = LIMITS.microsoft.exchangeResultSizeMax;
const BACKOFF = LIMITS.exchange.retryBackoff;
const RETRY_MAX = LIMITS.exchange.retryMax;

/** Full jitter: `[0, min(maxMs, initialMs * 2^n))`, the n-th repeat (0-based). */
function backoffMs(attempt: number, random01: number): number {
  const cap = Math.min(BACKOFF.maxMs, BACKOFF.initialMs * 2 ** Math.min(Math.max(0, attempt), 30));
  return Math.floor(Math.min(Math.max(random01, 0), 0.999_999_999) * cap);
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

export class PwshExchangeClient implements ExchangeClient {
  readonly #deps: PwshExchangeClientDeps;

  constructor(deps: PwshExchangeClientDeps) {
    this.#deps = deps;
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

  // ---- the call loop -------------------------------------------------------------------------

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
    let throttles = 0;
    let lost = false;
    let reset = false;
    for (;;) {
      try {
        const answer = await this.#deps.session.request({ cmdlet: call.cmdlet, args: call.args });
        const { response } = answer;
        if (response.ok) return dataOf(response.data);
        const { code, retryAfterMs } = response.error;
        if (code === 'throttled') {
          const wait = this.#throttleWait(throttles, retryAfterMs);
          if (throttles >= RETRY_MAX || wait === null) {
            throw new ExchangeThrottledError(
              retryAfterMs === undefined ? undefined : { retryAfterMs },
            );
          }
          throttles += 1;
          await this.#sleep(call, throttles, 'throttled', wait);
          continue;
        }
        if (code === 'timeout') {
          if (repeat !== 'never' && !lost) {
            lost = true;
            this.#note(call, 1, 'timeout', 0);
            continue;
          }
          throw new ExchangeUnavailableError({ reason: 'timeout', clientRequestId: answer.id });
        }
        if (code === 'not_connected') {
          if (!reset) {
            reset = true;
            await this.#deps.session.reset();
            this.#note(call, 1, 'not_connected', 0);
            continue;
          }
          throw new ExchangeUnavailableError({
            reason: 'not_connected',
            clientRequestId: answer.id,
          });
        }
        if (code === 'not_found' && lost && options.notFoundAfterLossIsDone === true) {
          // The attempt that was lost had removed it: the repeat finds nothing, and that is the result wanted.
          return { rows: [], cut: false };
        }
        throw errorFor(code, retryAfterMs, answer.id);
      } catch (failure) {
        if (
          failure instanceof ExchangeUnavailableError &&
          (failure.reason === 'worker_timeout' || failure.reason === 'worker_crashed') &&
          repeat !== 'never' &&
          !lost
        ) {
          lost = true;
          this.#note(call, 1, failure.reason, 0);
          continue;
        }
        throw failure;
      }
    }
  }

  #throttleWait(attempt: number, retryAfterMs: number | undefined): number | null {
    const jitter = this.#deps.random.float();
    return retryAfterMs === undefined
      ? backoffMs(attempt, jitter)
      : retryAfterWaitMs(retryAfterMs, jitter);
  }

  async #sleep(call: CmdletCall, attempt: number, reason: string, waitMs: number): Promise<void> {
    this.#note(call, attempt, reason, waitMs);
    await new Promise<void>((resolve) => {
      this.#deps.scheduler.setTimeout(resolve, waitMs);
    });
  }

  #note(call: CmdletCall, attempt: number, reason: string, waitMs: number): void {
    this.#deps.log?.warn(
      { event: 'exchange_retry', cmdlet: call.cmdlet, attempt, reason, waitMs },
      'exchange call repeated',
    );
  }
}

function dataOf(data: unknown): Data {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { rows: [], cut: false };
  const { rows, truncated } = data as { rows?: unknown; truncated?: unknown };
  return {
    rows: Array.isArray(rows)
      ? rows.filter(
          (row): row is Row => typeof row === 'object' && row !== null && !Array.isArray(row),
        )
      : [],
    cut: truncated === true,
  };
}

/** The typed error for a code of the closed list that is not handled by the loop. */
function errorFor(code: string, retryAfterMs: number | undefined, requestId: string): Error {
  switch (code) {
    case 'role_pending':
      return new ExchangeUnavailableError({ reason: 'role_pending', clientRequestId: requestId });
    case 'internal':
      return new ExchangeUnavailableError({ reason: 'internal', clientRequestId: requestId });
    case 'invalid_argument':
      return new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
    default:
      return new ExchangeCommandError(
        code as ConstructorParameters<typeof ExchangeCommandError>[0],
        retryAfterMs === undefined ? undefined : { retryAfterMs },
      );
  }
}
