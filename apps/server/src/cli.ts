// The command line of the image (FR-A-075): `node dist/cli.js verify-audit [--from N] [--to M]
// [--expect-seq N] [--expect-hash HEX]`.
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

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
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

// Run when started as a script (`node dist/cli.js ...`, `tsx src/cli.ts ...`), not when imported.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
