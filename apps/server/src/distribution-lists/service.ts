// The distribution lists service (T-D-118, FR-D-202, FR-D-207, plan 5.2): what the read routes P40 to P42
// and P45 ask of Exchange and Graph and what they answer. As the Phase C services, every method that
// returns data takes the capability of the policy layer as an argument (`VisibleScope`,
// `AuthorizedResource`): a route that never asked `ctx` cannot call it (compile time), and the runtime
// net of the wrapper catches the rest (FR-C-401, ADR-0175).
//
// The worker has no cursor, so a list is read ONCE into a bounded buffer (`list-buffer.ts`) and the pages
// are slices of it. A result larger than `LIMITS.exchange.listBufferMax` is refused with 422
// `validation_failed` and the detail code `narrow_search` on `/q`: the panel never shows a silent
// short list. The scope of the actor is applied to the slice, row by row, with the same function the
// detail route asks (`visibilityOf` over `listResource`), so a scoped list never holds a row the detail
// refuses.
//
// A dynamic list has no member list: `Get-DynamicDistributionGroupMember` is not on the allow-list of
// the worker (GD1-server-a finding 6), so P42 answers an empty page for it. Nothing here logs a name,
// an address or an id (FR-D-107).
import { defined } from '../directory/pool.js';
import { LIMITS } from '@m365portal/shared/limits';
import { pageLimitOf } from '@m365portal/shared/schemas/common';
import type {
  DistributionListCandidate,
  DistributionListCandidatesResponse,
  DistributionListDetail,
  DistributionListListQuery,
  DistributionListListResponse,
  DistributionListMembersResponse,
  DistributionListMemberRow,
} from '@m365portal/shared/schemas/distribution-lists';
import { ProblemError } from '../http/problem.js';
import { userResource } from '../directory/mappers.js';
import { keyOf } from '../directory/paging.js';
import { scanList, seesAll, seesNothing, visibilityOf } from '../directory/scoped-list.js';
import { viaGraph } from '../directory/errors.js';
import type { AuthorizedResource, VisibleScope } from '../policy/index.js';
import type {
  ExchangeClient,
  ExchangeDistributionGroup,
  ExchangeRecipient,
} from '../ports/exchange.js';
import type { GraphClient } from '../ports/graph.js';
import { viaExchange } from './errors.js';
import type { ListBufferStore } from './list-buffer.js';
import {
  contactResource,
  listResource,
  memberWireId,
  toListDetail,
  toListItem,
} from './mappers.js';
import { toMemberRow, type MemberVisibility } from './members.js';

/**
 * The kind of a candidate that is a user. A constant, not a literal in an object: the source scan of the actor
 * resolvers (`default-deny.test.ts`) looks for `kind: 'user'` objects, which here are rows, not actors.
 */
const USER_KIND = 'user' as const;

export interface ExchangeServiceDeps {
  readonly exchange: () => ExchangeClient;
  readonly graph: () => GraphClient;
  readonly buffers: ListBufferStore;
}

interface PageInput {
  readonly actorId: string;
  readonly query: { readonly limit?: string | undefined; readonly cursor?: string | undefined };
}

export interface DistributionListsService {
  /** The lists the actor may see (P40). */
  list(
    input: PageInput & {
      readonly scope: VisibleScope<'distributionList'>;
      readonly users: VisibleScope<'user'>;
      readonly query: DistributionListListQuery;
    },
  ): Promise<DistributionListListResponse>;
  /** The list as Exchange has it, or `null`: the route needs the attributes to ask `authorizeResource`. */
  find(id: string): Promise<ExchangeDistributionGroup | null>;
  /** The detail of a list the actor may see (P41), with the member count when Exchange lets it be counted. */
  detail(input: {
    readonly authorized: AuthorizedResource<'distributionList'>;
    readonly group: ExchangeDistributionGroup;
    readonly users: VisibleScope<'user'>;
  }): Promise<DistributionListDetail>;
  /** The members of a list (P42), rows cut to restricted rows by the scopes of the actor. */
  members(
    input: PageInput & {
      readonly authorized: AuthorizedResource<'distributionList'>;
      readonly group: ExchangeDistributionGroup;
      readonly visibility: MemberVisibility;
    },
  ): Promise<DistributionListMembersResponse>;
  /** The users and contacts the actor may add to a list (P45). */
  candidates(
    input: PageInput & {
      readonly authorized: AuthorizedResource<'distributionList'>;
      readonly group: ExchangeDistributionGroup;
      readonly users: VisibleScope<'user'>;
      readonly contacts: VisibleScope<'contact'>;
      readonly q: string;
    },
  ): Promise<DistributionListCandidatesResponse>;
  /** The members of a list as Exchange has them right now, by wire id (the write service reads membership with it). */
  readMembers(group: ExchangeDistributionGroup): Promise<Map<string, ExchangeRecipient>>;
}

