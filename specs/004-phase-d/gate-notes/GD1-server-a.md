# Gate note GD1-server-a (T-D-110 to T-D-117): the server stream A of step D1

Verdict: **GD1-server-a passed for lint, typecheck and the server tests (counts below), with these things NOT run and NOT proven:** the Docker build, the image smoke test, the image size and start time, the arm64 ping, and the real Microsoft behaviour (U75 and the other claims stay UNVERIFIED until OV-D1). The worker script itself was run on a real PowerShell 7 (see "Real pwsh"). **One decision for the owner: the image size ceiling** (400 MB today; the new image is estimated well above it, unmeasured; ADR-0180).

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, HEAD `0d4c0e8` (GD1-0) plus the uncommitted S-D2a working tree (the orchestrator commits), 2026-10-13, Node v22, pnpm 10. `VERSION` is 0.3.55 and is NOT bumped here. The `packages/shared` contract of GD1-0 was used as it is; no change was needed. `apps/web` was not touched. `scripts/bundle-budget.json` was not edited.

| Command | Result |
|---|---|
| `pnpm --filter @m365portal/server lint` | green |
| `pnpm --filter @m365portal/server typecheck` | green |
| `pnpm --filter @m365portal/server test` | red only in `limits-doc.test.ts` (4 tests, the known interim red): 218 of 219 files passed or were skipped (1 file skipped: `real-pwsh.test.ts` without `pwsh`), 9,017 tests passed, 11 skipped, 4 failed. The full run before the last two fixes had 5 failed (the 4 above and the ADR count of `docs-contract.test.ts`); that one is fixed and `docs-contract` and `no-undocumented` were re-run green on their own afterwards |
| `python3 -m unittest discover -s scripts` | green: 245 tests (`test_check_dockerfile_pins` 29, `test_check_image_contents` 79, `test_workflows` 68) |
| Real `pwsh` run of the worker script (`apps/server/test/exchange/real-pwsh.test.ts` with `PWSH_PATH`) | green: 10 tests, including the tmpfs hand-over file (mode 0600, removed again) |
| `npx prettier --check` on `apps/server/src`, `apps/server/test`, `scripts/image-smoke.ts`, the new docs | green (prettier has no parser for `.ps1`, `.env.example` or the Dockerfile) |
| `pnpm --filter @m365portal/server exchange:check` | green (the generated block of the script and `generated-allow-list.ts` equal the allow-list of `@m365portal/shared`) |
| Not run | `docker build`, `pnpm image:smoke`, `check_image_size.py` against a real image, the arm64 step of `image.yml`, `pnpm e2e`, the web package, `pnpm bundle:check`, root `pnpm lint` |

Known interim reds not touched (as instructed): `apps/server/test/limits-doc.test.ts` and `apps/web/test/lazy-namespaces.test.ts`.

## Tasks (evidence)

Test-first as the protocol asks. The test files were written before the code; the first red run (everything missing) and the second (after the ports and fakes existed but before the client, session and script) are kept in the scratchpad of the builder as `red-1.log` and `red-2.log` and summarised here.

