// `hash-password` (FR-B-110, FR-B-521, plan 7.7): reads a password from standard input WITHOUT echo
// and prints the break-glass hash `scrypt:131072:8:1:<salt>:<hash>` (16-byte salt, 32-byte hash) that
// `BREAK_GLASS_PASSWORD_HASH` takes. The password is the UTF-8 text typed, minus one trailing
// newline; it is never an argument (it would be in the process list) and never printed.
//
// Refused with exit 1 and nothing on standard output: fewer than 14 characters, or fewer than 6
// distinct characters (characters are code points, not bytes). The refusal says which rule, never the
// password. On a terminal the input is read in raw mode so nothing is echoed; from a pipe it is read
// whole (at most 4,096 bytes, the size of an authentication body).
import { scrypt } from 'node:crypto';
import { formatScryptHash } from '@m365portal/shared/auth/scrypt-hash';
import { LIMITS } from '@m365portal/shared/limits';
import { systemRandom } from '../../system-random.js';
import type { CommandIo, CommandStdin } from '../../cli.js';

export const HASH_PASSWORD_USAGE =
  'usage: node dist/cli.js hash-password   (the password is read from standard input)\n';

/** FR-B-110: a password with fewer distinct characters is refused. */
export const PASSWORD_MIN_DISTINCT_CHARS = 6;
const MAX_INPUT_BYTES = 4096;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const N = LIMITS.breakGlass.scrypt.nMax;
const R = 8;
const P = 1;
/** Node needs a ceiling above `128 * N * r` (128 MiB); the format caps the cost at that figure. */
const MAX_MEMORY_BYTES = 2 * LIMITS.breakGlass.scrypt.maxMemoryBytes;

class InputTooLargeError extends Error {}

function readPiped(stdin: CommandStdin): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stdin.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new InputTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    stdin.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stdin.once('error', reject);
  });
}

/** Raw mode: characters arrive one at a time and are not echoed. Enter ends, Ctrl-C and Ctrl-D abort. */
function readTyped(stdin: CommandStdin, prompt: { write(text: string): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    let typed = '';
    prompt.write('Password: ');
    stdin.setRawMode?.(true);
    stdin.resume();
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      prompt.write('\n');
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === '\r' || character === '\n') {
          finish();
          resolve(typed);
          return;
        }
        if (character === '\u0003' || character === '\u0004') {
          finish();
          reject(new InputTooLargeError());
          return;
        }
        if (character === '\u007f' || character === '\b') {
          typed = Array.from(typed).slice(0, -1).join('');
        } else {
          typed += character;
        }
        if (Buffer.byteLength(typed) > MAX_INPUT_BYTES) {
          finish();
          reject(new InputTooLargeError());
          return;
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** The password without one trailing `\n` or `\r\n`. */
function trimNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function hashOf(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      HASH_BYTES,
      { N, r: R, p: P, maxmem: MAX_MEMORY_BYTES },
      (error, derived) => {
        if (error === null) resolve(new Uint8Array(derived));
        else reject(error);
      },
    );
  });
}

export async function runHashPassword(args: readonly string[], io: CommandIo): Promise<number> {
  if (args.length > 0 || io.stdin === undefined) {
    io.stderr.write(HASH_PASSWORD_USAGE);
    return 2;
  }
  let password: string;
  try {
    const raw =
      io.stdin.isTTY === true && io.stdin.setRawMode !== undefined
        ? await readTyped(io.stdin, io.stderr)
        : trimNewline(await readPiped(io.stdin));
    password = raw;
  } catch (error) {
    io.stderr.write(
      error instanceof InputTooLargeError
        ? 'hash-password: the password was not accepted (aborted or longer than 4,096 bytes)\n'
        : 'hash-password: the password could not be read\n',
    );
    return 1;
  }

  const characters = Array.from(password);
  if (characters.length < LIMITS.breakGlass.passwordMinChars) {
    io.stderr.write(
      `hash-password: refused: the password has fewer than ${String(LIMITS.breakGlass.passwordMinChars)} characters\n`,
    );
    return 1;
  }
  if (new Set(characters).size < PASSWORD_MIN_DISTINCT_CHARS) {
    io.stderr.write(
      `hash-password: refused: the password has fewer than ${String(PASSWORD_MIN_DISTINCT_CHARS)} distinct characters\n`,
    );
    return 1;
  }

  const salt = (io.random ?? systemRandom).bytes(SALT_BYTES);
  const hash = await hashOf(password, salt);
  io.stdout.write(`${formatScryptHash({ n: N, r: R, p: P, salt, hash })}\n`);
  return 0;
}
