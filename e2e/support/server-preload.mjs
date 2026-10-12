// The e2e server's preload (T-B-370, CB17, PB-19): `node --import e2e/support/server-preload.mjs
// apps/server/dist/index.js`. The built server is the production bundle and knows nothing about the
// fake tenant; this file, loaded before it, does two things from the outside:
//
//   1. installs the no-egress guard (`apps/server/test/support/no-egress.ts`): a connection to
//      anything but the loopback interface is destroyed with `ENOEGRESS`, so a stray call to
//      Microsoft fails loudly instead of leaving the machine;
//   2. puts MSW on global `fetch` (the fetch-only interceptor, as in `apps/server/test/support/msw.ts`)
//      and forwards the three Microsoft hosts to the local fake tenant over plain HTTP, with
//      `bypass()` so the forwarded request is not intercepted again. A request to any other host that
//      is not on the loopback interface ends in an error.
//
// Environment (set by `servers.ts`): E2E_FAKE_ORIGIN (http://127.0.0.1:<E2E_PORT + 2>) and
// E2E_FAKE_TENANT (`a` or `b`: the tenant of this instance). No production file refers to this file.
import { register } from 'tsx/esm/api';

register();

const { installNoEgress, isLoopbackHost } = await import(
  new URL('../../apps/server/test/support/no-egress.ts', import.meta.url).href
);
const { HttpResponse, bypass, http } = await import('msw');
const { FetchInterceptor } = await import('@mswjs/interceptors/fetch/web');
const { defineNetwork, InMemoryHandlersController, InterceptorSource } = await import(
  'msw/experimental'
);

const fakeOrigin = process.env.E2E_FAKE_ORIGIN ?? '';
const tenant = process.env.E2E_FAKE_TENANT ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(fakeOrigin) || !/^[ab]$/.test(tenant)) {
  throw new Error('server-preload: E2E_FAKE_ORIGIN and E2E_FAKE_TENANT must be set by servers.ts');
}

installNoEgress();

const MICROSOFT = /^https:\/\/(login\.microsoftonline\.com|graph\.microsoft\.com|outlook\.office365\.com)\//;
const DROPPED = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);

const forward = http.all(MICROSOFT, async ({ request }) => {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!DROPPED.has(name)) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const forwarded = new Request(`${fakeOrigin}/t/${tenant}/${url.hostname}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  });
  try {
    const upstream = await fetch(bypass(forwarded), { redirect: 'manual' });
    // A fresh Response: the one `fetch` returned already carries its URL, which MSW cannot set again.
    const empty = [101, 204, 205, 304].includes(upstream.status);
    return new Response(empty ? null : await upstream.arrayBuffer(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch {
    // The fake dropped the connection on purpose (a crash switch), or is gone: a network failure.
    return HttpResponse.error();
  }
});

const network = defineNetwork({
  sources: [new InterceptorSource({ interceptors: [new FetchInterceptor()] })],
  handlers: new InMemoryHandlersController([forward]),
  context: { quiet: true },
});

network.configure({
  onUnhandledFrame({ frame }) {
    const request = frame.protocol === 'http' ? frame.data?.request : undefined;
    if (request !== undefined) {
      try {
        if (isLoopbackHost(new URL(request.url).hostname.replace(/^\[|\]$/g, ''))) return;
      } catch {
        // fall through to the error
      }
    }
    throw Object.assign(
      new Error(
        `server-preload: unhandled network request (${request?.method ?? frame.protocol} ${request?.url ?? ''}): only the three Microsoft hosts are simulated`,
      ),
      { code: 'EUNHANDLEDREQUEST', errno: -1 },
    );
  },
});
network.enable();
