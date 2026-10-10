// local/no-direct-route-registration (FR-A-031): a route is registered through `defineRoute`
// (apps/server/src/http/route.ts) and nowhere else, because only defineRoute forces the route to
// declare `permission` or `public: true` and puts the guards in their fixed order. A route added
// straight on a Hono instance would skip all of it.
//
// Two suites: the first has no type information and recognises an app by its name (`app`) and by
// how it is built; the second has types and recognises a Hono instance by its type, whatever it is
// called, through subclasses, unions and generic constraints.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  createRuleTester,
  createTypedRuleTester,
  ruleOf,
  scopeOf,
  STRICT_ASSERTIONS,
} from './support.js';

const rule = ruleOf('no-direct-route-registration');
const FILE = 'apps/server/src/modules/example.ts';
const APP_FILE = 'apps/server/src/app.ts';

/** Methods that register a route or mount something that does (T-A-008, plus `openapi`). */
const REGISTRATION_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'all',
  'on',
  'route',
  'mount',
  'openapi',
] as const;

function validCase(code: string, name?: string, filename = FILE): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename };
}

function direct(
  code: string,
  method: string,
  name?: string,
  filename = FILE,
): RuleTester.InvalidTestCase {
  return {
    name: name ?? code,
    code,
    filename,
    errors: [{ messageId: 'directRoute', data: { method } }],
  };
}

function constructed(code: string, name: string, label?: string): RuleTester.InvalidTestCase {
  return {
    name: label ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'newHono', data: { name } }],
  };
}

// ---------------------------------------------------------------------------------------------
// Without type information: names and shapes.
// ---------------------------------------------------------------------------------------------

