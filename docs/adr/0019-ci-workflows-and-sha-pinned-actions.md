# ADR-0019: CI workflows with every third-party action pinned by commit SHA (D19)

Samenvatting (NL): CI-workflows waarin elke externe action op commit-SHA is vastgezet.

## Status

Adjusted

Source: plan section 6.1, row D19.

## Context

The decision brief assumed that action commit SHAs cannot be looked up, so it allowed tag pins. They can be looked up (V-07 to V-09), and a tag can move (SA-01).

## Decision

`ci.yml` (`quality`, `e2e`), `image.yml` (`image`, `publish`), `codeql.yml` (`analyze`), `dependabot.yml` and a secret scan; the two existing governance jobs keep their names. **Third-party actions are pinned by commit SHA** with a `# vX.Y.Z` comment; the two governance workflows are re-pinned too (TA-10). `publish` runs on push to `main` and on manual dispatch (ADR-0046 for the release tag).

## Consequences

Dependabot raises the SHA bumps. cosign signing happens only on public repositories (PD-20).

## Evidence

- Plan 6.1 row D19; V-07, V-08, V-09; SA-01, SA-07, SA-09.
- `G7.md`: 14 actions resolved on 2026-10-11, `py/test_workflows.py` 64 tests with 42 negative fixtures, actionlint 1.7.12 clean on 7 workflow files.
- **No workflow has run on GitHub** (`G7.md` section 1): the first run is a risk (PR-12), not a fact.
