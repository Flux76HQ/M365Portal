// T-B-248, FR-B-508, FR-B-515: the validation order of contract P29, in the service. Zod (strict) is the
// route's job; here: the role exists and is assignable -> `owner` takes no scope and no expiry -> a
// group never gets a role with `rbac:manage` or `settings:connection` -> every scope target is used by
// the role and global-only roles take no scope -> `expiresAt` in the future and at most 730 days ahead
// -> early `canGrant` (403 before any Graph call) -> the principal exists (422 / 503) -> BEGIN
// IMMEDIATE (reload the actor's grants, `canGrant` again, limits, duplicate, insert, audit).
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { describe, expect, it } from 'vitest';
import { ProblemError } from '../../src/http/problem.js';
import { GraphThrottledError, GraphTransientError } from '../../src/ports/errors.js';
import { PolicyDenied } from '../../src/policy/denied.js';
import { insertRole } from '../../src/rbac/repository.js';
import { withTransaction } from '../../src/db/index.js';
import { serviceFixture, type ServiceFixture } from './service-fixture.js';

const DEPARTMENT: ScopeItem = { target: 'user', match: { by: 'department', value: 'Finance' } };
const PREFIX: ScopeItem = {
  target: 'group',
  match: { by: 'prefix', attr: 'displayName', value: 'Sales' },
};

async function failureOf(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

function problemOf(error: unknown): { code: string; errors: string[] } {
  expect(error).toBeInstanceOf(ProblemError);
  const problem = error as ProblemError;
  return { code: problem.code, errors: (problem.details.errors ?? []).map((entry) => entry.code) };
}

async function ownerWorld(): Promise<
  ServiceFixture & { owner: ReturnType<ServiceFixture['actorWithRoles']> }
> {
  const f = await serviceFixture();
  return { ...f, owner: f.actorWithRoles('owner') };
}

describe('the role (P29 step 2)', () => {
  it('refuses an unknown role, a template key and a malformed key as assignment_invalid', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    for (const role of ['nobody', 'board', 'Owner']) {
      const error = await failureOf(() =>
        f.service.create(
          f.owner,
          { principalType: 'user', principalId: target.id, role },
          f.audit(),
        ),
      );
      expect(problemOf(error), role).toEqual({
        code: 'assignment_invalid',
        errors: ['role_unknown'],
      });
    }
    expect(f.fake.calls).toHaveLength(0);
  });

  it('refuses a role that is not assignable', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    withTransaction(f.db, (tx) =>
      insertRole(tx, {
        key: 'sealed',
        createdAt: f.clock.iso(),
        grants: [{ permission: 'users:read', qualifier: 'full' }],
      }),
    );
    f.db.sqlite.prepare("UPDATE rbac_role SET assignable = 0 WHERE key = 'sealed'").run();
    const error = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'sealed' },
        f.audit(),
      ),
    );
    expect(problemOf(error)).toEqual({
      code: 'assignment_invalid',
      errors: ['role_not_assignable'],
    });
  });
});

describe('owner takes no scope and no expiry (step 3)', () => {
  it('refuses both, with their own codes', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    const scoped = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'owner', scope: [DEPARTMENT] },
        f.audit(),
      ),
    );
    expect(problemOf(scoped)).toEqual({ code: 'assignment_invalid', errors: ['owner_scope'] });
    const expiring = await failureOf(() =>
      f.service.create(
        f.owner,
        {
          principalType: 'user',
          principalId: target.id,
          role: 'owner',
          expiresAt: '2026-11-10T12:00:00.000Z',
        },
        f.audit(),
      ),
    );
    expect(problemOf(expiring)).toEqual({ code: 'assignment_invalid', errors: ['owner_expiry'] });
  });
});

