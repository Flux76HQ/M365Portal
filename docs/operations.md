# Operations

> **Status:** Phase A. How to set up, run, stop, update, back up and monitor M365Portal, and the
> numbers that whatever sits in front of it must honour. Short deployment notes live in
> [`deploy/README.md`](../deploy/README.md). Nederlandse versie: zie [Nederlands](#nederlands).

## Setup

You need Docker (Compose v2 recommended). The image is `ghcr.io/flux76hq/m365portal`; it is built and
published by the `publish` workflow on GitHub, which has not run yet at the time of writing, so until
the first publish build the image yourself (below). The image has no shell and no curl; the process
runs as uid 65532 with all capabilities dropped.

```sh
cp .env.example .env     # optional: without a .env every default applies
docker compose up -d     # pulls the image and starts it
docker compose ps        # "healthy" after about half a minute (the first health check)
```

The panel answers on `http://localhost:9300`. To build the image from a checkout, pass the version
(without it the version label says `unknown` on purpose and the contents check and smoke test refuse
the image):

```sh
docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .
```

### Ports

Two ports, two meanings (FR-A-016, A-63). `PORT` is the port the process listens on **inside** the
container (1024 to 65535; the container is unprivileged). `HOST_PORT` is the port published on the
Docker host; it exists only in Compose and `.env.example`, and the application never reads it. The
browser reaches the panel on the **host** port, and every write is compared with the origin of
`PUBLIC_BASE_URL`, so a changed host port needs a matching `PUBLIC_BASE_URL`.

| Situation | Settings |
|---|---|
| Default | `docker run -p 9300:9300 ...`, nothing else |
| Another host port, plain `docker run` | `docker run -p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090 ...` |
| Another container port | `docker run -p 9090:9090 -e PORT=9090 -e PUBLIC_BASE_URL=http://localhost:9090 ...` |
| Compose | `HOST_PORT=9090` in `.env`; the mapping is `'${HOST_PORT:-9300}:${PORT:-9300}'` and `PUBLIC_BASE_URL` defaults to `http://localhost:${HOST_PORT:-9300}` |
| Low host port (80, 443) | `HOST_PORT=80`, never a low `PORT` |
| `network_mode: host` | `PORT` is the host port |

A host port changed without `PUBLIC_BASE_URL` shows up as `403 origin_not_allowed`; the problem names
the expected origin and the variable.

### Environment variables

Configuration is environment variables plus the `/data` volume, nothing else. The table equals the
configuration schema (`ENV_VARIABLES`) plus `HOST_PORT`, and `.env.example`; a test compares them. An
invalid value stops the start and names the variable, never its value. Do not commit `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `HOST_PORT` | `9300` | Compose only, not read by the application: the port published on the Docker host. With `docker run` publish with `-p <host port>:<PORT>`. |
| `PORT` | `9300` | The port the process listens on inside the container, an integer from 1024 to 65535. Anything else (0, below 1024, above 65535, empty, with whitespace, non-numeric) stops the start. |
| `HOST` | `0.0.0.0` | The address the process binds to inside the container. A published port needs `0.0.0.0`. Compose does not pass it on. The image health check asks 127.0.0.1, so a single non-loopback address makes the check fail although the server is fine. |
| `DATA_DIR` | `/data` | Where the database and files live; must match the volume mount. Compose does not pass it on. |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` (Compose: with `HOST_PORT`) | The origin the browser uses: an absolute `http` or `https` origin without path, query or credentials. Every write is compared with it. Leave it unset in `.env` while the panel is reached on `http://localhost:<HOST_PORT>`; set it behind a reverse proxy (for example `https://panel.example.com`). |
| `TRUST_PROXY` | `none` | `none`, a number of proxies in front (1 to 8), or a comma-separated list (at most 32) of IP addresses or CIDR ranges to trust. See the checklist below. |
| `PREVIEW_MODE` | `false` | `true` or `false`. Unauthenticated administration for evaluation only. Publish the port on loopback only. |
| `PREVIEW_MODE_ALLOW_REMOTE` | `false` | `true` or `false`. Lets preview mode start with a non-loopback `PUBLIC_BASE_URL`. Never on a panel that anyone else can reach. |
| `SHOWCASE` | `false` | `true` or `false`. Serves the `/design` component showcase. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. |
| `HSTS_MAX_AGE` | `31536000` | Seconds, 0 to 63072000, for `Strict-Transport-Security` (sent over https only). |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | `true` or `false`. Adds `includeSubDomains`, only on the host of `PUBLIC_BASE_URL`. |
| `HSTS_PRELOAD` | `false` | `true` or `false`. Adds `preload` on that host; refused at start without `HSTS_INCLUDE_SUBDOMAINS=true` and a `HSTS_MAX_AGE` of at least 31536000. |

**HSTS opt-ins.** `includeSubDomains` is a promise about every subdomain, for the whole `max-age`, in
every browser that saw it once; `preload` asks browser vendors to hard-code the host and cannot easily be
undone (baseline section 13). Turn them on only for hosts you own and have put under https. Plain
`max-age` is sent on every https response regardless.

### Run with docker run

```sh
docker run -d --name m365portal -p 9300:9300 -v m365:/data --stop-timeout 15 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/flux76hq/m365portal:latest
```

For preview mode publish on loopback only: `-p 127.0.0.1:9300:9300 -e PREVIEW_MODE=true`. A named
volume inherits the ownership of the image's `/data` (uid 65532). A bind mount must be prepared:
`chown 65532:65532 /path/to/data`. If the process cannot write `DATA_DIR`, the panel starts in degraded
mode (below) and `/readyz` says `data_dir_not_writable`.

## Run and stop

| Action | Command |
|---|---|
| Start | `docker compose up -d` |
| Follow the logs | `docker compose logs -f m365portal` (JSON lines on stdout) |
| Stop | `docker compose stop`, or `docker compose down` (removes the container, keeps the volume) |
| Restart | `docker compose restart` |

Stopping sends `SIGTERM`. The application stops accepting connections, sends `Connection: close`,
closes idle connections, kills image child processes, drains in-flight requests for up to 10 seconds,
checkpoints the WAL (`wal_checkpoint(TRUNCATE)`), closes the database and exits 0 (exit 1 if the drain
timed out). `docker stop` must therefore wait at least 10 seconds; Docker's default is exactly 10, and
the Compose example and the `docker run` line above ask for 15.

## Health endpoints

Both are public, `no-store` and exempt from rate limiting.

| Endpoint | Meaning |
|---|---|
| `/healthz` | Liveness: the process runs, also in degraded mode. 200 with the version. Asks nothing of storage. |
| `/readyz` | Readiness: 200 when the data directory is writable, the database is open and the schema is the one this build expects; otherwise 503 with the failing check and one code: `data_dir_not_writable`, `database_unavailable`, `database_corrupt` or `schema_newer_than_app`. The write probe is cached for 2 seconds. |

The image `HEALTHCHECK` is a Node script (`dist/healthcheck.js`) that asks `/readyz` on `127.0.0.1` and
the configured `PORT`, so an unusable volume shows as `unhealthy`. `GET /api/v1/me` answers
`storageAvailable` for the UI.

## Runtime architecture

One process, one container, one volume. Components and the request pipeline are in
[architecture.md](architecture.md); the data locations are:

| Path | Content |
|---|---|
| `/data/m365portal.sqlite` (+ `-wal`, `-shm` while open) | The database (WAL mode) |
| `/data/branding/<sha256>.png`, `/data/branding/.tmp/` | Logos and icons by content hash; staging for atomic writes |
| `/data/backups/pre-migrate-<from>-<to>.sqlite` | Copies taken before pending migrations; the newest 3 are kept |

**Single replica, local disk.** SQLite in WAL mode needs shared memory on one host and does not work
over a network file system (NFS, SMB and many NAS volumes). Run exactly one replica and keep `/data` on
a local disk or a Docker volume on a local disk; never mount one volume into two containers. Rate-limit
buckets and the CSRF key live in memory and reset on restart. Locking keeps the data consistent if you
break the rule, but readiness may report `storage_busy`.

The application checks for timed-out connections every 5 seconds (not a limit, so it is not in the table below). Requests the HTTP parser rejects before routing are answered 400, 408 or 431 with a problem body.

**Start sequence.** Parse the configuration (invalid: exit 1, variable names only); `umask 077`;
locate the built frontend (missing: exit 1); probe `DATA_DIR` (not writable: **degraded mode**); open
the database; run migrations (a changed migration file, `migration_checksum_mismatch`, or a database from
a newer version, `schema_newer_than_app`, exits 1 and leaves the database untouched); sweep temporary
files; create the default branding row; check the route table; listen; schedule the hourly sweepers.

**Degraded mode** (storage unusable at start): `/healthz` 200; `/readyz` 503 with the code; `/api/v1/me`
works with `storageAvailable: false`; every route that needs storage answers 503 `storage_unavailable`
(a denied write is a 503 too, because its audit entry cannot be written); the UI shows a storage page
with the remedy (`chown 65532:65532` or a named volume). Later failures (volume turns read-only or
full) answer 503 `storage_unavailable` or `storage_busy` with `Retry-After: 1`; nothing is half-applied.
A corrupt database is never repaired automatically.

**Symptoms.**

| You see | Likely cause |
|---|---|
| `403 origin_not_allowed` on every save | `PUBLIC_BASE_URL` does not match the address in the browser (changed host port, or https behind a proxy) |
| `429 rate_limited` for everybody | `TRUST_PROXY` too narrow: every visitor shares the proxy's address |
| `/readyz` 503 `data_dir_not_writable` | A bind mount owned by someone else: `chown 65532:65532`, or use a named volume |
| `/readyz` 503 `schema_newer_than_app` | An older image started on a newer database; run the newer image or restore a backup |
| Container exits 1 at start | Invalid configuration (names the variable), a changed migration, a missing frontend build, or a port in use |
| `branding_asset_missing` in the log | A referenced logo file is gone; the UI falls back to the monogram; export answers 500 until the branding is applied or reset again |
| 502 from the proxy now and then | The proxy's idle timeout towards the panel is not shorter than the keep-alive of 65 seconds |

## Deploy and update

Pin a version tag or, better, an image digest instead of `latest` in `docker-compose.yml`, so an update
is your decision and a rollback is a one-line change. To update:

```sh
docker compose pull
docker compose up -d
```

On start, pending migrations run in one transaction. Before them the application writes a consistent
copy of the database to `backups/pre-migrate-<from>-<to>.sqlite` (none on a first install) and keeps the
newest 3; if the copy cannot be written, nothing is migrated. Migrations are forward-only: an older
image refuses a newer database. To go back, stop the container, restore the backup you took before the
update (below) and start the older image. After an update check `/readyz` and, if you keep the head of
the audit chain (below), run `verify-audit`.

### Reverse proxy and HTTPS

The application serves plain HTTP. For https put a reverse proxy in front;
[`deploy/caddy/Caddyfile.example`](../deploy/caddy/Caddyfile.example) shows Caddy with an automatic
certificate (its directives were checked against Caddy's documentation, not executed). Checklist for
`TRUST_PROXY` (mis-setting it is E-15):

- Set `PUBLIC_BASE_URL` to the public `https://` origin.
- Set `TRUST_PROXY` to the number of proxies in front, or to the list of their addresses. With `none`
  every visitor shares the proxy's address and therefore one rate limit; a value that is too wide lets a
  client forge its address with `X-Forwarded-For`. Never `1` without a proxy.
- **Preserve the `Host` header.** The HSTS flags and the preview-mode rule depend on it.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto` yourself and drop what the client sent; the panel
  trusts them only from the proxies in `TRUST_PROXY`.
- **Never cache the HTML shell.** Every page carries a per-request nonce in its security policy, so a
  cached page is a broken page.
- Run one replica.

## Backup and restore

Stop the container, copy **all of `/data`** (the database, any `-wal` and `-shm` files, and `branding/`,
which must be copied together with the database because the registry rows and the files must match),
start it again. Without stopping, the copy may be slightly inconsistent: not recommended. The automatic
pre-migration copy is a convenience, not a substitute. Backups contain the audit log and therefore
client addresses: they are personal data like the live database, so protect them the same way.

```sh
docker compose stop
docker run --rm -v m365portal_data:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/m365portal-data.tgz -C /data .
docker compose start
```

To restore, stop the container and put the files back with the same ownership (uid 65532):

```sh
docker compose stop
docker run --rm -v m365portal_data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.tmp && tar -xzf /backup/m365portal-data.tgz -C /data && chown -R 65532:65532 /data'
docker compose start
```

These two commands are examples; they were not run for this document. For a bind mount, copy the
directory and run `chown -R 65532:65532` on it. Staged but unused logos are deleted after 24 hours and
retired derived files within an hour, so a restore may legitimately lack them.

### Checking the audit chain

`docker exec m365portal /nodejs/bin/node dist/cli.js verify-audit` prints one JSON line and exits 0
(chain intact, all three append-only triggers present), 1 (broken chain, missing trigger or anchor
mismatch) or 2 (could not check). The chain alone cannot see rows deleted from the end of the log: record
the newest `seq` and `hash` (the `audit_head` log line) and pass them as `--expect-seq` and
`--expect-hash`. Details and limits are in [security.md](security.md#audit-chain).

### Retention and audit growth

Audit entries are kept indefinitely until Phase D defines retention (OD-10). Anonymous denied writes
are audited too, so an unauthenticated client can make the audit table grow without bound: each client
address is limited by the `write` bucket, but many source addresses (an IPv6 range, a too-wide
`TRUST_PROXY`) multiply it. Watch the size of `/data`; a global cap on denial rows is an open decision
(R-09). Backups keep only the newest 3 pre-migration copies; unreferenced images 24 hours.

## Limits outside the repository

The repository ships no reverse proxy, CDN or ingress, so it has no limits of its own outside the
application. Every limit on the path from the client to the application is documented here as a number,
with what enforces it and which limit it constrains. Whatever sits in front of the application must allow
request bodies of at least 9,437,184 bytes (the branding import, the largest request), must not cache
HTML, and must preserve the `Host` header.

| Limit | Value | Enforced by | Constrains |
|---|---|---|---|
| JSON request body (all JSON routes except import) | 262,144 bytes (256 KiB) | the app, while streaming | 413 `payload_too_large` |
| Logo file | 2,097,152 bytes (2 MiB) | the app | one image |
| Logo upload request body | 2,162,688 bytes (2 MiB plus 64 KiB envelope) | the app | upload route |
| Branding import request body (the largest request) | 9,437,184 bytes (9 MiB) | the app | import route. Derivation: three images of 2,097,152 bytes are 2,796,204 base64 characters each, 8,388,612 in total; plus 65,536 for the JSON that is 8,454,148, rounded up to 9 MiB. Whatever sits in front must allow at least 9,437,184 bytes. |
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

The single source of every number is `packages/shared/src/limits.ts` (`LIMITS`); this table is a
mirror, compared with it by `limits-doc.test.ts`. A pull request that raises a size, rate or timeout
limit states the new value as a number, never as one proxy's setting. The measured image size of the
first local build was 193.5 MB against the ceiling.

## Repository settings (recommended)

These are settings of the GitHub repository, not code, and an agent cannot change them. The default
branch setting must be `main` (the owner's decision). Recommended: a **merge queue**, or "require
branches to be up to date before merging", so that a green check on an old base does not merge;
required status checks `quality`, `e2e`, `image`, `enforce-version-bump` and `agent-instructions-lint`;
secret scanning and push protection on; Dependabot alerts on.

## Nederlands

### Installatie

Je hebt Docker nodig (Compose v2 aanbevolen). De image is `ghcr.io/flux76hq/m365portal`; de `publish`-workflow
op GitHub bouwt en publiceert hem en heeft bij het schrijven nog niet gedraaid, dus bouw de image tot die tijd
zelf met `docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .` (zonder het argument
staat het versielabel bewust op `unknown`). Daarna: `cp .env.example .env` (optioneel) en
`docker compose up -d`. Het paneel antwoordt op `http://localhost:9300`; `docker compose ps` toont
"healthy" na ongeveer een halve minuut. De container draait als uid 65532 zonder capabilities en zonder shell.

### Poorten en omgevingsvariabelen

`PORT` is de poort in de container (1024 tot en met 65535), `HOST_PORT` de poort op de Docker-host (alleen
Compose en `.env.example`; de applicatie leest hem nooit) en `PUBLIC_BASE_URL` de oorsprong die de browser
gebruikt. Elke schrijfactie wordt daarmee vergeleken, dus bij een andere hostpoort hoort een passende
`PUBLIC_BASE_URL`: met Compose volgt hij `HOST_PORT` zolang je hem niet zelf instelt; met `docker run`
gebruik je `-p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090`. Een lage hostpoort (80, 443) haal je via
`HOST_PORT`, nooit via een lage `PORT`. Bij `network_mode: host` is `PORT` de hostpoort. Een fout hier geeft
`403 origin_not_allowed`, met de verwachte oorsprong in de melding.

De tabel met omgevingsvariabelen hierboven is gelijk aan het configuratieschema plus `HOST_PORT` en aan
`.env.example`. Een ongeldige waarde stopt het opstarten en noemt de variabele, nooit de waarde. De
HSTS-opties `HSTS_INCLUDE_SUBDOMAINS` en `HSTS_PRELOAD` zijn bewuste keuzes van de operator en gelden alleen
voor de host van `PUBLIC_BASE_URL`; `preload` vraagt `includeSubDomains` en een `max-age` van minimaal
31536000 en laat zich lastig terugdraaien. Gewone `max-age` wordt op elke https-respons gestuurd.

### Starten en stoppen

Starten: `docker compose up -d`. Stoppen: `docker compose stop` (of `down`; het volume blijft). Bij `SIGTERM`
stopt de applicatie met accepteren, sluit inactieve verbindingen, wacht maximaal 10 seconden op lopende
verzoeken, schrijft de WAL weg en eindigt met code 0 (code 1 als de wachttijd verstreken is). `docker stop`
moet dus minstens 10 seconden wachten; het Compose-voorbeeld en de `docker run`-regel vragen 15.

### Gezondheidscontroles

`/healthz` zegt dat het proces draait (ook in degraded mode). `/readyz` zegt of het werk kan: map
schrijfbaar, database open, schema passend; anders 503 met `data_dir_not_writable`, `database_unavailable`,
`database_corrupt` of `schema_newer_than_app`. De Docker-`HEALTHCHECK` is een Node-script dat `/readyz` op
127.0.0.1 en `PORT` vraagt.

### Architectuur tijdens het draaien en degraded mode

Eén proces, één container, één volume: `/data` bevat de database (`m365portal.sqlite`, met `-wal` en `-shm`
zolang hij open is), `branding/` en `backups/`. Draai precies één replica en houd `/data` op een lokale
schijf: SQLite in WAL-modus werkt niet over een netwerkbestandssysteem (NFS, SMB, veel NAS-volumes). Een
bind mount heeft `chown 65532:65532` nodig; een benoemd volume erft de eigenaar van de image. Als de map niet
schrijfbaar is of de database niet opent, start het paneel in degraded mode: `/healthz` 200, `/readyz` 503,
opslagroutes antwoorden 503 `storage_unavailable` en de UI toont de oplossing. Een gewijzigd
migratiebestand of een database van een nieuwere versie stopt het opstarten met code 1.

### Deployen en bijwerken

Zet in productie een versietag of digest in `docker-compose.yml` in plaats van `latest`. Bijwerken:
`docker compose pull` en `docker compose up -d`. Vóór openstaande migraties maakt de applicatie zelf een kopie
in `backups/` (de nieuwste 3 blijven). Migraties gaan alleen vooruit: een oudere image weigert een nieuwere
database; terugdraaien betekent de back-up van vóór de update terugzetten.

### Reverse proxy

Het paneel spreekt HTTP; zet er voor https een reverse proxy voor (zie `deploy/caddy/Caddyfile.example`).
Checklist `TRUST_PROXY`: zet `PUBLIC_BASE_URL` op de https-oorsprong; zet `TRUST_PROXY` op het aantal proxy's
(te smal: alle bezoekers delen één rate limit; te ruim: `X-Forwarded-For` is te vervalsen); geef de
`Host`-header ongewijzigd door; stuur `X-Forwarded-*` zelf en verwijder wat de client stuurde; cache de
HTML nooit (elke pagina heeft een nonce per verzoek); één replica.

### Back-up en terugzetten

Stop de container, kopieer **alles in `/data`** inclusief `-wal` en `-shm` en de map `branding/` (die moet
samen met de database gekopieerd worden, want register en bestanden horen bij elkaar), en start weer. Terugzetten:
stop, kopieer terug met eigenaar uid 65532, start. Back-ups bevatten het auditlog en dus clientadressen:
persoonsgegevens, beveilig ze zoals de database. Met `verify-audit` controleer je de auditketen; bewaar de
nieuwste `seq` en `hash` (logregel `audit_head`) en geef ze mee als `--expect-seq` en `--expect-hash`, want
de keten alleen ziet niet dat rijen aan het einde verwijderd zijn. Anonieme geweigerde schrijfacties worden
ook gelogd en laten de audittabel dus onbegrensd kunnen groeien; houd de omvang van `/data` in de gaten
(retentie volgt in Fase D).

### Grenzen buiten de repository

De repository levert zelf geen reverse proxy, CDN of ingress en heeft dus buiten de applicatie geen eigen
grenzen. Alles wat ervoor staat moet verzoeken met een body van minimaal 9437184 bytes (9 MiB, de
branding-import, het grootste verzoek) doorlaten, mag HTML niet cachen en moet de `Host`-header behouden.
De tabel hierboven noemt alle 25 grenzen als getal, met wat ze afdwingt en wat ze begrenst; de bron van elk
getal is `packages/shared/src/limits.ts`. Belangrijk voor wat ervoor staat: de keep-alive van het paneel is
65 seconden (de idle-timeout van de proxy richting het paneel moet korter zijn, bijvoorbeeld 60 seconden),
het ontvangen van een verzoek mag tot 60 seconden duren, en `docker stop` moet minstens 10 seconden wachten.

### Aanbevolen repository-instellingen

Dit zijn instellingen van de GitHub-repository, geen code: een merge queue of "branches moeten up-to-date
zijn", verplichte checks (`quality`, `e2e`, `image`, `enforce-version-bump`, `agent-instructions-lint`),
secret scanning en push protection. De standaardbranch is `main`.
