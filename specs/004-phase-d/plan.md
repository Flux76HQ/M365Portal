# Implementation Plan: M365Portal Phase D (Exchange lists and contacts, group members, CSV, roles, audit, hardening)

**Spec**: [spec.md](spec.md) | **Research**: [research-microsoft-d.md](research-microsoft-d.md) | **Builds on**: `specs/003-phase-c/plan.md` (sections 4 to 9), `specs/002-phase-b/plan.md` (sections 8, 11, 14), ADR-0169 (one fake tenant), ADR-0175 (capability-branded arguments), ADR 0179 (cursor store and restricted rows)

## Samenvatting (Nederlands)

Dit plan beschrijft hoe fase D in drie stappen wordt gebouwd. **D1:** een `pwsh`-werkproces achter de bestaande `ExchangeClient`-poort (JSON-regels over stdin en stdout, vaste lijst toegestane cmdlets, één warm proces dat wordt ververst), een Ubuntu-LTS-image, de distributielijst- en contactmodules met hun routes (P40 tot en met P54), schrijfmethoden op de `GraphClient` voor groepsleden, een uitbreiding van de nep-tenant voor Exchange-schrijven, en de bijbehorende webpagina's in lazy chunks. **D2:** een CSV-schrijver in gedeelde code (met bescherming tegen formule-injectie, getest met een onafhankelijke parser), de exportroute met streaming, het auditscherm met ketencontrole, bewaartermijn met een controlepunt en een globale begrenzing voor geweigerde verzoeken. **D3:** rollenbeheer (eigen rollen, sjablonen, scope, vervaldatum, effectieve rechten, "bekijk als"), certificaatrotatie met `addKey`, break-glass-versterking, OpenTelemetry, Bicep, het ASVS-overzicht, e2e en documentatie. Elke stap eindigt met een poort, een PR en jouw test tegen de echte tenant. Er is geen nieuwe Graph-toestemming nodig. Het entry-bundelbudget wordt niet aangeraakt: alles komt in lazy chunks.

## 0. What was re-read before planning

The merged Phase C code and docs (v0.3.54) and: `apps/server/src/ports/exchange.ts` and `integrations/exchange/*` (the port has `capabilities().write` as the empty tuple; the Admin API adapter has only `probe`, `getOrganizationConfig`, `listDistributionGroupMembers`), `apps/server/src/audit/*` (writer, canonical form, hash chain, head log), `apps/server/src/rbac/*` (assignments, grants, restore-owner, membership cache), `packages/shared/src/{permissions,limits,problem,routes}.ts` and `rbac/*`, `docs/permissions.md` parts 1 to 4, `docs/security.md`, `docs/operations.md`, `Dockerfile` and `.github/workflows/{ci,image}.yml`.

Findings that shape the plan:

1. The 15-permission catalogue already contains every Phase D permission; the resource types `distributionList` and `contact` and the scope schema exist. No catalogue change.
2. The Exchange port is read-only by type (`write: readonly []`); writes are added by widening that tuple type and the interface, so a write method cannot be added by accident elsewhere.
3. The audit chain verifies from the first row. Retention needs a sealed checkpoint row (hash of the deleted prefix) so that verification of the remainder starts from it. This is the one change to the chain code and gets the heaviest tests.
4. Phase C's read-only guard (`server/integrations/graph/read-only.test.ts`) fails on any write method; it becomes an allow-list of exactly `addGroupMember` and `removeGroupMember`.
5. The fake tenant has Graph and Entra and an Exchange module that serves the Admin API read path; the write cmdlets are new. The worker is faked at the process boundary (a scripted stand-in speaks the same line protocol), so the real `PwshExchangeClient` code is exercised in all unit tests.
6. The runtime image is distroless and the CI `image` job pins digests and runs a smoke test; both change in D1 (spec FR-D-106).
7. The rate-limit table has no `export` class; one row is added.
8. Entry chunks have 52 B (JS) and 18 B (CSS) of headroom (Phase C closing). Every new page, dialog and catalogue is lazy; any shared seam that grows an entry chunk is a stop condition (section 10).

