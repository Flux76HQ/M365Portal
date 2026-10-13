// The directory of Phase C for the end-to-end specs (T-C-060, FR-C-602): the seeded fake tenant and the three
// actors of the users and groups pages.
//
//   full     the Owner: `users:read` and `groups:read` on everything
//   scoped   `scoped-viewer`: the Reader role with `users:read` limited to the department "Finance". Made
//            through the real RBAC API by the Owner, with a step-up, exactly as a person would
//   basic    `basic-viewer`: `users:read` with the qualifier `basic` (id, name and address only) and
//            `groups:read` in full. The API cannot make that role in Phase C (the template "board" is
//            assignable only from Phase D), so the role and its assignment are written to the database
//            directly, as `support/database.ts` does for the other things the API refuses on purpose
//
// `createDirectoryWorld` seeds the directory (`directory.seed` of the fake tenant: 1,200 users and 150
// groups of every kind) and gives the two actors their rights; `destroy` takes all of it back, so that the
// shared tenant and the shared database are what other specs expect. A spec file calls the first in
// `beforeAll` and the second in `afterAll`. Signing in as an actor is `app.signInAs(actor.principal, ...)`
// in a test that starts without a session (`test.use({ principal: 'anonymous' })`).
import type { Browser } from '@playwright/test';
import { readState } from '../servers.js';
import { ApiClient } from '../support/api-client.js';
import { freshClientAddress } from '../support/client-address.js';
import {
  deleteCustomRole,
  insertAssignmentDirectly,
  insertCustomRole,
} from '../support/database.js';
import { fakeControl, type DirectorySeedSummary } from '../support/fake-control.js';
import { originOf } from '../support/ports.js';
import { PRINCIPALS, type PrincipalName } from '../support/principals.js';
import { signInAs } from '../support/sign-in.js';
import type { AllowedResponse } from '../fixtures.js';
import type { DirectoryState } from '../routes.js';

/** The key of the custom role of the basic actor. */
export const BASIC_ROLE_KEY = 'e2e_basic_users';

/** The department the scoped actor is limited to. The seeded directory has users of it and of six others. */
export const SCOPED_DEPARTMENT = 'Finance';

export type DirectoryActorName = 'full' | 'scoped' | 'basic';

export interface DirectoryActor {
  readonly name: DirectoryActorName;
  /** The principal to pass to `app.signInAs`. */
  readonly principal: PrincipalName;
  readonly description: string;
}

/** The actors, by name. `full` is the Owner, who is signed in at the start of every test by default. */
export const DIRECTORY_ACTORS: Readonly<Record<DirectoryActorName, DirectoryActor>> = {
  full: { name: 'full', principal: 'owner', description: 'users:read and groups:read, everywhere' },
  scoped: {
    name: 'scoped',
    principal: 'scoped-viewer',
    description: `users:read limited to the department ${SCOPED_DEPARTMENT}, groups:read everywhere`,
  },
  basic: {
    name: 'basic',
    principal: 'basic-viewer',
    description: 'users:read basic (id, name, email), groups:read everywhere',
  },
};

export interface DirectoryWorld {
  readonly facts: DirectorySeedSummary;
  readonly actors: typeof DIRECTORY_ACTORS;
  /** Takes the actors' rights, the seeded rows and the switches back. Safe to call twice. */
  destroy(): Promise<void>;
}

const SESSION_COOKIE = 'm365portal_session';

/** An API client signed in as the Owner with a fresh step-up, and the way to end that session again. */
export async function ownerWithStepUp(
  browser: Browser,
): Promise<{ readonly api: ApiClient; close(): Promise<void> }> {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'x-forwarded-for': freshClientAddress() },
  });
  try {
    const page = await context.newPage();
    await signInAs(page, 'owner');
    await signInAs(page, 'owner', { purpose: 'stepup' });
    const cookie = (await context.cookies(originOf('a'))).find(
      (candidate) => candidate.name === SESSION_COOKIE,
    );
    if (cookie === undefined) throw new Error('the Owner sign-in left no session cookie');
    const api = new ApiClient('a', { [SESSION_COOKIE]: cookie.value });
    return {
      api,
      async close() {
        // The session is ended so that a run does not pile up live sessions of the Owner (at most ten).
        await api.post('/api/v1/auth/logout').catch(() => undefined);
        await context.close();
      },
    };
  } catch (failure) {
    await context.close();
    throw failure;
  }
}

/** Creates the department-scoped assignment through the real API; returns the id of the assignment. */
async function assignScoped(api: ApiClient): Promise<string> {
  const response = await api.post('/api/v1/rbac/assignments', {
    principalType: 'user',
    principalId: PRINCIPALS['scoped-viewer'].oid,
    role: 'reader',
    scope: [{ target: 'user', match: { by: 'department', value: SCOPED_DEPARTMENT } }],
  });
  if (response.status !== 201) {
    throw new Error(`the scoped assignment answered ${String(response.status)} (expected 201)`);
  }
  return (response.json() as { id: string }).id;
}

