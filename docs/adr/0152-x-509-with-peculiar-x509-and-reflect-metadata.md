# ADR-0152: X.509 with @peculiar/x509 and reflect-metadata

Samenvatting (NL): X.509 via @peculiar/x509 2.1.0 en reflect-metadata 0.2.2, lui geladen, met een DER-encoder van 120 regels als terugval.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-02.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B02, V-B03.

## Decision

X.509: `@peculiar/x509` 2.1.0 + `reflect-metadata` 0.2.2, lazy; fallback a 120-line DER encoder (PB-02).

## Consequences

One-file swap behind `CertificateFactory`; revisit on an advisory.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-02, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.
