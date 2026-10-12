// T-B-254 (support), contract P27: the wire shape of a role and of a template is built in one place; the
// repository calls the permissions of a role its grants, the wire calls them `permissions`.
import { describe, expect, it } from 'vitest';
import { RoleListResponseSchema } from '../src/schemas/rbac.js';
import { BUILTIN_ROLES, roleToWire, templateToWire, TEMPLATES } from '../src/rbac/roles.js';

describe('roleToWire and templateToWire', () => {
  it('turn the built-in roles and the template into a valid RoleListResponse', () => {
    const body = {
      roles: BUILTIN_ROLES.map((role) =>
        roleToWire({
          key: role.key,
          builtin: role.builtin,
          assignable: role.assignable,
          grants: role.permissions,
        }),
      ),
      templates: TEMPLATES.map((template) =>
        templateToWire({
          key: template.key,
          scopeTarget: template.scopeTarget,
          grants: template.permissions,
        }),
      ),
    };
    expect(RoleListResponseSchema.parse(body)).toEqual(body);
    expect(body.roles.map((role) => role.permissions.length)).toEqual([15, 13, 9, 6, 4]);
  });

  it('copies the entries: changing the result never changes the constant', () => {
    const owner = BUILTIN_ROLES[0];
    const wire = roleToWire({
      key: 'owner',
      builtin: true,
      assignable: true,
      grants: owner?.permissions ?? [],
    });
    expect(wire.permissions[0]).not.toBe(owner?.permissions[0]);
    expect(wire.permissions[0]).toEqual(owner?.permissions[0]);
  });
});
