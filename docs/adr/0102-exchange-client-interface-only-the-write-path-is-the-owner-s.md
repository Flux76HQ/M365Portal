# ADR-0102: Exchange client: interface only, the write path is the owner's decision

Samenvatting (NL): Voor Exchange bouwt Fase B alleen de interface, een leesadapter en de contracttests; het schrijfpad voor lijsten en contacten is een beslissing van de eigenaar (ODB-01).

## Status

Accepted. Kept from the decision brief with a change: the brief expected a write path, the research found none that is documented. The decision is updated with the owner's choice after the Phase B gate.

Source: spec section 9 (B-02), Appendix A (the owner memo), plan section 19 and 17.1 (PB-22).

## Context

The brief asked for an `ExchangeClient` with `InvokeCommand` and PowerShell as a fallback. Microsoft Learn documents no `InvokeCommand` page. The Exchange Admin API (Preview) has six POST-only endpoints and no distribution list writes and no contact cmdlets; the only documented write path is the Exchange Online PowerShell module. Options A (a `pwsh` worker in the one container on an Ubuntu LTS base), B (`pwsh` in a separate container), C (the Admin API only) and D (the undocumented endpoint) differ in image size, key handling and what acceptance criteria 3, 4, 12 and 13 can be met (spec Appendix A, plan section 19).

## Decision

Phase B ships an interface-only Exchange client: the `ExchangeClient` port has read methods only and `capabilities().write` is empty, one contract suite runs against any adapter, the Admin API read adapter is used for the verification probe (a warning, never a block, PB-22), and the runtime base image is not touched. The write path (distribution list members and mail contacts) is the owner's decision ODB-01; the recommendation is option A and it is reversible. This ADR is updated with the owner's choice after the Phase B gate, and the Phase D plan starts from that choice. With no decision, Phase D starts with acceptance criteria 3 (the list part), 4 and 12 blocked, as the memo says.

## Consequences

Phase B is unaffected by the choice, and every option plugs into the interface. The cost of option A or B that the memo did not state is the certificate private key inside the PowerShell process; Phase B's `CertificateHolder` deliberately has no method that returns the key, and Phase D would add one narrow, audited export. Planning estimates are 8 to 12 engineer-days for A, about 3 more for B and about 0 now for C. Unverified: the size of an Ubuntu base layer, PowerShell on arm64 (U26) and the narrower Exchange roles (U5, U6); the experiment OV-13 informs the choice.

## Evidence

- `specs/002-phase-b/spec.md` Appendix A and section 11 (ODB-01, ODB-03); `specs/002-phase-b/plan.md` section 19.
- `apps/server/test/exchange/exchange-client-contract.test.ts` is the contract suite that runs against every adapter; `docs-contract.test.ts` checks that this ADR records the decision and that it is updated with the owner's choice.
- Not verified: the Admin API response envelope (U45) and the production terms of the Preview (U25).
