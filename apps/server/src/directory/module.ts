// The directory module (T-C-024, S-C2, FR-C-401 to FR-C-403): the read-only users and groups routes of
// Phase C. Appended to `appModules` after rbac (seam XC1), so the actor resolver and the grants it reads
// are in place. It holds no state on disk: the cursor store is process memory and is lost on restart
// (PC-02), and nothing is written to the database.
//
// The Graph client is taken per call from the registry (`deps.clients.graph()`), which throws while the
// secrets are unusable or no tenant is pinned; the route answers 503 then (`directory/errors.ts`).
import type { AppModule, ModuleDeps } from '../module.js';
import type { DirectoryContext } from './context.js';
import { createCursorStore } from './cursor-store.js';
import { createGroupsService } from './groups-service.js';
import { directoryRoutes } from './routes.js';
import { createUsersService } from './users-service.js';

export const DIRECTORY_MODULE_ID = 'directory';

export function directoryModule(deps: ModuleDeps): AppModule {
  const log = deps.log.child({ module: DIRECTORY_MODULE_ID });
  const serviceDeps = {
    graph: () => deps.clients.graph(),
    cursors: createCursorStore({ clock: { now: deps.now }, random: deps.random }),
    log,
  };
  const context: DirectoryContext = {
    users: createUsersService(serviceDeps),
    groups: createGroupsService(serviceDeps),
  };
  return {
    id: DIRECTORY_MODULE_ID,
    routes: () => directoryRoutes(context),
  };
}
