// The fake Entra (T-B-064, FR-B-707; plan 14.2; research-microsoft-b.md sections 5 and 6): the
// identity provider of the fake tenant. It serves `login.microsoftonline.com` and nothing else:
//
//   GET  /{tenant}/v2.0/.well-known/openid-configuration     discovery
//   GET  /{tenant}/discovery/v2.0/keys                        the key set (rotation, dropping)
//   GET  /{tenant}/oauth2/v2.0/authorize                      signs in a configured user, redirects
//   POST /{tenant}/oauth2/v2.0/token                          authorization_code, client_credentials,
//                                                             device_code (both spellings), refresh_token
//   POST /{tenant}/oauth2/v2.0/devicecode                     the device authorization request
//   GET|POST /{tenant}/oauth2/v2.0/logout                     the end-session endpoint
//
// Strict where Learn is specific (a lenient fake gives false greens, baseline section 2):
//   - /authorize: client id and the exact registered redirect URI (port ignored for a registered
//     `http://localhost` URI only) are checked first and end in an error PAGE, never a redirect; the
//     rest end in a redirect with `error` and `state`. `response_type` is `code`, `response_mode`
//     `query`, PKCE is S256, `state` and `nonce` are required, `prompt` is `login` or
//     `select_account`. Scopes are narrower than Learn: the panel's sign-in asks for OIDC scopes only.
//   - /token: form encoded; client credentials are never accepted together with an `Origin` header
//     (Learn: "prevents the use of client credentials in all flows in the presence of an Origin
//     header"); the client assertion is validated by `assertion.ts`; a code is single use and valid
//     for 60 s ("typically ... about 1 minute"); PKCE is checked; the redirect URI must be the one of
//     the authorize request; `client_credentials` needs `<resource>/.default` and a service principal,
//     and the access token SNAPSHOTS the application's grants at issue time (research section 4).
//   - the device flow: `expires_in` 900, `interval` 5 (scaled by the test), no
//     `verification_uri_complete`, errors as Learn lists them plus `slow_down` (U22).
//
// What the fake invents (UNVERIFIED, recorded in the gate note): the error and the description of a
// Conditional Access block while polling (U61), the refusal of an `Origin` header (the error code is
// not documented, U62), and the single use of an assertion's `jti` (U59). `client_info`, which a real
// token response may carry and Learn's token reference does not list, is left out: MSAL works without it.
//
// IDs and strings are derived from counters, so a failure message names the same value each run.
import { createHash } from 'node:crypto';
import { jsonResponse } from '../index.js';
import type { FakeTenantClock, FakeTenantCore, FakeTenantModule, RouteContext } from '../types.js';
import { ENTRA_ROLE_TEMPLATES } from '../graph/directory.js';
import { isGuidText } from '../graph/ids.js';
import type { FakeWorld } from '../graph/tokens.js';
import { checkClientAssertion } from './assertion.js';
import {
  compact,
  ecKeyPair,
  signature as signatureOf,
  type JsonObject,
  type SigningAlgorithm,
} from './jwt.js';
import { KeyRegistry, attackerKey, type SigningKey } from './keys.js';
import type {
  AuthorizeRecord,
  DeviceApproval,
  DiscoveryFault,
  FakeDeviceControl,
  FakeEntraControl,
  KeysFault,
  LogoutRecord,
  SignInSpec,
  TokenFault,
  TokenFaultAnswer,
  TokenRecord,
} from './types.js';

const HOST = 'login.microsoftonline.com';
const ORIGIN = 'https://login.microsoftonline.com';
const FORM = 'application/x-www-form-urlencoded';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const DEVICE_URN = 'urn:ietf:params:oauth:grant-type:device_code';

/** Text in the device-code `message` that the product must never show (FR-B-214). */
export const DEVICE_MESSAGE_CANARY = 'FAKE-ENTRA-MESSAGE-CANARY';
/** A 5,000-character hostile `error_description` (F-37). */
export const HOSTILE_DESCRIPTION = `<script>alert(1)</script> ${'x'.repeat(5_000)}`;

const OIDC_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);
const DELEGATED_GRAPH_SCOPES = new Set([
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
]);
const RESOURCES: Readonly<Record<string, 'graph' | 'exchange'>> = {
  'https://graph.microsoft.com': 'graph',
  'https://outlook.office365.com': 'exchange',
};
const AUTHORIZE_PARAMETERS = new Set([
  'client_id',
  'response_type',
  'redirect_uri',
  'response_mode',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'prompt',
]);
const SECRET_FIELDS = new Set([
  'client_assertion',
  'client_secret',
  'code',
  'code_verifier',
  'device_code',
  'refresh_token',
]);
const CODE_LIFETIME_MS = 60_000;
const DEVICE_LIFETIME_SECONDS = 900;
const TOKEN_LIFETIME_SECONDS = 3_600;
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

interface CodeRecord {
  readonly code: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly scope: readonly string[];
  readonly userId: string;
  readonly spec: SignInSpec;
  readonly issuedAt: number;
  used: boolean;
}

type DeviceStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'blocked';

