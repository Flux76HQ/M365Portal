// The distribution lists module (T-D-120, S-D2, FR-D-201): P40 to P45. Appended to `appModules` after the
// directory module (seam XD1). It holds no state on disk: the list buffer is process memory and is lost on
// restart (PD-03); the member writes keep their audit entries in the database next to the change.
//
// The clients are taken per call from the registry: `deps.clients.exchangeWorker()` (the `pwsh` worker, built
// on first use so that a process without `pwsh` starts) and `deps.clients.graph()`. Both throw while the
// secrets are unusable or no tenant is pinned; the route answers 503 then (`errors.ts`).
import type { AppModule, ModuleDeps } from '../module.js';
import type { DistributionListsContext } from './context.js';
import { createListBufferStore } from './list-buffer.js';
import { createDistributionListMemberWrites } from './members-write.js';
import { distributionListsRoutes } from './routes.js';
import { createDistributionListsService } from './service.js';

export const DISTRIBUTION_LISTS_MODULE_ID = 'distributionlists';

export function distributionListsModule(deps: ModuleDeps): AppModule {
  const serviceDeps = {
    exchange: () => deps.clients.exchangeWorker(),
    graph: () => deps.clients.graph(),
    buffers: createListBufferStore({ clock: { now: deps.now }, random: deps.random }),
  };
  const lists = createDistributionListsService(serviceDeps);
  const context: DistributionListsContext = {
    lists,
    writes: createDistributionListMemberWrites({
      exchange: serviceDeps.exchange,
      graph: serviceDeps.graph,
      lists,
      database: () => deps.requireDatabase(),
      now: deps.now,
    }),
  };
  return {
    id: DISTRIBUTION_LISTS_MODULE_ID,
    routes: () => distributionListsRoutes(context),
  };
}
