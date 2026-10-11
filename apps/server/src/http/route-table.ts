// The route table (FR-A-031, PD-22, contract C4): one record per route and per fallback, kept as plain
// data so that the boot check, the OpenAPI parity check and the tests can read the declarations
// without touching the router.
//
// What the boot check refuses (every message names the route id and a rule, never a value that came
// from a definition):
//   - an entry that did not come through `defineRoute` or `defineFallback`;
//   - access that is not exactly one of `{ public: true }` or `{ permission }`, or a permission that
//     is not in the catalogue (the compiler stops both; this stops a cast and untyped JavaScript);
//   - a duplicate id, or two routes for one method and path;
//   - a write route outside `/api/v1`, a write route whose id is not an audit action (the id is the
//     `action` of its denial entries), or a rate class that does not fit the method;
//   - a fallback that is documented, or a route that is not.
//
// A path uses `{name}` for a parameter (the OpenAPI spelling). A fallback may end in `*`.
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A rate class, or `exempt` for the probes, the worker and the build output. */
export const RATE_SETTINGS = ['read', 'write', 'upload', 'exempt'] as const;
export type RateSetting = (typeof RATE_SETTINGS)[number];

/** A fallback may also take the class of the request's method (a 404 is rated like any request). */
export type FallbackRateSetting = RateSetting | 'by-method';

/** Exactly one of the two, or the route does not compile. */
export type RouteAccess =
  | { readonly public: true; readonly permission?: never }
  | { readonly permission: Permission; readonly public?: never };

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
const RATE_SET: ReadonlySet<unknown> = new Set([...RATE_SETTINGS, 'by-method']);
const PERMISSION_SET: ReadonlySet<unknown> = new Set(PERMISSIONS);

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
  if (!isRaw(access)) return 'declares no access: use { public: true } or { permission }';
  const isPublic = access.public === true;
  const hasPermission = 'permission' in access && access.permission !== undefined;
  if (access.public !== undefined && access.public !== true) {
    return 'declares public as something other than true; declare exactly one of public: true or permission';
  }
  if (isPublic === hasPermission) {
    return isPublic
      ? 'declares both public: true and a permission; declare exactly one'
      : 'declares no access: declare exactly one of public: true or permission';
  }
  if (hasPermission && !PERMISSION_SET.has(access.permission)) {
    return 'names a permission that is not in the catalogue';
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
      complain('rate must be read, write, upload or exempt');
    }

    const isWrite = methods.some((method) => method !== 'GET');
    if (isRoute && methods.length === 1 && METHOD_SET.has(methods[0])) {
      if (isWrite) {
        if (candidate.rateLimit !== 'write' && candidate.rateLimit !== 'upload') {
          complain('a write route is rated write or upload');
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
      } else if (candidate.rateLimit !== 'read' && candidate.rateLimit !== 'exempt') {
        complain('a GET route is rated read or exempt');
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
   * no route matches. A fallback does not count: it answers whatever is left over.
   */
  allowFor(path: string): readonly string[] {
    const methods = new Set<string>();
    for (const { entry, pattern } of this.#patterns) {
      if (!pattern.test(path)) continue;
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