| Task | Test files (`apps/server/test/`) | Red first, for the right reason |
|---|---|---|
| T-D-110 owner sheet | `docs/owner-test-phase-d1.md` (draft, en and nl; no VERSION bump) | n/a (a procedure) |
| T-D-111 port, capabilities, fake client, contract | `exchange/capabilities.test.ts`, `exchange/exchange-client-contract.test.ts` (Phase D surface, per-subject capabilities), `ports.test.ts` | the methods and the closed error codes did not exist |
| T-D-112 worker script, session | `exchange/worker-protocol.test.ts`, `exchange/worker-lifecycle.test.ts` (deadline kill, recycle by calls and age, crash at every step, serial queue, close), `exchange/allow-list.test.ts` (hash test, script scan), `exchange/real-pwsh.test.ts` (skipped without pwsh), `exchange/build-script.test.ts` | no session, no script, no generated hash |
| T-D-113 client, retry, logs | `exchange/retry.test.ts`, `exchange/no-personal-data-in-logs.test.ts`, `exchange/rows.test.ts`, contract suite on the pwsh client over the stand-in and on the fake | no client |
| T-D-114 hand-over | `exchange/key-handover.test.ts`, `exchange/no-key-on-disk.test.ts` (canary, negatives), `exchange/node-launcher.test.ts` (environment, arguments, no shell), `config.test.ts` (`EXCHANGE_KEY_HANDOVER`) | no hand-over module, no variable |
| T-D-115 fake tenant Exchange writes | `fakes/fake-tenant.exchange-writes.selftest.test.ts` (strictness self-test: member types, duplicates, manager check with and without the bypass, synced read-only, read-back delay) | no write module |
| T-D-116 Graph member writes | `integrations/graph/read-only.test.ts` (rewritten: allow-list of exactly two write methods, path from `memberRefPath`, negatives), `integrations/graph/graph-member-writes.test.ts`, `integrations/graph/graph-client.contract.test.ts` (write describe), `integrations/graph/permissions-map.test.ts`, `fakes/fake-tenant.graph-writes.selftest.test.ts` | no methods on the port |
| T-D-117 image | `scripts/test_check_dockerfile_pins.py` (`ExchangeRuntimePins`), `scripts/test_check_image_contents.py` (`ExchangeRuntime`), `apps/server/test/integrations/exchange/no-undocumented.test.ts` (path allow-list for PowerShell) | the pin rules and the content rules did not exist (29 tests with 44 failures and 2 errors before the rules) |

Red state, first run (everything missing): **15 test files failed, 74 tests failed, 166 passed** (`red-1.log`). Second run (ports and fakes in, client, session and script missing): **15 files failed, 60 tests failed, 180 passed; 11 suites could not load** (`red-2.log`). The failures were "module not found" and "is not a function" for the new code and none were assertion errors on existing behaviour. `build-script.test.ts` passed on its first run because `build.mjs` already copied the script when the test was written (the copy was added together with the script, not test-first: a deviation, small).

## Deployment-file changes (to be reviewed as such)

| File | Change |
|---|---|
| `Dockerfile` | New stage `pwsh-fetch` (Ubuntu 24.04 by digest; PowerShell 7.6.6 tarball and module 3.10.1 nupkg, each with a checksum verified in the same RUN); the runtime stage is now `ubuntu:24.04` by digest, installs `ca-certificates libgcc-s1 libgssapi-krb5-2 libicu74 libssl3t64 libstdc++6 zlib1g` with apt, user `nonroot` 65532, node copied to `/nodejs/bin/node` (ENTRYPOINT and CMD unchanged), telemetry opt-outs as ENV. |
| `.github/workflows/image.yml` | The existing arm64 smoke step (still `continue-on-error`, same name) also pings the Exchange worker on arm64; header comment updated. No step added or renamed (`test_workflows.py` green). |
| `docker-compose.yml` | `EXCHANGE_KEY_HANDOVER:` passed through (empty means the default). |
| `.env.example` | `EXCHANGE_KEY_HANDOVER=memory` with its comment. |
| Not deployment, but listed for the docs contract | `README.md` and `docs/operations.md` rows for the new variable; `scripts/check_dockerfile_pins.py`, `scripts/check_image_contents.py`, `scripts/image-smoke.ts` and their tests. |
| No seccomp profile | The plan did not need one; Docker's default profile applies (ADR-0180 item 7). |

New environment variable: **`EXCHANGE_KEY_HANDOVER`** (`memory` default, or `tmpfs`), in `apps/server/src/config/env.ts` (`ENV_VARIABLES` now has 25 entries, `AppConfig.exchangeKeyHandover`). It is not in the Phase D spec table; it is the "configuration" the brief asks for (FR-D-103). It needs a one-line addition to the spec's variable table (an architect decision), because `config.test.ts` reads Phase A and B from their specs and Phase D only from the code.

## Findings and gaps (read these)

