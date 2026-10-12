# ADR-0105: Sign-in with our own authorization code client

Samenvatting (NL): Aanmelden gebruikt de autorisatiecodestroom met PKCE en een certificaat-assertion via een eigen client en jose; MSAL alleen voor apparaatcode- en applicatietokens.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-05); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. MSAL adds `offline_access`, `openid`, `profile`, `email` and caches per account (research §5.3); the panel needs no token retention and one assertion signer

## Decision

Sign-in is the authorization code flow with PKCE, `state`, `nonce`, issuer, audience and `tid` validation and a certificate assertion; implemented with our own code client and `jose`, with MSAL used only for device code and client-credentials tokens (B-05).

## Consequences

Implemented by FR-B-112, FR-B-402 to FR-B-404, FR-B-418. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-05, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-112, FR-B-402 to FR-B-404, FR-B-418" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
