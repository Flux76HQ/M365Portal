// local/no-direct-route-registration (FR-A-031, plan PD-22)
//
// A route is registered through `defineRoute` (apps/server/src/http/route.ts, which this rule's
// scope leaves out) and nowhere else. defineRoute is what forces the declaration of exactly one of
// `permission` or `public: true`, puts the guards in their fixed order (rate limit, body limit,
// content type, Origin, CSRF, authorisation, validation, handler) and feeds the route table that is
// checked at boot. A route added directly on a Hono instance skips all of that, silently.
//
// Refused in apps/server/src:
//   - get, post, put, patch, delete, options, all, on, route or mount on a Hono instance, called,
//     taken off (`const register = app.get.bind(app)`), destructured (`const { get } = app`) or
//     named by a variable (`app[method](...)`); `openapi` is refused too: it registers a route on
//     an OpenAPIHono just the same
//   - `new Hono()` / `new OpenAPIHono()`, or a class derived from one, however it is imported or
//     held (`import { Hono as H }`, `const Server = Hono`), except in app.ts, which builds the
//     application
//   - app.use(...) with a handler that never calls next: it answers the request, which makes it a
//     route nobody declared
// Allowed: app.use(...) for middleware, app.onError, app.notFound, app.request, app.fetch.
//
// A Hono instance is recognised
//   - by type, when type information is available: a receiver whose type is Hono or OpenAPIHono,
//     or extends one, or is a union, intersection or generic constraint that contains one
//   - by name, always: the identifier `app`, a member named `app` (`this.app`, `c.app`), a
//     `new Hono()` expression, and a call chain on any of those (`app.use(mw).get(...)`)
//
// A receiver of type `any` is not recognised (nothing can be said about it); typescript-eslint's
// no-unsafe-call and no-unsafe-member-access, on in the typed configuration, report it.
import { posix, sep } from 'node:path';
import { findVariable, resolvedName, staticName, unwrap } from '../lib/ast.js';
import { SERVER_SOURCES } from '../lib/scope.js';

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
    useAnswers:
      'app.use() with a handler that never calls next() answers the request itself, which makes it a route nobody declared: declare it with defineRoute in apps/server/src/http/route.ts (FR-A-031).',
  },
  schema: [],
};