1. **Image size is unmeasured.** There is no Docker daemon here. Estimated about 500 to 550 MB against a ceiling of 400 MB (Phase A measured 193.5 MB). The `Image size budget` step of the `image` job will fail until the owner sets the ceiling. I did not change `LIMITS.imageSizeCeilingMegabytes` or `check_image_size.py`. ADR-0180 asks for the decision. Start time is unmeasured too (`workerPingMs` is recorded by the smoke test when it runs).
2. **The Dockerfile was not built.** The fetch logic (URLs, checksums, unpacking, the `netFramework` removal) was run locally with the real downloads and the checksums matched; the `FROM` digests were resolved over the network (the digest of `ubuntu:24.04` is in the file). The apt packages of the runtime stage are **not pinned** (the base digest pins the archive only at the moment it was resolved); a snapshot mirror is the fix and is a decision for later.
3. **Console noise on stdout (found by the real-pwsh run).** The module prints names to the Console; the script now redirects the Console output to null and writes protocol lines through its own `ProtocolOut`. The Node side also ignores non-JSON lines, never logs them, and sets stderr to ignore. A leak test with a noisy fake exists (`no-key-on-disk`, `worker-protocol`).
4. **U75 evidence is partial.** The in-memory path and the tmpfs path of the script were both run on a real PowerShell, but `Connect-ExchangeOnline` itself needs a tenant, so "the module accepts an in-memory certificate on Linux" is untested. OV-D1 (`docs/owner-test-phase-d1.md`) settles it. The fallback (`EXCHANGE_KEY_HANDOVER=tmpfs`) is tested for file mode, removal and the tmpfs check, with a negative control.
5. **PKCS#12 producer.** The frozen `connect` line carries a `pfx-base64` container and a password. Phase B stores the certificate with a sealed private key, not a PKCS#12. `ExchangeCredentialSource` (the port that yields the PFX bytes) has a fake only. Part B or the bootstrap must build the real source (generate the PFX from the sealed key and certificate in memory). This is a gap, not a decision I could take.
6. **Dynamic distribution groups.** `Get-DistributionGroup` does not return them; they are listed and read through `Get-Recipient -RecipientTypeDetails DynamicDistributionGroup` (`kind: 'dynamic'`). Their members would need `Get-DynamicDistributionGroupMember`, which is not on the frozen allow-list, so the port has no way to list them: part B must treat a `dynamic` group as read-only without a member list, and a change to `packages/shared` is needed if the spec wants the members shown.
7. **Line limit.** A worker answer is cut at 1 MiB of JSON and marked `truncated`; the client turns a cut list into the "more than the buffer" result, never a silent short list. Large `ResultSize: Unlimited` member reads depend on this and on `LIMITS.exchange.listBufferMax`.
8. **Unverified details in the script and the client**, all recorded where they are used: the OPATH properties accepted by `-Filter` on `Members` (`Get-DistributionGroup -Filter "Members -eq '<DN>'"`), the regular expressions that map error text to the closed codes (the mapping is on the exception's fully qualified error id first, text second), and the exact text of "already a member" and "not a member" answers (U94). Each has a fallback to `internal` (never a guess at success).
9. **The real-pwsh test is not part of the CI skip.** It is skipped where `pwsh` is missing and runs where it exists (GitHub runners have it; the image does). It never talks to a tenant.
10. **Path deviation.** The task list names `py/` for the Python checks; this repository keeps them in `scripts/`, so the files are there.
11. **The self-tests are separate files** (`fake-tenant.exchange-writes.selftest.test.ts`, `fake-tenant.graph-writes.selftest.test.ts`) instead of one `fake-tenant.selftest.test.ts`, to keep the Phase B and C self-test untouched.
12. **Tests outside my files that had to change:** `docs-contract.test.ts` counts the ADRs, so ADR-0180 (decision ODB-01) was added to its list with a negative; `no-undocumented.test.ts` now allows PowerShell in the listed paths only (`InvokeCommand` stays forbidden everywhere); `config.test.ts` counts 25 variables; `rbac/membership.test.ts` doubles got the two Graph write methods.
13. **`secrets/no-plaintext.test.ts`** was not extended: the Exchange key canary lives in `exchange/no-key-on-disk.test.ts`, next to the code it guards.
14. **Wiring is left to part B.** `registry.ts` still gives out the Phase B subset type (`ExchangeAdminApiClient`); nothing constructs `PwshExchangeClient` at start. See the report for the constructors.
15. **U-register.** U92 (add of an existing member answers 400 with others), U93 (remove of a non-member) and U96 (role-assignable groups) are recorded in `permissions-map.ts` rows as unverified; whether to pre-check membership before the Graph add is the service's decision (part B).
