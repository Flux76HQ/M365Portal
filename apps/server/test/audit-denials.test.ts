// T-B-242, FR-B-602, FR-B-414, FR-B-411, TB-11: the denials of the route table, audited.
//
// The table is walked: every access word the wrapper knows, as a read and as a write, times every kind
// of caller (nobody, an expired session, a user with no role, a reader, an Owner who stepped up, an
// Owner who did not, the setup actor, break-glass). For each pair the expected answer is written out
// below, from the contract (section 1 of `contracts/phase-b-api.md`) and not from the code:
//
//   - nobody gets 401 `unauthenticated`, an unknown or expired session cookie gets 401
//     `session_expired` and the cookie is cleared;
//   - a caller that is signed in but lacks the permission, or is of the wrong kind, gets 403
//     `permission_denied`; a stale step-up gets 403 `step_up_required`;
//   - every denial of a WRITE route (any caller, 401 included) and every denial of a READ route of a
//     caller that has a session of some kind is audited BEFORE the answer: `action` is the route id,
//     `outcome` `denied`, `reason_code` one of the five of FR-B-602, with the request id and the client
//     address; anonymous reads, 429 and successes write no denial;
//   - if the append fails the answer is 503 `storage_unavailable` instead of the denial.
//
// Negative fixtures: the same walk against a pipeline that audits too little, too much or too late.
import { cookieNames } from '@m365portal/shared/auth/cookies';
import type { Permission } from '@m365portal/shared/permissions';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifyChain } from '../src/audit/index.js';
import { createDenialAudit } from '../src/http/denial-audit.js';
import {
  defineRoute,
  type OnRouteDenied,
  type RouteAccess,
  type RouteDefinition,
} from '../src/http/route.js';
import { createFixtureApp, fixtureRoutes } from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';
import {
  createPolicyHarness,
  type PolicyHarness,
  type SeededSession,
} from './helpers/policy-harness.js';
import { assign, guid } from './helpers/rbac-db.js';

const RBAC: Permission = 'rbac:manage';
const REASONS = [
  'permission_missing',
  'scope_mismatch',
  'step_up_required',
  'escalation_denied',
  'last_owner_protected',
] as const;

interface AccessCase {
  readonly name: string;
  readonly access: RouteAccess;
}

const ACCESS_CASES: readonly AccessCase[] = [
  { name: 'authenticated', access: { authenticated: true } },
  { name: 'usersonly', access: { authenticated: true, actorKinds: ['user'] } },
  { name: 'permission', access: { permission: RBAC, unscopedReason: 'global-only permission' } },
  {
    name: 'stepup',
    access: { permission: RBAC, stepUp: true, unscopedReason: 'global-only permission' },
  },
  { name: 'setup', access: { setup: true } },
  { name: 'connection', access: { connection: true } },
  { name: 'connectionstepup', access: { connection: true, stepUp: true } },
];

type CallerName =
  'nobody' | 'expired' | 'norole' | 'reader' | 'owner' | 'ownerstale' | 'setup' | 'breakglass';

const CALLERS: readonly CallerName[] = [
  'nobody',
  'expired',
  'norole',
  'reader',
  'owner',
  'ownerstale',
  'setup',
  'breakglass',
];

interface Expected {
  readonly status: number;
  readonly code?: string;
  /** The audit reason when the answer is a denial. */
  readonly reason?: (typeof REASONS)[number];
}

const OK: Expected = { status: 200 };
const UNAUTHENTICATED: Expected = {
  status: 401,
  code: 'unauthenticated',
  reason: 'permission_missing',
};
const EXPIRED: Expected = { status: 401, code: 'session_expired', reason: 'permission_missing' };
const FORBIDDEN: Expected = {
  status: 403,
  code: 'permission_denied',
  reason: 'permission_missing',
};
const STEP_UP: Expected = { status: 403, code: 'step_up_required', reason: 'step_up_required' };

