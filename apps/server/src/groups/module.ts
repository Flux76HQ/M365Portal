// The groups module (T-D-123, S-D2, FR-D-352): the member writes of a Microsoft 365 or security group, P53
// and P54. It sits beside the directory module, which stays read-only (Phase C, FR-C-402: the guard
// `directory/no-writes.test.ts` scans that folder for anything that could write). Appended to `appModules`
// after the directory module (seam XD1): the reads of the same path, `GET /api/v1/groups/{id}/members`, are
// P39 there.
//
// It writes through Graph (`deps.clients.graph()`, taken per call) and keeps its audit entries in the
// database next to the change. No state of its own is kept in memory.
import { createGroupsService } from '../directory/groups-service.js';
import { createCursorStore } from '../directory/cursor-store.js';
import type { AppModule, ModuleDeps } from '../module.js';
import { createGroupMemberWrites } from './members-write.js';
import { groupMemberWriteRoutes } from './routes.js';

export const GROUPS_MODULE_ID = 'groups';

export function groupsModule(deps: ModuleDeps): AppModule {
  const graph = () => deps.clients.graph();
  // Only `find` is used: the group service is the one reader of a group the directory module has.
  const reader = createGroupsService({
    graph,
    cursors: createCursorStore({ clock: { now: deps.now }, random: deps.random }),
    log: deps.log.child({ module: GROUPS_MODULE_ID }),
  });
  const routes = groupMemberWriteRoutes({
    find: (id) => reader.find(id),
    writes: createGroupMemberWrites({
      graph,
      database: () => deps.requireDatabase(),
      now: deps.now,
    }),
  });
  return {
    id: GROUPS_MODULE_ID,
    routes: () => routes,
  };
}
