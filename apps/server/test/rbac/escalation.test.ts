// T-B-249, FR-B-509, SC-B-006, US-B6 item 2: nobody creates, or removes, an assignment they could not
// grant themselves. The decision is `canGrant` over the grants of the actor; a refusal is the
// `PolicyDenied` `escalation_denied` that the route wrapper audits as a denial and answers with 403.
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { RolePermission } from '@m365portal/shared/rbac/roles';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { PolicyDenied } from '../../src/policy/denied.js';
import { assign } from '../helpers/rbac-db.js';
import { serviceFixture, type ServiceFixture } from './service-fixture.js';

const group = (value: string): ScopeItem => ({
  target: 'group',
  match: { by: 'prefix', attr: 'displayName', value },
});
const department = (value: string): ScopeItem => ({
  target: 'user',
  match: { by: 'department', value },
});

interface Row {
  readonly label: string;
  readonly actor: (f: ServiceFixture) => ReturnType<ServiceFixture['actorWithRoles']>;
  readonly role: string;
  readonly scope: readonly ScopeItem[];
  readonly allowed: boolean;
}

const full = (permission: RolePermission['permission']): RolePermission => ({
  permission,
  qualifier: 'full',
});

function prepare(f: ServiceFixture): void {
  f.customRole('manager', [full('rbac:manage')]);
  f.customRole('basiconly', [{ permission: 'users:read', qualifier: 'basic' }]);
  f.customRole('fullonly', [full('users:read')]);
  f.customRole('auditor', [full('audit:read')]);
}

const ROWS: readonly Row[] = [
  {
    label: 'owner assigns owner',
    actor: (f) => f.actorWithRoles('owner'),
    role: 'owner',
    scope: [],
    allowed: true,
  },
  {
    label: 'owner assigns admin',
    actor: (f) => f.actorWithRoles('owner'),
    role: 'admin',
    scope: [],
    allowed: true,
  },
  {
    label: 'admin assigns admin',
    actor: (f) => f.actorWithRoles('admin'),
    role: 'admin',
    scope: [],
    allowed: true,
  },
  {
    label: 'admin assigns operator',
    actor: (f) => f.actorWithRoles('admin'),
    role: 'operator',
    scope: [],
    allowed: true,
  },
  {
    label: 'admin assigns owner',
    actor: (f) => f.actorWithRoles('admin'),
    role: 'owner',
    scope: [],
    allowed: false,
  },
  {
    label: 'operator assigns reader',
    actor: (f) => f.actorWithRoles('operator'),
    role: 'reader',
    scope: [],
    allowed: true,
  },
  {
    label: 'operator assigns admin',
    actor: (f) => f.actorWithRoles('operator'),
    role: 'admin',
    scope: [],
    allowed: false,
  },
  {
    label: 'helpdesk assigns operator',
    actor: (f) => f.actorWithRoles('helpdesk'),
    role: 'operator',
    scope: [],
    allowed: false,
  },
  {
    label: 'custom rbac:manage assigns operator',
    actor: (f) => f.actorWithRoles('manager'),
    role: 'operator',
    scope: [],
    allowed: false,
  },
  {
    label: 'custom rbac:manage assigns reader',
    actor: (f) => f.actorWithRoles('manager'),
    role: 'reader',
    scope: [],
    allowed: false,
  },
  {
    label: 'custom rbac:manage assigns itself',
    actor: (f) => f.actorWithRoles('manager'),
    role: 'manager',
    scope: [],
    allowed: true,
  },
  {
    label: 'scoped helpdesk inside its scope',
    actor: (f) => f.actorWithScopedRole('helpdesk', [group('Sales')]),
    role: 'reader',
    scope: [group('SalesEU')],
    allowed: true,
  },
  {
    label: 'scoped helpdesk outside its scope',
    actor: (f) => f.actorWithScopedRole('helpdesk', [group('Sales')]),
    role: 'reader',
    scope: [group('HR')],
    allowed: false,
  },
  {
    label: 'scoped helpdesk, wider prefix',
    actor: (f) => f.actorWithScopedRole('helpdesk', [group('Sales')]),
    role: 'reader',
    scope: [group('Sal')],
    allowed: false,
  },
  {
    label: 'scoped helpdesk, no scope at all',
    actor: (f) => f.actorWithScopedRole('helpdesk', [group('Sales')]),
    role: 'reader',
    scope: [],
    allowed: false,
  },
  {
    label: 'basic actor assigns a basic role',
    actor: (f) => f.actorWithRoles('basiconly'),
    role: 'basiconly',
    scope: [],
    allowed: true,
  },
  {
    label: 'basic actor assigns a full role',
    actor: (f) => f.actorWithRoles('basiconly'),
    role: 'fullonly',
    scope: [],
    allowed: false,
  },
  {
    label: 'full actor assigns a basic role',
    actor: (f) => f.actorWithRoles('fullonly'),
    role: 'basiconly',
    scope: [],
    allowed: true,
  },
  {
    label: 'scoped admin assigns a scoped helpdesk inside',
    actor: (f) => f.actorWithScopedRole('admin', [department('Finance')]),
    role: 'helpdesk',
    scope: [department('Finance')],
    allowed: true,
  },
  {
    label: 'scoped admin assigns a global-only role',
    actor: (f) => f.actorWithScopedRole('admin', [department('Finance')]),
    role: 'auditor',
    scope: [],
    allowed: false,
  },
  {
    label: 'scoped admin assigns admin',
    actor: (f) => f.actorWithScopedRole('admin', [department('Finance')]),
    role: 'admin',
    scope: [],
    allowed: false,
  },
];