/** What the contract says each caller gets on each access word (written out, not computed). */
const EXPECTED: Readonly<Record<string, Readonly<Record<CallerName, Expected>>>> = {
  authenticated: {
    nobody: UNAUTHENTICATED,
    expired: EXPIRED,
    norole: OK,
    reader: OK,
    owner: OK,
    ownerstale: OK,
    setup: UNAUTHENTICATED,
    breakglass: OK,
  },
  usersonly: {
    nobody: UNAUTHENTICATED,
    expired: EXPIRED,
    norole: OK,
    reader: OK,
    owner: OK,
    ownerstale: OK,
    setup: UNAUTHENTICATED,
    breakglass: FORBIDDEN,
  },
  permission: {
    nobody: UNAUTHENTICATED,
    expired: EXPIRED,
    norole: FORBIDDEN,
    reader: FORBIDDEN,
    owner: OK,
    ownerstale: OK,
    setup: FORBIDDEN,
    breakglass: OK,
  },
  stepup: {
    nobody: UNAUTHENTICATED,
    expired: EXPIRED,
    norole: FORBIDDEN,
    reader: FORBIDDEN,
    owner: OK,
    ownerstale: STEP_UP,
    setup: FORBIDDEN,
    breakglass: OK,
  },
  setup: {
    nobody: UNAUTHENTICATED,
    // A stale session cookie says nothing about the setup session: nothing is cleared.
    expired: UNAUTHENTICATED,
    norole: UNAUTHENTICATED,
    reader: UNAUTHENTICATED,
    owner: UNAUTHENTICATED,
    ownerstale: UNAUTHENTICATED,
    setup: OK,
    breakglass: UNAUTHENTICATED,
  },
  connection: {
    nobody: UNAUTHENTICATED,
    expired: EXPIRED,
    norole: FORBIDDEN,
    reader: FORBIDDEN,
    owner: OK,
    ownerstale: OK,
    setup: OK,
    breakglass: FORBIDDEN,
  },
  connectionstepup: {
    nobody: UNAUTHENTICATED,
    expired: EXPIRED,
    norole: FORBIDDEN,
    reader: FORBIDDEN,
    owner: OK,
    ownerstale: STEP_UP,
    setup: OK,
    breakglass: FORBIDDEN,
  },
};

const OK_BODY = z.strictObject({ ok: z.literal(true) });

function routesOf(enter: (id: string) => void): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  for (const { name, access } of ACCESS_CASES) {
    for (const [verb, method] of [
      ['read', 'GET'],
      ['make', 'POST'],
    ] as const) {
      const id = `deny.${name}.${verb}`;
      routes.push(
        defineRoute({
          id,
          method,
          // The setup and connection families sit where the contract puts them.
          path: `/api/v1/${name.startsWith('conn') ? 'connection' : name === 'setup' ? 'setup' : 'deny'}/${name}/${verb}`,
          access,
          rateLimit: method === 'GET' ? 'read' : 'write',
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: OK_BODY } } },
          },
          handler: (c) => {
            enter(id);
            return c.json({ ok: true as const }, 200);
          },
        }),
      );
    }
  }
  return routes;
}

interface Rig {
  readonly harness: PolicyHarness;
  readonly callers: Readonly<Record<CallerName, readonly SeededSession[]>>;
  readonly app: Awaited<ReturnType<typeof createFixtureApp>>;
  readonly audit: () => AuditRow[];
}

interface AuditRow {
  readonly action: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly client_ip: string | null;
  readonly request_id: string | null;
  readonly detail: string;
}

