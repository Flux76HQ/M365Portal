// `APP_KEY`: formats, validation and the key id (FR-B-104, plan 7.1). Pure: no I/O, no logging.
// Reading the file named by `APP_KEY_FILE` happens at start (T-B-019); this module only judges the
// text or the bytes it is given.
//
// A key is exactly 32 bytes, written as 64 hexadecimal characters, or as base64 or base64url of
// 43 characters (44 with one trailing `=`) over ONE alphabet. The encoding must be canonical:
// re-encoding the decoded bytes has to reproduce the input, which rejects non-zero trailing bits.
// Rejected as weak: all bytes equal, and fewer than 16 distinct byte values.
//
// Every failure carries a code and nothing of the input: a key must never reach a log line, an
// error message, a problem body or `/readyz`.
import { createHash } from 'node:crypto';
import { LIMITS } from '@m365portal/shared/limits';

export const APP_KEY_BYTES = LIMITS.secrets.appKeyBytes;
export const APP_KEY_FILE_MAX_BYTES = LIMITS.secrets.appKeyFileMaxBytes;

/** Fewer distinct byte values than this is a weak key (FR-B-104). */
const MIN_DISTINCT_BYTE_VALUES = 16;

export type AppKeyFailure = 'format' | 'weak' | 'file_too_large';

export type ParseAppKeyResult =
  | { readonly ok: true; readonly key: Uint8Array }
  | { readonly ok: false; readonly reason: AppKeyFailure };

/** Thrown by `requireAppKey`. The message is the code; it never holds a piece of the key. */
export class AppKeyError extends Error {
  readonly code: AppKeyFailure;

  constructor(code: AppKeyFailure) {
    super(`APP_KEY is not acceptable (${code})`);
    this.name = 'AppKeyError';
    this.code = code;
  }
}

const HEX = /^[0-9a-fA-F]{64}$/;
const BASE64_BODY = /^[A-Za-z0-9+/_-]{43}$/;

function decodeBase64Text(text: string): Uint8Array | undefined {
  const padded = text.length === 44;
  if (padded && !text.endsWith('=')) return undefined;
  const body = padded ? text.slice(0, 43) : text;
  if (!BASE64_BODY.test(body)) return undefined;
  const standard = /[+/]/.test(body);
  const urlSafe = /[-_]/.test(body);
  if (standard && urlSafe) return undefined;
  const asStandard = body.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Buffer.from(asStandard, 'base64');
  if (bytes.length !== APP_KEY_BYTES) return undefined;
  // Canonical: the bytes written back in the same alphabet are the input.
  const again = bytes.toString('base64').replace(/=+$/, '');
  const written = urlSafe ? again.replaceAll('+', '-').replaceAll('/', '_') : again;
  return written === body ? new Uint8Array(bytes) : undefined;
}

function isWeak(key: Uint8Array): boolean {
  return new Set(key).size < MIN_DISTINCT_BYTE_VALUES;
}

/** Read the text of `APP_KEY` (or the trimmed content of the key file). */
export function parseAppKey(text: string): ParseAppKeyResult {
  let key: Uint8Array | undefined;
  if (HEX.test(text)) key = new Uint8Array(Buffer.from(text, 'hex'));
  else key = decodeBase64Text(text);
  if (key === undefined || key.length !== APP_KEY_BYTES) return { ok: false, reason: 'format' };
  return isWeak(key) ? { ok: false, reason: 'weak' } : { ok: true, key };
}

/** Like `parseAppKey` but throws `AppKeyError`, for callers that cannot continue without a key. */
export function requireAppKey(text: string): Uint8Array {
  const result = parseAppKey(text);
  if (!result.ok) throw new AppKeyError(result.reason);
  return result.key;
}

/**
 * The content of the file `APP_KEY_FILE` names: at most 1,024 bytes of UTF-8, one trailing `\n` or
 * `\r\n` removed, then the same rules as the variable. A file over the limit is refused before it
 * is looked at.
 */
export function parseAppKeyFileContent(content: Uint8Array): ParseAppKeyResult {
  if (content.length > APP_KEY_FILE_MAX_BYTES) return { ok: false, reason: 'file_too_large' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  return parseAppKey(text);
}

/**
 * The key id: the first 8 bytes, as 16 lower-case hex characters, of SHA-256 over the ASCII string
 * `m365portal-key-id` followed by the key. It is stored in `secret.key_id` and may be logged.
 */
export function keyId(key: Uint8Array): string {
  return createHash('sha256')
    .update('m365portal-key-id', 'ascii')
    .update(key)
    .digest('hex')
    .slice(0, LIMITS.secrets.keyIdBytes * 2);
}