async function outcome(
  row: Row,
  make: () => Promise<ServiceFixture> = serviceFixture,
): Promise<'allowed' | 'escalation_denied'> {
  const f = await make();
  prepare(f);
  const actor = row.actor(f);
  const target = f.user('bob@contoso-fake.example');
  try {
    await f.service.create(
      actor,
      {
        principalType: 'user',
        principalId: target.id,
        role: row.role,
        ...(row.scope.length === 0 ? {} : { scope: row.scope }),
      },
      f.audit(),
    );
    return 'allowed';
  } catch (error) {
    if ((error as { reason?: unknown }).reason === 'escalation_denied') return 'escalation_denied';
    throw error;
  }
}

describe('creating an assignment requires canGrant (FR-B-509)', () => {
  it.each(ROWS)('$label', async (row) => {
    expect(await outcome(row)).toBe(row.allowed ? 'allowed' : 'escalation_denied');
  });

  it('a refusal changes nothing and writes no success entry', async () => {
    const f = await serviceFixture();
    const helpdesk = f.actorWithRoles('helpdesk');
    const target = f.user('bob@contoso-fake.example');
    await expect(
      f.service.create(
        helpdesk,
        { principalType: 'user', principalId: target.id, role: 'admin' },
        f.audit(),
      ),
    ).rejects.toBeInstanceOf(PolicyDenied);
    expect(
      f.db.sqlite
        .prepare('SELECT count(*) AS n FROM rbac_assignment WHERE principal_id = ?')
        .get(target.id),
    ).toEqual({ n: 0 });
    expect(f.auditRows()).toEqual([]);
  });

  it('negative: a canGrant whose covers lets any prefix cover any other is caught by the matrix', async () => {
    vi.resetModules();
    vi.doMock('../../src/policy/can-grant.js', async () => {
      const { canGrantCore } = await import('@m365portal/shared/rbac/covers');
      return {
        // "Any two prefix items cover": every filtered grant of the actor behaves as if unscoped.
        canGrant: (
          actor: { grants: readonly Grant[] },
          role: readonly RolePermission[],
          scope: readonly ScopeItem[],
        ): boolean =>
          canGrantCore(
            actor.grants.map((grant) => ({ ...grant, scope: 'all' as const })),
            role,
            scope,
          ),
      };
    });
    try {
      const lenient = await import('./service-fixture.js');
      const row = ROWS.find((candidate) => candidate.label === 'scoped helpdesk outside its scope');
      expect(row?.allowed).toBe(false);
      await expectGuardFails(async () => {
        expect(await outcome(row!, lenient.serviceFixture)).toBe('escalation_denied');
      }, undefined);
    } finally {
      vi.doUnmock('../../src/policy/can-grant.js');
      vi.resetModules();
    }
  });
});

describe('removing an assignment requires canGrant of what is removed ("nobody removes what they could not grant")', () => {
  it('an operator cannot remove an admin assignment, an owner can', async () => {
    const f = await serviceFixture();
    prepare(f);
    const operator = f.actorWithRoles('operator');
    const owner = f.actorWithRoles('owner');
    const victim = f.user('victim@contoso-fake.example');
    const id = assign(f.db, { principalId: victim.id, role: 'admin' });
    await expect(f.service.remove(operator, id, f.audit())).rejects.toBeInstanceOf(PolicyDenied);
    expect(
      f.db.sqlite.prepare('SELECT count(*) AS n FROM rbac_assignment WHERE id = ?').get(id),
    ).toEqual({ n: 1 });
    const removed = await f.service.remove(owner, id, f.audit());
    expect(removed.roleKey).toBe('admin');
    expect(
      f.db.sqlite.prepare('SELECT count(*) AS n FROM rbac_assignment WHERE id = ?').get(id),
    ).toEqual({ n: 0 });
  });

  it('removes with an audit entry rbac.assignment.delete, reason revoked', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const victim = f.user('victim@contoso-fake.example');
    const id = assign(f.db, { principalId: victim.id, role: 'reader' });
    await f.service.remove(owner, id, f.audit());
    const rows = f.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'rbac.assignment.delete', outcome: 'success' });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
      principalType: 'user',
      principalId: victim.id,
      role: 'reader',
      reason: 'revoked',
    });
  });

  it('an unknown id is not_found', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    await expect(
      f.service.remove(owner, '00000000-0000-4000-8000-0000000000bb', f.audit()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
