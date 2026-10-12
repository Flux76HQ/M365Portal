// The branding module (T-A-092, contract C5, seam X1): the one place where the pieces of the S2
// stream are wired together and handed to the composition root.
//
//   store      the asset files under `${DATA_DIR}/branding` and their registry rows
//   images     the image job runner: one fresh child process per job; killed by `stop`
//   service    the applied branding, apply and reset in one transaction with the audit entry
//   routes     R6 to R9 (branding, upload), R10 and R11 (export, import), R12 (assets), R13 to R15
//   shell      the page renderer of C6; it asks the service on every render and falls back to the
//              in-memory defaults while storage is unavailable (degraded mode, FR-A-013)
//   start      after the migrations, never in degraded mode: directories, the stale `.tmp` entries
//              of a crashed process, the sweepers (through the server registry, no timers of our
//              own), the check that every referenced file exists, and the first branding row
//   stop       kills the image child processes and fails the jobs that wait
//
// Nothing here has a rule of its own. A factory takes the dependencies of the server (`ModuleDeps`)
// and, optionally, a stand-in image runner for tests.
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import type { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import type { z } from 'zod';
import type { AppModule, ModuleDeps } from '../module.js';
import { APP_VERSION } from '../version.js';
import { createAssetStore } from './asset-store.js';
import { exportImportRoutes } from './routes/export-import.js';
import { assetsUploadRoutes } from './routes/assets-upload.js';
import { brandingRoutes } from './routes/branding.js';
import { pwaRoutes } from './routes/pwa.js';
import { assetServingRoutes } from './routes/serve-assets.js';
import { createImageJobRunner, type ImageJobRunner } from './pipeline/job-runner.js';
import { createBrandingService } from './service.js';
import { createBrandingShell } from './shell.js';
import {
  checkReferencedAssets,
  registerBrandingSweepers,
  sweepTemporaryFiles,
  type SweepDependencies,
} from './sweepers.js';

type MeResponse = z.infer<typeof MeResponseSchema>;

export const BRANDING_MODULE_ID = 'branding';

export interface BrandingModuleOptions {
  /** The image runner. Default: the real one (a child process per job). A test passes a stand-in. */
  readonly images?: ImageJobRunner;
}

/**
 * The `me` of one request, built exactly as `GET /api/v1/me` builds it: the actor from the same
 * resolver the pipeline uses (nothing in the request selects it beyond the configuration and the
 * `Host` rules of preview mode), the permissions in catalogue order, the preview flag only for the
 * preview actor. `module.test.ts` pins that the two never differ.
 */
function meOf(deps: ModuleDeps, request: Request): MeResponse {
  const actor = deps.resolveActor(request);
  const held: Permission[] = PERMISSIONS.filter((candidate) => actor.permissions.has(candidate));
  return {
    // TRANSITIONAL: the wire enum is Phase A's until T-B-194 replaces the shape of `me` (S-B4).
    actor: { kind: actor.kind as MeResponse['actor']['kind'], id: actor.id, label: actor.label },
    permissions: held,
    // TRANSITIONAL: `preview` leaves the wire shape with T-B-194 (S-B4); it is never true any more.
    features: { showcase: deps.config.showcase, preview: false },
    version: APP_VERSION,
    publicOrigin: deps.config.publicOrigin,
    storageAvailable: deps.storageAvailable(),
  };
}

export function createBrandingModule(
  deps: ModuleDeps,
  options: BrandingModuleOptions = {},
): AppModule {
  const log = deps.log.child({ module: BRANDING_MODULE_ID });
  const assets = createAssetStore({ dataDir: deps.config.dataDir, now: deps.now });
  const images = options.images ?? createImageJobRunner();
  const service = createBrandingService({
    requireDatabase: deps.requireDatabase,
    now: deps.now,
    assets,
    images,
  });
  const sweepDeps: SweepDependencies = {
    store: assets,
    database: deps.database,
    now: deps.now,
  };
  const transfer = {
    requireDatabase: deps.requireDatabase,
    now: deps.now,
    assets,
    images,
    service,
  };

  return {
    id: BRANDING_MODULE_ID,
    routes: () => [
      ...brandingRoutes({ service }),
      ...assetsUploadRoutes({
        requireDatabase: deps.requireDatabase,
        now: deps.now,
        assets,
        images,
        isShuttingDown: deps.isShuttingDown,
      }),
      ...exportImportRoutes(transfer),
      ...assetServingRoutes({ requireDatabase: deps.requireDatabase, assets }),
      ...pwaRoutes({ service }),
    ],
    shell: createBrandingShell({
      template: deps.shellTemplate,
      service,
      me: (request) => meOf(deps, request),
    }),
    start: async () => {
      await assets.ensureDirectories();
      // Entries a crashed process left behind; the hourly sweeper would get them too, later.
      await sweepTemporaryFiles(sweepDeps);
      registerBrandingSweepers(deps.sweepers, sweepDeps);
      await checkReferencedAssets({ ...sweepDeps, log });
      // Makes the first row (`branding.init`) and loads sharp in a child: a broken native module
      // ends the start here, not at the first upload.
      await service.ensureDefault();
    },
    stop: () => images.shutdown(),
  };
}

/** The factory `modules.ts` registers (seam X1). */
export function brandingModule(deps: ModuleDeps, options?: BrandingModuleOptions): AppModule {
  return createBrandingModule(deps, options);
}
