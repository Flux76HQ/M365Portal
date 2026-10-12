// The entry. The order of the first lines matters:
//   1. zod-config   Zod must not probe `new Function` (Trusted Types, probe P17): before any schema parses.
//   2. app.css      the stylesheet (the server inlines the built result into the HTML shell).
//   3. the nonce    libraries that inject a <style> at run time read `__webpack_nonce__` (probe P15).
//   4. the cache    `me` and `branding` come embedded in the page, so the first render needs no request;
//                   an anonymous boot actor is checked once against GET /api/v1/me first (boot/recheck.ts).
//
// The stage modules (boot/stage-*.ts) are the dynamic imports of the start-up; build/plugins/defer-entry.ts
// finds their chunks by that name and preloads them all in parallel, so the chain of tasks is not a chain
// of network round trips.
//
// The start-up is a chain of short tasks (T-A-173, plan 14.2 tactic 4). One static import graph is
// evaluated in ONE task of 40 ms or more, and a task over 12 ms on a phone counts against Total Blocking
// Time, so each part of the application is a dynamic `import()` with the main thread handed back in
// between (boot/yield.ts), and the first render is a transition, which React slices itself. The static
// shell in index.html is on screen the whole time (build/plugins/static-shell.ts).
import './boot/zod-config';
import './styles/app.css';
import { installNonceShim } from './boot/nonce-shim';
import { yieldToMain } from './boot/yield';

async function start(): Promise<void> {
  const nonce = installNonceShim();
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('#root element is missing from index.html');

  const { StrictMode, startTransition, createRoot } = await import('./boot/stage-react');
  await yieldToMain();
  const data = await import('./boot/stage-data');
  await yieldToMain();
  const queryClient = data.createAppQueryClient();
  const api = data.getApiClient();
  const bootData = data.readBootData();
  if (bootData) data.seedQueryClient(queryClient, bootData, api);
  // A cross-site entry drops the Strict cookie: ask once before any gating redirect (T-B-296, PB-15).
  await data.recheckBootSession({ boot: bootData, queryClient, api });
  const { createAppRouter } = await import('./boot/stage-router');
  await yieldToMain();
  const router = createAppRouter(undefined, { queryClient, api });
  // Match the URL and load its route's code and data before the first render: the first render is then
  // one pass that React slices, instead of a frame followed by a second, synchronous pass when the
  // route arrives (the router's store updates are synchronous and cannot be sliced).
  await router.load();
  await yieldToMain();
  const { RootProviders } = await import('./boot/stage-ui');
  await yieldToMain();

  const root = createRoot(rootElement);
  // A transition lane: React renders the first tree in slices of about 5 ms and yields in between.
  startTransition(() => {
    root.render(
      <StrictMode>
        <RootProviders router={router} queryClient={queryClient} nonce={nonce} />
      </StrictMode>,
    );
  });

  // After the first render and the load event: the worker must never compete with the first paint.
  const { registerServiceWorkerWhenLoaded } = await import('./lib/sw-register');
  registerServiceWorkerWhenLoaded();
}

void start();
