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
- Stack: **PHP 8.3** (strict types, PSR-12, Composer), Slim 4 of Symfony-componenten,
  Twig + HTMX (geen zware SPA-build), **FrankenPHP/Caddy** als webserver,
  **SQLite** op volume `/data` (config, audit log, sessies). Optioneel `pwsh` met
  ExchangeOnlineManagement in dezelfde image als fallback voor Exchange-cmdlets.
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
1. Welkom + controle omgeving (HTTPS, schrijfbare `/data`, `APP_KEY`, PHP-extensies).
2. **Tenant koppelen** met een tijdelijke beheerderslogin (device code flow of
   interactieve login) van een gebruiker met Global Administrator (of combinatie
   Application Administrator + Privileged Role Administrator). Dit bootstrap-token
   wordt na de wizard weggegooid en nooit opgeslagen.
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

### 5. Kwaliteit
- Architectuur: scheiding tussen `GraphClient`, `ExchangeClient` (REST met
  pwsh-fallback achter dezelfde interface), services en controllers.
- Tests: PHPUnit (unit + integratie met gemockte HTTP), PHPStan level max,
  PHP-CS-Fixer in CI. Een optionele e2e-suite tegen een M365 developer tenant.
- Geen onnodige dependencies; houd de image klein.
- Security-review: OWASP-top-10 check, input-validatie, output-escaping,
  geen PII in logs, security headers (CSP, HSTS, X-Frame-Options).

### 6. Acceptatiecriteria
1. `docker run -p 8080:8080 -v m365:/data ghcr.io/flux76hq/m365portal` op een lege
   volume toont de wizard; na afronding zijn app-registratie, certificaat,
   permissies en Exchange-rol aantoonbaar aanwezig in de tenant.
2. Na herstart blijft de configuratie behouden en is de wizard niet meer bereikbaar.
3. Een gebruiker is vanuit het panel aan een groep en aan een bestaande
   distributielijst toe te voegen en weer te verwijderen.
4. Een mailcontact is aan te maken, te bewerken en te verwijderen.
5. Alle schrijfacties staan in het audit log; geen secrets in logs of repo.
6. CI is groen (lint, PHPStan, tests, image-build, scan).

### 7. Opleveren
Lever per fase een kleine, reviewbare commit-reeks, werk README/docs bij, en
sluit af met een lijst van openstaande risico's en vervolgideeën (fase 2:
licentiebeheer, shared mailboxes, MFA-overzicht, rollen).

---

## Advies samengevat
| Optie | Oordeel |
|---|---|
| GitHub Pages | Niet geschikt: statisch, geen veilige secrets, geen Exchange-aanroepen |
| Azure Web App met kale PHP | Kan, maar Azure-gebonden en lastiger voor certificaten/pwsh |
| **Docker, alles in 1 container** | **Aanbevolen**: draait overal, ook op Azure |

Kernpunt: Graph kan geen leden aan distributielijsten toevoegen of mailcontacten
beheren; daarvoor is de Exchange Online Admin API (app-only, certificaat,
`Exchange.ManageAsApp` + Exchange-rol) nodig.
