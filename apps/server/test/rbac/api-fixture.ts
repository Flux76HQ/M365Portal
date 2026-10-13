// The real application over every module the server lists, with a fake directory behind the Graph
// client and real signed-in identities (T-B-250 to T-B-253). Not a test file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { defaultPaths } from '../../scripts/schema-snapshot.js';
import { buildApp, type BuiltApp } from '../../src/app.js';
import { clearAuditHeadLog, setAuditHeadLog } from '../../src/audit/index.js';
import { loadConfigOrThrow } from '../../src/config/index.js';
import { DATABASE_FILE_NAME, openDatabase, type AppDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createReadiness } from '../../src/lifecycle/readiness.js';
import { createStorageProbe } from '../../src/lifecycle/storage-probe.js';
import { createSweeperRegistry } from '../../src/lifecycle/sweepers.js';
import { createLogger } from '../../src/logging/logger.js';
import { requireDatabaseOf, type AppModule, type ModuleDeps } from '../../src/module.js';
import { appModules } from '../../src/modules.js';
import type { GraphClient } from '../../src/ports/graph.js';
import { FakeGraphClient, type FakeGraphClientOptions } from '../fakes/fake-graph-client.js';
import { FakeDirectory } from '../fakes/fake-tenant/graph/index.js';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock.js';
import { createHttpClient, type HttpClient } from '../helpers/http-client.js';
import { createLogCapture, type LogCapture } from '../helpers/log-capture.js';
import { moduleDepsExtras } from '../helpers/module-deps-extras.js';
import { createPolicyHarness, type PolicyHarness } from '../helpers/policy-harness.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { signedInAs, type SignedIn, type SignedInOptions } from '../helpers/test-app.js';

export const ORIGIN = 'http://localhost:9300';
const PEER = {
  incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 54_321, remoteFamily: 'IPv4' } },
  outgoing: {},
};
const WEB = join(fileURLToPath(new URL('..', import.meta.url)), 'fixtures', 'web-dist');

export interface AuditRow {
  readonly seq: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly target_id: string | null;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly detail: string | null;
}

export interface ApiFixture {
  readonly built: BuiltApp;
  readonly db: AppDatabase;
  readonly clock: FakeClock;
  readonly directory: FakeDirectory;
  readonly fake: FakeGraphClient;
  readonly logs: LogCapture;
  readonly identity: PolicyHarness;
  readonly modules: readonly AppModule[];
  anonymous(): HttpClient;
  /**
   * A signed-in actor. A user also exists in the directory (the revalidation of the session asks Graph
   * about the person, FR-B-409) and starts with a fresh group resolution, so a request of the user
   * costs no Graph call until the cache is cleared (a group assignment) or the TTL passes.
   */
  signIn(options: SignedInOptions): SignedIn;
  /**
   * Lets every session of a user revalidate now (one `GET /api/v1/me` each) and forgets the Graph
   * calls that cost, so a test counts only the calls of the request it is about.
   */
  settle(): Promise<void>;
  /** A user known to the directory and to `app_user`. */
  user(upn: string, options?: { department?: string; accountEnabled?: boolean }): { id: string };
  group(name: string): { id: string };
  rows(): AuditRow[];
}

export interface ApiFixtureOptions {
  /** Wrap or replace the Graph client the modules see. */
  readonly graph?: (fake: FakeGraphClient) => GraphClient;
  /** Options of the in-memory Graph client (Phase C: the manager mode, hidden members). */
  readonly graphOptions?: FakeGraphClientOptions;
  readonly env?: Readonly<Record<string, string>>;
}

