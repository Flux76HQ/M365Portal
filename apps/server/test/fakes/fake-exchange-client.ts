// `FakeExchangeClient`: the in-memory `ExchangeClient` that service tests use (T-B-080, T-D-111, plan
// 8.7; a service test uses this and never MSW). It answers from a `FakeExchangeState`, the data the
// fake Admin API serves over HTTP and the worker stand-in works on, so one contract suite
// (test/exchange/exchange-client-contract.test.ts) runs against this class, against
// `AdminApiExchangeClient` on MSW (Phase B reads) and against `PwshExchangeClient` over the worker
// stand-in (the Phase D surface), and must see the same answers.
//
// It follows the real clients where a service can notice: `capabilities()` is the Phase D set, a
// property outside the documented list or a `ResultSize` outside 1 to 1,000 is
// `ExchangeUnsupportedError`, a group that does not exist is `ExchangeUnavailableError` (status 404),
// pages are `resultSize` long and must be read within 5 minutes of the first, `null` stands for a
// property the data lacks. The Phase D methods build the same cmdlet calls as `PwshExchangeClient`
// (arguments.ts) and refuse what the allow-list refuses; the rules of Exchange itself (member types,
// duplicates, the manager check, synced objects, the read-back delay) are those of the write module
// (fake-tenant/exchange/writes.ts), the same ones the worker stand-in applies. `probe()` answers `ok`
// unless a test scripts another outcome with `scriptProbe`, and `failNext` makes the next calls throw
// a typed error (for the failure paths of a service). Every call is recorded in `calls`.
import { LIMITS } from '@m365portal/shared/limits';
import {
  ExchangeCommandError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  type ExchangeError,
} from '../../src/ports/errors.js';
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
  ExchangeScalar,
} from '../../src/ports/exchange.js';
import {
  contactCreateCall,
  contactGetCall,
  contactListCall,
  contactRemoveCall,
  contactUpdateCall,
  groupGetCall,
  groupListCalls,
  groupMembersCall,
  limitOf,
  memberWriteCall,
  membershipsCall,
} from '../../src/integrations/exchange/pwsh/arguments.js';
import {
  toDistributionGroup,
  toMailContact,
  toMember,
} from '../../src/integrations/exchange/pwsh/rows.js';
import type { Clock } from '../../src/ports/clock.js';
import {
  DEFAULT_ORGANIZATION_SELECT,
  ORGANIZATION_CONFIG_PROPERTIES,
  scalar,
  type OrganizationConfigProperty,
} from '../../src/integrations/exchange/schemas.js';
import {
  addMember,
  createContact,
  groupMatches,
  groupRow,
  recipientRow,
  removeContact,
  removeMember,
  renderOrganizationConfig,
  updateContact,
  type FakeDistributionGroup,
  type FakeExchangeState,
  type FakeRecipient,
  type Refusal,
} from './fake-tenant/exchange/index.js';

const RESULT_SIZE_MAX = LIMITS.microsoft.exchangeResultSizeMax;
const PAGING_WINDOW_MS = LIMITS.microsoft.exchangePagingWindowSeconds * 1000;

