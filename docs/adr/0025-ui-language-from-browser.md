# ADR-0025: UI language from the browser, switchable, stored per browser (D25)

Samenvatting (NL): De UI-taal komt uit de browser (nl of en), is wisselbaar en wordt per browser bewaard.

## Status

Accepted

Source: plan section 6.1, row D25.

## Context

There are no user accounts in Phase A, so a language preference cannot live on the server, and a cookie would add a consent and size cost.

## Decision

The language is detected from the browser (nl or en), switchable, stored in `localStorage` under `m365portal.locale`; no cookie (A-56). Branding data (organisation name) is not translated.

## Consequences

The preference does not follow the person to another browser. All access to storage goes through `lib/storage.ts`.

## Evidence

- Plan 6.1 row D25; spec FR-A-113.
- `apps/web/src/lib/storage.ts` has the key `m365portal.locale`; `locale-detection.test.ts` and `storage.test.ts` exist.
