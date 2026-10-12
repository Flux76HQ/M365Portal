# Feature Specification: M365Portal, a self-hosted Microsoft 365 administration panel

## Samenvatting (Nederlands)

**Wat.** M365Portal is een self-hosted webpanel, geleverd als één Docker-image met één container (Node.js 22 met Hono voor de API, React voor de frontend), waarmee een beheerder een Microsoft 365-tenant beheert: gebruikers, groepen, distributielijsten en mailcontacten. Het panel dwingt zijn eigen RBAC-model af (fijnmazige permissies, rollen, scopes); de Entra- of M365-rollen van de gebruiker tellen daarvoor niet mee.

**Fasen.** A (fundament: monorepo, Docker, CI, design system, app-shell, branding), B (wizard, aanmelden, RBAC-fundament), C (gebruikers en groepen via Graph), D (distributielijsten en mailcontacten via Exchange, CSV-export, RBAC-beheer met scopes, audit-UI, hardening). Na elke fase stop ik, lever ik het vijfpuntsrapport uit de brief en wacht ik op uw expliciete akkoord. Na fase B en D test de eigenaar tegen een echte tenant.

**Fase A in het kort.** Een draaiend, veilig en toegankelijk skelet: server-kern met een deny-by-default beleidslaag (Actor-interface met precies twee resolvers: anoniem en PREVIEW_MODE), onveranderbaar auditlog (SHA-256-hashketen), CSP met nonces en Trusted Types, Origin- en CSRF-controle, rate limiting, RFC 9457-fouten; branding met veilige logo-upload (magic bytes, SVG-allowlist, altijd gerasterd naar PNG, metadata gestript) en accenttinten die voor elke hex-kleur WCAG AA garanderen; design system en app-shell in Nederlands en Engels (licht/donker/systeem, command palette, DataTable, PWA); distroless non-root image met read-only rootfs; CI met kwaliteits-, e2e-, image-, CodeQL- en releasecontroles (Trivy, CycloneDX, cosign, SLSA-provenance). Er is in fase A **geen tenant en geen login**: alleen een anonieme actor (mag niets schrijven) en, uitsluitend met `PREVIEW_MODE=true`, een previewactor met alle rechten, met een luide waarschuwing en een permanente banner.

**Elke MUST heeft een benoemde geautomatiseerde controle** (Vitest-bestand, Playwright-test, CI-job of hook). Waar dat niet kan, staat dat er expliciet bij.

**Acceptatiecriteria.** Volledig in fase A: 10. Gedeeltelijk in fase A (fundament, geen tenant): 1, 2, 5, 6, 7, 8, 9, 11. Pas vanaf B/C/D: 3, 4, 12, 13 (en de rest van 1, 2, 11). Zie sectie "Success Criteria".

**Belangrijkste tegenstrijdigheden en beslissingen voor de eigenaar** (details in de secties "Brief conflicts" en "Owner decisions"): (1) een distroless image kan geen `pwsh` bevatten, terwijl Exchange-schrijfacties volgens Microsoft Learn alleen via PowerShell (alleen Ubuntu LTS gedocumenteerd) of de nog niet gedocumenteerde `InvokeCommand`-route kunnen; (2) HSTS-preload uit de brief botst met baseline sectie 13, daarom standaard uit; (3) de importlimiet van 8 MiB is rekenkundig te klein voor drie logo's van 2 MiB in base64, daarom 9 MiB; (4) de brief vraagt "minimaal User.ReadWrite.All", Microsoft Learn noemt minder rechten voldoende; (5) ESLint 10 (met een geforceerde peer voor de niet meer onderhouden jsx-a11y-plugin) en TypeScript 6.0 zijn de bruikbare versies, Playwright 1.56 past bij de aanwezige Chromium; (6) licentie en kanaalbeleid ontbreken nog.

---

## Document status

**Feature Branch**: the branch this session was given (the integration branch is not yet decided by the owner: AGENTS.md section 8, OD-02)

**Created**: 2026-10-10

**Status**: Draft. Phase A is specified in full detail; Phases B, C and D are specified at outline level and are refined by a spec amendment at the start of each phase (spec first, then plan, then tasks, then code).

**Input**: `docs/build-prompt.md` (Dutch product brief, sections 0 to 9) plus the orchestrator's decision brief D1 to D26, recorded here as assumptions A-01 to A-26. Microsoft claims are taken from `research-microsoft.md` in this folder (Microsoft Learn, 2026-10-10); anything not on Learn is marked UNVERIFIED.

---

## 1. Scope and phases

| Phase | Theme | Brief references | Done when (gate) |
|---|---|---|---|
| **A** | Foundation: monorepo, server core, branding, design system, app shell, Docker image, CI, docs | 0, 1, 5, 5a, 6 (web, supply chain, runtime), 7 | Phase A report accepted by the owner |
| **B** | Onboarding wizard, Entra sign-in, secrets at rest, RBAC foundation (policy layer with real data) | 2, 2a (model), 3, 6 (login) | Owner tests against a real tenant, accepts |
| **C** | Users and groups through Microsoft Graph | 4 (users, groups) | Owner accepts |
| **D** | Distribution lists and mail contacts through Exchange, CSV export, RBAC admin UI with scopes, audit UI and export, hardening, tenant e2e, final docs | 2a (UI, scopes), 4, 6, 7, 9 | Owner tests against a real tenant, accepts |

### 1.1 Phase A scope

**In**: monorepo and toolchain; server core (configuration, API conventions, errors, health, security middleware, logging, persistence, migrations, policy interface, audit store); branding backend and UI (organisation name, accent colour, logo upload with variants and icons, export and import); design system; app shell and Phase A pages; PWA; i18n module; Dockerfile, compose example, `.env.example`; CI workflows; test suites; documentation listed in D24.

**Out (later phases, recorded so nobody builds them early)**:

| Item | Phase |
|---|---|
| Onboarding wizard, device-code flow, tenant configuration | B |
| OIDC sign-in, sessions, cookies, MFA enforcement, step-up | B (design), D (hardening) |
| Real RBAC data model (roles, assignments, group-membership cache) and its admin UI, scopes | B (model), D (UI, scopes) |
| Break-glass account | B (design), D (hardening) |
| Secrets at rest (libsodium, `APP_KEY`), certificate handling | B |
| `GraphClient` | B (verification calls), C (full) |
| `ExchangeClient` | B (interface and verification), D (full) |
| Users, groups pages with real data | C |
| Distribution lists, contacts, CSV export | D |
| Audit log UI and CSV export | D |
| OpenTelemetry traces and metrics (disableable) | D |
| Azure Bicep example, custom seccomp profile, permission-audit screen | D |
| Sending e-mail of any kind (the brief mentions the organisation name "in e-mails"; no phase sends mail unless the owner asks) | none |

---

## 2. Document conventions

- **Levels.** MUST and SHOULD are used as in RFC 2119. Baseline section 7: a MUST without an automated enforcement point does not belong in this document. Where a MUST can only be enforced by review, the row says so in the "Enforced by" column (as baseline section 17 does for vendor skill directories).
- **IDs.** `FR-A-nnn` Phase A functional requirements, `FR-B-nnn`, `FR-C-nnn`, `FR-D-nnn` outline requirements for later phases, `US-n` user stories, `SC-A-nnn` Phase A success criteria, `A-nn` assumptions, `BC-nn` brief conflicts, `OD-nn` owner decisions, `R-nn` risks, `H-nn` hostile fixtures (Appendix A).
- **Enforcement vocabulary.** CI job names are the names AGENTS.md cites: `enforce-version-bump` and `agent-instructions-lint` (exist), `quality` and `e2e` (new, in `ci.yml`), `image` (new, in `image.yml`), plus `publish` (release job in `image.yml`) and `analyze` (in `codeql.yml`). Test paths use short prefixes:

  | Prefix | Path |
  |---|---|
  | `server/` | `apps/server/test/` |
  | `shared/` | `packages/shared/test/` |
  | `web/` | `apps/web/test/` |
  | `e2e/` | `e2e/tests/` |
  | `py/` | `scripts/` (Python, next to the existing governance tests) |

- **Planned names.** Test file names in this document are the planned paths. `tasks.md` may refine them but MUST keep the requirement-to-control mapping one to one and update this table in the same commit (spec first).
- **Additional and moved controls** (tasks.md TA-01 to TA-08, applied during the speckit-analyze pass of 2026-10-10; they keep the one-to-one mapping):
  - FR-A-030: `shared/permissions.test.ts` asserts the catalogue equals the brief's 15 permissions; `server/docs-contract.test.ts` asserts `docs/permissions.md` lists the same 15 (TA-02).
  - FR-A-112: `shared/error-codes.test.ts` reads the `problem` catalogue fragments; `shared/i18n-fragments.test.ts` guarantees the merged catalogues contain them (TA-03).
  - FR-A-072: the transaction control is `server/branding/audit-branding.test.ts` (the change and its audit entry share one transaction, a fault injected between them rolls both back); `server/audit-integration.test.ts` keeps FR-A-034 and FR-A-073 (TA-04).
  - Repository guards (G0, round 2): the placement of test files (a `*.test.*` or `*.spec.*` file outside the place its runner collects tests from is a dead test), the size of scanned files and the ban on switching off a local lint rule are checks 8 to 10 of `shared/repo-conventions.test.ts`; `shared/support/repository.ts` is the helper that both repository guards share (the walk of the tree, the definition of a test path) and is not a test.
  - FR-A-011: the `.env.example` parity with the configuration schema is asserted in `server/deploy-files.test.ts`; `server/config.test.ts` keeps the schema validation (TA-06). FR-A-151: `web/routes-coverage.test.ts` is owned by the verification stream (TA-07).
  - Catalogues (FR-A-110, FR-A-111): the catalogues are produced from per-namespace fragments (`packages/shared/src/i18n/fragments/<namespace>.{en,nl}.json`) merged by `pnpm i18n:merge` into the committed `nl.json` and `en.json`; the checks of FR-A-111 run on the merged files; new control `shared/i18n-fragments.test.ts` (freshness, namespace ownership, duplicate keys; + negative) (TA-01).
  - Additional controls named by tasks and not in the tables of section 6.1 (TA-08: every test file that a task names and that sections 2 and 6.1 do not is listed here, so the list is complete; `tasks.md` section 5 names the families, this is the file-by-file expansion). Each proves part of a requirement that the single control named in section 6.1 cannot prove alone, or a property of the repository itself:
    - Shared package: `shared/{exports,guard-helper,index,limits,schemas-common,schemas-branding,logo-plate,glyphs,i18n-fragments}.test.ts`.
    - Server: `server/{app,listen,version,helpers,schema-parity,deploy-files}.test.ts`; `server/branding/{sniff,raster,svg-render,job-runner,asset-store,persistence,audit-branding}.test.ts`.
    - Web: `web/{api,problem,theme,boot-script,build-output,styles,sw-lifecycle,sw-register}.test.ts`; `web/{gating,motion,shortcuts,placeholders,showcase,router,dashboard,pages}.test.tsx`; `web/branding/api.test.ts`; `web/branding/{accent-picker,apply-to-shell,live-preview,logo-slot}.test.tsx`; `web/ui/{feedback,forms,layout,overlays}.test.tsx`.
    - Repository tooling: `eslint-rules/test/{no-literal-ui-strings,no-raw-colour,no-string-built-sql,no-dangerous-html,no-direct-storage,no-trusted-types-policy-elsewhere,no-direct-route-registration}.test.ts`; `tools/lint-canary/lint-canary.test.ts`; `tools/traceability/traceability.test.ts`; `scripts/bundle-budget.test.ts`; `py/test_resolve_action_pins.py`; `py/test_check_image_size.py`; `py/test_check_image_contents.py`; `py/test_version_guard.py`; `py/test_check_agent_instructions.py`.
    - End to end: `e2e/{headers,fixtures-selftest,branding-persistence}.spec.ts`; `e2e/lighthouse/judge.test.mjs`.
- **Guard tests are tested.** Baseline section 2: "a guard nobody has seen fail is an assumption with a green tick next to it". Every guard that protects a security or contract property (header rules, HSTS rules, catalogue checks, version guards, route-table check, schema snapshot check, hostile corpus runner) SHOULD ship with a negative fixture that makes it fail on purpose. Rows that need one say "(+ negative)".
- **Baseline sections that do not apply.** Section 9 (native Apple), section 11 (web push, none planned), section 14 (AI-crawler policy: `robots.txt` disallows everything and no switch exists), section 15 (sitemap: none, the app is private; FR-A-049 keeps it out of search engines), section 16 (workspace per feature: governed by the session set-up). Sections 2, 4, 5, 6, 8, 10, 12, 13 and 17 apply and are referenced where they bite.

---

## 3. Phase gate

