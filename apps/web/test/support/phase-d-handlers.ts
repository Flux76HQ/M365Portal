// Handlers for the Phase D routes of step D1 (P40 to P45, P47 to P54), built from the frozen wire schemas of gate
// GD1-0 (T-D-151). Like `directory-handlers.ts`, the network stand-in is a plain `fetch` function: every success
// answer is parsed with the schema of its route before it is sent, so a fixture that does not fit the contract
// fails the handler and not, by luck, the page. Requests are parsed with the request schemas too (strict, 422
// `validation_failed` with the field pointers the server would send), and the rules the pages rely on are kept:
// a read-only list or group answers 409 `read_only_object`, a member that is in already is `already`, an unknown
// id is `failed` with `not_found`, a duplicate contact address or alias is 409 `conflict` with a pointer.
//
// Everything that is not a Phase D route goes to the Phase C handlers (`createDirectoryApi`), which also answer
// the users search the group member picker uses.
import {
  ContactCreateRequestSchema,
  ContactDeleteRequestSchema,
  ContactDeleteResponseSchema,
  ContactDetailSchema,
  ContactListQuerySchema,
  ContactListResponseSchema,
  ContactListsQuerySchema,
  ContactListsResponseSchema,
  ContactUpdateRequestSchema,
  type ContactDetail,
} from '@m365portal/shared/schemas/contacts';
import { PAGE_LIMIT_DEFAULT } from '@m365portal/shared/schemas/common';
import {
  DistributionListCandidatesQuerySchema,
  DistributionListCandidatesResponseSchema,
  DistributionListDetailSchema,
  DistributionListListQuerySchema,
  DistributionListListResponseSchema,
  DistributionListMembersQuerySchema,
  DistributionListMembersResponseSchema,
  isRestrictedMemberRow,
  type DistributionListDetail,
  type DistributionListListItem,
  type DistributionListMemberRow,
} from '@m365portal/shared/schemas/distribution-lists';
import {
  DistributionListMemberWriteRequestSchema,
  DistributionListMemberWriteResponseSchema,
  GroupMemberWriteRequestSchema,
  GroupMemberWriteResponseSchema,
  summariseMemberResults,
  type MemberFailReason,
  type MemberWriteItem,
} from '@m365portal/shared/schemas/member-writes';
import type { FetchFunction } from '../../src/lib/api';
import { json, problem, type Call } from '../helpers/mock-api';
import {
  createDirectoryApi,
  emptyWorld,
  guid,
  type DirectoryApi,
  type DirectoryWorld,
} from './directory-handlers';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface ListRecord {
  detail: DistributionListDetail;
  members: DistributionListMemberRow[];
}

export interface ContactRecord {
  detail: ContactDetail;
}

export interface PhaseDWorld extends DirectoryWorld {
  lists: ListRecord[];
  contacts: ContactRecord[];
  /** Ids of lists the contact is in: list id by contact id. */
  contactLists: Record<string, string[]>;
  /** Members that fail on purpose, by id: the reason the write answers. */
  failing: Map<string, MemberFailReason>;
  /** The answer's `readBackPending`. */
  readBackPending: boolean;
}

export function emptyPhaseDWorld(): PhaseDWorld {
  return {
    ...emptyWorld(),
    lists: [],
    contacts: [],
    contactLists: {},
    failing: new Map(),
    readBackPending: false,
  };
}

export const listGuid = (n: number): string => guid(3000 + n);
export const contactGuid = (n: number): string => guid(4000 + n);

export function makeList(
  n: number,
  overrides: Partial<DistributionListDetail> = {},
): DistributionListDetail {
  return {
    id: listGuid(n),
    displayName: `List ${String(n).padStart(4, '0')}`,
    primarySmtpAddress: `list${String(n)}@example.test`,
    kind: 'standard',
    securityEnabled: false,
    memberCount: 0,
    managers: [{ displayName: 'Manager One', mail: 'manager.one@example.test' }],
    alias: `list${String(n)}`,
    createdDateTime: '2023-05-04T10:00:00.000Z',
    ...overrides,
  };
}

