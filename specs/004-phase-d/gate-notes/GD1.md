# Gate note GD1: step D1 (Exchange layer, distribution lists, contacts, group members)

Verdict: **D1 is built and passes every local check that can run in the sandbox; CI on the pull request is the next evidence.** Nothing against a real tenant has run (owner ledger OV-D1, OV-D2, OV-D4, OV-D5). The Ubuntu image has not been built (no Docker daemon), so its size and start time are unmeasured.

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf` after the D1 commits (contract `0d4c0e8`, web `eafa557`, server `823dc6d` and `44287d2`, docs `7450331`, credential source `84bbd2c`, docs touch-up `5293116`, e2e and two small fixes in the closing commit), `VERSION` 0.3.6x.

| Command | Result |
|---|---|
| `pnpm --filter @m365portal/shared lint typecheck test`, `pnpm i18n:check` | green (GD1-0.md) |
| `pnpm --filter @m365portal/server lint typecheck test` | green: 238 files, 9,199 tests (GD1-server-b.md, credential source report) |
| `pnpm --filter @m365portal/web lint`, `tsc --noEmit`, `test` | green: 80 files, 1,996 tests |
| `pnpm test:tools` | green: 1,118 tests |
| `python3 -m unittest discover -s scripts` | 245 OK |
| `pnpm bundle:check` with `BUNDLE_BUDGET_BASE_REF=origin/main` | within budget (JS 247,411 B, CSS 47,182 B, Brotli 278,789 B) with the owner-approved Phase D growth (+2,048 B JS, +3,072 B Brotli) |
| e2e on `desktop-light`: distribution-lists 16, contacts 19, group-members 12, bestuur 6, pages 27, nav-gating 31 | green (GD1-e2e.md) |
| e2e a11y on the four a11y projects | zero violations on every new state |
| e2e keyboard 6, responsive 62 | green |

## Not run, and why

- Docker build, image size, image smoke test: no daemon in the sandbox. CI measures them; the owner sets the size ceiling (ADR-0180, ODD-10).
- Real `pwsh` and `Connect-ExchangeOnline` (U75): no `pwsh` here. `real-pwsh.test.ts` is written and skipped.
- The 13 new visual specs per project: baselines come only from the CI runner artefact.
- e2e on `ultrawide`, `storage-blocked`, `forced-colors`, `reduced-motion` and the Phase B wizard states: CI runs them.

## Deployment-file changes

Dockerfile (Ubuntu 24.04 runtime with PowerShell 7.6.6 and ExchangeOnlineManagement 3.10.1), `.github/workflows/image.yml` (worker ping in the arm64 smoke step), `docker-compose.yml` and `.env.example` (`EXCHANGE_KEY_HANDOVER`). Owner-approved bundle growth in `scripts/bundle-budget.json`.

## Closing fixes in this commit

- The contact delete dialog leaves the detail page before it refreshes the contact queries (the deleted contact was asked for twice and answered 404).
- The Groups page description no longer says that nothing can be changed.

## Open for the next step

D2 flips the export check of `bestuur.spec.ts` from 404 to 403 (P55 arrives), decides the class of P46 (a POST rated `read` is refused by the route table), and adds the audit screen. Dynamic distribution lists show no members (FD-05); lists over about 2,500 members are unreadable (FD-07).

## After CI (addendum, 2026-10-13)

CI has since built and measured the image (amd64, run 38394173673). The container smoke test passed 33 of 34 checks; only the size check failed, against the old ceiling of 400 MB. This note's "Not run" entry for the Docker build, the image size and the image smoke test is therefore answered for amd64:

| Measured in CI (amd64) | Value |
|---|---|
| Image size | 538.2 MB |
| `/readyz` | 200 after 1,184 ms |
| Exchange worker ping, inside the restricted container | 1,473 ms (module 3.10.1, PowerShell 7.6.6) |
| Resident memory | 148 MB idle; 173 MB peak during two concurrent largest uploads |
| `docker stop` | exit 0 in 152 ms |

Owner decision of 2026-10-13 (ODD-10): the image size ceiling becomes **600 MB** (was 400 MB). `LIMITS.imageSizeCeilingMegabytes`, `scripts/check_image_size.py` and their tests were changed to 600; the documents were updated (README, `docs/operations.md`, ADR-0180, `docs/owner-test-phase-d1.md`, the phase report, `docs/open-points.md`). Still not measured: arm64, and the memory of a long-running worker (U84). Real `pwsh` against a tenant (U75) is unchanged and still open.
