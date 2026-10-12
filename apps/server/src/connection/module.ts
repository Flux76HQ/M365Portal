// The connection module (T-B-139, T-B-142): the connection page API P19 to P26.
//
// Owner: S-B3 (Setup engine). Created by S-B1 at T-B-014 as a stub and taken over at gate GB0 (tasks.md
// section 1.3); the stub marker is gone.
// The runner it talks to
// is the setup module's (one engine per server, `setupRuntimeOf`). The start posture logs the
// certificate expiry level once, without a secret (FR-B-111).
import type { AppModule, ModuleDeps } from '../module.js';
import { setupRuntimeOf } from '../setup/runtime.js';
import { expiryWarningOf } from './cert-expiry.js';
import { connectionRoutes } from './routes.js';

export const CONNECTION_MODULE_ID = 'connection';

export function connectionModule(deps: ModuleDeps): AppModule {
  const runtime = setupRuntimeOf(deps);
  const log = deps.log.child({ module: CONNECTION_MODULE_ID });
  return {
    id: CONNECTION_MODULE_ID,
    routes: () => connectionRoutes(runtime),
    start() {
      const certificates = deps.secrets.services()?.certificates;
      const active = certificates?.current(deps.requireDatabase()).active;
      if (active !== undefined) {
        const warning = expiryWarningOf(active.notAfter, deps.now());
        if (warning !== undefined) log.warn(warning, 'certificate_expiry');
      }
      return Promise.resolve();
    },
  };
}
