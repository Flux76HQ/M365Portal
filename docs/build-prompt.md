# Bouw-prompt: self-hosted Microsoft 365 beheerpanel (M365Portal)

**Gebruik:** kopieer alles onder de kop *Prompt* (tot het einde van het bestand) en
geef het aan een AI-codeeragent, of gebruik het als input voor `/speckit-specify`.
De prompt is zelfstandig leesbaar.

## Achtergrond: hostingadvies
| Optie | Oordeel |
|---|---|
| GitHub Pages | Niet geschikt: statisch, geen veilige secrets, geen Exchange-aanroepen |
| Azure Web App zonder container | Kan, maar Azure-gebonden en lastiger voor certificaten/pwsh |
| **Docker, alles in 1 container** | **Aanbevolen**: draait overal, ook op Azure |

Kernpunt: Graph kan geen leden aan distributielijsten toevoegen of mailcontacten
beheren; daarvoor is de Exchange Online Admin API (app-only, certificaat,
`Exchange.ManageAsApp` + Exchange-rol) nodig.

---

## Prompt

Je bent een senior full-stack engineer met diepe kennis van Microsoft Entra ID,
Microsoft Graph en Exchange Online. Bouw **M365Portal**: een self-hosted webpanel
waarmee een beheerder een Microsoft 365-tenant beheert.

**Aanpak:** stel eerst maximaal 5 gerichte verduidelijkende vragen als iets echt
onduidelijk is; kies anders zelf verstandige standaardwaarden en noteer ze als
aannames in de spec. Bouw daarna in vier fasen, elk met werkende, geteste code en
een eigen commit-reeks:
- **Fase A:** monorepo, Docker-image, CI, design system en app-shell, branding.
- **Fase B:** onboarding wizard, authenticatie en RBAC-fundament (policy-laag).
- **Fase C:** gebruikers en groepen (Graph).
- **Fase D:** distributielijsten en mailcontacten (Exchange), RBAC-beheer-UI met
  scopes, audit log en beveiligings-hardening, e2e-tests en documentatie.

Verzin geen API's of cmdlet-parameters: controleer ze in de officiële Microsoft
Learn-documentatie en markeer wat je niet kon verifiëren in `docs/open-points.md`.

### 0. Werkafspraken
- Lees eerst `AGENTS.md` en `shared/guidelines/project-baseline.md` (als aanwezig in
  de repo of via App-Guidance) en volg die. Bump `VERSION` bij wijzigingen aan
  runtime/build/deploy. Geen secrets in de repo of in logs. Ontbreekt `AGENTS.md`
  in de repo, maak dan een korte aan met deze werkafspraken.
- Werk spec-first: schrijf een korte spec (`/speckit-specify`), plan en taken, en
  implementeer daarna in kleine, geteste stappen.
- Documenteer: README (install in 5 minuten), `docs/architecture.md`,
  `docs/security.md`, `docs/permissions.md` (elke permissie met reden).
- UI en documentatie in **Nederlands en Engels** (i18n vanaf dag 1); code,
  identifiers, commit-berichten en code-commentaar in het Engels.

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
  Wie mag inloggen en wat iemand daarna mag, bepaalt uitsluitend het eigen
  RBAC-model van het panel (zie 2a), niet de Entra- of M365-rollen van de gebruiker. Server-side sessies, CSRF-tokens, strikte cookies, rate limiting.
- **Eén app-registratie** (confidential client met certificaat) dient voor zowel
  de panel-login (OIDC) als de app-only toegang; de wizard vraagt de publieke
  basis-URL van het panel (ook `http://localhost` is toegestaan) en registreert
  daarvan de redirect-URI.
- **Toegang tot de tenant (runtime):** app-only (client credentials) met
  **certificaat** (client assertion, geen client secret). Privésleutel versleuteld at rest in `/data`
  (sleutel uit env `APP_KEY` of Docker secret).
- Least privilege; elke permissie gedocumenteerd.

### 2a. Rollen en rechten (RBAC in het panel)
Omdat het panel met één krachtige app-identiteit werkt, is het panel zelf de enige
plek waar rechten worden afgedwongen. Een gebruiker die in Entra/M365 beheerder is,
mag in het panel alleen wat het panel hem toestaat; wie in Entra geen rechten heeft
maar in het panel een rol krijgt, kan alleen via het panel precies die acties doen.
- **Rechtenmodel:** fijnmazige permissies in de vorm `resource:actie`, bijvoorbeeld
  `users:read`, `groups:read`, `groups:members:write`, `distributionlists:read`,
  `distributionlists:members:write`, `distributionlists:export`,
  `contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete`, `audit:read`, `audit:export`, `settings:branding`,
  `settings:connection`, `rbac:manage`. Een rol is een set permissies.
