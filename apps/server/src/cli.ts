// The command line of the image (FR-A-075, FR-B-110): `node dist/cli.js <command>`.
//
//   verify-audit [--from N] [--to M] [--expect-seq N] [--expect-hash HEX]      Phase A, unchanged
//   generate-app-key    one line of padded base64, 32 random bytes
//   hash-password       the break-glass hash of a password read from standard input
//   rotate-app-key      re-seal the stored secrets under a new APP_KEY (FR-B-109)
//   setup-token, setup-reopen --confirm      owned by the setup engine (S-B3); stubs until T-B-124
//
// `runCli` is synchronous and serves `verify-audit` only (its tests call it as such); the dispatcher
// for every command is the asynchronous `runCommand` (SB-36). Exit codes of every command: 0 success,
// 1 refusal, 2 bad usage or invalid configuration; results go to standard output, never to the
// server logger, so a secret cannot reach a log line.
//
// verify-audit, in detail:
//
// The runtime image has no shell, so the check an operator wants after a restore, an upgrade or an
// incident has to be a Node script. It opens the database READ-ONLY (it cannot change a byte), streams
// the audit table through `verifyChain` and prints the verdict as ONE LINE of JSON:
//
//   {"ok":true,"checked":42,"triggersMissing":[]}
//   {"ok":false,"checked":17,"firstBadSeq":18,"triggersMissing":[]}
//   {"ok":false,"checked":4,"anchorMismatch":true,"triggersMissing":[]}   (tail truncated)
//
// Caveat: the chain alone cannot see rows deleted from the END of the log. Only the anchor can
// (--expect-seq / --expect-hash, the head you recorded earlier).
//
// Exit codes:
//   0  the chain verifies and the three append-only triggers are present
//   1  the chain does not verify, or a trigger is missing (the JSON says which; a database whose
//      triggers were dropped is exactly what someone who edits the log would leave behind)
//   2  it could not check: unknown command or option, invalid configuration, no readable database
//
// The configuration is read through the same schema as the server, so `DATA_DIR` means the same
// thing; an invalid variable is named, never echoed.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { verifyChain } from './audit/chain.js';
import { formatConfigIssues, loadConfig } from './config/index.js';
import { classifyStorageError } from './db/errors.js';
import { databasePathOf, openDatabase } from './db/open.js';
import type { Clock, RandomSource } from './ports/clock.js';
import { runGenerateAppKey } from './cli/commands/generate-app-key.js';
import { runHashPassword } from './cli/commands/hash-password.js';
import { runRotateAppKey } from './cli/commands/rotate-app-key.js';
import { runSetupReopen } from './cli/commands/setup-reopen.js';
import { runSetupToken } from './cli/commands/setup-token.js';

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

/** What `hash-password` reads: standard input, which is a terminal or a pipe. */
export interface CommandStdin {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  once(event: 'end', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** The streams and sources of a command; a test passes its own. */
export interface CommandIo extends CliIo {
  readonly stdin?: CommandStdin;
  readonly random?: RandomSource;
  readonly now?: Clock['now'];
}

const USAGE =
  'usage: node dist/cli.js verify-audit [--from <seq>] [--to <seq>] [--expect-seq <seq>] [--expect-hash <hex>]\n' +
  'note: the hash chain alone cannot see rows deleted from the END of the log (with the append-only\n' +
  'triggers dropped). Pass the newest seq and hash you recorded (the audit head log line) as\n' +
  '--expect-seq / --expect-hash to detect it.\n';

interface Range {
  from?: number;
  to?: number;
  expectSeq?: number;
  expectHash?: string;
}

/** `--from 3`, `--from=3`, `--to 9`; anything else is a usage error (`undefined`). */
function parseRange(args: readonly string[]): Range | undefined {
  const range: Range = {};
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    const [name, inline] = arg.split('=', 2);
    if (
      name !== '--from' &&
      name !== '--to' &&
      name !== '--expect-seq' &&
      name !== '--expect-hash'
    ) {
      return undefined;
    }
    const raw = inline ?? args[(at += 1)];
    if (raw === undefined) return undefined;
    if (name === '--expect-hash') {
      if (!/^[0-9a-fA-F]{64}$/.test(raw)) return undefined;
      range.expectHash = raw.toLowerCase();
      continue;
    }
    if (!/^[1-9]\d{0,15}$/.test(raw)) return undefined;
    if (name === '--expect-seq') range.expectSeq = Number(raw);
    else range[name === '--from' ? 'from' : 'to'] = Number(raw);
  }
  if (range.from !== undefined && range.to !== undefined && range.to < range.from) return undefined;
  return range;
}

export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  const range = command === 'verify-audit' ? parseRange(rest) : undefined;
  if (range === undefined) {
    io.stderr.write(USAGE);
    return 2;
  }

  const loaded = loadConfig(io.env);
  if (!loaded.ok) {
    io.stderr.write(formatConfigIssues(loaded.issues));
    return 2;
  }

  let verdict: ReturnType<typeof verifyChain>;
  try {
    const database = openDatabase({ path: databasePathOf(loaded.config.dataDir), readonly: true });
    try {
      verdict = verifyChain(database.sqlite, range);
    } finally {
      database.close();
    }
  } catch (error) {
    // The name of the failure, never its message: it may hold a path.
    const failure = classifyStorageError(error);
    const code = failure?.kind === 'corrupt' ? 'database_corrupt' : 'database_unavailable';
    io.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    return 2;
  }

  io.stdout.write(`${JSON.stringify(verdict)}\n`);
  return verdict.ok ? 0 : 1;
}

const COMMAND_USAGE =
  'usage: node dist/cli.js <command>\n' +
  '  generate-app-key                       print a new APP_KEY (32 random bytes, base64)\n' +
  '  hash-password                          read a password from standard input, print the break-glass hash\n' +
  '  rotate-app-key                         re-seal the stored secrets: APP_KEY (new) and APP_KEY_PREVIOUS (old)\n' +
  '  setup-token                            print the setup token\n' +
  '  setup-reopen --confirm                 reopen the setup wizard\n' +
  '  verify-audit [--from <seq>] [--to <seq>] [--expect-seq <seq>] [--expect-hash <hex>]\n';

type Command = (args: readonly string[], io: CommandIo) => Promise<number>;

const COMMANDS: Readonly<Record<string, Command>> = Object.freeze({
  'generate-app-key': runGenerateAppKey,
  'hash-password': runHashPassword,
  'rotate-app-key': runRotateAppKey,
  'setup-token': runSetupToken,
  'setup-reopen': runSetupReopen,
  'verify-audit': (args, io) => Promise.resolve(runCli(['verify-audit', ...args], io)),
});

/**
 * The dispatcher (SB-36): runs one command and resolves with its exit code. An unknown command or no
 * command prints the usage on standard error and is exit 2.
 */
export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  const [name, ...args] = argv;
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    io.stderr.write(COMMAND_USAGE);
    return 2;
  }
  return command(args, io);
}

// Run when started as a script (`node dist/cli.js ...`, `tsx src/cli.ts ...`), not when imported.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCommand(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  });
}