export function listRecord(
  detail: DistributionListDetail,
  members: DistributionListMemberRow[] = [],
): ListRecord {
  return { detail: { ...detail, memberCount: members.length }, members };
}

export function makeContact(n: number, overrides: Partial<ContactDetail> = {}): ContactDetail {
  return {
    id: contactGuid(n),
    displayName: `Contact ${String(n).padStart(4, '0')}`,
    alias: `contact${String(n)}`,
    externalEmailAddress: `contact${String(n)}@elsewhere.test`,
    synced: false,
    firstName: 'Con',
    lastName: String(n).padStart(4, '0'),
    hiddenFromAddressLists: false,
    createdDateTime: '2024-02-03T08:30:00.000Z',
    ...overrides,
  };
}

/** A member row of a list for user number `n` (the same user ids as `directory-handlers`). */
export function userMember(n: number): DistributionListMemberRow {
  return {
    kind: 'user',
    id: guid(1000 + n),
    displayName: `User ${String(n).padStart(4, '0')}`,
    primarySmtpAddress: `user${String(n)}@example.test`,
  };
}

export function contactMember(n: number): DistributionListMemberRow {
  return {
    kind: 'contact',
    id: contactGuid(n),
    displayName: `Contact ${String(n).padStart(4, '0')}`,
    primarySmtpAddress: `contact${String(n)}@elsewhere.test`,
  };
}

// ---------------------------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------------------------

export interface PhaseDApi {
  readonly fetch: FetchFunction;
  readonly world: PhaseDWorld;
  /** Every call of the page, in order (the CSRF token request excluded). */
  readonly calls: Call[];
  /** The calls to routes that match `method` and `path`. */
  readonly callsTo: (method: string, path: RegExp) => Call[];
  /** The Phase C handlers underneath (users, groups). */
  readonly directory: DirectoryApi;
  /** Make the next calls to this route fail with this answer; `null` removes it. */
  readonly override: (method: string, path: RegExp, answer: (() => Response) | null) => void;
}

const startsWithFold = (value: string | null, prefix: string): boolean =>
  value?.toLowerCase().startsWith(prefix.toLowerCase()) === true;

function byName<T extends { displayName: string | null }>(items: T[], order: 'asc' | 'desc'): T[] {
  return [...items].sort((a, b) => {
    const compare = (a.displayName ?? '').localeCompare(b.displayName ?? '');
    return order === 'asc' ? compare : -compare;
  });
}

/** One page of `items`, with an offset cursor (`c<offset>`): enough for the pages, which never read it. */
function pageOf<T>(
  items: readonly T[],
  query: { limit?: string | undefined; cursor?: string | undefined },
): { items: T[]; nextCursor?: string } {
  const limit = query.limit === undefined ? PAGE_LIMIT_DEFAULT : Number(query.limit);
  const offset = query.cursor === undefined ? 0 : Number(query.cursor.slice(1));
  const slice = items.slice(offset, offset + limit);
  return offset + limit >= items.length
    ? { items: slice }
    : { items: slice, nextCursor: `c${String(offset + limit)}` };
}

function validationFailed(pointer?: string, code?: string): Response {
  return problem(422, 'validation_failed', {
    ...(pointer === undefined || code === undefined ? {} : { errors: [{ pointer, code }] }),
  });
}

/** The first issue of a failed request parse as the `errors[]` entry the server sends: pointer and code. */
function issueOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): Response {
  const issue = error.issues[0];
  const pointer = `/${(issue?.path ?? []).map(String).join('/')}`.replace(/\/$/, '');
  const message = issue?.message ?? '';
  const code = /^[a-z][a-z0-9_]*$/.test(message) ? message : 'invalid';
  return validationFailed(pointer, code);
}

