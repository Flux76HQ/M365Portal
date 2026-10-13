// The process-level worker stand-in with meaning (GD1 e2e topology): a Node program that speaks the
// protocol of `@m365portal/shared/exchange/protocol` on stdin and stdout, like `worker-script.ps1`, over
// the fake Exchange state of this directory (`runCmdlet`, the same rules the unit tests run against). It is
// what the `pwsh` shim (`e2e/support/pwsh-shim/pwsh`) starts, through `standin-process.mjs --semantic`.
//
// What it does like the script: the shared parser for every line (anything else is `invalid_argument`); a
// call before the connect is `not_connected`; the connect and the ping answer the two manifest hashes; a
// call goes to `runCmdlet`; no answer holds text of a request; `shutdown` answers and exits; a closed
// stdin ends it. The connect also checks, like the real thing would have to, that the PEM key belongs to
// the PEM certificate (a mismatch is `permission_denied`), and in the `tmpfs` mode it plays the script's
// file handling (three files of mode 0600 for the duration of the connect).
//
// What is different from a unit test stand-in: the process is recycled by the product (call count, age),
// and the data must survive that. So the state is: the SEED (`<shim dir>/seed.json`, else the default
// seed), plus a JOURNAL of the writes applied since, replayed when a new process starts. The journal is
// a file in the temporary directory named after the parent (server) process, so two servers do not share
// one and a stale file of a dead server is removed. The seed file is read on every request: a changed
// seed (an e2e test that wants other data) replaces the state at once and empties the journal.
import { X509Certificate, createHash, createPrivateKey } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import {
  createLineDecoder,
  encodeLine,
  parseRequestLine,
  type ExchangeErrorCode,
} from '@m365portal/shared/exchange/protocol';
import {
  ALLOW_LIST_MANIFEST_SHA256,
  PROJECTION_MANIFEST_SHA256,
} from '../../../../src/integrations/exchange/pwsh/generated-allow-list.js';
import { runCmdlet } from './cmdlets.js';
import { DEFAULT_SEED, buildState, parseSeed, type StandInSeed } from './standin-seed.js';
import type { FakeExchangeState } from './state.js';

const WRITE_CMDLETS = new Set([
  'Add-DistributionGroupMember',
  'Remove-DistributionGroupMember',
  'New-MailContact',
  'Set-MailContact',
  'Remove-MailContact',
]);

/** The budget of one answer line for rows, as the script computes it (`LineMaxBytes - 4096`). */
const ROW_BUDGET_BYTES = LIMITS.exchange.lineMaxBytes - 4096;

/**
 * What `Get-ResultData` of the script does: rows are kept in order until the budget of one line is used up;
 * the rest is dropped and `truncated` says so (the client then asks the caller to narrow the search).
 */
function fitRows(data: Record<string, unknown>): Record<string, unknown> {
  const rows = data.rows;
  if (!Array.isArray(rows)) return data;
  let used = 0;
  const kept: unknown[] = [];
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (used + size > ROW_BUDGET_BYTES) return { ...data, rows: kept, truncated: true };
    used += size;
    kept.push(row);
  }
  return data;
}

const JOURNAL_PREFIX = 'm365portal-standin-';

const valueAfter = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === 'EPERM';
  }
};

interface World {
  state: FakeExchangeState;
  seed: StandInSeed;
  seedHash: string;
}

/** Owns the state: the seed, the journal and the check that the seed file did not change. */
function createWorld(options: { readonly seedFile: string | undefined; readonly journal: string }) {
  let world: World | undefined;

  const readSeed = (): { seed: StandInSeed; hash: string } => {
    if (options.seedFile === undefined || !existsSync(options.seedFile)) {
      return { seed: DEFAULT_SEED, hash: 'default' };
    }
    const text = readFileSync(options.seedFile, 'utf8');
    return {
      seed: parseSeed(JSON.parse(text) as unknown),
      hash: createHash('sha256').update(text).digest('hex'),
    };
  };

  const start = (seed: StandInSeed, hash: string): World => {
    const state = buildState(seed);
    let replay: string[] = [];
    if (existsSync(options.journal)) {
      const [header, ...entries] = readFileSync(options.journal, 'utf8').split('\n');
      if (header === JSON.stringify({ seed: hash })) replay = entries.filter((line) => line !== '');
      else writeFileSync(options.journal, `${JSON.stringify({ seed: hash })}\n`);
    } else {
      writeFileSync(options.journal, `${JSON.stringify({ seed: hash })}\n`);
    }
    for (const line of replay) {
      const entry = JSON.parse(line) as { cmdlet: string; args: Record<string, unknown> };
      runCmdlet(state, entry.cmdlet, entry.args);
    }
    return { state, seed, seedHash: hash };
  };

  return {
    /** The current world; rebuilt when the seed file changed since the last request. */
    current(): World {
      const { seed, hash } = readSeed();
      if (world === undefined) {
        world = start(seed, hash);
      } else if (world.seedHash !== hash) {
        writeFileSync(options.journal, `${JSON.stringify({ seed: hash })}\n`);
        world = { state: buildState(seed), seed, seedHash: hash };
      }
      return world;
    },
    journal(cmdlet: string, args: Record<string, unknown>): void {
      appendFileSync(options.journal, `${JSON.stringify({ cmdlet, args })}\n`);
    },
  };
}

