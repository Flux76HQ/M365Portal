// A server entry for the spawn-level lifecycle tests: the real start sequence and the real
// shutdown, with one fixture module that gives the lifecycle something to be tested with. The real
// bundle (`dist/index.js`) has no module yet (the branding module is S2's), so it has no write route,
// no route that needs storage and no route that takes time; this one has all three:
//
//   GET  /api/v1/fixture/slow?ms=N   answers after N milliseconds (a request in flight at SIGTERM)
//   GET  /api/v1/fixture/storage     needs the database: 503 `storage_unavailable` in degraded mode
//   POST /api/v1/fixture/things      a write route that needs `settings:branding` (the denial audit)
//
// `test/helpers/built-server.ts` bundles this file the way `build.mjs` bundles the server and runs
// the result with `node`.
import { z } from 'zod';
import { defineRoute } from '../../src/http/route.js';
import type { AppModuleFactory } from '../../src/module.js';
import {
  installShutdownSignals,
  StartError,
  startServer,
  type RunningServer,
} from '../../src/start.js';

const Ok = z.strictObject({ ok: z.literal(true) }).meta({ id: 'LifecycleFixtureOk' });
const okResponse = {
  200: { description: 'Done', content: { 'application/json': { schema: Ok } } },
} as const;

const fixtureModule: AppModuleFactory = (deps) => ({
  id: 'fixture',
  routes: () => [
    defineRoute({
      id: 'fixture.slow',
      method: 'GET',
      path: '/api/v1/fixture/slow',
      access: { public: true },
      rateLimit: 'read',
      request: { query: z.object({ ms: z.string().regex(/^\d{1,6}$/) }) },
      responses: okResponse,
      handler: async (c, input) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Number(input.query.ms));
        });
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.storage',
      method: 'GET',
      path: '/api/v1/fixture/storage',
      access: { public: true },
      rateLimit: 'read',
      responses: okResponse,
      handler: (c) => {
        deps.requireDatabase();
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.thing.create',
      method: 'POST',
      path: '/api/v1/fixture/things',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      responses: okResponse,
      handler: (c) => c.json({ ok: true as const }, 200),
    }),
  ],
  start: () => {
    deps.log.info({ event: 'fixture_start' }, 'fixture_start');
    return Promise.resolve();
  },
  stop: () => {
    deps.log.info({ event: 'fixture_stop' }, 'fixture_stop');
    return Promise.resolve();
  },
});

let running: RunningServer;
try {
  running = await startServer({ env: process.env, modules: [fixtureModule] });
} catch (error) {
  process.exit(error instanceof StartError ? error.exitCode : 1);
}
installShutdownSignals(running);
