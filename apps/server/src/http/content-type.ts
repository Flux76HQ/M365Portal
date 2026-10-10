// Stage 9 of the request pipeline (plan 7.2, FR-A-020): the media type of a request body. A JSON route
// takes `application/json` and nothing else; the upload takes `multipart/form-data` with a boundary.
// Anything else answers 415 `unsupported_media_type`.
//
// Why this is a security control as well as a convention: the types a cross-site HTML form or a
// no-CORS `fetch` can send without a preflight are `text/plain`, `application/x-www-form-urlencoded`
// and `multipart/form-data`. A JSON route that accepts one of them is a route a foreign page can
// call. (Origin and CSRF checks stand behind this one; this stage makes a mistake there cheaper.)
//
// The match is on the whole media type, not on a word in it: `application/vnd.api+json`,
// `application/jsonp` and `text/json` are not `application/json`. JSON is UTF-8 (RFC 8259), so the
// only parameter allowed is `charset=utf-8`.
//
// A request with no body and no content type is fine: `DELETE` and an action `POST` carry neither.
// "Has a body" means the headers say so; a client that sends bytes sends a length or chunks them.
import type { MiddlewareHandler } from 'hono';
import { problemResponse } from './problem.js';
import type { AppEnv } from './request-context.js';

export type ContentTypeKind = 'json' | 'multipart';

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;
const MAX_HEADER_LENGTH = 1_024;

interface MediaType {
  /** Lower case, `type/subtype`. */
  readonly essence: string;
  /** Parameter names in lower case; a value is kept as written, quotes removed. */
  readonly parameters: ReadonlyMap<string, string>;
}

/**
 * Parse `type/subtype; name=value; name="quoted value"`. Returns `undefined` for anything that does
 * not follow the grammar: a stray `;`, a name without a value, an unterminated quote, a repeated
 * parameter (which of the two values counts?), or control characters.
 */
function parseMediaType(header: string): MediaType | undefined {
  if (header.length > MAX_HEADER_LENGTH) return undefined;
  let position = 0;
  const skipSpaces = (): void => {
    while (header[position] === ' ' || header[position] === '\t') position += 1;
  };
  const readToken = (): string => {
    const start = position;
    while (position < header.length && TOKEN.test(header.charAt(position))) position += 1;
    return header.slice(start, position);
  };

  skipSpaces();
  const type = readToken();
  if (type === '' || header[position] !== '/') return undefined;
  position += 1;
  const subtype = readToken();
  if (subtype === '') return undefined;

  const parameters = new Map<string, string>();
  for (;;) {
    skipSpaces();
    if (position >= header.length) break;
    if (header[position] !== ';') return undefined;
    position += 1;
    skipSpaces();
    const name = readToken().toLowerCase();
    if (name === '' || header[position] !== '=' || parameters.has(name)) return undefined;
    position += 1;
    let value: string;
    if (header[position] === '"') {
      position += 1;
      value = '';
      for (;;) {
        const character = header[position];
        if (character === undefined) return undefined;
        position += 1;
        if (character === '"') break;
        if (character === '\\') {
          const escaped = header[position];
          if (escaped === undefined) return undefined;
          value += escaped;
          position += 1;
        } else {
          value += character;
        }
      }
    } else {
      value = readToken();
      if (value === '') return undefined;
    }
    parameters.set(name, value);
  }
  return { essence: `${type}/${subtype}`.toLowerCase(), parameters };
}

function isJson(media: MediaType): boolean {
  if (media.essence !== 'application/json') return false;
  for (const [name, value] of media.parameters) {
    if (name !== 'charset' || value.toLowerCase() !== 'utf-8') return false;
  }
  return true;
}

function isMultipart(media: MediaType): boolean {
  if (media.essence !== 'multipart/form-data') return false;
  const boundary = media.parameters.get('boundary');
  // RFC 2046: 1 to 70 characters, not ending in a space.
  return boundary !== undefined && BOUNDARY.test(boundary) && !boundary.endsWith(' ');
}

/**
 * Does the request say it has a body? A positive `Content-Length`, or any `Transfer-Encoding`
 * (which only exists to frame a body).
 */
export function requestHasBody(headers: Headers): boolean {
  if (headers.has('transfer-encoding')) return true;
  const length = headers.get('content-length');
  return length !== null && /^\d+$/.test(length) && Number(length) > 0;
}

/**
 * May a request with this `Content-Type` header (or none, `null`) go to a route of this kind?
 * A declared type has to be the right one whether or not there is a body; a missing one is only
 * acceptable when there is no body.
 */
export function contentTypeAllowed(
  kind: ContentTypeKind,
  header: string | null,
  hasBody: boolean,
): boolean {
  if (header === null) return !hasBody;
  const media = parseMediaType(header);
  if (media === undefined) return false;
  return kind === 'json' ? isJson(media) : isMultipart(media);
}

/** Stage 9 for one route: 415 `unsupported_media_type` unless the content type fits the route. */
export function requireContentType(kind: ContentTypeKind): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const headers = c.req.raw.headers;
    if (!contentTypeAllowed(kind, headers.get('content-type'), requestHasBody(headers))) {
      return problemResponse(c, 'unsupported_media_type');
    }
    await next();
    return undefined;
  };
}
