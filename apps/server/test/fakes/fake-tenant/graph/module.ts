// The fake Microsoft Graph (T-B-065, FR-B-707; plan 14.2; research-microsoft-b.md sections 2, 3, 8
// and 10): the endpoints of the call sheet (spec 6.3.1) and of `GraphClient`, mounted on the fake
// tenant core with `core.router.add`, and nothing else. A request to any other path is the core's
// 404; a method the path does not have is its 405.
//
// What makes it strict (a lenient fake gives false greens, baseline section 2):
//   - every call needs an access token the world issued: unknown, expired or issued for another
//     resource is 401; a token without the permission Learn lists for the call is 403;
//   - the delegated calls that grant roles need a signed-in user who holds Global Administrator or
//     Privileged Role Administrator (research 2.5);
//   - request bodies are allow-listed: a property the application resource does not have is 400, as
//     it is on Graph; ids are checked as GUIDs; `redirectUris` follow reply-url rules;
//   - `$select` outside the entity's property catalog is 400, a call without `$select` returns only
//     the default set (a user without `$select=accountEnabled,department` has neither);
//   - `PATCH keyCredentials` REPLACES the collection; `key` comes back only for a single application
//     read with `$select=keyCredentials`;
//   - `checkMemberGroups` refuses more than 20 ids and any malformed id, evaluates nested groups,
//     and leaves hidden-membership groups out without `Member.Read.Hidden`;
//   - the toggles of `FakeGraphControl` produce replication delay, throttling in both `Retry-After`
//     forms, 5xx, duplicate-grant behaviour (U31), the unknown-group answer (U38), an application
//     management policy that refuses a credential lifetime (U19), an unreadable credential count
//     (U50) and paging.
//
// The module serves `graph.microsoft.com` under `/v1.0`. It knows nothing of Entra: tokens come from
// the shared `FakeWorld`, which the fake Entra module fills when it answers a token request.
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { jsonResponse } from '../index.js';
import type { FakeTenantCore, FakeTenantModule, RouteContext } from '../types.js';
import {
  ENTRA_ROLE_TEMPLATES,
  InvalidCertificateError,
  type GroupRecord,
  type ApplicationRecord,
  type AppRoleAssignmentRecord,
  type KeyCredentialRecord,
  type ServicePrincipalRecord,
} from './directory.js';
import { isGuidText } from './ids.js';
import { FilterError, evaluate, parseFilter, parseSelect, project } from './odata.js';
import {
  GROUP_ADVANCED_STARTS_WITH,
  GROUP_FILTER_PROPERTIES,
  GROUP_ORDER_PROPERTIES,
  USER_ADVANCED_STARTS_WITH,
  USER_FILTER_PROPERTIES,
  USER_ORDER_PROPERTIES,
  decodeSkipToken,
  encodeSkipToken,
  hasNoOwnersInGraph,
  parseListQuery,
  reasonsOf,
  selectGroups,
  selectUsers,
} from './lists.js';
import {
  APPLICATION_CATALOG,
  APPLICATION_DEFAULTS,
  APPLICATION_WRITABLE,
  GROUP_CATALOG,
  GROUP_DEFAULTS,
  ORGANIZATION_CATALOG,
  SERVICE_PRINCIPAL_CATALOG,
  SERVICE_PRINCIPAL_DEFAULTS,
  USER_CATALOG,
  USER_DEFAULTS,
  renderApplication,
  renderGroup,
  renderOrganization,
  renderServicePrincipal,
  renderUser,
} from './render.js';
import {
  applyAdd,
  applyRemove,
  checkAdd,
  checkRemove,
  deleteObject,
  deletePermissionFor,
  type RemoveNonMember,
} from './member-writes.js';
import type { FakeWorld, IssuedToken } from './tokens.js';

const HOST = 'graph.microsoft.com';
const BASE = '/v1.0';
const ORIGIN = 'https://graph.microsoft.com';
const META = `${ORIGIN}${BASE}/$metadata#`;

// ---------------------------------------------------------------------------------------------
// The control surface
// ---------------------------------------------------------------------------------------------

export interface ThrottleSpec {
  /** How many matching requests answer 429. */
  readonly times: number;
  /** Seconds in `Retry-After`; `null` leaves the header out. Default 1. */
  readonly seconds?: number | null;
  /** `seconds` (default) or an HTTP date relative to the injected clock. */
  readonly form?: 'seconds' | 'httpDate';
  /** Only requests whose `METHOD /path` matches. */
  readonly match?: RegExp;
}

export interface FailureSpec {
  readonly times: number;
  readonly status: 500 | 502 | 503 | 504;
  readonly match?: RegExp;
}

export type DuplicateGrantMode = 'idempotent' | 'conflict' | 'bad_request';

export interface FakeGraphControl {
  /**
   * A number of calls that still see "not found" for an object created from now on (research 10.2).
   * A number applies to applications, service principals and groups alike.
   */
  replicationDelay(
    delay: number | { applications?: number; servicePrincipals?: number; groups?: number },
  ): void;
  throttle(spec: ThrottleSpec): void;
  failWith(spec: FailureSpec): void;
  /** U31: what a second grant of the same app role or directory role does. Default `conflict`. */
  duplicateGrants(mode: DuplicateGrantMode): void;
  /** U38: what `checkMemberGroups` does with a well-formed id that names no group. Default `omit`. */
  unknownGroupId(mode: 'omit' | 'bad_request'): void;
  /** U19: an application management policy that refuses a credential valid for longer than this. */
  credentialLifetimePolicy(maxDays: number | null): void;
  /** U14: refuse `http://localhost` redirect URIs, as a tenant policy might. */
  rejectLocalhostRedirectUris(on: boolean): void;
  /** U50: reading `passwordCredentials`, `keyCredentials` or `owners` is refused with 403. */
  credentialsReadable(on: boolean): void;
  /** U37: `GET /groups?$filter=...` needs `ConsistencyLevel: eventual`. Default off. */
  groupFilterNeedsConsistencyLevel(on: boolean): void;
  /** Items per page for collections; `null` is the default of 100. */
  pageSize(size: number | null): void;
  /**
   * U66: does `GET /users/{id}/manager` work for an application token? `refused` (default) answers 403,
   * which is the reading of "Application: Not supported" on the List manager page; `allowed` answers as
   * for a delegated token (404 for a user without a manager).
   */
  managerForApps(mode: 'refused' | 'allowed'): void;
  /**
   * U67: what a hidden-membership group answers to its members without `Member.Read.Hidden`. `true`
   * (default) is 403; `false` is an empty list. The group is also left out of `transitiveMemberOf` while
   * this is on.
   */
  hiddenMembersRefused(on: boolean): void;
  /**
   * U36, U69: a group row comes back without `visibility`, `description`, `mailNickname` and
   * `onPremisesSyncEnabled` (they are `null`), as if `GroupMember.Read.All` returned basic properties only.
   */
  omitGroupProperties(on: boolean): void;
  /** Rewrites the `@odata.nextLink` of a page (hostile links for the URL discipline tests). */
  rewriteNextLink(rewrite: ((link: string) => string) | null): void;
  /**
   * U93: what `DELETE /groups/{id}/members/{id}/$ref` answers for an object that is not a member. The
   * page is silent; `not_found` (404, default) or `no_content` (204).
   */
  removeNonMember(mode: RemoveNonMember): void;
  /** Counts of what the fake received, for tests that assert on behaviour the call record cannot show. */
  readonly stats: { readonly policyRefusals: number; readonly objectsDeleted: number };
}

interface Faults {
  throttles: { spec: ThrottleSpec; left: number }[];
  failures: { spec: FailureSpec; left: number }[];
}

interface Settings {
  delays: { applications: number; servicePrincipals: number; groups: number };
  duplicates: DuplicateGrantMode;
  unknownGroup: 'omit' | 'bad_request';
  maxCredentialDays: number | null;
  rejectLocalhost: boolean;
  credentialsReadable: boolean;
  groupFilterNeedsConsistency: boolean;
  pageSize: number | null;
  rewriteNextLink: ((link: string) => string) | null;
  managerForApps: 'refused' | 'allowed';
  hiddenMembersRefused: boolean;
  omitGroupProperties: boolean;
  removeNonMember: RemoveNonMember;
}

function defaultSettings(): Settings {
  return {
    delays: { applications: 0, servicePrincipals: 0, groups: 0 },
    duplicates: 'conflict',
    unknownGroup: 'omit',
    maxCredentialDays: null,
    rejectLocalhost: false,
    credentialsReadable: true,
    groupFilterNeedsConsistency: false,
    pageSize: null,
    rewriteNextLink: null,
    managerForApps: 'refused',
    hiddenMembersRefused: true,
    omitGroupProperties: false,
    removeNonMember: 'not_found',
  };
}

// ---------------------------------------------------------------------------------------------
// Permissions (Microsoft Learn permission tables; see permissions-map.ts for the product's side)
// ---------------------------------------------------------------------------------------------