interface DeviceFlow {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  intervalSeconds: number;
  status: DeviceStatus;
  userId: string | null;
  entraRoles: readonly string[];
  lastPoll: number | null;
}

interface RefreshRecord {
  readonly clientId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly entraRoles: readonly string[];
}

interface State {
  keys: KeyRegistry;
  counter: number;
  codes: Map<string, CodeRecord>;
  flows: Map<string, DeviceFlow>;
  refresh: Map<string, RefreshRecord>;
  seenJti: Set<string>;
  queue: SignInSpec[];
  defaultSpec: SignInSpec | null;
  keysFault: KeysFault;
  discoveryFault: DiscoveryFault;
  tokenFaults: { grant: TokenFault['grant']; times: number; answer: TokenFault['answer'] }[];
  rejections: string[];
  authorize: AuthorizeRecord[];
  tokens: TokenRecord[];
  logouts: LogoutRecord[];
  minted: string[];
  device: {
    intervalSeconds: number;
    verificationUri: string;
    slowDown: number;
    temporarilyUnavailable: number;
    enforceInterval: boolean;
    requested: string[][];
    failStart: TokenFaultAnswer | null;
  };
}

function freshState(pinnedTenant: string): State {
  const keys = new KeyRegistry();
  keys.ensure(pinnedTenant);
  return {
    keys,
    counter: 0,
    codes: new Map(),
    flows: new Map(),
    refresh: new Map(),
    seenJti: new Set(),
    queue: [],
    defaultSpec: null,
    keysFault: null,
    discoveryFault: null,
    tokenFaults: [],
    rejections: [],
    authorize: [],
    tokens: [],
    logouts: [],
    minted: [],
    device: {
      intervalSeconds: 5,
      verificationUri: 'https://login.microsoft.com/device',
      slowDown: 0,
      temporarilyUnavailable: 0,
      enforceInterval: false,
      requested: [],
      failStart: null,
    },
  };
}

export interface FakeEntra {
  readonly world: FakeWorld;
  readonly control: FakeEntraControl;
  readonly module: FakeTenantModule;
}

// ---- small helpers -------------------------------------------------------------------------------

function noStore(headers: Record<string, string> = {}): Record<string, string> {
  return { 'cache-control': 'no-store', pragma: 'no-cache', ...headers };
}

function hashText(text: string, length: number): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, length);
}

/** Does `requested` match one of the registered redirect URIs? Exact, except the localhost port. */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (asked.protocol !== 'http:' || asked.hostname !== 'localhost' || asked.port === '') {
    return false;
  }
  // Learn (reply-url, localhost exceptions): the port of a registered http://localhost URI is
  // ignored. Only a registered URI WITHOUT a port gets that treatment.
  const withoutPort = `http://localhost${asked.pathname}${asked.search}`;
  return registered.includes(withoutPort);
}

function scopeList(value: string | null): string[] {
  return value === null ? [] : value.split(' ').filter((part) => part !== '');
}

// ---- the module ----------------------------------------------------------------------------------

