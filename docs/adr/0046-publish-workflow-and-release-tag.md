# ADR-0046: Publish workflow: release tag, channel tags, keyless signing on public repositories (PD-20)

Samenvatting (NL): Publish-workflow: releasetag v<VERSION>, kanaaltags en cosign alleen op publieke repositories.

## Status

Plan

Source: plan section 6.2, row PD-20.

## Context

V-07 to V-09. A tag created with `GITHUB_TOKEN` does not start other workflows (GitHub-documented behaviour, not re-read here), so tag-triggered publishing would never fire.

## Decision

Triggers: push to `main` and `workflow_dispatch`. The step "Create release tag" calls the Git refs API for `v<VERSION>` and records whether it created it; the version image tag is enabled only in the run that created the tag (never onto an existing tag, baseline 12.4). Channel tags `latest` and `sha-<short>` always move. The digest is signed with cosign keyless only when the repository is public. Provenance and SBOM are GitHub artifact attestations (`attest-build-provenance`, `attest-sbom`); the SBOM is CycloneDX from Trivy. All third-party actions are pinned by commit SHA.

## Consequences

Claims SLSA v1.0 Build Level 2 at most (V-09). cosign 3.x CLI syntax and the multi-arch index digest flow are UNVERIFIED until the first run (PR-12). SA-07, SA-09.

## Evidence

- Plan 6.2 row PD-20.
- `G7.md`: `image.yml` and its tests are static checks only (64 workflow tests, actionlint clean). **Nothing here has run on GitHub**; cosign, attestations, GHCR push, Trivy and the arm64 smoke are first-run risks.