Re-read as built for gate GD1-0 (T-D-101, 2026-10-13): findings 1 to 7 are **confirmed** by the code (details in `gate-notes/GD1-0.md`). Finding 8 is **amended**: the headroom is 57 B (JS gzip) at 0.3.54, and the D1 shared seams themselves (seven problem codes with their nl and en messages in the entry catalogues, the `LIMITS` additions) grow the initial JS by about 0.94 KB gzip, so `pnpm bundle:check` fails on the contract alone. This is the stop condition of section 10; the numbers and the options are in the gate note and the budget is not edited. Three further findings: **9** the i18n merge accepted lower case namespaces only, so `distributionLists` needed `FILE_NAME` and the owner table to accept camel case; **10** the wizard already uses `exchange_unavailable` as a result code (CD-05 test amended); **11** the Graph pages show that the `$ref` delete path is dangerous without `/$ref` and that the bulk PATCH is all-or-nothing (research R-D-08).

## 1. Technical context

New runtime dependencies: none in Node (the worker protocol is hand-written; CSV writer is hand-written because the libraries add weight and the injection rule is ours); OpenTelemetry only if the plan of D3 shows the SDK fits the image budget as an optional lazy import (FR-D-802). New system packages in the image: `powershell` (pinned) and the `ExchangeOnlineManagement` module (pinned). Storage: two migrations in D2 and D3 (audit checkpoint table; role and assignment columns for scope-free custom roles, expiry and the break-glass factor), each tested by the upgrade test (SC-B-012 pattern). Performance: the cost is Exchange latency; the worker serialises calls.

## 2. Constitution and baseline check

| Rule | How Phase D satisfies it |
|---|---|
| Server-side enforcement only (AGENTS.md section 1) | Every new route through `defineRoute` with permission and `scoped`; capability-branded service arguments; the policy matrix extended |
| No invented Microsoft facts | `research-microsoft-d.md`, U75 to U91, owner ledger OV-D1 to OV-D9 |
| Phase stop | Each step ends with a gate note, a phase report and a stop (`T-D-199`, `T-D-299`, `T-D-399`) |
| Documentation contract | Docs in nl and en per step (FR-D-807); deployment-file changes are listed and explained in each PR (the Dockerfile, CI, compose, Bicep) |
| Versioning | Runtime code changes bump `VERSION` in the first code task of each step |
| Secrets and PII | No names or addresses in logs (FR-D-107); no key on disk; the export is never stored |
| Reuse | Table in section 3 |
| Bundle budget | Never edited by me; lazy chunks only; stop and ask if the check fails |

## 3. Reuse

| Item | Decision | Note |
|---|---|---|
| `ExchangeClient` port, `FakeExchangeClient`, contract suite | adapt | write methods; one contract suite on both implementations |
| Admin API adapter | keep | probe and organisation config only |
| `GraphClient`, `GraphHttp`, retry, budget, error map | adapt | two write methods |
| Cursor store, restricted rows, `groupKindOf`, scoped scan | reuse | lists and contacts use the same machinery |
| Route wrapper, policy context, capabilities, step-up, CSRF | reuse | |
| Audit writer, canonical form, chain | adapt | new actions; checkpoint; retention |
| RBAC repository, grants, `canGrant`, last-owner guard | adapt | custom roles, scope, expiry |
| DataTable, dialogs, Select, SegmentedControl, Tabs, Persona | reuse | |
| Fake tenant | adapt | Exchange write module, worker stand-in |
| New: `exchange/pwsh-worker`, `distribution-lists`, `contacts`, `csv`, `audit` routes, `rbac` admin, `rotation` | new | |

## 4. Module layout

### 4.1 Shared (`packages/shared/src`)

