// The OpenAPI 3.1 document (FR-A-021, PD-22, V-12, contract R3 and section 8.4).
//
// It is generated from the definitions that enforce the rules: `defineRoute` hands the route to
// `@hono/zod-openapi` with the extensions `x-route-id`, `x-permission` or `x-public`, `x-rate-limit`
// and (when the route declares one) `x-audit`, and the generator turns the Zod schemas into JSON
// Schema. Nothing in the document is written by hand, so it cannot claim a permission the code does
// not check.
//
// Two checks keep the document and the router together, in both directions:
//   - every route the router holds is documented (a fallback excepted: it is `openapi: false`);
//   - every operation of the document is held by the router, with the access, rate class and audit
//     action of the route it names.
// The boot runs them (`createHttpApp`); `openapi.test.ts` runs them with a route that is missing from
// one side and expects them to fail.
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './request-context.js';
import {
  RouteTable,
  RouteTableError,
  routerPath,
  type RegisteredRoute,
  type RouteTableEntry,
} from './route-table.js';

/** The document, as the generator returns it. */
export type OpenApiDocument = ReturnType<OpenAPIHono<AppEnv>['getOpenAPI31Document']>;

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/** Generate the document from everything registered on `app` through `defineRoute`. */
export function buildOpenApiDocument(app: OpenAPIHono<AppEnv>, info: OpenApiInfo): OpenApiDocument {
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    servers: [{ url: '/' }],
  });
}

/**
 * The document, made once at start and read by `GET /api/v1/openapi.json` (R3). The route is defined
 * before the application that documents it exists, so the route holds this and the boot fills it.
 */
export interface DocumentSource {
  get(): OpenApiDocument;
  set(document: OpenApiDocument): void;
}

export function createDocumentSource(): DocumentSource {
  let current: OpenApiDocument | undefined;
  return {
    get() {
      if (current === undefined) throw new Error('the OpenAPI document has not been generated yet');
      return current;
    },
    set(document) {
      current = document;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------------------------

export interface ParityInput {
  readonly document: OpenApiDocument;
  readonly table: RouteTable;
  readonly registered: readonly RegisteredRoute[];
}

interface DocumentedOperation {
  readonly key: string;
  readonly operation: Readonly<Record<string, unknown>>;
}

const DOCUMENT_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

function documentedOperations(document: OpenApiDocument): DocumentedOperation[] {
  const found: DocumentedOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of DOCUMENT_METHODS) {
      const operation = (item as Record<string, unknown>)[method];
      if (typeof operation === 'object' && operation !== null) {
        found.push({
          key: `${method.toUpperCase()} ${path}`,
          operation: operation as Record<string, unknown>,
        });
      }
    }
  }
  return found;
}

/** The registrations in the document's spelling (`{id}`), to compare with its paths. */
function documentSpelling(path: string): string {
  return path.replaceAll(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
}

function routeKey(entry: RouteTableEntry): string {
  return `${entry.methods[0] ?? ''} ${entry.paths[0] ?? ''}`;
}

function accessProblem(
  entry: RouteTableEntry,
  operation: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  if ('permission' in entry.access && entry.access.permission !== undefined) {
    if (operation['x-permission'] !== entry.access.permission) {
      problems.push(
        `${entry.id}: x-permission is not the permission the route declares (${entry.access.permission})`,
      );
    }
    if ('x-public' in operation)
      problems.push(`${entry.id}: x-public on a route that needs a permission`);
  } else {
    if (operation['x-public'] !== true)
      problems.push(`${entry.id}: x-public is missing on a public route`);
    if ('x-permission' in operation) {
      problems.push(`${entry.id}: x-permission on a public route`);
    }
  }
  return problems;
}

/** Every disagreement between the document, the table and the router, as readable lines. */
export function checkOpenApiParity(input: ParityInput): string[] {
  const { document, table, registered } = input;
  const problems: string[] = [];

  const operations = documentedOperations(document);
  const documentedKeys = new Set(operations.map(({ key }) => key));
  const routes = new Map(table.routes.map((entry) => [routeKey(entry), entry]));
  const heldKeys = new Set(
    registered.map(({ method, path }) => `${method} ${documentSpelling(path)}`),
  );
  const fallbackKeys = new Set(
    table.fallbacks.flatMap((entry) =>
      entry.methods.flatMap((method) =>
        entry.paths.map((path) => `${method} ${documentSpelling(routerPath(path))}`),
      ),
    ),
  );

  for (const { key, operation } of operations) {
    if (!heldKeys.has(key)) problems.push(`${key}: documented but not registered`);
    const entry = routes.get(key);
    if (entry === undefined) {
      problems.push(`${key}: documented but not in the route table`);
      continue;
    }
    if (operation['x-route-id'] !== entry.id) {
      problems.push(
        `${key}: x-route-id "${String(operation['x-route-id'])}" is not the id of this route (${entry.id})`,
      );
    }
    problems.push(...accessProblem(entry, operation));
    if (operation['x-rate-limit'] !== entry.rateLimit) {
      problems.push(
        `${entry.id}: x-rate-limit is not the class the route declares (${entry.rateLimit})`,
      );
    }
    if (operation['x-audit'] !== entry.audit) {
      problems.push(`${entry.id}: x-audit is not the audit action the route declares`);
    }
  }

  for (const key of [...heldKeys].sort()) {
    if (!documentedKeys.has(key) && !fallbackKeys.has(key)) {
      problems.push(`${key}: registered but not documented`);
    }
  }
  for (const [key, entry] of routes) {
    if (!documentedKeys.has(key)) problems.push(`${entry.id}: not documented (${key})`);
  }
  return problems;
}

/** Throws a `RouteTableError` unless the document, the table and the router agree. */
export function assertOpenApiParity(input: ParityInput): void {
  const problems = checkOpenApiParity(input);
  if (problems.length > 0) throw new RouteTableError(problems);
}