export function createPhaseDApi(world: PhaseDWorld = emptyPhaseDWorld()): PhaseDApi {
  const directory = createDirectoryApi(world);
  const calls: Call[] = [];
  const overrides: { method: string; path: RegExp; answer: () => Response }[] = [];

  const listItemOf = (detail: DistributionListDetail): DistributionListListItem => ({
    id: detail.id,
    displayName: detail.displayName,
    primarySmtpAddress: detail.primarySmtpAddress,
    kind: detail.kind,
    securityEnabled: detail.securityEnabled,
    memberCount: detail.memberCount,
    managers: detail.managers,
  });

  function findList(id: string): ListRecord | Response {
    const list = world.lists.find((candidate) => candidate.detail.id === id);
    return list ?? problem(404, 'not_found');
  }

  function findContact(id: string): ContactRecord | Response {
    const contact = world.contacts.find((candidate) => candidate.detail.id === id);
    return contact ?? problem(404, 'not_found');
  }

  /** Does something with this id exist that may be a member: a user or a contact. */
  function candidateOf(id: string): DistributionListMemberRow | null {
    const user = world.users.find((candidate) => candidate.id === id);
    if (user !== undefined) {
      return {
        kind: 'user',
        id: user.id,
        displayName: user.displayName,
        primarySmtpAddress: user.mail,
      };
    }
    const contact = world.contacts.find((candidate) => candidate.detail.id === id);
    if (contact !== undefined) {
      return {
        kind: 'contact',
        id: contact.detail.id,
        displayName: contact.detail.displayName,
        primarySmtpAddress: contact.detail.externalEmailAddress,
      };
    }
    return null;
  }

  // --- distribution lists -----------------------------------------------------------------------
  function listsList(call: Call): Response {
    const query = DistributionListListQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const { q, kind, order, limit, cursor } = query.data;
    const matching = world.lists
      .map((list) => list.detail)
      .filter(
        (detail) =>
          (q === undefined ||
            startsWithFold(detail.displayName, q) ||
            startsWithFold(detail.primarySmtpAddress, q)) &&
          (kind === 'all' || detail.kind === kind),
      );
    const page = pageOf(byName(matching, order), { limit, cursor });
    return json(
      200,
      DistributionListListResponseSchema.parse({ ...page, items: page.items.map(listItemOf) }),
    );
  }

  function listsMembers(id: string, call: Call): Response {
    const list = findList(id);
    if (list instanceof Response) return list;
    const query = DistributionListMembersQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    return json(200, DistributionListMembersResponseSchema.parse(pageOf(list.members, query.data)));
  }

  function listsCandidates(id: string, call: Call): Response {
    const list = findList(id);
    if (list instanceof Response) return list;
    const query = DistributionListCandidatesQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const { q, limit, cursor } = query.data;
    const memberIds = new Set(
      list.members
        .filter((row) => !isRestrictedMemberRow(row))
        .map((row) => (row as { id: string }).id),
    );
    const found = [
      ...world.users
        .filter((user) => startsWithFold(user.displayName, q) || startsWithFold(user.mail, q))
        .map((user) => ({
          kind: 'user' as const,
          id: user.id,
          displayName: user.displayName,
          mail: user.mail,
        })),
      ...world.contacts
        .filter(
          (contact) =>
            startsWithFold(contact.detail.displayName, q) ||
            startsWithFold(contact.detail.externalEmailAddress, q),
        )
        .map((contact) => ({
          kind: 'contact' as const,
          id: contact.detail.id,
          displayName: contact.detail.displayName,
          mail: contact.detail.externalEmailAddress,
        })),
    ];
    const page = pageOf(found, { limit, cursor });
    return json(
      200,
      DistributionListCandidatesResponseSchema.parse({
        ...page,
        items: page.items.map((item) => ({ ...item, alreadyMember: memberIds.has(item.id) })),
      }),
    );
  }

  /** The shared write: one result per id, the same rules for lists and groups. */
  function applyWrite(
    ids: readonly string[],
    mode: 'add' | 'remove',
    present: (id: string) => boolean,
    change: (id: string) => void,
    exists: (id: string) => boolean,
  ): MemberWriteItem[] {
    return ids.map((id): MemberWriteItem => {
      const reason = world.failing.get(id);
      if (reason !== undefined) return { id, result: 'failed', reason };
      if (!exists(id)) return { id, result: 'failed', reason: 'not_found' };
      if (mode === 'add') {
        if (present(id)) return { id, result: 'already' };
        change(id);
        return { id, result: 'added' };
      }
      if (!present(id)) return { id, result: 'already' };
      change(id);
      return { id, result: 'removed' };
    });
  }

  function listsWrite(id: string, call: Call, mode: 'add' | 'remove'): Response {
    const list = findList(id);
    if (list instanceof Response) return list;
    const body = DistributionListMemberWriteRequestSchema.safeParse(call.body);
    if (!body.success) return issueOf(body.error);
    if (list.detail.kind !== 'standard') return problem(409, 'read_only_object');
    const results = applyWrite(
      body.data.members,
      mode,
      (member) => list.members.some((row) => !isRestrictedMemberRow(row) && row.id === member),
      (member) => {
        if (mode === 'add') {
          const row = candidateOf(member);
          if (row !== null) list.members.push(row);
        } else {
          list.members = list.members.filter(
            (row) => isRestrictedMemberRow(row) || row.id !== member,
          );
        }
        list.detail = { ...list.detail, memberCount: list.members.length };
      },
      (member) => candidateOf(member) !== null || mode === 'remove',
    );
    return json(
      200,
      DistributionListMemberWriteResponseSchema.parse({
        results,
        summary: summariseMemberResults(results),
        readBackPending: world.readBackPending,
      }),
    );
  }

  // --- groups -----------------------------------------------------------------------------------
  function groupsWrite(id: string, call: Call, mode: 'add' | 'remove'): Response {
    const group = world.groups.find((candidate) => candidate.detail.id === id);
    if (group === undefined) return problem(404, 'not_found');
    const body = GroupMemberWriteRequestSchema.safeParse(call.body);
    if (!body.success) return issueOf(body.error);
    const { kind, membershipType, onPremisesSyncEnabled } = group.detail;
    if (
      (kind !== 'm365' && kind !== 'security') ||
      membershipType === 'dynamic' ||
      onPremisesSyncEnabled === true
    ) {
      return problem(409, 'read_only_object');
    }
    const results = applyWrite(
      body.data.members,
      mode,
      (member) => group.members.some((row) => 'id' in row && row.id === member),
      (member) => {
        const user = world.users.find((candidate) => candidate.id === member);
        const rows = group.members as unknown[];
        if (mode === 'add' && user !== undefined) {
          rows.push({
            kind: 'user',
            id: user.id,
            displayName: user.displayName,
            mail: user.mail,
            userPrincipalName: user.userPrincipalName,
          });
        } else {
          (group as unknown as { members: unknown[] }).members = rows.filter(
            (row) => (row as { id?: string }).id !== member,
          );
        }
      },
      (member) => world.users.some((candidate) => candidate.id === member) || mode === 'remove',
    );
    return json(
      200,
      GroupMemberWriteResponseSchema.parse({ results, summary: summariseMemberResults(results) }),
    );
  }

  // --- contacts ---------------------------------------------------------------------------------
  function contactsList(call: Call): Response {
    const query = ContactListQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const { q, order, limit, cursor } = query.data;
    const matching = world.contacts
      .map((contact) => contact.detail)
      .filter(
        (detail) =>
          q === undefined ||
          startsWithFold(detail.displayName, q) ||
          startsWithFold(detail.externalEmailAddress, q) ||
          startsWithFold(detail.alias, q),
      );
    const page = pageOf(byName(matching, order), { limit, cursor });
    return json(
      200,
      ContactListResponseSchema.parse({
        ...page,
        items: page.items.map((detail) => ({
          id: detail.id,
          displayName: detail.displayName,
          alias: detail.alias,
          externalEmailAddress: detail.externalEmailAddress,
          synced: detail.synced,
        })),
      }),
    );
  }

  function contactsLists(id: string, call: Call): Response {
    const contact = findContact(id);
    if (contact instanceof Response) return contact;
    const query = ContactListsQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const rows = (world.contactLists[id] ?? [])
      .map((listId) => world.lists.find((list) => list.detail.id === listId))
      .filter((list): list is ListRecord => list !== undefined)
      .map((list) => listItemOf(list.detail));
    return json(200, ContactListsResponseSchema.parse(pageOf(rows, query.data)));
  }

  function conflictOf(detail: Partial<ContactDetail>, except?: string): Response | null {
    const clash = (field: 'alias' | 'externalEmailAddress') =>
      detail[field] !== undefined &&
      world.contacts.some(
        (contact) => contact.detail.id !== except && contact.detail[field] === detail[field],
      );
    if (clash('externalEmailAddress')) {
      return problem(409, 'conflict', {
        errors: [{ pointer: '/externalEmailAddress', code: 'conflict' }],
      });
    }
    if (clash('alias')) {
      return problem(409, 'conflict', { errors: [{ pointer: '/alias', code: 'conflict' }] });
    }
    return null;
  }

  function contactsCreate(call: Call): Response {
    const body = ContactCreateRequestSchema.safeParse(call.body);
    if (!body.success) return issueOf(body.error);
    const clash = conflictOf(body.data);
    if (clash !== null) return clash;
    const detail = makeContact(world.contacts.length + 100, {
      displayName: body.data.displayName,
      alias: body.data.alias,
      externalEmailAddress: body.data.externalEmailAddress,
      firstName: body.data.firstName ?? null,
      lastName: body.data.lastName ?? null,
    });
    world.contacts.push({ detail });
    return json(201, ContactDetailSchema.parse(detail));
  }

  function contactsUpdate(id: string, call: Call): Response {
    const contact = findContact(id);
    if (contact instanceof Response) return contact;
    const body = ContactUpdateRequestSchema.safeParse(call.body);
    if (!body.success) return issueOf(body.error);
    if (contact.detail.synced === true) return problem(409, 'read_only_object');
    const clash = conflictOf(body.data, id);
    if (clash !== null) return clash;
    contact.detail = { ...contact.detail, ...body.data };
    return json(200, ContactDetailSchema.parse(contact.detail));
  }

  function contactsDelete(id: string, call: Call): Response {
    const contact = findContact(id);
    if (contact instanceof Response) return contact;
    const body = ContactDeleteRequestSchema.safeParse(call.body);
    if (!body.success) return issueOf(body.error);
    if (contact.detail.synced === true) return problem(409, 'read_only_object');
    if (body.data.confirmName !== contact.detail.displayName) {
      return validationFailed('/confirmName', 'confirm_mismatch');
    }
    const removedFrom = (world.contactLists[id] ?? [])
      .map((listId) => world.lists.find((list) => list.detail.id === listId))
      .filter((list): list is ListRecord => list !== undefined);
    for (const list of removedFrom) {
      list.members = list.members.filter((row) => isRestrictedMemberRow(row) || row.id !== id);
      list.detail = { ...list.detail, memberCount: list.members.length };
    }
    world.contacts = world.contacts.filter((candidate) => candidate.detail.id !== id);
    world.contactLists = Object.fromEntries(
      Object.entries(world.contactLists).filter(([key]) => key !== id),
    );
    return json(
      200,
      ContactDeleteResponseSchema.parse({
        removedFromLists: removedFrom.map((list) => ({
          id: list.detail.id,
          displayName: list.detail.displayName,
        })),
      }),
    );
  }

  // --- routing ----------------------------------------------------------------------------------
  type Handler = (match: RegExpExecArray, call: Call) => Response;
  const ROUTES: readonly (readonly [string, RegExp, Handler])[] = [
    ['GET', /^\/api\/v1\/distribution-lists$/, (_m, call) => listsList(call)],
    [
      'GET',
      /^\/api\/v1\/distribution-lists\/([^/]+)$/,
      (m) => {
        const list = findList(m[1] ?? '');
        return list instanceof Response
          ? list
          : json(200, DistributionListDetailSchema.parse(list.detail));
      },
    ],
    [
      'GET',
      /^\/api\/v1\/distribution-lists\/([^/]+)\/members$/,
      (m, call) => listsMembers(m[1] ?? '', call),
    ],
    [
      'POST',
      /^\/api\/v1\/distribution-lists\/([^/]+)\/members$/,
      (m, call) => listsWrite(m[1] ?? '', call, 'add'),
    ],
    [
      'DELETE',
      /^\/api\/v1\/distribution-lists\/([^/]+)\/members$/,
      (m, call) => listsWrite(m[1] ?? '', call, 'remove'),
    ],
    [
      'GET',
      /^\/api\/v1\/distribution-lists\/([^/]+)\/candidates$/,
      (m, call) => listsCandidates(m[1] ?? '', call),
    ],
    ['GET', /^\/api\/v1\/contacts$/, (_m, call) => contactsList(call)],
    ['POST', /^\/api\/v1\/contacts$/, (_m, call) => contactsCreate(call)],
    [
      'GET',
      /^\/api\/v1\/contacts\/([^/]+)$/,
      (m) => {
        const contact = findContact(m[1] ?? '');
        return contact instanceof Response
          ? contact
          : json(200, ContactDetailSchema.parse(contact.detail));
      },
    ],
    ['PATCH', /^\/api\/v1\/contacts\/([^/]+)$/, (m, call) => contactsUpdate(m[1] ?? '', call)],
    ['DELETE', /^\/api\/v1\/contacts\/([^/]+)$/, (m, call) => contactsDelete(m[1] ?? '', call)],
    ['GET', /^\/api\/v1\/contacts\/([^/]+)\/lists$/, (m, call) => contactsLists(m[1] ?? '', call)],
    [
      'POST',
      /^\/api\/v1\/groups\/([^/]+)\/members$/,
      (m, call) => groupsWrite(m[1] ?? '', call, 'add'),
    ],
    [
      'DELETE',
      /^\/api\/v1\/groups\/([^/]+)\/members$/,
      (m, call) => groupsWrite(m[1] ?? '', call, 'remove'),
    ],
  ];

  const network: FetchFunction = async (input, init) => {
    const url = new URL(input, 'http://panel.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.pathname === '/api/v1/csrf') {
      return json(200, { token: 'csrf-token-1', expiresAt: '2030-10-12T23:00:00.000Z' });
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method, path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    const taken = overrides.find(
      (override) => override.method === method && override.path.test(url.pathname),
    );
    if (taken !== undefined) return taken.answer();
    for (const [routeMethod, pattern, handler] of ROUTES) {
      if (routeMethod !== method) continue;
      const match = pattern.exec(url.pathname);
      if (match !== null) return handler(match, call);
    }
    return directory.fetch(input, init);
  };

  return {
    fetch: network,
    world,
    calls,
    callsTo: (method, path) =>
      calls.filter((call) => call.method === method && path.test(call.path)),
    directory,
    override: (method, path, answer) => {
      const index = overrides.findIndex(
        (o) => o.method === method && o.path.source === path.source,
      );
      if (index >= 0) overrides.splice(index, 1);
      if (answer !== null) overrides.push({ method, path, answer });
    },
  };
}
