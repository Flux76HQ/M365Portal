// A `DATA_DIR` where creating a file fails, for the degraded-mode and readiness tests (E-10).
//
// The obvious way, `chmod 0500`, proves nothing here: the sandbox and the CI containers run as root,
// and root ignores mode bits, so the directory would stay writable and the test would pass for the
// wrong reason. Instead the path points BELOW A REGULAR FILE: every attempt to create a directory or
// a file there fails with ENOTDIR, whoever asks.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterCurrentTest } from './temp-data-dir.js';

export interface UnwritableDataDir {
  /** A path that cannot be created or written to: its parent is a regular file. */
  readonly path: string;
  /** Delete the file that blocks the path. Safe to call more than once. */
  remove(): Promise<void>;
}

export async function unwritableDataDir(): Promise<UnwritableDataDir> {
  const root = await mkdtemp(join(tmpdir(), 'm365portal-unwritable-'));
  const blocker = join(root, 'not-a-directory');
  await writeFile(blocker, 'a regular file where a directory would have to be');
  const remove = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  };
  afterCurrentTest(remove);
  return { path: join(blocker, 'data'), remove };
}