interface Need {
  /** An application token needs every role of at least one of these sets. */
  readonly app?: readonly (readonly string[])[];
  /** A delegated token needs every scope of at least one of these sets. */
  readonly delegated?: readonly (readonly string[])[];
  /** A delegated token's user must hold one of these Entra roles (template ids). */
  readonly userRoles?: readonly string[];
}

const READ_APPLICATIONS = ['Application.Read.All'] as const;
const WRITE_APPLICATIONS = ['Application.ReadWrite.All'] as const;
const ADMIN_ROLES = [
  ENTRA_ROLE_TEMPLATES.globalAdministrator,
  ENTRA_ROLE_TEMPLATES.privilegedRoleAdministrator,
] as const;

const NEED = {
  organization: {
    app: [['Organization.Read.All'], ['Directory.Read.All']],
    delegated: [['User.Read'], ['Organization.Read.All'], ['Directory.Read.All']],
  },
  users: {
    app: [['User.Read.All'], ['Directory.Read.All']],
    delegated: [['User.ReadBasic.All'], ['User.Read.All'], ['Directory.Read.All']],
  },
  checkMemberGroups: {
    app: [
      ['User.ReadBasic.All', 'GroupMember.Read.All'],
      ['User.Read.All', 'GroupMember.Read.All'],
      ['User.Read.All', 'Group.Read.All'],
      ['Directory.Read.All'],
    ],
    delegated: [
      ['User.ReadBasic.All', 'GroupMember.Read.All'],
      ['User.Read.All', 'GroupMember.Read.All'],
      ['User.Read.All', 'Group.Read.All'],
      ['Directory.Read.All'],
    ],
  },
  groups: {
    app: [['GroupMember.Read.All'], ['Group.Read.All'], ['Directory.Read.All']],
    delegated: [['GroupMember.Read.All'], ['Group.Read.All'], ['Directory.Read.All']],
  },
  // group-post-members, group-delete-members (R-D-08): GroupMember.ReadWrite.All for a user member.
  groupMembersWrite: {
    app: [['GroupMember.ReadWrite.All'], ['Group.ReadWrite.All'], ['Directory.ReadWrite.All']],
    delegated: [
      ['GroupMember.ReadWrite.All'],
      ['Group.ReadWrite.All'],
      ['Directory.ReadWrite.All'],
    ],
  },
  // group-delete-members without /$ref deletes the member object: the call needs no member role at
  // all in the fake (the handler checks the permission of the OBJECT, the trap of R-D-08).
  groupMemberDelete: {
    app: [['GroupMember.ReadWrite.All'], ['Group.ReadWrite.All'], ['Directory.ReadWrite.All']],
    delegated: [['GroupMember.ReadWrite.All']],
  },
  // user-list-transitivememberof (R-C-08): User.Read.All is the least privileged for another user.
  transitiveMemberOf: {
    app: [['User.Read.All'], ['Directory.Read.All'], ['Group.Read.All'], ['GroupMember.Read.All']],
    delegated: [['User.Read.All'], ['Directory.Read.All']],
  },
  // user-list-memberof (R-C-08): for another user only Directory.Read.All (application).
  memberOf: {
    app: [['Directory.Read.All']],
    delegated: [['Directory.Read.All']],
  },
  applicationsRead: {
    app: [READ_APPLICATIONS, WRITE_APPLICATIONS, ['Directory.Read.All']],
    delegated: [READ_APPLICATIONS, WRITE_APPLICATIONS, ['Directory.Read.All']],
  },
  applicationsWrite: {
    app: [WRITE_APPLICATIONS],
    delegated: [WRITE_APPLICATIONS, ['AppRegistration.Create']],
  },
  servicePrincipalsWrite: { app: [WRITE_APPLICATIONS], delegated: [WRITE_APPLICATIONS] },
  appRoleAssignmentsRead: {
    app: [READ_APPLICATIONS, WRITE_APPLICATIONS],
    delegated: [READ_APPLICATIONS, WRITE_APPLICATIONS],
  },
  appRoleAssignmentsWrite: {
    delegated: [
      ['AppRoleAssignment.ReadWrite.All', 'Application.Read.All'],
      ['AppRoleAssignment.ReadWrite.All', 'Application.ReadWrite.All'],
    ],
    userRoles: ADMIN_ROLES,
  },
  roleAssignmentsRead: {
    delegated: [['RoleManagement.ReadWrite.Directory'], ['RoleManagement.Read.Directory']],
  },
  roleAssignmentsWrite: {
    delegated: [['RoleManagement.ReadWrite.Directory']],
    userRoles: ADMIN_ROLES,
  },
} as const satisfies Record<string, Need>;

