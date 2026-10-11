// The fixture of the branding tests that need a database, an asset store, a service and, for the
// route tests, the real HTTP pipeline (T-A-084 to T-A-087): a fresh data directory with a migrated
// database, the asset store and the branding service over an injected clock, the branding routes in
// the fixture application of `helpers/http-app.ts`, and the real denial audit behind it.
//
// The image work runs in this process by default (`inProcessImages`): the same functions the child
// process runs, without the child, so a test that is not about the child does not pay for starting a
// process. A test that is about the wiring passes the real runner (`createImageJobRunner`).
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import sharp from 'sharp';
import { onTestFinished } from 'vitest';
import { defaultPaths } from '../../scripts/schema-snapshot.js';
import { clearAuditHeadLog } from '../../src/audit/index.js';
import {
  createAssetStore,
  type AssetStore,
  type StoreFileOperations,
} from '../../src/branding/asset-store.js';
import { stagingUsage } from '../../src/branding/repository.js';
import { DEFAULT_BRANDING } from '../../src/branding/defaults.js';
import { deriveVariants } from '../../src/branding/pipeline/icons.js';
import type { ImageJobRunner } from '../../src/branding/pipeline/job-runner.js';
import { processUpload } from '../../src/branding/pipeline/process-upload.js';
import { assetsUploadRoutes } from '../../src/branding/routes/assets-upload.js';
import { brandingRoutes } from '../../src/branding/routes/branding.js';
import { createBrandingService, type BrandingService } from '../../src/branding/service.js';
import {
  DATABASE_FILE_NAME,
  openDatabase,
  type AppDatabase,
  type DatabaseHandle,
} from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createDenialAudit } from '../../src/http/denial-audit.js';
import { ProblemError } from '../../src/http/problem.js';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock.js';
import { createFixtureApp, fixtureRoutes, type FixtureApp } from '../helpers/http-app.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';

export type BrandingImages = Pick<ImageJobRunner, 'process' | 'deriveVariants'>;

/** The image jobs, run in this process: the same code the child runs. */
export function inProcessImages(): BrandingImages {
  return {
    async process({ bytes, slot }) {
      const result = await processUpload({ bytes, slot });
      return {
        png: Buffer.from(result.png),
        width: result.width,
        height: result.height,
        luminance: result.luminance,
        warnings: result.warnings,
      };
    },
    async deriveVariants(input) {
      const derived = await deriveVariants({
        orgName: input.orgName,
        accent: input.accent,
        light: input.light === null ? null : { png: input.light },
        dark: input.dark === null ? null : { png: input.dark },
        compact: input.compact === null ? null : { png: input.compact },
      });
      return {
        compact: derived.compact,
        compactDerived: derived.compactDerived,
        source: derived.icons.source,
        plate: derived.icons.plate,
        icons: derived.icons.icons,
      };
    },
  };
}

/** Images that fail the way the runner does: for the tests of busy, timeout and shutdown. */
export function failingImages(
  code: 'image_processing_busy' | 'image_processing_timeout' | 'shutting_down',
): BrandingImages {
  const problem = (): ProblemError =>
    new ProblemError(code, code === 'image_processing_busy' ? { retryAfterSeconds: 5 } : {});
  return {
    process: () => Promise.reject(problem()),
    deriveVariants: () => Promise.reject(problem()),
  };
}

// ---------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** A solid PNG. */
export async function solidPng(width: number, height: number, colour: Rgb): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: colour[0], g: colour[1], b: colour[2] },
    },
  })
    .png()
    .toBuffer();
}

