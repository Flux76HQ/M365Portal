# Phase B report / Fase B-rapport

Date / datum: 2026-10-12 · Branch `claude/modest-bohr-45f4kf`, build `0.3.33` · Spec: `specs/002-phase-b/spec.md` · Gate notes: `specs/002-phase-b/gate-notes/GB0.md` to `GB9.md`

Status: **Phase B is built; the owner test against a real Microsoft 365 test tenant is open. GB7 (e2e, visual baselines, Lighthouse, image) and GB9 are "pending CI".** Nothing in this report claims what only a real tenant can show.

Status: **Fase B is gebouwd; de test van de eigenaar op een echte Microsoft 365-testtenant staat open. GB7 (e2e, visuele baselines, Lighthouse, image) en GB9 zijn "pending CI".** Dit rapport beweert niets wat alleen een echte tenant kan laten zien.

---

## 1. Summary / Samenvatting

### 1.1 What was built (English)

- **Platform**: 14 new variables with cross-field rules; migration `0001_phase_b` (17 tables, 9 indexes, 29 triggers, 4 seeds); audit vocabulary and detail allow-list; 53 problem codes with Dutch and English text; module availability and five new modules.
- **Secrets**: `APP_KEY` (or `APP_KEY_FILE`), XChaCha20-Poly1305 sealed box with a key id, a self-signed RSA 2048 certificate valid 360 days, key rotation, a degraded mode without the key. CLI commands: `generate-app-key`, `hash-password`, `rotate-app-key`, `setup-token`, `setup-reopen`, `verify-audit`.
- **Microsoft clients and one fake tenant**: `GraphClient`, `TenantProvisioner`, `ExchangeClient` (read adapter for the Admin API only), identity (client assertion, application tokens through MSAL, device-code bootstrap, ID-token validator, token endpoint). Entra, Graph and Exchange are simulated by one fake tenant (MSW), with a self-test of its strictness.
- **Setup wizard** (5 steps: environment, connect, configure, verify, finish) with a setup token, a resumable runner with a live log, manual provisioning mode (checklist plus downloadable `.cer`), the proof list V1 to V6, and "repair the connection" after completion.
- **Sign-in**: Entra authorization code flow with a server-side session, MFA check on `amr`, step-up, sign-out and sign out everywhere, 45 sign-in fixtures, an interstitial instead of a 303 after the callback, revalidation, an administrator-consent link.
- **RBAC**: five built-in roles and the *Bestuur* template, assignments to users and groups with scopes and expiry, central `authorize`, anti-escalation, last-Owner protection, "My access", default deny.
- **Break-glass**: optional local account that can only restore an Owner.
- **Web**: wizard, sign-in, no-access, Settings (Connection, Access, Restore access), persona menu, session timers, break-glass banner, lazy language files.
- **Docs, deploy, e2e**: `docs/*.md`, README, 54 new ADRs (0101 to 0126, 0151 to 0178), deploy files, image checks, e2e topology with the fake tenant, 38 e2e spec files, Lighthouse harness.

**Deliberately not built**: users and groups screens, distribution lists, contacts and CSV, an RBAC admin screen, an audit screen, OpenTelemetry, Bicep, any Exchange write path (the `ExchangeClient` has a documented read adapter only), certificate self-renewal by `addKey` (Phase D).

**Deviations from the brief, with evidence** (ODB rows in part 4): four Graph application permissions instead of five (ODB-02, `docs/permissions.md`); certificate lifetime 360 days (a credential is limited to one year); the wizard locks at the first Owner sign-in, not at "finish" (ODB-05); `response_mode=query` plus an interstitial page (SB-14, RB-11); step-up by `prompt=login` and a fresh `auth_time`, without `max_age` (U13, U27); the manual mode (ODB-07); scopes per object type; denials of permissioned reads are audited (ODB-12).

**Decisions taken while building** (also in `docs/open-points.md`): a step-up without MFA gives `mfa_required` or `amr_missing`, not `stepup_failed` (FR-B-411); the F-45 fixture uses 250 short `groups` entries; audit `actor.id` is `anonymous` or `break-glass` for requests without a user (the contract text follows the code); the Grant scope literal is lower case `all`; MSW is wired for `fetch` only; route ids are lower case (SB-27: `auth.logout.all`, `auth.breakglass`, `connection.runs.retry.now`, `rbac.restore.owner`); the revalidation guard lives in `http/route.ts`; restore-owner works from a break-glass session only; the manual-mode certificate is generated and sealed on the first `GET /api/v1/setup/certificate.cer`; certificate renewal beyond the repair run (planned step 7) is not built; repair is not available in manual mode; the stored default language reaches the browser only once the setup is completed.

**Deployment files (AGENTS.md statement)**: new variables and defaults, all in `.env.example`: `APP_KEY` or `APP_KEY_FILE` (exactly one; required once a certificate exists), `APP_KEY_PREVIOUS`, `APP_KEY_PREVIOUS_FILE`, `SETUP_TOKEN` (optional), `BOOTSTRAP_CLIENT_ID` (`14d82eec-204b-4c2f-b7e8-296a70dab67e`), `SETUP_PROPAGATION_TIMEOUT_SECONDS` 900, `SESSION_IDLE_TIMEOUT_MINUTES` 30, `SESSION_ABSOLUTE_TIMEOUT_HOURS` 8, `GROUP_CACHE_TTL_SECONDS` 300, `AUTH_REQUIRE_MFA` true, `AUTH_MFA_AMR_VALUES` `mfa,multipleauthn`, `BREAK_GLASS_USERNAME`, `BREAK_GLASS_PASSWORD_HASH` (both or neither). `PORT` and `HOST_PORT` default 9300 and are editable in `.env`. Compose has a `secrets:` stanza (`app_key` from `./secrets/app_key`, `APP_KEY_FILE=/run/secrets/app_key`). `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` are removed and ignored with one warning. An existing Phase A deployment starts `unconfigured`.

**Limits as numbers**: largest accepted request 9,437,184 bytes (unchanged); JSON bodies 262,144; the four authentication bodies 4,096; sessions 30 minutes idle and 8 hours absolute; setup session 60 minutes idle and 8 hours; step-up window 10 minutes; break-glass session 30 minutes and 128 MiB scrypt memory per verification; group cache 300 seconds; assignments 5,000, roles 100, bound groups 200, scope items 50.

### 1.2 Wat is gebouwd (Nederlands)

- **Platform**: 14 nieuwe variabelen met kruisregels; migratie `0001_phase_b` (17 tabellen, 9 indexen, 29 triggers); audit-woordenschat; 53 foutcodes in Nederlands en Engels; vijf nieuwe modules.
- **Geheimen**: `APP_KEY` (of `APP_KEY_FILE`), versleutelde opslag van de certificaatsleutel, zelfondertekend RSA 2048-certificaat van 360 dagen, sleutelrotatie, een degraded-modus zonder sleutel, en de CLI-commando's `generate-app-key`, `hash-password`, `rotate-app-key`, `setup-token`, `setup-reopen` en `verify-audit`.
- **Microsoft-clients en één nep-tenant**: Graph, provisioning, Exchange (alleen een leesadapter) en identiteit; Entra, Graph en Exchange worden gesimuleerd door één nep-tenant met een zelftest.
- **Setup-wizard** in 5 stappen met setup-token, hervatbare uitvoering met live log, handmatige modus (checklist en `.cer`-download), bewijslijst V1 tot V6 en "verbinding herstellen" na afloop.
- **Aanmelden**: Entra-aanmelding met server-side sessie, MFA-controle op `amr`, step-up, uitloggen en overal uitloggen, 45 aanmeldscenario's.
- **RBAC**: vijf ingebouwde rollen en het sjabloon *Bestuur*, toewijzingen aan gebruikers en groepen met scope en einddatum, centrale `authorize`, bescherming van de laatste Eigenaar, "Mijn toegang", standaard geweigerd.
- **Break-glass** (noodtoegang): optioneel lokaal account dat alleen een Eigenaar kan herstellen.
- **Niet gebouwd (bewust)**: scherm voor gebruikers en groepen, verdeellijsten, contacten en CSV, beheerscherm voor RBAC, auditscherm, OpenTelemetry, Bicep, elk schrijfpad naar Exchange, en zelfvernieuwing van het certificaat (fase D).
- **Afwijkingen van de opdracht**: vier in plaats van vijf Graph-rechten; certificaat van 360 dagen; de wizard sluit bij de eerste aanmelding van de Eigenaar; step-up zonder `max_age`; handmatige modus; scopes per objecttype; geweigerde leesacties worden vastgelegd.

