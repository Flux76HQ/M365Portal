# Chunk s7a: S7 CI workflows, T-A-250 to T-A-255

Date: 2026-10-11. No workflow has run on GitHub; GitHub Actions, QEMU/arm64, cosign, attestations, GHCR, Trivy and `playwright install` cannot run in this environment. Verification is static: `python -m unittest scripts/test_workflows.py` (53 tests, 2 skipped on purpose), `bash -n` on every `run:` block, balanced `${{ }}`. actionlint was not run (T-A-260 downloads it).

## Tasks
- T-A-250 `scripts/resolve_action_pins.py` + `scripts/test_resolve_action_pins.py` (13 tests). `git ls-remote --tags` works through the proxy, so all 14 actions were re-resolved on 2026-10-11 and equal the table of plan 12.3; SHA pinning is done, not an open point.
- T-A-251 `scripts/test_workflows.py` written first (red: workflows missing), then green; 34 negative fixtures (floating tag, renamed job/step, reorder, workflow-level write, wrong-job write, publish on pull_request, ungated version tag, tag overwrite, unconditional cosign, Trivy settings, ignore entry without reason/expiry, step without remediation, literal cancel-in-progress, ...).
- T-A-252/253 `.github/workflows/ci.yml` jobs `quality`, `e2e`. T-A-254/255 `.github/workflows/image.yml` jobs `image`, `publish`.

## Decisions and assumptions
- Appendix C step names are a required ordered subsequence; extra steps added: image job `Enable corepack/Setup Node/Install (frozen lockfile)` (image-smoke is a tsx script), `Design token freshness` (`pnpm tokens:check`), `Install PyYAML` (test_workflows imports yaml; `PyYAML==6.0.1`), and `<check> hint` steps after Trivy action steps (an action cannot print a remediation itself).
- "Schema snapshot check" = `pnpm schema:snapshot` + `git diff --exit-code apps/server/schema-snapshots/`; "Schema drift check" = `pnpm schema:check`. Unit step sets `REQUIRE_DOCKER=1` (T-A-232).
- Image labels: revision and created are passed as `labels:`; the metadata-action labels are NOT used (its version label would be `latest`). Build arg `VERSION` only. The Dockerfile (S6b) must set the `version` label from `ARG VERSION`.
- Concurrency: pull-request runs cancel superseded ones; push/dispatch runs get a `run_id` group so a newer merge never replaces a pending publish (VERSION would be skipped). Risk: two quick merges can finish out of order and move `latest` backwards.
- `publish` condition: `github.ref == 'refs/heads/main' && (push || workflow_dispatch)`; `needs: image`.
- Release gate: `matching-refs` API (never 404) in "Decide release tag", POST `git/refs` in "Create release tag", version tag `enable=` only from `steps.release_tag.outputs.created == 'true'`; test forbids force/patch/delete wording in the tag steps.
- Cosign steps conditioned on `github.event.repository.private == false`.
- Trivy ignore format defined by the test: a `# reason` comment above the entry and `exp:YYYY-MM-DD` on it in `.trivyignore`; UNVERIFIED against Trivy docs (no entry exists; verify at first entry).
- Artefact paths `e2e/playwright-report/`, `e2e/test-results/`, `e2e/lighthouse/results/` are assumed (S9 owns the outputs; missing paths are ignored).
- `scripts/image-smoke.ts`, `check_image_*.py` are called with default image `m365portal:local`; no smoke env var was invented.

## Pending / for others
- `test_workflows.py` skips codeql checks until `codeql.yml` exists (T-A-256) and skips pin checks of the two governance workflows until they are re-pinned (T-A-257, they still use `actions/checkout@v4`). The owners delete `CODEQL_PENDING` and `GOVERNANCE_REPIN_PENDING`.
- Not done: T-A-256 onward.

## First-run risks (PR-12)
cosign 3.x flags, multi-arch digest output, `push-to-registry`, CycloneDX predicate type `https://cyclonedx.org/bom` in `gh attestation verify` (UNVERIFIED), Trivy DB download and scan of a GHCR digest, QEMU arm64 smoke (`continue-on-error`), actionlint download script checksum, `--verify-tag` in `gh release create`, whether attest actions need extra permissions (e.g. artifact metadata) UNVERIFIED, Trivy secret scan on repo fixtures.
