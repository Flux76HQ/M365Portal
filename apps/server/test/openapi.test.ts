// T-A-040 (FR-A-021, PD-22, V-12, C4): the OpenAPI 3.1 document is generated from the same route
// definitions that enforce the rules, and it cannot drift from them.
//
//   - It validates against the OpenAPI 3.1 meta-schema (@seriousme/openapi-schema-validator).
//   - Every operation carries `x-route-id`, exactly one of `x-permission` or `x-public`, and
//     `x-rate-limit`; `x-audit` only where the route declares an audit action.
//   - Every registered route is documented and every documented route is registered. A route the
//     document does not know, and a document entry the router does not hold, each fail the check.
//
// The route at `/api/v1/openapi.json` itself is T-A-042 and is tested in this file once it exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  assertOpenApiParity,
  checkOpenApiParity,
  type OpenApiDocument,
} from '../src/http/openapi.js';
import { registeredRoutesOf } from '../src/http/route-table.js';
import type { AppEnv } from '../src/http/request-context.js';
import { createFixtureApp, type FixtureApp } from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';
import { startWizardServer } from './setup/support/server-scene.js';

type Operation = Record<string, unknown> & {
  readonly responses?: Record<string, { content?: Record<string, unknown> }>;
  readonly parameters?: readonly { name: string; in: string; required?: boolean }[];
};

function operationsOf(document: OpenApiDocument): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      operations.set(`${method.toUpperCase()} ${path}`, operation as Operation);
    }
  }
  return operations;
}

async function withApp<T>(run: (app: FixtureApp) => T | Promise<T>): Promise<T> {
  const app = await createFixtureApp();
  return await run(app);
}

describe('the document is OpenAPI 3.1 (FR-A-021)', () => {
  it('declares version 3.1.0, an info block, and the root as the server', async () => {
    await withApp((app) => {
      const { document } = app.http;
      expect(document.openapi).toBe('3.1.0');
      expect(document.info.title).toBe('M365Portal API');
      expect(document.info.version).toBe('0.0.0-test');
      expect(document.servers).toEqual([{ url: '/' }]);
    });
  });

  it('validates against the OpenAPI 3.1 meta-schema', async () => {
    await withApp(async (app) => {
      const result = await new Validator().validate(app.http.document as never);
      expect(result.valid).toBe(true);
    });
  });

  it('negative fixture: the validator rejects a document with an invalid info block', async () => {
    await withApp(async (app) => {
      const broken = { ...app.http.document, info: {} };
      const validate = async (document: OpenApiDocument): Promise<void> => {
        const result = await new Validator().validate(document as never);
        if (!result.valid) throw new Error('the document does not validate');
      };
      await expectGuardFails(validate, broken as OpenApiDocument, {
        reason: 'does not validate',
      });
    });
  });

  it('is plain JSON: it survives a JSON round trip unchanged', async () => {
    await withApp((app) => {
      const { document } = app.http;
      expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    });
  });
});