/** Different bytes for a different `seed`: a visible bar whose position follows the seed. */
export async function distinctPng(seed: number, size = 64): Promise<Buffer> {
  const bar = await sharp({
    create: { width: 8, height: size, channels: 3, background: { r: 20, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 230, g: 230, b: 230 } },
  })
    .composite([{ input: bar, left: seed % (size - 8), top: 0 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export interface AuditRow {
  readonly seq: number;
  readonly ts: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly client_ip: string | null;
  readonly request_id: string | null;
  readonly detail: string;
}

export function detailOf(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.detail) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// The database side
// ---------------------------------------------------------------------------------------------

export interface BrandingStorage {
  readonly dataDir: string;
  readonly clock: FakeClock;
  readonly database: AppDatabase;
  readonly store: AssetStore;
  readonly images: BrandingImages;
  readonly service: BrandingService;
  audit(): AuditRow[];
  /** The staging quota in use right now: assets whose 24 hours are still running. */
  usage(): { readonly files: number; readonly bytes: number };
  /** Raw rows of `branding_asset`, oldest first. */
  assets(): { sha256: string; bytes: number; unreferenced_at: string | null; created_at: string }[];
  /** A second connection to the same file (for the tests of races). */
  connect(): AppDatabase;
}

export interface BrandingStorageOptions {
  readonly clock?: FakeClock;
  readonly dataDir?: string;
  readonly images?: BrandingImages;
  readonly files?: StoreFileOperations;
  readonly randomName?: () => string;
  /** Create the default row (the start hook does). Default: yes. */
  readonly withDefault?: boolean;
}

/** A migrated database, the store and the service over one fake clock, removed when the test ends. */
export async function createBrandingStorage(
  options: BrandingStorageOptions = {},
): Promise<BrandingStorage> {
  const dir = options.dataDir === undefined ? await createTempDataDir() : undefined;
  const dataDir = options.dataDir ?? dir?.path ?? '';
  const clock = options.clock ?? createFakeClock();
  const paths = defaultPaths();
  const path = join(dataDir, DATABASE_FILE_NAME);

  const database = openDatabase({ path });
  const extra: AppDatabase[] = [];
  onTestFinished(() => {
    clearAuditHeadLog();
    for (const handle of [database, ...extra]) if (handle.sqlite.open) handle.close();
  });
  await runMigrations(database.sqlite, {
    migrationsFolder: paths.migrationsFolder,
    backupsDir: join(dataDir, 'backups'),
  });

  const images = options.images ?? inProcessImages();
  const store = createAssetStore({
    dataDir,
    now: () => clock.nowMs(),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.randomName === undefined ? {} : { randomName: options.randomName }),
  });
  await store.ensureDirectories();
  const service = createBrandingService({
    requireDatabase: () => database,
    now: () => clock.nowMs(),
    assets: store,
    images,
  });
  if (options.withDefault !== false) await service.ensureDefault();

  return {
    dataDir,
    clock,
    database,
    store,
    images,
    service,
    usage: () =>
      stagingUsage(database, new Date(clock.nowMs() - LIMITS.staging.retentionMs).toISOString()),
    audit: () =>
      database.sqlite.prepare('SELECT * FROM audit_log ORDER BY seq').all() as AuditRow[],
    assets: () =>
      database.sqlite
        .prepare(
          'SELECT sha256, bytes, unreferenced_at, created_at FROM branding_asset ORDER BY created_at, sha256',
        )
        .all() as ReturnType<BrandingStorage['assets']>,
    connect: () => {
      const handle = openDatabase({ path });
      extra.push(handle);
      return handle;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The HTTP side
// ---------------------------------------------------------------------------------------------

export interface BrandingAppOptions extends BrandingStorageOptions {
  /** The preview actor holds `settings:branding`; without it the actor is anonymous. Default: preview. */
  readonly preview?: boolean;
  readonly isShuttingDown?: () => boolean;
}

export interface BrandingApp extends BrandingStorage {
  readonly app: FixtureApp;
}

/** The fixture application with the branding routes of `T-A-086` and `T-A-087` over real storage. */
export async function createBrandingApp(options: BrandingAppOptions = {}): Promise<BrandingApp> {
  const storage = await createBrandingStorage(options);
  const { clock, database, store, images, service } = storage;
  const denied = createDenialAudit({
    database: (): DatabaseHandle => database,
    now: () => clock.nowMs(),
  });
  const app = await createFixtureApp({
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
      ...brandingRoutes({ service }),
      ...assetsUploadRoutes({
        requireDatabase: () => database,
        now: () => clock.nowMs(),
        assets: store,
        images,
        isShuttingDown: options.isShuttingDown ?? (() => false),
      }),
    ],
  });
  return { ...storage, app };
}

export const DEFAULT_NAME = DEFAULT_BRANDING.orgName;
export const DEFAULT_ACCENT_HEX = DEFAULT_BRANDING.accent;
