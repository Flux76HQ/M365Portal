// The setup token (T-B-124, FR-B-203, FR-B-223, EB-01, EB-37).
//
// The token comes from `SETUP_TOKEN` when that is set, otherwise from the file `${DATA_DIR}/setup-token`,
// which is created at the first start while the state is not `completed`: 32 random bytes, base64url,
// mode 0600, written with `O_EXCL` so an existing file is never overwritten while setup is open. The
// file is deleted when the state becomes `completed` and at start if it lingers.
//
// A candidate is compared as SHA-256 digests with `timingSafeEqual`, so neither the length of the
// expected token nor the position of the first differing byte shows in the time. The token is accepted
// in the body of `POST /api/v1/setup/unlock` and nowhere else; this module has no function that logs,
// serialises or returns it other than `reveal()`, which only the `setup-token` command uses.
//
// The file is read again only when its modification time changed, so an operator who replaces it (the
// `setup-reopen` command writes a new one) is obeyed on the next request.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { LIMITS } from '@m365portal/shared/limits';
import type { SecretText } from '../config/secret-text.js';
import type { RandomSource } from '../ports/clock.js';

export const SETUP_TOKEN_FILE_NAME = 'setup-token';

export function setupTokenPath(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILE_NAME);
}

export interface SetupTokenOptions {
  /** `SETUP_TOKEN` from the configuration, or `undefined`. */
  readonly envToken: SecretText | undefined;
  readonly dataDir: string;
  readonly random: RandomSource;
}

export type SetupTokenSource = 'env' | 'file' | 'none';

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** Constant-time equality of two strings, through SHA-256 digests of the same length. */
export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

export class SetupToken {
  readonly #options: SetupTokenOptions;
  #cache: { readonly mtimeMs: number; readonly size: number; readonly value: string } | undefined;

  constructor(options: SetupTokenOptions) {
    this.#options = options;
  }

  get path(): string {
    return setupTokenPath(this.#options.dataDir);
  }

  /** Where the expected token comes from right now. */
  source(): SetupTokenSource {
    if (this.#options.envToken !== undefined) return 'env';
    return existsSync(this.path) ? 'file' : 'none';
  }

  /**
   * Make sure the file exists while setup is open and no environment token is set. Returns what
   * happened. Never overwrites a file that is there.
   */
  ensureFile(): 'created' | 'exists' | 'env' {
    if (this.#options.envToken !== undefined) return 'env';
    mkdirSync(this.#options.dataDir, { recursive: true, mode: 0o700 });
    const token = Buffer.from(this.#options.random.bytes(LIMITS.setup.tokenBytes)).toString(
      'base64url',
    );
    let descriptor: number;
    try {
      descriptor = openSync(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (failure) {
      if ((failure as { code?: unknown } | null)?.code === 'EEXIST') return 'exists';
      throw failure;
    }
    try {
      writeSync(descriptor, `${token}\n`);
    } finally {
      closeSync(descriptor);
    }
    return 'created';
  }

  /** Delete the file. True when there was one. */
  remove(): boolean {
    const existed = existsSync(this.path);
    rmSync(this.path, { force: true });
    this.#cache = undefined;
    return existed;
  }

  /** The expected token: the environment's, else the file's (trimmed), else `undefined`. */
  #expected(): string | undefined {
    if (this.#options.envToken !== undefined) return this.#options.envToken.reveal();
    try {
      const stat = statSync(this.path);
      if (this.#cache?.mtimeMs !== stat.mtimeMs || this.#cache.size !== stat.size) {
        this.#cache = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          value: readFileSync(this.path, 'utf8').trim(),
        };
      }
      return this.#cache.value === '' ? undefined : this.#cache.value;
    } catch {
      this.#cache = undefined;
      return undefined;
    }
  }

  /** Is there a token a candidate can match? */
  available(): boolean {
    return this.#expected() !== undefined;
  }

  /** Constant-time comparison. A missing token matches nothing (the comparison still runs). */
  verify(candidate: string): boolean {
    const expected = this.#expected();
    const equal = constantTimeEqual(candidate, expected ?? '');
    return expected !== undefined && equal;
  }

  /** The token itself: for the `setup-token` command, which prints it, and for nothing else. */
  reveal(): string | undefined {
    return this.#expected();
  }

  toJSON(): string {
    return '[setup token]';
  }

  [inspect.custom](): string {
    return '[setup token]';
  }
}
