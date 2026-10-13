// Shared setup of the Phase D route tests (T-D-118 to T-D-123). Not a test file.
//
// `createListsFixture` is the real application over every module (the `rbac` api fixture, which mounts
// `appModules`), with the in-memory Graph client and the in-memory Exchange client behind the registry,
// and a small world in which the two agree: users of the directory that also exist as recipients of
// Exchange (their `ExternalDirectoryObjectId` is the Entra object id), distribution lists of the three
// kinds, mail contacts, and one user without a mailbox address.
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import type { ExchangeClient } from '../../src/ports/exchange.js';
import type { FakeExchangeClient } from '../fakes/fake-exchange-client.js';
import type { FakeDistributionGroup, FakeRecipient } from '../fakes/fake-tenant/exchange/index.js';
import { readJson, type HttpClient } from '../helpers/http-client.js';
import { createApiFixture, type ApiFixture, type ApiFixtureOptions } from '../rbac/api-fixture.js';

export const DOMAIN = 'contoso-fake.example';

export const READ_LISTS: Grant = {
  permission: 'distributionlists:read',
  qualifier: 'full',
  scope: 'all',
};
export const WRITE_MEMBERS: Grant = {
  permission: 'distributionlists:members:write',
  qualifier: 'full',
  scope: 'all',
};
export const READ_CONTACTS: Grant = {
  permission: 'contacts:read',
  qualifier: 'full',
  scope: 'all',
};
export const CREATE_CONTACTS: Grant = {
  permission: 'contacts:create',
  qualifier: 'full',
  scope: 'all',
};
export const UPDATE_CONTACTS: Grant = {
  permission: 'contacts:update',
  qualifier: 'full',
  scope: 'all',
};
export const DELETE_CONTACTS: Grant = {
  permission: 'contacts:delete',
  qualifier: 'full',
  scope: 'all',
};
export const READ_USERS: Grant = { permission: 'users:read', qualifier: 'full', scope: 'all' };
export const READ_GROUPS: Grant = { permission: 'groups:read', qualifier: 'full', scope: 'all' };
export const WRITE_GROUP_MEMBERS: Grant = {
  permission: 'groups:members:write',
  qualifier: 'full',
  scope: 'all',
};

export function scoped(
  permission: Grant['permission'],
  scope: readonly ScopeItem[],
  qualifier: 'full' | 'basic' = 'full',
): Grant {
  return { permission, qualifier, scope: [...scope] };
}

export const listPrefix = (value: string): ScopeItem => ({
  target: 'distributionList',
  match: { by: 'prefix', attr: 'displayName', value },
});
export const listId = (id: string): ScopeItem => ({
  target: 'distributionList',
  match: { by: 'id', id },
});
export const contactPrefix = (
  attr: 'displayName' | 'alias' | 'mail',
  value: string,
): ScopeItem => ({
  target: 'contact',
  match: { by: 'prefix', attr, value },
});

export interface ListsWorld {
  /** Entra users that are also Exchange recipients, by first name. */
  readonly users: Record<'alice' | 'bob' | 'carol', { id: string; recipient: FakeRecipient }>;
  /** A user of the directory with no mailbox address (EC-D3). */
  readonly noMail: { id: string };
  /** A Microsoft 365 group of the directory (a type a list does not take). */
  readonly m365Group: { id: string };
  readonly lists: {
    readonly marketing: FakeDistributionGroup;
    readonly sales: FakeDistributionGroup;
    readonly salesEu: FakeDistributionGroup;
    readonly dynamic: FakeDistributionGroup;
    readonly synced: FakeDistributionGroup;
  };
  readonly contacts: { readonly dave: FakeRecipient; readonly erin: FakeRecipient };
}

export interface ListsFixture extends ApiFixture {
  readonly world: ListsWorld;
  /** A signed-in user with exactly these grants (a fresh step-up). */
  actor(...grants: Grant[]): ReturnType<ApiFixture['signIn']>;
  /** The same with a stale step-up. */
  staleActor(...grants: Grant[]): ReturnType<ApiFixture['signIn']>;
}

