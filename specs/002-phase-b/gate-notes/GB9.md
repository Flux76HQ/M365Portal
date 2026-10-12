# Gate note GB9 (T-B-489): verification complete

Verdict: **pending CI, not passable yet**. The local matrix is green except `pnpm format:check`; the negative-control ledger (T-B-395) and the rehearsal of the owner's step list (T-B-481) have not been done, and the CI-only parts have not run.

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

## Ledger (T-B-480)

| Group | Content |
|---|---|
| Ran locally, green | lint, typecheck, unit/integration (shared 3,532, web 1,740, server 8,179, tools 1,113, e2e unit 165), build, schema, routes, i18n, tokens, bundle, Python tests (223), compose config |
| Ran locally, red | `pnpm format:check` (100 files) |
| Only on GitHub / not run here | `pnpm e2e` all projects, visual baselines, `pnpm lighthouse`, `pnpm image:smoke`, `docker build`, `pnpm audit`, actionlint, arm64, cosign, SLSA, CodeQL, Trivy |
| Simulated | Entra, Graph, Exchange by the one fake tenant (MSW). Assumptions it encodes: strict assertion rules, full replacement semantics of `keyCredentials`, replication delay, role snapshot in tokens, Admin API envelope tolerance (see GB2) |
| Cannot be tested here | any real Microsoft 365 tenant (OV-01 to OV-23), securityheaders.com, Mozilla Observatory, screen readers, browsers other than Chromium |

## T-B-395 negative-control ledger

Not written. Known negative controls: the unit-test negatives of each stream (red when written, not repeated), the migration trigger mutation test (29 of 29), the lint canary cases, and the bootstrap-lifetime negative that exists only as a mutation run (GB4). A file-level ledger is still to be produced.

## T-B-481 rehearsal

Not done. `docker build` and the steps A and B of the owner's list were not run in this sandbox; the commands in `docs/phase-reports/phase-B.md` are copied from `docs/operations.md`, `.env.example`, `docker-compose.yml` and the CLI source, and every Microsoft step is marked owner only. The measured time from `docker run` to the wizard is not available.

## Open points of S-B7 for T-B-425 and T-B-999

See GB7 and GB8: baselines from CI, Lighthouse mobile `/setup` LCP decision, `a-owner` report-only, format fix, register gaps U51 to U65, the `-it` note for `hash-password`.
