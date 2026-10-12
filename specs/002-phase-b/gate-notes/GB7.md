# Gate note GB7 (T-B-419): e2e, deploy files and image

Verdict: **pending CI**. Deploy files, workflow tests and the bundle budget pass locally. The e2e suite, the visual baselines, Lighthouse and the image smoke test were **not** run to a green result in this sandbox by this note; the CI run on the pull request is in progress and the visual baselines are copied in from its artefact later (no PNG baseline was generated here). The gate must not be called passed before CI is green.

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, HEAD `e27ddf5`, working tree clean (`git status --short` empty), 2026-10-12, Node v22.22.0, pnpm 10.28.0. The commands were run on this tree, not on a fresh clone (`pnpm install --frozen-lockfile` on a clean copy: UNVERIFIED, CI does it).

| Command | Result | Time |
|---|---|---|
| `pnpm lint` (routes generate, eslint `--max-warnings 0`) | green | 186 s |
| `pnpm typecheck` | green | 46 s |
| `pnpm test` | green: shared 45 files / 3,532 tests; web 63 / 1,740; server 185 / 8,179; tools 15 / 1,113 (1 skipped); e2e unit 165 | 485 s |
| `pnpm build` | green | 7 s |
| `pnpm schema:check`, `routes:check`, `i18n:check`, `tokens:check` | green | 2, 2, 8, 1 s |
| `pnpm bundle:check` | within budget (initial JS 244,665 B gzip, first load 276,206 B brotli; the ratchet was skipped, no base ref) | 3 s |
| `python3 -m unittest discover -s scripts` | 223 tests OK | 4 s |
| `docker compose config -q` | exit 0 | 7 s |
| `pnpm format:check` | **red**: Prettier 3.9.10 reports 100 files (apps/web/src 39, apps/web/test 24, apps/server/test 19, packages/shared/test 7, apps/server/src 5, others 6). Not fixed here (application code); `pnpm format` is a whitespace-only fix the orchestrator must run and commit | 34 s |
| Not run in this sandbox | `pnpm e2e`, `pnpm lighthouse`, `pnpm image:smoke`, `pnpm audit`, actionlint, arm64, cosign, SLSA, CodeQL, Trivy; the "seen red once more" reruns of the negative controls (UNVERIFIED unless a line below says otherwise) | |

## Tasks (evidence)

| Task | State |
|---|---|
| T-B-350 re-read of deploy, e2e, docs | `specs/002-phase-b/phase-a-reread/deploy-docs.md` (the file name in `tasks.md` is `deploy-e2e-docs.md`) |
| T-B-351 `.env.example`, Compose secret, deploy-files test | done: `apps/server/test/deploy-files.test.ts` green; `docker compose config -q` exit 0; 14 new variables, `PREVIEW_MODE*` dropped, `secrets:` stanza with `APP_KEY_FILE=/run/secrets/app_key`, `HOST_PORT` and `PORT` (default 9300) |
| T-B-352 image content bans, T-B-353 smoke test | code and Python tests done (`scripts/test_check_image_contents.py` in the 223 green tests); `pnpm image:smoke` not run here (Docker daemon present, image not built): pending CI |
| T-B-354 Dependabot, workflow tests, bundle budget | done: `.github/dependabot.yml` (+14), `scripts/test_workflows.py`, `bundle-budget.json`; `ci.yml` unchanged |
| T-B-370 topology, T-B-371 Phase A specs migrated | harness and specs exist (`e2e/support/*`, `e2e/README.md`); the last local run record `e2e/test-results/.last-run.json` says passed (scope not recorded) |
| T-B-372 to T-B-376 Phase B specs | files exist: `setup-gate`, `setup-redirect`, `setup-lock`, `setup-wizard`, `setup-manual`, `connection`, `connection-repair`, `degraded-secrets`, `signin`, `auth-logout`, `stepup`, `session-timeout`, `break-glass`, `access`, `preview-removed`; full green in CI pending |
| T-B-377 CSP, headers, external requests; T-B-378 a11y and keyboard | `csp`, `headers`, `no-external-requests`, `a11y`, `keyboard` specs exist; green in CI pending |
| T-B-379 visual baselines | **not done**: baselines come from the CI artefact (`visual-baselines.yml`) |
| T-B-380 Lighthouse routes and authenticated measurement | harness done (`e2e/lighthouse/run.mjs`, `judge.mjs`, `topology.ts`, groups `a-public`, `b-setup`, `a-owner`); result **pending CI** (see below) |
| T-B-381 routes-coverage guard | `apps/web/test/routes-coverage.test.ts` green |
| T-B-390 to T-B-394 cross-stream controls | `no-leak.test.ts`, `logging-events.test.ts`, `audit-b-coverage.test.ts`, `security-headers.test.ts`, `openapi.test.ts`, `body-limits.test.ts`, `single-implementation.test.ts`, `layering.test.ts`, `tools/traceability/traceability.test.ts`: green |

