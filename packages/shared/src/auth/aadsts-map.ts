// One table from a Microsoft error to a canonical reason (FR-B-217, TB-05; baseline section 10).
// The wizard's result codes (T-B-131) and the sign-in error codes (T-B-180) are projections of
// `AadstsReason`: this file decides what Microsoft's error means, the two callers decide what the
// product says about it. Microsoft's free text is never read beyond the leading number, never kept
// and never shown; only the number and a reason from this closed list leave the module.
//
// Documented codes, each re-read on Microsoft Learn on 2026-10-11:
//   65001   not consented       https://learn.microsoft.com/troubleshoot/entra/entra-id/app-integration/troubleshoot-consent-issues
//   90093   policy or role stops the user from granting; 90094 only an admin can grant
//                               https://learn.microsoft.com/entra/identity/enterprise-apps/application-sign-in-unexpected-user-consent-error
//   50105   assignment required https://learn.microsoft.com/troubleshoot/entra/entra-id/app-integration/error-code-aadsts50105-user-not-assigned-role
//   53003   BlockedByConditionalAccess
//                               https://learn.microsoft.com/entra/identity/conditional-access/troubleshoot-conditional-access
//   530036  refresh token invalid due to authentication-flow checks
//                               https://learn.microsoft.com/entra/identity/conditional-access/concept-authentication-flows
//   700027  client assertion has an invalid signature
//                               https://learn.microsoft.com/entra/msal/javascript/node/certificate-credentials
// The error strings are OAuth 2.0 / OIDC error codes of the token and authorize endpoints.

export const AADSTS_REASONS = Object.freeze([
  'consent_required',
  'admin_approval_required',
  'assignment_required',
  'conditional_access_blocked',
  'refresh_token_invalid',
  'client_assertion_invalid',
  'invalid_client',
  'interaction_required',
  'temporarily_unavailable',
  'unknown',
] as const);
export type AadstsReason = (typeof AADSTS_REASONS)[number];

/** Documented AADSTS numbers. `AADSTS90094` and `AADSTS90093` are both "an administrator must act". */
export const AADSTS_NUMBER_REASONS: Readonly<Record<number, AadstsReason>> = Object.freeze({
  65001: 'consent_required',
  90094: 'admin_approval_required',
  90093: 'admin_approval_required',
  50105: 'assignment_required',
  53003: 'conditional_access_blocked',
  530036: 'refresh_token_invalid',
  700027: 'client_assertion_invalid',
});

/** OAuth error strings of the token and authorize endpoints that FR-B-217 names. */
export const OAUTH_ERROR_REASONS: Readonly<Record<string, AadstsReason>> = Object.freeze({
  invalid_client: 'invalid_client',
  interaction_required: 'interaction_required',
  consent_required: 'consent_required',
  temporarily_unavailable: 'temporarily_unavailable',
});

// Anchored at the start, four to seven digits, and not followed by another digit (a longer run is
// not an AADSTS number and must not be cut into one). A second code inside the text is never read.
const AADSTS_AT_START = /^AADSTS(\d{4,7})(?!\d)/;
const ERROR_STRING = /^[a-z_]{1,64}$/;

/** The number of the code an `error_description` starts with, or `null`. Nothing else is read. */
export function extractAadsts(errorDescription: unknown): number | null {
  if (typeof errorDescription !== 'string') return null;
  const match = AADSTS_AT_START.exec(errorDescription.slice(0, 16));
  return match?.[1] === undefined ? null : Number(match[1]);
}

export interface MappedMicrosoftError {
  reason: AadstsReason;
  /** The AADSTS number when the description started with one, even for an unknown number. */
  aadsts: number | null;
}

/**
 * Maps `error` and `error_description` of a token or authorize response. A documented number wins
 * over the generic error string; an unknown number with a known string takes the string; the rest
 * is `unknown`. The result holds a reason and a number, never text from Microsoft.
 */
export function mapMicrosoftError(input: {
  error?: unknown;
  errorDescription?: unknown;
}): MappedMicrosoftError {
  const aadsts = extractAadsts(input.errorDescription);
  if (aadsts !== null && Object.hasOwn(AADSTS_NUMBER_REASONS, aadsts)) {
    const byNumber = AADSTS_NUMBER_REASONS[aadsts];
    if (byNumber !== undefined) return { reason: byNumber, aadsts };
  }
  const error = input.error;
  if (
    typeof error === 'string' &&
    ERROR_STRING.test(error) &&
    Object.hasOwn(OAUTH_ERROR_REASONS, error)
  ) {
    const byString = OAUTH_ERROR_REASONS[error];
    if (byString !== undefined) return { reason: byString, aadsts };
  }
  return { reason: 'unknown', aadsts };
}
