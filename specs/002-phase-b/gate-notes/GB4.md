# Gate note GB4 (T-B-179): setup engine

Verdict: **ready for GB4 review (local pass)**. The wizard run against the fake tenant to `completed` is exercised by `setup/complete-on-signin.test.ts` (with `setup/support/tenant-scene.ts`) and, in a browser, by `e2e/tests/setup-wizard.spec.ts` (execution of the e2e specs: see GB7, pending CI). Everything that needs Microsoft is OV-01 to OV-06, OV-19 to OV-22.

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

## Tasks (evidence, `apps/server/test/setup/` unless stated)

| Task | Evidence |
|---|---|
| T-B-123 state machine | `state-machine.test.ts` |
| T-B-124 setup token, two CLI commands | `token.test.ts`, `cli-setup.test.ts` |
| T-B-125 unlock limiter, setup session | `unlock-rate.test.ts`, `session.test.ts` |
| T-B-126 gate, loopback guard, lock, page behaviour | `gate.test.ts`, `loopback-guard.test.ts`, `page-redirect.test.ts` |
| T-B-127 step model, live log | `step-model.test.ts`, `log.test.ts` |
| T-B-128 backoff and classification | `backoff.test.ts` |
| T-B-129 runner, lease | `concurrency.test.ts`, `idempotency.test.ts` |
| T-B-130 environment checks | `environment.test.ts` |
| T-B-131 device-code bootstrap | `device-code.test.ts`, `bootstrap-token-lifecycle.test.ts`, `aadsts-map.test.ts` |
| T-B-132 role resolution, discovery, adoption | `resolve-app-roles.test.ts`, `discovery.test.ts`, `tenant-pin.test.ts` |
| T-B-133 application and service principal | `provision-app.test.ts`, `service-principal.test.ts` |
| T-B-134 certificate | `certificate-upload.test.ts`, `certificate.test.ts`, `verify-credential.test.ts` |
| T-B-135 permissions and Exchange role | `grant-roles.test.ts`, `permission-set.test.ts`, `assign-exchange-role.test.ts`, `exchange-role.test.ts` |
| T-B-136 verification, proof list | `verify.test.ts`, `propagation-probe.test.ts` |
| T-B-137 finish | `finish.test.ts` |
| T-B-138 manual mode | `manual-mode.test.ts` |
| T-B-139 routes P10 to P26 | `routes.test.ts`, `connection/routes.test.ts` |
| T-B-140 idempotency, crash resume, replication retry | `idempotency.test.ts`, `backoff.test.ts`, `propagation-probe.test.ts` (`resume.test.ts` and `replication-retry.test.ts` of the task text do not exist as files) |
| T-B-141 completion on first Owner sign-in | `complete-on-signin.test.ts` |
| T-B-142 expiry banners and repair | `connection/cert-expiry.test.ts`, `connection/repair.test.ts` (repair is a run flavour in `setup/runner.ts` and `connection/routes.ts`; `setup/repair.ts` of the task does not exist) |
| T-B-143 setup audit coverage | `audit-setup.test.ts` |

## Decisions and facts

- The certificate for manual mode is generated on the first `GET /api/v1/setup/certificate.cer` and kept sealed.
- Certificate renewal beyond the repair run (the planned step 7, `addKey` self-rotation) is not built (Phase D, ODB-08).
- Repair is not available in manual mode.
- The lock happens at the first Owner sign-in (ODB-05); `setup-reopen --confirm` is the way back.
- The `x5t` fallback of the assertion is a constant switched by a one-line change after OV-04.
- The bootstrap-lifetime negative (`bootstrap-token-lifecycle.test.ts`) exists only as a **mutation run** (the code was broken once and the test seen red), not as a standing negative test: UNVERIFIED as a regression control.

## Frozen interfaces

CB12 setup half and CB13: setup state names, step and sub-action registry, result codes, `completeSetupInTx`, the `Runner` and `RunContext`, tenant pin.

## Seams applied

| Seam | Files | Lines |
|---|---|---|
| XB13 | `apps/server/src/cli.ts` (`setup-token`, `setup-reopen`) | +76 -3 (counted at GB1) |
| XB20 | `http/spa-fallback.ts`, `test/static.test.ts` (303 to `/setup`, 404 after completion) | 2 files +70 -4 |

## Open points, assumptions, risks, UNVERIFIED

- U18 (`uniqueName`, unused), U19 (credential lifetime policy), U22 (`slow_down`; default interval 5 s, `expires_in` 900 observed), U31 and U32 (duplicate grants, error codes of create-then-use chains), U34 (closed: the image smoke test ran the `docker exec` form, 33 of 33 checks), U35, U41 (`NODE_USE_ENV_PROXY`, unproven), U43 (host of the verification link), U44, U47, U49 (tag limits): see `docs/open-points.md`; owner-verified through OV-01 to OV-06.
- Risk: replication delay of a new service principal or role assignment (U4); the retry window is `SETUP_PROPAGATION_TIMEOUT_SECONDS` (default 900).
- UNVERIFIED: gate, loopback, unlock limiter and state-machine negatives seen red again.

- The Not-found page is no longer a gated anonymous cell of the Lighthouse run: an anonymous visitor of an unknown path is sent to `/signin` first (FR-B-607), so that cell measured the sign-in page under another name and failed its own integrity check ("ended on /signin"). It is measured with the Owner session in the reported group `a-owner` (desktop 100/0.82 s locally). Found on the first CI run in which Lighthouse ran at all (2026-10-12).
