// Types of the fake tenant core (T-B-063, CB7). The Entra, Graph and Exchange modules of T-B-064 to
// T-B-066 are written against these: a module is a function that receives the core and mounts routes
// on it. Test support: nothing under `src/` imports any of this (`server/no-test-hooks.test.ts`).

/** The only three hosts the product talks to (FR-B-317). Anything else is a 404 here. */
export const FAKE_TENANT_HOSTS = [
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'outlook.office365.com',
] as const;
export type FakeHost = (typeof FAKE_TENANT_HOSTS)[number];

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The clock of the fake: the injected `Clock` of ports/clock.ts (`now()` in milliseconds). */
export interface FakeTenantClock {
  now(): number;
}

export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  /** `:name` segments and the named groups of a RegExp path, decoded; `*` for a trailing wildcard. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** Parses the body as JSON. A body that is not JSON ends the request with 400. */
  json(): Promise<unknown>;
  /** Parses an `application/x-www-form-urlencoded` body. */
  form(): Promise<URLSearchParams>;
  readonly clock: FakeTenantClock;
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>;

export interface RouteDefinition {
  readonly host: FakeHost;
  readonly method: HttpMethod;
  /**
   * `/v1.0/users/:id` (a `:name` segment never spans a slash; a final `*` takes the rest), or a
   * RegExp tested against the raw path. Matching is case-sensitive.
   */
  readonly path: string | RegExp;
  /**
   * Whether a successful call changes the directory. Defaults to the method: anything but GET, HEAD
   * and OPTIONS. A read sent as POST (`checkMemberGroups`, the token endpoint) says `false`.
   */
  readonly mutating?: boolean;
  readonly handler: RouteHandler;
}

export interface Router {
  /** Returns a function that removes the route again. */
  add(route: RouteDefinition): () => void;
}

export interface FakeTenantCore {
  readonly clock: FakeTenantClock;
  readonly router: Router;
  /** Registers a function that puts the module's own state back to its initial value on `reset()`. */
  onReset(hook: () => void): void;
}

/** A module mounts its routes and registers its reset hook on the core. */
export type FakeTenantModule = (core: FakeTenantCore) => void;

/** What the fake kept of one request: metadata only, never a header, a body or a query value. */
export interface CallRecord {
  /** 1-based, since the last `reset()`. */
  readonly sequence: number;
  /** The injected clock when the call arrived, in milliseconds. */
  readonly at: number;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  /** The status the fake produced. For a crashed call it is the status of the call it applied. */
  readonly status: number;
  readonly mutating: boolean;
  /** True when `control.crashAfterMutating` made the client see a network failure instead. */
  readonly crashed: boolean;
}

export interface CallLog {
  /** A copy of every call so far, oldest first. */
  all(): readonly CallRecord[];
  /** The calls that changed the directory: what the idempotency tests count (SC-B-002). */
  mutating(): readonly CallRecord[];
  forHost(host: string): readonly CallRecord[];
  readonly length: number;
  clear(): void;
}

export interface FakeTenantControl {
  /**
   * Applies the n-th mutating call since the last `reset()` and then fails the client's `fetch` like a
   * dropped connection (`SimulatedNetworkFailure`). It fires once. `n` is a whole number from 1.
   */
  crashAfterMutating(n: number): void;
  /** Disarms a crash that has not fired. */
  cancelCrash(): void;
  /** The `n` of an armed crash, or `null`. */
  readonly pendingCrash: number | null;
  /** The injected clock's reading, in milliseconds. */
  now(): number;
}

export interface FakeTenantOptions {
  /** Required: the fake never reads the wall clock. */
  readonly clock: FakeTenantClock;
  /** Modules that stay mounted for the life of the fake; `reset()` calls their reset hooks. */
  readonly modules?: readonly FakeTenantModule[];
}

export interface FakeTenant {
  /** A WHATWG handler: keyed by host and path, no network, no globals. */
  fetch(request: Request): Promise<Response>;
  readonly control: FakeTenantControl;
  readonly calls: CallLog;
  /**
   * Back to the initial directory: module state restored through the reset hooks, test-mounted
   * modules removed, calls and numbering cleared, a pending crash disarmed.
   */
  reset(): void;
  /** Mounts a module for the rest of the test (until `reset()` or the returned function). */
  mount(module: FakeTenantModule): () => void;
}
