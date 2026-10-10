// local/no-direct-route-registration (FR-A-031, plan PD-22)
//
// A route is registered through `defineRoute` (apps/server/src/http/route.ts, which this rule's
// scope leaves out) and nowhere else. defineRoute is what forces the declaration of exactly one of
// `permission` or `public: true`, puts the guards in their fixed order (rate limit, body limit,
// content type, Origin, CSRF, authorisation, validation, handler) and feeds the route table that is
// checked at boot. A route added directly on a Hono instance skips all of that, silently.
//
// Refused in apps/server/src:
//   - a call of get, post, put, patch, delete, options, all, on, route or mount on a Hono instance;
//     `openapi` is refused too: it registers a route on an OpenAPIHono just the same
//   - `new Hono()` / `new OpenAPIHono()`, except in app.ts, which builds the application
// Allowed: app.use(...) for middleware, app.onError, app.notFound, app.request, app.fetch.
//
// A Hono instance is recognised
//   - by type, when type information is available: a receiver whose type is Hono or OpenAPIHono,
//     or extends one, or is a union, intersection or generic constraint that contains one
//   - by name, always: the identifier `app`, a member named `app` (`this.app`, `c.app`), a
//     `new Hono()` expression, and a call chain on any of those (`app.use(mw).get(...)`)
//
// TEMPORARY EXEMPTION. The scaffold's apps/server/src/app.ts registers `GET /healthz` directly.
// That one call, in that one file, is excused so that the repository stays green until the stream
// that owns the file replaces it (T-A-042 declares the health routes with defineRoute, T-A-045
// builds the application in the composition root). Any other route in app.ts, and /healthz
// anywhere else, is refused. Once app.ts no longer contains the call, delete LEGACY_HEALTH_ROUTE,
// `isLegacyHealthRoute` and the matching cases of the test; nothing else changes.
import { posix, sep } from 'node:path';
import { staticName, unwrap } from '../lib/ast.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow registering routes or creating Hono applications outside defineRoute (FR-A-031)',
  },
  messages: {
    directRoute:
      'Route registered directly with "{{method}}": declare it with defineRoute in apps/server/src/http/route.ts so it must state `permission` or `public: true` (FR-A-031).',
    newHono:
      '"new {{name}}()" outside apps/server/src/app.ts: the application is built once; add routes through defineRoute (FR-A-031).',
  },
  schema: [],
};

export const scope = {
  files: ['apps/server/src/**/*.ts'],
  ignores: ['apps/server/src/http/route.ts'],
};

const ROUTE_METHODS = new Set([
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
]);
const HONO_CLASSES = new Set(['Hono', 'OpenAPIHono']);
const APPLICATION_FILE = 'apps/server/src/app.ts';
const LEGACY_HEALTH_ROUTE = { method: 'get', path: '/healthz' };

/** True when the type is Hono or OpenAPIHono, or derives from, contains or is constrained by one. */
function isHonoType(type, seen = new Set(), depth = 0) {
  if (type === undefined || seen.has(type) || depth > 6) return false;
  seen.add(type);
  const name = type.getSymbol()?.getName();
  if (name !== undefined && HONO_CLASSES.has(name)) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => isHonoType(member, seen, depth + 1));
  }
  if (isHonoType(type.getConstraint(), seen, depth + 1)) return true;
  // A generic instantiation (Hono<Env>) shares its base types with the declared class.
  const declared = type.target ?? type;
  return (declared.getBaseTypes?.() ?? []).some((base) => isHonoType(base, seen, depth + 1));
}

/** The Hono class a `new` expression constructs, or undefined. */
function constructedHono(callee) {
  const node = unwrap(callee);
  const name =
    node.type === 'Identifier'
      ? node.name
      : node.type === 'MemberExpression'
        ? staticName(node)
        : '';
  return name !== undefined && HONO_CLASSES.has(name) ? name : undefined;
}

/** By name and by shape: `app`, `this.app`, `new Hono()` and calls chained on those. */
function looksLikeApplication(expression) {
  const node = unwrap(expression);
  switch (node.type) {
    case 'Identifier':
      return node.name === 'app';
    case 'MemberExpression':
      return staticName(node) === 'app';
    case 'NewExpression':
      return constructedHono(node.callee) !== undefined;
    case 'CallExpression': {
      const callee = unwrap(node.callee);
      return callee.type === 'MemberExpression' && looksLikeApplication(callee.object);
    }
    default:
      return false;
  }
}

export function create(context) {
  const services = context.sourceCode.parserServices;
  const checker = services?.program?.getTypeChecker();
  // Matched by suffix, not against the working directory: `pnpm --filter @m365portal/server lint`
  // runs ESLint from apps/server, where a path relative to the cwd would read `src/app.ts`.
  const filename = context.filename.split(sep).join(posix.sep);
  const inApplicationFile =
    filename === APPLICATION_FILE || filename.endsWith(`/${APPLICATION_FILE}`);

  function hasHonoType(expression) {
    if (checker === undefined || services?.esTreeNodeToTSNodeMap === undefined) return false;
    const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
    return tsNode !== undefined && isHonoType(checker.getTypeAtLocation(tsNode));
  }

  function isLegacyHealthRoute(method, call) {
    const [first] = call.arguments;
    return (
      inApplicationFile &&
      method === LEGACY_HEALTH_ROUTE.method &&
      first?.type === 'Literal' &&
      first.value === LEGACY_HEALTH_ROUTE.path
    );
  }

  return {
    CallExpression(node) {
      const callee = unwrap(node.callee);
      if (callee.type !== 'MemberExpression') return;
      const method = staticName(callee);
      if (method === undefined || !ROUTE_METHODS.has(method)) return;
      if (!looksLikeApplication(callee.object) && !hasHonoType(callee.object)) return;
      if (isLegacyHealthRoute(method, node)) return;
      context.report({ node: callee.property, messageId: 'directRoute', data: { method } });
    },

    NewExpression(node) {
      const name = constructedHono(node.callee);
      if (name === undefined || inApplicationFile) return;
      context.report({ node, messageId: 'newHono', data: { name } });
    },
  };
}
