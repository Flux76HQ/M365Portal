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
import type { PagePolicy } from './http/spa-fallback.js';
import { ProblemError } from './http/problem.js';
import type { ClientsRegistry } from './integrations/registry.js';
import type { Logger } from './logging/logger.js';
import type { Scheduler, Sweeper } from './lifecycle/sweepers.js';
import type { ActorResolver, PolicyPorts } from './policy/index.js';
import type { RandomSource } from './ports/clock.js';
import type { SecretsRuntime } from './secrets/state.js';
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
  /**
   * Randomness (Phase B, T-B-022): identifiers, nonces, salts, jitter. Production passes a source over
   * `node:crypto` (`systemRandom`); a test passes a seeded one. Code under `src/{setup,connection,auth,
   * rbac,policy,integrations}` takes it from here and never calls an ambient random function.
   */
  readonly random: RandomSource;
  /** Timers (Phase B, T-B-022): the same four-method scheduler the sweepers use. */
  readonly scheduler: Scheduler;
  /**
   * The secrets state and services (Phase B, T-B-019, SB-32): a holder built before any module and
   * filled by the `secrets` module's `start` hook. Reading it before that fails closed
   * (`key_missing`). Other modules read `secrets.state()` per call and never keep the result.
   */
  readonly secrets: SecretsRuntime;
  /**
   * The Microsoft clients (Phase B, T-B-023, CB11): `graph()`, `exchange()`, `oidc()` and `appTokens()`,
   * each throwing `SecretsUnavailableError` while the secrets are not usable and `NotConnectedError`
   * before a tenant is pinned. Built by the composition root, started after the module `start` hooks
   * and reloaded when the secrets module publishes a new state; services get clients here and nowhere else.
   */
  readonly clients: ClientsRegistry;
  /**
   * The ports of the policy layer (Phase B, T-B-240, CB10, SB-32): holders built before any module.
   * The auth module registers its session store, the setup module its setup sessions and the rbac
   * module the grants of a user; a holder that is still empty fails closed (anonymous).
   */
  readonly policy: PolicyPorts;
  /**
   * Who a request acts as: the one resolver of the application. The pipeline calls it lazily on the
   * first read of the actor; the HTML shell calls it for the boot data, so the page and
   * `GET /api/v1/me` can never disagree (SB-32, SB-38).
   */
  readonly resolveActor: ActorResolver;
}

/**
 * The two availability gates of Phase B (CB2): `setupOpen` (the setup routes exist only while the
 * wizard is open, FR-B-201) and `breakGlass` (the break-glass routes exist only when the account is
 * configured, FR-B-521). A gate is a predicate on the request; the route wrapper (T-B-237) answers
 * the standard 404 for a route whose gate is closed. No other name is a gate.
 */
export const AVAILABILITY_GATES = ['setupOpen', 'breakGlass'] as const;

export type AvailabilityGate = (typeof AVAILABILITY_GATES)[number];

/** The predicates a module offers, by gate. A module offers the gates it can decide, not all. */
export type ModuleAvailability = Readonly<
  Partial<Record<AvailabilityGate, (request: Request) => boolean>>
>;

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
  /**
   * Availability predicates (Phase B, additive): which gates this module can answer. Optional; the
   * composition root merges them and the route wrapper reads them (`T-B-237`).
   */
  readonly availability?: ModuleAvailability;
  /**
   * What a page navigation gets before the shell renders (Phase B, additive, seam XB20): the setup
   * module answers 404 for `/setup` once the wizard is closed and 303 to `/setup` for any other page
   * while it is open. The first module that has one is used.
   */
  readonly pages?: PagePolicy;
}

/** Throws unless the `availability` of `module`, when there is one, names only the two gates, as functions. */
export function assertModuleAvailability(module: AppModule): void {
  const { availability } = module as { availability?: unknown };
  if (availability === undefined) return;
  if (typeof availability !== 'object' || availability === null || Array.isArray(availability)) {
    throw new Error(`module "${module.id}": availability must be an object`);
  }
  for (const [gate, predicate] of Object.entries(availability)) {
    if (!(AVAILABILITY_GATES as readonly string[]).includes(gate)) {
      throw new Error(
        `module "${module.id}" declares the gate "${gate}", which is not one of ${AVAILABILITY_GATES.join(' and ')}`,
      );
    }
    if (typeof predicate !== 'function') {
      throw new Error(`module "${module.id}": the gate "${gate}" must be a function`);
    }
  }
}

export type AppModuleFactory = (deps: ModuleDeps) => AppModule;

/** `deps.requireDatabase` for a composition root: the handle, or the 503 of degraded mode. */
export function requireDatabaseOf(
  database: () => DatabaseHandle | undefined,
): () => DatabaseHandle {
  return () => {
    const handle = database();
    if (handle === undefined) throw new ProblemError('storage_unavailable');
    return handle;
  };
}
