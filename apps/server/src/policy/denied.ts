// A denial that a handler raises after it has looked at the data (FR-B-509, FR-B-510; T-B-249). The
// wrapper's own guards refuse on the declaration of a route (permission, kind, step-up) before the
// handler runs; some refusals can only be decided with the rows in hand: the caller may not hand out
// this role (`escalation_denied`), or the change would leave the panel without an Owner
// (`last_owner_protected`). The handler (or the service under it) throws this error; the route
// wrapper audits it as a denial under the route id, with the reason as `reason_code`, before the
// answer leaves, and answers with the problem of the same code (403 and 409).
export const POLICY_DENIAL_REASONS = Object.freeze([
  'escalation_denied',
  'last_owner_protected',
] as const);

export type PolicyDenialReason = (typeof POLICY_DENIAL_REASONS)[number];

export class PolicyDenied extends Error {
  readonly reason: PolicyDenialReason;

  constructor(reason: PolicyDenialReason) {
    super(`denied: ${reason}`);
    this.name = 'PolicyDenied';
    this.reason = reason;
  }
}