- `schemas/distribution-lists.ts`, `schemas/contacts.ts`, `schemas/member-writes.ts` (add and remove members of lists and groups, one vocabulary), `schemas/audit.ts`, `schemas/rbac-admin.ts`, `schemas/export.ts`: wire schemas (the gate GD1, GD2 and GD3 artefacts); `exchange/{protocol,allow-list}.ts`: the worker protocol and the closed cmdlet map (subpath `./exchange/*`).
- `csv/write.ts`: `csvField`, `csvRow`, `neutraliseFormula`, `writeCsv(options)`; `csv/presets.ts` (`laposta`, `generic`).
- `rbac/templates.ts`: the templates (*Bestuur* and the others the spec names); `rbac/effective.ts` extended for expiry.
- `limits.ts`: `exchange`, `distributionLists`, `export`, `audit`, `cert`, `rateLimit.export`; `problem.ts`: the codes of spec 6.11.3; i18n: lazy namespaces `distributionLists`, `contacts`, `audit`, `rbacAdmin` with `nl` and `en`.

### 4.2 Server (`apps/server/src`)

- `ports/exchange.ts` (write methods), `integrations/exchange/pwsh/{worker-protocol,allow-list,session,pwsh-client,worker-script.ps1}` (the script is shipped as a file in the image and its hash is pinned), `integrations/exchange/admin-api-client.ts` unchanged.
- `distribution-lists/{module,routes,service,members-write,export,readback}.ts`, `contacts/{module,routes,service,validation}.ts`, `groups/members-write.ts` (added to the Phase C `directory` module family), `audit/{routes,export,retention,checkpoint,denial-cap}.ts`, `rbac/{roles-routes,templates,view-as,expiry}.ts`, `setup/{rotation,rotation-proof}.ts`, `auth/break-glass-hardening.ts`, `telemetry.ts`.
- `Dockerfile` (Ubuntu LTS runtime stage), `.github/workflows/{ci,image}.yml` (digest pins, smoke test of the worker), `deploy/bicep/*`, a seccomp profile file.
- Test fakes: `test/fakes/fake-tenant/exchange/{writes,worker-standin}.ts`, `test/fakes/fake-tenant/graph` (member writes, key rolls).

### 4.3 Web (`apps/web/src`)

- Routes `distribution-lists.tsx` (replaced), `distribution-lists.$id.tsx`, `contacts.tsx` (replaced), `contacts.$id.tsx`, `audit.tsx` (replaced), `settings.access.roles.tsx`; `routeTree.gen.ts` regenerated and committed.
- `features/{distribution-lists,contacts,audit,rbac-admin,export}/*`; member editing inside `features/groups/GroupDetail`; shared `features/directory/MemberPicker.tsx` (search and multi-select, used by lists and groups).

## 5. Server design

### 5.1 The Exchange worker (FR-D-101 to FR-D-108)

`PwshExchangeClient` owns one `WorkerSession`: it spawns `pwsh -NoLogo -NoProfile -NonInteractive -File worker-script.ps1` with an empty environment plus the few variables the script needs, writes one JSON object per line (`{ id, cmdlet, args, deadlineMs }`), and reads one JSON object per line back (`{ id, ok, data | error }`). The allow-list is a closed map from cmdlet name to an argument schema (types, bounds, which parameters are allowed); the TypeScript side validates before it writes and the PowerShell side validates again against the same map (generated into the script at build time and hash-checked by a test, so the two cannot differ). The script connects once with the certificate passed in memory (the key arrives on stdin in the first line, sealed in transit by the pipe only; never in arguments or environment), sets `-CommandName` to the allow-list and `-SkipLoadingFormatData`, and answers calls serially. A watchdog in Node kills the process at the deadline; the session recycles after `workerMaxCalls` or `workerMaxAgeSeconds`. If U75 turns out false, the script reads a mode-0600 file on `tmpfs` named by an argument and deletes it after the connect; the fallback is a switch in configuration, not a code fork, and has its own negative test.

### 5.2 Distribution list and contact services (FR-D-201 to FR-D-305)

Services take capabilities exactly as Phase C. List and contact reads page through the worker (`-ResultSize` and `-Filter` with the OPATH prefix form) and the cursor store holds the resume state (the position in the result, since the worker has no server-side cursor: a list is read once into a bounded buffer per cursor, with a TTL, and sliced; the buffer is capped by `LIMITS.exchange.listBufferMax` and an over-large result answers a clear "narrow your search"). Member writes resolve identities first (user ids against Graph, contact ids against Exchange), validate the member type (EC-D3), then call add or remove per member in chunks, then read the member list back. Audit entries are written by the route wrapper's declared action plus a per-member helper called by the service.

