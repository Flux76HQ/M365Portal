// T-B-236, contracts sections 7 and 12.1, CB14: the RBAC wire schemas. Each is checked with the values
// it must accept and, as important, the values it must refuse. Rules of the folder: Zod only, no
// transform, `.meta({ id })` with the constant name minus `Schema`, request schemas strict.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIMITS } from '../src/limits.js';
import { PERMISSIONS } from '../src/permissions.js';
import { RESOURCE_TYPES } from '../src/rbac/resources.js';
import { BUILTIN_ROLES, TEMPLATES } from '../src/rbac/roles.js';
import { SCOPE_MATRIX } from '../src/rbac/scope.js';
import * as rbac from '../src/schemas/rbac.js';

const {
  AssignmentListQuerySchema,
  AssignmentListResponseSchema,
  AssignmentSchema,
  CreateAssignmentRequestSchema,
  EffectiveQuerySchema,
  EffectiveResponseSchema,
  GrantSchema,
  RestoreOwnerRequestSchema,
  RoleListResponseSchema,
  RoleSchema,
  RoleTemplateSchema,
  ScopeItemSchema,
} = rbac;

const GUID = '8e0c2b8e-0000-4000-8000-0000000000aa';
const GUID_2 = '8e0c2b8e-0000-4000-8000-0000000000bb';
const TS = '2026-10-11T12:00:00.000Z';

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const prefixItem = {
  target: 'group',
  match: { by: 'prefix', attr: 'displayName', value: 'Sales' },
};
const assignment = {
  id: GUID,
  principalType: 'user',
  principalId: GUID_2,
  role: { key: 'helpdesk', builtin: true },
  scope: [prefixItem],
  expiresAt: TS,
  source: 'api',
  createdAt: TS,
  createdBy: GUID,
};

