// T-B-014, AM-01, CB2, XB11: the module list of Phase B and the additive `AppModule.availability`.
//
//   - `appModules` lists branding first, then secrets, setup, connection, auth and rbac;
//   - modules start in list order and stop in reverse;
//   - a stub module has no routes, no hooks and no availability. A stub carries the marker line
//     `STUB-MODULE` in its source; the stream that takes the file over at GB0 removes it, and from
//     then on only the shape of the factory is asserted for that module;
//   - `availability` is optional and its predicate keys are exactly `setupOpen` and `breakGlass`;
//   - a module that returns a route without an access declaration still fails the Phase A route
//     table check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { defaultPaths } from '../scripts/schema-snapshot.js';
import { loadConfigOrThrow } from '../src/config/index.js';
import { createSweeperRegistry } from '../src/lifecycle/sweepers.js';
import { createLogger } from '../src/logging/logger.js';
import {
  AVAILABILITY_GATES,
  assertModuleAvailability,
  requireDatabaseOf,
  type AppModule,
  type AppModuleFactory,
  type ModuleDeps,
} from '../src/module.js';
import { appModules } from '../src/modules.js';
import { startServer, StartError } from '../src/start.js';
import { freePort } from './helpers/built-server.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { moduleDepsExtras } from './helpers/module-deps-extras.js';

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = defaultPaths().migrationsFolder;

const PHASE_B_IDS = ['secrets', 'setup', 'connection', 'auth', 'rbac'] as const;
const IDS = ['branding', ...PHASE_B_IDS, 'directory'] as const;

function fakeDeps(): ModuleDeps {
  const log = createLogger({ level: 'silent' });
  return {
    config: loadConfigOrThrow({}),
    log,
    now: () => 0,
    database: () => undefined,
    requireDatabase: requireDatabaseOf(() => undefined),
    storageAvailable: () => false,
    webRoot: WEB,
    shellTemplate: '',
    sweepers: createSweeperRegistry({ log }),
    isShuttingDown: () => false,
    ...moduleDepsExtras(),
  };
}

