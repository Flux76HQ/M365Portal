// Key rotation (FR-B-109, EB-34, plan 7.5): re-seal every `secret` row from the previous key to the
// new one. A pure function of ports: the database, the two keys, the clock, the random source and
// the folder for the safety copy. The CLI (`cli/commands/rotate-app-key.ts`) wraps it.
//
//   1. refuse unless the keys are two different 32-byte keys, and no setup run holds the lease;
//   2. nothing to do (every row already on the new key, or no rows): return `rows: 0` and write
//      nothing, so a second run is a no-op (no copy, no audit entry);
//   3. copy the database with the SQLite backup API to `backups/pre-rotate-<UTC>.sqlite`; the newest
//      3 are kept, counted apart from `pre-migrate-*` (data-model 2);
//   4. ONE `BEGIN IMMEDIATE` transaction: pick the key by the stored `key_id` (neither matches: abort,
//      nothing changed), skip rows already on the new key, open, seal again with a fresh nonce under
//      the SAME `secret.id` and purpose, update `blob` and `key_id`; audit `secrets.app_key.rotate`
//      (actor `cli`: `rows`, `fromKeyId`, `toKeyId`) in the same transaction.
//
// Rotation re-seals the same private key under the new key; it does not renew the certificate. No
// key is printed, logged or put into a file name: errors carry a code only.
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { Clock, RandomSource } from '../ports/clock.js';
import { keyId } from './app-key.js';
import { openSecret, sealSecret, wipe, initSealedBox } from './sealed-box.js';

export type RotationErrorCode = 'keys_equal' | 'key_invalid' | 'run_active' | 'unknown_key_id';

export class RotationError extends Error {
  readonly code: RotationErrorCode;

  constructor(code: RotationErrorCode) {
    super(`rotation refused: ${code}`);
    this.name = 'RotationError';
    this.code = code;
  }
}

export interface RotateDeps {
  /** The open database; its connection also takes the safety copy. */
  readonly db: DatabaseHandle;
  readonly newKey: Uint8Array;
  readonly previousKey: Uint8Array;
  readonly clock: Clock;
  /** Reserved for symmetry with the other secrets services; the nonces come from libsodium. */
  readonly random: RandomSource;
  /** `${DATA_DIR}/backups`. */
  readonly backupsDir: string;
  /** The audit writer; a test replaces it to inject a fault. */
  readonly appendAudit?: typeof appendAudit;
}

export interface RotationResult {
  readonly rows: number;
  /** The file name of the safety copy, or `null` when there was nothing to do. */
  readonly backup: string | null;
}

interface SecretRow {
  readonly id: string;
  readonly purpose: string;
  readonly key_id: string;
  readonly blob: Buffer;
}

const COPY_PREFIX = 'pre-rotate-';
const COPY_PATTERN = /^pre-rotate-\d{8}T\d{6}Z\.sqlite$/;

/** `20261010T120000Z`: sortable, without the characters a file name dislikes. */
function stamp(milliseconds: number): string {
  return new Date(milliseconds)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function pruneCopies(backupsDir: string, keep: number): void {
  const copies = readdirSync(backupsDir)
    .filter((name) => COPY_PATTERN.test(name))
    .sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - keep))) {
    rmSync(join(backupsDir, name), { force: true });
  }
  for (const name of readdirSync(backupsDir)) {
    if (name.startsWith(COPY_PREFIX) && name.endsWith('.partial')) {
      rmSync(join(backupsDir, name), { force: true });
    }
  }
}

async function takeCopy(db: DatabaseHandle, backupsDir: string, now: number): Promise<string> {
  const name = `${COPY_PREFIX}${stamp(now)}.sqlite`;
  const finalPath = join(backupsDir, name);
  const partialPath = `${finalPath}.partial`;
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  try {
    await db.sqlite.backup(partialPath);
    renameSync(partialPath, finalPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
  pruneCopies(backupsDir, LIMITS.preMigrationBackupsKept);
  return name;
}

function assertKeys(newKey: Uint8Array, previousKey: Uint8Array): void {
  const size = LIMITS.secrets.appKeyBytes;
  if (newKey.length !== size || previousKey.length !== size) throw new RotationError('key_invalid');
  if (keyId(newKey) === keyId(previousKey)) throw new RotationError('keys_equal');
}

function runIsActive(db: DatabaseHandle, now: number): boolean {
  const lease = db.sqlite.prepare('SELECT expires_at FROM runner_lease WHERE id = 1').get() as
    { expires_at: string } | undefined;
  return lease !== undefined && Date.parse(lease.expires_at) > now;
}

const SELECT_ROWS = 'SELECT id, purpose, key_id, blob FROM secret ORDER BY created_at, id';

export async function rotateAppKey(deps: RotateDeps): Promise<RotationResult> {
  await initSealedBox();
  assertKeys(deps.newKey, deps.previousKey);
  const now = deps.clock.now();
  if (runIsActive(deps.db, now)) throw new RotationError('run_active');

  const toId = keyId(deps.newKey);
  const fromId = keyId(deps.previousKey);

  // Decide before copying anything: a row under a third key is a refusal, a run with nothing to do
  // is a no-op. Both leave the disk as it is.
  const initial = deps.db.sqlite.prepare(SELECT_ROWS).all() as SecretRow[];
  for (const row of initial) {
    if (row.key_id !== toId && row.key_id !== fromId) throw new RotationError('unknown_key_id');
  }
  if (initial.every((row) => row.key_id === toId)) return { rows: 0, backup: null };

  const backup = await takeCopy(deps.db, deps.backupsDir, now);
  const audit = deps.appendAudit ?? appendAudit;

  const rows = withTransaction(deps.db, (tx) => {
    // Read again inside the write lock: what the transaction changes is what it just saw.
    const current = tx.sqlite.prepare(SELECT_ROWS).all() as SecretRow[];
    let changed = 0;
    for (const row of current) {
      if (row.key_id === toId) continue;
      if (row.key_id !== fromId) throw new RotationError('unknown_key_id');
      const plaintext = openSecret(deps.previousKey, row.blob, {
        purpose: row.purpose,
        secretId: row.id,
        keyId: row.key_id,
      });
      // `sealSecret` takes the plaintext over and zeroes it.
      const blob = sealSecret(deps.newKey, plaintext, {
        purpose: row.purpose,
        secretId: row.id,
        keyId: toId,
      });
      tx.sqlite
        .prepare('UPDATE secret SET blob = ?, key_id = ? WHERE id = ?')
        .run(Buffer.from(blob), toId, row.id);
      wipe(blob);
      changed += 1;
    }
    if (changed === 0) return 0;
    audit(tx, {
      ts: new Date(now).toISOString(),
      actorKind: 'cli',
      actorId: 'cli',
      action: 'secrets.app_key.rotate',
      targetType: 'secret',
      targetId: '',
      outcome: 'success',
      detail: { rows: changed, fromKeyId: fromId, toKeyId: toId },
    });
    return changed;
  });
  return { rows, backup };
}
