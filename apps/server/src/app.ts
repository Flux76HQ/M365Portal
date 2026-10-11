// The composition root of the HTTP side (FR-A-012, plan 7.2, contract C5 and C6): `buildApp` builds
// every argument of `createHttpApp` and calls it. It owns no route and no rule of its own; what it
// decides is only which pieces are wired to which, so that this file is the one place to read when
// the question is "what runs for a request, and what does it talk to".
//
//   clocks         the wall clock for CSRF tokens and audit times, a monotonic one for the rate limiter
//   csrf, limiter  one of each per process (the CSRF key lives and dies with the process)
//   denial audit   the database of the moment: none in degraded mode, which fails closed with 503
//   routes         health, meta, robots, the service worker, then the routes of the modules in order
//   fallbacks      the static files, then the page shell (the first module with a shell, else the
//                  placeholder that fills the nonce); the 404 and 405 answer is added last
//   storage        a storage failure the error handler answers is told to readiness
//
// A route table that does not hold (a route without access, a documented route that is not
// registered, ...) throws here, and with it the start: nothing listens.
import { performance } from 'node:perf_hooks';
import type { AppConfig } from './config/env.js';
import type { DatabaseHandle } from './db/index.js';
import { createCsrf } from './http/csrf.js';
import { createDenialAudit } from './http/denial-audit.js';
import { createDocumentSource } from './http/openapi.js';
import { createRateLimiter } from './http/rate-limit.js';
import { createHttpApp, type HttpApp } from './http/route.js';
import { spaFallback } from './http/spa-fallback.js';
import { serviceWorkerRoute, staticFallback } from './http/static.js';
import type { ReadinessController } from './lifecycle/readiness.js';
import type { Logger } from './logging/logger.js';
import type { AppModule, ModuleDeps } from './module.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';
import { robotsRoutes } from './routes/robots.js';
import { createPlaceholderShell, type ShellRenderer } from './shell-port.js';
import { APP_VERSION } from './version.js';

/** The two clocks of the server. Tests pass fakes; the server passes `systemClock`. */
export interface ServerClock {
  /** Milliseconds since the epoch: CSRF tokens, audit entries, log times. */
  now(): number;
  /** Milliseconds from an arbitrary start, never going back: the rate limiter. */
  monotonic(): number;
}

export const systemClock: ServerClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export interface BuildAppDeps {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly clock: ServerClock;
  readonly readiness: ReadinessController;
  /** The open database, or `undefined` in degraded mode. */
  readonly database: () => DatabaseHandle | undefined;
  /** The modules, already built, in registration order. */
  readonly modules: readonly AppModule[];
  /** The object the modules were built from. */
  readonly moduleDeps: ModuleDeps;
  /** The absolute path of the built frontend. */
  readonly webRoot: string;
  /** `index.html` of the build, for the placeholder shell. */
  readonly shellTemplate: string;
  readonly shutdown: { isShuttingDown(): boolean };
}

type FetchEnv = Parameters<HttpApp['app']['fetch']>[1];

export interface BuiltApp {
  /** Handles a request; during shutdown every answer carries `Connection: close`. */
  fetch(request: Request, env?: FetchEnv): Promise<Response>;
  /** The route table and the OpenAPI document, for the checks that read them. */
  readonly http: HttpApp;
  /** The shell in use: the first module's renderer, or the placeholder. */
  readonly shell: ShellRenderer;
}

function assertUniqueModules(modules: readonly AppModule[]): void {
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.id)) throw new Error(`two modules are named "${module.id}"`);
    seen.add(module.id);
  }
}

/** The same answer with `Connection: close`; a response with immutable headers is copied. */
function withConnectionClose(response: Response): Response {
  try {
    response.headers.set('Connection', 'close');
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set('Connection', 'close');
    return copy;
  }
}

export function buildApp(deps: BuildAppDeps): BuiltApp {
  assertUniqueModules(deps.modules);
  const { config, log, clock } = deps;

  const csrf = createCsrf({ now: () => clock.now() });
  const limiter = createRateLimiter({ now: () => clock.monotonic() });
  const document = createDocumentSource();
  const shell: ShellRenderer =
    deps.modules.find((module) => module.shell !== undefined)?.shell ??
    createPlaceholderShell(deps.shellTemplate);

  const http = createHttpApp({
    config,
    log,
    csrf,
    limiter,
    onDenied: createDenialAudit({ database: deps.database, now: () => clock.now() }),
    onStorageFailure: (failure) => {
      deps.readiness.reportStorageFailure(failure);
    },
    routes: [
      ...healthRoutes({ version: APP_VERSION, readiness: deps.readiness }),
      ...metaRoutes({
        version: APP_VERSION,
        publicOrigin: config.publicOrigin,
        showcase: config.showcase,
        storageAvailable: () => deps.readiness.storageAvailable(),
        csrf,
        document,
      }),
      ...robotsRoutes(),
      serviceWorkerRoute({ root: deps.webRoot }),
      ...deps.modules.flatMap((module) => module.routes(deps.moduleDeps)),
    ],
    fallbacks: [staticFallback({ root: deps.webRoot }), spaFallback({ shell })],
    openApi: { version: APP_VERSION, source: document },
  });

  return {
    http,
    shell,
    fetch: async (request, env) => {
      const response = await http.app.fetch(request, env);
      return deps.shutdown.isShuttingDown() ? withConnectionClose(response) : response;
    },
  };
}
