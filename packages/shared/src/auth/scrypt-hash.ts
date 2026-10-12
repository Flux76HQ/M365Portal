// The break-glass password hash format, parsed and written in one place (FR-B-521 parameter floors,
// SB-04, CB4):
//
//   scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
//
// No `$`, so Docker Compose does not interpolate the value. `N` is a power of two from 16,384 to
// 131,072; `r` is 8 to 16; `p` is 1 to 4; `128 * N * r` is at most 134,217,728 bytes, so one
// verification needs at most 128 MiB (plan V-B10: N = 2^20 would need 1 GiB, the Compose limit is
// 512 MiB); the salt is 16 to 64 bytes and the hash 32 to 64 bytes, both unpadded canonical
// base64url. Weaker parameters are refused, and so are heavier ones: a hash that cannot be verified
// inside the memory budget must fail at configuration time, not at the first sign-in.
//
// Configuration (`config_invalid`), the CLI (`hash-password`) and the verifier all use this module.
// A failure carries a reason code and never the value.
import { LIMITS } from '../limits.js';

export const SCRYPT_R_MIN = 8;
export const SCRYPT_R_MAX = 16;
export const SCRYPT_P_MIN = 1;
export const SCRYPT_P_MAX = 4;

/** The longest well-formed line is about 190 characters; anything above this is not looked at. */
const MAX_LINE_CHARS = 256;

export type ScryptHashFailure =
  'oversized' | 'format' | 'n' | 'r' | 'p' | 'memory' | 'salt' | 'hash' | 'encoding';

export interface ScryptHashParts {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

export type ParseScryptHashResult =
  | { readonly ok: true; readonly value: ScryptHashParts }
  | { readonly ok: false; readonly reason: ScryptHashFailure };

/** Thrown by `formatScryptHash` for parts the parser would refuse. Never carries the value. */
export class ScryptHashError extends Error {
  readonly reason: ScryptHashFailure;

  constructor(reason: ScryptHashFailure) {
    super(`the scrypt hash is not acceptable: ${reason}`);
    this.name = 'ScryptHashError';
    this.reason = reason;
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeBase64Url(data: Uint8Array): string {
  let out = '';
  for (let index = 0; index < data.length; index += 3) {
    const a = data[index] ?? 0;
    const b = data[index + 1] ?? 0;
    const c = data[index + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    out += ALPHABET.charAt((chunk >> 18) & 63) + ALPHABET.charAt((chunk >> 12) & 63);
    if (index + 1 < data.length) out += ALPHABET.charAt((chunk >> 6) & 63);
    if (index + 2 < data.length) out += ALPHABET.charAt(chunk & 63);
  }
  return out;
}

/** Decode canonical unpadded base64url; `undefined` for anything else (padding, other alphabet, spare bits). */
function decodeBase64Url(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  const values: number[] = [];
  for (const character of text) {
    const value = ALPHABET.indexOf(character);
    if (value === -1) return undefined;
    values.push(value);
  }
  const out: number[] = [];
  for (let index = 0; index < values.length; index += 4) {
    const chunk =
      ((values[index] ?? 0) << 18) |
      ((values[index + 1] ?? 0) << 12) |
      ((values[index + 2] ?? 0) << 6) |
      (values[index + 3] ?? 0);
    out.push((chunk >> 16) & 255);
    if (index + 2 < values.length) out.push((chunk >> 8) & 255);
    if (index + 3 < values.length) out.push(chunk & 255);
  }
  const decoded = Uint8Array.from(out);
  // Spare bits must be zero: the canonical form is the one this module would write.
  return encodeBase64Url(decoded) === text ? decoded : undefined;
}

const DIGITS = /^[1-9][0-9]{0,9}$/;

function integer(text: string | undefined): number | undefined {
  return text !== undefined && DIGITS.test(text) ? Number(text) : undefined;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** The first parameter fault of `parts`, or `undefined` when they are acceptable. */
function checkParts(parts: ScryptHashParts): ScryptHashFailure | undefined {
  const { nMin, nMax, maxMemoryBytes, saltMinBytes, saltMaxBytes, hashMinBytes, hashMaxBytes } =
    LIMITS.breakGlass.scrypt;
  if (!Number.isInteger(parts.n) || parts.n < nMin || parts.n > nMax || !isPowerOfTwo(parts.n)) {
    return 'n';
  }
  if (!Number.isInteger(parts.r) || parts.r < SCRYPT_R_MIN || parts.r > SCRYPT_R_MAX) return 'r';
  if (!Number.isInteger(parts.p) || parts.p < SCRYPT_P_MIN || parts.p > SCRYPT_P_MAX) return 'p';
  if (128 * parts.n * parts.r > maxMemoryBytes) return 'memory';
  if (parts.salt.length < saltMinBytes || parts.salt.length > saltMaxBytes) return 'salt';
  if (parts.hash.length < hashMinBytes || parts.hash.length > hashMaxBytes) return 'hash';
  return undefined;
}

/** Parse a `scrypt:` line. Total: it never throws and never repeats the input. */
export function parseScryptHash(text: string): ParseScryptHashResult {
  if (text.length > MAX_LINE_CHARS) return { ok: false, reason: 'oversized' };
  if (/\s/.test(text)) return { ok: false, reason: 'format' };
  const fields = text.split(':');
  if (fields.length !== 6 || fields[0] !== 'scrypt') return { ok: false, reason: 'format' };
  const [, nText, rText, pText, saltText = '', hashText = ''] = fields;
  const n = integer(nText);
  const r = integer(rText);
  const p = integer(pText);
  // Parameters first, in order, so the reason is the first fault a reader would look at.
  if (n === undefined) return { ok: false, reason: 'n' };
  const probe: ScryptHashParts = {
    n,
    r: r ?? 0,
    p: p ?? 0,
    salt: new Uint8Array(LIMITS.breakGlass.scrypt.saltMinBytes),
    hash: new Uint8Array(LIMITS.breakGlass.scrypt.hashMinBytes),
  };
  const parameterFault = checkParts(probe);
  if (parameterFault !== undefined) return { ok: false, reason: parameterFault };
  const salt = decodeBase64Url(saltText);
  const hash = decodeBase64Url(hashText);
  if (salt === undefined || hash === undefined) return { ok: false, reason: 'encoding' };
  const value: ScryptHashParts = { n, r: probe.r, p: probe.p, salt, hash };
  const fault = checkParts(value);
  return fault === undefined ? { ok: true, value } : { ok: false, reason: fault };
}

/** Write the line for `parts`; throws `ScryptHashError` for parts the parser would refuse. */
export function formatScryptHash(parts: ScryptHashParts): string {
  const fault = checkParts(parts);
  if (fault !== undefined) throw new ScryptHashError(fault);
  return [
    'scrypt',
    String(parts.n),
    String(parts.r),
    String(parts.p),
    encodeBase64Url(parts.salt),
    encodeBase64Url(parts.hash),
  ].join(':');
}
