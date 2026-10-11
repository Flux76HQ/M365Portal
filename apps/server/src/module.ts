// The module port (contract C5, FR-A-012 start sequence steps 7 and 8): how a feature of the server
// (branding in Phase A; secrets, setup, connection, auth and rbac in Phase B) joins the application
// without the composition root knowing anything about it.
//
// A module is a plain object built by a factory from `ModuleDeps`. The composition root
//
//   - asks each module for its routes (`routes`) and hands them to the route table, where they meet
//     the same guards, the same table checks and the same OpenAPI document as the core routes;
//   - uses the `shell` of the first module that has one in place of the placeholder shell (C6);
//   - runs each `start` once, in registration order, after the migrations and before the port opens
//     (steps 7 and 8: sweepers, the asset check, the default row). `start` is NOT called in degraded
//     mode, because every one of those steps needs storage; `database()` is `undefined` there, and a
//     `shell` has to render with in-memory defaults then (FR-A-013);
//   - calls each `stop` in reverse order when the process shuts down, before the drain: that is
//     where image child processes are killed.
//
// A `start` that throws ends the process with exit code 1 before it listens: a broken native module
// (sharp) fails the start, not the first upload.
import type { AppConfig } from './config/env.js';
import type { DatabaseHandle } from './db/index.js';
import type { RouteDefinition } from './http/route.js';
import { ProblemError } from './http/problem.js';
import type { Logger } from './logging/logger.js';
import type { Sweeper } from './lifecycle/sweepers.js';
import type { ShellRenderer } from './shell-port.js';

/** What a module may use of the server. One object, built once, shared by all modules. */
export interface ModuleDeps {
  readonly config: AppConfig;
  /** The server logger; a module takes `log.child({ module: id })` for its own lines. */
  readonly log: Logger;
  /** Milliseconds since the epoch. The one wall clock: a module never calls `Date.now()` itself. */
  readonly now: () => number;
  /** The open database, or `undefined` in degraded mode. Read per call: storage can come and go. */
  readonly database: () => DatabaseHandle | undefined;
  /** The open database, or a thrown 503 `storage_unavailable` that the error handler answers. */
  readonly requireDatabase: () => DatabaseHandle;
  /** Is storage usable right now (the answer of `/api/v1/me`)? */
  readonly storageAvailable: () => boolean;
  /** The absolute path of the built frontend (`index.html`, `assets/`, `sw.js`). */
  readonly webRoot: string;
  /** `index.html` of the build, with the placeholders of C8, read once at start. */
  readonly shellTemplate: string;
  /** Housekeeping jobs: run at start and then every hour (plan 7.1 step 10). */
  readonly sweepers: { register(sweeper: Sweeper): void };
  /** True from the moment shutdown begins; an upload in progress ends with 503 `shutting_down`. */
  readonly isShuttingDown: () => boolean;
}

export interface AppModule {
  /** Unique, lower case words: `branding`. */
  readonly id: string;
  /** The routes of the module. `deps` is the object the factory was given. */
  routes(deps: ModuleDeps): RouteDefinition[];
  /** Renders the page shell (C6). Replaces the placeholder shell when present. */
  readonly shell?: ShellRenderer;
  /** Start hook. Not called in degraded mode. */
  start?(ctx: ModuleDeps): Promise<void>;
  /** Stop hook, called once at shutdown. */
  stop?(): Promise<void>;
}

export type AppModuleFactory = (deps: ModuleDeps) => AppModule;

/** `deps.requireDatabase` for a composition root: the handle, or the 503 of degraded mode. */
export function requireDatabaseOf(database: () => DatabaseHandle | undefined): () => DatabaseHandle {
  return () => {
    const handle = database();
    if (handle === undefined) throw new ProblemError('storage_unavailable');
    return handle;
  };
}