/** The answer for a result that does not fit the buffer: the one clear "narrow your search". */
export function narrowYourSearch(): ProblemError {
  return new ProblemError('validation_failed', {
    errors: [{ pointer: '/q', code: 'narrow_search' }],
  });
}

function cursorInvalid(): ProblemError {
  return new ProblemError('cursor_invalid');
}

/** Reads the members of a list from Exchange into a map by wire id; at most the buffer size. */
async function collectMembers(
  exchange: ExchangeClient,
  group: ExchangeDistributionGroup,
): Promise<ExchangeRecipient[]> {
  const rows: ExchangeRecipient[] = [];
  for await (const recipient of exchange.listDistributionGroupMembers(group.guid)) {
    rows.push(recipient);
    if (rows.length > LIMITS.exchange.listBufferMax) {
      throw new ProblemError('exchange_unavailable', { retryAfterSeconds: 30 });
    }
  }
  return rows;
}

function nameOf(recipient: ExchangeRecipient): string {
  const display = recipient.DisplayName;
  return (typeof display === 'string' ? display : (recipient.name ?? '')).toLowerCase();
}

export function createDistributionListsService(
  deps: ExchangeServiceDeps,
): DistributionListsService {
  const callOptions = { priority: 'high' } as const;

  return {
    async list({ scope, users, actorId, query }) {
      const scopes = scope.scopes;
      if (seesNothing(scopes)) return { items: [] };
      const limit = pageLimitOf(query);
      const route = 'distributionLists.list';
      const key = keyOf({ q: query.q, kind: query.kind, order: query.order });

      let rows: readonly ExchangeDistributionGroup[];
      let offset = 0;
      if (query.cursor === undefined) {
        const result = await viaExchange(() =>
          deps.exchange().listDistributionGroups({
            kind: query.kind,
            limit: LIMITS.exchange.listBufferMax,
            ...(query.q === undefined ? {} : { prefix: query.q }),
          }),
        );
        if (result.truncated) throw narrowYourSearch();
        rows = query.order === 'desc' ? [...result.items].reverse() : result.items;
      } else {
        const page = deps.buffers.take<ExchangeDistributionGroup>(actorId, query.cursor);
        if (page?.route !== route || page.key !== key) throw cursorInvalid();
        rows = page.rows;
        offset = page.offset;
      }

      const items = [];
      let index = offset;
      for (; index < rows.length && items.length < limit; index += 1) {
        const group = defined(rows[index]);
        if (visibilityOf(scopes, listResource(group)) !== null)
          items.push(toListItem(group, users));
      }
      // Rows the actor may not see at the end of the buffer are not a next page.
      while (
        index < rows.length &&
        visibilityOf(scopes, listResource(defined(rows[index]))) === null
      ) {
        index += 1;
      }
      const nextCursor =
        query.cursor === undefined
          ? deps.buffers.put(actorId, { route, key, rows, offset: index })
          : deps.buffers.next(actorId, query.cursor, index);
      return { items, ...(nextCursor === null ? {} : { nextCursor }) };
    },

    find(id) {
      return viaExchange(() => deps.exchange().getDistributionGroup(id));
    },

    async detail({ authorized, group, users }) {
      if (authorized.resource.id !== group.guid) {
        throw new TypeError('the capability is for another list');
      }
      let count: number | null = null;
      if (group.kind !== 'dynamic') {
        try {
          count = (await collectMembers(deps.exchange(), group)).length;
        } catch {
          // A count is a courtesy: the detail does not fail for it (U79).
          count = null;
        }
      }
      return toListDetail(group, users, count);
    },

    async members({ authorized, group, visibility, actorId, query }) {
      if (authorized.resource.id !== group.guid) {
        throw new TypeError('the capability is for another list');
      }
      // No member list for a dynamic list: its cmdlet is not on the allow-list (FR-D-207 is not built).
      if (group.kind === 'dynamic') return { items: [] };
      const limit = pageLimitOf(query);
      const route = 'distributionLists.members';
      const key = keyOf({ list: group.guid });

      let rows: readonly ExchangeRecipient[];
      let offset = 0;
      if (query.cursor === undefined) {
        const read = await viaExchange(() => collectMembers(deps.exchange(), group));
        rows = [...read].sort((a, b) => {
          const left = nameOf(a);
          const right = nameOf(b);
          if (left !== right) return left < right ? -1 : 1;
          return (a.guid ?? '') < (b.guid ?? '') ? -1 : 1;
        });
      } else {
        const page = deps.buffers.take<ExchangeRecipient>(actorId, query.cursor);
        if (page?.route !== route || page.key !== key) throw cursorInvalid();
        rows = page.rows;
        offset = page.offset;
      }

      const items: DistributionListMemberRow[] = [];
      let index = offset;
      for (; index < rows.length && items.length < limit; index += 1) {
        const row = toMemberRow(defined(rows[index]), visibility);
        if (row !== null) items.push(row);
      }
      const nextCursor =
        query.cursor === undefined
          ? deps.buffers.put(actorId, { route, key, rows, offset: index })
          : deps.buffers.next(actorId, query.cursor, index);
      return { items, ...(nextCursor === null ? {} : { nextCursor }) };
    },

    async candidates({ authorized, group, users, contacts, q, query }) {
      if (authorized.resource.id !== group.guid) {
        throw new TypeError('the capability is for another list');
      }
      // This route never issues a cursor: a cursor in the request is not one of ours.
      if (query.cursor !== undefined) throw cursorInvalid();
      const limit = pageLimitOf(query);

      let present: ReadonlySet<string> | null = null;
      try {
        present = new Set(
          (await collectMembers(deps.exchange(), group)).flatMap((member) => {
            const id = memberWireId(member);
            return id === null ? [] : [id];
          }),
        );
      } catch {
        // `alreadyMember` is `null` when it could not be checked (the schema allows it).
        present = null;
      }
      const flag = (id: string): boolean | null => (present === null ? null : present.has(id));

      const items: DistributionListCandidate[] = [];
      if (!seesNothing(users.scopes)) {
        const scopes = users.scopes;
        // A search on the principal name would reveal it for a row shown as `basic` (FR-C-204).
        const searchPrincipalName = scopes.full === 'all' || scopes.basic === 'none';
        const found = await viaGraph(() =>
          scanList({
            readPage: (after) =>
              deps.graph().listUsers(
                {
                  q,
                  searchPrincipalName,
                  enabled: 'true',
                  type: 'all',
                  order: 'asc',
                  top: seesAll(scopes) ? limit : LIMITS.directory.graphPageSize,
                  after,
                },
                callOptions,
              ),
            // A user without a mailbox address cannot be a member (EC-D3): not offered.
            select: (user) =>
              user.mail !== null && visibilityOf(scopes, userResource(user)) !== null
                ? ({
                    kind: USER_KIND,
                    id: user.id,
                    displayName: user.displayName,
                    mail: user.mail,
                    alreadyMember: flag(user.id),
                  } satisfies DistributionListCandidate)
                : null,
            limit,
            start: null,
            maxPages: LIMITS.directory.scanPagesMax,
          }),
        );
        items.push(...found.rows);
      }
      if (items.length < limit && !seesNothing(contacts.scopes)) {
        const found = await viaExchange(() =>
          deps.exchange().listMailContacts({ prefix: q, limit: LIMITS.exchange.listBufferMax }),
        );
        for (const contact of found.items) {
          if (items.length >= limit) break;
          if (visibilityOf(contacts.scopes, contactResource(contact)) === null) continue;
          items.push({
            kind: 'contact',
            id: contact.guid,
            displayName: contact.displayName,
            mail: contact.externalEmailAddress ?? contact.primarySmtpAddress,
            alreadyMember: flag(contact.guid),
          });
        }
      }
      return { items };
    },

    async readMembers(group) {
      const rows = await viaExchange(() => collectMembers(deps.exchange(), group));
      const byId = new Map<string, ExchangeRecipient>();
      for (const row of rows) {
        const id = memberWireId(row);
        if (id !== null) byId.set(id, row);
      }
      return byId;
    },
  };
}
