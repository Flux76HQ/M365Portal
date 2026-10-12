// Readiness (FR-A-026, PD-24, plan 7.4): is the application able to do its job right now?
//
// Four named checks, each with a stable failure code and never an error text:
//
//   data_dir   a file can be created and removed in `DATA_DIR`        data_dir_not_writable
//   database   the connection is open and the file answers            database_unavailable | database_corrupt
//   schema     the applied migrations are the ones this build ships   schema_newer_than_app
//   secrets    the application key opens the certificate (Phase B)    app_key_missing | app_key_invalid | certificate_unreadable
//
// `secrets` (FR-B-108, SB-31) is decided by the secrets module (`secrets/state.ts`), which knows
// whether the key is required at all: it fails only once setup is completed or a certificate exists.
// Before that a missing key is the wizard's business and `/readyz` stays 200.
//
// When the database is not there (degraded mode) the `schema` check cannot be made and says what the
// `database` check says: a check only ever fails with one of the four codes of the contract.
//
// The whole answer is cached for 2 seconds on the injected clock, so that a probe from Docker, a load
// balancer and a person with a browser together cost one file write per two seconds, and a volume that
// turns read-only is noticed within that window. A storage failure that the error handler saw makes
// the next answer a fresh one, and a corrupt database stays corrupt until the process restarts: there
// is no automatic repair (E-10).
import type { ReadinessFailureCode } from '@m365portal/shared/schemas/health';
import type { DatabaseHandle } from '../db/index.js';
import { classifyStorageError, type StorageFailure } from '../db/errors.js';
import { appliedMigrations, inspectMigrations, shippedMigrations } from '../db/migrate.js';
import type { Readiness, ReadinessResult } from '../routes/health.js';
import type { StorageProbe } from './storage-probe.js';

/** How long an answer is reused, in milliseconds (plan 7.4). */
export const READINESS_CACHE_MS = 2000;

export interface ReadinessOptions {
  /** The clock, in milliseconds. Injected: a test moves it instead of waiting. */
  readonly now: () => number;
  readonly probe: StorageProbe;
  /** The open database, or `undefined` in degraded mode. Read on every fresh answer. */
  readonly database: () => DatabaseHandle | undefined;
  /** Why there is no database, as recorded at start; `undefined` when there is one. */
  readonly startFailure: () =>
    Extract<ReadinessFailureCode, 'database_unavailable' | 'database_corrupt'> | undefined;
  /** The folder with the shipped migrations, for the `schema` check. */
  readonly migrationsFolder: string;
  /**
   * The failure code of the `secrets` check, or `undefined` when it passes. Omitted: the check
   * passes (a server without the secrets module, as in the Phase A fixtures).
   */
  readonly secrets?: () => SecretsFailureCode | undefined;
}

type SecretsFailureCode = Extract<
  ReadinessFailureCode,
  'app_key_missing' | 'app_key_invalid' | 'certificate_unreadable'
>;

export interface ReadinessController extends Readiness {
  check(): ReadinessResult;
  /** Called by the error handler for every storage failure it answered. */
  reportStorageFailure(failure: StorageFailure): void;
  /** Whether storage is usable now: the answer of `/api/v1/me` (`storageAvailable`). */
  storageAvailable(): boolean;
}

type DatabaseCode = Extract<ReadinessFailureCode, 'database_unavailable' | 'database_corrupt'>;

export function createReadiness(options: ReadinessOptions): ReadinessController {
  let cached: { readonly at: number; readonly result: ReadinessResult } | undefined;
  let corrupt = false;
  let shipped: ReturnType<typeof shippedMigrations> | undefined;

  function databaseCodeOf(error: unknown): DatabaseCode {
    return classifyStorageError(error)?.kind === 'corrupt'
      ? 'database_corrupt'
      : 'database_unavailable';
  }

  /** The database and schema checks: one failure code for both, or the schema's own. */
  function checkDatabase(): {
    database: ReadinessFailureCode | undefined;
    schema: ReadinessFailureCode | undefined;
  } {
    if (corrupt) return { database: 'database_corrupt', schema: 'database_corrupt' };
    const handle = options.database();
    if (handle === undefined) {
      const code = options.startFailure() ?? 'database_unavailable';
      return { database: code, schema: code };
    }
    try {
      handle.sqlite.pragma('schema_version', { simple: true });
    } catch (error) {
      const code = databaseCodeOf(error);
      return { database: code, schema: code };
    }
    try {
      shipped ??= shippedMigrations(options.migrationsFolder);
      const state = inspectMigrations(appliedMigrations(handle.sqlite), shipped);
      if (state.status === 'schema_newer_than_app') {
        return { database: undefined, schema: 'schema_newer_than_app' };
      }
      // A checksum mismatch or a pending migration cannot exist after a successful start; if the file
      // changed under the running process, the database is not the one this build opened.
      if (state.status !== 'current') {
        return { database: undefined, schema: 'database_unavailable' };
      }
      return { database: undefined, schema: undefined };
    } catch (error) {
      const code = databaseCodeOf(error);
      return { database: code, schema: code };
    }
  }

  /** The secrets check never throws: a holder that fails is a failing check, not a crash. */
  function secretsCode(): ReadinessFailureCode | undefined {
    try {
      return options.secrets?.();
    } catch {
      return 'certificate_unreadable';
    }
  }

  function fresh(): ReadinessResult {
    const dataDir: ReadinessFailureCode | undefined = options.probe()
      ? undefined
      : 'data_dir_not_writable';
    const { database, schema } = checkDatabase();
    const entry = (
      name: 'data_dir' | 'database' | 'schema' | 'secrets',
      code: ReadinessFailureCode | undefined,
    ) => (code === undefined ? { name, ok: true } : { name, ok: false, code });
    const checks = [
      entry('data_dir', dataDir),
      entry('database', database),
      entry('schema', schema),
      entry('secrets', secretsCode()),
    ];
    return {
      status: checks.every((check) => check.ok) ? 'ready' : 'unavailable',
      checks,
    };
  }

  function check(): ReadinessResult {
    const now = options.now();
    // A clock that stepped back would keep an answer alive for as long as the step is long.
    if (cached !== undefined && now >= cached.at && now - cached.at < READINESS_CACHE_MS) {
      return cached.result;
    }
    const result = fresh();
    cached = { at: now, result };
    return result;
  }

  return {
    check,
    reportStorageFailure(failure) {
      if (failure.kind === 'corrupt') corrupt = true;
      cached = undefined;
    },
    storageAvailable: () => check().status === 'ready',
  };
}