async function rig(
  options: { onDenied?: (real: OnRouteDenied) => OnRouteDenied } = {},
): Promise<Rig> {
  const harness = await createPolicyHarness();
  const owner = guid(10);
  assign(harness.db, { principalId: owner, role: 'owner' });
  assign(harness.db, { principalId: guid(11), role: 'reader' });
  const real = createDenialAudit({ database: () => harness.db, now: () => harness.clock.nowMs() });
  const names = cookieNames('http://localhost:9300');
  const callers: Record<CallerName, readonly SeededSession[]> = {
    nobody: [],
    expired: [
      {
        value: 'x'.repeat(43),
        idHash: 'x',
        oid: '',
        headers: { cookie: `${names.session}=${'x'.repeat(43)}` },
      },
    ],
    norole: [harness.seedSession({ oid: guid(12) })],
    reader: [harness.seedSession({ oid: guid(11) })],
    owner: [harness.seedSession({ oid: owner, stepUpAgoMs: 1_000 })],
    ownerstale: [harness.seedSession({ oid: owner, stepUpAgoMs: null })],
    setup: [harness.seedSetupSession()],
    breakglass: [harness.seedSession({ kind: 'break_glass' })],
  };
  const app = await createFixtureApp({
    clock: harness.clock,
    resolveActor: harness.resolve,
    onDenied: options.onDenied?.(real) ?? real,
    rules: {
      read: { capacity: 10_000, refillIntervalMs: 1 },
      write: { capacity: 10_000, refillIntervalMs: 1 },
    },
    routes: ({ calls, csrf, publicOrigin }) => [
      ...fixtureRoutes(calls, csrf, { withCsrf: true, publicOrigin }).filter(
        (route) => route.id === 'fixture.csrf',
      ),
      ...routesOf((id) => {
        calls.byRoute.set(id, (calls.byRoute.get(id) ?? 0) + 1);
      }),
    ],
  });
  return {
    harness,
    callers,
    app,
    audit: () =>
      harness.db.sqlite
        .prepare("SELECT * FROM audit_log WHERE outcome = 'denied' ORDER BY seq")
        .all() as AuditRow[],
  };
}

function headersOf(sessions: readonly SeededSession[]): Record<string, string> {
  return sessions.length === 0
    ? {}
    : { cookie: sessions.map((session) => session.headers.cookie).join('; ') };
}

function actorOf(caller: CallerName): { kind: string; id: string } {
  switch (caller) {
    case 'nobody':
    case 'expired':
      return { kind: 'anonymous', id: 'anonymous' };
    case 'norole':
      return { kind: 'user', id: guid(12) };
    case 'reader':
      return { kind: 'user', id: guid(11) };
    case 'owner':
    case 'ownerstale':
      return { kind: 'user', id: guid(10) };
    case 'setup':
      return { kind: 'setup', id: 'setup' };
    case 'breakglass':
      return { kind: 'break_glass', id: 'break-glass' };
  }
}

/** Is a denial of this caller written to the audit table? */
function isAudited(verb: 'read' | 'make', caller: CallerName): boolean {
  if (verb === 'make') return true;
  return caller !== 'nobody' && caller !== 'expired';
}

describe('the table walked: answers and audit entries (FR-B-414, FR-B-602)', () => {
  const cases = ACCESS_CASES.flatMap(({ name }) =>
    CALLERS.flatMap((caller) =>
      (['read', 'make'] as const).map((verb) => ({ name, caller, verb })),
    ),
  );

  it.each(cases)('$name $verb as $caller', async ({ name, caller, verb }) => {
    const { app, callers, audit } = await rig();
    const id = `deny.${name}.${verb}`;
    const expected = EXPECTED[name]?.[caller] as Expected;
    const client = app.clientFor({ headers: headersOf(callers[caller]) });
    const path = app.http.table.routes.find((route) => route.id === id)?.paths[0] ?? '';

    const response =
      verb === 'read' ? await client.get(path) : await client.post(path, { json: {} });
    expect(response.status).toBe(expected.status);
    if (expected.status === 200) {
      expect(app.calls.of(id)).toBe(1);
      expect(audit()).toEqual([]);
      return;
    }
    expect(app.calls.of(id)).toBe(0);
    const body = await readJson<Record<string, unknown>>(response);
    expect(body.code).toBe(expected.code);
    // No tenant id, step state, log line or permission name in the body of a refusal.
    expect(Object.keys(body).sort()).toEqual(
      ['code', 'detail', 'requestId', 'status', 'title', 'type'].sort(),
    );

    const rows = audit();
    if (!isAudited(verb, caller)) {
      expect(rows).toEqual([]);
      return;
    }
    expect(rows).toHaveLength(1);
    const row = rows[0] as AuditRow;
    expect(row).toMatchObject({
      action: id,
      outcome: 'denied',
      reason_code: expected.reason,
      actor_kind: actorOf(caller).kind,
      actor_id: actorOf(caller).id,
      client_ip: '127.0.0.1',
      request_id: body.requestId,
    });
    expect(REASONS).toContain(row.reason_code);
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    expect(detail.method).toBe(verb === 'read' ? 'GET' : 'POST');
    expect(detail.route).toBe(path);
  });
});

