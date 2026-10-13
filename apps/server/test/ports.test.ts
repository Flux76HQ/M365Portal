// T-B-060, CB6, FR-B-311, FR-B-314, FR-B-315, SB-05, SB-34, PB-20: the ports Microsoft's clients sit
// behind, the error taxonomy, and the three sources of time and randomness.
//
// What the file proves:
//   1. every error class has a stable code, a retry flag and only the fields of plan 8.2, and
//      nothing from outside (a token, a header value, a body, Microsoft's free text) can get into
//      `message`, `toString`, `JSON.stringify` or `util.inspect` (canary + negative);
//   2. the port signatures of plan 8.1 (`expectTypeOf`);
//   3. `Clock`, `Scheduler` and `RandomSource` are what Phase A's `ServerClock`, `Scheduler`,
//      `FakeClock` and `FakeScheduler` already are (SB-34): one shape, not a second one;
//   4. the port files import nothing external and do no I/O (a source scan, + negative).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ServerClock } from '../src/app.js';
import type { Scheduler as LifecycleScheduler } from '../src/lifecycle/sweepers.js';
import type { Clock, RandomSource, Scheduler } from '../src/ports/clock.js';
import {
  DEVICE_CODE_KINDS,
  DeviceCodeError,
  ExchangeBadRequestError,
  ExchangeForbiddenError,
  ExchangeNetworkError,
  ExchangeThrottledError,
  ExchangeTransientError,
  ExchangeUnauthorizedError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  GraphBadRequestError,
  GraphConflictError,
  GraphForbiddenError,
  GraphNetworkError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
  GraphUnauthorizedError,
  ID_TOKEN_CHECKS,
  IdTokenError,
  IntegrationError,
  NotConnectedError,
  SECRETS_UNAVAILABLE_REASONS,
  SecretsUnavailableError,
  TokenEndpointError,
} from '../src/ports/errors.js';
import type {
  CallOptions,
  DirectoryGroup,
  DirectoryUser,
  GraphClient,
  Guid,
  OrganizationInfo,
} from '../src/ports/graph.js';
import type {
  AccessToken,
  AppTokenProvider,
  BootstrapAuthenticator,
  BootstrapIdentity,
  CompactSigner,
  DeviceCodeInfo,
  OidcClient,
  ValidatedIdToken,
} from '../src/ports/identity.js';
import type {
  ExchangeClient,
  ExchangeOrganizationConfig,
  ExchangeProbeResult,
  ExchangeRecipient,
} from '../src/ports/exchange.js';
import type { BearerTokenProvider, TenantProvisioner } from '../src/ports/provisioner.js';
import type { SecretsState } from '../src/ports/secrets.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { createFakeScheduler } from './helpers/fake-scheduler.js';

// ---------------------------------------------------------------------------------------------
// 1. The error taxonomy
// ---------------------------------------------------------------------------------------------

/** A token-shaped secret, a header value, a body and free text: none may reach an error. */
const CANARIES = {
  bearer:
    'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.CANARYtokenPAYLOAD0123456789.CANARYsignature',
  header: 'Authorization: Bearer CANARY-header-value-9f3a',
  body: '{"password":"CANARY-body-secret","key":"CANARY-key"}',
  text: 'AADSTS70011: The provided request must include CANARY-free-text and user@example.test',
} as const;
const CANARY_PATTERN = /CANARY|Bearer|eyJ|password|example\.test|AADSTS70011/;

interface ErrorRow {
  readonly name: string;
  readonly construct: (details?: Record<string, unknown>) => IntegrationError;
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
}

