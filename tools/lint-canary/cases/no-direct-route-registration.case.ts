// Canary cases for local/no-direct-route-registration (FR-A-031): scope apps/server/src/**/*.ts
// except apps/server/src/http/route.ts, the module that defines defineRoute. These cases import the
// real `hono` package, so the type-aware half of the rule is exercised too.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-direct-route-registration';

const DIRECT_ROUTE = `
import type { Hono } from 'hono';
export function wire(app: Hono): void {
  app.get('/users', (c) => c.json([]));
}
`;

export const cases = [
  {
    name: 'a route registered on an app by name',
    path: 'apps/server/src/__lint_canary__/route-named.ts',
    code: DIRECT_ROUTE,
    mustReport: [RULE],
  },
  {
    name: 'a route registered on a Hono instance that is not called app (by type)',
    path: 'apps/server/src/__lint_canary__/route-typed.ts',
    code: `
import type { Hono } from 'hono';
export function wire(router: Hono): void {
  router.post('/users', (c) => c.json({}));
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a sub-application mounted with route()',
    path: 'apps/server/src/__lint_canary__/route-mount.ts',
    code: `
import type { Hono } from 'hono';
export function wire(parent: Hono, child: Hono): void {
  parent.route('/admin', child);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a second application created outside app.ts',
    path: 'apps/server/src/__lint_canary__/route-new-hono.ts',
    code: `
import { Hono } from 'hono';
export const sub = new Hono();
`,
    mustReport: [RULE],
  },
  {
    name: 'control: middleware and error handlers are allowed',
    path: 'apps/server/src/__lint_canary__/route-middleware.ts',
    code: `
import type { Hono } from 'hono';
export function wire(app: Hono): void {
  app.use('*', async (_c, next) => {
    await next();
  });
  app.onError((_error, c) => c.text('error', 500));
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: get() on something that is not a Hono instance is allowed',
    path: 'apps/server/src/__lint_canary__/route-other-get.ts',
    code: `
export function lookup(cache: Map<string, number>, headers: Headers): number | null {
  return cache.get('a') ?? Number(headers.get('x-count'));
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: app.ts builds the application',
    path: 'apps/server/src/app.ts',
    code: `
import { Hono } from 'hono';
export function createApp(): Hono {
  const app = new Hono();
  app.use('*', async (_c, next) => {
    await next();
  });
  return app;
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: defineRoute lives in http/route.ts and may register routes',
    path: 'apps/server/src/http/route.ts',
    code: DIRECT_ROUTE,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the server (web)',
    path: 'apps/web/src/__lint_canary__/route-named.ts',
    code: DIRECT_ROUTE,
    mustNotReport: [RULE],
  },
  {
    name: 'control: server tests live outside src and may register routes on a test app',
    path: 'apps/server/test/__lint_canary__/route-named.test.ts',
    code: DIRECT_ROUTE,
    mustNotReport: [RULE],
  },
  // G0 defects D14 and D15: renamed imports, destructured methods, middleware that answers.
  {
    name: 'a second application created through a renamed import',
    path: 'apps/server/src/__lint_canary__/route-renamed-hono.ts',
    code: `
import { Hono as H } from 'hono';
export const sub = new H();
`,
    mustReport: [RULE],
  },
  {
    name: 'a route method taken off the application with destructuring',
    path: 'apps/server/src/__lint_canary__/route-destructured.ts',
    code: `
import type { Hono } from 'hono';
export function wire(app: Hono): void {
  const { get } = app;
  get('/x', (c) => c.text('x'));
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a route registered with use() by a handler that never calls next',
    path: 'apps/server/src/__lint_canary__/route-use-handler.ts',
    code: `
import type { Hono } from 'hono';
export function wire(app: Hono): void {
  app.use('/open', (c) => c.text('ok'));
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a route method called with a name held in a variable',
    path: 'apps/server/src/__lint_canary__/route-dynamic-method.ts',
    code: `
import type { Hono } from 'hono';
export function wire(app: Hono, method: 'get' | 'post'): void {
  app[method]('/x', (c) => c.text('x'));
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a .mjs module of the server is linted',
    path: 'apps/server/src/__lint_canary__/route-new-hono.mjs',
    code: `
import { Hono } from 'hono';
export const sub = new Hono();
`,
    mustReport: [RULE],
  },
  {
    name: 'control: a middleware that calls next is allowed',
    path: 'apps/server/src/__lint_canary__/route-use-next.ts',
    code: `
import type { Hono } from 'hono';
export function wire(app: Hono): void {
  app.use('/api/*', async (c, next) => {
    c.header('x-test', '1');
    await next();
  });
  app.use(async (_c, next) => next());
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