describe('the headers of a 401 (FR-B-414)', () => {
  it('carries the challenge on both 401 codes, and the stale session cookie is cleared only for session_expired', async () => {
    const { app, callers } = await rig();
    const nobody = await app.clientFor({}).get('/api/v1/deny/permission/read');
    expect(nobody.status).toBe(401);
    expect(nobody.headers.get('www-authenticate')).toBe('Cookie realm="m365portal"');
    expect(nobody.headers.get('set-cookie')).toBeNull();

    const expired = await app
      .clientFor({ headers: headersOf(callers.expired) })
      .get('/api/v1/deny/permission/read');
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toBe('Cookie realm="m365portal"');
    const cleared = expired.headers.get('set-cookie') ?? '';
    expect(cleared).toMatch(/^m365portal_session=;/);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('SameSite=Strict');
  });

  it('never clears a cookie for an unknown, malformed or duplicated setup cookie', async () => {
    const { app } = await rig();
    for (const cookie of [
      `m365portal_setup=${'z'.repeat(43)}`,
      'm365portal_setup=short',
      `m365portal_setup=${'z'.repeat(43)}; m365portal_setup=${'y'.repeat(43)}`,
    ]) {
      const response = await app.clientFor({ headers: { cookie } }).get('/api/v1/setup/setup/read');
      expect(response.status).toBe(401);
      expect((await readJson<{ code: string }>(response)).code).toBe('unauthenticated');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('carries no challenge on a 403', async () => {
    const { app, callers } = await rig();
    const response = await app
      .clientFor({ headers: headersOf(callers.reader) })
      .get('/api/v1/deny/permission/read');
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });
});

describe('the step-up window (FR-B-411)', () => {
  it('is 403 step_up_required one millisecond after the window and 200 at its last millisecond', async () => {
    const { app, harness } = await rig();
    const owner = harness.seedSession({ oid: guid(10), stepUpAgoMs: 0 });
    const client = app.clientFor({ headers: owner.headers });
    harness.clock.advance(10 * 60_000 - 1);
    expect((await client.get('/api/v1/deny/stepup/read')).status).toBe(200);
    harness.clock.advance(1);
    const stale = await client.get('/api/v1/deny/stepup/read');
    expect(stale.status).toBe(403);
    expect((await readJson<{ code: string }>(stale)).code).toBe('step_up_required');
  });
});

describe('the audit comes before the answer, and a failed append is a 503 (PD-21, FR-B-602)', () => {
  it('writes the entry before the answer exists', async () => {
    const order: string[] = [];
    const { app, callers } = await rig({
      onDenied: (real) => async (c, denial) => {
        await real(c, denial);
        order.push('audited');
      },
    });
    const response = await app
      .clientFor({ headers: headersOf(callers.reader) })
      .post('/api/v1/deny/permission/make', { json: {} });
    order.push(`answered ${String(response.status)}`);
    expect(order).toEqual(['audited', 'answered 403']);
  });

  it('answers 503 storage_unavailable instead of the denial when the append fails (write)', async () => {
    const { app, callers, audit } = await rig({
      onDenied: () => () => {
        throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
      },
    });
    const response = await app
      .clientFor({ headers: headersOf(callers.reader) })
      .post('/api/v1/deny/permission/make', { json: {} });
    expect(response.status).toBe(503);
    expect((await readJson<{ code: string }>(response)).code).toBe('storage_unavailable');
    expect(audit()).toEqual([]);
  });

  it('answers 503 instead of the denial when the append fails (read of a signed-in caller)', async () => {
    const { app, callers } = await rig({
      onDenied: () => () => {
        throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
      },
    });
    const response = await app
      .clientFor({ headers: headersOf(callers.reader) })
      .get('/api/v1/deny/permission/read');
    expect(response.status).toBe(503);
  });

  it('keeps the answer 401 for an anonymous read: nothing is appended, so nothing can fail', async () => {
    const { app } = await rig({
      onDenied: () => () => {
        throw new Error('must not be called');
      },
    });
    expect((await app.clientFor({}).get('/api/v1/deny/permission/read')).status).toBe(401);
  });

  it('does not audit a 429, and leaves a chain that verifies', async () => {
    const harness = await createPolicyHarness();
    const real = createDenialAudit({
      database: () => harness.db,
      now: () => harness.clock.nowMs(),
    });
    const app = await createFixtureApp({
      clock: harness.clock,
      resolveActor: harness.resolve,
      onDenied: real,
      rules: { write: { capacity: 1, refillIntervalMs: 3_600_000 } },
      routes: ({ calls, csrf, publicOrigin }) => [
        ...fixtureRoutes(calls, csrf, { withCsrf: true, publicOrigin }).filter(
          (route) => route.id === 'fixture.csrf',
        ),
        ...routesOf(() => undefined),
      ],
    });
    const client = app.clientFor({});
    const first = await client.post('/api/v1/deny/permission/make', { json: {} });
    const second = await client.post('/api/v1/deny/permission/make', { json: {} });
    expect([first.status, second.status]).toEqual([401, 429]);
    const rows = harness.db.sqlite
      .prepare("SELECT count(*) AS n FROM audit_log WHERE outcome = 'denied'")
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    expect(verifyChain(harness.db.sqlite)).toMatchObject({ ok: true });
  });
});

describe('the guard behind the walk fails a pipeline that audits wrongly (tasks.md section 0.3)', () => {
  /** Run the walk's essentials against a hook; throws on the first rule the hook breaks. */
  async function assertAuditRules(wrap: (real: OnRouteDenied) => OnRouteDenied): Promise<void> {
    const { app, callers, audit } = await rig({ onDenied: wrap });
    const reader = app.clientFor({ headers: headersOf(callers.reader) });
    const nobody = app.clientFor({});
    await reader.post('/api/v1/deny/permission/make', { json: {} });
    if (audit().length !== 1)
      throw new Error('a denied write by a signed-in user was not audited once');
    await nobody.post('/api/v1/deny/permission/make', { json: {} });
    if (audit().length !== 2) throw new Error('a denied anonymous write was not audited');
    await nobody.get('/api/v1/deny/permission/read');
    if (audit().length !== 2) throw new Error('an anonymous read was audited');
    await reader.get('/api/v1/deny/permission/read');
    if (audit().length !== 3) throw new Error('a denied read of a signed-in user was not audited');
  }

  it('passes for the real hook', async () => {
    await expect(assertAuditRules((real) => real)).resolves.toBeUndefined();
  });

  it('fails for a hook that audits nothing', async () => {
    await expectGuardFails(assertAuditRules, () => () => undefined, {
      reason: 'was not audited once',
    });
  });

  it('fails for a hook that skips anonymous callers', async () => {
    await expectGuardFails(
      assertAuditRules,
      (real) => async (c, denial) => {
        if (c.get('actor').kind !== 'anonymous') await real(c, denial);
      },
      { reason: 'anonymous write was not audited' },
    );
  });
});