export async function createListsFixture(options: ApiFixtureOptions = {}): Promise<ListsFixture> {
  const f = await createApiFixture(options);
  const state = f.exchangeState;
  const person = (name: string, department: string) => {
    const lower = name.toLowerCase();
    const user = f.directory.addUser({
      userPrincipalName: `${lower}@${DOMAIN}`,
      displayName: `${name} Example`,
      mail: `${lower}@${DOMAIN}`,
      department,
    });
    const recipient = state.addRecipient({
      displayName: `${name} Example`,
      primarySmtpAddress: `${lower}@${DOMAIN}`,
      externalDirectoryObjectId: user.id,
    });
    return { id: user.id, recipient };
  };
  const alice = person('Alice', 'Finance');
  const bob = person('Bob', 'Sales');
  const carol = person('Carol', 'Sales');
  const noMail = f.directory.addUser({
    userPrincipalName: `nomail@${DOMAIN}`,
    displayName: 'No Mail',
    mail: null,
  });
  const m365Group = f.directory.addGroup({
    displayName: 'Project Phoenix',
    mailNickname: 'phoenix',
    mail: `phoenix@${DOMAIN}`,
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
  });

  const list = (
    name: string,
    extra: Partial<Parameters<typeof state.addDistributionGroup>[0]> = {},
  ) =>
    state.addDistributionGroup({
      name,
      primarySmtpAddress: `${name.toLowerCase().replaceAll(' ', '-')}@${DOMAIN}`,
      managedByApp: true,
      ...extra,
    });
  const lists = {
    marketing: list('Marketing'),
    sales: list('Sales'),
    salesEu: list('Sales EU'),
    dynamic: list('Dynamic Staff', { recipientTypeDetails: 'DynamicDistributionGroup' }),
    synced: list('Synced Board', { isDirSynced: true }),
  };
  const contacts = {
    dave: state.addMailContact({
      displayName: 'Dave Outside',
      alias: 'dave.outside',
      externalEmailAddress: 'dave@elsewhere.example',
    }),
    erin: state.addMailContact({
      displayName: 'Erin Partner',
      alias: 'erin.partner',
      externalEmailAddress: 'erin@partner.example',
    }),
  };
  state.distributionGroups.get(lists.marketing.guid)?.members.push(alice.recipient, contacts.dave);

  return {
    ...f,
    world: {
      users: { alice, bob, carol },
      noMail: { id: noMail.id },
      m365Group: { id: m365Group.id },
      lists,
      contacts,
    },
    actor: (...grants) => f.signIn({ kind: 'user', grants, stepUpAgoMs: 60_000 }),
    staleActor: (...grants) => f.signIn({ kind: 'user', grants, stepUpAgoMs: null }),
  };
}

export interface ProblemBody {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { pointer: string; code: string }[];
}

export interface Page<Row> {
  readonly items: Row[];
  readonly nextCursor?: string;
}

/** A request and its JSON answer. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape of the answer
export async function call<T = unknown>(
  client: HttpClient,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await client.request(method, path, body === undefined ? {} : { json: body });
  const text = await response.clone().text();
  return {
    status: response.status,
    body: (text === '' ? null : await readJson(response)) as T,
    headers: response.headers,
  };
}

/** Follows `nextCursor` to the end. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the row type of the list
export async function walkAll<Row>(
  client: HttpClient,
  path: string,
  params: Readonly<Record<string, string>> = {},
): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const query = new URLSearchParams({ ...params, ...(cursor === undefined ? {} : { cursor }) });
    const answer = await call<Page<Row>>(client, 'GET', `${path}?${query.toString()}`);
    if (answer.status !== 200) throw new Error(`${path} answered ${String(answer.status)}`);
    rows.push(...answer.body.items);
    cursor = answer.body.nextCursor;
    pages += 1;
    if (pages > 500) throw new Error(`${path} does not end`);
  } while (cursor !== undefined);
  return { rows, pages };
}

type Method = keyof FakeExchangeClient;

/**
 * The in-memory Exchange client with some methods replaced: `override(original)(...args)` runs in place of
 * the method, and `original` is the bound method of the fake. Every other member is the fake's own, bound to it.
 */
export function wrapExchange(
  fake: FakeExchangeClient,
  overrides: Partial<
    Record<Method, (original: (...args: never[]) => unknown) => (...args: never[]) => unknown>
  >,
): ExchangeClient {
  return new Proxy(fake, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: never[]) => unknown).bind(target);
      const wrap = overrides[property as Method];
      return wrap === undefined ? bound : wrap(bound);
    },
  });
}

/** Makes the `nth` (1-based) call of `method` throw `error`; the others run. */
export function failingOn(method: Method, nth: number, error: Error) {
  return (fake: FakeExchangeClient): ExchangeClient => {
    let count = 0;
    return wrapExchange(fake, {
      [method]:
        (original: (...args: never[]) => unknown) =>
        (...args: never[]) => {
          count += 1;
          if (count === nth) return Promise.reject(error);
          return original(...args);
        },
    });
  };
}
