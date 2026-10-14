// The fake Exchange Admin API (T-B-066, FR-B-707, FR-B-314; plan 14.2; research-microsoft-b.md
// section 9): `POST https://outlook.office365.com/adminapi/v2.0/<TenantID>/<EndpointName>` and nothing
// else. It answers only what the Learn pages document:
//
//   - POST only (there is no GET: the core answers 405), `Authorization: Bearer`, `Content-Type:
//     application/json`, `X-AnchorMailbox: APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tenant>`
//     (mandatory) and the body `{"CmdletInput":{"CmdletName":...,"Parameters":...}}`;
//   - a token without the application role `Exchange.ManageAsAppV2` is 401 (consent missing); a token
//     that has the role but whose snapshot lacks an Exchange Administrator or Exchange Recipient
//     Administrator assignment is 403 ("without the appropriate RBAC role assignments, even valid
//     tokens fail with 403"); `propagation(n)` makes the first n otherwise valid calls 403;
//   - the six documented endpoints exist; `OrganizationConfig` (Get-OrganizationConfig, no
//     parameters) and `DistributionGroupMember` (Get-DistributionGroupMember, `Identity` required,
//     `ResultSize` 1 or more or "Unlimited") are implemented; any other endpoint, cmdlet or
//     parameter is 400 ("Passing unsupported cmdlets or parameters results in 400 Bad Request");
//   - `$select` keeps the named properties and skips unknown ones; without it the Preview's full
//     output comes back;
//   - `ResultSize` is the page size (default 1,000); a longer result carries `@odata.nextLink`, to be
//     POSTed with the same body, valid for `nextLinkLifetimeMs` (default 5 minutes: Learn says 5 to
//     10) and 400 afterwards.
//
// Not documented, so a switch instead of a rule (spec 8.8, U25 and U45): the envelope of the answer
// (`envelope`: a `value` object, a top-level array, a single object), and what the service says when
// the Preview is not available in the organization (`previewAvailable(false)`, 404 by default).
import type { ExchangeCommandCode } from '../../../../src/ports/errors.js';
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { jsonResponse } from '../index.js';
import type { FakeTenantModule, RouteContext } from '../types.js';
import type { FakeWorld, IssuedToken } from '../graph/tokens.js';
import { runCmdlet } from './cmdlets.js';
import {
  FakeExchangeState,
  renderOrganizationConfig,
  renderRecipient,
  select,
  type FakeDistributionGroup,
} from './state.js';

const HOST = 'outlook.office365.com';
const ORIGIN = 'https://outlook.office365.com';
const SYSTEM_MAILBOX = 'bb558c35-97f1-4cb9-8ff7-d53741dc928c';
const DEFAULT_RESULT_SIZE = 1_000;

/** The six endpoints Learn lists, and the cmdlets each accepts (admin-api-endpoints-reference). */
const ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
  OrganizationConfig: ['Get-OrganizationConfig'],
  AcceptedDomain: ['Get-AcceptedDomain'],
  Mailbox: ['Get-Mailbox', 'Set-Mailbox'],
  MailboxFolderPermission: [
    'Get-MailboxFolderPermission',
    'Add-MailboxFolderPermission',
    'Set-MailboxFolderPermission',
    'Remove-MailboxFolderPermission',
  ],
  DistributionGroupMember: ['Get-DistributionGroupMember'],
  DynamicDistributionGroupMember: ['Get-DynamicDistributionGroupMember'],
};

export type Envelope = 'value' | 'array' | 'single';

export interface ExchangeFaultSpec {
  readonly times: number;
  /** 401 and 429 can carry `Retry-After`; 500, 502, 503 and 504 are plain failures. */
  readonly status: 401 | 429 | 500 | 502 | 503 | 504;
  /** Seconds in `Retry-After` (401 and 429 only); `null` leaves the header out. Default 1. */
  readonly retryAfterSeconds?: number | null;
  readonly form?: 'seconds' | 'httpDate';
}

