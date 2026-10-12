// Outbound URL discipline (FR-B-317, PB-01): the only place that knows the three origins the product
// talks to and the only place that turns a value into a path segment or an OData literal.
//
// Three things live here, and clients use nothing else to build a URL:
//
//   1. the origins. `MICROSOFT_ORIGINS` is the one list; a source scan (url-discipline.test.ts)
//      finds no origin literal outside this file. A client is built for one origin and one path
//      prefix and `resolveUnder` refuses any URL that leaves either: another host, another scheme,
//      a port, user information, a fragment, a dot segment, an encoded slash, a control character.
//   2. path segments. `guidSegment` accepts a GUID and nothing else; `pathSegment` escapes anything
//      else with `encodeURIComponent` and refuses the two values that escaping leaves alone and
//      that mean something to a URL parser (`.` and `..`).
//   3. OData string literals. `odataString` doubles single quotes; the whole literal is then
//      percent-encoded by the query builder, so no value can change the structure of the query.
//
// A refusal is a `UrlRefusedError`; the clients turn it into their own typed error. The message is a
// fixed word: the offending value is never echoed.

/** The three origins (FR-B-317). No other origin literal may appear in `apps/server/src`. */
export const MICROSOFT_ORIGINS = Object.freeze({
  login: 'https://login.microsoftonline.com',
  graph: 'https://graph.microsoft.com',
  exchange: 'https://outlook.office365.com',
} as const);

export type MicrosoftOrigin = (typeof MICROSOFT_ORIGINS)[keyof typeof MICROSOFT_ORIGINS];

/** Why a value or a URL was refused: a word, never the value. */
export type UrlRefusal =
  | 'not_a_guid'
  | 'bad_segment'
  | 'bad_literal'
  | 'bad_query_name'
  | 'bad_url'
  | 'bad_origin'
  | 'bad_prefix'
  | 'bad_tenant_hint';

export class UrlRefusedError extends Error {
  readonly refusal: UrlRefusal;