1. Each phase ends with the report the brief prescribes, in this order: (1) a short summary of what was built and what deliberately was not; (2) the test results (unit, e2e, a11y, lint, typecheck) and what could not be tested; (3) a step list to try the result yourself, including the `docker run` command and what to check against a test tenant; (4) open points, assumptions and risks (also in `docs/open-points.md`); (5) the question "Akkoord om door te gaan met fase X?".
2. **Work stops after the report.** No agent starts the next phase, including scaffolding, dependency additions or spec amendments for it, before the owner's explicit approval. Feedback on the finished phase is processed first.
3. After Phase B and after Phase D the owner tests against a real Microsoft 365 tenant before the next step; that test is the owner's, the report only prepares it.
4. **Enforcement.** This is a process rule and cannot be automated: it is enforced by review (the owner's recorded approval line in `docs/phase-reports/phase-A.md`, FR-A-188) and mechanically supported by `tasks.md` ending in a gate task with nothing scheduled behind it. This is the one MUST in this document without a script, in line with baseline section 17.
5. **Phase A report content that is already known to need honesty.** The report states separately what ran locally and what only runs on GitHub (workflows, arm64 build, cosign signing and verification, SLSA provenance, CodeQL), what cannot be tested in this environment (securityheaders.com and Mozilla Observatory scores, screen readers, browsers other than Chromium, any real tenant), and that Phase A has no tenant, so "what to check against a test tenant" is explicitly "nothing yet".

---

## 4. User Scenarios and Testing

Priorities: P1 is needed for the phase gate, P2 expected, P3 desirable. Phase A stories are independently demonstrable. Stories for B, C and D are outlines.

### US-1 Run the image and see a working shell (Phase A, P1)

An operator starts the image on an empty volume and gets a healthy container that serves a usable, branded-by-default shell.

**Why this priority**: every other story needs a runnable, trustworthy artefact. Partly satisfies acceptance criteria 1, 2 and 6.

**Independent test**: `docker run` on an empty volume; wait for `/readyz`; open the UI; restart the container.

**Acceptance scenarios**:

1. **Given** an empty volume and no `PREVIEW_MODE`, **When** the container starts as documented, **Then** within 10 seconds `/readyz` answers 200, `/healthz` reports the version from `VERSION`, and the browser shows the shell with the default monogram mark and the Dashboard, in the system theme and the browser language (nl or en).
2. **Given** the container runs with read-only root filesystem, all capabilities dropped, `no-new-privileges`, a tmpfs `/tmp` and only `/data` writable, **When** it starts and later handles a branding write (preview mode), **Then** it stays healthy and writes nowhere else.
3. **Given** saved branding, **When** the container is restarted on the same volume, **Then** the same branding is served and no already-applied migration is applied again.
4. **Given** `/data` is not writable, **When** the container starts, **Then** `/readyz` answers 503 with `data_dir_not_writable`, the UI shows a "storage not available" page with the remedy, `/healthz` still answers 200, and the process does not crash-loop.
5. **Given** the volume was written by a newer app version than the running image, **When** the container starts, **Then** it refuses to start with `schema_newer_than_app` and the database is untouched.

### US-2 Customise branding with a live preview (Phase A, P1)

An administrator (preview actor in Phase A) sets organisation name, accent colour and logos and sees the result before saving.

**Why this priority**: acceptance criterion 10 is fully satisfiable in Phase A and the branding pipeline is the most security-critical Phase A feature.

**Independent test**: Settings, Appearance, in a browser against a `PREVIEW_MODE=true` server.

**Acceptance scenarios**:

1. **Given** preview mode, **When** I change the name and accent, **Then** the live preview (sidebar, header, buttons in rest/hover/active/focus, light and dark side by side) updates immediately; after saving and reloading, the sidebar, the browser tab title and the manifest show the new values without a flash of the old ones.
2. **Given** a valid PNG, JPEG or SVG logo for the light theme only, **When** I upload it, **Then** I see the processed result and any warnings, and after saving it is used in both themes (in the theme where it would be illegible it sits on a contrasting plate; it is never recoloured), and favicon, apple-touch, 192, 512 and maskable 512 icons are derived from it.
3. **Given** I enter an accent colour with no accessible variant (for example `#FFFF00`), **When** I look at the preview, **Then** the UI shows the colour I chose and the effective colour it uses, all text and controls stay at WCAG AA contrast, and saving is allowed.
4. **Given** no logo, **Then** a monogram tile with initials appears in the sidebar, favicon, manifest icons and apple-touch icon.
5. **Given** two tabs edit the same branding, **When** the second saves from a stale revision, **Then** it gets a conflict message with a reload action and nothing is overwritten.
6. **Given** an export file, **When** I import it, **Then** every image goes through the full validation and sanitising pipeline again; a tampered image is rejected and nothing is applied.
7. **Given** I reset branding to defaults, **Then** a confirmation dialog names the object ("Appearance of <organisation name>") and, after confirming, an Undo is offered.

### US-3 Hostile uploads cannot do harm (Phase A, P1)

**Why this priority**: the upload is the largest attack surface in Phase A.

**Independent test**: the hostile corpus in Appendix A, run by `server/branding/hostile-uploads.test.ts` and, for the stored-XSS case, `e2e/branding-xss.spec.ts`.

**Acceptance scenarios**:

1. **Given** any file in Appendix A, **When** it is uploaded, **Then** the outcome is the one listed (rejected with a stable problem code, or neutralised), no stored or served byte contains active content or metadata, no outbound network connection is made, and the audit log records the outcome.
2. **Given** a file whose extension or `Content-Type` lies, **Then** the decision is made on content (magic bytes).
3. **Given** a file of 2,097,153 bytes (2 MiB plus 1 byte), **Then** the upload is refused with 413 `payload_too_large`, nothing is stored and no temporary file remains; a request body above 2,162,688 bytes (2 MiB plus a 64 KiB multipart envelope) is cut off while it streams.
4. **Given** a stored logo URL, **Then** it is served as `image/png` with `X-Content-Type-Options: nosniff` and a strict CSP, from a name that is exactly 64 lowercase hex characters plus `.png`.

### US-4 Secure by default: nothing is written without permission (Phase A, P1)

**Why this priority**: the policy layer, headers, CSRF and audit are the foundation Phases B to D build on; they cannot be retrofitted.

**Independent test**: `server/policy.test.ts`, `server/csrf.test.ts`, `server/security-headers.test.ts`, `e2e/csp.spec.ts` (fixture on every e2e test).

**Acceptance scenarios**:

1. **Given** no `PREVIEW_MODE`, **When** an anonymous client calls any write route directly with a correct Origin and CSRF token, **Then** it gets 403 `permission_denied`, nothing changes, and a denied entry (actor, route, request id, required permission, client address) is appended to the audit log.
2. **Given** preview mode, **When** a write arrives with a foreign or missing Origin, a `Sec-Fetch-Site` other than `same-origin`, or a missing or invalid CSRF token, **Then** it gets 403 with the specific code (`origin_not_allowed`, `csrf_invalid`) and the denial is audit-logged.
3. **Given** any route, **Then** the response headers match FR-A-040 to FR-A-043 and the browser reports zero `securitypolicyviolation` events during the whole e2e run.
4. **Given** more requests than a bucket allows, **Then** the excess gets 429 with `Retry-After`, and a spoofed `X-Forwarded-For` does not change the bucket unless the peer is a trusted proxy.
5. **Given** `PREVIEW_MODE=true` with a `PUBLIC_BASE_URL` that is not loopback, **Then** startup refuses unless `PREVIEW_MODE_ALLOW_REMOTE=true` (A-30).
6. **Given** a database with audit entries, **When** one entry is changed, deleted or reordered through raw SQL, **Then** `verifyChain()` reports the first bad sequence number.
7. **Given** `PREVIEW_MODE=true` and the default loopback `PUBLIC_BASE_URL`, **When** a request arrives with a non-loopback `Host` header or with `Forwarded` or `X-Forwarded-*` headers (the port was published to a network, or a reverse proxy forwards to it), **Then** it is resolved as the anonymous actor and every write is denied and audited (FR-A-036).

### US-5 Navigate the application shell (Phase A, P2)

**Acceptance scenarios**:

1. **Given** an actor with a set of permissions, **Then** the sidebar lists exactly the entries those permissions allow (Dashboard always); the anonymous actor sees Dashboard only; collapsing the sidebar is remembered per browser; on a phone-width viewport the sidebar is a drawer.
2. **Given** focus anywhere, **When** I press Ctrl+K (Cmd+K on macOS), **Then** a command palette opens with focus in its input; typing "appear" and pressing Enter goes to Settings, Appearance; Esc closes it and restores focus. Results contain only entries the actor may use.
3. **Given** focus not in a text field, **When** I press `?`, **Then** the shortcut overview opens; single-character shortcuts can be switched off there (WCAG 2.1.4).
4. **Given** the theme switcher (light, dark, system) and language switcher (nl, en), **Then** the choice persists per browser, applies before first paint (no flash), and defaults come from the system theme and the browser language.
5. **Given** the Users, Groups, Distribution lists, Contacts, Audit log or Settings page in Phase A, **Then** it says plainly that it is not available until Phase B, C or D and what it will do.
6. **Given** an unknown URL, **Then** the Not-found page; **given** the anonymous actor opens a gated route directly, **Then** the No-access page; **given** a render error, **Then** the error boundary shows a translated message with the request id when there is one and never a stack trace.
7. **Given** the Dashboard, **Then** counter cards show skeletons while loading and then honest empty states ("no tenant connected yet"); no invented numbers appear anywhere.
8. **Given** `SHOWCASE` is not `true`, **Then** `/design` is not reachable (Not-found); **given** `SHOWCASE=true`, **Then** it shows every component in every state, including a server-driven DataTable on clearly labelled sample data.
9. **Given** the DataTable showcase, **Then** sorting, filtering, pagination, column picker, bulk selection, sticky header and the skeleton, empty and error states all work with the keyboard alone, and state lives in the URL.

### US-6 Install as an app and degrade gracefully offline (Phase A, P2)

**Acceptance scenarios**:

1. **Given** a supporting browser, **Then** the app is installable; name, theme colour and icons come from the branding; maskable and apple-touch icons are opaque.
2. **Given** the network goes away, **Then** a navigation shows a neutral offline page in both languages, hashed static assets still load from the cache, and no `/api` response is ever served from a cache.
3. **Given** a new version is deployed, **Then** the old app keeps working until the user accepts "Update available"; stale caches are removed on activation.

### US-7 Operate: deploy, update, back up, monitor (Phase A, P2)

**Acceptance scenarios**:

1. **Given** the compose example, **Then** it runs with `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs, healthcheck and resource limits, and nothing else needs to be configured but `PUBLIC_BASE_URL`.
2. **Given** `docs/operations.md`, **Then** it holds setup, run, stop, health endpoints, deploy and update, backup and restore, the architecture summary and the limits table with numbers (baseline section 6), and the numbers equal the ones in code.
3. **Given** an older data volume, **When** the new image starts, **Then** migrations apply forward only, a backup of the database is taken first, and a checksum mismatch or a newer schema stops the start with a clear code.

### US-8 Contribute safely: CI gates and supply chain (Phase A, P2)

**Acceptance scenarios**:

1. **Given** a pull request, **Then** the jobs `enforce-version-bump`, `agent-instructions-lint`, `quality`, `e2e` and `image` run under exactly those names; `analyze` (CodeQL) runs too.
2. **Given** a push to the integration branch or a manual dispatch, **Then** `publish` builds amd64 and arm64, pushes to GHCR, signs the digest keylessly (public repositories only, A-62), attaches SBOM and provenance attestations, and writes the version image tag only in the run that created the git tag, never when the git tag already exists (baseline section 5).
3. **Given** a regression in a guard (for example a header removed), **Then** the guard fails with the exact remediation in its message.

### US-9 Read the documentation in Dutch or English (Phase A, P3)

**Acceptance scenarios**: README (Dutch and English) lets a newcomer run the image in five minutes and shows light and dark screenshots and a short demo GIF; `docs/architecture.md`, `docs/security.md`, `docs/permissions.md`, `docs/operations.md`, `docs/open-points.md` and `docs/adr/` exist and pass the docs contract (FR-A-180 to FR-A-188).

### Outline stories for later phases

| Story | Phase | Priority | Outline |
|---|---|---|---|
| US-10 First-run wizard | B | P1 | **Given** an empty `/data`, **When** I open the panel, **Then** `/setup` starts: environment check, device-code sign-in with a temporary administrator, automatic tenant configuration (app registration, service principal, certificate, permissions and consent, Exchange role), verification with retry and backoff, branding step, language, lock (`setup_completed`). Every step shows status and a rollback hint and can be resumed. |
| US-11 Sign in with Entra and get exactly the panel's rights | B | P1 | OIDC code flow with PKCE, server-side session, group membership re-evaluated at each sign-in; a user without a role cannot sign in even as Global Administrator; the first wizard account becomes Owner. |
| US-12 Recover the connection | B | P3 | "Herstel verbinding" re-runs the relevant wizard steps. |
| US-13 List and inspect users | C | P1 | Searchable, sortable, paginated list; detail page with group memberships. |
| US-14 Manage group membership | C | P1 | Add and remove members of M365 and security groups, multi-select and bulk; dynamic, synced and role-assignable groups shown read-only. |
| US-15 Manage distribution list membership | D | P1 | Add and remove users and contacts through Exchange; nested and dynamic lists handled. |
| US-16 Manage mail contacts | D | P1 | Create, edit, delete with validation and a confirmation naming the object; DL membership visible. |
| US-17 Export a distribution list as CSV | D | P1 | Column picker with live preview, Laposta preset, separator and BOM options, formula-injection protection, audit entry, permission `distributionlists:export`. |
| US-18 Administer roles and scopes | D | P1 | Roles, assignments to users and Entra groups, scopes, expiry, effective permissions, "view as", template *Bestuur*. |
| US-19 Read and export the audit log | D | P2 | Filterable view and CSV export of the hash-chained log. |
| US-20 Hardening and tenant e2e | D | P1 | OpenTelemetry (disableable), Bicep example, permission audit, break-glass hardening, ASVS L2 mapping complete, optional e2e suite against a developer tenant, final risk list and follow-up ideas. |

---

## 5. Edge Cases

Every row names the behaviour that is required, not a hope. "Enforced by" uses the vocabulary of section 2.

| ID | Situation | Required behaviour | Enforced by |
|---|---|---|---|
| E-01 | Hostile uploads (scripted SVG, XXE, entity bombs, polyglots, pixel bombs, type confusion, metadata payloads, path tricks, slow or oversized bodies) | Every fixture in Appendix A ends as listed there: rejected with a stable problem code or neutralised; nothing active or identifying is stored or served; no outbound connection; the outcome is audit-logged; temporary files are removed. | `server/branding/hostile-uploads.test.ts`, `server/branding/svg-sanitiser.test.ts`, `e2e/branding-xss.spec.ts` |
| E-02 | Upload exactly at and just above the limit; chunked body without `Content-Length`; client aborts mid-upload | 2,097,152 bytes of a valid image is accepted; one byte more is refused with 413 (request bodies above the 2,162,688-byte request cap are cut off while streaming); an abort leaves no temporary file. | `server/branding/upload-pipeline.test.ts` (H-35, H-36) |
| E-03 | Accent colour with no accessible variant (white, black, `#FFFF00`, a grey exactly at the 4.5:1 boundary, fully desaturated colours, near-white and near-black) | The stored value is what the user chose; the effective tokens are adjusted per theme to meet FR-A-101; the UI shows chosen and effective colour and a short explanation; saving is never blocked. | `shared/accent.property.test.ts`, `e2e/branding.spec.ts` |
| E-04 | Invalid accent input (`red`, `#12`, `#GGGGGG`, `#11223344`, `rgb(1,2,3)`, empty) | 422 `accent_invalid`; `#ABC` is stored as `#aabbcc`. | `shared/accent.property.test.ts`, `server/branding/branding-api.test.ts` |
| E-05 | Missing logo, or only one of light/dark, or no compact variant, or a stored logo file deleted from `/data/branding` | No logo: monogram tile in sidebar, favicon, manifest and apple-touch icons. One logo: used in both themes, on a contrasting plate where it would be illegible (A-39). No compact: derived by fitting the light logo into a square. File deleted: asset URL answers 404, the UI falls back to the monogram, a `branding_asset_missing` warning is logged at start, `/readyz` stays 200. | `server/branding/upload-pipeline.test.ts`, `server/branding/serve-assets.test.ts`, `e2e/branding.spec.ts` |
| E-06 | `prefers-reduced-motion: reduce` | No animation runs; state changes are instant or opacity-only; no spring, no parallax. | `e2e/reduced-motion.spec.ts` |
| E-07 | Right-to-left is not in scope | Locales are nl and en only; the document direction is always `ltr`. Organisation names in RTL scripts render inside an isolating element so surrounding UI does not reorder; bidi control characters are rejected (FR-A-081). Logical CSS properties are preferred so adding an RTL locale later is cheap (FR-A-135, SHOULD, not enforced). | `shared/org-name.test.ts`, `e2e/branding-xss.spec.ts` |
| E-08 | Offline PWA | Navigation offline shows the offline page (nl and en together); cached hashed assets still load; `/api` is never served from cache; saving is disabled with a translated reason; nothing is queued. | `web/sw-routing.test.ts`, `e2e/offline.spec.ts` |
| E-09 | Clock skew and clock steps | All stored times are server UTC; the client clock is never used for a security decision. Audit order is by `seq`, never by time; a backward time step is stored as is and does not break `verifyChain`. A CSRF token is valid while `iat` is not more than 5 minutes in the future and `exp` (plus 60 s leeway) is not past; otherwise `csrf_invalid` and the client fetches a new token once. (OIDC leeway is Phase B.) | `server/csrf.test.ts` (fake clock), `server/audit.test.ts` |
| E-10 | Data volume read-only, not writable, full, locked or corrupt | Not writable at start: degraded mode (FR-A-013). Turns read-only or full later: affected writes fail with 503 `storage_unavailable`, nothing is half-applied (change and audit entry share one transaction), `/readyz` flips to 503. Locked: 503 `storage_busy` with `Retry-After: 1`. Corrupt: `/readyz` 503 `database_corrupt`, no automatic repair, restore from backup per `docs/operations.md`. The test fixture for "not writable" must not rely on `chmod`, because root ignores mode bits. | `server/lifecycle.test.ts`, `server/db.test.ts`, `image` smoke test |
| E-11 | Concurrent branding writes (two tabs, two administrators, save versus import, the same file uploaded twice) | One winner per revision; the loser gets 412 `branding_conflict` and the UI offers reload; identical uploads converge on one content-addressed file; revision increments exactly once per accepted change. | `server/branding/concurrency.test.ts`, `e2e/branding.spec.ts` |
| E-12 | Very long organisation names, and names at the limits | 64 grapheme clusters / 256 bytes accepted, one more rejected with `org_name_invalid`; sidebar, header, breadcrumbs and dialogs truncate with an ellipsis and expose the full name through an accessible name; `short_name` is cut at a grapheme boundary to 12; `<title>` is not truncated by the server; audit detail truncates values to 256 bytes. | `shared/org-name.test.ts`, `server/branding/manifest.test.ts`, `e2e/branding.spec.ts` |
| E-13 | Emoji, diacritics or non-Latin organisation names in monogram initials | `deriveInitials` skips non-word-like segments (emoji, symbols), uses grapheme clusters (so "Élan" gives É, and a ZWJ emoji is never split), handles one-word and multi-word names. `monogramGlyphs` maps to A to Z and 0 to 9 with Latin transliteration and otherwise returns the generic pictogram; the tile and the icons always agree. Examples: "Acme Corp" gives AC; "élan vital" gives EV; "Ørsted" gives O; "🚀 Rocket" gives R; "株式会社" gives the pictogram; "3M" gives 3. | `shared/initials.test.ts`, `server/branding/icons-no-fonts.test.ts` |
| E-14 | The page is opened from an address other than `PUBLIC_BASE_URL` (for example `127.0.0.1` instead of `localhost`, or a proxy host that was never configured) | Reads work; writes fail with 403 `origin_not_allowed`; the UI explains which origin the server expects (taken from `/api/v1/me`). DNS-rebinding pages fail the same way. | `server/csrf.test.ts`, `e2e/branding.spec.ts` |
| E-15 | `TRUST_PROXY` mis-set | Too narrow: every client shares the proxy's bucket (documented symptom). Too wide: `X-Forwarded-For` is forgeable (documented risk). The effective mode is logged once at start without addresses; `docs/operations.md` has a checklist. | `server/trust-proxy.test.ts`, `server/logging.test.ts` |
| E-16 | HSTS configuration | `http` base URL and no trusted `X-Forwarded-Proto: https`: no header. `https` base URL: plain `max-age` on every host the app answers on. Opt-ins only through env, and `includeSubDomains` and `preload` only on the host of `PUBLIC_BASE_URL` (a request for any other host, such as an alias, an IP address or an internal name, gets the plain form). `HSTS_PRELOAD=true` without `HSTS_INCLUDE_SUBDOMAINS=true`, or with `max-age` below 31,536,000: configuration error at start. | `server/hsts.test.ts`, `server/config.test.ts` |
| E-17 | `PREVIEW_MODE=true` on a non-local public URL, or reached through a name or proxy other than loopback although the configured URL is loopback | Refuse to start on a non-loopback `PUBLIC_BASE_URL` unless `PREVIEW_MODE_ALLOW_REMOTE=true`; with the override the warning and the banner remain. Without the override a request whose `Host` is not loopback, or that carries `Forwarded` or `X-Forwarded-*` headers, is resolved as the anonymous actor (FR-A-036). | `server/config.test.ts`, `server/preview-mode.test.ts`, `e2e/preview-removed.spec.ts` |
| E-18 | Browser features missing or blocked: storage (private mode), service workers, Trusted Types, JavaScript | Storage blocked: theme, language and sidebar fall back to in-memory defaults and the app works. No service worker: no PWA, no offline page, everything else works. Trusted Types unsupported: the directive is ignored by the browser and the code does not depend on it. JavaScript off: a `<noscript>` message in both languages. The app sets no cookies in Phase A (A-56). | `web/storage.test.ts`, `e2e/i18n-theme.spec.ts` (storage-blocked project), `e2e/pages.spec.ts` |
| E-19 | Viewport and zoom extremes: 320 CSS px wide, 200 % text zoom, 3440 px ultrawide, landscape phone | No horizontal scroll at 320 px; no loss of content at 200 % zoom; content is capped and centred on ultrawide; sticky header never hides the focused element. | `e2e/responsive.spec.ts`, `e2e/keyboard.spec.ts` |
| E-20 | Locale edge cases | Browser prefers `de-DE` only: English. `nl-BE`: Dutch. A stored choice always wins. A problem code the catalogue does not know (newer server, older cached app): generic message plus the code and request id. | `web/locale-detection.test.ts`, `web/error-boundary.test.tsx` |
| E-21 | Stale app versus newer server | `/api/v1/me.version` differing from the running app's build version raises the "Update available" toast; additive API changes never break an older client (unknown fields ignored). | `e2e/pwa.spec.ts` |
| E-22 | Hostile or malformed branding import (wrong or newer `schemaVersion`, extra or duplicate keys, `__proto__`, invalid base64, media type that does not match the bytes, depth bombs, 9 MiB plus one byte) | Rejected before anything is applied (`import_invalid`, `import_unsupported_version`, 413); an image that fails the pipeline fails the whole import; `?dryRun=true` shows the outcome without applying. | `server/branding/export-import.test.ts` (H-42) |
| E-23 | A hostile unauthenticated client floods write routes (each denial is audited) | The write and upload buckets bound the rate (at most 10 rows per burst, 30 per minute per client address); 429 responses are not audited; growth and retention are documented and revisited in Phase D (R-09). Disk full: writes fail with 503, never unaudited. | `server/rate-limit.test.ts`, `server/audit-integration.test.ts` |
| E-24 | Two containers on one volume, or a network-filesystem volume | Unsupported and documented: SQLite WAL needs shared memory on one host and does not work over a network filesystem (sqlite.org/wal.html, read 2026-10-10). Locking keeps the data consistent, but readiness may report `storage_busy`. | `docs/operations.md` (docs contract); R-10 |
| E-25 | Container run with another uid, or a bind mount owned by someone else | `/readyz` 503 `data_dir_not_writable` with the remedy in the UI and in `docs/operations.md` (`chown 65532:65532`, or a named volume, which inherits the image's ownership). | `server/lifecycle.test.ts`, `server/docs-contract.test.ts` |
| E-26 | Shutdown while a request is in flight | Drain up to 10 s; an upload in progress is aborted with 503; a write is either committed together with its audit entry or rolled back; leftover temporary files are removed at the next start; exit code 0 when drained. | `server/lifecycle.test.ts` |
| E-27 | Injection through names and headers (path traversal in `/branding/<name>`, NUL, uppercase hex, wrong length, `.png.exe`; hostile `X-Request-Id`; multipart `filename="../../x"`; CRLF in values) | 404 for any asset name not matching `^[0-9a-f]{64}\.png$`; inbound request ids that do not match the pattern are replaced; client filenames are ignored; headers are never built from unvalidated input. | `server/branding/serve-assets.test.ts` (H-43), `server/api-conventions.test.ts` (H-38) |
| E-28 | Many simultaneous image jobs, or a job that never finishes | At most 2 run, up to 4 wait, the rest get 429 `image_processing_busy`; memory stays bounded; a job over its 10 s budget gives 422 `image_processing_timeout` and its child process is killed. | `server/branding/hostile-uploads.test.ts` (H-39), `server/branding/job-runner.test.ts` |

---

## 6. Requirements

### 6.1 Functional Requirements, Phase A

Format: ID, level, requirement, enforcement. Where a row names a CI job, that job is defined by FR-A-170 and FR-A-171.

#### Repository and toolchain

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-001 | MUST | The repository is a pnpm workspace with `apps/server` (`@m365portal/server`), `apps/web` (`@m365portal/web`), `packages/shared` (`@m365portal/shared`), `e2e` (`@m365portal/e2e`), plus `deploy/`, `docs/`, `specs/`, `scripts/`, `Dockerfile` and `docker-compose.yml` at the root. Root scripts `lint`, `typecheck`, `test`, `build` and `e2e` exist. | `quality` (runs them); `shared/repo-conventions.test.ts` (layout and script names; a test file named like one sits only where its runner collects it, so none is dead) |
| FR-A-002 | MUST | `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass from a clean checkout with no manual step. Generated routing artefacts are produced by the build or are committed and checked for drift. | `quality` (fresh checkout, `pnpm install --frozen-lockfile`) |
| FR-A-003 | MUST | TypeScript strict everywhere through one `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` and `noFallthroughCasesInSwitch`; `any` is an ESLint error unless disabled with a reason. | `shared/repo-conventions.test.ts` (flags present; none of the `strict` family switched off in the effective options of any tsconfig, tests included, with the whole `extends` chain resolved); `quality` (typecheck, lint) |
| FR-A-004 | MUST | ESLint flat config with type-aware typescript-eslint rules, `eslint-plugin-jsx-a11y` and `eslint-plugin-react-hooks`; Prettier check; zero warnings (`--max-warnings 0`). Versions per A-28. | `quality` (`pnpm lint`) |
| FR-A-005 | MUST | Node 22 and pnpm are pinned (`.nvmrc`, `engines`, `packageManager` with an exact version); the lockfile is committed; installs use `--frozen-lockfile`; no `latest` or open ranges for build tooling. | `quality` (frozen install); `shared/repo-conventions.test.ts` (dependencies, `overrides` and `resolutions` pinned; the last `save-exact` assignment of `.npmrc`; the lockfile not ignored by any `.gitignore` line, with git's own matching rules) |
| FR-A-006 | MUST | Every direct production dependency of every package appears in the dependency table of `docs/architecture.md` with a one-line reason (AGENTS.md section 7). | `server/docs-contract.test.ts` |
| FR-A-007 | MUST | No runtime CDN and no third-party request: during the e2e run every request the browser makes is same-origin. | `e2e/no-external-requests.spec.ts` |
| FR-A-008 | MUST | One normaliser per displayed value (baseline section 10): organisation-name normalisation and the short-name cut (`shortOrgName`), accent hex normalisation, initials, monogram glyph mapping, locale-tag normalisation, problem-code to message mapping and the permission catalogue are each defined once, in `packages/shared`. | `shared/single-implementation.test.ts`: asserts on the source and fails on the presence of a second definition outside `packages/shared` (the test directories of the packages excluded, the folders of the sources not), including the same function under another spelling (names that contain a concept stem, with an `EXEMPTIONS` record) and the tell-tales of a second implementation (+ negative); once a module has landed it must define the names its row guards |
| FR-A-009 | MUST | No raw colour literal and no Tailwind arbitrary colour value in `apps/web/src` outside the token module (AGENTS.md section 6). | `shared/repo-conventions.test.ts` (source scan of every text file of `apps/web/src`: hex, colour functions, named colours, Tailwind arbitrary values and palette utilities); `quality` (lint rule `local/no-raw-colour`) |

#### Configuration and lifecycle

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-010 | MUST | Configuration is environment variables plus `/data` only, parsed and validated by one Zod schema. Invalid configuration stops the process with a non-zero exit before listening, and the log names the variables, never their values. Phase A variables: `PORT` (9300, see FR-A-016), `HOST` (0.0.0.0), `DATA_DIR` (/data), `PUBLIC_BASE_URL` (default `http://localhost:<PORT>`), `TRUST_PROXY` (none), `PREVIEW_MODE` (false), `PREVIEW_MODE_ALLOW_REMOTE` (false), `SHOWCASE` (false), `LOG_LEVEL` (info), `HSTS_MAX_AGE` (31536000), `HSTS_INCLUDE_SUBDOMAINS` (false), `HSTS_PRELOAD` (false). | `server/config.test.ts` (+ negative) |
| FR-A-011 | MUST | `.env.example` lists exactly the variables the schema knows plus the Compose-only `HOST_PORT` (marked as not read by the application), with placeholders or defaults only; `docs/operations.md` carries the same table. No real secret appears anywhere in the repository. | `server/deploy-files.test.ts` (parity with the configuration schema); `server/docs-contract.test.ts`; `quality` (secret scan) |
| FR-A-012 | MUST | Start order: validate configuration, open and migrate the database, then listen. A failing migration or checksum mismatch exits non-zero before listening. | `server/lifecycle.test.ts` |
| FR-A-013 | MUST | Degraded mode (A-35): when `DATA_DIR` is not writable or the database cannot be opened, the process still listens. `/healthz` answers 200; `/readyz` answers 503 naming `data_dir_not_writable` or `database_unavailable`; every `/api/v1` route that needs storage answers 503 `storage_unavailable`; `/api/v1/me` and the static UI still work (the HTML shell is rendered with default branding) and the UI shows the storage-unavailable page. | `server/lifecycle.test.ts` (unwritable fixture without `chmod`); `image` smoke test |
| FR-A-014 | MUST | Graceful shutdown on SIGTERM and SIGINT: stop accepting, drain up to 10 s, close the database so the WAL is checkpointed, exit 0 (exit 1 if the drain timed out). The process works as PID 1. | `server/lifecycle.test.ts` (spawns the built server, signals it, checks exit code and absence of a `-wal` file); `image` smoke test (`docker stop` exits 0 within 10 s) |
| FR-A-015 | MUST | At start the server logs once, at info level, the effective posture without values or addresses: preview mode, trust-proxy mode, HSTS mode, showcase, storage writable, schema version. | `server/logging.test.ts` |
| FR-A-016 | MUST | Ports are configurable from `.env` so the panel never has to collide with another service on the Docker host. `PORT` is the port the process listens on inside the container (default 9300; accepted range 1024-65535, because the container runs unprivileged with all capabilities dropped; anything else, including 0, an empty value and non-numeric input, is a configuration error that names `PORT`). `HOST_PORT` is a Compose-only variable that the application never reads: the port published on the Docker host (default 9300). `docker-compose.yml` maps `"${HOST_PORT:-9300}:${PORT:-9300}"`, passes `PORT` to the container and defaults `PUBLIC_BASE_URL` to `http://localhost:${HOST_PORT:-9300}`, because the browser reaches the panel on the HOST port and A-31 compares every write against that origin. The image `HEALTHCHECK`, the dev proxy, the e2e `webServer` (variable `E2E_PORT`, default 4173) and every example in the documentation derive from the same variables; the literal default `9300` is defined once per file kind (config default, `Dockerfile` ENV, `.env.example`, Compose defaults). The `origin_not_allowed` problem names the expected origin and the `PUBLIC_BASE_URL` variable, so a host port that was changed without it is diagnosable. A low host port (80, 443) is reached with `HOST_PORT`, never with a low `PORT`. | `server/config.test.ts` (range, with negatives 0, 80, 1023, 65536, `abc`, empty, `9300 `); `server/deploy-files.test.ts` (Compose mapping, `PUBLIC_BASE_URL` default, `.env.example` parity); `shared/repo-conventions.test.ts` (no stray literal port in source); `image` smoke test (second run with `PORT=18080`: `/healthz` answers there and the container health status becomes `healthy`) |

#### HTTP API conventions

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-020 | MUST | All API routes live under `/api/v1` (health at `/healthz` and `/readyz`, images at `/branding/`, PWA files at the root). JSON in and out, UTF-8. Unknown `/api/*` paths answer a 404 problem (never HTML); a wrong method answers 405 with `Allow`; JSON write routes require `Content-Type: application/json` (otherwise 415 `unsupported_media_type`). | `server/api-conventions.test.ts` |
| FR-A-021 | MUST | The OpenAPI 3.1 document is generated from the Zod route schemas and served at `/api/v1/openapi.json`. There is no hand-written duplicate. Every registered route is documented and every documented route is registered; the document validates against the OpenAPI 3.1 meta-schema. | `server/openapi.test.ts` (+ negative: an undocumented route fails) |
| FR-A-022 | MUST | Errors are RFC 9457 `application/problem+json` with `type` (a URN per code), `title`, `status`, `detail` (English, never sensitive), `code` (stable machine code), `requestId`, and for validation `errors[]` with `pointer` and `code`. The code registry (section 6.4) lives in `packages/shared`. Unhandled errors answer 500 `internal_error` with a generic body. | `server/problem.test.ts` |
| FR-A-023 | MUST | The server never leaks stack traces, SQL, file paths or secrets in a response. | `server/no-leak.test.ts` (a canary secret thrown inside a handler must appear in neither response nor log) |
| FR-A-024 | MUST | Every response carries `X-Request-Id`. An inbound id is accepted only if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise it is replaced. The id appears on every log line of the request, in problem bodies and in audit entries. | `server/api-conventions.test.ts`; `server/logging.test.ts` |
| FR-A-025 | MUST | Request size and time limits follow the limits table (section 6.5) and are enforced while the body streams. Exceeding a size limit answers 413 `payload_too_large`. Node's header-size and timeout options are set explicitly. | `server/body-limits.test.ts` |
| FR-A-026 | MUST | `/healthz` (liveness) answers 200 with `{status, version}`; `/readyz` (readiness) reports database open, schema at the expected version and data directory writable as `{status, checks[{name, ok}]}` with 200 or 503 and never raw error text. Both are unauthenticated, `no-store`, and exempt from rate limiting and CSRF; because `/readyz` is exempt, its whole result (the write probe included) is cached for 2 seconds. | `server/health.test.ts` |
| FR-A-027 | MUST | `GET /api/v1/me` (public) returns actor kind, id and label, the permission list, `features` (`showcase`, `preview`; `preview` is true only when the request resolved to the preview actor, FR-A-036), the app version, the configured public origin and `storageAvailable`. `GET /api/v1/csrf` (public) returns a CSRF token (FR-A-044). These two are the whole metadata endpoint set: `/api/v1/meta` and `/api/v1/session` are not created (`/session` is reserved for Phase B). | `server/policy.test.ts`; `server/csrf.test.ts` |

#### Actor and policy layer

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-030 | MUST | An `Actor` interface (`kind`, `id`, `label`, `permissions`) and one `authorize(actor, permission, resource?)` function in `apps/server/src/policy`. Deny by default. The `resource` parameter exists from the start (unused in Phase A) so scopes in Phases B and D change no signature. The permission catalogue is one typed list in `packages/shared` with exactly the permissions of brief section 2a: `users:read`, `groups:read`, `groups:members:write`, `distributionlists:read`, `distributionlists:members:write`, `distributionlists:export`, `contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete`, `audit:read`, `audit:export`, `settings:branding`, `settings:connection`, `rbac:manage`. | `server/policy.test.ts`; `shared/permissions.test.ts` (the catalogue equals the brief's 15 permissions); `server/docs-contract.test.ts` (`docs/permissions.md` lists the same 15) |
| FR-A-031 | MUST | Every route registration declares exactly one of `permission: <catalogue entry>` or `public: true`. A route without a declaration is a type error and the application refuses to boot if one is found at runtime. | `server/route-table.test.ts` (+ negative: registers an undeclared route and expects boot failure) |
| FR-A-032 | MUST | Exactly two actor resolvers exist: anonymous (no permissions) and preview (all catalogue permissions), the latter only when `PREVIEW_MODE=true`. With preview mode on: a warning on the log and on stderr at start; `/api/v1/me` reports `preview: true`; the UI shows a persistent banner on every route that cannot be dismissed; audit entries name the actor `preview`. `docs/security.md` and an ADR state that preview mode is removed or replaced in Phase B. | `server/preview-mode.test.ts`; `e2e/preview-removed.spec.ts` |
| FR-A-033 | MUST | Without preview mode every write route (any method other than GET, HEAD or OPTIONS under `/api/v1`) answers 403 `permission_denied` (A-29). | `server/policy.test.ts` (table-driven over the route table) |
| FR-A-034 | MUST | Every denied authorisation, Origin or CSRF decision on a write route appends an audit entry (outcome `denied`, actor, route id, required permission, request id, client address, reason code) before the response is sent. Rate-limited requests are not audited. | `server/audit-integration.test.ts` |
| FR-A-035 | MUST | With `PREVIEW_MODE=true` and a `PUBLIC_BASE_URL` whose host is not loopback (`localhost`, `127.0.0.0/8`, `::1`), startup fails unless `PREVIEW_MODE_ALLOW_REMOTE=true` (A-30). | `server/config.test.ts` |
| FR-A-036 | MUST | The guard of FR-A-035 checks the configured name, and the default `PUBLIC_BASE_URL` (`http://localhost:<PORT>`) is loopback even when the port is published to a network or a reverse proxy forwards to it. So, unless `PREVIEW_MODE_ALLOW_REMOTE=true`, the preview resolver returns the preview actor only for a request whose `Host` header names a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`) and that carries no `Forwarded`, `X-Forwarded-*` or `X-Real-IP` header; every other request is the anonymous actor. The rule can only downgrade an actor, never upgrade one. The start posture line (FR-A-015) says that preview mode refuses such requests. `docs/security.md`, the README and the phase report state that this prevents accidental exposure and is not a security boundary (a non-browser client can forge `Host`): the boundary is publishing the port on loopback only (`-p 127.0.0.1:<port>:<port>`). | `server/preview-mode.test.ts`: `Host` and forwarding-header matrix (a LAN `Host`, an IP `Host` outside loopback, `X-Forwarded-For`, `Forwarded` and `X-Real-IP` each give the anonymous actor; `[::1]:9300` and `127.0.0.2` give the preview actor; the override lifts the rule) (+ negative: a resolver that ignores `Host` fails) |

#### Web security

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-040 | MUST | Every response carries the security headers of section 6.3 with the values given there. The one exception is a response Node itself writes before the application sees the request (protocol-level 400, 408 and 431 with `Connection: close` and no body); it carries no body and no `Server` header, and `docs/security.md` says so. | `server/security-headers.test.ts` (+ negative: removing a header fails); `server/body-limits.test.ts` (the Node-level responses) |
| FR-A-041 | MUST | CSP: a fresh nonce per request (at least 128 bits, base64, never reused); no `unsafe-inline`, `unsafe-eval`, wildcard or `data:` in `script-src` or `style-src`; one function builds the policy. | `server/security-headers.test.ts` (two requests give different nonces; the policy string is parsed and asserted) |
| FR-A-042 | MUST | Trusted Types: `require-trusted-types-for 'script'` with a `trusted-types` allow-list; the web app creates policies only in one module. Every e2e test fails on a `securitypolicyviolation` event, a `pageerror`, a `console.error` or a console warning that mentions `Permissions-Policy` (a browser upgrade that drops a feature name is noticed). | e2e fixture (FR-A-157); `e2e/csp.spec.ts` |
| FR-A-043 | MUST | HSTS (baseline section 13): emitted only when the effective scheme is https (`PUBLIC_BASE_URL` is https, or the request comes from a trusted proxy with `X-Forwarded-Proto: https`). Every https response gets plain `max-age=<HSTS_MAX_AGE>`. `includeSubDomains` is added only with `HSTS_INCLUDE_SUBDOMAINS=true` **and** when the request host (the `Host` header without port and trailing dot, lower case) equals the host of `PUBLIC_BASE_URL`, the one host the operator declared and therefore owns; an alias, an IP address, an internal name or a missing `Host` gets the plain form. `preload` only with `HSTS_PRELOAD=true` on that same host, which in turn requires `includeSubDomains` and `max-age` of at least 31,536,000, otherwise a configuration error. | `server/hsts.test.ts`: asserts both directions (flags present for the declared host with the opt-ins and absent for every other host; plain `max-age` present on every https host; flags absent by default; nothing over http) (+ negative: a function that always adds `includeSubDomains` fails) |
| FR-A-044 | MUST | Origin and CSRF (A-31 to A-33). Every request under `/api/v1` with a method other than GET, HEAD or OPTIONS must carry an `Origin` equal to the origin of `PUBLIC_BASE_URL`; if `Sec-Fetch-Site` is present it must be `same-origin`; a request with neither `Origin` nor `Sec-Fetch-Site` is rejected; and it must carry `X-CSRF-Token`: an HMAC-SHA-256 signed `iat.exp.nonce`, key in memory per process, TTL 8 h, issued by `GET /api/v1/csrf`, validated by a function that takes a `binding` value (empty now, the session id from Phase B). Codes `origin_not_allowed` and `csrf_invalid`. A GET route that writes an audit entry (`GET /api/v1/branding/export`) applies the `Sec-Fetch-Site` rule too (absent, `same-origin` or `none` pass; `same-site` and `cross-site` give 403 `origin_not_allowed`, not audited), so a cross-site `<img>` or form cannot make the server write audit rows. The design is recorded in `docs/security.md` so Phase B can bind it to the session. | `server/csrf.test.ts`: full matrix of Origin, Sec-Fetch-Site and token states, including the audited GET (+ negative) |
| FR-A-045 | MUST | Rate limiting: in-memory token buckets per client address, `read`, `write` and `upload`, values in the limits table. Excess answers 429 `rate_limited` with an integer `Retry-After`. At most 10,000 tracked clients, idle entries evicted. `/healthz`, `/readyz` and static assets are exempt. The clock is injectable. | `server/rate-limit.test.ts` |
| FR-A-046 | MUST | `TRUST_PROXY` (default `none`) governs how the client address and `X-Forwarded-Proto` are read. `none` uses the socket peer. A hop count or CIDR list trusts only those peers and reads `X-Forwarded-For` from right to left, skipping trusted hops. Headers from untrusted peers are ignored. | `server/trust-proxy.test.ts` (spoofing cases) |
| FR-A-047 | MUST | No CORS: no `Access-Control-*` header is ever sent, and preflights are not answered. | `server/security-headers.test.ts` |
| FR-A-048 | MUST | Static serving only from the build output directory: no listing, no dotfiles, safe against traversal (plain, encoded, double-encoded, backslash, NUL); SPA fallback only for GET navigations accepting HTML outside `/api`, `/branding` and asset paths; correct `Content-Type`; an unknown asset answers 404, never `index.html`. | `server/static.test.ts` |
| FR-A-049 | SHOULD | `X-Robots-Tag: noindex, nofollow` on every response and a `/robots.txt` that disallows everything. | `server/security-headers.test.ts` |
| FR-A-050 | MUST | Cache rules: HTML shell `no-store`; hashed build assets and `/branding/<hash>.png` `public, max-age=31536000, immutable`; `/api/*` and health `no-store`; `/sw.js` and `/manifest.webmanifest` `no-cache` with an ETag. | `server/cache-headers.test.ts` |
| FR-A-051 | MUST | Logging: pino JSON on stdout, level from `LOG_LEVEL`. Redaction of `authorization`, `cookie`, `set-cookie`, `x-csrf-token` and any key containing password, secret, token, key or credential. A request line holds request id, method, route template, status and duration only: no query string, body, IP address, e-mail address or organisation name. | `server/logging.test.ts`: canary secrets and PII patterns over the captured output |

#### Persistence and migrations

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-060 | MUST | SQLite through better-sqlite3 at `${DATA_DIR}/m365portal.sqlite` in WAL mode with foreign keys on and a busy timeout; schema in Drizzle; every query parameterised; no SQL assembled from strings outside migrations. | `server/db.test.ts` (PRAGMAs); `quality` (lint rule banning string-built SQL) |
| FR-A-061 | MUST | Migrations are forward-only SQL files generated by drizzle-kit and applied at start, all pending migrations in one transaction (the stock Drizzle migrator re-verifies nothing, so the application adds the checksum re-verification, the newer-schema detection and the foreign-key handling around it). The SHA-256 of every applied migration is recorded. At start the recorded checksums must equal the shipped files, otherwise the process exits with `migration_checksum_mismatch`; a database from a newer schema exits with `schema_newer_than_app`. | `server/migrations.test.ts` (+ negative: an edited migration file) |
| FR-A-062 | MUST | The schema of every shipped schema version is exported and committed under `apps/server/schema-snapshots/` before it is needed (baseline section 2). A CI step regenerates the snapshot of the current version from the migrations and fails if the committed file is missing or differs; a drift step fails if `drizzle-kit generate` would produce changes. | `quality` steps "Schema snapshot check" and "Schema drift check"; `server/migrations.test.ts` |
| FR-A-063 | MUST | An upgrade test (baseline section 2) opens a database at version N from the committed snapshot, applies the migrations and compares the result with the committed snapshot of N+1 (tables, columns, types, defaults, indexes, triggers). Phase A has one schema version, so the harness is proven on a synthetic fixture pair that includes a deliberately drifting migration which must fail. | `server/migrations.upgrade.test.ts` (+ negative) |
| FR-A-064 | SHOULD | Before applying pending migrations to an existing database, take a consistent copy (SQLite backup API) to `/data/backups/pre-migrate-<from>-<to>.sqlite` and keep the last 3. | `server/migrations.test.ts` |
| FR-A-065 | MUST | SQLite failures map to problems: read-only, full or I/O error gives 503 `storage_unavailable`; busy gives 503 `storage_busy` with `Retry-After: 1`; corruption makes `/readyz` report `database_corrupt` without automatic repair. | `server/db.test.ts` (injected failures) |
| FR-A-066 | MUST | Phase A tables: migration bookkeeping, `branding` (one row), `branding_asset` (content hash registry with creation time and `unreferenced_at`, null while the applied branding references the asset), `audit_log`. | `server/migrations.upgrade.test.ts` (snapshot content) |

#### Audit store

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-070 | MUST | `audit_log` is append-only with a SHA-256 hash chain: `hash = SHA-256(prev_hash concatenated with canonical_json(entry))`; the first `prev_hash` is 32 zero bytes; canonical JSON has sorted keys and no insignificant whitespace; SQLite triggers abort UPDATE and DELETE; appends run in `BEGIN IMMEDIATE` so concurrent writers cannot fork the chain. Columns: `seq`, `ts` (UTC ISO-8601 with milliseconds), `actor_kind`, `actor_id`, `action`, `target_type`, `target_id`, `outcome` (one of success, denied, rejected, error), `reason_code`, `client_ip`, `request_id`, `detail` (JSON, at most 4,096 bytes), `prev_hash`, `hash`. | `server/audit.test.ts` (50 parallel appends give a valid, gap-free chain) |
| FR-A-071 | MUST | `verifyChain(db, {from?, to?})` streams the table in constant memory and returns `{ok, checked, firstBadSeq?}`. It detects a changed row, a deleted row, a reordered row and a forged hash. | `server/audit.test.ts`: each tamper fixture (applied by dropping the trigger inside the test) must be detected (+ negative) |
| FR-A-072 | MUST | The audit writer is used for: denied writes (FR-A-034), branding asset upload (accepted and rejected), branding apply, reset, import (accepted and rejected) and export. A branding change and its audit entry are written in one transaction: no change without an entry and no entry without its change. | `server/branding/audit-branding.test.ts` (a fault injected between the two rolls both back) |
| FR-A-073 | MUST | Audit `detail` never holds secrets or request bodies: images are recorded by hash and size, names as old and new value truncated to 256 bytes. The client address lives in the audit table only; it is personal data and is documented as such. | `server/audit-integration.test.ts`; `server/docs-contract.test.ts` |
| FR-A-074 | SHOULD | Each append logs the new head (`seq` and `hash` only) so an external log pipeline can anchor the chain and detect tail truncation. | `server/audit.test.ts` |
| FR-A-075 | SHOULD | `verifyChain` is runnable inside the image as `node dist/cli.js verify-audit` (no shell needed). | `image` smoke test |

#### Branding backend

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-080 | MUST | `GET /api/v1/branding` (public) returns revision, organisation name and whether it is the default, chosen accent, derived token sets, logo URLs (light, dark, compact) or null, icon URLs and monogram glyphs. Writes require `settings:branding`: `POST /api/v1/branding/assets` (stage an image), `PUT /api/v1/branding` (apply), `DELETE /api/v1/branding` (reset to defaults), `GET /api/v1/branding/export`, `POST /api/v1/branding/import` (with `?dryRun=true`). | `server/branding/branding-api.test.ts` |
| FR-A-081 | MUST | Organisation name: NFC-normalised, trimmed, internal whitespace collapsed, 1 to 64 grapheme clusters and at most 256 bytes of UTF-8. Rejected: control characters (Cc), unpaired surrogates, line and paragraph separators, every Unicode `Default_Ignorable_Code_Point` except U+200C and U+200D (zero-width non-joiner and joiner, allowed) and the variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF (this covers the bidi controls U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069, the invisible U+200B, U+2060, U+FEFF, the soft hyphen U+00AD, the fillers U+3164 and U+FFA0 and the tag characters U+E0001 and U+E0020 to U+E007F), U+2800 (blank Braille), and a name without at least one letter, number, punctuation mark or symbol (a spoofed or empty-looking name in the sidebar, dialogs and audit entries). Default "M365Portal" until Phase B (A-42). | `shared/org-name.test.ts` |
| FR-A-082 | MUST | Accent input: `#rgb` or `#rrggbb` in any case, stored as lowercase `#rrggbb`; anything else gives 422 `accent_invalid`. | `shared/accent.property.test.ts`; `server/branding/branding-api.test.ts` |
| FR-A-083 | MUST | Optimistic concurrency: `PUT`, `DELETE` and `import` require `If-Match` with the current revision (missing gives 428 `precondition_required`, stale gives 412 `branding_conflict`); each accepted change increments the revision exactly once. Staged uploads of identical bytes are idempotent. | `server/branding/concurrency.test.ts` |
| FR-A-084 | MUST | Upload transport: the request body is capped at 2,162,688 bytes while it streams and the file part at 2,097,152 bytes (413 `payload_too_large`); the upload is buffered in memory, so nothing is written before the pipeline has accepted it; the client's filename and `Content-Type` are neither trusted nor stored; the temporary files of atomic writes live in `${DATA_DIR}/branding/.tmp/` (the same filesystem as the target, so the rename cannot fail with `EXDEV`) and are removed on success, failure and abort. | `server/branding/upload-pipeline.test.ts` (H-35 to H-38) |
| FR-A-085 | MUST | Type is decided by content: PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`) or SVG (UTF-8 text whose first element is `svg` in the SVG namespace, after an optional BOM, XML declaration, comments and whitespace). Everything else gives 415 `image_type_unsupported`, including GIF, WebP, AVIF, HEIC, TIFF, BMP, ICO, PDF, gzip and HTML, even where the image library could decode them. | `server/branding/hostile-uploads.test.ts` (H-22, H-31 to H-34) |
| FR-A-086 | MUST | Raster images: a pixel cap of 16,777,216 checked before the full decode (`image_pixels_exceeded`); failure on any decode error, with no tolerant mode (`image_corrupt`); EXIF orientation applied, then all metadata (EXIF, XMP, ICC, text chunks, thumbnails) dropped; converted to sRGB; animated input reduced to its first frame with warning `animation_flattened`. | `server/branding/hostile-uploads.test.ts` (H-25 to H-30, H-40, H-41) |
| FR-A-087 | MUST | SVG: UTF-8 only; any DOCTYPE or ENTITY refused (`svg_doctype_forbidden`); no external resolution, XInclude or processing instruction is ever acted on. A new document is rebuilt from an element and attribute allowlist (published in `docs/security.md`); everything else is dropped and reported as warning `svg_content_removed` with categories. `<text>` and `<tspan>` are rejected (`svg_text_unsupported`, A-38). More than 10,000 elements or depth above 64 is rejected (`svg_too_complex`), and so is a reference cycle or a reference graph that expands (`use`, gradient, clip-path and mask references counted transitively, with no cycle needed) to more than 100,000 element instances; a result with nothing renderable is rejected (`image_empty`). The Phase A allowlist excludes filters, patterns, images, anchors and switches; the output size comes from the `viewBox`, else from `width` and `height`, else the file is refused as `svg_not_wellformed`. Only `url(#id)` and `#id` references inside the document survive; inline `style` is converted to allowlisted presentation attributes; `<style>` elements are dropped. | `server/branding/svg-sanitiser.test.ts` (+ negative); `server/branding/hostile-uploads.test.ts` (H-01 to H-24) |
| FR-A-088 | MUST | The sanitised SVG is always rasterised and is never stored or served as SVG. No outbound network connection is made while processing any upload. | `server/branding/hostile-uploads.test.ts` (H-04, H-05, H-08: a local listener must see zero connections) |
| FR-A-089 | MUST | Variants: masters `logoLight` and `logoDark` (optional) bounded to 512 by 512, and `compact` bounded to 128 by 128 (fitted into a square from the icon source below when absent, and then flagged as derived). Icons: favicon 32, apple-touch 180 (opaque), PWA 192, PWA 512 and maskable 512 (opaque, content inside the central 80 % safe zone). Icon source priority: the light master, else the dark master, else the explicit compact, else the monogram; every icon is composed on a plate (the monogram on an accent tile, a logo on a light or dark neutral plate chosen from the logo's measured luminance). Everything is re-encoded to PNG by sharp, named `<sha256 of the bytes>.png` and written atomically (a temporary file in `/data/branding/.tmp/`, then a rename, FR-A-084) to `/data/branding/`. A failure while deriving variants leaves the previous branding in force. | `server/branding/upload-pipeline.test.ts` (dimensions, opaqueness and safe zone by pixel checks) |
| FR-A-090 | MUST | `/branding/<name>` serves only names matching `^[0-9a-f]{64}\.png$` that exist in the registry (else 404) with `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, the strict CSP of section 6.3 and an immutable cache. Staged assets are served only to an actor holding `settings:branding`. | `server/branding/serve-assets.test.ts` (H-43) |
| FR-A-091 | MUST | Staged assets not referenced by the applied branding are deleted after 24 hours (at start and hourly); referenced assets are never deleted. Staging identical bytes again refreshes the 24-hour timer of an unreferenced asset (in the same synchronous step as the existence and quota check), so an asset cannot be swept between the upload and the apply. Assets retired by an apply keep their 24 hours only for the latest change (the Undo target, at most 3 files); the masters of an earlier apply expire at the next apply. | `server/branding/upload-pipeline.test.ts` (fake clock) |
| FR-A-092 | MUST | Monogram: `deriveInitials(name)` (any script; word-like segments from `Intl.Segmenter`; one word gives its first grapheme, two or more give the first of the first and the first of the last; at most two) and `monogramGlyphs(initials)` (guaranteed set A to Z and 0 to 9, Latin transliteration through NFD plus a small table for Ø, Æ, Œ, Ł, Đ, ß and similar, otherwise one fixed generic pictogram). The UI tile, favicon and PWA icons use the same glyph paths from `packages/shared`. No system font is used on the server for any icon (distroless has none). | `shared/initials.test.ts`; `server/branding/icons-no-fonts.test.ts` (renders with an empty font configuration and checks glyph pixels); `image` smoke test (icon fetched from the running distroless container has glyph pixels) |
| FR-A-093 | MUST | Export is JSON `{schemaVersion: 1, orgName, accent, images: {logoLight, logoDark, compact}}` with each image as base64 of the stored master PNG. Import validates with a strict Zod schema (unknown, duplicate and `__proto__` or `constructor` keys rejected), runs every image through the complete pipeline, applies all or nothing in one transaction, and rejects an unknown `schemaVersion` with `import_unsupported_version`. | `server/branding/export-import.test.ts` (H-42) |
| FR-A-094 | MUST | `GET /manifest.webmanifest` is generated from branding: `name`, `short_name` (cut at a grapheme boundary to 12 by the shared `shortOrgName`), `theme_color` (effective accent), a neutral `background_color`, `display: standalone`, `start_url` and `scope` `/`, icons including a maskable one. The organisation name is serialised as JSON data, never concatenated. | `server/branding/manifest.test.ts` |
| FR-A-095 | MUST | HTML shell templating: per request the server injects the CSP nonce, the escaped organisation name in `<title>`, the accent and surface tokens for light and dark as CSS variables in a nonce-carrying `<style>`, the icon links, `theme-color`, the font preload and a small nonce-carrying boot script that sets `data-theme` and `lang` before first paint from the stored preference or the system. All values are inserted in one pass by a replacer function (never as a replacement string, whose `$&`, `` $` `` and `$'` patterns would be interpreted), and only the template is cached, never a filled shell (a cached shell would reuse a nonce). The organisation name `"><img src=x onerror=alert(1)>` is inert everywhere (title, manifest, UI, toasts, dialogs), and names such as `$&`, `$'` and `__M365_NONCE__` stay literal text. | `server/branding/html-shell.test.ts`; `e2e/branding-xss.spec.ts` (H-44); `e2e/no-flash.spec.ts` |
| FR-A-096 | SHOULD | At start every referenced branding file is checked; a missing one logs `branding_asset_missing` (warn), the UI falls back to the monogram and `/readyz` stays 200. | `server/branding/serve-assets.test.ts` |
| FR-A-097 | SHOULD | At most 2 image jobs run at once with a queue of 4; beyond that 429 `image_processing_busy` with `Retry-After`. Each job runs in its own child process (started with an empty environment, talking over IPC only) that is killed with SIGKILL after a 10 s budget (422 `image_processing_timeout`), so a pathological input cannot hold the main process, its libuv thread pool or its memory. A worker thread is not enough: `worker.terminate()` does not stop a native libvips or librsvg call that is already running (plan V-19). | `server/branding/hostile-uploads.test.ts` (H-39); `server/branding/job-runner.test.ts` (the child is gone after the budget, no orphan) |

#### Accent tokens

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-100 | MUST | `deriveAccentTokens(hex)` in `packages/shared` is a pure, deterministic function (no I/O, no clock) that returns for light and dark: `accent`, `accentHover`, `accentActive`, `accentSubtle`, `onAccent`, `accentText`, `focusRing`, and whether the chosen colour had to be adjusted. The server and the live preview call this one function. | `shared/accent.property.test.ts`; `shared/single-implementation.test.ts` |
| FR-A-101 | MUST | For every possible input hex, in both themes and against every documented surface token (page, raised/card, sidebar base, overlay base; the opaque base colours, so translucent glass cannot lower contrast): `onAccent` on `accent`, `accentHover` and `accentActive` is at least 4.5:1; `accent` is at least 3:1; `accentText` is at least 4.5:1, also on `accentSubtle`; `focusRing` is at least 3:1. A chosen colour that already satisfies all of this is used unchanged as `accent`. Hover and active differ from `accent` by a perceptible lightness step. | `shared/accent.property.test.ts`: the full 16 by 16 by 16 RGB lattice (4,096 colours), the cube corners, greys and WCAG luminance boundary colours, plus 20,000 colours from a seeded PRNG (the seed is printed on failure); contrast is computed by an independent oracle written in the test (+ negative: a deliberately broken derivation must fail) |
| FR-A-102 | MUST | The surface tokens used in FR-A-101 are imported by the test from the same module the app uses, so changing a surface re-runs the guarantee. | `shared/tokens.test.ts` |
| FR-A-103 | MUST | Selection and state are never conveyed by colour alone (WCAG 1.4.1); a non-colour indicator is present. | `e2e/a11y.spec.ts` (axe `color-contrast`, `link-in-text-block`); the colour-only rule is only partly automatable, so the manual checklist in the Accessibility section of `docs/architecture.md` (FR-A-185) covers the rest (stated, not hidden) |

#### Internationalisation

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-110 | MUST | An in-house typed i18n module in `packages/shared`: catalogues `nl.json` and `en.json`; the key union derives from `en.json`; `{placeholder}` interpolation; plurals through `Intl.PluralRules` with `key.one` and `key.other` suffixes (and any further CLDR category a locale needs); numbers and dates through `Intl`; no i18n framework. A missing key is a compile error; at runtime a missing key falls back to `en`. | `shared/i18n.test.ts`; `shared/i18n.types.test.ts` (compile-time, checked by `pnpm typecheck`) |
| FR-A-111 | MUST | Catalogue checks (baseline section 12), run in `quality` as "i18n catalogue checks": key parity, no empty values, placeholder parity per key, plural-category completeness, and no value in a third script (each catalogue's own script is inferred from the catalogue; Latin is always allowed; only letters are read). The test states its own limitation: it cannot see one Latin-script language filed as another. | `shared/i18n-catalogue.test.ts` (+ negative: shifted-catalogue fixtures in Cyrillic and Greek must fail) |
| FR-A-112 | MUST | Every code in the problem registry has a message in both catalogues; the UI shows the translated message and never the server's English `detail`; an unknown code shows a generic message with the code and request id. | `shared/error-codes.test.ts`; `web/error-boundary.test.tsx` |
| FR-A-113 | MUST | Language defaults from `navigator.languages` (first of nl or en; `nl-BE` counts as nl; otherwise en), is switchable, is stored per browser (`m365portal.locale`) and `<html lang>` follows. Organisation names and other data are never translated. | `web/locale-detection.test.ts`; `e2e/i18n-theme.spec.ts` |
| FR-A-114 | MUST | Every browser storage access is wrapped in try/catch and the app is fully usable with storage blocked; all storage keys live in one module. | `web/storage.test.ts`; `e2e/i18n-theme.spec.ts` (storage-blocked project) |
| FR-A-115 | MUST | No user-visible literal string in JSX text or in user-facing attributes (`aria-label`, `title`, `placeholder`, `alt`) outside the catalogues. | `quality` (lint rule for literal strings) |

#### Design system and application shell

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-120 | MUST | Design tokens (colour, 4 px spacing grid, radius 4 to 8 px, shadows, type scale, motion durations, layers) are defined once as CSS variables through the Tailwind v4 theme; neutral blue-grey palette; the accent tokens are overridden at runtime from branding. | `shared/tokens.test.ts`; `shared/repo-conventions.test.ts` |
| FR-A-121 | MUST | Light, dark and system themes; switching is instant, persisted per browser and applied before first paint; `color-scheme` is set. Under `forced-colors: active` and `prefers-contrast: more` the UI uses system colours with visible borders and focus rings; glass and blur effects fall back to opaque surfaces under `forced-colors`, `prefers-reduced-transparency: reduce` and where `backdrop-filter` is unsupported. | `e2e/i18n-theme.spec.ts`; `e2e/forced-colors.spec.ts` |
| FR-A-122 | MUST | Every animation lasts at most 200 ms with spring-like easing; all motion goes through one helper and `MotionConfig reducedMotion="user"` plus a CSS reset under `prefers-reduced-motion: reduce`; nothing animates under reduced motion. | `shared/tokens.test.ts` (durations); `e2e/reduced-motion.spec.ts` (`document.getAnimations()` is empty after interactions) |
| FR-A-123 | MUST | Inter variable is self-hosted from `@fontsource-variable/inter` with `font-display: swap`, the Latin subset preloaded and a size-adjusted system-ui fallback face so the swap causes no layout shift. | `e2e/no-external-requests.spec.ts`; Lighthouse CLS (FR-A-154) |
| FR-A-124 | MUST | A component library (shadcn/ui on Radix, restyled to the tokens): Button, IconButton, Input, Textarea, Select, Checkbox, RadioGroup, Switch, SegmentedControl, Tabs, Menu, Tooltip, Dialog with blurred scrim, ConfirmDialog, Toast, Banner, Breadcrumbs, CommandBar, DetailsPanel, CommandPalette, Persona, Skeleton, EmptyState, ErrorState, DataTable and FormField with inline validation. `ConfirmDialog` requires the name of the object as a prop; no generic "Are you sure?" variant exists. | `web/confirm-dialog.test.tsx` (type-level and runtime); `e2e/visual.spec.ts` on `/design` |
| FR-A-125 | MUST | DataTable, server-driven: sorting, filtering, search, pagination with page-size choices, column picker (remembered per browser and table id), bulk selection that distinguishes "selected on this page" from "all N", sticky header, skeleton rows, two empty states (no data; no results with "clear filters"), error state with retry, row actions, details panel. Query state lives in the URL. Semantic table with `aria-sort`, labelled checkboxes and a live region for the result count; keyboard operable; column ordering has a non-drag alternative. | `web/DataTable.test.tsx`; `e2e/keyboard.spec.ts`; `e2e/visual.spec.ts` |
| FR-A-126 | MUST | Shell: header with global search, language and theme switchers and the organisation mark; collapsible sidebar (state persisted; drawer below 768 px); breadcrumbs from the route tree; skip-to-content link; one `main` landmark; app version in the sidebar footer. | `web/shell.test.tsx`; `e2e/keyboard.spec.ts` |
| FR-A-127 | MUST | The command palette (Ctrl or Cmd+K) and the global search share one command registry and list only what the actor's permissions allow (scope filtering joins in Phases B and D); accessible combobox and listbox pattern; focus trap and focus restore. | `web/command-palette.test.tsx`; `e2e/keyboard.spec.ts` |
| FR-A-128 | MUST | Shortcuts (A-54): Ctrl or Cmd+K opens the palette, `?` the overview, `/` focuses search, Esc closes. Single-character shortcuts are ignored while typing in a field and can be switched off in the overview (WCAG 2.1.4). | `e2e/shortcuts.spec.ts` |
| FR-A-129 | MUST | Navigation is gated from `/api/v1/me`: Users (`users:read`), Groups (`groups:read`), Distribution lists (`distributionlists:read`), Contacts (`contacts:read`), Audit log (`audit:read`), Settings (any `settings:*`); Dashboard is always shown. Gating is cosmetic; the server enforces. | `web/nav-gating.test.tsx`; `e2e/nav-gating.spec.ts` (anonymous and preview servers) |
| FR-A-130 | MUST | Pages: Dashboard (counter cards, skeleton then honest empty state, no invented numbers); placeholder pages for Users, Groups, Distribution lists, Contacts, Audit log and the Settings overview saying "not available until Phase X"; Settings, Appearance; No-access; Not-found; error boundary at root and route level showing the request id and never a stack. | `e2e/dashboard.spec.ts`; `e2e/pages.spec.ts`; `web/error-boundary.test.tsx` |
| FR-A-131 | MUST | `/design` exists only when `SHOWCASE=true` (A-21); otherwise Not-found. `/api/v1/me.features.showcase` tells the client; sample data is labelled as sample data. | `e2e/showcase.spec.ts` (both servers) |
| FR-A-132 | MUST | Appearance page: organisation name; accent (hex input, swatches, native colour input; shows chosen versus effective colour); three logo slots with file button and drag-and-drop (a non-drag alternative always exists, WCAG 2.5.7); upload result with warnings; live preview in light and dark side by side; save with `If-Match`; reset (confirmation naming the object); export; import with dry run and confirmation; unsaved-changes guard; conflict handling. All problem codes are translated. | `e2e/branding.spec.ts`; `web/branding-form.test.tsx` |
| FR-A-133 | SHOULD | Undo after save and reset re-applies the previous values through the revision check, so it cannot overwrite a newer change. | `e2e/branding.spec.ts` |
| FR-A-134 | MUST | Toasts use a polite live region (assertive for errors), do not auto-dismiss while hovered or focused, and errors persist until dismissed. | `web/toast.test.tsx` |
| FR-A-135 | SHOULD | Logical CSS properties (`margin-inline`, `padding-block`) are used so an RTL locale is cheap later (E-07). | none (stated intent) |

#### Progressive web app

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-140 | MUST | A hand-written service worker (no Workbox) at `/sw.js`, root scope: cache-first for hashed static assets and branding images; network-first for navigations with a precached offline page (both languages) as fallback; never caches `/api/*` (any method, any encoding of the prefix); ignores cross-origin requests; stores only responses with status 200 and the expected content type (never a 404, a 5xx, a redirect or an opaque response); cache names carry the app version and activation deletes older caches. The routing decision is a pure function. | `web/sw-routing.test.ts` (hostile URL table); `e2e/pwa.spec.ts` |
| FR-A-141 | MUST | A waiting worker is activated only after the user accepts the "Update available" toast. | `e2e/pwa.spec.ts` |
| FR-A-142 | MUST | Offline (A-55): a navigation shows the offline page; API failures show a translated offline state and disable save buttons; no write is queued or replayed. | `e2e/offline.spec.ts` |
| FR-A-143 | SHOULD | Worker registration works under Trusted Types, with a named policy for the script URL if the browser requires one (UNVERIFIED which browsers do; the violation guard finds it). | `e2e/pwa.spec.ts` |

#### Accessibility and performance

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-150 | MUST | WCAG 2.2 AA: axe-core with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` runs on every route in `e2e/routes.ts`, in light and dark, at 1440 by 900 and 390 by 844, with zero violations (A-53). Waivers live only in `e2e/axe-waivers.json` with rule, reason and expiry date; an expired or reason-less waiver fails the test. | `e2e/a11y.spec.ts` |
| FR-A-151 | MUST | `e2e/routes.ts` is the single route list used by axe, visual regression and Lighthouse; a test compares it with the router's route tree in both directions (a missing entry and a listed route that does not exist both fail). | `web/routes-coverage.test.ts` (+ negative) |
| FR-A-152 | MUST | Every Phase A flow works with the keyboard alone (skip link, sidebar, palette, dialogs with focus trap and restore, DataTable, Appearance form); focus is visible (at least 3:1) and never hidden by the sticky header (WCAG 2.4.11); interactive targets are at least 24 by 24 CSS px (2.5.8); no `outline: none` without a replacement. | `e2e/keyboard.spec.ts`; `e2e/responsive.spec.ts` (target size); `shared/repo-conventions.test.ts` (scan of CSS, HTML, `@apply`, class strings and style objects) |
| FR-A-153 | MUST | Responsive from phone to 3440 px: no horizontal scroll at 320 CSS px on any route; content capped and centred on ultrawide; 200 % text zoom without loss. | `e2e/responsive.spec.ts` |
| FR-A-154 | MUST | Lighthouse at least 95 for Performance, Accessibility and Best Practices on every route in `e2e/routes.ts`, mobile and desktop presets; LCP below 2.0 s; CLS at most 0.01; against the production build served by the real server. Timing metrics are judged on the best of 3 runs and all three results are kept as artefacts; non-timing scores are judged on the first run (baseline section 8, A-52). | `e2e` job step "Lighthouse" (`e2e/lighthouse/run.mjs`) |
| FR-A-155 | SHOULD | Initial route JavaScript at most 250 KiB gzip; the budget is calibrated after the first build and only ever ratcheted down. | `quality` step "Bundle budget" |
| FR-A-156 | MUST | Visual regression with `toHaveScreenshot` for `/design`, the Dashboard and Appearance in light and dark at desktop and mobile, plus one ultrawide Dashboard; animations disabled, reduced motion, fixed time zone and locale, fonts awaited, dynamic regions masked; baselines committed with a platform suffix (R-01). | `e2e/visual.spec.ts` |
| FR-A-157 | MUST | e2e topology: two instances of the production build, preview (preview mode and showcase on) and anonymous, each with a fresh temporary `DATA_DIR`. Every test fails on `pageerror`, `console.error`, `securitypolicyviolation` and unexpected 4xx or 5xx responses to same-origin requests. | e2e fixture (`e2e/fixtures.ts`) |
| FR-A-158 | MUST | Performance structure (brief section 5): the entry CSS is inlined as a nonce-carrying `<style>` in the HTML shell; only the Latin Inter file is preloaded; every route except the Dashboard, No-access and Not-found is a lazy chunk; loading states (skeletons) reserve their final height so nothing shifts. | `web/build-output.test.ts` (inlined CSS, preload set, separate route chunks); CLS through the `e2e` step "Lighthouse" (FR-A-154) |

#### Docker and runtime

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-160 | MUST | Multi-stage Dockerfile: build on `node:22-bookworm-slim`, runtime on `gcr.io/distroless/nodejs22-debian12:nonroot`, both pinned by digest in every `FROM`; runtime user 65532:65532; `/data` exists and is owned by 65532 in the image; only the production build output and production dependencies are copied. [NEEDS CLARIFICATION: Phase D may need `pwsh`, which a distroless runtime cannot hold (BC-10, OD-07). Default: distroless now; the ADR records that a Phase D change of runtime base is possible.] | `py/test_check_dockerfile_pins.py`; `image` smoke test; `py/check_image_contents.py` |
| FR-A-161 | MUST | The container works with `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL` and `--security-opt no-new-privileges`, writing only to `/data` and `/tmp`. | `image` smoke test runs exactly this, then performs a branding write and upload and a restart |
| FR-A-162 | MUST | `HEALTHCHECK` runs a Node script (no shell, no curl) against `/readyz` on the configured port with a timeout (A-34). | `image` smoke test (`docker inspect` reports healthy) |
| FR-A-163 | MUST | `VERSION` is copied into the image and read by `/healthz`; the build argument `VERSION` (set by CI from the file) is checked against the file during the build; OCI labels `title`, `description`, `source`, `version`, `revision`, `created` are set. [NEEDS CLARIFICATION: the `licenses` label and the repository and image visibility wait for OD-01; default: label omitted until the owner names a licence.] | `image` smoke test (`/healthz` version equals `VERSION` equals the label) |
| FR-A-164 | MUST | The image holds no secrets, `.env`, `.git`, test files or development dependencies; `.dockerignore` excludes them. | `py/check_image_contents.py`; Trivy secret scan in `image` |
| FR-A-165 | MUST | The container listens on `PORT` (default 9300, unprivileged), and `docker run -p 9300:9300 -v m365:/data ghcr.io/flux76hq/m365portal` works as the README says; with another port, `docker run -p 9090:9090 -e PORT=9090 -e PUBLIC_BASE_URL=http://localhost:9090 -v m365:/data ghcr.io/flux76hq/m365portal` works the same (FR-A-016). | `image` smoke test (default port and `PORT=18080`) |
| FR-A-166 | MUST | `docker-compose.yml` example: `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, tmpfs for `/tmp`, a healthcheck, resource limits (memory, cpus, pids), a named volume at `/data`, `PUBLIC_BASE_URL` set, and the port mapping driven by `PORT` and `HOST_PORT` from `.env` (FR-A-016); it validates with `docker compose config`. | `server/deploy-files.test.ts`; `image` job (`docker compose config -q`) |
| FR-A-167 | MUST | `publish` builds linux/amd64 and linux/arm64; local verification is amd64 only (A-18). | `publish` (build); stated limitation in the phase report |
| FR-A-168 | SHOULD | Image size ceiling recorded after the first build (initial ceiling 400 MB uncompressed) and enforced. | `image` step "Image size budget" |
| FR-A-169 | SHOULD | HTTPS in front of the panel is documented and exemplified (brief section 1: "Caddy of een reverse proxy voor HTTPS is optioneel"): `deploy/caddy/Caddyfile.example` shows a Caddy reverse proxy with an automatic certificate, with `PUBLIC_BASE_URL`, `TRUST_PROXY`, the Host header preserved and the 9,437,184-byte body number. The app itself serves plain HTTP only. The example is written only after its directive names are verified in Caddy's own documentation; otherwise it is omitted and the gap is a row in `docs/open-points.md` marked UNVERIFIED. | `server/docs-contract.test.ts` (the file exists or the UNVERIFIED row exists); `server/limits-doc.test.ts` (numbers equal `LIMITS`) |

#### CI and supply chain

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-170 | MUST | `ci.yml` job `quality`: frozen-lockfile install, lint, typecheck, unit and integration tests, i18n catalogue checks, schema snapshot and drift checks, docs contract, `pnpm audit --prod` (any finding) and `pnpm audit --audit-level=high` (all dependencies; the moderate dev-only `esbuild` chain through `drizzle-kit` is an open point), secret scan, bundle budget, workflow lint. Job `e2e`: build, Playwright including axe and visual regression, Lighthouse, artefacts kept on failure. | `py/test_workflows.py` (asserts job and step names) |
| FR-A-171 | MUST | `image.yml` job `image` (pull requests: build amd64 without push, container smoke test, Trivy scan failing on HIGH and CRITICAL findings that have a fix, CycloneDX SBOM artefact) and job `publish` (a push to the integration branch or a manual dispatch, never a pull request: multi-arch build, push to GHCR, keyless cosign signature of the digest for public repositories only, build provenance and the CycloneDX SBOM as GitHub artifact attestations (SLSA v1.0 Build Level 2 at most, A-62), post-signing verification). Pull requests from forks never receive write tokens. | `py/test_workflows.py` |
| FR-A-172 | MUST | The version image tag is published only if the git tag does not yet exist: `publish` first creates `v<VERSION>` through the API; if the tag exists, the version image tag is not pushed (channel tags still move) and the job says why; a run that fails after it created the tag is repaired by deleting the unpublished tag by hand or by bumping `VERSION`, never by the workflow writing a version tag onto an existing git tag; each new tag gets a GitHub release with notes (baseline section 5). [NEEDS CLARIFICATION: integration branch name and channel tags (OD-02); default: `main`, tags `latest`, `v<VERSION>` and `sha-<short>`.] | `py/test_workflows.py` (step order and conditions) |
| FR-A-173 | MUST | `codeql.yml` job `analyze` (JavaScript and TypeScript) on pull requests, pushes to the integration branch and weekly; `dependabot.yml` for npm, docker and github-actions. | `py/test_workflows.py` |
| FR-A-174 | MUST | Least privilege: default `permissions: contents: read`; `id-token`, `packages`, `attestations` and `security-events` write access only on the jobs that need them; every third-party action, including those in the two governance workflows, pinned by full commit SHA with the version in a trailing comment, never by a tag or a branch (R-04). | `py/test_workflows.py` |
| FR-A-175 | MUST | The governance jobs `enforce-version-bump` and `agent-instructions-lint` keep their names and workflow files. | `py/test_workflows.py` |
| FR-A-176 | MUST | Every Trivy ignore entry carries a reason and an expiry date. | `py/test_workflows.py` |
| FR-A-177 | SHOULD | `docs/operations.md` recommends a merge queue or "require branches to be up to date" (baseline section 5); these are repository settings, not code. | none (repository setting) |

#### Documentation and governance

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-180 | MUST | README in Dutch and English: what it is, install in five minutes (`docker run` and compose), configuration table, screenshots in light and dark, a short demo GIF (at most 2 MiB) generated from a scripted run; every link resolves and every image exists. | `server/docs-contract.test.ts` |
| FR-A-181 | MUST | `docs/operations.md` covers setup, run and stop; health endpoints; deploy and update; backup and restore (stop the container, copy all of `/data` including any `-wal` and `-shm` files, restore by copying back; the automatic pre-migration copy); runtime architecture summary with data locations; the environment variable table; the single limits table; the local-disk and single-replica rule (A-57); the rule that whatever sits in front must not cache the HTML shell (it carries a per-request nonce); a Dutch section. | `server/docs-contract.test.ts` |
| FR-A-182 | MUST | The limits table in `docs/operations.md` equals the constants in `packages/shared/src/limits.ts` (the single source) and states, as a number, that whatever sits in front of the app must allow request bodies of at least 9,437,184 bytes (baseline section 6). | `server/limits-doc.test.ts` (+ negative) |
| FR-A-183 | MUST | `docs/security.md` holds: a STRIDE threat model of the Phase A surfaces; the CSRF and Origin design with the token binding; the header table; the upload pipeline and the SVG allowlist; the audit chain and its limits (tail truncation, a local attacker with file access); the preview-mode risk; the ASVS level 2 mapping, started (chapter, status, control). | `server/docs-contract.test.ts` |
| FR-A-184 | MUST | `docs/permissions.md` holds the panel permission catalogue (equal to the code) and a Graph and Exchange permission table in which every row has a reason, a phase and a verification status (`verified`, `corrected`, `UNVERIFIED`); every UNVERIFIED row has a row in `docs/open-points.md`. | `server/docs-contract.test.ts` |
| FR-A-185 | MUST | `docs/architecture.md` (components and layering (route handlers, services, repositories; `GraphClient` and `ExchangeClient` arrive behind interfaces in Phases B and D), data locations, dependency table with reasons, reuse / adapt / replace marks per AGENTS.md section 7, and an Accessibility section with the manual checklist: screen-reader pass, text-spacing override, colour-only cues, zoom to 400 %), `docs/open-points.md` and `docs/adr/NNNN-*.md` (one ADR per decision D1 to D26 with status and consequences). | `server/docs-contract.test.ts` |
| FR-A-186 | MUST | User-facing documentation exists in Dutch and English; spec, plan and tasks are English with a short Dutch summary. | `server/docs-contract.test.ts` (headings) |
| FR-A-187 | MUST | The first Phase A commit that touches a protected path bumps `VERSION` (0.2.0 for Phase A, A-47); `/healthz`, the image label and the release tag all derive from that file. | `enforce-version-bump`; `image` smoke test |
| FR-A-188 | MUST | `docs/phase-reports/phase-A.md` holds the five-point report of section 3; the owner's approval is recorded in it before any Phase B work starts. | review (cannot be automated, section 3) |

### 6.2 Functional Requirements, Phases B to D (outline)

These are stated so the whole product is covered by prioritised, phase-tagged requirements. Each phase starts with a spec amendment that turns its rows into FR-x-nnn rows with named controls, in the format above; until then they are intent, and they are SHOULD-level in strength so that this document keeps its rule that a MUST carries an enforcement point. "Planned control" names the kind of control expected. Microsoft facts come from `research-microsoft.md`; items marked U-nn are UNVERIFIED there.

| ID | Phase | Intent | Planned control |
|---|---|---|---|
| FR-B-001 | B | Empty `/data` starts `/setup`; the wizard is idempotent, resumable, shows status and rollback hint per step, and locks with `setup_completed`; afterwards `/setup` is unreachable and the configuration survives a restart; the wizard UI (progress bar, step status, live log lines per action) is built on the Phase A design system. | Vitest state machine; Playwright against a mocked tenant; owner test on a real tenant |
| FR-B-002 | B | Environment step: https or localhost, writable `/data`, `APP_KEY`, Node version. | Vitest; Playwright |
| FR-B-003 | B | Device-code bootstrap using client `14d82eec-204b-4c2f-b7e8-296a70dab67e`, overridable by `BOOTSTRAP_CLIENT_ID`; only the delegated scopes the wizard needs (set decided at the Phase B gate, research 2.2); the bootstrap token is never stored; a clear message when Conditional Access blocks device code (U2, U3). | MSW-mocked Vitest; owner test |
| FR-B-004 | B | Tenant configuration: app registration and service principal, certificate (public part uploaded, private part encrypted), application permissions with admin consent (set per OD-06), Exchange app role and service-principal role (per OD-07 and OD-08), redirect URI from the public base URL, optional `amr` claim. | MSW-mocked Vitest; owner test |
| FR-B-005 | B | Verification calls with retry and backoff for role propagation (U4); Exchange verification only through a documented path (BC-08). | Vitest with fake timers; owner test |
| FR-B-006 | B | Branding step reuses the Phase A UI; the signed-in administrator becomes the first Owner; optional Entra group for the Administrator role; the sign-in and no-access screens show the organisation name and mark (brief 5a). | Playwright |
| FR-B-007 | B | OIDC code flow with PKCE, `state` and `nonce`, validation of issuer, audience and `tid`, server-side sessions, rotation after sign-in, idle and absolute timeouts, sign-out everywhere, MFA through the `amr` optional claim (research 5.2), Conditional Access claims challenge; cookie rules per BC-03. | Vitest; Playwright with a stub identity provider |
| FR-B-008 | B | Secrets at rest: certificate private key encrypted with libsodium XChaCha20-Poly1305 using a key from `APP_KEY` or a Docker secret; never in logs, error pages or backups in clear. | Vitest with canaries; image scan |
| FR-B-009 | B | RBAC foundation: roles, permissions, assignments to users and Entra groups, group-membership cache with short TTL (re-evaluated at each sign-in, overage handled through Graph), default no access, no privilege escalation, last Owner protected; the policy layer of Phase A now fed with real data; preview mode removed (OD-03). | Vitest policy matrix; Playwright |
| FR-B-010 | B | Break-glass account through an environment variable that can only restore RBAC and makes every sign-in loud in the audit log. | Vitest; Playwright |
| FR-B-011 | B | "Herstel verbinding" re-runs the relevant wizard steps. | Playwright |
| FR-B-012 | B | `GraphClient` with 429 and `Retry-After` handling, exponential backoff with jitter and short-TTL caching; `ExchangeClient` interface. | MSW-mocked Vitest |
| FR-C-001 | C | Users: searchable, sortable, paginated list (name, UPN, e-mail, department, status; licences only if an app-only source is verified, U17); detail page with group memberships. | MSW-mocked Vitest; Playwright |
| FR-C-002 | C | Groups: add and remove members of Microsoft 365 and security groups (multi-select, bulk); dynamic, on-premises-synced (U8), mail-enabled security, distribution and role-assignable groups are shown read-only with the reason (research 1.2, 1.3). | MSW-mocked Vitest; Playwright |
| FR-C-003 | C | Permission and scope are checked server-side for every route, including bulk actions, search and the command palette; real dashboard counters; every write audited with who, what, when, result. | Vitest policy matrix; Playwright |
| FR-D-001 | D | Distribution lists: show lists and members, add and remove users and contacts, nested lists, dynamic lists read-only; execution path decided by OD-07; M365 groups are not valid DL members (research 4). | Vitest against the chosen client; owner test |
| FR-D-002 | D | Mail contacts: create, edit, delete with validation (unique external address checked by the app, U10; first and last name editing, U15), confirmation naming the object, DL membership visible. | Vitest; Playwright; owner test |
| FR-D-003 | D | CSV export of a distribution list: selectable columns with live preview, Laposta preset (format verified against Laposta's documentation at that time, UNVERIFIED now) and a generic preset, separator, BOM, nested expansion, de-duplication, skipped members counted, streaming, file name with list name and date, formula-injection protection for values starting with `=`, `+`, `-`, `@`, tab or CR, an audit entry (who, which list, rows), permission `distributionlists:export` within scope, a privacy notice, nothing stored on the server. | Vitest; Playwright; opens in Excel and imports in Laposta (owner test) |
| FR-D-004 | D | RBAC admin UI (Settings, Roles and access): per role and per user, effective permissions, "view as", safe change flow with confirmation, expiry dates, scopes (groups, lists, contacts, prefix or department filter), clone and templates including *Bestuur*; changes and refusals audited. | Vitest policy matrix; Playwright |
| FR-D-005 | D | Audit log UI with filters and CSV export (formula-safe), permissions `audit:read` and `audit:export`; the exported report carries the organisation name (brief 5a). | Vitest; Playwright |
| FR-D-006 | D | Hardening: OpenTelemetry (disableable), Bicep example, permission-audit screen, custom seccomp profile, step-up confirmation for sensitive actions, ASVS level 2 mapping complete, optional e2e suite against a developer tenant, final risk list and follow-up ideas (licence management, shared mailboxes, MFA overview, roles). | CI; owner test |

### 6.3 Security headers (values for FR-A-040)

| Header | Value | Applies to |
|---|---|---|
| `Content-Security-Policy` (HTML) | `default-src 'none'; script-src 'self' 'nonce-<n>'; style-src 'self' 'nonce-<n>'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types <policy names>`; `upgrade-insecure-requests` is added only when the effective scheme is https (it has no use over plain http) | HTML shell |
| `Content-Security-Policy` (everything else) | `default-src 'none'; frame-ancestors 'none'; sandbox` | API, images, health, errors |
| `Content-Security-Policy` (service worker) | `default-src 'none'; connect-src 'self'; frame-ancestors 'none'`, plus `Cross-Origin-Embedder-Policy: require-corp`; the generic profile above makes every navigation fail once the worker is registered (plan V-04) | `/sw.js` |
| `Strict-Transport-Security` | FR-A-043 | https only |
| `Referrer-Policy` | `no-referrer` | all |
| `Permissions-Policy` | every feature the app does not use disabled with an empty allow-list; the minimum set is listed in `docs/security.md`; the list is the one verified in Chromium 141 and recorded in plan Appendix A (a name the browser does not recognise logs a console warning, which the e2e fixture turns into a failure); Firefox and Safari are UNVERIFIED | all |
| `Cross-Origin-Opener-Policy` | `same-origin` | HTML |
| `Cross-Origin-Embedder-Policy` | `require-corp` | HTML |
| `Cross-Origin-Resource-Policy` | `same-origin` | all |
| `X-Content-Type-Options` | `nosniff` | all |
| `X-Frame-Options` | `DENY` (legacy duplicate of `frame-ancestors`) | HTML |
| `X-Robots-Tag` | `noindex, nofollow` (FR-A-049) | all |
| `Cache-Control` | FR-A-050 | per route |
| `Server`, `X-Powered-By` | absent | all |
| `Access-Control-*` | never sent (FR-A-047) | all |

### 6.4 Problem code registry (Phase A seed)

Stable machine codes, each with a nl and an en message (FR-A-112). HTTP status in brackets.

`permission_denied` (403), `origin_not_allowed` (403), `csrf_invalid` (403), `rate_limited` (429), `payload_too_large` (413), `unsupported_media_type` (415), `validation_failed` (422), `not_found` (404), `method_not_allowed` (405), `internal_error` (500), `storage_unavailable` (503), `storage_busy` (503), `precondition_required` (428), `branding_conflict` (412), `accent_invalid` (422), `org_name_invalid` (422), `asset_unknown` (422), `image_type_unsupported` (415), `image_corrupt` (422), `image_pixels_exceeded` (422), `image_empty` (422), `image_processing_busy` (429), `image_processing_timeout` (422), `svg_not_wellformed` (422), `svg_doctype_forbidden` (422), `svg_text_unsupported` (422), `svg_too_complex` (422), `import_invalid` (422), `import_unsupported_version` (422), `staging_quota_exceeded` (409), `shutting_down` (503), `bad_request` (400), `request_timeout` (408), `request_header_fields_too_large` (431). `staging_quota_exceeded` carries a specific `detail` that names the part that is full (the file limit or the size limit, waiting uploads against files kept for Undo), numbers only; the `code`, status and catalogue keys are the registry's. The last three are answered by the `clientError` handler for requests the HTTP parser rejects before routing (amendment 1, FR-A-040).

Warning codes returned with a successful upload: `svg_content_removed`, `animation_flattened`. Readiness checks are `data_dir`, `database` and `schema`; a failing check carries one of the failure codes `data_dir_not_writable`, `database_unavailable`, `database_corrupt`, `schema_newer_than_app`. Start-up failure codes (logged, not HTTP): `migration_checksum_mismatch`, `schema_newer_than_app`, `config_invalid`.

### 6.5 Limits (authoritative values; mirrored to `docs/operations.md` by FR-A-182)

The repository ships no reverse proxy, CDN or ingress, so it has no limits of its own outside the app. Whatever the operator puts in front must allow at least the largest request below, as a number, not as one product's setting.

| Limit | Value | Enforced by | Constrains |
|---|---|---|---|
| JSON request body (all JSON routes except import) | 262,144 bytes (256 KiB) | the app, while streaming | 413 `payload_too_large` |
| Logo file | 2,097,152 bytes (2 MiB) | the app | one image |
| Logo upload request body | 2,162,688 bytes (2 MiB plus 64 KiB envelope) | the app | upload route |
| **Branding import request body (the largest request)** | **9,437,184 bytes (9 MiB)** | the app | import route. Derivation: three images of 2,097,152 bytes are 2,796,204 base64 characters each, 8,388,612 in total; plus 65,536 for the JSON that is 8,454,148, rounded up to 9 MiB (A-36). **Whatever sits in front must allow at least 9,437,184 bytes.** |
| Input pixels per image | 16,777,216 (4096 by 4096) | the app (sharp `limitInputPixels`) | decompression bombs |
| SVG elements and depth | 10,000 and 64 | the app | `svg_too_complex` |
| Master sizes | logo 512 by 512, compact 128 by 128 | the app | stored size |
| Concurrent image jobs and queue | 2 and 4 | the app | 429 `image_processing_busy` |
| Staging quota (unreferenced assets) | 32 files and 33,554,432 bytes (32 MiB) | the app | 409 `staging_quota_exceeded` |
| SVG expanded element instances (`use`, gradient, clip-path and mask references counted transitively) | 100,000 | the app | `svg_too_complex` |
| Image job time budget | 10 seconds | the app (child process killed with SIGKILL) | 422 `image_processing_timeout` |
| Request header size | 16,384 bytes | Node server option, set explicitly | any proxy may be stricter; the app sets no cookies in Phase A |
| Headers timeout, request timeout, keep-alive timeout | 15 s, 60 s, 65 s | Node server options | keep-alive must exceed the idle timeout of whatever is in front (65 s covers a proxy that idles at 60 s) |
| Rate limit `read` | capacity 120, refill 2 per second, per client address | the app | 429 `rate_limited` |
| Rate limit `write` | capacity 10, refill 0.5 per second | the app | 429 `rate_limited` |
| Rate limit `upload` (asset upload and import) | capacity 3, refill 0.1 per second | the app | 429 `rate_limited` |
| Tracked clients | 10,000 | the app | memory bound |
| CSRF token lifetime | 8 hours | the app | refetch on `csrf_invalid` |
| Staged asset retention | 24 hours | the app | disk use |
| Pre-migration backups kept | 3 | the app | disk use |
| Graceful shutdown drain | 10 seconds | the app | `docker stop` grace period must be at least 10 s |
| Audit entry detail | 4,096 bytes | the app | row size |
| Organisation name | 64 grapheme clusters, 256 bytes | the app | validation |
| HSTS `max-age` default | 31,536,000 seconds | the app | override with `HSTS_MAX_AGE` |
| Image size ceiling | 400 MB uncompressed, recalibrated after the first build | `image` job | FR-A-168 |

### 6.6 Key Entities

- **Actor**: who performs a request. Kind (anonymous, preview; later user and break-glass), id, label, permission set. Resolved once per request, never trusted from the client.
- **Permission**: an entry of the catalogue `resource:action` (FR-A-030). A role (Phase B) is a set of permissions; an assignment (Phase B) binds a role to a user or an Entra group, optionally with a scope and an expiry.
- **Branding**: the single branding record. Revision, organisation name, chosen accent, references to up to three logo masters and the derived icon set, last change time and actor.
- **Branding asset**: a content-addressed PNG in `/data/branding` (name is the SHA-256 of its bytes), with a creation time and `unreferenced_at` (null while referenced by the applied branding; a non-null value means staged or retired; the masters retired by the latest apply keep 24 hours for Undo, older retired masters expire at the next apply).
- **Accent token set**: the derived, contrast-guaranteed colours for light and dark (FR-A-100). Not stored; derived on demand from the chosen accent by one function.
- **Audit entry**: one row of the hash-chained, append-only `audit_log` (FR-A-070).
- **Migration record**: applied migration identifier and its SHA-256.
- **Problem**: an RFC 9457 error with a stable code (section 6.4).
- **Locale catalogue**: `nl.json` and `en.json` plus the key union derived from `en.json`.
- **Limits**: the constants in section 6.5, defined once in `packages/shared`.

---

## 7. Success Criteria

### 7.1 Measurable outcomes, Phase A

- **SC-A-001**: From `docker run` on an empty volume, `/readyz` answers 200 within 10 seconds on the CI amd64 runner. (`image` smoke test)
- **SC-A-002**: A newcomer following the README reaches the running shell in five minutes or less; the phase report records a timed walk-through. (manual, reported)
- **SC-A-003**: Lighthouse scores of at least 95 for Performance, Accessibility and Best Practices, LCP below 2.0 s and CLS at most 0.01 on every Phase A route, for the mobile and desktop presets. (`e2e` job, FR-A-154)
- **SC-A-004**: Zero axe violations (WCAG 2.2 AA tag set) on every route, in light and dark, at desktop and mobile size. (`e2e/a11y.spec.ts`)
- **SC-A-005**: Zero `securitypolicyviolation` events, page errors and console errors during the whole e2e run. (e2e fixture)
- **SC-A-006**: 100 % of the hostile corpus (Appendix A, 44 fixtures) ends as specified, with zero outbound connections. (`server/branding/hostile-uploads.test.ts`)
- **SC-A-007**: Zero contrast failures over at least 24,096 accent colours (4,096 lattice points plus 20,000 random) in both themes. (`shared/accent.property.test.ts`)
- **SC-A-008**: Every branding field, including all stored images, survives a container restart. (`image` smoke test, `e2e/branding-persistence.spec.ts`)
- **SC-A-009**: 100 % of write routes refuse the anonymous actor, each denial leaving an audit entry. (`server/policy.test.ts`, `server/audit-integration.test.ts`)
- **SC-A-010**: 100 % of audit tamper fixtures are detected by `verifyChain`. (`server/audit.test.ts`)
- **SC-A-011**: Both catalogues have identical keys, no empty values, identical placeholders, and no third-script value; the deliberately broken fixtures fail. (`shared/i18n-catalogue.test.ts`)
- **SC-A-012**: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass on a clean checkout, locally and on GitHub. (`quality`)
- **SC-A-013**: The image runs as uid 65532 with a read-only root filesystem, reports healthy, stays under its size ceiling, has no fixable HIGH or CRITICAL finding and produces a CycloneDX SBOM. (`image`)
- **SC-A-014**: The docs contract passes and every user-facing document has both languages. (`server/docs-contract.test.ts`)
- **SC-A-015**: The five-point phase report is delivered, the approval line is empty until the owner fills it, and no Phase B artefact exists in the repository. (review)

### 7.2 Brief acceptance criteria (section 8) mapped to phases

"Phase A share" says what Phase A can honestly deliver; "Limit" says why the rest is not achievable there (no tenant, no login, no GitHub run).

| # | Criterion (brief section 8, abbreviated) | Satisfied in | Phase A share | Limit in Phase A |
|---|---|---|---|---|
| 1 | `docker run -p 9300:9300 -v m365:/data ghcr.io/flux76hq/m365portal` on an empty volume shows the wizard; afterwards app registration, certificate, permissions and Exchange role are demonstrably in the tenant | B | Partly: the exact command runs, the container is healthy and serves the shell (US-1, SC-A-001). | No wizard and no tenant. The tenant part can only be proven by the owner after Phase B. The image can only be pulled from GHCR after the first `publish` run on GitHub. |
| 2 | After a restart the configuration persists and the wizard is unreachable | B | Partly: configuration persistence is proven for branding (SC-A-008). | Wizard lock (`setup_completed`) is Phase B. |
| 3 | A user can be added to a group and to an existing distribution list from the panel, and removed again | C (groups), D (lists) | None. | No tenant, no Graph, no Exchange. |
| 4 | A mail contact can be created, edited and deleted | D | None. | Exchange access and its execution path are undecided (OD-07). |
| 5 | All write actions are in the audit log; no secrets in logs or repository | A (store, branding, denials), then every phase adds its writes; UI in D | Partly: the audit store, chain verification, audited branding writes and denials, log redaction and secret scanning (SC-A-009, SC-A-010, FR-A-051). | Phase A has few writes; coverage of Graph and Exchange writes grows with B to D; there is no audit UI until D. |
| 6 | CI is green (lint, typecheck, unit, e2e, a11y, image build, scans) | A, kept in every phase | Mostly: all workflows exist and every command runs locally (SC-A-012, SC-A-013). | GitHub Actions cannot be run from this environment; arm64, cosign, provenance and CodeQL are proven only by the first GitHub run (R-03). |
| 7 | Lighthouse of at least 95 on all main pages; axe reports no serious problems | A for Phase A pages, extended each phase | Fully for the Phase A pages (SC-A-003, SC-A-004), measured locally and in CI. | Later pages (users, groups, lists, contacts, audit) do not exist yet; lab scores vary by runner (R-02). |
| 8 | Security headers score A+ (securityheaders.com or Mozilla Observatory); the image is signed and has SBOM and provenance | A (headers, workflows), D (final hardening) | Partly: header rules are unit-tested, the workflows are written (SC-A-005, FR-A-171). | An external scanner needs a public https host (not available here, and the scoring rules were not read: UNVERIFIED); HSTS preload and includeSubDomains stay opt-in (BC-01), which may cost score; signing and provenance are proven only on GitHub. |
| 9 | Light/dark theme and mobile layout are visually checked and fit the Fluent look with Apple touches | A | Mostly: visual regression and axe in four configurations, reviewable screenshots (FR-A-156). | "Fits the look" is a judgement: the owner approves the screenshots at the gate. Baselines come from the sandbox Chromium (R-01). Screen reader testing is manual and not possible here. |
| 10 | Organisation name, logo (including a malicious SVG test file that is refused or cleaned) and accent colour can be changed and survive a restart | A | Fully (US-2, US-3, SC-A-006 to SC-A-008). | The wizard step that reuses the branding UI, and the tenant name as default name, arrive in Phase B (A-42). |
| 11 | RBAC: Reader cannot write even through the API (403 and audit line); a scope on group *Sales* shows and changes no other group; a user without a role cannot sign in even as Global Administrator; the last Owner cannot be removed; privilege escalation is refused; covered by automated tests | B (model, sign-in, enforcement), C and D (scope on real objects), D (admin UI) | Partly: the policy interface, deny by default, the route-table check, the audited 403 for writes (US-4, SC-A-009). | No roles, no sign-in, no scopes, no Entra. |
| 12 | A *Bestuur* user can create a mail contact and add and remove people on the assigned distribution list, but cannot edit or delete a contact, change other lists, export without the permission, or open settings and RBAC; all refused server-side | D | None. | Needs contacts, lists, roles, scopes. |
| 13 | The CSV export of a distribution list opens correctly in Excel and imports in Laposta (preset); de-duplicated; separator and BOM options work; a member named `=HYPERLINK(...)` is exported safely; the export is audited and needs the export permission | D | None. | Needs lists; the Laposta format is UNVERIFIED and must be read from Laposta's documentation then. |

---

## 8. Dependencies and Out-of-Scope Notes

- Phase A depends on nothing outside this repository, Docker, Node 22 and the pre-installed Chromium. It makes no Microsoft call.
- Phases B to D depend on the owner deciding OD-06 to OD-08 and on a developer tenant for the owner's tests.
- The pre-installed Chromium (revision 1194, Chromium 141.0.7390.37 according to `playwright-core` 1.56.x `browsers.json`) fixes the Playwright version (A-27).

---

## 9. Assumptions

Defaults chosen where the brief is silent. A-01 to A-26 record the orchestrator's decision brief D1 to D26 one to one (A-nn equals D-nn); A-27 onwards are further defaults chosen while writing this spec. Each one becomes an ADR-style decision in the plan. "Checked" means verified against a public source on 2026-10-10 from this environment (npm registry metadata, sqlite.org, Microsoft Learn); it never means a Microsoft permission or cmdlet claim unless Learn is named.

### 9.1 Decision brief (D1 to D26)

| ID | Assumption | Verification note and revisit trigger |
|---|---|---|
| A-01 | **D1.** Backend: Hono on Node 22 through `@hono/node-server`, not Fastify. One process serves the API and the built frontend. | Checked (registry): hono 4.13.13, @hono/node-server 2.1.4. The brief allowed "Hono (of Fastify)". |
| A-02 | **D2.** Validation with Zod v4; the OpenAPI 3.1 document is generated from the Zod route schemas and served at `/api/v1/openapi.json`. | Checked: `@hono/zod-openapi` 1.6.3 declares peers `zod ^4.0.0` and `hono >=4.10.0`; its dependency `@asteasolutions/zod-to-openapi` ^9.1.0 documents `OpenApiGeneratorV31`. So v4 holds and no replacement is needed. |
| A-03 | **D3.** SQLite (WAL) through better-sqlite3, drizzle-orm and drizzle-kit, file in `/data`; forward-only, checksum-guarded migrations; a committed schema snapshot of every shipped version; an upgrade test. | Checked: better-sqlite3 13.0.3 (engines node >=22), drizzle-orm 0.45.4, drizzle-kit 0.31.11. Whether Drizzle's own migrator already re-verifies applied checksums is for the plan to check; FR-A-061 requires the guard either way. |
| A-04 | **D4.** ESLint (flat config) with type-aware typescript-eslint, `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks`, plus Prettier; strict TypeScript everywhere. | Version pins in A-28. |
| A-05 | **D5.** Vitest (unit, and integration with a real SQLite file in a temp directory), Playwright e2e and visual regression (`toHaveScreenshot`, light and dark, desktop and mobile), `@axe-core/playwright`, Lighthouse CLI. Baseline screenshots come from the sandbox Chromium. | Cross-environment risk R-01. Playwright version A-27. Lighthouse 13.5.0 needs Node 22.19 or newer; the sandbox has 22.22.0. |
| A-06 | **D6.** Fonts: self-hosted Inter (`@fontsource-variable/inter`), `font-display: swap`, preloaded, system-ui fallback; no runtime CDN. | Checked: package 5.3.0 exists. |
| A-07 | **D7.** PWA: server-generated `/manifest.webmanifest` (name, theme colour and icons from branding) and a small hand-written service worker without Workbox: cache-first for hashed static assets, network-first navigation with an offline fallback, never `/api`. | |
| A-08 | **D8.** TanStack Router, Query and Table, React Hook Form with Zod, Motion, Lucide. Code-based or file-based routes: whichever lets `pnpm typecheck` pass from a clean checkout without a manual step. | Registry shows newer majors than the brief assumes (Vite 8.3.4, Vitest 5.0.3, React 19.3.0). The plan pins exact versions after checking peer ranges (R-16). |
| A-09 | **D9.** i18n: a small in-house typed module in `packages/shared` (JSON catalogues, key set derived from `en.json`, `{placeholder}` interpolation, `Intl.PluralRules`, `Intl` for numbers and dates), no framework; catalogue checks per baseline section 12 including "no value in a third script". | |
| A-10 | **D10.** Errors are RFC 9457 `application/problem+json` with stable machine codes; the UI translates the codes; the server never leaks stacks or secrets. | |
| A-11 | **D11.** Phase A has none of the real sign-in or RBAC. It ships the `Actor` and central policy-layer interface (deny by default) with exactly two resolvers: anonymous, and a preview actor that exists only with `PREVIEW_MODE=true` (all permissions, loud startup warning, persistent banner, removed or replaced in Phase B). | OD-03 asks the owner to confirm removal in Phase B. |
| A-12 | **D12.** State-changing requests require same-origin (`Origin` and `Sec-Fetch-Site`) and a CSRF token header; the design is recorded in `docs/security.md` so Phase B can bind it to the session. | Details A-31 to A-33. |
| A-13 | **D13.** Security headers: CSP with per-request nonces, Trusted Types, HSTS, Referrer-Policy, Permissions-Policy, COOP, COEP, CORP, nosniff, cache rules. HSTS follows baseline section 13: `includeSubDomains` and `preload` only by operator opt-in through env, default plain `max-age`, emitted only over https. e2e fails on any `securitypolicyviolation`. | BC-01, BC-06; numbers A-46. |
| A-14 | **D14.** In-memory token-bucket rate limiting per client address, stricter for writes and uploads; `TRUST_PROXY` controls how `X-Forwarded-For` is read; the default trusts nothing. | Numbers in section 6.5. |
| A-15 | **D15.** Structured JSON logging with pino, redaction, no PII, a request id on every request. OpenTelemetry is deferred to Phase D. | BC-14 on the client address. |
| A-16 | **D16.** Phase A implements the audit store only (append-only table, SHA-256 hash chain, `verifyChain()`, a writer used by branding changes and denied writes). The audit UI and CSV export are Phase D. | |
| A-17 | **D17.** Branding in Phase A (security-critical): organisation name, accent colour, logo upload as specified in FR-A-081 to FR-A-097, including always-rasterised SVG, bounded PNG variants named by hash, variants for light, dark, compact and icons, a monogram without system fonts, JSON export and import through the full pipeline, a WCAG AA guarantee for every input hex. | BC-04, BC-05. |
| A-18 | **D18.** Docker: multi-stage; build on `node:22-bookworm-slim`, runtime on `gcr.io/distroless/nodejs22-debian12:nonroot`, both pinned by digest; uid 65532; `/data` owned by 65532; read-only-root compatible; `HEALTHCHECK` through a Node script; `VERSION` read at build; OCI labels; multi-arch in CI; local verification amd64 only; compose example hardened; Azure Bicep deferred to Phase D. | BC-10 (`pwsh`). |
| A-19 | **D19.** GitHub Actions: `ci.yml` (jobs `quality`, `e2e`), `image.yml`, `codeql.yml`, `dependabot.yml`, a secret-scanning step; third-party actions pinned by full commit SHA with the version in a trailing comment (SHAs can be looked up from this environment with `git ls-remote --tags`, plan V-07). Existing jobs `enforce-version-bump` and `agent-instructions-lint` keep their names. | R-04. The plan re-resolved and checked every pinned SHA on 2026-10-10 (V-07). |
| A-20 | **D20.** Limits are documented as numbers in one authoritative table in `docs/operations.md`. | Final values in section 6.5; import limit deviates (A-36). |
| A-21 | **D21.** Phase A pages: Dashboard, permission-gated navigation entries for Users, Groups, Distribution lists, Contacts, Audit log and Settings with "not available until Phase X" placeholders, Settings, Appearance (the real branding UI), No-access, Not-found, error boundary, and a `/design` showcase enabled by `SHOWCASE=true` (off by default, on in e2e). Command palette, shortcut overview, collapsible sidebar, breadcrumbs, global search, theme and language switchers, toasts, confirm dialogs naming the object, a reusable server-driven DataTable. | |
| A-22 | **D22.** Fluent 2 look with a touch of Apple (calm surfaces, sparing Mica or Acrylic, 4 px grid, 4 to 8 px radius, Fluent-style focus rings, command bar, side panel, Persona with initials; soft shadows, whitespace, spring motion up to 200 ms, blurred glass overlays, rounded segmented controls). Neutral blue-grey palette, accent from branding, light/dark/system, reduced motion honoured, WCAG 2.2 AA, mobile to ultrawide, Lighthouse at least 95, LCP below 2.0 s, critical CSS inline, route-level lazy loading, no layout shift. | |
| A-23 | **D23.** Layout: `apps/server`, `apps/web`, `packages/shared`, `e2e`, `deploy/`, `docs/`, `specs/`, `scripts/`, `Dockerfile` and `docker-compose.yml` at the root. Protected paths are defined once in `scripts/version_guard_paths.py`. | R-11 on gaps in that file. |
| A-24 | **D24.** Documentation: README (Dutch and English, five-minute install, screenshots, demo GIF), `docs/architecture.md`, `docs/security.md` (STRIDE, ASVS L2 mapping started), `docs/permissions.md`, `docs/operations.md`, `docs/open-points.md`, `docs/adr/`. | |
| A-25 | **D25.** Product UI language defaults from the browser (nl or en), is switchable and stored per browser; branding and organisation name are data and are not translated. | |
| A-26 | **D26.** Agents commit on the designated branch and push; they do not open a pull request unless the owner asks (AGENTS.md section 8). | |

### 9.2 Further defaults chosen in this spec

| ID | Assumption | Verification note and revisit trigger |
|---|---|---|
| A-27 | **Playwright is pinned to 1.56.x.** The pre-installed Chromium is revision 1194 and browsers are never installed in this environment. | Checked: `playwright-core` 1.56.0 and 1.56.1 `browsers.json` list chromium revision 1194 (141.0.7390.37); 1.55.1 lists 1193 and 1.57.0 lists 1200. `@axe-core/playwright` follows. Registry latest is 1.64.0; move up when the sandbox browsers change. GitHub runners install the matching revision for the pinned version. |
| A-28 | **ESLint 10.12.x and TypeScript 6.0.x**, not ESLint 9 and not the registry's latest TypeScript major. | Checked (stack probe P1, P2): ESLint 9.39.5 is flagged as no longer supported by pnpm, ESLint 10.12.0 works; `eslint-plugin-jsx-a11y` 6.10.2 (last modified 2024-10) declares peer `eslint` up to `^9` but all its rules fire on ESLint 10, so the peer is forced for that one parent (`peerDependencyRules`); `typescript-eslint` 8.71.1 declares peer `typescript` `>=4.8.4 <6.1.0`; TypeScript 7.0.2 has no JavaScript API. Decision D4 holds with these pins. Revisit when the plugins move (R-12, R-16). |
| A-29 | Anonymous writes answer **403 `permission_denied`**, not 401. | Nothing in Phase A can authenticate, so 401 would invite a sign-in that does not exist, and HTTP semantics expect a challenge with a 401 (RFC 9110, not re-read here). Phase B adds 401 `unauthenticated` for a missing session. |
| A-30 | **Preview-mode remote guard** (own addition): `PREVIEW_MODE=true` with a non-loopback `PUBLIC_BASE_URL` refuses to start unless `PREVIEW_MODE_ALLOW_REMOTE=true`; and, because the default `PUBLIC_BASE_URL` is loopback even when the port is published, a request with a non-loopback `Host` or with forwarding headers is resolved as the anonymous actor (FR-A-036). | Reason: preview mode is unauthenticated administration. OD-04 asks the owner to confirm. |
| A-31 | The only origin the server trusts for writes is the origin of `PUBLIC_BASE_URL`, default `http://localhost:<PORT>`. The `Host` header is not used for that decision. | Opening the app by another address makes writes fail with `origin_not_allowed` (E-14). |
| A-32 | The CSRF token is a stateless HMAC token with a per-process random key held in memory, TTL 8 hours, fetched from a same-origin `GET`; no cookie. | Tokens die with the process and the client refetches once on `csrf_invalid`. Phase B binds the token to the session through the `binding` argument. Single instance only (A-57). |
| A-33 | Non-browser clients must send `Origin` (equal to the public origin) and the CSRF token on writes. | API tokens for automation are a later decision (the brief says "automatisering later"). |
| A-34 | `/healthz` is liveness (answers while the process runs, even degraded); `/readyz` is readiness (storage and schema). Docker `HEALTHCHECK` and compose use `/readyz`, so an unusable volume shows as unhealthy; an orchestrator that restarts on liveness uses `/healthz`. | The brief names `/healthz` and, in section 7, `/readyz` without saying which the container check uses (BC-19). |
| A-35 | **Degraded mode** instead of exit when storage is unusable (FR-A-013). | An operator without log access (a NAS) still gets a page that explains the problem; a crash loop hides it. Invalid configuration and failing migrations still exit. |
| A-36 | Limit values in section 6.5. The **branding import limit is 9 MiB, not the 8 MiB suggested in D20**. | Three images of 2 MiB are 8,388,612 base64 characters before any JSON, so 8 MiB cannot hold them. If the owner prefers 8 MiB, imports of hand-edited files with three maximum-size originals would be refused; exports (stored masters of at most about 1 MiB each) would still fit. OD-04. |
| A-37 | Uploads are **staged**: `POST /api/v1/branding/assets` processes and stores an unreferenced (`unreferenced_at` set), content-addressed PNG and returns hashes and warnings; `PUT /api/v1/branding` references hashes. | Gives a live preview, a clean audit story and concurrency control; abandoned uploads are deleted after 24 hours. |
| A-38 | **SVG policy:** any DOCTYPE or ENTITY is refused; unsupported content is dropped with a warning; `<text>` and `<tspan>` are refused; `<style>` elements are dropped and inline styles converted; the Phase A allowlist excludes filters, patterns, images, anchors and switches. | The distroless runtime has no fonts, so live text would render wrongly or empty; the user is told to convert text to outlines. Revisit if the font probe (R-06) shows a bundled font works. OD-04. |
| A-39 | One logo for both themes: shown unchanged, and on a contrasting neutral plate in the theme where its measured luminance would make it illegible. Never recoloured or inverted. | "Automatische weergave als er één is" (brief 5a) is read this way. |
| A-40 | Monogram guarantee: A to Z and 0 to 9 with Latin transliteration, else a generic pictogram; glyphs are pre-generated paths. | The probe (R-06) may show a bundled font also works; the guaranteed set and the tile-equals-icon rule stay either way. Cyrillic, Greek and CJK names get the pictogram in Phase A; widening is an owner request. |
| A-41 | The organisation-name rules of FR-A-081 (64 graphemes, 256 bytes, refusal of bidi and invisible characters) are the author's choice; the brief gives none. | Refusing bidi controls prevents spoofed names in the sidebar, audit log and dialogs. |
| A-42 | Default organisation name is "M365Portal"; the default accent is a calm blue defined once in the token module. From Phase B the default name is the tenant's display name ("standaard de tenantnaam", brief 5a). | Phase A has no tenant. |
| A-43 | Concurrency uses HTTP preconditions: `If-Match` with the revision, 412 on mismatch, 428 when missing. | |
| A-44 | The client address is stored in the audit table only (personal data); logs carry none. Hash-chain canonicalisation: sorted keys, no whitespace. SQLite triggers block UPDATE and DELETE. The head hash is logged. | This is tamper-evidence, not tamper-proofing against someone with file access (documented in `docs/security.md`). BC-14. |
| A-45 | Rate-limit numbers and exemptions (health and static assets) as in section 6.5. | A page load makes many asset requests; limiting them would 429 normal use. |
| A-46 | HSTS default `max-age` 31,536,000 seconds; `preload` demands `includeSubDomains` and that `max-age`. | The coupling is conservative and follows the HSTS preload list's requirements from general knowledge; not re-read in this task. |
| A-47 | Version scheme: `VERSION` is 0.1.0 (governance bootstrap). Phase A releases 0.2.0, B 0.3.0, C 0.4.0, D 0.5.0; 1.0.0 after the owner accepts Phase D; patch bumps for fixes. | OD-05. |
| A-48 | Integration branch `main` (the existing `version-guardrails.yml` already triggers on pushes to `main`). Channel tags: `latest` (moves), `v<VERSION>` (immutable), `sha-<short>` (immutable). No `stable` or `beta` until the owner defines channels. | Baseline section 5 asks for an explicit channel policy. OD-02. |
| A-49 | Image name `ghcr.io/flux76hq/m365portal`. | Taken from acceptance criterion 1; GHCR names are lower case. |
| A-50 | `image.yml` has two jobs: `image` on pull requests (build, smoke, Trivy, SBOM, no push, no secrets) and `publish` on a push to the integration branch and on manual dispatch (push, sign, attest). | Resolves BC-07. |
| A-51 | Visual baselines are committed with a platform suffix. The first GitHub run may need baselines regenerated from the CI container; that is an owner-visible act, not a silent update. | R-01. |
| A-52 | Lighthouse repeats follow baseline section 8: only timing may be repeated, every measurement is kept, and the lost sensitivity is named (a regression smaller than the runner spread can pass). | |
| A-53 | axe: zero violations for the WCAG tag set; best-practice rules fail only at impact serious or critical. | Stricter than "no serious problems" (criterion 7) for the tagged set. |
| A-54 | Only four shortcuts exist in Phase A (palette, `?`, `/`, Esc). | More are added with a reason. |
| A-55 | Offline scope: offline page and graceful API failure; no offline data and no queued writes. | |
| A-56 | The app sets **no cookies** in Phase A. Theme, language and sidebar state use `localStorage`; the CSRF token is held in memory. | Postpones the `__Host-` question (BC-03) to Phase B, where cookies first exist. |
| A-57 | `/data` must be on a local disk and exactly one replica runs. | WAL does not work over a network filesystem (checked on sqlite.org/wal.html). BC-15. |
| A-58 | Governance scripts stay Python; new repository tooling is TypeScript on Node; workflow and Docker checks are Python tests next to the existing ones (`py/`). | |
| A-59 | Microsoft facts for Phases B to D come from `research-microsoft.md`. This task spot-checked two of its claims on Learn (add-member application permission `GroupMember.ReadWrite.All`, plus `RoleManagement.ReadWrite.Directory` for role-assignable groups; the Exchange Admin API endpoint list of six, where `/DistributionGroupMember` supports only `Get-DistributionGroupMember`); both matched. Nothing in Phase A depends on a Microsoft API. | Everything else there keeps its own status; UNVERIFIED items U1 to U17 go to `docs/open-points.md`. |
| A-60 | Locales: nl and en, left to right only. | E-07. |
| A-61 | The release gate is atomic: `publish` creates the git tag through the API first (a tag cannot be created twice) and pushes the version image tag only in the run that created it. | Baseline section 5. |
| A-62 | Keyless cosign through GitHub OIDC signs the digest only when the repository is public (the public Sigstore instance writes the identity to a public transparency log). Build provenance and the CycloneDX SBOM are GitHub artifact attestations, which GitHub documents as SLSA v1.0 Build Level 2 at most (Level 3 needs a reusable workflow). This spec asserts no higher level. | Checked in the plan (V-09). R-13. |
| A-63 | Two ports, two meanings: `PORT` is the in-container listening port and `HOST_PORT` the Docker-host published port (Compose only). With plain `docker run -p 9090:9300` the operator must also set `PUBLIC_BASE_URL` to the browser-visible origin; with `network_mode: host`, `PORT` is the host port. | A host port changed without a matching `PUBLIC_BASE_URL` makes writes fail with `origin_not_allowed` (E-14); the problem says which origin it expected. Requested by the owner during Phase A. |

---

## 10. Brief conflicts and ambiguities

Where the brief, the baseline, Microsoft Learn or the decision brief disagree or leave a gap, and what this spec does about it.

| ID | Where | Conflict or ambiguity | Resolution in this spec | Phase |
|---|---|---|---|---|
| BC-01 | Brief 6 "HSTS (preload)"; baseline section 13 | The brief asks for HSTS with preload; baseline section 13 says `includeSubDomains` is a promise about hosts you may not own, only for hosts the project owns, and preload needs it. A self-hosted app cannot know which hosts the operator owns. | Default plain `max-age` over https only; `includeSubDomains` and `preload` are operator opt-ins by env with a test in both directions (FR-A-043). The A+ criterion (8) may need those opt-ins; scanner rules were not read (UNVERIFIED). | A |
| BC-02 | Brief 3 step 3 "minimaal `User.ReadWrite.All`, `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`, `Directory.Read.All`, `Organization.Read.All`"; brief 2 and 6 least privilege | The brief's own "minimaal" is the broadest set, contradicting its least-privilege rule. Learn (research 0, 1.2, 1.5): for the product's operations the least-privileged application permissions are `User.Read.All`, `GroupMember.ReadWrite.All`, `GroupMember.Read.All` (see U1) and `Organization.Read.All`; `User.ReadWrite.All`, `Group.ReadWrite.All` and `Directory.Read.All` are higher-privileged for every call; role-assignable groups need `RoleManagement.ReadWrite.Directory`, which must not be granted. | Not decided here. OD-06 at the Phase B gate; `docs/permissions.md` shows both with status. | B |
| BC-03 | Brief 6 `__Host-` cookies; brief 2 "ook `http://localhost` is toegestaan" | The `__Host-` prefix requires the `Secure` attribute; whether a browser accepts a `Secure` cookie from plain `http://localhost` is browser-dependent and was not verified. Learn: a redirect URI may use http only for `localhost`, the port is ignored when matching, and `http://localhost/<path>` is what to register (research 5.5, U14). | Phase A sets no cookies (A-56). Phase B proposal: `__Host-` name only when `PUBLIC_BASE_URL` is https; on `http://localhost` a plain-named `HttpOnly`, `SameSite=Strict` cookie, documented as a development trade-off. Needs owner confirmation at the Phase B gate. | B |
| BC-04 | Brief 5a "sanitize SVG ... of render naar PNG"; D17 "sanitise ... then ALWAYS rasterise" | The brief says sanitise or rasterise; D17 says both. If every upload is rasterised, a sanitised SVG is never served, so the sanitiser is defence in depth for the rasteriser, not for browsers; vector sharpness is lost (mitigated by bounded 512 px masters); live `<text>` cannot render in a distroless runtime. | Both, as D17 says (FR-A-087, FR-A-088); `<text>` refused (A-38). | A |
| BC-05 | Brief 5a "max. 2 MB"; D20 "branding import 8 MiB" | MB versus MiB; and 8 MiB is arithmetically too small for three 2 MiB images in base64 (8,388,612 characters before JSON). | 2 MiB = 2,097,152 bytes; import limit 9 MiB (A-36); stated as a number for the proxy. | A |
| BC-06 | Brief 6 "CSP met nonces (geen `unsafe-inline`)", Trusted Types | UI libraries and the service-worker registration may need inline style attributes or script-URL sinks. Whether each dependency works under `require-trusted-types-for 'script'` and `style-src` without `unsafe-inline` was not verified. | Set styles through the CSSOM (not blocked by CSP, believed), nonce for `<style>` elements; the e2e violation guard is the verifier (FR-A-042). If a dependency cannot comply it is replaced; the policy is never weakened silently (R-05). | A |
| BC-07 | AGENTS.md CI table (`image` on every PR: build, smoke, Trivy, SBOM); D19 `image.yml` with push, cosign, provenance | One job cannot both run for fork pull requests without secrets and push, sign and attest. | Two jobs, `image` and `publish` (A-50). | A |
| BC-08 | Brief 1 and 4 "Exchange via REST (`InvokeCommand`)" | Learn does not document an `InvokeCommand` endpoint (research 3.5). It documents the Exchange Online Admin API (Preview) with six endpoints; `/DistributionGroupMember` supports only `Get-DistributionGroupMember`; `Get-DistributionGroup`, `Add-/Remove-DistributionGroupMember` and every `*-MailContact` cmdlet are outside it (spot-checked in this task). So criteria 3, 4, 12 and 13 have no documented REST path. | OD-07 before Phase D (ideally at the Phase B gate): pwsh worker for all Exchange calls, Admin API Preview for reads only, or the unsupported route. | B, D |
| BC-09 | Brief 6 "MFA via de `amr`/`acr`-claim" | `amr` is an optional claim that must be requested; `acr` is v1.0-only; authentication context uses `acrs` (research 5.2, 5.3). | Phase B uses `amr` through the optional claim set by the wizard, and treats an `amr` containing `mfa` as the signal (OD-08). | B |
| BC-10 | D18 distroless runtime and "one image, one container" (brief 1); brief 1 "optioneel `pwsh` ... als fallback" | A distroless runtime has no shell and cannot hold PowerShell. Learn lists the Exchange Online module on Linux only for Ubuntu LTS and requires PowerShell 7.4 or 7.6 and newer (research 3.5, U9). If OD-07 picks `pwsh`, the runtime base must change (for example an Ubuntu-based runtime stage), and "distroless" is lost. | Phase A ships distroless as decided (FR-A-160) and records the possible base change in an ADR so Phase D is not a surprise. | A (decision), D |
| BC-11 | Brief 3 step 2 and 3: delegated scopes incl. `Directory.Read.All`; "tijdelijke Global Administrator" | `Directory.Read.All` is not needed by any wizard call; `AppRegistration.Create` is the least privileged for creating the registration, but `Application.ReadWrite.All` is needed anyway; Global Administrator is sufficient, not required (Privileged Role Administrator plus an app-registration-capable role is the documented minimum) (research 2.2, 2.3). | Phase B gate (OD-08). | B |
| BC-12 | Brief 3 step 3 "Exchange Administrator (of een custom Exchange-rolgroep)" versus brief 6 "bij voorkeur een beperkte Exchange-rolgroep" | The brief prefers the narrow role group in section 6 but the wizard in section 3 defaults to Exchange Administrator; the role-group route needs an interactive Exchange PowerShell session during the wizard and the minimal role set is unverified (research 3.2, U5, U6). | Phase B gate (OD-08), tied to OD-07. | B, D |
| BC-13 | Brief 4 users list shows "licenties" | `GET /users/{id}/licenseDetails` documents "Application: Not supported" (research 0, U17). | Licence column only if an app-only source is verified at the start of Phase C. | C |
| BC-14 | Brief 6 audit with IP; D15 logs with no PII | An IP address is personal data. | Audit table keeps it (documented as personal data); logs never do (FR-A-051, FR-A-073). Retention is OD-10 for Phase D. | A, D |
| BC-15 | Brief 1 hosting "NAS"; SQLite WAL | WAL does not work over a network filesystem; many NAS volumes are exactly that. | Documented unsupported (E-24, A-57); local disk or a Docker volume on local disk only. | A |
| BC-16 | D4, D5 versus the registry | TypeScript 7 is current but has no JavaScript API, so `typescript-eslint` cannot use it; ESLint 9 is flagged unsupported by pnpm, and ESLint 10 works only with a forced peer on the unmaintained `eslint-plugin-jsx-a11y`; Playwright's browser must match the pre-installed Chromium. | Pins in A-27 and A-28. | A |
| BC-17 | Brief 3 step 4 verification `Get-DistributionGroup -ResultSize 1` | That cmdlet is outside the documented Admin API; only `Get-OrganizationConfig` and `Get-DistributionGroupMember` could use it (research 3.5). | Phase B verification uses calls on a documented path; decided with OD-07. | B |
| BC-18 | Brief 5a "organisatienaam ... in e-mails", "standaard de tenantnaam" | No phase sends mail; Phase A has no tenant. | No mail is built; the default name is "M365Portal" until Phase B (A-42). | A |
| BC-19 | Brief 1 "healthcheck-endpoint `/healthz`", brief 7 "`/healthz` en `/readyz`", D18 `HEALTHCHECK` | Which endpoint the container check uses is not stated. | A-34. | A |

---

## 11. Owner decisions needed

Defaults apply if the owner stays silent, and nothing in Phase A is blocked by any of them.

| ID | Decision | Why it matters | Default | Needed by |
|---|---|---|---|---|
| OD-01 | Licence of the repository and image, and whether the repository and the GHCR image are public or private. | Fills the `licenses` OCI label and the README; keyless signing through the public Sigstore instance writes the signing identity to a public transparency log, which for a private repository would disclose its name (UNVERIFIED here). | No licence label. `publish` runs only on a push to the integration branch and on manual dispatch, which happens after the owner merges, so nothing is pushed before the owner has answered; cosign keyless signing runs only for a public repository (A-62), a private repository gets GitHub attestations. | Phase A gate |
| OD-02 | Integration branch name and the channel tag policy (`latest`, `stable`, `beta`). | `version-guardrails.yml` and `publish` trigger on it; AGENTS.md section 8 says it is undecided. | `main`; tags `latest`, `v<VERSION>`, `sha-<short>`. | Phase A gate |
| OD-03 | Fate of preview mode in Phase B: removed, or kept as a development-only switch. | Preview mode is unauthenticated administration. | Removed in Phase B. | Phase B gate |
| OD-04 | Confirm the Phase A deviations and additions: import limit 9 MiB instead of 8 MiB (A-36), `<text>` in SVG refused (A-38), 403 instead of 401 for anonymous writes (A-29), the remote guard for preview mode (A-30), HSTS defaults (A-46). | Each is a visible behaviour the brief did not specify. | As written. | Phase A gate |
| OD-05 | Version scheme: 0.2.0 for Phase A to 0.5.0 for Phase D, 1.0.0 after acceptance. | Image tags, releases and the version guard. | A-47. | Phase A gate |
| OD-06 | Graph application permission set: the brief's five, or the smaller Learn-backed four (`User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; research 1.5). | Least privilege, consent screen, `docs/permissions.md`. | The smaller set. | Phase B gate |
| OD-07 | Exchange execution path and runtime base: a `pwsh` worker for all Exchange calls (documented, Ubuntu-based runtime), Admin API Preview for reads only, or the undocumented `InvokeCommand` route. | Decides whether criteria 3, 4, 12 and 13 are achievable, whether the image stays distroless, and the image size. [Marker on FR-A-160.] | None can be assumed: ask early. | Phase B gate at the latest |
| OD-08 | Service-principal role (Exchange Administrator, Exchange Recipient Administrator, custom role group), the wizard user's role (Global Administrator or Privileged Role Administrator plus an app-registration role), the bootstrap fallback when device code is blocked, and the MFA policy (rely on Conditional Access only, or also require `amr` with `mfa`). | Research owner decisions O3 to O6. | Exchange Administrator now, narrower later; both wizard roles accepted; `BOOTSTRAP_CLIENT_ID` override; `amr` check on. | Phase B gate |
| OD-09 | Add root configuration files (`tsconfig*.json`, `eslint.config.*`, `.nvmrc`) to `scripts/version_guard_paths.py`. | A change there can alter the shipped image without a version bump (R-11). | Propose the addition in the Phase A report. | Phase A gate |
| OD-10 | Retention of audit entries, which hold client addresses (personal data). | GDPR and disk growth (R-09). | Keep everything until Phase D defines retention. | Phase D |
| OD-11 | Policy for pinning actions by commit SHA (answered in the plan: SHAs can be looked up, V-07). | Version tags are mutable (R-04). | Pin by commit SHA with the version in a comment; Dependabot proposes bumps. | Phase A gate |

---

## 12. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-01 | Visual-regression baselines made with the sandbox Chromium may differ from the GitHub runner (font rasterisation and system libraries), producing false failures on the first CI run. | Same Chromium revision through the Playwright pin (A-27); self-hosted font; platform-suffixed baselines; documented tolerance; regeneration from the CI container as an owner-visible step (A-51). |
| R-02 | Lighthouse scores vary with the runner (baseline section 8). | Best of 3 for timing only, all measurements kept, lost sensitivity named (A-52). Raising a threshold is the owner's call. |
| R-03 | GitHub Actions workflows cannot be run from this environment, so a workflow may fail on its first real run. | Static checks (`actionlint`, `py/test_workflows.py`), every command run locally, `docker compose config`, and the phase report separating what ran locally from what only runs on GitHub. |
| R-04 | A pinned SHA must be re-resolved whenever Dependabot proposes a bump, and a wrong SHA only fails on the first GitHub run. | Pins by commit SHA looked up with `git ls-remote --tags` and checked on 2026-10-10 (V-07); `py/test_workflows.py` asserts the pin format; least-privilege permissions (FR-A-174); Dependabot for github-actions; OD-11. |
| R-05 | A dependency (Radix, cmdk, Motion, TanStack, the service-worker registration) may not work under Trusted Types or CSP without `unsafe-inline`. UNVERIFIED. | The e2e violation guard finds it; replace the dependency rather than weaken the policy; weakening needs the owner. |
| R-06 | sharp on distroless: the stack probe (P3, P22) showed that SVG shapes rasterise in the distroless image and that SVG `<text>` does not (no fonts, no fontconfig); the behaviour of the final image is re-checked by the smoke test. | Pre-generated glyph paths for the monogram, `<text>` refused (A-38); `image` smoke test checks an icon from the real container (FR-A-092). If SVG rasterisation is missing, a separate rasteriser is chosen in the plan. |
| R-07 | arm64 cannot be tested here. | Built in `publish`; limitation stated in the report. |
| R-08 | Preview mode on a reachable network is unauthenticated administration of branding. | Remote guard (FR-A-035), per-request loopback `Host` and forwarding-header rule (FR-A-036), loud warning, permanent banner, documentation that says to publish the port on loopback, removed in Phase B. |
| R-09 | A hostile client can grow the audit table through denied writes. | Write bucket bounds the rate per client; 429s are not audited; retention in Phase D (OD-10). Residual: the per-client buckets do not bound many source addresses (an IPv6 range, a too-wide `TRUST_PROXY`); a global cap on denial rows is an open decision for Phase D. |
| R-10 | NAS or network volumes break SQLite WAL. | Documented unsupported (A-57). |
| R-11 | The version guard does not cover root configuration files, so a toolchain change can ship without a bump. | OD-09. |
| R-12 | `eslint-plugin-jsx-a11y` appears unmaintained (last modified 2024-10) and caps ESLint at 9. | axe in e2e is the primary accessibility control, lint the secondary one (A-28). |
| R-13 | Keyless signing through the public Sigstore instance writes the signing identity to a public transparency log, which for a private repository would disclose its name. | Cosign keyless runs only for a public repository; a private repository gets GitHub attestations (V-09, SA-09). OD-01. |
| R-14 | Rate-limit buckets and the CSRF key live in memory: they reset on restart and do not work across replicas. | Single instance is a documented rule (A-57). |
| R-15 | Phases B to D rest on Microsoft claims that are UNVERIFIED (U1 to U17). | Listed in `docs/open-points.md`; the owner tests against a real tenant after B and D. |
| R-16 | The registry is ahead of the brief's assumptions (Vite 8, Vitest 5, TypeScript 7, ESLint 10); incompatible combinations are likely. | Exact pins, peer ranges checked in the plan, frozen lockfile. |
| R-17 | Playwright pinned to 1.56.x is behind the registry's latest. | Upgrade path recorded; Dependabot ignore rule documented for that package. |

---

## Appendix A. Hostile upload corpus (minimum)

Every fixture is generated inside the test from a template (no malicious file is committed, which also avoids antivirus noise). `apps/server/test/fixtures/hostile-corpus.ts` holds the generators; `server/branding/hostile-uploads.test.ts` reads the IDs of this appendix and fails if one has no fixture (spec first). Each fixture must finish within 5 seconds on the CI runner. After every fixture the test also asserts: nothing is left in `/tmp` or `${DATA_DIR}/branding/.tmp/`, the served bytes of any stored result contain none of the payload markers, and the audit log holds one entry with the expected outcome.

"Neutralised" means accepted, rasterised to PNG, with the dangerous content gone and a warning reported. "Rejected" names the problem code.

| ID | Category | Payload | Expected |
|---|---|---|---|
| H-01 | SVG active content | `<script>` element (inline and with `src`) | Neutralised, warning `svg_content_removed` (script) |
| H-02 | SVG active content | Event-handler attributes (`onload`, `onclick`, `onmouseover`, `onfocus`) on root and children | Neutralised |
| H-03 | SVG active content | `javascript:` and `vbscript:` in `href` and `xlink:href` on `<a>` and other elements | Neutralised (`<a>` is not on the allowlist) |
| H-04 | SVG external reference | `<image href="https://attacker.example/x.png">` (server-side request forgery) | Neutralised; zero outbound connections |
| H-05 | SVG external reference | `<image href="data:image/svg+xml;base64,...">` nested document | Neutralised; zero outbound connections |
| H-06 | SVG external reference | `<use href>` pointing to an external URL or `file:///etc/passwd` | Neutralised |
| H-07 | SVG active content | `<foreignObject>` holding HTML, `<iframe>`, `<script>` | Neutralised |
| H-08 | SVG external reference | `<style>@import url(https://...)</style>` and `style="fill:url(https://...)"` | Neutralised; zero outbound connections |
| H-09 | SVG external reference | `<filter>` with `<feImage href>` | Neutralised |
| H-10 | SVG active content | SMIL `<animate attributeName="href" to="javascript:...">`, `<set>` | Neutralised |
| H-11 | SVG namespace tricks | `<svg:script>` with a prefix, a re-bound default namespace, and an XHTML-namespaced `<html:script>` | Neutralised (elements outside the SVG namespace are dropped) |
| H-12 | SVG case tricks | `<SCRIPT>`, `<ScRiPt>`, `OnLoad` | Neutralised (unknown names dropped) |
| H-13 | SVG parser tricks | CDATA-wrapped script, comments with markup, `<?xml-stylesheet href="https://..."?>` | Neutralised; processing instruction dropped |
| H-14 | XXE | `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` with `&xxe;` | Rejected `svg_doctype_forbidden`; a marker file's content never appears |
| H-15 | Entity expansion | Billion-laughs internal entities | Rejected `svg_doctype_forbidden`; bounded time and memory |
| H-16 | XInclude | `<xi:include href="file:///etc/hostname">` | Neutralised; nothing read |
| H-17 | Unsupported text | `<text>` and `<tspan>` | Rejected `svg_text_unsupported` |
| H-18 | Complexity | More than 10,000 elements; nesting deeper than 64 | Rejected `svg_too_complex` |
| H-19 | Dimension bomb | `width="1e9" height="1e9"`, extreme `viewBox` | Rasterised at the bounded size within the time budget, or rejected `svg_too_complex`; no memory spike |
| H-20 | Encoding tricks | UTF-16 with BOM; `<?xml encoding="UTF-7"?>` with a UTF-7 payload | Rejected `svg_not_wellformed` (UTF-8 only) |
| H-21 | Malformed XML | NUL bytes, invalid characters, unclosed and mismatched tags | Rejected `svg_not_wellformed` |
| H-22 | Compression | gzip-compressed SVG (`.svgz`) | Rejected `image_type_unsupported` |
| H-23 | Nothing left | SVG whose content is entirely disallowed | Rejected `image_empty` |
| H-24 | Reference loops | Gradient `href` cycles, `clip-path` and `mask` self-references, references to missing ids, and an exponential `use` fan-out without any cycle (a chain of groups that each reference the previous one ten times, expanding to far more than 100,000 instances) | Rejected before rendering or terminated within the time budget (the child is killed); neutralised or rejected `svg_too_complex` |
| H-25 | Polyglot | Valid PNG followed by HTML and JavaScript after `IEND` | Accepted; re-encoded output contains none of the trailing bytes |
| H-26 | Metadata payload | JPEG with script text in EXIF and XMP comments, GPS tags and an embedded thumbnail | Accepted; output has no EXIF, XMP, ICC or thumbnail |
| H-27 | Metadata payload | PNG with `tEXt`, `iTXt`, `zTXt` chunks carrying script text | Accepted; output chunk types limited to `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` and `pHYs` (sharp always writes `pHYs`) |
| H-28 | Pixel bomb | PNG header declaring 60,000 by 60,000 pixels; a small, highly compressible 40,000 by 40,000 image | Rejected `image_pixels_exceeded` before the full decode |
| H-29 | Corrupt data | PNG and JPEG truncated at half length | Rejected `image_corrupt` |
| H-30 | Animation | APNG with several frames | Accepted as the first frame, warning `animation_flattened` |
| H-31 | Type confusion | SVG bytes named `logo.png` with `Content-Type: image/png` | Decided by content: handled as SVG |
| H-32 | Type confusion | PNG bytes named `logo.svg` with `Content-Type: image/svg+xml` | Decided by content: handled as PNG |
| H-33 | Unsupported formats | GIF89a, WebP, AVIF and HEIC, TIFF, BMP, ICO and PDF bytes with an image name | Rejected `image_type_unsupported` |
| H-34 | Not an image | An HTML document with a script; an empty body; a one-byte body | HTML and one byte: rejected `image_type_unsupported`; empty: rejected `image_empty` |
| H-35 | Size boundary | A valid image of exactly 2,097,152 bytes; one of 2,097,153 bytes | First accepted; second refused with 413 `payload_too_large` (the request cap of 2,162,688 bytes is what cuts off a streaming body) |
| H-36 | Streaming abuse | Chunked body without `Content-Length` beyond the limit; client aborts mid-upload | Aborted at the limit; connection closed; no temporary file remains |
| H-37 | Slow upload | A body sent a few bytes at a time (test uses a shortened request timeout) | Connection closed with 408 after the timeout; resources freed |
| H-38 | Name tricks | Multipart `filename` with `../../x`, NUL and CR LF | Ignored; stored name is the content hash |
| H-39 | Concurrency | 20 simultaneous valid uploads | At most 2 processed at once, queue of 4, the rest 429 `image_processing_busy` |
| H-40 | Colour and profile | CMYK JPEG; a JPEG with a roughly 2 MB ICC profile | Accepted; converted to sRGB; profile dropped |
| H-41 | Correctness | JPEG with EXIF orientation 6 | Output is upright and has no EXIF |
| H-42 | Hostile import | JSON with `__proto__` and `constructor` keys; duplicate keys; unknown keys; invalid base64; a media type that does not match the bytes; nesting depth 10,000; 9,437,185 bytes | Rejected `import_invalid` or 413; nothing applied |
| H-43 | Asset-name tricks | `/branding/..%2f..%2fetc%2fpasswd`, NUL, uppercase hex, 63 and 65 characters, `.png.exe` | 404 |
| H-44 | Stored XSS canary | Organisation name `"><img src=x onerror=alert(1)>` and `</title><script>alert(1)</script>` | Stored as text; inert in title, manifest, sidebar, toasts and dialogs; no dialog opens; zero `securitypolicyviolation` events |
