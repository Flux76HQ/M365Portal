# ADR-0011: Actor and authorize(), with an anonymous and a preview-mode resolver (D11)

Samenvatting (NL): Een Actor en authorize() met twee resolvers: anoniem en (alleen met PREVIEW_MODE) preview.

## Status

Accepted, with changes

Source: plan section 6.1, row D11.

## Context

Phase A has no login, yet every route must go through the policy layer, deny by default, so that Phase B replaces a resolver and not the routes.

## Decision

An `Actor` interface and `authorize()` with exactly two resolvers: anonymous, and preview only with `PREVIEW_MODE=true`. The remote guard A-30 refuses a preview start that is not on loopback unless `PREVIEW_MODE_ALLOW_REMOTE` is set; per request, a non-loopback `Host` or any forwarding header makes the actor anonymous (FR-A-036, SA-15). A loud warning and a permanent banner accompany preview mode. Preview mode is removed or replaced in Phase B (OD-03).

## Consequences

Preview mode is unauthenticated administration. The loopback rule prevents accidental exposure and is not a security boundary: the boundary is publishing the port on loopback only.

## Evidence

- Plan 6.1 row D11; spec FR-A-030 to FR-A-036.
- `G5.md`: the Appearance page works in real Chromium with `PREVIEW_MODE` on a loopback origin; `preview-mode.test.ts` and `e2e/tests/preview-banner.spec.ts` exist.
