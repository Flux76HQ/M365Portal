// The dashboard module (FR-D-808, P70). Appended to `appModules` last, after the modules whose services it
// reads. Like the groups module it builds its own readers over the shared clients (taken per call from the
// registry), so no module needs to know of it; the cursors and list buffers it uses are process memory of its own.
// It writes nothing and holds nothing on disk.
import { createCursorStore } from '../directory/cursor-store.js';
import { createGroupsService } from '../directory/groups-service.js';
import { createUsersService } from '../directory/users-service.js';
import { createContactsService } from '../contacts/service.js';
import { createListBufferStore } from '../distribution-lists/list-buffer.js';
import { createDistributionListsService } from '../distribution-lists/service.js';
import type { AppModule, ModuleDeps } from '../module.js';
import { dashboardRoutes } from './routes.js';
import { createDashboardService } from './service.js';

export const DASHBOARD_MODULE_ID = 'dashboard';

export function dashboardModule(deps: ModuleDeps): AppModule {
  const log = deps.log.child({ module: DASHBOARD_MODULE_ID });
  const directory = {
    graph: () => deps.clients.graph(),
    cursors: createCursorStore({ clock: { now: deps.now }, random: deps.random }),
    log,
  };
  const exchange = () => deps.clients.exchangeCommands();
  const buffers = createListBufferStore({ clock: { now: deps.now }, random: deps.random });
  const service = createDashboardService({
    users: createUsersService(directory),
    groups: createGroupsService(directory),
    lists: createDistributionListsService({ exchange, graph: directory.graph, buffers }),
    contacts: createContactsService({
      exchange,
      buffers,
      database: () => deps.requireDatabase(),
      now: deps.now,
      random: deps.random,
    }),
    now: deps.now,
    log,
  });
  return {
    id: DASHBOARD_MODULE_ID,
    routes: () => dashboardRoutes(service),
  };
}
