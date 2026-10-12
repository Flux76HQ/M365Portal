// The check of the built-in roles (T-B-238, FR-B-501, plan 6.1 step 5, EB-29): the rows seeded by
// migration `0001` are compared with the constants `BUILTIN_ROLES` and `TEMPLATES`. A difference means
// the database was edited by hand, restored from the wrong build, or a migration is missing; the
// process must not serve with roles it does not understand, so the start ends with
// `builtin_roles_mismatch`. The check is the `start` hook of the rbac module (`module.ts`), which the
// start sequence runs after the migrations and the singleton rows and before anything listens.
//
// The messages name the role and a permission of the catalogue, and never a value that came from the
// database: a permission the catalogue does not know is called "an unknown permission".
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { BUILTIN_ROLES, TEMPLATES, type RolePermission } from '@m365portal/shared/rbac/roles';
import { eq } from 'drizzle-orm';
import { rbacRole, rbacRoleGrant, type DatabaseHandle } from '../db/index.js';
import { listRoles, listTemplates, type RoleRecord } from './repository.js';

/** Which part of the seeded data differs (the log names it; it never names a value). */
export type BuiltinMismatchPart = 'roles' | 'permissions' | 'template';

export interface BuiltinProblem {
  readonly part: BuiltinMismatchPart;
  readonly text: string;
}

export class BuiltinRolesMismatchError extends Error {
  /** The stable start-up code (FR-B-501). */
  readonly code = 'builtin_roles_mismatch';
  /** The part of the first difference. */
  readonly part: BuiltinMismatchPart;
  readonly problems: readonly string[];

  constructor(problems: readonly BuiltinProblem[]) {
    super(
      `the built-in roles in the database differ from the shipped ones (${problems[0]?.part ?? 'roles'})`,
    );
    this.name = 'BuiltinRolesMismatchError';
    this.part = problems[0]?.part ?? 'roles';
    this.problems = problems.map((problem) => problem.text);
  }
}

const CATALOGUE: ReadonlySet<string> = new Set(PERMISSIONS);

function catalogueNameOf(name: string): string {
  return CATALOGUE.has(name) ? name : 'an unknown permission';
}

function compareGrants(
  part: BuiltinMismatchPart,
  label: string,
  expected: readonly RolePermission[],
  found: readonly RolePermission[],
): BuiltinProblem[] {
  const problems: BuiltinProblem[] = [];
  const wanted = new Map(expected.map((entry) => [entry.permission, entry.qualifier]));
  const held = new Map(found.map((entry) => [entry.permission, entry.qualifier]));
  for (const [permission, qualifier] of wanted) {
    const stored = held.get(permission);
    if (stored === undefined) problems.push({ part, text: `${label} lacks ${permission}` });
    else if (stored !== qualifier) {
      problems.push({ part, text: `${label} holds ${permission} with another qualifier` });
    }
  }
  for (const permission of held.keys()) {
    if (!wanted.has(permission)) {
      problems.push({
        part,
        text: `${label} has an extra permission ${catalogueNameOf(permission)}`,
      });
    }
  }
  return problems;
}

/** Every difference between the database and the constants. Empty when they are equal. */
export function builtinRoleProblems(db: DatabaseHandle): BuiltinProblem[] {
  const problems: BuiltinProblem[] = [];
  const roles = listRoles(db);
  const byKey = new Map<string, RoleRecord>(roles.map((role) => [role.key, role]));

  for (const definition of BUILTIN_ROLES) {
    const stored = byKey.get(definition.key);
    if (stored === undefined) {
      problems.push({ part: 'roles', text: `the built-in role ${definition.key} is missing` });
      continue;
    }
    if (!stored.builtin) {
      problems.push({ part: 'roles', text: `the role ${definition.key} is not marked built-in` });
    }
    if (!stored.assignable) {
      problems.push({ part: 'roles', text: `the role ${definition.key} is not assignable` });
    }
    problems.push(
      ...compareGrants(
        'permissions',
        `the role ${definition.key}`,
        definition.permissions,
        stored.grants,
      ),
    );
  }

  const known = new Set<string>(BUILTIN_ROLES.map((definition) => definition.key));
  if (roles.some((role) => role.builtin && !known.has(role.key))) {
    problems.push({
      part: 'roles',
      text: 'the database holds a built-in role the build does not know',
    });
  }

  // Rows the repository does not show (a permission outside the catalogue) are a difference too.
  const unknownRows = db.orm
    .select({ permission: rbacRoleGrant.permission, key: rbacRole.key })
    .from(rbacRoleGrant)
    .innerJoin(rbacRole, eq(rbacRole.id, rbacRoleGrant.roleId))
    .all()
    .filter((row) => !CATALOGUE.has(row.permission) && known.has(row.key));
  for (const row of unknownRows) {
    problems.push({
      part: 'permissions',
      text: `the role ${row.key} has an extra permission an unknown permission`,
    });
  }

  const templates = listTemplates(db);
  for (const expected of TEMPLATES) {
    const stored = templates.find((template) => template.key === expected.key);
    if (stored === undefined) {
      problems.push({ part: 'template', text: `the template ${expected.key} is missing` });
      continue;
    }
    if (stored.scopeTarget !== expected.scopeTarget) {
      problems.push({
        part: 'template',
        text: `the template ${expected.key} has another scope target`,
      });
    }
    problems.push(
      ...compareGrants(
        'template',
        `the template ${expected.key}`,
        expected.permissions,
        stored.grants,
      ),
    );
  }
  if (templates.length !== TEMPLATES.length) {
    problems.push({
      part: 'template',
      text: 'the database holds a template the build does not know',
    });
  }
  return problems;
}

/** Throws a `BuiltinRolesMismatchError` unless the seeded roles and the template are the constants. */
export function assertBuiltinRoles(db: DatabaseHandle): void {
  const problems = builtinRoleProblems(db);
  if (problems.length > 0) throw new BuiltinRolesMismatchError(problems);
}
