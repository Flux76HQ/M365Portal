# M365Portal

> Nederlandse versie: zie [Nederlands](#nederlands). English first.

## English

M365Portal is a self-hosted web panel for administering a Microsoft 365 tenant (users, groups,
distribution lists, contacts) from one place. It runs as one container with one volume.

### Status, honestly

This is **Phase A, the foundation**. What exists and works:

- the application shell (sidebar, header, command palette `Ctrl+K`, light and dark theme, Dutch and English),
- organisation branding (name, logo upload, accent colour with a contrast guarantee, export and import),
- the design system (visible at `/design` when `SHOWCASE=true`),
- a hardened server and container image (strict security headers, rate limits, read-only root file system, audit log with a hash chain).

What does **not** exist yet:

- **There is no connection to a Microsoft 365 tenant** and **no sign-in**. The pages for users, groups,
  distribution lists and contacts are empty shells. Nothing is read from or written to Microsoft.
- Without preview mode every visitor is anonymous and sees a "no access" page. Branding can only be
  changed in **preview mode**.

**Preview mode** (`PREVIEW_MODE=true`) lets whoever reaches the port act as administrator, without signing
in, so the panel can be evaluated. It is not a security boundary: use it on your own computer only, publish the
port on loopback (`127.0.0.1`), never expose it to a network. It is planned to be removed in Phase B.
Details: [docs/security.md](docs/security.md#preview-mode).

The licence is **not decided yet** (open decision OD-01 in [docs/open-points.md](docs/open-points.md)); until it
is, no licence is granted.

### Install in 5 minutes

You need Docker. The published image `ghcr.io/flux76hq/m365portal` exists only after the first run of the
publish workflow on GitHub, which has not happened yet. Until then build it yourself; the result is the same:

```sh
docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .
```

Behind a proxy that inspects TLS, add the proxy certificate as a BuildKit secret (it never enters an image
layer): `--secret id=extra_ca,src=/path/to/ca-bundle.crt`. Where Docker has no bridge network, add
`--network host`. Without `--build-arg VERSION` the image says version `unknown` on purpose.

Run it (evaluation in preview mode, loopback only):

```sh
docker run -d --name m365portal -p 127.0.0.1:9300:9300 -v m365:/data \
  -e PREVIEW_MODE=true m365portal:local
```

Open <http://localhost:9300>. For the published image replace `m365portal:local` by
`ghcr.io/flux76hq/m365portal`. Without `PREVIEW_MODE` the panel starts too, but shows only the "no access" page.

With Docker Compose:

```sh
cp .env.example .env      # optional; every default applies without it
docker compose up -d
```

The Compose file pulls the published image; before the first publish run, build as above and set
`image: m365portal:local` in `docker-compose.yml`. With host networking (`docker run --network host`) `PORT` is
the host port.

**Ports.** `PORT` is the port inside the container (1024 to 65535, default 9300). `HOST_PORT` exists in Compose only
and is the port the browser uses (default 9300). Every write is compared with `PUBLIC_BASE_URL`, so it **must equal
the address in the browser's address bar** (without path). Change the host port with Compose by `HOST_PORT=9090` in
`.env` (`PUBLIC_BASE_URL` follows); with `docker run` by `-p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090`.
A mismatch shows as `403 origin_not_allowed`, and the message names the variable.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOST_PORT` | `9300` | Compose only: the port published on the Docker host |
| `PORT` | `9300` | The port the process listens on inside the container (1024 to 65535) |
| `HOST` | `0.0.0.0` | Bind address inside the container |
| `DATA_DIR` | `/data` | Database and files; must match the volume |
| `PUBLIC_BASE_URL` | `http://localhost:<port>` | The origin the browser uses; every write is compared with it |
| `TRUST_PROXY` | `none` | Proxies to trust for the client address; keep `none` without a reverse proxy |
| `PREVIEW_MODE` | `false` | Unauthenticated administration for evaluation (loopback only) |
| `PREVIEW_MODE_ALLOW_REMOTE` | `false` | Lets preview mode start on a non-loopback address; never on a shared panel |
| `SHOWCASE` | `false` | Serves the `/design` component showcase |
| `LOG_LEVEL` | `info` | `trace` to `fatal`, or `silent` |
| `HSTS_MAX_AGE` | `31536000` | Seconds for `Strict-Transport-Security` (https only) |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | Adds `includeSubDomains` |
| `HSTS_PRELOAD` | `false` | Adds `preload`; needs the setting above and a max-age of one year or more |

The full table with all rules is in [docs/operations.md](docs/operations.md#environment-variables). An invalid
value stops the start and names the variable.

### What it looks like

| Light | Dark |
|---|---|
| ![Dashboard, light theme](docs/media/dashboard-light.png) | ![Dashboard, dark theme](docs/media/dashboard-dark.png) |
| ![Appearance settings, light theme](docs/media/appearance-light.png) | ![Appearance settings, dark theme](docs/media/appearance-dark.png) |

![Demo: switch theme, open the command palette, change the accent colour and save](docs/media/demo.gif)

The images are generated with `pnpm media` from the real application in preview mode, with a made-up
organisation and logo. They show the version number of the build they were made with and go stale at the next
version bump.

### What to check after the start

1. `http://localhost:9300/healthz` answers 200 with the version (the process lives).
2. `http://localhost:9300/readyz` answers 200 (the data directory is writable, the database is open). A 503
   names the failing check.
3. `docker ps` shows `healthy` after about half a minute.
4. In preview mode: Settings, Appearance: change the name or the accent colour, save, reload. The change stays.
5. Stop and start the container: the branding is still there (it lives in the volume).

```sh
curl -s http://127.0.0.1:9300/healthz
curl -s http://127.0.0.1:9300/readyz
```

What was run, and where: see [the gate note of the documentation](specs/001-m365portal/gate-notes/G8.md).

### Limits as numbers

Whatever sits in front of the panel (reverse proxy, firewall) must allow requests of **at least 9,437,184 bytes**:
that is the largest request, the branding import. All other limits (image size, rate limits, timeouts, quota,
retention) are listed as numbers in [docs/operations.md](docs/operations.md#limits-outside-the-repository) and are defined once in `packages/shared`.

### Security

The container runs unprivileged (uid 65532), with a read-only root file system, all capabilities dropped and no
shell. The panel sets no cookies in Phase A and sends a strict Content-Security-Policy with Trusted Types. Uploaded
images are re-encoded; SVG is sanitised and rasterised. Read [docs/security.md](docs/security.md) before putting
it anywhere but your own computer. Report vulnerabilities privately to the owner of the repository, not in a public issue.

### Documentation

- [docs/operations.md](docs/operations.md): setup, ports, environment, backup, update, health, limits
- [docs/architecture.md](docs/architecture.md): components, request pipeline, performance architecture, dependencies, accessibility
- [docs/security.md](docs/security.md): threat model, controls, SVG allowlist, preview mode
- [docs/permissions.md](docs/permissions.md): the permission catalogue and the Microsoft Graph and Exchange permissions planned for later phases
- [docs/open-points.md](docs/open-points.md): open decisions, unverified claims, assumptions and risks
- [docs/adr/](docs/adr/): architecture decision records (ADR-0001 onwards)
- [deploy/README.md](deploy/README.md): short deployment notes; [specs/001-m365portal](specs/001-m365portal): the specification of Phase A

### Contributing

Read [AGENTS.md](AGENTS.md) first: versioning, hooks and CI controls, secret hygiene, the documentation
contract and the pull request workflow. `pnpm docs:check` checks the documentation.

## Nederlands

M365Portal is een zelf te hosten webpaneel om een Microsoft 365-tenant (gebruikers, groepen, distributielijsten,
contacten) vanaf één plek te beheren. Het draait als één container met één volume.

### Status, eerlijk

Dit is **Fase A, het fundament**. Wat er is en werkt:

- de applicatieschil (zijbalk, kopbalk, opdrachtenpalet `Ctrl+K`, licht en donker thema, Nederlands en Engels),
- organisatiebranding (naam, logo uploaden, accentkleur met contrastgarantie, export en import),
- het designsysteem (zichtbaar op `/design` met `SHOWCASE=true`),
- een geharde server en containerimage (strikte beveiligingskoppen, aanvraaglimieten, alleen-lezen rootbestandssysteem, auditlog met hashketen).

Wat er **nog niet** is:

- **Er is geen verbinding met een Microsoft 365-tenant** en **geen aanmelding**. De pagina's voor gebruikers,
  groepen, distributielijsten en contacten zijn lege schillen. Er wordt niets bij Microsoft gelezen of geschreven.
- Zonder previewmodus is iedere bezoeker anoniem en ziet alleen een pagina "geen toegang". Branding kan alleen
  in **previewmodus** worden gewijzigd.

**Previewmodus** (`PREVIEW_MODE=true`) laat iedereen die de poort bereikt als beheerder optreden, zonder aan te
melden, zodat het paneel kan worden beoordeeld. Het is geen beveiligingsgrens: gebruik het alleen op je eigen
computer, publiceer de poort op loopback (`127.0.0.1`) en stel het nooit bloot aan een netwerk. Het is de bedoeling
dat het in Fase B verdwijnt. Details: [docs/security.md](docs/security.md#preview-modus).

De licentie is **nog niet besloten** (open beslissing OD-01 in [docs/open-points.md](docs/open-points.md)); zolang
dat zo is, wordt er geen licentie verleend.

### Installeren in 5 minuten

Je hebt Docker nodig. De gepubliceerde image `ghcr.io/flux76hq/m365portal` bestaat pas na de eerste run van de
publish-workflow op GitHub, en die is nog niet geweest. Bouw hem tot die tijd zelf; het resultaat is hetzelfde:

```sh
docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .
```

Achter een proxy die TLS inspecteert voeg je het proxycertificaat toe als BuildKit-secret (het komt nooit in een
imagelaag): `--secret id=extra_ca,src=/pad/naar/ca-bundle.crt`. Waar Docker geen bridge-netwerk heeft, voeg je
`--network host` toe. Zonder `--build-arg VERSION` meldt de image bewust versie `unknown`.

Start hem (beoordelen in previewmodus, alleen loopback):

```sh
docker run -d --name m365portal -p 127.0.0.1:9300:9300 -v m365:/data \
  -e PREVIEW_MODE=true m365portal:local
```

Open <http://localhost:9300>. Voor de gepubliceerde image vervang je `m365portal:local` door
`ghcr.io/flux76hq/m365portal`. Zonder `PREVIEW_MODE` start het paneel ook, maar het toont alleen "geen toegang".

Met Docker Compose:

```sh
cp .env.example .env      # optioneel; zonder dit gelden alle standaardwaarden
docker compose up -d
```

Het Compose-bestand haalt de gepubliceerde image op; bouw vóór de eerste publish-run zoals hierboven en zet
`image: m365portal:local` in `docker-compose.yml`. Met hostnetwerk (`docker run --network host`) is `PORT` de
hostpoort.

**Poorten.** `PORT` is de poort in de container (1024 tot 65535, standaard 9300). `HOST_PORT` bestaat alleen in
Compose en is de poort die de browser gebruikt (standaard 9300). Elke schrijfactie wordt vergeleken met
`PUBLIC_BASE_URL`, dus die **moet gelijk zijn aan het adres in de adresbalk** (zonder pad). Wijzig de hostpoort met
Compose via `HOST_PORT=9090` in `.env` (`PUBLIC_BASE_URL` volgt); met `docker run` via
`-p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090`. Een verschil geeft `403 origin_not_allowed`, met de naam van
de variabele in de melding.

### Configuratie

De tabel in het Engelse deel geeft alle variabelen met hun standaardwaarde (`HOST_PORT`, `PORT`, `HOST`, `DATA_DIR`,
`PUBLIC_BASE_URL`, `TRUST_PROXY`, `PREVIEW_MODE`, `PREVIEW_MODE_ALLOW_REMOTE`, `SHOWCASE`, `LOG_LEVEL`,
`HSTS_MAX_AGE`, `HSTS_INCLUDE_SUBDOMAINS`, `HSTS_PRELOAD`); de volledige tabel met alle regels staat in
[docs/operations.md](docs/operations.md#environment-variables). Een ongeldige waarde stopt de start en noemt de
variabele.

### Hoe het eruitziet

![Dashboard, licht thema](docs/media/dashboard-light.png)
![Dashboard, donker thema](docs/media/dashboard-dark.png)
![Uiterlijk-instellingen, licht thema](docs/media/appearance-light.png)
![Uiterlijk-instellingen, donker thema](docs/media/appearance-dark.png)

![Demo: thema wisselen, opdrachtenpalet openen, accentkleur wijzigen en opslaan](docs/media/demo.gif)

De afbeeldingen worden met `pnpm media` gemaakt van de echte applicatie in previewmodus, met een verzonnen
organisatie en logo. Ze tonen het versienummer van de build waarmee ze zijn gemaakt en lopen achter na de volgende
versieverhoging.

### Wat je na de start controleert

1. `http://localhost:9300/healthz` geeft 200 met de versie (het proces leeft).
2. `http://localhost:9300/readyz` geeft 200 (de datamap is schrijfbaar, de database is open). Bij 503 staat de
   falende controle in het antwoord.
3. `docker ps` toont na ongeveer een halve minuut `healthy`.
4. In previewmodus: Instellingen, Uiterlijk: wijzig de naam of de accentkleur, sla op, laad opnieuw. De wijziging blijft.
5. Stop en start de container: de branding is er nog (die staat in het volume).

Wat er is uitgevoerd en waar: zie [de gate-notitie van de documentatie](specs/001-m365portal/gate-notes/G8.md).

### Grenzen als getallen

Alles wat voor het paneel staat (reverse proxy, firewall) moet verzoeken van **minstens 9.437.184 bytes** toestaan:
dat is het grootste verzoek, de brandingimport. Alle andere grenzen (afbeeldingsgrootte, aanvraaglimieten, time-outs,
quotum, bewaartermijn) staan als getallen in [docs/operations.md](docs/operations.md#limits-outside-the-repository) en
zijn eenmalig vastgelegd in `packages/shared`.

### Beveiliging

De container draait zonder rechten (uid 65532), met alleen-lezen rootbestandssysteem, alle capabilities weggehaald
en zonder shell. Het paneel zet in Fase A geen cookies en stuurt een strikte Content-Security-Policy met Trusted
Types. Geüploade afbeeldingen worden opnieuw gecodeerd; SVG wordt gezuiverd en gerasterd. Lees
[docs/security.md](docs/security.md) voordat je het ergens anders dan op je eigen computer neerzet. Meld kwetsbaarheden
privé bij de eigenaar van de repository, niet in een openbaar issue.

### Documentatie

- [docs/operations.md](docs/operations.md): installatie, poorten, omgeving, back-up, bijwerken, gezondheid, grenzen
- [docs/architecture.md](docs/architecture.md): onderdelen, verzoekpijplijn, prestatie-architectuur, afhankelijkheden, toegankelijkheid
- [docs/security.md](docs/security.md): dreigingsmodel, maatregelen, SVG-toegestane lijst, previewmodus
- [docs/permissions.md](docs/permissions.md): de rechtencatalogus en de Microsoft Graph- en Exchange-rechten voor latere fasen
- [docs/open-points.md](docs/open-points.md): open beslissingen, onbevestigde claims, aannames en risico's
- [docs/adr/](docs/adr/): architectuurbeslissingen (ADR-0001 en verder)
- [deploy/README.md](deploy/README.md): korte uitrolnotities; [specs/001-m365portal](specs/001-m365portal): de specificatie van Fase A

### Bijdragen

Lees eerst [AGENTS.md](AGENTS.md): versiebeheer, hooks en CI-controles, omgang met geheimen, het
documentatiecontract en de pull-requestwerkwijze. `pnpm docs:check` controleert de documentatie.