---

## 2. Test results / Testresultaten

### 2.1 What ran locally (2026-10-12, HEAD `e27ddf5`, Node v22.22.0) / Lokaal uitgevoerd

| Check | Result |
|---|---|
| `pnpm lint` | green |
| `pnpm typecheck` | green |
| `pnpm test` | green: shared 45 files / 3,532 tests; web 63 / 1,740; server 185 / 8,179; tools 15 / 1,113 (1 skipped); e2e unit 165 |
| `pnpm build`, `schema:check`, `routes:check`, `i18n:check`, `tokens:check`, `bundle:check` | green (initial JS 244,665 B gzip) |
| `python3 -m unittest discover -s scripts` | 223 tests OK |
| `docker compose config -q` | exit 0 |
| `pnpm docs:check`, `pnpm test:tools` | green (see GB8) |
| `pnpm format:check` | **red**: 100 files differ from Prettier 3.9.10 (formatting only); `pnpm format` fixes it and must be committed before CI's format step can pass |

Included in the server and shared numbers: the 45 sign-in fixtures (`auth/callback.test.ts`), the migration tests (59 assertions and the 29-of-29 trigger mutation test in `migrations.phase-b.test.ts`), the RBAC property tests, the last-Owner concurrency test with worker processes, the idempotency and crash-resume cases of the setup runner, and the policy matrix (15 permissions by actor kinds). The exact repetition counts (20,000 seeded cases per property test, 100 repetitions of the concurrency test) were not measured separately: UNVERIFIED.

The last local e2e run recorded `passed` (`e2e/test-results/.last-run.json`; its scope was not recorded).

### 2.2 Only on GitHub, or not yet run / Alleen op GitHub of nog niet gedraaid

CI run on the pull request in progress. Pending: `pnpm e2e` (all projects), the **visual baselines** (copied from the CI artefact by the orchestrator; none were generated here), `pnpm lighthouse`, `pnpm image:smoke`, `docker build`, `pnpm audit`, actionlint, arm64, cosign, SLSA, CodeQL, Trivy.

Lighthouse: the harness has three groups (`a-public`, `b-setup`, `a-owner`). In the sandbox the **mobile `/setup` LCP was 4.5 s**, which fails the G4 gate (target 2.0 s; default-instance gate 4,114 ms) and needs CI confirmation and an owner decision. The `a-owner` group (signed-in pages) is **report-only**. Best-of-3 is used for the timing metrics only.

### 2.3 Simulated, and the assumptions the simulation encodes / Gesimuleerd

The fake tenant encodes our reading of Microsoft Learn: a client assertion without `x5t#S256` is refused, assertion `exp` and `jti` rules, a `PATCH` of `keyCredentials` replaces the list, new objects replicate with a delay, a token carries a snapshot of the roles, an `Origin` header on the token request is refused, device-code polling errors, and a tolerant reading of the Admin API envelope. These are U21, U47, U58 to U62 and U45. **A passing test therefore proves our code against our reading, not Microsoft's behaviour.**

### 2.4 Could not be tested here / Niet testbaar

Any real tenant (OV-01 to OV-23 below), securityheaders.com, Mozilla Observatory, screen readers, browsers other than Chromium.

---

## 3. Step list to try it yourself / Stappenlijst voor de eigenaar

Commands were copied from `docs/operations.md`, `.env.example`, `docker-compose.yml` and the CLI source (`apps/server/src/cli.ts`). They were **not rehearsed** in a container (T-B-481 is open): where a command is unrehearsed it is correct to the source, not proven in a run. Steps that need Microsoft are **owner only**. Use a test tenant, never production.

### 3.1 English

**A. Before you start**

1. Accounts in a Microsoft 365 **test** tenant: **G**, a Global Administrator (becomes the first Owner); **H**, a second Global Administrator who never gets a panel role (OV-15); **U**, a licensed user without admin role; **R**, a licensed user for the role *Reader* (Dutch *Lezer*); **S**, an Entra security group with R as member.
2. Decide the address you type in the browser: `http://localhost:9300` (default) or an https address. `PUBLIC_BASE_URL` must be https, or exactly `http://localhost[:port]`, and **must equal the browser address**; every write is compared with it (otherwise `403 origin_not_allowed`).
3. Image: `ghcr.io/flux76hq/m365portal` after the first publish run; until then build it: `docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .` (add `--network host` where bridge networking is absent). Below `$IMAGE` is that name.
4. Generate the key and store it: `mkdir -p secrets && docker run --rm -i $IMAGE dist/cli.js generate-app-key > secrets/app_key`. Keep a copy in a password manager **separate from any backup of the data volume**. Without it the sealed certificate key cannot be opened; the only recovery is a new certificate through the repair flow by an administrator.

**B. Start and unlock (OV-23)**

5. Start (default port 9300):
   `docker run -d --name m365portal -p 9300:9300 -v m365:/data --stop-timeout 15 -e APP_KEY="$(cat secrets/app_key)" -e PUBLIC_BASE_URL=http://localhost:9300 $IMAGE`
   Variants: another host port `-p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090`; another container port `-p 9090:9090 -e PORT=9090 -e PUBLIC_BASE_URL=http://localhost:9090`. Key from a file instead of `APP_KEY`: `-v "$PWD/secrets/app_key:/run/secrets/app_key:ro" -e APP_KEY_FILE=/run/secrets/app_key` (if the container cannot read the file, check its permissions for uid 65532: UNVERIFIED). Compose: `cp .env.example .env`, set `HOST_PORT` (and `PORT`) in `.env`, keep `secrets/app_key`, run `docker compose up -d`; `PUBLIC_BASE_URL` then defaults to `http://localhost:${HOST_PORT}`. https behind a proxy: `PUBLIC_BASE_URL=https://<host>`, `TRUST_PROXY` as `docs/operations.md` says, the proxy keeps the `Host` header, forwards cookies and allows bodies of at least 9,437,184 bytes. Behind an outbound proxy: `NODE_USE_ENV_PROXY=1` (UNVERIFIED, U41): record whether it worked.
6. `docker logs m365portal`: one start line with the posture (setup state, secrets state, break-glass, MFA policy), no token. The setup token is written to `/data/setup-token` (mode 0600, never logged). Print it: `docker exec m365portal /nodejs/bin/node dist/cli.js setup-token` (Compose: `docker compose exec m365portal /nodejs/bin/node dist/cli.js setup-token`). Alternatively set `SETUP_TOKEN` (24 to 128 characters) before the first start.
7. Open `http://localhost:9300/setup` and enter the token ("Unlock"). Step 1 "Environment" shows six checks: `public_base_url`, `data_dir`, `app_key`, `node_version`, `network`, `time_skew`. The first three must be ok, `network` must reach `login.microsoftonline.com` and `graph.microsoft.com`, `time_skew` should be ok. Write down every warning and its remedy (OV-23). *Owner only for the network check.*

