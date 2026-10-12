// Fixtures of the secrets tests: a migrated database in a throwaway data directory, throwaway keys
// (generated per run, never a constant that could be mistaken for a real key), a seeded random
// source and the install id row. Nothing here is a secret: every value is made for the test.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { databasePathOf, openDatabase, type AppDatabase } from '../../src/db/index.js';
import type { RandomSource } from '../../src/ports/clock.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';

export const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
export const INSTALL_ID = '0123456789abcdef0123456789abcdef';

/** A throwaway 32-byte key with enough distinct bytes to pass the strength rules. */
export function throwawayKey(): Uint8Array {
  for (;;) {
    const key = new Uint8Array(randomBytes(32));
    if (new Set(key).size >= 16) return key;
  }
}

/** Random bytes from a counter: deterministic, so a failure repeats. Not for keys. */
export function countingRandom(seed = 1): RandomSource {
  let counter = seed;
  return {
    bytes: (length) => {
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        counter = (Math.imul(counter, 1103515245) + 12345) >>> 0;
        out[index] = (counter >>> 16) & 0xff;
      }
      return out;
    },
    float: () => 0.5,
  };
}

export interface MigratedDatabase {
  readonly dataDir: string;
  readonly database: AppDatabase;
}

/** A data directory with a migrated database and the `setup_state` singleton, closed after the test. */
export async function migratedDatabase(
  options: { setupState?: 'unconfigured' | 'completed' | false } = {},
): Promise<MigratedDatabase> {
  const dir = await createTempDataDir();
  const database = openDatabase({ path: databasePathOf(dir.path) });
  onTestFinished(() => {
    if (database.sqlite.open) database.close();
  });
  await runMigrations(database.sqlite, {
    migrationsFolder: MIGRATIONS,
    backupsDir: join(dir.path, 'backups'),
  });
  const state = options.setupState ?? 'unconfigured';
  if (state !== false) {
    database.sqlite
      .prepare(
        "INSERT INTO setup_state (id, state, mode, install_id, completed_at, updated_at) VALUES (1, ?, 'automatic', ?, ?, '2026-10-10T12:00:00.000Z')",
      )
      .run(state, INSTALL_ID, state === 'completed' ? '2026-10-10T12:00:00.000Z' : null);
  }
  return { dataDir: dir.path, database };
}
