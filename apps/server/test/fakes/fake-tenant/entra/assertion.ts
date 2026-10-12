// The client assertion, built and checked the way Microsoft Learn describes it (T-B-064). Test
// support: nothing under `src/` imports it.
//
// Learn, https://learn.microsoft.com/entra/identity-platform/certificate-credentials:
//   header   alg PS256, typ JWT, x5t#S256 = base64url SHA-256 thumbprint of the certificate DER
//   claims   aud https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token, iss = sub = client
//            id, jti unique, nbf now, iat, exp "5-10 minutes after nbf at most"
//   signature PS256 ("Use PSS padding")
//
// The fake is stricter than Entra where Learn says "should" or "at most": `typ` must be `JWT`,
// `x5t#S256` must be present and must name a registered certificate (the SHA-1 `x5t` alone is not
// enough, U21), `exp` at most 10 minutes after `nbf` although Learn adds that Entra "doesn't place
// restrictions on the exp time currently" (U58), and a `jti` is accepted once (Learn says it must
// be unique; whether Entra rejects a replay is not stated, U59). A rule the product breaks should
// fail in a test here, not at the first real token request.
import { X509Certificate, type KeyObject } from 'node:crypto';
import type { KeyCredentialRecord } from '../graph/directory.js';
import {
  compact,
  parseCompact,
  rsaKeyPair,
  verifyPs256,
  type JsonObject,
  type SigningAlgorithm,
} from './jwt.js';

/** The slot of the key pair a "signed by someone else" assertion uses. */
export const OTHER_KEY_SLOT = 9_001;

export const MAX_ASSERTION_LIFETIME_SECONDS = 600;

export interface AssertionCertificate {
  readonly privateKey: KeyObject;
  /** Base64url SHA-256 of the DER. */
  readonly thumbprintSha256: string;
  /** Upper-case hex SHA-1 of the DER. */
  readonly thumbprintSha1: string;
}

export interface BuildAssertionOptions {
  readonly certificate: AssertionCertificate;
  readonly clientId: string;
  /** The tenant as written in the token endpoint path: it is part of `aud`. */
  readonly tenant: string;
  readonly nowMs: number;
  readonly jti?: string;
  readonly alg?: SigningAlgorithm;
  readonly header?: JsonObject;
  readonly omitHeader?: readonly string[];
  /** Also send the SHA-1 `x5t` header (base64url of the thumbprint bytes). */
  readonly includeX5t?: boolean;
  readonly claims?: JsonObject;
  readonly omitClaims?: readonly string[];
  readonly arrayAudience?: boolean;
  /** Offsets in seconds from now: `nbf` (default 0), `exp` (default 300), `iat` (default = nbf). */
  readonly timing?: { readonly nbf?: number; readonly exp?: number; readonly iat?: number };
  readonly signWithOtherKey?: boolean;
}

/** The base64url form of an upper-case hex SHA-1, which is what a `x5t` header carries. */
export function x5tOf(thumbprintSha1: string): string {
  return Buffer.from(thumbprintSha1, 'hex').toString('base64url');
}

/** Builds a compact client assertion; options bend one rule at a time for the negative tests. */
export function buildClientAssertion(options: BuildAssertionOptions): string {
  const nowSeconds = Math.floor(options.nowMs / 1000);
  const nbf = nowSeconds + (options.timing?.nbf ?? 0);
  const exp = nowSeconds + (options.timing?.exp ?? 300);
  const iat = nowSeconds + (options.timing?.iat ?? options.timing?.nbf ?? 0);
  const endpoint = `https://login.microsoftonline.com/${options.tenant}/oauth2/v2.0/token`;
  const header: JsonObject = {
    alg: options.alg ?? 'PS256',
    typ: 'JWT',
    'x5t#S256': options.certificate.thumbprintSha256,
    ...(options.includeX5t === true ? { x5t: x5tOf(options.certificate.thumbprintSha1) } : {}),
    ...options.header,
  };
  for (const name of options.omitHeader ?? []) Reflect.deleteProperty(header, name);
  const claims: JsonObject = {
    aud: options.arrayAudience === true ? [endpoint] : endpoint,
    iss: options.clientId,
    sub: options.clientId,
    jti: options.jti ?? 'jti-default',
    nbf,
    iat,
    exp,
    ...options.claims,
  };
  for (const name of options.omitClaims ?? []) Reflect.deleteProperty(claims, name);
  const key =
    options.signWithOtherKey === true
      ? rsaKeyPair(OTHER_KEY_SLOT).privateKey
      : options.certificate.privateKey;
  const alg = (typeof header.alg === 'string' ? header.alg : 'PS256') as SigningAlgorithm;
  // A header that names an algorithm the signer does not have is signed as PS256 and keeps its label.
  const signWith: SigningAlgorithm = ['PS256', 'RS256', 'none'].includes(alg) ? alg : 'PS256';
  return compact(signWith, header, claims, key);
}