**C. The wizard (OV-01 to OV-06, OV-19 to OV-21)**

8. Step 2 "Connect to Microsoft": enter your tenant id or domain, press "Sign in with Microsoft". Note the **host of the verification link** (OV-01; expected `login.microsoft.com`). Open it and sign in as G. The consent screen must list exactly three permissions: `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`. Leave "Consent on behalf of your organization" **off**. The device code is shown on screen: never put it in a screenshot you send.
9. If Conditional Access blocks the device-code flow (error `AADSTS53003`) the panel names Conditional Access and offers manual mode: follow its checklist, download the `.cer` (generated on the first request), run "Check" and expect V1 to V3 and V5 ok, V4 and V6 `not_checked` (OV-02, OV-21). Do not try another client id.
10. Step 3 "Configure" runs by itself (application, service principal, certificate, application settings, Graph permissions, Exchange permissions, Exchange role). Keep the tab open and watch the live log. Lines "waiting for Microsoft to replicate" are expected; **write down the time between the role assignment and the first success** (OV-05, OV-06). If the Exchange check ends as a warning (`exchange_not_ready`) press "Try again now" later; record how many minutes it took.
11. Step 4 "Verify" shows the proof list. Record V1 to V6. V1 failing with `AADSTS700027` is the OV-04 case: send the evidence (the fix is a one-line change in a new build). A tenant without Exchange Online must show the two Exchange sub-actions as skipped plus a warning (OV-20), or write "not tested".
12. Step 5 "Finish": language, optionally search a group for the role *Administrator* by its first letters (OV-19: names only; group properties are not shown in Phase B), optionally branding, press "Finish". The state is `awaiting_first_signin`; `/setup` still needs the token.

