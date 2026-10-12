// The MFA gate (T-B-185, FR-B-405, EB-26, EB-27, RB-12): one decision, made by `evaluateAmr` of the
// shared package and by nothing else. The callback, the step-up callback and the session record all
// call `decideMfa`.
//
//   AUTH_REQUIRE_MFA=true (default)  the `amr` claim must be an array (else `amr_missing`: the tenant
//                                    never emits it, a registration issue) holding a value of
//                                    `AUTH_MFA_AMR_VALUES` (else `mfa_required`: MFA was not
//                                    performed). The session then records `mfa = 1` and the list.
//   AUTH_REQUIRE_MFA=false           the check is skipped and the session records `mfa = 0`.
//
// Break-glass never comes here (exempt, FR-B-522). The configured values extend or narrow the
// default set; the single-factor methods are removed from whatever is configured, as a second line
// behind the configuration check (`pwd`, `wia`, `x509`, `ngcmfa` and `otp` alone never pass: Learn
// lists them without `mfa` in several rows, https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).
import { evaluateAmr } from '@m365portal/shared/auth/amr';

/** Methods that never prove a second factor on their own. */
const SINGLE_FACTOR: ReadonlySet<string> = new Set(['pwd', 'wia', 'x509', 'ngcmfa', 'otp']);

export interface MfaPolicy {
  readonly requireMfa: boolean;
  readonly acceptedAmr: readonly string[];
}

export type MfaDecision =
  | { readonly ok: true; readonly mfa: boolean }
  | { readonly ok: false; readonly reason: 'mfa_required' | 'amr_missing' };

/** `amr` is what the validator kept of the claim: a list of strings, or `null` for an absent or malformed claim. */
export function decideMfa(amr: readonly string[] | null, policy: MfaPolicy): MfaDecision {
  if (!policy.requireMfa) return { ok: true, mfa: false };
  const accepted = policy.acceptedAmr.filter((value) => !SINGLE_FACTOR.has(value));
  const verdict = evaluateAmr(amr, accepted);
  return verdict === 'ok' ? { ok: true, mfa: true } : { ok: false, reason: verdict };
}
