# ADR-0111: RBAC foundation: five roles, a template and scopes

Samenvatting (NL): RBAC heeft vijf vaste rollen, het sjabloon Bestuur als data, de vereniging van toewijzingen, scopes per resourcetype en standaard weigeren.

## Status

Accepted. The default stands, clarified by the spec.

Source: spec section 9 (assumption B-11); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Clarified. The brief does not say what a scope restricts when a role mixes resource types. Scopes restrict per resource type; permissions without a resource type (settings, audit, RBAC) come only from unscoped assignments; `users:read` has the qualifier `basic` so *Bestuur* can read names and e-mail (BCB-09, BCB-10)

## Decision

RBAC: the 15-permission catalogue is unchanged; five immutable built-in roles; *Bestuur* as template data; effective permissions are the union of assignments; scopes; default deny (B-11).

## Consequences

Implemented by 6.5, FR-B-501 to FR-B-513. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-11, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "6.5, FR-B-501 to FR-B-513" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