Task boxes: T-B-370 to T-B-378 and T-B-381 are ticked on the worker reports and the local `.last-run.json` (`passed`); the CI result still decides GB7. T-B-353 (smoke test run), T-B-379 and T-B-380 stay unticked.

## Lighthouse

- Mobile `/setup` LCP measured 4.5 s in the sandbox; this misses the G4 gate (the default-instance gate is 4,114 ms, target 2.0 s) and needs CI confirmation and an **owner decision** (raise the gate, or work on the setup page).
- The `a-owner` group (signed-in pages) is **report-only**: measured and reported, never a failure (`reportOnly` in `judge.mjs`).
- Best-of-3 on the timing metrics only; spread is reported.

## Seams applied

| Seam | Files | Lines |
|---|---|---|
| XB30 | `.env.example`, `docker-compose.yml`, `deploy-files.test.ts` (`Dockerfile` unchanged) | 3 files +240 -38 |
| XB31 | `scripts/image-smoke.ts`, `check_image_contents.py`, `test_check_image_contents.py` | 3 files +525 -21 |
| XB32 | `.github/dependabot.yml`, `scripts/test_workflows.py`, `bundle-budget.json`, `bundle-budget.test.ts` (`ci.yml` unchanged) | 4 files +150 -5 |
| XB33 | `e2e/playwright.config.ts`, `fixtures.ts`, `routes.ts`, `global-teardown.ts`, `package.json`, `lighthouse/run.mjs`, `apps/web/test/routes-coverage.test.ts` and the Phase A specs | 7 listed files +341 -137 |
| XB34 | `tools/traceability/*` | 7 files +647 -6 |
| XB36 | `security-headers`, `openapi`, `body-limits` tests | 3 files +477 |
| XB23 | `repo-conventions.test.ts`, `single-implementation.test.ts` | +491 -3 |

## Pull-request statement of T-B-351 (AGENTS.md, deployment files)

New variables, all with defaults in `.env.example`: `APP_KEY` / `APP_KEY_FILE` (one required once a certificate exists), `APP_KEY_PREVIOUS` / `APP_KEY_PREVIOUS_FILE`, `SETUP_TOKEN`, `BOOTSTRAP_CLIENT_ID`, `SETUP_PROPAGATION_TIMEOUT_SECONDS`, `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS`, `GROUP_CACHE_TTL_SECONDS`, `AUTH_REQUIRE_MFA`, `AUTH_MFA_AMR_VALUES`, `BREAK_GLASS_USERNAME`, `BREAK_GLASS_PASSWORD_HASH`. Removed: `PREVIEW_MODE`, `PREVIEW_MODE_ALLOW_REMOTE` (ignored with one warning). Compose: `secrets: app_key` from `./secrets/app_key`. Existing Phase A deployments start `unconfigured`.

## Control-name changes

`e2e/tests/preview-banner.spec.ts` (tasks text) is `preview-removed.spec.ts`; FR-A-032 control name synced (commit `e27ddf5`).

## Open points, risks, UNVERIFIED

- Pending CI: e2e (all projects), visual baselines (T-B-379), Lighthouse, `image:smoke`, `pnpm audit`, actionlint, `docker build`.
- UNVERIFIED: `docker build --network host` in this sandbox; U41 (`NODE_USE_ENV_PROXY`).
- Formatting: `pnpm format:check` red (100 files), will fail CI's format step until `pnpm format` is committed.
