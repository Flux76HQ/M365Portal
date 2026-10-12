// Shared value schemas (contract section 8.1, FR-A-024, FR-A-082): the small building blocks that the
// route schemas, the audit entries and the web forms have in common.
//
// Rules of this folder: Zod only, no transform (a transform cannot be written in OpenAPI), every
// schema has `.meta({ id })`, and the id is the constant name without the `Schema` suffix.
import { z } from 'zod';

/** A SHA-256 digest as 64 lower-case hexadecimal characters (asset hashes). */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ id: 'Sha256Hex' });

/** A stored colour: lower-case `#rrggbb`. The output form; what a user types is `AccentInput`. */
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/)
  .meta({ id: 'HexColor' });

/**
 * What a user types as an accent colour: `#rgb` or `#rrggbb`, in any case. The schema checks and
 * returns the text unchanged; storing it as lower-case `#rrggbb` is the job of `normalizeAccent`.
 * Every failure, including a value that is not a string, has the message code `accent_invalid`,
 * which the server promotes to the problem code (FR-A-082).
 */
export const AccentInputSchema = z
  .string({ error: 'accent_invalid' })
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, { error: 'accent_invalid' })
  .meta({ id: 'AccentInput' });

/**
 * A UTC timestamp with milliseconds and the `Z` suffix, such as `2026-10-10T12:34:56.789Z`: the
 * form the injected clock produces and `Date.prototype.toISOString` writes. Offsets, a missing
 * fraction and dates that do not exist are refused.
 */
export const IsoTimestampSchema = z.iso.datetime({ precision: 3 }).meta({ id: 'IsoTimestamp' });

/** A request id: 8 to 64 letters, digits and hyphens (FR-A-024). Anything else is replaced. */
export const RequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,64}$/)
  .meta({ id: 'RequestId' });

/** True for the serialised origin of an http or https URL, exactly as `URL.origin` writes it. */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * The serialised origin of an http or https URL: scheme, host and a non-default port, with no
 * path, trailing slash, query, fragment or credentials. This is the form of `PUBLIC_BASE_URL`
 * after normalisation, the form of the `Origin` request header, and what `/api/v1/me` returns as
 * `publicOrigin`.
 */
export const OriginSchema = z
  .string()
  .refine(isHttpOrigin, {
    error: 'an http or https origin has no path, query, fragment, credentials or trailing slash',
  })
  .meta({ id: 'Origin' });

// ---------------------------------------------------------------------------------------------
// Phase B additions (T-B-024, XB5, CB14)
// ---------------------------------------------------------------------------------------------

/**
 * A GUID in the canonical lower-case form `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`: how Entra object
 * and application ids are stored and compared (upper case, braces and bare hex are refused).
 */
export const GuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .meta({ id: 'Guid' });

/** The UTF-8 length of `value` in bytes. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

const PARAMS_MAX_ENTRIES = 8;
const PARAMS_STRING_MAX_BYTES = 256;

/**
 * Parameters of a message key or a result: names, ids and counts, never free text. A flat map of at
 * most 8 entries; a value is a string of at most 256 UTF-8 bytes, a finite number or a boolean; a
 * key is an identifier of at most 64 characters. Nothing nested.
 */
export const ParamsSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    z.union([
      z.string().refine((value) => utf8Bytes(value) <= PARAMS_STRING_MAX_BYTES, {
        error: 'a parameter string has at most 256 bytes',
      }),
      z.number(),
      z.boolean(),
    ]),
  )
  .refine((params) => Object.keys(params).length <= PARAMS_MAX_ENTRIES, {
    error: 'at most 8 parameters',
  })
  .meta({ id: 'Params' });

/** An opaque list cursor (CD-10): 1 to 512 URL-safe characters. The server decides what is inside. */
export const CursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,512}$/)
  .meta({ id: 'Cursor' });

/** List routes: the page size when `limit` is absent, and its ceiling (CD-10). */
export const PAGE_LIMIT_DEFAULT = 100;
export const PAGE_LIMIT_MAX = 200;

/**
 * The query of a list route (CD-10). A query string is text and a route schema has no coercion, so
 * `limit` is the text of a whole number from 1 to 200 without sign or leading zero; `pageLimitOf`
 * turns it into the number, with the default 100 when it is absent.
 */
export const PageQuerySchema = z
  .strictObject({
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .refine((text) => Number(text) <= PAGE_LIMIT_MAX, {
        error: 'limit is at most 200',
      })
      .optional(),
    cursor: CursorSchema.optional(),
  })
  .meta({ id: 'PageQuery' });

export type PageQuery = z.infer<typeof PageQuerySchema>;

/** The page size of a parsed list query. */
export function pageLimitOf(query: PageQuery): number {
  return query.limit === undefined ? PAGE_LIMIT_DEFAULT : Number(query.limit);
}
