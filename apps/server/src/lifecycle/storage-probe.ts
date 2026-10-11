// The storage probe (plan 7.1 step 4, E-10): can this process create and delete a file in `DATA_DIR`?
//
// `mode & W_OK` would be the cheap answer and the wrong one: the process runs as root in the
// sandbox and in many containers, and root ignores mode bits. The probe does the thing the
// application is about to do, and asks nothing else of the file system. It reports only whether it
// worked: the error (which holds a path) stays here.
import { randomBytes } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `true` when a file could be created and removed again. Never throws. */
export type StorageProbe = () => boolean;

/** The two file operations of the probe, replaceable by a test that needs one of them to fail. */
export interface ProbeIo {
  write(path: string): void;
  remove(path: string): void;
}

const PROBE_FILE_PREFIX = '.write-probe-';

const nodeIo: ProbeIo = {
  // `wx`: never overwrite a file that happens to have the name; 0600 like everything under /data.
  write: (path) => {
    writeFileSync(path, 'probe', { flag: 'wx', mode: 0o600 });
  },
  remove: (path) => {
    unlinkSync(path);
  },
};

export function createStorageProbe(dataDir: string, io: ProbeIo = nodeIo): StorageProbe {
  return () => {
    const path = join(dataDir, `${PROBE_FILE_PREFIX}${randomBytes(6).toString('hex')}`);
    try {
      io.write(path);
      io.remove(path);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Create the data directory (and its parents) with mode 0700 when it is missing. Throws when that
 * is not possible, for example when a parent is a regular file; the caller turns that into degraded
 * mode.
 */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
