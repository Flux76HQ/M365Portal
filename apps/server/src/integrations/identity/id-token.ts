// The ID-token validator (T-B-078, FR-B-404, EB-22; plan 8.6.5; F-02 to F-27 of spec Appendix C).
//
// THE ONLY FILE THAT DECODES A MICROSOFT TOKEN (lint `local/no-decode-microsoft-tokens`, FR-B-316):
// `decodeJwt` and `decodeProtectedHeader` are used here, on the ID token Entra issued to OUR
// application, and nowhere else. An access token for Graph or Exchange is opaque to the product
// (Learn: "Don't attempt to validate or read tokens for any API you don't own",
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).
//
// What Learn says the validation is (https://learn.microsoft.com/entra/identity-platform/id-tokens,
// .../id-token-claims-reference): validate the signature, then the timestamps (`iat`, `nbf`, `exp`),
// `aud` equal to the application's client id and `nonce`; `iss` ends in `/v2.0` for a v2.0 token and
// is `https://login.microsoftonline.com/{tid}/v2.0`; `tid` is the tenant and must match the pinned
// one; `ver` is `2.0`; `oid` identifies the user across applications and `sub` is pairwise (never
// kept). The keys come from the tenant's key set (signing-key-rollover, jwks.ts). The discovery
// document lists `id_token_signing_alg_values_supported` as `["RS256"]` only (V-B12), so `alg` is
// exactly `RS256`. The 60 s tolerance for `exp`, `nbf` and `iat` is OUR choice: Learn gives none
// (U33, U35).
//
// `jose` 6.2.12 does the signature and most claims, and accepts three things on its own (V-B07):
// an `iat` in the future, an `aud` ARRAY that holds the client id, and `jku`, `jwk`, `x5u` headers.
// The validator therefore adds its own checks around `jose`, in this order (each failing check is an
// `IdTokenError` with the `check` name of Appendix C, never shown to the user):
//
//   size  format  header  alg  tenant (+ issuer)  [jose: kid signature expired not_before
//   audience issuer]  audience (a string)  issued_at  version  oid  nonce
//
// The steps are a list, `ID_TOKEN_STEPS`; the tests build copies without one step to prove that the
// matching fixtures then fail (mutation-style negatives, plan 14.6). Production uses the list as it is.
import { timingSafeEqual, createHash } from 'node:crypto';
import { LIMITS } from '@m365portal/shared/limits';
import { decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Clock } from '../../ports/clock.js';
import { IdTokenError, type IdTokenCheck } from '../../ports/errors.js';
import type { ValidatedIdToken } from '../../ports/identity.js';
import { MICROSOFT_ORIGINS, guidSegment, isGuid } from '../http/url-guard.js';
import { KeySetUnavailableError, type KeySet } from './jwks.js';

const MAX_BYTES = LIMITS.microsoft.idTokenMaxBytes;
const TOLERANCE_SECONDS = LIMITS.microsoft.clockToleranceSeconds;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** The signature segment may be empty: `alg: none` is judged by `alg`, not by `format` (F-17). */
const SIGNATURE_SEGMENT = /^[A-Za-z0-9_-]*$/;
const FORBIDDEN_HEADERS = ['jku', 'x5u', 'jwk', 'crit'] as const;
const LABEL_MAX_BYTES = 256;
const AMR_MAX_ITEMS = 16;
const AMR_MAX_LENGTH = 32;

export interface IdTokenValidatorDeps {
  /** The pinned tenant id (a GUID). */
  readonly tenantId: string;
  /** The client id of the panel's application (a GUID). */
  readonly clientId: string;
  readonly keys: Pick<KeySet, 'getKey'>;
  readonly clock: Clock;
}

/** What a step sees and fills in. */
export interface IdTokenContext {
  readonly raw: string;
  readonly expectedNonce: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly keys: Pick<KeySet, 'getKey'>;
  readonly now: Date;
  /** The payload as written, before the signature is checked: used to refuse EARLIER, never to accept. */
  unverified?: JWTPayload;
  /** The payload after `jose` has verified signature and claims. */
  verified?: JWTPayload;
}

