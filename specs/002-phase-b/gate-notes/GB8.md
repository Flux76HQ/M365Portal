# Gate note GB8 (T-B-449): documentation

Verdict: **ready for GB8 review (local pass)**, with the register gap named below. `pnpm docs:check` (docs-contract and limits-doc tests) is green; both languages are present in the documents.

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
| T-B-420 docs contract and limits-doc tests | `apps/server/test/docs-contract.test.ts`, `limits-doc.test.ts` green (XB35: +1,689 -117 over `README.md`, four `docs/*.md`, `open-points.md` and the two tests) |
| T-B-421 `docs/permissions.md`, T-B-422 `docs/operations.md`, T-B-423 `docs/security.md`, T-B-424 `docs/architecture.md`, T-B-425 `docs/open-points.md`, T-B-426 `README.md` | present; operations.md carries the ports table, the setup token section, `APP_KEY`, certificate, break-glass, sessions |
| T-B-427 ADR 0101 to 0126, T-B-428 ADR 0151 to 0178 | present (54 files; `docs/adr` holds 111 records in total) |

## Open points for the documentation

- `docs/open-points.md` registers U1 to U50. U58 to U62 appear only in code comments (GB2); U51 to U57 and U63 to U65 do not appear: add or renumber before the owner reads the register.
- `docs/operations.md` shows `docker run --rm -i <image> dist/cli.js hash-password`; on a terminal `-it` is needed so the password is read without echo (the command reads raw mode only on a TTY). Without `-t` the password echoes.
- `docs/operations.md` says `PUBLIC_BASE_URL` follows `HOST_PORT` in Compose; with plain `docker run -p 9090:9300` it must be set by hand (the default is `http://localhost:<PORT>`, the container port).
- Section 9 of `tasks.md` names `server/setup/lock.test.ts` and `server/setup/replication-retry.test.ts` as OV prerequisites; the checks live in `server/setup/gate.test.ts`/`session.test.ts` (lock, restart) and `backoff.test.ts`/`propagation-probe.test.ts` (replication).
- Decisions taken while building are listed in `docs/open-points.md` (section "Decisions taken while building Phase B").

## Control-name changes

Snapshot file is `0001-phase_b.sql` in the tree; `data-model.md` and `plan.md` still write `0001-phase-b.sql`.
