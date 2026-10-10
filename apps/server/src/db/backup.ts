// The pre-migration backup (FR-A-064, data-model sections 2 and 8.2): a consistent copy of the
// database, taken with the SQLite online backup API before pending migrations touch a database that
// already has applied ones, into `${DATA_DIR}/backups/pre-migrate-<from>-<to>.sqlite`. `<from>` is
// the schema version the database is at and `<to>` the one the migrations take it to, both four
// digits (`pre-migrate-0000-0001.sqlite`). Only the newest 3 are kept.
//
// A copy made with `cp` while the database is open can be torn (the main file and the write-ahead
// log are two files); the backup API gives a snapshot that is consistent as of one moment. The copy
// is written under a `.partial` name and renamed when it is complete, so a crash or a full disk never
// leaves something that looks like a backup and is not.
//
// The backups hold the audit log and therefore client addresses: they have the same protection (the
// process umask, directory 0700) and the same personal-data status as the live database.
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import type { SqliteConnection } from './open.js';

export const BACKUPS_DIR_NAME = 'backups';

/** `${dataDir}/backups`. */
export function backupsDirOf(dataDir: string): string {
  return join(dataDir, BACKUPS_DIR_NAME);
}

function padded(version: number): string {
  return String(version).padStart(4, '0');
}

/** `pre-migrate-0000-0001.sqlite`. */
export function backupFileName(from: number, to: number): string {
  return `pre-migrate-${padded(from)}-${padded(to)}.sqlite`;
}

export interface Backup {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

function parseBackupName(name: string): Backup | undefined {
  const match = /^pre-migrate-(\d{4,})-(\d{4,})\.sqlite$/.exec(name);
  if (match === null) return undefined;
  return { name, from: Number(match[1]), to: Number(match[2]) };
}

/**
 * The backups in a directory, oldest first. The order is the order of the versions (`to`, then
 * `from`), read as numbers: `0009-0010` is newer than `0008-0009`, which a sort by name gets right
 * only until the fifth digit. A missing directory has none. Files that are not backups are ignored.
 */
export function listBackups(backupsDir: string): Backup[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map(parseBackupName)
    .filter((backup): backup is Backup => backup !== undefined)
    .sort((a, b) => a.to - b.to || a.from - b.from);
}

/** Delete all but the newest `keep` backups, and any `.partial` file an earlier crash left. */
export function pruneBackups(
  backupsDir: string,
  keep: number = LIMITS.preMigrationBackupsKept,
): string[] {
  const removed: string[] = [];
  const backups = listBackups(backupsDir);
  for (const backup of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(backupsDir, backup.name), { force: true });
    removed.push(backup.name);
  }
  for (const name of readdirSync(backupsDir)) {
    if (/^pre-migrate-\d{4,}-\d{4,}\.sqlite\.partial$/.test(name)) {
      rmSync(join(backupsDir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export interface BackupOptions {
  readonly backupsDir: string;
  readonly from: number;
  readonly to: number;
  /** How many backups to keep. Default: `LIMITS.preMigrationBackupsKept`. */
  readonly keep?: number;
}

/** Copy `db` into the backups directory and prune the old ones. Returns the file name. */
export async function takeBackup(db: SqliteConnection, options: BackupOptions): Promise<string> {
  const name = backupFileName(options.from, options.to);
  const finalPath = join(options.backupsDir, name);
  const partialPath = `${finalPath}.partial`;

  mkdirSync(options.backupsDir, { recursive: true, mode: 0o700 });
  try {
    await db.backup(partialPath);
    // Replaces a copy of the same name: a migration that failed and is tried again.
    renameSync(partialPath, finalPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
  pruneBackups(options.backupsDir, options.keep ?? LIMITS.preMigrationBackupsKept);
  return name;
}
