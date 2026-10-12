# Gate note GB1 (T-B-059): secrets, pure shared code, ports and fake core

Verdict: **ready for GB1 review (local pass)**. The commands below are green on the current tree; the clean-copy install and the red-once-more reruns of the guard negatives are not repeated (UNVERIFIED, see the end). Nothing in this gate depends on CI.

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

| Task | Evidence in the tree (test files under `apps/server/test` or `packages/shared/test`) |
|---|---|
| T-B-015 `APP_KEY` formats, key id | `secrets/app-key.test.ts` |
| T-B-016 sealed box (XChaCha20-Poly1305, derived subkey) | `secrets/sealed-box.test.ts`, `secrets/no-plaintext.test.ts` |
| T-B-017 self-signed certificate generator | `secrets/certificate.test.ts` |
| T-B-018 secret store, certificate service, holder | `secrets/secret-store.test.ts`, `secrets/certificate-holder.test.ts`, `secrets/lazy-load.test.ts` |
| T-B-019 secrets module, state, readiness, degraded mode | `secrets/degraded.test.ts`, `health.test.ts`, `lifecycle.test.ts` |
| T-B-020 key rotation | `secrets/rotate.test.ts` |
| T-B-021 CLI core | `cli.test.ts` (commands `generate-app-key`, `hash-password`, `rotate-app-key`, `setup-token`, `setup-reopen`, `verify-audit`) |
| T-B-060 ports, error taxonomy | `ports.test.ts` |
| T-B-061 three lint rules | `eslint-rules/test`, `tools/lint-canary` (green inside `pnpm test`) |
| T-B-062 no-egress guard, T-B-063 fake tenant core and MSW | `fakes/no-egress.test.ts`, `fakes/fake-tenant.core.test.ts` |
| T-B-067 Graph roles, T-B-068 `AADSTS` map, T-B-069 `evaluateAmr` | `graph-roles.test.ts`, `aadsts-map.test.ts`, `amr.test.ts` (shared) |
| T-B-120 setup registries, T-B-121 desired state, T-B-122 wire schemas | `setup-registry.test.ts`, `desired-state.test.ts`, `schemas-setup.test.ts`, `schemas-connection.test.ts` (shared) |
| T-B-180 sign-in registries, `safeReturnTo` | `signin-errors.test.ts`, `return-to.test.ts`, `schemas-auth.test.ts` (shared) |
| T-B-230 to T-B-236 shared RBAC | `rbac-resources`, `rbac-scope`, `rbac-matrix`, `rbac-covers.property`, `rbac-qualifier`, `rbac-effective`, `rbac-roles-wire`, `schemas-rbac` (shared) |
| Also in GB1 scope: T-B-006 cookie names, T-B-007 redirect URIs, T-B-008 scrypt format and Node version (done in GB0) | `cookie-names`, `redirect-uri`, `scrypt-hash`, `node-version` (shared) |

`shared/exports.test.ts` is green with the real modules present (wildcard subpaths `./rbac/*`, `./auth/*`, `./setup/*`).

## Frozen interfaces

CB4 (config, `SecretText`, cookie names, redirect URIs, scrypt hash), CB5 (secrets: sealed box, key id, `CertificateHolder`, secrets state, rotation, CLI core), CB6 to CB8 and CB13, CB14 (shared half): `GRAPH_APP_ROLES`, `evaluateAmr`, `aadsts-map`, RBAC pure functions (`computeGrants`, `covers`, `canGrantCore`, `projectUser`, scope matcher), registries and wire schemas of setup, connection and auth.

## Seams applied

XB13 (`apps/server/src/cli.ts`, +76 -3: dispatcher; `verify-audit` untouched), XB38 (`schemas/health.ts`, `lifecycle/readiness.ts`, `routes/health.ts`, `test/health.test.ts`: +47 -11, check `secrets`), XB12 part (readiness only), XB6 shared half (`permissions.ts` +35 -3). Full line counts in GB0, GB2 and GB5.

## Control-name changes synced

None new in this gate beyond GB0.

## Open points, assumptions, risks, UNVERIFIED

- UNVERIFIED (2026-10-12): the guard negatives of the tasks above were not seen red again in this run; they were red when written (worker reports).
- UNVERIFIED: clean-copy `pnpm install --frozen-lockfile`.
- U47 (certificate extensions accepted by Entra) is encoded in `CertificateFactory`: only the owner test OV-03/OV-04 settles it.
- `pnpm format:check` is red for the tree (see table); it concerns formatting only.
