# ADR-0122: Certificate lifetime and renewal

Samenvatting (NL): Het certificaat is RSA 2048 en 360 dagen geldig; vernieuwen gaat via de herstelstroom, zelfvernieuwing komt in Fase D en banners verschijnen bij 60 en 14 dagen.

## Status

Adjusted. A check against Microsoft Learn or the brief changed part of it and the replacement is stated in the decision.

Source: spec section 9 (assumption B-22); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Changed against the brief's silence on lifetime: Learn caps a credential at one year from its start date; `addKey` needs proof of possession of a valid key (research §2.4); RSA size U20

## Decision

The certificate is RSA 2048 with 360 days validity; renewal in Phase B is the repair flow (full-list `PATCH`); self-rotation by `addKey` is Phase D; banners at 60 and 14 days (B-22).

## Consequences

Implemented by FR-B-106, FR-B-111, FR-B-220, ODB-08. Still open: U20 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-22, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-106, FR-B-111, FR-B-220, ODB-08" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U20. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