export interface IdTokenStep {
  /** The name of the step, for the mutation tests; `signature_and_claims` is the `jose` call. */
  readonly name: string;
  run(context: IdTokenContext): void | Promise<void>;
}

function fail(check: IdTokenCheck): never {
  throw new IdTokenError({ check });
}

/** Constant-time comparison of two strings (digests first, so the lengths do not leak). */
function sameText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b) && left.length === right.length;
}

const sizeStep: IdTokenStep = {
  name: 'size',
  run(context) {
    if (typeof context.raw !== 'string') fail('format');
    if (Buffer.byteLength(context.raw, 'utf8') > MAX_BYTES) fail('size');
  },
};

const formatStep: IdTokenStep = {
  name: 'format',
  run(context) {
    if (typeof context.raw !== 'string') fail('format');
    const parts = context.raw.split('.');
    const [head, body, signature] = parts;
    if (
      parts.length !== 3 ||
      head === undefined ||
      body === undefined ||
      signature === undefined ||
      !SEGMENT.test(head) ||
      !SEGMENT.test(body) ||
      !SIGNATURE_SEGMENT.test(signature)
    ) {
      fail('format');
    }
    try {
      // Both must decode to JSON objects; `decodeJwt` refuses a payload that is an array.
      decodeProtectedHeader(context.raw);
      context.unverified = decodeJwt(context.raw);
    } catch {
      fail('format');
    }
  },
};

const headerStep: IdTokenStep = {
  name: 'header',
  run(context) {
    const header = decodeProtectedHeader(context.raw);
    if (FORBIDDEN_HEADERS.some((name) => name in header)) fail('header');
    if (typeof header.kid !== 'string' || header.kid === '') fail('header');
  },
};

const algStep: IdTokenStep = {
  name: 'alg',
  run(context) {
    if (decodeProtectedHeader(context.raw).alg !== 'RS256') fail('alg');
  },
};

/** The unverified `tid` and `iss`: refusing a foreign token before the signature only refuses earlier. */
const tenantStep: IdTokenStep = {
  name: 'tenant',
  run(context) {
    const claims = context.unverified;
    const tid = claims?.tid;
    if (typeof tid !== 'string' || tid.toLowerCase() !== context.tenantId) fail('tenant');
    if (claims?.iss !== context.issuer) fail('issuer');
  },
};

/** Signature, key, expiry, not-before, audience and issuer by `jose` (V-B07), mapped to check names. */
const signatureStep: IdTokenStep = {
  name: 'signature_and_claims',
  async run(context) {
    try {
      const { payload } = await jwtVerify(context.raw, context.keys.getKey, {
        algorithms: ['RS256'],
        issuer: context.issuer,
        audience: context.clientId,
        clockTolerance: TOLERANCE_SECONDS,
        currentDate: context.now,
        requiredClaims: ['exp', 'iat', 'nbf', 'iss', 'aud', 'sub'],
      });
      context.verified = payload;
    } catch (failure) {
      throw mapVerifyFailure(failure);
    }
  },
};

function mapVerifyFailure(failure: unknown): IdTokenError {
  if (failure instanceof IdTokenError) return failure;
  if (failure instanceof KeySetUnavailableError)
    return new IdTokenError({ check: 'keys_unavailable' });
  if (failure instanceof errors.JWKSNoMatchingKey) return new IdTokenError({ check: 'kid' });
  if (failure instanceof errors.JWTExpired) return new IdTokenError({ check: 'expired' });
  if (failure instanceof errors.JWTClaimValidationFailed) {
    switch (failure.claim) {
      case 'exp':
        return new IdTokenError({ check: 'expired' });
      case 'nbf':
        return new IdTokenError({ check: 'not_before' });
      case 'iat':
        return new IdTokenError({ check: 'issued_at' });
      case 'iss':
        return new IdTokenError({ check: 'issuer' });
      case 'aud':
        return new IdTokenError({ check: 'audience' });
      default:
        return new IdTokenError({ check: 'format' });
    }
  }
  // A signature that does not verify, an algorithm `jose` does not allow, an unknown `crit`: no
  // token that reaches this line is acceptable, and which of them it was is not for the user.
  return new IdTokenError({ check: 'signature' });
}

