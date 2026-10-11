// The BUILT server as the target of the hostile corpus (T-A-093): `build.mjs` output, started with
// `node dist/index.js` as a real process, one fresh process and data directory per fixture, spoken
// to over a real socket. Nothing of the server runs in the test process.
//
// What the server is told:
//   PREVIEW_MODE=true, PREVIEW_MODE_ALLOW_REMOTE=true   the preview actor holds `settings:branding`
//                      (allow-remote because every request carries X-Forwarded-For, see next line)
//   TRUST_PROXY=1      each request names a client address of its own (see `clientAddress` in the
//                      harness): the 3-upload burst of the rate class is per client
//   DATA_DIR, TMPDIR   the workspace of the fixture, so that "nothing left in /tmp or branding/.tmp"
//                      is checked on the very directories the process used
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, DATABASE_FILE_NAME } from '../../src/db/index.js';
import { freePort, httpRequest, spawnServer, type BuiltLayout } from '../helpers/built-server.js';
import type { HostileFixture } from '../fixtures/hostile-corpus.js';
import type { TransportPlan } from '../fixtures/hostile/types.js';
import {
  viaHttp,
  type AuditObservation,
  type HostileTarget,
  type Workspace,
} from './hostile-harness.js';

const SHORT_TIMEOUT_PRELOAD = fileURLToPath(
  new URL('../fixtures/short-request-timeout.mjs', import.meta.url),
);

/** The shortened timeouts a fixture asks of the server, if it asks for any (H-37). */
export function transportPlanOf(fixture: HostileFixture): TransportPlan | undefined {
  for (const input of fixture.inputs) {
    if (input.kind === 'upload' && input.transport?.serverRequestTimeoutMs !== undefined) {
      return input.transport;
    }
  }
  return undefined;
}

export interface BuiltTargetOptions {
  readonly layout: BuiltLayout;
  readonly workspace: Workspace;
  readonly fixture: HostileFixture;
}

/** Audit rows of the data directory, read through a read-only connection of the test process. */
function readAuditRows(dataDir: string): AuditObservation[] {
  const database = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME), readonly: true });
  try {
    return (
      database.sqlite
        .prepare(
          "SELECT action, outcome, detail FROM audit_log WHERE action != 'branding.init' ORDER BY seq",
        )
        .all() as { action: string; outcome: string; detail: string }[]
    ).map((row) => ({ action: row.action, outcome: row.outcome, detail: row.detail }));
  } finally {
    database.close();
  }
}

/** Start the built server on the workspace of a fixture and return the target that talks to it. */
export async function startBuiltTarget(options: BuiltTargetOptions): Promise<HostileTarget> {
  const { layout, workspace, fixture } = options;
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const plan = transportPlanOf(fixture);
  const server = await spawnServer({
    layout,
    port,
    env: {
      DATA_DIR: workspace.dataDir,
      TMPDIR: workspace.tmpDir,
      PUBLIC_BASE_URL: origin,
      PREVIEW_MODE: 'true',
      PREVIEW_MODE_ALLOW_REMOTE: 'true',
      TRUST_PROXY: '1',
      LOG_LEVEL: 'info',
      ...(plan === undefined
        ? {}
        : {
            NODE_OPTIONS: `--import=${SHORT_TIMEOUT_PRELOAD}`,
            M365_TEST_REQUEST_TIMEOUT_MS: String(plan.serverRequestTimeoutMs ?? 1_000),
            M365_TEST_CHECK_INTERVAL_MS: String(plan.serverCheckIntervalMs ?? 100),
          }),
    },
  });
  await server.listening();

  let token: string | undefined;
  const csrfToken = async (): Promise<string> => {
    if (token !== undefined) return token;
    const answer = await httpRequest(port, '/api/v1/csrf');
    token = (JSON.parse(answer.body) as { token: string }).token;
    return token;
  };
  let client = 0;
  const target = viaHttp({
    server: {
      origin,
      close: async () => {
        if (server.child.exitCode === null && server.child.signalCode === null) {
          server.signal('SIGTERM');
        }
        await server.exited;
      },
    },
    publicOrigin: origin,
    csrfToken,
    dataDir: workspace.dataDir,
    readAudit: () => Promise.resolve(readAuditRows(workspace.dataDir)),
    clientAddress: () => {
      client += 1;
      return `10.${String((client >> 16) & 255)}.${String((client >> 8) & 255)}.${String(client & 255)}`;
    },
  });
  return target;
}

/** Run `node dist/cli.js verify-audit` of the built bundle on a data directory. */
export function verifyAuditOf(
  layout: BuiltLayout,
  dataDir: string,
): Promise<{ readonly code: number | null; readonly out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(layout.dist, 'cli.js'), 'verify-audit'], {
      env: {
        PATH: process.env.PATH ?? '',
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: 'http://localhost:8080',
      },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', (code) => {
      resolve({ code, out });
    });
  });
}
