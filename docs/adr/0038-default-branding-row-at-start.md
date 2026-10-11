# ADR-0038: A default branding row created at start through the normal apply path (PD-12)

Samenvatting (NL): Bij de start wordt via het gewone apply-pad een standaard branding-rij gemaakt (actor system, actie branding.init).

## Status

Plan

Source: plan section 6.2, row PD-12.

## Context

The manifest and the shell must not special-case "no branding row", and icon generation must have one code path.

## Decision

A default row (revision 1, name "M365Portal", default accent, monogram icons) is created at start by the same code path as any apply, with actor `system` and audit action `branding.init`. In degraded mode (storage unusable) the server serves in-memory defaults without icons.

## Consequences

The audit chain on a fresh volume has one entry. Tests that assume an empty chain start from a helper that skips it.

## Evidence

- Plan 6.2 row PD-12.
- `G2.md` (`module.test.ts`): `branding.init` is written once, also after a second start; degraded mode gives a shell with in-memory defaults and no icon links.
- `G6.md`: `verify-audit` reported `checked: 10` after the smoke run.