describe('appModules (CB2)', () => {
  it('lists branding first, then secrets, setup, connection, auth and rbac, and Phase C appends directory', () => {
    const deps = fakeDeps();
    expect(appModules).toHaveLength(7);
    expect(appModules.map((factory) => factory(deps).id)).toEqual([...IDS]);
  });

  it('builds a module with an id of lower-case words, once per id', () => {
    const ids = appModules.map((factory) => factory(fakeDeps()).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });
});

describe('the stub modules (AM-01)', () => {
  const sourceOf = (id: string): string =>
    readFileSync(join(SERVER_ROOT, 'src', id, 'module.ts'), 'utf8');

  it.each(PHASE_B_IDS)(
    '%s: a stub has no routes, no hooks and no availability; the owner is named in the header',
    (id) => {
      const factory = appModules[IDS.indexOf(id)];
      if (factory === undefined) throw new Error(`no module ${id}`);
      const module = factory(fakeDeps());
      expect(module.id).toBe(id);
      expect(typeof module.routes).toBe('function');
      const source = sourceOf(id);
      expect(source).toMatch(/Owner|owned by/i);
      if (!source.includes('STUB-MODULE')) return; // taken over: the stub assertions end here
      expect(module.routes(fakeDeps())).toEqual([]);
      expect(Object.keys(module).sort()).toEqual(['id', 'routes']);
      expect(module.start).toBeUndefined();
      expect(module.stop).toBeUndefined();
      expect(module.shell).toBeUndefined();
      expect(module.availability).toBeUndefined();
    },
  );

  it('each module has its own directory, and the secrets module is owned by S-B1 (section 1.3)', () => {
    expect(sourceOf('secrets')).toMatch(/S-B1/);
    expect(sourceOf('setup')).toMatch(/S-B3/);
    expect(sourceOf('connection')).toMatch(/S-B3/);
    expect(sourceOf('auth')).toMatch(/S-B4/);
    expect(sourceOf('rbac')).toMatch(/S-B5/);
    expect(sourceOf('directory')).toMatch(/S-C2/);
  });
});

describe('start and stop order', () => {
  async function started(factories: readonly AppModuleFactory[]) {
    const dataDir = (await createTempDataDir()).path;
    const port = await freePort();
    const running = await startServer({
      env: {
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
        LOG_LEVEL: 'silent',
      },
      stderr: createLogCapture(),
      logDestination: createLogCapture(),
      modules: factories,
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
    });
    onTestFinished(async () => {
      await running.stop();
    });
    return running;
  }

  function recording(id: string, events: string[]): AppModuleFactory {
    return () => ({
      id,
      routes: () => [],
      start: () => {
        events.push(`${id}.start`);
        return Promise.resolve();
      },
      stop: () => {
        events.push(`${id}.stop`);
        return Promise.resolve();
      },
    });
  }

  it('starts the six modules in list order and stops them in reverse', async () => {
    const events: string[] = [];
    const running = await started(IDS.map((id) => recording(id, events)));
    expect(events).toEqual(IDS.map((id) => `${id}.start`));
    events.length = 0;
    await expect(running.stop('SIGTERM')).resolves.toBe(0);
    expect(events).toEqual([...IDS].reverse().map((id) => `${id}.stop`));
  });

  it('starts the real modules with a database, and a server that has only stubs still serves /healthz', async () => {
    const running = await started(appModules);
    const answer = await fetch(`http://127.0.0.1:${String(running.port)}/healthz`);
    expect(answer.status).toBe(200);
  });
});

describe('AppModule.availability (CB2, additive)', () => {
  it('has the two gates setupOpen and breakGlass, and no other', () => {
    expect([...AVAILABILITY_GATES]).toEqual(['setupOpen', 'breakGlass']);
  });

  it('is optional: the existing modules have none and a module may offer one or both predicates', () => {
    const none: AppModule = { id: 'x', routes: () => [] };
    const one: AppModule = { id: 'y', routes: () => [], availability: { setupOpen: () => true } };
    const both: AppModule = {
      id: 'z',
      routes: () => [],
      availability: { setupOpen: () => false, breakGlass: () => true },
    };
    for (const module of [none, one, both]) {
      expect(() => {
        assertModuleAvailability(module);
      }).not.toThrow();
    }
  });

  it('refuses a gate that is not one of the two, and a predicate that is not a function', () => {
    const guard = (module: AppModule): void => {
      assertModuleAvailability(module);
    };
    const withAvailability = (availability: unknown): AppModule =>
      ({ id: 'bad', routes: () => [], availability }) as unknown as AppModule;
    expectGuardFails(guard, withAvailability({ setupOpened: () => true }), {
      name: 'availability',
      reason: 'module "bad" declares the gate "setupOpened"',
    });
    expectGuardFails(guard, withAvailability({ setupOpen: true }), {
      name: 'availability',
      reason: 'module "bad": the gate "setupOpen" must be a function',
    });
    expectGuardFails(guard, withAvailability('yes'), {
      name: 'availability',
      reason: 'module "bad": availability must be an object',
    });
  });

  it('is checked at start: a module with a wrong gate ends the start (route_table_invalid)', async () => {
    const dataDir = (await createTempDataDir()).path;
    const failure = await startServer({
      env: {
        PORT: String(await freePort()),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
      },
      stderr: createLogCapture(),
      logDestination: createLogCapture(),
      modules: [
        () => ({ id: 'bad', routes: () => [], availability: { setupOpened: () => true } }) as never,
      ],
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StartError);
    expect((failure as StartError).code).toBe('route_table_invalid');
  });
});

describe('a route without an access declaration still fails the Phase A route table check', () => {
  it('ends the start with route_table_invalid', async () => {
    const dataDir = (await createTempDataDir()).path;
    const noAccess: AppModuleFactory = () => ({
      id: 'sloppy',
      routes: () =>
        [
          {
            id: 'sloppy.read',
            method: 'get',
            path: '/api/v1/sloppy',
            rateLimit: 'read',
            responses: { 200: { description: 'ok' } },
            handler: (c: { json: (body: unknown) => Response }) => c.json({}),
          },
        ] as never,
    });
    const failure = await startServer({
      env: {
        PORT: String(await freePort()),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        LOG_LEVEL: 'silent',
      },
      stderr: createLogCapture(),
      logDestination: createLogCapture(),
      modules: [noAccess],
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StartError);
    expect((failure as StartError).code).toBe('route_table_invalid');
  });
});