### 5.3 Group member writes (FR-D-351 to FR-D-355)

`HttpGraphClient.addGroupMember(groupId, memberId)` and `removeGroupMember` use `POST /groups/{id}/members/$ref` and `DELETE /groups/{id}/members/{memberId}/$ref` (confirmed in Phase C's research for the read side only; the write pages were read in amendment 1 of the research: both paths and the 204 answers are confirmed; the delete path must always end in `/$ref`; a `400` on add cannot be told apart (U92), so membership is read first). Per-member calls with the existing retry; the batch endpoint is not used unless the research update shows it needed. Dynamic, synced and distribution groups are refused by `groupKindOf` and the membership type before any call.

### 5.4 CSV (FR-D-401 to FR-D-406)

`writeCsv` is a pure generator over an async iterable of member records; it neutralises formulas before quoting; the property test parses the output with an independent RFC 4180 parser written in the test, and checks the round trip modulo the documented neutralisation. The route streams through a `ReadableStream` and counts rows; abort propagates to the worker call (the call is not cancellable in the worker, so the stream stops reading and the audit entry is `cancelled`).

### 5.5 Audit screen, retention and cap (FR-D-451 to FR-D-455)

Reads page by `(created_at, id)` newest first with filters as indexed predicates (a migration adds the indexes). Verification is a streaming pass over the chain from the latest checkpoint. Retention deletes rows older than the limit in batches in one transaction per batch and inserts a checkpoint row `{ throughId, chainHashAtThrough }` sealed with the row hash chain; `verifyChain()` accepts a checkpoint as a start. The denial cap is a counter in memory per hour with the one `audit.denials.capped` row per hour; the wrapper asks the counter before it inserts a denial row.

### 5.6 RBAC administration (FR-D-601 to FR-D-608)

Custom roles are stored in the existing role table with `builtin = 0` (the migration adds `description` and `created_by`); templates are constants in shared code that create custom roles or assignments; `view-as` computes `computeGrants` for a principal and returns the permission table and the visible-scope summary for a fixed sample of routes; it never creates a session and never calls Graph beyond the membership cache path already used at sign-in. Expiry adds `expires_at` to assignments (a migration) and `computeGrants` filters by the injected clock.

### 5.7 Certificate rotation (FR-D-701 to FR-D-705)

`rotation.ts` is a state machine with persisted steps (`generated`, `added`, `verified`, `switched`, `old_removed`) in the connection table so that a crash resumes or cleans up. The proof JWT is built by the existing signer with the claims of R-D-05; `iss` is configurable internally (`appId` first, `objectId` second) and the working form is recorded in the connection state after the first success (U86). The new certificate is verified by a client-credentials token request before the switch. The job runs from the existing sweeper registry daily and on demand from the route.

### 5.8 Hardening (FR-D-801 to FR-D-808)

Break-glass: the allow-list is a parsed CIDR list checked against the trusted client address before the password work; the second factor is TOTP (RFC 6238 with the SHA-1 default for authenticator compatibility), secret sealed with the key service, one replay window of one step. Telemetry: a thin wrapper that is a no-op unless configured; spans only for route ids and cmdlet names; no attributes from request data. Bicep example and the seccomp profile are files with lint tests in `py/`.

## 6. Fake tenant design

Extend, never fork (ADR-0169). The Exchange module gains the write cmdlets with the strict rules of R-D-02 (member types, duplicates, manager check with and without the bypass, synced objects read-only, an eventual-consistency switch that delays read-back by N calls), served through the same line protocol by a worker stand-in so `PwshExchangeClient` is tested for real. The Graph module gains member `$ref` writes and `addKey`/`removeKey` with the proof check (audience, window, signature by an existing valid key, expiry of the old key makes rotation fail) and an optional `iss` strictness switch for U86. Strictness self-tests accompany each addition (FR-B pattern).

## 7. Web design

URL search parameters are state, as in Phase C. Member editing uses `MemberPicker` (debounced search through P45 or the users route, multi-select, per-member result view after submit, a confirmation dialog listing the changes). Delete dialogs name the object and require the typed or selected confirmation the spec fixes. The export dialog has the column checklist, preset select, separator, BOM, three checkboxes, a live preview table (P46) and the privacy notice; the download is a normal form POST so the browser streams the file, with step-up first. The audit page is a filter bar, a table, a detail drawer and the verify button. The role admin page has tabs (Roles, Assignments, Effective rights, View as). Everything is lazy; strings go through the four new namespaces.

## 8. Steps, streams, territories and waves (input to `tasks.md`)

| Step | Content | Gate and PR |
|---|---|---|
| D1 | Exchange layer and image, lists, contacts, group member writes, their pages | GD1, one PR, owner runs OV-D1, OV-D2, OV-D4, OV-D5 |
| D2 | CSV and export, audit screen, retention, cap | GD2, one PR, owner runs OV-D6, OV-D7 |
| D3 | Role administration, rotation, break-glass, telemetry, Bicep, ASVS, dashboard counters, final e2e and docs | GD3, one PR, owner runs OV-D3, OV-D8, OV-D9 and accepts |

Per step, streams as in Phase C: S-x1 contract and shared, S-x2 server (Exchange, Graph, services, routes, fakes), S-x3 web, S-x4 docs, e2e and verification. Within a step: W0 contract (gate Gx0 frozen schemas, limits, codes, namespace shells), W1 server and web in parallel (two builders at most), W2 e2e and docs, then the gate and the phase report. Between steps nothing starts before the owner's go.

Seams in Phase B and C files (the complete list): `modules.ts`, `ports/exchange.ts`, `ports/graph.ts` and their fakes, `integrations/graph/{graph-client,schemas,permissions-map}.ts`, `audit/{actions,chain,writer}.ts`, `rbac/{repository,grants}.ts` and the migrations, `setup/*` for rotation, `auth/break-glass*`, `http/cache-headers.ts`, `rate-limit`, `limits.ts`, `problem.ts`, i18n lazy lists and `NAMESPACE_OWNERS`, the Dockerfile, `.github/workflows/{ci,image}.yml`, `scripts/check_*`, the compose example and `docs/**`.

## 9. Test strategy

Unit and integration with Vitest on the fake tenant and the worker stand-in. Property tests: CSV round trip and injection (20,000 cases), `canGrant` and `computeGrants` with custom roles, scope and expiry (20,000 cases), audit chain with checkpoints (random deletions). Fault injection: every step of certificate rotation, worker crash at every protocol step. Concurrency: last-Owner race, two member writes. Source scans with negative fixtures: no cmdlet outside the allow-list, no write method outside the allow-lists of both clients, no key material in logs or files, no personal data in logs. Web with Testing Library and MSW; e2e with Playwright on the three-process topology (members, contacts, export download parsed in the test, audit filter and verify, role admin flows, *Bestuur* matrix, rotation banner). The image smoke test runs the worker against the fake endpoint. Visual baselines are taken only from the runner artefact.

## 10. Stop conditions

Stop and report (do not push through): the bundle check fails; an owner decision default turns out wrong in code; U75 false and the tmpfs fallback also impossible in the read-only image; the image grows past a size the owner has not approved; a Microsoft page read during D1 contradicts the research (amend the spec first).

## 11. Plan decisions

**PD-01** hand-written line protocol and one serial worker, not a pool (AD-03). **PD-02** the allow-list is generated into the script and hash-checked. **PD-03** list reads are buffered per cursor with a cap, since the worker has no cursor. **PD-04** CSV writer is hand-written. **PD-05** audit retention by checkpoint row, not by rewriting the chain. **PD-06** certificate rotation as a persisted state machine. **PD-07** view-as is a computation, not a session. **PD-08** custom roles reuse the role table. **PD-09** TOTP for the break-glass factor (the only factor that needs no network). **PD-10** one PR per step; the version bumps are patch-level within 0.3.x until the owner accepts (OD-05 says 0.5.0 for Phase D: the first D1 code task proposes the bump and the owner confirms at GD1).

## Nederlands (kort)

Zie de samenvatting bovenaan; de technische secties zijn Engels, zoals bij fase B en C.
