# Gate note GB2 (T-B-119): clients, fake tenant, policy layer

Verdict: **ready for GB2 review (local pass)**. Contract suites run on both implementations inside `pnpm test`; the Learn statements encoded by the fake are listed below; the negative reruns are not repeated (UNVERIFIED).

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

| Task | Evidence |
|---|---|
| T-B-022, T-B-023 composition, clients registry, JWKS reload, sweepers | `lifecycle.phase-b.test.ts`, `lifecycle.clients.test.ts`, `integrations/registry.test.ts`, `integrations/identity/jwks-cache.test.ts` |
| T-B-064 fake Entra, T-B-065 fake Graph, T-B-066 fake Exchange | `fakes/fake-entra.test.ts`, `fake-graph.test.ts`, `fake-exchange.test.ts` |
| T-B-070 one `fetch` wrapper, T-B-084 URL discipline | `integrations/json-fetch.test.ts`, `url-guard.test.ts`, `url-discipline.test.ts` |
| T-B-071 `GraphHttp` retry and budgets | `integrations/graph/http-retry.test.ts`, `cache.test.ts` |
| T-B-072 `GraphClient` both implementations, contract suite | `integrations/graph/graph-client.contract.test.ts`, `graph-client.test.ts`, `permissions-map.test.ts` |
| T-B-073 `TenantProvisioner` | `integrations/graph/provisioner.test.ts` |
| T-B-074 client assertion | `integrations/identity/client-assertion.test.ts` |
| T-B-075 MSAL application tokens | `integrations/identity/msal-app-token.test.ts` |
| T-B-076 bootstrap authenticator | `integrations/identity/bootstrap.test.ts` |
| T-B-077 tenant metadata and key set | `integrations/identity/tenant-metadata.test.ts`, `jwks-cache.test.ts` |
| T-B-078 ID-token validator (F-02 to F-27) | `integrations/identity/id-token.test.ts` |
| T-B-079 token endpoint, OIDC client | `integrations/identity/oidc-client.test.ts`, `aadsts.test.ts` |
| T-B-080 Exchange read adapter and contract | `integrations/exchange/admin-api.test.ts`, `no-undocumented.test.ts`, `exchange/exchange-client-contract.test.ts` |
| T-B-081 `ClientsRegistry` | `integrations/registry.test.ts` |
| T-B-082 layering and no test hooks | `layering.test.ts`, `no-test-hooks.test.ts` |
| T-B-083 fake strictness self-test | `fakes/fake-tenant.selftest.test.ts` |
| T-B-237 route wrapper, T-B-241 CSRF binding | `route-table.test.ts`, `api-conventions.test.ts`, `csrf.test.ts` |
| T-B-240 actors, resolvers, `authorize`; preview actor deleted | `policy.test.ts`, `policy-session-hash.test.ts`, `preview-mode.test.ts` |
| T-B-242 401/403/step-up semantics, T-B-243 `policy_not_applied` | `audit-denials.test.ts`, `policy-scoped-routes.test.ts` |
| T-B-244, T-B-245 signed-in test actors, Phase A tests migrated | `helpers.test.ts`, `apps/server/test/branding/*` (all green, none deleted) |
| T-B-246 policy matrix | `policy-matrix.test.ts` |

## Frozen interfaces

CB6 (ports), CB7 (fake tenant), CB9 (`GraphClient`, `TenantProvisioner`), CB10 (`ExchangeClient`, identity), CB11 (`ClientsRegistry`), CB16 (`signedInAs` helper).

## Seams applied (lines touched against Phase A `bafba3a`)

| Seam | Files | Lines |
|---|---|---|
| XB12 | `app.ts`, `index.ts`, `start.ts`, `lifecycle/*`, `test/lifecycle.test.ts`, `test/health.test.ts` | 7 files +353 -47 |
| XB14 | `apps/server/vitest.config.ts` | +6 -0 |
| XB15 | `http/route.ts`, `route-table.ts`, `openapi.ts`, `test/route-table.test.ts`, `test/api-conventions.test.ts` | 5 files +2136 -136 |
| XB16 | `policy/*` (`resolvers.ts` replaced by `resolvers/`), `test/policy.test.ts` | 17 files +1560 -324 |
| XB17 | `http/csrf.ts`, `test/csrf.test.ts` | +174 -4 |
| XB21 | `test/helpers/*`, `test/helpers.test.ts`, `test/branding/*` | 30 files +1982 -153 |
| XB22 | `eslint-rules/*`, `tools/lint-canary/*` (new files; loader untouched) | 9 files +1541 |
| XB37 | `branding/service.ts`, `branding/module.ts` (actor kinds); `request-support.ts` and `assets-upload.ts` needed no edit | 2 files +6 -28 |

## Control-name changes to sync (TB-12)

- Route ids are lower case (SB-27): `auth.logout.all`, `auth.breakglass`, `connection.runs.retry.now`, `rbac.restore.owner`. `tasks.md` line 1137 and the contract text still show the old camel-case names.
- Audit `actor.id` values `anonymous` and `break-glass` (the code leads; the contract text follows).
- The revalidation guard lives in `http/route.ts`.
- The Grant scope literal is lower case `'all'`.
- Tests named in `tasks.md` that now live elsewhere: `server/auth/client-assertion.test.ts` is `integrations/identity/client-assertion.test.ts`; `server/auth/jwks-cache.test.ts` is `integrations/identity/jwks-cache.test.ts`.

## Learn statements encoded by the fake (see also `fake-tenant.selftest.test.ts`)

Strict client assertion (`x5t#S256` required, `exp` and `jti` rules), `keyCredentials` `PATCH` as full replacement, replication delay for new objects, role snapshot in tokens, `Origin` header refused on the token endpoint for confidential clients, device-code polling errors, the Admin API envelope tolerance (U45).

## Open points, assumptions, risks, UNVERIFIED

- MSW is wired fetch-only (no `http`/`https` interception); the no-egress guard blocks anything else.
- U21, U31, U32, U36 to U38, U43 to U45 and U47 are touched; their status is in `docs/open-points.md` (all open, except as noted there).
- U58 (limit on assertion `exp` is ours), U59 (whether Entra rejects a replayed `jti`), U60 (MSAL error property is a property of the pinned library version), U61 (Conditional Access block seen while polling the device code, and the answer to a poll is ours), U62 (error code for an `Origin` header on the token request is not documented): these five ids exist only in code comments and in `fake-tenant.selftest.test.ts`; they are **not yet in the register of `docs/open-points.md`** (see GB8). U51 to U57 and U63 to U65 are not present anywhere in the tree: UNVERIFIED which items they denote; the workers who reserved them must list them.
- UNVERIFIED: negatives (layering, no-egress, wrapper) seen red again.