export interface FakeExchangeControl {
  /** The first `calls` otherwise valid calls answer 403, as RBAC does before it has propagated. */
  propagation(calls: number): void;
  fault(spec: ExchangeFaultSpec): void;
  /** Every `InvokeCommand` call fails with this code (`null`: back to normal). The e2e `connect.error` of a seed. */
  commandFault(code: ExchangeCommandCode | null): void;
  /** U45: the shape of the answer. `value` (default) is an object with a `value` list. */
  envelope(shape: { organizationConfig?: Envelope; recipients?: Envelope }): void;
  /** U25: when `false` every call is answered as an organization without the Preview would (status 404 or 400). */
  previewAvailable(available: boolean, status?: 400 | 404): void;
  /** How long a `@odata.nextLink` stays valid, in milliseconds. Default 300,000. */
  nextLinkLifetimeMs(ms: number): void;
  /** Rewrites a `@odata.nextLink` before it is sent (hostile links for the URL discipline tests). */
  rewriteNextLink(rewrite: ((link: string) => string) | null): void;
}

interface Settings {
  propagationLeft: number;
  envelope: { organizationConfig: Envelope; recipients: Envelope };
  preview: { available: boolean; status: 400 | 404 };
  nextLinkLifetimeMs: number;
  rewrite: ((link: string) => string) | null;
  commandFault: ExchangeCommandCode | null;
}

export interface FakeExchange {
  readonly module: FakeTenantModule;
  readonly control: FakeExchangeControl;
  readonly state: FakeExchangeState;
}

function defaults(): Settings {
  return {
    propagationLeft: 0,
    envelope: { organizationConfig: 'single', recipients: 'value' },
    preview: { available: true, status: 404 },
    nextLinkLifetimeMs: 300_000,
    rewrite: null,
    commandFault: null,
  };
}

const EXCHANGE_ROLE_TEMPLATES: readonly string[] = Object.values(EXCHANGE_ROLES).map(
  (role) => role.templateId,
);

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;