export const scope = {
  files: [SERVER_SOURCES],
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
/** Modules the Hono classes come from: `hono`, `hono/tiny`, `@hono/zod-openapi`. */
const HONO_PACKAGE = /^(?:hono(?:\/.*)?|@hono\/.+)$/;
const APPLICATION_FILE = 'apps/server/src/app.ts';

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

export function create(context) {
  const { sourceCode } = context;
  const services = sourceCode.parserServices;
  const checker = services?.program?.getTypeChecker();
  // Matched by suffix, not against the working directory: `pnpm --filter @m365portal/server lint`
  // runs ESLint from apps/server, where a path relative to the cwd would read `src/app.ts`.
  const filename = context.filename.split(sep).join(posix.sep);
  const inApplicationFile =
    filename === APPLICATION_FILE || filename.endsWith(`/${APPLICATION_FILE}`);

  function typeOf(expression) {
    if (checker === undefined || services?.esTreeNodeToTSNodeMap === undefined) return undefined;
    const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
    return tsNode === undefined ? undefined : checker.getTypeAtLocation(tsNode);
  }

  function hasHonoType(expression) {
    return isHonoType(typeOf(expression));
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
        return constructedHono(node) !== undefined;
      case 'CallExpression': {
        const callee = unwrap(node.callee);
        return callee.type === 'MemberExpression' && looksLikeApplication(callee.object);
      }
      default:
        return false;
    }
  }

  function isApplication(expression) {
    return looksLikeApplication(expression) || hasHonoType(expression);
  }

  /**
   * The Hono class a `new` expression constructs, or undefined: by what the identifier was imported
   * as (`import { Hono as H } from 'hono'`), by the name it is written with, by the member it is
   * read from (`hono.Hono`), and by the type of the new instance (`const Server = Hono`, a subclass).
   */
  function constructedHono(node) {
    const callee = unwrap(node.callee);
    if (callee.type === 'Identifier') {
      const definition = findVariable(sourceCode.getScope(callee), callee.name)?.defs[0];
      if (definition?.type === 'ImportBinding' && definition.node.type === 'ImportSpecifier') {
        const imported = definition.node.imported.name ?? definition.node.imported.value;
        // From the Hono packages the imported name decides: `import { Context as Hono }` is no Hono.
        if (HONO_PACKAGE.test(definition.parent.source.value)) {
          return HONO_CLASSES.has(imported) ? imported : undefined;
        }
      }
      if (HONO_CLASSES.has(callee.name)) return callee.name;
    } else if (callee.type === 'MemberExpression') {
      const name = staticName(callee);
      if (name !== undefined && HONO_CLASSES.has(name)) return name;
    }
    const type = typeOf(node);
    if (!isHonoType(type)) return undefined;
    return type?.getSymbol()?.getName() ?? 'Hono';
  }

  /** The call a member expression is the callee of, or undefined (it is only referenced). */
  function callOf(member) {
    const outer = member.parent.type === 'ChainExpression' ? member.parent : member;
    const { parent } = outer;
    return parent.type === 'CallExpression' && unwrap(parent.callee) === member
      ? parent
      : undefined;
  }

  /** Can this handler hand over to the next one? A handler that cannot answers the request itself. */
  function neverCallsNext(handler) {
    const next = handler.params[1];
    if (next === undefined) return true;
    // A pattern or a rest parameter hides the name: assume it is used.
    if (next.type !== 'Identifier') return false;
    const variable = sourceCode
      .getDeclaredVariables(handler)
      .find((candidate) => candidate.identifiers.includes(next));
    return variable !== undefined && variable.references.length === 0;
  }

  return {
    MemberExpression(node) {
      if (!isApplication(node.object)) return;
      const method = staticName(node);
      const call = callOf(node);
      if (method === undefined) {
        // `app[method](...)`: a name that is only known at run time. Referencing it is not enough
        // to say anything; calling it is a registration of something.
        if (call === undefined || node.computed !== true) return;
        const label = `[${sourceCode.getText(node.property)}]`;
        context.report({ node: node.property, messageId: 'directRoute', data: { method: label } });
        return;
      }
      if (!ROUTE_METHODS.has(method)) return;
      context.report({ node: node.property, messageId: 'directRoute', data: { method } });
    },

    // const { get, post } = app;  ({ get } = app);
    Property(node) {
      if (node.parent.type !== 'ObjectPattern') return;
      const method = resolvedName(sourceCode, node);
      if (method === undefined || !ROUTE_METHODS.has(method)) return;
      const { parent } = node.parent;
      const source =
        parent.type === 'VariableDeclarator'
          ? parent.init
          : parent.type === 'AssignmentExpression'
            ? parent.right
            : undefined;
      if (source !== null && source !== undefined && isApplication(source)) {
        context.report({ node, messageId: 'directRoute', data: { method } });
      }
    },

    // app.use('/open', (c) => c.text('ok')): middleware that answers is a route.
    CallExpression(node) {
      const callee = unwrap(node.callee);
      if (callee.type !== 'MemberExpression' || staticName(callee) !== 'use') return;
      if (!isApplication(callee.object)) return;
      for (const argument of node.arguments) {
        const handler = unwrap(argument);
        if (
          (handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression') &&
          neverCallsNext(handler)
        ) {
          context.report({ node: handler, messageId: 'useAnswers' });
        }
      }
    },

    NewExpression(node) {
      const name = constructedHono(node);
      if (name === undefined || inApplicationFile) return;
      context.report({ node, messageId: 'newHono', data: { name } });
    },
  };
}
