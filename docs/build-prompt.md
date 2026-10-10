# Bouw-prompt: self-hosted Microsoft 365 beheerpanel (M365Portal)

Gebruik deze prompt als startpunt voor een AI-codeeragent (of als input voor
`/speckit-specify`). Hij is zelfstandig leesbaar.

---

## Prompt

Je bent een senior full-stack engineer met diepe kennis van Microsoft Entra ID,
Microsoft Graph en Exchange Online. Bouw **M365Portal**: een self-hosted webpanel
waarmee een beheerder een Microsoft 365-tenant beheert.

### 0. Werkafspraken
- Lees eerst `AGENTS.md` en `shared/guidelines/project-baseline.md` (als aanwezig in
  de repo of via App-Guidance) en volg die. Bump `VERSION` bij wijzigingen aan
  runtime/build/deploy. Geen secrets in de repo of in logs.
- Werk spec-first: schrijf een korte spec (`/speckit-specify`), plan en taken, en
  implementeer daarna in kleine, geteste stappen.
- Documenteer: README (install in 5 minuten), `docs/architecture.md`,
  `docs/security.md`, `docs/permissions.md` (elke permissie met reden).
- UI en documentatie in **Nederlands en Engels** (i18n vanaf dag 1).

### 1. Hosting en architectuur (vast besluit)
- **Eén Docker-image, één container**, draait overal (Azure Container Apps /
  App Service for Containers, on-prem, VPS, NAS). Geen GitHub Pages: een statische
  site kan geen secrets/certificaten veilig bewaren en geen Exchange-aanroepen doen.
- **Taal: TypeScript end-to-end** (strict mode), één monorepo (pnpm workspaces) met
  gedeelde types tussen frontend en backend. Reden: beste ecosysteem voor
  Microsoft (MSAL, Graph SDK), beste UI-bibliotheken en één taal voor de agent.
- Backend: **Node.js 22 LTS** met **Hono** (of Fastify), **Zod** voor validatie,
  **Drizzle ORM** op **SQLite (WAL)** in volume `/data` (config, audit log, sessies).
  `@azure/msal-node` en de Graph-client voor Microsoft; Exchange via REST
  (`InvokeCommand`), optioneel `pwsh` met ExchangeOnlineManagement als fallback.
  **Backend-for-frontend:** tokens en certificaat blijven server-side; de browser
  krijgt alleen een `__Host-` sessiecookie, nooit een access token.
- Frontend: **React 19 + Vite**, **TanStack Router/Query/Table**, **Tailwind CSS v4**
  met **shadcn/ui** (Radix) als basis voor het eigen design system, Lucide-iconen,
  **React Hook Form + Zod**, Motion voor animaties. Geen CDN-afhankelijkheden
  tijdens runtime: alles wordt in de image meegebouwd. Installeerbaar als **PWA**.
- Het geheel wordt door één Node-proces geserveerd (statische build + API) in één
  image; Caddy of een reverse proxy voor HTTPS is optioneel.
- API-first: interne JSON-API met **OpenAPI 3.1**-spec (uit de Zod-schema's
  gegenereerd); de UI gebruikt dezelfde API, zodat automatisering later kan.
- Config uitsluitend via env vars + `/data`. Healthcheck-endpoint `/healthz`.
  Non-root user, read-only root filesystem waar mogelijk, HTTPS via reverse proxy
  of Caddy (automatisch certificaat) instelbaar.
- Multi-arch image (amd64/arm64), gebouwd en gepubliceerd via GitHub Actions
  naar GHCR, met Trivy-scan en SBOM.

### 2. Authenticatie
- **Aanmelden bij het panel:** OpenID Connect (auth code + PKCE) tegen Entra ID.
  Alleen gebruikers in een in de wizard gekozen beheerdersgroep (of met een app role)
  krijgen toegang. Server-side sessies, CSRF-tokens, strikte cookies, rate limiting.
- **Toegang tot de tenant (runtime):** app-only (client credentials) met
  **certificaat** (geen client secret). Privésleutel versleuteld at rest in `/data`
  (sleutel uit env `APP_KEY` of Docker secret).
- Least privilege; elke permissie gedocumenteerd.

### 3. Onboarding wizard (eerste start)
Bij een lege `/data` start automatisch `/setup`. De wizard is **idempotent,
hervatbaar en toont per stap status/rollback-hint**:
1. Welkom + controle omgeving (HTTPS, schrijfbare `/data`, `APP_KEY`, Node-versie).
2. **Tenant koppelen** met een tijdelijke Global Administrator-login via de
   **device code flow**. Gebruik als bootstrap-client de Microsoft-client
   "Microsoft Graph Command Line Tools" (client-ID
   `14d82eec-204b-4c2f-b7e8-296a70dab67e`, de client van `Connect-MgGraph`);
   die bestaat al in elke tenant, dus er is **geen eigen multi-tenant app** om
   te registreren of te hosten. Maak het client-ID overschrijfbaar via env var
   `BOOTSTRAP_CLIENT_ID`, zodat een beheerder een eigen app kan opgeven als
   Microsoft deze client ooit beperkt. Vraag alleen de delegated scopes die de
   wizard nodig heeft (`Application.ReadWrite.All`,
   `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`,
   `Directory.Read.All`). Het bootstrap-token wordt na de wizard weggegooid en
   nooit opgeslagen.