/** Removes the journals of servers that are gone. */
function sweepJournals(directory: string): void {
  for (const name of readdirSync(directory)) {
    const match = new RegExp(`^${JOURNAL_PREFIX}(\\d+)\\.ndjson$`).exec(name);
    if (match?.[1] !== undefined && !alive(Number(match[1]))) {
      rmSync(join(directory, name), { force: true });
    }
  }
}

/** The key belongs to the certificate: what `CreateFromPem` would refuse otherwise. */
function pairMatches(certificatePem: string, privateKeyPem: string): boolean {
  try {
    return new X509Certificate(certificatePem).checkPrivateKey(createPrivateKey(privateKeyPem));
  } catch {
    return false;
  }
}

export function runSemanticStandIn(args: readonly string[]): void {
  const shimDirectory = valueAfter(args, '--shim-dir');
  const mode = valueAfter(args, '-CertificateMode') ?? 'memory';
  const scratch = valueAfter(args, '-ScratchDirectory');
  const directory = tmpdir();
  mkdirSync(directory, { recursive: true });
  sweepJournals(directory);
  const world = createWorld({
    seedFile: shimDirectory === undefined ? undefined : join(shimDirectory, 'seed.json'),
    journal: join(directory, `${JOURNAL_PREFIX}${String(process.ppid)}.ndjson`),
  });
  let connected = false;

  const send = (message: unknown): void => {
    process.stdout.write(encodeLine(message));
  };
  const ok = (id: string, data: unknown): void => {
    send({ v: 1, id, ok: true, data });
  };
  const fail = (id: string, code: ExchangeErrorCode, retryAfterMs?: number): void => {
    send({
      v: 1,
      id,
      ok: false,
      error: { code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
    });
  };
  const hello = (): Record<string, unknown> => ({
    allowListSha256: ALLOW_LIST_MANIFEST_SHA256,
    projectionSha256: PROJECTION_MANIFEST_SHA256,
    moduleVersion: '3.10.1',
    psVersion: '7.6.6',
    mode,
    connected,
  });

  /** The fallback mode as the script plays it: the files exist while the connect runs, then they are gone. */
  const withScratchFiles = (certificate: string, privateKey: string, connect: () => void): void => {
    if (mode !== 'tmpfs' || scratch === undefined) {
      connect();
      return;
    }
    const token = createHash('sha256').update(certificate).digest('hex').slice(0, 16);
    const paths = [`c${token}.pem`, `k${token}.pem`, `p${token}.pfx`].map((name) =>
      join(scratch, name),
    );
    try {
      writeFileSync(paths[0] ?? '', certificate, { mode: 0o600 });
      writeFileSync(paths[1] ?? '', privateKey, { mode: 0o600 });
      writeFileSync(paths[2] ?? '', privateKey, { mode: 0o600 });
      connect();
    } finally {
      for (const path of paths) rmSync(path, { force: true });
    }
  };

  function handle(line: string): void {
    const parsed = parseRequestLine(line);
    if (!parsed.ok) {
      fail('invalid-request', 'invalid_argument');
      return;
    }
    const request = parsed.value;
    const { state, seed } = world.current();
    switch (request.type) {
      case 'ping':
        ok(request.id, hello());
        return;
      case 'shutdown':
        ok(request.id, { done: true });
        process.exit(0);
        return;
      case 'connect':
        withScratchFiles(request.certificate.certificate, request.certificate.privateKey, () => {
          if (!pairMatches(request.certificate.certificate, request.certificate.privateKey)) {
            connected = false;
            fail(request.id, 'permission_denied');
          } else if (seed.connect !== 'ok') {
            connected = false;
            fail(request.id, seed.connect.error);
          } else {
            connected = true;
            ok(request.id, hello());
          }
        });
        return;
      case 'call': {
        if (!connected) {
          fail(request.id, 'not_connected');
          return;
        }
        const outcome = runCmdlet(state, request.cmdlet, request.args);
        if (!outcome.ok) {
          fail(request.id, outcome.error, outcome.retryAfterMs);
          return;
        }
        if (WRITE_CMDLETS.has(request.cmdlet)) world.journal(request.cmdlet, request.args);
        ok(request.id, fitRows(outcome.data));
      }
    }
  }

  const decoder = createLineDecoder();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const piece of decoder.push(chunk)) {
      if (piece.kind === 'line') handle(piece.text);
      else fail('invalid-request', 'invalid_argument');
    }
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
}