- **Ingebouwde rollen** (niet te wijzigen): *Eigenaar* (alles, inclusief RBAC en
  verbinding), *Beheerder*, *Operator* (leden en contacten beheren, geen instellingen),
  *Helpdesk* (alleen lezen plus leden toevoegen/verwijderen binnen scope) en
  *Lezer* (alleen lezen). Daarnaast **eigen rollen** aan te maken en te klonen, met een paar
  **sjablonen** om mee te beginnen, waaronder *Bestuur*.
- **Voorbeeld-sjabloon *Bestuur*:** mag alleen (a) mailcontacten **aanmaken**
  (`contacts:create`), (b) mensen **toevoegen aan en verwijderen uit** de
  distributiegroep(en) binnen de toegewezen scope (`distributionlists:members:write`),
  plus de minimale leesrechten om dat te kunnen doen (`contacts:read`,
  `distributionlists:read`, `users:read` beperkt tot naam en e-mail). Contacten
  bewerken of verwijderen, groepen, instellingen, audit en RBAC zijn **niet**
  toegestaan; de UI toont alleen de schermen en knoppen die bij deze rol horen.
- **Toewijzing** aan individuele gebruikers én aan **Entra-groepen** (groepslidmaatschap
  wordt bij elke login opnieuw bepaald via Graph, ook bij groups-overage). Een
  gebruiker krijgt de som van zijn rollen. **Standaard geen toegang:** wie geen rol
  heeft kan niet inloggen en ziet een nette "geen toegang"-pagina.
- **Scope (beperking tot objecten):** een roltoewijzing kan beperkt worden tot
  specifieke groepen, distributielijsten, mailcontacten of een filter (bijvoorbeeld
  alle objecten met een bepaald voorvoegsel of afdeling). Voorbeeld: "mag alleen leden
  van de groepen *Sales* en *Marketing* beheren". Buiten scope zijn objecten onzichtbaar
  of alleen-lezen, afhankelijk van de permissies.
- **Afdwingen op de server:** elke API-route controleert permissie én scope in één
  centrale policy-laag (deny by default); de UI verbergt of disabelt alleen wat niet
  mag, ter bevestiging, nooit als beveiliging. Ook bulk-acties, exports, zoeken en
  de command palette respecteren de scope. Dit is onderdeel van de tests.
- **Bescherming tegen misbruik:** niemand kan rechten toekennen die hij zelf niet
  heeft (geen privilege escalation); de laatste Eigenaar kan zichzelf niet verwijderen
  of degraderen; het eerste account uit de wizard wordt Eigenaar. Optioneel een
  **break-glass**-account via env var dat alleen RBAC kan herstellen en dat elke
  login luid in het audit log zet.
