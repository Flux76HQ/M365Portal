// `rotate-app-key` (FR-B-109, plan 7.5): the new key from `APP_KEY` or `APP_KEY_FILE`, the old key
// from `APP_KEY_PREVIOUS` or `APP_KEY_PREVIOUS_FILE`; copies the database, re-seals every secret row
// in one transaction and prints `rows: n` (0 when there was nothing to do). Exit 0 on success, 1 on a
// refusal (a key missing or unreadable, a row under a third key, a run in progress, no database),
// 2 for an invalid configuration. A key, a path and an error text are never printed: only codes.
import { existsSync } from 'node:fs';
import { loadConfig, formatConfigIssues } from '../../config/index.js';
import { backupsDirOf } from '../../db/backup.js';
import { databasePathOf, openDatabase } from '../../db/open.js';
import { loadKey, type LoadedKey } from '../../secrets/key-source.js';
import { RotationError, rotateAppKey } from '../../secrets/rotate.js';
import { SecretDecryptError } from '../../secrets/sealed-box.js';
import { systemRandom } from '../../system-random.js';
import type { CommandIo } from '../../cli.js';

export const ROTATE_APP_KEY_USAGE =
  'usage: node dist/cli.js rotate-app-key   (keys from APP_KEY / APP_KEY_FILE and APP_KEY_PREVIOUS / APP_KEY_PREVIOUS_FILE)\n';

function keyOrRefusal(loaded: LoadedKey, names: string, io: CommandIo): Uint8Array | undefined {
  if (loaded.status === 'loaded') return loaded.key;
  const why =
    loaded.status === 'invalid'
      ? 'is not a valid key'
      : loaded.status === 'missing'
        ? 'cannot be read'
        : 'is not set';
  io.stderr.write(`rotate-app-key: refused: ${names} ${why}\n`);
  return undefined;
}

export async function runRotateAppKey(args: readonly string[], io: CommandIo): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(ROTATE_APP_KEY_USAGE);
    return 2;
  }
  const loaded = loadConfig(io.env);
  if (!loaded.ok) {
    io.stderr.write(formatConfigIssues(loaded.issues));
    return 2;
  }
  const { config } = loaded;

  const newKey = keyOrRefusal(loadKey(config.appKey), 'APP_KEY or APP_KEY_FILE', io);
  const previousKey = keyOrRefusal(
    loadKey(config.appKeyPrevious),
    'APP_KEY_PREVIOUS or APP_KEY_PREVIOUS_FILE',
    io,
  );
  if (newKey === undefined || previousKey === undefined) return 1;

  const path = databasePathOf(config.dataDir);
  let database: ReturnType<typeof openDatabase>;
  try {
    // Opening for writing would create an empty database: only an existing one is rotated.
    if (!existsSync(path)) throw new Error('no database');
    database = openDatabase({ path });
  } catch {
    io.stderr.write('rotate-app-key: refused: there is no usable database in DATA_DIR\n');
    return 1;
  }
  try {
    const result = await rotateAppKey({
      db: database,
      newKey,
      previousKey,
      clock: { now: io.now ?? (() => Date.now()) },
      random: io.random ?? systemRandom,
      backupsDir: backupsDirOf(config.dataDir),
    });
    io.stdout.write(`rows: ${String(result.rows)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RotationError) {
      io.stderr.write(`rotate-app-key: refused: ${error.code}\n`);
    } else if (error instanceof SecretDecryptError) {
      io.stderr.write('rotate-app-key: refused: a row could not be opened with the previous key\n');
    } else {
      io.stderr.write(
        'rotate-app-key: failed: the database could not be updated (nothing was changed)\n',
      );
    }
    return 1;
  } finally {
    database.close();
  }
}