**D. Check in the Entra admin center** (https://entra.microsoft.com, as G; Learn: https://learn.microsoft.com/entra/identity-platform/how-to-add-redirect-uri, https://learn.microsoft.com/entra/identity-platform/optional-claims, https://learn.microsoft.com/entra/identity/enterprise-apps/manage-application-permissions, https://learn.microsoft.com/entra/identity/role-based-access-control/view-assignments)

13. **Entra ID > App registrations > All applications**, the name you chose (default `M365Portal`). Overview: Application (client) ID and Directory (tenant) ID equal Settings, Connection in the panel. Properties/manifest: tags `m365portal` and `m365portal-install-<32 hex>` (OV-03, U49). **Authentication**: on the Web platform exactly two redirect URIs, https `<origin>/auth/callback` and `<origin>/auth/logged-out`, or for localhost `http://localhost/auth/callback` and `http://localhost/auth/logged-out` **without a port**; implicit-grant and hybrid-flow boxes unchecked; no front-channel logout URL. **Certificates & secrets**: one certificate named `M365Portal <first 8 hex of the thumbprint>`, thumbprint equal to the panel's SHA-1, expiry about 360 days away; no client secret. **API permissions**: Microsoft Graph application permissions `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; Office 365 Exchange Online `Exchange.ManageAsApp` (and `Exchange.ManageAsAppV2` if exposed); none with `Directory`, `RoleManagement`, `AppRoleAssignment` or `Application.ReadWrite` in the name. Whether the status column says "Granted for <tenant>" for grants made through the API is UNVERIFIED: cross-check step 14. **Token configuration**: optional claims `amr` and `auth_time` on the ID token. **Owners** (application and service principal): note who owns it and whether a second certificate or secret exists; the proof list must show the same counts and no `foreign_credential_present` (OV-03, U50).
14. **Enterprise apps > the same name > Permissions** (admin consent): the same permissions granted. **Properties**: "Assignment required" is No.
15. **Roles & admins > Exchange Administrator > Assignments**: the application is listed with directory scope and holds no other role (OV-05).
16. **Enterprise apps > "Microsoft Graph Command Line Tools" > Permissions > User consent**: the per-user consent left by the bootstrap sign-in. Learn states that user consent cannot be revoked in the portal; record whether you want it removed (the finish page says where to review it).

**E. Check in Exchange**

17. Panel: Settings, Connection, proof list, check V5 (Admin API `Get-OrganizationConfig`): ok or a warning with text (OV-06).
18. Exchange admin center (https://admin.exchange.microsoft.com) > Permissions > Admin roles > "Organization Management" > Assigned: look for the application. Whether a service principal that holds the role through Entra is listed is **not stated on Learn (UNVERIFIED)**: record what you see. Optionally in Exchange Online PowerShell `Get-ServicePrincipal` (UNVERIFIED whether the app appears).

**F. First sign-in, lock, restart (OV-07, OV-09, OV-14, OV-18)**

19. Press "Sign in with Microsoft" on `/signin` and sign in as G with your normal MFA. Expected: a short blank refresh page (not an error), then the panel with your initials. Open `http://localhost:9300/api/v1/me` in the same browser: `actor.kind` is `user`, `roles` contains `owner`, `session.mfa` is `true`, no token anywhere. Repeat with each MFA method you have (Authenticator push, TOTP, FIDO2/passkey, Windows Hello for Business, Temporary Access Pass) and write down which the panel accepts (OV-07). To see real ID-token claims decode a token **locally** from your own tooling; never paste a token into an online decoder or send it.
20. `/setup` is now a 404 page; `curl -i http://localhost:9300/api/v1/setup/status` is a 404 problem identical to an unknown path.
21. Browsers (OV-14): repeat step 19 and sign-out in Chrome, Firefox and Safari, on https and on `http://localhost:<port>`; the persona must show on the first paint; open a panel link from another site or an e-mail (a skeleton for a moment is fine); the console must show no CSP violation.
22. Sign out from the persona menu (OV-09): you pass `/auth/logged-out` and land on `/signin?signedout=1`; note whether Microsoft asks which account to sign out. "Sign out everywhere" ends your other browser sessions.
23. Restart (OV-18): `docker restart m365portal`: `/setup` stays 404, sign-in works, Connection shows the same thumbprint. Then run the container once **without** the key on the same volume (`docker rm -f m365portal`, repeat step 5 without `-e APP_KEY`): `curl -i http://localhost:9300/readyz` answers 503 with check `secrets`, the sign-in page explains cause and remedy, `curl http://localhost:9300/healthz` stays 200. Start again with the key.

**G. Roles, groups, access (OV-08, OV-11, OV-12, OV-15, OV-16).** The assignment screens are Phase D; use the browser console on the panel origin.

24. **OV-15**: sign in as H (no panel role): the "no access" page with a reference id and no session; note the id.
25. Step-up: as G open `http://localhost:9300/auth/login?purpose=stepup&returnTo=/settings/access` and sign in again. In the console: `const {token} = await (await fetch('/api/v1/csrf')).json(); const post = (b) => fetch('/api/v1/rbac/assignments', {method:'POST', headers:{'content-type':'application/json','x-csrf-token':token}, body: JSON.stringify(b)}).then(async r => [r.status, await r.json()]);` then `await post({principalType:'user', principalId:'<object id of R>', role:'reader'})` and `await post({principalType:'group', principalId:'<object id of S>', role:'helpdesk'})`. Role keys: `owner`, `admin`, `operator`, `helpdesk`, `reader`; a scope: `scope:[{target:'group', match:{by:'id', id:'<group id>'}}]`. Expect 201.
26. Sign in as R: Settings shows no Connection entry; the same `post(...)` answers 403 `permission_denied` even with a valid CSRF token. "My access" (Settings, Access) lists the roles with origin direct or via a group.
27. **Last Owner**: as G `fetch('/api/v1/rbac/assignments')` lists assignments; deleting your own Owner assignment (`DELETE /api/v1/rbac/assignments/<id>` with the CSRF header, after step-up) must answer 409 `last_owner_protected`.
28. **OV-16**: remove R from S in Entra at a noted time; reload a panel page as R; the group-derived rights must vanish at the first request after `GROUP_CACHE_TTL_SECONDS` (300 s) or later if Graph lags: record the delay. Delete a bound group: the others still resolve (the list shows it as `unresolvable`).
29. **OV-08** (if you can build it): a user in more than 200 groups, or a group nested in the bound group. **OV-11**: in a tenant with Security Defaults sign in as a non-administrator: accepted, or `mfa_required`/`amr_missing`? (`AUTH_REQUIRE_MFA=false` is the documented switch.) **OV-12**: with user consent disabled the first sign-in of R may end in a consent page: note the message and whether the administrator-consent link works.

**H. Break-glass (OV-17)**

30. `docker run --rm -it $IMAGE dist/cli.js hash-password` (type a password of at least 14 characters with at least 6 distinct characters; it prints an `scrypt:131072:8:1:...` line; use `-it`, without a terminal the input would echo). Recreate the container with `-e BREAK_GLASS_USERNAME=<name> -e BREAK_GLASS_PASSWORD_HASH='<line>'` (Compose: the same names in `.env`). Open `http://localhost:9300/break-glass`, "Sign in with break-glass access": a red banner on every page, the session ends after 30 minutes, every write is refused except "Restore the Owner" (enter a user object id). Six wrong passwords inside 15 minutes lock the route. Restrict `/api/v1/auth/break-glass` by address at your proxy.

**I. Repair, throttling (OV-10, OV-22)**

31. **OV-22**: in Entra remove one granted permission (Enterprise apps, Permissions) and change one redirect URI; in the panel, Settings, Connection: "Repair the connection" (step-up and a fresh device sign-in): only drifted parts change; App registrations and Enterprise apps each still show exactly one application. **OV-10**: throttling cannot be forced; keep the log lines if a 429 occurs.

**J. Optional experiment, not part of the panel (OV-13)**

32. For the Exchange write-path decision (ODB-01, ODB-03): with a **throwaway** app registration, certificate and Exchange Administrator assignment made by hand per https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2 run `Connect-ExchangeOnline` as that application, then `Get-DistributionGroup -ResultSize 1`, `Add-DistributionGroupMember` and `Remove-DistributionGroupMember` on a test list, and repeat with Exchange Recipient Administrator; write down which role suffices. Never export the panel's own key.

**K. What to send back if something fails (and what never to send)**

33. Send the checklist of part 3.3 (one line per OV: pass, fail or not tested, date, one sentence). For each failure: the step number, the exact on-screen text, the request id (the `ref` on the no-access page or the `X-Request-Id` response header), `docker logs --since 30m m365portal` (JSON lines; tested to hold no secret, but skim them), a copy of the Settings, Connection proof list, the version from `curl http://localhost:9300/healthz`, and the audit rows: `docker stop m365portal`, `docker cp m365portal:/data ./data-copy`, `docker start m365portal`, then `sqlite3 data-copy/m365portal.sqlite "select seq, ts, actor_kind, action, outcome, reason_code, request_id from audit_log order by seq desc limit 30;"` (leave out the actor and address columns: personal data). `docker exec m365portal /nodejs/bin/node dist/cli.js verify-audit` prints one JSON line and tells whether the chain is intact. **Never send**: `APP_KEY`, the setup token, the break-glass password or hash, the data volume or `data-copy` (they hold the sealed key and personal data), cookies, tokens, a screenshot showing a device code, a private key. The public `.cer` is harmless.

**Failure guide** (send the code, not the secret)

| Symptom | Code or log | Meaning and what to do |
|---|---|---|
| `403` on a write | `origin_not_allowed` | Browser address differs from `PUBLIC_BASE_URL`; fix one and restart. |
| Start refuses or `/readyz` 503 | `app_key_missing`, `app_key_invalid`, check `secrets`; `data_dir_not_writable` | Key missing or malformed; data volume owned by uid 65532. |
| Step 1 | `network_unreachable`, `time_skew_excessive` | Outbound proxy or host clock (more than a few minutes off). |
| Step 2 | `device_code_blocked` (`AADSTS53003`), `consent_required`, `admin_approval_required`, `bootstrap_role_insufficient`, `tenant_mismatch`, `device_code_expired` | Conditional Access: use manual mode. Account lacks a role or consent. Wrong tenant. Start again. |
| Step 3 | `replication_timeout`, `application_adoption_required`, `application_untrusted`, `policy_refused`, `forbidden_permission_present`, `exchange_service_principal_missing`, `graph_error` | Wait and press "Try again now"; an existing application needs your acknowledgement (ODB-18); a tenant policy refused the credential; no Exchange Online. |
| Step 4 | V1 `AADSTS700027` / `thumbprint_mismatch`; `organization_mismatch`; `users_unreadable`; `exchange_not_ready`; `optional_claim_missing`; `foreign_credential_present`; `drift_detected` | V1: send evidence (OV-04). Others: read the remedy text, press repair, send the code. |
| Sign-in page | `/signin?error=` `mfa_required`, `amr_missing`, `stepup_failed`, `conditional_access_blocked`, `secrets_unavailable`, `setup_required`, `session_expired`, `cookies_missing_or_expired`, `access_denied` | See the page text; `mfa_required` and `amr_missing` tell which tenant setting is missing. |
| API | `permission_denied`, `step_up_required`, `last_owner_protected` | By design. |

**Rollback: remove everything the wizard created in the tenant.** There is no automatic rollback; the wizard shows hints per object ("If you abandon the setup").

1. Entra admin center > App registrations: delete the application (name and object id are on Settings, Connection). Then check **Enterprise applications** for a leftover service principal with the same name and delete it; it also removes its permission grants and its Exchange Administrator assignment. Check Roles & admins > Exchange Administrator > Assignments is clean. Optionally App registrations > Deleted applications to remove it for good (Entra keeps deleted applications for a period).
2. If you want the consent of the bootstrap client removed: Enterprise apps > "Microsoft Graph Command Line Tools" > Permissions; user consent cannot be revoked in the portal (Learn); use Microsoft Graph or PowerShell for it, not the panel.
3. Locally: `docker rm -f m365portal`, `docker volume rm m365` (Compose: `docker compose down -v`), delete `secrets/app_key` and `data-copy`. Starting again gives an `unconfigured` panel.

### 3.2 Nederlands

**A. Voor je begint**

1. Accounts in een Microsoft 365-**testtenant**: **G**, Global Administrator (wordt de eerste Eigenaar); **H**, een tweede Global Administrator die nooit een paneelrol krijgt (OV-15); **U**, een gebruiker met licentie zonder beheerrol; **R**, een gebruiker met licentie voor de rol *Lezer*; **S**, een Entra-beveiligingsgroep met R als lid.
2. Kies het adres dat je in de browser typt: `http://localhost:9300` (standaard) of een https-adres. `PUBLIC_BASE_URL` is https, of precies `http://localhost[:poort]`, en **moet gelijk zijn aan het browseradres**; elke schrijfactie wordt ermee vergeleken (anders `403 origin_not_allowed`).
3. Image: `ghcr.io/flux76hq/m365portal` na de eerste publicatie; tot dan zelf bouwen: `docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .` (met `--network host` zonder bridge-netwerk). Hieronder is `$IMAGE` die naam.
4. Maak de sleutel: `mkdir -p secrets && docker run --rm -i $IMAGE dist/cli.js generate-app-key > secrets/app_key`. Bewaar een kopie in een wachtwoordkluis, **los van elke back-up van het datavolume**. Zonder sleutel is de versleutelde certificaatsleutel onleesbaar; herstel kan alleen met een nieuw certificaat via de herstelactie door een beheerder.

**B. Starten en ontgrendelen (OV-23)**

5. Start (standaardpoort 9300): `docker run -d --name m365portal -p 9300:9300 -v m365:/data --stop-timeout 15 -e APP_KEY="$(cat secrets/app_key)" -e PUBLIC_BASE_URL=http://localhost:9300 $IMAGE`. Varianten: andere hostpoort `-p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090`; andere containerpoort `-p 9090:9090 -e PORT=9090 -e PUBLIC_BASE_URL=http://localhost:9090`. Sleutel uit een bestand: `-v "$PWD/secrets/app_key:/run/secrets/app_key:ro" -e APP_KEY_FILE=/run/secrets/app_key` (kan de container het bestand niet lezen, controleer de rechten voor uid 65532: ONGEVERIFIEERD). Compose: `cp .env.example .env`, zet `HOST_PORT` (en `PORT`) in `.env`, bewaar `secrets/app_key`, `docker compose up -d`; `PUBLIC_BASE_URL` wordt dan `http://localhost:${HOST_PORT}`. https achter een proxy: `PUBLIC_BASE_URL=https://<host>`, `TRUST_PROXY` zoals `docs/operations.md`, de proxy behoudt de `Host`-header, geeft cookies door en staat bodies van minstens 9.437.184 bytes toe. Achter een uitgaande proxy: `NODE_USE_ENV_PROXY=1` (ONGEVERIFIEERD, U41): noteer of het werkte.
6. `docker logs m365portal`: één startregel met de houding (setup-status, geheimenstatus, break-glass, MFA-beleid), geen token. Het setup-token staat in `/data/setup-token` (modus 0600, nooit gelogd). Toon het: `docker exec m365portal /nodejs/bin/node dist/cli.js setup-token` (Compose: `docker compose exec m365portal /nodejs/bin/node dist/cli.js setup-token`). Of stel `SETUP_TOKEN` (24 tot 128 tekens) in vóór de eerste start.
7. Open `http://localhost:9300/setup` en voer het token in ("Ontgrendelen"). Stap 1 "Omgeving" toont zes controles: `public_base_url`, `data_dir`, `app_key`, `node_version`, `network`, `time_skew`. De eerste drie moeten ok zijn, `network` moet `login.microsoftonline.com` en `graph.microsoft.com` bereiken, `time_skew` hoort ok te zijn. Noteer elke waarschuwing en de oplossingstekst (OV-23). *Netwerkcontrole: alleen eigenaar.*

**C. De wizard (OV-01 tot OV-06, OV-19 tot OV-21)**

8. Stap 2 "Verbinden met Microsoft": vul je tenant-id of domein in, kies "Aanmelden met Microsoft". Noteer de **host van de verificatielink** (OV-01; verwacht `login.microsoft.com`). Open die en meld je aan als G. Het toestemmingsscherm toont precies drie rechten: `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`. Laat "Toestemming namens uw organisatie" **uit**. De apparaatcode staat op het scherm: zet die nooit in een screenshot die je verstuurt.
9. Blokkeert Conditional Access de device-code-aanmelding (`AADSTS53003`), dan noemt het paneel Conditional Access en biedt de handmatige modus: volg de checklist, download de `.cer` (gemaakt bij het eerste verzoek), kies "Controleren" en verwacht V1 tot V3 en V5 ok en V4 en V6 `not_checked` (OV-02, OV-21). Probeer geen andere client-id.
10. Stap 3 "Configureren" loopt vanzelf (applicatie, service principal, certificaat, applicatie-instellingen, Graph-rechten, Exchange-rechten, Exchange-rol). Houd het tabblad open en volg het live log. Regels "wachten tot Microsoft het doorvoert" zijn normaal; **noteer de tijd tussen de roltoewijzing en het eerste succes** (OV-05, OV-06). Eindigt de Exchange-controle als waarschuwing (`exchange_not_ready`), kies later "Nu opnieuw proberen" en noteer hoeveel minuten het duurde.
11. Stap 4 "Controleren" toont de bewijslijst. Noteer V1 tot V6. V1 met `AADSTS700027` is het geval van OV-04: stuur het bewijs (de oplossing is één regel in een nieuwe build). Een tenant zonder Exchange Online moet de twee Exchange-onderdelen als overgeslagen tonen plus een waarschuwing (OV-20), of schrijf "niet getest".
12. Stap 5 "Afronden": taal, eventueel een groep zoeken voor de rol *Beheerder* op de eerste letters (OV-19: alleen namen; groepseigenschappen zijn in fase B niet zichtbaar), eventueel huisstijl, kies "Voltooien". De status is `awaiting_first_signin`; `/setup` vraagt nog het token.

**D. Controleren in het Entra-beheercentrum** (https://entra.microsoft.com, als G)

13. **Entra ID > App-registraties > Alle toepassingen**, de naam die je koos (standaard `M365Portal`). Overzicht: Application (client) ID en Directory (tenant) ID gelijk aan Instellingen, Verbinding in het paneel. Tags `m365portal` en `m365portal-install-<32 hex>` (OV-03, U49). **Verificatie**: bij het platform Web precies twee omleidings-URI's, https `<origin>/auth/callback` en `<origin>/auth/logged-out`, of voor localhost `http://localhost/auth/callback` en `http://localhost/auth/logged-out` **zonder poort**; impliciete en hybride stroom uit; geen front-channel-afmeldings-URL. **Certificaten en geheimen**: één certificaat `M365Portal <eerste 8 hex van de vingerafdruk>`, vingerafdruk (SHA-1) gelijk aan het paneel, verloopt over ongeveer 360 dagen; geen clientgeheim. **API-machtigingen**: Microsoft Graph-toepassingsmachtigingen `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; Office 365 Exchange Online `Exchange.ManageAsApp` (en `Exchange.ManageAsAppV2` als beschikbaar); geen machtiging met `Directory`, `RoleManagement`, `AppRoleAssignment` of `Application.ReadWrite` in de naam. Of de statuskolom "Toestemming verleend voor <tenant>" toont voor via de API verleende rechten is ONGEVERIFIEERD: controleer stap 14. **Tokenconfiguratie**: optionele claims `amr` en `auth_time` op het ID-token. **Eigenaren** (applicatie en service principal): noteer wie eigenaar is en of er een tweede certificaat of geheim staat; de bewijslijst moet dezelfde aantallen tonen en geen `foreign_credential_present` (OV-03, U50).
14. **Bedrijfstoepassingen > dezelfde naam > Machtigingen** (beheerderstoestemming): dezelfde rechten verleend. **Eigenschappen**: "Toewijzing vereist" staat op Nee.
15. **Rollen en beheerders > Exchange-beheerder > Toewijzingen**: de applicatie staat er met directory-scope en heeft geen andere rol (OV-05).
16. **Bedrijfstoepassingen > "Microsoft Graph Command Line Tools" > Machtigingen > Gebruikerstoestemming**: de toestemming die de bootstrap-aanmelding achterliet. Volgens Learn kan gebruikerstoestemming niet in het portaal worden ingetrokken; noteer of je die weg wilt (de afrondpagina zegt waar je dit bekijkt).

**E. Controleren in Exchange**

17. Paneel: Instellingen, Verbinding, bewijslijst, controle V5 (Admin API `Get-OrganizationConfig`): ok of een waarschuwing met tekst (OV-06).
18. Exchange-beheercentrum (https://admin.exchange.microsoft.com) > Machtigingen > Beheerdersrollen > "Organization Management" > Toegewezen: zoek de applicatie. Of een service principal die de rol via Entra heeft hier staat, is **niet vermeld op Learn (ONGEVERIFIEERD)**: noteer wat je ziet. Optioneel `Get-ServicePrincipal` in Exchange Online PowerShell (ONGEVERIFIEERD of de app verschijnt).

**F. Eerste aanmelding, vergrendeling, herstart (OV-07, OV-09, OV-14, OV-18)**

19. Kies "Aanmelden met Microsoft" op `/signin` en meld je aan als G met je gewone MFA. Verwacht: een korte lege verversingspagina (geen fout), daarna het paneel met je initialen. Open `http://localhost:9300/api/v1/me` in dezelfde browser: `actor.kind` is `user`, `roles` bevat `owner`, `session.mfa` is `true`, nergens een token. Herhaal met elke MFA-methode die je hebt (Authenticator-melding, TOTP, FIDO2/passkey, Windows Hello for Business, Temporary Access Pass) en noteer welke het paneel accepteert (OV-07). Wil je de echte ID-tokenclaims zien, decodeer dan **lokaal** een token uit je eigen tooling; plak nooit een token in een online decoder en stuur het niet op.
20. `/setup` is nu een 404-pagina; `curl -i http://localhost:9300/api/v1/setup/status` geeft een 404-probleem gelijk aan een onbekend pad.
21. Browsers (OV-14): herhaal stap 19 en het uitloggen in Chrome, Firefox en Safari, op https en op `http://localhost:<poort>`; de persona staat bij de eerste weergave; open een paneellink vanaf een andere site of een e-mail (even een skeleton is goed); de console toont geen CSP-schending.
22. Log uit via het persona-menu (OV-09): je passeert `/auth/logged-out` en komt op `/signin?signedout=1`; noteer of Microsoft vraagt welk account uitlogt. "Overal uitloggen" beëindigt je andere browsersessies.
23. Herstart (OV-18): `docker restart m365portal`: `/setup` blijft 404, aanmelden werkt, Verbinding toont dezelfde vingerafdruk. Start daarna één keer **zonder** sleutel op hetzelfde volume (`docker rm -f m365portal`, herhaal stap 5 zonder `-e APP_KEY`): `curl -i http://localhost:9300/readyz` geeft 503 met controle `secrets`, de aanmeldpagina legt oorzaak en oplossing uit, `curl http://localhost:9300/healthz` blijft 200. Start weer met de sleutel.

**G. Rollen, groepen, toegang (OV-08, OV-11, OV-12, OV-15, OV-16).** De toewijsschermen zijn fase D; gebruik de browserconsole op de paneel-origin.

24. **OV-15**: meld je aan als H (geen paneelrol): de pagina "Geen toegang tot het paneel" met een referentie-id en geen sessie; noteer het id.
25. Step-up: open als G `http://localhost:9300/auth/login?purpose=stepup&returnTo=/settings/access` en meld je opnieuw aan. In de console: `const {token} = await (await fetch('/api/v1/csrf')).json(); const post = (b) => fetch('/api/v1/rbac/assignments', {method:'POST', headers:{'content-type':'application/json','x-csrf-token':token}, body: JSON.stringify(b)}).then(async r => [r.status, await r.json()]);` daarna `await post({principalType:'user', principalId:'<object-id van R>', role:'reader'})` en `await post({principalType:'group', principalId:'<object-id van S>', role:'helpdesk'})`. Rolsleutels: `owner`, `admin`, `operator`, `helpdesk`, `reader`; een scope: `scope:[{target:'group', match:{by:'id', id:'<groep-id>'}}]`. Verwacht 201.
26. Meld je aan als R: Instellingen toont geen Verbinding; dezelfde `post(...)` geeft 403 `permission_denied`, ook met geldig CSRF-token. "Mijn toegang" (Instellingen, Toegang) toont de rollen met herkomst direct of via een groep.
27. **Laatste Eigenaar**: als G toont `fetch('/api/v1/rbac/assignments')` de toewijzingen; je eigen Eigenaar-toewijzing verwijderen (`DELETE /api/v1/rbac/assignments/<id>` met CSRF-header, na step-up) moet 409 `last_owner_protected` geven.
28. **OV-16**: verwijder R op een genoteerd tijdstip uit S in Entra; ververs een paneelpagina als R; de via de groep verkregen rechten verdwijnen bij het eerste verzoek na `GROUP_CACHE_TTL_SECONDS` (300 s), of later als Graph achterloopt: noteer de vertraging. Verwijder een gekoppelde groep: de andere groepen blijven werken (de lijst toont hem als `unresolvable`).
29. **OV-08** (als je het kunt opzetten): een gebruiker in meer dan 200 groepen, of een groep genest in de gekoppelde groep. **OV-11**: meld je in een tenant met Security Defaults aan als niet-beheerder: geaccepteerd, of `mfa_required`/`amr_missing`? (`AUTH_REQUIRE_MFA=false` is de gedocumenteerde schakelaar.) **OV-12**: met uitgeschakelde gebruikerstoestemming kan de eerste aanmelding van R op een toestemmingspagina eindigen: noteer de melding en of de beheerderstoestemmingslink werkt.

**H. Break-glass / noodtoegang (OV-17)**

30. `docker run --rm -it $IMAGE dist/cli.js hash-password` (typ een wachtwoord van minstens 14 tekens met minstens 6 verschillende tekens; het geeft een regel `scrypt:131072:8:1:...`; gebruik `-it`, zonder terminal wordt de invoer getoond). Maak de container opnieuw met `-e BREAK_GLASS_USERNAME=<naam> -e BREAK_GLASS_PASSWORD_HASH='<regel>'` (Compose: dezelfde namen in `.env`). Open `http://localhost:9300/break-glass`, "Aanmelden met noodtoegang": een rode balk op elke pagina, de sessie eindigt na 30 minuten, elke schrijfactie wordt geweigerd behalve "Eigenaar herstellen" (voer een gebruikers-object-id in). Zes foute wachtwoorden binnen 15 minuten vergrendelen de route. Beperk `/api/v1/auth/break-glass` per adres op je proxy.

**I. Herstel, throttling (OV-10, OV-22)**

31. **OV-22**: verwijder in Entra één verleend recht (Bedrijfstoepassingen, Machtigingen) en wijzig één omleidings-URI; in het paneel, Instellingen, Verbinding: "Verbinding herstellen" (step-up en een nieuwe apparaataanmelding): alleen afwijkende onderdelen veranderen; App-registraties en Bedrijfstoepassingen tonen elk nog precies één applicatie. **OV-10**: throttling is niet af te dwingen; bewaar de logregels als er een 429 komt.

**J. Optioneel experiment, geen onderdeel van het paneel (OV-13)**

32. Voor het besluit over het Exchange-schrijfpad (ODB-01, ODB-03): maak met de hand een **wegwerp**-appregistratie, certificaat en Exchange-beheerdertoewijzing volgens https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2, voer `Connect-ExchangeOnline` uit als die applicatie, daarna `Get-DistributionGroup -ResultSize 1`, `Add-DistributionGroupMember` en `Remove-DistributionGroupMember` op een testlijst, en herhaal met Exchange Recipient Administrator; noteer welke rol volstaat. Exporteer nooit de sleutel van het paneel zelf.

**K. Wat terugsturen bij een fout (en wat nooit)**

33. Stuur de checklist van 3.3 (één regel per OV: geslaagd, mislukt of niet getest, datum, één zin). Per fout: het stapnummer, de exacte schermtekst, het request-id (de `ref` op de pagina "Geen toegang" of de responsheader `X-Request-Id`), `docker logs --since 30m m365portal` (JSON-regels; getest op afwezigheid van geheimen, maar lees ze door), een kopie van de bewijslijst bij Instellingen, Verbinding, de versie uit `curl http://localhost:9300/healthz` en de auditregels: `docker stop m365portal`, `docker cp m365portal:/data ./data-copy`, `docker start m365portal`, daarna `sqlite3 data-copy/m365portal.sqlite "select seq, ts, actor_kind, action, outcome, reason_code, request_id from audit_log order by seq desc limit 30;"` (laat de kolommen met actor en adres weg: persoonsgegevens). `docker exec m365portal /nodejs/bin/node dist/cli.js verify-audit` geeft één JSON-regel en zegt of de keten intact is. **Stuur nooit**: `APP_KEY`, het setup-token, het break-glass-wachtwoord of de hash, het datavolume of `data-copy` (bevat de versleutelde sleutel en persoonsgegevens), cookies, tokens, een screenshot met een apparaatcode, een privésleutel. De publieke `.cer` is onschadelijk.

**Foutenwijzer**: zie de tabel bij de Engelse versie (de codes zijn dezelfde). Belangrijkste: `origin_not_allowed` = browseradres wijkt af van `PUBLIC_BASE_URL`; `app_key_missing` of controle `secrets` = sleutel ontbreekt of onleesbaar; `device_code_blocked` (`AADSTS53003`) = Conditional Access, gebruik de handmatige modus; `replication_timeout` = wacht en kies "Nu opnieuw proberen"; `mfa_required`/`amr_missing` = de tenant levert geen MFA-claim.

**Terugdraaien: verwijder alles wat de wizard in de tenant maakte.** Er is geen automatisch terugdraaien; de wizard toont per object een aanwijzing ("Als je de installatie afbreekt").

1. Entra-beheercentrum > App-registraties: verwijder de applicatie (naam en object-id staan bij Instellingen, Verbinding). Controleer daarna **Bedrijfstoepassingen** op een achtergebleven service principal met dezelfde naam en verwijder die; daarmee verdwijnen ook de verleende rechten en de Exchange-beheerdertoewijzing. Controleer Rollen en beheerders > Exchange-beheerder > Toewijzingen. Optioneel App-registraties > Verwijderde toepassingen om hem definitief te wissen.
2. Wil je de toestemming van de bootstrap-client verwijderen: Bedrijfstoepassingen > "Microsoft Graph Command Line Tools" > Machtigingen; gebruikerstoestemming is volgens Learn niet in het portaal in te trekken; gebruik Microsoft Graph of PowerShell, niet het paneel.
3. Lokaal: `docker rm -f m365portal`, `docker volume rm m365` (Compose: `docker compose down -v`), verwijder `secrets/app_key` en `data-copy`. Opnieuw starten geeft een `unconfigured` paneel.

### 3.3 Owner-verified ledger / Owner-verified-grootboek (OV-01 to OV-23)

Result: tick one box. "Not tested" is an allowed answer for OV-08, OV-12, OV-13 and OV-20 only. / Resultaat: één vakje. "Niet getest" mag alleen bij OV-08, OV-12, OV-13 en OV-20.

| OV | What only a real tenant proves / Wat alleen een echte tenant bewijst | Step | Pass | Fail | Not tested | Date and note |
|---|---|---|---|---|---|---|
| OV-01 | Device-code consent screen, the three scopes, the verification host / Toestemmingsscherm, de drie rechten, de host | 8 | [ ] | [ ] | [ ] | |
| OV-02 | Conditional Access device-code block and manual mode / Conditional Access-blokkade en handmatige modus | 9 | [ ] | [ ] | [ ] | |
| OV-03 | Graph accepts the application body, redirect URIs, optional claims, 360-day credential, tags; credential and owner counts readable (U47, U49, U50) / Graph accepteert de applicatie, tags, aantallen leesbaar | 13 | [ ] | [ ] | [ ] | |
| OV-04 | First client-credentials token with the self-signed certificate (`x5t#S256` only) / Eerste token met het zelfondertekende certificaat | 11 | [ ] | [ ] | [ ] | |
| OV-05 | The four application permissions are effective; propagation delay / Vier rechten werken; vertraging | 10, 15 | [ ] | [ ] | [ ] | |
| OV-06 | Exchange role propagation and the Admin API probe / Exchange-roldoorvoering en Admin API-probe | 10, 17, 18 | [ ] | [ ] | [ ] | |
| OV-07 | A real ID token: `amr` values, `tid`, `oid`, no `groups`, `auth_time`, `max_age` / Een echt ID-token | 19 | [ ] | [ ] | [ ] | |
| OV-08 | A user in more than 200 groups, nested groups / Gebruiker in meer dan 200 groepen | 29 | [ ] | [ ] | [ ] | |
| OV-09 | Sign-out round trip with the real end-session endpoint / Uitlogcyclus | 22 | [ ] | [ ] | [ ] | |
| OV-10 | Real throttling / Echte throttling | 31 | [ ] | [ ] | [ ] | |
| OV-11 | Security Defaults tenant and `amr` | 29 | [ ] | [ ] | [ ] | |
| OV-12 | Non-administrator with user consent disabled; the consent link / Gebruikerstoestemming uit; de link | 29 | [ ] | [ ] | [ ] | |
| OV-13 | Exchange write-path experiment (Recipient Administrator enough?) / Exchange-schrijfpadexperiment | 32 | [ ] | [ ] | [ ] | |
| OV-14 | Browsers and `SameSite` on https and `http://localhost` | 21 | [ ] | [ ] | [ ] | |
| OV-15 | Global Administrator without a panel role gets no session / Global Administrator zonder paneelrol krijgt geen sessie | 24 | [ ] | [ ] | [ ] | |
| OV-16 | Revocation timing of group-derived rights; deleted group / Intrekking van groepsrechten; verwijderde groep | 28 | [ ] | [ ] | [ ] | |
| OV-17 | Break-glass / Noodtoegang | 30 | [ ] | [ ] | [ ] | |
| OV-18 | Restart and lock; degraded without `APP_KEY` / Herstart en vergrendeling; degraded zonder sleutel | 23 | [ ] | [ ] | [ ] | |
| OV-19 | Group picker and group properties with only `GroupMember.Read.All` / Groepskiezer | 12 | [ ] | [ ] | [ ] | |
| OV-20 | Tenant without Exchange Online / Tenant zonder Exchange Online | 11 | [ ] | [ ] | [ ] | |
| OV-21 | Manual provisioning mode against the real tenant / Handmatige modus | 9 | [ ] | [ ] | [ ] | |
| OV-22 | Repair against drift / Herstel na afwijking | 31 | [ ] | [ ] | [ ] | |
| OV-23 | Environment checks on the owner's host / Omgevingscontroles op de host | 7 | [ ] | [ ] | [ ] | |

Automated prerequisites of each row are listed in `specs/002-phase-b/tasks.md` section 9.

---

## 4. Open points, assumptions and risks / Open punten, aannames en risico's

Full registers: `docs/open-points.md` (section "Phase B"): UNVERIFIED claims U34 to U50 (U1 to U33 carried), the owner-verified ledger, assumptions B-01 to B-26, plan decisions PB-01 to PB-28, risks RB-01 to RB-18 and PBR-01 to PBR-14, "Decisions taken while building Phase B".

### 4.1 Not yet done in Phase B / Nog niet gedaan in fase B

1. **Visual baselines** (T-B-379): come from the CI artefact; none exist for the new states yet.
2. **CI green** for e2e (all projects), Lighthouse, `image:smoke`, `docker build`, `pnpm audit`, actionlint (GB7, GB9 "pending CI").
3. **Mobile `/setup` LCP 4.5 s** fails the G4 gate in the sandbox: CI confirmation and an owner decision (raise the gate or optimise the setup page). The `a-owner` Lighthouse group is report-only.
4. **Formatting**: `pnpm format:check` lists 100 files; run `pnpm format`, commit.
5. **Negative-control ledger** (T-B-395) and the **rehearsal** of the step list (T-B-481, with a measured time from `docker run` to the wizard) are not done; the "red once more" reruns of the gate negatives were not repeated. The bootstrap-lifetime negative exists only as a mutation run.
6. **Certificate renewal beyond repair** (planned step 7, `addKey` self-rotation) is not built (ODB-08, Phase D). Repair is not available in manual mode.
7. **No audit screen**: read the audit through `docker cp` and `sqlite3` and `verify-audit` (step 33). A small `audit-tail` CLI command is possible if wanted (finding of T-B-425).
8. **Group properties** (`groupTypes`, `mailEnabled`, `securityEnabled`) are not visible in the panel; a failure of U36 shows only in the owner test (OV-19).
9. **Exchange write path**: undecided (ODB-01; memo in spec Appendix A, recommendation A, not blocking). Optional experiment: step 32.
10. **U-register gap**: `docs/open-points.md` holds U1 to U50. U58 to U62 are used in code comments (fake tenant: assertion `exp` limit, `jti` replay, MSAL error property of the pinned version, Conditional Access seen while polling, error code for an `Origin` header) but are not registered; U51 to U57 and U63 to U65 are not present anywhere in the tree. They must be added or renumbered.
11. Gates GB7 and GB9 and the task boxes T-B-353, T-B-379, T-B-380, T-B-395, T-B-419, T-B-480, T-B-481, T-B-489 and T-B-999 stay open.

### 4.2 Documentation and code inconsistencies found / Gevonden inconsistenties

| # | Where | Finding |
|---|---|---|
| 1 | `docs/operations.md`, `README.md` (hash-password) | The command is shown with `-i` only; on a terminal `-it` is needed, otherwise the password echoes (the code hides input only on a TTY). |
| 2 | `docs/operations.md` and `tasks.md` text | The repair button reads "Verbinding herstellen" (nl) and the banner text "Repair the connection" (en); `tasks.md` says "Herstel verbinding". The break-glass restore button reads "Restore the Owner" (en). |
| 3 | `tasks.md` T-B-142 | Names `apps/server/src/setup/repair.ts`; repair is implemented as a run flavour in `setup/runner.ts` and `connection/routes.ts`. |
| 4 | `tasks.md` section 9 and tasks | Names `server/setup/lock.test.ts`, `replication-retry.test.ts`, `resume.test.ts`, `server/auth/client-assertion.test.ts`, `server/auth/jwks-cache.test.ts`, `e2e/preview-banner.spec.ts`; they live in `setup/gate.test.ts`, `setup/backoff.test.ts`, `setup/idempotency.test.ts`, `integrations/identity/*`, `preview-removed.spec.ts`. |
| 5 | `tasks.md` T-B-196 line 1137 and the API contract | Old route ids; the code uses lower case (SB-27). |
| 6 | `data-model.md`, `plan.md` vs code | Snapshot file `0001-phase-b.sql` vs `0001-phase_b.sql` in the tree; `GB0.md` also numbers T-B-002 to T-B-014 differently from `tasks.md` (content equal). |
| 7 | `tasks.md` T-B-350 | Names `deploy-e2e-docs.md`; the file is `phase-a-reread/deploy-docs.md`. |
| 8 | `docs/open-points.md` | See 4.1 item 10 (U51 to U65). |
| 9 | `.env.example` / Compose | A plain `docker run -p 9090:9300` leaves `PUBLIC_BASE_URL` at its default `http://localhost:<PORT>` (container port); it must be set by hand. Documented in the ports table, but not in the one-line `docker run`. |

### 4.3 Owner decisions ODB-01 to ODB-18 / Besluiten van de eigenaar

Each default is implemented, so nothing blocks. Detail: `docs/open-points.md`.

| ID | Decision | Default implemented | If overturned | Needed by |
|---|---|---|---|---|
| ODB-01 | Exchange write path | Undecided; interface and read adapter only; recommendation A (pwsh worker in the same container, Ubuntu LTS base) | Phase C scope and image base | After OV-13, before Phase C |
| ODB-02 | Graph permission set | Reduced four; write permission granted now | Five permissions, or grant later (repair run) | Owner test |
| ODB-03 | Exchange role and second app role | Exchange Administrator; both app roles | Narrower role after OV-13 | After OV-13 |
| ODB-04 | MFA switch | `AUTH_REQUIRE_MFA` operator switch, on | Always enforce for Owners | Owner test (OV-11) |
| ODB-05 | When the wizard locks | At the first Owner sign-in | At "Finish" | Phase B gate |
| ODB-06 | Break-glass in Phase B | Built now | Move to Phase D | Phase B gate |
| ODB-07 | Manual mode | Built now | Defer; device-code-blocked tenants cannot use the wizard | Phase B gate |
| ODB-08 | Certificate renewal | Repair in B, `addKey` in D | Repair only | Before the Phase D plan |
| ODB-09 | Session numbers | 30 min idle, 8 h absolute | Other numbers (variables) | Owner test |
| ODB-10 | Group revocation delay | 300 s | Shorter, more Graph calls | Owner test (OV-16) |
| ODB-11 | Out-of-scope single objects | 403 | 404 | Phase C spec |
| ODB-12 | Denial audit volume | Reads and writes | Writes only | Owner test |
| ODB-13 | Admin API probe in verification | Keep V5 as warning | Drop until ODB-01 | Owner test |
| ODB-14 | First Owner other than the bootstrap admin | Manual mode only | Always or never | Phase B gate |
| ODB-15 | Plain cookie names on `http://localhost` | Accept | Require https | Phase B gate |
| ODB-16 | Entra groups and privileged roles | `rbac:manage` and `settings:connection` roles cannot be bound to a group | Bind with step-up, or free | Phase B gate |
| ODB-17 | Break-glass strength | Password floor (14) and proxy restriction | Second factor or allow-list now | Phase B gate |
| ODB-18 | Adopting an existing application | Refuse secrets, ask acknowledgement for foreign certificates and owners | Always refuse or always ask | Owner test (OV-03) |

---

## 5. The question / De vraag

Approve proceeding to Phase C? The owner fills in the approval line below; nobody else does. Nothing for Phase C is started before it is filled in.

Akkoord om door te gaan met fase C?

Naam en datum / Name and date:
