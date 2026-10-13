// The line-delimited JSON protocol between the server and the `pwsh` worker (Phase D, T-D-105,
// FR-D-102, FR-D-107, PD-01). One JSON object per line, on the worker's stdin (requests) and stdout
// (answers). Requests are serial. A request carries an id, a type, and for a `call` a cmdlet from the
// closed allow-list (`allow-list.ts`), its parameters and a deadline. An answer carries the id and
// either data or a CLOSED error code: the worker never sends free text, because a message from
// Exchange can hold a name or an address and must not reach logs.
//
// Pure and platform-neutral: no clock, no I/O, no randomness. Runs in the server, in tests and in the
// worker stand-in alike.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { GuidSchema, RequestIdSchema } from '../schemas/common.js';
import { isExchangeCmdlet, validateCall } from './allow-list.js';

export const PROTOCOL_VERSION = 1 as const;

const v = z.literal(PROTOCOL_VERSION);
const id = RequestIdSchema;

/** A DNS name of the tenant, such as `contoso.onmicrosoft.com` (`Connect-ExchangeOnline -Organization`). */
const OrganizationSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

/**
 * One PEM block of a given label: the frame lines, a base64 body in lines (LF or CRLF), nothing before or after
 * but an optional final line break. The body is bounded so a line cannot be made to carry anything else.
 */
const pemBlock = (label: string): RegExp =>
  new RegExp(
    `^-----BEGIN ${label}-----\\r?\\n(?:[A-Za-z0-9+/]{1,76}\\r?\\n)*[A-Za-z0-9+/]{1,76}={0,2}\\r?\\n-----END ${label}-----(?:\\r?\\n)?$`,
  );

/**
 * The certificate of the connection, handed over in the first line on stdin and never in arguments or
 * the environment (plan 5.1, FR-D-103; amended by GD1-0 section "Amendment 1": PEM in place of PKCS#12).
 * The certificate is an X.509 PEM, the key an UNENCRYPTED PKCS#8 PEM (`PRIVATE KEY`); the worker builds
 * the certificate object with `X509Certificate2.CreateFromPem`. The values are secrets: they are never
 * logged.
 */
const CertificateSchema = z.strictObject({
  format: z.literal('pem'),
  certificate: z.string().min(64).max(16_384).regex(pemBlock('CERTIFICATE')),
  privateKey: z.string().min(64).max(16_384).regex(pemBlock('PRIVATE KEY')),
});

const deadlineMax = LIMITS.exchange.callDeadlineSeconds * 1000;

const CallSchema = z
  .strictObject({
    v,
    type: z.literal('call'),
    id,
    cmdlet: z.string().max(64),
    // Kept as received (no copy): a record schema would drop a `__proto__` key silently, and the
    // allow-list must see it to refuse it.
    args: z.custom<Record<string, unknown>>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    ),
    deadlineMs: z.number().int().min(1000).max(deadlineMax),
  })
  .superRefine((request, context) => {
    if (!isExchangeCmdlet(request.cmdlet)) {
      context.addIssue({ code: 'custom', path: ['cmdlet'], message: 'not in the allow-list' });
      return;
    }
    const checked = validateCall(request.cmdlet, request.args);
    if (!checked.ok) {
      context.addIssue({
        code: 'custom',
        path: ['args'],
        message: `${checked.reason}: ${checked.parameters.join(', ')}`,
      });
    }
  });

/** A request line. Every member is checked; a `call` is also checked against the allow-list. */
export const ExchangeRequestSchema = z.union([
  CallSchema,
  z.strictObject({ v, type: z.literal('ping'), id }),
  z.strictObject({ v, type: z.literal('shutdown'), id }),
  z.strictObject({
    v,
    type: z.literal('connect'),
    id,
    appId: GuidSchema,
    organization: OrganizationSchema,
    certificate: CertificateSchema,
  }),
]);
export type ExchangeRequest = z.infer<typeof ExchangeRequestSchema>;

/**
 * Why a call failed, as a closed list; the server maps it to a problem code and, for
 * `role_pending` and `timeout`, a detail code (`exchange_role_pending`, `exchange_timeout`).
 */
export const EXCHANGE_ERROR_CODES = [
  'not_found',
  'already_exists',
  'already_member',
  'not_a_member',
  'member_type_not_allowed',
  'permission_denied',
  'manager_check',
  'read_only_object',
  'throttled',
  'timeout',
  'invalid_argument',
  'not_connected',
  'role_pending',
  'internal',
] as const;
export type ExchangeErrorCode = (typeof EXCHANGE_ERROR_CODES)[number];

/** An answer line: data, or a closed error code with an optional wait before a retry. */
export const ExchangeResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ v, id, ok: z.literal(true), data: z.json() }),
  z.strictObject({
    v,
    id,
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(EXCHANGE_ERROR_CODES),
      retryAfterMs: z.number().int().min(0).max(3_600_000).optional(),
      // GD1-0 Amendment 2: the number of an Entra `AADSTS<n>` code when a connect was refused by the
      // sign-in service. Digits only, never text: it tells a missing consent or role from other faults.
      aadsts: z.number().int().min(1).max(9_999_999).optional(),
      // GD1-0 Amendment 3: the .NET type name of the innermost exception and the first part of the
      // error id, letters, digits, dots and underscores only (never message text), to tell faults apart.
      detail: z
        .strictObject({
          type: z
            .string()
            .regex(/^[A-Za-z0-9_.]{1,120}$/)
            .optional(),
          errorId: z
            .string()
            .regex(/^[A-Za-z0-9_.]{1,120}$/)
            .optional(),
          // GD1-0 Amendment 4: words of a closed list that the error text contains, and HTTP status numbers.
          hints: z
            .array(z.string().regex(/^[a-z0-9_]{1,24}$/))
            .max(16)
            .optional(),
        })
        .optional(),
    }),
  }),
]);
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

/**
 * One message as one line: JSON never holds a raw newline (they are escaped), so the framing cannot
 * be broken by a value. Throws a `RangeError` for a line over `LIMITS.exchange.lineMaxBytes`.
 */
export function encodeLine(message: unknown): string {
  const text = JSON.stringify(message);
  if (utf8Bytes(text) > LIMITS.exchange.lineMaxBytes) {
    throw new RangeError('the protocol line is longer than the limit');
  }
  return `${text}\n`;
}

/** What a decoder yields: a complete line, a line that was too long, or (from `flush`) an unfinished one. */
export type DecodedLine =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'overflow' }
  | { readonly kind: 'partial'; readonly text: string };

export interface LineDecoder {
  /** Add a chunk of the stream; returns the lines it completed. Blank lines are skipped. */
  push(chunk: string): DecodedLine[];
  /** The unfinished line, if any, once the stream ended. */
  flush(): DecodedLine[];
}

/**
 * Cut a text stream into lines, however it was chunked. A `\r\n` ending is accepted. A line over
 * `maxBytes` (UTF-8) yields ONE `overflow` and the rest of that line is skipped up to its newline.
 */
export function createLineDecoder(maxBytes: number = LIMITS.exchange.lineMaxBytes): LineDecoder {
  let buffer = '';
  let bufferBytes = 0;
  let skipping = false;

  const push = (chunk: string): DecodedLine[] => {
    const lines: DecodedLine[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf('\n');
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      rest = newline === -1 ? '' : rest.slice(newline + 1);
      if (!skipping) {
        buffer += piece;
        bufferBytes += utf8Bytes(piece);
        if (bufferBytes > maxBytes) {
          lines.push({ kind: 'overflow' });
          buffer = '';
          bufferBytes = 0;
          skipping = true;
        }
      }
      if (newline === -1) break;
      if (skipping) {
        skipping = false;
      } else {
        const text = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        if (text.length > 0) lines.push({ kind: 'line', text });
        buffer = '';
        bufferBytes = 0;
      }
    }
    return lines;
  };

  const flush = (): DecodedLine[] => {
    const text = buffer;
    buffer = '';
    bufferBytes = 0;
    skipping = false;
    return text.length > 0 ? [{ kind: 'partial', text }] : [];
  };

  return { push, flush };
}

// ---------------------------------------------------------------------------------------------
// Parsing a line
// ---------------------------------------------------------------------------------------------

export type ParseResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: 'not_json' | 'invalid' | 'too_long' };

function parseLine<Value>(line: string, schema: z.ZodType<Value>): ParseResult<Value> {
  if (utf8Bytes(line) > LIMITS.exchange.lineMaxBytes) return { ok: false, reason: 'too_long' };
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, value: result.data } : { ok: false, reason: 'invalid' };
}

/** A request line as the worker (or its stand-in) reads it. The reason never holds content. */
export function parseRequestLine(line: string): ParseResult<ExchangeRequest> {
  return parseLine(line, ExchangeRequestSchema);
}

/** An answer line as the server reads it. */
export function parseResponseLine(line: string): ParseResult<ExchangeResponse> {
  return parseLine(line, ExchangeResponseSchema);
}