export async function createDirectoryWorld(browser: Browser): Promise<DirectoryWorld> {
  const fake = fakeControl('a');
  const dataDir = readState().instances.a.dataDir;
  let scopedAssignment: string | undefined;
  let basicRole = false;
  let destroyed = false;

  const world: DirectoryWorld = {
    // Replaced below, once the seed has answered.
    facts: undefined as unknown as DirectorySeedSummary,
    actors: DIRECTORY_ACTORS,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      if (basicRole) deleteCustomRole(dataDir, BASIC_ROLE_KEY);
      if (scopedAssignment !== undefined) {
        const owner = await ownerWithStepUp(browser);
        try {
          await owner.api.delete(`/api/v1/rbac/assignments/${scopedAssignment}`);
        } finally {
          await owner.close();
        }
      }
      await fake.managerForApps('refused');
      await fake.hiddenMembersRefused(true);
      await fake.omitGroupProperties(false);
      await fake.unseedDirectory();
    },
  };

  try {
    const facts = await fake.seedDirectory();
    const owner = await ownerWithStepUp(browser);
    try {
      scopedAssignment = await assignScoped(owner.api);
    } finally {
      await owner.close();
    }
    insertCustomRole(dataDir, BASIC_ROLE_KEY, [
      { permission: 'users:read', qualifier: 'basic' },
      { permission: 'groups:read' },
    ]);
    basicRole = true;
    insertAssignmentDirectly(dataDir, {
      oid: PRINCIPALS['basic-viewer'].oid,
      role: BASIC_ROLE_KEY,
    });
    return { ...world, facts };
  } catch (failure) {
    await world.destroy().catch(() => undefined);
    throw failure;
  }
}

/** Only the seeded rows and the switches, for the specs that need no actor besides the Owner. */
export async function seedDirectoryOnly(): Promise<{
  readonly facts: DirectorySeedSummary;
  destroy(): Promise<void>;
}> {
  const fake = fakeControl('a');
  const facts = await fake.seedDirectory();
  return {
    facts,
    async destroy() {
      await fake.managerForApps('refused');
      await fake.hiddenMembersRefused(true);
      await fake.omitGroupProperties(false);
      await fake.unseedDirectory();
    },
  };
}

/** An API client for the session the page's context holds (to read the same routes the page reads). */
export async function apiOf(context: {
  cookies(url: string): Promise<{ name: string; value: string }[]>;
}): Promise<ApiClient> {
  const cookie = (await context.cookies(originOf('a'))).find(
    (candidate) => candidate.name === SESSION_COOKIE,
  );
  if (cookie === undefined) throw new Error('the context holds no session of the panel');
  return new ApiClient('a', { [SESSION_COOKIE]: cookie.value });
}

/** One page of a cursor list, as the API sends it. */
export interface ApiPage<Row> {
  readonly items: readonly Row[];
  readonly nextCursor?: string;
}

/** Reads a cursor list to its end through the API (a guard against a page that loops or skips). */
export async function walkApi<Row>(
  api: ApiClient,
  path: string,
  query: Readonly<Record<string, string>> = {},
  maxPages = 200,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ limit: '200', ...query });
    if (cursor !== undefined) params.set('cursor', cursor);
    const response = await api.get(`${path}?${params.toString()}`);
    if (response.status !== 200) throw new Error(`${path} answered ${String(response.status)}`);
    const body = response.json() as ApiPage<Row>;
    rows.push(...body.items);
    if (body.nextCursor === undefined) return rows;
    cursor = body.nextCursor;
  }
  throw new Error(`${path} had more than ${String(maxPages)} pages`);
}

/** A well-formed id that names nobody: the detail routes answer 404. */
export const UNKNOWN_ID = '00000000-0000-4000-8000-0000000fffff';

/** The id of a seeded row by the key a state names (`DirectoryState.seeded`). */
export function seededId(facts: DirectorySeedSummary, key: string): string {
  if (key === 'unknownId') return UNKNOWN_ID;
  const row =
    key === 'financeUserWithOutsideManager'
      ? facts.financeUserWithOutsideManager
      : key === 'outsideUser'
        ? facts.outsideUser
        : key === 'financeUser'
          ? facts.financeUser
          : null;
  const id = row?.id ?? facts.ids[key];
  if (id === undefined) throw new Error(`the seed has no row ${key}`);
  return id;
}

/** The address a state is on. */
export function pathOfState(facts: DirectorySeedSummary, state: DirectoryState): string {
  if (state.path !== undefined) return state.path;
  if (state.route === undefined || state.seeded === undefined) {
    throw new Error(`the state ${state.slug} names neither a path nor a route`);
  }
  return state.route.replace('$id', seededId(facts, state.seeded));
}

/**
 * The answers of 4xx and 5xx that are the point of a state and not a misbehaving page, for the `guard` of the
 * fixtures: an object outside the scope (403), an object that does not exist (404), the server stand-in that
 * fails (503), and the memberships a `basic` actor's detail page asks for before it knows it is a basic one
 * (403, recorded in the gate note GC2).
 */
export function expectedProblemsOf(
  facts: DirectorySeedSummary,
  state: DirectoryState,
): AllowedResponse[] {
  const allowed: AllowedResponse[] = [];
  if (state.mock === 'users-unavailable') allowed.push({ status: 503, url: '/api/v1/users' });
  if (state.route !== undefined && state.seeded !== undefined) {
    const base = `${state.route.startsWith('/users') ? '/api/v1/users' : '/api/v1/groups'}/${seededId(facts, state.seeded)}`;
    if (state.seeded === 'unknownId') allowed.push({ status: 404, url: base });
    if (state.seeded === 'outsideUser') allowed.push({ status: 403, url: base });
    if (state.actor === 'basic' && state.route === '/users/$id') {
      allowed.push({ status: 403, url: `${base}/groups` });
    }
  }
  return allowed;
}
