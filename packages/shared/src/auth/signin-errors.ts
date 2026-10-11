// The sign-in code registry (tasks T-B-180, CB12, TB-13; spec 6.9.5 "Sign-in error codes",
// contract 9.2, Appendix C, plan 8.6.5 and 10.10).
//
// `/signin?error=<code>` accepts only the allow-list below; any other value renders `signin_failed`.
// `/no-access?reason=<reason>&ref=<request id>` accepts `no_role` and `graph_unavailable`; any other
// reason renders `no_role`, and `ref` is shown only when it looks like a request id. The `check`
// and `reason` values of the audit entries `auth.signin` and `auth.stepup` come from the lists here
// and are never shown to the user.
//
// The sign-in codes that name a Microsoft error are a projection of `aadsts-map.ts` (TB-05): that
// file decides what the error means, this one decides what the sign-in page says.
//
// FROZEN at gate GB1 (TB-13). The catalogue text is S-B6's (`signin` and `noaccess` fragments).
import { RequestIdSchema } from '../schemas/common.js';
import { mapMicrosoftError, type AadstsReason } from './aadsts-map.js';

/** The sign-in error codes of spec 6.9.5, in the order of the table. */
export const SIGNIN_ERROR_CODES = Object.freeze([
  'signin_failed',
  'cookies_missing_or_expired',
  'access_denied',
  'interaction_required',
  'consent_required',
  'admin_approval_required',
  'assignment_required',
  'conditional_access_blocked',
  'temporarily_unavailable',
  'mfa_required',
  'amr_missing',
  'stepup_failed',
  'secrets_unavailable',
  'setup_required',
  'session_expired',
] as const);
export type SigninErrorCode = (typeof SIGNIN_ERROR_CODES)[number];

/** What the page falls back to for a value outside the allow-list. */
export const SIGNIN_ERROR_FALLBACK: SigninErrorCode = 'signin_failed';

export function isSigninErrorCode(value: unknown): value is SigninErrorCode {
  return typeof value === 'string' && (SIGNIN_ERROR_CODES as readonly string[]).includes(value);
}

/** The code to render for a query value: the value when it is on the allow-list, else `signin_failed`. */
export function resolveSigninError(value: unknown): SigninErrorCode {
  return isSigninErrorCode(value) ? value : SIGNIN_ERROR_FALLBACK;
}

/**
 * Whether the failure is written to the audit trail (the "Audited" column): `never` (before the ID
 * token is validated the request is unauthenticated and attacker-reachable, B-24), `always`, or
 * `from_validation` (only a failure from step 7 of FR-B-403 on).
 */
export const SIGNIN_ERROR_AUDIT = Object.freeze({
  signin_failed: 'from_validation',
  cookies_missing_or_expired: 'never',
  access_denied: 'never',
  interaction_required: 'never',
  consent_required: 'never',
  admin_approval_required: 'never',
  assignment_required: 'never',
  conditional_access_blocked: 'never',
  temporarily_unavailable: 'never',
  mfa_required: 'always',
  amr_missing: 'always',
  stepup_failed: 'always',
  secrets_unavailable: 'never',
  setup_required: 'never',
  session_expired: 'never',
} as const satisfies Record<SigninErrorCode, 'never' | 'always' | 'from_validation'>);

/**
 * The codes next to which an administrator is shown the tenant-wide consent link (FR-B-419). The
 * link is built from the pinned tenant and the registered callback URI (T-B-188).
 */
export const SIGNIN_CONSENT_LINK_CODES = Object.freeze([
  'consent_required',
  'admin_approval_required',
] as const);

/** Catalogue key of the message of a sign-in code. */
export function signinErrorMessageKey(code: SigninErrorCode): string {
  return `signin.error.${code}`;
}

/** Catalogue key of the remedy of a sign-in code. */
export function signinErrorRemedyKey(code: SigninErrorCode): string {
  return `signin.remedy.${code}`;
}

/**
 * Projection of the shared `AADSTS` table: the sign-in code for each reason. The reasons that must
 * not say which check failed (a rejected client assertion, a refused refresh token, anything
 * unknown) are `signin_failed`; the others keep the distinct message FR-B-217 asks for.
 */