export type AssertionRejection =
  | 'malformed'
  | 'bad_alg'
  | 'bad_typ'
  | 'missing_x5t_s256'
  | 'unknown_certificate'
  | 'x5t_mismatch'
  | 'bad_iss'
  | 'bad_sub'
  | 'bad_aud'
  | 'missing_jti'
  | 'missing_nbf'
  | 'missing_exp'
  | 'not_yet_valid'
  | 'expired'
  | 'lifetime_too_long'
  | 'certificate_expired'
  | 'certificate_not_yet_valid'
  | 'bad_signature'
  | 'jti_reused';

export interface AssertionCheck {
  readonly assertion: string;
  readonly clientId: string;
  /** The tenant as written in the request path. */
  readonly tenantPath: string;
  readonly credentials: readonly KeyCredentialRecord[];
  readonly nowMs: number;
  /** `clientId:jti` of assertions already accepted. */
  readonly seenJti: Set<string>;
}

function isoMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `undefined` when the assertion is acceptable, otherwise the first rule it breaks. */
export function checkClientAssertion(check: AssertionCheck): AssertionRejection | undefined {
  const parsed = parseCompact(check.assertion);
  if (parsed === undefined) return 'malformed';
  const { header, payload } = parsed;

  if (header.alg !== 'PS256') return 'bad_alg';
  if (header.typ !== 'JWT') return 'bad_typ';
  const s256 = header['x5t#S256'];
  if (typeof s256 !== 'string' || s256 === '') return 'missing_x5t_s256';
  const credential = check.credentials.find((candidate) => candidate.thumbprintSha256 === s256);
  if (credential === undefined) return 'unknown_certificate';
  if ('x5t' in header && header.x5t !== x5tOf(credential.thumbprintSha1)) return 'x5t_mismatch';

  if (payload.iss !== check.clientId) return 'bad_iss';
  if (payload.sub !== check.clientId) return 'bad_sub';
  if (payload.aud !== `https://login.microsoftonline.com/${check.tenantPath}/oauth2/v2.0/token`) {
    return 'bad_aud';
  }
  if (typeof payload.jti !== 'string' || payload.jti === '') return 'missing_jti';
  const { nbf, exp } = payload;
  if (typeof nbf !== 'number' || !Number.isFinite(nbf)) return 'missing_nbf';
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return 'missing_exp';
  const now = Math.floor(check.nowMs / 1000);
  if (nbf > now) return 'not_yet_valid';
  if (exp <= now) return 'expired';
  if (exp - nbf > MAX_ASSERTION_LIFETIME_SECONDS) return 'lifetime_too_long';

  const notAfter = isoMs(credential.endDateTime);
  if (notAfter !== undefined && notAfter < check.nowMs) return 'certificate_expired';
  const notBefore = isoMs(credential.startDateTime);
  if (notBefore !== undefined && notBefore > check.nowMs) return 'certificate_not_yet_valid';

  let publicKey: KeyObject;
  try {
    publicKey = new X509Certificate(Buffer.from(credential.key, 'base64')).publicKey;
  } catch {
    return 'bad_signature';
  }
  if (!verifyPs256(parsed.input, parsed.signature, publicKey)) return 'bad_signature';

  const seen = `${check.clientId}:${payload.jti}`;
  if (check.seenJti.has(seen)) return 'jti_reused';
  check.seenJti.add(seen);
  return undefined;
}