describe('component ids', () => {
  const ALL = { ...rbac } as Record<string, unknown>;
  const schemas = Object.entries(ALL).filter(([name]) => name.endsWith('Schema'));

  it('exports every schema of the contract', () => {
    for (const name of [
      'ScopeItemSchema',
      'GrantSchema',
      'AssignmentSchema',
      'RoleSchema',
      'RoleTemplateSchema',
      'RoleListResponseSchema',
      'AssignmentListQuerySchema',
      'AssignmentListResponseSchema',
      'CreateAssignmentRequestSchema',
      'EffectiveQuerySchema',
      'EffectiveResponseSchema',
      'RestoreOwnerRequestSchema',
    ])
      expect(Object.keys(ALL), name).toContain(name);
  });

  it.each(schemas)(
    '%s carries an OpenAPI component id: its name without the suffix',
    (name, schema) => {
      expect((schema as z.ZodType).meta()?.id).toBe(name.replace(/Schema$/, ''));
    },
  );

  it.each(schemas)(
    '%s can be written as JSON Schema (no transform, no custom type)',
    (_name, schema) => {
      expect(() => z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'throw' })).not.toThrow();
    },
  );

  it('has unique component ids', () => {
    const ids = schemas.map(([, schema]) => (schema as z.ZodType).meta()?.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ScopeItemSchema (validated against SCOPE_MATRIX)', () => {
  const valid: unknown[] = [];
  for (const target of RESOURCE_TYPES) {
    const row = SCOPE_MATRIX[target];
    if (row.id) valid.push({ target, match: { by: 'id', id: GUID } });
    for (const attr of row.prefix)
      valid.push({ target, match: { by: 'prefix', attr, value: 'Sales' } });
    if (row.department) valid.push({ target, match: { by: 'department', value: 'Finance' } });
  }

  it.each(valid)('accepts %j and returns it unchanged (no transform)', (item) => {
    const result = ScopeItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(item);
  });

  it('accepts exactly the combinations of the matrix, for all 4 x 7 combinations', () => {
    let accepted = 0;
    for (const target of RESOURCE_TYPES) {
      const options: [unknown, boolean][] = [
        [{ by: 'id', id: GUID }, SCOPE_MATRIX[target].id],
        [{ by: 'department', value: 'x' }, SCOPE_MATRIX[target].department],
        ...(['displayName', 'alias', 'mail', 'department'] as const).map(
          (attr): [unknown, boolean] => [
            { by: 'prefix', attr, value: 'x' },
            (SCOPE_MATRIX[target].prefix as readonly string[]).includes(attr),
          ],
        ),
      ];
      for (const [match, allowed] of options) {
        expect(
          accepts(ScopeItemSchema, { target, match }),
          `${target} ${JSON.stringify(match)}`,
        ).toBe(allowed);
        if (allowed) accepted += 1;
      }
    }
    expect(accepted).toBe(16);
  });

  it.each([
    ['an unknown target', { target: 'tenant', match: { by: 'department', value: 'x' } }],
    ['an unknown match kind', { target: 'user', match: { by: 'suffix', value: 'x' } }],
    ['an empty value', { target: 'user', match: { by: 'department', value: '' } }],
    ['a value of only spaces', { target: 'user', match: { by: 'department', value: '   ' } }],
    [
      'a value of 65 code points',
      { target: 'user', match: { by: 'department', value: 'a'.repeat(65) } },
    ],
    ['a control character', { target: 'user', match: { by: 'department', value: 'a\u{0}b' } }],
    ['a bidi override', { target: 'user', match: { by: 'department', value: 'a\u{202e}b' } }],
    ['an upper-case GUID', { target: 'group', match: { by: 'id', id: GUID.toUpperCase() } }],
    ['an id that is not a GUID', { target: 'group', match: { by: 'id', id: 'abc' } }],
    ['an id with a value', { target: 'group', match: { by: 'id', id: GUID, value: 'x' } }],
    ['an extra key on the item', { ...prefixItem, extra: true }],
    ['an extra key on the match', { target: 'group', match: { ...prefixItem.match, extra: 1 } }],
    ['a missing match', { target: 'group' }],
    ['null', null],
    ['a string', 'group'],
  ])('rejects %s', (_label, value) => {
    expect(accepts(ScopeItemSchema, value)).toBe(false);
  });
});

describe('GrantSchema', () => {
  it('accepts all and a list of items', () => {
    expect(
      accepts(GrantSchema, { permission: 'groups:read', qualifier: 'full', scope: 'all' }),
    ).toBe(true);
    expect(
      accepts(GrantSchema, { permission: 'groups:read', qualifier: 'full', scope: [prefixItem] }),
    ).toBe(true);
    expect(
      accepts(GrantSchema, { permission: 'users:read', qualifier: 'basic', scope: 'all' }),
    ).toBe(true);
  });

  it.each([
    ['the scope in capitals', { permission: 'groups:read', qualifier: 'full', scope: 'ALL' }],
    ['an empty list of items', { permission: 'groups:read', qualifier: 'full', scope: [] }],
    ['a missing scope', { permission: 'groups:read', qualifier: 'full' }],
    [
      'a permission outside the catalogue',
      { permission: 'users:write', qualifier: 'full', scope: 'all' },
    ],
    [
      'a qualifier outside the two',
      { permission: 'users:read', qualifier: 'partial', scope: 'all' },
    ],
    [
      'basic on a permission that has no basic form',
      { permission: 'groups:read', qualifier: 'basic', scope: 'all' },
    ],
    [
      'an item outside the matrix',
      {
        permission: 'users:read',
        qualifier: 'full',
        scope: [{ target: 'user', match: { by: 'id', id: GUID } }],
      },
    ],
    ['an extra key', { permission: 'groups:read', qualifier: 'full', scope: 'all', source: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(GrantSchema, value)).toBe(false);
  });

  it('accepts every catalogue permission as full', () => {
    for (const permission of PERMISSIONS)
      expect(
        accepts(GrantSchema, { permission, qualifier: 'full', scope: 'all' }),
        permission,
      ).toBe(true);
  });
});

describe('AssignmentSchema', () => {
  it('accepts the example and returns it unchanged', () => {
    const result = AssignmentSchema.safeParse(assignment);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(assignment);
  });

  it('accepts an unscoped assignment without expiry, from the wizard, the API and break-glass', () => {
    for (const source of ['wizard', 'api', 'break_glass'])
      expect(accepts(AssignmentSchema, { ...assignment, scope: [], expiresAt: null, source })).toBe(
        true,
      );
  });

  it('accepts a group principal and a custom role', () => {
    expect(
      accepts(AssignmentSchema, {
        ...assignment,
        principalType: 'group',
        role: { key: 'board_members', builtin: false },
      }),
    ).toBe(true);
  });

  it.each([
    ['a principal type outside user and group', { principalType: 'service' }],
    ['a principal id that is not a GUID', { principalId: 'not-a-guid' }],
    ['an upper-case id', { id: GUID.toUpperCase() }],
    ['a source outside the three', { source: 'import' }],
    ['an expiry without milliseconds', { expiresAt: '2026-10-11T12:00:00Z' }],
    ['an expiry with an offset', { expiresAt: '2026-10-11T14:00:00.000+02:00' }],
    ['an expiry that is missing', { expiresAt: undefined }],
    [
      'more than 50 scope items',
      {
        scope: Array.from({ length: 51 }, (_, i) => ({
          target: 'user',
          match: { by: 'department', value: `d${String(i)}` },
        })),
      },
    ],
    ['a role key with capitals', { role: { key: 'Owner', builtin: true } }],
    ['a role key of one character', { role: { key: 'o', builtin: true } }],
    ['a role without the builtin flag', { role: { key: 'owner' } }],
    ['an empty created-by', { createdBy: '' }],
    ['a created-by of 65 bytes', { createdBy: 'x'.repeat(65) }],
    ['an extra key', { permissions: [] }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(AssignmentSchema, { ...assignment, ...change })).toBe(false);
  });

  it('accepts 50 scope items', () => {
    const scope = Array.from({ length: 50 }, (_, i) => ({
      target: 'user',
      match: { by: 'department', value: `d${String(i)}` },
    }));
    expect(accepts(AssignmentSchema, { ...assignment, scope })).toBe(true);
  });
});

describe('RoleSchema, RoleTemplateSchema, RoleListResponseSchema', () => {
  const wireRoles = BUILTIN_ROLES.map((r) => ({
    key: r.key,
    builtin: r.builtin,
    assignable: r.assignable,
    permissions: r.permissions.map((p) => ({ ...p })),
  }));
  const wireTemplates = TEMPLATES.map((t) => ({
    key: t.key,
    permissions: t.permissions.map((p) => ({ ...p })),
    scopeTarget: t.scopeTarget,
  }));

  it('accepts the built-in roles and the template as the server will send them', () => {
    for (const role of wireRoles) expect(accepts(RoleSchema, role), role.key).toBe(true);
    for (const template of wireTemplates) expect(accepts(RoleTemplateSchema, template)).toBe(true);
    expect(accepts(RoleListResponseSchema, { roles: wireRoles, templates: wireTemplates })).toBe(
      true,
    );
    expect(accepts(RoleListResponseSchema, { roles: [], templates: [] })).toBe(true);
  });

  it('accepts a template without a suggested target', () => {
    expect(accepts(RoleTemplateSchema, { key: 'x1', permissions: [], scopeTarget: null })).toBe(
      true,
    );
  });

  it.each([
    [
      'a permission outside the catalogue',
      { permissions: [{ permission: 'users:write', qualifier: 'full' }] },
    ],
    ['basic on groups:read', { permissions: [{ permission: 'groups:read', qualifier: 'basic' }] }],
    [
      'the same permission twice',
      {
        permissions: [
          { permission: 'users:read', qualifier: 'full' },
          { permission: 'users:read', qualifier: 'basic' },
        ],
      },
    ],
    [
      'a qualifier that is the empty string (the stored form of full)',
      { permissions: [{ permission: 'users:read', qualifier: '' }] },
    ],
    [
      'more than 15 permissions',
      {
        permissions: Array.from({ length: 16 }, () => ({
          permission: 'users:read',
          qualifier: 'full',
        })),
      },
    ],
    ['a key with a dash', { key: 'help-desk' }],
    ['a key of 33 characters', { key: 'a'.repeat(33) }],
    ['assignable missing', { assignable: undefined }],
    ['an extra key', { description: 'x' }],
  ])('RoleSchema rejects %s', (_label, change) => {
    expect(accepts(RoleSchema, { ...wireRoles[4], ...change })).toBe(false);
  });

  it('RoleTemplateSchema rejects an unknown scope target, an assignable flag and an extra key', () => {
    expect(accepts(RoleTemplateSchema, { ...wireTemplates[0], scopeTarget: 'tenant' })).toBe(false);
    expect(accepts(RoleTemplateSchema, { ...wireTemplates[0], assignable: false })).toBe(false);
    expect(accepts(RoleTemplateSchema, { ...wireTemplates[0], scopeTarget: undefined })).toBe(
      false,
    );
  });

  it('RoleListResponseSchema allows at most 100 roles and rejects extra keys', () => {
    const roles = Array.from({ length: LIMITS.rbac.rolesMax }, (_, i) => ({
      ...wireRoles[4],
      key: `role_${String(i)}`,
    }));
    expect(accepts(RoleListResponseSchema, { roles, templates: [] })).toBe(true);
    expect(
      accepts(RoleListResponseSchema, {
        roles: [...roles, { ...wireRoles[4], key: 'one_more' }],
        templates: [],
      }),
    ).toBe(false);
    expect(
      accepts(RoleListResponseSchema, { roles: wireRoles, templates: wireTemplates, total: 6 }),
    ).toBe(false);
    expect(accepts(RoleListResponseSchema, { roles: wireRoles })).toBe(false);
  });
});

describe('AssignmentListQuerySchema and AssignmentListResponseSchema', () => {
  it('accepts no filter, either filter, and the page parameters as text', () => {
    expect(accepts(AssignmentListQuerySchema, {})).toBe(true);
    expect(accepts(AssignmentListQuerySchema, { principalId: GUID })).toBe(true);
    expect(accepts(AssignmentListQuerySchema, { role: 'owner' })).toBe(true);
    expect(
      accepts(AssignmentListQuerySchema, {
        principalId: GUID,
        role: 'helpdesk',
        limit: '50',
        cursor: 'abc_DEF-123',
      }),
    ).toBe(true);
  });

  it.each([
    ['a limit of 0', { limit: '0' }],
    ['a limit of 201', { limit: '201' }],
    ['a numeric limit (a query is text)', { limit: 50 }],
    ['an upper-case principal id', { principalId: GUID.toUpperCase() }],
    ['a role key with capitals', { role: 'Owner' }],
    ['a cursor with a slash', { cursor: 'a/b' }],
    ['an unknown parameter', { sort: 'role' }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(AssignmentListQuerySchema, value)).toBe(false);
  });

  const page = { assignments: [assignment], unresolvable: [GUID_2], total: 1, nextCursor: null };

  it('accepts a page and an empty page', () => {
    expect(accepts(AssignmentListResponseSchema, page)).toBe(true);
    expect(
      accepts(AssignmentListResponseSchema, {
        assignments: [],
        unresolvable: [],
        total: 0,
        nextCursor: 'abc',
      }),
    ).toBe(true);
  });

  it.each([
    ['a negative total', { total: -1 }],
    ['a total with a fraction', { total: 1.5 }],
    ['a total beyond the limit of assignments', { total: LIMITS.rbac.assignmentsMax + 1 }],
    ['an unresolvable id in capitals', { unresolvable: [GUID.toUpperCase()] }],
    [
      'more unresolvable ids than bound groups',
      { unresolvable: Array.from({ length: 201 }, () => GUID) },
    ],
    [
      'more than 200 assignments on a page',
      { assignments: Array.from({ length: 201 }, () => assignment) },
    ],
    ['a missing next cursor', { nextCursor: undefined }],
    ['an extra key', { query: 'x' }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(AssignmentListResponseSchema, { ...page, ...change })).toBe(false);
  });
});

describe('CreateAssignmentRequestSchema (strict)', () => {
  it('accepts the example of contracts section 11 (an escalation attempt is still a valid request)', () => {
    const body = {
      principalType: 'user',
      principalId: '8e0c2b8e-0000-4000-8000-0000000000aa',
      role: 'owner',
    };
    const result = CreateAssignmentRequestSchema.safeParse(body);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(body);
  });

  it('accepts a scope of up to 50 items and an expiry, or a null expiry', () => {
    const base = { principalType: 'group', principalId: GUID, role: 'helpdesk' };
    expect(
      accepts(CreateAssignmentRequestSchema, { ...base, scope: [prefixItem], expiresAt: TS }),
    ).toBe(true);
    expect(accepts(CreateAssignmentRequestSchema, { ...base, expiresAt: null })).toBe(true);
    expect(accepts(CreateAssignmentRequestSchema, { ...base, scope: [] })).toBe(true);
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      target: 'user',
      match: { by: 'department', value: `d${String(i)}` },
    }));
    expect(accepts(CreateAssignmentRequestSchema, { ...base, scope: fifty })).toBe(true);
    expect(accepts(CreateAssignmentRequestSchema, { ...base, scope: [...fifty, fifty[0]] })).toBe(
      false,
    );
  });

  const base = { principalType: 'user', principalId: GUID, role: 'reader' };
  it.each([
    ['a missing principal type', { principalType: undefined }],
    ['a missing principal id', { principalId: undefined }],
    ['a missing role', { role: undefined }],
    ['a principal type outside user and group', { principalType: 'device' }],
    ['a principal id in capitals', { principalId: GUID.toUpperCase() }],
    ['a role that is not a key', { role: 'Reader Role' }],
    ['a role that is an object', { role: { key: 'reader' } }],
    ['a scope that is not a list', { scope: prefixItem }],
    [
      'a scope item outside the matrix',
      { scope: [{ target: 'user', match: { by: 'id', id: GUID } }] },
    ],
    ['an expiry without milliseconds', { expiresAt: '2026-10-11T12:00:00Z' }],
    ['an unknown key (the source is the server’s)', { source: 'api' }],
    ['an unknown key (created by)', { createdBy: 'me' }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(CreateAssignmentRequestSchema, { ...base, ...change })).toBe(false);
  });

  it('rejects a body that is not an object', () => {
    for (const value of [null, [], 'owner', 7])
      expect(accepts(CreateAssignmentRequestSchema, value)).toBe(false);
  });
});