describe('the scope (step 5)', () => {
  it('refuses a scope target that none of the role permissions uses (a scope that changes nothing)', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    // `reader` has users, groups, lists and contacts; a custom role with only users:read does not use `group`.
    withTransaction(f.db, (tx) =>
      insertRole(tx, {
        key: 'usersonly',
        createdAt: f.clock.iso(),
        grants: [{ permission: 'users:read', qualifier: 'full' }],
      }),
    );
    const error = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'usersonly', scope: [PREFIX] },
        f.audit(),
      ),
    );
    expect(problemOf(error)).toEqual({
      code: 'assignment_invalid',
      errors: ['scope_target_unused'],
    });
  });

  it('refuses any scope on a role that holds only global-only permissions', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    withTransaction(f.db, (tx) =>
      insertRole(tx, {
        key: 'auditor',
        createdAt: f.clock.iso(),
        grants: [{ permission: 'audit:read', qualifier: 'full' }],
      }),
    );
    const error = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'auditor', scope: [DEPARTMENT] },
        f.audit(),
      ),
    );
    expect(problemOf(error)).toEqual({
      code: 'assignment_invalid',
      errors: ['scope_target_unused'],
    });
  });

  it('refuses an item the scope matrix does not allow, and more than 50 items', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    const bad = await failureOf(() =>
      f.service.create(
        f.owner,
        {
          principalType: 'user',
          principalId: target.id,
          role: 'reader',
          scope: [{ target: 'user', match: { by: 'prefix', attr: 'alias', value: 'x' } }],
        },
        f.audit(),
      ),
    );
    expect(problemOf(bad).code).toBe('assignment_invalid');
    const many = Array.from({ length: 51 }, (_, index) => ({
      target: 'user' as const,
      match: { by: 'prefix' as const, attr: 'displayName' as const, value: `a${String(index)}` },
    }));
    const tooMany = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'reader', scope: many },
        f.audit(),
      ),
    );
    expect(problemOf(tooMany)).toEqual({
      code: 'assignment_invalid',
      errors: ['scope_items_limit'],
    });
  });

  it('stores the scope in its normalised form (case, Unicode, trailing space)', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    const created = await f.service.create(
      f.owner,
      {
        principalType: 'user',
        principalId: target.id,
        role: 'reader',
        scope: [{ target: 'user', match: { by: 'department', value: '  Finance ' } }],
      },
      f.audit(),
    );
    expect(created.scope).toEqual([DEPARTMENT]);
  });
});

describe('the expiry (step 6)', () => {
  it('must lie in the future and at most 730 days ahead', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    const now = f.clock.nowMs();
    const at = (ms: number): string => new Date(now + ms).toISOString();
    const day = 86_400_000;
    for (const [expiresAt, label] of [
      [at(0), 'now'],
      [at(-1000), 'past'],
      [at(730 * day + 1), 'too far'],
    ] as const) {
      const error = await failureOf(() =>
        f.service.create(
          f.owner,
          { principalType: 'user', principalId: target.id, role: 'reader', expiresAt },
          f.audit(),
        ),
      );
      expect(problemOf(error), label).toEqual({
        code: 'assignment_invalid',
        errors: ['expiry_invalid'],
      });
    }
    const exactly = await f.service.create(
      f.owner,
      { principalType: 'user', principalId: target.id, role: 'reader', expiresAt: at(730 * day) },
      f.audit(),
    );
    expect(exactly.expiresAt).toBe(at(730 * day));
  });
});

describe('escalation comes before any Graph traffic (step 7)', () => {
  it('answers escalation_denied without asking Graph', async () => {
    const f = await serviceFixture();
    const helpdesk = f.actorWithRoles('helpdesk');
    const target = f.user('bob@contoso-fake.example');
    const error = await failureOf(() =>
      f.service.create(
        helpdesk,
        { principalType: 'user', principalId: target.id, role: 'operator' },
        f.audit(),
      ),
    );
    expect(error).toBeInstanceOf(PolicyDenied);
    expect((error as PolicyDenied).reason).toBe('escalation_denied');
    expect(f.fake.calls).toHaveLength(0);
    expect(f.auditRows()).toEqual([]);
  });
});

describe('the principal exists (step 8)', () => {
  it('is 422 principal_unknown for a user or a group Graph does not know', async () => {
    const f = await ownerWorld();
    const unknown = '00000000-0000-4000-8000-0000000000aa';
    const user = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: unknown, role: 'reader' },
        f.audit(),
      ),
    );
    expect(problemOf(user).code).toBe('principal_unknown');
    const group = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'group', principalId: unknown, role: 'reader' },
        f.audit(),
      ),
    );
    expect(problemOf(group).code).toBe('principal_unknown');
    expect(f.fake.callsTo('getUser')).toHaveLength(1);
    expect(f.fake.callsTo('getGroup')).toHaveLength(1);
  });

  it('is 503 graph_unavailable when Graph is down, 503 graph_throttled when it asks for a long wait', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: 'getUser' });
    const down = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'reader' },
        f.audit(),
      ),
    );
    expect(problemOf(down).code).toBe('graph_unavailable');
    f.fake.failNext(new GraphThrottledError({ retryAfterMs: 120_000 }), { method: 'getUser' });
    const throttled = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'reader' },
        f.audit(),
      ),
    );
    expect(problemOf(throttled).code).toBe('graph_throttled');
    expect(f.auditRows()).toEqual([]);
  });
});

