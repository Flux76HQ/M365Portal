# Implementation Plan: M365Portal Phase B (onboarding wizard, Entra sign-in, RBAC foundation)

**Branch**: the branch this session was given (integration branch undecided: AGENTS.md section 8, Phase A OD-02) | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `specs/002-phase-b/spec.md` (FR-B-101 to FR-B-716, US-B1 to US-B13, EB-01 to EB-38, B-01 to B-26, ODB-01 to ODB-18, OV-01 to OV-23, F-01 to F-45), `research-microsoft-b.md`, the Phase A plan, data model, contract and tasks (`specs/001-m365portal/`), `docs/build-prompt.md` (sections 2, 2a, 3, 6, 7, 8), `AGENTS.md`, the Flux76 baseline and the orchestrator's defaults B1 to B12.

**Companion documents**: [data-model.md](data-model.md) (migration `0001_phase_b`, triggers, invariants, snapshot and upgrade test) and [contracts/phase-b-api.md](contracts/phase-b-api.md) (every new endpoint, the changed Phase A shapes, cookies, headers, error codes).

**Scope of this plan**: Phase B only. Phases C and D are outside it, except where section 8.8 and section 11.9 name what Phase B must prepare. Work stops after Phase B: the owner tests against a real Microsoft 365 tenant (spec section 3). Nothing here may be used to start Phase C.

## Samenvatting (Nederlands)