/** `jose` accepts an `aud` array that holds the client id (F-09): the claim must be the string itself. */
const audienceStep: IdTokenStep = {
  name: 'audience_string',
  run(context) {
    if (typeof context.verified?.aud !== 'string') fail('audience');
  },
};

/** `jose` does not look at `iat` (F-16): not later than now plus the tolerance. */
const issuedAtStep: IdTokenStep = {
  name: 'issued_at',
  run(context) {
    const iat = context.verified?.iat;
    if (typeof iat !== 'number' || iat > context.now.getTime() / 1000 + TOLERANCE_SECONDS) {
      fail('issued_at');
    }
  },
};

const versionStep: IdTokenStep = {
  name: 'version',
  run(context) {
    if (context.verified?.ver !== '2.0') fail('version');
  },
};

const oidStep: IdTokenStep = {
  name: 'oid',
  run(context) {
    const oid = context.verified?.oid;
    if (typeof oid !== 'string' || !isGuid(oid.toLowerCase())) fail('oid');
  },
};

const nonceStep: IdTokenStep = {
  name: 'nonce',
  run(context) {
    const nonce = context.verified?.nonce;
    if (
      typeof nonce !== 'string' ||
      nonce === '' ||
      context.expectedNonce === '' ||
      !sameText(nonce, context.expectedNonce)
    ) {
      fail('nonce');
    }
  },
};

/** The steps of plan 8.6.5, in order. */
export const ID_TOKEN_STEPS: readonly IdTokenStep[] = Object.freeze([
  sizeStep,
  formatStep,
  headerStep,
  algStep,
  tenantStep,
  signatureStep,
  audienceStep,
  issuedAtStep,
  versionStep,
  oidStep,
  nonceStep,
]);

// ---- what is kept ------------------------------------------------------------------------------------

/** At most 256 bytes of a string label, cut at a character boundary; `null` for anything else. */
function label(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let out = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > LABEL_MAX_BYTES) break;
    out += character;
    bytes += size;
  }
  return out;
}

function amrOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > AMR_MAX_ITEMS) return null;
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.length > AMR_MAX_LENGTH) return null;
    items.push(item);
  }
  return items;
}

function kept(claims: JWTPayload, tenantId: string): ValidatedIdToken {
  const authTime = claims.auth_time;
  return {
    tid: tenantId,
    oid: String(claims.oid).toLowerCase(),
    upn: label(claims.preferred_username),
    name: label(claims.name),
    amr: amrOf(claims.amr),
    authTime: typeof authTime === 'number' && Number.isSafeInteger(authTime) ? authTime : null,
  };
}

export type IdTokenValidator = (raw: string, p: { nonce: string }) => Promise<ValidatedIdToken>;

export function createIdTokenValidator(
  deps: IdTokenValidatorDeps,
  steps: readonly IdTokenStep[] = ID_TOKEN_STEPS,
): IdTokenValidator {
  const tenantId = guidSegment(deps.tenantId);
  const clientId = guidSegment(deps.clientId);
  const issuer = `${MICROSOFT_ORIGINS.login}/${tenantId}/v2.0`;
  return async (raw, p) => {
    const context: IdTokenContext = {
      raw,
      expectedNonce: p.nonce,
      tenantId,
      clientId,
      issuer,
      keys: deps.keys,
      now: new Date(deps.clock.now()),
    };
    for (const step of steps) await step.run(context);
    // A mutant without the signature step has no verified payload; the real list always has one.
    return kept(context.verified ?? context.unverified ?? {}, tenantId);
  };
}
