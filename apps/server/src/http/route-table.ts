// The route table (FR-A-031, PD-22, contract C4): one record per route and per fallback, kept as plain
// data so that the boot check, the OpenAPI parity check and the tests can read the declarations
// without touching the router.
//
// What the boot check refuses (every message names the route id and a rule, never a value that came
// from a definition):
//   - an entry that did not come through `defineRoute` or `defineFallback`;
//   - access that is not exactly one word of `public`, `authenticated`, `permission`, `setup` and
//     `connection`, a modifier on the wrong word, a permission that is not in the catalogue, or a
//     permission with a resource type that declares neither `scoped` nor `unscopedReason` (the
//     compiler stops most of it; this stops a cast and untyped JavaScript);
//   - a duplicate id, or two routes for one method and path;
//   - a write route outside `/api/v1`, a write route whose id is not an audit action (the id is the
//     `action` of its denial entries), or a rate class that does not fit the method or the path
//     (`auth` belongs to the sign-in paths, `setup` to `setup.status` and `setup.unlock`);
//   - `availability` that is not one of the two gates, `secFetch` anywhere but `auth.callback`,
//     `slidesSession: false` anywhere but the two polled reads, and a setup or connection route
//     without the gate or the setup or connection access (T-B-237);
//   - a fallback that is documented, or a route that is not.
//
// A path uses `{name}` for a parameter (the OpenAPI spelling). A fallback may end in `*`.
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '@m365portal/shared/permissions';
import { RESOURCE_TYPES, type ResourceType } from '@m365portal/shared/rbac/resources';
import { AVAILABILITY_GATES, type AvailabilityGate } from '../module.js';
import type { SessionActorKind } from '../policy/actor.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A rate class, or `exempt` for the probes, the worker and the build output. */
export const RATE_SETTINGS = ['read', 'write', 'upload', 'auth', 'setup', 'exempt'] as const;
export type RateSetting = (typeof RATE_SETTINGS)[number];

/** A fallback may also take the class of the request's method (a 404 is rated like any request). */
export type FallbackRateSetting = RateSetting | 'by-method';

/** The kinds a route may require with `actorKinds`: the ones that hold a session of some kind. */
export const SESSION_KINDS: readonly SessionActorKind[] = ['user', 'setup', 'break_glass'];

/** The words of the access declaration and the modifiers that go with them. */
type AccessKeys =
  | 'public'
  | 'authenticated'
  | 'permission'
  | 'setup'
  | 'connection'
  | 'actorKinds'
  | 'stepUp'
  | 'scoped'
  | 'unscopedReason';

/** `Own`, and every other key of the declaration forbidden: one word, its own modifiers, nothing else. */
type Exclusive<Own extends object> = Own &
  Readonly<Partial<Record<Exclude<AccessKeys, keyof Own>, never>>>;

/**
 * Exactly one access word, or the route does not compile (contracts section 1, plan 11.8):
 *
 *   public          no actor needed
 *   authenticated   a user or break-glass session (the setup actor is not authenticated in this sense)
 *   permission      a permission; `stepUp` for user actors, `actorKinds` to restrict the kind, and
 *                   `scoped` (the resource type the handler applies) or `unscopedReason` for a
 *                   permission that has a resource type (FR-B-505)
 *   setup           the setup actor
 *   connection      the setup actor while setup is open, otherwise `settings:connection`
 */
export type RouteAccess =
  | Exclusive<{ readonly public: true }>
  | Exclusive<{
      readonly authenticated: true;
      readonly actorKinds?: readonly SessionActorKind[];
    }>
  | Exclusive<{
      readonly permission: Permission;
      readonly stepUp?: true;
      readonly actorKinds?: readonly SessionActorKind[];
      readonly scoped?: ResourceType;
      readonly unscopedReason?: string;
    }>
  | Exclusive<{ readonly setup: true }>
  | Exclusive<{ readonly connection: true; readonly stepUp?: true }>;

export type AccessWord = 'public' | 'authenticated' | 'permission' | 'setup' | 'connection';

const ACCESS_WORDS: readonly AccessWord[] = [
  'public',
  'authenticated',
  'permission',
  'setup',
  'connection',
];

/** The word a declaration uses. The declaration is valid, or the table check has refused it. */
export function accessWordOf(access: RouteAccess): AccessWord {
  return ACCESS_WORDS.find((word) => access[word] !== undefined) ?? 'public';
}

/**
 * The one GET that Entra redirects to from another site (SB-25): the `Sec-Fetch-Site` rule of an
 * audited read does not apply to it. The list is closed.
 */