describe('the write (step 9)', () => {
  it('inserts the assignment and the audit entry together, with the details of the contract', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    const expiresAt = new Date(f.clock.nowMs() + 86_400_000).toISOString();
    const created = await f.service.create(
      f.owner,
      {
        principalType: 'user',
        principalId: target.id,
        role: 'reader',
        scope: [DEPARTMENT],
        expiresAt,
      },
      f.audit(),
    );
    expect(created).toMatchObject({
      principalType: 'user',
      principalId: target.id,
      roleKey: 'reader',
      source: 'api',
      createdBy: f.owner.id,
      expiresAt,
      scope: [DEPARTMENT],
    });
    const rows = f.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'rbac.assignment.create', outcome: 'success' });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
      principalType: 'user',
      principalId: target.id,
      role: 'reader',
      scopeTargets: ['user'],
      scopeItems: 1,
      expiresAt,
      source: 'api',
    });
  });

  it('a duplicate (principal, role, scope set) is 409 assignment_exists, whatever the order of the scope', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    const input = {
      principalType: 'user' as const,
      principalId: target.id,
      role: 'reader',
      scope: [
        DEPARTMENT,
        {
          target: 'user' as const,
          match: { by: 'prefix' as const, attr: 'mail' as const, value: 'a' },
        },
      ],
    };
    await f.service.create(f.owner, input, f.audit());
    const error = await failureOf(() =>
      f.service.create(f.owner, { ...input, scope: [...input.scope].reverse() }, f.audit()),
    );
    expect(problemOf(error).code).toBe('assignment_exists');
    // The same role without a scope is another assignment.
    await f.service.create(
      f.owner,
      { principalType: 'user', principalId: target.id, role: 'reader' },
      f.audit(),
    );
  });

  it('reloads the grants of the actor inside the write: a revocation between request and write wins', async () => {
    const f = await serviceFixture();
    const admin = f.actorWithRoles('admin'); // the grants the request carried
    const target = f.user('bob@contoso-fake.example');
    // The role is taken away after the request was authorised and before the write.
    f.db.sqlite.prepare('DELETE FROM rbac_assignment WHERE principal_id = ?').run(admin.id);
    const error = await failureOf(() =>
      f.service.create(
        { ...admin, grants: admin.grants },
        { principalType: 'user', principalId: target.id, role: 'reader' },
        f.audit(),
      ),
    );
    expect(error).toBeInstanceOf(PolicyDenied);
    expect(
      f.db.sqlite
        .prepare('SELECT count(*) AS n FROM rbac_assignment WHERE principal_id = ?')
        .get(target.id),
    ).toEqual({ n: 0 });
  });

  it('writes nothing when the audit append fails (one transaction)', async () => {
    const f = await ownerWorld();
    const target = f.user('bob@contoso-fake.example');
    f.db.sqlite.exec(
      "CREATE TRIGGER audit_fault BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'fault'); END",
    );
    const error = await failureOf(() =>
      f.service.create(
        f.owner,
        { principalType: 'user', principalId: target.id, role: 'reader' },
        f.audit(),
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(
      f.db.sqlite
        .prepare('SELECT count(*) AS n FROM rbac_assignment WHERE principal_id = ?')
        .get(target.id),
    ).toEqual({ n: 0 });
  });

  it('ids come from the injected randomness: two services with the same seed make the same ids', async () => {
    const a = await ownerWorld();
    const b = await ownerWorld();
    const ta = a.user('bob@contoso-fake.example');
    const tb = b.user('bob@contoso-fake.example');
    const one = await a.service.create(
      a.owner,
      { principalType: 'user', principalId: ta.id, role: 'reader' },
      a.audit(),
    );
    const two = await b.service.create(
      b.owner,
      { principalType: 'user', principalId: tb.id, role: 'reader' },
      b.audit(),
    );
    expect(one.id).toBe(two.id);
    expect(one.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
