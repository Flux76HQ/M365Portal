# Feature Specification: M365Portal Phase B (onboarding wizard, Entra sign-in, RBAC foundation)

## Samenvatting (Nederlands)

**Wat.** Fase B maakt van het skelet uit fase A een paneel dat echt een tenant kan koppelen en waar echt mensen op inloggen: een onboarding-wizard die de tenant inricht (app-registratie, certificaat, Graph-permissies, Exchange-rol), aanmelden met Entra ID (autorisatiecode met PKCE, certificaat-assertion, server-side sessies), geheimen versleuteld op schijf (libsodium, `APP_KEY`) en het RBAC-fundament (rollen, toewijzingen aan gebruikers en Entra-groepen, scopes, centrale policy-laag, laatste-Eigenaar-bescherming, break-glass). `PREVIEW_MODE` verdwijnt. **Na fase B stop ik**: de eigenaar test dan tegen een echte Microsoft 365-tenant. Gebruikers en groepen (C), distributielijsten en contacten (D), de RBAC-beheer-UI (D), audit-UI (D), OpenTelemetry (D) en Bicep (D) staan niet in fase B.

**Eerste start.** Een niet-geconfigureerd paneel mag door een vreemde niet te kapen zijn: `/setup` vraagt een eenmalig setup-token (uit `SETUP_TOKEN` of een 0600-bestand dat `docker exec ... node dist/cli.js setup-token` toont, nooit in logs), met brute-force-limieten. De wizard (vijf stappen uit de brief) is idempotent, hervatbaar, toont per stap status en rollback-hint en live logregels, en wacht met retry/backoff op propagatie. De vergrendeling (`setup_completed`, daarna 404 op `/setup`) gaat in bij de **eerste geslaagde aanmelding van de eerste Eigenaar**, niet al bij "Voltooien", zodat een misgelopen eerste aanmelding de eigenaar niet buitensluit.

**Wat anders is dan de uitgangspunten (met bewijs, sectie 9 en 10).** (1) Vier Graph-permissies in plaats van vijf (`User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`): Microsoft Learn noemt `/users/{id}/memberOf` en `/directoryObjects/{id}/checkMemberGroups` alleen met `Directory.Read.All`, dus gebruiken we `transitiveMemberOf` en `/users/{id}/checkMemberGroups`. (2) Een certificaat is volgens Learn maximaal een jaar geldig: RSA 2048, 360 dagen, `customKeyIdentifier` niet meegeven. (3) `response_mode=query` (niet `form_post`) omdat de korte Lax-statuscookie anders niet meekomt; na de callback volgt een tussenpagina (geen 302) zodat de `SameSite=Strict`-sessiecookie meekomt. (4) `max_age` is voor Entra niet gedocumenteerd: step-up is `prompt=login` plus controle van `auth_time` en `amr`. (5) Device code kan door een Conditional Access-beleid worden geblokkeerd, ook met een eigen `BOOTSTRAP_CLIENT_ID`: er komt een handmatige inrichtmodus als terugvaloptie. (6) Scopes werken per objecttype; rechten zonder objecttype (instellingen, audit, RBAC) komen alleen uit onbeperkte toewijzingen; `users:read` kent de kwalificatie `basic` (naam en e-mail) voor het sjabloon *Bestuur*. (7) Elke geweigerde actie van een ingelogde gebruiker komt in het auditlog, ook leesacties; anonieme leesacties niet.

**Exchange.** Fase B levert de `ExchangeClient`-interface en een adapter voor het gedocumenteerde leespad (Admin API, Preview) voor de wizard-verificatie. Het schrijfpad voor DL-leden en contacten (pwsh-worker, alleen leesrechten via de Admin API, of een ongedocumenteerde route) wordt **niet** beslist: dat is een eigenaarsbeslissing, met memo in Bijlage A.

**Elke MUST heeft een benoemde geautomatiseerde controle** (Vitest-bestand, Playwright-test, CI-job of hook). Entra, Graph en Exchange worden gesimuleerd (MSW voor HTTP, een in-process nep-identiteitsprovider die met `jose` tokens ondertekent). Wat alleen tegen een echte tenant te bewijzen is, staat expliciet in het **owner-verified-grootboek** (sectie 8.6).

**Acceptatiecriteria.** Volledig of grotendeels in fase B: 1, 2, 11 (model, aanmelden, afdwingen; scopes op echte objecten volgen in C). Gedeeltelijk: 5, 6, 7, 8, 9 (blijven groen), 12 (data en afdwinging van het sjabloon *Bestuur*; HTTP-flows in D), 13 (alleen voorwaarden). Niet in B: 3, 4. Zie sectie 7.2.

---

## Document status

**Feature Branch**: the branch this session was given (integration branch undecided: AGENTS.md section 8, Phase A OD-02)

**Created**: 2026-10-10

**Status**: Draft for the Phase B gate. Written spec-first, in parallel with the Phase A build, from the Phase A *planned* interfaces (`specs/001-m365portal/plan.md`, `tasks.md` section 3, contracts C1 to C14). The Phase B plan MUST re-read the as-built Phase A code before it writes tasks; where the code differs from the plan, the plan amends this spec in the same commit.

**Input**: `docs/build-prompt.md` (sections 2, 2a, 3, 6, 7, 8), the Phase A spec (outline rows FR-B-001 to FR-B-012, assumptions A-xx, edge cases, BC-xx, OD-xx), `research-microsoft.md` (Phase A research, U1 to U17), `research-microsoft-b.md` (Phase B research, same folder: rules R-01 to R-25, owner-verified OV-01 to OV-13, UNVERIFIED U18 to U33), the Flux76 baseline, and the orchestrator's Phase B defaults, recorded here as assumptions B-01 to B-13 with the evidence that kept or changed each one (section 9).

**Microsoft evidence.** Every Microsoft claim is either carried from the two research files (cited as "research §n") or was re-read on Microsoft Learn on 2026-10-10 while writing this spec (section 8.1 lists what was re-read and what it changed). Anything Learn does not state is marked UNVERIFIED with a `U` number (U34 and up are new in this document). No API, permission, claim name, endpoint or cmdlet parameter in this document comes from memory.

---

## 1. Scope and phase gate

### 1.1 Scope

| Area | In Phase B | Not in Phase B (phase) |
|---|---|---|
| First-run protection | Setup token, brute-force limits, loopback guard over plain http, lock after first Owner sign-in, `setup-reopen` CLI | none |
| Onboarding wizard | Five steps of brief 3; idempotent, resumable, per-step status and rollback hint, live log lines, retry and backoff for propagation, "Herstel verbinding" in Settings; manual provisioning mode (SHOULD) | Automatic rollback and removal of tenant objects (hints only); wizard-driven certificate rotation by `addKey` (D) |
| Tenant provisioning | App registration, service principal, self-signed certificate, 4 Graph application permissions, Exchange app roles, Exchange Administrator Entra role, redirect URIs, optional claims | Custom Exchange role group (follow-up); group creation (dropped, BCB-01) |
| Secrets | `APP_KEY` / `APP_KEY_FILE`, libsodium XChaCha20-Poly1305, certificate private key sealed at rest, rotation CLI, bootstrap token memory-only | Key Vault references (D or later) |
| Sign-in and sessions | OIDC code flow with PKCE and certificate assertion, ID-token validation, MFA gate on `amr`, server-side hashed sessions, rotation, idle and absolute timeouts, sign-out and sign-out everywhere, session-bound CSRF, step-up mechanism | Front-channel and back-channel logout (not supported), phishing-resistant authentication strength (tenant policy), session list UI (D) |
| RBAC foundation | Tables, 5 immutable built-in roles, *Bestuur* template as data, effective permissions, scope model enforced by the policy layer, group-membership cache with short TTL, default no access, first Owner, last-Owner protection, no privilege escalation, assignment API, "Mijn toegang" page | RBAC admin UI, custom-role UI, "view as", scope pickers (D); real group, list and contact objects to scope on (C, D) |
| Break-glass | Optional env-configured local account, restore-Owner only, loudly audited (decided for Phase B, B-17) | Second factor or IP allow-list for break-glass (D hardening) |
| Clients | `GraphClient` (app-only, MSAL client credentials, retry and cache), `TenantProvisioner` (delegated, bootstrap only), `ExchangeClient` interface plus Admin API read adapter | Graph write methods for users and groups (C), Exchange write path (D, owner decision ODB-01) |
| Audit | Every new write and every denial (section 6.6) | Audit UI and export (D) |
| Phase A changes | `PREVIEW_MODE` and the preview actor removed; actor kinds `user`, `setup`, `break_glass`; 401 for missing sessions; CSRF bound to the session; e2e topology replaced (section 13.2) | none |

### 1.2 Phase A interfaces Phase B builds on, and the additive changes it needs

Names are the planned ones (plan 7.2, 8.8; tasks 3). "Additive" means no existing signature changes.

| Interface (Phase A) | Phase B use | Change |
|---|---|---|
| `defineRoute({ id, method, path, access, rateLimit, request, responses, audit? })` and the route table | Every new route declares access, class and audit | `access` gains `{ authenticated: true }`, optional `stepUp: true` and `scoped: ResourceType` on permission access; `rateLimit` gains classes `auth` and `setup`; OpenAPI extensions `x-step-up`, `x-scoped` |
| `AppModule { id; routes(deps); shell?; start?; stop? }`, `appModules` | New modules `secrets`, `setup`, `auth`, `rbac`, `connection` | Append factories (seam on `apps/server/src/modules.ts`, like Phase A seam X1) |
| `Actor`, `authorize(actor, permission, resource?)` | Real actors; `resource` now used | `Actor.kind` gains `user`, `setup`, `break_glass` (and loses `preview`); `Actor` gains `grants`; `Decision.reason` gains `scope_mismatch`; new `visibleScopes`, `canGrant` |
| Audit writer `appendAudit(tx, entry)`, `withTransaction`, detail allow-list, action vocabulary | All new writes and denials | Allow-list and vocabulary extended (section 6.6); actor kinds `user`, `setup`, `break_glass`, `cli` |
| Config schema (one Zod schema), `.env.example` parity, posture log line | New variables (6.9.1) | `PREVIEW_MODE*` removed; posture line gains setup state, secrets, break-glass, MFA policy |
| Migration wrapper, committed schema snapshots, upgrade test | Migration `0001_phase_b` | First real (non-synthetic) upgrade pair |
| CSRF `binding` argument (empty in Phase A) | Session id hash | none (the argument exists) |
| Shell renderer and boot data (`me`, `branding`) | Boot data carries the real actor | `MeResponse` shape (6.4, FR-B-413) |
| i18n fragments per namespace, catalogue checks | New namespaces | none |
| Design system, DataTable, ConfirmDialog, Banner, Toast, Persona | Wizard, sign-in, Settings pages | none |
| `LIMITS` (single source), `docs/operations.md` limits table | New numbers (6.9.2) | rows added |
| Readiness checks `data_dir`, `database`, `schema` | Secrets | check `secrets` added |
| CLI `node dist/cli.js verify-audit` | More commands | commands added (FR-B-110) |
| Image smoke test, e2e topology | New flows | extended; e2e topology replaced (FR-B-708) |

### 1.3 Mapping of the Phase A outline rows

The outline rows FR-B-001 to FR-B-012 of the Phase A spec are intent only. This document supersedes them; its rows use the numbers FR-B-101 and up so the two number ranges never collide.

| Phase A outline row | Intent | Rows in this spec |
|---|---|---|
| FR-B-001 | Wizard, lock, restart | FR-B-201 to FR-B-212, FR-B-219, FR-B-221 |
| FR-B-002 | Environment step | FR-B-213 |
| FR-B-003 | Device-code bootstrap | FR-B-214, FR-B-215, FR-B-217, FR-B-218 |
| FR-B-004 | Tenant configuration | FR-B-301 to FR-B-308 |
| FR-B-005 | Verification with backoff | FR-B-212, FR-B-309, FR-B-316 |
| FR-B-006 | Branding step, first Owner | FR-B-219 |
| FR-B-007 | OIDC sign-in, sessions, MFA | FR-B-401 to FR-B-419 |
| FR-B-008 | Secrets at rest | FR-B-104 to FR-B-110, FR-B-112 |
| FR-B-009 | RBAC foundation | FR-B-501 to FR-B-514 |
| FR-B-010 | Break-glass | FR-B-521 to FR-B-523 |
| FR-B-011 | "Herstel verbinding" | FR-B-220 |
| FR-B-012 | `GraphClient`, `ExchangeClient` | FR-B-311 to FR-B-315 |

### 1.4 Coverage of the brief (sections 2, 2a, 3, 6, 7)

| Brief item | Rows |
|---|---|
| 2 Panel login, one app registration, certificate assertion, server-side sessions, CSRF, strict cookies, rate limiting | FR-B-112, FR-B-401 to FR-B-418, FR-B-303 |
| 2 Runtime app-only access with certificate, private key encrypted at rest | FR-B-104 to FR-B-108, FR-B-311 |
| 2a Permissions, built-in roles, *Bestuur*, assignments to users and groups, groups re-resolved at each sign-in including overage, default no access, scopes, server-side enforcement, anti-escalation, last Owner, first Owner, break-glass, audit, data model | FR-B-501 to FR-B-523, FR-B-601, FR-B-602 |
| 3 Wizard steps 1 to 5, repair action | FR-B-201 to FR-B-222, FR-B-301 to FR-B-309 |
| 6 Panel login (OIDC, `state`/`nonce`, issuer/audience/`tid`, MFA, rotation, timeouts, sign-out everywhere, Conditional Access, step-up) | FR-B-402 to FR-B-412, FR-B-419 |
| 6 Secrets (libsodium, key from secret) | FR-B-104 to FR-B-110 |
| 6 Web security under the strict CSP | FR-B-605, FR-B-606 |
| 7 Client separation, MSW tests, a11y, i18n | FR-B-310 to FR-B-315, FR-B-604, FR-B-609, FR-B-707, FR-B-708 |

### 1.5 Suggested build streams (input to the Phase B plan; not binding)

S-B1 secrets, config, CLI (FR-B-1xx); S-B2 identity and Microsoft clients plus the fake tenant (FR-B-112, FR-B-3xx, FR-B-707); S-B3 setup engine and API (FR-B-2xx); S-B4 sign-in and sessions (FR-B-4xx); S-B5 RBAC and policy (FR-B-5xx); S-B6 web (wizard, sign-in, Settings pages, session UX); S-B7 docs, CI, e2e, image. The seams in Phase A territories are listed in section 13.2.

---

## 2. Document conventions

- **Levels.** MUST and SHOULD as in RFC 2119. Baseline section 7: a MUST without an automated enforcement point does not belong here. Where a MUST can only be enforced by review the row says so (FR-B-712 only).
- **IDs.** `FR-B-nnn` requirements (ranges: 1xx configuration and secrets, 2xx setup gate and wizard, 3xx tenant provisioning and clients, 4xx sign-in and sessions, 5xx RBAC and break-glass, 6xx audit, errors, i18n, UI, 7xx persistence, limits, docs, CI); `US-Bn` stories; `EB-nn` edge cases; `SC-B-nnn` success criteria; `B-nn` assumptions; `BCB-nn` brief conflicts; `ODB-nn` owner decisions; `RB-nn` risks; `F-nn` sign-in fixtures (Appendix C); `OV-nn` owner-verified items (OV-01 to OV-13 keep the research numbers; OV-05, OV-06 and OV-13 are narrowed to what Phase B ships, the `pwsh` parts of research OV-06 and OV-13 are now the optional experiment OV-13; OV-14 and up are new here); `U-nn` UNVERIFIED items (U1 to U17 Phase A research, U18 to U33 Phase B research, U34 and up new here); `AM-nn` amendments to Phase A artefacts (13.2).
- **Test path prefixes.** As in Phase A: `server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`, `py/` is `scripts/`. New server test folders: `server/setup/`, `server/auth/`, `server/rbac/`, `server/secrets/`, `server/connection/`, `server/integrations/`, `server/fakes/`. Names are the planned paths; `tasks.md` may refine them but MUST keep the requirement-to-control mapping one to one and update this spec in the same commit. Names that equal a rule of `research-microsoft-b.md` section 13 were taken over so the two documents agree (mapping in 8.7).
- **CI vocabulary.** Existing job names only: `quality`, `e2e`, `image`, `enforce-version-bump`, `agent-instructions-lint` (plus `publish`, `analyze`). No new job is introduced; new steps live inside them.
- **Simulation rule.** No automated test reaches a real tenant. Entra, Graph and Exchange are simulated (MSW for HTTP, `onUnhandledFrame: 'error'` so any request the simulation does not know fails the test; an in-process fake identity provider that signs with `jose`). The simulation encodes our reading of Learn; it cannot prove what Microsoft does. That residue is the owner-verified ledger (8.6).
- **Guard tests are tested.** Baseline section 2: a guard nobody has seen fail is an assumption. Rows marked "(+ negative)" ship a fixture that makes the guard fail on purpose.
- **Normalisers.** Baseline section 10 applies: grant computation, scope matching, qualifier projection, `amr` evaluation, return-URL sanitising, cookie naming, redirect-URI computation and the built-in role matrix are each defined once in `packages/shared` (FR-B-713).
- **No secrets.** No document, fixture or test in this phase contains a real secret; tests generate throwaway keys and certificates.

---

## 3. Phase gate

1. The Phase B report (`docs/phase-reports/phase-B.md`) follows the five points of the brief and Phase A section 3, and adds the owner test plan: the owner-verified ledger (8.6) as a checklist, the decisions ODB-01 to ODB-15 (section 11) and the Exchange memo (Appendix A).
2. **Work stops after the report.** No agent starts Phase C, including scaffolding, dependencies or spec amendments for it, before the owner's explicit approval.
3. The owner tests Phase B against a real Microsoft 365 tenant; that test is the owner's, the report only prepares it.
4. Enforcement: review only (FR-B-712), in line with baseline section 17; `tasks.md` ends with a gate task and nothing scheduled behind it.
5. The report states separately what ran locally, what only runs on GitHub, what was simulated (and which assumptions the simulation encodes), and what is owner-verified.

---

## 4. User Scenarios and Testing

Priorities: P1 needed for the gate, P2 expected, P3 desirable.

### US-B1 A stranger cannot take over an unconfigured panel (P1)

**Why**: an unconfigured panel that is reachable on a network is administration of a whole tenant for whoever finds it first.

**Independent test**: `server/setup/gate.test.ts`, `server/setup/token.test.ts`, `e2e/setup-gate.spec.ts`.

1. **Given** a new volume and no `SETUP_TOKEN`, **When** the container starts, **Then** `/data/setup-token` exists (mode 0600), the log says only how to print it (`docker exec <container> /nodejs/bin/node /app/dist/cli.js setup-token`, UNVERIFIED path until the image smoke test runs it, U34), and the token appears in no log line.
2. **Given** the panel is unconfigured, **When** any client calls any setup or connection route except `status` and `unlock`, **Then** it gets 401 `unauthenticated` and no tenant data, step state or log line is returned.
3. **Given** a client, **When** it sends 5 wrong tokens within 15 minutes, **Then** it gets 429 `setup_token_locked` with `Retry-After`, and a correct token during the lock is also refused.
4. **Given** the right token, **When** I submit it, **Then** I get a setup session (cookie, idle 60 minutes) and the wizard shows step 1.
5. **Given** `PUBLIC_BASE_URL=http://localhost:8080` and a request with a non-loopback `Host` or forwarding headers, **Then** setup routes answer 404 (accidental-exposure guard; the token is the boundary).

### US-B2 The wizard configures the tenant (P1)

**Independent test**: `e2e/setup-wizard.spec.ts` against the fake tenant; owner test OV-01 to OV-06.

1. **Given** an unlocked wizard and a healthy environment (`APP_KEY` valid, `PUBLIC_BASE_URL` https or `http://localhost`), **When** I start the connection, **Then** the wizard shows a device code and the verification link; no Microsoft token reaches the browser.
2. **Given** an administrator completed the device sign-in, **When** configuration runs, **Then** I see per sub-action status, live log lines, and at the end the application, service principal, certificate thumbprint and expiry, the granted application permissions, the Exchange Administrator assignment and the verification results.
3. **Given** the Exchange Admin API preview answers 403 for 15 minutes after the role assignment, **Then** the verification ends as warning `exchange_not_ready`, not as failure, and everything else is usable.
4. **Given** the tenant has no "Office 365 Exchange Online" service principal, **Then** the Exchange sub-actions are `skipped`, the step is a warning, and Exchange features stay disabled.
5. **Given** device code is blocked (Conditional Access `AADSTS53003`), **Then** the wizard names the cause and offers the manual provisioning mode.

### US-B3 The wizard is idempotent and resumable (P1)

**Independent test**: `server/setup/idempotency.test.ts`, `server/setup/resume.test.ts`.

1. **Given** a completed configuration, **When** I run it again, **Then** only read calls are made and no object is created twice.
2. **Given** the process dies after any one of the mutating calls, **When** it restarts and I unlock the wizard, **Then** the interrupted sub-action is re-run from its read phase and the final tenant and setup state equal an uninterrupted run (the bootstrap sign-in must be repeated: the token lives in memory only).
3. **Given** two browsers press "run" at once, **Then** one gets 409 `setup_step_busy`.

### US-B4 The wizard locks and the configuration survives (P1)

**Independent test**: `server/setup/lock.test.ts`, `server/setup/complete-on-signin.test.ts`, `e2e/setup-lock.spec.ts`. Partly satisfies brief criteria 1 and 2.

1. **Given** the wizard finished, **Then** the state is `awaiting_first_signin`, `/setup` still needs the token, and the panel offers "Aanmelden".
2. **Given** the designated first Owner signs in successfully, **Then** the state becomes `completed` in the same transaction as the session, the token file is deleted and an audit entry `setup.complete` exists.
3. **Given** `completed`, **Then** `/setup`, `/setup/anything` answer HTTP 404, every `/api/v1/setup/*` route (`status` and `unlock` included) answers the standard 404 problem, and `/api/v1/connection/*` no longer accepts a setup session (it serves a signed-in user holding `settings:connection`); after a restart the same holds and all configuration is intact.

### US-B5 Sign in with Entra and get exactly the panel's rights (P1)

**Independent test**: `server/auth/callback.test.ts`, `e2e/signin.spec.ts`. Satisfies part of criterion 11.

1. **Given** a user with an assignment, **When** I press "Aanmelden met Microsoft", **Then** I am redirected to the tenant-pinned authorize URL with PKCE, `state`, `nonce`, `response_mode=query` and scopes `openid profile`; after Entra returns, I land on the page I came from, already shown as signed in on first paint.
2. **Given** my token lacks `mfa` in `amr` and MFA is required, **Then** I see a specific explanation and a "Sign in again" action; no session exists.
3. **Given** a tampered, replayed, expired or foreign token (fixtures F-02 to F-45), **Then** sign-in fails with a generic code, no session is created, and nothing in the response says which check failed.
4. **Given** a Global Administrator without a panel role, **Then** I get the "geen toegang" page with a reference id, no session, and an audit entry `auth.signin` denied `no_role`.

### US-B6 Roles are enforced on the server, not in the UI (P1)

**Independent test**: `server/policy-matrix.test.ts`, `server/rbac/escalation.test.ts`, `server/rbac/last-owner.test.ts`. Satisfies the model and enforcement part of criterion 11.

1. **Given** a user with only *Lezer*, **When** they call any write route directly with valid Origin and CSRF, **Then** 403 `permission_denied` and an audit entry.
2. **Given** a user with *Helpdesk* and a custom role that holds `rbac:manage` only for assignments within their own rights (fixture), **When** they try to assign *Operator*, **Then** 403 `escalation_denied`.
3. **Given** exactly one Owner, **When** they try to delete or demote themselves, **Then** 409 `last_owner_protected`; two owners racing to remove each other leave exactly one.
4. **Given** an assignment scoped to group *Sales*, **Then** `authorize(actor, 'groups:members:write', group Sales)` allows and the same for group *HR* answers `scope_mismatch` (policy level; HTTP flows on real groups arrive in Phase C).

### US-B7 Entra groups grant roles, and revocation is timely (P1)

**Independent test**: `server/rbac/membership.test.ts`, `server/rbac/overage.test.ts`, `server/auth/revalidate.test.ts`.

1. **Given** a group assigned to *Beheerder*, **When** a member signs in, **Then** `checkMemberGroups` decides (chunks of 20); a `groups` claim in the token is ignored.
2. **Given** the member is removed from the group, **Then** within `GROUP_CACHE_TTL_SECONDS` the next request drops the group-derived rights.
3. **Given** the Graph call fails, **Then** direct assignments still apply, group-derived rights are denied, and the session shows a "membership could not be determined" notice.
4. **Given** the user is disabled or deleted in Entra, **Then** the next revalidation revokes the session.

### US-B8 Sessions behave (P2)

**Independent test**: `server/auth/session-store.test.ts`, `server/auth/step-up.test.ts`, `e2e/session-timeout.spec.ts`.

1. Idle timeout default 30 minutes, absolute 8 hours; a warning dialog with "Sessie verlengen" appears 2 minutes before idle expiry.
2. "Sign out everywhere" ends every session of the user; sign-out ends the Entra session too (redirect to the end-session endpoint).
3. A step-up-protected route answers 403 `step_up_required` until the user re-authenticates (`prompt=login`, fresh `auth_time`, MFA policy again).

### US-B9 Repair the connection (P2)

**Independent test**: `server/connection/repair.test.ts`, `e2e/connection-repair.spec.ts`.

1. **Given** `PUBLIC_BASE_URL` changed, a permission was removed, or the certificate nears expiry, **When** the Owner runs "Herstel verbinding" (step-up, fresh device sign-in), **Then** only the drifted sub-actions change and no duplicate object appears.

### US-B10 Break-glass restores access (P2)

**Independent test**: `server/auth/break-glass.test.ts`, `server/rbac/restore-owner.test.ts`, `e2e/break-glass.spec.ts`.

1. **Given** `BREAK_GLASS_*` is configured and no Owner can sign in, **When** the operator signs in with the break-glass account, **Then** a red banner shows, the session lasts at most 30 minutes, and the only successful write is "Eigenaar herstellen" for a given user object id.
2. **Given** break-glass is not configured, **Then** its route answers 404.

### US-B11 Secrets are sealed and rotatable (P2)

**Independent test**: `server/secrets/*.test.ts`, `image` smoke test.

1. The certificate private key exists on disk only as a sealed blob; a missing or wrong `APP_KEY` yields a readable degraded state, not a crash; `rotate-app-key` re-seals everything or nothing.

### US-B12 The Owner sees their own access and the connection state (P3)

**Independent test**: `web/access-page.test.tsx`, `e2e/access.spec.ts`, `e2e/connection.spec.ts`.

1. "Mijn toegang" lists roles, where each came from (direct or group), scopes, expiry and effective permissions; Settings, Connection shows state, certificate expiry and the proof list.

### US-B13 Read the documentation in Dutch or English (P3)

README, `docs/security.md`, `docs/permissions.md`, `docs/operations.md`, `docs/architecture.md` and `docs/open-points.md` are updated in both languages and pass the docs contract (FR-B-709).

---

## 5. Edge Cases

Every row names a required behaviour. "Enforced by" uses the vocabulary of section 2.