3. **Automatisch configureren in de tenant:**
   - App-registratie "M365Portal" + service principal aanmaken;
   - certificaat genereren, publieke deel uploaden, privé versleuteld opslaan;
   - Graph application permissions toekennen en admin consent geven
     (minimaal `User.ReadWrite.All`, `Group.ReadWrite.All`,
     `GroupMember.ReadWrite.All`, `Directory.Read.All`, `Organization.Read.All`);
   - `Exchange.ManageAsApp` toekennen en de service principal de rol
     **Exchange Administrator** (of een custom Exchange-rolgroep met minimaal
     benodigde rechten voor DL's en mailcontacten) geven;
   - redirect-URI's voor panel-login registreren, beheerdersgroep aanmaken/kiezen.
4. **Verificatie:** testaanroepen (Graph `/organization`, `/users?$top=1`,
   Exchange `Get-OrganizationConfig` / `Get-DistributionGroup -ResultSize 1`) en
   duidelijke foutmeldingen met oplossing (propagatievertraging van rollen
   afhandelen met retry/backoff).
5. Eerste beheerder instellen, taal kiezen, wizard vergrendelen (`setup_completed`).
   Een "Herstel verbinding"-actie in Instellingen draait de relevante stappen opnieuw.

### 4. Functionaliteit (fase 1)
**Gebruikers** (Graph): zoekbare, sorteerbare, gepagineerde lijst (naam, UPN,
e-mail, afdeling, status, licenties); detailpagina met groepslidmaatschappen.

**Groepen** (Graph): gebruikers toevoegen/verwijderen bij M365-groepen en
security-groepen (multi-select, bulk). Dynamische en on-prem gesynchroniseerde
groepen zijn read-only en worden zo getoond.

**Distributielijsten** (Exchange Online Admin API, `InvokeCommand`;
cmdlets `Get-DistributionGroup`, `Get-DistributionGroupMember`,
`Add-DistributionGroupMember`, `Remove-DistributionGroupMember`): bestaande lijsten
tonen en gebruikers (en mailcontacten) toevoegen/verwijderen. Let op: Microsoft
Graph ondersteunt dit **niet**; gebruik Exchange.

**Mailcontacten** (Exchange: `Get-MailContact`, `New-MailContact`,
`Set-MailContact`, `Remove-MailContact`): volledige CRUD met validatie
(extern e-mailadres uniek, weergavenaam, alias), bevestigingsdialoog bij
verwijderen, en zichtbaar maken van lidmaatschap in DL's.

**Overig:** audit log van alle schrijfacties (wie, wat, wanneer, resultaat) in de UI
en exporteerbaar (CSV); dashboard met tellers; nette foutafhandeling met
throttling (429/`Retry-After`) en caching met korte TTL.

### 5. Design en gebruikerservaring (professioneel niveau)
Het resultaat moet eruitzien als een commercieel product (denk aan Linear,
Vercel en het Microsoft Entra-admincenter), niet als een standaard admin-template.
- **Design system:** eigen tokens (kleur, spacing, radius, schaduw, typografie) met
  een rustig, modern palet, variabele lettertype (Inter of Geist, zelf gehost) en
  consistente componenten: tabellen, formulieren, dialogen, toasts, command palette.
- **Licht, donker en systeemthema**, soepel schakelen; `prefers-reduced-motion`
  gerespecteerd; subtiele, snelle micro-interacties (≤200 ms).
- **Navigatie:** inklapbare zijbalk, brodkruimels, globale zoekbalk en command
  palette (`Ctrl/Cmd+K`), sneltoetsen met overzicht (`?`).
- **Data-tabellen:** server-side zoeken, sorteren, filteren en paginering, sticky
  header, kolomkeuze, bulkselectie, skeleton loaders, lege staten met uitleg,
  inline validatie en duidelijke foutstaten met herstelactie.
- **Gevaarlijke acties** (verwijderen, bulk) altijd met bevestiging die het
  object noemt; ongedaan-maken waar het kan.
- **Wizard:** voortgangsbalk, duidelijke stapstatus, live logregels per actie.
- **Responsive** (mobiel tot ultrawide) en **toegankelijk volgens WCAG 2.2 AA**:
  toetsenbordbediening, focusindicatoren, ARIA waar nodig, voldoende contrast,
  schermlezer-getest.
- **Prestaties:** Lighthouse ≥ 95 (Performance, Accessibility, Best Practices),
  LCP < 2,0 s, kritieke CSS inline, lazy loading, geen layout shift.
- Lever bij oplevering schermafbeeldingen (licht/donker) en een korte demo-GIF in
  de README.

### 6. Beveiliging (security by design)
- Voer vooraf een korte **threat model** (STRIDE) uit en leg die vast in
  `docs/security.md`; volg **OWASP ASVS niveau 2**.
- **Panel-login:** OIDC + PKCE, `state`/`nonce`, tokenvalidatie (issuer, audience,
  tid), afdwingen van MFA via de `amr`/`acr`-claim, sessie-rotatie na login,
  idle- en absolute timeout, uitloggen overal. Ondersteun Conditional Access.
- **RBAC** in het panel (lezer / operator / beheerder) en step-up bevestiging bij
  gevoelige acties.
- **Geheimen:** certificaat-privésleutel versleuteld met libsodium
  (XChaCha20-Poly1305, via `libsodium-wrappers`); sleutel via Docker/Azure secret of Key Vault-referentie;
  nooit in logs, error-pagina's of backups in leesbare vorm.
- **Webbeveiliging:** strikte **CSP met nonces** (geen `unsafe-inline`),
  Trusted Types, HSTS (preload), `Referrer-Policy`, `Permissions-Policy`,
  COOP/COEP/CORP, `SameSite=Strict` `__Host-`-cookies, CSRF-tokens op elke
  schrijfactie, parametrische queries, uitvoer-escaping, rate limiting en
  brute-force-bescherming, strikte invoervalidatie en uploadbeperkingen.
- **Least privilege richting Microsoft:** alleen de nodige permissies, bij voorkeur
  een beperkte Exchange-rolgroep in plaats van de volledige Exchange Administrator;
  documenteer per permissie het waarom en bied in de UI een "permissie-audit".
- **Onveranderbaar audit log** (hash-keten) met wie/wat/wanneer/resultaat/IP.
- **Supply chain:** vastgepinde dependencies, Dependabot/Renovate, `pnpm audit` in CI, secret scanning, CodeQL, image gebouwd op een minimale
  (distroless of Alpine) basis, **cosign-handtekening**, **SLSA-provenance** en SBOM
  (CycloneDX) bij elke release.
- **Runtime:** non-root, `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`,
  seccomp-profiel; voorbeeld-`docker-compose.yml` en Azure-voorbeeld (Bicep) met
  deze instellingen.

### 7. Kwaliteit en observability
- Architectuur: scheiding tussen `GraphClient`, `ExchangeClient` (REST met
  pwsh-fallback achter dezelfde interface), services en controllers.
- Tests: Vitest (unit + integratie met gemockte HTTP via MSW), **Playwright** e2e en
  visuele regressietests, axe-core toegankelijkheidstests, TypeScript strict,
  ESLint en Prettier (of Biome) in CI. Optionele e2e-suite tegen een M365
  developer tenant.
- **Observability:** gestructureerde JSON-logs (zonder PII), **OpenTelemetry**
  traces/metrics (uitschakelbaar), `/healthz` en `/readyz`, nette throttling
  (429/`Retry-After`) met backoff en korte-TTL-caching.
- Geen onnodige dependencies; houd de image klein.

### 8. Acceptatiecriteria
1. `docker run -p 8080:8080 -v m365:/data ghcr.io/flux76hq/m365portal` op een lege
   volume toont de wizard; na afronding zijn app-registratie, certificaat,
   permissies en Exchange-rol aantoonbaar aanwezig in de tenant.
2. Na herstart blijft de configuratie behouden en is de wizard niet meer bereikbaar.
3. Een gebruiker is vanuit het panel aan een groep en aan een bestaande
   distributielijst toe te voegen en weer te verwijderen.
4. Een mailcontact is aan te maken, te bewerken en te verwijderen.
5. Alle schrijfacties staan in het audit log; geen secrets in logs of repo.
6. CI is groen (lint, typecheck, unit/e2e/a11y-tests, image-build, scans).
7. Lighthouse ≥ 95 op alle hoofdpagina's; axe-core meldt geen ernstige problemen.
8. Security-headers scoren A+ (securityheaders.com / Mozilla Observatory);
   de image is gesigneerd en heeft SBOM en provenance.
9. Licht/donker thema en mobiele weergave zijn visueel gecontroleerd.

### 9. Opleveren
Lever per fase een kleine, reviewbare commit-reeks, werk README/docs bij, en
sluit af met een lijst van openstaande risico's en vervolgideeën (fase 2:
licentiebeheer, shared mailboxes, MFA-overzicht, rollen).

---

## Advies samengevat
| Optie | Oordeel |
|---|---|
| GitHub Pages | Niet geschikt: statisch, geen veilige secrets, geen Exchange-aanroepen |
| Azure Web App zonder container | Kan, maar Azure-gebonden en lastiger voor certificaten/pwsh |
| **Docker, alles in 1 container** | **Aanbevolen**: draait overal, ook op Azure |

Kernpunt: Graph kan geen leden aan distributielijsten toevoegen of mailcontacten
beheren; daarvoor is de Exchange Online Admin API (app-only, certificaat,
`Exchange.ManageAsApp` + Exchange-rol) nodig.
