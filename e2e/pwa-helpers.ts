// Helpers of the PWA specs: a small reverse proxy in front of the preview instance that can pretend the
// server was upgraded. The service worker script (`/sw.js`) and the version the server reports (the
// embedded `me` of the shell and `/api/v1/me`) carry the build version; the proxy rewrites that one
// string, which is exactly what a deployment of another build changes. Playwright cannot do this with
// `route`: it does not see the browser's own fetch of the worker script.
//
// The proxy has its own origin, so the `guard` fixture counts requests to it as "another origin"; the
// specs that use it take those problems on purpose (`guard.take('origin')`).
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { portOf } from './servers.js';

export const BUILD_VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();

export interface VersionProxy {
  readonly origin: string;
  /** The version the proxied server pretends to run. */
  version: string;
  /** Every path that went through, in order. */
  readonly seen: string[];
  close(): Promise<void>;
}

const REWRITTEN = /^\/(sw\.js|api\/v1\/me)(\?.*)?$/;

function collect(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => { resolve(Buffer.concat(chunks)); });
    response.on('error', reject);
  });
}

export async function startVersionProxy(): Promise<VersionProxy> {
  const upstreamPort = portOf('preview');
  const state: VersionProxy = {
    origin: '',
    version: BUILD_VERSION,
    seen: [],
    close: () => closeServer(server),
  };
  const server: Server = createServer((incoming, outgoing) => {
    state.seen.push(incoming.url ?? '');
    const headers = {
      ...incoming.headers,
      host: `localhost:${String(upstreamPort)}`,
      'accept-encoding': 'identity',
    };
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (response) => {
        const path = incoming.url ?? '';
        const isHtmlShell = (response.headers['content-type'] ?? '').includes('text/html');
        if (!REWRITTEN.test(path) && !isHtmlShell) {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
          return;
        }
        void collect(response).then((body) => {
          const rewritten = body.toString('utf8').replaceAll(BUILD_VERSION, state.version);
          const out = { ...response.headers };
          delete out['content-length'];
          delete out['content-encoding'];
          delete out.etag;
          outgoing.writeHead(response.statusCode ?? 502, out);
          outgoing.end(rewritten);
        });
      },
    );
    upstream.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port');
  (state as { origin: string }).origin = `http://localhost:${String(address.port)}`;
  return state;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => { resolve(); });
  });
}
