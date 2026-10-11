// T-B-180, FR-B-402, FR-B-410, FR-B-521, FR-B-603 (part), CB14: the wire schemas of the sign-in
// routes (P01 to P06, P09). Held together:
//   - every schema contract 12.1 names for `schemas/auth.ts` exists, has `.meta({ id })`, can be
//     written as JSON Schema (so it has no transform) and every request is strict;
//   - the code lists are the registries (`SIGNIN_ERROR_CODES`, `NO_ACCESS_REASONS`);
//   - the login query is lenient on purpose and `loginQueryOf` is where it is made safe;
//   - the sign-out redirect has exactly the two shapes of CD-02;
//   - every guard has a negative fixture (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NO_ACCESS_REASONS, SIGNIN_ERROR_CODES } from '../src/auth/signin-errors.js';
import * as auth from '../src/schemas/auth.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  BreakGlassRequestSchema,
  BreakGlassResponseSchema,
  LoginQuerySchema,
  LogoutAllResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  MyAccessResponseSchema,
  NoAccessReasonSchema,
  SigninErrorCodeSchema,
  isLogoutRedirect,
  loginQueryOf,
} = auth;

const CONTRACT = readFileSync(
  new URL('../../../specs/002-phase-b/contracts/phase-b-api.md', import.meta.url),
  'utf8',
);

const show = (value: unknown): string => inspect(value, { breakLength: Infinity });
const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const mustReject =
  (schema: z.ZodType) =>
  (value: unknown): void => {
    if (schema.safeParse(value).success)
      throw new Error(`accepted: ${JSON.stringify(value).slice(0, 80)}`);
  };