export const SEC_FETCH_EXEMPT_ROUTES: readonly string[] = ['auth.callback'];

/**
 * The polled reads that must not keep a user session alive (FR-B-420). The flag `slidesSession:
 * false` is accepted on these two routes and nowhere else.
 */
export const NON_SLIDING_ROUTES: readonly string[] = ['connection.log', 'connection.runs.current'];

/** The routes that may be rated in the `setup` class (FR-B-415). */
const SETUP_CLASS_ROUTES: readonly string[] = ['setup.status', 'setup.unlock'];

export interface RouteTableEntry {
  readonly kind: 'route' | 'fallback';
  readonly id: string;
  /** A route has exactly one method. */
  readonly methods: readonly HttpMethod[];
  /** A route has exactly one path. */
  readonly paths: readonly string[];
  readonly access: RouteAccess;
  readonly rateLimit: FallbackRateSetting;
  /** Is the entry part of the OpenAPI document? Always true for a route, always false for a fallback. */
  readonly openapi: boolean;
  /** The audit action a successful call writes. A GET that declares one also checks `Sec-Fetch-Site`. */
  readonly audit?: string | undefined;
  /** The gate that decides whether the route exists for a request (T-B-237). */
  readonly availability?: AvailabilityGate | undefined;
  /** `cross-site-allowed` on `auth.callback` only. */
  readonly secFetch?: 'cross-site-allowed' | undefined;
  /** Does a request keep a user session alive? Default true. */
  readonly slidesSession?: boolean | undefined;
}

/** The table check failed: the application must not start. `problems` lists every rule that broke. */
export class RouteTableError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`route table refused:\n  ${problems.join('\n  ')}`);
    this.name = 'RouteTableError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/** Dotted words: `health.live`, `branding.asset.stage`, `pwa.appleTouchIcon`. */
const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;
/** The audit writer's pattern for an `action`: what a write route's id and an audit action must fit. */
const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const PATH_CHARACTERS = /^\/[A-Za-z0-9._~\-/{}*]*$/;
const PARAMETER = /^\{[A-Za-z][A-Za-z0-9]*\}$/;
const API_PREFIX = '/api/v1/';

const METHOD_SET: ReadonlySet<unknown> = new Set(HTTP_METHODS);
const WRITE_CLASSES: ReadonlySet<unknown> = new Set(['write', 'upload', 'auth', 'setup']);
const READ_CLASSES: ReadonlySet<unknown> = new Set(['read', 'exempt', 'auth', 'setup']);
const AUTH_PATH = /^\/(?:api\/v1\/)?auth\//;
const RATE_SET: ReadonlySet<unknown> = new Set([...RATE_SETTINGS, 'by-method']);
const PERMISSION_SET: ReadonlySet<unknown> = new Set(PERMISSIONS);
const GATE_SET: ReadonlySet<unknown> = new Set(AVAILABILITY_GATES);
const SESSION_KIND_SET: ReadonlySet<unknown> = new Set(SESSION_KINDS);
const RESOURCE_TYPE_SET: ReadonlySet<unknown> = new Set(RESOURCE_TYPES);

type Raw = Readonly<Record<string, unknown>>;

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function label(entry: Raw, index: number): string {
  const { id } = entry;
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : `entry #${String(index + 1)}`;
}

/** Is this a path of the allowed grammar? Parameters are whole segments; `*` is a final segment. */
function pathProblem(path: unknown, allowWildcard: boolean): string | undefined {
  if (typeof path !== 'string' || !PATH_CHARACTERS.test(path)) {
    return 'a path starts with a slash and holds only letters, digits and . _ ~ - / { }';
  }
  const segments = path.split('/').slice(1);
  for (const [index, segment] of segments.entries()) {
    if (segment.includes('*')) {
      if (!allowWildcard) return 'a route path has no wildcard';
      if (segment !== '*' || index !== segments.length - 1) {
        return 'a wildcard is only allowed as the final segment';
      }
    } else if (/[{}]/.test(segment) && !PARAMETER.test(segment)) {
      return 'a parameter is a whole segment written {name}';
    }
  }
  return undefined;
}