export function entraModule(world: FakeWorld, clock: FakeTenantClock): FakeEntra {
  const directory = world.directory;
  const pinned = directory.tenantId;
  const state: State = freshState(pinned);

  function resetState(): void {
    Object.assign(state, freshState(pinned));
  }

  const now = (): number => clock.now();

  function next(prefix: string): string {
    state.counter += 1;
    return `${prefix}-${String(state.counter).padStart(5, '0')}`;
  }

  /** `error`, `error_description` with the Trace ID lines Entra appends, and the numeric codes. */
  function failure(
    status: number,
    error: string,
    text: string,
    options: { aadsts?: number; headers?: Record<string, string> } = {},
  ): Response {
    const trace = hashText(`trace-${String(state.counter)}-${error}`, 32);
    const prefix = options.aadsts === undefined ? '' : `AADSTS${String(options.aadsts)}: `;
    return jsonResponse(
      status,
      {
        error,
        error_description: `${prefix}${text}\r\nTrace ID: ${trace}\r\nCorrelation ID: ${trace}\r\nTimestamp: ${new Date(now()).toISOString()}`,
        error_codes: options.aadsts === undefined ? [] : [options.aadsts],
        timestamp: new Date(now()).toISOString(),
        trace_id: trace,
        correlation_id: trace,
      },
      noStore(options.headers),
    );
  }

  function reject(reason: string): void {
    state.rejections.push(reason);
  }

  /** The tenant of a path segment: a known tenant id or domain, or one of the three authorities. */
  function tenantOf(
    segment: string,
  ):
    | { readonly kind: 'tenant'; readonly id: string }
    | { readonly kind: 'authority'; readonly name: string }
    | undefined {
    const lower = segment.toLowerCase();
    if (lower === 'organizations' || lower === 'common' || lower === 'consumers') {
      return { kind: 'authority', name: lower };
    }
    if (isGuidText(lower) && state.keys.has(lower)) return { kind: 'tenant', id: lower };
    const domains = directory.organization.verifiedDomains.map((domain) =>
      domain.name.toLowerCase(),
    );
    if (domains.includes(lower)) return { kind: 'tenant', id: pinned };
    return undefined;
  }

  function badTenant(): Response {
    return failure(400, 'invalid_request', 'the tenant is not one the fake tenant knows', {});
  }

  // ---- discovery and keys ------------------------------------------------------------------------

  function discovery(ctx: RouteContext): Response {
    const tenant = tenantOf(ctx.params.tenant ?? '');
    if (tenant === undefined) return badTenant();
    if (state.discoveryFault === 'unavailable') {
      return jsonResponse(503, { error: 'temporarily_unavailable' });
    }
    // The `organizations` document shows the issuer as the template (V-B12).
    const id = tenant.kind === 'tenant' ? tenant.id : '{tenantid}';
    const base = `${ORIGIN}/${id}`;
    const fault = state.discoveryFault;
    return jsonResponse(200, {
      token_endpoint: `${base}/oauth2/v2.0/token`,
      token_endpoint_auth_methods_supported: [
        'client_secret_post',
        'private_key_jwt',
        'client_secret_basic',
      ],
      jwks_uri:
        fault === 'foreign_hosts'
          ? 'https://keys.attacker.example/keys'
          : `${base}/discovery/v2.0/keys`,
      response_modes_supported: ['query', 'fragment', 'form_post'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      issuer:
        fault === 'issuer_mismatch'
          ? `${ORIGIN}/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/v2.0`
          : `${base}/v2.0`,
      request_uri_parameter_supported: false,
      userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      device_authorization_endpoint: `${base}/oauth2/v2.0/devicecode`,
      http_logout_supported: true,
      frontchannel_logout_supported: true,
      end_session_endpoint:
        fault === 'foreign_hosts'
          ? 'https://logout.attacker.example/logout'
          : `${base}/oauth2/v2.0/logout`,
      claims_supported: [
        'sub',
        'iss',
        'cloud_instance_name',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'acr',
        'nonce',
        'preferred_username',
        'name',
        'tid',
        'ver',
        'at_hash',
        'c_hash',
        'email',
      ],
    });
  }

  function keySet(ctx: RouteContext): Response {
    const tenant = tenantOf(ctx.params.tenant ?? '');
    if (tenant?.kind !== 'tenant') return badTenant();
    switch (state.keysFault) {
      case 'unavailable':
        return jsonResponse(503, { error: 'temporarily_unavailable' });
      case 'redirect':
        return new Response(null, {
          status: 302,
          headers: { location: 'https://keys.attacker.example/keys' },
        });
      case 'not_json':
        return new Response('not a key set', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      case null:
        break;
    }
    return jsonResponse(200, state.keys.jwks(tenant.id));
  }

  // ---- authorize ---------------------------------------------------------------------------------

  function errorPage(text: string): Response {
    return jsonResponse(400, { error: 'invalid_request', error_description: text }, noStore());
  }

  function redirectWith(redirectUri: string, params: Record<string, string | null>): Response {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) {
      if (value !== null) target.searchParams.set(name, value);
    }
    return new Response(null, { status: 302, headers: noStore({ location: target.href }) });
  }

  function takeSignIn(): SignInSpec {
    const queued = state.queue.shift();
    if (queued !== undefined) return queued;
    if (state.defaultSpec !== null) return state.defaultSpec;
    throw new Error(
      'fake Entra: /authorize was called but no sign-in is configured; ' +
        'call control.nextSignIn(...) or control.defaultSignIn(...)',
    );
  }

  function authorize(ctx: RouteContext): Response {
    const q = ctx.query;
    const tenant = tenantOf(ctx.params.tenant ?? '');
    const record: AuthorizeRecord = {
      tenant: ctx.params.tenant ?? '',
      clientId: q.get('client_id'),
      redirectUri: q.get('redirect_uri'),
      scope: q.get('scope'),
      responseType: q.get('response_type'),
      responseMode: q.get('response_mode'),
      prompt: q.get('prompt'),
      state: q.get('state'),
      nonce: q.get('nonce'),
      codeChallengeMethod: q.get('code_challenge_method'),
      extraParameters: [
        ...new Set([...q.keys()].filter((name) => !AUTHORIZE_PARAMETERS.has(name))),
      ],
    };
    state.authorize.push(record);

    // 1. Errors that end in a page: nowhere to redirect to.
    if (tenant === undefined) return errorPage('the tenant is not one the fake tenant knows');
    if (tenant.kind !== 'tenant') {
      return errorPage(
        'the panel signs in against its own tenant, never common, organizations or consumers',
      );
    }
    const clientId = q.get('client_id');
    if (clientId === null || !isGuidText(clientId))
      return errorPage('client_id is missing or malformed');
    const application = directory.applicationByAppId(clientId.toLowerCase());
    if (application === undefined)
      return errorPage('the application is not registered in this tenant');
    const redirectUri = q.get('redirect_uri');
    if (redirectUri === null || !redirectUriMatches(application.web.redirectUris, redirectUri)) {
      return errorPage('the redirect_uri does not match a registered redirect URI');
    }

    // 2. Errors that go back to the application, with the state.
    const stateParam = q.get('state');
    const back = (error: string, text: string): Response =>
      redirectWith(redirectUri, {
        error,
        error_description: text,
        state: stateParam,
      });
    if (q.get('response_type') !== 'code') {
      return back('unsupported_response_type', 'response_type must be exactly code');
    }
    const mode = q.get('response_mode');
    if (mode !== null && mode !== 'query') {
      return back('invalid_request', 'the fake supports response_mode=query only');
    }
    const scopes = scopeList(q.get('scope'));
    if (scopes.length === 0 || !scopes.includes('openid')) {
      return back('invalid_request', 'scope must contain openid');
    }
    // Narrower than Learn on purpose: the panel's sign-in asks for OIDC scopes and no resource.
    if (scopes.some((scope) => !OIDC_SCOPES.has(scope))) {
      return back('invalid_scope', 'the sign-in asks for OIDC scopes only');
    }
    if (stateParam === null || stateParam === '') {
      return back('invalid_request', 'state is required by the fake');
    }
    const nonce = q.get('nonce');
    if (nonce === null || nonce === '') return back('invalid_request', 'nonce is required');
    const challenge = q.get('code_challenge');
    if (
      q.get('code_challenge_method') !== 'S256' ||
      challenge === null ||
      !PKCE_CHALLENGE.test(challenge)
    ) {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const prompt = q.get('prompt');
    if (prompt !== null && !['login', 'select_account', 'none'].includes(prompt)) {
      return back('invalid_request', 'prompt must be login or select_account');
    }
    if (prompt === 'none') return back('login_required', 'there is no session to reuse');

    // 3. The sign-in itself.
    const spec = takeSignIn();
    if (spec.authorizeError !== undefined) {
      const given = spec.authorizeError;
      const prefix = given.aadsts === undefined ? '' : `AADSTS${String(given.aadsts)}: `;
      return back(given.error, `${prefix}${given.description ?? 'refused by the fake'}`);
    }
    const wanted = spec.user ?? state.defaultSpec?.user;
    const user = wanted === undefined ? undefined : directory.findUser(wanted);
    if (user === undefined || user.accountEnabled === false) {
      return back('access_denied', 'the account cannot sign in');
    }

    const code = hashText(`code-${String(state.counter + 1)}-${clientId}`, 43);
    state.counter += 1;
    state.codes.set(code, {
      code,
      clientId: clientId.toLowerCase(),
      tenantId: tenant.id,
      redirectUri,
      challenge,
      nonce,
      scope: scopes,
      userId: user.id,
      spec,
      issuedAt: now(),
      used: false,
    });
    return redirectWith(redirectUri, { code, state: stateParam });
  }

  // ---- ID tokens ---------------------------------------------------------------------------------

  function mintIdToken(input: {
    spec: SignInSpec;
    clientId: string;
    userId: string;
    nonce: string | null;
    tenantId: string;
  }): string {
    const { spec } = input;
    if (spec.rawIdToken !== undefined) return spec.rawIdToken;
    const issuer = spec.issuerTenant ?? input.tenantId;
    state.keys.ensure(issuer);
    const user = directory.users.get(input.userId);
    const seconds = Math.floor(now() / 1000);
    const nonce = spec.nonce === undefined ? input.nonce : spec.nonce;
    const payload: JsonObject = {
      ver: '2.0',
      iss: `${ORIGIN}/${issuer}/v2.0`,
      sub: hashText(`sub:${input.clientId}:${input.userId}`, 43),
      aud: input.clientId,
      exp: seconds + (spec.timing?.exp ?? TOKEN_LIFETIME_SECONDS),
      iat: seconds + (spec.timing?.iat ?? 0),
      nbf: seconds + (spec.timing?.nbf ?? 0),
      name: user?.displayName ?? null,
      preferred_username: user?.userPrincipalName ?? null,
      oid: input.userId,
      tid: issuer,
      ...(nonce === null ? {} : { nonce }),
      amr: ['pwd', 'mfa'],
      auth_time: seconds,
      uti: hashText(`uti-${String(state.counter)}`, 22),
      ...spec.claims,
    };
    for (const name of spec.omitClaims ?? []) Reflect.deleteProperty(payload, name);
    if (spec.padBytes !== undefined) payload.pad = 'p'.repeat(spec.padBytes);

    const signer = spec.signer ?? 'current';
    let key: SigningKey = state.keys.current(issuer);
    let alg: SigningAlgorithm = 'RS256';
    let secret: Parameters<typeof signatureOf>[2] = key.pair.privateKey;
    switch (signer) {
      case 'current':
        break;
      case 'old':
        key = state.keys.previous(issuer);
        secret = key.pair.privateKey;
        break;
      case 'attacker': {
        key = attackerKey();
        secret = key.pair.privateKey;
        break;
      }
      case 'attacker-real-kid': {
        const attacker = attackerKey();
        key = { ...attacker, kid: state.keys.current(issuer).kid };
        secret = attacker.pair.privateKey;
        break;
      }
      case 'none':
        alg = 'none';
        break;
      case 'hs256-public-key':
        alg = 'HS256';
        secret = String(key.pair.publicKey.export({ type: 'spki', format: 'pem' }));
        break;
      case 'ps256':
        alg = 'PS256';
        break;
      case 'rs384':
        alg = 'RS384';
        break;
      case 'es256':
        alg = 'ES256';
        secret = ecKeyPair(0).privateKey;
        break;
    }
    // The signature follows the signer; a header that labels itself differently (`spec.header.alg`)
    // is how some fixtures lie about the algorithm.
    const header: JsonObject = { typ: 'JWT', alg, kid: key.kid, ...spec.header };
    for (const name of spec.omitHeader ?? []) Reflect.deleteProperty(header, name);
    const token = compact(alg, header, payload, secret);
    state.minted.push(token);
    return token;
  }

  // ---- token endpoint ----------------------------------------------------------------------------

  function recordToken(ctx: RouteContext, form: URLSearchParams, response: Response): Response {
    const fields: Record<string, string> = {};
    for (const [name, value] of form.entries()) {
      fields[name] = SECRET_FIELDS.has(name) ? '[present]' : value;
    }
    state.tokens.push({
      tenant: ctx.params.tenant ?? '',
      grantType: form.get('grant_type'),
      contentType: ctx.request.headers.get('content-type'),
      hasOrigin: ctx.request.headers.has('origin'),
      fields,
      status: response.status,
    });
    return response;
  }

  function matchingFault(grant: string | null): TokenFault['answer'] | undefined {
    const index = state.tokenFaults.findIndex(
      (fault) => fault.times > 0 && (fault.grant === undefined || fault.grant === grant),
    );
    if (index < 0) return undefined;
    const fault = state.tokenFaults[index];
    if (fault === undefined) return undefined;
    fault.times -= 1;
    return fault.answer;
  }

  function faultResponse(answer: TokenFaultAnswer): Response {
    const headers: Record<string, string> =
      answer.retryAfterSeconds === undefined
        ? {}
        : { 'retry-after': String(answer.retryAfterSeconds) };
    if (answer.error === undefined) {
      return new Response('<html>service unavailable</html>', {
        status: answer.status,
        headers: noStore({ 'content-type': 'text/html', ...headers }),
      });
    }
    return failure(answer.status, answer.error, answer.description ?? 'refused by the fake', {
      ...(answer.aadsts === undefined ? {} : { aadsts: answer.aadsts }),
      headers,
    });
  }

  /** Client authentication with a certificate. A `Response` is the refusal; `undefined` is success. */
  function authenticateClient(
    ctx: RouteContext,
    form: URLSearchParams,
    tenantSegment: string,
  ): { readonly clientId: string } | Response {
    const clientId = (form.get('client_id') ?? '').toLowerCase();
    const assertion = form.get('client_assertion');
    const hasCredential = assertion !== null || form.has('client_secret');
    if (hasCredential && ctx.request.headers.has('origin')) {
      reject('origin_header');
      return failure(
        400,
        'invalid_request',
        'client credentials are not accepted with an Origin header',
      );
    }
    if (!isGuidText(clientId) || directory.applicationByAppId(clientId) === undefined) {
      reject('unknown_client');
      return failure(400, 'invalid_client', 'the application was not found in the tenant');
    }
    if (assertion === null) {
      reject(form.has('client_secret') ? 'secret_not_registered' : 'no_credential');
      return failure(400, 'invalid_client', 'client authentication failed');
    }
    if (form.get('client_assertion_type') !== ASSERTION_TYPE) {
      reject('bad_assertion_type');
      return failure(400, 'invalid_client', 'client_assertion_type must be the jwt-bearer URN');
    }
    const reason = checkClientAssertion({
      assertion,
      clientId,
      tenantPath: tenantSegment,
      credentials: directory.registeredCertificates(clientId),
      nowMs: now(),
      seenJti: state.seenJti,
    });
    if (reason !== undefined) {
      reject(reason);
      return reason === 'malformed' || reason === 'bad_signature'
        ? failure(400, 'invalid_client', 'Client assertion contains an invalid signature.', {
            aadsts: 700027,
          })
        : failure(400, 'invalid_client', `client assertion refused (${reason})`);
    }
    return { clientId };
  }

  function opaqueAccessToken(
    clientId: string,
    userId: string,
    scopes: readonly string[],
    entraRoles: readonly string[],
  ): string {
    const delegated = scopes
      .filter((scope) => scope.startsWith(`https://graph.microsoft.com/`))
      .map((scope) => scope.slice('https://graph.microsoft.com/'.length));
    const oidcOnly = scopes.filter((scope) => OIDC_SCOPES.has(scope));
    return world.issueDelegatedToken({
      appId: clientId,
      userId,
      scopes: delegated.length > 0 ? delegated : oidcOnly,
      entraRoleTemplateIds: entraRoles,
    }).value;
  }

  function authorizationCodeGrant(
    ctx: RouteContext,
    form: URLSearchParams,
    tenant: { kind: 'tenant'; id: string },
  ): Response {
    const authenticated = authenticateClient(ctx, form, ctx.params.tenant ?? '');
    if (authenticated instanceof Response) return authenticated;
    const { clientId } = authenticated;

    const code = form.get('code');
    if (code === null || code === '') return failure(400, 'invalid_request', 'code is required');
    const redirectUri = form.get('redirect_uri');
    if (redirectUri === null) return failure(400, 'invalid_request', 'redirect_uri is required');
    const scope = form.get('scope');
    if (scope !== null && scopeList(scope).some((entry) => !OIDC_SCOPES.has(entry))) {
      return failure(400, 'invalid_scope', 'the scope is not valid for this request', {
        aadsts: 70011,
      });
    }

    const record = state.codes.get(code);
    if (record === undefined || record.used || record.clientId !== clientId) {
      return failure(400, 'invalid_grant', 'the authorization code is invalid or already used');
    }
    record.used = true;
    if (now() - record.issuedAt > CODE_LIFETIME_MS) {
      return failure(400, 'invalid_grant', 'the authorization code has expired');
    }
    if (record.redirectUri !== redirectUri) {
      return failure(400, 'invalid_grant', 'redirect_uri differs from the authorize request');
    }
    const verifier = form.get('code_verifier');
    if (
      verifier === null ||
      !PKCE_VERIFIER.test(verifier) ||
      createHash('sha256').update(verifier).digest('base64url') !== record.challenge
    ) {
      return failure(400, 'invalid_grant', 'the PKCE code verifier does not match');
    }

    const body: JsonObject = {
      token_type: 'Bearer',
      scope: record.scope.join(' '),
      expires_in: TOKEN_LIFETIME_SECONDS,
      access_token: opaqueAccessToken(clientId, record.userId, record.scope, []),
      id_token: mintIdToken({
        spec: record.spec,
        clientId,
        userId: record.userId,
        nonce: record.nonce,
        tenantId: tenant.id,
      }),
    };
    if (record.scope.includes('offline_access')) {
      const refresh = hashText(next('refresh'), 40);
      state.refresh.set(refresh, {
        clientId,
        userId: record.userId,
        scopes: record.scope,
        entraRoles: [],
      });
      body.refresh_token = refresh;
    }
    return jsonResponse(200, body, noStore());
  }

  function clientCredentialsGrant(ctx: RouteContext, form: URLSearchParams): Response {
    const authenticated = authenticateClient(ctx, form, ctx.params.tenant ?? '');
    if (authenticated instanceof Response) return authenticated;
    const scopes = scopeList(form.get('scope'));
    if (scopes.length === 0) return failure(400, 'invalid_request', 'scope is required');
    const [only] = scopes;
    const resource =
      scopes.length === 1 && only?.endsWith('/.default') === true
        ? RESOURCES[only.slice(0, -'/.default'.length)]
        : undefined;
    if (resource === undefined) {
      return failure(400, 'invalid_scope', 'the scope must be one <resource>/.default', {
        aadsts: 70011,
      });
    }
    const { clientId } = authenticated;
    if (directory.servicePrincipalByAppId(clientId) === undefined) {
      reject('no_service_principal');
      return failure(
        400,
        'invalid_client',
        'the application has no service principal in the tenant',
      );
    }
    const issued = world.issueAppToken(clientId, resource);
    return jsonResponse(
      200,
      {
        token_type: 'Bearer',
        expires_in: Math.round((issued.expiresAt - issued.issuedAt) / 1000),
        access_token: issued.value,
      },
      noStore(),
    );
  }

  function deviceTokens(
    clientId: string,
    userId: string,
    scopes: readonly string[],
    entraRoles: readonly string[],
    tenantId: string,
  ): Response {
    const refresh = hashText(next('refresh'), 40);
    state.refresh.set(refresh, { clientId, userId, scopes, entraRoles });
    const idToken = mintIdToken({ spec: {}, clientId, userId, nonce: null, tenantId });
    return jsonResponse(
      200,
      {
        token_type: 'Bearer',
        scope: scopes.join(' '),
        expires_in: TOKEN_LIFETIME_SECONDS,
        access_token: opaqueAccessToken(clientId, userId, scopes, entraRoles),
        refresh_token: refresh,
        id_token: idToken,
      },
      noStore(),
    );
  }

  function deviceGrant(form: URLSearchParams): Response {
    if (form.has('client_assertion') || form.has('client_secret')) {
      return failure(400, 'invalid_request', 'a public client does not send credentials');
    }
    const clientId = (form.get('client_id') ?? '').toLowerCase();
    const deviceCode = form.get('device_code') ?? '';
    const flow = state.flows.get(deviceCode);
    if (flow?.clientId !== clientId) {
      return failure(400, 'bad_verification_code', 'the device_code is not recognised');
    }
    if (state.device.slowDown > 0) {
      state.device.slowDown -= 1;
      return failure(400, 'slow_down', 'poll less often');
    }
    if (state.device.temporarilyUnavailable > 0) {
      state.device.temporarilyUnavailable -= 1;
      return failure(400, 'temporarily_unavailable', 'try again');
    }
    const at = now();
    if (
      state.device.enforceInterval &&
      flow.lastPoll !== null &&
      at - flow.lastPoll < flow.intervalSeconds * 1000
    ) {
      flow.lastPoll = at;
      flow.intervalSeconds += 5;
      return failure(400, 'slow_down', 'poll less often');
    }
    flow.lastPoll = at;
    if (flow.status === 'expired' || at > flow.expiresAt) {
      return failure(400, 'expired_token', 'the device code has expired');
    }
    switch (flow.status) {
      case 'declined':
        return failure(400, 'authorization_declined', 'the user declined');
      case 'blocked':
        return failure(400, 'access_denied', 'blocked by Conditional Access', { aadsts: 53003 });
      case 'pending':
        return failure(400, 'authorization_pending', 'the user has not finished');
      case 'approved':
        break;
    }
    return deviceTokens(flow.clientId, flow.userId ?? '', flow.scopes, flow.entraRoles, pinned);
  }

  function refreshGrant(form: URLSearchParams): Response {
    if (form.has('client_assertion') || form.has('client_secret')) {
      return failure(400, 'invalid_request', 'a public client does not send credentials');
    }
    const record = state.refresh.get(form.get('refresh_token') ?? '');
    const clientId = (form.get('client_id') ?? '').toLowerCase();
    if (record?.clientId !== clientId) {
      return failure(400, 'invalid_grant', 'the refresh token is not valid');
    }
    return deviceTokens(clientId, record.userId, record.scopes, record.entraRoles, pinned);
  }

  async function token(ctx: RouteContext): Promise<Response> {
    const tenant = tenantOf(ctx.params.tenant ?? '');
    const contentType = ctx.request.headers.get('content-type') ?? '';
    const form = contentType.toLowerCase().startsWith(FORM)
      ? await ctx.form()
      : new URLSearchParams();
    const answer = ((): Response | Promise<Response> => {
      if (!contentType.toLowerCase().startsWith(FORM)) {
        return failure(
          400,
          'invalid_request',
          'the body must be application/x-www-form-urlencoded',
        );
      }
      if (tenant === undefined) return badTenant();
      const grant = form.get('grant_type');
      const fault = matchingFault(grant);
      if (fault === 'hang') return new Promise<Response>(() => undefined);
      if (fault !== undefined) return faultResponse(fault);
      switch (grant) {
        case 'authorization_code':
          if (tenant.kind !== 'tenant') return badTenant();
          return authorizationCodeGrant(ctx, form, tenant);
        case 'client_credentials':
          if (tenant.kind !== 'tenant') return badTenant();
          return clientCredentialsGrant(ctx, form);
        case 'device_code':
        case DEVICE_URN:
          return deviceGrant(form);
        case 'refresh_token':
          return refreshGrant(form);
        default:
          return failure(400, 'unsupported_grant_type', 'the grant type is not supported');
      }
    })();
    const resolved = await answer;
    return recordToken(ctx, form, resolved);
  }

  // ---- device authorization ----------------------------------------------------------------------

  async function deviceCode(ctx: RouteContext): Promise<Response> {
    const tenant = tenantOf(ctx.params.tenant ?? '');
    if (!(ctx.request.headers.get('content-type') ?? '').toLowerCase().startsWith(FORM)) {
      return failure(400, 'invalid_request', 'the body must be application/x-www-form-urlencoded');
    }
    const form = await ctx.form();
    if (tenant === undefined) return badTenant();
    // Learn allows `common` and `consumers`; the panel never asks for them (FR-B-214), so the fake
    // makes the mistake visible.
    if (tenant.kind === 'authority' && tenant.name !== 'organizations') {
      return failure(400, 'invalid_request', 'the panel uses organizations or a tenant id here');
    }
    if (form.has('client_assertion') || form.has('client_secret')) {
      return failure(400, 'invalid_request', 'a public client does not send credentials');
    }
    const clientId = (form.get('client_id') ?? '').toLowerCase();
    if (!isGuidText(clientId)) return failure(400, 'invalid_request', 'client_id is required');
    const scopes = scopeList(form.get('scope'));
    if (scopes.length === 0) return failure(400, 'invalid_request', 'scope is required');
    const allowed = (scope: string): boolean =>
      OIDC_SCOPES.has(scope) ||
      (scope.startsWith('https://graph.microsoft.com/') &&
        DELEGATED_GRAPH_SCOPES.has(scope.slice('https://graph.microsoft.com/'.length)));
    if (!scopes.every(allowed)) {
      return failure(400, 'invalid_scope', 'the scope is not valid for this request', {
        aadsts: 70011,
      });
    }
    state.device.requested.push([...scopes]);
    if (state.device.failStart !== null) return faultResponse(state.device.failStart);
    const at = now();
    const n = state.counter + 1;
    state.counter = n;
    const flow: DeviceFlow = {
      deviceCode: hashText(`device-${String(n)}-${clientId}`, 64),
      userCode: hashText(`user-${String(n)}`, 9)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, 'X'),
      clientId,
      scopes,
      issuedAt: at,
      expiresAt: at + DEVICE_LIFETIME_SECONDS * 1000,
      intervalSeconds: state.device.intervalSeconds,
      status: 'pending',
      userId: null,
      entraRoles: [],
      lastPoll: null,
    };
    state.flows.set(flow.deviceCode, flow);
    return jsonResponse(
      200,
      {
        user_code: flow.userCode,
        device_code: flow.deviceCode,
        verification_uri: state.device.verificationUri,
        expires_in: DEVICE_LIFETIME_SECONDS,
        interval: flow.intervalSeconds,
        message: `To sign in, use a web browser to open the page and enter the code ${flow.userCode}. ${DEVICE_MESSAGE_CANARY}`,
      },
      noStore(),
    );
  }

  // ---- logout ------------------------------------------------------------------------------------

  async function logout(ctx: RouteContext): Promise<Response> {
    const tenant = tenantOf(ctx.params.tenant ?? '');
    if (tenant?.kind !== 'tenant') return badTenant();
    let uri = ctx.query.get('post_logout_redirect_uri');
    if (uri === null && ctx.request.method === 'POST') {
      uri = (await ctx.form()).get('post_logout_redirect_uri');
    }
    const registered = [...directory.applications.values()].some((application) =>
      redirectUriMatches(application.web.redirectUris, uri ?? ''),
    );
    const redirected = uri !== null && uri !== '' && registered;
    state.logouts.push({ tenantId: tenant.id, postLogoutRedirectUri: uri, redirected });
    if (redirected && uri !== null) {
      return new Response(null, { status: 302, headers: noStore({ location: uri }) });
    }
    return new Response('<html><body>You signed out of your account.</body></html>', {
      status: 200,
      headers: noStore({ 'content-type': 'text/html' }),
    });
  }

  // ---- control -----------------------------------------------------------------------------------

  function pendingFlows(): DeviceFlow[] {
    return [...state.flows.values()].filter((flow) => flow.status === 'pending');
  }

  function endPending(status: DeviceStatus): void {
    const flows = pendingFlows();
    if (flows.length === 0) throw new Error('fake Entra: no device flow is waiting');
    for (const flow of flows) flow.status = status;
  }

  const device: FakeDeviceControl = {
    approve(approval: DeviceApproval) {
      const flows = pendingFlows();
      if (flows.length === 0) throw new Error('fake Entra: no device flow is waiting');
      const user = directory.findUser(approval.user);
      if (user === undefined)
        throw new Error('fake Entra: the approving user is not in the directory');
      for (const flow of flows) {
        flow.status = 'approved';
        flow.userId = user.id;
        flow.entraRoles = [
          ...(approval.entraRoleTemplateIds ?? [ENTRA_ROLE_TEMPLATES.globalAdministrator]),
        ];
      }
    },
    decline: () => {
      endPending('declined');
    },
    expire: () => {
      endPending('expired');
    },
    block: () => {
      endPending('blocked');
    },
    interval(seconds) {
      if (!Number.isInteger(seconds) || seconds < 1)
        throw new RangeError('interval is whole seconds from 1');
      state.device.intervalSeconds = seconds;
    },
    verificationUri(uri) {
      state.device.verificationUri = uri;
    },
    slowDown(times) {
      state.device.slowDown = times;
    },
    temporarilyUnavailable(times) {
      state.device.temporarilyUnavailable = times;
    },
    enforceInterval(on) {
      state.device.enforceInterval = on;
    },
    failStart(answer) {
      state.device.failStart = answer;
    },
    requestedScopes: () => state.device.requested.map((scopes) => [...scopes]),
    pending: () => pendingFlows().length,
  };

  const control: FakeEntraControl = {
    nextSignIn(spec) {
      state.queue.push(spec);
    },
    defaultSignIn(spec) {
      state.defaultSpec = spec;
    },
    rotateKeys: (tenantId = pinned) => state.keys.rotate(tenantId).kid,
    dropOldKeys: (tenantId = pinned) => {
      state.keys.dropOld(tenantId);
    },
    keyIds: (tenantId = pinned) => state.keys.list(tenantId).map((key) => key.kid),
    addTenant: (tenantId) => {
      state.keys.ensure(tenantId.toLowerCase());
    },
    failKeys: (mode) => {
      state.keysFault = mode;
    },
    failDiscovery: (mode) => {
      state.discoveryFault = mode;
    },
    failToken(fault) {
      state.tokenFaults.push({ grant: fault.grant, times: fault.times, answer: fault.answer });
    },
    device,
    assertionRejections: () => [...state.rejections],
    authorizeRequests: () => [...state.authorize],
    tokenRequests: () => [...state.tokens],
    logouts: () => [...state.logouts] as readonly LogoutRecord[],
    mintedIdTokens: () => [...state.minted],
  };

  const module: FakeTenantModule = (core: FakeTenantCore) => {
    core.onReset(resetState);
    const add = (
      method: 'GET' | 'POST',
      path: string,
      handler: (ctx: RouteContext) => Response | Promise<Response>,
      mutating = false,
    ): void => {
      core.router.add({ host: HOST, method, path, mutating, handler });
    };
    add('GET', '/:tenant/v2.0/.well-known/openid-configuration', discovery);
    add('GET', '/:tenant/discovery/v2.0/keys', keySet);
    add('GET', '/:tenant/oauth2/v2.0/authorize', authorize);
    add('POST', '/:tenant/oauth2/v2.0/token', token);
    add('POST', '/:tenant/oauth2/v2.0/devicecode', deviceCode);
    add('GET', '/:tenant/oauth2/v2.0/logout', logout);
    add('POST', '/:tenant/oauth2/v2.0/logout', logout);
  };

  return { world, control, module };
}