  constructor(refusal: UrlRefusal) {
    super(`url_refused:${refusal}`);
    this.name = 'UrlRefusedError';
    this.refusal = refusal;
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Printable ASCII only: no control character, no space, no non-ASCII before the parser sees it. */
const URL_TEXT = /^[\x21-\x7e]+$/;
/** A value that goes into a path or a literal: at most this many characters (UTF-16 units). */
const MAX_VALUE_LENGTH = 256;
const MAX_URL_LENGTH = 4_096;
const QUERY_NAME = /^\$?[A-Za-z][A-Za-z0-9]{0,31}$/;

/** True for a lower-case GUID, which is what the Phase B code keeps and sends. */
export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID.test(value);
}

/**
 * A GUID as a path segment. Upper-case input is lower-cased (a directory id is case-insensitive and
 * the code keeps them lower case); anything that is not a GUID is refused.
 */
export function guidSegment(value: string): string {
  const lower = typeof value === 'string' ? value.toLowerCase() : '';
  if (!GUID.test(lower)) throw new UrlRefusedError('not_a_guid');
  return lower;
}

/**
 * Any other id (a user principal name, an application name used as a key) as a path segment. It is
 * escaped with `encodeURIComponent`; the empty string, a value over 256 characters, `.` and `..`
 * (which `encodeURIComponent` leaves alone and a URL parser treats as navigation) and a value that
 * escapes to an encoded slash or backslash are refused.
 */
export function pathSegment(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
    throw new UrlRefusedError('bad_segment');
  }
  if (value === '.' || value === '..') throw new UrlRefusedError('bad_segment');
  if (value.includes('/') || value.includes('\\')) throw new UrlRefusedError('bad_segment');
  if (hasLoneSurrogate(value)) throw new UrlRefusedError('bad_segment');
  const escaped = encodeURIComponent(value);
  // `encodeURIComponent` leaves ! ' ( ) * ~ alone. None is a separator, but `'` and `(` are used
  // by OData key syntax, so they are escaped too: an id never changes how a path is read.
  return escaped.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The key form of a path segment, `users('$x@y.com')`: for a user principal name that begins with
 * `$`, which `/users/$x@y.com` cannot carry (Learn, user-get, tip 1:
 * https://learn.microsoft.com/graph/api/user-get). The value is an OData literal (quotes doubled)
 * that is then percent-encoded, so it cannot end the literal or the segment early.
 */
export function keySegment(entity: string, value: string): string {
  if (!/^[A-Za-z]{1,32}$/.test(entity)) throw new UrlRefusedError('bad_segment');
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new UrlRefusedError('bad_segment');
  }
  return `${entity}(${encodeURIComponent(odataString(value))})`;
}

/**
 * An OData string literal: single quotes doubled, wrapped in single quotes. The caller puts the whole
 * literal into a query parameter, which is percent-encoded, so the literal cannot end early.
 */
export function odataString(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
    throw new UrlRefusedError('bad_literal');
  }
  if (hasLoneSurrogate(value) || hasControlCharacter(value)) {
    throw new UrlRefusedError('bad_literal');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Builds a query string from names and values. A name is `$top`, `$select` and the like; a value is
 * percent-encoded with `encodeURIComponent` (a space is `%20`, never `+`, which OData servers read
 * as a plus sign in some places and a space in others). Names are sorted, so the same query always
 * gives the same string: the cache key and the call record rely on it.
 */
export function buildQuery(query: Readonly<Record<string, string>> | undefined): string {
  if (query === undefined) return '';
  const names = Object.keys(query).sort();
  if (names.length === 0) return '';
  const parts = names.map((name) => {
    if (!QUERY_NAME.test(name)) throw new UrlRefusedError('bad_query_name');
    const value = query[name];
    if (typeof value !== 'string' || value.length > 2_048) throw new UrlRefusedError('bad_literal');
    return `${name}=${encodeURIComponent(value)}`;
  });
  return `?${parts.join('&')}`;
}

/** The lower-case ASCII host check shared by `assertBase` and the tenant hint. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The tenant hint of the bootstrap authority (FR-B-214, FR-B-317): a lower-case GUID, or a DNS name
 * of at least two labels of letters, digits and hyphens (1 to 63 characters each, 253 in all, no
 * label that starts or ends with a hyphen). `common`, `consumers` and `organizations` are never accepted.
 * Returns the hint in lower case.
 */
export function tenantHint(value: string): string {
  if (typeof value !== 'string') throw new UrlRefusedError('bad_tenant_hint');
  const lower = value.toLowerCase();
  if (lower === 'common' || lower === 'consumers' || lower === 'organizations') {
    throw new UrlRefusedError('bad_tenant_hint');
  }
  if (GUID.test(lower)) return lower;
  if (lower.length === 0 || lower.length > 253) throw new UrlRefusedError('bad_tenant_hint');
  const labels = lower.split('.');
  // A tenant domain has a dot (`contoso.onmicrosoft.com`); a single label is not one, and a GUID with
  // a typo in it would otherwise pass as a label.
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) {
    throw new UrlRefusedError('bad_tenant_hint');
  }
  return lower;
}

/** A client is configured with a `https` origin without a path and a prefix with a slash at both ends. */
export function assertBase(origin: string, pathPrefix: string): void {
  if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(origin)) {
    throw new UrlRefusedError('bad_origin');
  }
  if (
    typeof pathPrefix !== 'string' ||
    !pathPrefix.startsWith('/') ||
    !pathPrefix.endsWith('/') ||
    pathPrefix.includes('//') ||
    pathPrefix.includes('\\') ||
    !URL_TEXT.test(pathPrefix)
  ) {
    throw new UrlRefusedError('bad_prefix');
  }
}

function hasNavigationSegment(rawPath: string): boolean {
  return rawPath.split('/').some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
}

/**
 * Parses `rawUrl` and returns it only when it is an `https` URL on exactly `origin` (no port, no user
 * information, no fragment) whose path is under `pathPrefix`, written without dot segments and
 * without an encoded slash or backslash. Everything else is a `UrlRefusedError('bad_url')`.
 * Used for every request and for every `@odata.nextLink` before a request exists.
 */
export function resolveUnder(origin: string, pathPrefix: string, rawUrl: string): URL {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_URL_LENGTH ||
    !URL_TEXT.test(rawUrl) ||
    rawUrl.includes('\\') ||
    rawUrl.includes('#')
  ) {
    throw new UrlRefusedError('bad_url');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlRefusedError('bad_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  ) {
    throw new UrlRefusedError('bad_url');
  }
  // The path exactly as written: the parser has already resolved dot segments in `url.pathname`.
  const afterOrigin = rawUrl.slice(origin.length);
  const rawPath = afterOrigin.split('?')[0] ?? '';
  if (!rawPath.startsWith(pathPrefix) || !url.pathname.startsWith(pathPrefix)) {
    throw new UrlRefusedError('bad_url');
  }
  if (hasNavigationSegment(rawPath) || /%2f|%5c/i.test(rawPath)) {
    throw new UrlRefusedError('bad_url');
  }
  return url;
}