const ERROR_ROWS: readonly ErrorRow[] = [
  {
    name: 'GraphBadRequestError',
    construct: (d) => new GraphBadRequestError(d),
    code: 'graph_bad_request',
    retryable: false,
    status: 400,
  },
  {
    name: 'GraphUnauthorizedError',
    construct: (d) => new GraphUnauthorizedError(d),
    code: 'graph_unauthorized',
    retryable: false,
    status: 401,
  },
  {
    name: 'GraphForbiddenError',
    construct: (d) => new GraphForbiddenError(d),
    code: 'graph_forbidden',
    retryable: false,
    status: 403,
  },
  {
    name: 'GraphNotFoundError',
    construct: (d) => new GraphNotFoundError(d),
    code: 'graph_not_found',
    retryable: false,
    status: 404,
  },
  {
    name: 'GraphConflictError',
    construct: (d) => new GraphConflictError(d),
    code: 'graph_conflict',
    retryable: false,
    status: 409,
  },
  {
    name: 'GraphThrottledError',
    construct: (d) => new GraphThrottledError(d),
    code: 'graph_throttled',
    retryable: true,
    status: 429,
  },
  {
    name: 'GraphTransientError',
    construct: (d) => new GraphTransientError(d),
    code: 'graph_transient',
    retryable: true,
    status: 503,
  },
  {
    name: 'GraphNetworkError',
    construct: (d) => new GraphNetworkError(d),
    code: 'graph_network',
    retryable: true,
    status: undefined,
  },
  {
    name: 'ExchangeBadRequestError',
    construct: (d) => new ExchangeBadRequestError(d),
    code: 'exchange_bad_request',
    retryable: false,
    status: 400,
  },
  {
    name: 'ExchangeUnauthorizedError',
    construct: (d) => new ExchangeUnauthorizedError(d),
    code: 'exchange_unauthorized',
    retryable: false,
    status: 401,
  },
  {
    name: 'ExchangeForbiddenError',
    construct: (d) => new ExchangeForbiddenError(d),
    code: 'exchange_forbidden',
    retryable: false,
    status: 403,
  },
  {
    name: 'ExchangeThrottledError',
    construct: (d) => new ExchangeThrottledError(d),
    code: 'exchange_throttled',
    retryable: true,
    status: 429,
  },
  {
    name: 'ExchangeTransientError',
    construct: (d) => new ExchangeTransientError(d),
    code: 'exchange_transient',
    retryable: true,
    status: 503,
  },
  {
    name: 'ExchangeNetworkError',
    construct: (d) => new ExchangeNetworkError(d),
    code: 'exchange_network',
    retryable: true,
    status: undefined,
  },
  {
    name: 'ExchangeUnavailableError',
    construct: (d) => new ExchangeUnavailableError(d),
    code: 'exchange_unavailable',
    retryable: false,
    status: undefined,
  },
  {
    name: 'ExchangeUnsupportedError',
    construct: (d) => new ExchangeUnsupportedError(d),
    code: 'exchange_unsupported',
    retryable: false,
    status: undefined,
  },
  {
    name: 'TokenEndpointError',
    construct: (d) => new TokenEndpointError(d),
    code: 'token_endpoint_error',
    retryable: false,
    status: undefined,
  },
  {
    name: 'IdTokenError',
    construct: (d) => new IdTokenError({ ...d, check: 'signature' } as never),
    code: 'id_token_invalid',
    retryable: false,
    status: undefined,
  },
  {
    name: 'DeviceCodeError',
    construct: (d) => new DeviceCodeError({ ...d, kind: 'failed' } as never),
    code: 'device_code_failed',
    retryable: false,
    status: undefined,
  },
  {
    name: 'SecretsUnavailableError',
    construct: (d) => new SecretsUnavailableError({ ...d, reason: 'app_key_missing' } as never),
    code: 'secrets_unavailable',
    retryable: false,
    status: undefined,
  },
  {
    name: 'NotConnectedError',
    construct: (d) => new NotConnectedError(d),
    code: 'not_connected',
    retryable: false,
    status: undefined,
  },
];

/** What a safe error may show: it must not contain any canary, in any rendering of it. */
function renderings(error: Error): string[] {
  return [
    error.message,
    error.toString(),
    JSON.stringify(error),
    inspect(error, { depth: 6, showHidden: true }),
    inspect(error, { depth: 6, getters: true }),
    String(error.stack),
    `${error.name}: ${error.message}`,
  ];
}

/** The guard of the canary rule: throws when any rendering of `error` shows a canary. */
function assertNoLeak(error: Error): void {
  for (const rendering of renderings(error)) {
    const found = CANARY_PATTERN.exec(rendering);
    if (found !== null) throw new Error(`leaked ${found[0]} into a rendering of the error`);
  }
}

/** Every field a hostile caller might offer, including the ones the classes must not accept. */
function hostileDetails(): Record<string, unknown> {
  return {
    message: CANARIES.text,
    cause: new Error(CANARIES.bearer),
    token: CANARIES.bearer,
    accessToken: CANARIES.bearer,
    authorization: CANARIES.header,
    headers: { authorization: CANARIES.header },
    body: CANARIES.body,
    requestBody: CANARIES.body,
    response: { text: CANARIES.text },
    description: CANARIES.text,
    error_description: CANARIES.text,
    graphCode: CANARIES.header,
    requestId: CANARIES.bearer,
    clientRequestId: CANARIES.body,
    aadsts: CANARIES.text,
    error: CANARIES.text,
    reason: CANARIES.text,
    check: CANARIES.text,
    kind: CANARIES.text,
    status: CANARIES.text,
    retryAfterMs: CANARIES.text,
  };
}