function accessProblem(access: unknown): string | undefined {
  if (!isRaw(access)) {
    return 'declares no access: declare exactly one of public, authenticated, permission, setup or connection';
  }
  for (const word of ['public', 'authenticated', 'setup', 'connection'] as const) {
    if (access[word] !== undefined && access[word] !== true) {
      return `declares ${word} as something other than true; declare exactly one access word`;
    }
  }
  const present = ACCESS_WORDS.filter((word) => access[word] !== undefined);
  if (present.length !== 1) {
    return present.length === 0
      ? 'declares no access: declare exactly one of public, authenticated, permission, setup or connection'
      : `declares more than one access word (${present.join(', ')}); declare exactly one`;
  }
  const word = present[0];

  if (word === 'permission' && !PERMISSION_SET.has(access.permission)) {
    return 'names a permission that is not in the catalogue';
  }

  if (access.actorKinds !== undefined) {
    if (word !== 'authenticated' && word !== 'permission') {
      return 'actorKinds belongs to authenticated or permission access';
    }
    const kinds = access.actorKinds;
    if (
      !Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.some((k) => !SESSION_KIND_SET.has(k))
    ) {
      return `actorKinds is a non-empty list of ${SESSION_KINDS.join(', ')}`;
    }
  }

  if (access.stepUp !== undefined) {
    if (word !== 'permission' && word !== 'connection') {
      return 'stepUp belongs to permission or connection access';
    }
    if (access.stepUp !== true) return 'stepUp is true or absent';
  }

  if (access.scoped !== undefined || access.unscopedReason !== undefined) {
    if (word !== 'permission') return 'scoped and unscopedReason belong to permission access';
    if (access.scoped !== undefined && access.unscopedReason !== undefined) {
      return 'declares both scoped and unscopedReason; declare one';
    }
  }
  if (word === 'permission') {
    const permission = access.permission as Permission;
    const resource = PERMISSION_RESOURCE[permission];
    const reason = access.unscopedReason;
    const reasonDeclared = typeof reason === 'string' && reason.trim() !== '';
    if (access.unscopedReason !== undefined && !reasonDeclared) {
      return `${permission}: unscopedReason is a sentence; declare scoped or unscopedReason`;
    }
    if (access.scoped !== undefined) {
      if (!RESOURCE_TYPE_SET.has(access.scoped) || resource === null) {
        return `${permission} has no resource type, so scoped does not apply`;
      }
      if (access.scoped !== resource) {
        return `scoped names another resource type than ${permission} applies to (${resource})`;
      }
    } else if (resource !== null && !reasonDeclared) {
      return `names ${permission}, which has a resource type: declare scoped or unscopedReason`;
    }
  }
  return undefined;
}

/**
 * Every rule that the entries break, as readable lines. Empty for a correct table. The entries are
 * read as untyped data on purpose: the compiler has checked the declarations of the code that wrote
 * them, and this function is for the ones that got past it.
 */
