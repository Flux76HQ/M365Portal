// T-B-238, FR-B-503, I-B1: the template *Bestuur* is data in `rbac_role_template`. It has the five
// permissions of the spec, is not a role (so it cannot be assigned), and is never an input of the
// effective permissions.
import { TEMPLATES } from '@m365portal/shared/rbac/roles';
import { describe, expect, it } from 'vitest';
import { findAssignableRole, findRoleByKey, listTemplates } from '../../src/rbac/repository.js';
import { createMigratedDatabase } from '../helpers/rbac-db.js';

describe('the Bestuur template (FR-B-503)', () => {
  it('is stored as the constant says: five permissions, users:read basic, target distributionList', async () => {
    const db = await createMigratedDatabase();
    const stored = listTemplates(db);
    expect(stored).toHaveLength(1);
    const board = stored[0];
    expect(board).toMatchObject({
      key: 'board',
      assignable: false,
      scopeTarget: 'distributionList',
    });
    expect(board?.grants).toEqual(TEMPLATES[0]?.permissions);
    expect(board?.grants.map((entry) => entry.permission).sort()).toEqual([
      'contacts:create',
      'contacts:read',
      'distributionlists:members:write',
      'distributionlists:read',
      'users:read',
    ]);
    expect(board?.grants.find((entry) => entry.permission === 'users:read')?.qualifier).toBe(
      'basic',
    );
  });

  it('is not a role: it cannot be found as one, and so cannot be assigned', async () => {
    const db = await createMigratedDatabase();
    expect(findRoleByKey(db, 'board')).toBeUndefined();
    expect(findAssignableRole(db, 'board')).toBeUndefined();
    expect(findAssignableRole(db, 'owner')?.key).toBe('owner');
  });
});
