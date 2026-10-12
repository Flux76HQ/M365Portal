// The seam to the group membership service (FR-B-507, T-B-247). The auth module needs two things of
// it, so it depends on this port; `rbac/membership.ts` owns the implementation and the rules (chunks
// of 20, at most 4 in flight, fail closed, the TTL).
//
//   refresh   resolve the bound groups of a user through Graph, store the answer in
//             `rbac_group_member_cache` and `app_user.groups_resolved_at` in one transaction, and drop
//             group rights once the TTL has passed on a failure. `ok: false` is a Graph failure: the
//             user then has direct assignments only. The user's `app_user` row must exist.
//   isFresh   is a `groups_resolved_at` still inside the TTL?
import type { ModuleDeps } from '../module.js';
import { createMembershipService } from '../rbac/membership.js';

export interface MembershipResult {
  readonly ok: boolean;
}

export interface MembershipPort {
  refresh(oid: string): Promise<MembershipResult>;
  isFresh(groupsResolvedAt: string | null): boolean;
}

/** The port over a membership service built from the server's dependencies. */
export function createMembershipPort(deps: ModuleDeps): MembershipPort {
  const service = createMembershipService({
    database: deps.database,
    graph: () => deps.clients.graph(),
    now: deps.now,
    ttlMs: deps.config.rbac.groupCacheTtlMs,
    log: deps.log,
  });
  return {
    refresh: async (oid) => {
      try {
        return { ok: (await service.refresh(oid)).ok };
      } catch {
        // No client (secrets unavailable, not connected): the same as Graph being down.
        return { ok: false };
      }
    },
    isFresh: (at) => service.isFresh(at),
  };
}