export function validateRouteTable(entries: readonly unknown[]): string[] {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  const routeSlots = new Map<string, string[]>();

  for (const [index, candidate] of entries.entries()) {
    if (!isRaw(candidate)) {
      problems.push(`entry #${String(index + 1)} is not a table entry`);
      continue;
    }
    const name = label(candidate, index);
    const complain = (rule: string): void => {
      problems.push(`${name}: ${rule}`);
    };

    const { kind, id } = candidate;
    if (kind !== 'route' && kind !== 'fallback') {
      complain(
        'kind must be "route" or "fallback"; register through defineRoute or defineFallback',
      );
      continue;
    }
    const isRoute = kind === 'route';

    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      complain('id must be dotted words such as health.live');
    } else {
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }

    const accessFault = accessProblem(candidate.access);
    if (accessFault !== undefined) complain(accessFault);

    const methods = Array.isArray(candidate.methods) ? (candidate.methods as unknown[]) : [];
    if (methods.length === 0) complain('declares no method');
    if (isRoute && methods.length > 1) complain('a route has exactly one method');
    if (methods.some((method) => !METHOD_SET.has(method))) {
      complain(`method must be one of ${HTTP_METHODS.join(', ')} (HEAD follows GET)`);
    }

    const paths = Array.isArray(candidate.paths) ? (candidate.paths as unknown[]) : [];
    if (paths.length === 0) complain('declares no path');
    if (isRoute && paths.length > 1) complain('a route has exactly one path');
    for (const path of paths) {
      const fault = pathProblem(path, !isRoute);
      if (fault !== undefined) complain(`path: ${fault}`);
    }

    // `by-method` is for fallbacks only: a route names its class.
    if (!RATE_SET.has(candidate.rateLimit) || (isRoute && candidate.rateLimit === 'by-method')) {
      complain('rate must be read, write, upload, auth, setup or exempt');
    }

    const isWrite = methods.some((method) => method !== 'GET');
    if (isRoute && methods.length === 1 && METHOD_SET.has(methods[0])) {
      if (isWrite) {
        if (!WRITE_CLASSES.has(candidate.rateLimit)) {
          complain('a write route is rated write, upload, auth or setup');
        }
        const path = paths[0];
        if (typeof path === 'string' && !path.startsWith(API_PREFIX)) {
          complain('a write route lives under /api/v1');
        }
        if (typeof id === 'string' && !AUDIT_ACTION_PATTERN.test(id)) {
          complain(
            'a write route id must fit an audit action (lower case words), it is the action of its denial entries',
          );
        }
      } else if (!READ_CLASSES.has(candidate.rateLimit)) {
        complain('a GET route is rated read, exempt, auth or setup');
      }
    }

    if (isRoute && candidate.rateLimit === 'auth') {
      const path = paths[0];
      if (typeof path !== 'string' || !AUTH_PATH.test(path)) {
        complain('the auth class belongs to the sign-in paths /auth and /api/v1/auth');
      }
    }
    if (isRoute && candidate.rateLimit === 'setup') {
      if (typeof id !== 'string' || !SETUP_CLASS_ROUTES.includes(id)) {
        complain('the setup class belongs to setup.status and setup.unlock only');
      }
    }

    if (candidate.availability !== undefined) {
      if (!isRoute) complain('a fallback has no availability gate');
      else if (!GATE_SET.has(candidate.availability)) {
        complain(`availability must be one of ${AVAILABILITY_GATES.join(' or ')}`);
      }
    }

    if (candidate.secFetch !== undefined) {
      const getRoute = methods.length === 1 && methods[0] === 'GET';
      if (
        candidate.secFetch !== 'cross-site-allowed' ||
        !isRoute ||
        !getRoute ||
        typeof id !== 'string' ||
        !SEC_FETCH_EXEMPT_ROUTES.includes(id)
      ) {
        complain(
          `secFetch cross-site-allowed is accepted on a GET route of the list ${SEC_FETCH_EXEMPT_ROUTES.join(', ')} only`,
        );
      }
    }

    if (candidate.slidesSession !== undefined) {
      if (typeof candidate.slidesSession !== 'boolean') {
        complain('slidesSession is true or false');
      } else if (!candidate.slidesSession) {
        const getRoute = methods.length === 1 && methods[0] === 'GET';
        if (!isRoute || !getRoute || typeof id !== 'string' || !NON_SLIDING_ROUTES.includes(id)) {
          complain(
            `slidesSession: false is accepted on the GET routes ${NON_SLIDING_ROUTES.join(' and ')} only`,
          );
        }
      }
    }

    if (
      isRoute &&
      paths.length === 1 &&
      typeof paths[0] === 'string' &&
      accessFault === undefined
    ) {
      const path = paths[0];
      const gated =
        path.startsWith('/api/v1/setup/') ||
        path === '/api/v1/connection' ||
        path.startsWith('/api/v1/connection/');
      const access = candidate.access as Raw;
      if (gated && candidate.availability === undefined && !access.setup && !access.connection) {
        complain(
          'lives under /api/v1/setup or /api/v1/connection and carries neither the availability gate nor the setup or connection access',
        );
      }
    }

    if (candidate.audit !== undefined) {
      if (!isRoute) complain('a fallback writes no audit entry');
      else if (typeof candidate.audit !== 'string' || !AUDIT_ACTION_PATTERN.test(candidate.audit)) {
        complain('audit must be an action name such as branding.export');
      }
    }

    if (isRoute && candidate.openapi !== true)
      complain('a route must be documented (openapi: true)');
    if (!isRoute && candidate.openapi !== false) {
      complain('a fallback is never documented: declare openapi: false');
    }

    if (isRoute && methods.length === 1 && paths.length === 1) {
      const slot = `${String(methods[0])} ${String(paths[0])}`;
      routeSlots.set(slot, [...(routeSlots.get(slot) ?? []), name]);
    }
  }

  for (const [id, count] of ids) {
    if (count > 1) problems.push(`${id}: the id is declared more than once`);
  }
  for (const [slot, names] of routeSlots) {
    if (names.length > 1) {
      problems.push(
        `${slot}: more than one route claims this method and path (${names.join(', ')})`,
      );
    }
  }
  return problems;
}

/** Throws a `RouteTableError` unless the table is correct. The boot calls this before it listens. */
export function assertRouteTable(entries: readonly unknown[]): void {
  const problems = validateRouteTable(entries);
  if (problems.length > 0) throw new RouteTableError(problems);
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

function escapeForRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A path of the table (`/api/v1/things/{id}`, `/assets/*`) as a regular expression. */
export function pathPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => {
      if (segment === '*') return '.*';
      if (PARAMETER.test(segment)) return '[^/]+';
      return escapeForRegExp(segment);
    })
    .join('/');
  return new RegExp(`^${source}$`);
}