| ID | Situation | Required behaviour | Enforced by |
|---|---|---|---|
| EB-01 | Setup token leaked into a URL, log, referrer, error page or the shell | The token is only accepted in a POST body; no route reads it from a query string; canary absent from logs, audit, responses and the HTML shell | `server/setup/token.test.ts`, `server/no-leak.test.ts` |
| EB-02 | Restart in the middle of the wizard | `running` rows are reset to `pending`; the operator unlocks again with the token; the bootstrap sign-in is repeated; finished sub-actions are only re-read | `server/setup/resume.test.ts` |
| EB-03 | Device code expires, is declined, or the user closes the tab | Polling stops; step 2 returns to "start"; the code is not reusable; the in-memory token cache is cleared | `server/setup/device-code.test.ts` |
| EB-04 | Device code blocked by Conditional Access (`AADSTS53003`) | A distinct message names Conditional Access and the manual mode; a custom `BOOTSTRAP_CLIENT_ID` is not offered as the cure | `server/setup/aadsts-map.test.ts` |
| EB-05 | Wizard user lacks a role (`AADSTS90094`, 403 from Graph) | A message lists Global Administrator or Privileged Role Administrator plus an app-registration role | `server/setup/aadsts-map.test.ts` |
| EB-06 | An application with the wizard's name exists | One match with our install tag: adopt. One match without: stop and ask (explicit confirmation recorded). Several: `application_ambiguous`. Never a silent duplicate | `server/setup/discovery.test.ts` |
| EB-07 | Replication delay (404 on a just-created object, 400 "source resource object", 403 after a grant) | Classified as replication; retried with backoff inside the window; every wait appears in the live log | `server/setup/replication-retry.test.ts` |
| EB-08 | Tenant has no Exchange Online service principal | Sub-actions skipped, `exchange_enabled=false`, step warning, no first-party object created | `server/setup/exchange-role.test.ts` |
| EB-09 | Exchange Admin API preview unavailable or role not yet effective | Verification result `warning`; never `failed`; retry button; message says the preview may not be available in the organisation | `server/setup/verify.test.ts` |
| EB-10 | App management policy refuses the credential or redirect URI | The Graph error text (allow-listed fields) is shown; for a lifetime refusal the wizard offers a shorter validity; no retry on permanent errors | `server/setup/certificate-upload.test.ts` |
| EB-11 | `PUBLIC_BASE_URL` changed after setup | Entra shows its own redirect-URI error; the panel cannot help the user in the browser. Recovery: break-glass cannot fix connection settings; `setup-reopen`, change the URL, repair | `server/cli.test.ts`, `docs/operations.md` (docs contract) |
| EB-12 | `APP_KEY` missing or wrong after setup | `/readyz` fails check `secrets` (`app_key_missing`, `app_key_invalid`); sign-in answers 503 `secrets_unavailable`; static UI and break-glass work | `server/secrets/degraded.test.ts` |
| EB-13 | Certificate expired or expiring | Banner at 60 days and critical at 14 days; expired: token requests fail `invalid_client`, sign-in unavailable; recovery by `setup-reopen` and repair | `server/connection/cert-expiry.test.ts` |
| EB-14 | Clock skew between host and Microsoft | Environment check warns at 60 s and fails at 300 s skew (our thresholds, U35); JWT tolerance is 60 s | `server/setup/environment.test.ts` |
| EB-15 | Browser blocks cookies | The callback finds no transaction cookie and redirects to `/signin?error=cookies_missing_or_expired` with a translated explanation; nothing is audited | `server/auth/callback.test.ts` (F-30) |
| EB-16 | Same callback URL used twice, or two tabs sign in | The transaction is single use; the second callback fails; tabs do not share transactions | `server/auth/replay.test.ts` |
| EB-17 | `returnTo` attack (`//host`, `/\host`, scheme, `/api/...`, CRLF, 300 characters) | Falls back to `/`; never reflected unescaped | `server/auth/return-to.test.ts` |
| EB-18 | A token carries a `groups` claim, `_claim_names` or `hasgroups` | Ignored; groups come only from `checkMemberGroups` | `server/rbac/overage.test.ts` |
| EB-19 | More than 20 bound groups, nested groups, hidden-membership group, deleted group | Chunks of 20; nested via transitive semantics; hidden and deleted never match (fail closed); one malformed id never reaches Graph | `server/rbac/membership.test.ts` |
| EB-20 | User is disabled, deleted, or loses a group while signed in | Revalidation at TTL; disabled or deleted revokes the session with audit; group loss drops the rights | `server/auth/revalidate.test.ts` |
| EB-21 | Graph unavailable during sign-in | Direct grants apply, group grants denied; if nothing remains the user sees `graph_unavailable` (not `no_role`) | `server/auth/callback.test.ts` |
| EB-22 | Guest or foreign-tenant user | `tid` must equal the pinned tenant; a guest of the pinned tenant is an ordinary principal by `oid`; foreign `tid` fails | `server/integrations/identity/id-token.test.ts` (F-04, F-05) |
| EB-23 | Two Owners remove each other at the same time | Exactly one remains (`BEGIN IMMEDIATE` plus trigger) | `server/rbac/last-owner.concurrency.test.ts` |
| EB-24 | Assignment expires while the user is signed in | Rights vanish at the expiry instant without re-sign-in | `server/rbac/expiry.test.ts` |
| EB-25 | Break-glass guessing | 5 failures per client per 15 minutes and 20 per hour in total lock the route (429); failures inside the bound are audited | `server/auth/break-glass.test.ts` |
| EB-26 | `AUTH_REQUIRE_MFA=true` but the tenant never emits `amr` | Error `amr_missing` (registration issue) differs from `mfa_required`; both explain the remedy; repair re-applies the optional claim | `server/auth/mfa.test.ts` |
| EB-27 | Security Defaults tenant: non-administrators may sign in without `mfa` | Blocked while the policy is on, with a message naming the two remedies; owner-verified (OV-11) | `server/auth/mfa.test.ts`; OV-11 |
| EB-28 | First sign-in by a non-administrator hits a consent prompt or "need admin approval" | Callback error mapped to a message; an administrator-consent link is offered (SHOULD); effect owner-verified | `server/auth/consent-link.test.ts`; OV-12 |
| EB-29 | Upgrade of a Phase A volume | Migration `0001` applies; preview-era audit rows and branding stay valid; the panel starts `unconfigured`; a leftover `PREVIEW_MODE=true` logs one warning and has no effect | `server/migrations.upgrade.test.ts`, `server/config.test.ts` |
| EB-30 | Operator runs the panel behind a reverse proxy that rewrites `Host` or drops cookies | Documented; cookies are host-only; `PUBLIC_BASE_URL` is the only origin used for redirect URIs and Origin checks | `server/docs-contract.test.ts` (checklist present) |
| EB-31 | Outbound HTTPS blocked or proxied | Environment check `network` fails with the three host names; documented `NODE_USE_ENV_PROXY` hint is UNVERIFIED (U41) | `server/setup/environment.test.ts` |
| EB-32 | Tenant in a sovereign cloud | Unsupported; the documentation says so; Microsoft's own errors surface through the standard sign-in error page | `server/docs-contract.test.ts` |
| EB-33 | Container started with a non-writable `/data` while a setup token is needed | Degraded mode of Phase A applies; setup routes answer 503 `storage_unavailable`; the token file is not created | `server/lifecycle.test.ts` |
| EB-34 | `rotate-app-key` interrupted | One transaction: all rows re-sealed or none | `server/secrets/rotate.test.ts` |
| EB-35 | A scoped route handler forgets to apply scope | Fail-closed 500 `policy_not_applied`, audited | `server/policy-scoped-routes.test.ts` |

## 6. Requirements

Format: ID, level, requirement, enforcement. Tables 6.9.1 to 6.9.7 hold the normative values (environment variables, limits, cookies, built-in role matrix, problem codes, audit actions, routes) that the rows refer to.

### 6.1 Configuration, secrets and certificate

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-101 | MUST | The single Zod configuration schema gains the variables of table 6.9.1 with the stated ranges. Invalid configuration exits non-zero before listening with `config_invalid` naming variables, never values. Cross-field rules: exactly one of `APP_KEY` and `APP_KEY_FILE` may be set (neither is allowed before setup, see FR-B-213); `APP_KEY_PREVIOUS` and `APP_KEY_PREVIOUS_FILE` likewise; `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` are both set or both unset; `SESSION_ABSOLUTE_TIMEOUT_HOURS` x 60 is greater than `SESSION_IDLE_TIMEOUT_MINUTES`. The start posture line (FR-A-015) additionally reports, without values: setup state, secrets state, break-glass enabled, MFA policy on or off. | `server/config.test.ts` (range tables with negatives for every variable and rule), `server/logging.test.ts` (posture line, no values) |
| FR-B-102 | MUST | `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` are removed from the schema, the code, `.env.example`, the documentation, the banner component, the preview actor resolver and the e2e topology. If either variable is present in the environment, the server logs one warning `preview_mode_removed` naming the variable and otherwise ignores it. The wire field `features.preview` is removed from `MeResponse`. | `server/config.test.ts` (warning and no effect), `server/deploy-files.test.ts` (`.env.example` parity), `shared/repo-conventions.test.ts` (source scan finds no `PREVIEW_MODE`, no `preview` actor kind, no `features.preview` in `apps/*/src` and `packages/shared/src`) (+ negative) |
| FR-B-103 | MUST | `PUBLIC_BASE_URL` must be `https` (any host) or `http` with host exactly `localhost` (no `127.0.0.1`, no `[::1]`, no other host); otherwise `config_invalid`. One shared module `redirectUris(publicBaseUrl)` computes the two registered redirect URIs and `authorizeRedirectUri(publicBaseUrl)` the one sent in requests: https gives `<origin>/auth/callback` and `<origin>/auth/logged-out` (registered and sent identically); `http://localhost:<port>` registers `http://localhost/auth/callback` and `http://localhost/auth/logged-out` without port (Learn ignores the port when matching, research §2.2) and sends the real origin with port. Wildcards, userinfo, query, fragment, the characters `! $ ' ( ) , ;`, internationalised hosts and uppercase path differences are refused. The module is the only place these strings are built. | `shared/redirect-uri.test.ts` (table of valid and invalid URIs from research §2.2, port handling, round trip with the config schema) (+ negative), `server/config.test.ts` |
| FR-B-104 | MUST | `APP_KEY` (or the content of the file named by `APP_KEY_FILE`, at most 1,024 bytes, one trailing newline trimmed) is exactly 32 bytes encoded as base64 or base64url (43 or 44 characters) or as 64 hexadecimal characters. Rejected: wrong length or encoding, all bytes equal, fewer than 16 distinct byte values. The key is never logged, echoed, put in an error message or exposed in `/readyz`. Its key id is the first 8 bytes (hex) of SHA-256 over the ASCII string `m365portal-key-id` followed by the key; the key id may be logged and stored. | `server/secrets/app-key.test.ts` (formats, rejections, key id, canary absent from log capture) (+ negative) |
| FR-B-105 | MUST | Sealing uses libsodium `crypto_aead_xchacha20poly1305_ietf` through `libsodium-wrappers`. A per-purpose 32-byte subkey is derived from `APP_KEY` with libsodium key derivation (context `m365sec1`, subkey id 1 for sealed secrets); nonce is 24 random bytes per encryption; the stored form is the version byte 0x01, then the nonce, then the ciphertext; additional data is the UTF-8 text `m365portal/secret/v1`, the purpose, the secret id and the key id, joined by the byte 0x1F, so a blob moved to another row, purpose or key fails. Wrong key, any flipped byte in version, nonce, ciphertext or additional data, truncation and swapped rows all fail closed with a typed `SecretDecryptError` carrying no plaintext. The function names are checked against the pinned `libsodium-wrappers` build by the test. | `server/secrets/sealed-box.test.ts` (round trip, flip every region, wrong key, row swap, truncation, random-data fuzz of 1,000 blobs) (+ negative) |
| FR-B-106 | MUST | Certificate generation: RSA 2048, self-signed X.509 v3, SHA-256 signature, random 16-byte positive serial, subject `CN=M365Portal <first 8 hex characters of the install id>`, basic constraints CA false, key usage digital signature, `notBefore` = now minus 5 minutes and `notAfter` = `notBefore` + 360 days (Learn: a key credential may last at most one year from `startDateTime`, research §2.4; sizes other than 2048 are UNVERIFIED, U20). The private key is exported as PKCS#8 PEM only in memory and sealed immediately (FR-B-107). Thumbprints are computed from the DER: SHA-1 (40 hex, equals the `customKeyIdentifier` Entra assigns) and SHA-256 (64 hex, for `x5t#S256`). `node:crypto` can parse but not create certificates (checked on Node 22.22), so the generator is a small dependency chosen by a plan-time probe (B-19); the `image` smoke test creates a certificate inside the real image. | `server/secrets/certificate.test.ts` (parsed with `node:crypto` `X509Certificate`: key size, signature algorithm, validity, serial, extensions, both thumbprints against an independent computation, key pair match), `image` smoke test |
| FR-B-107 | MUST | The private key exists at rest only as a sealed blob in table `secret`. It is never written to disk in clear (no temporary file, no PFX), never sent in any outbound request body, and never appears in logs, audit, problem bodies, backups or responses. The in-memory holder (`CertificateHolder`) exposes signing and thumbprints, not the PEM, and its `toJSON`, `toString` and `util.inspect` give `[redacted]`. Database backups contain only sealed blobs; `APP_KEY` is not stored under `/data`. | `server/secrets/no-plaintext.test.ts` (after a full fake-tenant wizard run, every file under the data directory including `-wal`, `-shm` and backups is scanned for PEM markers and for the base64 and hex forms of the key), `server/no-leak.test.ts` (canary key in logs, responses, audit), `server/setup/certificate.test.ts` (canary in every outbound MSW request body), `image` smoke test |
| FR-B-108 | MUST | Secrets state at start and in `/readyz`: once a certificate exists, the active certificate key is decrypted at start. Missing `APP_KEY` gives readiness check `secrets` failing with code `app_key_missing`; a key that does not decrypt gives `app_key_invalid`; an unreadable certificate row gives `certificate_unreadable`. The process stays up (degraded): `/healthz` 200, `/readyz` 503, sign-in and Graph and Exchange clients answer 503 `secrets_unavailable`, the static UI and break-glass work, and the UI explains the cause and the remedy. | `server/secrets/degraded.test.ts`, `server/health.test.ts` (check `secrets`), `e2e/degraded-secrets.spec.ts` |
| FR-B-109 | MUST | `node dist/cli.js rotate-app-key` takes the new key from `APP_KEY` or `APP_KEY_FILE` and the old key from `APP_KEY_PREVIOUS` or `APP_KEY_PREVIOUS_FILE`. It first copies the database with the SQLite backup API to `backups/pre-rotate-<UTC timestamp>.sqlite`, then in one transaction decrypts every `secret` row with the previous key (selected by the stored key id) and seals it with the new key. It refuses when a row's key id matches neither key, skips rows already on the new key (idempotent), writes audit `secrets.app_key.rotate` with actor kind `cli`, and prints no key. At start the server accepts `APP_KEY_PREVIOUS` to open rows still on the previous key and logs a warning until rotation is done. | `server/secrets/rotate.test.ts` (success, injected failure rolls back, wrong previous key, idempotent re-run, mixed key ids, backup exists, audit entry) |
| FR-B-110 | MUST | `dist/cli.js` provides, without a shell: `generate-app-key` (prints 32 random bytes as base64, nothing else), `setup-token` (prints the setup token, creating the file if absent while setup is open; exits 1 with a message when setup is completed), `rotate-app-key`, `hash-password` (reads a password from standard input without echo, prints the break-glass hash of FR-B-521), `setup-reopen --confirm` (FR-B-222) and the existing `verify-audit`. Output goes to standard output; the server logger is never used for secrets. Exit code 0 on success, 1 on a refusal, 2 on bad usage. | `server/cli.test.ts` (spawns the built CLI per command: output shape, exit codes, no extra output), `image` smoke test (commands run under read-only root filesystem, `/data` writable) |
| FR-B-111 | SHOULD | The certificate expiry is visible: Settings, Connection shows days left; a warning banner at 60 days or fewer and a critical one at 14 days or fewer; the start posture logs a warning at 60 days or fewer (no secrets). | `server/connection/cert-expiry.test.ts` (fake clock, boundaries 61, 60, 15, 14, 0, negative), `e2e/connection.spec.ts` |
| FR-B-112 | MUST | One function `signClientAssertion` (in `integrations/identity`) builds every client assertion with `jose`: header `alg` PS256, `typ` JWT, `x5t#S256` = base64url SHA-256 of the DER; claims `aud` `https://login.microsoftonline.com/<tid>/oauth2/v2.0/token`, `iss` = `sub` = client id, unique `jti`, `iat` and `nbf` = now, `exp` = `nbf` + 300 seconds (Learn: at most 10 minutes). It is used directly by the sign-in code exchange (FR-B-403) and handed to MSAL as its `clientAssertion` callback for client-credentials tokens (Learn: the callback runs whenever MSAL needs a token), so there is exactly one implementation. An optional second header `x5t` (SHA-1) can be switched on as the documented fallback if the first real token fails (U21); default off. | `server/auth/client-assertion.test.ts` (verified against the certificate public key; negatives: wrong `alg`, `exp` over 10 minutes, missing `x5t#S256`, reused `jti`), `server/integrations/identity/msal-app-token.test.ts` (MSAL receives the callback, no `clientSecret` anywhere), `shared/single-implementation.test.ts` (no second assertion builder) |

### 6.2 Setup gate and wizard

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-201 | MUST | Setup state is persisted in SQLite and moves only forward: `unconfigured` to `in_progress` (first successful unlock), to `awaiting_first_signin` (wizard finished), to `completed` (first successful sign-in of the designated first Owner). The only way back is the CLI of FR-B-222. While the state is not `completed`, an HTML navigation to any panel page other than `/setup`, `/signin` and static assets is redirected (303) to `/setup`; `/api/v1/me` reports `setup.state`. | `server/setup/state-machine.test.ts` (transition table with forbidden transitions) (+ negative), `e2e/setup-redirect.spec.ts` |
| FR-B-202 | MUST | Setup gate: while the state is not `completed`, every route under `/api/v1/connection/` and every route of the wizard except `GET /api/v1/setup/status` and `POST /api/v1/setup/unlock` requires the setup actor. The setup actor exists only for a valid setup-session cookie obtained through `unlock`. Without it the answer is 401 `unauthenticated` with no tenant id, step state or log line in the body. `status` returns only `{state, tokenRequired}`. | `server/setup/gate.test.ts` (matrix of every setup and connection route times {no cookie, malformed, expired, valid} before and after completion) (+ negative: a route registered without the gate fails the route-table test) |
| FR-B-203 | MUST | Setup token: taken from `SETUP_TOKEN` when set, otherwise from `${DATA_DIR}/setup-token`, created at first start while the state is not `completed` from 32 random bytes (base64url, mode 0600, never overwritten while setup is open). The token is accepted only in the body of `POST /api/v1/setup/unlock`, compared in constant time (SHA-256 digests with `timingSafeEqual`), never read from a query string or header, and never written to logs, audit, problem bodies, the HTML shell or the OpenAPI document. The start log names only the command that prints it. When the state becomes `completed` the file is deleted. | `server/setup/token.test.ts` (sources, permissions, constant-time path, no query parsing), `server/no-leak.test.ts` (token canary in captured logs, audit, responses, shell), `server/cli.test.ts` |
| FR-B-204 | MUST | Brute-force protection: 5 failed unlocks per client address within 15 minutes lock that address for 15 minutes; 30 failures per hour across all addresses lock unlocking for everyone for 15 minutes; both answer 429 `setup_token_locked` with an integer `Retry-After` and refuse a correct token during the lock. A single audit entry `setup.unlock` (outcome `denied`, reason `setup_token_locked`) is written when a lock starts, not per attempt. Counters are in memory and use the injectable clock. | `server/setup/unlock-rate.test.ts` (fake clock; per-address and global; lock expiry; correct token refused while locked; audit written once) |
| FR-B-205 | MUST | The setup session is a random 256-bit id in cookie `setup` (6.9.3), kept in memory with idle 60 minutes and absolute 8 hours (a restart requires the token again). The CSRF binding of the setup actor is the SHA-256 hex of its session id. Setup writes need Origin and CSRF like any write. `DELETE /api/v1/setup/session` ends the session at once and clears the cookie. | `server/setup/session.test.ts` (idle, absolute, restart, cookie attributes, explicit end), `server/csrf.test.ts` (setup binding) |
| FR-B-206 | MUST | When `PUBLIC_BASE_URL` is http (therefore `localhost`), setup routes and `/setup` pages answer 404 to a request whose `Host` is not loopback (`localhost`, `127.0.0.0/8`, `[::1]`) or that carries `Forwarded`, `X-Forwarded-*` or `X-Real-IP`. This prevents accidental exposure over plain http; it is not a security boundary (a non-browser client can forge `Host`), the token is. `docs/security.md` says so. | `server/setup/loopback-guard.test.ts` (Host and header matrix; https base URL not affected) (+ negative: a guard that ignores `Host` fails) |
| FR-B-207 | MUST | Lock: when the state is `completed`, `GET /setup` and `GET /setup/*` answer HTTP 404 (the shell renders Not-found), every setup-only API route answers the standard 404 `not_found` problem, byte-for-byte the body and headers of an unknown path (no distinguishing header, timing aside), no setup actor can be resolved, and no HTTP request can reopen setup. The state, the pinned tenant and all configuration survive a restart. | `server/setup/lock.test.ts` (including a restart on the same database and a comparison with an unknown route), `e2e/setup-lock.spec.ts` |
| FR-B-208 | MUST | Every step and sub-action is idempotent and resumable. Before and after each external call its row (status, attempt, timestamps) is written; at start every `running` row becomes `pending`. A sub-action first reads (stored object id, then discovery per FR-B-304); when the observed state already matches the desired state it makes only read calls. Interrupting the process after any mutating call and restarting converges to the same tenant state and setup state as an uninterrupted run. | `server/setup/idempotency.test.ts` (second run: zero mutating requests recorded by the fake tenant), `server/setup/resume.test.ts` (fault injection after each of the N mutating calls; N derived from the call sheet) |
| FR-B-209 | MUST | At most one step run at a time: an in-process lock plus a lease row (`runner_lease`, heartbeat every 15 seconds, expiry 120 seconds) so a second request, a second browser or a restart race answers 409 `setup_step_busy`. A stale lease is taken over only after expiry. | `server/setup/concurrency.test.ts` (parallel runs, expired lease, crash) |
| FR-B-210 | MUST | Per-step model: status `pending`, `running`, `waiting`, `succeeded`, `warning`, `failed` or `skipped`; attempt count; timestamps; error code from an allow-list; `rollback_hint_key` (a catalogue key whose parameters name the created objects and the manual removal); a `detail` object validated against a secret-free schema (allow-listed keys, strings at most 256 bytes, object ids as GUIDs; any key matching `secret`, `token`, `key`, `password`, `assertion`, `pem` or `credential` case-insensitively is rejected by the writer). No automatic rollback is built; hints only. | `server/setup/step-model.test.ts` (schema, rejected keys, canary), `shared/schemas-setup.test.ts` |
| FR-B-211 | MUST | Live log: rows `{seq, ts, step, level, messageKey, params}` with no translated text and no secrets (same schema rule as FR-B-210), at most 1,000 retained (oldest trimmed), read through `GET /api/v1/connection/log?after=<seq>&limit<=200`. The UI polls every second while a run is active (every 2 seconds in a hidden tab) and renders the lines in a log region. Polling is used instead of server-sent events because intermediaries buffer event streams (B-10). | `server/setup/log.test.ts` (trim, cursor, validation), `web/setup-log.test.tsx`, `e2e/setup-wizard.spec.ts` |
| FR-B-212 | MUST | Retry and backoff. Failures are classified *transient* (429, 503, 504, network), *replication* (404 on an id the wizard just created or received, 400 "source resource object ... don't exist", 401 or 403 from Graph or Exchange inside the propagation window after a grant or role assignment, token endpoint `invalid_client` inside the window after a certificate upload) or *permanent* (everything else, including 400 validation and policy refusals). Transient: `Retry-After` when present else backoff 1 s doubling to 30 s with full jitter, at most 6 tries. Replication: 2 s doubling to 60 s with full jitter; window 300 seconds for object chains (application, service principal, grants) and `SETUP_PROPAGATION_TIMEOUT_SECONDS` (default 900, maximum 3,600) for role-to-token propagation. While retrying the sub-action is `waiting`, every wait is a live log line ("waiting for Microsoft to replicate, n of m"), and a "Retry now" action is always available. Permanent errors are never retried. Every probe requests a fresh token (`skipCache`) because an Entra role is baked into the token (research §4). The schedule is a pure function of attempt number, class and injected random source. | `server/setup/backoff.test.ts` (schedule tables, jitter bounds, caps, window end), `server/setup/replication-retry.test.ts` (fake timers and fake tenant with N failures), `server/setup/propagation-probe.test.ts` (fresh token flag, window, final failure hint) |
| FR-B-213 | MUST | Step 1 environment checks, each `ok`, `warn` or `fail` with a remedy key: `public_base_url` (FR-B-103; fail), `data_dir` (writable database open; fail), `app_key` (FR-B-104 and a seal and open round trip; fail), `node_version` (inside the package `engines` range, constant tested against `package.json`; warn), `network` (any HTTP response, even 401 or 404, from `login.microsoftonline.com` and `graph.microsoft.com` is reachable and a connection error is not; fail; `outlook.office365.com`: warn), `time_skew` (difference between the host clock and the `Date` header of the Entra response: at most 60 s ok, up to 300 s warn, more fail; our thresholds, U35). Any `fail` blocks step 2. Check results are not secrets and are returned only to the setup actor. | `server/setup/environment.test.ts` (each check pass and fail, thresholds at the boundary, host list), `e2e/setup-wizard.spec.ts` |
| FR-B-214 | MUST | Step 2 device-code bootstrap through MSAL Node `PublicClientApplication.acquireTokenByDeviceCode` with client id `BOOTSTRAP_CLIENT_ID` (default `14d82eec-204b-4c2f-b7e8-296a70dab67e`), authority `https://login.microsoftonline.com/<tenant hint or organizations>` (never `common` or `consumers`; a tenant id or domain is required for guest administrators), and **exactly** the scopes `https://graph.microsoft.com/Application.ReadWrite.All`, `https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All`, `https://graph.microsoft.com/RoleManagement.ReadWrite.Directory` (the constant is tested; MSAL adds `openid`, `profile`, `email` and `offline_access` itself and explicit OIDC scopes would fail, research §5.3). No cache plugin is configured. The device code (`user_code`) and the verification link are shown; the link is rendered only for `https` URIs whose host is in an allow-list (`microsoft.com`, `www.microsoft.com`, `login.microsoft.com`, `login.microsoftonline.com`; U43) and with `rel="noopener noreferrer"`; the `message` text from Entra is never rendered. Cancel stops polling (`cancel = true`). The wizard tells the administrator to leave "Consent on behalf of your organization" off (research §5.4). | `server/setup/device-code.test.ts` (MSW and fake timers: pending, declined, expired, bad code, `slow_down` handled as RFC 8628, cancel; exact scope list; link allow-list with `javascript:` and foreign hosts (+ negative); `message` never in a response) |
| FR-B-215 | MUST | Bootstrap token lifetime: access, refresh and ID tokens of the Microsoft client live only in the in-memory MSAL cache of the single bootstrap object. They are never persisted, logged, audited, serialised or returned. The object is discarded and its cache cleared (a) when the delegated audit reads of FR-B-309 are done, which is before the propagation probes, (b) on failure, cancel or timeout, (c) when the setup session expires (idle 60 minutes), (d) at process exit. Only `tid`, `oid`, `preferred_username` (label) and `name` (label) from the ID token claims are kept; GUIDs are validated and strings truncated to 256 bytes. | `server/setup/bootstrap-token-lifecycle.test.ts` (canary access and refresh tokens absent from database files, logs, audit, problem bodies; cache empty after each end condition; no `cachePlugin`), `server/no-leak.test.ts` |
| FR-B-216 | MUST | Tenant pinning: the first bootstrap proposes `tid`; the app-only `GET /organization` (FR-B-309) confirms it (`id` equals the proposed tenant) before it is stored as the pinned tenant. A later bootstrap (repair) must return the same `tid`, otherwise it is rejected (`tenant_mismatch`) and its token discarded. Switching tenants is a new installation on a new volume (documented). The bootstrap identity maps to the first Owner by `oid` plus `tid`, never by `sub` (pairwise per application) or by mutable claims. | `server/setup/tenant-pin.test.ts` (confirm, mismatch, repair with another tenant (+ negative), `sub`-only token rejected) |
| FR-B-217 | MUST | Microsoft error mapping: the wizard and sign-in map the documented codes to distinct messages with a remedy: `AADSTS65001` (not consented), `AADSTS90094` and `AADSTS90093` (administrator approval needed), `AADSTS50105` (assignment required), `AADSTS53003` (blocked by Conditional Access), `AADSTS530036` (refresh token invalid due to authentication-flow checks), `AADSTS700027` (client assertion signature invalid; check the certificate), `invalid_client`, `interaction_required`, `consent_required`, `temporarily_unavailable`. The code is extracted by a strict pattern from `error_description` and only the number is kept; the free text is never shown. An unknown code shows a generic message plus the number. | `server/setup/aadsts-map.test.ts` (one case per code, unknown code, hostile description text) |
| FR-B-218 | SHOULD | Manual provisioning mode, offered when device code is blocked, declined or when the operator chooses it. The wizard generates and seals the certificate, offers the public certificate as a `.cer` download, and shows a checklist generated from the same constants as the automated path (application name, redirect URIs, optional claims, implicit flows off, application permissions with role names, Exchange app roles, Entra role, certificate thumbprints) with the Learn how-to links for the portal tasks (no invented portal steps). The operator enters the application (client) id and the object id or user principal name of the first Owner (a first Owner other than the signed-in bootstrap administrator exists only in this mode, ODB-14). The wizard then runs the app-only checks V1 to V3 and V5 of FR-B-309; V4 and V6 need a delegated read and show `not_checked`. The first Owner id is resolved with the app-only `GET /users/{id or userPrincipalName}`. State records `mode = manual`. | `server/setup/manual-mode.test.ts` (checklist equals the automated request bodies field by field; verification without a bootstrap token; Owner resolution), `e2e/setup-manual.spec.ts` |
| FR-B-219 | MUST | Step 5, finish: (a) optional branding through the Phase A Appearance form (skippable); the proposed organisation name is the tenant display name only while the branding still has the default name; (b) the first Owner assignment for the bootstrap `oid` (role `owner`, source `wizard`) is created if absent, in one transaction with its audit entry; (c) an optional Entra group for role *Beheerder* is chosen by search (app-only, FR-B-311) or entered as an object id validated with `GET /groups/{id}`; no group is created (BCB-01); (d) a default language `nl` or `en` is stored and used by the shell only when the browser has no stored choice and no nl or en preference (additive second argument of `detectLocale`); (e) the bootstrap cache is cleared; (f) the state becomes `awaiting_first_signin` and the page offers "Aanmelden"; (g) the state becomes `completed` exactly when the designated oid signs in successfully (FR-B-403), in the transaction that creates the session, together with audit `setup.complete`, deletion of the token file and a final proof-list snapshot. If the designated user never signs in the state stays open (documented, B-09). | `server/setup/finish.test.ts` (each part, atomicity with injected fault), `server/setup/complete-on-signin.test.ts`, `web/setup-finish.test.tsx`, `e2e/setup-wizard.spec.ts` |
| FR-B-220 | MUST | "Herstel verbinding" in Settings, Connection (permission `settings:connection`, step-up for user actors) re-runs sub-actions: per sub-action and as "repair all". It needs a fresh device-code bootstrap on the pinned tenant (or the manual mode). It converges drift only: redirect URIs after a `PUBLIC_BASE_URL` change, the `amr` and `auth_time` optional claims, missing or extra application permissions (extra roles are reported, forbidden ones fail, nothing is removed automatically), a missing Entra role assignment, and certificate renewal: a new certificate is generated and added to the full existing key-credential list, verified by acquiring an app-only token with it, and only then are expired or retired credentials removed from the application and the old sealed key deleted. No duplicate object may result. | `server/connection/repair.test.ts` (one drift fixture per item; no duplicate; renewal sequence and failure leaving the old certificate active), `e2e/connection-repair.spec.ts` |
| FR-B-221 | MUST | Wizard UI on the Phase A design system: step list (`ol`, `aria-current="step"`) with a progress indicator, per step status with icon and text, rollback hint, live log region (`role="log"`), device-code panel (code shown as text, copy action, link per FR-B-214), environment results, finish summary and proof list. All text from catalogues (nl, en); responsive; respects reduced motion; the wizard never shows a secret and never renders server-supplied free text. | `web/setup-wizard.test.tsx`, `e2e/setup-wizard.spec.ts`, `e2e/a11y.spec.ts`, `e2e/visual.spec.ts` |
| FR-B-222 | SHOULD | `node dist/cli.js setup-reopen --confirm` sets the state to `in_progress`, issues a new setup token file, writes audit `setup.reopen` with actor kind `cli`, and prints the next steps. Existing sessions continue. It is the documented recovery for a changed `PUBLIC_BASE_URL`, an expired certificate and a locked-out panel. Without `--confirm` it only explains. | `server/cli.test.ts` (confirm, refusal without flag, state change, audit) |

