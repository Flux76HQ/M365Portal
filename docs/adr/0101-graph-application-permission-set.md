# ADR-0101: Graph application permission set

Samenvatting (NL): De Graph-applicatierechten zijn de verkleinde vier: User.Read.All, GroupMember.Read.All, GroupMember.ReadWrite.All en Organization.Read.All.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-01); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. Learn lists `GroupMember.Read.All` for `checkMemberGroups` on users, Get group and List groups, and `User.Read.All` for `transitiveMemberOf`; no call was found that needs `Group.Read.All` or `Directory.Read.All` (8.1, 8.2). Open: U36, U37. Delta against the brief's five in 8.2

## Decision

Graph permission set: start from `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; add `Group.Read.All` or `Directory.Read.All` only if provably needed; never `RoleManagement.ReadWrite.Directory` for the runtime application (B-01).

## Consequences

Implemented by FR-B-301, FR-B-311. Still open: U36, U37 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-01, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-301, FR-B-311" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U36, U37. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
