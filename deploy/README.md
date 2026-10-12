# Deployment notes

How to run M365Portal from the published image, and what has to be true of anything you put in front
of it. The full operating guide (setup, update, backup and restore, the complete limits table) is
[docs/operations.md](../docs/operations.md). This folder holds the files and the numbers that belong
with a deployment. The Dutch version of the main points is at the end ([Nederlands](#nederlands)).

| File | What it is |
|---|---|
| [`docker-compose.yml`](../docker-compose.yml) | A hardened Compose example: read-only root file system, all capabilities dropped, memory, CPU and process limits, a named volume at `/data`, a health check |
| [`.env.example`](../.env.example) | Every setting with its default. Copy it to `.env`; the file is optional |
| [`caddy/Caddyfile.example`](caddy/Caddyfile.example) | An optional Caddy reverse proxy with an automatic certificate |

Phase D adds an Azure Bicep example and a custom seccomp profile to this folder. Neither exists in
Phase A, and nothing here depends on them.

## Run it with Compose

```sh
cp .env.example .env     # optional: without a .env every default applies
docker compose up -d     # pulls ghcr.io/flux76hq/m365portal and starts it
docker compose ps        # "healthy" after about half a minute (the first health check)
```

The panel answers on `http://localhost:9300`. Stop it with `docker compose down`; the data stays in
the named volume `data`, which Compose creates as `m365portal_data`. To update, run
`docker compose pull` and then `docker compose up -d`.

The image is not built by Compose. In production, replace `latest` in `docker-compose.yml` by a
version tag or, better, a digest, so that an update is a decision of yours.

Without Compose, the same image runs with
`docker run -p 9300:9300 -v m365:/data ghcr.io/flux76hq/m365portal`.

## Two ports, two meanings

| Setting | Meaning | Default |
|---|---|---|
| `PORT` | The port the process listens on **inside** the container (1024 to 65535: the container is unprivileged) | `9300` |
| `HOST_PORT` | The port published on the Docker host, the one the browser connects to. Compose reads it; the application never does | `9300` |
| `PUBLIC_BASE_URL` | The origin the browser uses. Every write is compared with it, so it must match | `http://localhost:` followed by `HOST_PORT` |

- Another host port with Compose: set `HOST_PORT=9090` in `.env`. `PUBLIC_BASE_URL` follows, as long
  as `.env` leaves it unset.
- Another host port with `docker run`: `-p 9090:9300 -e PUBLIC_BASE_URL=http://localhost:9090`.
- A low host port (80, 443) is reached with `HOST_PORT`, never with a low `PORT`.
- With `network_mode: host` there is no mapping, and `PORT` is the host port.
- A host port that was changed without `PUBLIC_BASE_URL` shows up as `403 origin_not_allowed`; the
  problem names the expected origin and the variable.
- Before the wizard has run, the setup gate is the only thing the panel answers, protected by the setup
  token. For a trial on your own computer publish the port on loopback only:
  `127.0.0.1:${HOST_PORT:-9300}:${PORT:-9300}` in the `ports` list.

## HTTPS and a reverse proxy

The application serves plain HTTP. For HTTPS, put a reverse proxy in front.
[`caddy/Caddyfile.example`](caddy/Caddyfile.example) shows one with Caddy and an automatic
certificate. Whatever you use has to do the following.

- Set `PUBLIC_BASE_URL` to the public `https://` origin, for example `https://panel.example.com`.
- Set `TRUST_PROXY` to the number of proxies in front (`1` for one), or to the list of their
  addresses. With the default `none` every visitor shares the address of the proxy, and therefore
  one rate limit. A wrong value lets a client forge its address.
- Pass the `Host` header on unchanged. The HSTS rule compares it with the host of `PUBLIC_BASE_URL`.
- Set `X-Forwarded-For` and `X-Forwarded-Proto` yourself and drop whatever the client sent. The
  panel trusts them only from the proxies named in `TRUST_PROXY`.
- Do not cache the HTML. Every page carries a per-request nonce in its security policy, so a cached
  page is a broken page.
- Run exactly one replica, with `/data` on a local disk: SQLite in WAL mode does not work over a
  network file system, and two containers must not share one volume.

## Numbers whatever sits in front must honour

A request reaches the application through things it does not own: a proxy, a CDN, an ingress. The
one that refuses first answers with its own error, and the application never sees the request. These
are the numbers, not one product's settings. The complete table is in
[docs/operations.md](../docs/operations.md#limits-outside-the-repository).

| What | Number | Meaning for what is in front |
|---|---|---|
| Request body | at least 9,437,184 bytes (9 MiB) | The branding import is the largest request. A lower limit makes it fail before the application can explain why |
| Request header size | 16,384 bytes | The application refuses more; a proxy may be stricter, never needs to be looser |
| Time to send a request | 15 s for the headers, 60 s for the whole request | A proxy must not give up on a slow upload before 60 s |
| Keep-alive | 65 s | The application closes an idle connection after 65 s. The idle timeout of the proxy towards the panel must be shorter, for example 60 s, or the proxy reuses connections that are already closed and answers 502 |
| Stop grace | at least 10 s | The application drains for up to 10 s on `SIGTERM`. `docker stop` and the orchestrator must wait at least that long. Compose asks for 15 s |

## Backup, restore, update

Stop the container, copy all of `/data` (including any `-wal` and `-shm` files), start it again. To
restore, copy it back. Before a database migration the application makes a copy of its own. The
steps, with the commands, are in [docs/operations.md](../docs/operations.md).

## Nederlands

Hoe je M365Portal draait vanaf de gepubliceerde image, en wat waar moet zijn voor alles wat je er
voor zet. De volledige beheerhandleiding staat in [docs/operations.md](../docs/operations.md).

- **Starten**: `cp .env.example .env` (optioneel) en `docker compose up -d`. Het paneel luistert op
  `http://localhost:9300`. Stoppen met `docker compose down`; de gegevens blijven in het volume.
- **Poorten**: `PORT` is de poort in de container, `HOST_PORT` de poort op de Docker-host (alleen
  Compose leest die), `PUBLIC_BASE_URL` de oorsprong die de browser gebruikt. Wijzig je `HOST_PORT`,
  dan volgt `PUBLIC_BASE_URL` vanzelf zolang je die niet zelf instelt. Een lage hostpoort (80, 443)
  haal je via `HOST_PORT`, nooit via een lage `PORT`.
- **HTTPS**: het paneel spreekt gewoon HTTP; zet er een reverse proxy voor, bijvoorbeeld Caddy
  ([voorbeeld](caddy/Caddyfile.example)). Zet `PUBLIC_BASE_URL` op de https-oorsprong en
  `TRUST_PROXY` op het aantal proxy's ervoor, geef de `Host`-header ongewijzigd door en cache de
  HTML niet.
- **Getallen waar alles ervoor aan moet voldoen**: een request body van ten minste 9437184 bytes
  (9 MiB, de branding-import), een keep-alive van 65 s in het paneel (de idle-timeout van de proxy
  richting het paneel moet korter zijn, bijvoorbeeld 60 s) en een stop-termijn van ten minste 10 s
  (Compose vraagt 15 s). De volledige tabel staat in
  [docs/operations.md](../docs/operations.md#limits-outside-the-repository).
- **Fase D** voegt een Azure Bicep-voorbeeld en een eigen seccomp-profiel toe aan deze map.