#### 6.2.1 Wizard steps and sub-actions (keys used in `setup_step` rows)

| Step | Key | Sub-actions (key) | Mutating calls |
|---|---|---|---|
| 1 | `environment` | `public_base_url`, `data_dir`, `app_key`, `node_version`, `network`, `time_skew` | none |
| 2 | `connect` | `device_code` or `manual_inputs` | none (token acquisition only) |
| 3 | `configure` | `application`, `service_principal`, `certificate`, `application_settings`, `graph_permissions`, `exchange_permissions`, `exchange_role` | POST/PATCH applications, POST servicePrincipals, appRoleAssignedTo, roleAssignments |
| 4 | `verify` | `audit_reads` (V4, V6; bootstrap token), then `app_token` (V1), `organization` (V2), `users` (V3), `exchange_probe` (V5) | none |
| 5 | `finish` | `branding`, `owner`, `beheerder_group`, `language`, `handover` | local database only |

### 6.3 Tenant provisioning and Microsoft clients

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-301 | MUST | The runtime application permission set is the constant `GRAPH_APP_ROLES` in `packages/shared`: `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`, with `permission_set_version` 1. Exchange: `Exchange.ManageAsApp` (required) and `Exchange.ManageAsAppV2` (only when the tenant's Exchange service principal exposes it). The constant `FORBIDDEN_APP_ROLES` (`RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All`, `Application.ReadWrite.All`) must never be granted to the runtime application by any code path or setting; the bootstrap token holds the delegated forms only for the length of the wizard. Reverting to the brief's five (ODB-02) is a change of the constant, the version number, the test and `docs/permissions.md`, followed by a repair run. | `shared/graph-roles.test.ts` (exact set, no overlap with the forbidden list), `server/setup/permission-set.test.ts` (wizard requests exactly the set; a granted forbidden role fails the step) (+ negative), `server/docs-contract.test.ts` (every permission has a reason row in `docs/permissions.md`) |
| FR-B-302 | MUST | Application role ids are resolved at run time from `GET /servicePrincipals?$filter=appId eq '<resource appId>'&$select=id,displayName,appId,appRoles` (Graph `00000003-0000-0000-c000-000000000000`, Exchange `00000002-0000-0ff1-ce00-000000000000`), matching `value`, `allowedMemberTypes` containing `Application` and `isEnabled`. Missing or disabled stops with a named error (`app_role_missing`). The ids in `docs/permissions.md` are fixtures: a difference between lookup and fixture is a warning in the log, never an error, and never a reason to use the fixture. | `server/setup/resolve-app-roles.test.ts` (negatives: missing, disabled, only `User` member type, fixture mismatch warning) |
| FR-B-303 | MUST | Application body: `displayName` (default `M365Portal`, 3 to 64 characters, editable), `description`, `signInAudience: "AzureADMyOrg"` (always explicit, research §2.1), `web.redirectUris` = the two URIs of FR-B-103, `web.implicitGrantSettings` with both flags false, `isFallbackPublicClient: false`, `requiredResourceAccess` with `type: "Role"` entries for the resolved roles, `optionalClaims.idToken` = `amr` and `auth_time` (`essential: false`), `tags` = `m365portal` and `m365portal-install-<install id>`; no `groupMembershipClaims`, no `identifierUris`, no `web.logoutUrl`, no client secret, no wildcard URI. The enterprise application keeps "assignment required" off (panel RBAC is the gate). | `server/setup/provision-app.test.ts` (MSW asserts the body field by field; negatives: wildcard, secret, implicit flag, personal-account audience) |
| FR-B-304 | MUST | Discovery order for idempotence: (1) the stored application object id, `GET /applications/{id}`; (2) `GET /applications?$filter=displayName eq '<name>'&$select=id,appId,displayName,tags`. One match carrying our install tag is adopted; one match without it stops the step and asks the operator, with the explicit confirmation recorded; several matches stop with `application_ambiguous`; none creates. Filter values escape single quotes by doubling. The same rule applies to service principals by `appId`. The `uniqueName` upsert (`Prefer: create-if-missing`) is documented but not used until its permissions are read (U18). | `server/setup/discovery.test.ts` (each branch; injection fixtures such as `'; or 1 eq 1`) |
| FR-B-305 | MUST | Service principal: `GET /servicePrincipals(appId='<appId>')`, else `POST /servicePrincipals` with `{appId}` and replication retry (FR-B-212). The created object is recorded in `setup_object`. | `server/setup/service-principal.test.ts` |
| FR-B-306 | MUST | Certificate upload: `PATCH /applications/{id}` with `keyCredentials` carrying the **complete** intended list (PATCH replaces the collection): the existing entries read with `GET /applications/{id}?$select=keyCredentials` plus the new one `{type: "AsymmetricX509Cert", usage: "Verify", key: <base64 DER>, displayName, startDateTime, endDateTime}` with `endDateTime` at most 360 days after `startDateTime` and **no** `customKeyIdentifier` (Entra derives the SHA-1 thumbprint). `addKey` is not used in Phase B (it needs proof of possession of an existing key; research §2.4). After the PATCH the application is read again and the entry must be present with `customKeyIdentifier` equal to the SHA-1 thumbprint (case-insensitive). A 400 is treated as a possible app-management-policy refusal: the Graph error code and message fields are shown (allow-listed) and a shorter lifetime is offered (EB-10, U19). | `server/setup/certificate-upload.test.ts` (fresh application, application with foreign credentials preserved, idempotent re-run, thumbprint mismatch fails, 400 policy case), `server/setup/certificate.test.ts` (canary private key never in a request body) |
| FR-B-307 | MUST | Graph permissions are granted with `POST /servicePrincipals/{graphSpId}/appRoleAssignedTo` (`principalId` = runtime service principal id, `resourceId` = Graph service principal id, `appRoleId`). Existing grants are read first (`GET /servicePrincipals/{runtimeSpId}/appRoleAssignments`) and only missing ones are granted; a duplicate response counts as success (U31). Extra roles are reported as drift in the proof list; a forbidden role present fails the sub-action `forbidden_permission_present`. | `server/setup/grant-roles.test.ts` (second run makes no POST; duplicate; drift; forbidden role) |
| FR-B-308 | MUST | Exchange: look up the "Office 365 Exchange Online" service principal; when it does not exist the sub-actions `exchange_permissions` and `exchange_role` are `skipped`, `exchange_enabled` is false and nothing first-party is created (research §11). Otherwise grant `Exchange.ManageAsApp` and, when exposed, `Exchange.ManageAsAppV2` as in FR-B-307, and assign the Entra role Exchange Administrator to the runtime service principal with `POST /roleManagement/directory/roleAssignments` (`principalId`, `roleDefinitionId` `29232cdf-9323-42fd-ade2-1d097af3e4de`, `directoryScopeId` `/`), after listing `GET /roleManagement/directory/roleAssignments?$filter=principalId eq '<id>'` to skip an existing one (filter support U31). The role id is a setting `exchange_role` (default Exchange Administrator) so a narrower role can be tried without code (research §16). The custom Exchange role group is documented as follow-up. | `server/setup/exchange-role.test.ts` (present, absent, V2 not exposed, already assigned, wrong role present), `server/setup/assign-exchange-role.test.ts` (body and idempotence) |
| FR-B-309 | MUST | Verification (step 4). **Delegated, while the bootstrap token lives:** V4 reads the application, service principal, key credentials, app role assignments and Entra role assignment and compares them with the desired state; V6 confirms `optionalClaims.idToken` holds `amr` and `auth_time`; then the bootstrap object is discarded (FR-B-215). **App-only, new token each attempt:** V1 acquires a Graph token with the certificate (replication retry); V2 `GET /organization` returns one item whose `id` equals the proposed tenant (stores display name and the domain with `isInitial` from `verifiedDomains`); V3 `GET /users?$top=1&$select=id`; V5 Exchange Admin API `Get-OrganizationConfig` (FR-B-314). V1 to V4 failing means `failed`; V5 and V6 failing mean `warning` (the preview API is "not available in all organizations"; whether V5 stays at all is ODB-13). Results (at most 50 KB) are stored and shown as a proof list: application name and id, service principal, certificate thumbprint and expiry, granted roles by name, Exchange Administrator assignment, each check with time. Re-running verification from Settings runs the app-only checks; the delegated ones need a fresh bootstrap. | `server/setup/verify.test.ts` (each check pass and fail, warning rules, ordering, proof list content), `server/setup/verify-credential.test.ts` (read-back before token, research R-08) |
| FR-B-310 | MUST | Delegated provisioning calls live behind interface `TenantProvisioner` that takes a `BearerTokenProvider` and exposes only the calls of the call sheet (find, create and patch application, service principal create and find, key credential read, app role assignment list and grant, directory role assignment list and create, application and service principal lookups by `appId`). No `TenantProvisioner` can be built without a live bootstrap session; it does not exist after the wizard. The app-only `GraphClient` has no provisioning methods. | `server/layering.test.ts`, `server/integrations/graph/provisioner.test.ts` (MSW: paths, bodies, headers) |
| FR-B-311 | MUST | Interface `GraphClient` (app-only, runtime) with methods `getOrganization`, `probeUsers`, `getUser(idOrUpn)` (`id`, `displayName`, `userPrincipalName`, `mail`, `department`, `accountEnabled`), `checkMemberGroups(userId, groupIds)`, `searchGroups(prefix, top)`, `getGroup(id)`; implemented by `HttpGraphClient` on `GraphHttp` with MSAL client-credentials tokens (scope `https://graph.microsoft.com/.default`, assertion callback of FR-B-112). `checkMemberGroups` calls `POST /users/{id}/checkMemberGroups`, never `/directoryObjects/{id}/checkMemberGroups` (that form lists `Directory.Read.All` as the least privilege for application permissions), sends at most 20 ids per call and validates every id as a GUID first (one malformed id fails the whole request on Graph). User group display in later phases uses `transitiveMemberOf`, not `memberOf` (application permission `Directory.Read.All` only). Group search uses `$filter` on `displayName` with `startswith` and escaped values (U37). | `server/integrations/graph/graph-client.test.ts` (paths, bodies, chunking at 20 and 21, GUID validation (+ negative), escaping), `server/integrations/graph/graph-client.contract.test.ts` (same suite against `HttpGraphClient` on MSW and `FakeGraphClient`), `server/integrations/graph/permissions-map.test.ts` (each method lists the Learn permission it relies on and that permission is in `GRAPH_APP_ROLES`) |
| FR-B-312 | MUST | `GraphHttp` retry policy: 429 waits `Retry-After` (seconds or an HTTP date) plus 0 to 20 % jitter, at most 60 s per wait, and a longer value fails fast with `graph_throttled` carrying the value; at most 4 retries; 503 and 504 retry with backoff 500 ms doubling to 10 s with full jitter, at most 4 retries, for GET, HEAD, PUT, DELETE and for POST calls the caller marks idempotent, on a fresh connection; 400, 401, 403, 404 and 409 never retry; a call budget of 20 s interactive and 60 s for wizard calls; at most 4 calls in flight; header `x-ms-throttle-priority: high` for user-initiated calls and `low` for background refreshes; errors are typed (`GraphThrottledError`, `GraphForbiddenError`, `GraphNotFoundError`, `GraphConflictError`, `GraphTransientError`, `GraphBadRequestError`, `GraphUnauthorizedError`, `GraphNetworkError`) and never contain a token. | `server/integrations/graph/http-retry.test.ts` (fake timers; both `Retry-After` forms; jitter bounds; budgets; no retry on non-idempotent POST 503; priority header; token redaction) |
| FR-B-313 | MUST | Short-TTL cache for Graph GET results: organization 300 s, user 60 s, group 60 s; LRU of at most 1,000 entries keyed by method, path and query; errors are never cached; `checkMemberGroups` is never cached here (the RBAC cache of FR-B-507 owns it). | `server/integrations/graph/cache.test.ts` (TTL boundaries with fake clock, LRU, error not cached) |
| FR-B-314 | MUST | Interface `ExchangeClient` with `capabilities()`, `probe()` (the result of `Get-OrganizationConfig`: reachable, role effective or not, preview available or not), `getOrganizationConfig(select)` and `listDistributionGroupMembers(identity, options)`. `AdminApiExchangeClient` uses `POST https://outlook.office365.com/adminapi/v2.0/<tid>/<Endpoint>` with body `{"CmdletInput":{"CmdletName":...,"Parameters":...}}`, mandatory `X-AnchorMailbox: APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tid>`, scope `https://outlook.office365.com/.default`, the app-only token of FR-B-112 (the token is treated as opaque: never decoded), paging through `@odata.nextLink` finished within 5 minutes (the link is valid 5 to 10 minutes), `ResultSize` at most 1,000, `Retry-After` honoured on 429 and 401, 403 and 400 mapped to typed errors. `capabilities()` reports `{read: ['organizationConfig','distributionGroupMembers'], write: []}`. The Phase D operations are not on the interface yet; a call to anything else throws `ExchangeUnsupportedError`. The repository contains no `InvokeCommand`, no `pwsh` and no undocumented endpoint (the decision is ODB-01). `FakeExchangeClient` implements the same interface; one contract suite runs against both so the Phase D adapter plugs into it. | `server/exchange/exchange-client-contract.test.ts` (adapter on MSW with `onUnhandledFrame: 'error'`: method, URL pattern, headers, envelope, paging, errors; and the fake), `server/integrations/exchange/admin-api.test.ts`, `server/integrations/exchange/no-undocumented.test.ts` (source scan for `InvokeCommand`, `pwsh`, `powershell` outside `docs/` and ADRs) (+ negative) |
| FR-B-315 | MUST | Layering: only `apps/server/src/integrations/**` and `apps/server/src/secrets/**` may import `undici`, `node:http`, `node:https`, `@azure/msal-node`, `jose`, `libsodium-wrappers`, the X.509 library, or call `fetch`. Services, routes and repositories depend on interfaces (`GraphClient`, `TenantProvisioner`, `ExchangeClient`, `IdentityProvider`, `SecretStore`). | `quality` (ESLint `no-restricted-imports` and `no-restricted-globals`), `server/layering.test.ts` (import graph scan, fixture file that violates the rule must fail) (+ negative) |
| FR-B-316 | MUST | Probes and token acquisition for propagation use a fresh token (`skipCache: true`) and make one cheap real call; no code decodes or validates an access token issued for Graph or Exchange (Learn: do not read tokens of APIs you do not own); `decodeJwt` is allowed only on ID tokens in `integrations/identity`. | `server/setup/propagation-probe.test.ts` (flag asserted), `quality` (lint rule `no-decode-microsoft-tokens`), `server/layering.test.ts` |

#### 6.3.1 Call sheet (mutating calls, in order)

| # | Call | Token | Sub-action |
|---|---|---|---|
| 1 | `GET /servicePrincipals?$filter=appId eq '<Graph>'` and `... '<Exchange>'` | delegated | `application` |
| 2 | `GET /applications/{id}` or `GET /applications?$filter=...`, then `POST /applications` | delegated | `application` |
| 3 | `GET /servicePrincipals(appId='...')`, then `POST /servicePrincipals` | delegated | `service_principal` |
| 4 | `GET /applications/{id}?$select=keyCredentials`, then `PATCH /applications/{id}` | delegated | `certificate` |
| 5 | `PATCH /applications/{id}` (redirect URIs, optional claims, resource access) when drifted | delegated | `application_settings` |
| 6 | `GET /servicePrincipals/{id}/appRoleAssignments`, then up to 4 `POST .../appRoleAssignedTo` on Graph | delegated | `graph_permissions` |
| 7 | up to 2 `POST .../appRoleAssignedTo` on Exchange | delegated | `exchange_permissions` |
| 8 | `GET` then `POST /roleManagement/directory/roleAssignments` | delegated | `exchange_role` |
| 9 | audit reads, then discard the bootstrap token | delegated | `verify` |
| 10 | token, `GET /organization`, `GET /users?$top=1`, Exchange probe | app-only | `verify` |

The maximum number of mutating calls in one clean run is 1 + 1 + 1 + 1 + 4 + 2 + 1 = 11 (application, service principal, certificate PATCH, optional PATCH, Graph grants, Exchange grants, role assignment); `server/setup/resume.test.ts` derives its fault-injection points from the fake tenant's record of mutating calls, not from this number.

### 6.4 Sign-in and sessions

The browser-facing sign-in endpoints live at the root, like the other browser resources of Phase A (`/healthz`, `/manifest.webmanifest`): `GET /auth/login`, `GET /auth/callback`, `GET /auth/logged-out`. JSON actions live under `/api/v1/auth/`.

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-401 | MUST | Cookies follow table 6.9.3: session cookie `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, no `Max-Age` (a browser session cookie; the server enforces the timeouts); OIDC transaction cookie `SameSite=Lax`, `Max-Age=600`; setup cookie `SameSite=Strict`. When `PUBLIC_BASE_URL` is https the names carry the `__Host-` prefix and `Secure`; on `http://localhost` the names are plain and `Secure` is omitted (BC-03, B-07). Cookie names and attributes are produced by one function in `packages/shared`. Deleting a cookie repeats its attributes with `Max-Age=0`. Values are 256-bit random ids. | `server/auth/cookies.test.ts` (attribute matrix for https and localhost, deletion, no `Domain`), `shared/cookie-names.test.ts` |
| FR-B-402 | MUST | `GET /auth/login?returnTo=&prompt=&purpose=` creates a login transaction in memory: transaction id, `state`, `nonce` (each 32 random bytes, base64url), PKCE `code_verifier` (32 random bytes, 43 characters), purpose (`signin` or `stepup`), sanitised `returnTo`, start time, and for step-up the hash of the current session id. Limits: 1,000 pending in total, 20 per client address (oldest evicted), lifetime 600 s. It answers 303 to `https://login.microsoftonline.com/<pinned tid>/oauth2/v2.0/authorize` with exactly `client_id`, `response_type=code`, `redirect_uri` (FR-B-103), `response_mode=query`, `scope=openid profile` (no `offline_access`; research §6.1), `state`, `nonce`, `code_challenge` (S256 only), `code_challenge_method=S256` and optionally `prompt` (`login` for step-up and "sign in again", `select_account` for another account; any other value is dropped). No `max_age`, no `claims` (U13, U27). `returnTo` must start with a single `/`, contain no `//`, `\`, control character or scheme, be at most 256 characters and not begin with `/api/` or `/setup`; otherwise `/`. While the state is not past `in_progress` with a stored tenant connection, or while secrets are unavailable, it answers 409 `setup_required` or 503 `secrets_unavailable` as a redirect to `/signin?error=...`. | `server/auth/authorize-request.test.ts` (parameter list exact, entropy, caps and eviction, lifetime), `server/auth/return-to.test.ts` (attack list, F-43 variants) (+ negative), `shared/return-to.test.ts` |
| FR-B-403 | MUST | `GET /auth/callback` processes in this order and stops at the first failure with a 303 to `/signin?error=<allow-listed code>` (or `/no-access?reason=no_role&ref=<request id>`), `Cache-Control: no-store`: (1) rate limit class `auth`; (2) the transaction cookie must name a live transaction, else `cookies_missing_or_expired` (not audited); (3) the transaction is deleted (single use) and the cookie cleared; (4) `state` equals the stored value (constant time); (5) an `error` parameter is mapped through the allow-list of FR-B-217; (6) the code is exchanged at `POST https://login.microsoftonline.com/<tid>/oauth2/v2.0/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `client_id`, the assertion of FR-B-112 and `scope=openid profile`, timeout 10 s, one retry after 1 s on `temporarily_unavailable`, and no `Origin` header (Learn rejects credentials in the presence of one); (7) the `id_token` is validated (FR-B-404); (8) the MFA policy (FR-B-405); (9) principal and permissions are resolved (FR-B-406, FR-B-507) and an empty result is `no_role`; (10) the session is created (FR-B-407) and, when the state is `awaiting_first_signin` and the `oid` is the designated Owner, setup completes (FR-B-219); (11) the interstitial of FR-B-412 is returned. The query string (`code`, `state`) is never logged. Failures before step 7 are not audited (unauthenticated and attacker-reachable, B-24); failures from step 7 on are audited as `auth.signin` with a reason. The sign-in error page offers "Sign in again" (`prompt=login`) and "Use another account" (`prompt=select_account`); neither repeats automatically. | `server/auth/callback.test.ts` (matrix F-01 to F-45 of Appendix C with expected redirect, audit and session outcome), `server/auth/replay.test.ts`, `server/no-leak.test.ts` (code, state, id_token canaries) |
| FR-B-404 | MUST | ID-token validation with `jose` against the keys of `https://login.microsoftonline.com/<pinned tid>/discovery/v2.0/keys` (found through the tenant discovery document): `alg` in `["RS256"]` (U33); the `kid` must match a key; `iss` equals `https://login.microsoftonline.com/<pinned tid>/v2.0` exactly; `tid` equals the pinned tenant; `aud` equals the client id and is a string; `nonce` equals the stored value; `exp`, `nbf` and `iat` with a 60 s tolerance (Learn names none, U33); `ver` equals `2.0`; `oid` is a GUID; the token is at most 8 KiB; `jku`, `x5u`, `jwk` and `crit` headers are refused. Keys are cached per tenant by `kid` with a 24 h lifetime, refreshed hourly, and refetched on an unknown `kid` at most every 5 minutes (signing-key rollover guidance; the `jose` option names are checked against the pinned 6.2.12, U40). The discovery and key documents are fetched only from `login.microsoftonline.com`. | `server/integrations/identity/id-token.test.ts` (fixtures F-02 to F-27 signed by the fake provider and by attacker keys), `server/auth/jwks-cache.test.ts` (fake clock: TTL, hourly refresh, unknown `kid` cooldown, rotation, cold start with the endpoint down fails closed), `server/fakes/fake-tenant.selftest.test.ts` |
| FR-B-405 | MUST | MFA policy: with `AUTH_REQUIRE_MFA=true` (default) the `amr` claim must be present as an array (else `amr_missing`) and contain at least one value of `AUTH_MFA_AMR_VALUES` (default `mfa`, `multipleauthn`; else `mfa_required`). Learn's OIDC table lists `mfa` for Authenticator push, TOTP, hardware OATH, phone sign-in, SMS, phone call, email, FIDO2 and passkeys, Windows Hello for Business, multi-factor certificate-based sign-in and Temporary Access Pass, so passwordless methods pass exactly when Entra says MFA was completed; `pwd`, `wia`, `x509`, `ngcmfa` or `otp` alone never pass. `amr` is requested as an optional claim by the wizard (FR-B-303). The function is `evaluateAmr(claim, accepted)` in `packages/shared`. Break-glass is exempt. The session records `mfa` and the (truncated) `amr` list. | `server/auth/mfa-check.test.ts` (one row per method of the Learn table, plus absent, empty, string instead of array, case variants, `ngcmfa` alone), `shared/amr.test.ts`, `server/auth/mfa-config.test.ts` |
| FR-B-406 | MUST | The principal key is `(tid, oid)`; `tid` must equal the pinned tenant. `sub`, `email`, `preferred_username`, `upn` and `name` are labels only, never select or authorise a user. `app_user` is upserted (labels and last sign-in). | `server/auth/identity-key.test.ts` (two tokens with the same e-mail and different `oid`; a user whose UPN equals another's old UPN gets nothing), `server/auth/principal.test.ts` |
| FR-B-407 | MUST | Sessions live in SQLite. The cookie holds a 256-bit random id; only its SHA-256 (hex) is stored, as the primary key. A new id is issued at every sign-in and at step-up; a pre-existing id is never reused. Idle timeout `SESSION_IDLE_TIMEOUT_MINUTES` (default 30) slides, with store updates at most once per 60 s; absolute timeout `SESSION_ABSOLUTE_TIMEOUT_HOURS` (default 8) is never extended by rotation. At most 10 sessions per principal (oldest evicted). Expired rows are purged hourly. Row content: principal, kind (`user`, `break_glass`), timestamps, `mfa`, `authenticated_at`, `step_up_at`, `groups_stale`; no IP address, no user agent. | `server/auth/session-store.test.ts` (database scan finds no raw id; idle and absolute with fake clock; write throttling; eviction; purge), `server/auth/rotation.test.ts` |
| FR-B-408 | MUST | CSRF is bound to the session: `GET /api/v1/csrf` returns a token whose `binding` is the SHA-256 hex of the session id (the setup session id for the setup actor, empty for anonymous). A token for another binding fails with `csrf_invalid`; after rotation the old token fails and the client fetches a new one once (E-09). The unauthenticated login routes need no CSRF (GET, no state change except the transaction); `POST /api/v1/auth/*` need Origin and CSRF. | `server/csrf.test.ts` (binding matrix: anonymous, user, setup, rotated, other user's token), `e2e/signin.spec.ts` |
| FR-B-409 | MUST | Revalidation: after `GROUP_CACHE_TTL_SECONDS` (default 300) the next request of a session refreshes, single-flight per principal, (a) the group memberships (FR-B-507) and (b) `GET /users/{oid}?$select=id,accountEnabled`. A 404 or `accountEnabled=false` revokes the session (audit `auth.session.revoked`, reason `account_disabled`) and the request answers 401 `unauthenticated`. On a Graph failure direct assignments keep applying, group-derived grants are dropped once the TTL has passed, `groups_stale` is set (the UI shows a notice), and the refresh is retried no more often than every 30 s. | `server/auth/revalidate.test.ts` (fake clock; disabled, deleted, failure, recovery, single flight) |
| FR-B-410 | MUST | Sign-out: `POST /api/v1/auth/logout` deletes the current session first and clears the cookie, then returns `{redirect}` with the Entra `end_session_endpoint` of the pinned tenant and `post_logout_redirect_uri` = `<origin>/auth/logged-out` (a registered redirect URI; Learn requires one); `GET /auth/logged-out` answers 303 to `/signin?signedout=1`. `POST /api/v1/auth/logout-all` deletes every session of the principal (not of other principals) and then does the same. Front-channel and back-channel logout are not supported and `web.logoutUrl` stays unset (a cross-site GET cannot carry the Strict cookie, so it could not name the session, and an unauthenticated session-ending GET is a logout-CSRF primitive; research §6.6, U29). | `server/auth/logout.test.ts` (order, scope of logout-all, registered URI), `e2e/auth-logout.spec.ts` |
| FR-B-411 | MUST | Step-up: a route with `access: { permission, stepUp: true }` requires `session.step_up_at` within `STEP_UP_WINDOW` (10 minutes) for user actors, else 403 `step_up_required` (audited). The flow is `GET /auth/login?purpose=stepup` (needs a session): `prompt=login`; the callback requires the same `oid`, an `auth_time` claim present and not earlier than the transaction start minus 60 s, and the MFA policy again; then the session id is rotated and `step_up_at` set. `max_age` is not sent and `claims` is not used (U13, U27). If the tenant never asks for MFA the step-up fails with the explicit reason `mfa_required`, never a loop. The setup actor and break-glass are exempt. | `server/auth/step-up.test.ts` (other oid, stale `auth_time`, missing `auth_time`, no MFA, window boundary), `server/route-table.test.ts` (`x-step-up` in OpenAPI), `e2e/stepup.spec.ts` |
| FR-B-412 | MUST | A successful callback answers 200 `text/html` (header profile html with a nonce) holding `<meta http-equiv="refresh" content="0;url=<sanitised returnTo>">` and a visible link, never a 303. A redirect chain started by a cross-site navigation may withhold `SameSite=Strict` cookies from the follow-up request (browser behaviour, not a Microsoft claim, U39); the interstitial makes the next navigation same-site so the first paint carries the session and the boot data shows the signed-in actor. | `server/auth/interstitial.test.ts` (status, markup, escaping; a 303 fails) (+ negative), `e2e/signin.spec.ts` (first paint shows the signed-in persona without a refetch) |
| FR-B-413 | MUST | `GET /api/v1/me` and the embedded boot data return: `actor {kind: anonymous, user, setup or break_glass; id; label}`, `permissions` (held anywhere), `roles [{key}]`, `session {expiresAt, idleExpiresAt, mfa, stepUpValidUntil, groupsStale}` or null, `setup {state}`, `publicOrigin`, `version`, `storageAvailable`, `features {showcase}`. No `preview`. The actor is resolved from the cookie only; nothing in the request selects it. | `shared/schemas-meta.test.ts`, `server/policy.test.ts` |
| FR-B-414 | MUST | A request without a valid session to a route that needs a permission or `authenticated` answers 401 `unauthenticated` with `WWW-Authenticate: Cookie realm="m365portal"` (RFC 9110 expects a challenge with a 401; the scheme token is ours, U42); an expired or unknown session cookie answers 401 `session_expired` and clears the cookie; an authenticated actor lacking the permission answers 403 `permission_denied`. Phase A's 403 for anonymous writes (A-29) is replaced. | `server/policy.test.ts` (table over the route table: anonymous 401, expired 401, user without permission 403), `server/api-conventions.test.ts` |
| FR-B-415 | MUST | Rate-limit classes `auth` (capacity 10, refill 0.2 per second per client: `/auth/login`, `/auth/callback`, `/auth/logged-out`, `/api/v1/auth/*`) and `setup` (capacity 10, refill 0.2 per second: `status`, `unlock`) are added; `read` and `write` apply to the rest as in Phase A. 429 responses are not audited. | `server/rate-limit.test.ts` |
| FR-B-416 | MUST | Timing adjustable (WCAG 2.2.1): the web app shows a dialog two minutes before idle expiry with "Sessie verlengen" (a call to `/api/v1/me` slides the session), and a notice five minutes before the absolute expiry; at expiry the app shows the sign-in page with `returnTo`. | `web/session-timeout.test.tsx` (fake timers), `e2e/session-timeout.spec.ts` (Playwright clock) |
| FR-B-417 | MUST | Every response of `/auth/*`, `/api/v1/auth/*`, `/api/v1/setup/*`, `/api/v1/connection/*`, `/api/v1/me` and the shell HTML is `Cache-Control: no-store`; `Set-Cookie` appears only on responses that set or clear a session, transaction or setup cookie. The service worker never caches these routes or navigations to `/signin` and `/setup` (allow-list routing). | `server/auth/headers.test.ts`, `server/cache-headers.test.ts`, `web/sw-routing.test.ts` (hostile URL table extended) |
| FR-B-418 | MUST | The sign-in path keeps no token: the token response's `access_token` is discarded unread, no refresh token exists (`offline_access` is not requested), and the ID token is not stored; only the claims listed in FR-B-406 and the session row survive. MSAL is not used for this path (it adds `offline_access`, `openid`, `profile`, `email` and caches per account; research §5.3). | `server/auth/no-token-retained.test.ts` (database and memory scan for token canaries after 200 sign-ins) |
| FR-B-419 | SHOULD | When the callback reports `consent_required`, `AADSTS65001`, `AADSTS90093` or `AADSTS90094`, the sign-in error page shows an administrator the tenant-wide consent link `https://login.microsoftonline.com/<tid>/v2.0/adminconsent?client_id=<appId>&scope=openid%20profile&redirect_uri=<registered callback>` (pattern from Learn's add-in consent page; effect for OIDC-only scopes UNVERIFIED, U30). | `server/auth/consent-link.test.ts` (link construction, registered URI only, no link for other errors); effect owner-verified OV-12 |

### 6.5 RBAC foundation and the policy layer

#### 6.5.1 Model

- **Resource types and permissions.** `user` (`users:read`), `group` (`groups:read`, `groups:members:write`), `distributionList` (`distributionlists:read`, `distributionlists:members:write`, `distributionlists:export`), `contact` (`contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete`). `audit:read`, `audit:export`, `settings:branding`, `settings:connection` and `rbac:manage` have no resource type: they are *global-only*.
- **Scope item** `{target, match}`: `target` is a resource type; `match` is `{by: 'id', id}` (GUID, for group, distributionList and contact), `{by: 'prefix', attr, value}` (`attr` one of `displayName`, `alias`, `mail`; value 1 to 64 characters, NFC, compared case-insensitively with `startsWith`) or `{by: 'department', value}` (for user and contact). A resource attribute that is missing never matches (fail closed).
- **Qualifier** `basic` on `users:read`: only `id`, `displayName` and `mail` may be returned. It is data on the role permission, not a 16th permission, because the permission catalogue is exactly the brief's 15 (FR-A-030).
- **Assignment** `{principal (user oid or Entra group id), role, scope items (none = unscoped), expiresAt (optional)}`.

#### 6.5.2 Effective permissions and `authorize`

For a user `oid` with the set `G` of bound groups the user belongs to (from the cache of FR-B-507) and the current time `now`:

1. Active assignments are those whose principal is `oid` or a member of `G` and whose expiry is empty or later than `now`.
2. For each active assignment `A` and each `(permission p, qualifier q)` of its role: if `p` is global-only, the grant `(p, q, ALL)` exists only when `A` has **no** scope items; otherwise (resource type `T`) the grant is `(p, q, scopes)` where `scopes` are the scope items of `A` whose target is `T`, or `ALL` when `A` has none for `T` (*scopes restrict only the resource types they name*; B-11, BCB-09).
3. Grants for the same permission merge: scopes are unioned (`ALL` absorbs the rest); the qualifier stays `basic` only if every contributing grant is `basic`.
4. `authorize(actor, p, resource?)`: no grant for `p` gives `permission_missing`; without `resource` it allows when any grant exists (the route-level gate); with `resource` (whose type must equal the type of `p`) it allows when a grant has `ALL` or an item that matches, else `scope_mismatch`. `visibleScopes(actor, p)` returns `none`, `all` or the union of items; lists, search, bulk actions, exports and the command palette MUST use it. Creation checks the proposed attributes against the items (an id item can never match a new object).
5. A scoped assignment never contributes global-only permissions.

#### 6.5.3 Covering and escalation

`canGrant(actor, role, scopeItems)` holds when, for every `(p, q)` of the role: the actor has a grant for `p` whose qualifier covers `q` (full covers `basic`, not the reverse) and whose scopes cover the target scopes (for a global-only `p` the target assignment must then be unscoped and the actor's grant `ALL`). An item covers another when it equals it, or when both are prefix items on the same attribute and the target value starts with the actor's value; `ALL` covers everything; an actor with filter scopes never covers an id item. Property: if `canGrant` holds, every resource the target is allowed on for `p` is a resource the actor is allowed on for `p`.

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-501 | MUST | Tables per Appendix B. The five built-in roles `owner`, `admin`, `operator`, `helpdesk`, `reader` are rows inserted by migration `0001`; SQL triggers abort any `UPDATE` or `DELETE` of a built-in `rbac_role` row and any `INSERT`, `UPDATE` or `DELETE` of its `rbac_role_permission` rows. The constant `BUILTIN_ROLES` in `packages/shared` equals the database rows (a change needs a new migration and an ADR). Role keys are English; display names come from the catalogue (nl: Eigenaar, Beheerder, Operator, Helpdesk, Lezer). | `server/rbac/builtin-roles.test.ts` (database equals constant; raw SQL attempts fail; custom role fixtures remain editable), `server/migrations.upgrade.test.ts` |
| FR-B-502 | MUST | The built-in matrix of table 6.9.4 is normative and identical in `docs/permissions.md`. Properties asserted: *Eigenaar* holds all 15; *Lezer* holds no write permission (nothing ending in `:write`, `:create`, `:update`, `:delete`, no `export`, no `settings:*`, no `audit:*`, no `rbac:manage`); *Helpdesk* adds only `groups:members:write` and `distributionlists:members:write` to *Lezer*; *Operator* has no `settings:*`, `audit:*`, `rbac:manage` and no export; *Beheerder* lacks exactly `rbac:manage` and `settings:connection`. | `shared/rbac-matrix.test.ts`, `server/docs-contract.test.ts` |
| FR-B-503 | MUST | The template *Bestuur* is data in `rbac_role_template`: `contacts:create`, `contacts:read`, `distributionlists:read`, `distributionlists:members:write`, `users:read` with qualifier `basic`, suggested scope target `distributionList`. A template is not assignable; Phase D instantiates it as a custom role. | `server/rbac/templates.test.ts` |
| FR-B-504 | MUST | Effective permissions per 6.5.2 are one pure function `computeGrants` in `packages/shared`, together with `covers`, `matchScope` and `projectUser`; the server and (in Phase D) the web "view as" use it. | `shared/rbac-effective.test.ts` (matrix 15 permissions x 5 roles x {unscoped, scoped in, scoped out, expired, group-derived}; seeded random property test of at least 20,000 cases printing the seed on failure), `shared/single-implementation.test.ts` |
| FR-B-505 | MUST | Policy API `authorize`, `visibleScopes`, `canGrant` in `apps/server/src/policy`. Route access may declare `scoped: ResourceType`; the wrapper then tracks whether the handler called `ctx.authorizeResource` or `ctx.visibleScopes`, and a 2xx response without either becomes 500 `policy_not_applied`, audited as `error` (fail closed). The route-table test fails when a route whose permission has a resource type declares neither `scoped` nor `unscopedReason`. | `server/policy-matrix.test.ts` (15 permissions x all actor kinds x resources), `server/policy-scoped-routes.test.ts` (test-only module registers routes; a forgetful handler yields 500) (+ negative), `server/route-table.test.ts` |
| FR-B-506 | MUST | Default no access: a principal without an active grant gets no session (`no_role`, audit `auth.signin` denied); `anonymous` holds nothing; an actor never holds a permission by Entra role. | `server/rbac/default-deny.test.ts`, `e2e/signin.spec.ts` (Global Administrator without a role, fixture claim `wids`-like data is ignored) |
| FR-B-507 | MUST | Group principals: the set of distinct bound Entra group ids (at most 200) is resolved with `GraphClient.checkMemberGroups(oid, ids)` in chunks of 20 at every sign-in and at every TTL expiry; results go to `rbac_group_member_cache(user_oid, group_id, resolved_at)` with `app_user.groups_resolved_at`; creating or deleting a group assignment clears the cache. The token's `groups`, `_claim_names`, `_claim_sources` and `hasgroups` are ignored and never fetched (overage cannot matter; Learn's JWT limit is 200 groups). Hidden-membership and deleted groups never match; `Member.Read.Hidden` is not requested. A chunk that Graph rejects with 400 is bisected (at most 5 extra calls per bad id and at most 5 bad ids per refresh) so one unknown or deleted group id cannot hide the others; the ids found unresolvable are remembered for the TTL, listed as `unresolvable` in `GET /api/v1/rbac/assignments`, and logged as `membership_refresh_failed` without ids (U38). | `server/rbac/membership.test.ts` (chunks at 20, 21 and 45; nested via fake transitive semantics; hidden omitted; cache TTL; invalidation; a fake Graph that rejects any chunk containing a given id: the other ids still resolve, bisection bounds hold), `server/rbac/overage.test.ts` (token with `_claim_names`, `hasgroups`, and 250 `groups` entries ignored) |
| FR-B-508 | MUST | Assignment API (permission `rbac:manage`; `stepUp` for user actors on `POST` and `DELETE` only, reads need none): `GET /api/v1/rbac/roles`, `GET /api/v1/rbac/assignments`, `POST /api/v1/rbac/assignments`, `DELETE /api/v1/rbac/assignments/{id}`, `GET /api/v1/rbac/effective?principal=`; and for any signed-in actor `GET /api/v1/me/access`. Validation: the role exists and is assignable; a user principal exists (`GET /users/{id}`) and a group principal exists (`getGroup`), else 422 `principal_unknown` (503 when Graph is down); `expiresAt` in the future and at most 730 days ahead; at most 50 scope items and every item's target is used by the role (a scope that changes nothing is `assignment_invalid`); the `owner` role takes no scope and no expiry; a duplicate (principal, role, scope set) is 409 `assignment_exists`; limits: 5,000 assignments, 100 roles. | `server/rbac/assignments-api.test.ts`, `server/rbac/validation.test.ts` |
| FR-B-509 | MUST | No privilege escalation: creating or deleting an assignment requires `canGrant(actor, role, scopeItems)`; otherwise 403 `escalation_denied`, audited as denied with reason. | `server/rbac/escalation.test.ts` (matrix including a custom-role fixture holding `rbac:manage`), `shared/rbac-covers.property.test.ts` (seeded, at least 20,000 cases: `canGrant` implies target rights are a subset) (+ negative: a deliberately broken `covers` fails) |
| FR-B-510 | MUST | Last Owner: the last assignment of role `owner` to a user principal cannot be deleted or changed (409 `last_owner_protected`); the check and the change run in `BEGIN IMMEDIATE`, and a SQL trigger aborts a delete or update that would leave none. Owner assignments to groups do not count. | `server/rbac/last-owner.test.ts`, `server/rbac/last-owner.concurrency.test.ts` (two owners remove each other in parallel: exactly one remains), `server/migrations.upgrade.test.ts` (trigger present) |
| FR-B-511 | MUST | Every mutation of roles, role permissions, assignments or assignment scopes increments `rbac_epoch` in the same transaction; SQL triggers do the increment so a change that bypasses the repository code cannot skip it (Appendix B). Grants are memoised per (principal, epoch, groups resolved at, earliest expiry); a revocation is effective for the next request, and an assignment expiring mid-session removes its rights at the expiry instant. | `server/rbac/epoch.test.ts` (raw SQL insert, update and delete on each of the four tables bump the epoch; a stale memo is never served), `server/rbac/expiry.test.ts` (fake clock) |
| FR-B-512 | MUST | The qualifier `basic` is applied by `projectUser` (one function in `packages/shared`): a response for a `basic` grant contains only `id`, `displayName` and `mail`; a full grant wins when both exist. | `shared/rbac-qualifier.test.ts` |
| FR-B-513 | MUST | Scope items are normalised and validated by one module: GUIDs lower-cased, prefix and department values NFC-normalised, trimmed, 1 to 64 characters, no control, bidi or default-ignorable characters (the organisation-name rejection set), `attr` allow-listed per target. | `shared/rbac-scope.test.ts` (matching table including case and Unicode, rejected inputs), `shared/single-implementation.test.ts` |
| FR-B-514 | SHOULD | "Mijn toegang" (Settings) lists the signed-in user's roles, whether each came directly or through which group, scopes in words, expiry and the effective permissions; it is read-only. | `web/access-page.test.tsx`, `e2e/access.spec.ts` |

#### 6.5.4 Break-glass

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-521 | MUST | Optional account from `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` (format `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`; no `$`, so Compose does not interpolate it; N a power of two from 16,384 to 1,048,576, r = 8, p = 1 unless the hash states otherwise within r 8 to 16, p 1 to 4; salt 16 to 64 bytes; hash 32 to 64 bytes; weaker parameters are `config_invalid`). `POST /api/v1/auth/break-glass` verifies with `node:crypto.scrypt` and `timingSafeEqual`, doing the same work for an unknown username. Failures are limited to 5 per client per 15 minutes and 20 per hour in total (429 `break_glass_locked`). When not configured the route answers the standard 404. `node dist/cli.js hash-password` produces the value. | `server/auth/break-glass.test.ts` (hash round trip, parameter floors, lock counters, equal work for unknown user, unconfigured 404, both variables required) |
| FR-B-522 | MUST | A break-glass session is kind `break_glass`, absolute 30 minutes, not sliding, holds exactly `rbac:manage`, is exempt from MFA and step-up, shows a persistent red banner on every route (nl, en), writes a `warn` log line `break_glass_signin` without the username, and audits `breakglass.signin` (success, and every failure inside the rate bound) and `breakglass.signout`. | `server/auth/break-glass-session.test.ts`, `e2e/break-glass.spec.ts`, `server/audit-integration.test.ts` |
| FR-B-523 | MUST | `POST /api/v1/rbac/restore-owner` (`rbac:manage`, actor kind `break_glass` only; any other actor, including an Owner, gets 403) takes a user object id, validates it with `GET /users/{id}` (503 when Graph is down; the operator may then confirm the id explicitly), and creates the `owner` assignment (source `break_glass`). It is the only path that bypasses `canGrant`. A break-glass actor cannot create or delete any other assignment (it holds no permission that any role grants, so `canGrant` refuses) and no other write route accepts it. Audit `rbac.owner.restore`. | `server/rbac/restore-owner.test.ts`, `server/policy-matrix.test.ts` (break-glass column) |

### 6.6 Audit, errors, headers, internationalisation and UI

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-601 | MUST | Every new write is audited with the Phase A writer in the same transaction as the change (no change without its entry, no entry without its change), using the actions of table 6.9.6 and the extended detail allow-list. Actors are recorded as kind plus id: users by `oid` only (no UPN, no display name), `setup`, `break_glass`, `system`, `cli`. Detail never holds a secret, token, password, key, certificate body or request body. | `server/audit-b-coverage.test.ts` (route-table driven: for every route with an audit declaration, success, denied and rejected cases each produce the expected entry), `server/rbac/audit-rbac.test.ts` and `server/setup/audit-setup.test.ts` (fault injected between change and entry rolls both back), `server/audit-integration.test.ts` (allow-list, canaries) |
| FR-B-602 | MUST | Denials: every denial on a write route (any actor) and every denial of a permissioned read for an authenticated actor (`user`, `setup`, `break_glass`) is audited with route id, permission, reason (`permission_missing`, `scope_mismatch`, `step_up_required`, `escalation_denied`, `last_owner_protected`), request id and client address, before the response is sent; if the append fails the answer is 503 instead of the denial (Phase A PD-21). Anonymous reads answer 401 and are not audited; 429 is never audited. This extends Phase A PA-15 (brief 2a: every 403). | `server/audit-denials.test.ts` (table over the route table times actor kinds and methods) |
| FR-B-603 | MUST | New problem codes (table 6.9.5) each with status, English title, and nl and en messages plus a remedy line where the user can act; wizard step result codes and sign-in error codes (table 6.9.5) have catalogue messages too. The UI shows translated text only, never server `detail`, and never renders text copied from Microsoft responses. | `shared/error-codes.test.ts`, `shared/message-keys.test.ts` (every code, step result code, sign-in error code, rollback-hint key and log message key used by the server exists in both catalogues), `web/error-boundary.test.tsx` |
| FR-B-604 | MUST | Every new UI string exists in `nl` and `en` in fragments of the namespaces `setup`, `connection`, `signin`, `noaccess`, `access`, `role`, `permission`, `session`, `breakglass` and `scope`; roles and permissions have catalogue labels; the server sends keys and parameters only (wizard log lines, hints, results). Catalogue checks of baseline section 12 run on the merged files, including "no value in a third script". Documentation exists in both languages. | `shared/i18n-fragments.test.ts` (ownership, duplicates), `shared/i18n-catalogue.test.ts` (+ negative), `quality` (lint: no literal UI strings), `shared/message-keys.test.ts` |
| FR-B-605 | MUST | Security headers are unchanged for every new route and for the interstitial: the CSP strings, `Strict-Transport-Security` rules, COOP, COEP, CORP, `Referrer-Policy`, `Permissions-Policy` and cache rules of Phase A section 6.3. The CSP gains no entry: no host in `connect-src`, `form-action` stays `'self'`, no `frame-src`, no change to `trusted-types`. | `server/security-headers.test.ts` (extended route list; the policy string is compared with the Phase A constant; adding `https://login.microsoftonline.com` to `connect-src` must fail) (+ negative), `e2e/csp.spec.ts` |
| FR-B-606 | MUST | Navigation mechanics under the strict CSP: sign-in and the redirect to Microsoft are top-level navigations (a link or `location.assign`, answered by a 303); sign-out calls `fetch` (same origin) and then navigates to the returned Microsoft URL; the device-login link is an anchor with `rel="noopener noreferrer"`; no form posts to another origin (a form redirected cross-origin would violate `form-action 'self'`); the browser never calls a Microsoft host (`connect-src 'self'`); the device-code polling happens on the server. | `e2e/signin.spec.ts` and `e2e/setup-wizard.spec.ts` (zero `securitypolicyviolation` events; request log shows no Microsoft host from page scripts), `web/navigation.test.ts` (source scan: no `fetch` or `XMLHttpRequest` to absolute URLs) |
| FR-B-607 | MUST | UI routes: `/setup` (token form and wizard), `/signin`, `/no-access` (variant by allow-listed `reason`), `/break-glass` (404 unless configured), `/settings/connection`, `/settings/access`, `/settings/restore-access` (break-glass actor only). Gating: an anonymous visitor of a gated route is sent to `/signin?returnTo=<path>`; an authenticated actor without the permission sees the in-place No-access content (Phase A); `/setup*` follows FR-B-207. The command registry and the navigation add the Settings entries by permission. `e2e/routes.ts` lists the new routes. | `web/routes-coverage.test.ts` (+ negative), `web/gating.test.tsx`, `web/nav-gating.test.tsx`, `e2e/nav-gating.spec.ts` |
| FR-B-608 | MUST | The header shows a Persona (initials of the display name) with a menu: Mijn toegang, Sign out, Sign out everywhere; a break-glass session shows the red banner of FR-B-522; session warnings per FR-B-416; a notice when `groupsStale`; the organisation name and mark appear on the sign-in and no-access pages (brief 5a). | `web/shell.test.tsx`, `e2e/signin.spec.ts` |
| FR-B-609 | MUST | Accessibility (WCAG 2.2 AA) for every new route and every wizard state (token form, locked, each step in running, waiting, succeeded, warning, failed, skipped; manual mode; finish): axe with the Phase A tag set and zero violations in light and dark at both viewport sizes; the step list is an ordered list with `aria-current="step"`; status is conveyed by icon and text, not colour; the log region is `role="log"` with polite announcements; focus moves to the step heading on a step change and to the error summary on failure; the device code is selectable text with a copy button and an accessible name; targets are at least 24 by 24 CSS px; keyboard-only completion of the wizard, sign-in error page and Settings pages. | `e2e/a11y.spec.ts` (route and state list), `e2e/keyboard.spec.ts`, `web/setup-wizard.test.tsx` |
| FR-B-610 | SHOULD | Lighthouse at least 95 (performance, accessibility, best practices) for `/signin`, `/no-access?reason=no_role` and the `/setup` token form (mobile and desktop presets, timing judged on the best of 3 as in Phase A); authenticated routes are measured with a session cookie created through the fake sign-in and reported. | `e2e` step "Lighthouse" (route list extended) |
| FR-B-611 | MUST | Visual regression baselines (light and dark, desktop and mobile) for the `/setup` token form, one wizard state per status, `/signin` with each error variant, `/no-access`, `/settings/connection` and `/settings/access`. | `e2e/visual.spec.ts` |

### 6.7 Persistence, limits, documentation, CI and test infrastructure

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-701 | MUST | One forward-only migration `0001_phase_b` (Appendix B tables, seeded built-in roles and template, hand-written triggers in a marked section) with the schema snapshot `apps/server/schema-snapshots/0001-phase-b.sql` and the manifest entry committed in the same commit as the migration (baseline section 2). The upgrade test opens a database at schema version 0 built from the committed snapshot of Phase A and seeded with a branding row and its referenced assets, a staged asset and an audit chain that includes `preview` actor rows, applies the real start-up wrapper and compares the result with snapshot 1 (tables, columns, types, defaults, indexes, triggers); it also asserts `foreign_key_check` is empty, the branding row and assets intact, the audit chain verifies, the built-in roles equal `BUILTIN_ROLES`, and the new triggers exist. The synthetic drifting fixture of Phase A stays and must still fail. | `server/migrations.upgrade.test.ts` (+ negative), `server/migrations.test.ts`, `quality` steps "Schema snapshot check" and "Schema drift check" |
| FR-B-702 | MUST | Column defaults are stated in the TypeScript schema and in the SQL and compared by the parity test; new `NOT NULL` columns have defaults; no `CHECK` lists values that later phases extend (`actor_kind`, `action`, `reason_code`); closed sets that will not grow may use `CHECK` (session kind, principal type, scope `by`, step status). | `server/schema-parity.test.ts` (+ negative: a migration default differing from the schema) |
| FR-B-703 | MUST | The limits of table 6.9.2 are constants in `packages/shared/src/limits.ts` and rows of the table in `docs/operations.md`, with numbers. The documentation states that the largest request the app accepts is unchanged (9,437,184 bytes, branding import) and that Phase B adds no larger one; new JSON routes keep the 262,144-byte cap, and the small auth bodies (`unlock`, `logout`, `logout-all`, `break-glass`) a 4,096-byte cap. | `server/limits-doc.test.ts` (+ negative), `server/body-limits.test.ts` |
| FR-B-704 | MUST | `.env.example` lists exactly the variables of the schema (table 6.9.1) plus the Compose-only `HOST_PORT`, with placeholders or defaults only (`APP_KEY` stays empty with the generate command in a comment; no real secret anywhere); `docs/operations.md` carries the same table. The PR body states per AGENTS.md what the operator must add by hand: `APP_KEY` or a Docker secret (required), `SETUP_TOKEN` (optional), and that `PREVIEW_MODE*` can be removed. | `server/deploy-files.test.ts` (parity), `server/docs-contract.test.ts`, `quality` (secret scan) |
| FR-B-705 | MUST | The Compose example gains a `secrets:` stanza that mounts `app_key` at `/run/secrets/app_key` and sets `APP_KEY_FILE`, keeps `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs, healthcheck and the 15 s stop period, and documents the `docker exec` commands. `docker compose config -q` passes. | `server/deploy-files.test.ts`, `image` job |
| FR-B-706 | MUST | The image stays distroless and non-root (the runtime base is not changed in Phase B; ODB-01 may change it later). The image smoke test is extended: under `--read-only` with `/data` writable it (a) runs `generate-app-key`, `setup-token` and `hash-password` through the CLI, (b) creates a certificate inside the image (FR-B-106), (c) starts with `APP_KEY`, unlocks setup with the printed token and reads the environment step, (d) restarts and checks that the state persists. The image size ceiling is re-measured with the new dependencies and recorded; it is raised only with the measured value in the PR. `py/check_image_contents.py` additionally fails on `fake-tenant`, `msw`, `.env` and any setup token or key file in the image. | `image` job (`scripts/image-smoke.ts`), `py/test_check_image_contents.py` (+ negative) |
| FR-B-707 | MUST | Fake tenant (`apps/server/test/fakes/`): simulated Entra (discovery, JWKS with rotation, authorize, token with PKCE and certificate-assertion validation, device code with pending, declined, expired and blocked outcomes), a Graph subset (every call of 6.3.1 and 6.3 `GraphClient`, with `$filter` basics, `appRoles`, `keyCredentials` replacement semantics), the Exchange Admin API subset, and fault toggles (replication delay of N calls, 429 with `Retry-After` in both forms, 5xx, Conditional Access block, policy refusal, missing Exchange service principal, deleted or disabled user, hidden-membership group, deleted group). It validates strictly what Learn says (for example it rejects an assertion without `x5t#S256`, a `PATCH` that drops other credentials is applied as a replacement, a duplicate grant behaves as configured). Vitest uses it through MSW with `onUnhandledFrame: 'error'`; e2e starts the production bundle through a test-only entry that installs request interception before importing `dist/index.js` and forwards to the fake over local HTTP. No production file references the fake or the interception. | `server/fakes/fake-tenant.selftest.test.ts` (strictness; each toggle), `server/no-test-hooks.test.ts` (source scan of `apps/server/src` for `fake-tenant`, `msw`, test-only environment branches) (+ negative), `py/test_check_image_contents.py` |
| FR-B-708 | MUST | e2e topology replaces Phase A FR-A-157: instance A is configured (seeded by driving the real setup API against the fake tenant once per run) and tests sign in through the real flow as fixture principals: owner, administrator, operator, helpdesk, reader, norole (Global Administrator without a panel role), expired-assignment, group-member; instance B starts on an empty data directory for the wizard. Every test still fails on `pageerror`, `console.error`, `securitypolicyviolation`, unexpected 4xx or 5xx, and console warnings that mention `Permissions-Policy`. Phase A specs that used the preview server are migrated, not deleted. | `e2e/fixtures.ts`, `e2e/fixtures-selftest.spec.ts`, `web/routes-coverage.test.ts` |
| FR-B-709 | MUST | Documentation is updated in Dutch and English per 6.8 and passes the docs contract: the listed sections exist, `docs/permissions.md` rows each carry a reason, a phase and a verification status, every UNVERIFIED row has a row in `docs/open-points.md`, `docs/operations.md` carries the env table and the limits numbers, `docs/security.md` carries the Phase B STRIDE tables and the ASVS rows. | `server/docs-contract.test.ts` (extended), `server/limits-doc.test.ts` |
| FR-B-710 | MUST | `VERSION` is bumped to 0.3.0 (Phase A assumption A-47) in the first Phase B commit that touches a protected path; `/healthz`, the image label and the release tag derive from it. | `enforce-version-bump`, `image` smoke test |
| FR-B-711 | MUST | New production dependencies are `@azure/msal-node` 7.0.1, `jose` 6.2.12, `libsodium-wrappers` 0.8.4 (versions pinned by the Phase A stack probe) and one X.509 generation library chosen by a plan-time probe (candidate `@peculiar/x509`; registry shows 2.1.0, node >= 20; B-19). `msw` 3.0.3 is a development dependency. `@microsoft/microsoft-graph-client` is **not** added (B-12). Each production dependency has a reason row in `docs/architecture.md` with a reuse / adapt / replace mark. | `server/docs-contract.test.ts` (dependency table), `quality` (`pnpm audit --prod`, frozen lockfile) |
| FR-B-712 | MUST | The Phase B report is written, the owner's approval line is empty until the owner fills it, and nothing for Phase C exists in the repository. | review (cannot be automated, section 3) |
| FR-B-713 | MUST | One implementation per concept in `packages/shared` (baseline section 10): `computeGrants`, `covers`, `matchScope`, `normalizeScopeItem`, `projectUser`, `evaluateAmr`, `safeReturnTo`, `cookieNames`, `redirectUris`, `authorizeRedirectUri`, `BUILTIN_ROLES`, `GRAPH_APP_ROLES`, the step and result code registries. A second definition anywhere in `apps/*/src` fails the test; amounts are summed from buckets, not counted separately. | `shared/single-implementation.test.ts` (source scan; extended name list) (+ negative) |
| FR-B-714 | MUST | Start sequence additions after the migration wrapper: load setup state; initialise libsodium and the secrets state (FR-B-108); create the setup token file when setup is open (FR-B-203); load the tenant connection and build the identity and Graph clients; reset `running` rows; start the session and transaction sweepers (hourly purge, minute-level transaction expiry); then listen. Shutdown additionally clears the bootstrap object, drops in-memory transactions and releases the runner lease. | `server/lifecycle.test.ts` (order, degraded combinations, shutdown) |
| FR-B-715 | MUST | Logs gain structured events without personal data: `setup_unlock_locked`, `setup_step` (step, sub-action, status, attempt), `signin_ok`, `signin_denied` (allow-listed code), `session_revoked` (reason), `break_glass_signin`, `membership_refresh_failed`, `preview_mode_removed`. No `oid`, UPN, display name, token, code, state, session id, setup token or key appears in any log line. | `server/logging.test.ts` (canaries over a full fake-tenant run), `server/no-leak.test.ts` |

### 6.8 Documentation to update

| Document | Phase B content |
|---|---|
| `README.md` (nl, en) | First run: key generation, `docker run` with `APP_KEY`, printing the setup token, opening `/setup`, signing in; Compose with the secret; what the wizard needs from the administrator (Global Administrator, or Privileged Role Administrator plus an app-registration role) |
| `docs/security.md` | STRIDE for the setup gate, sign-in, sessions, RBAC, secrets, break-glass; first-run takeover analysis; cookie and CSRF design including the `localhost` trade-off and shared cookies across ports; session and step-up design; the Exchange Administrator blast radius; self-signed certificate trade-off; headers unchanged and why; what the simulation cannot prove; ASVS level 2 rows (V2, V3, V4, V6, V8) |
| `docs/permissions.md` | Runtime application permissions with reason, phase, status and the delta against the brief; the wizard's delegated scopes and the roles of the administrator; Exchange app roles and the Entra role; the built-in role matrix; the permission to resource-type map and the scope semantics |
| `docs/operations.md` | Env table; limits table with numbers; `APP_KEY` generation, backup (separately from `/data`), rotation procedure; certificate expiry and renewal; setup token and `setup-reopen`; break-glass hash and use; timeouts; reverse-proxy checklist (preserve `Host`, forward cookies, no HTML caching, body 9,437,184 bytes); outbound hosts (`login.microsoftonline.com`, `graph.microsoft.com`, `outlook.office365.com`); sovereign clouds unsupported; Dutch section |
| `docs/architecture.md` | Layering with the `integrations` boundary, the module list, new dependencies with reasons, accessibility checklist additions (session timing, wizard) |
| `docs/open-points.md` | U34 and up, the owner-verified ledger, assumptions B-01 to B-26, risks RB-01 to RB-16 |
| `docs/adr/` | One ADR per assumption B-01 to B-26 |
| `docs/phase-reports/phase-B.md` | The report of section 3 |


### 6.9 Reference tables (normative)

These tables hold the values that rows of 6.1 to 6.7 refer to. They are normative: code, `.env.example`, `docs/operations.md`, `docs/permissions.md` and the catalogues are checked against them by the tests named in the rows that cite them (FR-B-101, FR-B-103, FR-B-401, FR-B-502, FR-B-601, FR-B-603, FR-B-703, FR-B-704, FR-B-713). The detailed request and response shapes of the routes in 6.9.7 belong to `contracts/phase-b-api.md` of the Phase B plan, which MUST NOT change a path, an access rule, a rate class or an audit action listed here without amending this spec in the same commit.

#### 6.9.1 Environment variables

Added by Phase B (14). Every variable is read by the one Zod schema (FR-B-101), appears in `.env.example` and in the table of `docs/operations.md`, and is reported by name only in errors and logs.

| Variable | Default | Accepted values | Secret | Rows |
|---|---|---|---|---|
| `APP_KEY` | unset | 32 bytes as base64 or base64url (43 or 44 characters) or 64 hexadecimal characters; not all bytes equal; at least 16 distinct byte values; exclusive with `APP_KEY_FILE` | yes | FR-B-104, FR-B-105 |
| `APP_KEY_FILE` | unset | absolute path of a readable file of at most 1,024 bytes holding the same formats, one trailing newline trimmed | the file content | FR-B-104, FR-B-705 |
| `APP_KEY_PREVIOUS` | unset | as `APP_KEY`; set only while rotating; exclusive with `APP_KEY_PREVIOUS_FILE` | yes | FR-B-109 |
| `APP_KEY_PREVIOUS_FILE` | unset | as `APP_KEY_FILE` | the file content | FR-B-109 |
| `SETUP_TOKEN` | unset (a token file is used) | 24 to 128 characters from `A-Z a-z 0-9 - _ . ~`, at least 12 distinct characters | yes | FR-B-203 |
| `BOOTSTRAP_CLIENT_ID` | `14d82eec-204b-4c2f-b7e8-296a70dab67e` | a GUID, case-insensitive, stored lower-case | no | FR-B-214 |
| `SETUP_PROPAGATION_TIMEOUT_SECONDS` | 900 | integer 60 to 3,600 | no | FR-B-212 |
| `SESSION_IDLE_TIMEOUT_MINUTES` | 30 | integer 5 to 480 | no | FR-B-407 |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | 8 | integer 1 to 24; hours x 60 must exceed the idle minutes | no | FR-B-407 |
| `GROUP_CACHE_TTL_SECONDS` | 300 | integer 30 to 3,600 | no | FR-B-409, FR-B-507 |
| `AUTH_REQUIRE_MFA` | `true` | exactly `true` or `false` | no | FR-B-405 |
| `AUTH_MFA_AMR_VALUES` | `mfa,multipleauthn` | comma-separated list of 1 to 8 distinct values of 2 to 32 characters from `a-z 0-9`; `pwd`, `wia` and `x509` are refused (single-factor methods in Learn's `amr` table) | no | FR-B-405 |
| `BREAK_GLASS_USERNAME` | unset | 3 to 64 characters from `A-Z a-z 0-9 . _ -`; set together with the hash or not at all | no (never logged) | FR-B-521 |
| `BREAK_GLASS_PASSWORD_HASH` | unset | the `scrypt:` format of FR-B-521 with its parameter floors | yes | FR-B-521 |

Changed by Phase B.

| Variable | Phase A | Phase B |
|---|---|---|
| `PUBLIC_BASE_URL` | default `http://localhost:<PORT>`; any URL | `https`, or `http` with host exactly `localhost`; the redirect URIs are derived from it (FR-B-103); a change after setup needs the repair flow (EB-11) |

Removed by Phase B (2): `PREVIEW_MODE`, `PREVIEW_MODE_ALLOW_REMOTE` (FR-B-102). Unchanged from Phase A: `PORT`, `HOST`, `DATA_DIR`, `TRUST_PROXY`, `SHOWCASE`, `LOG_LEVEL`, `HSTS_MAX_AGE`, `HSTS_INCLUDE_SUBDOMAINS`, `HSTS_PRELOAD`; the Compose-only `HOST_PORT` is not read by the application.

#### 6.9.2 Limits (numbers; constants in `packages/shared/src/limits.ts`)

The column "Constant" is the name in `LIMITS`; `docs/operations.md` carries the same rows (FR-B-703). Rows marked "setting" are also environment variables (6.9.1). Client address means the Phase A client key (IPv4 address or IPv6 /64, `TRUST_PROXY` rules).

| Area | Constant | Value | Notes |
|---|---|---|---|
| Setup | `SETUP_UNLOCK_FAILS_PER_CLIENT` | 5 failures per 15 minutes | lock of that address for 15 minutes (FR-B-204) |
| Setup | `SETUP_UNLOCK_FAILS_GLOBAL` | 30 failures per hour | lock of unlocking for everyone for 15 minutes |
| Setup | `SETUP_LOCK_MINUTES` | 15 | `Retry-After` is the remaining seconds |
| Setup | `SETUP_SESSION_IDLE_MINUTES`, `SETUP_SESSION_ABSOLUTE_HOURS` | 60 and 8 | in memory; a restart ends the session (FR-B-205) |
| Setup | `SETUP_TOKEN_BYTES` | 32 | generated token, base64url, mode 0600 |
| Setup | `SETUP_LEASE_HEARTBEAT_SECONDS`, `SETUP_LEASE_EXPIRY_SECONDS` | 15 and 120 | runner lease (FR-B-209) |
| Setup | `SETUP_LOG_RETAINED`, `SETUP_LOG_PAGE_MAX` | 1,000 rows and 200 rows | polling every 1 s, every 2 s in a hidden tab (FR-B-211) |
| Setup | `SETUP_DETAIL_STRING_MAX_BYTES`, `SETUP_VERIFY_RESULT_MAX_BYTES` | 256 and 51,200 | step detail strings; stored proof list (FR-B-210, FR-B-309) |
| Setup | `SETUP_TRANSIENT_BACKOFF` | 1 s doubling to 30 s, full jitter, at most 6 tries | `Retry-After` wins when present (FR-B-212) |
| Setup | `SETUP_REPLICATION_BACKOFF` | 2 s doubling to 60 s, full jitter | window 300 s for object chains (`SETUP_OBJECT_CHAIN_WINDOW_SECONDS`) |
| Setup | `SETUP_PROPAGATION_TIMEOUT_SECONDS` (setting) | default 900, range 60 to 3,600 | role-to-token propagation window; hard maximum 3,600 |
| Setup | `SETUP_SKEW_WARN_SECONDS`, `SETUP_SKEW_FAIL_SECONDS` | 60 and 300 | our thresholds, U35 |
| Setup | `SETUP_MUTATING_CALLS_CLEAN_RUN` | 11 | informative; the fault-injection test derives its points from the fake tenant |
| Certificate | `CERT_RSA_BITS`, `CERT_VALIDITY_DAYS`, `CERT_BACKDATE_MINUTES` | 2048, 360, 5 | Learn: at most one year from the start date (FR-B-106) |
| Certificate | `CERT_WARN_DAYS`, `CERT_CRITICAL_DAYS` | 60 and 14 | banner levels (FR-B-111) |
| Secrets | `APP_KEY_BYTES`, `SECRET_NONCE_BYTES`, `KEY_ID_BYTES` | 32, 24, 8 | FR-B-104, FR-B-105 |
| Secrets | `APP_KEY_FILE_MAX_BYTES` | 1,024 | FR-B-104 |
| Microsoft | `CLIENT_ASSERTION_LIFETIME_SECONDS` | 300 | Learn: at most 10 minutes after `nbf` (FR-B-112) |
| Microsoft | `TOKEN_ENDPOINT_TIMEOUT_SECONDS` | 10 | one retry after 1 s on `temporarily_unavailable` (FR-B-403) |
| Microsoft | `ID_TOKEN_MAX_BYTES` | 8,192 | FR-B-404 |
| Microsoft | `CLOCK_TOLERANCE_SECONDS` | 60 | `exp`, `nbf`, `iat` (U33) |
| Microsoft | `JWKS_CACHE_HOURS`, `JWKS_REFRESH_MINUTES`, `JWKS_UNKNOWN_KID_COOLDOWN_MINUTES` | 24, 60, 5 | signing-key rollover guidance (FR-B-404) |
| Microsoft | `GRAPH_CHECK_MEMBER_GROUPS_MAX_IDS` | 20 | Learn: up to 20 groups per request (FR-B-311) |
| Microsoft | `GRAPH_RETRY_MAX`, `GRAPH_RETRY_AFTER_MAX_WAIT_SECONDS` | 4 and 60 | longer waits fail fast as `graph_throttled` (FR-B-312) |
| Microsoft | `GRAPH_5XX_BACKOFF` | 500 ms doubling to 10 s, full jitter, at most 4 retries | idempotent calls only |
| Microsoft | `GRAPH_BUDGET_INTERACTIVE_SECONDS`, `GRAPH_BUDGET_WIZARD_SECONDS`, `GRAPH_IN_FLIGHT_MAX` | 20, 60, 4 | per call including retries |
| Microsoft | `GRAPH_CACHE_TTL_SECONDS` | organization 300, user 60, group 60 | `GRAPH_CACHE_ENTRIES` 1,000 (FR-B-313) |
| Microsoft | `EXCHANGE_RESULT_SIZE_MAX`, `EXCHANGE_PAGING_WINDOW_SECONDS` | 1,000 and 300 | nextLink valid 5 to 10 minutes (FR-B-314) |
| Sign-in | `LOGIN_TX_MAX`, `LOGIN_TX_PER_CLIENT_MAX`, `LOGIN_TX_LIFETIME_SECONDS` | 1,000, 20, 600 | oldest evicted (FR-B-402) |
| Sign-in | `RETURN_TO_MAX_CHARS` | 256 | FR-B-402 |
| Sign-in | `RATE_AUTH`, `RATE_SETUP` | capacity 10, refill 0.2 per second, per client | FR-B-415 |
| Session | `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS` (settings) | 30 and 8 | ranges in 6.9.1 |
| Session | `SESSION_WRITE_INTERVAL_SECONDS`, `SESSIONS_PER_PRINCIPAL_MAX`, `SESSION_PURGE_MINUTES` | 60, 10, 60 | FR-B-407 |
| Session | `SESSION_IDLE_WARNING_SECONDS`, `SESSION_ABSOLUTE_WARNING_MINUTES` | 120 and 5 | FR-B-416 |
| Session | `STEP_UP_WINDOW_MINUTES`, `STEP_UP_AUTH_TIME_LEEWAY_SECONDS` | 10 and 60 | FR-B-411 |
| Session | `REVALIDATE_RETRY_SECONDS` | 30 | after a Graph failure (FR-B-409) |
| Break-glass | `BREAK_GLASS_SESSION_MINUTES` | 30, not sliding | FR-B-522 |
| Break-glass | `BREAK_GLASS_FAILS_PER_CLIENT`, `BREAK_GLASS_FAILS_GLOBAL` | 5 per 15 minutes and 20 per hour | 429 `break_glass_locked` (FR-B-521) |
| Break-glass | `SCRYPT_N_MIN`, `SCRYPT_N_MAX`, `SCRYPT_SALT_BYTES`, `SCRYPT_HASH_BYTES` | 16,384; 1,048,576; 16 to 64; 32 to 64 | r = 8 and p = 1 unless stated (FR-B-521) |
| RBAC | `GROUP_CACHE_TTL_SECONDS` (setting) | default 300, range 30 to 3,600 | FR-B-409 |
| RBAC | `GROUPS_BOUND_MAX` | 200 | distinct bound Entra groups (FR-B-507) |
| RBAC | `ASSIGNMENTS_MAX`, `ROLES_MAX` | 5,000 and 100 | roles include the five built-in (FR-B-508) |
| RBAC | `SCOPE_ITEMS_PER_ASSIGNMENT_MAX`, `SCOPE_VALUE_MAX_CHARS` | 50 and 64 | FR-B-513 |
| RBAC | `ASSIGNMENT_EXPIRY_MAX_DAYS` | 730 | FR-B-508 |
| Request size | `AUTH_BODY_MAX_BYTES` | 4,096 | `unlock`, `logout`, `logout-all`, `break-glass` (FR-B-703) |
| Request size | JSON bodies, largest request | 262,144 and 9,437,184 bytes | unchanged from Phase A; Phase B adds no larger request |
| Audit | `AUDIT_DETAIL_MAX_BYTES` | 4,096 | unchanged from Phase A |

#### 6.9.3 Cookies

All three cookies are `HttpOnly`, `Path=/`, have no `Domain` attribute and carry a 256-bit random value (base64url). `Secure` and the `__Host-` prefix apply exactly when `PUBLIC_BASE_URL` is https. The names come from `cookieNames(publicBaseUrl)` in `packages/shared` (FR-B-401, FR-B-713). Cookies are not isolated by port: on `http://localhost` another local application can read and overwrite them, which `docs/security.md` states (B-07, U39).

| Purpose | Name on https | Name on `http://localhost` | `SameSite` | Lifetime | Value | Set by | Cleared by |
|---|---|---|---|---|---|---|---|
| Session (user and break-glass) | `__Host-m365portal_session` | `m365portal_session` | `Strict` | browser session (no `Max-Age`); the server enforces timeouts | session id; only its SHA-256 is stored | `GET /auth/callback`, `POST /api/v1/auth/break-glass`, step-up | logout, logout-all, revocation, expiry |
| OIDC transaction | `__Host-m365portal_oidc` | `m365portal_oidc` | `Lax` | `Max-Age=600` | transaction id | `GET /auth/login` | `GET /auth/callback` (any outcome after the cookie was read) |
| Setup session | `__Host-m365portal_setup` | `m365portal_setup` | `Strict` | browser session; the server enforces 60 minutes idle and 8 hours absolute | setup session id (memory only) | `POST /api/v1/setup/unlock` | `DELETE /api/v1/setup/session`, expiry |

#### 6.9.4 Built-in role matrix (normative; identical in `docs/permissions.md`)

`x` means the role holds the permission. The five built-in roles are unscoped definitions; a scope belongs to an assignment (6.5.1). The template *Bestuur* is data, not a role (FR-B-503); `basic` is the qualifier of 6.5.1. Totals: *Eigenaar* 15, *Beheerder* 13, *Operator* 9, *Helpdesk* 6, *Lezer* 4, *Bestuur* 5.

| Permission | Resource type | Eigenaar (`owner`) | Beheerder (`admin`) | Operator (`operator`) | Helpdesk (`helpdesk`) | Lezer (`reader`) | Bestuur (template) |
|---|---|---|---|---|---|---|---|
| `users:read` | `user` | x | x | x | x | x | basic |
| `groups:read` | `group` | x | x | x | x | x | |
| `groups:members:write` | `group` | x | x | x | x | | |
| `distributionlists:read` | `distributionList` | x | x | x | x | x | x |
| `distributionlists:members:write` | `distributionList` | x | x | x | x | | x |
| `distributionlists:export` | `distributionList` | x | x | | | | |
| `contacts:read` | `contact` | x | x | x | x | x | x |
| `contacts:create` | `contact` | x | x | x | | | x |
| `contacts:update` | `contact` | x | x | x | | | |
| `contacts:delete` | `contact` | x | x | x | | | |
| `audit:read` | none (global-only) | x | x | | | | |
| `audit:export` | none (global-only) | x | x | | | | |
| `settings:branding` | none (global-only) | x | x | | | | |
| `settings:connection` | none (global-only) | x | | | | | |
| `rbac:manage` | none (global-only) | x | | | | | |

#### 6.9.5 Codes

**Problem codes added by Phase B** (RFC 9457 `code`, each with `problem.<code>` messages in nl and en; the UI never shows server `detail`, FR-B-603). Phase A codes (`permission_denied`, `origin_not_allowed`, `csrf_invalid`, `rate_limited`, `not_found`, `storage_unavailable` and the rest) are unchanged; `permission_denied` now covers a missing permission and a scope mismatch alike, and the audit `reason_code` tells them apart.

| Code | Status | Source | `Retry-After` |
|---|---|---|---|
| `unauthenticated` | 401 | no valid session or setup session on a route that needs one; carries `WWW-Authenticate: Cookie realm="m365portal"` (FR-B-414) | |
| `session_expired` | 401 | unknown or expired session cookie; the cookie is cleared | |
| `step_up_required` | 403 | route with `stepUp` and no step-up inside the window (FR-B-411) | |
| `escalation_denied` | 403 | `canGrant` is false (FR-B-509) | |
| `last_owner_protected` | 409 | change would leave no Owner (FR-B-510) | |
| `setup_token_invalid` | 401 | wrong token on `unlock` | |
| `setup_token_locked` | 429 | unlock lock (FR-B-204) | integer seconds |
| `setup_step_busy` | 409 | runner lease held (FR-B-209) | |
| `setup_step_not_ready` | 409 | step started before its predecessor succeeded or ended in warning | |
| `setup_required` | 409 | sign-in or connection use before the state reached `awaiting_first_signin` | |
| `secrets_unavailable` | 503 | `APP_KEY` missing or invalid, certificate unreadable (FR-B-108) | |
| `policy_not_applied` | 500 | scoped route handler returned 2xx without applying scope (FR-B-505); audited as `error` | |
| `principal_unknown` | 422 | assignment or restore-owner names a user or group Entra does not know | |
| `assignment_exists` | 409 | duplicate principal, role and scope set | |
| `assignment_invalid` | 422 | role not assignable, scope target not used by the role, expiry out of range, owner role with scope or expiry | |
| `break_glass_locked` | 429 | break-glass failure bound (FR-B-521) | integer seconds |
| `graph_unavailable` | 503 | Graph failed where the route needs it (assignment validation, restore-owner) | 30 |
| `graph_throttled` | 503 | Graph asked for a wait longer than 60 s (FR-B-312) | value from Graph |
| `tenant_mismatch` | 409 | bootstrap returned another tenant than the pinned one (FR-B-216) | |

**Wizard result codes** (`setup_step.error_code`, step results, proof list; each has a catalogue message and a remedy key; Microsoft free text is never stored or shown, only the `AADSTS` number).

| Step | Code | Status | Meaning |
|---|---|---|---|
| environment | `public_base_url_invalid`, `data_dir_not_writable`, `app_key_missing`, `app_key_invalid` | fail | FR-B-213 |
| environment | `network_unreachable` | fail | login or Graph host unreachable (params: host names) |
| environment | `network_exchange_unreachable`, `node_version_unsupported`, `time_skew_warning` | warn | FR-B-213 |
| environment | `time_skew_excessive` | fail | skew over 300 s (U35) |
| connect | `device_code_expired`, `device_code_declined`, `device_code_cancelled` | failed | EB-03 |
| connect | `device_code_blocked` | failed | `AADSTS53003`; offers manual mode (EB-04) |
| connect | `consent_required`, `admin_approval_required`, `assignment_required` | failed | `AADSTS65001`; `AADSTS90093` and `AADSTS90094`; `AADSTS50105` (FR-B-217) |
| connect | `bootstrap_role_insufficient` | failed | the first delegated call answered 403 (EB-05) |
| connect | `tenant_mismatch`, `bootstrap_failed` | failed | FR-B-216; any other error, with the `AADSTS` number |
| configure | `app_role_missing` | failed | FR-B-302 |
| configure | `application_ambiguous` | failed | several matches (FR-B-304) |
| configure | `application_adoption_required` | waiting | one match without our install tag; needs the explicit confirmation of `connection.adopt` |
| configure | `policy_refused`, `thumbprint_mismatch`, `forbidden_permission_present` | failed | EB-10, FR-B-306, FR-B-307 |
| configure | `replication_timeout`, `graph_error` | failed | window exhausted; permanent Graph error (allow-listed Graph error code in params) |
| configure | `exchange_service_principal_missing` | skipped | EB-08 |
| verify | `token_unavailable`, `organization_mismatch`, `users_unreadable`, `drift_detected` | failed | V1, V2, V3, V4 (FR-B-309) |
| verify | `exchange_not_ready`, `exchange_unavailable`, `optional_claim_missing` | warning | V5 twice, V6 (EB-09) |
| verify | `not_checked` | skipped | V4 and V6 in manual mode |
| finish | `owner_missing`, `group_unknown` | failed | FR-B-219 |

**Sign-in error codes** (allow-list for `/signin?error=`; any other value renders `signin_failed`) and **no-access reasons** (`/no-access?reason=`).

| Code | Raised by | Audited |
|---|---|---|
| `signin_failed` | any token, state or exchange failure that must not say which check failed (the Appendix C fixtures that list `signin_failed`) | from step 7 of FR-B-403 only |
| `cookies_missing_or_expired` | no live transaction (F-30 to F-32) | no |
| `access_denied`, `interaction_required` | `error` parameter from Entra (F-34, F-35) | no |
| `consent_required`, `admin_approval_required`, `assignment_required` | `AADSTS65001`; `AADSTS90093` and `AADSTS90094`; `AADSTS50105` (F-36) | no |
| `conditional_access_blocked` | `AADSTS53003` | no |
| `temporarily_unavailable` | token endpoint or key endpoint unavailable (F-27, F-41) | no |
| `mfa_required`, `amr_missing` | FR-B-405 (F-42) | yes |
| `stepup_failed` | step-up callback failed a check of FR-B-411 | yes |
| `secrets_unavailable`, `setup_required` | login start (FR-B-402) | no |
| `session_expired` | the web app redirects after a 401 `session_expired` | no |
| no-access `no_role` | principal without an active grant (F-44) | yes |
| no-access `graph_unavailable` | only group-derived grants existed and Graph failed (EB-21, F-44) | yes |

#### 6.9.6 Audit actions and detail allow-list

Outcome values are those of Phase A (`success`, `denied`, `rejected`, `error`). A step that ends in warning is `success` with detail `status` `warning`. A denial on a write route or a permissioned read of an authenticated actor is recorded with `action` equal to the route id of 6.9.7, `outcome` `denied` and `reason_code` one of `permission_missing`, `scope_mismatch`, `step_up_required`, `escalation_denied`, `last_owner_protected` (FR-B-602; Phase A wrote `permission_denied` as reason, `origin_not_allowed` and `csrf_invalid` are unchanged).

| Action | Target (type / id) | Outcomes | Actor kinds | Detail keys |
|---|---|---|---|---|
| `setup.unlock` | `setup` / empty | `success`; `denied` when a lock starts | `setup`; `anonymous` | `reason`, `lockScope` |
| `setup.step.run` | `setup_step` / step key | `success`, `error`, `denied` | `setup` or `user` | `step`, `subAction`, `status`, `attempt`, `codes`, `mode` |
| `setup.object.change` | `setup_object` / object kind | `success`, `error` | `setup` or `user` | `kind`, `op`, `objectId`, `appId`, `name`, `confirmed` |
| `setup.tenant.pin` | `tenant` / `tid` | `success`, `rejected` | `setup` | `tid`, `mode` |
| `setup.complete` | `setup` / empty | `success` | `user` | `mode` |
| `setup.reopen` | `setup` / empty | `success` | `cli` | `fromState` |
| `connection.repair` | `setup_step` / sub-action key | `success`, `error`, `denied` | `user` | `subAction`, `drift`, `status`, `codes` |
| `connection.verify` | `connection` / empty | `success`, `error`, `denied` | `user` | `checks`, `codes` |
| `secrets.certificate.create` | `certificate` / SHA-1 thumbprint | `success` | `setup` or `user` | `thumbprintSha1`, `notAfter` |
| `secrets.app_key.rotate` | `secret` / empty | `success`, `error` | `cli` | `rows`, `fromKeyId`, `toKeyId` |
| `auth.signin` | `app_user` / `oid` | `success`, `denied` | `user`; `anonymous` before the token validated | `reason`, `check`, `mfa`, `groupsResolved`, `purpose` |
| `auth.stepup` | `app_user` / `oid` | `success`, `denied` | `user` | `reason`, `check`, `mfa` |
| `auth.signout` | `session` / empty | `success` | `user`, `break_glass` | `scope`, `sessions` |
| `auth.session.revoked` | `app_user` / `oid` | `success` | `system` | `reason`, `sessions` |
| `breakglass.signin` | `break_glass` / empty | `success`, `denied` | `break_glass`; `anonymous` | `reason` |
| `breakglass.signout` | `break_glass` / empty | `success` | `break_glass` | `reason` |
| `rbac.assignment.create` | `rbac_assignment` / id | `success`, `denied` | `user` | `principalType`, `principalId`, `role`, `scopeTargets`, `scopeItems`, `expiresAt`, `source` |
| `rbac.assignment.delete` | `rbac_assignment` / id | `success`, `denied` | `user` | `principalType`, `principalId`, `role`, `reason` |
| `rbac.owner.restore` | `app_user` / `oid` | `success`, `denied` | `break_glass` | `assignmentId`, `graphChecked` |

Rules. (1) The writer accepts only the keys `step`, `subAction`, `status`, `attempt`, `codes`, `mode`, `kind`, `op`, `objectId`, `appId`, `name`, `confirmed`, `tid`, `fromState`, `drift`, `checks`, `thumbprintSha1`, `notAfter`, `rows`, `fromKeyId`, `toKeyId`, `reason`, `check`, `mfa`, `groupsResolved`, `purpose`, `scope`, `sessions`, `principalType`, `principalId`, `role`, `scopeTargets`, `scopeItems`, `expiresAt`, `source`, `assignmentId`, `graphChecked`, `lockScope`, plus the Phase A keys (`permission`, `method`, route template). (2) Values are strings of at most 256 bytes, integers, booleans or short string arrays; `objectId`, `appId`, `tid`, `principalId` and `assignmentId` must be GUIDs, `thumbprintSha1` 40 hexadecimal characters; `reason`, `check`, `op`, `kind`, `purpose`, `scope`, `lockScope` and `mode` are enumerations of the shared registries. (3) A key whose name matches `secret`, `token`, `key`, `password`, `assertion`, `pem` or `credential` (case-insensitive) is rejected by the writer, as in FR-B-210; `fromKeyId` and `toKeyId` are key ids (FR-B-104), not keys, and are on the allow-list by exact name. (4) User actors are recorded by `oid` only; the break-glass username, UPN, display name, client secrets, codes, `state` and tokens never appear. (5) Tenant-changing calls (`setup.object.change`) are audited in the same transaction as the `setup_object` row after the call returned; if the process dies between the call and the transaction, the resumed run finds the object and records `op` `adopt`. The coverage test `server/audit-b-coverage.test.ts` iterates the route table (6.9.7) and the actions above; `server/setup/audit-setup.test.ts`, `server/rbac/audit-rbac.test.ts` and `server/audit-integration.test.ts` hold the fault-injection and allow-list cases of FR-B-601.

#### 6.9.7 Route index

New routes use ids and paths below; Phase A routes R1 to R17 and S1 to S3 keep their access, with two shape changes (R4 `meta.me`, R5 `meta.csrf`, AM-07 and AM-08). Access words: `public` (no actor needed); `authenticated` (any user or break-glass session); `setup` (valid setup session, only while the state is not `completed`); `connection` (setup session while the state is not `completed`, `settings:connection` afterwards); a permission name; `stepUp` means FR-B-411 applies to user actors; the setup actor and break-glass are exempt. Classes: `auth` and `setup` of FR-B-415, otherwise `read` or `write` of Phase A. After the state is `completed` every `/api/v1/setup/*` route answers the standard 404, `status` and `unlock` included (FR-B-207). All routes are in the OpenAPI document (`x-step-up`, `x-scoped` extensions), declare their audit action, and answer with `Cache-Control: no-store` where FR-B-417 says so.

| # | Route id | Method and path | Access | Class | Audit |
|---|---|---|---|---|---|
| P01 | `auth.login` | `GET /auth/login?returnTo=&prompt=&purpose=` | public | auth | none |
| P02 | `auth.callback` | `GET /auth/callback` | public | auth | `auth.signin` or `auth.stepup` (from step 7) |
| P03 | `auth.loggedOut` | `GET /auth/logged-out` | public | auth | none |
| P04 | `auth.logout` | `POST /api/v1/auth/logout` | authenticated | auth | `auth.signout`, `breakglass.signout` |
| P05 | `auth.logoutAll` | `POST /api/v1/auth/logout-all` | authenticated, user sessions | auth | `auth.signout` |
| P06 | `auth.breakGlass` | `POST /api/v1/auth/break-glass` | public; 404 unless configured | auth | `breakglass.signin` |
| P07 | `meta.me` | `GET /api/v1/me` | public | read | none |
| P08 | `meta.csrf` | `GET /api/v1/csrf` | public | read | none |
| P09 | `me.access` | `GET /api/v1/me/access` | authenticated | read | none |
| P10 | `setup.status` | `GET /api/v1/setup/status` | public | setup | none |
| P11 | `setup.unlock` | `POST /api/v1/setup/unlock` | public | setup | `setup.unlock` |
| P12 | `setup.session.end` | `DELETE /api/v1/setup/session` | setup | write | none |
| P13 | `setup.state` | `GET /api/v1/setup/state` | setup | read | none |
| P14 | `setup.environment` | `POST /api/v1/setup/environment` | setup | write | `setup.step.run` |
| P15 | `setup.manual` | `PUT /api/v1/setup/manual` | setup | write | `setup.step.run` |
| P16 | `setup.certificate` | `GET /api/v1/setup/certificate.cer` | setup | read | none (public certificate only) |
| P17 | `setup.groups` | `GET /api/v1/setup/groups?q=` | setup | read | none |
| P18 | `setup.finish` | `POST /api/v1/setup/finish` | setup | write | `setup.step.run` |
| P19 | `connection.get` | `GET /api/v1/connection` | connection | read | none |
| P20 | `connection.log` | `GET /api/v1/connection/log?after=&limit=` | connection | read | none |
| P21 | `connection.runs.start` | `POST /api/v1/connection/runs` | connection, stepUp | write | `setup.step.run` (wizard), `connection.repair` (after completion) |
| P22 | `connection.runs.current` | `GET /api/v1/connection/runs/current` | connection | read | none |
| P23 | `connection.runs.retryNow` | `POST /api/v1/connection/runs/current/retry-now` | connection, stepUp | write | none |
| P24 | `connection.runs.cancel` | `POST /api/v1/connection/runs/current/cancel` | connection, stepUp | write | none |
| P25 | `connection.adopt` | `POST /api/v1/connection/adopt` | connection, stepUp | write | `setup.object.change` |
| P26 | `connection.verify` | `POST /api/v1/connection/verify` | connection, stepUp | write | `connection.verify` |
| P27 | `rbac.roles.list` | `GET /api/v1/rbac/roles` | `rbac:manage` | read | none |
| P28 | `rbac.assignments.list` | `GET /api/v1/rbac/assignments` | `rbac:manage` | read | none |
| P29 | `rbac.assignments.create` | `POST /api/v1/rbac/assignments` | `rbac:manage`, stepUp | write | `rbac.assignment.create` |
| P30 | `rbac.assignments.delete` | `DELETE /api/v1/rbac/assignments/{id}` | `rbac:manage`, stepUp | write | `rbac.assignment.delete` |
| P31 | `rbac.effective` | `GET /api/v1/rbac/effective?principal=` | `rbac:manage` | read | none |
| P32 | `rbac.restoreOwner` | `POST /api/v1/rbac/restore-owner` | `rbac:manage`, actor kind `break_glass` only | write | `rbac.owner.restore` |

Notes. (1) Reads of authenticated actors that are denied are audited under the route id (FR-B-602), so P19 to P22 and P27 to P31 produce `denied` entries for a signed-in user without the permission, never for an anonymous visitor (401). (2) The `Sec-Fetch-Site` rule of Phase A FR-A-044 applies to every route that writes an audit entry on a GET (none in Phase B). (3) P01 to P03 are browser navigations; they carry no `X-CSRF-Token` and change no state except the in-memory transaction and the cookies of 6.9.3. (4) A route whose permission has a resource type declares `scoped` or `unscopedReason` (FR-B-505); no Phase B route has a resource type, so all use `unscopedReason`, and the Phase C and D routes will use `scoped`. (5) `setup.certificate` serves only the public certificate (`application/x-x509-ca-cert`, no private material); it answers 409 `setup_step_not_ready` until the certificate exists, which in manual mode is from the start of step 2.

UI routes (single-page application, served by the shell fallback): `/setup` and `/setup/*` (404 once `completed`), `/signin`, `/no-access`, `/break-glass` (404 unless configured), `/settings/connection` (`settings:connection`), `/settings/access` (any signed-in user), `/settings/restore-access` (break-glass actor only). Gating and redirects: FR-B-607.

---

## 7. Success Criteria

### 7.1 Measurable outcomes

Each outcome is checked by the named automated control; the measure is the pass condition of that control. Nothing here depends on a real tenant (section 8.6 lists what does).

| ID | Outcome | Measure | Control |
|---|---|---|---|
| SC-B-001 | A stranger cannot use or learn anything from an unconfigured panel (US-B1) | 100 % of setup and connection routes refuse as FR-B-202 says for every cookie state; the setup-token canary is absent from 100 % of captured logs, audit rows, responses, HTML shells and database files; the lock engages after 5 failures and refuses a correct token while locked | `server/setup/gate.test.ts`, `server/setup/token.test.ts`, `server/setup/unlock-rate.test.ts`, `server/no-leak.test.ts` |
| SC-B-002 | The wizard configures the simulated tenant end to end (US-B2) | A clean run against the fake tenant ends in `awaiting_first_signin` with every proof-list row green or an expected warning; the fake tenant records at most 11 mutating calls | `e2e/setup-wizard.spec.ts`, `server/setup/verify.test.ts` |
| SC-B-003 | The wizard is idempotent and resumable (US-B3) | A second run records 0 mutating calls; after fault injection at each mutating call of the clean run (at least 11 injection points, all of them) the final tenant and setup state equal the uninterrupted run | `server/setup/idempotency.test.ts`, `server/setup/resume.test.ts` |
| SC-B-004 | The wizard locks and the configuration survives (US-B4, brief criteria 1 and 2) | After the designated Owner signs in, 100 % of `/setup*` and `/api/v1/setup/*` requests answer the standard 404 with the body and headers of an unknown path; after a restart the same holds and the pinned tenant, certificate and assignments are unchanged | `server/setup/lock.test.ts`, `server/setup/complete-on-signin.test.ts`, `e2e/setup-lock.spec.ts` |
| SC-B-005 | Sign-in accepts exactly the right tokens (US-B5) | All 45 fixtures of Appendix C end with the stated redirect, audit entry and session outcome; the success fixtures create exactly one session each and every other fixture creates none | `server/auth/callback.test.ts`, `server/integrations/identity/id-token.test.ts`, `server/auth/mfa-check.test.ts` |
| SC-B-006 | Enforcement is correct and has no gaps (US-B6, brief criterion 11) | The policy matrix (15 permissions x actor kinds x resource cases) equals table 6.9.4; the seeded property tests of `computeGrants` and `canGrant` run at least 20,000 cases each without a counterexample; every guard that has a negative control fails when the control is applied | `server/policy-matrix.test.ts`, `shared/rbac-effective.test.ts`, `shared/rbac-covers.property.test.ts` |
| SC-B-007 | The last Owner cannot be removed, also under a race (US-B6) | 100 repetitions of two Owners removing each other in parallel leave exactly one Owner every time | `server/rbac/last-owner.concurrency.test.ts` |
| SC-B-008 | Group-derived rights are timely and fail closed (US-B7) | With a fake clock the next request after `GROUP_CACHE_TTL_SECONDS` drops rights of a removed member; a Graph failure never grants group rights; chunking is correct at 20, 21 and 45 ids; one unknown group id does not hide the others | `server/rbac/membership.test.ts`, `server/auth/revalidate.test.ts`, `server/rbac/overage.test.ts` |
| SC-B-009 | Sessions behave (US-B8) | Idle and absolute expiry fire within 1 second of the configured instant on the fake clock; rotation invalidates the old id; sign-out everywhere removes every session of that principal and no other; a step-up route answers 403 until fresh | `server/auth/session-store.test.ts`, `server/auth/rotation.test.ts`, `server/auth/step-up.test.ts`, `e2e/session-timeout.spec.ts` |
| SC-B-010 | Break-glass restores access and nothing else (US-B10) | The only successful write of a break-glass session is `restore-owner`; unconfigured, the route answers the standard 404; the 6th failure inside 15 minutes answers 429 | `server/auth/break-glass.test.ts`, `server/rbac/restore-owner.test.ts` |
| SC-B-011 | Secrets are sealed and rotatable (US-B11) | The certificate private key never appears in clear in any file under the data directory or any outbound request body after a full run; `rotate-app-key` is all-or-nothing and idempotent; a wrong `APP_KEY` yields the degraded state, not a crash | `server/secrets/no-plaintext.test.ts`, `server/secrets/rotate.test.ts`, `server/secrets/degraded.test.ts` |
| SC-B-012 | A Phase A volume upgrades without loss | The upgrade test seeded with branding, assets and a preview-actor audit chain ends with the Phase B snapshot, an empty `foreign_key_check`, an intact branding row and a verifying audit chain | `server/migrations.upgrade.test.ts` |
| SC-B-013 | No secret leaks anywhere | After a full run (wizard, sign-ins, rotation, break-glass) the canaries for the app key, setup token, private key, bootstrap tokens, authorization code, `state`, ID token, session id and break-glass password produce 0 hits in logs, audit, responses, shells and data files | `server/no-leak.test.ts`, `server/logging.test.ts` |
| SC-B-014 | The new UI meets the quality bar | Zero axe violations on every new route and wizard state in light and dark at both viewport sizes; the wizard, sign-in error page and Settings pages are completable by keyboard alone; visual baselines exist for every listed state; Lighthouse is at least 95 on the three public routes (SHOULD) | `e2e/a11y.spec.ts`, `e2e/keyboard.spec.ts`, `e2e/visual.spec.ts` |
| SC-B-015 | Phase A is not lost | Every Phase A test and e2e spec still runs against the real sign-in (migrated, none deleted); the headers test fails when a Microsoft host is added to `connect-src` | `quality`, `e2e`, `server/security-headers.test.ts` |
| SC-B-016 | The image still works and is still small | The extended image smoke test passes under a read-only root filesystem (CLI commands, certificate creation, unlock, restart persistence); the size is at or below the re-measured ceiling | `image` job |
| SC-B-017 | The owner can test without guessing | The Phase B report holds a checklist with one procedure and one result field for every item of the owner-verified ledger (8.6) and a row for every decision ODB-01 to ODB-15; every Microsoft claim in the spec has a source or a U row | review (FR-B-712), `server/docs-contract.test.ts` |

### 7.2 Mapping to the brief's acceptance criteria (brief section 8)

"Full" means Phase B can satisfy the criterion on its own; "partial" names what is left; "prepared" means Phase B only creates preconditions. Whatever needs the real tenant is an owner-verified item of 8.6.

| # | Criterion (short) | Phase B | Automated in B | Owner-verified |
|---|---|---|---|---|
| 1 | Empty volume shows the wizard; app registration, certificate, permissions and Exchange role are present in the tenant afterwards | Full for the product, simulated for the tenant | SC-B-001 to SC-B-003, SC-B-016 | OV-01 to OV-06 prove the objects exist in a real tenant |
| 2 | After a restart the configuration is kept and the wizard is unreachable | Full (the wizard locks at the first Owner sign-in, BCB-02) | SC-B-004 | OV-18 |
| 3 | Add and remove a user to a group and to an existing distribution list | Prepared: `GraphClient` reads, `checkMemberGroups`, the permission set including `GroupMember.ReadWrite.All`, `ExchangeClient` interface and read adapter; routes and Exchange writes are C and D (ODB-01) | none | none in B |
| 4 | Create, edit and delete a mail contact | Prepared: interface only; D (ODB-01) | none | none in B |
| 5 | All writes in the audit log; no secrets in logs or repository | Partial: every Phase B write and every denial is audited and secret-free; C and D add theirs | SC-B-013, `server/audit-b-coverage.test.ts` | none |
| 6 | CI green | Partial: new steps live in existing jobs | `quality`, `e2e`, `image` | none |
| 7 | Lighthouse at least 95 on all main pages; axe without serious findings | Partial: new routes included | SC-B-014 | authenticated Lighthouse is reported, not gated |
| 8 | Security headers A+; signed image, SBOM, provenance | Partial: headers unchanged for new routes; release pipeline is Phase A | SC-B-015 | external scanner on the deployed URL |
| 9 | Light, dark, mobile visually checked | Partial: baselines for new routes | SC-B-014 | owner looks |
| 10 | Branding survives restart, malicious SVG refused | Phase A, kept green behind real sign-in | SC-B-015 | none |
| 11 | RBAC: Reader cannot write (403 and audit); scoped user sees and changes nothing else; no role means no sign-in even for a Global Administrator; last Owner protected; no escalation | Full for model, enforcement, sign-in, audit; scoped access on real group routes at policy level (HTTP flows C) | SC-B-005 to SC-B-008 | OV-15, OV-16 |
| 12 | *Bestuur* can create a contact and change members of the assigned list; the rest is refused server-side | Partial: template data and policy-level enforcement (matrix, scopes); HTTP flows D | SC-B-006, `server/rbac/templates.test.ts` | none in B |
| 13 | CSV export of a list opens in Excel and imports in Laposta; formula-safe; audited; only with the export permission | Prepared: permission `distributionlists:export`, audit vocabulary, member read on the Admin API path; export is D | none | none in B |

---

## 8. Microsoft facts, permissions and the owner-verified ledger

Status words: **re-read** (search excerpt or page read again on 2026-10-10 while writing this spec), **carried** (read for `research-microsoft-b.md` or `research-microsoft.md` the same day and not re-read; the research section is given), **UNVERIFIED** (Learn does not state it; section 8.5). Excerpts are not full-page reads; where an excerpt was the only source the row says so.

### 8.1 What was read, and what it changed

| Topic | Learn page | Status | What it settled or changed |
|---|---|---|---|
| `checkMemberGroups` permissions and shape | https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0 | re-read (excerpt) | For `POST /users/{id or userPrincipalName}/checkMemberGroups` the application least privilege is `User.ReadBasic.All` and `GroupMember.Read.All`; `User.Read.All` and `GroupMember.Read.All` is listed as a higher combination. The generic `POST /directoryObjects/{id}/checkMemberGroups` form lists `Directory.Read.All`. Up to 20 group ids per request. Hidden-membership groups are omitted unless the app holds `Member.Read.Hidden`. `/me` is delegated only. Decides FR-B-311 (user form, 20 per call) and B-01 (no `Directory.Read.All`). |
| Transitive memberships of a user | https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof?view=graph-rest-1.0 | re-read (excerpt) | Application least privilege `User.Read.All`; `Group.Read.All` and `GroupMember.Read.All` are higher. Without a group read permission the group objects come back with limited information (id and type). `$filter`, `$search` and OData cast need `ConsistencyLevel: eventual` and `$count`. Page size 100 by default, 999 at most. Phase C displays group membership with this call. |
| Direct memberships of a user | https://learn.microsoft.com/en-us/graph/api/user-list-memberof?view=graph-rest-1.0 | re-read (excerpt) | Application least privilege `Directory.Read.All`. This is why `memberOf` is not used (B-01). |
| Get group, list groups | https://learn.microsoft.com/en-us/graph/api/group-get?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/api/group-list?view=graph-rest-1.0 | re-read (excerpt) | `GroupMember.Read.All` is listed for both; the least-privileged column names an unrelated write permission (`Group-NestingSupport.ReadWrite.All`) and is not used as guidance. No evidence that `Group.Read.All` is needed (B-01); returned properties are U36, `$filter` use is U37. |
| Get organization | https://learn.microsoft.com/en-us/graph/api/organization-get?view=graph-rest-1.0 | re-read (excerpt) | Application least privilege `Organization.Read.All`; with only `User.Read` just `id`, `displayName` and `verifiedDomains` are readable. |
| Get user, list users | https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0 | re-read (excerpt) | Application least privilege `User.Read.All` for both; reading and writing `accountEnabled` needs `User.EnableDisableAccount.All` plus `User.Read.All`, so reading it needs `User.Read.All`. |
| Add and remove group members | https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/api/group-delete-members?view=graph-rest-1.0 | re-read (excerpt) | Application `GroupMember.ReadWrite.All` for group and user members. Adding an organisational contact also needs `OrgContact.Read.All`. Role-assignable groups also need `RoleManagement.ReadWrite.Directory`, which the runtime application never gets (FORBIDDEN_APP_ROLES). |
| Create group | https://learn.microsoft.com/en-us/graph/api/group-post-groups?view=graph-rest-1.0 | re-read (excerpt) | Application least privilege `Group.Create`; creating a group with user members also needs `User.Read.All`. Group creation is dropped from the wizard (BCB-01). |
| Permissions reference | https://learn.microsoft.com/en-us/graph/permissions-reference | re-read (excerpt) | `GroupMember.Read.All` (application id `98830695-27a2-44f7-8c18-0c3ebc9698f6`): "memberships and basic group properties". `Group.*` permissions also grant access to Microsoft 365 group content (conversations, files). Directory permissions carry the caution "choose permissions specific to these resources and avoid using directory permissions". Settles the delta of 8.2. |
| Group types in Graph | https://learn.microsoft.com/en-us/graph/api/resources/groups-overview?view=graph-rest-1.0 | re-read (excerpt) | Distribution groups (`groupTypes` empty, `mailEnabled` true, `securityEnabled` false) and mail-enabled security groups are read-only through Graph; dynamic distribution groups are not supported. Graph is therefore at most a read path for distribution lists (whether it returns them to our application is U36); writing members needs Exchange (Appendix A). |
| Exchange module platform support | https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps | re-read (excerpt) | Linux support is listed for Ubuntu LTS releases; module 3.10.0 or later needs PowerShell 7.6.0 or later; behind a proxy on Linux the module must be 3.0.0 or later. Feeds Appendix A. |
| App-only Exchange PowerShell | https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2?view=exchange-ps | re-read (excerpt) | `Exchange.ManageAsApp` on "Office 365 Exchange Online" (application permission, admin consent required); `-Organization` takes the primary `.onmicrosoft.com` domain; the Microsoft 365 group cmdlets do not work unattended. |
| App registration, service principal, redirect URIs, certificate credential | research §2.1 to §2.6 (application-post-applications, serviceprincipal-post-serviceprincipals, reply-url, applications-how-to-add-certificate, certificate-credentials, keycredentialconfiguration) | carried | `signInAudience` explicit; certificate at most one year from `startDateTime`; `customKeyIdentifier` left to Entra; `PATCH keyCredentials` replaces the collection; `addKey` needs proof of possession (not in B); `http://localhost` only, port ignored, no `127.0.0.1`; app management policy can cap lifetime. FR-B-103, FR-B-106, FR-B-303, FR-B-306. |
| Granting application permissions and the Entra role | research §3 and §4 (permissions-grant-via-msgraph, serviceprincipal-post-approleassignedto, rbacapplication-post-roleassignments) | carried | `appRoleAssignedTo`; role ids resolved at run time; Exchange Administrator template id `29232cdf-9323-42fd-ade2-1d097af3e4de`; role propagation delay not stated (U4). FR-B-302, FR-B-307, FR-B-308. |
| Device code, Conditional Access | research §5 (v2-oauth2-device-code, policy-block-authentication-flows, managed-policies) | carried | Three scopes; MSAL adds OIDC scopes; the flow block applies to every client. FR-B-214, FR-B-217, FR-B-218. |
| Authorization code flow, ID token, keys | research §6 (v2-oauth2-auth-code-flow, v2-protocols-oidc, id-tokens, id-token-claims-reference, signing-key-rollover) | carried | `response_mode=query`; no `offline_access`; key cache rules; `post_logout_redirect_uri` must be registered; `max_age` undocumented. FR-B-402 to FR-B-412. |
| `amr`, `auth_time`, groups claim | research §7 and §8 (optional-claims-reference, id-token-claims-reference) | carried | `amr` values table; `mfa` for every MFA method; `groups` claim dropped over 200 entries. FR-B-405, FR-B-507. |
| Exchange Admin API (Preview) | research §9 (admin-api-overview, admin-api-get-started, admin-api-authentication, admin-api-endpoints-reference and the endpoint pages) | carried | Six POST-only endpoints; `X-AnchorMailbox` mandatory; `Exchange.ManageAsAppV2`; no distribution list writes, no contacts. FR-B-314, Appendix A. |
| Throttling and replication | research §10 (throttling-limits, 404-not-found-error-manage-objects-microsoft-graph) | carried | Identity and access limits; `Retry-After`; replication "several minutes". FR-B-212, FR-B-312. |

### 8.2 Runtime Graph permissions (decision B1) and the delta against the brief

The runtime application is granted application permissions only. Column "Held" refers to the set `GRAPH_APP_ROLES` version 1 of FR-B-301.

| Operation (client method, phase) | Call | Least-privileged application permission on Learn | Held |
|---|---|---|---|
| `getOrganization`, verification V2 (B) | `GET /organization` | `Organization.Read.All` | yes |
| `probeUsers`, verification V3 (B) | `GET /users?$top=1&$select=id` | `User.Read.All` | yes |
| `getUser`, revalidation, assignment validation (B) | `GET /users/{id or userPrincipalName}` with `accountEnabled` | `User.Read.All` | yes |
| `checkMemberGroups` at sign-in (B) | `POST /users/{id}/checkMemberGroups` | `User.ReadBasic.All` plus `GroupMember.Read.All` (higher: `User.Read.All` plus `GroupMember.Read.All`) | yes (`User.Read.All`, `GroupMember.Read.All`) |
| `getGroup`, `searchGroups` (B, wizard step 5 and assignment validation) | `GET /groups/{id}`, `GET /groups?$filter=...` | `GroupMember.Read.All` is listed; properties and filter behaviour U36, U37 | yes (`GroupMember.Read.All`) |
| group display of a user (C) | `GET /users/{id}/transitiveMemberOf` | `User.Read.All` (higher: `GroupMember.Read.All`, `Group.Read.All`) | yes |
| add and remove group members (C) | `POST /groups/{id}/members/$ref`, `DELETE /groups/{id}/members/{id}/$ref` | `GroupMember.ReadWrite.All` | yes, granted in B and unused until C (ODB-02) |
| add an organisational contact to a group (C or D, if wanted) | as above | `GroupMember.ReadWrite.All` plus `OrgContact.Read.All` | no (decision in C) |
| create the administrators group (dropped) | `POST /groups` | `Group.Create` | no (BCB-01) |
| direct memberships (not used) | `GET /users/{id}/memberOf` | `Directory.Read.All` | no |

Delta against the five permissions of brief section 3:

| Brief permission | Phase B | Reason |
|---|---|---|
| `User.ReadWrite.All` | replaced by `User.Read.All` | Phase B and C read users; no user write is planned (brief section 4 lists reading and group membership only). A later write need is a new decision with its own evidence. |
| `Group.ReadWrite.All` | dropped | Its only planned use was creating the administrators group (BCB-01); membership writes need `GroupMember.ReadWrite.All` on Learn; `Group.*` also opens group content (conversations, files). |
| `GroupMember.ReadWrite.All` | kept | Membership writes of Phase C; granted in B so that the owner's one consent covers it (ODB-02 offers deferral). |
| `Directory.Read.All` | dropped | Learn: avoid directory permissions where resource-specific ones exist; the sign-in lookup works with `User.Read.All` plus `GroupMember.Read.All`; `memberOf`, the only call found that needs it, is replaced by `transitiveMemberOf`. Re-add only with a call that is proven to need it. |
| `Organization.Read.All` | kept | Verification and tenant display name. |
| (new) `GroupMember.Read.All` | added | Read side of group membership; listed for `checkMemberGroups`, `getGroup`, `transitiveMemberOf`. |
| (new) `User.Read.All` | added | Replaces `User.ReadWrite.All`. |

Result: four permissions instead of five; three of the brief's five removed or narrowed, two added. `Group.Read.All` and `Directory.Read.All` are not granted because no call is proven to need them (the default of B1). Never granted to the runtime application: `RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All`, `Application.ReadWrite.All` (`FORBIDDEN_APP_ROLES`). Exchange: `Exchange.ManageAsApp` (required), `Exchange.ManageAsAppV2` (when exposed), Entra role Exchange Administrator (B-03, ODB-03).

### 8.3 What the wizard asks the administrator for (decision B4)

| Item | Value | Source |
|---|---|---|
| Delegated scopes of the bootstrap token | `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`; `Directory.Read.All` is not needed by any call | research §2.5, §5.3 |
| Administrator account | Global Administrator, or Privileged Role Administrator plus Application Administrator or Cloud Application Administrator (or Application Developer when members may register applications) | research §2.5, §11.1 |
| Consent | per user, not "on behalf of your organization"; the consent of Microsoft's client remains visible in the tenant after the wizard and the finish page says where to review it | research §5.4 |
| Authority | tenant id or domain when known, otherwise `organizations`; never `common` or `consumers`; guests must give the tenant | research §5.5 |

### 8.4 Facts the sign-in and Exchange design rests on

| Fact | Value | Source and status |
|---|---|---|
| Authorize request | tenant-specific authority, `response_type=code`, `response_mode=query`, `scope=openid profile`, S256 PKCE, `state`, `nonce`; `prompt=login` forces credentials; no `offline_access` | https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow, carried (research §6.1) |
| Code redemption | certificate assertion `PS256` with `x5t#S256`, claims `aud` (tenant token endpoint), `iss` = `sub` = client id, `jti`, `nbf`, `exp` within 10 minutes | https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials, carried (research §2.4); header details U21 |
| Keys | per tenant from the discovery document; cache by `kid` for 24 hours, refresh hourly and on an unknown `kid` at most every 5 minutes | https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover, carried |
| ID token checks | signature, `iss` (v2.0 form), `tid`, `aud` = client id, `nonce`, `exp`, `nbf`, `ver` 2.0; `oid` is the stable user key, `sub` is pairwise, `preferred_username`, `email` and `upn` are mutable | https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference, carried (research §6.4); tolerance U33, U35 |
| MFA evidence | optional claim `amr`; `mfa` is emitted for every MFA method of the Learn table; passwordless sign-in methods also carry `mfa`; `acr` exists only in v1.0 tokens | https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference, carried (research §7) |
| Step-up | `prompt=login` forces credentials but not MFA; `auth_time` is an optional claim; `max_age` and an ID-token `claims` request are not documented for Entra | carried (research §6.1, §6.5); U13, U27 |
| Sign-out | redirect to the tenant `end_session_endpoint` with a registered `post_logout_redirect_uri`, after the server session is gone; front-channel logout not used | https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc, carried (research §6.6); U29 |
| Redirect URIs | `https`, or `http://localhost` with the port ignored; `127.0.0.1` not registrable in the portal; no wildcards; `! $ ' ( ) , ;` refused | https://learn.microsoft.com/en-us/entra/identity-platform/reply-url, carried (research §2.2); acceptance by Graph U14 |
| Group claim limits | the `groups` claim holds at most 200 entries in a JWT, then `_claim_names` and `_claim_sources` appear; the panel ignores all of them | https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference, carried (research §8) |
| Exchange Admin API | six POST-only endpoints: `OrganizationConfig`, `AcceptedDomain`, `Mailbox`, `MailboxFolderPermission`, `DistributionGroupMember`, `DynamicDistributionGroupMember`; header `X-AnchorMailbox` mandatory; scope `https://outlook.office365.com/.default`; app role `Exchange.ManageAsAppV2`; Preview; no `Get-DistributionGroup`, no distribution group writes, no contacts | https://learn.microsoft.com/en-us/exchange/reference/admin-api-endpoints-reference, carried (research §9.1); terms U25 |
| Exchange Administrator role | template id `29232cdf-9323-42fd-ade2-1d097af3e4de`; "provides the required permissions for any task in Exchange Online PowerShell"; maps to Organization Management | https://learn.microsoft.com/en-us/exchange/permissions-exo/permissions-exo, carried (research §4) |
| Graph throttling | `429` with `Retry-After`; identity-and-access limits shared by users, groups, applications and service principals; `checkMemberGroups` costs 4 resource units; `x-ms-throttle-priority` | https://learn.microsoft.com/en-us/graph/throttling-limits, carried (research §10.1) |

### 8.5 UNVERIFIED register (U34 and up are new in this document; copy to `docs/open-points.md`, date 2026-10-10)

| # | Claim | Where used | Tried | Needed to close |
|---|---|---|---|---|
| U34 | The `docker exec` command `/nodejs/bin/node /app/dist/cli.js <command>` works in the distroless image | FR-B-110, US-B1, README | Phase A image layout from its plan | The image smoke test runs the printed command (FR-B-706) |
| U35 | Clock-skew values: Learn gives no tolerance for ID-token timestamps and none for the host clock against Entra; the 60 s tolerance and the 60 and 300 s thresholds are our choices | FR-B-213, FR-B-404 | id-tokens and signing-key-rollover pages | OV-07 and OV-23 show real skew; the numbers are constants |
| U36 | Which properties (`id`, `displayName`, `groupTypes`, `mailEnabled`, `securityEnabled`) `GET /groups/{id}` returns to an application that holds `GroupMember.Read.All` and not `Group.Read.All`; the permission is listed for Get group and described as "basic group properties"; and whether `GET /groups` returns distribution groups to such an application (Learn calls them read-only in Graph) | FR-B-311, FR-B-219, Phase C and D (recognising and listing distribution lists) | group-get, group-list, permissions reference (excerpts) | OV-19 |
| U37 | `GET /groups?$filter=startswith(displayName,'...')` works for an app-only caller without `ConsistencyLevel: eventual` | FR-B-311, FR-B-219 | group-list excerpt | OV-19; fallback: send `ConsistencyLevel: eventual` and `$count=true` |
| U38 | `checkMemberGroups` with a well-formed id of a group that does not exist or was deleted: the whole call fails, or the id is omitted | FR-B-507 | the page states that one malformed id fails the request and is silent on unknown ids | OV-16; the bisect fallback of FR-B-507 handles both |
| U39 | Browser handling of `SameSite=Strict` cookies set by and sent after a redirect chain started by a cross-site navigation, and of cookies on `http://localhost` (shared across ports, `Secure` omitted) | FR-B-401, FR-B-412 | reasoning from the cookie specification, not Learn | OV-14 |
| U40 | Option names of `jose` 6.2.12 for remote key sets (cache duration, cooldown) | FR-B-404 | stack probe pins the version | the unit test `server/auth/jwks-cache.test.ts` pins the behaviour when the code is written |
| U41 | Whether Node 22 honours `NODE_USE_ENV_PROXY` for `fetch`, and from which minor | EB-31 | none | image smoke test behind a proxy, or the owner's own proxy |
| U42 | A `WWW-Authenticate` challenge with the scheme `Cookie` (RFC 9110 expects a challenge with 401; the scheme is not a registered one) | FR-B-414 | RFC text only | none; low risk, documented |
| U43 | Host names of the `verification_uri` Entra returns for the device-code flow; the allow-list (`microsoft.com`, `www.microsoft.com`, `login.microsoft.com`, `login.microsoftonline.com`) is ours | FR-B-214 | research §5.1 (response shape only) | OV-01 shows the real host; the allow-list is a constant |
| U44 | Whether the Admin API `OrganizationConfig` endpoint accepts `$select`, and which properties it returns | FR-B-309 V5, FR-B-314 | endpoint reference lists `Get-OrganizationConfig` without parameters | OV-06 |

Carried from the two research files and relied on by this spec (status unchanged): U13 and U27 (`max_age`, ID-token `claims`; FR-B-402, FR-B-411), U14 (Graph accepts `http://localhost` redirect URIs; FR-B-103), U18 (`uniqueName` upsert permissions; FR-B-304), U19 (credential lifetime enforcement and policy refusal text; FR-B-306, EB-10), U20 (RSA sizes; FR-B-106), U21 (`x5t` versus `x5t#S256`; FR-B-112), U22 (`slow_down`; FR-B-214), U23 (consent UI; OV-01), U24 (client existence and Conditional Access error; EB-04), U25 (Admin API production terms; FR-B-314), U26 (module on arm64 and Debian; Appendix A), U29 (logout parameters; FR-B-410), U30 (consent for OIDC-only scopes; FR-B-419), U31 (duplicate grant behaviour; FR-B-307, FR-B-308), U32 (replication error codes; FR-B-212), U33 (`alg` values; FR-B-404); U4, U5 and U6 (role propagation, narrower roles, `ManageAsApp` versus `ManageAsAppV2`; OV-06, ODB-03). Closed: U16.

### 8.6 Owner-verified ledger (the owner's test plan; none of these is covered by an automated control)

Procedures are short; the Phase B report expands each into a checklist line with a result field and the date. "Fail means" tells the owner what a failure changes in this spec.

| ID | What the owner checks | Procedure and expected result | Fail means |
|---|---|---|---|
| OV-01 | Device-code consent screen with the three scopes | Run step 2 with a Global Administrator, then with Privileged Role Administrator plus Application Administrator. Consent screen lists the three scopes; "Consent on behalf of your organization" appears only for the first; leaving it off works. Note the host of the verification link (U43). | Adjust the wizard text; extend the host allow-list; U23 stays open |
| OV-02 | Device code allowed, or the Conditional Access message and manual mode | In a tenant with the managed "Block device code flow" policy (or after adding such a policy): step 2 names Conditional Access (`AADSTS53003`) and offers manual mode; the manual checklist then completes the setup. | Reword EB-04; fix the manual checklist (FR-B-218) |
| OV-03 | Graph accepts what the wizard sends | Application with the `http://localhost` and https redirect URIs, `amr` and `auth_time` optional claims, a 360-day credential, tags; with an app management policy if the tenant has one (U14, U19, U20). | Change the body (FR-B-303), lifetime or key size (FR-B-106) |
| OV-04 | First client-credentials token with the uploaded self-signed certificate | Verification V1 succeeds with `x5t#S256` only; if it fails with `AADSTS700027`, set the documented fallback of FR-B-112 and rerun (U21). | Switch the `x5t` fallback on by default |
| OV-05 | The four application permissions are effective | V2 and V3 pass; record the delay between the grant and the first success. | Adjust the window of FR-B-212 |
| OV-06 | Exchange role propagation and the Admin API probe | Record the delay between the role assignment and the first 200 of V5; note whether the preview API is available; note which `OrganizationConfig` fields return (U44). Optional Exchange Recipient Administrator experiment of ODB-03. | Window and wording of EB-09; ODB-03 |
| OV-07 | A real ID token | Inspect the owner's own token claims (decode locally): `amr` values per method, `tid`, `oid`, no `groups`, `ver` 2.0, header `alg`, `auth_time`; observe `prompt=login`; observe whether `max_age` is ignored (U13, U27, U33, U35). | `AUTH_MFA_AMR_VALUES` default, step-up rule, tolerance |
| OV-08 | A user in more than 200 groups and nested groups | Sign in as that user with a role bound to a nested group: the role applies through `checkMemberGroups`. | FR-B-507 |
| OV-09 | Sign-out round trip | Sign out: land on `/auth/logged-out` then `/signin?signedout=1`; no front-channel URL registered; behaviour with an existing primary refresh token (U29). | FR-B-410 |
| OV-10 | Real throttling | Cannot be forced; if a `429` occurs, read `docs/operations.md` log events and compare with FR-B-312. | Retry values |
| OV-11 | Security Defaults tenant | The wizard works for an administrator; a non-administrator *Lezer* signs in with and without `mfa` in `amr` (EB-27). | EB-27 text; ODB-04 |
| OV-12 | Non-administrator with a panel role on a tenant with user consent disabled | Sign-in either works or ends in `consent_required`; the consent link of FR-B-419 fixes it (U30). | FR-B-419 (SHOULD) |
| OV-13 | Exchange write-path experiment (informs ODB-01, ODB-03) | On the owner's machine, with a throwaway application, certificate and Exchange Administrator assignment made by hand following Learn's app-only article (the panel's sealed key is never exported): `Connect-ExchangeOnline` with that application, `Get-DistributionGroup -ResultSize 1`, `Add-DistributionGroupMember` and `Remove-DistributionGroupMember` on a test list, then the same with Exchange Recipient Administrator instead of Exchange Administrator (U4 to U6). The report records which role suffices. Not a Phase B feature. | Appendix A recommendation |
| OV-14 | Browsers and `SameSite` | Sign in with Chrome, Firefox and Safari on `https://` and on `http://localhost:<port>`: the first paint after the interstitial shows the signed-in persona; sign-out and re-sign-in work; no `securitypolicyviolation` (U39). | FR-B-401, FR-B-412 (B-07) |
| OV-15 | Global Administrator without a panel role | Sign in with such an account: "geen toegang" page with a reference id, no session, an `auth.signin` denied entry `no_role`. | FR-B-506 |
| OV-16 | Revocation timing of group-derived rights | Remove the user from the bound Entra group: rights vanish at the next request after `GROUP_CACHE_TTL_SECONDS`; record how long Graph needs to reflect the change; also delete a bound group and confirm others still resolve (U38). | Default TTL (ODB-10); FR-B-507 |
| OV-17 | Break-glass | Generate the hash with `hash-password`, configure it, sign in: red banner, 30-minute limit, only "Eigenaar herstellen" works; the audit shows `breakglass.signin`. | FR-B-521 to FR-B-523 |
| OV-18 | Restart and lock | After the first Owner signed in, restart the container: `/setup` answers 404, sign-in still works, the certificate opens with the same `APP_KEY`; remove `APP_KEY` and see the degraded state and the readable explanation. | FR-B-207, FR-B-108 |
| OV-19 | Group picker and group properties | In wizard step 5 search groups by prefix; group properties include `groupTypes`, `mailEnabled`, `securityEnabled` with only `GroupMember.Read.All` (U36, U37). | Add `Group.Read.All` (new decision), or send `ConsistencyLevel` |
| OV-20 | Tenant without Exchange Online | If the owner has such a tenant: Exchange sub-actions are skipped, step is warning, the panel works. Otherwise report "not tested". | EB-08 |
| OV-21 | Manual provisioning mode | Follow the checklist for a tenant (or after deleting the application): V1 to V3 and V5 pass; V4 and V6 show `not_checked`. | FR-B-218 |
| OV-22 | Repair against drift | Remove one permission and change the redirect URI by hand, then run "Herstel verbinding": only the drifted sub-actions change; no duplicate application or service principal appears. | FR-B-220 |
| OV-23 | Environment checks on the owner's host | Step 1 is green in the real container (network hosts, time skew within 60 s, key); behind a proxy, record what happens (U41). | EB-14, EB-31 |

### 8.7 Research rules R-01 to R-25 and where this spec satisfies them

`research-microsoft-b.md` section 13 proposed rules and file names. This spec took over the rule and, where the proposed path differs, kept the stronger or more specific control. The mapping keeps the two documents in agreement.

| Rule | Subject | Rows here | Control (research name, when different) |
|---|---|---|---|
| R-01 | Application body | FR-B-303 | `server/setup/provision-app.test.ts` |
| R-02 | Redirect URIs | FR-B-103 | `shared/redirect-uri.test.ts` |
| R-03 | Role ids at run time | FR-B-302 | `server/setup/resolve-app-roles.test.ts` |
| R-04 | Grant by `appRoleAssignedTo` | FR-B-307 | `server/setup/grant-roles.test.ts` |
| R-05 | Entra role assignment | FR-B-308 | `server/setup/assign-exchange-role.test.ts`, `server/setup/exchange-role.test.ts` |
| R-06 | Exact permission set | FR-B-301 | `server/setup/permission-set.test.ts`; set decided here (8.2) |
| R-07 | Public certificate only | FR-B-306, FR-B-107 | `server/setup/certificate.test.ts` |
| R-08 | Read back, then token | FR-B-306, FR-B-309 | `server/setup/verify-credential.test.ts` |
| R-09 | Device code | FR-B-214 | `server/setup/device-code.test.ts` |
| R-10 | Bootstrap token in memory | FR-B-215 | `server/setup/bootstrap-token-lifecycle.test.ts` |
| R-11 | AADSTS map | FR-B-217 | `server/setup/aadsts-map.test.ts` |
| R-12 | Fresh token for probes | FR-B-316 | `server/setup/propagation-probe.test.ts` |
| R-13 | Replication retry | FR-B-212 | `server/setup/replication-retry.test.ts` |
| R-14 | Propagation window | FR-B-212 | `server/setup/propagation-probe.test.ts` |
| R-15 | Graph throttling | FR-B-312 | `server/integrations/graph/http-retry.test.ts` (research: `server/graph-client.test.ts`) |
| R-16 | Authorize request | FR-B-402 | `server/auth/authorize-request.test.ts` |
| R-17 | Certificate assertion | FR-B-112 | `server/auth/client-assertion.test.ts` |
| R-18 | ID-token validation | FR-B-404 | `server/integrations/identity/id-token.test.ts` (research: `server/auth/id-token-validation.test.ts`) |
| R-19 | Key cache | FR-B-404 | `server/auth/jwks-cache.test.ts` |
| R-20 | MFA gate | FR-B-405 | `server/auth/mfa-check.test.ts` |
| R-21 | Identity key | FR-B-406 | `server/auth/identity-key.test.ts` |
| R-22 | Sign-out | FR-B-410 | `server/auth/logout.test.ts`, `e2e/auth-logout.spec.ts` |
| R-23 | Group resolution | FR-B-507 | `server/rbac/membership.test.ts`, `server/rbac/overage.test.ts` (research: `server/rbac/group-resolution.test.ts`) |
| R-24 | Exchange client confinement | FR-B-314 | `server/exchange/exchange-client-contract.test.ts` |
| R-25 | Consent link (SHOULD) | FR-B-419 | review plus `server/auth/consent-link.test.ts`; effect OV-12 |

---

## 9. Assumptions

B-01 to B-13 are the orchestrator's Phase B defaults (decisions B1 to B12 of its list, in order, with B-13 the out-of-scope list); each was challenged with the evidence of section 8 and is marked **kept**, **changed** (with the reason) or **clarified**. B-14 to B-26 are additions made while writing this spec. Each assumption gets one ADR in `docs/adr/` (FR-B-709); the plan assigns the numbers.

| ID | Assumption | Evidence and verdict | Rows |
|---|---|---|---|
| B-01 | Graph permission set: start from `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; add `Group.Read.All` or `Directory.Read.All` only if provably needed; never `RoleManagement.ReadWrite.Directory` for the runtime application | Kept. Learn lists `GroupMember.Read.All` for `checkMemberGroups` on users, Get group and List groups, and `User.Read.All` for `transitiveMemberOf`; no call was found that needs `Group.Read.All` or `Directory.Read.All` (8.1, 8.2). Open: U36, U37. Delta against the brief's five in 8.2 | FR-B-301, FR-B-311 |
| B-02 | `ExchangeClient` interface plus an adapter for the documented read path only (Admin API, Preview); the write path stays an owner decision with a memo | Kept. The Admin API has six POST-only endpoints and no distribution list or contact writes; `InvokeCommand` has no Learn page; the PowerShell module is the only documented write path (8.4, Appendix A) | FR-B-314, ODB-01 |
| B-03 | Exchange Administrator for the service principal by default; a narrower custom role group is a follow-up; the role is a setting | Kept. Learn states Exchange Administrator suffices "for any task"; whether narrower roles suffice for list and contact writes is UNVERIFIED (U5); experiment OV-13 | FR-B-308, ODB-03 |
| B-04 | Wizard user is Global Administrator, or Privileged Role Administrator plus an app-registration role; the wizard asks exactly the scopes its calls need | Kept. Three scopes cover every call; the brief's fourth (`Directory.Read.All`) is needed by none (8.3) | FR-B-214, BCB-04 |
| B-05 | Sign-in is the authorization code flow with PKCE, `state`, `nonce`, issuer, audience and `tid` validation and a certificate assertion; implemented with our own code client and `jose`, with MSAL used only for device code and client-credentials tokens | Kept. MSAL adds `offline_access`, `openid`, `profile`, `email` and caches per account (research §5.3); the panel needs no token retention and one assertion signer | FR-B-112, FR-B-402 to FR-B-404, FR-B-418 |
| B-06 | MFA is a configurable `amr` check; step-up uses `prompt=login` plus a claims or `max_age` check | Changed. `max_age` and an ID-token `claims` request are undocumented for Entra (U13, U27) and `prompt=login` does not force MFA; step-up is `prompt=login`, a fresh `auth_time`, the same `oid` and the MFA policy again; no `max_age`, no `claims` | FR-B-405, FR-B-411 |
| B-07 | Sessions are server-side, hashed, in SQLite, with rotation, idle and absolute timeouts, sign-out everywhere and session-bound CSRF; the cookie is `__Host-` only on https, plain `HttpOnly`/`SameSite=Strict` on `http://localhost`; the OIDC transaction cookie is `Lax` | Kept, with two consequences: `response_mode=query` (a `form_post` callback is a cross-site POST that a Lax cookie does not accompany) and a 200 interstitial instead of a 303 after the callback so the Strict cookie reaches the first paint (U39). Phase A BC-03 already accepts the plain names on `localhost` | FR-B-401, FR-B-407, FR-B-408, FR-B-412 |
| B-08 | Libsodium XChaCha20-Poly1305 seals the certificate key; the key comes from `APP_KEY` or `APP_KEY_FILE`; a rotation procedure exists; the bootstrap token lives in memory only | Kept, with a derived per-purpose subkey, a key id and additional data that binds blob to row, purpose and key | FR-B-104 to FR-B-110, FR-B-215 |
| B-09 | A one-time setup token (`SETUP_TOKEN` or a 0600 file, never logged) protects the unconfigured panel; the wizard locks when `setup_completed` and answers 404 afterwards | Changed. The lock engages at the first successful sign-in of the designated first Owner, not at "finish": a failed first sign-in (wrong redirect URI, blocked MFA) would otherwise lock the owner out of the tenant they just configured (BCB-02). If that person never signs in, the state stays open and the token still guards it (documented). `setup-reopen` is the recovery | FR-B-201, FR-B-203, FR-B-207, FR-B-219, FR-B-222, ODB-05 |
| B-10 | The wizard is persisted, idempotent and resumable with per-step status, rollback hint, live log, retry and backoff | Kept. The live log is polled (1 s, 2 s in a hidden tab), not streamed, because intermediaries buffer event streams. Graph replication takes "several minutes" (research §10.2) | FR-B-208 to FR-B-212 |
| B-11 | RBAC: the 15-permission catalogue is unchanged; five immutable built-in roles; *Bestuur* as template data; effective permissions are the union of assignments; scopes; default deny | Clarified. The brief does not say what a scope restricts when a role mixes resource types. Scopes restrict per resource type; permissions without a resource type (settings, audit, RBAC) come only from unscoped assignments; `users:read` has the qualifier `basic` so *Bestuur* can read names and e-mail (BCB-09, BCB-10) | 6.5, FR-B-501 to FR-B-513 |
| B-12 | `GraphClient` (MSAL certificate auth, `Retry-After`, jitter, short-TTL cache, typed errors) is built on a thin own HTTP layer behind interfaces; the Microsoft Graph SDK is not added | Kept. The runtime client calls six Graph endpoints (8.2); the brief asks for no unnecessary dependencies; the retry rules are small and testable | FR-B-311 to FR-B-313, FR-B-711 |
| B-13 | Not in Phase B: users and groups screens (C), distribution lists, contacts, CSV (D), RBAC admin UI (D), audit UI (D), OpenTelemetry (D), Bicep (D) | Kept | 1.1 |
| B-14 | Retry values: transient 1 s to 30 s, at most 6 tries; replication 2 s to 60 s with a 300 s window; role-to-token propagation 900 s by default, 3,600 s at most | Changed from an earlier draft (600 s): Learn names no delay for Entra role to Exchange (U4), so the default is the research window | FR-B-212 |
| B-15 | Group membership comes from `checkMemberGroups` in chunks of 20 at every sign-in and at the cache TTL (300 s); the token's `groups` claim is ignored; Graph failure keeps direct grants and drops group grants | Kept. Learn: at most 20 ids per request; the `groups` claim is dropped over 200 entries (8.4) | FR-B-409, FR-B-507 |
| B-16 | The principal is `(tid, oid)`; the first Owner is the bootstrap administrator's `oid` plus `tid`, never `sub`; in manual mode the operator names the Owner | Kept. `oid` is the same across applications, `sub` is pairwise (research §5.5) | FR-B-216, FR-B-219, FR-B-406 |
| B-17 | Break-glass is decided for Phase B (the brief allows B or D): an optional env-configured account that can only restore an Owner | Kept at B. Without it a deleted Owner group or a lost MFA device locks the panel; the env-only design needs no UI and costs one route and one session kind | FR-B-521 to FR-B-523, ODB-06 |
| B-18 | `PREVIEW_MODE` is removed; actor kinds are `anonymous`, `user`, `setup`, `break_glass`; anonymous writes now answer 401 instead of Phase A's 403 | Kept. Phase A FR-A-032 promised removal; RFC 9110 expects a challenge with 401 (U42) | FR-B-102, FR-B-413, FR-B-414 |
| B-19 | A small X.509 library, chosen by a plan-time probe (candidate `@peculiar/x509`), creates the certificate | Added. `node:crypto` parses certificates and cannot create them (checked on Node 22.22); the distroless image has no `openssl` | FR-B-106, FR-B-711 |
| B-20 | Simulation: MSW with `onUnhandledFrame: 'error'` for HTTP; an in-process fake identity provider signing with `jose`; e2e starts the production bundle with request interception installed before it loads; no production file knows the fake | Kept (brief section 7) | FR-B-707, FR-B-708 |
| B-21 | Denials are audited for writes by any actor and for permissioned reads of authenticated actors; anonymous reads (401) and 429 are not audited | Changed (extends Phase A PA-15): the brief says every refused action (403) is audited; anonymous probing is attacker-reachable volume | FR-B-602, ODB-12 |
| B-22 | The certificate is RSA 2048 with 360 days validity; renewal in Phase B is the repair flow (full-list `PATCH`); self-rotation by `addKey` is Phase D; banners at 60 and 14 days | Changed against the brief's silence on lifetime: Learn caps a credential at one year from its start date; `addKey` needs proof of possession of a valid key (research §2.4); RSA size U20 | FR-B-106, FR-B-111, FR-B-220, ODB-08 |
| B-23 | A manual provisioning mode exists as a SHOULD | Added. The managed "Block device code flow" policy applies to every client and is enabled by default after a 30-day report-only period (research §5.6) | FR-B-218, ODB-07 |
| B-24 | Callback failures before the ID token is validated are not audited; failures from validation on are | Added. Earlier failures are unauthenticated and attacker-reachable; the `auth` rate class bounds the volume | FR-B-403 |
| B-25 | Session numbers: idle 30 minutes, absolute 8 hours, at most 10 sessions per principal, step-up window 10 minutes, break-glass 30 minutes, setup session 60 minutes and 8 hours | Added. The brief gives none and no source fixes them; `docs/security.md` documents the choice | FR-B-407, FR-B-411, FR-B-522, ODB-09 |
| B-26 | One replica on local disk (Phase A A-57): login transactions, setup sessions, rate and unlock counters live in memory and are lost at restart | Added. After a restart users sign in again and the wizard needs the token again; no security property depends on persistence; a shared store is out of scope | FR-B-204, FR-B-205, FR-B-402 |

---

## 10. Conflicts with the brief

| ID | The brief says | Evidence | Resolution in this spec | Rows |
|---|---|---|---|---|
| BCB-01 | Section 3 step 3: create or choose the administrators group | Creating a group needs `Group.Create` or `Group.ReadWrite.All` (group-post-groups); `Group.*` also opens group content | The wizard chooses an existing group (search or object id); it creates none | FR-B-219 |
| BCB-02 | Section 3 step 5 and criterion 2: lock the wizard (`setup_completed`) when it finishes; criterion 2: after a restart the wizard is unreachable | A first sign-in can fail for reasons the wizard cannot foresee; a locked wizard then strands the owner | State `awaiting_first_signin` after the wizard; `completed` and the lock at the first successful sign-in of the designated Owner; token required until then | FR-B-201, FR-B-219, FR-B-207 |
| BCB-03 | Section 3 step 3: five permissions (`User.ReadWrite.All`, `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`, `Directory.Read.All`, `Organization.Read.All`) | 8.1 and 8.2 | Four permissions: `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All` | FR-B-301, ODB-02 |
| BCB-04 | Section 3 step 2: four delegated scopes including `Directory.Read.All` | No wizard call needs it (research §2.5) | Three scopes (already corrected in the Phase A research) | FR-B-214 |
| BCB-05 | Section 3: generate a certificate (no lifetime given) | Learn: a key credential lasts at most one year from its start date; app management policies can cap it further | RSA 2048, 360 days, expiry banners, renewal by repair | FR-B-106, FR-B-111, FR-B-220 |
| BCB-06 | Section 6: `__Host-` cookies with `SameSite=Strict` except the Lax state cookie | `__Host-` needs `Secure`; the Phase A default `PUBLIC_BASE_URL` is `http://localhost` (Phase A BC-03) | `__Host-` names on https, plain names on localhost; `response_mode=query`; interstitial 200 | FR-B-401, FR-B-412 |
| BCB-07 | Section 6: enforce MFA through the `amr`/`acr` claim | `acr` exists only in v1.0 tokens; `amr` is an optional claim that must be requested | `amr` only; the wizard registers the optional claim | FR-B-303, FR-B-405 |
| BCB-08 | Section 6: step-up (and `max_age`-style re-authentication) | `max_age` and ID-token `claims` are undocumented for Entra | `prompt=login` plus `auth_time` and MFA checks; an explicit failure instead of a loop | FR-B-411 |
| BCB-09 | Section 2a: a scope restricts a role assignment to objects | Silent on roles that mix resource types and on permissions without objects | Per-type scoping; global-only permissions only from unscoped assignments; qualifier `basic` | 6.5 |
| BCB-10 | Section 2a: outside the scope objects are invisible or read-only, depending on the permissions | A scope applies to every permission of that type in the assignment | "Read everything, write only Sales" is two assignments (*Lezer* unscoped, a members-write role scoped); lists show only the visible scopes | 6.5.2, FR-B-505, ODB-11 |
| BCB-11 | Sections 3, 4 and 7: Exchange through the Admin API and `InvokeCommand`, pwsh as fallback behind one interface; step 4 verifies with `Get-DistributionGroup -ResultSize 1` | `InvokeCommand` has no Learn page; the Admin API has no `Get-DistributionGroup` and no list or contact writes (8.4) | Interface plus read adapter in B; verification by `Get-OrganizationConfig` on the Admin API as a warning; write path is ODB-01 | FR-B-309, FR-B-314, Appendix A |
| BCB-12 | Section 3 step 2: the bootstrap client "exists in every tenant" and `BOOTSTRAP_CLIENT_ID` is the fallback if Microsoft restricts it | Existence before first use is unproven (U24); the Conditional Access flow block applies to every client | Keep `BOOTSTRAP_CLIENT_ID`; add the manual provisioning mode for a blocked flow | FR-B-214, FR-B-218 |
| BCB-13 | Section 6: break-glass "can only restore RBAC" | Stricter is safer | Restore-Owner only; no other assignment write | FR-B-523 |

---

## 11. Owner decisions

Each decision has a default that this spec implements, so work can proceed; the owner can overturn the default at the gate or after the owner test. "Needed by" is the latest moment.

| ID | Decision | Options | Default in this spec | Evidence and effect | Needed by |
|---|---|---|---|---|---|
| ODB-01 | Exchange write path (distribution list members, mail contacts) | A pwsh worker in the one container on an Ubuntu LTS base; B pwsh in a separate container; C Admin API only; D the undocumented `InvokeCommand` REST endpoint | Undecided; Phase B ships interface, read adapter and contract suite only. Recommendation A in Appendix A | Appendix A: criteria 3, 4, 12, 13; Phase B is unaffected | Before the Phase D plan; best at the Phase B gate |
| ODB-02 | Graph permission set | The reduced four (default) or the brief's five; and `GroupMember.ReadWrite.All` granted now (default) or only when Phase C starts | Reduced four, write permission granted now | 8.2. Granting early means one consent covers Phase C, at the price of an unused write permission for a phase; deferral means a repair run with an administrator before Phase C | The owner test |
| ODB-03 | Exchange role and second app role | Exchange Administrator (default) or Exchange Recipient Administrator or a custom role group; grant `Exchange.ManageAsAppV2` when exposed (default) or only `Exchange.ManageAsApp` | Exchange Administrator; both app roles | Learn supports Exchange Administrator; narrower sufficiency is U5, U6; the V2 role feeds only the Admin API probe | After OV-13 |
| ODB-04 | MFA switch | `AUTH_REQUIRE_MFA` as an operator switch (default); or always enforced for principals holding `owner` or `rbac:manage` | Operator switch, default on, visible in the posture line and Settings | A tenant without any MFA policy cannot produce `mfa` (EB-26, EB-27); enforcing for Owners only would lock them out there | The owner test (OV-11) |
| ODB-05 | When the wizard locks | At the first Owner sign-in (default) or at "Voltooien" as the brief says | First Owner sign-in | BCB-02 | The Phase B gate |
| ODB-06 | Break-glass in Phase B | Build now (default) or in Phase D | Now | B-17 | The Phase B gate |
| ODB-07 | Manual provisioning mode | Build now as a SHOULD (default) or defer to Phase D | Build now | B-23; tenants with the device-code block cannot use the wizard otherwise | The Phase B gate |
| ODB-08 | Certificate renewal | Repair flow in B and `addKey` self-rotation in D (default); or only repair | Repair in B, `addKey` in D | B-22; a lapsed certificate always needs an administrator | Before the Phase D plan |
| ODB-09 | Session numbers | Idle 30 minutes, absolute 8 hours (default), or others | Defaults | B-25 | The owner test |
| ODB-10 | Group-derived revocation delay | `GROUP_CACHE_TTL_SECONDS` 300 (default) or shorter | 300 | Shorter means more Graph calls (4 resource units per 20 groups per refresh); OV-16 measures Graph's own delay | The owner test |
| ODB-11 | Out-of-scope single objects | 403 `permission_denied` (default) or 404 | 403 | Brief: invisible or read-only. 404 hides existence; Phase C decides for lists (they filter by `visibleScopes`) | The Phase C spec |
| ODB-12 | Denial audit volume | Audit permissioned reads of authenticated actors (default) or writes only | Both | B-21; the brief asks for every refused action | The owner test |
| ODB-13 | Admin API probe in verification | Keep V5 as a warning (default) or drop it until ODB-01 is decided | Keep | Preview terms U25; a warning never blocks | The owner test |
| ODB-14 | First Owner other than the bootstrap administrator | Allowed only in manual mode (default), always, or never | Manual mode only | B-16; the brief says the signed-in Global Administrator becomes Owner | The Phase B gate |
| ODB-15 | Plain cookie names on `http://localhost` | Accept (default) or require https even for local use | Accept | BCB-06; Phase A BC-03 | The Phase B gate |

---

## 12. Risks

Likelihood and impact are low (L), medium (M) or high (H). Every risk with a control names it; risks without an automated control say how the owner sees them.

| ID | Risk | L / I | Mitigation | Control |
|---|---|---|---|---|
| RB-01 | The Exchange write path stays undecided and Phase D cannot meet criteria 3, 4, 12, 13 | M / H | Memo with a recommendation and a deadline; Phase B built so any option plugs into the interface | `server/exchange/exchange-client-contract.test.ts`; ODB-01 |
| RB-02 | The Admin API stays Preview, narrows or disappears | M / M | Used only for the verification probe and the read adapter; failures are warnings | `server/setup/verify.test.ts`; U25 |
| RB-03 | Role propagation takes longer than the window | M / M | 900 s default, 3,600 s maximum, "Retry now", a final hint, the owner measures | `server/setup/propagation-probe.test.ts`; OV-06 |
| RB-04 | Device code is blocked by Conditional Access | H / M | Distinct message and manual mode | `server/setup/aadsts-map.test.ts`, `server/setup/manual-mode.test.ts`; OV-02 |
| RB-05 | A stranger takes over an unconfigured panel | M / H | Setup token, brute-force limits, loopback guard over http, token never logged, lock at first Owner sign-in | SC-B-001 |
| RB-06 | The owner locks themselves out (wrong redirect URI, lost `APP_KEY`, expired certificate, no Owner) | M / H | State stays open until the Owner signs in; `setup-reopen`; break-glass; documented `APP_KEY` backup | `server/cli.test.ts`, `server/auth/break-glass.test.ts`; OV-17, OV-18 |
| RB-07 | `APP_KEY` is lost, so the sealed certificate key is unrecoverable | L / H | Documented separate backup; recovery is a new certificate through the repair flow with an administrator | `server/secrets/degraded.test.ts`; `docs/operations.md` |
| RB-08 | One powerful application identity (Exchange Administrator, group write) is abused through a panel flaw | L / H | Panel RBAC on the server, fail-closed policy layer, audit of every write and denial, least-privilege documentation, ODB-03 | SC-B-006, `server/policy-scoped-routes.test.ts` |
| RB-09 | A self-signed certificate is discouraged by Learn | L / L | No CA exists for a self-hosted panel; the trade-off is written in `docs/security.md` | `server/docs-contract.test.ts` |
| RB-10 | The simulation encodes our reading of Learn and diverges from Microsoft | M / M | The fake validates strictly, contract suites run against it, the owner-verified ledger covers the residue | `server/fakes/fake-tenant.selftest.test.ts`; section 8.6 |
| RB-11 | Browsers treat the `SameSite` redirect chain differently from the design | M / M | `response_mode=query`, Lax transaction cookie, 200 interstitial; first paint carries the session | `server/auth/interstitial.test.ts`; OV-14 (U39) |
| RB-12 | The tenant never emits `amr` or MFA, so nobody can sign in | M / M | Separate errors `amr_missing` and `mfa_required`; operator switch; repair re-applies the claim; break-glass | `server/auth/mfa.test.ts`; OV-11 |
| RB-13 | Revocation of group-derived rights is late (cache TTL plus Graph eventual consistency) | M / M | TTL setting, revalidation, direct assignments revoke at once, expiry at the instant | `server/rbac/epoch.test.ts`, `server/auth/revalidate.test.ts`; OV-16 |
| RB-14 | In-memory state (transactions, setup sessions, counters) is lost at restart or differs across replicas | M / L | Documented single replica; sign-in simply starts again | `server/lifecycle.test.ts`; B-26 |
| RB-15 | Graph throttles the application | L / M | Retry rules, caches, priority header, fail-fast on long waits | `server/integrations/graph/http-retry.test.ts`; OV-10 |
| RB-16 | New dependencies (`@azure/msal-node`, `jose`, `libsodium-wrappers`, an X.509 library) enlarge the image and the supply-chain surface | M / M | Pinned versions, audit in CI, image size re-measured, each with a reuse mark | `quality`, `image`, `server/docs-contract.test.ts` |

---

## 13. Dependencies and amendments

### 13.1 What Phase B needs from Phase A as built

This spec was written from the Phase A plan. The Phase B plan MUST check each row against the code before it writes tasks, and amend this spec in the same commit where the code differs.

| Needed from Phase A | Check |
|---|---|
| `defineRoute`, the route table, OpenAPI generation, the "every route declares access" test | The access union accepts `authenticated`, `stepUp`, `scoped`, `unscopedReason` without breaking existing routes |
| `AppModule` and `appModules` (seam X1) | Five modules can be appended without touching other modules |
| `Actor`, `authorize`, the actor resolver | Actor kinds and `grants` can be added; the resolver reads the cookie only |
| Audit writer, hash chain, detail allow-list, action vocabulary | Extension points exist; denial append failure gives 503 (PD-21) |
| One Zod configuration schema, `.env.example` parity test, posture line | New variables and cross-field rules fit |
| Migration wrapper, committed schema snapshots, upgrade-test harness | Migration `0001` is the first real one; foreign keys off during rebuilds |
| CSRF with a `binding` argument | Binding is the session hash |
| Shell renderer and boot data | `MeResponse` can change shape |
| i18n fragments per namespace and catalogue checks | New namespaces and the third-script rule |
| `LIMITS` and `limits-doc.test.ts` | Rows can be added |
| Rate limiter with classes | Classes `auth` and `setup` can be added |
| Readiness checks and degraded mode | A `secrets` check fits |
| Image smoke test and `check_image_contents.py` | Extensible with the new commands and bans |
| e2e fixtures and `routes.ts` | Topology can be replaced; Phase A specs migrate |

### 13.2 Amendments to Phase A artefacts

Made in the Phase B commits, listed here so the Phase A documents are amended in the same commits and nothing drifts.

| ID | Phase A artefact | Amendment |
|---|---|---|
| AM-01 | `apps/server/src/modules.ts` (seam X1) | Append the factories `secrets`, `setup`, `auth`, `rbac`, `connection` |
| AM-02 | `defineRoute` and the route table (FR-A-031, plan 7.2) | Access gains `{ authenticated: true }`, `stepUp`, `scoped`, `unscopedReason`; classes `auth` and `setup`; OpenAPI `x-step-up` and `x-scoped` |
| AM-03 | `Actor`, `authorize` (FR-A-030, FR-A-032, FR-A-033) | Kinds `user`, `setup`, `break_glass` replace `preview`; `grants`; `Decision.reason` gains `scope_mismatch`; `visibleScopes` and `canGrant` added; A-29 (403 for anonymous writes) becomes 401 |
| AM-04 | Audit vocabulary and writer (FR-A-070 to FR-A-073, PA-15) | Actor kinds `user`, `setup`, `break_glass`, `cli`; the actions and detail keys of 6.9.6; denial of permissioned reads for authenticated actors; reason codes `permission_missing` and `scope_mismatch` |
| AM-05 | Configuration (FR-A-010, FR-A-015, A-30, E-17) | 6.9.1: new variables, `PUBLIC_BASE_URL` rule, `PREVIEW_MODE*` removed with the one warning; the posture line |
| AM-06 | Migrations (data-model section 8) | `0001_phase_b` and snapshot 1; the upgrade test gains its first real pair |
| AM-07 | CSRF (FR-A-044) | The `binding` argument carries the session hash; `GET /api/v1/csrf` per FR-B-408 |
| AM-08 | `MeResponse`, boot data (FR-A-027) | New shape of FR-B-413; `features.preview` removed |
| AM-09 | Shell banner component (FR-A-032, FR-A-130) | Preview banner removed; red break-glass banner; session warnings; persona menu |
| AM-10 | e2e topology (FR-A-157), `e2e/routes.ts`, Phase A specs | Replaced by FR-B-708; Phase A specs migrated to the real sign-in, none deleted |
| AM-11 | Readiness (FR-A-013) | Check `secrets` with codes `app_key_missing`, `app_key_invalid`, `certificate_unreadable` |
| AM-12 | Service worker routing and cache rules (PD-02, PD-17, FR-A-050) | The `no-store` routes of FR-B-417 are never cached |
| AM-13 | i18n, problem registry, `LIMITS` (FR-A-112, 6.4, 6.5) | New namespaces; the codes of 6.9.5; the rows of 6.9.2 |
| AM-14 | Docs, `.env.example`, Compose, image smoke test, `check_image_contents.py` (FR-A-165, FR-A-166, FR-A-181 to FR-A-183) | Per 6.8 and FR-B-704 to FR-B-706 |
| AM-15 | `detectLocale` (FR-A-110) | Additive second argument: the stored default language |
| AM-16 | `docs/security.md` preview-mode risk (R-08) | Closed: preview mode is gone |

### 13.3 What Phase B hands to Phases C and D

| To | What |
|---|---|
| C | `GraphClient` with `getUser`, `getGroup`, `searchGroups`, `checkMemberGroups` and the retry and cache layer, to which C adds list and member-write methods (the permission set already holds `GroupMember.ReadWrite.All`); `authorize`, `visibleScopes`, `scoped` routes with the fail-closed safety net; `projectUser` for `basic`; `me.access`; step-up; the audit vocabulary pattern |
| D | `ExchangeClient` interface, contract suite and `FakeExchangeClient` (an adapter for the decided write path plugs in, ODB-01); RBAC tables, `rbac_role_template`, `computeGrants` for "view as"; assignment API for the admin UI; `connection.repair` and the certificate sequence for `addKey` rotation; `docs/permissions.md` as the base of the permission audit screen |

---

## Appendix A. OWNER DECISION MEMO: the Exchange write path (ODB-01)

**For**: the owner. **Date**: 2026-10-10. **Decision**: how the panel adds and removes distribution list members and manages mail contacts in Exchange Online (Phase D). **Needed by**: before the Phase D plan; best at the Phase B gate so Phase D starts without a pause. **Phase B is not blocked.** It ships the `ExchangeClient` interface, a read adapter on the Admin API, a fake and a contract suite that any option must pass, and it leaves the runtime image unchanged.

**What Learn says (8.4).** The Exchange Admin API is Preview ("not available in all organizations, subject to change"; production terms unstated, U25) and has six POST-only endpoints: it can read list members (`Get-DistributionGroupMember`) but has no `Get-DistributionGroup`, no `Add-` or `Remove-DistributionGroupMember` and no contact cmdlets. The `InvokeCommand` REST endpoint named in the brief has no Learn page. PowerShell with the `ExchangeOnlineManagement` module is the documented way to write: app-only with a certificate; Linux support is listed for Ubuntu LTS; module 3.10.0 or later needs PowerShell 7.6 or later; Debian, Alpine and distroless are not listed; arm64 is unstated (U26); Microsoft's container images are "for testing". Graph treats distribution groups as read-only (Learn, groups-overview); that member reads work through Graph for them is not stated (U36), while the Admin API reads members.

| Option | Covers | Cost | Risk |
|---|---|---|---|
| A. `pwsh` worker in the one container, runtime base changes from distroless to Ubuntu 24.04 LTS, PowerShell 7.6 and the module pinned | All: list and member reads, member add and remove, contact create, edit, delete, and the brief's verification `Get-DistributionGroup -ResultSize 1` | Larger image (ceiling re-measured), a shell exists in the image, Phase A distroless rule changes, arm64 to be tested, worker process and JSON protocol to build | On the documented path; Ubuntu only; more packages to patch |
| B. `pwsh` in a separate sidecar container | Same as A | Two images and two signing flows, Compose becomes two services, sidecar authentication | The brief's single `docker run` no longer works alone |
| C. Admin API only | Member reads; nothing else | None | Preview may change or vanish; no member writes, no contacts |
| D. Undocumented `InvokeCommand` REST | In principle everything | Reverse engineering | Unsupported and breakable at any time; excluded by the evidence rule |

| Brief criterion | A | B | C | D |
|---|---|---|---|---|
| 3 Add and remove a user to a group and a list | full | full | group part only (Graph); list part open | not accepted |
| 4 Mail contact create, edit, delete | full | full | open | not accepted |
| 12 *Bestuur* creates a contact and changes list members | full | full | open | not accepted |
| 13 CSV export of a list | full | full | members readable on the Admin API; list names only if Graph returns distribution groups (U36); possible | not accepted |

**Recommendation: option A, decided now** (research decision B1): record the ADR in Phase B, pin Ubuntu 24.04 LTS, PowerShell 7.6 and the module version, build the adapter in Phase D behind `ExchangeClient`, keep the Admin API as an optional non-blocking probe, reject D. If the owner will not change the base image, choose C and accept that criteria 3 (list part), 4 and 12 stay open until a later decision; choose B only if two containers are acceptable.

**The owner does**: pick A, B or C; optionally run experiment OV-13 (does Exchange Recipient Administrator suffice for list and contact writes, ODB-03). **Without a decision**: Phase D starts with criteria 3 (list part), 4 and 12 blocked. **Reversible**: the interface isolates the choice; changing adapters later is a Phase D change, not a rewrite.

---

## Appendix B. Data model summary (migration `0001_phase_b`; the plan's `data-model.md` holds the full DDL)

| Table | Columns (key first) | Notes |
|---|---|---|
| `setup_state` | `id` (always 1), `state`, `mode`, `install_id`, `designated_owner_oid`, `default_language`, `completed_at`, `updated_at` | `state` in `unconfigured`, `in_progress`, `awaiting_first_signin`, `completed`; `mode` `automatic` or `manual`; `default_language` `nl` or `en`; one row |
| `setup_step` | (`step`, `sub_action`), `status`, `attempt`, `started_at`, `finished_at`, `error_code`, `rollback_hint_key`, `detail` | `detail` is JSON of at most 4,096 bytes validated by FR-B-210 |
| `setup_object` | (`kind`, `tenant_object_id`), `app_id`, `name`, `origin`, `created_at` | `origin` `created` or `adopted`; what the wizard may later report or repair |
| `setup_log` | `seq`, `ts`, `step`, `level`, `message_key`, `params` | at most 1,000 rows, oldest trimmed |
| `runner_lease` | `id` (always 1), `holder`, `heartbeat_at`, `expires_at` | FR-B-209 |
| `tenant_connection` | `id` (always 1), `tenant_id`, `tenant_name`, `initial_domain`, `app_object_id`, `app_id`, `sp_object_id`, `graph_sp_id`, `exchange_sp_id`, `exchange_enabled`, `exchange_role_template_id`, `permission_set_version`, `redirect_uris`, `certificate_id`, `proof`, `verified_at` | `proof` JSON at most 51,200 bytes; `tenant_id` never changes once set |
| `secret` | `id`, `purpose`, `key_id`, `blob`, `created_at`, `retired_at` | `blob` is the sealed form of FR-B-105; no plaintext column exists |
| `certificate` | `id`, `secret_id`, `thumbprint_sha1`, `thumbprint_sha256`, `subject`, `not_before`, `not_after`, `public_der`, `state` | `state` `active` or `retired`; at most one active (partial unique index) |
| `app_user` | (`tid`, `oid`), `upn_label`, `name_label`, `first_seen_at`, `last_signin_at`, `groups_resolved_at` | labels at most 256 bytes; never used to select a user |
| `session` | `id_hash`, `kind`, `tid`, `oid`, `created_at`, `last_seen_at`, `absolute_expires_at`, `mfa`, `amr`, `authenticated_at`, `step_up_at`, `groups_stale` | `kind` `user` or `break_glass` (closed set, may use `CHECK`); `oid` empty for break-glass; index on (`tid`, `oid`) |
| `rbac_role` | `id`, `key`, `builtin`, `assignable`, `created_at` | `key` unique; five built-in rows seeded; display names come from the catalogue |
| `rbac_role_permission` | (`role_id`, `permission`), `qualifier` | `qualifier` empty or `basic` |
| `rbac_role_template` | `key`, `permissions`, `scope_target` | *Bestuur*; not assignable |
| `rbac_assignment` | `id`, `principal_type`, `principal_id`, `role_id`, `expires_at`, `source`, `created_at`, `created_by` | `principal_type` `user` or `group`; `source` `wizard`, `api` or `break_glass`; unique on principal, role and scope hash |
| `rbac_assignment_scope` | (`assignment_id`, `position`), `target`, `match_by`, `attr`, `value` | `match_by` `id`, `prefix` or `department` |
| `rbac_group_member_cache` | (`user_oid`, `group_id`), `resolved_at` | cleared when a group assignment is created or deleted |
| `rbac_epoch` | `id` (always 1), `epoch` | incremented by triggers |

Hand-written triggers in the marked section of the migration: built-in `rbac_role` rows cannot be updated or deleted; built-in `rbac_role_permission` rows cannot be inserted, updated or deleted; an update or delete of an `rbac_assignment` that would leave no `owner` assignment to a user aborts; inserts, updates and deletes on the four RBAC tables bump `rbac_epoch`; `tenant_connection.tenant_id` cannot change once set. The Phase A audit triggers are untouched.

| ID | Invariant | Enforced by |
|---|---|---|
| I-B1 | Built-in roles and their permissions equal `BUILTIN_ROLES` and cannot be changed | `server/rbac/builtin-roles.test.ts`, `server/migrations.upgrade.test.ts` |
| I-B2 | At least one user-principal `owner` assignment exists once the first Owner was created | `server/rbac/last-owner.test.ts`, `server/rbac/last-owner.concurrency.test.ts` |
| I-B3 | Every change to roles, role permissions, assignments or scopes bumps `rbac_epoch` | `server/rbac/epoch.test.ts` |
| I-B4 | No table holds a plaintext secret, token or password; `session.id_hash` is a hash; `secret.blob` is sealed | `server/secrets/no-plaintext.test.ts`, `server/auth/session-store.test.ts`, `server/auth/no-token-retained.test.ts` |
| I-B5 | `setup_state.state` moves forward only, except through the CLI | `server/setup/state-machine.test.ts` |
| I-B6 | At most one active certificate | `server/connection/repair.test.ts`, `server/migrations.upgrade.test.ts` |
| I-B7 | The pinned tenant never changes | `server/setup/tenant-pin.test.ts` |
| I-B8 | A change and its audit entry commit together | `server/setup/audit-setup.test.ts`, `server/rbac/audit-rbac.test.ts` |
| I-B9 | JSON `detail` and `params` columns are written only through schemas that reject secret-looking keys | `server/setup/step-model.test.ts`, `server/setup/log.test.ts` |

---

## Appendix C. Sign-in fixtures F-01 to F-45

All fixtures run against the in-process fake identity provider (valid fixtures signed with its current key, attacker fixtures with another key or algorithm) and the fake tenant, with `AUTH_REQUIRE_MFA=true` unless stated. "Denied" entries are `auth.signin` with outcome `denied`; `check` is the internal check name (`format`, `size`, `header`, `alg`, `kid`, `signature`, `issuer`, `tenant`, `audience`, `nonce`, `expired`, `not_before`, `issued_at`, `version`, `oid`) and is never shown to the user. "Sessions" counts sessions created. The control for all rows is `server/auth/callback.test.ts`; rows that test the token validator alone also run in `server/integrations/identity/id-token.test.ts`.

| ID | Case | Expected result | Audit | Sessions |
|---|---|---|---|---|
| F-01 | Member with an assignment, valid token, `amr` contains `mfa` | 200 interstitial to `returnTo`; first paint shows the signed-in persona | success | 1 |
| F-02 | Signed with an attacker key that reuses a real `kid` | `/signin?error=signin_failed` | denied, `token_invalid`, check `signature` | 0 |
| F-03 | `kid` absent from the key set, also after one refresh | `signin_failed` | denied, check `kid` | 0 |
| F-04 | Guest user of the pinned tenant (`tid` is the pinned one) with an assignment | as F-01; principal by `oid` | success | 1 |
| F-05 | Foreign `tid` and issuer, validly signed by that tenant's key | `signin_failed` | denied, check `tenant` | 0 |
| F-06 | `iss` in the v1 form `https://sts.windows.net/<tid>/` | `signin_failed` | denied, check `issuer` | 0 |
| F-07 | `iss` near-misses: trailing slash, upper-case host, other host, missing `/v2.0` | `signin_failed` | denied, check `issuer` | 0 |
| F-08 | `aud` is another client id | `signin_failed` | denied, check `audience` | 0 |
| F-09 | `aud` is an array holding our id and another | `signin_failed` | denied, check `audience` | 0 |
| F-10 | `nonce` differs from the stored one | `signin_failed` | denied, check `nonce` | 0 |
| F-11 | `nonce` missing | `signin_failed` | denied, check `nonce` | 0 |
| F-12 | `exp` 61 s in the past | `signin_failed` | denied, check `expired` | 0 |
| F-13 | `exp` 59 s in the past (inside the 60 s tolerance) | as F-01 | success | 1 |
| F-14 | `nbf` 61 s in the future | `signin_failed` | denied, check `not_before` | 0 |
| F-15 | `nbf` 59 s in the future | as F-01 | success | 1 |
| F-16 | `iat` 120 s in the future | `signin_failed` | denied, check `issued_at` | 0 |
| F-17 | `alg` none, unsigned | `signin_failed` | denied, check `alg` | 0 |
| F-18 | `alg` HS256 signed with the public key as the secret | `signin_failed` | denied, check `alg` | 0 |
| F-19 | `alg` PS256, RS384 or ES256 with valid signatures | `signin_failed` | denied, check `alg` | 0 |
| F-20 | Header `jku` pointing at an attacker URL | `signin_failed`; the URL is never fetched | denied, check `header` | 0 |
| F-21 | Header `jwk` with an embedded key | `signin_failed` | denied, check `header` | 0 |
| F-22 | Header `x5u` or `crit` | `signin_failed` | denied, check `header` | 0 |
| F-23 | `ver` is `1.0` | `signin_failed` | denied, check `version` | 0 |
| F-24 | `oid` missing or not a GUID | `signin_failed` | denied, check `oid` | 0 |
| F-25 | Token over 8,192 bytes | `signin_failed` | denied, check `size` | 0 |
| F-26 | Malformed compact serialisation: two segments, non-base64url, payload that is a JSON array | `signin_failed` | denied, check `format` | 0 |
| F-27 | Key endpoint unreachable on a cold start | `/signin?error=temporarily_unavailable` | denied, `keys_unavailable` | 0 |
| F-28 | `state` differs from the stored one | `signin_failed` | none (before step 7) | 0 |
| F-29 | `state` missing | `signin_failed` | none | 0 |
| F-30 | Transaction cookie absent (browser blocks cookies) | `/signin?error=cookies_missing_or_expired` | none | 0 |
| F-31 | Transaction older than 600 s | `cookies_missing_or_expired` | none | 0 |
| F-32 | Second use of the same callback URL | `cookies_missing_or_expired`; the first use created one session | none | 0 (second) |
| F-33 | Two tabs: the earlier tab's callback arrives with the later tab's cookie | `signin_failed`; the later transaction is consumed | none | 0 |
| F-34 | `error=access_denied` | `/signin?error=access_denied` | none | 0 |
| F-35 | `error=interaction_required` | `interaction_required` | none | 0 |
| F-36 | `error` carrying `AADSTS65001`, `AADSTS90093` or `AADSTS90094`, or `AADSTS50105` | `consent_required`, `admin_approval_required` or `assignment_required`; the consent link appears for the first three (FR-B-419) | none | 0 |
| F-37 | `error=invalid_request` with a 5,000-character hostile `error_description` | `signin_failed`; the text is never rendered | none | 0 |
| F-38 | Token endpoint answers `invalid_grant` | `signin_failed` | none | 0 |
| F-39 | Token endpoint answers `invalid_client` (certificate rejected) | `signin_failed`; log event `signin_denied` with code `invalid_client` | none | 0 |
| F-40 | Token endpoint answers `temporarily_unavailable` once, then succeeds | as F-01 after 1 s | success | 1 |
| F-41 | Token endpoint answers 503 twice, or does not answer within 10 s | `temporarily_unavailable` | none | 0 |
| F-42 | `amr` variants: absent; `["pwd"]`; the string `"mfa"`; `["pwd","mfa"]`; `["ngcmfa"]`; `["rsa","ngcmfa","mfa"]`; and the same set with `AUTH_REQUIRE_MFA=false` | absent and string: `amr_missing`; `pwd` and `ngcmfa` alone: `mfa_required`; the other two as F-01; with the switch off all as F-01 | denied (`amr_missing`, `mfa_required`) or success | 0 or 1 |
| F-43 | `returnTo` attacks: `//evil`, `/\evil`, `https://evil`, `/api/v1/me`, `/setup`, CRLF, 300 characters | sign-in succeeds and lands on `/` | success | 1 |
| F-44 | Valid token for (a) a Global Administrator without an assignment (the `wids` claim is ignored); (b) a user with only a group-derived assignment while Graph fails | (a) `/no-access?reason=no_role&ref=<request id>`; (b) `/no-access?reason=graph_unavailable` | denied, `no_role` or `graph_unavailable` | 0 |
| F-45 | Token carrying `groups` with 250 entries, `_claim_names` and `hasgroups` | accepted; rights come from direct assignments and `checkMemberGroups` only | success | 1 |
