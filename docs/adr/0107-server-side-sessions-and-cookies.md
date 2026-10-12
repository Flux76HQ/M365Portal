# ADR-0107: Server-side sessions and cookies

Samenvatting (NL): Sessies staan op de server, gehasht in SQLite; het cookie heet alleen op https __Host- en het OIDC-transactiecookie is Lax.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-07); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept, with two consequences: `response_mode=query` (a `form_post` callback is a cross-site POST that a Lax cookie does not accompany) and a 200 interstitial instead of a 303 after the callback so the Strict cookie reaches the first paint (U39). Phase A BC-03 already accepts the plain names on `localhost`

## Decision

Sessions are server-side, hashed, in SQLite, with rotation, idle and absolute timeouts, sign-out everywhere and session-bound CSRF; the cookie is `__Host-` only on https, plain `HttpOnly`/`SameSite=Strict` on `http://localhost`; the OIDC transaction cookie is `Lax` (B-07).

## Consequences

Implemented by FR-B-401, FR-B-407, FR-B-408, FR-B-412. Still open: U39 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-07, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-401, FR-B-407, FR-B-408, FR-B-412" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U39. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).
