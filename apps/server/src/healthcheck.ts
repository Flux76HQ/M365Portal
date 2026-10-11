// The image HEALTHCHECK (FR-A-016, FR-A-162): `node dist/healthcheck.js`. The runtime image has no
// shell, curl or wget, so the check is a Node script. It asks `/readyz` of this container on
// 127.0.0.1, on the port in `PORT` (the default of the shared limits when unset), gives up after
// 3 seconds, and exits 0 only on a 200.
//
// It has no dependencies on purpose: no configuration module, no logger, no `fetch` (which would
// follow `HTTP_PROXY` where the sandbox sets one). `PORT` that is set but not a port is a failure,
// never turned into the default: the container would then be reported healthy for the wrong service.
import { request } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@m365portal/shared/limits';

/** The abort of a check, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 3000;

const PORT_PATTERN = /^[1-9]\d{0,4}$/;

export interface HealthcheckOptions {
  /** Overrides the 3-second abort; for a test that cannot wait that long. */
  readonly timeoutMs?: number;
}

function portOf(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env.PORT;
  if (raw === undefined) return DEFAULT_PORT;
  if (!PORT_PATTERN.test(raw)) return undefined;
  const port = Number(raw);
  return port <= 65_535 ? port : undefined;
}

/** Resolves with the exit code: 0 when `/readyz` answered 200, 1 in every other case. */
export function runHealthcheck(
  env: Readonly<Record<string, string | undefined>>,
  options: HealthcheckOptions = {},
): Promise<number> {
  const port = portOf(env);
  if (port === undefined) return Promise.resolve(1);

  return new Promise<number>((done) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      done(code);
    };
    const call = request(
      { host: '127.0.0.1', port, path: '/readyz', method: 'GET', agent: false },
      (response) => {
        response.resume();
        finish(response.statusCode === 200 ? 0 : 1);
      },
    );
    call.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      call.destroy();
      finish(1);
    });
    call.on('error', () => {
      finish(1);
    });
    call.end();
  });
}

// Run when started as a script (`node dist/healthcheck.js`), not when imported.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runHealthcheck(process.env).then((code) => {
    process.exit(code);
  });
}
