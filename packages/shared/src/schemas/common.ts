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