function satisfied(held: readonly string[], sets: readonly (readonly string[])[]): boolean {
  return sets.some((set) => set.every((name) => held.includes(name)));
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** `isGuidText` as a plain predicate (it is a type guard, which narrows a `string` to `never` when negated). */
const isGuid = (value: string): boolean => isGuidText(value);

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Entra role definitions the fake knows (built-in template ids). */
const KNOWN_ROLE_DEFINITIONS: ReadonlySet<string> = new Set([
  ENTRA_ROLE_TEMPLATES.globalAdministrator,
  ENTRA_ROLE_TEMPLATES.privilegedRoleAdministrator,
  ...Object.values(EXCHANGE_ROLES).map((role) => role.templateId),
]);

export interface GraphModuleResult {
  readonly module: FakeTenantModule;
  readonly control: FakeGraphControl;
}

export function graphModule(world: FakeWorld): GraphModuleResult {
  const { directory } = world;
  let settings = defaultSettings();
  const faults: Faults = { throttles: [], failures: [] };
  const stats = { policyRefusals: 0, objectsDeleted: 0 };

  const control: FakeGraphControl = {
    replicationDelay(delay) {
      settings.delays =
        typeof delay === 'number'
          ? { applications: delay, servicePrincipals: delay, groups: delay }
          : {
              applications: delay.applications ?? 0,
              servicePrincipals: delay.servicePrincipals ?? 0,
              groups: delay.groups ?? 0,
            };
    },
    throttle(spec) {
      faults.throttles.push({ spec, left: spec.times });
    },
    failWith(spec) {
      faults.failures.push({ spec, left: spec.times });
    },
    duplicateGrants(mode) {
      settings.duplicates = mode;
    },
    unknownGroupId(mode) {
      settings.unknownGroup = mode;
    },
    credentialLifetimePolicy(maxDays) {
      settings.maxCredentialDays = maxDays;
    },
    rejectLocalhostRedirectUris(on) {
      settings.rejectLocalhost = on;
    },
    credentialsReadable(on) {
      settings.credentialsReadable = on;
    },
    groupFilterNeedsConsistencyLevel(on) {
      settings.groupFilterNeedsConsistency = on;
    },
    pageSize(size) {
      settings.pageSize = size;
    },
    rewriteNextLink(rewrite) {
      settings.rewriteNextLink = rewrite;
    },
    managerForApps(mode) {
      settings.managerForApps = mode;
    },
    hiddenMembersRefused(on) {
      settings.hiddenMembersRefused = on;
    },
    omitGroupProperties(on) {
      settings.omitGroupProperties = on;
    },
    removeNonMember(mode) {
      settings.removeNonMember = mode;
    },
    get stats() {
      return stats;
    },
  };

  const module: FakeTenantModule = (core) => {
    core.onReset(() => {
      settings = defaultSettings();
      faults.throttles.length = 0;
      faults.failures.length = 0;
      stats.policyRefusals = 0;
      stats.objectsDeleted = 0;
      world.reset();
    });
    mount(core);
  };

  // ---- responses ---------------------------------------------------------------------------

  function error(
    ctx: RouteContext,
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ): Response {
    const requestId = directory.newId('request');
    const clientRequestId = ctx.request.headers.get('client-request-id');
    return jsonResponse(
      status,
      {
        error: {
          code,
          message,
          innerError: {
            date: directory.nowIso(),
            'request-id': requestId,
            ...(clientRequestId === null ? {} : { 'client-request-id': clientRequestId }),
          },
        },
      },
      {
        'request-id': requestId,
        ...(clientRequestId === null ? {} : { 'client-request-id': clientRequestId }),
        ...headers,
      },
    );
  }

  const badRequest = (ctx: RouteContext, message: string): Response =>
    error(ctx, 400, 'Request_BadRequest', message);
  const unsupported = (ctx: RouteContext, message: string): Response =>
    error(ctx, 400, 'Request_UnsupportedQuery', message);
  const notFound = (ctx: RouteContext, what: string): Response =>
    error(
      ctx,
      404,
      'Request_ResourceNotFound',
      `Resource '${what}' does not exist or one of its queried reference-property objects are not present.`,
    );

  function ok(ctx: RouteContext, status: number, body: unknown): Response {
    const requestId = directory.newId('request');
    const clientRequestId = ctx.request.headers.get('client-request-id');
    return jsonResponse(status, body, {
      'request-id': requestId,
      ...(clientRequestId === null ? {} : { 'client-request-id': clientRequestId }),
    });
  }

  function noContent(ctx: RouteContext): Response {
    const clientRequestId = ctx.request.headers.get('client-request-id');
    return new Response(null, {
      status: 204,
      headers: {
        'request-id': directory.newId('request'),
        ...(clientRequestId === null ? {} : { 'client-request-id': clientRequestId }),
      },
    });
  }

  // ---- authentication, permissions, faults ------------------------------------------------

  function authenticate(ctx: RouteContext): IssuedToken | Response {
    const header = ctx.request.headers.get('authorization');
    const match = header === null ? null : /^Bearer ([\x21-\x7e]+)$/.exec(header);
    if (match === null) {
      return error(ctx, 401, 'InvalidAuthenticationToken', 'Access token is empty or malformed.', {
        'www-authenticate': 'Bearer realm=""',
      });
    }
    const token = world.tokens.lookup(match[1] ?? '');
    if (token?.tenantId !== directory.tenantId) {
      return error(ctx, 401, 'InvalidAuthenticationToken', 'Access token validation failure.');
    }
    if (token.audience !== 'graph') {
      return error(
        ctx,
        401,
        'InvalidAuthenticationToken',
        'Access token validation failure. Invalid audience.',
      );
    }
    if (ctx.clock.now() >= token.expiresAt) {
      return error(
        ctx,
        401,
        'InvalidAuthenticationToken',
        'Lifetime validation failed, the token is expired.',
      );
    }
    return token;
  }

  function permitted(token: IssuedToken, need: Need): boolean {
    const held = token.kind === 'app' ? token.roles : token.scopes;
    const sets = token.kind === 'app' ? need.app : need.delegated;
    if (sets === undefined || !satisfied(held, sets)) return false;
    if (token.kind === 'delegated' && need.userRoles !== undefined) {
      return need.userRoles.some((role) => token.entraRoleTemplateIds.includes(role));
    }
    return true;
  }

  function takeFault(ctx: RouteContext): Response | null {
    const key = `${ctx.request.method} ${ctx.url.pathname}`;
    for (const fault of faults.throttles) {
      if (fault.left <= 0 || (fault.spec.match !== undefined && !fault.spec.match.test(key)))
        continue;
      fault.left -= 1;
      const seconds = fault.spec.seconds === undefined ? 1 : fault.spec.seconds;
      const headers: Record<string, string> = {};
      if (seconds !== null) {
        headers['retry-after'] =
          fault.spec.form === 'httpDate'
            ? new Date(ctx.clock.now() + seconds * 1000).toUTCString()
            : String(seconds);
      }
      return error(ctx, 429, 'TooManyRequests', 'Too many requests.', headers);
    }
    for (const fault of faults.failures) {
      if (fault.left <= 0 || (fault.spec.match !== undefined && !fault.spec.match.test(key)))
        continue;
      fault.left -= 1;
      return error(
        ctx,
        fault.spec.status,
        'serviceNotAvailable',
        'The service is temporarily unavailable.',
      );
    }
    return null;
  }

  type Handler = (ctx: RouteContext, token: IssuedToken) => Response | Promise<Response>;

  function guarded(need: Need, handler: Handler) {
    return async (ctx: RouteContext): Promise<Response> => {
      const token = authenticate(ctx);
      if (token instanceof Response) return token;
      const fault = takeFault(ctx);
      if (fault !== null) return fault;
      if (!permitted(token, need)) {
        return error(
          ctx,
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        );
      }
      return handler(ctx, token);
    };
  }

  // ---- query options and bodies --------------------------------------------------------------

  interface Query {
    select: string[] | null;
    top: number | null;
    skip: number;
    filter: string | null;
    orderby: string | null;
    /** `$count=true` was sent. */
    count: boolean;
  }

  /** Reads `$select`, `$top`, `$filter`, `$orderby`, `$count` and `$skiptoken`; any other option is a 400. */
  function readQuery(ctx: RouteContext, allowed: readonly string[]): Query | Response {
    for (const name of ctx.query.keys()) {
      if (name === '$skip') {
        return error(
          ctx,
          400,
          'Request_UnsupportedQuery',
          'Query option $skip is not supported for this collection; follow @odata.nextLink.',
        );
      }
      if (!allowed.includes(name))
        return error(
          ctx,
          400,
          'Request_UnsupportedQuery',
          `Query option ${name} is not supported by the fake.`,
        );
    }
    let select: string[] | null;
    try {
      select = parseSelect(ctx.query.get('$select'));
    } catch (failure) {
      return error(
        ctx,
        400,
        'Request_BadRequest',
        failure instanceof FilterError ? failure.message : 'bad $select',
      );
    }
    const topText = ctx.query.get('$top');
    let top: number | null = null;
    if (topText !== null) {
      if (!/^\d{1,4}$/.test(topText) || Number(topText) < 1 || Number(topText) > 999) {
        return badRequest(ctx, 'Invalid value for $top.');
      }
      top = Number(topText);
    }
    const skipText = ctx.query.get('$skiptoken');
    let skip = 0;
    if (skipText !== null) {
      const position = decodeSkipToken(skipText);
      if (position === null) return badRequest(ctx, 'Invalid $skiptoken.');
      skip = position;
    }
    const countText = ctx.query.get('$count');
    if (countText !== null && countText !== 'true' && countText !== 'false') {
      return badRequest(ctx, 'Invalid value for $count.');
    }
    const consistency = ctx.request.headers.get('consistencylevel');
    if (consistency !== null && consistency.toLowerCase() !== 'eventual') {
      return badRequest(ctx, 'Invalid value for the ConsistencyLevel header.');
    }
    return {
      select,
      top,
      skip,
      filter: ctx.query.get('$filter'),
      orderby: ctx.query.get('$orderby'),
      count: countText === 'true',
    };
  }

  /**
   * The advanced-query rule (R-C-01, R-C-02, R-C-05, R-C-06): a query that uses any of `reasons` is
   * answered only when the request carries `ConsistencyLevel: eventual` AND `$count=true`.
   */
  function advancedGate(
    ctx: RouteContext,
    query: Query,
    reasons: readonly string[],
  ): Response | null {
    if (reasons.length === 0) return null;
    const header = ctx.request.headers.get('consistencylevel')?.toLowerCase() === 'eventual';
    if (header && query.count) return null;
    return error(
      ctx,
      400,
      'Request_UnsupportedQuery',
      `This query needs ConsistencyLevel: eventual and $count=true (${reasons.join(', ')}).`,
    );
  }

  function unreadable(ctx: RouteContext, select: readonly string[] | null): Response | null {
    if (settings.credentialsReadable) return null;
    if (
      select !== null &&
      (select.includes('passwordCredentials') || select.includes('keyCredentials'))
    ) {
      return error(
        ctx,
        403,
        'Authorization_RequestDenied',
        'Insufficient privileges to complete the operation.',
      );
    }
    return null;
  }

  function filterOf(
    ctx: RouteContext,
    text: string | null,
    allowed: readonly string[],
  ): ReturnType<typeof parseFilter> | null | Response {
    if (text === null) return null;
    try {
      return parseFilter(text, allowed);
    } catch (failure) {
      return error(
        ctx,
        400,
        'Request_UnsupportedQuery',
        failure instanceof FilterError ? failure.message : 'bad $filter',
      );
    }
  }

  function page(
    ctx: RouteContext,
    query: Query,
    items: readonly Json[],
    contextName: string,
  ): Response {
    const size = Math.min(query.top ?? settings.pageSize ?? 100, settings.pageSize ?? 999);
    const slice = items.slice(query.skip, query.skip + size);
    const body: Json = { '@odata.context': `${META}${contextName}`, value: slice };
    if (query.count) body['@odata.count'] = items.length;
    if (query.skip + size < items.length) {
      const next = new URLSearchParams();
      for (const [name, value] of ctx.query) if (name !== '$skiptoken') next.set(name, value);
      const pairs = [
        ...next.entries(),
        ['$skiptoken', encodeSkipToken(query.skip + size)] as [string, string],
      ]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('&');
      const link = `${ORIGIN}${ctx.url.pathname}?${pairs}`;
      body['@odata.nextLink'] =
        settings.rewriteNextLink === null ? link : settings.rewriteNextLink(link);
    }
    return ok(ctx, 200, body);
  }

  async function bodyOf(ctx: RouteContext): Promise<Json | Response> {
    const type = ctx.request.headers.get('content-type');
    if (type === null || !/^application\/json\s*(;|$)/i.test(type)) {
      return error(ctx, 415, 'UnsupportedMediaType', 'The content type must be application/json.');
    }
    const body = asRecord(await ctx.json());
    return body ?? badRequest(ctx, 'The request body must be a JSON object.');
  }

  function guidParam(ctx: RouteContext, value: string | undefined): string | Response {
    if (value === undefined) return badRequest(ctx, "Invalid object identifier ''.");
    if (!isGuid(value)) return badRequest(ctx, `Invalid object identifier '${value}'.`);
    return value.toLowerCase();
  }

  // ---- directory objects on the wire ------------------------------------------------------------

  /** Does the token hold this application role (or, delegated, scope)? */
  function holdsRole(token: IssuedToken, name: string): boolean {
    return (token.kind === 'app' ? token.roles : token.scopes).includes(name);
  }

  const GROUP_BASIC_ONLY = ['visibility', 'description', 'mailNickname', 'onPremisesSyncEnabled'];

  /** A group row; with `omitGroupProperties` the properties of U36/U69 come back `null`. */
  function groupRow(group: GroupRecord, select: string[] | null): Json {
    const row = project(renderGroup(group), GROUP_DEFAULTS, GROUP_CATALOG, select);
    if (settings.omitGroupProperties) {
      for (const name of GROUP_BASIC_ONLY) if (name in row) row[name] = null;
    }
    return row;
  }

  /** The names a `$select` may carry on a collection of directory objects of any type. */
  const OBJECT_CATALOG: ReadonlySet<string> = new Set([...USER_CATALOG, ...GROUP_CATALOG]);

  /**
   * A member, an owner or a manager as the polymorphic collections show it (R-C-05): a user in full
   * when the token may read users, a group in full, anything else (device, service principal, contact)
   * and a user the token may not read with `id` and `@odata.type` only; the selected properties are
   * `null`. A name in `$select` that the object's type does not have is `null`, not an error.
   */
  function objectRow(id: string, token: IssuedToken, select: string[] | null): Json {
    if (select !== null) {
      for (const name of select) {
        if (!OBJECT_CATALOG.has(name)) {
          throw new FilterError(`could not find a property named ${name}`);
        }
      }
    }
    const limited = (odataType: string): Json => {
      const row: Json = { '@odata.type': odataType, id };
      for (const name of select ?? []) if (name !== 'id') row[name] = null;
      return row;
    };
    const loose = (render: Record<string, unknown>, defaults: readonly string[]): Json => {
      const row: Json = { '@odata.type': render['@odata.type'], id };
      for (const name of select ?? defaults) if (name !== 'id') row[name] = render[name] ?? null;
      return row;
    };
    const user = directory.users.get(id);
    if (user !== undefined) {
      const mayRead =
        holdsRole(token, 'User.Read.All') ||
        holdsRole(token, 'User.ReadBasic.All') ||
        holdsRole(token, 'Directory.Read.All');
      return mayRead ? loose(renderUser(user), USER_DEFAULTS) : limited('#microsoft.graph.user');
    }
    const group = directory.groups.get(id);
    if (group !== undefined) {
      const row = loose(renderGroup(group), GROUP_DEFAULTS);
      if (settings.omitGroupProperties) {
        for (const name of GROUP_BASIC_ONLY) if (name in row) row[name] = null;
      }
      return row;
    }
    const other = directory.otherObjects.get(id);
    return limited(other?.odataType ?? '#microsoft.graph.directoryObject');
  }

  // ---- routes --------------------------------------------------------------------------------

  function mount(core: FakeTenantCore): void {
    const add = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string | RegExp,
      need: Need,
      handler: Handler,
      mutating?: boolean,
    ): void => {
      core.router.add({
        host: HOST,
        method,
        path: typeof path === 'string' ? `${BASE}${path}` : path,
        ...(mutating === undefined ? {} : { mutating }),
        handler: guarded(need, handler),
      });
    };

    // ---- organization --------------------------------------------------------------------------
    add('GET', '/organization', NEED.organization, (ctx, token) => {
      const query = readQuery(ctx, ['$select', '$top']);
      if (query instanceof Response) return query;
      const basicOnly =
        token.kind === 'delegated' &&
        !token.scopes.includes('Organization.Read.All') &&
        !token.scopes.includes('Directory.Read.All');
      try {
        const render = renderOrganization(directory.organization, basicOnly);
        const defaults = Object.keys(render).filter((name) => ORGANIZATION_CATALOG.has(name));
        const row = project(render, defaults, ORGANIZATION_CATALOG, query.select);
        return ok(ctx, 200, { '@odata.context': `${META}organization`, value: [row] });
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    });

    // ---- users ---------------------------------------------------------------------------------
    add('GET', '/users', NEED.users, (ctx) => {
      const query = readQuery(ctx, [
        '$select',
        '$top',
        '$skiptoken',
        '$filter',
        '$orderby',
        '$count',
      ]);
      if (query instanceof Response) return query;
      try {
        const parsed = parseListQuery(query, {
          filter: USER_FILTER_PROPERTIES,
          orderby: USER_ORDER_PROPERTIES,
        });
        const gate = advancedGate(ctx, query, reasonsOf(parsed, USER_ADVANCED_STARTS_WITH));
        if (gate !== null) return gate;
        const rows = selectUsers(directory, parsed).map((user) =>
          project(renderUser(user), USER_DEFAULTS, USER_CATALOG, query.select),
        );
        return page(ctx, query, rows, 'users');
      } catch (failure) {
        if (failure instanceof FilterError) return unsupported(ctx, failure.message);
        throw failure;
      }
    });

    const getUser = (ctx: RouteContext, wanted: string): Response => {
      const query = readQuery(ctx, ['$select']);
      if (query instanceof Response) return query;
      const user = directory.findUser(wanted);
      if (user === undefined) return notFound(ctx, wanted);
      try {
        return ok(ctx, 200, {
          '@odata.context': `${META}users(${query.select === null ? '' : query.select.join(',')})/$entity`,
          ...project(renderUser(user), USER_DEFAULTS, USER_CATALOG, query.select),
        });
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    };
    add('GET', '/users/:id', NEED.users, (ctx) => getUser(ctx, ctx.params.id ?? ''));
    // The key form Learn recommends for a userPrincipalName that starts with "$" (user-get, Tip 1):
    // /users('$x@y.com'), the quote of a value doubled.
    add('GET', /^\/v1\.0\/users\('(?<key>(?:[^']|'')*)'\)$/, NEED.users, (ctx) =>
      getUser(ctx, (ctx.params.key ?? '').replaceAll("''", "'")),
    );

    add(
      'POST',
      '/users/:id/checkMemberGroups',
      NEED.checkMemberGroups,
      async (ctx, token) => {
        const body = await bodyOf(ctx);
        if (body instanceof Response) return body;
        const ids = body.groupIds;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          return badRequest(
            ctx,
            'The property groupIds is required and must be a collection of strings.',
          );
        }
        if (ids.length > 20) {
          return badRequest(ctx, 'The collection groupIds exceeds the maximum of 20 elements.');
        }
        const groupIds = ids as string[];
        const malformed = groupIds.find((id) => !isGuid(id));
        if (malformed !== undefined)
          return badRequest(ctx, `Invalid object identifier '${malformed}'.`);
        const wanted = ctx.params.id ?? '';
        const user = directory.findUser(wanted);
        if (user === undefined) return notFound(ctx, wanted);
        const memberOf = directory.transitiveGroupIds(user.id);
        const mayReadHidden = token.kind === 'app' && token.roles.includes('Member.Read.Hidden');
        const value: string[] = [];
        for (const raw of groupIds) {
          const id = raw.toLowerCase();
          const group = directory.groups.get(id);
          if (group === undefined) {
            if (settings.unknownGroup === 'bad_request') {
              return badRequest(ctx, `Invalid object identifier '${id}'.`);
            }
            continue;
          }
          if (group.hiddenMembership && !mayReadHidden) continue;
          if (memberOf.has(id) && !value.includes(id)) value.push(id);
        }
        return ok(ctx, 200, { '@odata.context': `${META}Collection(Edm.String)`, value });
      },
      false,
    );

    // ---- groups --------------------------------------------------------------------------------
    add('GET', '/groups/:id', NEED.groups, (ctx) => {
      const query = readQuery(ctx, ['$select']);
      if (query instanceof Response) return query;
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const group = directory.groups.get(id);
      if (group === undefined || !directory.touch(group)) return notFound(ctx, id);
      try {
        return ok(ctx, 200, {
          '@odata.context': `${META}groups(${query.select === null ? '' : query.select.join(',')})/$entity`,
          ...groupRow(group, query.select),
        });
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    });

    add('GET', '/groups', NEED.groups, (ctx) => {
      const query = readQuery(ctx, [
        '$select',
        '$top',
        '$filter',
        '$orderby',
        '$count',
        '$skiptoken',
      ]);
      if (query instanceof Response) return query;
      if (
        query.filter !== null &&
        settings.groupFilterNeedsConsistency &&
        ctx.request.headers.get('consistencylevel')?.toLowerCase() !== 'eventual'
      ) {
        return error(
          ctx,
          400,
          'Request_UnsupportedQuery',
          'Request_UnsupportedQuery: ConsistencyLevel eventual is required.',
        );
      }
      try {
        const parsed = parseListQuery(query, {
          filter: GROUP_FILTER_PROPERTIES,
          orderby: GROUP_ORDER_PROPERTIES,
        });
        const gate = advancedGate(ctx, query, reasonsOf(parsed, GROUP_ADVANCED_STARTS_WITH));
        if (gate !== null) return gate;
        const rows: Json[] = [];
        for (const group of selectGroups(directory, parsed)) {
          if (!directory.touch(group)) continue;
          rows.push(groupRow(group, query.select));
        }
        return page(ctx, query, rows, 'groups');
      } catch (failure) {
        if (failure instanceof FilterError) return unsupported(ctx, failure.message);
        throw failure;
      }
    });

    // The relationship collections (R-C-05, R-C-06, R-C-08): every query option but $expand needs the
    // advanced pair, and the rows are directory objects of any type.
    const relationshipQuery = (ctx: RouteContext): Query | Response => {
      const query = readQuery(ctx, ['$select', '$top', '$skiptoken', '$count']);
      if (query instanceof Response) return query;
      const options = [...ctx.query.keys()];
      return advancedGate(ctx, query, options.length === 0 ? [] : options) ?? query;
    };

    add('GET', '/users/:id/manager', NEED.users, (ctx, token) => {
      const query = readQuery(ctx, ['$select']);
      if (query instanceof Response) return query;
      if (token.kind === 'app' && settings.managerForApps === 'refused') {
        return error(
          ctx,
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        );
      }
      const wanted = ctx.params.id ?? '';
      const user = directory.findUser(wanted);
      if (user === undefined) return notFound(ctx, wanted);
      const manager = user.managerId === null ? undefined : directory.users.get(user.managerId);
      if (manager === undefined) return notFound(ctx, 'manager');
      try {
        return ok(ctx, 200, {
          '@odata.context': `${META}directoryObjects/$entity`,
          ...objectRow(manager.id, token, query.select),
        });
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    });

    const membershipsOf = (userId: string, transitive: boolean): string[] => {
      if (transitive) return [...directory.transitiveGroupIds(userId)];
      return [...directory.groups.values()]
        .filter((group) => group.members.has(userId))
        .map((group) => group.id);
    };
    const membershipRoute =
      (transitive: boolean) =>
      (ctx: RouteContext): Response => {
        const query = relationshipQuery(ctx);
        if (query instanceof Response) return query;
        const wanted = ctx.params.id ?? '';
        const user = directory.findUser(wanted);
        if (user === undefined) return notFound(ctx, wanted);
        try {
          const rows: Json[] = [];
          for (const id of membershipsOf(user.id, transitive)) {
            const group = directory.groups.get(id);
            if (group === undefined) continue;
            // U67: a hidden-membership group is left out while the fake refuses its members.
            if (group.hiddenMembership && settings.hiddenMembersRefused) continue;
            rows.push(groupRow(group, query.select));
          }
          return page(ctx, query, rows, 'directoryObjects');
        } catch (failure) {
          if (failure instanceof FilterError) return badRequest(ctx, failure.message);
          throw failure;
        }
      };
    add(
      'GET',
      '/users/:id/transitiveMemberOf/microsoft.graph.group',
      NEED.transitiveMemberOf,
      membershipRoute(true),
    );
    add('GET', '/users/:id/memberOf', NEED.memberOf, membershipRoute(false));
    add('GET', '/users/:id/memberOf/microsoft.graph.group', NEED.memberOf, membershipRoute(false));

    const groupCollection =
      (kind: 'members' | 'owners') => (ctx: RouteContext, token: IssuedToken) => {
        const query = relationshipQuery(ctx);
        if (query instanceof Response) return query;
        const id = guidParam(ctx, ctx.params.id);
        if (id instanceof Response) return id;
        const group = directory.groups.get(id);
        if (group === undefined || !directory.touch(group)) return notFound(ctx, id);
        try {
          let ids: string[];
          if (kind === 'owners') {
            // R-C-06: no owners in Graph for Exchange-created, distribution and synced groups.
            ids = hasNoOwnersInGraph(group) ? [] : [...group.owners];
          } else if (group.hiddenMembership && !holdsRole(token, 'Member.Read.Hidden')) {
            if (settings.hiddenMembersRefused) {
              return error(
                ctx,
                403,
                'Authorization_RequestDenied',
                'Insufficient privileges to complete the operation.',
              );
            }
            ids = [];
          } else {
            ids = [...group.members];
          }
          const rows = ids.map((memberId) => objectRow(memberId, token, query.select));
          return page(ctx, query, rows, 'directoryObjects');
        } catch (failure) {
          if (failure instanceof FilterError) return badRequest(ctx, failure.message);
          throw failure;
        }
      };
    add('GET', '/groups/:id/members', NEED.groups, groupCollection('members'));
    add('GET', '/groups/:id/owners', NEED.groups, groupCollection('owners'));

    // ---- group members: the two writes of Phase D (R-D-08) ------------------------------------------
    // The reference of a member: `https://graph.microsoft.com/v1.0/directoryObjects/{id}` and nothing else.
    const MEMBER_REF =
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/directoryObjects\/([0-9a-fA-F-]{36})$/;

    add('POST', '/groups/:id/members/$ref', NEED.groupMembersWrite, async (ctx, token) => {
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const body = await bodyOf(ctx);
      if (body instanceof Response) return body;
      const reference = body['@odata.id'];
      if (Object.keys(body).length !== 1 || typeof reference !== 'string') {
        return badRequest(ctx, 'The request body must be {"@odata.id": "<reference>"}.');
      }
      const matched = MEMBER_REF.exec(reference);
      if (matched === null || !isGuid(matched[1] ?? '')) {
        return badRequest(ctx, 'The member reference must name a directory object by its id.');
      }
      const memberId = (matched[1] ?? '').toLowerCase();
      const verdict = checkAdd(
        directory,
        id,
        memberId,
        token.kind === 'app' ? token.roles : token.scopes,
      );
      if (!verdict.ok) {
        return error(
          ctx,
          verdict.status,
          verdict.code,
          verdict.status === 404
            ? `Resource '${memberId}' does not exist or one of its queried reference-property objects are not present.`
            : 'The request could not be completed.',
        );
      }
      applyAdd(directory, id, memberId);
      return noContent(ctx);
    });

    add('DELETE', '/groups/:id/members/:memberId/$ref', NEED.groupMembersWrite, (ctx) => {
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const memberId = guidParam(ctx, ctx.params.memberId);
      if (memberId instanceof Response) return memberId;
      const verdict = checkRemove(directory, id, memberId, settings.removeNonMember);
      if (!verdict.ok) {
        return error(ctx, verdict.status, verdict.code, 'The request could not be completed.');
      }
      applyRemove(directory, id, memberId);
      return noContent(ctx);
    });

    // The same path WITHOUT /$ref: it deletes the member object itself, if the application may (R-D-08).
    add('DELETE', '/groups/:id/members/:memberId', NEED.groupMemberDelete, (ctx, token) => {
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const memberId = guidParam(ctx, ctx.params.memberId);
      if (memberId instanceof Response) return memberId;
      const group = directory.groups.get(id);
      if (!group?.members.has(memberId)) return notFound(ctx, memberId);
      const needed = deletePermissionFor(directory, memberId);
      const held = token.kind === 'app' ? token.roles : token.scopes;
      if (needed === undefined || !held.includes(needed)) {
        return error(
          ctx,
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        );
      }
      deleteObject(directory, memberId);
      stats.objectsDeleted += 1;
      return noContent(ctx);
    });

    // ---- service principals ----------------------------------------------------------------------
    const spRow = (sp: ServicePrincipalRecord, select: string[] | null): Json =>
      project(
        renderServicePrincipal(sp, false),
        SERVICE_PRINCIPAL_DEFAULTS,
        SERVICE_PRINCIPAL_CATALOG,
        select,
      );

    add('GET', '/servicePrincipals', NEED.applicationsRead, (ctx) => {
      const query = readQuery(ctx, ['$select', '$top', '$filter', '$skiptoken']);
      if (query instanceof Response) return query;
      const denied = unreadable(ctx, query.select);
      if (denied !== null) return denied;
      const filter = filterOf(ctx, query.filter, ['appId', 'displayName']);
      if (filter instanceof Response) return filter;
      try {
        const rows: Json[] = [];
        for (const sp of directory.servicePrincipals.values()) {
          if (
            filter !== null &&
            !evaluate(filter, (property) => (property === 'appId' ? sp.appId : sp.displayName))
          )
            continue;
          if (!directory.touch(sp)) continue;
          rows.push(spRow(sp, query.select));
        }
        return page(ctx, query, rows, 'servicePrincipals');
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    });

    add(
      'GET',
      /^\/v1\.0\/servicePrincipals\(appId='(?<appId>[^']*)'\)$/,
      NEED.applicationsRead,
      (ctx) => {
        const query = readQuery(ctx, ['$select']);
        if (query instanceof Response) return query;
        const denied = unreadable(ctx, query.select);
        if (denied !== null) return denied;
        const appId = guidParam(ctx, ctx.params.appId);
        if (appId instanceof Response) return appId;
        const sp = directory.servicePrincipalByAppId(appId);
        if (sp === undefined || !directory.touch(sp)) return notFound(ctx, appId);
        try {
          return ok(ctx, 200, {
            '@odata.context': `${META}servicePrincipals/$entity`,
            ...spRow(sp, query.select),
          });
        } catch (failure) {
          if (failure instanceof FilterError) return badRequest(ctx, failure.message);
          throw failure;
        }
      },
    );

    add('POST', '/servicePrincipals', NEED.servicePrincipalsWrite, async (ctx) => {
      const body = await bodyOf(ctx);
      if (body instanceof Response) return body;
      const unknown = Object.keys(body).find(
        (name) => name !== 'appId' && name !== 'tags' && name !== 'displayName',
      );
      if (unknown !== undefined)
        return badRequest(
          ctx,
          `Property ${unknown} does not exist on type microsoft.graph.servicePrincipal.`,
        );
      const appId =
        typeof body.appId === 'string' && isGuidText(body.appId) ? body.appId.toLowerCase() : null;
      if (appId === null)
        return badRequest(ctx, 'The property appId is required and must be a GUID.');
      const application = directory.applicationByAppId(appId);
      const resource = directory.servicePrincipalByAppId(appId);
      if (application === undefined && resource === undefined) {
        return error(ctx, 404, 'Request_ResourceNotFound', `Resource '${appId}' does not exist.`);
      }
      if (application !== undefined && !directory.touch(application)) {
        return error(ctx, 404, 'Request_ResourceNotFound', `Resource '${appId}' does not exist.`);
      }
      if (resource !== undefined) {
        return error(
          ctx,
          409,
          'Request_MultipleErrors',
          'A service principal for this application already exists.',
        );
      }
      const sp: ServicePrincipalRecord = {
        id: directory.newId('service-principal'),
        appId,
        displayName: application?.displayName ?? appId,
        appRoles: [],
        appRoleAssignmentRequired: false,
        tags: Array.isArray(body.tags)
          ? (body.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
          : [],
        keyCredentials: [],
        passwordCredentials: [],
        owners: [],
        servicePrincipalType: 'Application',
        createdDateTime: directory.nowIso(),
        pending: settings.delays.servicePrincipals,
      };
      directory.servicePrincipals.set(sp.id, sp);
      return ok(ctx, 201, {
        '@odata.context': `${META}servicePrincipals/$entity`,
        ...spRow(sp, null),
      });
    });

    add('GET', '/servicePrincipals/:id/owners', NEED.applicationsRead, (ctx) => {
      const query = readQuery(ctx, ['$select', '$top']);
      if (query instanceof Response) return query;
      if (!settings.credentialsReadable)
        return error(
          ctx,
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        );
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const sp = directory.servicePrincipals.get(id);
      if (sp === undefined || !directory.touch(sp)) return notFound(ctx, id);
      return ok(ctx, 200, {
        '@odata.context': `${META}directoryObjects`,
        value: sp.owners.map((owner) => ({ '@odata.type': '#microsoft.graph.user', id: owner })),
      });
    });

    const assignmentRow = (assignment: AppRoleAssignmentRecord): Json => {
      const principal = directory.servicePrincipals.get(assignment.principalId);
      const resource = directory.servicePrincipals.get(assignment.resourceId);
      return {
        id: assignment.id,
        deletedDateTime: null,
        appRoleId: assignment.appRoleId,
        createdDateTime: assignment.createdDateTime,
        principalDisplayName: principal?.displayName ?? null,
        principalId: assignment.principalId,
        principalType: 'ServicePrincipal',
        resourceDisplayName: resource?.displayName ?? null,
        resourceId: assignment.resourceId,
      };
    };

    for (const [segment, key] of [
      ['appRoleAssignments', 'principalId'],
      ['appRoleAssignedTo', 'resourceId'],
    ] as const) {
      add('GET', `/servicePrincipals/:id/${segment}`, NEED.appRoleAssignmentsRead, (ctx) => {
        const query = readQuery(ctx, ['$select', '$top', '$skiptoken']);
        if (query instanceof Response) return query;
        const id = guidParam(ctx, ctx.params.id);
        if (id instanceof Response) return id;
        const sp = directory.servicePrincipals.get(id);
        if (sp === undefined || !directory.touch(sp)) return notFound(ctx, id);
        const rows = [...directory.appRoleAssignments.values()]
          .filter((assignment) => assignment[key] === id)
          .map(assignmentRow);
        return page(ctx, query, rows, 'appRoleAssignments');
      });
    }

    add(
      'POST',
      '/servicePrincipals/:id/appRoleAssignedTo',
      NEED.appRoleAssignmentsWrite,
      async (ctx) => {
        const pathId = guidParam(ctx, ctx.params.id);
        if (pathId instanceof Response) return pathId;
        const body = await bodyOf(ctx);
        if (body instanceof Response) return body;
        const unknown = Object.keys(body).find(
          (name) => !['principalId', 'resourceId', 'appRoleId'].includes(name),
        );
        if (unknown !== undefined)
          return badRequest(
            ctx,
            `Property ${unknown} does not exist on type microsoft.graph.appRoleAssignment.`,
          );
        const ids: Record<string, string> = {};
        for (const name of ['principalId', 'resourceId', 'appRoleId'] as const) {
          const value = body[name];
          if (typeof value !== 'string' || !isGuidText(value))
            return badRequest(ctx, `The property ${name} is required and must be a GUID.`);
          ids[name] = value.toLowerCase();
        }
        const principalId = ids.principalId ?? '';
        const resourceId = ids.resourceId ?? '';
        const appRoleId = ids.appRoleId ?? '';
        if (resourceId !== pathId)
          return badRequest(
            ctx,
            'The resourceId must be the id of the service principal in the path.',
          );
        const resource = directory.servicePrincipals.get(resourceId);
        if (resource === undefined || !directory.touch(resource)) return notFound(ctx, resourceId);
        const principal = directory.servicePrincipals.get(principalId);
        if (principal === undefined || !directory.touch(principal)) {
          return badRequest(
            ctx,
            'The source resource object or one of the objects being referenced does not exist.',
          );
        }
        const role = resource.appRoles.find((candidate) => candidate.id === appRoleId);
        if (
          role === undefined ||
          !role.isEnabled ||
          !role.allowedMemberTypes.includes('Application')
        ) {
          return badRequest(
            ctx,
            'The app role does not exist on the resource, is disabled, or cannot be assigned to an application.',
          );
        }
        const existing = [...directory.appRoleAssignments.values()].find(
          (assignment) =>
            assignment.principalId === principalId &&
            assignment.resourceId === resourceId &&
            assignment.appRoleId === appRoleId,
        );
        if (existing !== undefined) {
          if (settings.duplicates === 'idempotent')
            return ok(ctx, 201, {
              '@odata.context': `${META}appRoleAssignments/$entity`,
              ...assignmentRow(existing),
            });
          if (settings.duplicates === 'conflict')
            return error(
              ctx,
              409,
              'Request_MultipleErrors',
              'Permission being assigned already exists on the object.',
            );
          return badRequest(ctx, 'Permission being assigned already exists on the object.');
        }
        const created: AppRoleAssignmentRecord = {
          id: directory.newOpaqueId('app-role-assignment'),
          principalId,
          resourceId,
          appRoleId,
          createdDateTime: directory.nowIso(),
        };
        directory.appRoleAssignments.set(created.id, created);
        return ok(ctx, 201, {
          '@odata.context': `${META}appRoleAssignments/$entity`,
          ...assignmentRow(created),
        });
      },
    );

    // ---- applications ----------------------------------------------------------------------------
    const appRow = (
      application: ApplicationRecord,
      select: string[] | null,
      single: boolean,
    ): Json =>
      project(
        renderApplication(application, single && select?.includes('keyCredentials') === true),
        APPLICATION_DEFAULTS,
        APPLICATION_CATALOG,
        select,
      );

    add('GET', '/applications', NEED.applicationsRead, (ctx) => {
      const query = readQuery(ctx, ['$select', '$top', '$filter', '$skiptoken']);
      if (query instanceof Response) return query;
      const denied = unreadable(ctx, query.select);
      if (denied !== null) return denied;
      const filter = filterOf(ctx, query.filter, ['appId', 'displayName']);
      if (filter instanceof Response) return filter;
      try {
        const rows: Json[] = [];
        for (const application of directory.applications.values()) {
          if (
            filter !== null &&
            !evaluate(filter, (property) =>
              property === 'appId' ? application.appId : application.displayName,
            )
          )
            continue;
          if (!directory.touch(application)) continue;
          rows.push(appRow(application, query.select, false));
        }
        return page(ctx, query, rows, 'applications');
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    });

    add('GET', '/applications/:id', NEED.applicationsRead, (ctx) => {
      const query = readQuery(ctx, ['$select']);
      if (query instanceof Response) return query;
      const denied = unreadable(ctx, query.select);
      if (denied !== null) return denied;
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const application = directory.applications.get(id);
      if (application === undefined || !directory.touch(application)) return notFound(ctx, id);
      try {
        return ok(ctx, 200, {
          '@odata.context': `${META}applications/$entity`,
          ...appRow(application, query.select, true),
        });
      } catch (failure) {
        if (failure instanceof FilterError) return badRequest(ctx, failure.message);
        throw failure;
      }
    });

    add('GET', '/applications/:id/owners', NEED.applicationsRead, (ctx) => {
      const query = readQuery(ctx, ['$select', '$top']);
      if (query instanceof Response) return query;
      if (!settings.credentialsReadable)
        return error(
          ctx,
          403,
          'Authorization_RequestDenied',
          'Insufficient privileges to complete the operation.',
        );
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const application = directory.applications.get(id);
      if (application === undefined || !directory.touch(application)) return notFound(ctx, id);
      return ok(ctx, 200, {
        '@odata.context': `${META}directoryObjects`,
        value: application.owners.map((owner) => ({
          '@odata.type': '#microsoft.graph.user',
          id: owner,
        })),
      });
    });

    add('POST', '/applications', NEED.applicationsWrite, async (ctx, token) => {
      const body = await bodyOf(ctx);
      if (body instanceof Response) return body;
      const checked = validateApplicationBody(ctx, body, true, undefined);
      if (checked instanceof Response) return checked;
      const application: ApplicationRecord = {
        id: directory.newId('application'),
        appId: directory.newId('application-client'),
        displayName: checked.displayName ?? '',
        description: checked.description ?? null,
        signInAudience: checked.signInAudience ?? 'AzureADMyOrg',
        web: {
          redirectUris: checked.redirectUris ?? [],
          implicitGrantSettings: checked.implicitGrantSettings ?? {
            enableIdTokenIssuance: false,
            enableAccessTokenIssuance: false,
          },
          logoutUrl: checked.logoutUrl ?? null,
        },
        requiredResourceAccess: checked.requiredResourceAccess ?? [],
        optionalClaims: checked.optionalClaims ?? null,
        tags: checked.tags ?? [],
        keyCredentials: checked.keyCredentials ?? [],
        passwordCredentials: [],
        owners: token.userId === null ? [] : [token.userId],
        createdDateTime: directory.nowIso(),
        extra: {},
        pending: settings.delays.applications,
      };
      directory.applications.set(application.id, application);
      return ok(ctx, 201, {
        '@odata.context': `${META}applications/$entity`,
        ...appRow(application, null, false),
      });
    });

    add('PATCH', '/applications/:id', NEED.applicationsWrite, async (ctx) => {
      const id = guidParam(ctx, ctx.params.id);
      if (id instanceof Response) return id;
      const body = await bodyOf(ctx);
      if (body instanceof Response) return body;
      const application = directory.applications.get(id);
      if (application === undefined || !directory.touch(application)) return notFound(ctx, id);
      const checked = validateApplicationBody(ctx, body, false, application);
      if (checked instanceof Response) return checked;
      if (checked.displayName !== undefined) application.displayName = checked.displayName;
      if (checked.description !== undefined) application.description = checked.description;
      if (checked.signInAudience !== undefined) application.signInAudience = checked.signInAudience;
      if (checked.redirectUris !== undefined) application.web.redirectUris = checked.redirectUris;
      if (checked.implicitGrantSettings !== undefined)
        application.web.implicitGrantSettings = checked.implicitGrantSettings;
      if (checked.logoutUrl !== undefined) application.web.logoutUrl = checked.logoutUrl;
      if (checked.requiredResourceAccess !== undefined)
        application.requiredResourceAccess = checked.requiredResourceAccess;
      if (checked.optionalClaims !== undefined) application.optionalClaims = checked.optionalClaims;
      if (checked.tags !== undefined) application.tags = checked.tags;
      // REPLACEMENT: the collection that was sent is the collection that remains (research 2.4).
      if (checked.keyCredentials !== undefined) application.keyCredentials = checked.keyCredentials;
      return noContent(ctx);
    });

    // ---- directory role assignments ----------------------------------------------------------------
    const roleAssignmentRow = (assignment: {
      id: string;
      principalId: string;
      roleDefinitionId: string;
      directoryScopeId: string;
    }): Json => ({
      id: assignment.id,
      principalId: assignment.principalId,
      roleDefinitionId: assignment.roleDefinitionId,
      directoryScopeId: assignment.directoryScopeId,
      appScopeId: null,
    });

    add('GET', '/roleManagement/directory/roleAssignments', NEED.roleAssignmentsRead, (ctx) => {
      const query = readQuery(ctx, ['$select', '$top', '$filter', '$skiptoken']);
      if (query instanceof Response) return query;
      const filter = filterOf(ctx, query.filter, [
        'principalId',
        'roleDefinitionId',
        'directoryScopeId',
      ]);
      if (filter instanceof Response) return filter;
      const rows = [...directory.directoryRoleAssignments.values()]
        .filter(
          (assignment) =>
            filter === null ||
            evaluate(
              filter,
              (property) => (assignment as unknown as Record<string, string>)[property],
            ),
        )
        .map(roleAssignmentRow);
      return page(ctx, query, rows, 'roleManagement/directory/roleAssignments');
    });

    add(
      'POST',
      '/roleManagement/directory/roleAssignments',
      NEED.roleAssignmentsWrite,
      async (ctx) => {
        const body = await bodyOf(ctx);
        if (body instanceof Response) return body;
        const unknown = Object.keys(body).find(
          (name) => !['principalId', 'roleDefinitionId', 'directoryScopeId'].includes(name),
        );
        if (unknown !== undefined)
          return badRequest(
            ctx,
            `Property ${unknown} does not exist on type microsoft.graph.unifiedRoleAssignment.`,
          );
        const principalId =
          typeof body.principalId === 'string' && isGuidText(body.principalId)
            ? body.principalId.toLowerCase()
            : null;
        const roleDefinitionId =
          typeof body.roleDefinitionId === 'string' && isGuidText(body.roleDefinitionId)
            ? body.roleDefinitionId.toLowerCase()
            : null;
        const scope = body.directoryScopeId;
        if (principalId === null || roleDefinitionId === null) {
          return badRequest(
            ctx,
            'The properties principalId and roleDefinitionId are required and must be GUIDs.',
          );
        }
        if (typeof scope !== 'string' || !(scope === '/' || /^\/[0-9a-f-]{36}$/i.test(scope))) {
          return badRequest(
            ctx,
            'The property directoryScopeId is required: "/" or "/{object id}".',
          );
        }
        if (!KNOWN_ROLE_DEFINITIONS.has(roleDefinitionId)) {
          return badRequest(ctx, 'The role definition does not exist.');
        }
        const principal = directory.servicePrincipals.get(principalId);
        const exists =
          principal !== undefined ||
          directory.users.has(principalId) ||
          directory.groups.has(principalId);
        if (!exists || (principal !== undefined && !directory.touch(principal))) {
          return badRequest(
            ctx,
            'The source resource object or one of the objects being referenced does not exist.',
          );
        }
        const existing = [...directory.directoryRoleAssignments.values()].find(
          (assignment) =>
            assignment.principalId === principalId &&
            assignment.roleDefinitionId === roleDefinitionId &&
            assignment.directoryScopeId === scope,
        );
        if (existing !== undefined) {
          if (settings.duplicates === 'idempotent')
            return ok(ctx, 201, {
              '@odata.context': `${META}roleManagement/directory/roleAssignments/$entity`,
              ...roleAssignmentRow(existing),
            });
          if (settings.duplicates === 'conflict')
            return error(
              ctx,
              409,
              'Request_MultipleErrors',
              'A conflicting object with one or more of the specified property values is present in the directory.',
            );
          return badRequest(
            ctx,
            'A conflicting object with one or more of the specified property values is present in the directory.',
          );
        }
        const created = {
          id: directory.newOpaqueId('role-assignment'),
          principalId,
          roleDefinitionId,
          directoryScopeId: scope,
        };
        directory.directoryRoleAssignments.set(created.id, created);
        return ok(ctx, 201, {
          '@odata.context': `${META}roleManagement/directory/roleAssignments/$entity`,
          ...roleAssignmentRow(created),
        });
      },
    );
  }

  // ---- application bodies ---------------------------------------------------------------------

  interface CheckedApplication {
    displayName?: string;
    description?: string | null;
    signInAudience?: string;
    redirectUris?: string[];
    implicitGrantSettings?: { enableIdTokenIssuance: boolean; enableAccessTokenIssuance: boolean };
    logoutUrl?: string | null;
    requiredResourceAccess?: {
      resourceAppId: string;
      resourceAccess: { id: string; type: string }[];
    }[];
    optionalClaims?: Record<string, unknown> | null;
    tags?: string[];
    keyCredentials?: KeyCredentialRecord[];
  }

  /** Strict validation of a create or update body; `existing` is set for a PATCH. */
  function validateApplicationBody(
    ctx: RouteContext,
    body: Json,
    creating: boolean,
    existing: ApplicationRecord | undefined,
  ): CheckedApplication | Response {
    const out: CheckedApplication = {};
    for (const name of Object.keys(body)) {
      if (name === 'id' || name === 'appId' || name === 'createdDateTime') {
        return badRequest(ctx, `Property ${name} is read-only.`);
      }
      if (!APPLICATION_WRITABLE.has(name)) {
        return badRequest(
          ctx,
          `Property ${name} does not exist on type microsoft.graph.application.`,
        );
      }
    }
    if (creating && (typeof body.displayName !== 'string' || body.displayName.length === 0)) {
      return badRequest(ctx, 'The property displayName is required.');
    }
    if (body.displayName !== undefined) {
      if (
        typeof body.displayName !== 'string' ||
        body.displayName.length === 0 ||
        body.displayName.length > 256
      ) {
        return badRequest(ctx, 'The property displayName must be a string of 1 to 256 characters.');
      }
      out.displayName = body.displayName;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string')
        return badRequest(ctx, 'The property description must be a string.');
      out.description = body.description;
    }
    if (body.signInAudience !== undefined) {
      const audiences = [
        'AzureADMyOrg',
        'AzureADMultipleOrgs',
        'AzureADandPersonalMicrosoftAccount',
        'PersonalMicrosoftAccount',
      ];
      if (typeof body.signInAudience !== 'string' || !audiences.includes(body.signInAudience)) {
        return badRequest(ctx, 'The property signInAudience is not valid.');
      }
      out.signInAudience = body.signInAudience;
    }
    if (body.web !== undefined) {
      const web = asRecord(body.web);
      if (web === null) return badRequest(ctx, 'The property web must be an object.');
      const unknown = Object.keys(web).find(
        (name) =>
          !['redirectUris', 'implicitGrantSettings', 'logoutUrl', 'homePageUrl'].includes(name),
      );
      if (unknown !== undefined)
        return badRequest(
          ctx,
          `Property ${unknown} does not exist on type microsoft.graph.webApplication.`,
        );
      if (web.redirectUris !== undefined) {
        const uris = web.redirectUris;
        if (
          !Array.isArray(uris) ||
          uris.some((uri) => typeof uri !== 'string') ||
          uris.length > 256
        ) {
          return badRequest(
            ctx,
            'The property redirectUris must be a collection of at most 256 strings.',
          );
        }
        for (const uri of uris as string[]) {
          const refusal = redirectUriRefusal(uri, settings.rejectLocalhost);
          if (refusal !== null)
            return badRequest(ctx, `Property replyUrlsWithType is invalid: ${refusal}`);
        }
        out.redirectUris = [...(uris as string[])];
      }
      if (web.implicitGrantSettings !== undefined) {
        const grant = asRecord(web.implicitGrantSettings);
        if (
          grant === null ||
          typeof grant.enableIdTokenIssuance !== 'boolean' ||
          typeof grant.enableAccessTokenIssuance !== 'boolean'
        ) {
          return badRequest(ctx, 'The property implicitGrantSettings is not valid.');
        }
        out.implicitGrantSettings = {
          enableIdTokenIssuance: grant.enableIdTokenIssuance,
          enableAccessTokenIssuance: grant.enableAccessTokenIssuance,
        };
      }
      if (web.logoutUrl !== undefined) {
        if (web.logoutUrl !== null && typeof web.logoutUrl !== 'string')
          return badRequest(ctx, 'The property logoutUrl must be a string.');
        out.logoutUrl = web.logoutUrl;
      }
    }
    if (body.requiredResourceAccess !== undefined) {
      const entries = body.requiredResourceAccess;
      if (!Array.isArray(entries) || entries.length > 50)
        return badRequest(
          ctx,
          'The property requiredResourceAccess must be a collection of at most 50 entries.',
        );
      const checked: NonNullable<CheckedApplication['requiredResourceAccess']> = [];
      let permissions = 0;
      for (const entry of entries as unknown[]) {
        const record = asRecord(entry);
        const access = record === null ? null : record.resourceAccess;
        if (
          record === null ||
          typeof record.resourceAppId !== 'string' ||
          !isGuidText(record.resourceAppId) ||
          !Array.isArray(access) ||
          Object.keys(record).some((name) => name !== 'resourceAppId' && name !== 'resourceAccess')
        ) {
          return badRequest(ctx, 'The property requiredResourceAccess is not valid.');
        }
        const items: { id: string; type: string }[] = [];
        for (const item of access as unknown[]) {
          const permission = asRecord(item);
          if (
            permission === null ||
            typeof permission.id !== 'string' ||
            !isGuidText(permission.id) ||
            (permission.type !== 'Role' && permission.type !== 'Scope') ||
            Object.keys(permission).some((name) => name !== 'id' && name !== 'type')
          ) {
            return badRequest(ctx, 'The property resourceAccess is not valid.');
          }
          items.push({ id: permission.id.toLowerCase(), type: permission.type });
          permissions += 1;
        }
        checked.push({ resourceAppId: record.resourceAppId.toLowerCase(), resourceAccess: items });
      }
      if (permissions > 400) return badRequest(ctx, 'At most 400 permissions can be requested.');
      out.requiredResourceAccess = checked;
    }
    if (body.optionalClaims !== undefined) {
      if (body.optionalClaims === null) {
        out.optionalClaims = null;
      } else {
        const claims = asRecord(body.optionalClaims);
        if (claims === null)
          return badRequest(ctx, 'The property optionalClaims must be an object.');
        for (const [kind, list] of Object.entries(claims)) {
          if (!['idToken', 'accessToken', 'saml2Token'].includes(kind) || !Array.isArray(list)) {
            return badRequest(ctx, 'The property optionalClaims is not valid.');
          }
          for (const claim of list as unknown[]) {
            const record = asRecord(claim);
            if (
              record === null ||
              typeof record.name !== 'string' ||
              record.name.length === 0 ||
              Object.keys(record).some(
                (name) => !['name', 'essential', 'source', 'additionalProperties'].includes(name),
              ) ||
              (record.essential !== undefined && typeof record.essential !== 'boolean')
            ) {
              return badRequest(ctx, 'The property optionalClaims is not valid.');
            }
          }
        }
        out.optionalClaims = claims;
      }
    }
    if (body.tags !== undefined) {
      if (
        !Array.isArray(body.tags) ||
        (body.tags as unknown[]).some(
          (tag) => typeof tag !== 'string' || tag.length === 0 || tag.length > 256,
        )
      ) {
        return badRequest(
          ctx,
          'The property tags must be a collection of strings of 1 to 256 characters.',
        );
      }
      out.tags = [...(body.tags as string[])];
    }
    if (body.keyCredentials !== undefined) {
      const credentials = body.keyCredentials;
      if (!Array.isArray(credentials))
        return badRequest(ctx, 'The property keyCredentials must be a collection.');
      const built: KeyCredentialRecord[] = [];
      for (const item of credentials as unknown[]) {
        const record = asRecord(item);
        if (
          record === null ||
          Object.keys(record).some(
            (name) =>
              ![
                'type',
                'usage',
                'key',
                'displayName',
                'startDateTime',
                'endDateTime',
                'customKeyIdentifier',
                'keyId',
              ].includes(name),
          )
        ) {
          return badRequest(ctx, 'The property keyCredentials is not valid.');
        }
        if (record.type !== 'AsymmetricX509Cert' || record.usage !== 'Verify') {
          return badRequest(
            ctx,
            'The type must be AsymmetricX509Cert and the usage must be Verify.',
          );
        }
        if (typeof record.key !== 'string') {
          // An existing credential re-sent without its key keeps the stored one when it matches by keyId.
          const kept =
            typeof record.keyId === 'string'
              ? existing?.keyCredentials.find((candidate) => candidate.keyId === record.keyId)
              : undefined;
          if (kept === undefined) return badRequest(ctx, 'The key of a credential is required.');
          built.push(kept);
          continue;
        }
        for (const name of ['startDateTime', 'endDateTime'] as const) {
          const value = record[name];
          if (
            value !== undefined &&
            value !== null &&
            (typeof value !== 'string' || !isoDate.test(value))
          ) {
            return badRequest(ctx, `The property ${name} is not a valid date time.`);
          }
        }
        const start = typeof record.startDateTime === 'string' ? record.startDateTime : null;
        const end = typeof record.endDateTime === 'string' ? record.endDateTime : null;
        if (settings.maxCredentialDays !== null && start !== null && end !== null) {
          const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
          if (days > settings.maxCredentialDays) {
            stats.policyRefusals += 1;
            return badRequest(
              ctx,
              'Credential lifetime exceeds the maximum allowed by an application management policy.',
            );
          }
        }
        try {
          const sameKey = existing?.keyCredentials.find(
            (candidate) => candidate.key === record.key,
          );
          built.push(
            directory.credentialFromUpload({
              key: record.key,
              type: record.type,
              usage: record.usage,
              displayName: typeof record.displayName === 'string' ? record.displayName : null,
              startDateTime: start,
              endDateTime: end,
              ...(sameKey === undefined ? {} : { keyId: sameKey.keyId }),
            }),
          );
        } catch (failure) {
          if (failure instanceof InvalidCertificateError)
            return badRequest(ctx, `The key credential is not valid: ${failure.message}.`);
          throw failure;
        }
      }
      out.keyCredentials = built;
    }
    return out;
  }

  return { module, control };
}

/** Reply URL rules of Learn (reply-url): https, or http for localhost only; no wildcards or listed characters. */
function redirectUriRefusal(uri: string, rejectLocalhost: boolean): string | null {
  if (uri.length === 0 || uri.length > 256) return 'a redirect URI has 1 to 256 characters';
  if (/[*!$'(),;\s]/.test(uri))
    return "a redirect URI has no wildcard, white space or any of ! $ ' ( ) , ;";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'a redirect URI is an absolute URI';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && url.hostname === 'localhost') {
    return rejectLocalhost ? 'http://localhost is refused by this tenant' : null;
  }
  return 'a redirect URI is https, or http for localhost';
}
