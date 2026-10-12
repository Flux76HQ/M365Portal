// The MFA claim check (FR-B-405, shared half; B-06). One implementation: the callback, the step-up
// callback and the session record all use these functions (baseline section 10).
//
// Entra emits `mfa` (and `multipleauthn`) only when the user completed multi-factor authentication
// and lists, per method, the `amr` values in "AMR values for Microsoft Entra authentication
// methods": https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
// `amr` is an optional claim of v2.0 ID tokens: it is present only when the app registration asks
// for it (FR-B-303), so an absent claim means "not satisfied", never "satisfied".
//
// The check never allow-lists the whole value set, never looks at `amr[0]` and never treats `pwd`,
// `wia` or `x509` alone as MFA: it asks whether the array holds one value the caller accepts.

export const DEFAULT_ACCEPTED_AMR: readonly string[] = Object.freeze(['mfa', 'multipleauthn']);

/** A token's list is cut here before it is judged or stored (plan 8.6.5 step 12). */
export const AMR_MAX_ENTRIES = 16;
/** A value longer than this is dropped; Entra's values are short method codes. */
export const AMR_MAX_VALUE_LENGTH = 32;

export type AmrVerdict = 'ok' | 'amr_missing' | 'mfa_required';

/**
 * The part of the claim that is kept: the first `AMR_MAX_ENTRIES` members, of which only strings of
 * at most `AMR_MAX_VALUE_LENGTH` characters survive. `null` when the claim is not an array.
 */
export function truncateAmr(claim: unknown): string[] | null {
  if (!Array.isArray(claim)) return null;
  const members: unknown[] = claim.slice(0, AMR_MAX_ENTRIES);
  return members.filter(
    (member): member is string =>
      typeof member === 'string' && member.length <= AMR_MAX_VALUE_LENGTH,
  );
}

/**
 * `ok` when the claim is an array holding at least one accepted value (exact, case-sensitive);
 * `amr_missing` when it is absent or not an array; `mfa_required` otherwise. An empty accepted set
 * accepts nothing.
 */
export function evaluateAmr(
  claim: unknown,
  accepted: readonly string[] = DEFAULT_ACCEPTED_AMR,
): AmrVerdict {
  const values = truncateAmr(claim);
  if (values === null) return 'amr_missing';
  const acceptable = new Set(accepted);
  return values.some((value) => acceptable.has(value)) ? 'ok' : 'mfa_required';
}