export type FakeExchangeMethod =
  | 'capabilities'
  | 'probe'
  | 'getOrganizationConfig'
  | 'listDistributionGroupMembers'
  | 'listDistributionGroups'
  | 'getDistributionGroup'
  | 'addDistributionGroupMember'
  | 'removeDistributionGroupMember'
  | 'listMailContacts'
  | 'getMailContact'
  | 'createMailContact'
  | 'updateMailContact'
  | 'removeMailContact'
  | 'listRecipientMemberships';

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

  capabilities(): ExchangeCapabilities {
    this.calls.push({ method: 'capabilities', args: [] });
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
    groupMembersCall(identity);
    const startedAt = this.#clock.now();
    const members = this.#state.read((view) => {
      const group = view
        .groups()
        .find(
          (candidate) =>
            candidate.recipientTypeDetails !== 'DynamicDistributionGroup' &&
            groupMatches(candidate, identity),
        );
      return group === undefined ? undefined : view.members(group);
    });
    if (members === undefined)
      throw new ExchangeUnavailableError({ status: 404, reason: 'not_found' });
    for (let offset = 0; offset < members.length; offset += resultSize) {
      if (offset > 0 && this.#clock.now() - startedAt > PAGING_WINDOW_MS) {
        throw new ExchangeUnavailableError({ reason: 'paging_window_exceeded' });
      }
      for (const member of members.slice(offset, offset + resultSize)) {
        const record = toMember(recipientRow('Get-DistributionGroupMember', member));
        if (record !== null) yield record;
      }
    }
  }

  // ---- Phase D (FR-D-101): lists, contacts, the five writes --------------------------------------

  /** Runs `body` as the call of `method`: recorded, scripted failures first, rejections as promises. */
  #phaseD<T>(method: FakeExchangeMethod, args: readonly unknown[], body: () => T): Promise<T> {
    try {
      this.#enter(method, args);
      return Promise.resolve(body());
    } catch (failure) {
      return Promise.reject(failure instanceof Error ? failure : new Error('unexpected'));
    }
  }

  listDistributionGroups(
    query: ExchangeGroupListQuery = {},
  ): Promise<ExchangeListResult<ExchangeDistributionGroup>> {
    return this.#phaseD('listDistributionGroups', [query], () => {
      groupListCalls(query);
      const limit = limitOf(query.limit);
      const kind = query.kind ?? 'all';
      const prefix = (query.prefix ?? '').toLowerCase();
      const groups = this.#state.read((view) =>
        view.groups().filter((group) => {
          const record = groupRecord(group);
          if (kind !== 'all' && record.kind !== kind) return false;
          return (
            prefix === '' ||
            [group.name, group.displayName, group.alias, group.primarySmtpAddress].some((value) =>
              value.toLowerCase().startsWith(prefix),
            )
          );
        }),
      );
      const sorted = groups.map(groupRecord).sort(byDisplayName);
      return { items: sorted.slice(0, limit), truncated: sorted.length > limit };
    });
  }

  getDistributionGroup(identity: string): Promise<ExchangeDistributionGroup | null> {
    return this.#phaseD('getDistributionGroup', [identity], () => {
      groupGetCall(identity);
      const matches = this.#state.read((view) =>
        view.groups().filter((group) => groupMatches(group, identity)),
      );
      if (matches.length > 1) throw new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
      const [only] = matches;
      return only === undefined ? null : groupRecord(only);
    });
  }

  addDistributionGroupMember(
    group: string,
    member: string,
    o?: ExchangeMemberWriteOptions,
  ): Promise<'added' | 'already'> {
    return this.#phaseD('addDistributionGroupMember', [group, member, o], () => {
      memberWriteCall('Add-DistributionGroupMember', group, member, o);
      const outcome = addMember(this.#state, group, member, {
        bypass: o?.bypassManagerCheck !== false,
      });
      if (outcome.ok) return 'added' as const;
      if (outcome.error === 'already_member') return 'already' as const;
      throw errorFor(outcome);
    });
  }

  removeDistributionGroupMember(
    group: string,
    member: string,
    o?: ExchangeMemberWriteOptions,
  ): Promise<'removed' | 'already'> {
    return this.#phaseD('removeDistributionGroupMember', [group, member, o], () => {
      memberWriteCall('Remove-DistributionGroupMember', group, member, o);
      const outcome = removeMember(this.#state, group, member, {
        bypass: o?.bypassManagerCheck !== false,
      });
      if (outcome.ok) return 'removed' as const;
      if (outcome.error === 'not_a_member') return 'already' as const;
      throw errorFor(outcome);
    });
  }

  listMailContacts(
    query: ExchangeContactListQuery = {},
  ): Promise<ExchangeListResult<ExchangeMailContact>> {
    return this.#phaseD('listMailContacts', [query], () => {
      contactListCall(query);
      const limit = limitOf(query.limit);
      const prefix = (query.prefix ?? '').toLowerCase();
      const contacts = this.#state.read((view) =>
        view
          .contacts()
          .filter(
            (contact) =>
              prefix === '' ||
              [
                contact.name,
                contact.displayName,
                contact.alias,
                contact.primarySmtpAddress,
                contact.firstName,
                contact.lastName,
              ].some((value) => (value ?? '').toLowerCase().startsWith(prefix)),
          ),
      );
      const sorted = contacts.map(contactRecord).sort(byDisplayName);
      return { items: sorted.slice(0, limit), truncated: sorted.length > limit };
    });
  }

  getMailContact(guid: string): Promise<ExchangeMailContact | null> {
    return this.#phaseD('getMailContact', [guid], () => this.#contact(guid));
  }

  createMailContact(input: ExchangeContactCreate): Promise<ExchangeMailContact> {
    return this.#phaseD('createMailContact', [input], () => {
      contactCreateCall(input);
      const outcome = createContact(this.#state, input);
      if (!outcome.ok) throw errorFor(outcome);
      return contactRecord(outcome.value);
    });
  }

  updateMailContact(guid: string, changes: ExchangeContactChanges): Promise<ExchangeMailContact> {
    return this.#phaseD('updateMailContact', [guid, changes], () => {
      contactUpdateCall(guid, changes);
      const outcome = updateContact(this.#state, guid.toLowerCase(), changes);
      if (!outcome.ok) throw errorFor(outcome);
      // Like the real client: the answer is what a read sees now (U82).
      const read = this.#contact(guid);
      if (read === null) throw new ExchangeUnavailableError({ reason: 'read_back_pending' });
      return read;
    });
  }

  removeMailContact(guid: string): Promise<void> {
    return this.#phaseD('removeMailContact', [guid], () => {
      contactRemoveCall(guid);
      const outcome = removeContact(this.#state, guid.toLowerCase());
      if (!outcome.ok) throw errorFor(outcome);
    });
  }

  listRecipientMemberships(
    distinguishedName: string,
    o?: { limit?: number },
  ): Promise<ExchangeListResult<ExchangeDistributionGroup>> {
    return this.#phaseD('listRecipientMemberships', [distinguishedName, o], () => {
      membershipsCall(distinguishedName, o?.limit);
      const limit = limitOf(o?.limit);
      const wanted = distinguishedName.toLowerCase();
      const groups = this.#state.read((view) =>
        view
          .groups()
          .filter(
            (group) =>
              group.recipientTypeDetails !== 'DynamicDistributionGroup' &&
              view
                .members(group)
                .some((member) => member.distinguishedName.toLowerCase() === wanted),
          ),
      );
      const sorted = groups.map(groupRecord).sort(byDisplayName);
      return { items: sorted.slice(0, limit), truncated: sorted.length > limit };
    });
  }

  /** A contact by GUID as a read sees it, or `null`. */
  #contact(guid: string): ExchangeMailContact | null {
    contactGetCall(guid);
    const wanted = guid.toLowerCase();
    const found = this.#state.read((view) =>
      view.contacts().find((contact) => contact.guid === wanted),
    );
    return found === undefined ? null : contactRecord(found);
  }
}

// ---- helpers of the Phase D methods -------------------------------------------------------------

function groupRecord(group: FakeDistributionGroup): ExchangeDistributionGroup {
  const record = toDistributionGroup(groupRow('Get-DistributionGroup', group));
  if (record === null) throw new Error('a fake group without a GUID');
  return record;
}

function contactRecord(contact: FakeRecipient): ExchangeMailContact {
  const record = toMailContact(recipientRow('Get-MailContact', contact));
  if (record === null) throw new Error('a fake contact without a GUID');
  return record;
}

function byDisplayName<T extends { displayName: string | null; guid: string }>(a: T, b: T): number {
  const left = (a.displayName ?? '\uffff').toLowerCase();
  const right = (b.displayName ?? '\uffff').toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
}

/** The typed error for a refusal of the write module, as `PwshExchangeClient` would throw it. */
function errorFor(outcome: Refusal): Error {
  switch (outcome.error) {
    case 'invalid_argument':
      return new ExchangeUnsupportedError({ reason: 'invalid_parameter' });
    case 'role_pending':
    case 'internal':
      return new ExchangeUnavailableError({ reason: outcome.error });
    default:
      return new ExchangeCommandError(outcome.error);
  }
}