Dit plan beschrijft hoe fase B wordt gebouwd bovenop de geplande fase A-interfaces: een setup-poort (eenmalig token, brute-force-limieten, 404 na vergrendeling), een hervatbare tenant-wizard (device code, app-registratie, certificaat, Graph-permissies, Exchange-rol, verificatie met retry en backoff, handmatige modus), Entra-aanmelden (autorisatiecode met PKCE, certificaat-assertion, eigen ID-token-validatie met `jose`, server-side sessies met gehashte id's, CSRF gebonden aan de sessie, step-up, uitloggen overal), geheimen versleuteld met libsodium en het RBAC-fundament (rollen, toewijzingen aan gebruikers en groepen, scopes, een centrale policy-laag zonder `PREVIEW_MODE`, laatste-Eigenaar-bescherming in SQL-triggers, break-glass). Alles wat Microsoft doet wordt in tests gesimuleerd door één nep-tenant (MSW, een nep-identiteitsprovider met `jose`), met een extra vangnet dat elke echte netwerkverbinding in tests blokkeert.
Dit plan is gecontroleerd met proeven in deze omgeving (sectie 0): het levert 26 aanpassingen aan de spec op (sectie 18), waaronder dat `node:https` door MSW niet wordt onderschept (alleen `fetch` is toegestaan, met een no-egress-vangnet), dat `@peculiar/x509` een `reflect-metadata`-polyfill nodig heeft (lazy geladen), dat scrypt met `N` tot 2^20 een gigabyte geheugen vraagt (begrensd op 128 MiB), en dat `jose` een `iat` in de toekomst, een `aud`-array en een `jku`-header niet zelf weigert (eigen controles vóór en na `jose`). De Exchange-schrijfroute blijft een eigenaarsbeslissing (sectie 19). Na fase B stopt het werk voor de test van de eigenaar tegen een echte tenant.

## Summary

Phase B turns the Phase A skeleton into a panel that can attach to a real tenant and that real people sign in to. It adds five `AppModule`s (`secrets`, `setup`, `connection`, `auth`, `rbac`) on the Phase A seam X1, one forward-only migration (`0001_phase_b`: 17 tables, 29 triggers, seeded built-in roles), three integration families behind ports (`graph`, `exchange`, `identity`), three actor resolvers that replace the preview resolver (session user, setup, break-glass), and the web routes `/setup`, `/signin`, `/no-access`, `/break-glass`, `/settings/connection`, `/settings/access`, `/settings/restore-access`.

Three design rules carry most of the risk and are stated up front:

1. **One simulation, three transports.** A single WHATWG `fetch`-shaped fake tenant (Entra, Graph, Exchange) serves Vitest through MSW, the e2e server process through an MSW preload that forwards to a local HTTP server, and the browser through Playwright routes. Production code makes outbound HTTP only through global `fetch` (probe V-B05 showed MSW does not intercept `node:https`), and every test process has a no-egress guard that fails any non-loopback socket (V-B06).
2. **The policy layer is the only gate and it fails closed.** Actor kinds are `anonymous`, `user`, `setup`, `break_glass`; all but two tiny fixed sets of permissions come from rows, never from code; the route table refuses to boot a route without an access declaration; a scoped route that forgets scope answers 500 and is audited.
3. **Nothing secret outlives its need.** The bootstrap token lives in one in-memory object that is discarded before the propagation probes; the certificate key exists only sealed (XChaCha20-Poly1305, key from `APP_KEY`) and as a non-exportable-by-API `KeyObject`; sessions are stored as SHA-256 hashes; the setup token is compared in constant time and never logged.

## 0. What was verified while planning

Items marked **verified** were run or read on 2026-10-10 in this environment (Node 22.22.0, sandbox with direct egress and the pre-installed Chromium). Probe code lived in the session scratchpad and is not repository code; its assertions are the specification of the tests named in the last column. Everything not in this table and not in the spec or the two research files is **UNVERIFIED** (section 18.3).

| ID | Check | Result | Consequence for the plan | Control |
|---|---|---|---|---|
| V-B01 | `pnpm view` of every candidate pin (run from the repository so corepack resolves pnpm 10.28.0) | `@azure/msal-node` 7.0.1 (modified 2026-10-02; depends on `jsonwebtoken ^9` and `@azure/msal-common 16.14.2`), `jose` 6.2.12, `libsodium-wrappers` 0.8.4 (depends on `libsodium ^0.8.0`), `msw` 3.0.3 (engines node `>=22.12.0`), `@peculiar/x509` 2.1.0, `reflect-metadata` 0.2.2. | The four probe pins stand; two more pins added (4.1). | `quality` (frozen lockfile) |
| V-B02 | `@peculiar/x509` 2.1.0 in a scratch project: RSA 2048 `RSASSA-PKCS1-v1_5`/SHA-256 self-signed v3 certificate through WebCrypto | Works and takes 169 ms. **It throws at import** ("tsyringe requires a reflect polyfill") until `reflect-metadata` is imported first. The result parses with `node:crypto` `X509Certificate` (`verify(publicKey)` true, `checkPrivateKey` true, SHA-1 and SHA-256 fingerprints equal an independent hash of the DER) and passes `openssl x509 -text` and `openssl verify`. 21 packages, 4.8 MB. | Library kept (B-19) with `reflect-metadata` as a second direct dependency, both imported lazily and only inside `secrets/x509/` (PB-02). Fallback: a 120-line DER encoder, verified by the same three parsers. | `server/secrets/certificate.test.ts`, `image` smoke test |
| V-B03 | Production dependency tree of the five Phase B packages installed alone | 41 packages, 17 MB on disk; importing all of them plus constructing a `ConfidentialClientApplication` raises RSS from 42 to 85 MB (+43 MB; heap 19 MB). `npm audit` reports 0 vulnerabilities for the production tree and for the `msw` tree. No package has an install script, so `strictDepBuilds` needs no new `ignoredBuiltDependencies`. | Idle RSS budget rises from 150 to 200 MB (section 15); image budget +17 MB. | `quality` (`pnpm audit --prod`), `image` (size and RSS) |
| V-B04 | `@azure/msal-node` 7.0.1 against MSW (client credentials with a `clientAssertion` callback, device code with a pending then a success answer) | MSAL makes **no discovery request** for the Microsoft authority; it uses **global `fetch`** (`HttpClient.mjs`); sends no `Origin` header; calls the assertion callback with `{clientId, tokenEndpoint}` **on every acquire, cache hit included**; adds `openid profile offline_access` (not `email`) to the device-code scope; polls the device grant with `grant_type=device_code` (not the URN of Learn); `acquireTokenByClientCredential({skipCache:true})` is honoured; `clearCache()` exists on both application classes and empties the account list; the device-code `AuthenticationResult` carries `account.tenantId` and `localAccountId` equal to the ID token's `oid`. | The fake IdP accepts both device grant spellings (SB-10); `signClientAssertion` takes its audience from `tokenEndpoint`; the bootstrap holder calls `clearCache()` and drops the object (FR-B-215). | `server/integrations/identity/msal-app-token.test.ts`, `server/setup/bootstrap-token-lifecycle.test.ts` |
| V-B05 | MSW 3.0.3 in a plain Node process: `fetch` to a Microsoft host, `node:https` `get` to the same host, an unlisted host, and a forwarding handler using `bypass()` to a local HTTP server | `fetch` is intercepted and forwarding with `bypass()` works. An unlisted host fails with the MSW error under `onUnhandledFrame: 'error'`. **`https.get` was not intercepted at all: it reached the real Entra endpoint and returned a real `AADSTS90002`.** | A hard rule (PB-01): outbound HTTP in the product is global `fetch` only, so no file under `apps/server/src` imports `node:http`, `node:https`, `node:net`, `node:tls` or `undici` (global `fetch` needs no import). Plus the no-egress guard (V-B06). FR-B-315's "integrations may import the HTTP modules" is tightened to "nobody may". | `server/layering.test.ts` (+ negative), `server/fakes/no-egress.test.ts` |
| V-B06 | A test-time guard patching `net.Socket.prototype.connect` to destroy connections to non-loopback hosts | Blocks `https.get` and `fetch` to Microsoft hosts (`ENOEGRESS`), still allows `127.0.0.1`. | Installed by the Vitest setup file of the `server` project and by the e2e server preload (section 14.3). | `server/fakes/no-egress.test.ts` (+ negative: a test that opens a real socket must fail) |
| V-B07 | `jose` 6.2.12 `jwtVerify` against a local key set with `algorithms:['RS256']`, `clockTolerance:60`, `issuer`, `audience` | `exp` 59 s past accepted, 61 s past `ERR_JWT_EXPIRED`; `nbf` +59 s accepted, +61 s `ERR_JWT_CLAIM_VALIDATION_FAILED` (claim `nbf`); wrong `aud`/`iss` rejected (claim names); unknown `kid` `ERR_JWKS_NO_MATCHING_KEY`; attacker key with a real `kid` `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`; `alg` none/PS256 `ERR_JOSE_ALG_NOT_ALLOWED`; unknown `crit` `ERR_JOSE_NOT_SUPPORTED`. **Accepted without complaint: `iat` 120 s in the future (F-16), an `aud` array holding our id and another (F-09), a `jku` header (F-20, F-22).** | The validator adds its own checks around `jose` (section 10.3, SB-08): header pre-check, unverified `tid`/`iss` peek, then `jose`, then `aud` is a string, `iat`, `ver`, `oid`, `nonce`. | `server/integrations/identity/id-token.test.ts` (F-02 to F-27) |
| V-B08 | `jose` 6.2.12 `createRemoteJWKSet` types | Options `timeoutDuration` (default 5 s), `cooldownDuration` (default 30 s: time after a successful fetch before an unknown `kid` may refetch), `cacheMaxAge` (default 10 min), `headers`, and the symbols `customFetch` and `jwksCache`; the resolver has `reload()`, `coolingDown`, `fresh`. | **Closes U40.** Configure `cacheMaxAge` 24 h, `cooldownDuration` 5 min, `[customFetch]` = our fetch wrapper, plus an hourly `reload()` (FR-B-404). | `server/auth/jwks-cache.test.ts` |
| V-B09 | `libsodium-wrappers` 0.8.4 | All names of FR-B-105 exist: `crypto_aead_xchacha20poly1305_ietf_encrypt/decrypt` (`NPUBBYTES` 24, `ABYTES` 16, `KEYBYTES` 32), `crypto_kdf_derive_from_key` (context length 8, so `m365sec1` fits; `BYTES_MIN` 16), `crypto_generichash`, `randombytes_buf`, `memzero`. Wrong additional data and a flipped byte both throw. The package ships its own types. | A known-answer vector is normative (section 7.2). | `server/secrets/sealed-box.test.ts` |
| V-B10 | `node:crypto.scrypt` at r=8, p=1 | The default `maxmem` (32 MiB) rejects every N from 2^15 up (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`). With `maxmem` set: N=2^14 62 ms/16 MiB, 2^16 242 ms/64 MiB, 2^17 604 ms/128 MiB, 2^18 1.07 s/256 MiB, 2^20 4.1 s/**1 GiB**. | The spec's N range up to 1,048,576 cannot run in the 512 MiB Compose limit: memory is capped at 128 MiB and one verification runs at a time (SB-04, PB-12). | `server/auth/break-glass.test.ts` |
| V-B11 | The migration SQL of data-model.md executed on better-sqlite3 13.0.3 (SQLite 3.53.4) | 17 tables, 29 triggers, 9 indexes; 59 assertions pass: matrix counts 15/13/9/6/4, built-in immutability, last-owner delete/demote/convert, group owners do not count, cascade deletes bump the epoch, group assignments clear the membership cache, session/secret/certificate/scope `CHECK`s, partial unique indexes, tenant pin, setup transitions, `foreign_key_check` empty. A second probe ran 40 table-driven trigger cases and dropped each of the 29 triggers in turn: 29 of 29 mutants were killed (data-model.md section 13). | The SQL is normative as written (data-model.md section 5); every trigger needs a case and the mutation test is part of the suite. | `server/migrations.phase-b.test.ts`, `server/migrations.doc.test.ts`, `server/rbac/*.test.ts` |
| V-B12 | Live Entra discovery documents (public endpoints): `organizations`, and the public Microsoft tenant | `id_token_signing_alg_values_supported` is `["RS256"]` (**closes the `alg` part of U33**); `token_endpoint_auth_methods_supported` includes `private_key_jwt`; the tenant document carries literal `issuer` `https://login.microsoftonline.com/<tid>/v2.0`, `jwks_uri` `.../<tid>/discovery/v2.0/keys`, `end_session_endpoint` `.../<tid>/oauth2/v2.0/logout`; the `organizations` document shows the issuer as the template `{tenantid}`. | Constructed endpoints and discovery agree (FR-B-402, FR-B-404, FR-B-410). | `server/integrations/identity/tenant-metadata.test.ts` |
| V-B13 | One unauthenticated device-code request (never completed) for client `14d82eec-...` with the three scopes against `organizations` | HTTP 200, `Cache-Control: no-store`; `verification_uri` `https://login.microsoft.com/device`, `expires_in` 900, `interval` 5, plus `user_code`, `device_code`, `message`. | **Partly closes U43** (host `login.microsoft.com` is on the allow-list) **and the default `interval` of U22** (5 s). `slow_down` stays undocumented. | `server/setup/device-code.test.ts` |
| V-B14 | `NODE_USE_ENV_PROXY=1` in Node 22.22.0 | Accepted for `fetch` and `https`; prints `UNDICI-EHPA: EnvHttpProxyAgent is experimental`. The sandbox has direct egress, so the proxy effect itself cannot be proven here. | U41 stays open (refined); operations.md documents the variable as UNVERIFIED. | `docs/open-points.md` |
| V-B15 | Learn, Exchange Admin API pages `get-started`, `OrganizationConfig`, `DistributionGroupMember` (read in full) | `$select` "is supported on all endpoints"; `Get-OrganizationConfig` takes no parameters and returns one object whose documented properties are `Name`, `Identity`, `Id`, `Guid` and three MailTips properties (the Preview returns the full cmdlet output); base URLs per cloud; `X-AnchorMailbox` forms; 401/403/400 meanings. The page does not show the response envelope. | The probe is `Get-OrganizationConfig` with `?$select=Name,Guid`; envelope parsing is tolerant (array, `value` array or single object) and the shape is **U45**. | `server/exchange/exchange-client-contract.test.ts` |
| V-B16 | Learn, `verifiedDomain` and `unifiedRoleAssignment` | `verifiedDomain.isInitial` exists; `roleManagement/directory/roleAssignments` supports `$filter` on `principalId` (`eq`, `in`) and `roleDefinitionId`. | **Closes the filter part of U31** (duplicate-POST behaviour stays open); the initial domain is read from `verifiedDomains`. | `server/setup/assign-exchange-role.test.ts` |
| V-B17 | Learn permission tables and the permissions reference for the operations of Phases C and D (section 8.8) | Details and sources in 8.8. Net result: no Phase C or D Graph operation found needs `Group.Read.All` or `Directory.Read.All`; `Organization.Read.All` explicitly covers `subscribedSkus`; `licenseDetails` does not support application permissions; `Group.ReadBasic.All` is named in the List groups table but **has no entry in the permissions reference**. | B1 default confirmed, with a fallback ladder for U36 (8.8). | `shared/graph-roles.test.ts`, `server/integrations/graph/permissions-map.test.ts` |
| V-B18 | PowerShell Gallery feed for `ExchangeOnlineManagement` | Latest 3.10.1, published 2026-07-24, package 21,682,678 bytes, depends on `PackageManagement` and `PowerShellGet`. | Input to the Exchange memo (section 19). Not a Phase B dependency. | none |
| V-B19 | As-built state of Phase A at 15:40 on 2026-10-10 | The server holds only `app.ts` (`createApp()` with `/healthz`), `index.ts`, `listen.ts` and `version.ts`; `packages/shared/src/{permissions,problem,routes,schemas/meta}.ts` and `i18n/index.ts` are `export {}` stubs; local ESLint rules, the lint canary and the shared repository guards exist. | The spec's check "Phase B plan re-reads the as-built code" has nothing to compare against yet. The plan builds on the **planned** contracts C1 to C14 and task `T-B-001` repeats the comparison at the Phase A gate before any Phase B code (spec section 13.1 and plan section 21). | `T-B-001` (review) |

## 1. Technical context

**Language/Version**: TypeScript 6.0.3 strict, Node 22 (image 22.22.0, engines `>=22.19.0 <23`), React 19.3.0; unchanged from Phase A.

**New production dependencies** (4.1): `@azure/msal-node` 7.0.1, `jose` 6.2.12, `libsodium-wrappers` 0.8.4, `@peculiar/x509` 2.1.0, `reflect-metadata` 0.2.2. **New development dependency**: `msw` 3.0.3. No new web dependency.

**Storage**: the Phase A SQLite file gains migration `0001_phase_b`. Files: `${DATA_DIR}/setup-token` (mode 0600, only while setup is open) and `${DATA_DIR}/backups/pre-rotate-<UTC>.sqlite` (rotation). No key, token or certificate private key is ever written in clear.

**Testing**: Vitest 5.0.3 with MSW 3.0.3 (`onUnhandledFrame: 'error'`) and the fake tenant; Playwright 1.56.1 against the production bundle started with an MSW preload; fast-check is not added (seeded property tests use a 40-line seeded PRNG already planned for Phase A's accent test).

**Target platform**: unchanged (distroless, uid 65532, read-only root, one replica). The runtime base is not changed in Phase B (FR-B-706); the Exchange decision may change it in Phase D.

**Constraints**: the CSP gains nothing (FR-B-605); the largest request stays 9,437,184 bytes; new JSON routes keep 262,144 bytes and the four small auth bodies 4,096; outbound hosts are exactly `login.microsoftonline.com`, `graph.microsoft.com`, `outlook.office365.com` (worldwide cloud only).

**Scale/Scope**: a handful of administrators; at most 200 bound Entra groups, 5,000 assignments, 100 roles; 32 new routes (P01 to P32), 7 new UI routes, 17 new tables, about 355 new translation keys per language (estimate: setup 140, connection 40, signin 30, noaccess 15, access 25, role 20, permission 35, session 15, breakglass 15, scope 20).

### Clarifications resolved by this plan

Every item the spec left to the plan or marked UNVERIFIED has a default here; the numbered decisions are in section 17.

| Item | Default chosen | Where |
|---|---|---|
| X.509 library (B-19, FR-B-711) | `@peculiar/x509` 2.1.0 plus `reflect-metadata` 0.2.2, lazily imported; own DER encoder as documented fallback | PB-02, V-B02 |
| ADR numbers for B-01 to B-26 (FR-B-709) | `0100 + n`; plan decisions `0150 + n` | 17.1 |
| `jose` option names (U40) | closed by V-B08 | PB-05 |
| How the setup actor reaches the Appearance form in wizard step 5 | the setup actor holds exactly `settings:branding` and `settings:connection` | PB-06, SB-01 |
| Log polling load against the `read` bucket | one combined poll per second (`runs/current?after=`) instead of two | PB-14 |
| Certificate crash-safety | `pending` certificate state, generated and sealed before the upload | PB-13, SB-02 |
| Break-glass memory under 512 MiB | scrypt memory capped at 128 MiB, one verification at a time | PB-12, SB-04 |
| `Strict` cookie and cross-site entry (links from mail or chat) | one `GET /api/v1/me` re-check on boot when the boot actor is anonymous | PB-15 |
| Exchange probe cmdlet | `Get-OrganizationConfig?$select=Name,Guid` | PB-22 |
| Scope attributes per target (FR-B-513 "allow-listed per target") | `SCOPE_MATRIX` of 11.3 | PB-11, SB-07 |

## 2. Constitution check

No filled-in constitution exists (Phase A plan section 2); the gates are `AGENTS.md` and the baseline.

| Gate | Before design | After design |
|---|---|---|
| AGENTS.md section 1: spec first, stop after the phase, no invented Microsoft API | Pass | Pass. Every Microsoft claim is cited, carried or marked UNVERIFIED (U34 to U50). `tasks.md` of Phase B ends with the gate task. |
| Server-side enforcement is the only enforcement | Pass by spec | Pass. Section 11.7 shows how deny by default survives the removal of preview mode; the route table refuses undeclared routes; `policy_not_applied` is the safety net for scoped routes. |
| Baseline section 7: every MUST has a named automated control | Pass in the spec | Pass. The control names of the spec are kept; sections 14.6 and 14.7 add the negative controls and a completeness test. The only review-only MUST is FR-B-712 (phase gate). |
| AGENTS.md section 7: few, justified dependencies | Five production packages | Pass: one more than the spec (`reflect-metadata`), justified by V-B02; 41 packages, 17 MB, 0 advisories (V-B03). Fallback documented. |
| AGENTS.md section 4: no secrets | Pass | Pass. Canary tests for the app key, setup token, private key, bootstrap tokens, authorization code, state, ID token, session id and break-glass password (SC-B-013); throwaway generated values only. |
| No Phase C artefact in the repository (FR-B-712) | Pass | Pass. `GraphClient` gains no user-list or member-write methods; `ExchangeClient` has read methods only. |

## 3. Baseline compliance

Every section of `project-baseline.md`. Test paths follow the prefixes of the spec (`server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`, `py/` is `scripts/`).

| Baseline section | How Phase B satisfies it | Enforcement point |
|---|---|---|
| 1 Version control | `VERSION` 0.2.x to 0.3.0 in the first Phase B commit that touches a protected path (FR-B-710); `/healthz`, label and tag derive from it | `enforce-version-bump`, `image` smoke test |
| 2 CI guardrails; schema snapshots; upgrade test | `apps/server/schema-snapshots/0001-phase-b.sql` and its manifest entry are committed with the migration; the upgrade test opens snapshot 0 seeded with branding, assets, a staged asset and an audit chain that includes `preview` actor rows, applies the real wrapper and compares with snapshot 1; a synthetic drifting fixture must keep failing; the parity test compares defaults stated twice. Migration `0001` only adds tables, so the table-rebuild hazard of Phase A P12 does not arise, and the test still runs with child rows | `server/migrations.upgrade.test.ts` (+ negative), `server/schema-parity.test.ts` (+ negative), `quality` steps "Schema snapshot check" and "Schema drift check" |
| 3 Local automation | Hooks unchanged; no new hook. The pre-commit hook still only runs the version guard and the agent-instruction lint | `.githooks/pre-commit` (existing) |
| 4 Secrets and configuration | `.env.example` lists exactly the 14 new variables and drops `PREVIEW_MODE*`; `APP_KEY` is empty with a generate command in a comment; the Compose example mounts a Docker secret; fixtures generate throwaway keys; the image check bans `.env`, token and key files, `msw` and the fake tenant | `server/deploy-files.test.ts`, `py/test_check_image_contents.py`, `quality` secret scan, `server/no-leak.test.ts` |
| 5 Release discipline | Unchanged (Phase A pipeline). The PR body states the operator-visible changes of AGENTS.md "Deployment-file changes" (11 and 12.2: `APP_KEY` or secret required, `SETUP_TOKEN` optional, `PREVIEW_MODE*` removable) | review, `py/test_workflows.py` (existing) |
| 6 Operational docs and limits | `docs/operations.md` gains the env table, the limits rows with numbers, key backup and rotation, certificate renewal, setup token and `setup-reopen`, break-glass, timeouts, reverse-proxy checklist and the outbound host list. The largest request stays 9,437,184 bytes | `server/limits-doc.test.ts` (+ negative), `server/docs-contract.test.ts` |
| 7 Enforcement rule | Each MUST row of the spec names a control; section 14.7 adds `tools/traceability` coverage of `specs/002-phase-b/spec.md` | `server/docs-contract.test.ts`, `tools/traceability/traceability.test.ts` |
| 8 Agent PRs; latency objectives | Phase A rule D26 stands (no pull request unless asked). Performance gates keep the best-of-3 rule for timing only; the new Lighthouse routes use the same harness. Auth and policy micro-budgets are measured (section 15), not gated on shared runners | review, `e2e` step "Lighthouse" |
| 9 Native Apple | Not applicable | none |
| 10 One normaliser per concept | `computeGrants`, `covers`, `canGrantCore`, `matchScope`, `normalizeScopeItem`, `projectUser`, `evaluateAmr`, `safeReturnTo`, `cookieNames`, `redirectUris`, `authorizeRedirectUri`, `BUILTIN_ROLES`, `GRAPH_APP_ROLES`, `parseScryptHash`, the `AADSTS` map, `roleLabelKey`, `permissionLabelKey`, `scopeItemText`, `qualifierLabelKey`, `originText`, `principalLabel` (FR-B-716), the step and result code registries live once in `packages/shared`; on the server `signClientAssertion`, `sealSecret`/`openSecret`, `backoffDelay`, `classifyFailure`, `hashSessionId`, `csrfBindingFor`, `serializeCookie` live once each; amounts are summed from buckets (assignment counts, proof lists) | `shared/single-implementation.test.ts` and `server/single-implementation.test.ts` (source scan; + negative) |
| 11 Web push | Not applicable | none |
| 12 Translation catalogue reads values | The ten new namespaces merge into the catalogues; the Phase A value check (third-script rule) runs on the merged files and on the lazily loaded namespace files | `shared/i18n-catalogue.test.ts` (+ negative), `shared/i18n-fragments.test.ts` |
| 13 `includeSubDomains` | Unchanged; the interstitial and new routes use the same HSTS function | `server/hsts.test.ts`, `server/security-headers.test.ts` |
| 14 AI-crawler policy | Not applicable (`robots.txt` unchanged) | none |
| 15 Sitemap | Not applicable | none |
| 16 Feature work gets its own workspace | Governed by how this work is started; not enforceable | none |
| 17 Agent instructions are client-neutral | Phase B adds no client-specific tooling (no skill, no MCP server) | `agent-instructions-lint` (existing) |

## 4. Dependencies

All versions exact (`save-exact=true`, `catalogMode: strict`), added through `pnpm --filter <package> add <name>@<exact>` under the install protocol of `tools/INSTALL-PROTOCOL.md`; the six pins go into the `catalog:` block of `pnpm-workspace.yaml`. Each production dependency gets a reason row with a reuse / adapt / replace mark in `docs/architecture.md` (FR-B-711).

### 4.1 Additions

| Package | Pin | Kind | Workspace | Why | Mark |
|---|---|---|---|---|---|
| `@azure/msal-node` | 7.0.1 | prod | server | Device-code bootstrap (`PublicClientApplication`) and client-credentials app tokens (`ConfidentialClientApplication` with a `clientAssertion` callback). Not used for sign-in: it adds `offline_access`, caches per account and would be a second assertion signer (B-05, V-B04) | reuse |
| `jose` | 6.2.12 | prod | server | ID-token verification and remote key set (V-B07, V-B08); compact signing inside the certificate holder | reuse |
| `libsodium-wrappers` | 0.8.4 | prod | server | XChaCha20-Poly1305 sealing and key derivation (V-B09). Ships its own types; `@types/libsodium-wrappers` is a deprecated stub and is not added (stack probe P4) | reuse |
| `@peculiar/x509` | 2.1.0 | prod | server | Self-signed certificate creation; `node:crypto` can parse but not create (FR-B-106). Imported lazily, only inside `secrets/x509/` | reuse (adapt: lazy) |
| `reflect-metadata` | 0.2.2 | prod | server | Mandatory polyfill of `@peculiar/x509`'s `tsyringe`; imported first, in the same lazy module, so the global side effect never loads at start (V-B02) | reuse |
| `msw` | 3.0.3 | dev | server, e2e | HTTP simulation of Entra, Graph and Exchange for Vitest and for the e2e server preload (`onUnhandledFrame: 'error'`) | reuse |

Not added (B-12): `@microsoft/microsoft-graph-client`, `undici`, `cookie`, `fast-check`, a UUID library (`crypto.randomUUID`), a scrypt library (`node:crypto`), a PKCE library (32 random bytes and SHA-256).

### 4.2 Transitive surface, advisories and install scripts

- Production tree of the five packages alone: 41 packages, 17 MB, `npm audit` clean on 2026-10-10, no install scripts (V-B03). `@azure/msal-node` brings `jsonwebtoken` (with `jws`, `jwa`, `lodash.*`, `semver`, `ms`) for its own certificate path that this product never uses (`clientCertificate` is never configured; the assertion callback is). That is documented in `docs/architecture.md` and is the reason the image check lists them as expected.
- The X.509 subtree (`@peculiar/*`, `asn1js`, `tsyringe`, `pvtsutils`, `reflect-metadata`, `tslib`) is about 5 MB of the 17. Fallback if an advisory lands or the owner dislikes it: replace `secrets/x509/self-signed.ts` by a DER encoder of about 120 lines (fixed template, no options) and keep the three-parser test (`node:crypto`, `openssl` in CI, and `@peculiar/x509` as a **dev** oracle). That is a one-file change behind the `CertificateFactory` port; ADR-0152 records it.
- `pnpm audit --prod` stays a failing step; Dependabot ignores majors of `@azure/msal-node` (`>=8`), `jose` (`>=7`) and `@peculiar/x509` (`>=3`) and groups the rest weekly (Phase A rule extended).

### 4.3 Layering rules (FR-B-315, tightened by PB-01)

One local ESLint rule file `eslint-rules/rules/layering.js` (the loader builds its entries; `eslint.config.js` does not change) and the import-graph test `server/layering.test.ts` enforce:

| Source folder | May import (beyond relative imports and `@m365portal/shared`) | Must not |
|---|---|---|
| `src/ports/**` | nothing external (types and error classes only) | any I/O module |
| `src/integrations/graph/**`, `.../exchange/**` | global `fetch`, `AbortSignal`, `node:crypto` (`randomUUID` only), ports | `node:http`, `node:https`, `node:net`, `node:tls`, `undici`, `jose`, `@azure/msal-node`, any token decoding |
| `src/integrations/identity/**` | `jose`, `@azure/msal-node`, global `fetch`, `node:crypto` (`randomBytes`, `createHash`, `timingSafeEqual`), ports | `decodeJwt` on anything but an ID token (rule `no-decode-microsoft-tokens`, FR-B-316) |
| `src/secrets/**` | `libsodium-wrappers`, `jose` (compact signing), `node:crypto`, and lazily `@peculiar/x509` plus `reflect-metadata` (only under `secrets/x509/`) | `fetch` |
| `src/setup/**`, `src/connection/**`, `src/auth/**`, `src/rbac/**`, `src/policy/**`, `src/http/**` | ports, repositories, `node:crypto` for `timingSafeEqual`, `randomBytes`, `createHash`, `scrypt` (auth only) | every HTTP, token, sodium and X.509 module; global `fetch` |
| `apps/server/src/**` | everything it needs | any reference to `fake-tenant`, `msw`, a `TEST_*` environment branch (FR-B-707 `server/no-test-hooks.test.ts`) |

`no-restricted-globals` forbids `fetch` outside `integrations/**`. The fixture file `tools/lint-canary/cases/layering.case.ts` imports `node:https` from a service and must make the lint fail (the canary is how this guard is seen failing).

## 5. Module layout

New and changed paths only. Owner streams (5.7) are in the last column of 5.6; one owner per file.

### 5.1 Server (`apps/server/src`)

```text
ports/                         # interfaces and error classes, no I/O (section 8)
  graph.ts  provisioner.ts  exchange.ts  identity.ts  secrets.ts  clock.ts  errors.ts
integrations/
  http/json-fetch.ts           # the one fetch wrapper: timeout, size cap, redirect:'error', header allow-list, redaction
  graph/{graph-http.ts, graph-client.ts, provisioner.ts, retry.ts, cache.ts, schemas.ts, errors-map.ts}
  exchange/{admin-api-client.ts, schemas.ts}
  identity/{app-token.ts, bootstrap.ts, oidc-client.ts, id-token.ts, jwks.ts, tenant-metadata.ts,
            client-assertion.ts, aadsts.ts, token-endpoint.ts}
secrets/
  {app-key.ts, sealed-box.ts, secret-store.ts, certificate-holder.ts, rotate.ts, state.ts}
  x509/self-signed.ts          # lazy: `await import('./x509/self-signed.js')` from certificate service only
setup/                         # AppModule `setup` (and the Phase B part of the unlocked wizard)
  {module.ts, routes.ts, state.ts, token.ts, unlock-limiter.ts, session.ts, availability.ts,
   loopback-guard.ts, environment.ts, runner.ts, lease.ts, run-context.ts, log.ts, proof.ts,
   manual-mode.ts, finish.ts, repair.ts}
  steps/{connect.ts, verify.ts, configure/{application.ts, service-principal.ts, certificate.ts,
         application-settings.ts, graph-permissions.ts, exchange-permissions.ts, exchange-role.ts}}
connection/                    # AppModule `connection`
  {module.ts, routes.ts, service.ts, cert-expiry.ts}
auth/                          # AppModule `auth`
  {module.ts, routes.ts, login-transactions.ts, callback.ts, interstitial.ts, principal.ts,
   session-store.ts, sessions.ts, revalidate.ts, step-up.ts, logout.ts, break-glass.ts,
   password-hash.ts, mfa.ts, cookies.ts}
rbac/                          # AppModule `rbac`
  {module.ts, routes.ts, repository.ts, assignment-service.ts, membership.ts, grants.ts,
   restore-owner.ts, builtin-check.ts}
policy/                        # Phase A folder, extended
  {actor.ts, authorize.ts, scoped.ts, can-grant.ts, resolvers/{anonymous.ts, setup.ts, session.ts}}
cli.ts + cli/commands/{generate-app-key.ts, setup-token.ts, rotate-app-key.ts, hash-password.ts,
                       setup-reopen.ts}            # `verify-audit` stays
db/{check-macros.ts, schema/phase-b.ts}            # CHECK helpers shared by schema.ts and the migration
```

`modules.ts` appends, in start order: `secretsModule`, `setupModule`, `connectionModule`, `authModule`, `rbacModule` (Phase A's `brandingModule` keeps its position; modules start in list order and stop in reverse).

### 5.2 Shared (`packages/shared/src`)

```text
rbac/{resources.ts, roles.ts, scope.ts, effective.ts, covers.ts, qualifier.ts}   # computeGrants, covers, canGrantCore, matchScope, normalizeScopeItem, projectUser, BUILTIN_ROLES, TEMPLATES, SCOPE_MATRIX
auth/{cookies.ts, redirect-uri.ts, return-to.ts, amr.ts, signin-errors.ts}       # cookieNames, redirectUris, authorizeRedirectUri, safeReturnTo, evaluateAmr, sign-in and no-access code registries
setup/{steps.ts, result-codes.ts, graph-roles.ts, desired-state.ts, log-keys.ts, backoff-constants.ts, node-version.ts}
schemas/{setup.ts, connection.ts, auth.ts, rbac.ts}  + schemas/meta.ts (changed)
i18n/fragments/{setup,connection,signin,noaccess,access,role,permission,session,breakglass,scope}.{en,nl}.json
permissions.ts (+ PERMISSION_RESOURCE map)  limits.ts (+ rows)  problem.ts (+ 19 codes)
```

`package.json` `exports` gains the wildcard subpaths `./rbac/*`, `./auth/*`, `./setup/*` (TA-05 style, no barrels).

### 5.3 Web (`apps/web/src`)

```text
routes/{signin.tsx, no-access.tsx (Phase A, extended), setup.tsx, setup.$.tsx (404 target), break-glass.tsx,
        settings.connection.tsx, settings.access.tsx, settings.restore-access.tsx}
features/setup/{TokenForm.tsx, Wizard.tsx, StepList.tsx, EnvironmentStep.tsx, ConnectStep.tsx, DeviceCodePanel.tsx,
                ManualMode.tsx, ConfigureStep.tsx, VerifyStep.tsx, FinishStep.tsx, LogRegion.tsx,
                useRunPolling.ts, setup-api.ts}
features/connection/{ConnectionPage.tsx, CertificateCard.tsx, ProofList.tsx, RepairPanel.tsx}
features/auth/{SignInPage.tsx, SignInError.tsx, NoAccessReason.tsx, PersonaMenu.tsx, SessionTimers.tsx,
               StepUpDialog.tsx, BreakGlassForm.tsx, BreakGlassBanner.tsx, session-store.ts}
features/access/{AccessPage.tsx, EffectivePermissions.tsx, ScopeText.tsx}
lib/{ms-url.ts, auth-nav.ts}                       # new; lib/api.ts, lib/commands.ts, lib/storage.ts extended
```

### 5.4 e2e, scripts, docs

```text
e2e/support/{ports.ts, fake-tenant-server.ts, server-preload.mjs, global-setup.ts, principals.ts, sign-in.ts, cross-site-link.ts}
e2e/tests/{setup-gate, setup-wizard, setup-manual, setup-lock, setup-redirect, signin, auth-logout, stepup,
           session-timeout, break-glass, nav-gating, access, connection, connection-repair, degraded-secrets,
           csp, a11y (extended), keyboard (extended), visual (extended), fixtures-selftest}.spec.ts
scripts/image-smoke.ts (extended)  scripts/check_image_contents.py (extended)
docs/{README, security, permissions, operations, architecture, open-points}.md  docs/adr/0101-0126, 0151-...  docs/phase-reports/phase-B.md
```

### 5.5 Test folders

`apps/server/test/{setup,auth,rbac,secrets,connection,integrations,fakes,exchange}/` and `packages/shared/test/` as the spec lists. The fakes (`test/fakes/`) are shared by Vitest, the e2e support code (imported as TypeScript through `tsx`) and the image smoke test (not used there: the image runs against the network).

### 5.6 Phase A files that Phase B edits (the only cross-territory edits)

Each row has exactly one Phase B owner and is applied by one task after the Phase A gate (`T-B-001` re-checks the file exists as planned). "AM" numbers continue the spec's list (AM-01 to AM-16).

| File (Phase A owner) | Phase B edit | AM | Owner |
|---|---|---|---|
| `apps/server/src/modules.ts` (S1) | append the five module factories (empty stubs first, so the other streams fill their own module files) | AM-01 | S-B1 |
| `apps/server/src/config/*` (S1) | the 14 variables, cross-field rules, removal of `PREVIEW_MODE*` with the one warning, posture line | AM-05 | S-B1 |
| `apps/server/src/audit/{writer,vocabulary,allowlist}.ts` (S1; Phase A `T-A-039` lists `audit/{canonical,chain,writer,head-log,index}.ts`, so `vocabulary.ts` and `allowlist.ts` are new files or the same content split out of `writer.ts`, which `T-B-001` settles when it reads the code) | actor kinds `user`, `setup`, `break_glass`, `cli` (write enum) and `preview` kept as a **read** kind for old rows; the 19 actions and 38 new detail keys of spec 6.9.6 (data-model.md section 10) | AM-04 | S-B1 |
| `apps/server/src/lifecycle/*` (S1) | readiness check `secrets`; start hooks order; bootstrap object cleared at shutdown | AM-11 | S-B1 |
| `packages/shared/src/{problem,limits}.ts` (S1) | the 19 problem codes with messages; the limit rows | AM-13 | S-B1 |
| `apps/server/src/db/*`, `drizzle/`, `schema-snapshots/` (S1) | `schema/phase-b.ts`, migration `0001_phase_b`, snapshot 1, manifest entry, `check-macros.ts` | AM-06 | S-B1 |
| `apps/server/src/http/route.ts` and the route table (S1) | access union `public \| authenticated \| permission(stepUp, scoped, unscopedReason, actorKinds) \| setup \| connection`; classes `auth`, `setup`; `x-step-up`, `x-scoped`; availability gate; scoped tracking | AM-02 | S-B5 |
| `apps/server/src/policy/*` (S1) | `Actor` kinds and `grants`, resolvers, `authorize`, `visibleScopes`, `canGrant`; preview resolver deleted | AM-03 | S-B5 |
| `apps/server/src/http/csrf.ts` (S1) | binding read from `actor.csrfBinding` | AM-07 | S-B5 |
| `apps/server/src/http/{rate-limit,cache-headers}.ts` (S1) | classes `auth` and `setup`; no-store route list; `Set-Cookie` discipline | AM-12 | S-B4 |
| `apps/server/src/routes/meta.ts`, shell boot data (S1, S2) | `MeResponse` of FR-B-413 with the real actor; `features.breakGlass`; header `X-Session-Idle-Expires` | AM-08 | S-B4 |
| `packages/shared/src/schemas/meta.ts` (S1) | new `MeResponse`, `Session`, `SetupSummary` | AM-08 | S-B4 |
| `packages/shared/src/permissions.ts` (S1) | `PERMISSION_RESOURCE` map next to the 15 entries | AM-03 | S-B5 |
| `packages/shared/package.json` (S0) | exports `./rbac/*`, `./auth/*`, `./setup/*` | AM-18 | S-B1 |
| `packages/shared/src/i18n/*` (S4) | `loadNamespace(locale, namespace)` additive API; lazy namespace files generated by the merge script | AM-21 | S-B6 |
| `apps/web/src/{routes/__root.tsx, components/shell/*, lib/api.ts, lib/commands.ts, sw/routing.ts, boot/*}` (S4) | auth-aware root guard, persona menu, break-glass banner, 401 and step-up handling, Settings entries by permission and actor kind, SW pass-through for `/auth/` and `/api/`, boot re-check | AM-09, AM-12 | S-B6 |
| `apps/web/src/routes/settings.tsx` (S4) | overview gets Connection and Access cards | AM-09 | S-B6 |
| `eslint-rules/*`, `tools/lint-canary/*` (S0) | rules `layering`, `no-decode-microsoft-tokens` with canary cases | AM-17 | S-B2 |
| `tools/traceability/*` (S9) | also scan `specs/002-phase-b/spec.md` | AM-23 | S-B7 |
| `Dockerfile`, `docker-compose.yml`, `.env.example`, `scripts/{image-smoke.ts,check_image_contents.py}` (S6) | secrets stanza, new variables, extended smoke and content checks | AM-14 | S-B7 |
| `e2e/{playwright.config.ts,fixtures.ts,routes.ts}`, Phase A specs (S9) | topology replaced, specs migrated | AM-10 | S-B7 |
| `docs/*`, `apps/server/test/{docs-contract,limits-doc}.test.ts` (S8) | content per section 16; ADR check accepts the numbered blocks 0101 to 0126 and 0151 onward | AM-14, AM-22 | S-B7 |

### 5.7 Streams, territories and waves (input to `tasks.md`)

| Stream | Goal | Owns | Needs |
|---|---|---|---|
| **S-B1** Platform | persistence, config, secrets, CLI, audit/limits/problem extensions | rows of 5.6 marked S-B1; `src/secrets/**`, `src/cli/**`; `test/secrets/**`, `test/cli.test.ts`, `test/config.test.ts`, `test/migrations*.test.ts`, `test/schema-parity.test.ts`; shared `setup/node-version.ts`, `auth/cookies.ts` (cookie names are needed by config and CLI first) | Phase A gate |
| **S-B2** Microsoft clients | ports, `integrations/**`, fake tenant, layering rules | `src/ports/**`, `src/integrations/**`, `test/{integrations,fakes,exchange}/**`, `test/layering.test.ts`, `test/no-test-hooks.test.ts`; shared `setup/graph-roles.ts`, `auth/redirect-uri.ts`, `auth/amr.ts`; AM-17 | S-B1 persistence and secrets ports |
| **S-B3** Setup engine | gate, wizard, connection | `src/setup/**`, `src/connection/**`, `test/{setup,connection}/**`; shared `setup/{steps,result-codes,desired-state,log-keys,backoff-constants}.ts`, `schemas/{setup,connection}.ts` | S-B1, S-B2 |
| **S-B4** Sign-in | OIDC, sessions, break-glass, cookies | `src/auth/**`, `test/auth/**`; shared `auth/{return-to,signin-errors}.ts`, `schemas/auth.ts`; rows of 5.6 marked S-B4 | S-B1, S-B2, S-B5 (actor resolvers) |
| **S-B5** RBAC and policy | model, algorithms, assignment API, policy layer | `src/rbac/**`, `src/policy/**`, `test/rbac/**`, `test/policy*.test.ts`, `test/route-table.test.ts`; shared `rbac/**`, `schemas/rbac.ts`; rows marked S-B5 | S-B1 |
| **S-B6** Web | wizard, sign-in, settings pages, shell changes, i18n | `apps/web/src/{features/*,routes/*}` rows above; `apps/web/test/**` for them; the ten i18n fragment pairs | S-B3/S-B4/S-B5 contracts (schemas) |
| **S-B7** Docs, CI, e2e, image | proof | docs, e2e, scripts, deploy files | all, test-first against the spec |

Waves: **W0** `T-B-001` (re-read of Phase A, VERSION bump, dependency install, S-B1 platform tasks including migration and stubs); **W1** S-B2 ports and fake tenant, S-B5 shared algorithms (pure), S-B1 secrets and CLI, S-B7 fixtures and docs skeleton; **W2** S-B3 engine, S-B4 sign-in, S-B5 policy and API; **W3** S-B6 web, S-B7 e2e against the fakes; **W4** image smoke, docs, report; **gate** `T-B-999` with nothing behind it. The critical path is migration -> ports and fake tenant -> actor resolvers -> sign-in callback -> setup completion on first sign-in -> e2e wizard and sign-in.

## 6. Server architecture changes

### 6.1 Start sequence (extends Phase A plan 7.1; FR-B-714)

Phase A steps keep their numbers; Phase B inserts are marked `+`.

1. Parse the environment with the one Zod schema. `+` The 14 new variables and their cross-field rules (spec 6.9.1, FR-B-101); `PREVIEW_MODE`/`PREVIEW_MODE_ALLOW_REMOTE` present: one warning `preview_mode_removed` naming the variable, no effect. `APP_KEY` and `APP_KEY_FILE` set together is `config_invalid`; **neither set is valid here** (FR-B-213 reports it in the wizard). The key itself is not read at this step.
2. Umask 0077; locate the shell template.
3. Storage probe; degraded mode as in Phase A (then skip every `+` step that needs the database and go to step 9).
4. Open the database; run the migration wrapper (applies `0001_phase_b` once).
5. `+` Singleton rows: `INSERT OR IGNORE` of `setup_state` (state `unconfigured`, fresh 128-bit `install_id`), then `rbac/builtin-check.ts` compares the seeded roles and permissions with `BUILTIN_ROLES`; a difference exits non-zero with `builtin_roles_mismatch` (the database was tampered with or a migration is missing).
6. `+` Secrets: `await sodium.ready`; read the key (`APP_KEY` or the file, at most 1,024 bytes); validate (7.1). No key: state `key_missing`; invalid: `key_invalid`; with a key and an `active` or `pending` certificate: decrypt the key of the **active** certificate and build the `CertificateHolder`; failure is `certificate_unreadable`. All three are *degraded*, not fatal (FR-B-108). `APP_KEY_PREVIOUS` opens rows still on the previous key and logs `app_key_previous_in_use` until the rotation is finished.
7. `+` Setup: when the state is not `completed`, ensure the setup token exists (9.3 and 7.7; `SETUP_TOKEN` wins over the file; the file is created with `O_EXCL`, mode 0600, from 32 random bytes) and log only the `docker exec` hint. When the state is `completed` and a token file exists, delete it (a crash between commit and unlink). Reset every `running` and `waiting` `setup_step` row to `pending`, and, while the state is not `completed`, every `connect` row of mode `automatic` too (the bootstrap token lived in memory only). Release a stale runner lease.
8. `+` Clients: with secrets available and a pinned `tenant_connection`, build the identity, Graph and Exchange clients (`ClientsRegistry`); schedule the hourly JWKS reload and a best-effort first reload that never blocks listening.
9. Branding start hook (Phase A), build the app, route-table check, listen; the posture line additionally reports without values: setup state, secrets state, whether break-glass is enabled, MFA policy on or off, days to certificate expiry when 60 or fewer.
10. Signal handlers; `+` sweepers: expired sessions hourly, login transactions every minute, unlock and break-glass counters by their own windows.

Shutdown (additive to Phase A 7.4): reject new setup runs; cancel an active run (it stops at its next checkpoint, `running` rows return to `pending`); clear and drop the bootstrap object; drop in-memory login transactions and setup sessions; release the lease; then the Phase A drain.

### 6.2 Composition

`buildApp(deps)` (Phase A) receives `deps` extended with ports, never concrete classes:

```ts
interface AppDeps {
  config: Config;  db: Db;  clock: Clock;  random: RandomSource;  scheduler: Scheduler;  logger: Logger;
  audit: AuditWriter;  secrets: SecretsState;            // { status: 'ok'|'key_missing'|'key_invalid'|'certificate_unreadable'|'no_certificate', holder? }
  clients: ClientsRegistry;                              // graph(), exchange(), oidc(), appTokens(): throws SecretsUnavailableError or NotConnectedError
  provisionerFactory: (bearer: BearerTokenProvider) => TenantProvisioner;
  bootstrapFactory: (opts: BootstrapOptions) => BootstrapAuthenticator;
}
```

`Clock { now(): number }`, `RandomSource { bytes(n): Uint8Array; float(): number }` and `Scheduler { setTimeout, setInterval, clear }` are the only sources of time and randomness in the new code (no `Date.now`, `Math.random` or global timers: a lint canary case enforces it for `src/{setup,auth,rbac,integrations,secrets}`). `ClientsRegistry.reload()` rebuilds the clients after a certificate swap in repair. The modules receive `deps` in `routes(deps)` and `start(ctx)` as in contract C5.

### 6.3 Request pipeline changes (extends Phase A 7.2)

| # | Stage | Phase B change |
|---|---|---|
| 1 | Request context | none; the client key is also the key of the setup and break-glass counters |
| 1b | **Availability gate** (new, routes flagged `availability: 'setupOpen'` and `breakGlass`) | Before the rate limiter. When the setup state is `completed`, or the loopback guard fails (http base URL and non-loopback `Host`, or `Forwarded`/`X-Forwarded-*`/`X-Real-IP` present), or break-glass is not configured, the gate consumes **one token of the `read` bucket** (what the unknown-path fallback consumes) and answers through the same `notFound` function as an unknown `/api` path or, for page navigations, renders the shell with status 404. Byte-for-byte equality except `requestId` and `X-Request-Id` (FR-B-207) |
| 6 | Rate limit | classes `auth` and `setup` (capacity 10, refill 0.2/s); GETs of the wizard poll the `read` class |
| 9b | **CSRF binding** (new, before Origin and CSRF) | The binding is computed from the cookies the browser sent, with no database access: the SHA-256 hex of the session cookie value and of the setup cookie value, joined by `.` when both are present, empty when neither (10.5). So a cross-site request still learns nothing before Origin and CSRF are checked |
| 10 | Origin, CSRF | unchanged apart from the binding; `GET /auth/*` carry no token (no state change besides the in-memory transaction and cookies) |
| 11 | Authorisation | the actor is resolved here (cookie to `Actor`, one indexed read), then in this order: access kind check -> 401 for anonymous or expired -> actor kind filter -> `authorize(permission)` -> 403 `permission_denied` -> `stepUp` check -> 403 `step_up_required`. Every denial of a write, and of a permissioned read for an authenticated actor, is audited before the response; a failed append answers 503 (FR-B-602) |
| 13 | Handler | `ctx.actor`, `ctx.authorizeResource(permission, resource)`, `ctx.visibleScopes(permission)`; a `scoped` route that returns 2xx without calling either becomes 500 `policy_not_applied`, audited as `error` (11.8) |
| 14 | Response | `Cache-Control: no-store` on the route families of FR-B-417; `Set-Cookie` only where a cookie is set or cleared; header `X-Session-Idle-Expires` on every response of an authenticated session (PB-16) |

### 6.4 Configuration notes beyond the spec table

- `PUBLIC_BASE_URL` is parsed once into `{origin, https, host, redirectUri, redirectUris}` by the shared functions (`redirectUris`, `authorizeRedirectUri`, `cookieNames`); no other code builds those strings.
- Reading `APP_KEY_FILE` belongs to step 6 of the start sequence, not to configuration parsing, so that an unreadable file is a degraded `app_key_missing` and not an exit.
- `SETUP_TOKEN`, when set, is validated by the schema (24 to 128 characters of `A-Z a-z 0-9 - _ . ~`, at least 12 distinct) and then only ever compared through digests.
- Every duration variable is converted to milliseconds once in `config/derived.ts` and handed to modules as numbers; modules never read `process.env`.

### 6.5 Degraded combinations

| Condition | `/healthz` | `/readyz` | Behaviour |
|---|---|---|---|
| Storage unusable (Phase A) | 200 | 503 `data_dir_not_writable` or similar | Every route that needs storage answers 503 `storage_unavailable`; setup token file not created (EB-33); `/api/v1/me` and `/api/v1/csrf` answer as anonymous |
| State `completed`, key missing or invalid, or certificate unreadable | 200 | 503 check `secrets` with code `app_key_missing`, `app_key_invalid` or `certificate_unreadable` | Sign-in and every Graph/Exchange use answer 503 `secrets_unavailable`; static UI, `/signin` (with the explanation), break-glass and Settings pages without Graph work; the banner names the cause and the remedy (EB-12) |
| State not `completed`, key missing or invalid | 200 | 200 | The wizard's `app_key` check fails and blocks step 2; nothing else breaks |
| State `completed` but no pinned tenant (cannot happen through the product) | 200 | 200 | Sign-in answers 409 `setup_required`; the operator runs `setup-reopen` |
| Certificate expired | 200 | 200 | Token requests fail `invalid_client`; sign-in shows `temporarily_unavailable` and the Settings banner is critical (EB-13) |

## 7. Secrets and the certificate

### 7.1 `APP_KEY`

Source: `APP_KEY`, or the content of the file `APP_KEY_FILE` names (at most 1,024 bytes, UTF-8, one trailing `\n` or `\r\n` removed). Parsing (`secrets/app-key.ts`, pure, tested with vectors):

1. 64 characters of `[0-9a-fA-F]`: hexadecimal.
2. Otherwise 43 characters, or 44 characters ending in one `=`, over **one** alphabet: standard (`A-Za-z0-9+/`) or URL-safe (`A-Za-z0-9_-`). A string that mixes `+/` with `-_` is invalid.
3. The decoded length must be exactly 32 bytes and re-encoding must reproduce the input (canonical: this rejects non-zero trailing bits).
4. Rejected: all 32 bytes equal; fewer than 16 distinct byte values.

Vectors (normative, from V-B09): the 32 bytes `00 01 02 ... 1f` are written `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` (base64), `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` (base64url), `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` (hex); all three give key id `c743d54d05bd4d72`. `generate-app-key` prints the padded base64 form and a newline, nothing else.

Key id: the first 8 bytes, as 16 lower-case hex characters, of SHA-256 over the ASCII string `m365portal-key-id` followed by the 32 key bytes. It is stored in `secret.key_id` and may be logged. The key and anything derived from it never appear in a log line, error message, problem body, `/readyz`, audit entry or the shell; all errors of this module carry only a code.

### 7.2 Envelope (FR-B-105)

```text
subkey      = crypto_kdf_derive_from_key(32, 1, "m365sec1", APP_KEY)
nonce       = randombytes_buf(24)                              (fresh per encryption)
AD          = "m365portal/secret/v1" 0x1F purpose 0x1F secretId 0x1F keyId     (UTF-8; 0x1F is the unit separator)
blob        = 0x01 || nonce(24) || crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, AD, null, nonce, subkey)
```

`secretId` is the GUID of the `secret` row, `purpose` is `certificate_key`, `keyId` is the 16-character key id. Opening reads the version byte (anything but `0x01` is `SecretDecryptError`), splits nonce and ciphertext, rebuilds the AD from the **row's** columns, and decrypts; any failure is the one typed `SecretDecryptError` with no plaintext and no distinction between wrong key, wrong row and tampering.

Known-answer test (normative; `server/secrets/sealed-box.test.ts` must reproduce it byte for byte): key `00..1f`; nonce bytes `a0 a1 ... b7`; plaintext ASCII `m365portal known answer`; purpose `certificate_key`; secretId `11111111-1111-4111-8111-111111111111`; keyId `c743d54d05bd4d72`. Subkey `0ce1b14c2cbc664400863c884abe7919cb64d0d6a539634af4408d351ee58afd`; blob (64 bytes) `01a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7e4dda898cb2cb501edb6873ad4598962c113f4220ca5b313df10f8081a10de3c75bf7361349014`.

Memory hygiene: every plaintext and subkey buffer is passed to `sodium.memzero` in a `finally`. This is best effort in a garbage-collected runtime and is documented as such in `docs/security.md`.

### 7.3 Certificate generation (FR-B-106; library per PB-02)

`secrets/x509/self-signed.ts`, loaded with a dynamic `import()` only when a certificate is created (wizard step 3, manual mode step 2, repair). First line `import 'reflect-metadata'`, then `@peculiar/x509`.

| Field | Value |
|---|---|
| Key pair | WebCrypto `RSASSA-PKCS1-v1_5`, `SHA-256`, modulus 2048, public exponent 65537, extractable only so the PKCS#8 export can be sealed |
| Certificate | X.509 v3, signature `sha256WithRSAEncryption`, issuer = subject = `CN=M365Portal <first 8 hex of install_id>` |
| Serial | 16 random bytes, top bit cleared, first byte forced non-zero |
| Validity | `notBefore` = now minus 5 minutes (injected clock), `notAfter` = `notBefore` + 360 days; the same two instants are sent as `startDateTime` and `endDateTime` |
| Extensions | `basicConstraints` cA=false (critical), `keyUsage` digitalSignature (critical); nothing else |
| Outputs | `publicDer` (Buffer), `pkcs8Der` (Buffer, sealed at once, then zeroed), thumbprints SHA-1 (40 hex) and SHA-256 (64 hex) of the DER |

Sequence in `CertificateService.create()` (one transaction after generation): insert `secret` (sealed key), insert `certificate` with state `pending`; audit `secrets.certificate.create` in the same transaction. The PKCS#8 buffer is zeroed in `finally`. Whether Entra accepts exactly these extensions is U47 (OV-03/OV-04).

### 7.4 The holder and the assertion signature

`CertificateHolder` is built from the decrypted PKCS#8 DER with `crypto.createPrivateKey({key, format:'der', type:'pkcs8'})`; the buffer is zeroed and the `KeyObject` stays in the closure of the holder. It exposes `thumbprintSha1`, `thumbprintSha256`, `notAfter`, `publicDer` and `signCompact(protectedHeader, payload)` (the `CompactSigner` port, implemented with `jose`'s `CompactSign`, algorithm `PS256`). It has no method that returns the key, a PEM or a PKCS#8 export; `toJSON`, `toString`, `[util.inspect.custom]` and `[Symbol.toPrimitive]` return `[redacted]`.

`signClientAssertion` (in `integrations/identity/client-assertion.ts`, the only code that builds an assertion) creates header `{alg:'PS256', typ:'JWT', 'x5t#S256': base64url(SHA-256(DER))}` (and `x5t` only when the fallback switch of FR-B-112 is on) and claims `{aud: tokenEndpoint, iss: clientId, sub: clientId, jti: randomUUID(), iat: now, nbf: now, exp: now + 300}` and asks the holder to sign. `aud` is `config.tokenEndpoint` from MSAL's callback, or `https://login.microsoftonline.com/<tid>/oauth2/v2.0/token` for the sign-in code exchange (V-B04). This clarifies FR-B-112 (SB-12): header and claims are built in one place; the compact signature is produced inside `secrets/` so the key never crosses the module boundary.

### 7.5 Rotation procedure (FR-B-109)

Operator steps (documented in `docs/operations.md`, nl and en):

1. Back up `/data` (the CLI also takes a database copy). 2. `docker exec <c> /nodejs/bin/node /app/dist/cli.js generate-app-key` to obtain a new key. 3. Stop the container, set `APP_KEY_PREVIOUS` to the old key and `APP_KEY` to the new one (or the `_FILE` pair for Docker secrets). 4. Start: the server opens rows with the previous key, logs `app_key_previous_in_use`. 5. Run `node dist/cli.js rotate-app-key`. 6. Remove `APP_KEY_PREVIOUS`, restart.

`rotate-app-key` algorithm: refuse unless setup is not running a run; validate both keys; copy the database with the SQLite backup API to `backups/pre-rotate-<UTC>.sqlite` (the newest 3 are kept, like `pre-migrate-*`; data-model.md section 2); then in one `BEGIN IMMEDIATE` transaction: for each `secret` row, choose the key by the stored `key_id` (neither matches: abort, nothing changed), skip rows already on the new key, decrypt, re-seal with a fresh nonce and the new key id under the **same** `secret.id` and purpose, update `blob` and `key_id`; audit `secrets.app_key.rotate` (actor `cli`, detail `rows`, `fromKeyId`, `toKeyId`) in the same transaction. Idempotent: a second run changes nothing and prints `0 rows`. Recovery when the old key is gone: a new certificate through repair with an administrator (RB-07); there is no backdoor.

### 7.6 Other secrets and what never leaves memory

| Value | Lifetime | Where |
|---|---|---|
| Bootstrap access/refresh/ID token | wizard run, discarded before the propagation probes (FR-B-215) | MSAL in-memory cache of one `PublicClientApplication` |
| Device code and user code | until the device flow ends | memory of the bootstrap object; the user code is shown, the device code is never returned |
| Authorization code, `state`, `nonce`, PKCE verifier | one login transaction, at most 600 s | memory map; verifier never leaves the server |
| ID token | the duration of the callback | local variable; only the claims of FR-B-406 survive |
| Session id | the cookie; the database holds its SHA-256 | cookie and hash |
| Setup token | until `completed` | env, or the 0600 file; compared via SHA-256 digests with `timingSafeEqual` |
| Break-glass password | one verification | request body (4,096-byte cap); the hash is in an env variable |
| App-only access tokens (Graph, Exchange) | MSAL in-memory cache until expiry | never decoded, never logged |

### 7.7 CLI contract (FR-B-110)

`dist/cli.js <command>` (the entry that exists for `verify-audit`); exit 0 success, 1 refusal, 2 bad usage; results on standard output only; the logger is never used for secrets.

| Command | Reads | Writes | Output |
|---|---|---|---|
| `generate-app-key` | nothing | nothing | one line, padded base64 |
| `setup-token` | env `SETUP_TOKEN` or the file (creates it with `O_EXCL` if setup is open and none exists) | the token file | the token and a newline; exit 1 with a message when the state is `completed` |
| `rotate-app-key` | env keys, database | database, backup, audit | `rows: n` |
| `hash-password` | the password from standard input without echo | nothing | the `scrypt:<N>:<r>:<p>:<salt>:<hash>` line; N=131072, r=8, p=1, 16-byte salt, 32-byte hash (SB-04); refuses (exit 1, no output) a password of fewer than 14 characters or with fewer than 6 distinct characters (FR-B-110) |
| `setup-reopen --confirm` | database | state `in_progress`, a new token file, audit `setup.reopen` (actor `cli`) | next steps; without `--confirm` it only explains; refuses (exit 1) while `SETUP_TOKEN` is set in the environment, so the old value cannot govern the reopened wizard (FR-B-223); sign-ins are refused until the wizard has finished (`setup_required`) |
| `verify-audit` | database (read-only) | nothing | Phase A output |

Because the CLI runs in a second process on the same SQLite file it opens the database with the same PRAGMAs, uses `BEGIN IMMEDIATE`, and the server re-reads `setup_state` on every request (no cache), so a reopen takes effect at once.

## 8. Microsoft clients

### 8.1 Ports (`apps/server/src/ports`)

Services, routes and repositories see only these types. Implementations live in `integrations/**` and `secrets/**` (4.3).

```ts
// graph.ts - app-only, runtime. Phase C adds methods; Phase B never adds a write method.
interface GraphClient {
  getOrganization(): Promise<OrganizationInfo>;                      // { id, displayName|null, initialDomain|null, defaultDomain|null }
  probeUsers(): Promise<void>;                                       // GET /users?$top=1&$select=id
  getUser(idOrUpn: string, o?: CallOptions): Promise<DirectoryUser | null>;   // null on 404
  checkMemberGroups(userId: Guid, groupIds: readonly Guid[], o?: CallOptions): Promise<ReadonlySet<Guid>>;
  searchGroups(prefix: string, top: number): Promise<DirectoryGroup[]>;
  getGroup(id: Guid): Promise<DirectoryGroup | null>;                // null on 404
}
interface CallOptions { priority?: 'high' | 'low'; budget?: 'interactive' | 'wizard'; signal?: AbortSignal }

// provisioner.ts - delegated, wizard only; cannot be constructed without a live bearer provider.
interface TenantProvisioner {
  findServicePrincipalByAppId(appId: Guid): Promise<ServicePrincipalInfo | null>;      // with appRoles for the two resources
  getApplication(objectId: Guid): Promise<ApplicationInfo | null>;
  findApplicationsByDisplayName(name: string): Promise<ApplicationInfo[]>;
  createApplication(body: ApplicationCreateBody): Promise<ApplicationInfo>;
  patchApplication(objectId: Guid, patch: ApplicationPatch): Promise<void>;
  readKeyCredentials(objectId: Guid): Promise<KeyCredentialInfo[]>;                    // $select=keyCredentials (single-object read returns `key`)
  createServicePrincipal(appId: Guid): Promise<ServicePrincipalInfo>;
  listAppRoleAssignments(servicePrincipalId: Guid): Promise<AppRoleAssignmentInfo[]>;
  grantAppRole(resourceSpId: Guid, principalSpId: Guid, appRoleId: Guid): Promise<AppRoleAssignmentInfo>;
  listDirectoryRoleAssignments(principalId: Guid): Promise<DirectoryRoleAssignmentInfo[]>;
  createDirectoryRoleAssignment(principalId: Guid, roleDefinitionId: Guid): Promise<DirectoryRoleAssignmentInfo>;
}
type BearerTokenProvider = () => Promise<string>;                  // refreshes silently inside the bootstrap object

// exchange.ts - Phase B: documented read path only.
interface ExchangeClient {
  capabilities(): { read: readonly ('organizationConfig' | 'distributionGroupMembers')[]; write: readonly [] };
  probe(o?: { skipCache?: boolean }): Promise<ExchangeProbeResult>;
  getOrganizationConfig(select?: readonly string[]): Promise<ExchangeOrganizationConfig>;  // { name, guid, ...documented properties }
  listDistributionGroupMembers(identity: string, o?: { resultSize?: number }): AsyncIterable<ExchangeRecipient>;
}
interface ExchangeProbeResult { status: 'ok' | 'not_ready' | 'unavailable'; httpStatus: number | null; roleEffective: 'yes' | 'no' | 'unknown'; previewAvailable: 'yes' | 'no' | 'unknown' }

// identity.ts
interface AppTokenProvider { get(resource: 'graph' | 'exchange', o?: { skipCache?: boolean }): Promise<AccessToken> }   // AccessToken.reveal() only inside the HTTP layer
interface OidcClient {
  buildAuthorizeUrl(p: { state: string; nonce: string; codeChallenge: string; prompt?: 'login' | 'select_account' }): URL;
  exchangeCode(p: { code: string; codeVerifier: string }): Promise<{ idToken: string }>;
  validateIdToken(raw: string, p: { nonce: string }): Promise<ValidatedIdToken>;     // throws IdTokenError(check)
  endSessionUrl(): Promise<URL>;
}
interface BootstrapAuthenticator {
  start(o: { tenantHint?: string }): Promise<DeviceCodeInfo>;        // { userCode, verificationUri, expiresAt, intervalSeconds }
  completion(): Promise<BootstrapIdentity>;                          // { tid, oid, upnLabel, nameLabel }; rejects with DeviceCodeError
  bearer(): BearerTokenProvider;  cancel(): void;  discard(): void;
}
interface CompactSigner { signCompact(protectedHeader: Record<string, unknown>, payload: Uint8Array): Promise<string> }   // implemented by CertificateHolder
```

DTOs are Zod-parsed allow-lists (unknown fields dropped, strings capped at 256 bytes); a property a call did not return is `null`, never invented (U36).

### 8.2 Error taxonomy

All classes carry a stable `code`, `retryable`, optional HTTP `status`, `retryAfterMs`, a Graph error `code` matching `^[A-Za-z0-9_.]{1,64}$`, the correlation ids of the response and the `AADSTS` number (digits only). They never carry a token, a header value, a request body or free text from Microsoft (SB-05).

| Family | Classes | Source | Retried inside the client |
|---|---|---|---|
| Graph | `GraphBadRequestError` 400, `GraphUnauthorizedError` 401, `GraphForbiddenError` 403, `GraphNotFoundError` 404, `GraphConflictError` 409, `GraphThrottledError` 429 (only after the wait would exceed 60 s), `GraphTransientError` 500/502/503/504, `GraphNetworkError` | `GraphHttp` | 429 (honour `Retry-After`), 503 and 504 for idempotent calls; nothing else |
| Exchange | `ExchangeUnauthorizedError` 401, `ExchangeForbiddenError` 403, `ExchangeBadRequestError` 400, `ExchangeThrottledError` 429, `ExchangeTransientError`, `ExchangeNetworkError`, `ExchangeUnavailableError` (other 4xx or an unreadable envelope), `ExchangeUnsupportedError` (client-side: an endpoint or cmdlet the adapter does not allow) | `AdminApiExchangeClient` | 429 with `Retry-After`; 5xx idempotent (all calls are reads) |
| Identity | `TokenEndpointError {error, aadsts}`, `IdTokenError {check}`, `DeviceCodeError {kind: expired\|declined\|cancelled\|blocked\|bad_code\|failed, aadsts}`, `SecretsUnavailableError {reason}`, `NotConnectedError` | token endpoint, validator, bootstrap, registry | `temporarily_unavailable` once after 1 s (sign-in exchange only) |

`classifyFailure(error, context)` (setup, one function) maps an error to `transient`, `replication` or `permanent` (FR-B-212): transient = 429, 503, 504, `GraphNetworkError`; replication = `GraphNotFoundError` on an id the run created or received within 300 s, `GraphBadRequestError` whose Graph code is one of the allow-listed replication codes, `GraphForbiddenError`/`GraphUnauthorizedError` inside the propagation window after a grant or role assignment, `TokenEndpointError invalid_client` inside the window after a certificate upload; everything else permanent. The allow-listed replication codes are not known from Learn (U32): the first version uses only the status classes and the message-independent rule "400 on an object the run just created", and the fake tenant models it. OV-05 and OV-06 record real codes.

### 8.3 `GraphHttp` (FR-B-312, FR-B-313)

One class over global `fetch`; constructed with a fixed origin `https://graph.microsoft.com`, path prefix `/v1.0`, a token provider, the clock, the random source and the scheduler.

- **Request building.** Paths come from typed templates; every id is a validated GUID or `encodeURIComponent`-escaped; OData string literals are escaped by doubling single quotes (`odataString`); the final URL must start with the fixed origin and prefix (an `@odata.nextLink` is followed only if it does, same origin; the table-driven control is `server/integrations/url-discipline.test.ts`, FR-B-317) and `redirect: 'error'` is set. The `Authorization` header is attached in this class only.
- **Headers.** `Accept: application/json`, `Content-Type: application/json` for bodies, `x-ms-throttle-priority: high` for calls marked user-initiated and `low` for background work, `client-request-id` (random UUID, logged on failure). `ConsistencyLevel: eventual` plus `$count=true` only when a method sets it (U37 fallback).
- **Retry.** `429`: wait `Retry-After` (integer seconds or HTTP date) plus 0 to 20 % jitter; a wait over 60 s throws `GraphThrottledError(retryAfterMs)` at once; at most 4 retries. `503`/`504`: backoff 500 ms doubling to 10 s with full jitter, at most 4 retries, only for GET, HEAD, PUT, DELETE or a POST the caller marks `idempotent` (reads that use POST: `checkMemberGroups`), as a new request (Learn says to retry 503 on a new connection; global `fetch` gives no per-request control of the socket, so the plan relies on undici dropping a failed socket from its pool and does not claim more). 400, 401, 403, 404, 409 never retry.
- **Budget and concurrency.** Per call, retries included: 20 s interactive, 60 s wizard; the wizard budget sets `retries: 0` (the runner owns every wait, section 9.7), so the 429/503/504 rules above apply to the interactive budget and the background budget only, and a wizard call that meets 429 throws `GraphThrottledError(retryAfterMs)` at once; each attempt aborts after `min(remaining, 10 s)`; at most 4 calls in flight (a small semaphore queue, FIFO, queue capped at 64 then `GraphTransientError`).
- **Response handling.** Size cap 5 MiB; `application/json` only; JSON parsed once and validated by the method's schema; a schema failure is `GraphBadRequestError` with code `unexpected_shape` (never the body).
- **Cache** (GET only, keyed by method + path + sorted query, LRU 1,000): organization 300 s, user 60 s, group 60 s; errors, `checkMemberGroups`, provisioning calls and wizard probes are never cached; `skipCache` option for the revalidation path.
- **Logging.** One `debug` line per attempt with method, route template, status, duration, attempt; at `warn` for retries and failures. No query string, id, token or body.

### 8.4 `HttpGraphClient`, `FakeGraphClient` and the contract suite

`HttpGraphClient` implements the six methods of 8.1 on `GraphHttp` with the application-token provider (scope `https://graph.microsoft.com/.default`, assertion callback of 7.4). Rules from FR-B-311: `checkMemberGroups` uses `POST /users/{id}/checkMemberGroups` with `{"groupIds":[...]}`, at most 20 ids per request (chunks of a longer input run with at most 4 in flight), all ids GUID-validated first; the result is the union of the `value` arrays intersected with the input. `permissions-map.ts` declares, per method, the Learn page and the permission names it relies on; the test asserts every name is in `GRAPH_APP_ROLES`.

`server/integrations/graph/graph-client.contract.test.ts` runs one suite against `HttpGraphClient` on MSW (the fake tenant) and against `FakeGraphClient` (in-memory, for unit tests of services). A service test never uses MSW directly.

### 8.5 `TenantProvisioner`

`GraphHttp` with a `BearerTokenProvider` instead of the app-token provider and the wizard budget; the same retry rules; it exposes only the calls of the call sheet (spec 6.3.1). It is created by `provisionerFactory(bootstrap.bearer())`; the factory throws `NotConnectedError` when the bootstrap object is not authenticated, and nothing in the product keeps a provisioner after the delegated phase ends (FR-B-310). `readKeyCredentials` reads `GET /applications/{id}?$select=keyCredentials`; the PATCH always sends the full intended list built from that read (FR-B-306).

### 8.6 Identity

**8.6.1 App tokens (`app-token.ts`).** One `ConfidentialClientApplication` per (tenant, client id, certificate): `auth.clientId`, `auth.authority` `https://login.microsoftonline.com/<tid>`, `auth.clientAssertion` = callback that calls `signClientAssertion`; no `clientSecret`, no `clientCertificate`, no `cache.cachePlugin`, `system.loggerOptions` forwarding to the redacting logger at `error` level with `piiLoggingEnabled: false`. `get('graph'|'exchange', {skipCache})` calls `acquireTokenByClientCredential({scopes:[resource + '/.default'], skipCache})` and wraps the token in `AccessToken`. Because MSAL calls the assertion callback on every acquire (V-B04), signing happens per call (about 2 ms) and the `jti` is always fresh.

**8.6.2 Bootstrap (`bootstrap.ts`).** One `PublicClientApplication` per wizard connection attempt: `auth.clientId` = `BOOTSTRAP_CLIENT_ID` (default `14d82eec-204b-4c2f-b7e8-296a70dab67e`), `auth.authority` `https://login.microsoftonline.com/<tenant hint or organizations>` (never `common` or `consumers`), no cache plugin. `start()` calls `acquireTokenByDeviceCode({ scopes: [the three Graph scopes of the constant], deviceCodeCallback, cancel })` and resolves with the device-code information once the callback fires; the acquire promise is kept as `completion()`. `bearer()` returns `async () => (await pca.acquireTokenSilent({ account, scopes })).accessToken` when the cached token expires in under 5 minutes, otherwise the cached one (the refresh token that MSAL adds is in the same in-memory cache). `discard()` calls `pca.clearCache()`, drops the account, the callback and the promise, and is idempotent. Identity extracted from the result: `account.tenantId` (`tid`), `idTokenClaims.oid`, `preferred_username` and `name` as labels, all validated (GUID or 256-byte cap). The `message` of the device-code response is never forwarded; the verification URI is forwarded only if it passes the allow-list of FR-B-214 (observed host `login.microsoft.com`, V-B13).

**8.6.3 Tenant metadata (`tenant-metadata.ts`).** Fetches `https://login.microsoftonline.com/<tid>/v2.0/.well-known/openid-configuration` once per 24 hours and on demand; accepts the document only if `issuer` equals `https://login.microsoftonline.com/<tid>/v2.0` and `jwks_uri` and `end_session_endpoint` are https on `login.microsoftonline.com`; otherwise (or when the fetch fails) the constructed forms `.../<tid>/discovery/v2.0/keys` and `.../<tid>/oauth2/v2.0/logout` are used and a `warn` is logged. The authorize and token endpoints are always constructed (V-B12).

**8.6.4 Keys (`jwks.ts`).** `createRemoteJWKSet(new URL(jwksUri), { cacheMaxAge: 24 h, cooldownDuration: 5 min, timeoutDuration: 5 s, [customFetch]: fetchViaJsonFetch })`; an hourly `reload()` from the scheduler (failures are logged, the cache is kept); a first reload at start, never blocking. `customFetch` lets the fake tenant and the redirect rules apply (`redirect: 'manual'` is passed by jose; any 3xx is a failure). A cold cache with the endpoint unreachable makes validation throw `IdTokenError('keys_unavailable')`, mapped to `/signin?error=temporarily_unavailable` (F-27). Key sets are per tenant; there is exactly one tenant.

**8.6.5 ID-token validation (`id-token.ts`).** In this order, each failing check throwing `IdTokenError` with the `check` name of Appendix C of the spec (SB-08):

1. `size`: at most 8,192 bytes. 2. `format`: exactly three base64url segments; header and payload decode to JSON objects (`decodeProtectedHeader`, `decodeJwt` are allowed here and nowhere else). 3. `header`: none of `jku`, `x5u`, `jwk`, `crit`; `kid` a string. 4. `alg`: exactly `RS256` (the discovery document lists only RS256, V-B12). 5. `tenant`: unverified `tid` equals the pinned tenant; `issuer`: unverified `iss` equals `https://login.microsoftonline.com/<tid>/v2.0` exactly. (Peeking before the signature only rejects earlier; acceptance needs everything below.) 6. `jwtVerify` with the key set, `algorithms:['RS256']`, `issuer`, `audience: clientId`, `clockTolerance: 60`, `requiredClaims: ['exp','iat','nbf','iss','aud','sub']`; its errors map to `kid` (no matching key), `signature`, `expired`, `not_before`, `issuer`, `audience`. 7. `audience`: `aud` must be a **string** (jose accepts an array containing the id, F-09). 8. `issued_at`: `iat` not later than now + 60 s (jose does not check, F-16). 9. `version`: `ver` equals `2.0`. 10. `oid`: a lower-case GUID after lower-casing. 11. `nonce`: equals the transaction's value (constant-time). 12. `amr`: kept as an array of at most 16 strings of at most 32 characters, else `null`. 13. `auth_time`: kept when a safe integer.

**8.6.6 Token endpoint (`token-endpoint.ts`).** `POST https://login.microsoftonline.com/<tid>/oauth2/v2.0/token` with `application/x-www-form-urlencoded`: `client_id`, `scope=openid profile`, `code`, `redirect_uri`, `grant_type=authorization_code`, `code_verifier`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion`; no `Origin` header (global `fetch` sends none for server-side calls); 10 s timeout; one retry after 1 s on `temporarily_unavailable`; the JSON answer is read for `id_token` and for `error`/`error_description` only (the `AADSTS` number is extracted by `^AADSTS(\d{4,7})` and kept; the text is discarded); `access_token` is never read (FR-B-418).

### 8.7 `ExchangeClient` and the Admin API adapter (FR-B-314)

`AdminApiExchangeClient` (`integrations/exchange/admin-api-client.ts`) allows exactly two endpoints and two cmdlets:

| Method | Request | Notes |
|---|---|---|
| `getOrganizationConfig(select)` | `POST https://outlook.office365.com/adminapi/v2.0/<tid>/OrganizationConfig?$select=<comma list>` body `{"CmdletInput":{"CmdletName":"Get-OrganizationConfig"}}` | No cmdlet parameters exist for this endpoint (V-B15). `select` defaults to `Name,Guid`; only documented property names are accepted by the client's allow-list |
| `listDistributionGroupMembers(identity, o)` | `POST .../DistributionGroupMember[?$select=...]` body `{"CmdletInput":{"CmdletName":"Get-DistributionGroupMember","Parameters":{"Identity":"<identity>","ResultSize":<n>}}}` | `ResultSize` 1 to 1,000 (default 1,000); follows `@odata.nextLink` by POST with the same headers only when it is an `https` URL on `outlook.office365.com` under `/adminapi/v2.0/<tid>/` (anything else: `ExchangeUnavailableError('invalid_next_link')`, no request is sent, FR-B-317), all pages inside 5 minutes (after that `ExchangeUnavailableError('paging_window_exceeded')`) |
| `probe()` | `getOrganizationConfig(['Name','Guid'])` with a fresh token (`skipCache`) | Mapping below |

Headers on every call: `Authorization`, `Content-Type: application/json`, `X-AnchorMailbox: APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tid>` (the GUID is documented as the same across organizations; Learn's example writes the organization after the `@`, and `tenantIdOrOrganization` is the documented placeholder). Scope `https://outlook.office365.com/.default`. The response envelope is not documented (U45): the parser accepts a top-level array, an object with a `value` array, or a single object, and the adapter's contract tests pin only that tolerance.

| HTTP result | `ExchangeProbeResult` | Wizard verification |
|---|---|---|
| 200 | `ok`, role `yes`, preview `yes` | V5 succeeded |
| 401 | `not_ready` (token or scope not yet effective: consent for `Exchange.ManageAsAppV2` missing or propagating) | replication class inside the window, then warning `exchange_not_ready` |
| 403 | `not_ready`, role `no` | same |
| 400, 404, other 4xx | `unavailable`, preview `unknown` | warning `exchange_unavailable` (the Preview is "not available in all organizations") |
| 429, 5xx, network | retried per the Exchange rules, then `unavailable` | warning |

`FakeExchangeClient` implements the same interface; `server/exchange/exchange-client-contract.test.ts` runs one suite on both. The repository contains no `InvokeCommand`, `pwsh` or `powershell` outside `docs/` and ADRs (`server/integrations/exchange/no-undocumented.test.ts`, + negative).

### 8.8 Graph permissions by operation (decision B1, evidence of 2026-10-10)

Sources are Microsoft Learn permission tables of the named API pages and the permissions reference (sections `Group.*`, `GroupMember.*`, `Organization.*`, `Member.Read.Hidden`, `OrgContact.Read.All`, read on 2026-10-10; the rest of that 9,200-line page was not read). "Held" means contained in `GRAPH_APP_ROLES` v1 (`User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`).

| Phase | Operation | Call | Application permissions on Learn | Held? |
|---|---|---|---|---|
| B | Verify and show the tenant | `GET /organization` | `Organization.Read.All` | yes |
| B | Read a user, revalidate, validate a principal | `GET /users/{id or upn}` | `User.Read.All`; reading `accountEnabled` needs `User.Read.All` (the `User.EnableDisableAccount.All` pairing is for writing) | yes |
| B | Group membership at sign-in | `POST /users/{id}/checkMemberGroups` | `User.ReadBasic.All` + `GroupMember.Read.All`; `User.Read.All` + `GroupMember.Read.All` is listed higher; `/directoryObjects/{id}/checkMemberGroups` lists `Directory.Read.All` and is not used | yes |
| B | Get and search groups | `GET /groups/{id}`, `GET /groups?$filter=...` | `GroupMember.Read.All` is listed; the permissions reference says it "reads memberships and basic group properties"; which properties come back: U36 | yes |
| C | List and read users incl. department, status | `GET /users`, `GET /users/{id}` | `User.Read.All`; guests cannot call it as delegated users (irrelevant app-only) | yes |
| C | Licences of a user | `assignedLicenses` as `$select` property of the user | `User.Read.All` (the page's property exceptions do not list it: U48). **`GET /users/{id}/licenseDetails` does not support application permissions** and must not be planned | yes |
| C | Licence SKU names | `GET /subscribedSkus` | least `LicenseAssignment.Read.All`; **`Organization.Read.All` is listed as an alternative for application permissions** and its description includes "subscribed skus" | yes (`Organization.Read.All`) |
| C | A user's groups | `GET /users/{id}/transitiveMemberOf` | `User.Read.All` (higher: `GroupMember.Read.All`, `Group.Read.All`); `/memberOf` needs `Directory.Read.All` and is not used | yes |
| C | List groups and their members | `GET /groups`, `GET /groups/{id}/members` | List groups: `GroupMember.Read.All` listed. List members: least `GroupMember.ReadBasic.All`, `GroupMember.Read.All` listed. Members that are not users or groups come back with `id` and `@odata.type` only unless the app can read that type (`Device.Read.All`, `Application.Read.All`, `OrgContact.Read.All`): acceptable, shown as "other object" | yes |
| C | Add and remove members of Microsoft 365 and security groups | `POST /groups/{id}/members/$ref`, `DELETE .../members/{id}/$ref` | `GroupMember.ReadWrite.All` (user and group members). An organisational contact as member additionally needs `OrgContact.Read.All`; role-assignable groups need `RoleManagement.ReadWrite.Directory` (never granted) | yes; contacts and role-assignable groups not supported in C |
| C/D | Hidden-membership groups | `Member.Read.Hidden` | not requested; such groups never match (fail closed) | no, by design |
| D | Distribution lists and mail contacts | Exchange, not Graph (groups-overview: distribution groups are read-only in Graph) | n/a | n/a |

**Result.** No Phase C or D Graph operation found needs `Group.Read.All` or `Directory.Read.All`; the brief's `User.ReadWrite.All` and `Group.ReadWrite.All` are not needed either (spec 8.2 delta stands). **Fallback ladder for U36**, to be used only if OV-19 shows that `GroupMember.Read.All` does not return the properties Phase C needs (`displayName`, `mail`, `mailNickname`, `groupTypes`, `membershipRule`, `onPremisesSyncEnabled`, `securityEnabled`, `mailEnabled`): (1) request fewer properties and mark the rest "unknown" in the UI; (2) add `Group.Read.All`, whose description adds "read conversations for all groups" and, for Microsoft 365 groups, "access to the contents of the group". That is a new owner decision with its own evidence. `Group.ReadBasic.All` appears in Learn's List groups table but has **no entry in the permissions reference** (searched 2026-10-10): it is not a documented fallback (U46). The four role ids in `docs/permissions.md` were re-confirmed today against the reference (`User.Read.All` `df021288-...`, `GroupMember.Read.All` `98830695-...`, `GroupMember.ReadWrite.All` `dbaae8cf-...`, `Organization.Read.All` `498476ce-...`); the runtime lookup of FR-B-302 remains the rule.

## 9. Setup gate and wizard

### 9.1 Setup state machine (FR-B-201)

Persisted in `setup_state.state`; moves only along these edges; the SQL trigger of data-model.md is the second line of defence (the HTTP routes can only perform the first four rows).

| # | From | To | Trigger | Guard | Effects (one transaction unless noted) | Audit |
|---|---|---|---|---|---|---|
| 1 | `unconfigured` | `in_progress` | first successful `POST /api/v1/setup/unlock` | token valid, availability gate open, not locked | create the setup session | `setup.unlock` success |
| 2 | `in_progress` | `in_progress` | later unlock | same | new setup session | `setup.unlock` success |
| 3 | `in_progress` | `awaiting_first_signin` | `POST /api/v1/setup/finish` | steps `environment`, `connect`, `configure`, `verify` each `succeeded` or `warning` (manual mode: its own subset, 9.10); designated owner known and equal to `confirmOwnerOid` | owner assignment (and optional Beheerder group assignment) inserted if absent, `designated_owner_oid`, `default_language` stored, bootstrap object discarded | `setup.step.run` (step `finish`), `rbac.assignment.create` with actor `setup`, source `wizard` |
| 4 | `awaiting_first_signin` | `completed` | `GET /auth/callback` of the designated `oid` after validation, MFA and grant resolution | non-empty grants | the session row, `app_user` upsert, the state change and `completed_at` in **one** `BEGIN IMMEDIATE`; the token file is unlinked after the commit | `auth.signin` success, `setup.complete` |
| 5 | `awaiting_first_signin` or `completed` | `in_progress` | CLI `setup-reopen --confirm` only | none | new token file; step rows are kept so a repair can reconcile | `setup.reopen` (actor `cli`) |

While the state is `in_progress` sign-in is refused (`setup_required`), because the wizard may be in the middle of changing the application; `awaiting_first_signin` and `completed` allow sign-in. This is the cost of reopening and is stated in `docs/operations.md` (RB-13).

### 9.2 The setup actor and the availability gate

- **Actor.** `kind: 'setup'`, `id: 'setup'`, grants exactly `settings:branding` and `settings:connection` (both `ALL`, qualifier full) and nothing else (PB-06, SB-01). Without `settings:branding` the Phase A Appearance form could not run in step 5 (FR-B-219a); without `settings:connection` the connection routes would need a second mechanism. The actor exists only for a valid setup cookie while the state is not `completed`. `csrfBinding` comes from the cookies (10.5).
- **Gate** (pipeline stage 1b) for every route flagged `availability: 'setupOpen'` (all `/api/v1/setup/*`, all `/api/v1/connection/*` while not completed) and the pages `/setup` and `/setup/*`: open only when the state is not `completed` **and** the loopback guard passes. Guard (FR-B-206), evaluated only when `PUBLIC_BASE_URL` is http: the `Host` header (port stripped) must be `localhost`, an address in `127.0.0.0/8`, or `[::1]`, and none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port`, `X-Real-IP` may be present. A closed gate answers exactly like an unknown path (6.3, stage 1b). After `completed`, `/api/v1/connection/*` is served to a signed-in user holding `settings:connection` (access kind `connection`), no longer to a setup actor.
- **What the gate does not do.** It is not a security boundary (a non-browser client can forge `Host`); the token is. `docs/security.md`, the README and the report say so.

### 9.3 Unlock (FR-B-203 to FR-B-205)

`POST /api/v1/setup/unlock` body `{"token": "<string>"}` (4,096-byte cap; the token is accepted nowhere else). Order: gate -> rate class `setup` -> Origin and CSRF (anonymous binding) -> body parse -> **lock check** -> compare -> bookkeeping.

- Compare: `timingSafeEqual(sha256(input), sha256(expected))`; the expected token is `SETUP_TOKEN` or the file content (trimmed), read once per request from a cached value invalidated by the file's mtime.
- Counters (memory, injectable clock, keyed by the client key): failure timestamps per client within 15 minutes; failure timestamps globally within 60 minutes. The 5th failure of one client inside 15 minutes locks that client for 15 minutes; the 30th global failure inside 60 minutes locks unlocking for everyone for 15 minutes. While a lock holds, every unlock (a correct token too) answers 429 `setup_token_locked` with integer `Retry-After` (remaining seconds). When a lock **starts**, one audit entry `setup.unlock` (denied, `reason: setup_token_locked`, `lockScope: client|global`) and one log event `setup_unlock_locked` are written; failures inside the bound are not audited (they are attacker-reachable volume; the lock entry is the signal).
- Success: a 256-bit random id (base64url) in memory with idle 60 minutes (sliding) and absolute 8 hours; at most 5 live setup sessions (oldest evicted); state edge 1 or 2; cookie `setup` (Strict); body `{state}`.
- `DELETE /api/v1/setup/session` ends the session at once, clears the cookie and clears the bootstrap object when this was the last setup session.
- A sweeper every minute removes expired setup sessions; when the last one expires the bootstrap object is discarded (FR-B-215c).

### 9.4 Step model

Keys are the registry `STEPS` in `packages/shared/src/setup/steps.ts` (and the keys of `setup_step` rows): `environment` (`public_base_url`, `data_dir`, `app_key`, `node_version`, `network`, `time_skew`), `connect` (`device_code` or `manual_inputs`), `configure` (`application`, `service_principal`, `certificate`, `application_settings`, `graph_permissions`, `exchange_permissions`, `exchange_role`), `verify` (`audit_reads`, `app_token`, `organization`, `users`, `exchange_probe`), `finish` (`branding`, `owner`, `beheerder_group`, `language`, `handover`). The `setup_step` row holds status, attempt, timestamps, `error_code` (allow-list of the result codes of spec 6.9.5), `rollback_hint_key` and `detail` (JSON object, at most 4,096 bytes, keys from a closed list, no secret-looking key, FR-B-210).

Step status is derived by one pure function `aggregate(subStatuses)`: any `failed` -> `failed`; else any `running` or `waiting` -> `running`; else any `pending` -> `pending`; else any `warning`, or `skipped` flagged as a warning (the two Exchange sub-actions when the tenant has no Exchange service principal, EB-08) -> `warning`; else `succeeded`. In manual mode the `configure` sub-actions are written as `skipped` with `detail.manual = true` and count as succeeded. Preconditions (`setup_step_not_ready`, 409): `connect` needs `environment` without `failed`; `configure` needs `connect` succeeded and, in automatic mode, a live bootstrap object; `verify` needs `configure` succeeded or warning; `finish` needs `verify` succeeded or warning.

### 9.5 Sub-actions: idempotency keys, calls and hints

All delegated calls below go through `TenantProvisioner` with the wizard budget; every mutating call is followed by one transaction that writes the `setup_object` row, the step row, the `tenant_connection` field and the audit entry `setup.object.change` (a crash between the call and the transaction is repaired by the next run finding the object and recording `op: adopt`, spec 6.9.6 rule 5). Role ids are resolved first (FR-B-302) and cached in the run context.

| Sub-action | Idempotency key (what the next run reads first) | Mutating call, only when the read shows a difference | Recorded | Rollback hint (catalogue key, parameters) | Notable result codes |
|---|---|---|---|---|---|
| `application` | stored `setup_object(application)`; else apps with our install tag, else `displayName` match (FR-B-304), then, for a match without our tag, the trust inspection of FR-B-318 (credentials and owners of the application and its service principal; a password credential ends the step) | `POST /applications` | `setup_object(application, id, appId, name, origin)`, `tenant_connection.app_object_id`, `app_id` | `setup.hint.application` (name, objectId, appId): "delete this app registration in Entra if you abandon the install" | `application_ambiguous`, `application_adoption_required` (waiting for `POST /connection/adopt`), `application_untrusted` (FR-B-318), `app_role_missing`, `graph_error` |
| `service_principal` | `GET /servicePrincipals(appId='<appId>')` | `POST /servicePrincipals` `{appId}` (replication class on 400/404 for a just-created app) | `setup_object(service_principal)`, `sp_object_id` | `setup.hint.service_principal` | `graph_error` |
| `certificate` | local `certificate` row (state `pending` or `active`) and `GET /applications/{id}?$select=keyCredentials` containing its SHA-1 as `customKeyIdentifier` | generate and seal first (7.3, `pending`), then `PATCH /applications/{id}` with the full list; read back; mark `active` | `certificate`, `secret` rows; `tenant_connection.certificate_id` | `setup.hint.certificate` (thumbprint, appObjectId) | `policy_refused` (400, EB-10), `thumbprint_mismatch`, `graph_error` |
| `application_settings` | `GET /applications/{id}?$select=signInAudience,web,optionalClaims,requiredResourceAccess,isFallbackPublicClient,tags` compared field by field with the desired state | `PATCH /applications/{id}` with only the drifted members | `tenant_connection.redirect_uris`, `permission_set_version` | none (reversible by the next run) | `graph_error` |
| `graph_permissions` | `GET /servicePrincipals/{spId}/appRoleAssignments` | up to 4 x `POST /servicePrincipals/{graphSpId}/appRoleAssignedTo` | `setup_object(app_role_assignment)` per grant | `setup.hint.grants` (role names) | `forbidden_permission_present` (failed), `app_role_missing`, `replication_timeout` |
| `exchange_permissions` | same list for the Exchange service principal | up to 2 grants (`Exchange.ManageAsApp`, `Exchange.ManageAsAppV2` when exposed) | idem | `setup.hint.grants` | `exchange_service_principal_missing` (skipped), `app_role_missing` |
| `exchange_role` | `GET /roleManagement/directory/roleAssignments?$filter=principalId eq '<spId>'` | `POST /roleManagement/directory/roleAssignments` | `setup_object(directory_role_assignment)`, `tenant_connection.exchange_role_template_id`, `exchange_enabled = 1` | `setup.hint.exchange_role` (role name) | `exchange_service_principal_missing` (skipped) |
| `audit_reads` (verify) | all of the above read again | none | proof items V4, V6 | none | `drift_detected`, `optional_claim_missing` |

`setup_object` kinds are `application`, `service_principal`, `app_role_assignment`, `directory_role_assignment`. The ids of the last two are not GUIDs, so the audit detail `objectId` is only filled for the first two; for grants and role assignments the detail carries `kind` and `name` (the permission or role name) (SB-11).

**Desired state** (`packages/shared/src/setup/desired-state.ts`, one function `buildDesiredState({baseUrl, installId, applicationName, roleIds, exchange})`; the automated path, the manual checklist and the verification all read it, so the three cannot drift apart):

```json
{
  "displayName": "<applicationName, 3 to 64 characters, NFC>",
  "description": "Created by the M365Portal setup wizard (install <first 8 of installId>)",
  "signInAudience": "AzureADMyOrg",
  "tags": ["m365portal", "m365portal-install-<installId>"],
  "web": { "redirectUris": ["<origin>/auth/callback", "<origin>/auth/logged-out"],
           "implicitGrantSettings": { "enableIdTokenIssuance": false, "enableAccessTokenIssuance": false } },
  "isFallbackPublicClient": false,
  "requiredResourceAccess": [
    { "resourceAppId": "00000003-0000-0000-c000-000000000000",
      "resourceAccess": [ { "id": "<User.Read.All>", "type": "Role" }, { "id": "<GroupMember.Read.All>", "type": "Role" },
                          { "id": "<GroupMember.ReadWrite.All>", "type": "Role" }, { "id": "<Organization.Read.All>", "type": "Role" } ] },
    { "resourceAppId": "00000002-0000-0ff1-ce00-000000000000",
      "resourceAccess": [ { "id": "<Exchange.ManageAsApp>", "type": "Role" } /* + ManageAsAppV2 when exposed */ ] } ],
  "optionalClaims": { "idToken": [ { "name": "amr", "essential": false }, { "name": "auth_time", "essential": false } ] }
}
```

(`<origin>` is the redirect URI base of `redirectUris(PUBLIC_BASE_URL)`; the Exchange block is omitted when the tenant has no Exchange service principal.) Key credential entry added by `certificate`: `{"type":"AsymmetricX509Cert","usage":"Verify","key":"<base64 DER>","displayName":"M365Portal <first 8 of SHA-1>","startDateTime":"<notBefore>","endDateTime":"<notAfter>"}`, no `customKeyIdentifier`; entries already on the application are re-sent exactly as read (including `key`), and if an existing entry came back without `key` the sub-action stops with `graph_error` rather than risk dropping it (whether re-sending preserves it is U47). Grant body: `{"principalId":"<runtime SP id>","resourceId":"<resource SP id>","appRoleId":"<role id>"}`. Role assignment body: `{"@odata.type":"#microsoft.graph.unifiedRoleAssignment","roleDefinitionId":"<template id>","principalId":"<runtime SP id>","directoryScopeId":"/"}` with `EXCHANGE_ROLES` = `exchange_administrator` `29232cdf-9323-42fd-ade2-1d097af3e4de` (default) and `exchange_recipient_administrator` `31392ffb-586c-42d1-9346-e59415a2cc4e` (research §4; Learn permissions reference). The start request names the role by these keys only (FR-B-308); no other template id is accepted from a request or a setting, so a privileged directory role can never be assigned to the runtime application (OV-13 selects the second key, ODB-03).

### 9.6 Runner

- **Request.** `POST /api/v1/connection/runs` body `{steps, mode, tenantHint?, applicationName?, exchangeRole?}` where `steps` is a non-empty ordered subset of `connect`, `configure`, `verify` or the word `repair`, and `mode` is `continue` (skip sub-actions already `succeeded` or `skipped`) or `reconcile` (visit every sub-action read-first; used by repair and by the idempotency test). Answer 202 with the run status. The run executes in the background of the same process; an unhandled exception ends the run `failed` with log key `setup.log.run_crashed` and releases the lease.
- **Single runner.** An in-process mutex plus the `runner_lease` row (holder = run id, heartbeat every 15 s from the scheduler, expiry 120 s). A second request, another browser, or a restart racing a stale lease gets 409 `setup_step_busy`; a lease past its expiry is taken over in the same transaction that writes the new holder.
- **Cancel** (`POST .../cancel`): sets the cancel flag; the runner stops at its next checkpoint (between calls and during waits), sets `cancel = true` on a pending device-code acquire, returns `running`/`waiting` rows to `pending`, discards the bootstrap object, releases the lease. The in-flight HTTP call completes (its answer is recorded) but no further call starts.
- **Retry now** (`POST .../retry-now`): wakes the current wait immediately; the attempt counts.
- **Log.** `setup_log` rows `{seq, ts, step, level, messageKey, params}` written in the same transaction as the step row they describe; keys come from `LOG_KEYS` in shared (every key has nl and en text); params are scalars validated by the secret-free schema; 1,000 rows kept (trimmed in the same transaction as the insert). The UI polls `GET /api/v1/connection/runs/current?after=<seq>` once per second (every 2 seconds in a hidden tab), which returns the run, the step states, the device-code panel data and up to 200 new log lines in one response, so the polling load is 1 request per second against a `read` bucket that refills at 2 per second (PB-14); `GET /api/v1/connection/log` pages the history.
- **Run context** (memory): resolved role ids, service principal ids, the bootstrap object and the desired state; discarded with the run.

### 9.7 Retry and backoff (FR-B-212)

`backoffDelay({klass, attempt, retryAfterMs?, random})` in `packages/shared/src/setup/backoff-constants.ts` + `apps/server/src/setup/backoff.ts` (pure):

| Class | Delay for attempt n (1-based) | Tries / window | Constants |
|---|---|---|---|
| transient | `retryAfterMs` when present; else `max(500, random() * min(30000, 1000 * 2^(n-1)))` ms | at most 6 tries | `SETUP_TRANSIENT_BASE_MS` 1000, `_CAP_MS` 30000 |
| replication | `max(500, random() * min(60000, 2000 * 2^(n-1)))` ms | until the window ends: 300 s for object chains (`SETUP_OBJECT_CHAIN_WINDOW_SECONDS`), `SETUP_PROPAGATION_TIMEOUT_SECONDS` (default 900, maximum 3,600) for role-to-token propagation | `SETUP_REPLICATION_BASE_MS` 2000, `_CAP_MS` 60000 |
| permanent | none | never retried | |

The 500 ms floor (SB-06) keeps a full-jitter draw near zero from hammering Graph and from flooding the log; the spec's jitter bound `0..cap` becomes `500..cap`. The window starts at the first replication-class failure of the sub-action. Wizard calls run with `GraphHttp` retries disabled (`budget: 'wizard'` sets `retries: 0` and surfaces `retryAfterMs`), so every wait is the runner's, is written as a log line "waiting for Microsoft to replicate, n of m" (`setup.log.waiting_replication` with `{attempt, max, seconds}`), and the sub-action is `waiting` with `detail.nextAttemptAt` for the UI countdown. Every probe in `verify` requests a fresh token (`skipCache: true`, FR-B-316) because the Entra role is baked into the token (research §4). Final failure hint after the window: "the role may still be propagating; use Retry now, or wait up to the documented minutes" with the measured elapsed time.

### 9.8 Verification and the proof list (FR-B-309)

| Check | Sub-action | Token | Pass | Fail status |
|---|---|---|---|---|
| V4 | `audit_reads` | delegated | application fields equal the desired state; service principal exists; our credential present by thumbprint; app role assignments contain the desired set (extra roles are reported as `drift`, forbidden roles fail); the Entra role assignment is present; the credentials and owners the panel did not create are counted for the application and its service principal (FR-B-319) | `failed` `drift_detected`; foreign credentials: `warning` `foreign_credential_present` |
| V6 | `audit_reads` | delegated | `optionalClaims.idToken` holds `amr` and `auth_time` | `warning` `optional_claim_missing` |
| (switch) | | | **the bootstrap object is discarded here** (FR-B-215a) | |
| V1 | `app_token` | app-only, `skipCache` | a Graph token is obtained with the certificate | `failed` `token_unavailable` |
| V2 | `organization` | app-only | `GET /organization` returns one item whose `id` equals the proposed tenant; then, in one transaction, `tenant_connection.tenant_id`, `tenant_name`, `initial_domain` (the `verifiedDomains` entry with `isInitial`), `verified_at` are written and `setup.tenant.pin` is audited; a repair run must see the same id (`tenant_mismatch` otherwise) | `failed` `organization_mismatch` |
| V3 | `users` | app-only | `GET /users?$top=1&$select=id` answers 200 | `failed` `users_unreadable` |
| V5 | `exchange_probe` | app-only | `ExchangeClient.probe()` is `ok` | `warning` `exchange_not_ready` or `exchange_unavailable` (never `failed`, EB-09) |

The proof list is `tenant_connection.proof` (JSON, at most 51,200 bytes): `{generatedAt, mode, items:[{key, status: ok|warning|failed|not_checked, at, params}]}` with keys `application`, `service_principal`, `certificate`, `graph_roles`, `exchange_roles`, `entra_role`, `check_v1` to `check_v6`. Params are names, thumbprints and counts, never free text. `POST /api/v1/connection/verify` re-runs V1, V2 (comparison only), V3 and V5 with fresh tokens in one request (budget 60 s, no waiting loop) and replaces the app-only items.

### 9.9 Finish (FR-B-219)

`POST /api/v1/setup/finish` body `{confirmOwnerOid: Guid, language?: 'nl'|'en', beheerderGroupId?: Guid|null}`. Branding is saved beforehand through the Phase A routes with the setup actor's `settings:branding`; skipping it is allowed. The proposed organisation name is the tenant display name while `branding.orgName` still equals the Phase A default. The Beheerder group id is validated with `GraphClient.getGroup` (found: ok; 404: `group_unknown`; Graph unavailable: `graph_unavailable`) before the transaction. The request must name the person who becomes Owner (`confirmOwnerOid` equals `designated_owner_oid`; the wizard shows that person's label, FR-B-219 h) and the state must be `in_progress` (a replayed finish is 409 `setup_step_not_ready`). The final transaction (state edge 3) inserts the Owner assignment for `designated_owner_oid` (`source: 'wizard'`, `created_by: 'setup'`) and the optional `admin` assignment for the group, stores the language and the state, and writes the audit entries; the bootstrap object has already been discarded.

### 9.10 Manual provisioning mode (FR-B-218)

Entry: the operator picks it, or accepts the offer after `device_code_blocked`, `consent_required` or `admin_approval_required`. Steps: (1) the certificate is generated and sealed at once (`pending`); `GET /api/v1/setup/certificate.cer` serves the public DER. (2) The UI shows the checklist rendered from `buildDesiredState` (application name, redirect URIs, optional claims, implicit flows off, application permissions by name, Exchange app roles, Entra role, thumbprints) with links to the Learn how-to pages for the portal tasks; no invented portal steps. (3) `PUT /api/v1/setup/manual` body `{applicationClientId, tenantId, firstOwner: {kind:'oid'|'upn', value}}` stores `mode = manual`, `tenant_connection.app_id`, `proposed_tenant_id`; the first Owner is resolved with `GraphClient.getUser` (a UPN is resolved to an `oid` and the `oid` is what is stored). (4) `verify` runs V1 to V3 and V5; `audit_reads` is written `skipped` with proof items V4 and V6 `not_checked`, so the step ends `warning`. (5) The certificate becomes `active` after V1 succeeds. The first Owner may differ from the person doing the setup only in this mode (ODB-14).

### 9.11 Repair (FR-B-220) and certificate renewal

`POST /connection/runs {steps:'repair', mode:'reconcile'}` needs step-up for user actors, a fresh device-code bootstrap on the pinned tenant (`tenant_mismatch` and discard otherwise) or the manual inputs. It reads first and fixes only drift: redirect URIs (after a `PUBLIC_BASE_URL` change), optional claims, `requiredResourceAccess`, missing grants, a missing Entra role, and certificate renewal. Extra grants are reported, never removed; a forbidden role present fails the sub-action. **Renewal sequence:** (1) reuse the `pending` certificate or create one; (2) `PATCH` the full existing list plus the new credential; (3) read back and compare the SHA-1; (4) build a temporary holder and application for the new certificate and acquire an app-only token with it (this proves possession and propagation); (5) in one transaction retire the old certificate, activate the new one and point `tenant_connection.certificate_id` at it; `ClientsRegistry.reload()`; (6) `PATCH` the list without credentials that are expired or belong to retired certificates; (7) delete the retired certificate and its sealed secret. A failure before step 5 leaves the old certificate active and the new one `pending` for the next attempt. A lapsed certificate cannot be renewed by the panel itself (it cannot obtain a token): repair with an administrator is the only path, and `addKey` self-rotation is Phase D (ODB-08).

### 9.12 What is persisted and what is not

| Item | Persisted | Where | Not persisted |
|---|---|---|---|
| Setup state, mode, install id, designated owner, default language | yes | `setup_state` | |
| Step and sub-action status, attempts, hints, secret-free detail | yes | `setup_step` | |
| Ids of created or adopted objects | yes | `setup_object`, `tenant_connection` | |
| Live log | yes, 1,000 rows | `setup_log` | |
| Certificate public data, sealed private key | yes | `certificate`, `secret` | the PKCS#8 key in clear |
| Proof list | yes | `tenant_connection.proof` | |
| Runner lease | yes | `runner_lease` | |
| Setup sessions, unlock counters, the bootstrap object, device and user code, run context, current run object | no (memory) | | a restart ends them; the operator unlocks again and repeats the device sign-in |

### 9.13 Rollback hints

Hints are catalogue keys with named parameters; no automatic rollback exists. They are written when an object is created or adopted and shown on the failed or abandoned step: `setup.hint.application`, `setup.hint.service_principal`, `setup.hint.certificate`, `setup.hint.grants`, `setup.hint.exchange_role`, and `setup.hint.bootstrap_consent` (shown on the finish page: where to review the per-user consent that Microsoft's Graph Command Line Tools client keeps in the tenant, research §5.4). Every key exists in nl and en (`shared/message-keys.test.ts`).

### 9.14 First run, end to end

1. Operator starts the container with `APP_KEY` and reads the token: `docker exec <c> /nodejs/bin/node /app/dist/cli.js setup-token` (U34). 2. Browser: `GET /setup` (gate open) shows the token form; `POST /api/v1/setup/unlock`. 3. `POST /api/v1/setup/environment` runs the six checks. 4. `POST /api/v1/connection/runs {steps:['connect','configure','verify']}`; the UI shows the user code and the allow-listed link; the administrator signs in at Microsoft, leaving "Consent on behalf of your organization" off. 5. The runner configures (11 mutating calls at most), reads back (`audit_reads`), **discards the bootstrap object**, then probes with the new certificate, waiting out replication. 6. The UI shows the proof list; the operator optionally edits branding, picks a language and a Beheerder group, and finishes: state `awaiting_first_signin`. 7. The designated administrator presses "Aanmelden"; the callback flips the state to `completed`; `/setup` now answers 404.

## 10. Sign-in and sessions

### 10.1 Cookies, per environment (FR-B-401; names and attributes come from `cookieNames()` and one `serializeCookie()`)

All three cookies are `HttpOnly`, `Path=/`, carry no `Domain` and no `Expires`, and hold a 256-bit random value (base64url, 43 characters). A deletion repeats the attributes with `Max-Age=0`. Duplicate cookies of the same name in one request are treated as absent (fail closed) and logged once as `cookie_duplicate`; a cookie with a malformed value is absent.

| Cookie | `PUBLIC_BASE_URL` https | `http://localhost:<port>` | `SameSite` | Lifetime |
|---|---|---|---|---|
| Session | `__Host-m365portal_session=<id>; Path=/; Secure; HttpOnly; SameSite=Strict` | `m365portal_session=<id>; Path=/; HttpOnly; SameSite=Strict` | Strict | browser session; the server enforces idle and absolute timeouts |
| OIDC transaction | `__Host-m365portal_oidc=<id>; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax` | `m365portal_oidc=<id>; Path=/; Max-Age=600; HttpOnly; SameSite=Lax` | Lax (the only cookie that must accompany the cross-site top-level `GET` from Entra) | 600 s |
| Setup session | `__Host-m365portal_setup=<id>; Path=/; Secure; HttpOnly; SameSite=Strict` | `m365portal_setup=<id>; Path=/; HttpOnly; SameSite=Strict` | Strict | browser session; 60 min idle, 8 h absolute server-side |