describe('EffectiveQuerySchema', () => {
  it('needs the principal; the type is user or group and may be absent (absent means user)', () => {
    expect(accepts(EffectiveQuerySchema, { principal: GUID })).toBe(true);
    expect(accepts(EffectiveQuerySchema, { principal: GUID, principalType: 'group' })).toBe(true);
    expect(accepts(EffectiveQuerySchema, { principal: GUID, principalType: 'user' })).toBe(true);
    expect(accepts(EffectiveQuerySchema, {})).toBe(false);
    expect(accepts(EffectiveQuerySchema, { principal: 'abc' })).toBe(false);
    expect(accepts(EffectiveQuerySchema, { principal: GUID.toUpperCase() })).toBe(false);
    expect(accepts(EffectiveQuerySchema, { principal: GUID, principalType: 'role' })).toBe(false);
    expect(accepts(EffectiveQuerySchema, { principal: GUID, extra: 1 })).toBe(false);
  });
});

describe('EffectiveResponseSchema', () => {
  const response = {
    principal: { type: 'user', id: GUID, label: 'Renee Smit' },
    assignments: [
      { assignment, origin: { type: 'direct' } },
      { assignment: { ...assignment, id: GUID_2 }, origin: { type: 'group', groupId: GUID_2 } },
    ],
    grants: [
      { permission: 'groups:read', qualifier: 'full', scope: 'all' },
      {
        permission: 'users:read',
        qualifier: 'basic',
        scope: [{ target: 'user', match: { by: 'department', value: 'Sales' } }],
      },
    ],
    groupsResolved: true,
    resolvedAt: TS,
  };

  it('accepts a full answer, a group principal without a label, and the Graph-down answer', () => {
    expect(accepts(EffectiveResponseSchema, response)).toBe(true);
    expect(
      accepts(EffectiveResponseSchema, {
        ...response,
        principal: { type: 'group', id: GUID, label: null },
      }),
    ).toBe(true);
    expect(
      accepts(EffectiveResponseSchema, { ...response, groupsResolved: false, resolvedAt: null }),
    ).toBe(true);
    expect(accepts(EffectiveResponseSchema, { ...response, assignments: [], grants: [] })).toBe(
      true,
    );
  });

  it.each([
    ['an origin of another kind', { assignments: [{ assignment, origin: { type: 'role' } }] }],
    [
      'a group origin without the group id',
      { assignments: [{ assignment, origin: { type: 'group' } }] },
    ],
    [
      'a direct origin with a group id',
      { assignments: [{ assignment, origin: { type: 'direct', groupId: GUID } }] },
    ],
    [
      'a grant with the scope in capitals',
      { grants: [{ permission: 'groups:read', qualifier: 'full', scope: 'ALL' }] },
    ],
    ['groupsResolved as text', { groupsResolved: 'yes' }],
    ['a principal type of role', { principal: { type: 'role', id: GUID, label: null } }],
    ['a label of 300 bytes', { principal: { type: 'user', id: GUID, label: 'x'.repeat(300) } }],
    ['a missing resolved-at', { resolvedAt: undefined }],
    ['an extra key', { warnings: [] }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(EffectiveResponseSchema, { ...response, ...change })).toBe(false);
  });
});

describe('RestoreOwnerRequestSchema (strict)', () => {
  it('needs the user id; the confirmation is optional and a boolean', () => {
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID })).toBe(true);
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID, confirmUnverified: true })).toBe(
      true,
    );
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID, confirmUnverified: false })).toBe(
      true,
    );
    expect(accepts(RestoreOwnerRequestSchema, {})).toBe(false);
    expect(accepts(RestoreOwnerRequestSchema, { userId: 'abc' })).toBe(false);
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID.toUpperCase() })).toBe(false);
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID, confirmUnverified: 'true' })).toBe(
      false,
    );
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID, role: 'owner' })).toBe(false);
    expect(accepts(RestoreOwnerRequestSchema, { userId: GUID, confirmUnverified: null })).toBe(
      false,
    );
  });
});

describe('the web package can load the schemas lazily', () => {
  it('imports as a module of its own and exposes the schemas', async () => {
    const module = await import('../src/schemas/rbac.js');
    expect(module.CreateAssignmentRequestSchema).toBe(CreateAssignmentRequestSchema);
  });
});
