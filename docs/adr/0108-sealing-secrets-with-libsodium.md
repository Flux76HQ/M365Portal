# ADR-0108: Sealing secrets with libsodium

Samenvatting (NL): Libsodium XChaCha20-Poly1305 versleutelt de certificaatsleutel; de sleutel komt uit APP_KEY of APP_KEY_FILE en het bootstraptoken blijft in het geheugen.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-08); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept, with a derived per-purpose subkey, a key id and additional data that binds blob to row, purpose and key

## Decision

Libsodium XChaCha20-Poly1305 seals the certificate key; the key comes from `APP_KEY` or `APP_KEY_FILE`; a rotation procedure exists; the bootstrap token lives in memory only (B-08).

## Consequences

Implemented by FR-B-104 to FR-B-110, FR-B-215. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-08, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-104 to FR-B-110, FR-B-215" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
