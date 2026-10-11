// The router of the fake tenant (T-B-063): host first, then method and path. First match wins, in
// registration order. Paths are matched case-sensitively and without the query string: a typo in the
// path of one of our clients is a 404 here, which is the point of a strict fake.
import {
  FAKE_TENANT_HOSTS,
  type FakeHost,
  type HttpMethod,
  type RouteDefinition,
} from './types.js';

export interface Matched {
  readonly route: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

export type Resolution =
  | { readonly kind: 'matched'; readonly matched: Matched }
  | { readonly kind: 'method_not_allowed'; readonly allow: readonly HttpMethod[] }
  | { readonly kind: 'not_found' };

interface Compiled {
  readonly route: RouteDefinition;
  readonly pattern: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `/v1.0/users/:id/x` and `/adminapi/v2.0/:tid/*` to a regular expression with named groups. */
function compile(path: string): RegExp {
  if (!path.startsWith('/')) throw new Error(`a route path starts with "/": ${path}`);
  const segments = path.split('/').slice(1);
  const source = segments
    .map((segment, index) => {
      if (segment === '*') {
        if (index !== segments.length - 1) throw new Error(`"*" is only allowed last: ${path}`);
        return '(?<wildcard>.*)';
      }
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`bad parameter name: ${segment}`);
        return `(?<${name}>[^/]+)`;
      }
      return escapeRegExp(segment);
    })
    .join('/');
  return new RegExp(`^/${source}$`);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function paramsOf(groups: Record<string, string> | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(groups ?? {})) {
    params[name === 'wildcard' ? '*' : name] = decode(value);
  }
  return params;
}

export interface RouterImpl {
  add(route: RouteDefinition): () => void;
  resolve(host: string, method: string, pathname: string): Resolution;
}

export function createRouter(): RouterImpl {
  const routes: Compiled[] = [];

  return {
    add(route) {
      if (!(FAKE_TENANT_HOSTS as readonly string[]).includes(route.host)) {
        throw new Error(`the fake tenant does not serve ${route.host}`);
      }
      const entry: Compiled = {
        route,
        pattern: typeof route.path === 'string' ? compile(route.path) : route.path,
      };
      routes.push(entry);
      return () => {
        const index = routes.indexOf(entry);
        if (index >= 0) routes.splice(index, 1);
      };
    },

    resolve(host, method, pathname) {
      const onThisPath: Compiled[] = [];
      for (const entry of routes) {
        if (entry.route.host !== (host as FakeHost)) continue;
        const match = entry.pattern.exec(pathname);
        if (match === null) continue;
        if (entry.route.method === method) {
          return {
            kind: 'matched',
            matched: { route: entry.route, params: paramsOf(match.groups) },
          };
        }
        onThisPath.push(entry);
      }
      if (onThisPath.length === 0) return { kind: 'not_found' };
      const allow = [...new Set(onThisPath.map((entry) => entry.route.method))].sort();
      return { kind: 'method_not_allowed', allow };
    },
  };
}
