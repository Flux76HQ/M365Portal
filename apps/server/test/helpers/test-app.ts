// The harness around the application under test (plan 13.2): a fresh data directory, an injected
// clock, a log capture and an environment, handed to a `buildApp` factory, plus clients that reach
// the result in process or over a real socket.
//
// The factory is the only thing a test supplies about the application. Before the composition root
// exists (T-A-045) it builds a few routes written in the test itself; afterwards it calls the real
// `buildApp(deps)`. Anything with a `fetch(request)` method will do, so the harness depends on no
// part of the server.
//
// Everything is removed when the test ends (or earlier, by `close()`): the data directory the
// harness created, the application (through the optional `stop` callback) and every real server it
// started. A data directory the test brings itself is left alone.
import { createServer, type Server, type ServerOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { DEFAULT_PORT } from '@m365portal/shared/limits';
import { createFakeClock, type FakeClock } from './fake-clock.js';
import { createHttpClient, type FetchLike, type HttpClient } from './http-client.js';
import { createLogCapture, type LogCapture } from './log-capture.js';
import { afterCurrentTest, createTempDataDir } from './temp-data-dir.js';

/** The part of an application the harness needs: Hono, `@hono/zod-openapi` and plain objects fit. */
export interface FetchableApp {
  fetch(request: Request, env?: unknown): Response | Promise<Response>;
}

/** What the factory receives; also readable from the `TestApp`. */
export interface TestAppContext {
  /** `DATA_DIR` of this test: a fresh private directory, or the one the test passed in. */
  readonly dataDir: string;
  /** The clock the application must read all time from. */
  readonly clock: FakeClock;
  /** The destination of the application's log: JSON lines, readable as data. */
  readonly logs: LogCapture;
  /** The configuration the application is built with, as the environment variables it would read. */
  readonly env: Readonly<Record<string, string>>;
  /** The origin of `PUBLIC_BASE_URL`: what a browser sends as `Origin`. */
  readonly publicOrigin: string;
}

export interface CreateTestAppOptions<App extends FetchableApp> {
  readonly buildApp: (context: TestAppContext) => App | Promise<App>;
  /** Called once by `close()`, for an application that has something to stop. */
  readonly stop?: (app: App) => void | Promise<void>;
  /** Environment variables over the defaults (`DATA_DIR`, `PUBLIC_BASE_URL`, `HOST`). */
  readonly env?: Readonly<Record<string, string>>;
  /** The origin of `PUBLIC_BASE_URL`. Default: `http://localhost:<DEFAULT_PORT>`. */
  readonly publicOrigin?: string;
  /** A clock the test already has. Default: a new one. */
  readonly clock?: FakeClock;
  /** Use this `DATA_DIR` instead of a fresh one; the harness neither creates nor removes it. */
  readonly dataDir?: string;
}

export interface ClientOptions {
  /** Headers for every request of this client. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The address of the simulated socket peer of in-process requests. Default `127.0.0.1`. */
  readonly peer?: string;
}

export interface ListenOptions {
  /** Options of the Node HTTP server, such as `maxHeaderSize` or `requestTimeout`. */
  readonly serverOptions?: ServerOptions;
}

export interface RunningServer {
  /** `http://127.0.0.1:<port>`: where the socket is. */
  readonly origin: string;
  readonly port: number;
  readonly server: Server;
  /** A client that connects to the socket and sends the `Origin` of `PUBLIC_BASE_URL`. */
  readonly client: HttpClient;
  close(): Promise<void>;
}

export interface TestApp<App extends FetchableApp> extends TestAppContext {
  readonly app: App;
  /** In process, with the default peer `127.0.0.1`. */
  readonly client: HttpClient;
  clientFor(options?: ClientOptions): HttpClient;
  /** Serve the application on a free port of the loopback interface. */
  listen(options?: ListenOptions): Promise<RunningServer>;
  /** Stop the servers and the application, and remove the data directory. Safe to call twice. */
  close(): Promise<void>;
}

const DEFAULT_PEER = '127.0.0.1';

/**
 * What `@hono/node-server` puts in the second argument of `fetch`, as far as `getConnInfo` reads
 * it. An in-process request has no socket, so the harness supplies one with the address a test asks
 * for (the trust-proxy, rate-limit and preview-mode tests).
 */
function peerBindings(peer: string): unknown {
  return {
    incoming: {
      socket: {
        remoteAddress: peer,
        remotePort: 54_321,
        remoteFamily: peer.includes(':') ? 'IPv6' : 'IPv4',
      },
    },
    outgoing: {},
  };
}

function resolvePublicOrigin<App extends FetchableApp>(
  options: CreateTestAppOptions<App>,
): { baseUrl: string; origin: string } {
  const fromEnv = options.env?.PUBLIC_BASE_URL;
  if (fromEnv !== undefined && options.publicOrigin !== undefined) {
    if (new URL(fromEnv).origin !== new URL(options.publicOrigin).origin) {
      throw new Error('env.PUBLIC_BASE_URL and publicOrigin name different origins');
    }
  }
  const baseUrl = fromEnv ?? options.publicOrigin ?? `http://localhost:${String(DEFAULT_PORT)}`;
  return { baseUrl, origin: new URL(baseUrl).origin };
}

export async function createTestApp<App extends FetchableApp>(
  options: CreateTestAppOptions<App>,
): Promise<TestApp<App>> {
  const ownDirectory = options.dataDir === undefined ? await createTempDataDir() : undefined;
  const dataDir = options.dataDir ?? ownDirectory?.path ?? '';
  const { baseUrl, origin: publicOrigin } = resolvePublicOrigin(options);
  const env: Readonly<Record<string, string>> = {
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: baseUrl,
    HOST: '127.0.0.1',
    ...options.env,
  };
  const context: TestAppContext = {
    dataDir,
    clock: options.clock ?? createFakeClock(),
    logs: createLogCapture(),
    env,
    publicOrigin,
  };

  let app: App;
  try {
    app = await options.buildApp(context);
  } catch (failure) {
    await ownDirectory?.remove();
    throw failure;
  }

  const running = new Set<RunningServer>();
  let closing: Promise<void> | undefined;

  const inProcess = (peer: string): FetchLike => {
    const bindings = peerBindings(peer);
    return (request) => app.fetch(request, bindings);
  };

  const clientFor = (clientOptions: ClientOptions = {}): HttpClient =>
    createHttpClient({
      fetch: inProcess(clientOptions.peer ?? DEFAULT_PEER),
      baseUrl: publicOrigin,
      origin: publicOrigin,
      ...(clientOptions.headers === undefined ? {} : { headers: clientOptions.headers }),
    });

  const listen = async (listenOptions: ListenOptions = {}): Promise<RunningServer> => {
    const listener = getRequestListener((request, bindings) => app.fetch(request, bindings));
    const server = createServer(listenOptions.serverOptions ?? {}, (incoming, outgoing) => {
      void listener(incoming, outgoing);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    const serverOrigin = `http://127.0.0.1:${String(port)}`;
    let stopped = false;
    const handle: RunningServer = {
      origin: serverOrigin,
      port,
      server,
      client: createHttpClient({
        fetch: (request) => fetch(request),
        baseUrl: serverOrigin,
        origin: publicOrigin,
      }),
      close: async () => {
        if (stopped) return;
        stopped = true;
        running.delete(handle);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      },
    };
    running.add(handle);
    return handle;
  };

  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const server of [...running]) await server.close();
      await options.stop?.(app);
      await ownDirectory?.remove();
    })();
    return closing;
  };
  afterCurrentTest(close);

  return {
    ...context,
    app,
    client: clientFor(),
    clientFor,
    listen,
    close,
  };
}
