// The contacts module (T-D-122, S-D2, FR-D-301): P47 to P52. Appended to `appModules` after the distribution
// lists module (seam XD1). It holds no state on disk: the list buffer is process memory (PD-03); the success
// entries of the writes are written to the database next to the change.
import type { AppModule, ModuleDeps } from '../module.js';
import { createListBufferStore } from '../distribution-lists/list-buffer.js';
import { contactsRoutes } from './routes.js';
import { createContactsService } from './service.js';

export const CONTACTS_MODULE_ID = 'contacts';

export function contactsModule(deps: ModuleDeps): AppModule {
  const contacts = createContactsService({
    exchange: () => deps.clients.exchangeWorker(),
    buffers: createListBufferStore({ clock: { now: deps.now }, random: deps.random }),
    database: () => deps.requireDatabase(),
    now: deps.now,
    random: deps.random,
  });
  return {
    id: CONTACTS_MODULE_ID,
    routes: () => contactsRoutes(contacts),
  };
}