- **Beheer-UI:** *Instellingen → Rollen en toegang* met overzicht per rol en per
  gebruiker, "effectieve rechten" per gebruiker, een voorbeeld ("bekijk als
  gebruiker X") en een veilige wijzigingsflow met bevestiging. Roltoewijzingen kunnen
  optioneel een **vervaldatum** hebben (tijdelijke toegang).
- **Audit:** elke wijziging aan rollen en toewijzingen, en elke geweigerde actie
  (403), komt in het audit log.
- **Datamodel:** tabellen voor rollen, permissies, toewijzingen (gebruiker/groep, rol,
  scope, vervaldatum) en een cache van groepslidmaatschappen met korte TTL.

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
   - de app role `Exchange.ManageAsApp` (resource Office 365 Exchange Online) toekennen en de service principal de rol
     **Exchange Administrator** (of een custom Exchange-rolgroep met minimaal
     benodigde rechten voor DL's en mailcontacten) geven;
   - redirect-URI's voor panel-login registreren, beheerdersgroep aanmaken/kiezen.
4. **Verificatie:** testaanroepen (Graph `/organization`, `/users?$top=1`,
   Exchange `Get-OrganizationConfig` / `Get-DistributionGroup -ResultSize 1`) en
   duidelijke foutmeldingen met oplossing (propagatievertraging van rollen
   afhandelen met retry/backoff).
5. **Branding:** organisatienaam, logo en accentkleur instellen (met live preview;
   overslaan mag). De ingelogde Global Admin wordt de eerste *Eigenaar*; kies
   eventueel een Entra-groep voor de rol *Beheerder*. Taal kiezen, wizard vergrendelen
   (`setup_completed`).
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

**CSV-export van distributielijsten** (voor bijvoorbeeld Laposta of een andere
nieuwsbriefdienst): knop *Exporteer als CSV* op de lijst, met permissie
`distributionlists:export` en binnen de RBAC-scope.
- Kolommen kiesbaar met live voorbeeld; standaard: `email`, `voornaam`,
  `achternaam`, `weergavenaam`, `type` (gebruiker/contact). Een vooraf ingestelde
  **Laposta-preset** (e-mail plus voor- en achternaam) en een generieke preset; houd
  het kolomformaat configureerbaar en controleer het actuele importformaat van
  Laposta in hun documentatie voordat je de preset vastlegt.
- Opties: scheidingsteken (`;` voor Nederlandse Excel, of `,`), UTF-8 met of zonder
  BOM, geneste groepen uitvouwen, dubbele e-mailadressen ontdubbelen, leden zonder
  e-mailadres overslaan (met melding hoeveel).
- Streaming voor grote lijsten, bestandsnaam met lijstnaam en datum.
- **Veiligheid en privacy:** bescherm tegen CSV/formule-injectie (waarden die met
  `=`, `+`, `-`, `@`, tab of CR beginnen veilig maken), schrijf elke export (wie, welke
  lijst, aantal rijen) naar het audit log, vraag eventueel step-up bevestiging en
  toon een korte AVG-waarschuwing. Het exportbestand wordt niet op de server bewaard.
- Later (fase 2, niet nu): rechtstreekse synchronisatie met de Laposta-API.

**Overig:** audit log van alle schrijfacties (wie, wat, wanneer, resultaat) in de UI
en exporteerbaar (CSV); dashboard met tellers; nette foutafhandeling met
throttling (429/`Retry-After`) en caching met korte TTL.

### 5. Design en gebruikerservaring (professioneel niveau)
Het resultaat moet eruitzien als een commercieel product, niet als een standaard
admin-template. **Stijlrichting: strak zakelijk in de Microsoft Fluent 2-taal
(Entra- en Microsoft 365-admincenter) met een vleugje Apple.**
- **Fluent-kenmerken:** heldere, rustige vlakken met subtiele lagen (Mica/Acrylic-achtige
  zijbalk en header, spaarzaam gebruikt), duidelijke hiërarchie, compacte maar
  luchtige tabellen, 4 px-raster, radius 4-8 px, Fluent-achtige focusringen en
  componentgedrag (commandbar boven lijsten, details-paneel aan de zijkant, Persona
  met initialen voor gebruikers).
- **Apple-vleugje:** zachte, fijne schaduwen, royale witruimte, vloeiende spring-
  animaties, glasachtige blur op overlays en dialogen, afgeronde segmented controls
  en scherpe, kalme typografie. Niet overdrijven: zakelijk blijft leidend.
- **Typografie:** Segoe UI Variable-gevoel zonder licentieproblemen: gebruik zelf
  gehost Inter (of Geist) met Fluent-achtige maten en gewichten; systeem-UI-fonts als
  fallback.
- **Design system:** eigen tokens (kleur, spacing, radius, schaduw, typografie) met
  een neutraal grijs-blauw palet; de accentkleur komt uit de huisstijl (zie
  Branding) en alle contrasten blijven WCAG-conform. Consistente componenten:
  tabellen, formulieren, dialogen, toasts, command palette.
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

### 5a. Branding en white-label
Het panel is voor elke organisatie (bedrijf, vereniging, stichting) aan te passen,
zonder code te wijzigen. Instelbaar in de wizard en later onder *Instellingen →
Weergave*:
- **Organisatienaam:** getoond in zijbalk, browsertitel, aanmeldscherm, e-mails en
  het audit log-rapport. Standaard de tenantnaam, daarna vrij aan te passen.
- **Logo uploaden:** PNG, JPG of SVG (max. 2 MB), apart voor licht en donker thema
  (of automatische weergave als er één is), ook een compacte variant voor de
  ingeklapte zijbalk en een favicon/PWA-icoon dat uit het logo wordt afgeleid.
- **Accentkleur:** keuzehulp met live voorbeeld; de app berekent zelf toegankelijke
  tinten voor hover, actief en tekstkleur.
- **Veilige verwerking van uploads:** valideer op inhoud (magic bytes), niet op
  extensie; **sanitize SVG** (verwijder scripts, event handlers en externe
  verwijzingen) of render naar PNG; herschaal en verwijder metadata; sla op in
  `/data/branding` met een hash-naam; lever uit met `Content-Type`, `nosniff` en
  een strikte CSP; alleen beheerders mogen uploaden; schrijf elke wijziging naar het
  audit log.
- Zonder logo valt de app terug op een nette monogram-tegel met de initialen.
- Branding wordt in de database bewaard en is exporteerbaar/importeerbaar.

### 6. Beveiliging (security by design)
- Voer vooraf een korte **threat model** (STRIDE) uit en leg die vast in
  `docs/security.md`; volg **OWASP ASVS niveau 2**.
- **Panel-login:** OIDC + PKCE, `state`/`nonce`, tokenvalidatie (issuer, audience,
  tid), afdwingen van MFA via de `amr`/`acr`-claim, sessie-rotatie na login,
  idle- en absolute timeout, uitloggen overal. Ondersteun Conditional Access.
- **RBAC** volgens sectie 2a, plus step-up bevestiging (opnieuw inloggen met MFA)
  bij gevoelige acties zoals rollen wijzigen of bulk-verwijderen.
- **Geheimen:** certificaat-privésleutel versleuteld met libsodium
  (XChaCha20-Poly1305, via `libsodium-wrappers`); sleutel via Docker/Azure secret of
  Key Vault-referentie; nooit in logs, error-pagina's of backups in leesbare vorm.
- **Webbeveiliging:** strikte **CSP met nonces** (geen `unsafe-inline`),
  Trusted Types, HSTS (preload), `Referrer-Policy`, `Permissions-Policy`,
  COOP/COEP/CORP, `__Host-`-cookies (`SameSite=Strict`, behalve de korte `state`-cookie tijdens de
  OIDC-redirect, die `Lax` moet zijn), CSRF-tokens op elke
  schrijfactie, parametrische queries, uitvoer-escaping, rate limiting en
  brute-force-bescherming, strikte invoervalidatie en uploadbeperkingen.
- **Least privilege richting Microsoft:** alleen de nodige permissies, bij voorkeur
  een beperkte Exchange-rolgroep in plaats van de volledige Exchange Administrator;
  documenteer per permissie het waarom en bied in de UI een "permissie-audit".
- **Onveranderbaar audit log** (hash-keten) met wie/wat/wanneer/resultaat/IP.
- **Supply chain:** vastgepinde dependencies, Dependabot/Renovate,
  `pnpm audit` in CI, secret scanning, CodeQL, image gebouwd op een
  minimale (distroless of Alpine) basis, **cosign-handtekening**, **SLSA-provenance** en SBOM
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
9. Licht/donker thema en mobiele weergave zijn visueel gecontroleerd en passen bij
   de Fluent-achtige look met Apple-accenten.
10. Organisatienaam, logo (incl. kwaadaardig SVG-testbestand dat wordt geweigerd of
    opgeschoond) en accentkleur zijn aan te passen en overleven een herstart.

11. RBAC: een gebruiker met alleen de rol *Lezer* kan geen enkele schrijfactie doen,
    ook niet door de API rechtstreeks aan te roepen (403 en audit-regel). Een
    gebruiker met een scope op groep *Sales* ziet en wijzigt geen andere groepen. Een
    gebruiker zonder rol kan niet inloggen, ook al is hij Global Admin in Entra. De
    laatste Eigenaar is niet te verwijderen, en rechten uitdelen die je zelf niet
    hebt wordt geweigerd. Dit is gedekt door geautomatiseerde tests.

12. Een gebruiker met het sjabloon *Bestuur* kan een mailcontact aanmaken en mensen aan
    de toegewezen distributiegroep toevoegen en eruit verwijderen, maar een contact
    bewerken of verwijderen, andere lijsten wijzigen, exporteren (zonder die
    permissie), instellingen en RBAC openen wordt server-side geweigerd.
13. De CSV-export van een distributielijst opent correct in Excel en is te importeren
    in Laposta (preset); ontdubbeld en met werkende scheidingsteken- en BOM-opties;
    een testlid met naam `=HYPERLINK(...)` wordt veilig geëxporteerd; de export staat
    in het audit log en kan alleen met de exportpermissie.

### 9. Opleveren
Lever per fase een kleine, reviewbare commit-reeks, werk README/docs bij, en
sluit af met een lijst van openstaande risico's en vervolgideeën (fase 2:
licentiebeheer, shared mailboxes, MFA-overzicht, rollen).

---
