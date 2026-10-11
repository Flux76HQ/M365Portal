// Test support for the branding outputs (T-A-088 to T-A-091): the fixture application of
// `branding-fixture.ts` with the routes of the task under test added next to the branding routes, so
// the export, import, asset, manifest and icon routes are proven through the real route pipeline,
// the real denial audit and a migrated database. It adds no behaviour of its own.
import { createDenialAudit } from '../../src/http/denial-audit.js';
import type { RouteDefinition } from '../../src/http/route.js';
import type { DatabaseHandle } from '../../src/db/index.js';
import { assetsUploadRoutes } from '../../src/branding/routes/assets-upload.js';
import { brandingRoutes } from '../../src/branding/routes/branding.js';
import { createFixtureApp, fixtureRoutes, type FixtureApp } from '../helpers/http-app.js';
import {
  createBrandingStorage,
  type BrandingApp,
  type BrandingStorage,
  type BrandingStorageOptions,
} from './branding-fixture.js';

export interface OutputsAppOptions extends BrandingStorageOptions {
  /** The preview actor holds `settings:branding`; without it the actor is anonymous. Default: preview. */
  readonly preview?: boolean;
  /** The routes under test, built from the storage. */
  readonly routes: (storage: BrandingStorage) => readonly RouteDefinition[];
  /** Also register the S2 upload and apply routes (for tests that stage assets over HTTP). */
  readonly withBrandingRoutes?: boolean;
}

export async function createOutputsApp(options: OutputsAppOptions): Promise<BrandingApp> {
  const storage = await createBrandingStorage(options);
  const { clock, database, store, images, service } = storage;
  const denied = createDenialAudit({
    database: (): DatabaseHandle => database,
    now: () => clock.nowMs(),
  });
  const app: FixtureApp = await createFixtureApp({
    env: options.preview === false ? {} : { PREVIEW_MODE: 'true' },
    clock,
    context: { dataDir: storage.dataDir },
    rules: {
      read: { capacity: 10_000, refillIntervalMs: 1 },
      write: { capacity: 10_000, refillIntervalMs: 1 },
      upload: { capacity: 10_000, refillIntervalMs: 1 },
    },
    onDenied: denied,
    routes: ({ calls, csrf }) => [
      ...fixtureRoutes(calls, csrf, { withCsrf: true }).filter(
        (route) => route.id === 'fixture.csrf',
      ),
      ...(options.withBrandingRoutes === true
        ? [
            ...brandingRoutes({ service }),
            ...assetsUploadRoutes({
              requireDatabase: storage.requireDatabase,
              now: () => clock.nowMs(),
              assets: store,
              images,
              isShuttingDown: () => false,
            }),
          ]
        : []),
      ...options.routes(storage),
    ],
  });
  return { ...storage, app };
}