export function exchangeModule(
  world: FakeWorld,
  state: FakeExchangeState = new FakeExchangeState(),
): FakeExchange {
  const { directory } = world;
  let settings = defaults();
  const faults: { spec: ExchangeFaultSpec; left: number }[] = [];
  /** Issued continuation links: skip token to {when, offset, body fingerprint}. */
  const links = new Map<
    string,
    { issuedAt: number; offset: number; fingerprint: string; identity: string }
  >();
  let linkCounter = 0;

  const control: FakeExchangeControl = {
    propagation(calls) {
      settings.propagationLeft = calls;
    },
    fault(spec) {
      faults.push({ spec, left: spec.times });
    },
    envelope(shape) {
      settings.envelope = { ...settings.envelope, ...shape };
    },
    previewAvailable(available, status = 404) {
      settings.preview = { available, status };
    },
    nextLinkLifetimeMs(ms) {
      settings.nextLinkLifetimeMs = ms;
    },
    rewriteNextLink(rewrite) {
      settings.rewrite = rewrite;
    },
    commandFault(code) {
      settings.commandFault = code;
    },
  };

  function error(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ): Response {
    return jsonResponse(
      status,
      { error: { code, message } },
      { 'request-id': directory.newId('exchange-request'), ...headers },
    );
  }

  /** A failed cmdlet as the REST layer words it: HTTP status, a code and a message with the usual sentence. */
  function commandError(code: ExchangeCommandCode, retryAfterMs?: number): Response {
    const text: Record<ExchangeCommandCode, readonly [number, string]> = {
      not_found: [400, "The object couldn't be found on the server."],
      already_exists: [400, 'The proxy address already exists.'],
      already_member: [400, 'The recipient is already a member of the group.'],
      not_a_member: [400, "The recipient isn't a member of the group."],
      member_type_not_allowed: [400, "The recipient isn't a supported member of this group."],
      permission_denied: [403, 'Access is denied for this caller.'],
      manager_check: [400, 'This change can only be performed by a manager of the group.'],
      read_only_object: [
        400,
        'The object is being synchronized from your on-premises organization.',
      ],
      throttled: [429, 'Too many requests.'],
      timeout: [504, 'The operation timed out.'],
      invalid_argument: [400, 'ParameterBindingException: cannot bind the parameter.'],
      not_connected: [503, 'The session is not connected.'],
      role_pending: [400, 'The term is not recognized as the name of a cmdlet.'],
      internal: [500, 'An internal error occurred.'],
    };
    const [status, message] = text[code];
    return error(
      status,
      'CommandError',
      message,
      retryAfterMs === undefined ? {} : { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) },
    );
  }

  function authenticate(ctx: RouteContext): IssuedToken | Response {
    const header = ctx.request.headers.get('authorization');
    const match = header === null ? null : /^Bearer ([\x21-\x7e]+)$/.exec(header);
    const token = match === null ? undefined : world.tokens.lookup(match[1] ?? '');
    if (token?.tenantId !== directory.tenantId || token.audience !== 'exchange') {
      return error(
        401,
        'Unauthorized',
        'The access token is missing, invalid or not for this resource.',
        { 'www-authenticate': 'Bearer' },
      );
    }
    if (ctx.clock.now() >= token.expiresAt) {
      return error(401, 'Unauthorized', 'The access token has expired.', {
        'www-authenticate': 'Bearer',
      });
    }
    return token;
  }

  function takeFault(ctx: RouteContext): Response | null {
    for (const fault of faults) {
      if (fault.left <= 0) continue;
      fault.left -= 1;
      const headers: Record<string, string> = {};
      if (fault.spec.status === 401 || fault.spec.status === 429) {
        const seconds =
          fault.spec.retryAfterSeconds === undefined ? 1 : fault.spec.retryAfterSeconds;
        if (seconds !== null) {
          headers['retry-after'] =
            fault.spec.form === 'httpDate'
              ? new Date(ctx.clock.now() + seconds * 1000).toUTCString()
              : String(seconds);
        }
      }
      const code =
        fault.spec.status === 429
          ? 'TooManyRequests'
          : fault.spec.status === 401
            ? 'Unauthorized'
            : 'ServiceUnavailable';
      return error(fault.spec.status, code, 'Injected by the fake.', headers);
    }
    return null;
  }

  function selectOf(ctx: RouteContext): string[] | null | Response {
    for (const name of ctx.query.keys()) {
      if (name !== '$select' && name !== '$skiptoken')
        return error(400, 'BadRequest', `The query option ${name} is not supported.`);
    }
    const value = ctx.query.get('$select');
    if (value === null) return null;
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  function envelope(
    ctx: RouteContext,
    shape: Envelope,
    rows: Json[],
    nextLink: string | null,
  ): Response {
    const link =
      nextLink === null ? null : settings.rewrite === null ? nextLink : settings.rewrite(nextLink);
    // A top-level array has no room for a continuation link: with more pages it falls back to `value`.
    if (shape === 'array' && link === null)
      return jsonResponse(200, rows, { 'request-id': directory.newId('exchange-request') });
    if (shape === 'single' && link === null) {
      return jsonResponse(200, rows.length === 1 ? rows[0] : { value: rows }, {
        'request-id': directory.newId('exchange-request'),
      });
    }
    return jsonResponse(
      200,
      {
        '@odata.context': `${ORIGIN}/adminapi/v2.0/${ctx.params.tid ?? ''}/$metadata#${String(ctx.params.endpoint)}`,
        value: rows,
        ...(link === null ? {} : { '@odata.nextLink': link }),
      },
      { 'request-id': directory.newId('exchange-request') },
    );
  }

  function organizationConfig(
    ctx: RouteContext,
    cmdlet: string,
    parameters: Json | null,
  ): Response {
    if (cmdlet !== 'Get-OrganizationConfig')
      return error(400, 'BadRequest', 'This endpoint accepts Get-OrganizationConfig only.');
    if (parameters !== null && Object.keys(parameters).length > 0) {
      return error(
        400,
        'BadRequest',
        'No parameters of Get-OrganizationConfig are available through the REST endpoint.',
      );
    }
    const names = selectOf(ctx);
    if (names instanceof Response) return names;
    const row = select(renderOrganizationConfig(state.organizationConfig), names);
    return envelope(ctx, settings.envelope.organizationConfig, [row], null);
  }

  function groupMembers(
    ctx: RouteContext,
    cmdlet: string,
    parameters: Json | null,
    bodyText: string,
  ): Response {
    if (cmdlet !== 'Get-DistributionGroupMember')
      return error(400, 'BadRequest', 'This endpoint accepts Get-DistributionGroupMember only.');
    const unknown =
      parameters === null
        ? undefined
        : Object.keys(parameters).find((name) => name !== 'Identity' && name !== 'ResultSize');
    if (unknown !== undefined)
      return error(
        400,
        'BadRequest',
        `The parameter ${unknown} is not available through the REST endpoint.`,
      );
    const identity = parameters?.Identity;
    if (typeof identity !== 'string' || identity.length === 0 || identity.length > 512) {
      return error(400, 'BadRequest', 'The parameter Identity is required.');
    }
    let pageSize = DEFAULT_RESULT_SIZE;
    const resultSize = parameters?.ResultSize;
    if (resultSize !== undefined) {
      if (resultSize === 'Unlimited') pageSize = Number.MAX_SAFE_INTEGER;
      else if (typeof resultSize === 'number' && Number.isInteger(resultSize) && resultSize >= 1)
        pageSize = resultSize;
      else
        return error(400, 'BadRequest', 'The parameter ResultSize is an integer or "Unlimited".');
    }
    const names = selectOf(ctx);
    if (names instanceof Response) return names;
    const group: FakeDistributionGroup | undefined = state.findGroup(identity);
    if (group === undefined) {
      return error(
        404,
        'NotFound',
        `The distribution group "${identity.slice(0, 64)}" couldn't be found.`,
      );
    }
    let offset = 0;
    const token = ctx.query.get('$skiptoken');
    if (token !== null) {
      const link = links.get(token);
      if (link === undefined || ctx.clock.now() - link.issuedAt > settings.nextLinkLifetimeMs) {
        return error(400, 'BadRequest', 'The continuation token is not valid or has expired.');
      }
      if (link.fingerprint !== bodyText || link.identity !== identity) {
        return error(
          400,
          'BadRequest',
          'A continuation request carries the same body as the first request.',
        );
      }
      offset = link.offset;
    }
    const rows = group.members
      .slice(offset, offset + pageSize)
      .map((member) => select(renderRecipient(member), names));
    let nextLink: string | null = null;
    if (offset + pageSize < group.members.length) {
      linkCounter += 1;
      const skip = `fk-skip-${String(linkCounter)}`;
      links.set(skip, {
        issuedAt: ctx.clock.now(),
        offset: offset + pageSize,
        fingerprint: bodyText,
        identity,
      });
      const query = new URLSearchParams();
      if (names !== null) query.set('$select', names.join(','));
      const pairs = [...query.entries(), ['$skiptoken', skip] as [string, string]].map(
        ([key, value]) => `${key}=${encodeURIComponent(value)}`,
      );
      nextLink = `${ORIGIN}${ctx.url.pathname}?${pairs.join('&')}`;
    }
    return envelope(ctx, settings.envelope.recipients, rows, nextLink);
  }

  /** The checks both routes share: token, injected faults, tenant, headers, role, RBAC, propagation, preview. */
  function guard(ctx: RouteContext, roles: readonly string[]): Response | null {
    const token = authenticate(ctx);
    if (token instanceof Response) return token;
    const fault = takeFault(ctx);
    if (fault !== null) return fault;

    const tenant = (ctx.params.tid ?? '').toLowerCase();
    if (tenant !== directory.tenantId)
      return error(403, 'Forbidden', 'The tenant in the URL is not the tenant of the token.');
    const type = ctx.request.headers.get('content-type');
    if (type === null || !/^application\/json\s*(;|$)/i.test(type)) {
      return error(415, 'UnsupportedMediaType', 'The content type must be application/json.');
    }
    const anchor = ctx.request.headers.get('x-anchormailbox');
    const anchorPattern = new RegExp(`^APP:SystemMailbox\\{${SYSTEM_MAILBOX}\\}@(.+)$`, 'i');
    const anchorMatch = anchor === null ? null : anchorPattern.exec(anchor);
    if (anchorMatch === null) {
      return error(
        400,
        'BadRequest',
        'The header X-AnchorMailbox is required: APP:SystemMailbox{...}@<tenant>.',
      );
    }

    // Roles. No ManageAsAppV2 role: the consent is missing, 401. The role without an Exchange
    // role assignment (or one that has not propagated): 403.
    if (!roles.some((role) => token.roles.includes(role))) {
      return error(
        401,
        'Unauthorized',
        'The token does not carry an Exchange.ManageAsApp application role.',
        { 'www-authenticate': 'Bearer' },
      );
    }
    const rbac = token.entraRoleTemplateIds.some((id) => EXCHANGE_ROLE_TEMPLATES.includes(id));
    if (!rbac)
      return error(403, 'Forbidden', 'The caller has no role assignment that allows this call.');
    if (settings.propagationLeft > 0) {
      settings.propagationLeft -= 1;
      return error(403, 'Forbidden', 'The caller has no role assignment that allows this call.');
    }
    if (!settings.preview.available) {
      return error(
        settings.preview.status,
        'NotFound',
        'The Admin API is not available for this organization.',
      );
    }
    return null;
  }

  const module: FakeTenantModule = (core) => {
    core.onReset(() => {
      settings = defaults();
      faults.length = 0;
      links.clear();
      linkCounter = 0;
      state.reset();
    });
    core.router.add({
      host: HOST,
      method: 'POST',
      path: '/adminapi/v2.0/:tid/:endpoint',
      // Every call reads; none changes the directory (the Phase B adapter is read-only).
      mutating: false,
      handler: async (ctx) => {
        const refused = guard(ctx, ['Exchange.ManageAsAppV2']);
        if (refused !== null) return refused;

        const endpoint = ctx.params.endpoint ?? '';
        const cmdlets = ENDPOINTS[endpoint];
        if (cmdlets === undefined) return error(400, 'BadRequest', 'This endpoint does not exist.');

        const bodyText = await ctx.request.clone().text();
        const body = asRecord(await ctx.json());
        const input = body === null ? null : asRecord(body.CmdletInput);
        if (
          body === null ||
          input === null ||
          Object.keys(body).some((name) => name !== 'CmdletInput')
        ) {
          return error(400, 'BadRequest', 'The body must be {"CmdletInput": {...}}.');
        }
        if (Object.keys(input).some((name) => name !== 'CmdletName' && name !== 'Parameters')) {
          return error(400, 'BadRequest', 'CmdletInput has CmdletName and Parameters only.');
        }
        const cmdlet = input.CmdletName;
        if (typeof cmdlet !== 'string' || !cmdlets.includes(cmdlet)) {
          return error(400, 'BadRequest', 'This endpoint does not accept that cmdlet.');
        }
        const parameters = input.Parameters === undefined ? null : asRecord(input.Parameters);
        if (input.Parameters !== undefined && parameters === null)
          return error(400, 'BadRequest', 'Parameters must be an object.');

        if (endpoint === 'OrganizationConfig') return organizationConfig(ctx, cmdlet, parameters);
        if (endpoint === 'DistributionGroupMember')
          return groupMembers(ctx, cmdlet, parameters, bodyText);
        // Documented by Learn, not implemented by the fake: the product does not call it.
        return error(400, 'BadRequest', `The fake does not implement the ${endpoint} endpoint.`);
      },
    });

    // The undocumented `InvokeCommand` endpoint (ADR 0182): any cmdlet of the allow-list, run over the fake
    // state by `runCmdlet`. Errors are answered the way the REST layer words them, so the product's
    // classifier (error-class.ts) is tested against text and not against a mirror of its own code.
    core.router.add({
      host: HOST,
      method: 'POST',
      path: '/adminapi/beta/:tid/InvokeCommand',
      // Reads and writes share the route; the call log's `mutating` count is for the directory (Graph).
      mutating: false,
      handler: async (ctx) => {
        const refused = guard(ctx, ['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2']);
        if (refused !== null) return refused;
        const body = asRecord(await ctx.json());
        const input = body === null ? null : asRecord(body.CmdletInput);
        if (input === null || Object.keys(body ?? {}).some((name) => name !== 'CmdletInput')) {
          return error(400, 'BadRequest', 'The body must be {"CmdletInput": {...}}.');
        }
        const cmdlet = input.CmdletName;
        const parameters = input.Parameters === undefined ? {} : asRecord(input.Parameters);
        if (typeof cmdlet !== 'string' || parameters === null) {
          return error(400, 'BadRequest', 'CmdletName and Parameters are required.');
        }
        if (settings.commandFault !== null) return commandError(settings.commandFault);
        const outcome = runCmdlet(state, cmdlet, parameters);
        if (!outcome.ok) return commandError(outcome.error, outcome.retryAfterMs);
        const rows = (outcome.data as { rows?: unknown }).rows;
        return jsonResponse(
          200,
          {
            '@odata.context': `${ORIGIN}/adminapi/beta/${ctx.params.tid ?? ''}/$metadata#Collection(Microsoft.Exchange.Management.RestApiClient.Output)`,
            value: Array.isArray(rows) ? rows : [],
          },
          { 'request-id': directory.newId('exchange-request') },
        );
      },
    });
  };

  return { module, control, state };
}