export const SIGNIN_CODE_FOR_REASON = Object.freeze({
  consent_required: 'consent_required',
  admin_approval_required: 'admin_approval_required',
  assignment_required: 'assignment_required',
  conditional_access_blocked: 'conditional_access_blocked',
  refresh_token_invalid: 'signin_failed',
  client_assertion_invalid: 'signin_failed',
  invalid_client: 'signin_failed',
  interaction_required: 'interaction_required',
  temporarily_unavailable: 'temporarily_unavailable',
  unknown: 'signin_failed',
} as const satisfies Record<AadstsReason, SigninErrorCode>);

/**
 * The sign-in code for the `error` and `error_description` of an Entra callback (FR-B-403 step 5,
 * F-34 to F-38). A documented `AADSTS` number or error string wins; `access_denied` is the one
 * other error string the page names; everything else is `signin_failed`. The description is read
 * only for its leading number and is never part of the result.
 */
export function signinCodeForMicrosoftError(input: {
  error?: unknown;
  errorDescription?: unknown;
}): SigninErrorCode {
  const { reason } = mapMicrosoftError(input);
  if (reason !== 'unknown') return SIGNIN_CODE_FOR_REASON[reason];
  return input.error === 'access_denied' ? 'access_denied' : SIGNIN_ERROR_FALLBACK;
}

/** The reasons of `/no-access?reason=` (spec 6.9.5, contract 9.2). */
export const NO_ACCESS_REASONS = Object.freeze(['no_role', 'graph_unavailable'] as const);
export type NoAccessReason = (typeof NO_ACCESS_REASONS)[number];

export function isNoAccessReason(value: unknown): value is NoAccessReason {
  return typeof value === 'string' && (NO_ACCESS_REASONS as readonly string[]).includes(value);
}

/** The reason to render: the value when valid, else `no_role`. */
export function resolveNoAccessReason(value: unknown): NoAccessReason {
  return isNoAccessReason(value) ? value : 'no_role';
}

/** The reference id to show: the value when it is a request id (8 to 64 letters, digits, hyphens), else `null`. */
export function resolveNoAccessRef(value: unknown): string | null {
  const parsed = RequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Catalogue key of the explanation of a no-access reason. */
export function noAccessMessageKey(reason: NoAccessReason): string {
  return `noaccess.reason.${reason}`;
}

/**
 * The `check` values of `auth.signin` denials from ID-token validation on, in the order of
 * Appendix C (the validator of plan 8.6.5 raises them). The user never sees them.
 */
export const SIGNIN_CHECKS = Object.freeze([
  'format',
  'size',
  'header',
  'alg',
  'kid',
  'signature',
  'issuer',
  'tenant',
  'audience',
  'nonce',
  'expired',
  'not_before',
  'issued_at',
  'version',
  'oid',
] as const);
export type SigninCheck = (typeof SIGNIN_CHECKS)[number];

/**
 * The `check` values of the step-up callback beyond `SIGNIN_CHECKS` (FR-B-411): another `oid`, no
 * `auth_time` claim, an `auth_time` earlier than the transaction start minus 60 s. A missing MFA
 * claim is reported as the reasons `mfa_required` and `amr_missing`, not as a check.
 */
export const STEPUP_CHECKS = Object.freeze([
  'oid_mismatch',
  'auth_time_missing',
  'auth_time_stale',
] as const);
export type StepupCheck = (typeof STEPUP_CHECKS)[number];

/**
 * The `reason` values of `auth.signin` and `auth.stepup` denials (Appendix C, "Audit" column):
 * `token_invalid` (an ID-token check failed; `check` says which), `keys_unavailable` (F-27),
 * `mfa_required` and `amr_missing` (FR-B-405), `no_role` and `graph_unavailable` (F-44) and
 * `stepup_failed` (a step-up check failed; `check` says which).
 */
export const SIGNIN_AUDIT_REASONS = Object.freeze([
  'token_invalid',
  'keys_unavailable',
  'mfa_required',
  'amr_missing',
  'no_role',
  'graph_unavailable',
  'stepup_failed',
] as const);
export type SigninAuditReason = (typeof SIGNIN_AUDIT_REASONS)[number];