/** The path as the router spells it: `{id}` becomes `:id`. */
export function routerPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

export class RouteTable {
  readonly entries: readonly RouteTableEntry[];
  readonly routes: readonly RouteTableEntry[];
  readonly fallbacks: readonly RouteTableEntry[];
  readonly #patterns: readonly { entry: RouteTableEntry; pattern: RegExp }[];

  constructor(entries: readonly RouteTableEntry[]) {
    this.entries = entries;
    this.routes = entries.filter((entry) => entry.kind === 'route');
    this.fallbacks = entries.filter((entry) => entry.kind === 'fallback');
    this.#patterns = this.routes.map((entry) => ({
      entry,
      pattern: pathPattern(entry.paths[0] ?? ''),
    }));
  }

  /**
   * The methods the routes answer at `path`, sorted, with HEAD wherever there is a GET. Empty when
   * no route matches. A fallback does not count: it answers whatever is left over. `isOpen` lets the
   * caller leave out a route whose availability gate is closed for the request, so that a closed
   * route cannot show itself as a 405 (T-B-237).
   */
  allowFor(path: string, isOpen?: (entry: RouteTableEntry) => boolean): readonly string[] {
    const methods = new Set<string>();
    for (const { entry, pattern } of this.#patterns) {
      if (!pattern.test(path)) continue;
      if (isOpen !== undefined && !isOpen(entry)) continue;
      const method = entry.methods[0];
      if (method === undefined) continue;
      methods.add(method);
      if (method === 'GET') methods.add('HEAD');
    }
    return [...methods].sort();
  }
}

// ---------------------------------------------------------------------------------------------
// The router against the table
// ---------------------------------------------------------------------------------------------

/** One registration the router holds: a method (never `ALL`) and its path in the router's spelling. */
export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

/** What an application exposes of its router: Hono's `routes`. */
export interface HasRoutes {
  readonly routes: readonly { readonly method: string; readonly path: string }[];
}

/**
 * The method-specific registrations of an application, each once. Hono records one entry per handler
 * (every guard and validator of a route adds one), and `app.use` is `ALL`; neither says anything
 * about which routes exist.
 */
export function registeredRoutesOf(app: HasRoutes): RegisteredRoute[] {
  const seen = new Map<string, RegisteredRoute>();
  for (const { method, path } of app.routes) {
    if (method === 'ALL') continue;
    seen.set(`${method} ${path}`, { method, path });
  }
  return [...seen.values()];
}

/** The registrations the table calls for: each route once, each fallback once per method and path. */
export function expectedRegistrations(table: RouteTable): RegisteredRoute[] {
  const expected: RegisteredRoute[] = [];
  for (const entry of table.entries) {
    for (const method of entry.methods) {
      for (const path of entry.paths) expected.push({ method, path: routerPath(path) });
    }
  }
  return expected;
}

/**
 * Every method-specific route in the router is in the table, and every route of the table is in the
 * router. A route added with a direct `app.get`, or one that the wrapper failed to register, shows up
 * here. (The lint rule `no-direct-route-registration` is the first line; this is the second.)
 */
export function checkRouterAgainstTable(
  table: RouteTable,
  registered: readonly RegisteredRoute[],
): string[] {
  const problems: string[] = [];
  const held = new Set(registered.map(({ method, path }) => `${method} ${path}`));
  const expected = expectedRegistrations(table);
  const declared = new Set(expected.map(({ method, path }) => `${method} ${path}`));

  for (const slot of [...held].sort()) {
    if (!declared.has(slot)) problems.push(`${slot}: in the router but not in the route table`);
  }
  for (const entry of table.entries) {
    const missing = entry.methods.flatMap((method) =>
      entry.paths
        .filter((path) => !held.has(`${method} ${routerPath(path)}`))
        .map((path) => `${method} ${path}`),
    );
    if (missing.length > 0) {
      problems.push(
        `${entry.id}: in the route table but not in the router (${missing.join(', ')})`,
      );
    }
  }
  return problems;
}

export function assertRouterMatchesTable(
  table: RouteTable,
  registered: readonly RegisteredRoute[],
): void {
  const problems = checkRouterAgainstTable(table, registered);
  if (problems.length > 0) throw new RouteTableError(problems);
}
