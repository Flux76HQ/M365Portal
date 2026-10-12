# ADR-0104: Wizard user and delegated scopes

Samenvatting (NL): De wizardgebruiker is Global Administrator, of Privileged Role Administrator plus een rol voor appregistratie; de wizard vraagt precies drie scopes.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-04); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. Three scopes cover every call; the brief's fourth (`Directory.Read.All`) is needed by none (8.3)

## Decision

Wizard user is Global Administrator, or Privileged Role Administrator plus an app-registration role; the wizard asks exactly the scopes its calls need (B-04).

## Consequences

Implemented by FR-B-214, BCB-04. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-04, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-214, BCB-04" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
