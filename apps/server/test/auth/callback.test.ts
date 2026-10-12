// T-B-186: FR-B-403, FR-B-404 (through the validator), FR-B-405, FR-B-406, FR-B-418, EB-15, EB-16,
// EB-21, EB-22, SC-B-005, US-B5, F-01 to F-45 of spec Appendix C. One table, one control: every row
// goes through the fake identity provider (the fake Entra), the fake tenant and a scripted browser
// against the real server, and asserts the redirect target, the audit entry (action, outcome,
// reason, check), the number of sessions created, that no canary (code, state, ID token, cookie
// values) is in a log line, a response or any table, and that no token is stored.
//
// The rows that need more than a different token (a missing cookie, a replay, two tabs, a slow token
// endpoint, the MFA switch, a Graph outage) carry their own `run`.
import { createHash } from 'node:crypto';
import { SIGNIN_CHECKS } from '@m365portal/shared/auth/signin-errors';
import { describe, expect, it } from 'vitest';
import { HOSTILE_DESCRIPTION, type SignInSpec } from '../fakes/fake-tenant/entra/index.js';
import { assign } from '../helpers/rbac-db.js';
import { fake, testClock } from '../support/msw.js';
import type { FakeBrowser, Navigation } from './support/fake-browser.js';
import { pump, startSignInScene, type SceneOptions, type SignInScene } from './support/signin-scene.js';

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------

interface Started {
  readonly callbackUrl: URL;
  readonly code: string | null;
  readonly state: string | null;
}

/** Login, then Entra's authorize endpoint; stops where Entra hands the browser back to the panel. */
async function startFlow(browser: FakeBrowser, query = ''): Promise<Started> {
  const nav = await browser.navigate(`/auth/login${query}`, { stopBeforePanel: true });
  const location = nav.headers.get('location');
  if (location === null) throw new Error(`the sign-in did not reach Entra (status ${String(nav.status)})`);
  const callbackUrl = new URL(location);
  return {
    callbackUrl,
    code: callbackUrl.searchParams.get('code'),
    state: callbackUrl.searchParams.get('state'),
  };
}

/** Entra redirects the browser to the callback: a cross-site navigation. */
async function deliver(
  browser: FakeBrowser,
  url: URL,
  rewrite?: (url: URL) => URL,
): Promise<Navigation> {
  return await browser.navigate(url, {
    initiator: 'cross-site',
    ...(rewrite === undefined ? {} : { rewrite }),
  });
}

interface AuditExpectation {
  readonly action?: 'auth.signin' | 'auth.stepup';
  readonly outcome: 'success' | 'denied';
  readonly reason?: string;
  readonly check?: string;
}

function auditOf(scene: SignInScene): { action: string; outcome: string; detail: Record<string, unknown> }[] {
  return scene
    .auditRows()
    .filter((row) => row.action === 'auth.signin' || row.action === 'auth.stepup')
    .map((row) => ({
      action: row.action,
      outcome: row.outcome,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    }));
}