describe('every operation is generated from a definition (V-12)', () => {
  it('documents exactly the routes of the table, by method and path', async () => {
    await withApp((app) => {
      const documented = [...operationsOf(app.http.document).keys()].sort();
      const declared = app.http.table.routes
        .map((route) => `${route.methods[0] ?? ''} ${route.paths[0] ?? ''}`)
        .sort();
      expect(documented).toEqual(declared);
      expect(documented.length).toBeGreaterThan(5);
    });
  });

  it('does not document a fallback', async () => {
    await withApp((app) => {
      expect(app.http.table.fallbacks.length).toBeGreaterThan(0);
      const text = JSON.stringify(app.http.document.paths);
      for (const fallback of app.http.table.fallbacks) expect(text).not.toContain(fallback.id);
    });
  });

  it('gives each operation its route id as x-route-id and as operationId', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      for (const route of app.http.table.routes) {
        const operation = operations.get(`${route.methods[0] ?? ''} ${route.paths[0] ?? ''}`);
        expect(operation?.['x-route-id'], route.id).toBe(route.id);
        expect(operation?.operationId, route.id).toBe(route.id);
      }
    });
  });

  it('gives each operation exactly one of x-permission and x-public, from the access it declares', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      for (const route of app.http.table.routes) {
        const operation = operations.get(`${route.methods[0] ?? ''} ${route.paths[0] ?? ''}`);
        if (operation === undefined) throw new Error(`${route.id} is not documented`);
        const hasPermission = 'x-permission' in operation;
        const hasPublic = 'x-public' in operation;
        expect(hasPermission !== hasPublic, route.id).toBe(true);
        if ('permission' in route.access) {
          expect(operation['x-permission'], route.id).toBe(route.access.permission);
        } else {
          expect(operation['x-public'], route.id).toBe(true);
        }
      }
    });
  });

  it('gives each operation its rate class as x-rate-limit', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      for (const route of app.http.table.routes) {
        const operation = operations.get(`${route.methods[0] ?? ''} ${route.paths[0] ?? ''}`);
        expect(operation?.['x-rate-limit'], route.id).toBe(route.rateLimit);
      }
      expect(operations.get('POST /api/v1/fixture/upload')?.['x-rate-limit']).toBe('upload');
      expect(operations.get('GET /api/v1/fixture/read')?.['x-rate-limit']).toBe('read');
    });
  });

  it('gives x-audit to the routes that declare an audit action, and only to them', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      expect(operations.get('GET /api/v1/fixture/export')?.['x-audit']).toBe('fixture.export');
      expect(operations.get('POST /api/v1/fixture/things')?.['x-audit']).toBe('fixture.create');
      expect('x-audit' in (operations.get('GET /api/v1/fixture/read') ?? {})).toBe(false);
      expect('x-audit' in (operations.get('PUT /api/v1/fixture/things/{id}') ?? {})).toBe(false);
    });
  });

  it('documents path parameters, request bodies and the declared responses', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      const item = operations.get('GET /api/v1/fixture/items/{id}');
      expect(item?.parameters).toEqual([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
      ]);
      const create = operations.get('POST /api/v1/fixture/things');
      expect(create?.requestBody).toBeDefined();
      expect(Object.keys(create?.responses ?? {})).toContain('201');
    });
  });

  it('uses the shared Problem component for the problem responses the guards can produce', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      const create = operations.get('POST /api/v1/fixture/things');
      const statuses = Object.keys(create?.responses ?? {});
      for (const status of ['201', '403', '413', '415', '422', '429', '500']) {
        expect(statuses, status).toContain(status);
      }
      const problem = create?.responses?.['403']?.content?.['application/problem+json'];
      expect(JSON.stringify(problem)).toContain('#/components/schemas/Problem');
      expect(app.http.document.components?.schemas).toHaveProperty('Problem');
    });
  });

  it('promises a 429 for a rate-limited route and no 403 for a public read', async () => {
    await withApp((app) => {
      const operations = operationsOf(app.http.document);
      const read = Object.keys(operations.get('GET /api/v1/fixture/read')?.responses ?? {});
      expect(read).not.toContain('403');
      expect(read).toContain('429');
    });
  });

  it('names the component of every shared schema by its meta id', async () => {
    await withApp((app) => {
      const names = Object.keys(app.http.document.components?.schemas ?? {});
      expect(names).toEqual(expect.arrayContaining(['Problem', 'CsrfResponse', 'FixtureThing']));
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Documented and registered, in both directions
// ---------------------------------------------------------------------------------------------

describe('every registered route is documented and every documented route is registered', () => {
  it('holds for the real application', async () => {
    await withApp((app) => {
      expect(
        checkOpenApiParity({
          document: app.http.document,
          table: app.http.table,
          registered: registeredRoutesOf(app.http.app),
        }),
      ).toEqual([]);
    });
  });

  it('fails for a route that is registered and not documented', async () => {
    await withApp((app) => {
      const sneaky = new Hono<AppEnv>();
      sneaky.get('/api/v1/sneaky', () => new Response('x'));
      const registered = [...registeredRoutesOf(app.http.app), ...registeredRoutesOf(sneaky)];
      const problems = checkOpenApiParity({
        document: app.http.document,
        table: app.http.table,
        registered,
      });
      expect(problems.join('\n')).toMatch(/GET \/api\/v1\/sneaky.*registered but not documented/);
    });
  });

  it('fails for a route that is documented and not registered', async () => {
    await withApp((app) => {
      const document = structuredClone(app.http.document);
      document.paths = {
        ...document.paths,
        '/api/v1/ghost': { get: { 'x-route-id': 'ghost.get', 'x-public': true, responses: {} } },
      };
      const problems = checkOpenApiParity({
        document,
        table: app.http.table,
        registered: registeredRoutesOf(app.http.app),
      });
      expect(problems.join('\n')).toMatch(/GET \/api\/v1\/ghost.*documented but not registered/);
    });
  });

  it('fails when a registered route of the table has been left out of the document', async () => {
    await withApp((app) => {
      const document = structuredClone(app.http.document);
      delete (document.paths as Record<string, unknown>)['/api/v1/fixture/read'];
      const problems = checkOpenApiParity({
        document,
        table: app.http.table,
        registered: registeredRoutesOf(app.http.app),
      });
      expect(problems.join('\n')).toMatch(/fixture\.read.*not documented/);
    });
  });

  it('fails when an operation claims a permission its route does not declare', async () => {
    await withApp((app) => {
      const document = structuredClone(app.http.document);
      const operation = (document.paths as Record<string, Record<string, Operation>>)[
        '/api/v1/fixture/things'
      ]?.post;
      if (operation === undefined) throw new Error('the fixture route is not documented');
      operation['x-permission'] = 'rbac:manage';
      const problems = checkOpenApiParity({
        document,
        table: app.http.table,
        registered: registeredRoutesOf(app.http.app),
      });
      expect(problems.join('\n')).toMatch(/fixture\.create.*x-permission/);
    });
  });

  it('fails when an operation names a route id the table does not know', async () => {
    await withApp((app) => {
      const document = structuredClone(app.http.document);
      const operation = (document.paths as Record<string, Record<string, Operation>>)[
        '/api/v1/fixture/read'
      ]?.get;
      if (operation === undefined) throw new Error('the fixture route is not documented');
      operation['x-route-id'] = 'somebody.else';
      const problems = checkOpenApiParity({
        document,
        table: app.http.table,
        registered: registeredRoutesOf(app.http.app),
      });
      expect(problems.join('\n')).toMatch(/somebody\.else/);
    });
  });

  describe('negative fixtures: the check fails on purpose', () => {
    it('an undocumented route', async () => {
      await withApp((app) => {
        const sneaky = new Hono<AppEnv>();
        sneaky.delete('/api/v1/undocumented', () => new Response('x'));
        expectGuardFails(
          assertOpenApiParity,
          {
            document: app.http.document,
            table: app.http.table,
            registered: [...registeredRoutesOf(app.http.app), ...registeredRoutesOf(sneaky)],
          },
          { reason: 'DELETE /api/v1/undocumented' },
        );
      });
    });

    it('a documented route that is not registered', async () => {
      await withApp((app) => {
        const emptyRouter = new Hono<AppEnv>();
        expectGuardFails(
          assertOpenApiParity,
          {
            document: app.http.document,
            table: app.http.table,
            registered: registeredRoutesOf(emptyRouter),
          },
          { reason: 'documented but not registered' },
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-042: the document is served at /api/v1/openapi.json (R3, FR-A-021)
// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/openapi.json (R3)', () => {
  it('serves the document that was generated at start, as JSON, no-store, to everyone', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get('/api/v1/openapi.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await readJson(response)).toEqual(app.http.document);
  });

  it('serves a document that validates against the OpenAPI 3.1 meta-schema', async () => {
    const app = await createFixtureApp({ system: {} });
    const served = await readJson(await app.client.get('/api/v1/openapi.json'));
    const result = await new Validator().validate(served as never);
    expect(result.valid).toBe(true);
  });

  it('documents R1 to R5 and R16 with their access, class and extensions', async () => {
    const app = await createFixtureApp({ system: {} });
    const operations = operationsOf(app.http.document);
    const expected: readonly (readonly [string, string, string])[] = [
      ['GET /healthz', 'health.live', 'exempt'],
      ['GET /readyz', 'health.ready', 'exempt'],
      ['GET /api/v1/openapi.json', 'meta.openapi', 'read'],
      ['GET /api/v1/me', 'meta.me', 'read'],
      ['GET /api/v1/csrf', 'meta.csrf', 'read'],
      ['GET /robots.txt', 'meta.robots', 'read'],
    ];
    for (const [key, id, rate] of expected) {
      const operation = operations.get(key);
      expect(operation?.['x-route-id'], key).toBe(id);
      expect(operation?.['x-public'], key).toBe(true);
      expect(operation?.['x-rate-limit'], key).toBe(rate);
      expect('x-permission' in (operation ?? {}), key).toBe(false);
    }
  });

  it('describes the responses of /api/v1/me and /api/v1/csrf with the shared schemas', async () => {
    const app = await createFixtureApp({ system: {} });
    const text = JSON.stringify(app.http.document);
    expect(text).toContain('#/components/schemas/MeResponse');
    expect(text).toContain('#/components/schemas/CsrfResponse');
    expect(text).toContain('#/components/schemas/HealthzResponse');
    expect(text).toContain('#/components/schemas/ReadyzResponse');
  });

  it('keeps the document and the router in step with the system routes registered', async () => {
    const app = await createFixtureApp({ system: {} });
    expect(
      checkOpenApiParity({
        document: app.http.document,
        table: app.http.table,
        registered: registeredRoutesOf(app.http.app),
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase B (T-B-392, XB36): the 32 routes P01 to P32 of the contract, on the real application
// ---------------------------------------------------------------------------------------------

const CONTRACT = fileURLToPath(
  new URL('../../../specs/002-phase-b/contracts/phase-b-api.md', import.meta.url),
);

interface ContractRoute {
  readonly number: string;
  readonly id: string;
  readonly key: string;
  readonly access: string;
  readonly rateClass: string;
}

/** The route index of the contract (section 2), read independently of the code. */
function contractRoutes(): ContractRoute[] {
  const rows = [
    ...readFileSync(CONTRACT, 'utf8').matchAll(
      /^\| (P\d\d) \| `([^`]+)` \| `(GET|POST|PUT|PATCH|DELETE) ([^`?]+)\??[^`]*` \| ([^|]+) \| (auth|setup|read|write) \|/gm,
    ),
  ];
  return rows.map((row) => ({
    number: row[1] ?? '',
    id: row[2] ?? '',
    key: `${row[3] ?? ''} ${row[4] ?? ''}`.replaceAll(/\{([^}]+)\}/g, '{$1}'),
    access: (row[5] ?? '').trim(),
    rateClass: row[6] ?? '',
  }));
}

/** Every disagreement between the contract and the document, as readable lines. */
function contractProblems(document: OpenApiDocument, routes: readonly ContractRoute[]): string[] {
  const problems: string[] = [];
  const documented = operationsOf(document);
  for (const route of routes) {
    const operation = documented.get(route.key);
    if (operation === undefined) {
      problems.push(`${route.number} ${route.id}: ${route.key} is not documented`);
      continue;
    }
    if (operation['x-route-id'] !== route.id) {
      problems.push(
        `${route.number}: x-route-id is ${String(operation['x-route-id'])}, the contract says ${route.id}`,
      );
    }
    if (operation['x-rate-limit'] !== route.rateClass) {
      problems.push(
        `${route.number} ${route.id}: x-rate-limit is ${String(operation['x-rate-limit'])}, the contract says ${route.rateClass}`,
      );
    }
    const marked = ['x-permission', 'x-public'].filter((name) => operation[name] !== undefined);
    if (route.access.startsWith('public') && operation['x-public'] === undefined) {
      problems.push(
        `${route.number} ${route.id}: the contract says public, the document has no x-public`,
      );
    }
    if (
      !route.access.startsWith('public') &&
      marked.length === 0 &&
      operation['x-access'] === undefined
    ) {
      problems.push(
        `${route.number} ${route.id}: the document names neither a permission nor an access`,
      );
    }
  }
  return problems;
}

/** Secrets must not be in the document: tokens, cookie values, setup tokens, key material. */
function documentLeaks(text: string, canaries: readonly string[]): string[] {
  const found: string[] = [];
  for (const canary of canaries)
    if (canary !== '' && text.includes(canary)) found.push('a canary value');
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text)) found.push('a JWT-shaped token');
  if (text.includes('-----BEGIN ')) found.push('a PEM block');
  if (/\bm365portal_(?:session|setup|tx)=[A-Za-z0-9_-]{20,}/.test(text))
    found.push('a cookie value');
  return found;
}

describe('the contract routes P01 to P32 on the real application (T-B-392)', () => {
  it('documents all 32 routes with their ids, methods, paths and rate classes, and validates against OpenAPI 3.1', async () => {
    const server = await startWizardServer({
      env: {
        BREAK_GLASS_USERNAME: 'operator',
        BREAK_GLASS_PASSWORD_HASH: `scrypt:16384:8:1:${Buffer.alloc(16, 3).toString('base64url')}:${Buffer.alloc(32, 5).toString('base64url')}`,
      },
    });
    const response = await server.client().get('/api/v1/openapi.json');
    const text = await response.text();
    const document = JSON.parse(text) as OpenApiDocument;
    const routes = contractRoutes();
    expect(routes.map((route) => route.number)).toEqual(
      Array.from({ length: 32 }, (_unused, index) => `P${String(index + 1).padStart(2, '0')}`),
    );
    expect(contractProblems(document, routes)).toEqual([]);

    const verdict = await new Validator().validate(document as never);
    expect(verdict.valid, JSON.stringify(verdict.errors ?? [])).toBe(true);

    // The documented set equals the registered set: the server asserts it at start, and here the
    // document is the one the running application serves.
    const ids = new Set(
      [...operationsOf(document).values()].map((operation) => operation['x-route-id']),
    );
    for (const route of routes) expect(ids.has(route.id), route.id).toBe(true);

    // The document names the extensions on every operation, and leaks nothing.
    for (const [key, operation] of operationsOf(document)) {
      expect(operation['x-route-id'], key).toEqual(expect.any(String));
      expect(operation['x-rate-limit'], key).toEqual(expect.any(String));
    }
    expect(documentLeaks(text, [server.token() ?? ''])).toEqual([]);
  });

  describe('negative fixtures: the checks fail on purpose', () => {
    const route: ContractRoute = {
      number: 'P99',
      id: 'x.route',
      key: 'GET /api/v1/x',
      access: 'public',
      rateClass: 'read',
    };
    const documentWith = (extra: Record<string, unknown>): OpenApiDocument =>
      ({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {
          '/api/v1/x': {
            get: { 'x-route-id': 'x.route', 'x-rate-limit': 'read', 'x-public': true, ...extra },
          },
        },
      });

    it('a contract route that is not documented', () => {
      expectGuardFails(
        (input: { document: OpenApiDocument; routes: ContractRoute[] }) => {
          const problems = contractProblems(input.document, input.routes);
          if (problems.length > 0) throw new Error(problems.join('; '));
        },
        { document: documentWith({}), routes: [{ ...route, key: 'GET /api/v1/missing' }] },
        { reason: 'is not documented' },
      );
    });

    it('a wrong route id or rate class', () => {
      for (const [extra, reason] of [
        [{ 'x-route-id': 'other.route' }, 'x-route-id'],
        [{ 'x-rate-limit': 'write' }, 'x-rate-limit'],
      ] as const) {
        expectGuardFails(
          (input: { document: OpenApiDocument; routes: ContractRoute[] }) => {
            const problems = contractProblems(input.document, input.routes);
            if (problems.length > 0) throw new Error(problems.join('; '));
          },
          { document: documentWith(extra), routes: [route] },
          { reason },
        );
      }
    });

    it('a document that holds a token, a cookie value, a PEM block or the setup token', () => {
      for (const leak of [
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturesignature',
        'm365portal_setup=' + 'a'.repeat(40),
        '-----BEGIN ' + 'CERTIFICATE-----',
        'SETUP-CANARY-0123456789',
      ]) {
        expectGuardFails(
          (text: string) => {
            const found = documentLeaks(text, ['SETUP-CANARY-0123456789']);
            if (found.length > 0) throw new Error(found.join(', '));
          },
          `{"description":"${leak}"}`,
          { reason: /canary|JWT|cookie|PEM/ },
        );
      }
    });
  });
});