const TID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ENTRA_LOGOUT = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent('https://panel.example.test/auth/logged-out')}`;

describe('the schemas of contract 12.1 for schemas/auth.ts', () => {
  const row = /^\| `schemas\/auth\.ts` \| (.+) \|$/m.exec(CONTRACT)?.[1] ?? '';
  const named = [...row.matchAll(/`([A-Za-z]+Schema)`/g)].map((m) => m[1] ?? '');

  it('are the nine the contract lists, and all exist', () => {
    expect(named).toHaveLength(9);
    const exports = auth as unknown as Record<string, unknown>;
    for (const name of named) expect(exports[name], name).toBeInstanceOf(z.ZodType);
  });

  it('carry .meta({ id }) with the constant name without Schema', () => {
    const exports = auth as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      expect(z.globalRegistry.get(value)?.id, name).toBe(name.replace(/Schema$/, ''));
    }
  });

  it('can be written as JSON Schema, which a transform cannot', () => {
    const exports = auth as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      expect(() => z.toJSONSchema(value, { io: 'input' }), name).not.toThrow();
    }
  });
});

describe('SigninErrorCodeSchema and NoAccessReasonSchema', () => {
  it('are the registries, every member accepted and nothing else', () => {
    for (const code of SIGNIN_ERROR_CODES) expect(ok(SigninErrorCodeSchema, code), code).toBe(true);
    for (const reason of NO_ACCESS_REASONS)
      expect(ok(NoAccessReasonSchema, reason), reason).toBe(true);
    for (const bad of ['nope', '', 'no_role', 'toString', null, 1]) {
      expect(ok(SigninErrorCodeSchema, bad), String(bad)).toBe(false);
    }
    for (const bad of ['signin_failed', 'mfa_required', '', 'constructor', undefined]) {
      expect(ok(NoAccessReasonSchema, bad), String(bad)).toBe(false);
    }
  });
});

describe('LoginQuerySchema and loginQueryOf (P01)', () => {
  it('never rejects what a navigation can carry', () => {
    expect(ok(LoginQuerySchema, {})).toBe(true);
    expect(ok(LoginQuerySchema, { returnTo: '//evil', prompt: 'consent', purpose: 'admin' })).toBe(
      true,
    );
    expect(ok(LoginQuerySchema, { returnTo: 'x'.repeat(5000) })).toBe(true);
    expect(
      ok(LoginQuerySchema, { returnTo: '/users', session_state: 'abc', utm_source: 'x' }),
    ).toBe(true);
  });

  it('turns an unsafe returnTo into / with safeReturnTo', () => {
    for (const returnTo of [
      '//evil',
      '/\\evil',
      'https://evil',
      '/api/v1/me',
      '/setup',
      '/ok\r\nx',
      `/${'a'.repeat(299)}`,
      undefined,
    ]) {
      expect(loginQueryOf({ returnTo }).returnTo, String(returnTo)).toBe('/');
    }
    expect(loginQueryOf({ returnTo: '/users?q=1' }).returnTo).toBe('/users?q=1');
  });

  it('keeps prompt login and select_account only, and drops everything else', () => {
    expect(loginQueryOf({ prompt: 'login' }).prompt).toBe('login');
    expect(loginQueryOf({ prompt: 'select_account' }).prompt).toBe('select_account');
    for (const prompt of ['none', 'consent', 'LOGIN', 'login ', '', 'create', undefined]) {
      expect(loginQueryOf({ prompt }).prompt, String(prompt)).toBeUndefined();
    }
  });

  it('is signin unless the purpose is exactly stepup', () => {
    expect(loginQueryOf({}).purpose).toBe('signin');
    expect(loginQueryOf({ purpose: 'signin' }).purpose).toBe('signin');
    expect(loginQueryOf({ purpose: 'stepup' }).purpose).toBe('stepup');
    for (const purpose of ['Stepup', 'step-up', 'admin', '', 'stepup ']) {
      expect(loginQueryOf({ purpose }).purpose, purpose).toBe('signin');
    }
  });

  it('negative: a query schema that rejects a long returnTo would turn a sign-in into a 422', () => {
    const rejecting = z.object({ returnTo: z.string().max(256).optional() });
    const lenient = (schema: z.ZodType): void => {
      if (!schema.safeParse({ returnTo: 'x'.repeat(300) }).success)
        throw new Error('rejected a navigation');
    };
    lenient(LoginQuerySchema);
    expectGuardFails(lenient, rejecting, { reason: 'rejected a navigation' });
  });
});

describe('LogoutRequestSchema, LogoutResponseSchema and LogoutAllResponseSchema (P04, P05, CD-02)', () => {
  it('the request is the empty strict object', () => {
    expect(ok(LogoutRequestSchema, {})).toBe(true);
    for (const bad of [{ a: 1 }, { all: true }, null, [], 'x'])
      expect(ok(LogoutRequestSchema, bad), JSON.stringify(bad)).toBe(false);
  });

  it('knows exactly two shapes of redirect', () => {
    expect(isLogoutRedirect('/signin?signedout=1')).toBe(true);
    expect(isLogoutRedirect(ENTRA_LOGOUT)).toBe(true);
    expect(
      isLogoutRedirect(
        `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A9300%2Fauth%2Flogged-out`,
      ),
    ).toBe(true);
    expect(ok(LogoutResponseSchema, { redirect: ENTRA_LOGOUT })).toBe(true);
    expect(ok(LogoutResponseSchema, { redirect: '/signin?signedout=1' })).toBe(true);
  });

  it('refuses every other redirect: other hosts, schemes, paths, parameters and encodings', () => {
    const post = encodeURIComponent('https://panel.example.test/auth/logged-out');
    const bad = [
      '',
      '/',
      '/signin',
      '/signin?signedout=0',
      '/signin?signedout=1&x=1',
      '//evil.test',
      'https://evil.test/',
      'javascript:alert(1)',
      'http://login.microsoftonline.com/x',
      `http://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com.evil.test/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://evil.test/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com@evil.test/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com:8443/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://user:pw@login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com/${TID.toUpperCase()}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com/${TID}/oauth2/logout?post_logout_redirect_uri=${post}`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}&x=1`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?x=1`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}#frag`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent('https://panel.example.test/auth/logout')}`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent('https://panel.example.test/auth/logged-out?x=1')}`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent('javascript:alert(1)//auth/logged-out')}`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent('https://user@panel.example.test/auth/logged-out')}`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent('ftp://panel.example.test/auth/logged-out')}`,
      `${ENTRA_LOGOUT} `,
      ` ${ENTRA_LOGOUT}`,
      `${ENTRA_LOGOUT}\n`,
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout?post_logout_redirect_uri=${'a'.repeat(3000)}`,
      null,
      undefined,
      5,
      {},
    ];
    for (const redirect of bad) {
      expect(isLogoutRedirect(redirect), show(redirect).slice(0, 90)).toBe(false);
      expect(ok(LogoutResponseSchema, { redirect }), show(redirect).slice(0, 90)).toBe(false);
    }
  });

  it('logout-all counts at least one ended session, at most the per-principal cap', () => {
    expect(ok(LogoutAllResponseSchema, { redirect: ENTRA_LOGOUT, sessionsEnded: 1 })).toBe(true);
    expect(ok(LogoutAllResponseSchema, { redirect: ENTRA_LOGOUT, sessionsEnded: 10 })).toBe(true);
    for (const sessionsEnded of [0, -1, 11, 1.5, '1', null]) {
      expect(
        ok(LogoutAllResponseSchema, { redirect: ENTRA_LOGOUT, sessionsEnded }),
        String(sessionsEnded),
      ).toBe(false);
    }
    expect(ok(LogoutAllResponseSchema, { redirect: ENTRA_LOGOUT })).toBe(false);
    expect(
      ok(LogoutAllResponseSchema, { redirect: ENTRA_LOGOUT, sessionsEnded: 1, extra: 1 }),
    ).toBe(false);
  });

  it('negative: a redirect schema that takes any string lets an open redirect through', () => {
    const loose = z.strictObject({ redirect: z.string() });
    expectGuardFails(mustReject(loose), { redirect: 'https://evil.test/' }, { reason: 'accepted' });
    mustReject(LogoutResponseSchema)({ redirect: 'https://evil.test/' });
    mustReject(LogoutResponseSchema)({ redirect: '//evil.test' });
  });
});

describe('BreakGlassRequestSchema and BreakGlassResponseSchema (P06, FR-B-521)', () => {
  it('takes a username of 1 to 256 bytes and a password of 1 to 1,024 bytes', () => {
    expect(ok(BreakGlassRequestSchema, { username: 'u', password: 'p' })).toBe(true);
    expect(
      ok(BreakGlassRequestSchema, { username: 'a'.repeat(256), password: 'p'.repeat(1024) }),
    ).toBe(true);
    expect(
      ok(BreakGlassRequestSchema, { username: 'é'.repeat(128), password: 'é'.repeat(512) }),
    ).toBe(true);
    for (const bad of [
      { username: '', password: 'p' },
      { username: 'u', password: '' },
      { username: 'a'.repeat(257), password: 'p' },
      { username: 'u', password: 'p'.repeat(1025) },
      { username: 'é'.repeat(129), password: 'p' },
      { username: 'u', password: 'é'.repeat(513) },
      { username: 'u' },
      { password: 'p' },
      { username: 1, password: 'p' },
      { username: 'u', password: null },
      { username: 'u', password: 'p', remember: true },
      { user: 'u', password: 'p' },
    ]) {
      expect(ok(BreakGlassRequestSchema, bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it('does not trim or alter a password (spaces count)', () => {
    const parsed = BreakGlassRequestSchema.parse({ username: 'u', password: '  spaced  ' });
    expect(parsed.password).toBe('  spaced  ');
  });

  it('answers with the restore-access page and nothing else', () => {
    expect(ok(BreakGlassResponseSchema, { redirect: '/settings/restore-access' })).toBe(true);
    for (const bad of [
      { redirect: '/' },
      { redirect: 'https://evil.test' },
      {},
      { redirect: '/settings/restore-access', session: 'x' },
    ]) {
      expect(ok(BreakGlassResponseSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('negative: a request schema without a size bound lets a megabyte password through', () => {
    const unbounded = z.strictObject({ username: z.string(), password: z.string() });
    const big = { username: 'u', password: 'p'.repeat(1_000_000) };
    expectGuardFails(mustReject(unbounded), big, { reason: 'accepted' });
    mustReject(BreakGlassRequestSchema)(big);
  });
});

describe('MyAccessResponseSchema (P09, "Mijn toegang")', () => {
  const G = '1f8fad5b-d9cb-469f-a165-70867728950e';
  const G2 = '2f8fad5b-d9cb-469f-a165-70867728950e';
  const T = '2026-10-11T10:00:00.000Z';
  interface AccessFixture {
    assignments: unknown[];
    [key: string]: unknown;
  }
  const userAccess = (over: Record<string, unknown> = {}): AccessFixture => ({
    principal: { kind: 'user', id: G, label: 'Ada Lovelace' },
    assignments: [
      {
        id: G2,
        role: { key: 'owner', builtin: true },
        origin: { type: 'direct' },
        scope: [],
        expiresAt: null,
      },
      {
        id: TID,
        role: { key: 'helpdesk', builtin: true },
        origin: { type: 'group', groupId: G2, groupName: 'Servicedesk' },
        scope: [{ target: 'user', match: { by: 'prefix', attr: 'displayName', value: 'Sales' } }],
        expiresAt: T,
      },
    ],
    grants: [
      { permission: 'users:read', qualifier: 'full', scope: 'all' },
      {
        permission: 'groups:members:write',
        qualifier: 'full',
        scope: [{ target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Sales' } }],
      },
    ],
    groupsStale: false,
    groupsResolvedAt: T,
    ...over,
  });
  const breakGlass = (over: Record<string, unknown> = {}): AccessFixture => ({
    principal: { kind: 'break_glass', id: 'break_glass', label: 'Break-glass' },
    assignments: [],
    grants: [{ permission: 'rbac:manage', qualifier: 'full', scope: 'all' }],
    groupsStale: false,
    groupsResolvedAt: null,
    ...over,
  });

  it('accepts the access of a user, direct and through a group', () => {
    expect(ok(MyAccessResponseSchema, userAccess())).toBe(true);
    expect(ok(MyAccessResponseSchema, userAccess({ assignments: [], grants: [] }))).toBe(true);
    expect(
      ok(MyAccessResponseSchema, userAccess({ groupsStale: true, groupsResolvedAt: null })),
    ).toBe(true);
    const nameless = userAccess();
    (nameless.assignments[1] as { origin: unknown }).origin = {
      type: 'group',
      groupId: G2,
      groupName: null,
    };
    expect(ok(MyAccessResponseSchema, nameless)).toBe(true);
  });

  it('accepts a break-glass session with no assignments and the single grant rbac:manage', () => {
    expect(ok(MyAccessResponseSchema, breakGlass())).toBe(true);
  });

  it('refuses a break-glass session that holds anything else (FR-B-522)', () => {
    for (const bad of [
      breakGlass({ grants: [] }),
      breakGlass({ grants: [{ permission: 'users:read', qualifier: 'full', scope: 'all' }] }),
      breakGlass({
        grants: [
          { permission: 'rbac:manage', qualifier: 'full', scope: 'all' },
          { permission: 'users:read', qualifier: 'full', scope: 'all' },
        ],
      }),
      breakGlass({ assignments: userAccess().assignments.slice(0, 1) }),
    ]) {
      expect(ok(MyAccessResponseSchema, bad), show(bad).slice(0, 80)).toBe(false);
    }
  });

  it('refuses a principal that is neither a user by oid nor break-glass', () => {
    for (const principal of [
      { kind: 'setup', id: 'setup', label: 'Setup' },
      { kind: 'anonymous', id: '', label: '' },
      { kind: 'user', id: 'ada@contoso.test', label: 'Ada' },
      { kind: 'user', id: G.toUpperCase(), label: 'Ada' },
      { kind: 'break_glass', id: G, label: 'x' },
      { kind: 'user', id: G, label: 'x'.repeat(257) },
      { kind: 'user', id: G, label: 'Ada', extra: 1 },
    ]) {
      expect(ok(MyAccessResponseSchema, userAccess({ principal })), show(principal)).toBe(false);
    }
  });

  it('refuses what the RBAC schemas refuse and any extra field', () => {
    const base = userAccess();
    const bad = [
      userAccess({ grants: [{ permission: 'not:a-permission', qualifier: 'full', scope: 'all' }] }),
      userAccess({ grants: [{ permission: 'groups:read', qualifier: 'basic', scope: 'all' }] }),
      userAccess({ grants: [{ permission: 'users:read', qualifier: 'full', scope: [] }] }),
      userAccess({
        assignments: [
          {
            id: G2,
            role: { key: 'Owner', builtin: true },
            origin: { type: 'direct' },
            scope: [],
            expiresAt: null,
          },
        ],
      }),
      userAccess({
        assignments: [
          {
            id: G2,
            role: { key: 'owner', builtin: true },
            origin: { type: 'team' },
            scope: [],
            expiresAt: null,
          },
        ],
      }),
      userAccess({
        assignments: [
          {
            id: G2,
            role: { key: 'owner', builtin: true },
            origin: { type: 'direct' },
            scope: [{ target: 'user' }],
            expiresAt: null,
          },
        ],
      }),
      { ...base, token: 'x' },
      { ...base, sessionId: 'x' },
      userAccess({ groupsStale: 'no' }),
      userAccess({ groupsResolvedAt: 'yesterday' }),
    ];
    for (const value of bad)
      expect(ok(MyAccessResponseSchema, value), show(value).slice(0, 80)).toBe(false);
  });

  it('negative: a schema that does not tie break-glass to rbac:manage lets a wide session through', () => {
    const wide = breakGlass({
      grants: [{ permission: 'users:read', qualifier: 'full', scope: 'all' }],
    });
    const untied = z.strictObject({
      principal: z.unknown(),
      assignments: z.array(z.unknown()),
      grants: z.array(z.unknown()),
      groupsStale: z.boolean(),
      groupsResolvedAt: z.unknown(),
    });
    expectGuardFails(mustReject(untied), wide, { reason: 'accepted' });
    mustReject(MyAccessResponseSchema)(wide);
  });
});
