// Shared setup of the directory route tests (T-C-022 to T-C-027). Not a test file.
//
// `createDirectoryFixture` is the real application over every module (the `rbac` api fixture, which
// mounts `appModules` and so the directory module) with the seeded fake directory behind the in-memory
// Graph client. Actors are signed in with exactly the grants a test names.
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import type { HttpClient } from '../helpers/http-client.js';
import { readJson } from '../helpers/http-client.js';
import { seedDirectory, type SeededDirectory } from '../fakes/fake-tenant/graph/seed-directory.js';
import { createApiFixture, type ApiFixture, type ApiFixtureOptions } from '../rbac/api-fixture.js';

export const FULL_USERS: Grant = { permission: 'users:read', qualifier: 'full', scope: 'all' };
export const BASIC_USERS: Grant = { permission: 'users:read', qualifier: 'basic', scope: 'all' };
export const ALL_GROUPS: Grant = { permission: 'groups:read', qualifier: 'full', scope: 'all' };

export function usersScoped(
  scope: readonly ScopeItem[],
  qualifier: 'full' | 'basic' = 'full',
): Grant {
  return { permission: 'users:read', qualifier, scope: [...scope] };
}
export function groupsScoped(scope: readonly ScopeItem[]): Grant {
  return { permission: 'groups:read', qualifier: 'full', scope: [...scope] };
}

export const DEPARTMENT_FINANCE: ScopeItem = {
  target: 'user',
  match: { by: 'department', value: 'Finance' },
};

export interface DirectoryFixture extends ApiFixture {
  readonly seeded: SeededDirectory;
  /** A signed-in user with exactly these grants. */
  actor(...grants: Grant[]): ReturnType<ApiFixture['signIn']>;
}

export async function createDirectoryFixture(
  options: ApiFixtureOptions & { users?: number; groups?: number } = {},
): Promise<DirectoryFixture> {
  const { users, groups, ...rest } = options;
  const fixture = await createApiFixture(rest);
  const seeded = seedDirectory(fixture.directory, {
    users: users ?? 300,
    groups: groups ?? 40,
  });
  return {
    ...fixture,
    seeded,
    actor: (...grants) => fixture.signIn({ kind: 'user', grants }),
  };
}

export interface Page<Row> {
  readonly items: Row[];
  readonly nextCursor?: string;
}

/** `GET path?params` as JSON with its status. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape of the answer
export async function getJson<T = unknown>(
  client: HttpClient,
  path: string,
  params: Readonly<Record<string, string | undefined>> = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await client.get(query === '' ? path : `${path}?${query}`);
  const text = await response.clone().text();
  return {
    status: response.status,
    body: (text === '' ? null : await readJson(response)) as T,
    headers: response.headers,
  };
}

/** Follows `nextCursor` to the end and returns every row and the number of requests. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the row type of the list
export async function walk<Row>(
  client: HttpClient,
  path: string,
  params: Readonly<Record<string, string | undefined>> = {},
  maxPages = 200,
): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const answer = await getJson<Page<Row>>(client, path, { ...params, cursor });
    if (answer.status !== 200) throw new Error(`${path} answered ${String(answer.status)}`);
    rows.push(...answer.body.items);
    cursor = answer.body.nextCursor;
    pages += 1;
    if (pages > maxPages) throw new Error(`${path} does not end`);
  } while (cursor !== undefined);
  return { rows, pages };
}

export interface ProblemBody {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { pointer: string; code: string }[];
}