describe('the error taxonomy (plan 8.2): stable codes', () => {
  it.each(ERROR_ROWS)('$name has code $code, retryable $retryable, status $status', (row) => {
    const error = row.construct();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error.name).toBe(row.name);
    expect(error.code).toBe(row.code);
    expect(error.retryable).toBe(row.retryable);
    expect(error.status).toBe(row.status);
    expect(error.message).toBe(row.code);
    expect(error.toString()).toBe(`${row.name}: ${row.code}`);
  });

  it('gives every class its own code', () => {
    const codes = ERROR_ROWS.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('keeps codes that are also problem codes of the API in their registry spelling', () => {
    // `graph_throttled` and `secrets_unavailable` are Phase B problem codes (spec 6.9.5).
    expect(new GraphThrottledError().code).toBe('graph_throttled');
    expect(new SecretsUnavailableError({ reason: 'app_key_invalid' }).code).toBe(
      'secrets_unavailable',
    );
  });

  it('forms the Graph, Exchange and identity families', () => {
    const graph = ERROR_ROWS.filter((row) => row.name.startsWith('Graph'));
    const exchange = ERROR_ROWS.filter((row) => row.name.startsWith('Exchange'));
    expect(graph).toHaveLength(8);
    expect(exchange).toHaveLength(8);
    for (const row of graph) expect(row.construct().code).toMatch(/^graph_/);
    for (const row of exchange) expect(row.construct().code).toMatch(/^exchange_/);
  });
});

describe('the error taxonomy: the optional fields', () => {
  it('carries status, retryAfterMs, Graph code, correlation ids and the AADSTS number', () => {
    const error = new GraphThrottledError({
      retryAfterMs: 61_000,
      graphCode: 'TooManyRequests',
      requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      clientRequestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      aadsts: 53003,
    });
    expect(error.retryAfterMs).toBe(61_000);
    expect(error.graphCode).toBe('TooManyRequests');
    expect(error.requestId).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(error.clientRequestId).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(error.aadsts).toBe(53003);
    expect(error.toJSON()).toEqual({
      name: 'GraphThrottledError',
      code: 'graph_throttled',
      retryable: true,
      status: 429,
      retryAfterMs: 61_000,
      graphCode: 'TooManyRequests',
      requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      clientRequestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      aadsts: 53003,
    });
  });

  it('leaves absent fields out of the JSON form', () => {
    expect(new GraphNotFoundError().toJSON()).toEqual({
      name: 'GraphNotFoundError',
      code: 'graph_not_found',
      retryable: false,
      status: 404,
    });
  });

  it('lets a transient error carry its own 5xx status, and nothing else', () => {
    expect(new GraphTransientError({ status: 502 }).status).toBe(502);
    expect(new GraphTransientError({ status: 504 }).status).toBe(504);
    expect(new GraphTransientError({ status: 200 }).status).toBe(503);
    expect(new GraphTransientError({ status: 404 }).status).toBe(503);
    expect(new ExchangeTransientError({ status: 500 }).status).toBe(500);
  });

  it('fixes the status of the classes that name one', () => {
    expect(new GraphNotFoundError({ status: 500 }).status).toBe(404);
    expect(new ExchangeForbiddenError({ status: 200 }).status).toBe(403);
  });

  it('takes the status of an Exchange "other 4xx" error from the caller, 400 to 499 only', () => {
    expect(new ExchangeUnavailableError({ status: 404 }).status).toBe(404);
    expect(new ExchangeUnavailableError({ status: 500 }).status).toBeUndefined();
    expect(new ExchangeUnavailableError({ status: 99 }).status).toBeUndefined();
  });

  it.each([
    ['Graph', 'TooManyRequests'],
    ['Graph', 'Request_ResourceNotFound'],
    ['Graph', 'a.b.C_9'],
    ['Graph', 'x'.repeat(64)],
  ])('accepts the %s error code %s', (_family, graphCode) => {
    expect(new GraphBadRequestError({ graphCode }).graphCode).toBe(graphCode);
  });

  it.each([
    ['too long', 'x'.repeat(65)],
    ['empty', ''],
    ['a space', 'Too Many'],
    ['a dash', 'Too-Many'],
    ['a colon', 'Error: x'],
    ['a newline', 'A\nB'],
    ['markup', '<b>'],
    ['not a string', 7],
  ])('drops a Graph error code that is %s', (_name, graphCode) => {
    expect(new GraphBadRequestError({ graphCode } as never).graphCode).toBeUndefined();
  });

  it.each([
    ['digits', 65001, 65001],
    ['digits as text', '65001', 65001],
    ['four digits', 1234, 1234],
    ['seven digits', 1_234_567, 1_234_567],
    ['text with a prefix', 'AADSTS65001', undefined],
    ['three digits', 123, undefined],
    ['eight digits', 12_345_678, undefined],
    ['a fraction', 65001.5, undefined],
    ['a negative', -65001, undefined],
    ['text after digits', '65001: text', undefined],
    ['NaN', Number.NaN, undefined],
  ])('keeps an AADSTS number of digits only: %s', (_name, aadsts, expected) => {
    expect(new TokenEndpointError({ aadsts }).aadsts).toBe(expected);
  });

  it.each([
    ['0', 0, 0],
    ['a wait', 1500, 1500],
    ['a day', 86_400_000, 86_400_000],
    ['negative', -1, undefined],
    ['a fraction', 1.5, undefined],
    ['infinite', Number.POSITIVE_INFINITY, undefined],
    ['NaN', Number.NaN, undefined],
    ['text', '1500', undefined],
    ['over a week', 8 * 86_400_000, undefined],
  ])(
    'keeps retryAfterMs only as a whole, bounded number of milliseconds: %s',
    (_n, value, kept) => {
      expect(new GraphThrottledError({ retryAfterMs: value } as never).retryAfterMs).toBe(kept);
    },
  );

  it.each([
    ['a GUID', '0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['a short id', 'abc123'],
    ['64 characters', 'a'.repeat(64)],
  ])('keeps a correlation id that is %s', (_n, id) => {
    expect(new GraphForbiddenError({ requestId: id, clientRequestId: id }).requestId).toBe(id);
  });

  it.each([
    ['a header value', CANARIES.header],
    ['a token', CANARIES.bearer],
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
    ['with a space', 'a b'],
  ])('drops a correlation id that is %s', (_n, id) => {
    const error = new GraphForbiddenError({ requestId: id, clientRequestId: id });
    expect(error.requestId).toBeUndefined();
    expect(error.clientRequestId).toBeUndefined();
  });
});

describe('the error taxonomy: family fields', () => {
  it('TokenEndpointError keeps the OAuth error string and the AADSTS number', () => {
    const error = new TokenEndpointError({ error: 'invalid_client', aadsts: 7000215, status: 401 });
    expect(error.error).toBe('invalid_client');
    expect(error.aadsts).toBe(7000215);
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
  });

  it('TokenEndpointError replaces an error string that is not an OAuth error code by "unknown"', () => {
    expect(new TokenEndpointError({ error: CANARIES.text }).error).toBe('unknown');
    expect(new TokenEndpointError({ error: 'Invalid Client' }).error).toBe('unknown');
    expect(new TokenEndpointError({ error: 'x'.repeat(65) }).error).toBe('unknown');
    expect(new TokenEndpointError().error).toBe('unknown');
  });

  it('TokenEndpointError is retryable only for temporarily_unavailable (FR-B-403 step 6)', () => {
    expect(new TokenEndpointError({ error: 'temporarily_unavailable' }).retryable).toBe(true);
    expect(new TokenEndpointError({ error: 'invalid_grant' }).retryable).toBe(false);
    expect(new TokenEndpointError({ error: 'invalid_client' }).retryable).toBe(false);
  });

  it('IdTokenError names the check of Appendix C (SB-08)', () => {
    expect([...ID_TOKEN_CHECKS]).toEqual([
      'size',
      'format',
      'header',
      'alg',
      'tenant',
      'issuer',
      'kid',
      'signature',
      'expired',
      'not_before',
      'audience',
      'issued_at',
      'version',
      'oid',
      'nonce',
      'keys_unavailable',
    ]);
    for (const check of ID_TOKEN_CHECKS) {
      const error = new IdTokenError({ check });
      expect(error.check).toBe(check);
      expect(error.retryable).toBe(check === 'keys_unavailable');
    }
  });

  it('IdTokenError refuses a check that is not in the list', () => {
    expect(() => new IdTokenError({ check: CANARIES.text as never })).toThrow(/id token check/);
    expect(() => new IdTokenError({} as never)).toThrow(TypeError);
  });

  it('DeviceCodeError has the six kinds and the AADSTS number', () => {
    expect([...DEVICE_CODE_KINDS]).toEqual([
      'expired',
      'declined',
      'cancelled',
      'blocked',
      'bad_code',
      'failed',
    ]);
    const error = new DeviceCodeError({ kind: 'blocked', aadsts: 53003 });
    expect(error.kind).toBe('blocked');
    expect(error.aadsts).toBe(53003);
    expect(() => new DeviceCodeError({ kind: 'nope' as never })).toThrow(TypeError);
  });

  it('SecretsUnavailableError has the reasons of the secrets state', () => {
    expect([...SECRETS_UNAVAILABLE_REASONS]).toEqual([
      'app_key_missing',
      'app_key_invalid',
      'certificate_unreadable',
      'no_certificate',
    ]);
    expect(new SecretsUnavailableError({ reason: 'certificate_unreadable' }).reason).toBe(
      'certificate_unreadable',
    );
    expect(() => new SecretsUnavailableError({ reason: 'nope' as never })).toThrow(TypeError);
  });

  it('ExchangeUnavailableError and ExchangeUnsupportedError keep a reason word', () => {
    expect(new ExchangeUnavailableError({ reason: 'invalid_next_link' }).reason).toBe(
      'invalid_next_link',
    );
    expect(new ExchangeUnavailableError({ reason: 'paging_window_exceeded' }).reason).toBe(
      'paging_window_exceeded',
    );
    expect(new ExchangeUnsupportedError({ reason: 'cmdlet_not_allowed' }).reason).toBe(
      'cmdlet_not_allowed',
    );
    expect(new ExchangeUnavailableError().reason).toBe('unavailable');
    expect(new ExchangeUnavailableError({ reason: CANARIES.text }).reason).toBe('unavailable');
    expect(new ExchangeUnsupportedError({ reason: 'Not A Word' }).reason).toBe('unsupported');
  });
});

describe('the error taxonomy: nothing from outside gets in (canary)', () => {
  it.each(ERROR_ROWS)('$name shows no secret, header, body or free text', (row) => {
    const error = row.construct(hostileDetails());
    expect(() => {
      assertNoLeak(error);
    }).not.toThrow();
    expect(error.message).toBe(row.code);
    expect(Object.keys(error).sort()).not.toContain('cause');
    expect(Object.keys(error).join(',')).not.toMatch(/token|body|header|response|authorization/i);
  });

  it.each(ERROR_ROWS)('$name keeps a canary out of its own properties', (row) => {
    const error = row.construct(hostileDetails());
    const own = JSON.stringify(Object.entries(Object.getOwnPropertyDescriptors(error)));
    expect(own).not.toMatch(CANARY_PATTERN);
  });

  it('does not keep a cause, whatever the caller passes', () => {
    const error = new GraphNetworkError({ cause: new Error(CANARIES.bearer) } as never);
    expect(error.cause).toBeUndefined();
  });

  it('is detected when an error would carry text (negative)', () => {
    class Leaky extends Error {
      constructor() {
        super(CANARIES.text);
      }
    }
    expectGuardFails(assertNoLeak, new Leaky(), { reason: 'leaked' });
    class LeakyJson extends Error {
      toJSON(): unknown {
        return { body: CANARIES.body };
      }
    }
    expectGuardFails(assertNoLeak, new LeakyJson('graph_bad_request'), { reason: 'leaked' });
  });

  it('is detected when an error would show a header in util.inspect (negative)', () => {
    const error = Object.assign(new Error('graph_bad_request'), {
      headers: { authorization: CANARIES.header },
    });
    expectGuardFails(assertNoLeak, error, { reason: 'leaked' });
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The port signatures of plan 8.1
// ---------------------------------------------------------------------------------------------

describe('the port signatures (plan 8.1)', () => {
  it('GraphClient is app-only and read-only: the six methods of Phase B and the six reads of Phase C', () => {
    expectTypeOf<keyof GraphClient>().toEqualTypeOf<
      | 'getOrganization'
      | 'probeUsers'
      | 'getUser'
      | 'checkMemberGroups'
      | 'searchGroups'
      | 'getGroup'
      | 'listUsers'
      | 'getUserManager'
      | 'listUserGroups'
      | 'listGroups'
      | 'listGroupMembers'
      | 'listGroupOwners'
    >();
    expectTypeOf<GraphClient['getOrganization']>().toEqualTypeOf<() => Promise<OrganizationInfo>>();
    expectTypeOf<GraphClient['probeUsers']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<GraphClient['getUser']>().toEqualTypeOf<
      (idOrUpn: string, o?: CallOptions) => Promise<DirectoryUser | null>
    >();
    expectTypeOf<GraphClient['checkMemberGroups']>().toEqualTypeOf<
      (userId: Guid, groupIds: readonly Guid[], o?: CallOptions) => Promise<ReadonlySet<Guid>>
    >();
    expectTypeOf<GraphClient['searchGroups']>().toEqualTypeOf<
      (prefix: string, top: number) => Promise<DirectoryGroup[]>
    >();
    expectTypeOf<GraphClient['getGroup']>().toEqualTypeOf<
      (id: Guid) => Promise<DirectoryGroup | null>
    >();
  });

  it('CallOptions has priority, budget and signal', () => {
    expectTypeOf<CallOptions>().toEqualTypeOf<{
      priority?: 'high' | 'low';
      budget?: 'interactive' | 'wizard';
      signal?: AbortSignal;
    }>();
  });

  it('the DTOs hold null for a property a call did not return (U36)', () => {
    expectTypeOf<OrganizationInfo>().toEqualTypeOf<{
      readonly id: Guid;
      readonly displayName: string | null;
      readonly initialDomain: string | null;
      readonly defaultDomain: string | null;
    }>();
    expectTypeOf<DirectoryUser['displayName']>().toEqualTypeOf<string | null>();
    expectTypeOf<DirectoryUser['accountEnabled']>().toEqualTypeOf<boolean | null>();
    expectTypeOf<DirectoryGroup['groupTypes']>().toEqualTypeOf<readonly string[] | null>();
  });

  it('TenantProvisioner has the eleven calls of the call sheet and the two adoption-trust reads of FR-B-318', () => {
    expectTypeOf<keyof TenantProvisioner>().toEqualTypeOf<
      | 'findServicePrincipalByAppId'
      | 'getApplication'
      | 'findApplicationsByDisplayName'
      | 'createApplication'
      | 'patchApplication'
      | 'readKeyCredentials'
      | 'createServicePrincipal'
      | 'listAppRoleAssignments'
      | 'grantAppRole'
      | 'listDirectoryRoleAssignments'
      | 'createDirectoryRoleAssignment'
      | 'inspectApplication'
      | 'inspectServicePrincipal'
    >();
  });

  it('TenantProvisioner takes a BearerTokenProvider and never an application token', () => {
    expectTypeOf<BearerTokenProvider>().toEqualTypeOf<() => Promise<string>>();
    expectTypeOf<TenantProvisioner['grantAppRole']>().parameters.toEqualTypeOf<
      [resourceSpId: Guid, principalSpId: Guid, appRoleId: Guid]
    >();
    expectTypeOf<TenantProvisioner['listDirectoryRoleAssignments']>().parameters.toEqualTypeOf<
      [principalId: Guid]
    >();
  });

  it('ExchangeClient has no write capability in Phase B', () => {
    expectTypeOf<ReturnType<ExchangeClient['capabilities']>['write']>().toEqualTypeOf<
      readonly []
    >();
    expectTypeOf<ReturnType<ExchangeClient['capabilities']>['read']>().toEqualTypeOf<
      readonly ('organizationConfig' | 'distributionGroupMembers')[]
    >();
    expectTypeOf<keyof ExchangeClient>().toEqualTypeOf<
      'capabilities' | 'probe' | 'getOrganizationConfig' | 'listDistributionGroupMembers'
    >();
    expectTypeOf<ExchangeClient['probe']>().toEqualTypeOf<
      (o?: { skipCache?: boolean }) => Promise<ExchangeProbeResult>
    >();
    expectTypeOf<ExchangeClient['getOrganizationConfig']>().toEqualTypeOf<
      (select?: readonly string[]) => Promise<ExchangeOrganizationConfig>
    >();
    expectTypeOf<ExchangeClient['listDistributionGroupMembers']>().toEqualTypeOf<
      (identity: string, o?: { resultSize?: number }) => AsyncIterable<ExchangeRecipient>
    >();
    expectTypeOf<ExchangeProbeResult>().toEqualTypeOf<{
      status: 'ok' | 'not_ready' | 'unavailable';
      httpStatus: number | null;
      roleEffective: 'yes' | 'no' | 'unknown';
      previewAvailable: 'yes' | 'no' | 'unknown';
    }>();
  });

  it('the identity ports have the shapes of plan 8.1', () => {
    expectTypeOf<AppTokenProvider['get']>().toEqualTypeOf<
      (resource: 'graph' | 'exchange', o?: { skipCache?: boolean }) => Promise<AccessToken>
    >();
    expectTypeOf<AccessToken['reveal']>().toEqualTypeOf<() => string>();
    expectTypeOf<keyof OidcClient>().toEqualTypeOf<
      'buildAuthorizeUrl' | 'exchangeCode' | 'validateIdToken' | 'endSessionUrl'
    >();
    expectTypeOf<OidcClient['buildAuthorizeUrl']>().toEqualTypeOf<
      (p: {
        state: string;
        nonce: string;
        codeChallenge: string;
        prompt?: 'login' | 'select_account';
      }) => URL
    >();
    expectTypeOf<OidcClient['exchangeCode']>().toEqualTypeOf<
      (p: { code: string; codeVerifier: string }) => Promise<{ idToken: string }>
    >();
    expectTypeOf<OidcClient['validateIdToken']>().toEqualTypeOf<
      (raw: string, p: { nonce: string }) => Promise<ValidatedIdToken>
    >();
    expectTypeOf<OidcClient['endSessionUrl']>().toEqualTypeOf<() => Promise<URL>>();
    expectTypeOf<keyof BootstrapAuthenticator>().toEqualTypeOf<
      'start' | 'completion' | 'bearer' | 'cancel' | 'discard'
    >();
    expectTypeOf<BootstrapAuthenticator['start']>().toEqualTypeOf<
      (o: { tenantHint?: string }) => Promise<DeviceCodeInfo>
    >();
    expectTypeOf<BootstrapAuthenticator['completion']>().toEqualTypeOf<
      () => Promise<BootstrapIdentity>
    >();
    expectTypeOf<BootstrapAuthenticator['bearer']>().toEqualTypeOf<() => BearerTokenProvider>();
  });

  it('CompactSigner signs a header and a payload and returns the compact serialisation', () => {
    expectTypeOf<CompactSigner['signCompact']>().toEqualTypeOf<
      (protectedHeader: Record<string, unknown>, payload: Uint8Array) => Promise<string>
    >();
  });

  it('SecretsState carries a signer only when it is ok', () => {
    expectTypeOf<SecretsState['status']>().toEqualTypeOf<
      'ok' | 'key_missing' | 'key_invalid' | 'certificate_unreadable' | 'no_certificate'
    >();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Clock, RandomSource, Scheduler
// ---------------------------------------------------------------------------------------------

describe('Clock, RandomSource and Scheduler (SB-34, PB-20)', () => {
  it('Clock is one method, now() in milliseconds, which Phase A ServerClock already satisfies', () => {
    expectTypeOf<Clock>().toEqualTypeOf<{ now(): number }>();
    expectTypeOf<ServerClock>().toExtend<Clock>();
    const clock: Clock = { now: () => 1_700_000_000_000 };
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it('RandomSource is bytes(n) and float(), nothing else', () => {
    expectTypeOf<RandomSource>().toEqualTypeOf<{
      bytes(length: number): Uint8Array;
      float(): number;
    }>();
    expectTypeOf<keyof RandomSource>().toEqualTypeOf<'bytes' | 'float'>();
  });

  it('Scheduler is exactly the four methods of lifecycle/sweepers.ts, declared once more only structurally', () => {
    expectTypeOf<Scheduler>().toEqualTypeOf<LifecycleScheduler>();
    expectTypeOf<keyof Scheduler>().toEqualTypeOf<
      'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'
    >();
  });

  it('the Phase A fakes satisfy the ports (reused, not copied)', () => {
    const scheduler: Scheduler = createFakeScheduler();
    let fired = 0;
    const handle = scheduler.setTimeout(() => {
      fired += 1;
    }, 10);
    const cancelled = scheduler.setTimeout(() => {
      fired += 10;
    }, 10);
    scheduler.clearTimeout(cancelled);
    createFakeSchedulerAdvance(scheduler, 10);
    expect(fired).toBe(1);
    expect(handle).toBeDefined();

    const fake = createFakeClock();
    const clock: Clock = { now: () => fake.nowMs() };
    const before = clock.now();
    fake.advance(1500);
    expect(clock.now() - before).toBe(1500);
  });
});

/** The fake scheduler is the one object that can advance; the port has no `advance`. */
function createFakeSchedulerAdvance(scheduler: Scheduler, ms: number): void {
  (scheduler as unknown as { advance(ms: number): void }).advance(ms);
}

// ---------------------------------------------------------------------------------------------
// 4. The ports import nothing external and perform no I/O
// ---------------------------------------------------------------------------------------------

const PORTS_DIRECTORY = fileURLToPath(new URL('../src/ports/', import.meta.url));

const EXPECTED_PORT_FILES = [
  'clock.ts',
  'errors.ts',
  'exchange.ts',
  'graph.ts',
  'identity.ts',
  'provisioner.ts',
  'secrets.ts',
] as const;

/** Specifiers of static imports, re-exports and dynamic imports, plus `require` calls. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1] ?? '');
  }
  return found;
}

const IO_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a global fetch', /(?<![.\w])fetch\s*\(/],
  ['a timer', /(?<![.\w])(setTimeout|setInterval|setImmediate)\s*\((?!\s*\w+\s*[:?])/],
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['new Date()', /\bnew\s+Date\s*\(\s*\)/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['process', /\bprocess\s*\./],
  ['crypto', /\b(crypto|webcrypto)\s*\./],
];

/** Strips comments so the words of the documentation do not count. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The guard: throws when a port file imports a package or a `node:` module, or does I/O. */
function assertPortIsPure(fileName: string, source: string): void {
  const problems: string[] = [];
  const code = codeOf(source);
  for (const specifier of importSpecifiers(code)) {
    const local = specifier.startsWith('./') || specifier.startsWith('../');
    const shared =
      specifier === '@m365portal/shared' || specifier.startsWith('@m365portal/shared/');
    if (!local && !shared) problems.push(`imports "${specifier}"`);
  }
  for (const [label, pattern] of IO_PATTERNS) {
    if (pattern.test(code)) problems.push(`uses ${label}`);
  }
  if (problems.length > 0) throw new Error(`${fileName}: ${problems.join('; ')}`);
}

describe('the port files are pure (FR-B-315, plan 4.3)', () => {
  it('are exactly the seven files of T-B-060', () => {
    expect(readdirSync(PORTS_DIRECTORY).sort()).toEqual([...EXPECTED_PORT_FILES]);
  });

  it.each(EXPECTED_PORT_FILES)('%s imports nothing external and does no I/O', (fileName) => {
    const source = readFileSync(join(PORTS_DIRECTORY, fileName), 'utf8');
    expect(() => {
      assertPortIsPure(fileName, source);
    }).not.toThrow();
  });

  it.each([
    ['a node: module', "import { request } from 'node:https';", /node:https/],
    ['a package', "import { z } from 'zod';", /"zod"/],
    ['an HTTP client', "import { fetch } from 'undici';", /undici/],
    ['a type import of a package', "import type { Dispatcher } from 'undici';", /undici/],
    ['a dynamic import', "const m = await import('node:net');", /node:net/],
    ['a require', "const m = require('jose');", /jose/],
    ['a side-effect import', "import 'reflect-metadata';", /reflect-metadata/],
    ['a global fetch', "export const get = () => fetch('https://graph.microsoft.com');", /fetch/],
    ['Date.now', 'export const now = () => Date.now();', /Date\.now/],
    ['Math.random', 'export const r = () => Math.random();', /Math\.random/],
    ['a timer', 'export const t = () => setTimeout(() => undefined, 1);', /timer/],
  ])('refuses %s (negative)', (_name, source, reason) => {
    expectGuardFails(
      (input: string) => {
        assertPortIsPure('fixture.ts', input);
      },
      source,
      { reason },
    );
  });

  it('accepts relative imports and the shared package (control)', () => {
    expect(() => {
      assertPortIsPure(
        'fixture.ts',
        "import type { Guid } from './graph.js';\nimport { PermissionSchema } from '@m365portal/shared/permissions';\n// fetch( is a word in a comment\n",
      );
    }).not.toThrow();
  });
});