Trade-off on `http://localhost` (BC-03, B-07, ODB-15): `__Host-` needs `Secure`, which a plain-http origin cannot carry, so the plain names are used; cookies are not isolated by port, so another local application on `localhost` can read, overwrite or delete them. That is acceptable for a developer or evaluation run on a trusted machine and is stated in `docs/security.md`; any shared or exposed host must use https. `Set-Cookie` appears only on responses that set or clear one of these cookies (`server/auth/headers.test.ts`).

### 10.2 Sequences

**Sign-in** (`purpose=signin`; steps 6 to 10 are FR-B-403 in order; any failure answers 303 to `/signin?error=<code>` with `Cache-Control: no-store`).

| # | Actor | Request or action | Parameters and checks |
|---|---|---|---|
| 1 | Browser | `GET /auth/login?returnTo=%2Fusers` | optional `prompt` (`login` or `select_account`; anything else dropped), optional `purpose` (`signin`; `stepup` needs a session) |
| 2 | Panel | availability and rate class `auth`; creates the login transaction | `state`, `nonce` = 32 random bytes each, `code_verifier` = 32 random bytes (43 base64url characters), `returnTo` run through `safeReturnTo` (single leading `/`, no `//`, `\`, control character or scheme, at most 256 characters, not beginning `/api/` or `/setup`; else `/`); caps 1,000 transactions, 20 per client, 600 s |
| 3 | Panel -> Browser | `303 Location: https://login.microsoftonline.com/<tid>/oauth2/v2.0/authorize` + `Set-Cookie: oidc` | exactly: `client_id=<appId>`, `response_type=code`, `redirect_uri=<authorizeRedirectUri>`, `response_mode=query`, `scope=openid profile`, `state`, `nonce`, `code_challenge=base64url(SHA-256(verifier))`, `code_challenge_method=S256`, optional `prompt`. No `max_age`, no `claims`, no `login_hint`, no `offline_access` |
| 4 | Browser | authenticates at Entra (Conditional Access, MFA happen there) | |
| 5 | Entra -> Browser -> Panel | `302 <redirect_uri>?code=...&state=...` then `GET /auth/callback` with the Lax cookie | unknown query parameters (for example `session_state`) are ignored; the query string is never logged; the request is a cross-site navigation (`Sec-Fetch-Site: cross-site`) and is exempt from the Phase A rule for audited GETs (SB-25) |
| 6 | Panel | cookie -> transaction (`cookies_missing_or_expired` if none: not audited); delete transaction and clear cookie; `state` constant-time compare; `error` parameter mapped through the AADSTS table | |
| 7 | Panel -> Entra | code redemption, 8.6.6 | PKCE verifier, certificate assertion, no secret |
| 8 | Panel | ID-token validation (8.6.5), MFA gate (`evaluateAmr`), principal `(tid, oid)` | audited from here on as `auth.signin` denied with `reason` and `check` |
| 9 | Panel -> Graph | `checkMemberGroups` for the bound groups, chunks of 20, then `computeGrants` | empty grants: `no_role`, or `graph_unavailable` if only group-derived grants could exist and Graph failed |
| 10 | Panel | one `BEGIN IMMEDIATE`: upsert `app_user`, insert the hashed session, evict sessions beyond 10, and (state `awaiting_first_signin` and the designated `oid`) flip to `completed` with audit `setup.complete`; then unlink the token file | |
| 11 | Panel -> Browser | **`200 text/html` interstitial** (header profile html with a nonce): `<meta http-equiv="refresh" content="0;url=<safe returnTo>">` and a visible link, `Set-Cookie: session`, `Set-Cookie: oidc` cleared | never a 303 (FR-B-412, U39) |
| 12 | Browser | follows the refresh: `GET <returnTo>` same-site, session cookie sent | the shell's boot data carries the real actor, so the first paint shows the signed-in persona |

**Step-up** (`purpose=stepup`, FR-B-411): the same, but step 1 needs a valid session; the transaction stores the SHA-256 of the current session id and the request carries `prompt=login`. At step 8 the token must have the same `oid`, an `auth_time` claim present and not earlier than the transaction start minus 60 s, and pass the MFA policy again; step 9 is skipped; step 10 **rotates** the session id (new random id, the old row deleted in the same transaction) and sets `step_up_at = now`. Any failure is `/signin?error=stepup_failed` (audited `auth.stepup` denied). The panel never sends `max_age` or a `claims` request (U13, U27) and, when the tenant does not ask for MFA, fails with the explicit `mfa_required` instead of looping.

**Sign-out** (FR-B-410): `POST /api/v1/auth/logout` (Origin, CSRF) deletes the current session row first, clears the cookie, audits `auth.signout` (or `breakglass.signout`), and answers `{redirect}` = `https://login.microsoftonline.com/<tid>/oauth2/v2.0/logout?post_logout_redirect_uri=<origin>/auth/logged-out` (a registered redirect URI; for localhost the same port-less rule applies, and the sent URI carries the real origin); for a break-glass session, which has no Entra session, `redirect` is the local path `/signin?signedout=1`. The client checks the URL (`https:`, host `login.microsoftonline.com`) and navigates with `location.assign`; Entra returns to `GET /auth/logged-out`, which answers `303 /signin?signedout=1`. `POST /api/v1/auth/logout-all` first deletes **every** session row of the same `(tid, oid)` (no other principal) and then does the same; break-glass cannot use it. No front-channel or back-channel logout is registered (`web.logoutUrl` stays unset; U29).

**Revalidation** (FR-B-409, 10.8) and **break-glass** (10.9) are below.

### 10.3 Outcomes of the 45 fixtures

`server/auth/callback.test.ts` iterates `F-01 ... F-45` of spec Appendix C through the fake identity provider, the fake tenant and a scripted browser (`FakeBrowser`: cookie jar, redirect following, no JavaScript) against `app.fetch`. For every fixture it asserts the redirect target, the audit entry (action, outcome, reason, `check`), the number of sessions created (success fixtures exactly 1, all others 0), the absence of canaries in logs and responses, and that no `access_token` or `id_token` is in any table. The `check` names are the ones of 8.6.5. The ID-token validator also has its own table-driven test (`id-token.test.ts`) for F-02 to F-27; mutation-style negative controls replace the validator by copies that skip the nonce, the tenant peek, the `aud` string rule or the `iat` rule and expect the relevant fixtures to fail (14.6).

### 10.4 Sessions (FR-B-407)

- **Row and id.** The cookie value is 32 random bytes in base64url; `session.id_hash` is `SHA-256(value)` in hex and is the primary key; the raw value is never stored or logged. A session row holds `kind`, `tid`, `oid`, `created_at`, `last_seen_at`, `absolute_expires_at`, `mfa`, `amr` (JSON array, at most 256 bytes), `authenticated_at`, `step_up_at`, `groups_stale`. No IP address or user agent is stored.
- **Lookup per request.** One indexed query joins `session` and `app_user` (for `groups_resolved_at`). Unknown hash with a cookie present: 401 `session_expired` and the cookie is cleared. Absolute: `now >= absolute_expires_at`. Idle: `now - max(last_seen_at, memo.lastSeen) > SESSION_IDLE_TIMEOUT_MINUTES`. Either expiry deletes the row. A valid hit refreshes an in-memory `lastSeen` and writes `last_seen_at` only when the stored value is at least 60 s old (`SESSION_WRITE_INTERVAL_SECONDS`); after a restart the idle window can therefore be up to 60 s longer than configured, which is documented.
- **Break-glass sessions** (`kind = 'break_glass'`, `oid = ''`) expire absolutely 30 minutes after creation and never slide.
- **Rotation.** A new id at every sign-in and at step-up; a pre-existing id is never reused; the absolute expiry is **not** extended by rotation: a sign-in starts a fresh absolute window, while the step-up rotation copies `created_at` and `absolute_expires_at` from the row it replaces.
- **Limits.** At most 10 sessions per principal (the oldest by `created_at` is evicted at creation); hourly purge of expired rows; the `session_expiry_idx` index serves it.
- **Polling.** `GET /api/v1/connection/runs/current` and `GET /api/v1/connection/log` declare `slidesSession: false` (FR-B-420): a tab left open on the wizard or the connection page does not keep a user session alive, and the memo and `last_seen_at` are not touched by them.
- **Idle header.** Every response of an authenticated request carries `X-Session-Idle-Expires: <ISO timestamp>` (PB-16) so the web client can show the "extend" dialog two minutes before expiry without polling; `GET /api/v1/me` slides the session like any request.

### 10.5 CSRF binding (FR-B-408; SB-09)

`GET /api/v1/csrf` and the check on writes compute `binding = join('.', [sha256hex(sessionCookie), sha256hex(setupCookie)].filter(present))` from the cookies **as sent**, with no database access: a user with only a session cookie gets the SHA-256 of the session id, a setup actor only the SHA-256 of the setup id, an anonymous browser the empty string, exactly as FR-B-408 describes; and a browser holding both (an Owner who reopened setup) gets two hashes joined by a dot. The spec's "bound to the actor's session" would otherwise make the token fetched for the session unusable on setup routes (and the client would loop on `csrf_invalid`). The token format stays Phase A's `v1.<iat>.<exp>.<nonce>.<mac>` with the binding inside the MAC. After rotation (sign-in, step-up, unlock, logout) the old token fails; the client's single refetch-and-retry (Phase A) recovers.

### 10.6 Timeouts and warnings

Defaults 30 minutes idle, 8 hours absolute, step-up window 10 minutes, break-glass 30 minutes, setup session 60 minutes and 8 hours (B-25; ODB-09). The web app (FR-B-416) opens a dialog two minutes before the idle deadline taken from the last `X-Session-Idle-Expires`, with "Sessie verlengen" (a `GET /api/v1/me`), shows a notice five minutes before `session.expiresAt`, and at expiry navigates to `/signin?returnTo=...&error=session_expired`.

### 10.7 MFA gate (FR-B-405)

`evaluateAmr(claim, accepted)` in shared: `claim` must be an array of strings (else `amr_missing`) and contain at least one entry of `AUTH_MFA_AMR_VALUES` (default `mfa`, `multipleauthn`; `pwd`, `wia`, `x509` are refused as configuration values; matching is exact and case-sensitive) else `mfa_required`. `AUTH_REQUIRE_MFA=false` skips the check and the session records `mfa = 0`. The wizard requests the `amr` and `auth_time` optional claims (9.5). Which tenants emit `amr` or `mfa` at all is owner-verified (OV-07, OV-11).

### 10.8 Revalidation (FR-B-409)

At each request, if `now - groups_resolved_at > GROUP_CACHE_TTL_SECONDS` (or it is null after an assignment change), the first request starts a single-flight refresh for that principal (a `Map<oid, Promise>`; later requests await the same promise): `membership.refresh(oid)` and `GraphClient.getUser(oid)` run concurrently with `priority: 'high'` and the interactive budget.

| Outcome | Effect |
|---|---|
| user 404, or `accountEnabled = false` | all sessions of the principal deleted, audit `auth.session.revoked` (actor `system`, `reason: account_disabled`), log `session_revoked`; the request answers 401 `unauthenticated` |
| membership refreshed | cache rows replaced in one transaction, `groups_resolved_at = now`, `groups_stale = 0` |
| Graph failed (any error other than 404 on the user) | `lastFailureAt = now`; direct grants only (group-derived grants are dropped once the TTL has passed); `groups_stale = 1` (the UI shows the notice); no new attempt for 30 s (`REVALIDATE_RETRY_SECONDS`); log `membership_refresh_failed` without ids |

A revocation of a *direct* assignment is effective at once through `rbac_epoch`; an *expiry* removes the rights at the expiry instant because the grants memo carries the earliest expiry (11.6).

### 10.9 Break-glass (FR-B-521 to FR-B-523)

- **Configuration.** `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` together or neither. Format `scrypt:<N>:<r>:<p>:<salt b64url>:<hash b64url>`; parameters: `r` 8 to 16, `p` 1 to 4, `N` a power of two from 16,384, salt 16 to 64 bytes, hash 32 to 64 bytes, and **`128 * N * r` at most 134,217,728 bytes** (so N up to 131,072 at r = 8; V-B10, SB-04); a weaker or heavier hash is `config_invalid`. `hash-password` writes N = 131,072, r = 8, p = 1.
- **Route.** `POST /api/v1/auth/break-glass` (public, 404 when not configured, class `auth`, body cap 4,096 bytes, Origin and an anonymous CSRF token required). Verification runs behind a one-slot queue (at most 1 concurrent and 2 waiting; more answers 429 `break_glass_locked`) because one verification needs up to 128 MiB and about 0.6 s (V-B10). It always does the same work: the username digest is compared with `timingSafeEqual`, and the password is derived against the configured salt and compared with the configured hash, or against a dummy hash of the same parameters when the username differs. Failures: 5 per client in 15 minutes and 20 per hour overall lock the route (429 `break_glass_locked`, integer `Retry-After`); failures inside the bound are audited (`breakglass.signin` denied, actor anonymous); the username is never logged or audited.
- **Session and actor.** Kind `break_glass`, 30 minutes absolute, exempt from MFA and step-up, grants exactly `rbac:manage` (ALL), requires a pinned tenant (`setup_required` before). It may call `GET /rbac/roles`, `GET /rbac/assignments`, `GET /rbac/effective` and `POST /rbac/restore-owner` only: the assignment write routes declare `actorKinds: ['user']` (SB-03, which makes FR-B-523's "no other write route accepts it" true even for a custom role that holds only `rbac:manage`). A `warn` log `break_glass_signin` (no username) and the audit entries `breakglass.signin`, `breakglass.signout`, `rbac.owner.restore` make every use loud. Every page shows the red banner.
- **Not covered:** a lost `APP_KEY` or an expired certificate (sign-in itself is broken; break-glass cannot repair the connection, EB-11); the recovery is `setup-reopen` plus the wizard.

### 10.10 Errors the user sees

`/signin?error=<code>` accepts only the allow-list of spec 6.9.5; any other value renders `signin_failed`. The page offers "Sign in again" (`prompt=login`) and "Use another account" (`prompt=select_account`), never an automatic retry; for `consent_required` and `admin_approval_required` it also shows the tenant-wide consent link (FR-B-419). `/no-access?reason=no_role|graph_unavailable&ref=<request id>` shows the organisation mark and name, a translated explanation, the reference id and the same two actions; it has no data and no session. A signed-in user without the permission for a page sees the in-place No-access content (Phase A). A request to an API route without a session is 401 `unauthenticated` with `WWW-Authenticate: Cookie realm="m365portal"` (U42).

## 11. RBAC and the policy layer

### 11.1 Model and where it lives

`packages/shared/src/rbac/` holds every rule as pure functions so the server enforces and the Phase D "view as" screen computes with the same code: `resources.ts` (`ResourceType`, `PERMISSION_RESOURCE`, global-only set), `roles.ts` (`BUILTIN_ROLES`, `TEMPLATES`), `scope.ts` (`ScopeItem`, `SCOPE_MATRIX`, `normalizeScopeItem`, `canonicalScopeKey`, `matchScope`, `fold`), `effective.ts` (`computeGrants`), `covers.ts` (`covers`, `scopesCover`, `canGrantCore`), `qualifier.ts` (`projectUser`). The server adds the repository, the assignment service, membership resolution, the grants memo and the policy API.

```ts
type ResourceType = 'user' | 'group' | 'distributionList' | 'contact';
type Qualifier = 'full' | 'basic';                               // only users:read has a basic form
type ScopeItem = { target: ResourceType; match:
    | { by: 'id'; id: Guid }
    | { by: 'prefix'; attr: 'displayName' | 'alias' | 'mail'; value: string }
    | { by: 'department'; value: string } };
type Grant = { permission: Permission; qualifier: Qualifier; scope: 'ALL' | readonly ScopeItem[] };
interface ResourceAttrs { type: ResourceType; id?: Guid; displayName?: string | null; alias?: string | null; mail?: string | null; department?: string | null }
```

`PERMISSION_RESOURCE` maps `users:read` -> `user`; `groups:read`, `groups:members:write` -> `group`; `distributionlists:read|members:write|export` -> `distributionList`; `contacts:read|create|update|delete` -> `contact`; `audit:read`, `audit:export`, `settings:branding`, `settings:connection`, `rbac:manage` -> none (*global-only*).

### 11.2 Algorithms

**`computeGrants(assignments, now)`** (the caller passes the assignments whose principal is the user or one of the user's resolved bound groups).

1. Keep an assignment when `expiresAt` is empty or later than `now`.
2. For each kept assignment `A` and each `(p, q)` of its role: if `p` is global-only, contribute `(p, q, ALL)` only when `A` has no scope items; otherwise let `T = PERMISSION_RESOURCE[p]` and contribute `(p, q, items)` with `items = A.scope.filter(target = T)` when that list is not empty, else `ALL` (scopes restrict only the resource types they name; BCB-09). An assignment whose principal is a group contributes neither `rbac:manage` nor `settings:connection` (`GROUP_FORBIDDEN_PERMISSIONS`, FR-B-515): the pure function holds even for a row written around the API.
3. Merge **per `(p, q)`**: scope `ALL` absorbs the rest, otherwise the union of the items, de-duplicated by `canonicalScopeKey`. (SB-13: the spec merges per permission and keeps `basic` only if every contribution is basic, which would hand `full` to resources only a *scoped* full grant covers. Keeping the two qualifiers apart never grants more than the union of the contributions; with all grants unscoped the result equals the spec's.)

**`authorize(actor, p, resource?)`** returns `{allow:true, qualifier}` or `{allow:false, reason}` with `reason` in `permission_missing`, `scope_mismatch`. No grant for `p`: `permission_missing`. No `resource`: allow (the route-level gate; `qualifier` is `full` if any full grant exists). With a `resource`: its type must equal `PERMISSION_RESOURCE[p]` (a mismatch, or a resource passed for a global-only permission, is a programming error and throws, which the wrapper turns into a fail-closed 500 audited as `error`); allow when some grant has scope `ALL` or an item that `matchScope`s the resource; the qualifier is `full` when a matching grant is full. Otherwise `scope_mismatch`. **`visibleScopes(actor, p)`** returns `{full, basic}`, each `'none' | 'all' | ScopeItem[]`; lists, search, bulk actions, exports and the command palette must filter through it.

**`matchScope(item, resource)`**: `item.target` must equal `resource.type`; `id` compares lower-case GUIDs and never matches a resource without an id (so it cannot match a to-be-created object); `prefix` is `fold(resource[attr]).startsWith(fold(item.value))`; `department` is `fold(resource.department) === fold(item.value)`; a missing attribute never matches (fail closed). `fold(s) = s.normalize('NFC').toLowerCase().replaceAll('ς', 'σ')` (the final-sigma replacement removes the one context-dependent case mapping of `toLowerCase`).

**`normalizeScopeItem(raw)`**: validates against `SCOPE_MATRIX` (11.3); GUIDs lower-cased; `value` NFC, trimmed, 1 to 64 code points, none of the organisation-name rejection set (Phase A `containsForbiddenCharacters`: controls, bidi, default-ignorable); at most 50 items per assignment; returns the canonical item or a typed error. `canonicalScopeKey(items)` sorts and serialises the normalised items; the server hashes it with SHA-256 into `rbac_assignment.scope_hash`.

**`covers(a, b)`** (does the actor's item `a` cover the target item `b`): equal items; or both `prefix` on the same target and attribute with `fold(b.value).startsWith(fold(a.value))`; or both `department` and equal. An id item `b` is covered only by an equal id item (an actor with filter scopes never covers an id item, because the id's attributes are unknown). `scopesCover(actorSet, targetSet)`: actor `ALL` covers everything; a target `ALL` needs actor `ALL`; otherwise every target item is covered by some actor item.

**`canGrantCore(actorGrants, role, targetScope)`**: for every `(p, q)` of the role: global-only `p` needs an empty `targetScope` and an actor grant for `p` with scope `ALL`; otherwise the target set is the items of `targetScope` for `T` or `ALL`, the actor set is the union of the actor's grants for `p` whose qualifier is at least `q` (full covers basic, not the reverse), and `scopesCover(actorSet, targetSet)` must hold. Property (`shared/rbac-covers.property.test.ts`, at least 20,000 seeded cases, the seed printed on failure, Greek final-sigma and case-fold strings included in the generator): if `canGrantCore` holds then every resource the target grants allows for `p` is one the actor is allowed on for `p` with at least that qualifier. The deliberately broken `covers` (treats any two prefix items as covering) must fail it.

**`projectUser(user, qualifier)`**: `full` returns the full DTO; `basic` returns `{id, displayName, mail}` and nothing else.

### 11.3 Scope matrix (PB-11; SB-07)

`SCOPE_MATRIX` fixes which match kinds each target accepts; `normalizeScopeItem` and the SQL `CHECK` of `rbac_assignment_scope` enforce the same table (the property test asserts that every normaliser output satisfies the `CHECK`).

| Target | `id` | `prefix` attributes | `department` |
|---|---|---|---|
| `user` | no | `displayName`, `mail` | yes |
| `group` | yes | `displayName`, `alias`, `mail` | no |
| `distributionList` | yes | `displayName`, `alias`, `mail` | no |
| `contact` | yes | `displayName`, `alias`, `mail` | yes |

Group, list and contact `id` scopes cover "only these objects"; `prefix` and `department` cover the brief's "all objects with a prefix or department".

### 11.4 Assignment service

`POST /api/v1/rbac/assignments` (actor kind `user`, permission `rbac:manage`, step-up): validate (Zod strict) -> role exists and `assignable` -> owner role takes no scope and no expiry -> a group principal with a role holding `rbac:manage` or `settings:connection` is refused (`assignment_invalid`, `errors[]` code `privileged_role_group`, FR-B-515) -> every scope target is used by one of the role's permissions and global-only roles take no scope (`assignment_invalid`) -> `expiresAt` in the future and at most 730 days ahead -> **early `canGrant`** (cheap 403 `escalation_denied` before any Graph traffic) -> principal exists: `GraphClient.getUser` or `getGroup` (null: 422 `principal_unknown`; Graph error: 503 `graph_unavailable`) -> `BEGIN IMMEDIATE`: reload the actor's grants (a revocation between the request and the write wins), `canGrant` again, count limits (5,000 assignments, 100 roles, 200 distinct bound groups, 50 scope items), insert the assignment and scope rows, audit `rbac.assignment.create`; a unique-index violation is 409 `assignment_exists`. `DELETE /api/v1/rbac/assignments/{id}` requires `canGrant` for the assignment being removed (nobody removes what they could not grant), the last-Owner check (a pre-check inside the transaction raising `LastOwnerProtected` for a clear audit reason, with the SQL trigger as the backstop that maps to the same 409), then deletes and audits. Both routes are bound to `actorKinds: ['user']`.

### 11.5 Membership resolution (FR-B-507)

`membership.refresh(oid)`: bound groups = distinct `principal_id` of group assignments, minus ids remembered unresolvable for the TTL; chunks of 20 run with at most 4 in flight through `GraphClient.checkMemberGroups`. A `GraphBadRequestError` on a chunk of more than one id splits the chunk in halves recursively (at most 5 extra calls per bad id and 5 bad ids per refresh, else the refresh fails as a whole); a chunk of one that is rejected marks that id unresolvable (U38) and the others still resolve. Any other error fails the refresh. Success replaces the user's rows in `rbac_group_member_cache` and sets `groups_resolved_at` in one transaction. The token's `groups`, `_claim_names`, `_claim_sources` and `hasgroups` are never read.

### 11.6 Grants memo and the epoch

A request reads `rbac_epoch.epoch` and the user's `groups_resolved_at` (the latter arrives with the session row). `GrantsMemo` (LRU 1,000, keyed by `oid`) stores `{epoch, groupsResolvedAt, nextExpiry, grants}` and is used while the epoch and the resolution time are unchanged and `now < nextExpiry` (the earliest `expiresAt` among the contributing assignments), so an expiry removes rights at the instant, a revocation (any change to roles, permissions, assignments or scopes, through the repository or raw SQL, because the SQL triggers bump the epoch) is effective on the next request, and a group assignment change clears the cache rows and `groups_resolved_at` through its own triggers.

### 11.7 Policy layer and the removal of preview mode

| | Phase A | Phase B |
|---|---|---|
| Actor kinds | `anonymous`, `preview` | `anonymous`, `user`, `setup`, `break_glass` (audit also knows `system`, `cli`; old `preview` audit rows stay readable) |
| Source of permissions | preview: all 15, by code, on a loopback `Host` | `user`: rows (assignments, roles, groups); `setup`: the constant pair `settings:branding`, `settings:connection`; `break_glass`: the constant `rbac:manage`; `anonymous`: empty |
| Anonymous write | 403 `permission_denied` | 401 `unauthenticated` (challenge `WWW-Authenticate: Cookie realm="m365portal"`); signed-in without the permission: 403 |
| Default | deny | deny |

How deny by default survives: (1) `defineRoute` still refuses a route without an access declaration at compile time and at boot (the route-table test lists every Phase A and Phase B route and fails on a missing declaration or on a permission-with-resource-type route that declares neither `scoped` nor `unscopedReason`); (2) `authorize` has no allow-by-default branch and is a pure function with the exhaustive matrix test `policy-matrix.test.ts` (15 permissions x actor kinds x resource cases, compared with the table of `docs/permissions.md` parsed independently of the code, so the test is not a restatement of `BUILTIN_ROLES`); (3) every resolver failure degrades to *anonymous*, and a database error while resolving is a 503, never "treat as allowed"; (4) `Actor` objects are created only inside `policy/resolvers/` (a source scan finds no `kind: 'user'`, `'setup'` or `'break_glass'` literal elsewhere); (5) the two fixed grant sets live in one file, `policy/fixed-grants.ts`, asserted equal to the spec table; (6) a failed append of a denial audit entry answers 503 instead of the denial (FR-B-602); (7) the grants memo is keyed by the RBAC epoch, so a stale memo cannot outlive a change; (8) the removal itself is guarded: `PREVIEW_MODE` or the preview actor in `apps/*/src` or `packages/shared/src` fails `shared/repo-conventions.test.ts` (+ negative), and a server started with `PREVIEW_MODE=true` is tested to behave as anonymous (`server/config.test.ts`). The audit writer keeps `preview` in its **read** schema so Phase A rows and the Phase D list screen still parse, and removes it from the **write** enum.

### 11.8 The route wrapper

```ts
type Access =
  | { public: true }
  | { authenticated: true; actorKinds?: ActorKind[] }
  | { permission: Permission; stepUp?: true; actorKinds?: ActorKind[]; scoped?: ResourceType; unscopedReason?: string }
  | { setup: true }                                   // setup actor, only while the state is not completed
  | { connection: true; stepUp?: true };              // setup actor while not completed, otherwise settings:connection
```

Order inside the wrapper (after rate limit, body limit, content type, Origin, CSRF): resolve the actor -> `public` skips -> missing session on a non-public route: 401 `unauthenticated` (cookie present but unknown or expired: 401 `session_expired` and clear it) -> `actorKinds` mismatch: 403 `permission_denied` -> `authorize` -> 403 `permission_denied` (reason `permission_missing`) -> `stepUp`: user actors need `step_up_at` within 10 minutes, else 403 `step_up_required` (setup and break-glass exempt) -> validation -> handler. `ctx.authorizeResource(p, resource)` and `ctx.visibleScopes(p)` set a flag; when `access.scoped` is declared and the handler returns 2xx without the flag, the wrapper replaces the response with 500 `policy_not_applied` and audits `error` (EB-35). **This net detects a forgotten check; it cannot undo a write the handler already did.** Hence the Phase C/D rule below.

### 11.9 Rule for Phase C and D (prepared here, documented in `docs/architecture.md`)

Every response that carries user attributes (members of groups and lists, search results, exports, audit labels) passes `projectUser` with the actor's `users:read` qualifier, so a `basic` grant cannot be widened by a route that returns users in another shape; Phase C adds a route-table guard (a route declaring `returnsUsers` without the qualifier fails). Role, permission and scope texts come only from the label functions of FR-B-716.

Service methods that read or change a scoped resource take a capability argument (`AuthorizedResource<T>` or `VisibleScope<T>`) that only `ctx.authorizeResource` and `ctx.visibleScopes` can create (a branded type, constructor private to `policy/`). A handler therefore cannot call the service without having asked the policy layer, at compile time; the runtime net of 11.8 is the second line. Lists, search, the command palette, bulk actions and exports take their object set from `visibleScopes`.

### 11.10 `restore-owner` (FR-B-523)

`POST /api/v1/rbac/restore-owner` `{userId, confirmUnverified?}`: actor kind `break_glass` only (an Owner gets 403). `GraphClient.getUser(userId)`: null -> 422 `principal_unknown`; `accountEnabled` false -> 422 `principal_unknown` with `errors[]` code `principal_disabled` (FR-B-523); Graph unavailable -> 503 `graph_unavailable` unless `confirmUnverified: true` (the operator accepts the id as typed; `graphChecked: false` in the audit). Then one transaction inserts the `owner` assignment (`principal_type user`, `source: 'break_glass'`, `created_by: 'break-glass'`), skipping `canGrant` (the only path that does), and audits `rbac.owner.restore`. An existing Owner assignment for that user is 409 `assignment_exists`.

### 11.11 "Mijn toegang"

`GET /api/v1/me/access` returns the signed-in user's active assignments with their origin (`direct` or `group` with the group id and, best effort through the 60-second cached `getGroup`, its name), scopes as items, expiry, and the effective grants; it is read-only and needs only a session.

## 12. Web architecture

### 12.1 Routes and gating (FR-B-607)

| Path | Page | Gate | Loaded |
|---|---|---|---|
| `/signin` | Sign-in page and every `?error=` variant, `?signedout=1`, organisation mark and name | public; a visitor who already has a session is sent to `returnTo` | route chunk of about 3 KiB (a Lighthouse route, kept light) |
| `/no-access` | `?reason=no_role\|graph_unavailable&ref=` | none | entry (Phase A) |
| `/setup`, `/setup/*` | token form, or the wizard when `GET /api/v1/setup/state` succeeds; `/setup/<anything>` and `/setup` when the server answered 404 render Not-found | none in the client (the server decides) | lazy chunk `setup` |
| `/break-glass` | username and password form, red warning text | Not-found unless `me.features.breakGlass` | lazy |
| `/settings/connection` | state, certificate expiry, proof list, log, "Herstel verbinding" | `settings:connection` | lazy |
| `/settings/access` | "Mijn toegang" | any signed-in actor | lazy |
| `/settings/restore-access` | "Eigenaar herstellen" | actor kind `break_glass` | lazy |

An anonymous visitor of a gated route is replaced (history `replace`) to `/signin?returnTo=<path>`; a signed-in actor without the permission sees the in-place No-access content at the same URL (Phase A). While the setup state is not `completed` the server answers an HTML navigation to any panel page other than `/setup`, `/signin`, `/no-access` and static assets with 303 to `/setup`, **unless the request carries a valid user session** (SB-14: a non-designated user who signs in during `awaiting_first_signin` must not land on the token form; SB-26: a user without a role has no session, and the callback sends them to `/no-access`, which therefore must not bounce to `/setup` either). The command registry and the sidebar add the Settings entries by permission and, for restore-access, by actor kind (`anyOf` plus `actorKinds`).

### 12.2 Boot data and the Strict-cookie re-check (PB-15)

The embedded boot data carries the real `MeResponse`. A navigation that starts on another site (a link in mail or chat) does not carry a `SameSite=Strict` cookie, so the shell is rendered for an anonymous actor although the user has a session. On boot, when `boot.me.actor.kind` is `anonymous` and `boot.me.setup.state` is not `unconfigured`, the client sends one `GET /api/v1/me` (same-origin, so the cookie is sent) before any gating redirect; a signed-in answer replaces the boot data, an anonymous answer proceeds to the gate (`/signin?returnTo=`). The wait is capped at 800 ms and shows the shell skeleton. This keeps `Strict` (brief section 6) without bouncing users who are signed in. Controls: `web/boot-recheck.test.tsx`; `e2e/signin.spec.ts` follows a link from a page on `http://127.0.0.1:<port>` (a different site from `localhost`) and expects the signed-in persona.

### 12.3 API client changes (`lib/api.ts`, still the only code that calls `fetch`)

`unauthenticated` navigates to `/signin?returnTo=<current path>`; `session_expired` to `/signin?error=session_expired&returnTo=...`; `step_up_required` opens `StepUpDialog` ("Bevestig met opnieuw aanmelden"), which on confirmation navigates to `/auth/login?purpose=stepup&returnTo=<current path>`; after the return the user repeats the action (no automatic replay of a write); `csrf_invalid` keeps the Phase A single refetch-and-retry. The client reads `X-Session-Idle-Expires` from every response into a small store. `lib/ms-url.ts` accepts a logout redirect only if it is `https:` on host `login.microsoftonline.com` or exactly the local path `/signin?signedout=1`; `web/navigation.test.ts` scans the source for any `fetch`, `XMLHttpRequest` or `EventSource` to an absolute URL.

### 12.4 Session UX (FR-B-416, FR-B-608)

`SessionTimers` (mounted for user sessions): a dialog two minutes before the idle deadline with "Sessie verlengen" (calls `GET /api/v1/me`), a polite notice five minutes before `session.expiresAt`, and navigation to `/signin?error=session_expired&returnTo=` at expiry; a break-glass session shows the absolute countdown only. `PersonaMenu` in the header: initials Persona, "Mijn toegang", "Uitloggen", "Overal uitloggen" (user sessions only). `BreakGlassBanner`: a non-dismissable red status region on every route of a break-glass session. A `groupsStale` notice ("lidmaatschap kon niet worden bepaald") appears while `session.groupsStale` is true.

### 12.5 Wizard UI (FR-B-221, FR-B-609)

The UI holds no wizard state beyond what the server returns: `GET /api/v1/setup/state` once, then `GET /api/v1/connection/runs/current?after=<seq>` every second while a run is active or the device code is shown (every 2 seconds when the tab is hidden), and again after every action.

| Component | Content |
|---|---|
| `TokenForm` | one password-type field with an accessible name, submit; states: idle, submitting, `setup_token_invalid` (generic message), `setup_token_locked` (countdown from `Retry-After`), gate closed (404: Not-found) |
| `StepList` | `<ol>` with `aria-current="step"`, per step an icon and a text status (`pending`, `running`, `waiting`, `succeeded`, `warning`, `failed`, `skipped`) and a progress indicator |
| `EnvironmentStep` | six checks with icon, text and remedy keys; "Opnieuw controleren" |
| `ConnectStep` | optional tenant id or domain, "Aanmelden met Microsoft" (starts the run), `DeviceCodePanel` (code as selectable text with a copy button, the allow-listed `<a rel="noopener noreferrer" target="_blank">`, a countdown to `expiresAt`, the instruction to leave "Consent on behalf of your organization" off), cancel; the manual mode entry |
| `ConfigureStep`, `VerifyStep` | sub-action rows with status, attempt, rollback hint, a waiting countdown with "Nu opnieuw proberen", the adoption prompt (names the existing application, explicit confirmation), the proof list |
| `LogRegion` | `role="log"`, `aria-live="polite"`, auto-scrolls only when the user is at the bottom |
| `FinishStep` | the Phase A Appearance form (lazy), language choice, Beheerder group search (`GET /api/v1/setup/groups?q=`), summary, "Voltooien", then "Aanmelden" |
| `ManualMode` | the generated checklist, `.cer` download, the three inputs, "Controleren" |

Focus moves to the step heading when the step changes and to the error summary on failure; status is never colour alone; targets are at least 24 by 24 CSS pixels; all text comes from the catalogue; the UI never renders server-supplied free text (it renders keys and parameters). The test matrix (`web/setup-wizard.test.tsx`, `e2e/a11y.spec.ts`, `e2e/visual.spec.ts`) enumerates the token form states and every step in each of the seven statuses, manual mode and finish, in light and dark at both viewport sizes.

### 12.6 Internationalisation

Ten new namespaces, two files each, in `packages/shared/src/i18n/fragments/`: `setup` (S-B6), `connection`, `signin`, `noaccess`, `access`, `role`, `permission`, `session`, `breakglass`, `scope`, plus the 19 `problem.*` entries in the existing `problem` fragment (S-B1) and the sign-in code messages. Phase A planned both catalogues into the entry chunk and a revisit at 20 KiB gzip for both (PD-16); about 355 keys per language push past it (PB-17). So `signin`, `noaccess`, `session`, `role`, `permission` and `scope` join the entry, while `setup`, `connection`, `breakglass` and `access` become **lazy namespace files per locale** (`locales/lazy/<namespace>.<locale>.json`, generated by `pnpm i18n:merge` from the fragments and checked by the same catalogue rules) loaded by `loadNamespace(locale, ns)` in the route's `beforeLoad` (AM-21). If the bundle budget shows the entry growing by more than 8 KiB gzip, `access` and `session` move out as well. The catalogue check (key parity, placeholder parity, empty values, plural completeness, "no value in a third script", baseline section 12) runs on the merged files and on every lazy file.

### 12.7 Service worker (AM-12, PB-18)

`sw/routing.ts` returns `pass` (no `respondWith`, browser default) for `/auth/*` and `/api/*`, so the redirect and cookie handling of the sign-in flow never goes through a service-worker `fetch`; navigations to `/signin`, `/setup`, `/no-access`, `/break-glass` stay network-first with the offline fallback and are never stored. The hostile-URL table of `web/sw-routing.test.ts` gains encodings of `/auth/`, `/api/` and `/setup`.

## 13. CSP, Trusted Types and the other headers

Phase B changes **no** header (FR-B-605). The checks that keep it so: the CSP string equals the Phase A constant (`server/security-headers.test.ts`, extended to the new routes and the interstitial; adding `https://login.microsoftonline.com` to `connect-src` must fail it); `connect-src 'self'` holds because the device-code polling, the token exchange and every Graph and Exchange call are made by the server; `form-action 'self'` holds because sign-in and sign-out are navigations and a `fetch` of the same origin, never a form post to Microsoft; `frame-src` is absent; `trusted-types m365portal-sw` is unchanged because the new client code uses no Trusted Types sink (no `innerHTML`, no script URLs; `location.assign(url)` and `<a href>` are navigations, and `navigator.clipboard.writeText` for the copy button is covered by the Phase A `Permissions-Policy` entry `clipboard-write=(self)`). The device-login anchor and the Entra navigations leave the page with `Referrer-Policy: no-referrer`, so the authorization `code` in the callback URL cannot leak through a referrer, and the callback response is `no-store`. The interstitial uses the *html* profile with a nonce and contains no script and no style (an unstyled page for the instant before the refresh). Both COOP `same-origin` and the Entra round trip are compatible: the round trip is a top-level navigation. The e2e fixture (`securitypolicyviolation`, `pageerror`, `console.error`, `Permissions-Policy` warnings, unexpected 4xx/5xx) runs on every new route, and `e2e/csp.spec.ts` additionally asserts that no request from page scripts goes to a Microsoft host.

## 14. Test strategy

### 14.1 Layers

| Layer | Tooling | Subject |
|---|---|---|
| Unit, shared | Vitest | RBAC algorithms and properties, cookie names, redirect URIs, `safeReturnTo`, `evaluateAmr`, scope normaliser, registries, schemas, backoff constants, desired state |
| Unit, server | Vitest, injected `Clock`/`Scheduler`/`RandomSource`, real SQLite file per test | secrets, config, backoff, classification, sessions, limiter, break-glass hash, repositories, policy matrix |
| Integration | `app.fetch` + the fake tenant behind MSW + `FakeBrowser` | the whole wizard, the sign-in matrix F-01 to F-45, logout, step-up, revalidation, RBAC API, audit coverage, no-leak canaries |
| Contract suites | one suite, two implementations | `GraphClient` (HTTP on MSW, `FakeGraphClient`), `ExchangeClient` (Admin API adapter on MSW, `FakeExchangeClient`) |
| Component | happy-dom + Testing Library, `fetch` stubbed | wizard states, sign-in page, persona menu, timers, access page, boot re-check |
| End to end | Playwright against the production bundle, MSW preload, fake tenant over local HTTP, Playwright routes for the browser's Microsoft navigations | wizard, sign-in, step-up, logout, break-glass, lock, degraded secrets, nav gating, CSP |
| Accessibility, visual, Lighthouse | axe, `toHaveScreenshot` (threshold 0), Lighthouse CLI | every new route and wizard state (14.5) |
| Repository and image | Python unittest, `scripts/image-smoke.ts` | content bans, CLI commands under `--read-only`, certificate creation in the image, unlock and restart persistence |
| Owner-verified | none | the ledger of spec 8.6 |

### 14.2 The fake tenant (`apps/server/test/fakes/fake-tenant/`)

One module exposing `createFakeTenant(options)` -> `{ fetch(request): Promise<Response>, control, calls, reset() }`. It is a pure WHATWG handler keyed by host and path, with no network and no globals, driven by the injected clock. It contains:

- **Entra.** Discovery and key documents per tenant (key rotation: `control.rotateKeys()` adds a key, `control.dropOldKeys()` removes the old); `GET /authorize` (validates client id, exact registered redirect URI with the localhost port rule, `response_type`, `response_mode=query`, `scope`, `state`, `nonce`, PKCE S256, `prompt`; signs in `control.nextSignIn`; redirects with `code` and `state`); `POST /token` for `authorization_code` (single-use code valid 60 s, PKCE check, **client assertion validated as Learn describes**: `alg` PS256, `typ` JWT, `x5t#S256` equal to a registered key credential, `iss` = `sub` = client id, `aud` = the tenant token endpoint, `jti` unique, `nbf`/`exp` with `exp` at most 10 minutes after `nbf`, signature against the registered public key), for `client_credentials` (same assertion rule; the access token is opaque and *snapshots the application's role grants and Entra roles at issue time*, so a token requested before a role assignment lacks it, research §4), and for the device grant (accepts both `device_code` and the URN spelling, V-B04); `POST /devicecode` (`user_code`, `device_code`, `verification_uri`, `expires_in` 900, `interval` 5 scaled by the test, V-B13); logout endpoint with `post_logout_redirect_uri` validated against the registered URIs; fault toggles: Conditional Access block (`AADSTS53003`), declined, expired, `slow_down`, `temporarily_unavailable`, 503, `invalid_client`, consent and admin-approval errors, missing `amr`, `amr` variants, deleted or disabled user.
- **Graph.** An in-memory directory (organization, users, groups with nesting and hidden membership, applications, service principals for Graph and Exchange with their `appRoles`, app role assignments, directory role assignments) and exactly the endpoints of the call sheet and of `GraphClient`, with `$filter` on `appId`, `displayName`, `principalId`, `startswith(displayName,...)`; `PATCH keyCredentials` with **replacement semantics**; duplicate grants answer as configured (201 idempotent or 409, U31); `checkMemberGroups` rejects more than 20 ids and any malformed id with 400 and treats an unknown id as configured (400 or omitted, U38); **replication delay**: an object created is invisible for the next N calls touching it (`control.replicationDelay`), answering 404/400 as research §10.2 describes; throttling (`429` with `Retry-After` in seconds and as an HTTP date), 5xx counts, an application management policy refusing a credential lifetime, a missing Exchange service principal.
- **Exchange.** `POST /adminapi/v2.0/<tid>/<Endpoint>` requires the bearer, `X-AnchorMailbox` and the body envelope; role effective only for tokens whose snapshot has the Entra role and `Exchange.ManageAsAppV2`; any other endpoint or cmdlet answers 400; paging by `@odata.nextLink`.
- **Recording.** `calls` lists every request with host, method, path, status and `mutating`; `calls.mutating()` feeds the idempotency and resume tests. `control.crashAfterMutating(n)` applies the n-th mutating call and then rejects with a simulated network failure; the test then discards every in-memory object, rebuilds the application over the **same data directory and the same fake directory state**, and continues (this is process death as far as the product can tell; the number of points is read from an uninterrupted run).
- **Self-test.** `fake-tenant.selftest.test.ts` asserts the strictness (an assertion without `x5t#S256` is refused; a PATCH that omits the other credentials removes them; an unlisted endpoint 404s) and every toggle, because a lenient fake gives false greens (baseline section 2, and RB-10).

### 14.3 MSW, the preload and the no-egress guard

- **Vitest** (`test/setup/msw.ts`, `test/setup/no-egress.ts`, both in the `server` project's `setupFiles`): `setupServer(http.all(/^https:\/\/(login\.microsoftonline\.com|graph\.microsoft\.com|outlook\.office365\.com)\//, ({request}) => fake.fetch(request)))`, `listen({ onUnhandledFrame: 'error' })`, `afterEach` resets handlers and the fake. The guard patches `net.Socket.prototype.connect` to destroy any connection to a non-loopback host with `ENOEGRESS` (V-B06). A test that opens a real socket must fail (negative control), which is what would have exposed the `node:https` hole of V-B05.
- **e2e server process** (`e2e/support/server-preload.mjs`, used as `node --import e2e/support/server-preload.mjs apps/server/dist/index.js`): installs the guard and an MSW server whose handler forwards the three Microsoft hosts to the fake tenant's local HTTP server as `http://127.0.0.1:<E2E_PORT+2>/<host><path>` using `bypass()` (V-B05). No production file references the preload, MSW or the fake (`server/no-test-hooks.test.ts`, `py/check_image_contents.py`).
- **Browser.** `context.route(/^https:\/\/login\.microsoftonline\.com\//, ...)` answers the browser's authorize and end-session navigations from the same fake (so the page never leaves the machine).

### 14.4 Time, randomness and fixtures

Every new unit takes `Clock`, `Scheduler` and `RandomSource`; tests use `FakeClock` (settable `now`), `FakeScheduler` (timers fire when the clock advances) and a seeded generator; no test sleeps. `jose` is given `currentDate` from the clock. MSAL's own token cache uses the real clock, so tests of app tokens use `skipCache` or short real expiry values from the fake. The fixture inventory is: F-01 to F-45 (spec Appendix C), the six wizard scenarios of US-B2/B3, the fault-injection matrix, the principals `owner`, `administrator`, `operator`, `helpdesk`, `reader`, `norole` (Global Administrator without a panel role: the fake adds `wids` claims that the product must ignore), `expired-assignment`, `group-member`.

### 14.5 End-to-end topology (FR-B-708)

`playwright.config.ts` starts three processes: the fake tenant (HTTP, port `E2E_PORT + 2`), instance A `configured` (port `E2E_PORT`, a fresh data directory, `SETUP_TOKEN`, `APP_KEY` and break-glass variables generated per run, `SHOWCASE=true`, relaxed idle and absolute timeouts so storage states stay valid) and instance B `empty` (port `E2E_PORT + 1`). `globalSetup` seeds A by driving the real setup API against the fake (unlock, environment, device code approved through the fake control endpoint, configure, verify, finish) and then signing in the Owner through a scripted browser, then creates the fixture assignments through the real API with a step-up, and writes one `storageState` per principal; the `expired-assignment` row is inserted directly in the database with a past expiry, because the API refuses one (documented in `fixtures-selftest.spec.ts`). Every test still fails on `pageerror`, `console.error`, `securitypolicyviolation`, unexpected 4xx or 5xx, and `Permissions-Policy` warnings; Phase A specs are migrated, not deleted.

### 14.6 Negative controls (a guard nobody has seen fail is an assumption)

Each row is a test that applies the control to the guard and expects red, run through `expectGuardFails` (`@m365portal/shared/testing`) so the green suite is evidence.

| Guard | Control (made to fail on purpose) | Test |
|---|---|---|
| Route table (access declared, setup gate, `unscopedReason`) | register a route without access; a setup route without the gate flag; a permission-with-resource route without `scoped`/`unscopedReason` | `server/route-table.test.ts`, `server/setup/gate.test.ts` |
| `policy_not_applied` net | a test-only route that returns 2xx without calling the policy API | `server/policy-scoped-routes.test.ts` |
| `covers` / `canGrantCore` | a `covers` that treats any two prefix items as covering | `shared/rbac-covers.property.test.ts` |
| `computeGrants` expiry and epoch | a copy that ignores expiry; a memo that ignores the epoch | `server/rbac/expiry.test.ts`, `server/rbac/epoch.test.ts` |
| Last owner | the same test run against a database built without the trigger | `server/rbac/last-owner.test.ts` |
| Built-in immutability | a database without the triggers | `server/rbac/builtin-roles.test.ts` |
| ID-token validator | copies that skip the nonce, the tenant peek, the `aud` string rule, the `iat` rule, the `alg` check | `server/integrations/identity/id-token.test.ts` |
| Interstitial | a callback that answers 303 | `server/auth/interstitial.test.ts` |
| Cookie names | a function that drops `__Host-` on https | `shared/cookie-names.test.ts` |
| Loopback guard | a guard that ignores `Host`; one that ignores `X-Forwarded-For` | `server/setup/loopback-guard.test.ts` |
| Unlock limiter | a limiter that counts only 10 failures | `server/setup/unlock-rate.test.ts` |
| Layering | a service file importing `node:https`; a lint canary case | `server/layering.test.ts`, `tools/lint-canary` |
| No-egress guard | a test opening a real socket | `server/fakes/no-egress.test.ts` |
| Single implementation | a second `evaluateAmr`, `signClientAssertion` or `cookieNames` | `shared/single-implementation.test.ts`, `server/single-implementation.test.ts` |
| Schema parity | a migration default that differs from the schema | `server/schema-parity.test.ts` |
| Migration triggers | each of the 29 triggers dropped in turn must make at least one case fail; a trigger without a case fails the completeness check | `server/migrations.phase-b.test.ts` |
| Data-model document | a copy of the SQL block of data-model.md with one changed constant must differ from the migration | `server/migrations.doc.test.ts` |
| Contract document | a route in the route table that the contract file lacks, and the reverse; an exemption (`secFetch`) on a second route | `server/docs-contract.test.ts`, `server/route-table.test.ts` |
| Preview removal | a source file containing `PREVIEW_MODE` | `shared/repo-conventions.test.ts` |
| Secrets in files | a data directory containing the PEM or the key | `server/secrets/no-plaintext.test.ts` |
| Headers | `connect-src` with a Microsoft host | `server/security-headers.test.ts` |
| Test hooks in production | `fake-tenant` referenced from `apps/server/src` | `server/no-test-hooks.test.ts` |
| Bootstrap lifetime | a bootstrap object that is not discarded after `audit_reads` | `server/setup/bootstrap-token-lifecycle.test.ts` |
| URL discipline | a client that follows any `nextLink`; a tenant hint with `/` or `@` | `server/integrations/url-discipline.test.ts` |
| Adoption trust | a wizard that adopts without reading credentials and owners | `server/setup/discovery.test.ts` |
| Exchange role allow-list | a start request with a privileged template id reaching Graph | `server/setup/assign-exchange-role.test.ts` |
| Group-privileged rule | a `computeGrants` that lets a group-bound assignment grant `rbac:manage` | `server/rbac/group-privileged.test.ts`, `shared/rbac-effective.test.ts` |
| Reopen with a stale `SETUP_TOKEN` | a CLI that ignores the variable | `server/setup/cli-setup.test.ts` |
| Polling keeps a session alive | a POST route flagged `slidesSession: false`; polling that extends the idle deadline | `server/route-table.test.ts`, `server/auth/session-store.test.ts` |
| Labels | a second `roleLabelKey` or a hand-built `role.` key | `shared/single-implementation.test.ts` |
| Phase C artefact | a fixture with a `users` module or a `listUsers` method | `tools/traceability/traceability.test.ts` |

### 14.7 Requirement-to-control completeness (baseline section 7)

`tools/traceability` is extended to read `specs/002-phase-b/spec.md`: every MUST row names at least one control path, and (once the code exists) every named path exists on disk; the only allowed exception is FR-B-712 (review). `server/docs-contract.test.ts` checks that the plan's negative-control table paths exist. `tasks.md` keeps the mapping one to one and updates the spec in the same commit when a test is renamed (spec section 2).

## 15. Performance budgets

Measured on the planning machine where a number exists; otherwise a budget the implementation measures. Timing gates follow baseline section 8 (best of three, all runs kept); only the Lighthouse and image gates are CI gates, the rest are measured and reported.

| Area | Budget | Evidence or gate |
|---|---|---|
| Idle memory | RSS at most 200 MB (Phase A 150 MB plus the measured +43 MB for MSAL, jose, libsodium; the X.509 packages load only on certificate creation) | V-B03; `image` smoke test reports it |
| Break-glass verification | at most 128 MiB for at most 0.7 s on the CI runner, one at a time | V-B10 |
| Sign-in callback, server work excluding Microsoft | at most 50 ms p95 (RS256 verify well under 1 ms, PS256 sign about 2 ms, one write transaction) | measured in `server/auth/callback.test.ts`, not gated |
| Microsoft round trips per sign-in | token exchange (1, one retry at most) plus `ceil(G / 20)` `checkMemberGroups` calls for `G` bound groups; zero key fetches when cached | counted in `fake.calls` by `server/rbac/membership.test.ts` |
| Revalidation | `ceil(G / 20) + 1` calls per active user per `GROUP_CACHE_TTL_SECONDS` (default 300 s); at most 4 in flight | `server/auth/revalidate.test.ts` |
| Policy check per request | session + epoch reads, memo hit, `authorize`: at most 0.5 ms p95; `computeGrants` for 100 assignments and 20 groups at most 2 ms | measured in `shared/rbac-effective.test.ts` |
| Wizard clean run | at most 11 mutating calls (SC-B-002); the poll load is 1 request per second per open wizard tab | `server/setup/idempotency.test.ts` |
| Property tests | 20,000 cases each under 20 s on the CI runner | `shared/rbac-*.test.ts` |
| Web, entry JS | at most +8 KiB gzip over the Phase A budget; each lazy route chunk at most 40 KiB gzip (`setup` the largest) | `quality` step "Bundle budget" (ratcheted) |
| Lighthouse | at least 95 for `/signin`, `/no-access?reason=no_role`, `/setup` (token form), mobile and desktop; authenticated routes reported, not gated | `e2e` step "Lighthouse" |
| Image | the measured +17 MB of production dependencies stays under the 400 MB ceiling; the new ceiling is recorded with the measured value | `image` job |
| CI time | `quality` +2 minutes, `e2e` +4 minutes over Phase A | monitored, not gated |

## 16. Documentation plan

Owner: S-B7 for everything except the ADR text of decisions made inside a stream. All documents exist in Dutch and English where the repository requires it (README, operations, security, permissions); `server/docs-contract.test.ts` and `server/limits-doc.test.ts` check the contract (FR-B-709).

| Document | Phase B content | Check |
|---|---|---|
| `README.md` (nl, en) | First run in order: generate the key (`docker run --rm <image> dist/cli.js generate-app-key`: the distroless image's entrypoint is Node, so the command line is the script; U34 until the smoke test runs it), `docker run` with `-e APP_KEY` or the Compose secret, print the setup token with `docker exec`, open `/setup`, what the administrator needs (Global Administrator, or Privileged Role Administrator plus Application Administrator or Cloud Application Administrator), leaving "Consent on behalf of your organization" off, signing in; `http://localhost` versus https | docs contract |
| `docs/security.md` | The STRIDE seed below as tables, first-run takeover analysis, cookie and CSRF design with the `localhost` trade-off and the combined binding, session and step-up design, the Exchange Administrator blast radius, the self-signed certificate trade-off (Learn advises a CA certificate; none exists for a self-hosted panel), why headers are unchanged, what the simulation cannot prove (the owner-verified ledger), ASVS level 2 rows V2, V3, V4, V6, V7, V8, V13, the attack review of 16.1 as tables, the key-compromise note (rotating `APP_KEY` does not renew the certificate), DNS rebinding and the loopback `Host` rule, control from the Entra side (group owners, application owners, credential holders), break-glass without a second factor (ODB-17), the advice to block device code flow by Conditional Access outside the wizard window and to use manual mode then (research §5.6), `docker inspect` exposure of `-e APP_KEY` (prefer a secret or `APP_KEY_FILE`), the accepted risks | docs contract |
| `docs/permissions.md` | The 15-permission matrix of spec 6.9.4 (identical), the four Graph application roles with reason, phase, status and the delta against the brief, the evidence table of 8.8, the wizard's three delegated scopes, Exchange roles and the Entra role with the two `EXCHANGE_ROLES` templates and their Learn source, resource-type map and scope semantics | `shared/rbac-matrix.test.ts`, docs contract |
| `docs/operations.md` | Env table (14 new variables), limits table with the new rows, `APP_KEY` generation, separate backup and rotation (7.5), certificate expiry and renewal, setup token and `setup-reopen` (and that it blocks sign-in until finished and refuses while `SETUP_TOKEN` is set), the key-compromise procedure (renew the certificate, delete older copies of `/data` and every `pre-rotate-*`), break-glass hash and use (14-character floor, restrict the route by address at the proxy), timeouts, reverse-proxy checklist (preserve `Host`, forward cookies, no HTML caching, body at least 9,437,184 bytes), outbound hosts, sovereign clouds unsupported, `NODE_USE_ENV_PROXY` hint marked UNVERIFIED, Dutch section | `server/limits-doc.test.ts`, docs contract |
| `docs/architecture.md` | Layering with the `integrations` boundary and the fetch-only rule, module list, dependency rows with reuse marks (6 new), the Phase C/D capability rule of 11.9, accessibility additions (session timing, wizard) | docs contract |
| `docs/open-points.md` | U34 to U50 with dates and what was tried, updates to U22/U31/U33/U40/U41/U43/U44, the owner-verified ledger, assumptions B-01 to B-26 and PB-01 to PB-28, risks RB-01 to RB-18 and PBR-01 to PBR-14 | docs contract |
| `docs/adr/` | ADR-0101 to ADR-0126 for B-01 to B-26 and ADR-0151 to ADR-0178 for PB-01 to PB-28 (17.1); fields `Status`, `Context`, `Decision`, `Consequences`, `Evidence` | docs contract (AM-22) |
| `docs/phase-reports/phase-B.md` | Spec section 3, the owner checklist (one line and a result field per OV item), the decisions ODB-01 to ODB-18, Exchange memo, what ran locally, on GitHub only, simulated, owner-verified | review (FR-B-712) |

### STRIDE seed for `docs/security.md`

| Surface | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Setup gate (unconfigured panel) | a stranger opens `/setup` -> one-time token, constant-time compare, per-client and global lock | token in URL -> accepted only in a POST body | unlock locks audited once | token never in logs, shell, OpenAPI; `Cache-Control: no-store` | lock flooding by many clients -> global lock is the accepted cost; counters bounded | wizard grants tenant admin -> token + Entra administrator both needed |
| Wizard and bootstrap token | a phisher shows a fake device code -> only the allow-listed `https` host is rendered as a link | partial writes -> idempotent sub-actions, full-list credential PATCH | every object change audited in the same transaction | bootstrap token memory only, discarded before probes | runaway retries -> bounded windows and tries | bootstrap holds `RoleManagement.ReadWrite.Directory` only for the run |
| Sign-in | login CSRF and token substitution -> `state`, `nonce`, PKCE, transaction cookie | forged ID token -> signature, issuer, tenant, audience, algorithm, nonce, header checks | sign-in and every denial audited from token validation on | no token retained; `no-store`; code never logged | transaction floods -> caps and rate class `auth` | user without a role gets no session |
| Sessions | stolen cookie -> `HttpOnly`, `Strict`, hashed at rest, idle and absolute timeouts | rotation prevents fixation | sign-out and revocation audited | only the hash stored, no IP or agent | per-principal cap of 10 | step-up for role changes |
| RBAC and policy | spoofed actor -> actor from the cookie only | role tampering -> immutable built-ins by trigger | role and assignment changes and every 403 audited | `me` exposes only the actor's own data | assignment and group limits | no privilege escalation, last Owner protected, scope enforced server-side, fail closed |
| Secrets | key theft from backup -> key not in `/data` | blob swap -> AD binds row, purpose, key id | rotation audited | sealed blob only; redacted holder | missing key -> degraded, not crash | key never leaves `secrets/` |
| Break-glass | brute force -> scrypt, 5 per 15 minutes, 20 per hour, one-slot queue | none | every use audited and logged loudly | username never logged | memory-bound verification (128 MiB) | restore-Owner only, no other write |
| Microsoft clients | host confusion -> fixed origins, `redirect: 'error'`, GUID-validated paths | injection into OData -> escaped literals | calls counted | tokens opaque wrappers, never logged | throttling -> bounded retry, `Retry-After` honoured | runtime app never holds `FORBIDDEN_APP_ROLES` |

### 16.1 Attack review of the design (analysis pass of 2026-10-10)

Each row attacks one surface named by the owner, says which control already stood, what the review found missing, and what was done: a new requirement with a named control, or an owner decision. "Covered" means the existing control was read and found sufficient. Residual risks are accepted and go to `docs/security.md`.

| # | Attack | Existing control | Gap found | Fix or decision | Residual |
|---|---|---|---|---|---|
| 1 | First-run takeover of `/setup` | Setup token (32 random bytes, or a validated `SETUP_TOKEN`), constant-time compare, per-client and global lock, 404 after the lock, loopback guard over plain http, token only in a POST body, never logged (FR-B-203 to FR-B-207) | After `setup-reopen` a `SETUP_TOKEN` still set in the environment governs again, although it may be known (compose files, tickets, shell history) | FR-B-223: the CLI refuses while the variable is set; a warning at start; EB-37 | The global lock can be used to deny unlocking (RB-17); a host administrator can read the token file (host compromise is out of scope) |
| 2 | Device-code phishing and consent abuse | A device code exists only for the setup actor, one run at a time (lease), 15-minute life, link host allow-list, Entra `message` never rendered, consent on behalf of the organisation left off, three scopes, token in memory and discarded before the probes (FR-B-214, FR-B-215) | Nothing made the operator confirm who becomes Owner; the panel cannot stop phishing of the same Microsoft client outside itself | `confirmOwnerOid` on finish (FR-B-219 h); `docs/security.md` advises blocking device code flow by Conditional Access outside the wizard window and using manual mode then (research §5.6) | Entra-side phishing is outside the panel; the holder of the setup token is trusted |
| 3 | Bootstrap token handling | FR-B-215: one object, no cache plugin, four discard triggers, canary lifecycle test | none | Covered | Memory residue after `memzero` in a garbage-collected runtime, core dumps and swap: documented |
| 4 | CSRF, login CSRF, session fixation | Origin plus a token bound to the presented cookies; single-use state, nonce and Lax transaction cookie; a new session id at sign-in and step-up; `__Host-` names; fixtures F-28 to F-33 | none | Covered | Plain cookie names and shared cookies across ports on `http://localhost` (ODB-15) |
| 5 | Open redirect through `returnTo` | `safeReturnTo` (single leading `/`, no `//`, `\`, control character or scheme, 256 characters, not `/api/` or `/setup`); logout URL built by the server and checked by the client | The hostile table was server-side only; the web sign-in page also reads `returnTo` from its own URL | FR-B-402: the page applies the same function; `web/signin.test.tsx` hostile table | none |
| 6 | ID-token gaps: algorithm confusion, `tid`, `aud`, `iss`, nonce replay, clock skew | `RS256` only, `jku`, `x5u`, `jwk`, `crit` refused, `aud` a string, `iat` bounded, exact issuer, pinned `tid`, single-use nonce, 60 s tolerance, F-02 to F-27 with mutant validators (plan 8.6.5, V-B07) | none | Covered | The tolerance is ours (U33, U35) |
| 7 | PKCE downgrade | S256 only, exact authorize parameter list, verifier of 32 random bytes, `authorize-request.test.ts` | none | Covered | none |
| 8 | Cookie scoping | No `Domain`, `Path=/`, `__Host-` on https, Strict, duplicate cookies fail closed | none | Covered | Another application on `localhost` can read the plain cookies |
| 9 | Session store theft | Only SHA-256 of a 256-bit id stored, no IP or agent, no token retained (FR-B-407, FR-B-418) | A tab polling the wizard or connection page kept a user session alive indefinitely, defeating the idle timeout | FR-B-420 (`slidesSession: false` on the polled routes) | none |
| 10 | RBAC escalation by granting | `canGrant` on create and delete, early and again inside `BEGIN IMMEDIATE`; `actorKinds: ['user']` on both routes; only break-glass restores an Owner | none for the API | Covered | The gap between `authorize` and a later Graph write (Phase C and D) is closed by the capability-branded arguments of 11.9, not by a lock |
| 11 | Group-based roles | `checkMemberGroups`, token groups ignored, hidden and deleted groups fail closed (FR-B-507) | An Entra group bound to `owner` (or any role holding `rbac:manage` or `settings:connection`) makes whoever controls the group (group owners, Groups Administrator, a dynamic rule) a panel Owner with no panel audit entry | FR-B-515 and `GROUP_FORBIDDEN_PERMISSIONS`; EB-38; ODB-16 | The *Beheerder* group of the wizard stays allowed: that role holds neither permission |
| 12 | Expiry races and last-Owner races | Memo with the earliest expiry, epoch triggers, `BEGIN IMMEDIATE` plus triggers, 100 repetitions of the concurrent test | none | Covered | An Owner deleted in Entra still counts as an Owner (break-glass recovers) |
| 13 | Scope bypass through bulk, search and export paths | `visibleScopes` for lists, search, bulk and exports, capability-branded arguments, `policy_not_applied` (11.8, 11.9) | A route could return user attributes in another shape and so widen a `basic` grant | 11.9 and spec 13.3: every response with user attributes passes `projectUser`; the Phase C route-table guard is named | Phase C and D routes do not exist yet |
| 14 | Break-glass abuse | Memory-capped scrypt, one at a time, 5 per 15 minutes and 20 per hour, equal work for an unknown user, 30-minute non-sliding session, `rbac:manage` only, restore-Owner only, every use audited and logged | The spec's N range exceeded the memory cap (SB-04, now applied); no password floor; restore accepted a disabled account; password plus any enabled account (a B2B guest included) restores an Owner | FR-B-521, FR-B-110 (14 characters), FR-B-523 (disabled refused); ODB-17 (second factor, address allow-list, `Member`-only) and the proxy restriction in `docs/operations.md` | No second factor until Phase D; the route and `features.breakGlass` reveal that break-glass exists |
| 15 | Audit gaps | Every write and every authenticated denial in the same transaction, 503 when the denial entry cannot be written | Three control actions (P12, P23, P24) wrote nothing and the rule said every write is audited | FR-B-601 states the exemption list and the coverage test pins it | Pre-validation callback failures are unaudited by design (B-24) |
| 16 | Log leakage of tokens, certificates, `APP_KEY` | Canaries in `no-leak.test.ts`, redacting holder, typed errors without Microsoft text, key never in `/readyz` | `-e APP_KEY` is visible in `docker inspect` | `docs/security.md` and README prefer a Docker secret or `APP_KEY_FILE` | Anyone who can read the container environment can read `-e` values |
| 17 | Nonce reuse and associated data | 24 random bytes per seal, associated data binds purpose, row id and key id, known-answer vector | No test that nonces differ | FR-B-105 control: 10,000 seals of one plaintext give 10,000 distinct nonces | none |
| 18 | Private key in backups | Sealed blobs only, `APP_KEY` not under `/data`, `pre-rotate-*` useless without the old key | Rotating a possibly exposed `APP_KEY` re-seals the same private key | FR-B-109 and `docs/operations.md`: renew the certificate and delete older copies | A leaked key together with an older copy of `/data` |
| 19 | SSRF through the wizard | Fixed origins, `redirect: 'error'`, GUID or escaped path segments, `verification_uri` allow-list, discovery host check, Graph `nextLink` same-origin rule | The Exchange `nextLink` had no origin rule and the tenant hint no pattern | FR-B-317 and `server/integrations/url-discipline.test.ts` | none |
| 20 | Wizard step replay | Preconditions per step, one runner lease, idempotent sub-actions, setup CSRF | A replayed `finish` was not refused; nothing named the Owner | State `in_progress` precondition and `confirmOwnerOid` (FR-B-219 h) | none |
| 21 | Adopting a pre-created application | Install tag, ambiguity stop, explicit confirmation | An application someone pre-created with a client secret or foreign owners would receive the permissions the wizard grants, and its owner could add credentials later | FR-B-318 (inspection, refusal, acknowledgement), FR-B-319 (foreign credentials stay visible), ODB-18 | An Application Administrator can always add credentials: the blast radius is documented |
| 22 | A request assigns an arbitrary directory role to the runtime application | The role was "a setting" and a free GUID in the contract; the bootstrap token holds `RoleManagement.ReadWrite.Directory` | Any template id, a privileged one included, could be named | `EXCHANGE_ROLES` (two keys) in FR-B-308 and the contract, CD-14 | none |
| 23 | DNS rebinding against a localhost panel | Setup routes answer 404 to a non-loopback `Host`; cookies are host-bound, so a rebinding page sees only anonymous data; writes need Origin and a token | none | Covered; written up in `docs/security.md` | none |
| 24 | Denial of service on the emergency paths and on sign-in | Bounded counters, a rate class `auth`, a queue for break-glass, 20 login transactions per client | Global bounds can be exhausted by an attacker, and a flood from many addresses can evict in-flight login transactions (1,000 in total) | RB-17; a container restart resets the counters; the proxy can restrict both routes | Accepted |
| 25 | Information disclosure through public routes | `GET /api/v1/me` and the authorize redirect show only what a visitor already sees (state, tenant and application ids, whether break-glass is on) | none worth a change | Accepted | An attacker learns that break-glass exists |

## 17. Decisions and assumptions

ADR numbers: Phase A uses 0001 to 0055. Phase B uses **0100 + n for assumption B-n** (ADR-0101 to ADR-0126) and **0150 + n for plan decision PB-n** (ADR-0151 onward); the gaps are intended so Phase A can keep adding ADRs without renumbering, and the docs-contract ADR check accepts the blocks (AM-22).

### 17.1 The orchestrator's defaults and the spec's assumptions

| Orchestrator default | Spec ID | ADR | Verdict after the plan's evidence |
|---|---|---|---|
| B1 Graph permissions | B-01 | 0101 | **Kept.** Extended evidence (8.8): licences, group members and `subscribedSkus` are covered; `licenseDetails` is delegated-only; no Phase C/D operation needs `Group.Read.All` or `Directory.Read.All`; a documented fallback ladder for U36; the brief's five become four (spec 8.2 delta stands) |
| B2 Exchange client and read adapter | B-02 | 0102 | **Kept.** Probe cmdlet and `$select` settled from the re-read Admin API pages (PB-22); write path stays the owner's decision (section 19); the ADR is updated when the owner decides |
| B3 Service principal role | B-03 | 0103 | **Kept** (Exchange Administrator by default, selectable among two template ids for the OV-13 experiment) |
| B4 Wizard user and scopes | B-04 | 0104 | **Kept** (exactly three delegated scopes; the observed device-code request with them succeeded, V-B13) |
| B5 Sign-in, MFA, step-up | B-05, B-06 | 0105, 0106 | **B-05 kept** and reinforced (V-B04: MSAL adds `offline_access`, caches per account, calls the assertion callback on every acquire). **B-06 changed by the spec** (no `max_age`, no `claims`; `prompt=login` plus `auth_time` and MFA again) and kept |
| B6 Sessions and cookies | B-07 | 0107 | **Kept**; plan adds the Strict-cookie re-check (PB-15) and the combined CSRF binding (PB-08, SB-09) |
| B7 Secrets | B-08 | 0108 | **Kept**; known-answer vector normative (7.2) |
| B8 First-run takeover | B-09 | 0109 | **Changed by the spec** (lock at the first Owner sign-in) and kept; plan adds that reopen blocks sign-in until finish (RB-13) |
| B9 Persisted wizard | B-10 | 0110 | **Kept**; one combined poll per second (SB-19), run modes (PB-14) |
| B10 RBAC foundation | B-11, B-15, B-16, B-17, B-18 | 0111, 0115 to 0118 | **Kept / clarified**; precise grant merge (SB-13), `SCOPE_MATRIX` (SB-07), break-glass memory cap and actor-kind restriction (SB-04, SB-03) |
| B11 Clients | B-12 | 0112 | **Kept**; fetch-only rule and no-egress guard (PB-01) |
| B12 Out of scope | B-13 | 0113 | **Kept** |
| (spec additions) | B-14, B-19 to B-26 | 0114, 0119 to 0126 | **Kept**, except B-19: library confirmed with the second package `reflect-metadata` (SB-17) |

### 17.2 Decisions made in this plan (each also an ADR)

| ID | Decision | Evidence | Consequence / revisit trigger |
|---|---|---|---|
| PB-01 | Outbound HTTP is global `fetch` only; no `node:http`, `node:https`, `node:net`, `node:tls`, `undici` anywhere in `apps/server/src`; every test process installs a no-egress guard | V-B05 (`https.get` bypassed MSW and reached real Entra), V-B06, V-B04 (MSAL 7 uses `fetch`) | Tightens FR-B-315; revisit if a dependency starts using `node:https` (the guard then fails loudly) |
| PB-02 | X.509: `@peculiar/x509` 2.1.0 + `reflect-metadata` 0.2.2, lazy; fallback a 120-line DER encoder | V-B02, V-B03 | One-file swap behind `CertificateFactory`; revisit on an advisory |
| PB-03 | Sign-in uses our own code-flow client and `jose`; MSAL only for the bootstrap and app tokens | V-B04, B-05 | none |
| PB-04 | ID-token validation order of 8.6.5 with our own checks around `jose` | V-B07 | Fixture table F-02 to F-27 is the control |
| PB-05 | Remote key set: `cacheMaxAge` 24 h, `cooldownDuration` 5 min, custom fetch, hourly `reload()` | V-B08 (closes U40) | none |
| PB-06 | The setup actor holds exactly `settings:branding` and `settings:connection` | wizard step 5 needs the Phase A branding routes | Amends the spec (SB-01) |
| PB-07 | One availability gate for setup, connection pages and break-glass: same not-found function, same rate bucket as the unknown path | FR-B-207 | Byte equality test excludes only `requestId` |
| PB-08 | CSRF binding is computed from the cookies as sent (hashes joined by `.`), without a database read | an Owner who reopens setup holds two cookies | SB-09 |
| PB-09 | Sessions: hashed id, in-memory last-seen memo, database write at most every 60 s | FR-B-407 | After a restart idle can be up to 60 s longer |
| PB-10 | Revalidation inline and single-flight, retry no earlier than 30 s after a failure | FR-B-409 | Graph outage never blocks requests for more than one attempt per 30 s |
| PB-11 | `SCOPE_MATRIX` per target (11.3) | FR-B-513 leaves it to the plan | SB-07 |
| PB-12 | Break-glass: scrypt memory <= 128 MiB, one verification at a time, RBAC write routes restricted to `user` actors | V-B10 | SB-03, SB-04 |
| PB-13 | Certificate `pending` state; generate and seal before upload; renewal in repair with possession proof before swap | crash safety of the PATCH | SB-02 |
| PB-14 | In-process runner with lease; modes `continue` and `reconcile`; wizard budget disables `GraphHttp` retries so the runner owns and logs every wait; one combined poll per second | FR-B-209, FR-B-211, FR-B-212 | SB-19 |
| PB-15 | Boot re-check of `/api/v1/me` when the boot actor is anonymous | `SameSite=Strict` drops the cookie on cross-site navigation | keeps Strict (brief 6) |
| PB-16 | Header `X-Session-Idle-Expires` on authenticated responses | the client cannot know the sliding deadline otherwise | SB-18 |
| PB-17 | Four namespaces load lazily per locale; the rest join the entry | PD-16 threshold crossed | AM-21 |
| PB-18 | Service worker passes `/auth/*` and `/api/*` through untouched | keep redirects and cookies out of the worker | AM-12 |
| PB-19 | One WHATWG fake tenant, three transports, crash-after-n fault model | one simulation, no divergence | FR-B-707 |
| PB-20 | Clock, scheduler and random source injected in all new code | deterministic tests | lint canary |
| PB-21 | e2e: three processes, seeding through the real API, per-principal storage states | FR-B-708 | direct-DB `expired-assignment` fixture |
| PB-22 | Exchange probe `Get-OrganizationConfig?$select=Name,Guid`; tolerant envelope parser | V-B15 | U45 |
| PB-23 | `setup_object` kinds include grants and role assignments; audit `objectId` only for GUID ids | non-GUID ids | SB-11 |
| PB-24 | Grants merge per `(permission, qualifier)` | spec rule over-grants with scoped full grants | SB-13 |
| PB-25 | Phase C/D services take capability-branded arguments from the policy layer | the safety net cannot undo a write | 11.9 |
| PB-26 | Migration `0001` only adds objects; CHECK expressions come from `db/check-macros.ts` so schema and SQL cannot differ | data-model.md | none |
| PB-27 | 303 to `/setup` applies only without a valid user session | non-designated users during `awaiting_first_signin` | SB-14 |
| PB-28 | ADR numbering blocks | Phase A keeps 0001 to 0055 | AM-22 |

## 18. Amendments, conflicts and the UNVERIFIED register

### 18.1 Amendments to `spec.md` made by this plan (SB-nn)

The spec asks that the plan amend it in the same commit where it differs; this plan lists them. **Status (2026-10-10): SB-01 to SB-22, SB-24 to SB-26 are applied to the spec text by the analysis pass (18.1a, AN-01); SB-23 was already there.** `T-B-001` verifies them (`rg -n "SB-" specs/002-phase-b/spec.md`) and applies what the Phase A re-read changes. None changes the intent of a requirement; SB-03, SB-04, SB-06 and SB-13 tighten or correct a rule after evidence.

| ID | Spec location | Change | Evidence |
|---|---|---|---|
| SB-01 | FR-B-202, FR-B-219, 6.5, 6.9.7 | The setup actor holds `settings:branding` and `settings:connection`; the policy matrix has a `setup` column | PB-06 |
| SB-02 | Appendix B `certificate` | `state` gains `pending`; partial unique indexes for one `active` and one `pending`; `created_at`; unique SHA-1 | PB-13, data-model.md |
| SB-03 | 6.9.7 P29, P30 | `actorKinds: ['user']` on assignment create and delete | FR-B-523 |
| SB-04 | FR-B-521, 6.9.1 `BREAK_GLASS_PASSWORD_HASH`, 6.9.2 | scrypt: `128 * N * r <= 134,217,728`, so N at most 131,072 at r = 8 (spec: up to 1,048,576); `hash-password` writes N = 131,072; one verification at a time (`BREAK_GLASS_QUEUE` 1 running + 2 waiting) | V-B10 |
| SB-05 | EB-10, FR-B-603 | The Graph error `code` (pattern-checked) is shown through a catalogue message; the free-text message is neither stored nor shown | 6.9.5, FR-B-221 |
| SB-06 | FR-B-212, 6.9.2 | Waits have a floor of 500 ms (`SETUP_MIN_WAIT_MS`) | log flooding at full jitter near zero |
| SB-07 | FR-B-513 | `SCOPE_MATRIX` of 11.3 | PB-11 |
| SB-08 | FR-B-404, Appendix C | Check order of 8.6.5: header, unverified tenant and issuer peek, signature and claims, then `aud` string, `iat`, `ver`, `oid`, `nonce`; explicit own checks for `iat`, `aud` arrays and `jku`/`x5u`/`jwk`/`crit` | V-B07 |
| SB-09 | FR-B-408, FR-B-205 | CSRF binding = hashes of the cookies presented, joined by `.`; single-cookie cases equal the spec | PB-08 |
| SB-10 | FR-B-707 | The fake device grant accepts `device_code` and the URN | V-B04 |
| SB-11 | 6.9.6 rule 2, Appendix B `setup_object` | `objectId` only for GUID ids; `tenant_object_id` is not GUID-constrained; kinds listed in 9.5 | PB-23 |
| SB-12 | FR-B-112 | Header and claims are built by `signClientAssertion`; the compact signature is produced inside `secrets/` through `CompactSigner` | 7.4 |
| SB-13 | 6.5.2 step 3, FR-B-512 | Merge per `(permission, qualifier)`; a full grant wins only where its own scope applies | PB-24 |
| SB-14 | FR-B-201 | The 303 to `/setup` is skipped for a request with a valid user session | PB-27 |
| SB-15 | Appendix B | `setup_state.proposed_tenant_id`; `tenant_connection.tenant_id` nullable until V2 pins it; `updated_at` on `setup_step` and `tenant_connection`; `app_user` and `rbac_group_member_cache` as in data-model.md | data-model.md |
| SB-16 | FR-B-315, FR-B-707 | No file imports the HTTP modules at all; the no-egress guard is a control | PB-01 |
| SB-17 | FR-B-711, B-19 | `reflect-metadata` 0.2.2 is a second direct dependency | V-B02 |
| SB-18 | FR-B-413, FR-B-416 | `features.breakGlass`; response header `X-Session-Idle-Expires` | PB-16 |
| SB-19 | FR-B-211 | `GET /connection/runs/current?after=` returns the lines too (UI polling); `GET /connection/log` stays for paging | PB-14 |
| SB-20 | FR-B-218, P15 | `PUT /setup/manual` also takes `tenantId` | 9.10 |
| SB-21 | 6.9.6 `rbac.assignment.create` | actor kinds `user` and `setup` | 9.1 row 3 |
| SB-22 | FR-B-402, FR-B-521 | Sign-in and break-glass need a pinned tenant; sign-in answers `setup_required` while the state is `in_progress` (stated in operations.md) | RB-13 |
| SB-23 | FR-B-701, FR-B-709 | Snapshot file `apps/server/schema-snapshots/0001-phase-b.sql`; ADR blocks | PB-28 |
| SB-24 | 8.5 | Register updates of 18.3 | V-B08, V-B12 to V-B16 |
| SB-25 | 6.9.7 note 2 | `GET /auth/callback` (P02) audits denied sign-ins on a GET and is by design a cross-site top-level navigation (`Sec-Fetch-Site: cross-site` from Entra), so the Phase A rule for audited GETs (FR-A-044) cannot apply to it; the route declares the exemption, the control is `state`, `nonce`, PKCE and the Lax transaction cookie; it is the only exempt route | contracts file, `server/route-table.test.ts` (the exemption list is exactly `[auth.callback]`), `server/auth/callback.test.ts` (`FakeBrowser` sends `Sec-Fetch-Site: cross-site` on the callback) |
| SB-26 | FR-B-201 | The exempt pages of the 303 to `/setup` are `/setup*`, `/signin`, `/no-access` and static assets (spec: without `/no-access`) | contracts file section 8, `e2e/setup-redirect.spec.ts` (a no-role sign-in during `awaiting_first_signin` ends on `/no-access`) |

### 18.1a Amendments made by the analysis pass of 2026-10-10 (AN-nn)

Documents edited: `spec.md`, `plan.md`, `data-model.md`, `contracts/phase-b-api.md`, `tasks.md`. `research-microsoft-b.md` and everything under `specs/001-m365portal/` are untouched.

| ID | Kind | Change |
|---|---|---|
| AN-01 | consistency | SB-01 to SB-22 and SB-24 to SB-26 and the task amendment TB-14 written into the spec (setup actor grants, state redirect exemptions, setup session cap, combined CSRF binding, wait floor, scrypt cap and queue, `actorKinds` on P29 and P30, actor kinds of `rbac.assignment.create`, Appendix B columns, triggers and invariants, `features.breakGlass`, `adminConsentUrl`, `X-Session-Idle-Expires`, combined polling channel, manual `tenantId`, `Sec-Fetch-Site` exemption of P02, register entries U45 to U49). TB-01 to TB-13 (stream names, control renames) stay with `T-B-001` |
| AN-02 | consistency | The audit detail allow-list has 38 keys, not 37 (spec rule 1 and the data-model table list 38); text fixed in the plan, data model and tasks |
| AN-03 | consistency | Contract: the environment rows of the result-code table use the check statuses `fail` and `warn` of FR-B-213; access words of P05, P29, P30 and P32 use `actorKinds` as in the contract |
| AN-04 | coverage | Brief section 2 "the wizard asks for the base URL" recorded as BCB-14; brief section 7 optional developer-tenant e2e assigned to Phase D (scope table and 1.4); FR-B-712 gets the automated Phase C guard of `T-B-394`; Phase A outline mapping extended (FR-B-001, FR-B-009, FR-B-012) |
| AN-05 | coverage, baseline 10 | FR-B-716 (one label normaliser per displayed value) and task `T-B-254`; FR-B-713 name list extended |
| AN-06 | coverage, baseline 6 | Limits added as numbers: `SETUP_SESSIONS_MAX` 5, `SETUP_MIN_WAIT_MS` 500, `SCRYPT_MAX_MEMORY_BYTES`, `SCRYPT_N_MAX` 131,072, `BREAK_GLASS_QUEUE_RUNNING` 1, `BREAK_GLASS_QUEUE_WAITING` 2, `BREAK_GLASS_PASSWORD_MIN_CHARS` 14 |
| AN-07 | security | FR-B-223 (stale `SETUP_TOKEN` after reopen), EB-37, log event `setup_token_after_complete` |
| AN-08 | security | FR-B-318 and FR-B-319 (adoption trust, foreign credentials), EB-36, codes `application_untrusted` and `foreign_credential_present`, ODB-18, U50, OV-03 extended |
| AN-09 | security | FR-B-515 (no privileged role for a group), EB-38, `GROUP_FORBIDDEN_PERMISSIONS`, invariant I-B13, CD-16, ODB-16, RB-18 |
| AN-10 | security | FR-B-308 and contract P21: `exchangeRole` is a key of `EXCHANGE_ROLES`, never a free GUID (CD-14) |
| AN-11 | security | FR-B-317 (outbound URL discipline: Exchange `nextLink`, tenant hint) and task `T-B-084` |
| AN-12 | security | FR-B-219 h and P18: `confirmOwnerOid` and the `in_progress` precondition (CD-15) |
| AN-13 | security | FR-B-420 and the `slidesSession` route flag |
| AN-14 | security | FR-B-521 and FR-B-110 (14-character floor), FR-B-523 (disabled account refused), ODB-17, RB-17 |
| AN-15 | security | FR-B-109 and the docs: rotating `APP_KEY` does not renew the certificate; FR-B-105 nonce-uniqueness control |
| AN-16 | security | FR-B-402: the web sign-in page applies `safeReturnTo` to its own `returnTo` |
| AN-17 | security | FR-B-601: the explicit audit exemption list (P12, P23, P24) |
| AN-18 | feasibility | Spec 8.8: every UNVERIFIED behaviour with its interface, fallback and owner-verified item |
| AN-19 | docs | Spec 6.8 and plan 16 rows extended; plan 16.1 (this attack review); negative-control rows in 14.6 |
| AN-20 | tasks | Tasks changed and added: see the list in `tasks.md` section 5 (TB-15) |

### 18.2 Conflicts between inputs, resolved

(1) The orchestrator default "SSE or polling" for the live log versus intermediaries buffering streams: polling (spec B-10, PB-14). (2) The spec's `node:https` allowance in `integrations/**` versus the MSW hole: fetch only (PB-01). (3) The spec's scrypt range versus the 512 MiB Compose limit: capped (SB-04). (4) The spec's CSRF binding "of the actor's session" versus an Owner holding two cookies: combined binding (SB-09). (5) EB-10 shows Graph text versus 6.9.5 and FR-B-221 never rendering Microsoft text: the code only (SB-05). (6) The spec's FR-B-112 "built with jose" versus "the holder exposes no key": signing inside the holder (SB-12). (7) Spec 6.9.7 note 2 says no Phase B route audits on a GET, while P02 audits denied sign-ins on the cross-site callback navigation: the route is exempt from the `Sec-Fetch-Site` rule and nothing else is (SB-25).

### 18.3 New and updated UNVERIFIED items (copy to `docs/open-points.md`, dated 2026-10-10)

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U45 | The response envelope of the Admin API (top-level array, `value` array or single object) and its error body | FR-B-314 | `get-started`, `OrganizationConfig` and `DistributionGroupMember` pages read; they show requests, not responses | OV-06 records a real answer |
| U46 | `Group.ReadBasic.All` is named in Learn's List groups table but has no section in the permissions reference; whether it exists for applications | fallback ladder of 8.8 | permissions reference searched | Learn clarification or a tenant listing of the Graph service principal's `appRoles` |
| U47 | Entra accepts an uploaded self-signed certificate with exactly `basicConstraints` (cA=false, critical) and `keyUsage` digitalSignature (critical) and nothing else; re-sending existing key credentials as read (with `key`) preserves them in a full-list `PATCH` | FR-B-106, FR-B-306 | V-B02 parsers; Learn pages carried | OV-03, OV-04 |
| U48 | `assignedLicenses` is returned for `GET /users?$select=assignedLicenses` with `User.Read.All` alone | Phase C | user-list page: its property exceptions do not list it | Phase C spec, OV in C |
| U49 | Application `tags`: maximum count and length, so that `m365portal-install-<32 hex>` is accepted | FR-B-303 | none on Learn | OV-03 |
| Updated | U22: the default `interval` is 5 s and `expires_in` 900 (observed), `slow_down` still undocumented. U31: `$filter` on `principalId` is documented, duplicate-POST behaviour is not. U33: the discovery document lists only `RS256` (closed for `alg`), clock tolerance stays ours. U40: **closed** (V-B08). U41: the variable is accepted with an experimental warning, effect unproven. U43: the observed host is `login.microsoft.com`. U44: `$select` is documented for all endpoints and the `OrganizationConfig` properties are listed; the envelope is U45 | | | |

## 19. Exchange write path: addendum to the owner memo (ODB-01)

The one-page decision memo is **Appendix A of the spec** (options A to D, criteria 3, 4, 12 and 13, recommendation A, reversible, not blocking Phase B). This addendum adds what planning established and keeps the memo's numbers unchanged.

**Facts re-checked on 2026-10-10.** The Admin API pages `get-started`, `OrganizationConfig` and `DistributionGroupMember` were read in full: Preview, "not available in all organizations, subject to change", POST only, `X-AnchorMailbox` mandatory, `$select` on all endpoints, the response "will be limited to the core properties" at public release; there is still no `Get-DistributionGroup`, no `Add-` or `Remove-DistributionGroupMember` and no contact cmdlet (research §9.1, V-B15). The PowerShell Gallery lists `ExchangeOnlineManagement` 3.10.1 (published 2026-07-24, a 21.7 MB package that depends on `PackageManagement` and `PowerShellGet`). **Not measured here**, and therefore not claimed: the size of an Ubuntu 24.04 base layer, of PowerShell 7.6, and whether both run on arm64 (U26).

**What Phase B does to keep every option open.** The `ExchangeClient` interface has read methods only and `capabilities().write` is empty; one contract suite runs against any adapter; no product or test code depends on the distroless layout except the documented command path, which the smoke test takes from one variable so a changed base image changes one line; the Admin API probe is optional and a warning, so its disappearance changes nothing. The runtime base image is not touched.

**A cost the memo does not state and the owner should weigh.** Option A (`pwsh`) and B (sidecar) need the **certificate private key inside the PowerShell process**: `Connect-ExchangeOnline` takes a certificate object or a file plus password, and `-CertificateThumbprint` is Windows-only (research §9.4). Phase B's `CertificateHolder` deliberately has no method that returns the key. Phase D would add one narrow, audited export that hands a PKCS#12 with a per-start random passphrase to the worker over standard input (never a file on disk, never a log), and for option B the key would cross a container boundary. Option C needs no export (it uses the app token). This belongs in the Phase D ADR, and it is a reason to prefer A over B.

**Planning estimates** (engineer-days; judgement, not measurement): A about 8 to 12 (base image and its CI and arm64 test 3, worker process and a line-delimited JSON protocol with timeouts and health 3 to 4, adapter plus fake plus contract run 2, key hand-over and ADR 1 to 2, docs 1); B about A plus 3 (second image, Compose, inter-container authentication); C about 0 now and a cut of acceptance criteria 3 (list part), 4 and 12 until a later decision; D rejected (no Learn page, unsupported).

**Timeline.** Decide at the Phase B gate; ADR-0102 records the interface-only decision of Phase B and is updated with the owner's choice. With no decision Phase D starts with criteria 3 (list part), 4 and 12 blocked, as the memo says. OV-13 (an optional experiment on the owner's machine) tells whether Exchange Recipient Administrator suffices for list and contact writes (ODB-03).

## 20. Risks

Likelihood and impact are low (L), medium (M) or high (H). The spec's RB-01 to RB-18 stand; plan-level risks are numbered PBR and copied to `docs/open-points.md`.

| ID | Risk | L / I | Mitigation and control |
|---|---|---|---|
| PBR-01 | The simulation lets a real network call through (a library that bypasses `fetch`, as `node:https` bypassed MSW) | M / H | Fetch-only rule, no-egress guard in every test process, layering test, negative controls (PB-01, 14.3) |
| PBR-02 | Entra rejects the certificate or the assertion (`x5t#S256` only, extensions, lifetime, key size) | M / M | The three fallbacks are one-line switches (`x5t` header, shorter lifetime, key size); OV-03, OV-04; U19 to U21, U47 |
| PBR-03 | The Phase A interfaces differ from the planned ones at the Phase A gate | M / M | `T-B-001` re-reads the code against C1 to C14, amends the spec in the same commit (SB list grows), stops if a contract moved (V-B19) |
| PBR-04 | `@peculiar/x509` or `reflect-metadata` gets an advisory or misbehaves in the distroless image | L / M | Lazy import, 5 MB subtree, DER-encoder fallback, image smoke test creates a certificate in the real image (PB-02) |
| PBR-05 | Break-glass verification exhausts memory next to image jobs in the 512 MiB limit | L / M | 128 MiB cap, one at a time, the smoke test reports peak RSS (PB-12) |
| PBR-06 | Cross-site entry drops the `Strict` cookie and users bounce to sign-in | M / L | The boot re-check (PB-15); OV-14 observes it in three browsers |
| PBR-07 | Lazy i18n needs a Phase A i18n API change late in Phase A | L / L | `loadNamespace` is additive (AM-21); fall back to bundling all namespaces if the budget allows (it exceeds PD-16's threshold, so Lighthouse would be re-measured) |
| PBR-08 | `msw` 3 is a new major with `onUnhandledFrame`; its interception of `fetch` could change | L / M | Pinned; the no-egress guard is independent of it; the contract suites fail loudly |
| PBR-09 | The fake tenant encodes a wrong reading of Learn (assertion validation, replication delay, error codes) | M / M | Strictness self-test, contract suites on both implementations, the owner-verified ledger OV-01 to OV-23 |
| PBR-10 | SQLite writer contention: wizard run, sign-ins and the CLI use one file | L / L | Short `BEGIN IMMEDIATE` transactions, no network inside a transaction, `busy_timeout` 5 s, CLI uses the same PRAGMAs |
| PBR-11 | The Exchange Admin API envelope differs from the tolerant parser | M / L | Tolerant parser, warning-only use in the wizard (U45) |
| PBR-12 | A long-lived bootstrap object stays in memory after an error path | L / H | Four discard triggers (FR-B-215), `finally` blocks, lifecycle test with canary tokens, shutdown hook |
| PBR-13 | Reopen blocks sign-in for everyone until the wizard finishes | M / L | Documented in operations.md and in the CLI output; `setup-reopen` requires `--confirm`; the wizard keeps step state so the repair is quick (RB-13) |
| PBR-14 | `msal-node` carries `jsonwebtoken` and other transitive packages the product does not use | L / L | Listed in architecture.md, audited in CI, `clientCertificate` never configured |

## 21. Build order and the gate

### 21.1 Milestones (input to `tasks.md`; plan section 5.7 has the streams)

| Milestone | Content | Depends on | Gate |
|---|---|---|---|
| MB0 | `T-B-001`: re-read the as-built Phase A against the planned contracts and amend the spec (SB list); `VERSION` 0.3.0; install the six dependencies through the protocol; migration `0001_phase_b`, schema, check macros, snapshot, manifest, parity and upgrade tests (the first real upgrade pair); config schema, audit vocabulary, limits and problem codes; empty module stubs in `modules.ts`; `PREVIEW_MODE*` removed | Phase A gate approved | `quality` green on a clean checkout; upgrade test and its negative control green |
| MB1 | Pure code in shared (RBAC algorithms with the properties, cookies, redirect URIs, `safeReturnTo`, `evaluateAmr`, registries, desired state, backoff constants); secrets (`app-key`, sealed box with the known-answer test, certificate, holder, rotation, CLI); ports and errors; fake tenant skeleton, MSW setup, no-egress guard | MB0 | shared and secrets tests green; guard negative controls seen red |
| MB2 | Microsoft clients (`GraphHttp`, `GraphClient`, `TenantProvisioner`, identity, Admin API adapter) with contract suites; policy layer, resolvers, route wrapper and route table changes; availability gate; CSRF binding | MB1 | contract suites on both implementations; `policy-matrix` and route-table tests green |
| MB3 | Sessions and sign-in: login, callback with F-01 to F-45, interstitial, logout, logout-all, step-up, revalidation, break-glass, `me` and boot data | MB2 | the 45 fixtures; `no-leak` canaries |
| MB4 | Setup engine: gate, unlock, environment, runner, lease, steps, verify, finish, manual mode, repair, connection API; completion on first sign-in | MB2, MB3 | idempotency and resume (every injection point), `complete-on-signin`, lock tests |
| MB5 | RBAC API (assignments, effective, restore-owner, `me/access`), membership resolution, audit coverage over the route table | MB2, MB3 | escalation, last-owner (including the race), epoch and expiry tests |
| MB6 | Web: routes, wizard, sign-in, settings pages, shell changes, i18n lazy namespaces, service-worker routing | MB4, MB5 contracts | component tests; bundle budget measured |
| MB7 | e2e topology and specs, a11y, keyboard, visual, Lighthouse; image smoke test and content checks; Compose secret; `.env.example` | MB3 to MB6 | `e2e` and `image` green locally where runnable |
| MB8 | Documentation set in both languages, ADRs, open points, docs-contract and traceability tests | MB7 | docs tests green |
| MB9 | Full local matrix, `docs/phase-reports/phase-B.md` with the owner checklist and the Exchange memo, `T-B-999` | MB8 | the report; **work stops; nothing for Phase C is started** |

### 21.2 Definition of done for the phase (spec section 3, restated as checks)

The report states separately what ran locally, what only runs on GitHub (workflows, arm64, signing, CodeQL), what was simulated and which assumptions the simulation encodes, and what is owner-verified; every Microsoft claim has a source or a U row; the approval line is empty; `git status` shows nothing for Phase C.

## Appendix A. Log message keys (seed for `LOG_KEYS`)

Keys carry scalar parameters only (validated by the secret-free schema); every key has nl and en text. `setup.log.run_started` {mode, steps}; `.step_started` {step}; `.sub_started` {step, sub}; `.read` {what}; `.found` {kind, name}; `.created` {kind, name}; `.adopted` {kind, name}; `.unchanged` {kind}; `.waiting_replication` {attempt, max, seconds}; `.retry_transient` {attempt, max, seconds}; `.permanent_error` {code}; `.bootstrap_waiting` {seconds}; `.bootstrap_signed_in`; `.bootstrap_discarded`; `.certificate_generated` {thumbprint8}; `.certificate_uploaded`; `.token_acquired` {resource}; `.verified` {check, status}; `.tenant_pinned`; `.exchange_skipped`; `.manual_checked`; `.run_finished` {status}; `.run_cancelled`; `.run_crashed` {code}. Server log events (not wizard keys, FR-B-715): `setup_unlock_locked`, `setup_step`, `signin_ok`, `signin_denied`, `session_revoked`, `break_glass_signin`, `membership_refresh_failed`, `preview_mode_removed`, `setup_token_after_complete`, `app_key_previous_in_use`, `cookie_duplicate`, `jwks_refresh_failed`, `builtin_roles_mismatch`.