export async function createApiFixture(options: ApiFixtureOptions = {}): Promise<ApiFixture> {
  const dir = await createTempDataDir();
  const clock = createFakeClock();
  let monotonic = 0;
  const logs = createLogCapture();
  const log = createLogger({ level: 'debug', destination: logs, now: () => clock.nowMs() });
  const paths = defaultPaths();
  const database = openDatabase({ path: join(dir.path, DATABASE_FILE_NAME) });
  await runMigrations(database.sqlite, {
    migrationsFolder: paths.migrationsFolder,
    backupsDir: join(dir.path, 'backups'),
  });
  setAuditHeadLog(log);
  onTestFinished(() => {
    clearAuditHeadLog();
    if (database.sqlite.open) database.close();
  });
  const readiness = createReadiness({
    now: () => clock.nowMs(),
    probe: createStorageProbe(dir.path),
    database: () => database,
    startFailure: () => undefined,
    migrationsFolder: paths.migrationsFolder,
  });
  const config = loadConfigOrThrow({
    PUBLIC_BASE_URL: ORIGIN,
    DATA_DIR: dir.path,
    ...(options.env ?? {}),
  });
  const identity = await createPolicyHarness({ db: database, clock });
  const directory = new FakeDirectory({ clock: { now: () => clock.nowMs() } });
  const fake = new FakeGraphClient(directory, options.graphOptions ?? {});
  const graph = options.graph?.(fake) ?? fake;
  const sessions: SignedIn[] = [];
  const handle = (): AppDatabase | undefined => database;
  const extras = moduleDepsExtras(handle, {
    now: () => clock.nowMs(),
    overrides: { policy: identity.ports, resolveActor: identity.resolve },
  });
  const moduleDeps: ModuleDeps = {
    config,
    log,
    now: () => clock.nowMs(),
    database: handle,
    requireDatabase: requireDatabaseOf(handle),
    storageAvailable: () => readiness.storageAvailable(),
    webRoot: WEB,
    shellTemplate: readFileSync(join(WEB, 'index.html'), 'utf8'),
    sweepers: createSweeperRegistry({ log }),
    isShuttingDown: () => false,
    ...extras,
    clients: { ...extras.clients, graph: () => graph },
  };
  const modules = appModules.map((factory) => factory(moduleDeps));
  onTestFinished(async () => {
    for (const module of [...modules].reverse()) await module.stop?.();
  });
  const built = buildApp({
    config,
    log,
    clock: {
      now: () => clock.nowMs(),
      monotonic: () => {
        monotonic += 60_000;
        return monotonic;
      },
    },
    readiness,
    database: handle,
    modules,
    moduleDeps,
    webRoot: WEB,
    shellTemplate: moduleDeps.shellTemplate,
    shutdown: { isShuttingDown: () => false },
  });
  const clientFor = (headers?: Readonly<Record<string, string>>): HttpClient =>
    createHttpClient({
      fetch: (request) => built.fetch(request, PEER),
      baseUrl: ORIGIN,
      origin: ORIGIN,
      ...(headers === undefined ? {} : { headers }),
    });
  return {
    built,
    db: database,
    clock,
    directory,
    fake,
    logs,
    identity,
    modules,
    anonymous: () => clientFor(),
    signIn(signed) {
      const session = signedInAs(
        {
          db: database,
          clock,
          publicOrigin: ORIGIN,
          setupSessions: identity.setupSessions,
          clientFor: (clientOptions) => clientFor(clientOptions?.headers),
        },
        signed,
      );
      if (signed.kind === 'user') {
        if (!directory.users.has(session.oid)) {
          directory.addUser({
            id: session.oid,
            userPrincipalName: `signed-in-${session.oid.slice(-6)}@contoso-fake.example`,
          });
        }
        database.sqlite
          .prepare('UPDATE app_user SET groups_resolved_at = ? WHERE oid = ?')
          .run(clock.iso(), session.oid);
        sessions.push(session);
      }
      return session;
    },
    async settle() {
      for (const session of sessions) await session.client.get('/api/v1/me');
      fake.calls.length = 0;
    },
    user(upn, userOptions = {}) {
      const user = directory.addUser({
        userPrincipalName: upn,
        ...(userOptions.department === undefined ? {} : { department: userOptions.department }),
        ...(userOptions.accountEnabled === undefined
          ? {}
          : { accountEnabled: userOptions.accountEnabled }),
      });
      return user;
    },
    group: (name) => directory.addGroup({ displayName: name }),
    rows: () =>
      database.sqlite
        .prepare(
          'SELECT seq, actor_kind, actor_id, action, target_id, outcome, reason_code, detail FROM audit_log ORDER BY seq',
        )
        .all() as AuditRow[],
  };
}
