// The rbac module (S-B5, T-B-238 and following): the RBAC data, the grants the policy layer reads, the
// assignment API and restore-owner. Created as a stub by S-B1 at T-B-014 and owned by S-B5 from GB0.
// It is in `appModules` (`modules.ts`) after auth, which fixes the order of routes and of the `start`
// and `stop` hooks.
//
//   factory the grants of a user, memoised (`grants.ts`), are handed to the policy layer through the
//           holder of `ModuleDeps.policy`: the actor resolver reads them on every request. A request
//           that arrives before this has happened is anonymous (fail closed).
//   start   the check of the built-in roles (plan 6.1 step 5): a database whose seeded roles differ
//           from the constant `BUILTIN_ROLES` ends the start with `builtin_roles_mismatch`. The hook
//           runs after the migrations and the singleton rows, before anything listens, and not in
//           degraded mode.
import type { AppModule, ModuleDeps } from '../module.js';
import { BuiltinRolesMismatchError, assertBuiltinRoles } from './builtin-check.js';
import { createAssignmentService } from './assignment-service.js';
import type { RbacContext } from './context.js';
import { createGrantsService } from './grants.js';
import { createMembershipService } from './membership.js';
import { myAccessRoutes } from './my-access.js';
import { restoreOwnerRoutes } from './restore-owner.js';
import { rbacRoutes } from './routes.js';

export const RBAC_MODULE_ID = 'rbac';

export function rbacModule(deps: ModuleDeps): AppModule {
  const log = deps.log.child({ module: RBAC_MODULE_ID });
  const grants = createGrantsService({ database: deps.database, now: deps.now });
  deps.policy.grants.set(grants);
  const ctx: RbacContext = {
    deps,
    membership: createMembershipService({
      database: deps.database,
      graph: () => deps.clients.graph(),
      now: deps.now,
      ttlMs: deps.config.rbac.groupCacheTtlMs,
      log,
    }),
    assignments: createAssignmentService({
      database: deps.requireDatabase,
      graph: () => deps.clients.graph(),
      now: deps.now,
      random: deps.random,
      grantsOf: (actor) => {
        const db = deps.requireDatabase();
        const row = db.sqlite
          .prepare('SELECT groups_resolved_at AS at FROM app_user WHERE oid = ?')
          .get(actor.id) as { at: string | null } | undefined;
        return grants.grantsFor({ oid: actor.id, groupsResolvedAt: row?.at ?? null });
      },
    }),
  };
  return {
    id: RBAC_MODULE_ID,
    routes: () => [...myAccessRoutes(ctx), ...rbacRoutes(ctx), ...restoreOwnerRoutes(ctx)],
    start: (startDeps) => {
      try {
        assertBuiltinRoles(startDeps.requireDatabase());
      } catch (error) {
        if (error instanceof BuiltinRolesMismatchError) {
          // The problems name roles and catalogue permissions, never a value of the database.
          log.fatal(
            { event: 'builtin_roles_mismatch', part: error.part, problems: error.problems },
            'builtin_roles_mismatch',
          );
        }
        return Promise.reject(error instanceof Error ? error : new Error('the rbac start failed'));
      }
      return Promise.resolve();
    },
  };
}
