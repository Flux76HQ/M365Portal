// The real server for the auth route tests (T-B-194 and after): `startServer` on a free port with the
// modules a test names, a fake clock behind every timestamp, a throwaway data directory and a client.
// Sessions are written the way the store writes them, through a second connection to the same
// database (`seedSession`), and the stand-in setup sessions are registered by a tiny test module.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { authModule } from '../../../src/auth/module.js';
import { brandingModule } from '../../../src/branding/index.js';
import { DATABASE_FILE_NAME, openDatabase } from '../../../src/db/index.js';
import type { AppModuleFactory } from '../../../src/module.js';
import { rbacModule } from '../../../src/rbac/module.js';
import { startServer, type RunningServer } from '../../../src/start.js';
import { freePort } from '../../helpers/built-server.js';
import { createFakeClock, type FakeClock } from '../../helpers/fake-clock.js';
import {
  createFakeSetupSessions,
  type FakeSetupSessions,
} from '../../helpers/fake-setup-sessions.js';
import { createHttpClient, type HttpClient } from '../../helpers/http-client.js';
import { createLogCapture, type LogCapture } from '../../helpers/log-capture.js';
import { seedSession, newCookieValue, type SeedSessionOptions } from '../../helpers/signed-in.js';
import { hashSessionId } from '../../../src/policy/session-hash.js';
import { createTempDataDir } from '../../helpers/temp-data-dir.js';
import { cookieNames } from '@m365portal/shared/auth/cookies';

const SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

export interface RealServer {
  readonly running: RunningServer;
  readonly origin: string;
  readonly dataDir: string;
  readonly clock: FakeClock;
  readonly logs: LogCapture;
  readonly setupSessions: FakeSetupSessions;
  /** A client without cookies. */
  readonly client: HttpClient;
  /** A client that sends these headers (a `cookie`). */
  clientWith(headers: Readonly<Record<string, string>>): HttpClient;
  /** Write a session row and return the headers a browser holding it would send. */
  signIn(options?: SeedSessionOptions): {
    headers: Record<string, string>;
    value: string;
    idHash: string;
  };
  /** Register a live setup session and return the headers of a browser holding it. */
  signInSetup(): { headers: Record<string, string>; value: string };
}

export async function startRealServer(
  options: {
    readonly modules?: readonly AppModuleFactory[];
    readonly dataDir?: string;
    readonly env?: Record<string, string>;
  } = {},
): Promise<RealServer> {
  const dataDir = options.dataDir ?? (await createTempDataDir()).path;
  const port = await freePort();
  const logs = createLogCapture();
  const clock = createFakeClock();
  const setupSessions = createFakeSetupSessions(() => clock.iso());
  const socket = `http://127.0.0.1:${String(port)}`;
  const origin = `http://localhost:${String(port)}`;
  const holder: AppModuleFactory = (deps) => {
    deps.policy.setupSessions.set(setupSessions);
    return { id: 'testholder', routes: () => [] };
  };
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: origin,
      LOG_LEVEL: 'debug',
      ...options.env,
    },
    stderr: createLogCapture(),
    logDestination: logs,
    modules: options.modules ?? [brandingModule, authModule, rbacModule, holder],
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
    clock: { now: () => clock.nowMs(), monotonic: () => performance.now() },
  });
  onTestFinished(async () => {
    await running.stop();
  });
  const clientWith = (headers: Readonly<Record<string, string>>): HttpClient =>
    createHttpClient({ fetch: (request) => fetch(request), baseUrl: socket, origin, headers });
  return {
    running,
    origin,
    dataDir,
    clock,
    logs,
    setupSessions,
    client: clientWith({}),
    clientWith,
    signIn(seed = {}) {
      const database = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
      try {
        const session = seedSession(database, origin, { now: clock.nowMs(), ...seed });
        if (seed.kind !== 'break_glass') {
          // The groups of a person who just signed in are fresh; without this the first request
          // would try to refresh them and find no directory to ask (T-B-189).
          database.sqlite
            .prepare(
              'UPDATE app_user SET groups_resolved_at = ? WHERE oid = ? AND groups_resolved_at IS NULL',
            )
            .run(clock.iso(), session.oid);
        }
        return { headers: { ...session.headers }, value: session.value, idHash: session.idHash };
      } finally {
        database.close();
      }
    },
    signInSetup() {
      const value = newCookieValue();
      setupSessions.add(hashSessionId(value));
      return { headers: { cookie: `${cookieNames(origin).setup}=${value}` }, value };
    },
  };
}