createRuleTester().run('local/no-direct-route-registration (names)', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    // Middleware and handlers are not routes.
    validCase("app.use('*', secureHeaders());"),
    validCase('app.use(middleware);'),
    validCase('app.onError(handler);'),
    validCase('app.notFound(handler);'),
    validCase("await app.request('/healthz');"),
    validCase('app.fetch(request);'),
    validCase("app.basePath('/api');"),

    // The sanctioned way, and things that only look similar.
    validCase("defineRoute({ id: 'x', method: 'get', path: '/x', access: { public: true } });"),
    validCase("cache.get('key');"),
    validCase('headers.get(`x-${name}`);'),
    validCase("c.get('requestId');"),
    validCase("c.req.header('origin');"),
    validCase("router.get('/x', handler);", 'untyped, not named app: nothing to go on'),
    validCase("params.delete('page');", 'URLSearchParams#delete'),
    validCase('const map = new Map();'),
    validCase('const router = new Router();'),
    validCase('const app = createApp(); app.use(x);'),
    validCase('class Hono {}', 'a declaration is not a construction'),

    // app.ts builds the application: it may construct Hono, and (until /healthz moves into
    // defineRoute, T-A-042) it still registers that one scaffold route.
    validCase('const app = new Hono();', 'app.ts constructs the application', APP_FILE),
    validCase('const app = new OpenAPIHono();', 'app.ts constructs the application', APP_FILE),
    validCase("app.use('*', mw);", 'middleware in app.ts', APP_FILE),
    validCase(
      "app.get('/healthz', (c) => c.json({ status: 'ok' }));",
      'the scaffold health route in app.ts (to be removed with T-A-042 and T-A-045)',
      APP_FILE,
    ),
    validCase(
      'const app = new Hono();',
      'app.ts is recognised wherever the repository sits, and from any working directory',
      '/work/checkout/apps/server/src/app.ts',
    ),
  ],

  invalid: [
    // Every registering method on the conventional name.
    ...REGISTRATION_METHODS.map((method) =>
      direct(`app.${method}('/x', handler);`, method, `app.${method}`),
    ),
    direct("app?.get('/x', handler);", 'get', 'optional call'),
    direct("app['get']('/x', handler);", 'get', 'computed method name'),
    direct("app.on('GET', '/x', handler);", 'on'),
    direct("this.app.get('/x', handler);", 'get', 'a member named app'),
    direct("deps.app.post('/x', handler);", 'post', 'a member named app, deeper'),
    direct("c.app.get('/x', handler);", 'get', 'the context app'),
    direct("app.use(middleware).get('/x', handler);", 'get', 'after middleware in a chain'),
    direct("app.basePath('/api').post('/x', handler);", 'post', 'after basePath in a chain'),
    direct(
      "app.get('/other', handler);",
      'get',
      'app.ts: any route but the scaffold one',
      APP_FILE,
    ),
    direct(
      "app.post('/healthz', handler);",
      'post',
      'app.ts: only GET /healthz is excused',
      APP_FILE,
    ),
    direct("app.get('/healthz', handler);", 'get', 'the scaffold route is excused in app.ts only'),
    {
      name: 'both calls of a chain are reported',
      code: "app.get('/a', handler).post('/b', handler);",
      filename: FILE,
      errors: [
        { messageId: 'directRoute', data: { method: 'get' }, column: 5 },
        { messageId: 'directRoute', data: { method: 'post' }, column: 24 },
      ],
    },

    // Constructing an application.
    {
      name: 'a file whose name only resembles app.ts',
      code: 'const sub = new Hono();',
      filename: 'apps/server/src/application.ts',
      errors: [{ messageId: 'newHono', data: { name: 'Hono' } }],
    },
    {
      name: 'an app.ts of another package',
      code: 'const sub = new Hono();',
      filename: 'apps/other/src/app.ts',
      errors: [{ messageId: 'newHono', data: { name: 'Hono' } }],
    },
    constructed('const sub = new Hono();', 'Hono'),
    constructed('const sub = new OpenAPIHono();', 'OpenAPIHono'),
    constructed(
      'const sub = new Hono<{ Bindings: Env }>({ strict: false });',
      'Hono',
      'with type arguments',
    ),
    {
      name: 'a fresh instance with a route: both are reported',
      code: "new Hono().get('/x', handler);",
      filename: FILE,
      errors: [
        { messageId: 'newHono', data: { name: 'Hono' } },
        { messageId: 'directRoute', data: { method: 'get' } },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------------------------
// With type information: the receiver's type decides.
// ---------------------------------------------------------------------------------------------

const PRELUDE = `export {};
declare class Hono {
  get(path: string, handler: () => void): this;
  post(path: string, handler: () => void): this;
  use(...middleware: unknown[]): this;
}
declare class OpenAPIHono extends Hono {
  openapi(route: unknown, handler: () => void): this;
}
declare class Router {
  get(path: string): this;
}
declare class Context {
  get(key: string): unknown;
}
declare function handler(): void;
`;

let typedFileCount = 0;
const typedFilenames: string[] = [];

function typedFile(): string {
  typedFileCount += 1;
  const filename = `apps/server/src/__rule_tester__/typed-${String(typedFileCount)}.ts`;
  typedFilenames.push(filename);
  return filename;
}

function typedValid(body: string, name: string): RuleTester.ValidTestCase {
  return { name, code: `${PRELUDE}${body}`, filename: typedFile() };
}

function typedInvalid(body: string, method: string, name: string): RuleTester.InvalidTestCase {
  return {
    name,
    code: `${PRELUDE}${body}`,
    filename: typedFile(),
    errors: [{ messageId: 'directRoute', data: { method } }],
  };
}

const typedValidCases = [
  typedValid("declare const router: Router;\nrouter.get('/x');", 'a class that is not Hono'),
  typedValid("declare const ctx: Context;\nctx.get('requestId');", "Hono's context"),
  typedValid("declare const lookup: Map<string, string>;\nlookup.get('k');", 'a Map'),
  typedValid('declare const router: Hono;\nrouter.use(handler);', 'middleware on a Hono instance'),
  typedValid('declare const api: OpenAPIHono;\napi.use(handler);', 'middleware on an OpenAPIHono'),
  typedValid("declare const headers: Headers;\nheaders.get('x');", 'Headers'),
];

const typedInvalidCases = [
  typedInvalid(
    "declare const router: Hono;\nrouter.get('/x', handler);",
    'get',
    'by type, not by name',
  ),
  typedInvalid(
    'declare const api: OpenAPIHono;\napi.openapi({}, handler);',
    'openapi',
    'OpenAPIHono',
  ),
  typedInvalid(
    "declare const api: OpenAPIHono;\napi.post('/x', handler);",
    'post',
    'inherited method',
  ),
  typedInvalid(
    "declare class AdminApp extends Hono {}\ndeclare const admin: AdminApp;\nadmin.post('/x', handler);",
    'post',
    'a subclass',
  ),
  typedInvalid(
    "declare const maybe: Hono | undefined;\nmaybe?.get('/x', handler);",
    'get',
    'a union with undefined',
  ),
  typedInvalid(
    "function wire<T extends Hono>(r: T): void {\n  r.get('/x', handler);\n}",
    'get',
    'a generic constrained to Hono',
  ),
  typedInvalid(
    "declare const router: Hono;\nrouter.use(handler).post('/x', handler);",
    'post',
    'after middleware in a chain',
  ),
  typedInvalid(
    "type Server = Hono;\ndeclare const x: Server;\nx.get('/x', handler);",
    'get',
    'through a type alias',
  ),
  typedInvalid(
    "declare const x: Hono & { extra: number };\nx.get('/x', handler);",
    'get',
    'an intersection',
  ),
];

createTypedRuleTester(typedFilenames).run('local/no-direct-route-registration (types)', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: typedValidCases,
  invalid: typedInvalidCases,
});

describe('local/no-direct-route-registration: scope', () => {
  it('applies to the server source, except the module that defines defineRoute', () => {
    const scope = scopeOf('no-direct-route-registration');

    expect(scope.files).toEqual(['apps/server/src/**/*.ts']);
    expect(scope.ignores).toEqual(['apps/server/src/http/route.ts']);
  });
});
