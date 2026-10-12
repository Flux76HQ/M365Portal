// `generate-app-key` (FR-B-110, plan 7.7): 32 random bytes as padded base64, one line, nothing else.
// It reads nothing and writes nothing but that line to standard output. The key must pass the same
// rules the server applies to `APP_KEY` (not all bytes equal, at least 16 distinct byte values), so a
// generated key is never refused later; with random bytes that is a formality that is still checked.
import { parseAppKey } from '../../secrets/app-key.js';
import { systemRandom } from '../../system-random.js';
import type { CommandIo } from '../../cli.js';

export const GENERATE_APP_KEY_USAGE = 'usage: node dist/cli.js generate-app-key\n';

export function runGenerateAppKey(args: readonly string[], io: CommandIo): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(GENERATE_APP_KEY_USAGE);
    return Promise.resolve(2);
  }
  const random = io.random ?? systemRandom;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const text = Buffer.from(random.bytes(32)).toString('base64');
    if (parseAppKey(text).ok) {
      io.stdout.write(`${text}\n`);
      return Promise.resolve(0);
    }
  }
  io.stderr.write('generate-app-key: the random source did not give a usable key\n');
  return Promise.resolve(1);
}