/** Everything the database holds, as text: for the scan that finds no token. */
function databaseText(scene: SignInScene): string {
  const tables = scene.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return tables
    .map(({ name }) => JSON.stringify(scene.query(`SELECT * FROM "${name}"`)))
    .join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Outcome {
  /** Where the callback sent the browser, or `interstitial`. */
  readonly target: string;
  readonly nav: Navigation;
  readonly canaries: readonly string[];
}

/** The target of the callback response: its Location, or `interstitial` for the 200 page. */
function targetOf(nav: Navigation): string {
  const hop = nav.chain[0];
  if (hop === undefined) throw new Error('no request was made');
  if (hop.status === 200) return 'interstitial';
  if (hop.status !== 303) throw new Error(`the callback answered ${String(hop.status)}`);
  return hop.location ?? '';
}

function canariesOf(scene: SignInScene, started: readonly Started[]): string[] {
  return [
    ...scene.world.entra.control.mintedIdTokens(),
    ...started.flatMap((flow) => [flow.code, flow.state].filter((v): v is string => v !== null)),
  ];
}

function expectNoCanaries(scene: SignInScene, nav: Navigation, canaries: readonly string[]): void {
  const logs = scene.logs.text();
  const dump = databaseText(scene);
  const response = `${nav.text}\n${[...nav.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  for (const canary of canaries) {
    expect(canary.length).toBeGreaterThan(20);
    expect(logs).not.toContain(canary);
    expect(dump).not.toContain(canary);
    expect(response).not.toContain(canary);
  }
  // The hostile description is never rendered or stored.
  expect(response).not.toContain('<script>alert(1)</script>');
  expect(dump).not.toContain('<script>alert(1)</script>');
  expect(logs).not.toContain('<script>alert(1)</script>');
}

interface Row {
  readonly id: string;
  readonly scene?: SceneOptions;
  /** Only this row's world setup, before the sign-in. */
  readonly prepare?: (scene: SignInScene) => void;
  readonly spec?: SignInSpec;
  readonly query?: string;
  readonly rewrite?: (url: URL) => URL;
  /** Replaces the whole flow. */
  readonly run?: (scene: SignInScene) => Promise<Outcome>;
  readonly target: string;
  readonly audit: AuditExpectation | null;
  readonly sessions: number;
}

async function standardFlow(scene: SignInScene, row: Row): Promise<Outcome> {
  if (row.spec !== undefined) scene.world.entra.control.nextSignIn(row.spec);
  const browser = scene.browser();
  const started = await startFlow(browser, row.query ?? '');
  const nav = await deliver(browser, started.callbackUrl, row.rewrite);
  return { nav, target: targetOf(nav), canaries: canariesOf(scene, [started]) };
}

const SIGNIN_FAILED = '/signin?error=signin_failed';
const denied = (check: string): AuditExpectation => ({ outcome: 'denied', reason: 'token_invalid', check });
const SUCCESS: AuditExpectation = { outcome: 'success' };

function tenantOf(scene: SignInScene): string {
  return scene.world.tenantId;
}

const ISSUER_NEAR_MISSES: readonly [string, (tid: string) => string][] = [
  ['trailing slash', (tid) => `https://login.microsoftonline.com/${tid}/v2.0/`],
  ['upper-case host', (tid) => `https://LOGIN.MICROSOFTONLINE.COM/${tid}/v2.0`],
  ['other host', (tid) => `https://login.microsoft.com/${tid}/v2.0`],
  ['missing /v2.0', (tid) => `https://login.microsoftonline.com/${tid}`],
];

const SECOND_SEGMENT = 'eyJhbGciOiJSUzI1NiJ9';
const ROWS: readonly Row[] = [
  { id: 'F-01 member with an assignment, valid token, amr holds mfa', target: 'interstitial', audit: SUCCESS, sessions: 1 },
  { id: 'F-02 attacker key that reuses a real kid', spec: { signer: 'attacker-real-kid' }, target: SIGNIN_FAILED, audit: denied('signature'), sessions: 0 },
  { id: 'F-03 kid absent from the key set, also after one refresh', spec: { signer: 'attacker' }, target: SIGNIN_FAILED, audit: denied('kid'), sessions: 0 },
  {
    id: 'F-05 foreign tid and issuer, validly signed by that tenant key',
    prepare: (scene) => {
      scene.world.entra.control.addTenant('99999999-9999-4999-8999-999999999999');
    },
    spec: { issuerTenant: '99999999-9999-4999-8999-999999999999' },
    target: SIGNIN_FAILED,
    audit: denied('tenant'),
    sessions: 0,
  },
  {
    id: 'F-06 iss in the v1 form',
    run: async (scene) =>
      await standardFlow(scene, {
        id: 'x',
        spec: { claims: { iss: `https://sts.windows.net/${tenantOf(scene)}/` } },
        target: '',
        audit: null,
        sessions: 0,
      }),
    target: SIGNIN_FAILED,
    audit: denied('issuer'),
    sessions: 0,
  },
  ...ISSUER_NEAR_MISSES.map(
    ([name, build]): Row => ({
      id: `F-07 iss near-miss: ${name}`,
      run: async (scene) =>
        await standardFlow(scene, {
          id: 'x',
          spec: { claims: { iss: build(tenantOf(scene)) } },
          target: '',
          audit: null,
          sessions: 0,
        }),
      target: SIGNIN_FAILED,
      audit: denied('issuer'),
      sessions: 0,
    }),
  ),
  { id: 'F-08 aud is another client id', spec: { claims: { aud: '00000000-0000-4000-8000-000000000001' } }, target: SIGNIN_FAILED, audit: denied('audience'), sessions: 0 },
  {
    id: 'F-09 aud is an array holding our id and another',
    run: async (scene) =>
      await standardFlow(scene, {
        id: 'x',
        spec: { claims: { aud: [scene.world.app.appId, '00000000-0000-4000-8000-000000000001'] } },
        target: '',
        audit: null,
        sessions: 0,
      }),
    target: SIGNIN_FAILED,
    audit: denied('audience'),
    sessions: 0,
  },
  { id: 'F-10 nonce differs', spec: { nonce: 'a-nonce-that-this-sign-in-never-sent' }, target: SIGNIN_FAILED, audit: denied('nonce'), sessions: 0 },
  { id: 'F-11 nonce missing', spec: { nonce: null }, target: SIGNIN_FAILED, audit: denied('nonce'), sessions: 0 },
  { id: 'F-12 exp 61 s in the past', spec: { timing: { exp: -61 } }, target: SIGNIN_FAILED, audit: denied('expired'), sessions: 0 },
  { id: 'F-13 exp 59 s in the past, inside the tolerance', spec: { timing: { exp: -59 } }, target: 'interstitial', audit: SUCCESS, sessions: 1 },
  { id: 'F-14 nbf 61 s in the future', spec: { timing: { nbf: 61 } }, target: SIGNIN_FAILED, audit: denied('not_before'), sessions: 0 },
  { id: 'F-15 nbf 59 s in the future, inside the tolerance', spec: { timing: { nbf: 59 } }, target: 'interstitial', audit: SUCCESS, sessions: 1 },
  { id: 'F-16 iat 120 s in the future', spec: { timing: { iat: 120 } }, target: SIGNIN_FAILED, audit: denied('issued_at'), sessions: 0 },
  { id: 'F-17 alg none, unsigned', spec: { signer: 'none' }, target: SIGNIN_FAILED, audit: denied('alg'), sessions: 0 },
  { id: 'F-18 alg HS256 signed with the public key as the secret', spec: { signer: 'hs256-public-key' }, target: SIGNIN_FAILED, audit: denied('alg'), sessions: 0 },
  ...(['ps256', 'rs384', 'es256'] as const).map(
    (signer): Row => ({ id: `F-19 alg ${signer} with a valid signature`, spec: { signer }, target: SIGNIN_FAILED, audit: denied('alg'), sessions: 0 }),
  ),
  { id: 'F-20 header jku pointing at an attacker URL', spec: { header: { jku: 'https://attacker.example/keys' } }, target: SIGNIN_FAILED, audit: denied('header'), sessions: 0 },
  { id: 'F-21 header jwk with an embedded key', spec: { header: { jwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' } } }, target: SIGNIN_FAILED, audit: denied('header'), sessions: 0 },
  { id: 'F-22 header x5u', spec: { header: { x5u: 'https://attacker.example/cert' } }, target: SIGNIN_FAILED, audit: denied('header'), sessions: 0 },
  { id: 'F-22 header crit', spec: { header: { crit: ['exp'] } }, target: SIGNIN_FAILED, audit: denied('header'), sessions: 0 },
  { id: 'F-23 ver is 1.0', spec: { claims: { ver: '1.0' } }, target: SIGNIN_FAILED, audit: denied('version'), sessions: 0 },
  { id: 'F-24 oid missing', spec: { omitClaims: ['oid'] }, target: SIGNIN_FAILED, audit: denied('oid'), sessions: 0 },
  { id: 'F-24 oid not a GUID', spec: { claims: { oid: 'not-a-guid' } }, target: SIGNIN_FAILED, audit: denied('oid'), sessions: 0 },
  { id: 'F-25 token over 8,192 bytes', spec: { padBytes: 9_000 }, target: SIGNIN_FAILED, audit: denied('size'), sessions: 0 },
  { id: 'F-26 two segments', spec: { rawIdToken: `${SECOND_SEGMENT}.e30` }, target: SIGNIN_FAILED, audit: denied('format'), sessions: 0 },
  { id: 'F-26 not base64url', spec: { rawIdToken: '!!!.@@@.###' }, target: SIGNIN_FAILED, audit: denied('format'), sessions: 0 },
  { id: 'F-26 payload that is a JSON array', spec: { rawIdToken: `${SECOND_SEGMENT}.${Buffer.from('[1,2]').toString('base64url')}.c2ln` }, target: SIGNIN_FAILED, audit: denied('format'), sessions: 0 },
  {
    id: 'F-27 key endpoint unreachable on a cold start',
    scene: { beforeStart: (world) => { world.entra.control.failKeys('unavailable'); } },
    target: '/signin?error=temporarily_unavailable',
    audit: { outcome: 'denied', reason: 'keys_unavailable' },
    sessions: 0,
  },
  { id: 'F-28 state differs from the stored one', rewrite: (url) => withParam(url, 'state', 'a-different-state-value'), target: SIGNIN_FAILED, audit: null, sessions: 0 },
  { id: 'F-29 state missing', rewrite: (url) => withParam(url, 'state', null), target: SIGNIN_FAILED, audit: null, sessions: 0 },
  {
    id: 'F-30 transaction cookie absent (the browser blocks cookies)',
    run: async (scene) => {
      const browser = scene.browser();
      const started = await startFlow(browser);
      browser.deleteCookie('m365portal_oidc');
      const nav = await deliver(browser, started.callbackUrl);
      return { nav, target: targetOf(nav), canaries: canariesOf(scene, [started]) };
    },
    target: '/signin?error=cookies_missing_or_expired',
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-31 transaction older than 600 s',
    run: async (scene) => {
      const browser = scene.browser();
      const started = await startFlow(browser);
      scene.advance(600_000);
      const nav = await deliver(browser, started.callbackUrl);
      return { nav, target: targetOf(nav), canaries: canariesOf(scene, [started]) };
    },
    target: '/signin?error=cookies_missing_or_expired',
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-32 second use of the same callback URL',
    run: async (scene) => {
      const browser = scene.browser();
      const started = await startFlow(browser);
      const first = await deliver(browser, started.callbackUrl);
      expect(targetOf(first)).toBe('interstitial');
      const second = await deliver(browser, started.callbackUrl);
      return { nav: second, target: targetOf(second), canaries: canariesOf(scene, [started]) };
    },
    target: '/signin?error=cookies_missing_or_expired',
    audit: SUCCESS,
    sessions: 1,
  },
  {
    id: 'F-33 two tabs: the earlier tab callback arrives with the later tab cookie',
    run: async (scene) => {
      const browser = scene.browser();
      const earlier = await startFlow(browser);
      const later = await startFlow(browser);
      const nav = await deliver(browser, earlier.callbackUrl);
      // The later transaction was consumed by the earlier tab's callback.
      const next = await deliver(browser, later.callbackUrl);
      expect(targetOf(next)).toBe('/signin?error=cookies_missing_or_expired');
      return { nav, target: targetOf(nav), canaries: canariesOf(scene, [earlier, later]) };
    },
    target: SIGNIN_FAILED,
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-34 error=access_denied',
    spec: { authorizeError: { error: 'access_denied' } },
    target: '/signin?error=access_denied',
    audit: null,
    sessions: 0,
  },
  { id: 'F-35 error=interaction_required', spec: { authorizeError: { error: 'interaction_required' } }, target: '/signin?error=interaction_required', audit: null, sessions: 0 },
  { id: 'F-36 AADSTS65001', spec: { authorizeError: { error: 'invalid_grant', aadsts: 65001 } }, target: '/signin?error=consent_required', audit: null, sessions: 0 },
  { id: 'F-36 AADSTS90093', spec: { authorizeError: { error: 'invalid_grant', aadsts: 90093 } }, target: '/signin?error=admin_approval_required', audit: null, sessions: 0 },
  { id: 'F-36 AADSTS90094', spec: { authorizeError: { error: 'invalid_grant', aadsts: 90094 } }, target: '/signin?error=admin_approval_required', audit: null, sessions: 0 },
  { id: 'F-36 AADSTS50105', spec: { authorizeError: { error: 'access_denied', aadsts: 50105 } }, target: '/signin?error=assignment_required', audit: null, sessions: 0 },
  {
    id: 'F-37 invalid_request with a 5,000-character hostile description',
    spec: { authorizeError: { error: 'invalid_request', description: HOSTILE_DESCRIPTION } },
    target: SIGNIN_FAILED,
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-38 token endpoint answers invalid_grant',
    prepare: (scene) => {
      scene.world.entra.control.failToken({ times: 1, answer: { status: 400, error: 'invalid_grant' } });
    },
    target: SIGNIN_FAILED,
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-39 token endpoint answers invalid_client',
    prepare: (scene) => {
      scene.world.entra.control.failToken({ times: 1, answer: { status: 401, error: 'invalid_client', aadsts: 700027 } });
    },
    target: SIGNIN_FAILED,
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-40 token endpoint answers temporarily_unavailable once, then succeeds',
    run: async (scene) => {
      scene.world.entra.control.failToken({ times: 1, answer: { status: 400, error: 'temporarily_unavailable' } });
      const browser = scene.browser();
      const started = await startFlow(browser);
      const nav = await pump(scene, deliver(browser, started.callbackUrl));
      return { nav, target: targetOf(nav), canaries: canariesOf(scene, [started]) };
    },
    target: 'interstitial',
    audit: SUCCESS,
    sessions: 1,
  },
  {
    id: 'F-41 token endpoint answers 503 twice',
    run: async (scene) => {
      scene.world.entra.control.failToken({ times: 2, answer: { status: 503 } });
      const browser = scene.browser();
      const started = await startFlow(browser);
      const nav = await pump(scene, deliver(browser, started.callbackUrl));
      return { nav, target: targetOf(nav), canaries: canariesOf(scene, [started]) };
    },
    target: '/signin?error=temporarily_unavailable',
    audit: null,
    sessions: 0,
  },
  {
    id: 'F-41 token endpoint does not answer within 10 s',
    run: async (scene) => {
      scene.world.entra.control.failToken({ times: 2, answer: 'hang' });
      const browser = scene.browser();
      const started = await startFlow(browser);
      const nav = await pump(scene, deliver(browser, started.callbackUrl));
      return { nav, target: targetOf(nav), canaries: canariesOf(scene, [started]) };
    },
    target: '/signin?error=temporarily_unavailable',
    audit: null,
    sessions: 0,
  },
  ...['//evil', '/\\evil', 'https://evil', '/api/v1/me', '/setup', '/x\r\nSet-Cookie: a=b', `/${'a'.repeat(300)}`].map(
    (attack): Row => ({
      id: `F-43 returnTo attack ${JSON.stringify(attack).slice(0, 24)}`,
      query: `?returnTo=${encodeURIComponent(attack)}`,
      target: 'interstitial',
      audit: SUCCESS,
      sessions: 1,
    }),
  ),
  {
    id: 'F-44a Global Administrator without an assignment (wids is ignored)',
    scene: { role: false },
    spec: { claims: { wids: ['62e90394-69f5-4237-9190-012177145e10'] } },
    target: 'no-access:no_role',
    audit: { outcome: 'denied', reason: 'no_role' },
    sessions: 0,
  },
  {
    id: 'F-44b only a group-derived assignment while Graph fails',
    scene: {
      role: false,
      grantGraph: false,
      seed: (db) => {
        assign(db, { principalType: 'group', principalId: '22222222-2222-4222-8222-222222222222', role: 'owner' });
      },
    },
    target: 'no-access:graph_unavailable',
    audit: { outcome: 'denied', reason: 'graph_unavailable' },
    sessions: 0,
  },
  {
    id: 'F-45 groups with 250 entries, _claim_names and hasgroups are ignored',
    spec: {
      claims: {
        // 250 entries, short ones: a token with 250 GUIDs would be about 9.5 KB and meet the 8 KiB
        // limit of F-25 first (recorded as an open point of this stream).
        groups: Array.from({ length: 250 }, (_, index) => `g${String(index)}`),
        _claim_names: { groups: 'src1' },
        hasgroups: true,
      },
    },
    target: 'interstitial',
    audit: SUCCESS,
    sessions: 1,
  },
];

function withParam(url: URL, name: string, value: string | null): URL {
  const copy = new URL(url);
  if (value === null) copy.searchParams.delete(name);
  else copy.searchParams.set(name, value);
  return copy;
}

describe('the sign-in fixtures F-01 to F-45 (spec Appendix C)', () => {
  it.each(ROWS.map((row) => [row.id, row] as const))('%s', async (_id, row) => {
    const scene = await startSignInScene(row.scene);
    row.prepare?.(scene);
    const outcome = row.run === undefined ? await standardFlow(scene, row) : await row.run(scene);

    // 1. The redirect target.
    const expectedTarget = row.target.startsWith('no-access:')
      ? `/no-access?reason=${row.target.slice('no-access:'.length)}&ref=`
      : row.target;
    if (row.target.startsWith('no-access:')) {
      expect(outcome.target.startsWith(expectedTarget)).toBe(true);
      const ref = new URL(outcome.target, 'http://x').searchParams.get('ref') ?? '';
      expect(ref).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    } else {
      expect(outcome.target).toBe(expectedTarget);
    }

    // 2. The audit entry.
    const entries = auditOf(scene);
    if (row.audit === null) {
      expect(entries).toEqual([]);
    } else {
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry?.action).toBe(row.audit.action ?? 'auth.signin');
      expect(entry?.outcome).toBe(row.audit.outcome);
      if (row.audit.reason !== undefined) expect(entry?.detail.reason).toBe(row.audit.reason);
      if (row.audit.check !== undefined) {
        expect(entry?.detail.check).toBe(row.audit.check);
        expect(SIGNIN_CHECKS as readonly string[]).toContain(row.audit.check);
      }
    }

    // 3. The sessions created.
    expect(scene.sessionCount()).toBe(row.sessions);

    // 4. No canary anywhere, and no token in any table.
    expectNoCanaries(scene, outcome.nav, outcome.canaries);
  });
});

describe('the fixtures that need their own setup', () => {
  it('F-04 a guest of the pinned tenant with an assignment is an ordinary principal by oid', async () => {
    let guestId = '';
    const scene = await startSignInScene({
      role: false,
      seed: (db, world) => {
        const guest = world.graph.directory.addUser({
          userPrincipalName: 'partner_example.org#EXT#@contoso-fake.example',
        });
        guestId = guest.id;
        assign(db, { principalId: guest.id, role: 'reader' });
      },
    });
    scene.world.entra.control.nextSignIn({ user: guestId });
    const browser = scene.browser();
    const started = await startFlow(browser);
    const nav = await deliver(browser, started.callbackUrl);
    expect(targetOf(nav)).toBe('interstitial');
    const [session] = scene.query<{ tid: string; oid: string }>('SELECT tid, oid FROM session');
    expect(session).toEqual({ tid: scene.world.tenantId, oid: guestId });
    expect(auditOf(scene)).toHaveLength(1);
  });
});

/** F-42: the `amr` shapes, with and without the switch. */
const AMR_ROWS: readonly (readonly [string, SignInSpec, 'ok' | 'amr_missing' | 'mfa_required'])[] = [
  ['absent', { omitClaims: ['amr'] }, 'amr_missing'],
  ['pwd only', { claims: { amr: ['pwd'] } }, 'mfa_required'],
  ['the string mfa instead of an array', { claims: { amr: 'mfa' } }, 'amr_missing'],
  ['pwd and mfa', { claims: { amr: ['pwd', 'mfa'] } }, 'ok'],
  ['ngcmfa alone', { claims: { amr: ['ngcmfa'] } }, 'mfa_required'],
  ['rsa, ngcmfa and mfa', { claims: { amr: ['rsa', 'ngcmfa', 'mfa'] } }, 'ok'],
];

describe('F-42 the amr variants (EB-26, EB-27)', () => {
  it.each(AMR_ROWS)('AUTH_REQUIRE_MFA=true, amr %s', async (_name, spec, verdict) => {
    const scene = await startSignInScene();
    const outcome = await standardFlow(scene, {
      id: 'amr',
      spec,
      target: '',
      audit: null,
      sessions: 0,
    });
    if (verdict === 'ok') {
      expect(outcome.target).toBe('interstitial');
      expect(scene.query('SELECT mfa FROM session')).toEqual([{ mfa: 1 }]);
      expect(auditOf(scene)[0]?.detail.mfa).toBe(true);
    } else {
      expect(outcome.target).toBe(`/signin?error=${verdict}`);
      expect(scene.sessionCount()).toBe(0);
      const [entry] = auditOf(scene);
      expect(entry).toMatchObject({ action: 'auth.signin', outcome: 'denied' });
      expect(entry?.detail.reason).toBe(verdict);
    }
  });

  it.each(AMR_ROWS)('AUTH_REQUIRE_MFA=false, amr %s: signs in with mfa = 0', async (_name, spec) => {
    const scene = await startSignInScene({ env: { AUTH_REQUIRE_MFA: 'false' } });
    const outcome = await standardFlow(scene, { id: 'amr', spec, target: '', audit: null, sessions: 0 });
    expect(outcome.target).toBe('interstitial');
    expect(scene.query('SELECT mfa FROM session')).toEqual([{ mfa: 0 }]);
    expect(auditOf(scene)[0]?.detail.mfa).toBe(false);
  });
});

describe('what the fixtures leave in the log and the world', () => {
  it('F-39: an invalid_client answer is logged as signin_denied with its code, and the person sees signin_failed', async () => {
    const scene = await startSignInScene();
    scene.world.entra.control.failToken({
      times: 1,
      answer: { status: 401, error: 'invalid_client', aadsts: 700027 },
    });
    const outcome = await standardFlow(scene, { id: 'x', target: '', audit: null, sessions: 0 });
    expect(outcome.target).toBe(SIGNIN_FAILED);
    const denied = scene.logs.lines().filter((line) => line.event === 'signin_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ code: 'invalid_client' });
  });

  it('F-20: the URL of a jku header is never fetched', async () => {
    const scene = await startSignInScene();
    await standardFlow(scene, {
      id: 'x',
      spec: { header: { jku: 'https://attacker.example/keys' } },
      target: '',
      audit: null,
      sessions: 0,
    });
    expect(fake.calls.all().filter((call) => call.host.includes('attacker'))).toEqual([]);
    expect(scene.logs.text()).not.toContain('attacker.example');
  });

  it('F-44a: the ref of /no-access is the request id of the callback', async () => {
    const scene = await startSignInScene({ role: false });
    const browser = scene.browser();
    const started = await startFlow(browser);
    const result = await browser.request(started.callbackUrl, { from: 'microsoft' });
    const ref = new URL(result.headers.get('location') ?? '', 'http://x').searchParams.get('ref');
    expect(ref).toBe(result.headers.get('x-request-id'));
  });

  it('F-01: the first sign-in writes the app_user row with the labels and the time', async () => {
    const scene = await startSignInScene();
    await standardFlow(scene, { id: 'x', target: '', audit: null, sessions: 0 });
    const [row] = scene.query<{ oid: string; upn_label: string | null; last_signin_at: string }>(
      'SELECT oid, upn_label, last_signin_at FROM app_user',
    );
    expect(row?.oid).toBe(scene.userId);
    expect(row?.upn_label).toBe('alice@contoso-fake.example');
    expect(row?.last_signin_at).toBe(new Date(testClock.nowMs()).toISOString());
  });

  it('F-44: a person with no role leaves no app_user row behind', async () => {
    const scene = await startSignInScene({ role: false });
    await standardFlow(scene, { id: 'x', target: '', audit: null, sessions: 0 });
    expect(scene.query('SELECT 1 FROM app_user')).toEqual([]);
  });
});

describe('the order of FR-B-403', () => {
  it('deletes the transaction and clears the cookie before it looks at state or code', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const started = await startFlow(browser);
    const nav = await deliver(browser, withParam(started.callbackUrl, 'state', 'wrong'));
    expect(targetOf(nav)).toBe(SIGNIN_FAILED);
    expect(browser.cookie('m365portal_oidc')).toBeUndefined();
    expect(nav.chain[0]?.status).toBe(303);
    const cleared = nav.setCookies.length === 0 ? '' : nav.setCookies.join('\n');
    expect(cleared).toBe('');
  });

  it('answers every failure with Cache-Control no-store and a cleared transaction cookie', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const started = await startFlow(browser);
    const result = await browser.request(withParam(started.callbackUrl, 'state', 'wrong'), {
      from: 'microsoft',
    });
    expect(result.status).toBe(303);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.setCookies.join('\n')).toMatch(/m365portal_oidc=;.*Max-Age=0/);
    expect(result.setCookies).toHaveLength(1);
  });

  it('never logs the query string of the callback', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const started = await startFlow(browser);
    await deliver(browser, started.callbackUrl);
    const logs = scene.logs.text();
    expect(logs).not.toContain(started.code ?? 'no-code');
    expect(logs).not.toContain(started.state ?? 'no-state');
    expect(logs).not.toContain('code=');
    expect(logs).not.toContain('session_state');
  });

  it('ignores parameters nobody declared (session_state)', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const started = await startFlow(browser);
    const nav = await deliver(browser, withParam(started.callbackUrl, 'session_state', 'abc'));
    expect(targetOf(nav)).toBe('interstitial');
  });
});

describe('the identifiers of a session', () => {
  it('the callback stores only the hash of the new session id', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const started = await startFlow(browser);
    const nav = await deliver(browser, started.callbackUrl);
    expect(targetOf(nav)).toBe('interstitial');
    const value = browser.cookie('m365portal_session') ?? '';
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scene.query<{ id_hash: string }>('SELECT id_hash FROM session')).toEqual([
      { id_hash: sha256(value) },
    ]);
    expect(databaseText(scene)).not.toContain(value);
  });
});
