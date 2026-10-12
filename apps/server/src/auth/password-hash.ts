// The break-glass password check (T-B-192, FR-B-521, SB-04, V-B10): `scrypt` from `node:crypto` against
// the hash of `BREAK_GLASS_PASSWORD_HASH`, and a one-slot queue in front of it.
//
//   password   hashed exactly as the `hash-password` command hashes what it reads: the UTF-8 bytes of the
//              text minus ONE trailing newline (`\n` or `\r\n`). The two must agree or a hash written by
//              the command would never verify.
//   memory     `maxmem` is set from the parsed parameters, `128 * r * (N + p + 2)`: the two buffers
//              scrypt needs. The parameter floors and ceilings (`parseScryptHash`) keep `128 * N * r`
//              at 128 MiB or less, so one verification never needs more than about that (and the
//              container limit is 512 MiB).
//   same work  the password is derived against the configured salt whatever the username is; the
//              username is compared as digests with `timingSafeEqual`, and both comparisons are made
//              before the answer, so an unknown username costs the same as a wrong password.
//   queue      one verification at a time, two waiting; a fourth is refused at once (`QueueFullError`),
//              because a verification takes about 0.6 s and 128 MiB.
import { createHash, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { parseScryptHash } from '@m365portal/shared/auth/scrypt-hash';

export type ScryptFunction = (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number },
  callback: (error: Error | null, derivedKey: Buffer) => void,
) => void;

/** What `hash-password` hashes: the UTF-8 bytes of the text minus one trailing `\n` or `\r\n`. */
export function passwordBytes(password: string): Buffer {
  const trimmed = password.endsWith('\r\n')
    ? password.slice(0, -2)
    : password.endsWith('\n')
      ? password.slice(0, -1)
      : password;
  return Buffer.from(trimmed, 'utf8');
}

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

export interface BreakGlassVerifier {
  /** `true` only for the configured username with the configured password. Never throws for a wrong pair. */
  verify(username: string, password: string): Promise<boolean>;
}

export interface BreakGlassVerifierOptions {
  readonly username: string;
  /** The `scrypt:N:r:p:salt:hash` line of `BREAK_GLASS_PASSWORD_HASH`. */
  readonly passwordHash: string;
  /** For a test that watches the work; default `node:crypto`. */
  readonly scrypt?: ScryptFunction;
}

/** Throws at creation for a hash the configuration would have refused: it never reaches a sign-in. */
export function createBreakGlassVerifier(options: BreakGlassVerifierOptions): BreakGlassVerifier {
  const parsed = parseScryptHash(options.passwordHash);
  if (!parsed.ok) throw new Error(`the break-glass password hash is not acceptable: ${parsed.reason}`);
  const { n, r, p, salt, hash } = parsed.value;
  const expectedHash = Buffer.from(hash);
  const expectedUser = digest(options.username);
  const maxmem = 128 * r * (n + p + 2);
  const derive = options.scrypt ?? nodeScrypt;

  function derived(password: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      derive(
        passwordBytes(password),
        Buffer.from(salt),
        expectedHash.length,
        { N: n, r, p, maxmem },
        (error, key) => {
          if (error === null) resolve(key);
          else reject(error);
        },
      );
    });
  }

  return {
    async verify(username, password) {
      const key = await derived(password);
      const passwordMatches = key.length === expectedHash.length && timingSafeEqual(key, expectedHash);
      const userMatches = timingSafeEqual(digest(username), expectedUser);
      return userMatches && passwordMatches;
    },
  };
}

/** The queue is full: the work was not started. */
export class QueueFullError extends Error {
  constructor() {
    super('queue full');
    this.name = 'QueueFullError';
  }
}

export interface BoundedQueue {
  /** Runs `task` when a slot is free; rejects with `QueueFullError` at once when the line is full. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createBoundedQueue(limits: {
  readonly running: number;
  readonly waiting: number;
}): BoundedQueue {
  let running = 0;
  const waiting: (() => void)[] = [];

  function release(): void {
    running -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  }

  return {
    async run(task) {
      if (running >= limits.running) {
        if (waiting.length >= limits.waiting) throw new QueueFullError();
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      }
      running += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
