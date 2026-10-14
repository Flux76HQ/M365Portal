# Operations

> **Status:** Phase D step D1 (the Exchange worker and the Ubuntu image are new; the rest is as in Phase B and C). How to set up, run, stop, update, back up and monitor M365Portal, and the
> numbers that whatever sits in front of it must honour. Short deployment notes live in
> [`deploy/README.md`](../deploy/README.md). Nederlandse versie: zie [Nederlands](#nederlands).

## Setup

You need Docker (Compose v2 recommended). The image is `ghcr.io/flux76hq/m365portal`; it is built and
published by the `publish` workflow on GitHub, which has not run yet at the time of writing, so until
the first publish build the image yourself (below). Since Phase D step D1 the image is Ubuntu 24.04 with
PowerShell: it has a shell (`sh`) but no curl; the process runs as uid 65532 with all capabilities dropped
([the image and the worker](#the-exchange-worker-phase-d-step-d1)).

```sh
cp .env.example .env     # optional: without a .env every default applies
mkdir -p secrets && docker run --rm -i ghcr.io/flux76hq/m365portal:latest dist/cli.js generate-app-key > secrets/app_key
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
| `SHOWCASE` | `false` | `true` or `false`. Serves the `/design` component showcase. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. |
| `HSTS_MAX_AGE` | `31536000` | Seconds, 0 to 63072000, for `Strict-Transport-Security` (sent over https only). |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | `true` or `false`. Adds `includeSubDomains`, only on the host of `PUBLIC_BASE_URL`. |
| `HSTS_PRELOAD` | `false` | `true` or `false`. Adds `preload` on that host; refused at start without `HSTS_INCLUDE_SUBDOMAINS=true` and a `HSTS_MAX_AGE` of at least 31536000. |
| `APP_KEY` | `unset` | Secret. The key that seals the secrets in the database: 32 bytes as base64, base64url or 64 hexadecimal characters, at least 16 distinct byte values. Exactly one of `APP_KEY` and `APP_KEY_FILE`; neither is allowed until the setup wizard runs. Never in `.env.example`. |
| `APP_KEY_FILE` | `unset` | Absolute path of a readable file (at most 1,024 bytes, one trailing newline ignored) that holds the key. Exclusive with `APP_KEY`. |
| `APP_KEY_PREVIOUS` | `unset` | Secret. The previous key, set only while the key is rotated. Exclusive with `APP_KEY_PREVIOUS_FILE`. |
| `APP_KEY_PREVIOUS_FILE` | `unset` | Absolute path of a file that holds the previous key. |
| `SETUP_TOKEN` | `unset` | Secret. The setup token of the first installation: 24 to 128 characters from `A-Z a-z 0-9 - _ . ~`, at least 12 distinct. Unset: a token file in the data directory is used. |
| `BOOTSTRAP_CLIENT_ID` | `14d82eec-204b-4c2f-b7e8-296a70dab67e` | The public client of the device-code sign-in of the setup wizard, a GUID (stored in lower case). |
| `SETUP_PROPAGATION_TIMEOUT_SECONDS` | `900` | Seconds the wizard waits for a role to propagate: 60 to 3600. |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `30` | Minutes without activity before a session ends: 5 to 480. |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `8` | Hours a session lasts at most: 1 to 24; hours x 60 must be greater than the idle minutes. |
| `GROUP_CACHE_TTL_SECONDS` | `300` | Seconds a group membership is cached: 30 to 3600. |
| `AUTH_REQUIRE_MFA` | `true` | `true` or `false`. Requires a multi-factor sign-in from Microsoft Entra. |
| `AUTH_MFA_AMR_VALUES` | `mfa,multipleauthn` | The `amr` values that count as multi-factor: 1 to 8 distinct comma-separated values of 2 to 32 characters from `a-z 0-9`; `pwd`, `wia` and `x509` are refused. |
| `BREAK_GLASS_USERNAME` | `unset` | The break-glass account: 3 to 64 characters from `A-Z a-z 0-9 . _ -`. Both break-glass variables, or neither. |
| `BREAK_GLASS_PASSWORD_HASH` | `unset` | Secret. The `scrypt:` line that `hash-password` writes; no `$`. |
| `EXCHANGE_KEY_HANDOVER` | `memory` | `memory` or `tmpfs`. How the Exchange certificate reaches the PowerShell worker: `memory` sends it over the pipe and writes nothing; `tmpfs` is the fallback that writes a file with mode 0600 to a private directory on a tmpfs (`/dev/shm`) for the time of the connection and removes it again (refused at the first use when that directory is not a tmpfs). |
| `EXCHANGE_DEBUG_ERRORTEXT` | `unset` | Troubleshooting only, off by default. `1` makes the worker add a masked, truncated error text to a failed Exchange call and the server log it (see [Temporary diagnostics](#temporary-diagnostics-exchange_debug_errortext)); `0` is the explicit off; anything else, an empty value included, stops the start. Remove it when you are done. |

**HSTS opt-ins.** `includeSubDomains` is a promise about every subdomain, for the whole `max-age`, in
every browser that saw it once; `preload` asks browser vendors to hard-code the host and cannot easily be
undone (baseline section 13). Turn them on only for hosts you own and have put under https. Plain
`max-age` is sent on every https response regardless.

### Run with docker run

```sh
docker run -d --name m365portal -p 9300:9300 -v m365:/data --stop-timeout 15 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e APP_KEY="$(cat secrets/app_key)" ghcr.io/flux76hq/m365portal:latest
```

`APP_KEY` on the command line is visible to `docker inspect`; prefer `-v $PWD/secrets/app_key:/run/secrets/app_key:ro`
with `-e APP_KEY_FILE=/run/secrets/app_key`, or a platform secret. A named volume inherits the ownership of the image's `/data` (uid 65532). A bind mount must be prepared:
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
buckets, the CSRF key and the list cursors of Users and Groups live in memory and reset on restart (a lost
cursor is answered 400 `cursor_invalid` and the page starts the list again). Locking keeps the data consistent if you
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
- **Preserve the `Host` header.** The HSTS flags, the loopback rule of the setup gate and the Origin check depend on it.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto` yourself and drop what the client sent; the panel
  trusts them only from the proxies in `TRUST_PROXY`.
- **Never cache the HTML shell.** Every page carries a per-request nonce in its security policy, so a
  cached page is a broken page.
- Forward cookies and the `Set-Cookie` header unchanged, and do not rewrite redirects: the sign-in is a
  chain of redirects that carries cookies.
- Allow request bodies of at least 9,437,184 bytes (the branding import).
- Restrict `/api/v1/auth/break-glass` by address at the proxy when you use break-glass (below).
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

## First installation, the setup token and setup-reopen

A new panel is `unconfigured`: it answers the setup gate and nothing else. The setup token protects the
gate. It is generated into `/data/setup-token` at the first start (mode 0600, never logged); print it with
`docker exec <container> /nodejs/bin/node dist/cli.js setup-token`. The image's working directory is `/app`,
so `node dist/cli.js` works inside the container as well; the image smoke test runs exactly this command
(U34 is closed by it). You can set `SETUP_TOKEN` yourself (24 to 128 characters). Remove or unset
`SETUP_TOKEN` after the first installation: a variable outlives the wizard as a standing credential, and
`setup-reopen` refuses while it is set.

The wizard locks at the first successful sign-in of the designated first Owner, not at "finish". Until
then the token still guards the gate. A failed first sign-in (a wrong redirect URI, blocked MFA) therefore
does not strand you. After the lock `/setup` answers 404 and a restart does not reopen it.

`setup-reopen --confirm` is the way back (a lost Owner, a changed tenant, a changed `PUBLIC_BASE_URL`): it sets
the state back to `in_progress`, issues a new token and writes the audit entry `setup.reopen`. Signed-in users
stay signed in, but sign-in is refused for everyone until the wizard has finished again (`setup_required`), so
reopen only when you can finish the wizard. If `PUBLIC_BASE_URL` is changed (a new domain or port) the
registered redirect URIs no longer match: run `setup-reopen` and then repair the connection in the wizard,
which updates the redirect URIs and nothing else that is correct already. A trial without https works on
`http://localhost` only; every other address needs https.

## The sealing key (`APP_KEY`)

`APP_KEY` seals the private key of the application's certificate (XChaCha20-Poly1305, a subkey per purpose, a
key id in every blob). Without it a stored certificate cannot be used: the panel starts in a degraded state
that says so, and signing in is impossible.

**Generate.** `docker run --rm -i <image> dist/cli.js generate-app-key` prints 32 random bytes as base64.
Put the output in `secrets/app_key` for Compose (a Docker secret, mounted as `/run/secrets/app_key`, read
through `APP_KEY_FILE`) or in a platform secret store (a Key Vault reference or a platform secret of your host
that reaches the container as `APP_KEY` or `APP_KEY_FILE`). Set exactly one of `APP_KEY` and `APP_KEY_FILE`.
`-e APP_KEY=...` is visible to `docker inspect` and to everyone who can read the container configuration.

**Back up the key separately from the data volume.** Whoever holds the key and `/data` holds the certificate.
If the key is lost the sealed private key is unrecoverable: the recovery is a new certificate through the
repair flow, which needs a Microsoft administrator. Keep at least one copy of the key offline.

**Rotate** (a routine, or after a suspicion): create a new key, start the container with the new key as
`APP_KEY` (or `APP_KEY_FILE`) and the old key as `APP_KEY_PREVIOUS` (or `APP_KEY_PREVIOUS_FILE`), run
`docker exec <container> /nodejs/bin/node dist/cli.js rotate-app-key`, check that it reports the rows it
re-sealed, then remove `APP_KEY_PREVIOUS`. The command takes a safety copy of the database first
(`backups/pre-rotate-<UTC>.sqlite`, the newest 3 are kept), re-seals every secret in one transaction and
writes the audit entry `secrets.app_key.rotate`. A second run is a no-op. Rotating `APP_KEY` does not renew
the certificate: it seals the same private key under the new key.

### Key compromise (a leaked or compromised key)

1. Assume the certificate private key is exposed if both the old key and a copy of the database leaked. A
   key without the database is harmless, and the database without the key is sealed.
2. Run the rotation above so that the live database is sealed with a new key, then delete the old key
   everywhere. Every `backups/pre-rotate-*` copy, every older database backup and every volume snapshot is
   still sealed with an old key: delete those you do not need, and treat those you keep as compromised.
3. Replace the certificate, because rotation does not: repair the connection in the wizard
   (`setup-reopen --confirm`, then the repair run); the old credential is removed from
   the application at Microsoft. Check the sign-in log of the application in Entra for use you do not
   recognise.
4. Revoke the sessions (sign out everywhere) and review the audit log for the period.

## The certificate: expiry and renewal

The wizard creates an RSA 2048 self-signed certificate valid for 360 days (Microsoft limits a credential to
one year). The panel shows a banner to Owners at 60 and at 14 days before expiry. Renewal in Phase B is the
repair flow in the wizard (`setup-reopen --confirm`, then repair): a new certificate is generated, sealed,
uploaded and checked before the old one is removed. A lapsed certificate means nobody can sign in, so
break-glass and a recent key backup are the safety net. Self-renewal without an administrator comes in Phase D.

## Break-glass

Break-glass is an optional emergency account that can only restore an Owner (the button "Eigenaar
herstellen"); it bypasses Conditional Access and MFA by design, so treat its password like a root password.

1. Create the hash from the password on standard input:
   `docker run --rm -it <image> dist/cli.js hash-password` (with `-it`, so that the terminal does not echo the password). The command refuses a password shorter than
   14 characters.
2. Set `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` (both, or neither) and recreate the container.
   The hash line contains no `$`, so Compose and shells leave it alone.
3. Restrict the route by address at the reverse proxy: `/api/v1/auth/break-glass` should be reachable from
   your own network only.
4. Every use is audited (`breakglass.signin`), the session lasts 30 minutes, a red banner shows throughout, and
   the restore refuses a disabled account.

The failure bounds of break-glass and of the setup unlock are global (20 and 30 per hour), so an attacker can
lock them for an hour; a container restart resets the in-memory lock counters. Prefer the proxy restriction.

## Sessions and timeouts

Sessions are server-side. The defaults are 30 minutes idle (`SESSION_IDLE_TIMEOUT_MINUTES`) and 8 hours
absolute (`SESSION_ABSOLUTE_TIMEOUT_HOURS`), at most 10 sessions per person, a step-up window of 10 minutes
for sensitive actions, and 60 minutes idle plus 8 hours absolute for the setup session. The group cache
(`GROUP_CACHE_TTL_SECONDS`, 300) is also the longest delay after which a removed Entra group membership
stops granting rights; direct assignments revoke at once. A restart ends nothing stored in the database but
loses the in-memory login transactions, setup sessions and rate counters: users simply sign in again.
Run a single replica (one replica, local disk): these in-memory states are not shared.

## Outbound hosts, proxies and sovereign clouds

The panel calls three Microsoft hosts and no other: `login.microsoftonline.com` (sign-in and tokens),
`graph.microsoft.com` (Microsoft Graph) and `outlook.office365.com` (the Exchange Admin API probe). Open
exactly these in an egress firewall. The wizard's device-code verification page may be on
`login.microsoft.com`; that is opened by your browser, not by the panel. Sovereign and national clouds
(Azure Government, 21Vianet) use other hosts and are not supported in Phase B. A corporate proxy for
outbound traffic: Node 22 may honour `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY` for `fetch`; this is
UNVERIFIED (U41: accepted with an experimental warning, effect unproven), so test it with step 1 of the wizard.
A proxy that inspects TLS needs its CA certificate in the container (`NODE_EXTRA_CA_CERTS`).

## The Exchange worker (Phase D, step D1)

> **Status:** step D1 (2026-10-13), built, **not run against a real tenant and not measured in a real image**:
> there was no Docker daemon where it was built. Sizes and times below that are not marked "measured" are
> estimates. Decisions: ADR-0180 (the runtime image), ADR-0181 (the worker protocol and its allow-list).

Distribution lists and mail contacts are managed in Exchange Online, which Microsoft Graph cannot do. The
panel therefore runs **one long-lived PowerShell 7 process (the worker) inside the same container**, started
by the server on the first Exchange call (not at start), speaking line-delimited JSON on stdin and stdout.
There is still one container, one volume and one replica.

- **What the worker may do.** Ten cmdlets and nothing else (ADR-0181); the server refuses anything else before
  it reaches the worker. It runs serially, one call at a time, with a deadline of
  `exchange.callDeadlineSeconds` (120 s): a call that overruns kills the worker, which is started again.
- **Recycling.** The worker is replaced after `exchange.workerMaxCalls` (500) calls or `exchange.workerMaxAgeSeconds`
  (3,600 s), whichever comes first, because repeated connect and disconnect can leak memory (Learn). The worker is then started again
  (once per failed call, EC-D1).
- **Retries.** Throttled and transient answers are retried at most `exchange.retryMax` (3) times, 1 s doubling to
  15 s with jitter, `Retry-After` first; then 503 `exchange_throttled` or `exchange_unavailable`. The numbers
  are ours (U81).
- **Memory and CPU** of a warm worker: CI measured 148 MB resident idle and 173 MB at the peak during two concurrent largest uploads (amd64); the memory of a long-running worker and arm64 are unmeasured (U84); owner test OV-D1 step 11 records the resident memory.
  Size your container limit with room for a second process.
- **Outbound.** The worker needs the same hosts as the panel: `login.microsoftonline.com` and
  `outlook.office365.com`. Whether the module contacts any other host is not verified; if you restrict egress
  and the worker cannot connect, the proxy or firewall log names it, and OV-D1 step 5 reports `code` values.
- **Logs.** The worker and its client log the request id, the cmdlet name, the outcome and the duration, and
  nothing else: no display name, address, member list, search text or id from a result. The worker's own
  output (the module prints) is discarded and never logged.

### The certificate and the key

The worker connects with the application id, the tenant's `.onmicrosoft.com` domain and the **certificate of the
panel**. The private key never reaches the disk of the container in the default mode.

| `EXCHANGE_KEY_HANDOVER` | What happens | When to use it |
|---|---|---|
| `memory` (default) | The server sends the certificate and the key to the worker as PEM text in one `connect` line on the stdin pipe; the script builds the certificate object in memory (`X509Certificate2.CreateFromPem`) and passes it to `Connect-ExchangeOnline -Certificate`. Nothing is written. | Always, unless OV-D1 shows that the module will not take it on Linux (U75) |
| `tmpfs` (fallback) | The script writes the two PEMs to files (a certificate file and a key file, `cert.pem` and `key.pem` in kind, with a random token in the name) in a private directory under `/dev/shm` (a tmpfs), derives a PKCS#12 file from them (the cmdlet's `-CertificateFilePath` wants one; its password is random and exists only inside the function), connects, and removes all three files in a `finally` block. Every file has mode 0600. The first use is refused when that directory is not a tmpfs. | Only after OV-D1 says the in-memory path fails. A residual risk remains: the key exists in a file for the time of the connect |

- **The connect line carries PEM, and the credential source is built but not proven.** The first contract carried
  a PKCS#12 container and a password, which Phase B cannot produce (it stores a sealed PKCS#8 key and a public
  certificate; Node cannot write PKCS#12). The owner decided on 2026-10-13 for **PEM** (option C) and it is built:
  the connect line is `certificate: { format: 'pem', certificate, privateKey }` (an X.509 `CERTIFICATE` and an
  unencrypted PKCS#8 `PRIVATE KEY`, no password), sent in memory over the stdin pipe, and the script builds the
  certificate with `X509Certificate2.CreateFromPem`. The server gets the PEMs from one audited accessor,
  `SecretsRuntime.withCertificateMaterial`, which hands them to a callback and revokes them afterwards; each
  access is a log line with the purpose and the thumbprint, never the key. If the secrets module is degraded, or
  there is no certificate, no key that opens it or no initial domain, the Exchange routes answer 503
  `exchange_unavailable` (reason `credential_unavailable`) and every Graph feature (users, groups and group
  members) keeps working. **Not proven against a real `pwsh` or a tenant** (`CreateFromPem` and
  `Connect-ExchangeOnline -Certificate` on Linux: U75, OV-D1); finding FD-01.
- **The worker command is looked up on the server's PATH.** The server finds `pwsh` with its own lookup
  (`resolveCommand` in `integrations/exchange/runtime.ts`), because the worker itself starts with a short
  environment without a `PATH`. This is what lets the e2e shim (`e2e/support/pwsh-shim/`) stand in for PowerShell
  without a test hook; the image does not contain the shim.
- **No key on disk is a tested property**, not a promise: a canary key is planted and the container's files are
  searched after a connect, in both modes (`no-key-on-disk.test.ts`). The real behaviour of the module on Linux is
  OV-D1 step 10.
- Memory residue: the key can stay in the memory of the Node and PowerShell processes after use, in core dumps
  and in swap. Run without swap or with encrypted swap if that matters to you (accepted risk, see
  [security.md](security.md)).

### The image: Ubuntu 24.04 instead of distroless

Phase D step D1 **replaces the distroless runtime by `ubuntu:24.04`** (pinned by digest), because PowerShell
and the Exchange module run on Ubuntu LTS only (ADR-0180, owner decision ODD-08 and ODB-01 A).

| Item | Now |
|---|---|
| Base | `ubuntu:24.04@sha256:...` for the PowerShell fetch stage and for the runtime (the build stage stays `node:22-bookworm-slim` by digest); Node is copied from the build stage to `/nodejs/bin/node` (entry point and command unchanged) |
| PowerShell | 7.6.6 from the release tarball, SHA-256 checked in the same `RUN`; only `/opt/microsoft/powershell/7` is copied |
| Module | `ExchangeOnlineManagement` 3.10.1 from the PowerShell Gallery as a `.nupkg`, SHA-512 checked, `netFramework` removed; no `Install-Module` |
| Libraries | `ca-certificates libgcc-s1 libgssapi-krb5-2 libicu74 libssl3t64 libstdc++6 zlib1g` from the Ubuntu archive. **Not pinned by version** (the base digest pins the archive only at the moment it was resolved); a snapshot mirror would pin them and is not done |
| User | `nonroot`, uid and gid 65532, no home, login shell `nologin`; the worker gets `HOME` under `/tmp` |
| Shell | **Present now** (`sh`), so `docker exec <container> sh -c ...` works; there is still no `curl`, `unzip` or compiler in the runtime stage. The image is no longer "without a shell" |
| Telemetry | `POWERSHELL_TELEMETRY_OPTOUT=1`, `POWERSHELL_UPDATECHECK=Off`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1` as image `ENV` |
| Container hardening | Unchanged and required: read-only root file system, `/tmp` as tmpfs, `cap_drop: ALL`, `no-new-privileges`, uid 65532 |
| Checks | `scripts/check_dockerfile_pins.py`, `scripts/check_image_contents.py`, `scripts/image-smoke.ts` (a worker ping inside the restricted container), and the arm64 step of `image.yml` (the same ping, `continue-on-error`) |

**The image size ceiling: measured and decided.** The distroless image measured 193.5 MB (Phase A) against a
ceiling of 400 MB. CI measured the new Ubuntu image at **538.2 MB** (amd64, run 38394173673), and on 2026-10-13 the
owner decided that the ceiling becomes **600 MB** (`imageSizeCeilingMegabytes`, ODD-10, ADR-0180). The number lives
in two places that a test compares: `CEILING_MEGABYTES` in `scripts/check_image_size.py` and
`imageSizeCeilingMegabytes` in `packages/shared/src/limits.ts`. Nobody else raises it, and it is not raised "to make
CI green" (FR-D-106). `python scripts/check_image_size.py <image>` prints the size in megabytes of 1,000,000 bytes
(`docker image inspect --format '{{.Size}}' <image>` gives bytes, uncompressed). The `Image size budget` step of the `image` job enforces it.

What the same CI run measured (amd64; the container smoke test passed 33 of 34 checks, only the size check failed
against the old ceiling): `/readyz` answered 200 after 1,184 ms; the Exchange worker answered a ping in 1,473 ms
inside the restricted container (module 3.10.1, PowerShell 7.6.6); resident memory was 148 MB idle and 173 MB at
the peak during two concurrent largest uploads; `docker stop` exited 0 in 152 ms. **Not measured:** arm64, and the
memory of a long-running worker (U84).

### Deployment-file changes of step D1 (for the pull request statement)

| File | Change | An existing deployment |
|---|---|---|
| `Dockerfile` | New stage `pwsh-fetch`; runtime stage is Ubuntu 24.04 with PowerShell and the module (above) | Keeps working: pull the new image, recreate the container. The volume, uid 65532, port and entry point are unchanged |
| `.github/workflows/image.yml` | The arm64 smoke step also pings the Exchange worker; no step added or renamed | Not an operator file |
| `docker-compose.yml` | `EXCHANGE_KEY_HANDOVER:` passed through from the environment (unset or empty means the default) | Keeps working untouched; the variable is optional |
| `.env.example` | `EXCHANGE_KEY_HANDOVER=memory` with its comment | Add the line by hand only if you want to change it (`tmpfs`); the default is `memory` |
| `docker-compose.yml`, `.env.example` (added later in D1) | `EXCHANGE_DEBUG_ERRORTEXT:` passed through; `#EXCHANGE_DEBUG_ERRORTEXT=` commented out | Keeps working untouched; unset means off. Add `EXCHANGE_DEBUG_ERRORTEXT=1` by hand only for troubleshooting and remove it afterwards |

New variable: **`EXCHANGE_KEY_HANDOVER`**, default `memory`, values `memory` or `tmpfs`, in the environment table
above. No new Compose mapping line, no new volume, no migration. The largest request the application accepts
is unchanged at 9,437,184 bytes.

### Symptoms of the Exchange worker

| You see | Likely cause |
|---|---|
| Every distribution list, contact and Exchange-backed page answers 503 `exchange_unavailable` | The Exchange credential source cannot produce the certificate (degraded secrets, no certificate or no initial domain: reason `credential_unavailable`; built, but not proven against a tenant, FD-01), or the role was granted minutes ago (`exchange_role_pending`, wait and retry), or the worker could not start (`pwsh` missing: an image that is not the Phase D image) |
| 503 `exchange_unavailable` with `exchange_timeout` | A call exceeded 120 seconds; the worker was restarted. Try again |
| 503 `exchange_throttled` | Exchange asked for a wait and the retry budget is spent; `Retry-After` says how long |
| 503 `exchange_permission_missing` | Exchange refused the application: the Entra role is missing (Settings, Connection) or a manager check failed |
| A member change says "Microsoft refused the change" or "no permission" for one member | The member's own answer (`rejected`, `permission_missing`): for a group, a role-assignable group answers this (U96) |
| The change is made but the member list does not show it | `readBackPending`: Exchange can take a while (U82); refresh the members |
| The image is "unhealthy" or the container does not start after the update | The first Phase D image is much larger and slower to pull; check `docker logs`. The Node health check is unchanged |

### Temporary diagnostics: `EXCHANGE_DEBUG_ERRORTEXT`

By default the worker never sends free text (FR-D-107): a failed Exchange call is a code of a closed list plus the
.NET type name, the error id and a few words of a fixed vocabulary (`errorType`, `errorId`, `errorHints` in the
`exchange_fault` log entry). Some modules report their error with `Write-Error` and no word of that vocabulary
matches (`errorType` and `errorId` both `Microsoft.PowerShell.Commands.WriteErrorException`, `errorHints` empty).
For that case there is one **temporary, opt-in exception**, recorded as GD1-0 amendment 5:

- **Turn it on.** Set `EXCHANGE_DEBUG_ERRORTEXT=1` in the environment of the panel container (the Compose file passes it
  through, so with Compose or Dockhand add the line `EXCHANGE_DEBUG_ERRORTEXT=1` to the stack's `.env` or environment
  variables; with `docker run` add `-e EXCHANGE_DEBUG_ERRORTEXT=1`), then recreate the container. The start logs one warning, `{"event":"exchange_debug_errortext","enabled":true}`, as
  long as the mode is on.
- **What you get.** The `exchange_fault` entry of a failed call and the `connect_refused` entry of a refused connect
  carry `errorText` and `errorTextLength`. The text is the message of the outermost exception and, when it differs,
  of the innermost one, joined with ` | `. Before it leaves the worker, e-mail addresses, GUIDs and runs of 20 or
  more token-like characters (`A-Z a-z 0-9 + / = _ -`) become `X`, white space and control characters collapse to a
  space, and the result is cut at 300 characters. `errorTextLength` is the length of the unmasked outer message,
  so `0` shows an empty message. Without the mode both fields are `null`, and the server logs no text even if a
  worker sent one.
- **Probes.** In the same mode, after the first failed call of a worker process, the worker runs five small reads
  (`Get-OrganizationConfig`, `Get-Recipient`, `Get-DistributionGroup` and `Get-MailContact` with `-ResultSize 1`,
  and `Get-MailContact` without parameters) and the `exchange_fault` entry carries `errorProbes`: fixed words such
  as `org_onms` (the organization ends in `.onmicrosoft.com`) or `org_other`, then `orgcfg_ok`, `recip_fail`,
  `contact1_fail`, `contactall_ok` (`_missing` when the cmdlet is not loaded). All `fail` points at the tenant,
  the token or the role; one `fail` among `ok` points at a call shape such as a parameter.
- **Read it before you share it.** The masking is a pattern, not a proof: a display name, a tenant name or a
  cmdlet parameter in the message is **not** masked. Read the log lines yourself before you paste them anywhere.
  Nothing else carries the text: no page, API answer, audit entry or error page.
- **Turn it off.** Remove the variable (or set it to `0`) and recreate the container. Do not leave it on: it is for
  one troubleshooting session. An empty value (`EXCHANGE_DEBUG_ERRORTEXT=`) stops the start, like every other
  variable.

### Secret files and stack managers

A stack manager that runs **in a container itself** (Dockhand and similar) reads your Compose file from inside
its own container. If the secret file is given as an **absolute host path** (`file: /srv/m365/secrets/app_key`),
the manager may show a warning such as `secret file ... does not exist` although the file is there: the manager
looks for the path in its own file system, not on the Docker host. The warning is harmless for the panel. The
proof that the secret arrived is **inside the panel's container**: `docker exec <container> ls -l /run/secrets/app_key`
shows the mounted file (at most 1,024 bytes) and the panel starting without `APP_KEY` complaints
confirms it. Do not print the file. To silence the warning, give the stack manager the
same path in its own container, or use a path relative to the Compose file.

## Limits outside the repository

The repository ships no reverse proxy, CDN or ingress, so it has no limits of its own outside the
application. Every limit on the path from the client to the application is documented here as a number,
with what enforces it and which limit it constrains. Whatever sits in front of the application must allow
request bodies of at least 9,437,184 bytes (the branding import, the largest request), must not cache
HTML, and must preserve the `Host` header. Phase B adds no larger request: its bodies are small, the largest
being the 4,096-byte bodies of the authentication routes and 262,144 bytes for any other JSON body. Phase C adds
no request body at all (its seven routes are `GET`), so the largest request stays 9,437,184 bytes; the five
rows `searchMaxChars` to `cursorEntries` below are the limits of the users and groups lists. Phase D step D1
adds write bodies (a list of at most 200 GUIDs, about 8 KB, and small contact bodies), all far below the
262,144 bytes of any JSON body, so the largest request is still 9,437,184 bytes; the rows from `RATE_EXPORT`
to `contacts.addressMaxChars` are the limits of step D1 (the export class is used from step D2).

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
| Image size ceiling | 600 MB uncompressed. Owner decision (ODD-10, ADR-0180): the Ubuntu image of Phase D step D1 measured 538.2 MB in CI (amd64); it was 400 MB for the distroless image | `image` job | FR-A-168, FR-D-106, ADR-0180 |
| `SETUP_UNLOCK_FAILS_PER_CLIENT` | 5 failures per 15 minutes per client address | the app | lock of that address for `SETUP_LOCK_MINUTES` (FR-B-204) |
| `SETUP_UNLOCK_FAILS_GLOBAL` | 30 failures per 60 minutes | the app | lock of unlocking for everyone for `SETUP_LOCK_MINUTES` |
| `SETUP_LOCK_MINUTES` | 15 minutes | the app | `Retry-After` of 429 `setup_token_locked` is the remaining seconds |
| `SETUP_SESSION_IDLE_MINUTES`, `SETUP_SESSION_ABSOLUTE_HOURS` | 60 minutes and 8 hours | the app, in memory | a restart ends the setup session (FR-B-205) |
| `SETUP_SESSIONS_MAX` | 5 | the app | live setup sessions, the oldest is evicted |
| `SETUP_MIN_WAIT_MS` | 500 ms | the app | floor of every computed wait of the wizard |
| `SETUP_TOKEN_BYTES` | 32 bytes | the app | generated setup token, base64url, file mode 0600 |
| `SETUP_LEASE_HEARTBEAT_SECONDS`, `SETUP_LEASE_EXPIRY_SECONDS` | 15 s and 120 s | the app | runner lease (FR-B-209) |
| `SETUP_LOG_RETAINED`, `SETUP_LOG_PAGE_MAX` | 1,000 rows and 200 rows | the app | setup log; polled every 1 s, every 2 s in a hidden tab |
| `SETUP_DETAIL_STRING_MAX_BYTES`, `SETUP_VERIFY_RESULT_MAX_BYTES` | 256 bytes and 51,200 bytes | the app | step detail strings; the stored proof list |
| `SETUP_TRANSIENT_BACKOFF` | 1 s doubling to 30 s, full jitter, at most 6 tries | the app | `Retry-After` wins when present (FR-B-212) |
| `SETUP_REPLICATION_BACKOFF` | 2 s doubling to 60 s, full jitter | the app | wait for Microsoft replication |
| `SETUP_OBJECT_CHAIN_WINDOW_SECONDS` | 300 seconds | the app | window for object chains |
| `SETUP_PROPAGATION_TIMEOUT_SECONDS` (setting) | default 900, range 60 to 3,600 seconds | the app (`SETUP_PROPAGATION_TIMEOUT_SECONDS`) | role-to-token propagation window; hard maximum 3,600 |
| `SETUP_SKEW_WARN_SECONDS`, `SETUP_SKEW_FAIL_SECONDS` | 60 s and 300 s | the app | clock skew check of the wizard (our thresholds) |
| `SETUP_MUTATING_CALLS_CLEAN_RUN` | 11 (informative) | the fault-injection test | derived from the fake tenant |
| `CERT_RSA_BITS`, `CERT_VALIDITY_DAYS`, `CERT_BACKDATE_MINUTES` | 2,048 bits, 360 days, 5 minutes | the app | Microsoft Learn: a certificate lasts at most one year from its start date (FR-B-106) |
| `CERT_WARN_DAYS`, `CERT_CRITICAL_DAYS` | 60 days and 14 days | the app | banner levels (FR-B-111) |
| `APP_KEY_BYTES`, `SECRET_NONCE_BYTES`, `KEY_ID_BYTES` | 32, 24 and 8 bytes | the app | FR-B-104, FR-B-105 |
| `APP_KEY_FILE_MAX_BYTES` | 1,024 bytes | the app | size of the `APP_KEY_FILE` file |
| `CLIENT_ASSERTION_LIFETIME_SECONDS` | 300 seconds | the app | Microsoft Learn: at most 10 minutes after `nbf` |
| `TOKEN_ENDPOINT_TIMEOUT_SECONDS` | 10 seconds | the app | one retry after 1 s on `temporarily_unavailable` |
| `ID_TOKEN_MAX_BYTES` | 8,192 bytes | the app | size of an ID token |
| `searchMaxChars` | 64 characters | the app | `q` of the users and groups lists: 422 `validation_failed` above it (EC-C1) |
| `pageLimitDefault`, `pageLimitMax` | 100 and 200 rows | the app | `limit` of the directory lists (CD-10); the UI asks for 50 |
| `graphPageSize` | 999 | the app | `$top` of a scoped scan of users or groups (R-C-01) |
| `scanPagesMax` | 5 pages | the app | Graph pages read per request of a scoped list (FR-C-203) |
| `cursorTtlSeconds`, `cursorEntries` | 600 seconds and 1,000 entries | the app | list cursors held in memory, least recently used out (FR-C-103) |
| `RATE_EXPORT` | capacity 6, refill 0.1 per second, per actor | the app | 429 `rate_limited` on the export routes of step D2 (the class exists since step D1; ODD-07) |
| `exchange.workerMaxCalls`, `exchange.workerMaxAgeSeconds` | 500 calls and 3,600 seconds | the app | the `pwsh` worker is recycled at whichever comes first (FR-D-104) |
| `exchange.callDeadlineSeconds` | 120 seconds | the app | one cmdlet call; the worker is killed at the deadline and restarted once (EC-D1) |
| `exchange.listBufferMax`, `exchange.lineMaxBytes` | 10,000 rows and 1,048,576 bytes | the app | rows one list read holds per cursor: a larger result answers 422 `narrow_search`; one line of the worker protocol, a longer answer is cut and never shown as the whole list (FR-D-102) |
| `exchange.retryMax`, `exchange.retryBackoff` | 3 retries; 1 s doubling to 15 s, full jitter | the app | throttled or transient Exchange calls; `Retry-After` wins when present; then 503 `exchange_throttled` (FR-D-105, numbers ours until U81) |
| `distributionLists.bulkMax`, `distributionLists.bulkChunk`, `distributionLists.stepUpAbove` | 200, 50 and 20 members | the app | members in one add or remove request, members per chunk, and the size above which a fresh step-up is needed (FR-D-203, FR-D-204) |
| `groupMembers.bulkMax`, `groupMembers.bulkChunk`, `groupMembers.stepUpAbove` | 200, 20 and 20 members | the app | the same for Microsoft 365 and security groups through Graph (FR-D-353) |
| `contacts.nameMaxChars`, `contacts.displayNameMaxChars`, `contacts.aliasMaxChars`, `contacts.personNameMaxChars`, `contacts.addressMaxChars` | 64, 256, 64, 64 and 254 characters | the app | fields of a mail contact; the Exchange name is derived from the alias (FR-D-302) |
| `CLOCK_TOLERANCE_SECONDS` | 60 seconds | the app | `exp`, `nbf`, `iat` of an ID token |
| `JWKS_CACHE_HOURS`, `JWKS_REFRESH_MINUTES`, `JWKS_UNKNOWN_KID_COOLDOWN_MINUTES` | 24 hours, 60 minutes and 5 minutes | the app | signing-key rollover guidance |
| `GRAPH_CHECK_MEMBER_GROUPS_MAX_IDS` | 20 | the app | Microsoft Learn: up to 20 groups per request |
| `GRAPH_RETRY_MAX`, `GRAPH_RETRY_AFTER_MAX_WAIT_SECONDS` | 4 retries and 60 seconds | the app | a longer wait fails fast as 503 `graph_throttled` |
| `GRAPH_5XX_BACKOFF` | 500 ms doubling to 10 s, full jitter, at most 4 retries | the app | idempotent calls only |
| `GRAPH_BUDGET_INTERACTIVE_SECONDS`, `GRAPH_BUDGET_WIZARD_SECONDS`, `GRAPH_IN_FLIGHT_MAX` | 20 s, 60 s and 4 calls in flight | the app | per call including retries |
| `GRAPH_CACHE_TTL_SECONDS`, `GRAPH_CACHE_ENTRIES` | organization 300 s, user 60 s, group 60 s; 1,000 entries | the app | Graph response cache (FR-B-313) |
| `EXCHANGE_RESULT_SIZE_MAX`, `EXCHANGE_PAGING_WINDOW_SECONDS` | 1,000 and 300 seconds | the app | a `nextLink` is valid for 5 to 10 minutes (FR-B-314) |
| `LOGIN_TX_MAX`, `LOGIN_TX_PER_CLIENT_MAX`, `LOGIN_TX_LIFETIME_SECONDS` | 1,000, 20 and 600 seconds | the app | sign-in transactions; the oldest is evicted (FR-B-402) |
| `RETURN_TO_MAX_CHARS` | 256 characters | the app | `returnTo` after sign-in |
| `RATE_AUTH`, `RATE_SETUP` | capacity 10, refill 0.2 per second, per client address | the app | 429 `rate_limited` on sign-in and setup routes (FR-B-415) |
| `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS` (settings) | idle default 30, range 5 to 480 minutes; absolute default 8, range 1 to 24 hours | the app (the two variables of the same name) | hours x 60 must exceed the idle minutes |
| `SESSION_WRITE_INTERVAL_SECONDS`, `SESSIONS_PER_PRINCIPAL_MAX`, `SESSION_PURGE_MINUTES` | 60 s, 10 sessions and 60 minutes | the app | FR-B-407 |
| `SESSION_IDLE_WARNING_SECONDS`, `SESSION_ABSOLUTE_WARNING_MINUTES` | 120 s and 5 minutes | the app | session timers in the UI (FR-B-416) |
| `STEP_UP_WINDOW_MINUTES`, `STEP_UP_AUTH_TIME_LEEWAY_SECONDS` | 10 minutes and 60 s | the app | FR-B-411 |
| `REVALIDATE_RETRY_SECONDS` | 30 seconds | the app | after a Graph failure (FR-B-409) |
| `BREAK_GLASS_SESSION_MINUTES` | 30 minutes, not sliding | the app | FR-B-522 |
| `BREAK_GLASS_FAILS_PER_CLIENT`, `BREAK_GLASS_FAILS_GLOBAL` | 5 per 15 minutes per client address and 20 per 60 minutes | the app | 429 `break_glass_locked` (FR-B-521) |
| `SCRYPT_N_MIN`, `SCRYPT_N_MAX`, `SCRYPT_MAX_MEMORY_BYTES`, `SCRYPT_SALT_BYTES`, `SCRYPT_HASH_BYTES` | N from 16,384 to 131,072; at most 134,217,728 bytes of memory; salt 16 to 64 bytes; hash 32 to 64 bytes | the app | `128 * N * r` is at most the memory cap; the CLI writes N = 131,072, r = 8, p = 1 (FR-B-521) |
| `BREAK_GLASS_QUEUE_RUNNING`, `BREAK_GLASS_QUEUE_WAITING`, `BREAK_GLASS_PASSWORD_MIN_CHARS` | 1 running, 2 waiting, 14 characters | the app | one password verification at a time; the `hash-password` floor (FR-B-110) |
| `GROUP_CACHE_TTL_SECONDS` (setting) | default 300, range 30 to 3,600 seconds | the app (the variable of the same name) | group membership cache (FR-B-409) |
| `GROUPS_BOUND_MAX` | 200 | the app | distinct bound Entra groups (FR-B-507) |
| `ASSIGNMENTS_MAX`, `ROLES_MAX` | 5,000 and 100 | the app | roles include the five built-in roles (FR-B-508) |
| `SCOPE_ITEMS_PER_ASSIGNMENT_MAX`, `SCOPE_VALUE_MAX_CHARS` | 50 and 64 characters | the app | FR-B-513 |
| `ASSIGNMENT_EXPIRY_MAX_DAYS` | 730 days | the app | FR-B-508 |
| `AUTH_BODY_MAX_BYTES` | 4,096 bytes | the app | `unlock`, `logout`, `logout-all` and `break-glass` bodies; all other JSON bodies keep 262,144 bytes, and the largest request stays 9,437,184 bytes |

The single source of every number is `packages/shared/src/limits.ts` (`LIMITS`); this table is a
mirror, compared with it by `limits-doc.test.ts`. A pull request that raises a size, rate or timeout
limit states the new value as a number, never as one proxy's setting. The measured image size of the
first local build was 193.5 MB (the distroless image of Phase A, against the old ceiling of 400 MB); the Ubuntu image
of Phase D measured 538.2 MB in CI (amd64) against the ceiling of 600 MB.

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
"healthy" na ongeveer een halve minuut. De container draait als uid 65532 zonder capabilities; sinds Fase D stap D1 is de image Ubuntu 24.04 met PowerShell en dus mét een shell (`sh`), maar zonder curl.

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
(retentie volgt in Fase D, stap D2).

### Eerste installatie, setup-token en setup-reopen

Een nieuw paneel is `unconfigured` en antwoordt alleen met de installatiepoort. Het setup-token beschermt die
poort; het staat in `/data/setup-token` (0600, nooit gelogd) en `docker exec <container> /nodejs/bin/node
dist/cli.js setup-token` drukt het af. `SETUP_TOKEN` mag u zelf zetten, maar verwijder hem na de eerste
installatie. De wizard sluit bij de eerste geslaagde aanmelding van de eerste Eigenaar; `setup-reopen --confirm`
opent hem opnieuw (nieuwe tenant, verloren Eigenaar, gewijzigde `PUBLIC_BASE_URL`); tot de wizard klaar is, kan
niemand aanmelden.

### De versleutelsleutel (`APP_KEY`)

`APP_KEY` versleutelt de privésleutel van het certificaat. Maak hem met `generate-app-key`, bewaar hem als
Docker-secret (`secrets/app_key`) of platformgeheim en **maak een back-up los van het datavolume**. Roteren:
nieuwe sleutel als `APP_KEY`, de oude als `APP_KEY_PREVIOUS`, daarna `rotate-app-key`; roteren vernieuwt het
certificaat niet. **Gelekte sleutel:** roteer, verwijder de oude sleutel en alle `pre-rotate-*`-kopieën die u niet
nodig hebt, vernieuw het certificaat via de herstelstap van de wizard en controleer het aanmeldlogboek in Entra.

### Certificaat, break-glass en sessies

Het zelfondertekende certificaat (RSA 2048) is 360 dagen geldig; het paneel waarschuwt bij 60 en 14 dagen en
vernieuwen gaat via de herstelstap. Break-glass is een optioneel noodaccount dat alleen een Eigenaar kan
herstellen: maak de hash met `hash-password` (minimaal 14 tekens), zet `BREAK_GLASS_USERNAME` en
`BREAK_GLASS_PASSWORD_HASH` en beperk `/api/v1/auth/break-glass` op de reverse proxy tot uw eigen netwerk. Sessies
duren standaard 30 minuten inactief en 8 uur absoluut. Draai één replica; de tellers in het geheugen gaan bij een
herstart verloren.

### Uitgaande verbindingen

Het paneel roept drie Microsoft-hosts aan: `login.microsoftonline.com`, `graph.microsoft.com` en
`outlook.office365.com` (sinds Fase D stap D1 ook de Exchange-worker, zie hierboven). Soevereine (nationale) clouds worden niet ondersteund. Verzoeken tot 9,437,184 bytes
moeten door de reverse proxy kunnen (de brandingimport is het grootste verzoek; Fase B voegt geen groter verzoek
toe). De variabele `NODE_USE_ENV_PROXY` voor een uitgaande proxy is ONGEVERIFIEERD (U41).

### De Exchange-worker (Fase D, stap D1)

Stap D1 (2026-10-13) is gebouwd maar **niet tegen een echte tenant gedraaid en niet in een echte image
gemeten** (er was geen Docker-daemon); getallen die hieronder niet "gemeten" heten, zijn schattingen.
Besluiten: ADR-0180 (het runtime-image) en ADR-0181 (het worker-protocol en de toegestane lijst).

Distributielijsten en mailcontacten beheer je in Exchange Online; dat kan Microsoft Graph niet. Het paneel
draait daarom **één langlevend PowerShell 7-proces (de worker) in dezelfde container**, door de server gestart
bij de eerste Exchange-aanroep (niet bij het opstarten), met regelgebonden JSON over stdin en stdout. Het blijft
één container, één volume, één replica.

- **Wat de worker mag**: tien cmdlets en niets anders; de server weigert al het andere voordat het de worker
  bereikt. Eén aanroep tegelijk, met een deadline van 120 seconden (`exchange.callDeadlineSeconds`): wie die
  overschrijdt, laat de worker doden en opnieuw starten.
- **Verversen**: na 500 aanroepen of 3.600 seconden (`exchange.workerMaxCalls`, `exchange.workerMaxAgeSeconds`),
  wat het eerst komt, omdat herhaald verbinden en loskoppelen geheugen kan lekken.
- **Herhalen**: gethrottlede en tijdelijke antwoorden hoogstens 3 keer (`exchange.retryMax`), 1 s oplopend tot
  15 s met jitter, `Retry-After` eerst; daarna 503 `exchange_throttled` of `exchange_unavailable`. De getallen zijn
  van ons (U81).
- **Geheugen en CPU** van een warme worker: CI mat 148 MB resident in rust en 173 MB op het hoogtepunt bij twee gelijktijdige grootste uploads (amd64); het geheugen van een langlopende worker en arm64 zijn ongemeten (U84); OV-D1 stap 11 noteert het geheugen.
- **Uitgaand**: dezelfde hosts als het paneel, `login.microsoftonline.com` en `outlook.office365.com`; of de
  module nog een andere host aanroept, is niet geverifieerd.
- **Logs**: alleen verzoek-id, cmdletnaam, uitkomst en duur; nooit een naam, adres, ledenlijst of zoektekst.

**Certificaat en sleutel.** De worker verbindt met applicatie-id, het `.onmicrosoft.com`-domein en het certificaat
van het paneel. `EXCHANGE_KEY_HANDOVER=memory` (standaard): certificaat en sleutel gaan als één `connect`-regel
over de stdin-pipe, als PEM-tekst, en het script bouwt het certificaat in het geheugen; er wordt niets geschreven.
`tmpfs` is de terugval: het script schrijft de twee PEM's naar bestanden (een certificaat- en een sleutelbestand, met
een willekeurig token in de naam) in een privémap onder `/dev/shm`, leidt daar een PKCS#12-bestand van af (dat wil
`-CertificateFilePath`; het wachtwoord is willekeurig en bestaat alleen binnen de functie), verbindt en verwijdert
alle drie de bestanden in een `finally`-blok, allemaal met modus 0600, met een restrisico. Het is alleen nodig als
OV-D1 laat zien dat het geheugenpad op Linux niet werkt (U75). **De `connect`-regel draagt PEM en de bron van de
inloggegevens is gebouwd, maar niet bewezen**: het eerste contract droeg een PKCS#12 en een wachtwoord, wat Fase B
niet kan maken; de eigenaar besloot op 2026-10-13 voor **PEM** (optie C): `certificate: { format: 'pem',
certificate, privateKey }` (een X.509-`CERTIFICATE` en een niet-versleutelde PKCS#8-`PRIVATE KEY`, geen
wachtwoord), in het geheugen over de pipe, en het script bouwt het certificaat met `X509Certificate2.CreateFromPem`.
De server krijgt de PEM's van één geauditeerde toegangsmethode, `SecretsRuntime.withCertificateMaterial`, die ze aan
een callback geeft en daarna intrekt; elke toegang is een logregel met doel en vingerafdruk, nooit de sleutel. Is de
geheimenmodule gedegradeerd, of ontbreekt het certificaat, een sleutel die het opent of het initiële domein, dan
antwoordt elke Exchange-route 503 `exchange_unavailable` (reden `credential_unavailable`); het proces start en alles
via Graph (gebruikers, groepen, groepsleden) werkt. **Niet bewezen tegen een echte `pwsh` of een tenant**
(`CreateFromPem` en `Connect-ExchangeOnline -Certificate` op Linux: U75, OV-D1; bevinding FD-01). De workeropdracht
wordt op het PATH van de server opgezocht (`resolveCommand`), omdat de worker zelf zonder `PATH` start; daardoor kan
de e2e-shim zonder testhaak voor PowerShell instaan. Dat er geen sleutel op schijf komt is een geteste eigenschap (een kanariesleutel wordt
geplant en na het verbinden wordt in de bestanden gezocht, in beide modi); het echte gedrag van de module is
OV-D1 stap 10. Geheugenresten van de sleutel zijn een aanvaard risico (zie [security.md](security.md)).

**De image: Ubuntu 24.04 in plaats van distroless.** PowerShell en de Exchange-module draaien alleen op Ubuntu
LTS (ADR-0180, ODD-08 en ODB-01 A). De runtime is `ubuntu:24.04` op digest, met PowerShell 7.6.6 (SHA-256
gecontroleerd), de module `ExchangeOnlineManagement` 3.10.1 (SHA-512 gecontroleerd, `netFramework` verwijderd) en
de bibliotheken `ca-certificates libgcc-s1 libgssapi-krb5-2 libicu74 libssl3t64 libstdc++6 zlib1g` uit het
Ubuntu-archief (**niet op versie vastgezet**; een snapshot-mirror zou dat doen en is niet gedaan). Gebruiker
`nonroot` (uid 65532), telemetrie uit. Er is nu **wel een shell** (`sh`), dus `docker exec <container> sh -c ...`
werkt; er is nog steeds geen `curl`, `unzip` of compiler in de runtime. Alleen-lezen root, `/tmp` als tmpfs,
`cap_drop: ALL` en `no-new-privileges` blijven vereist en ongewijzigd.

**Het plafond voor de grootte van de image: gemeten en besloten.** De distroless-image mat 193,5 MB (Fase A) tegen een
plafond van 400 MB. CI mat de nieuwe Ubuntu-image op **538,2 MB** (amd64, run 38394173673) en de eigenaar besloot op
13-10-2026 dat het plafond **600 MB** wordt (`imageSizeCeilingMegabytes`, ODD-10, ADR-0180). Het getal staat op twee
plaatsen die een test vergelijkt: `CEILING_MEGABYTES` in `scripts/check_image_size.py` en `imageSizeCeilingMegabytes`
in `packages/shared/src/limits.ts`. Niemand anders verhoogt het, en niet "om CI groen te krijgen". Meet met
`docker image inspect --format '{{.Size}}' <image>` (bytes, ongecomprimeerd) of `python scripts/check_image_size.py
<image>`. De stap `Image size budget` van de job `image` handhaaft het.

Wat dezelfde CI-run mat (amd64; de rooktest van de container slaagde voor 33 van 34 controles, alleen de grootte-
controle faalde tegen het oude plafond): `/readyz` antwoordde 200 na 1.184 ms; de Exchange-worker beantwoordde een ping
in 1.473 ms binnen de beperkte container (module 3.10.1, PowerShell 7.6.6); het residente geheugen was 148 MB in rust
en 173 MB op het hoogtepunt bij twee gelijktijdige grootste uploads; `docker stop` eindigde met 0 in 152 ms. **Niet
gemeten:** arm64 en het geheugen van een langlopende worker (U84).

**Deployment-bestanden van stap D1.** `Dockerfile` (nieuwe stage `pwsh-fetch`, Ubuntu-runtime), `image.yml` (de
arm64-rooktest pingt ook de worker; geen stap toegevoegd of hernoemd), `docker-compose.yml` (`EXCHANGE_KEY_HANDOVER:`
doorgegeven; leeg betekent de standaard) en `.env.example` (`EXCHANGE_KEY_HANDOVER=memory`). Een bestaande
installatie blijft ongewijzigd werken: image ophalen en de container opnieuw maken; volume, uid, poort en
entrypoint zijn gelijk. Geen nieuwe Compose-mappingregel, geen volume, geen migratie; het grootste verzoek blijft
9.437.184 bytes. Later in D1 komt `EXCHANGE_DEBUG_ERRORTEXT:` bij in `docker-compose.yml` (doorgegeven; niet
ingesteld betekent uit) en `#EXCHANGE_DEBUG_ERRORTEXT=` (uitgecommentarieerd) in `.env.example`; een bestaande installatie
blijft ongewijzigd werken.

**Symptomen.** Elke Exchange-pagina antwoordt 503 `exchange_unavailable`: de bron van de inloggegevens is nog niet
te maken (verzegelde geheimen gedegradeerd of geen certificaat of initieel domein, reden `credential_unavailable`; gebouwd maar niet bewezen, FD-01), de rol is minuten geleden verleend (`exchange_role_pending`, wacht en probeer opnieuw) of
`pwsh` ontbreekt (een image die niet de Fase D-image is). `exchange_timeout`: een aanroep duurde langer dan 120
seconden. 503 `exchange_throttled`: de herhaalruimte is op; `Retry-After` zegt hoe lang. 503
`exchange_permission_missing`: de Entra-rol ontbreekt (Instellingen, Verbinding) of de beheerderscontrole faalde.
"Microsoft heeft de wijziging geweigerd" bij één lid: het antwoord voor dat lid (een rol-toewijsbare groep geeft
dit, U96). De wijziging is gedaan maar de ledenlijst toont haar niet: `readBackPending`, ververs de leden (U82).

**Tijdelijke diagnose: `EXCHANGE_DEBUG_ERRORTEXT`.** Standaard stuurt de worker nooit vrije tekst (FR-D-107): een
mislukte Exchange-aanroep is een code uit een gesloten lijst plus de .NET-typenaam, de fout-id en enkele woorden uit
een vaste woordenlijst (`errorType`, `errorId`, `errorHints` in het logregeltje `exchange_fault`). Meldt een module
zijn fout met `Write-Error` en past geen woord uit die lijst, dan is er één **tijdelijke uitzondering waarvoor je
kiest** (GD1-0 amendement 5). Zet `EXCHANGE_DEBUG_ERRORTEXT=1` in de omgeving van de paneelcontainer en maak de
container opnieuw; de start logt dan één waarschuwing, `{"event":"exchange_debug_errortext","enabled":true}`. De
logregels `exchange_fault` en `connect_refused` krijgen `errorText` en `errorTextLength`: de tekst van de buitenste
en, als die anders is, de binnenste uitzondering, gescheiden door ` | `, waarin e-mailadressen, GUID's en reeksen
van 20 of meer tokentekens door `X` zijn vervangen, witruimte is samengevouwen en het geheel op 300 tekens is
afgekapt; `errorTextLength` is de lengte van de ongemaskeerde buitenste melding (`0` toont een lege melding). Zonder
de modus zijn beide velden `null`. **Lees het log zelf door voordat je het deelt**: het maskeren is een patroon, geen
bewijs; een weergavenaam of tenantnaam in de melding wordt niet gemaskeerd. Na de eerste mislukte aanroep van een
workerproces draait de worker in deze modus ook vijf kleine leesopdrachten; `exchange_fault` krijgt dan
`errorProbes` met vaste woorden (`org_onms` of `org_other`, `orgcfg_ok`, `recip_fail`, `contact1_fail`,
`contactall_ok`): alles `fail` wijst op tenant, token of rol, een enkele `fail` op de vorm van de aanroep. Halen: verwijder de variabele (of zet
hem op `0`) en maak de container opnieuw. Laat hem niet staan; een lege waarde stopt de start, zoals bij elke
variabele.

**Geheimbestanden en stackbeheerders.** Een stackbeheerder die zelf **in een container** draait (Dockhand en
vergelijkbaar) leest je Compose-bestand vanuit zijn eigen container. Staat het geheimbestand als **absoluut pad van
de host** (`file: /srv/m365/secrets/app_key`), dan kan de beheerder een waarschuwing tonen als `secret file ... does
not exist` terwijl het bestand er gewoon is: hij zoekt het pad in zijn eigen bestandssysteem, niet op de Docker-host.
De waarschuwing is onschadelijk voor het paneel. Het bewijs dat het geheim is aangekomen zit **in de container van
het paneel**: `docker exec <container> ls -l /run/secrets/app_key` toont het gemonteerde bestand (hoogstens 1.024
bytes) en een paneel dat zonder `APP_KEY`-klachten start bevestigt het. Druk het bestand niet af. Wil je de
waarschuwing weg, geef de beheerder hetzelfde pad in zijn eigen container of gebruik een pad relatief aan het
Compose-bestand.

### Grenzen buiten de repository

De repository levert zelf geen reverse proxy, CDN of ingress en heeft dus buiten de applicatie geen eigen
grenzen. Alles wat ervoor staat moet verzoeken met een body van minimaal 9437184 bytes (9 MiB, de
branding-import, het grootste verzoek) doorlaten, mag HTML niet cachen en moet de `Host`-header behouden.
De tabel hierboven telt 87 rijen; elke rij noemt een of meer grenzen als getal, met wat ze afdwingt en wat ze begrenst (aangepast bij het sluiten van fase C: er stond 'alle 25 grenzen', een aantal dat al sinds fase B niet meer klopte); de bron van elk
getal is `packages/shared/src/limits.ts`. Belangrijk voor wat ervoor staat: de keep-alive van het paneel is
65 seconden (de idle-timeout van de proxy richting het paneel moet korter zijn, bijvoorbeeld 60 seconden),
het ontvangen van een verzoek mag tot 60 seconden duren, en `docker stop` moet minstens 10 seconden wachten.
Fase C voegt geen verzoekbody toe (de zeven routes zijn `GET`): het grootste verzoek blijft 9437184 bytes. Fase D stap D1 voegt schrijfbodies toe (hoogstens 200 GUID's, circa 8 KB), ver onder de 262144 bytes van elke JSON-body: het grootste verzoek blijft 9437184 bytes. De rijen `RATE_EXPORT` tot en met `contacts.addressMaxChars` zijn de grenzen van stap D1. De vijf
rijen `searchMaxChars` tot en met `cursorEntries` zijn de grenzen van de lijsten met gebruikers en groepen.

### Aanbevolen repository-instellingen

Dit zijn instellingen van de GitHub-repository, geen code: een merge queue of "branches moeten up-to-date
zijn", verplichte checks (`quality`, `e2e`, `image`, `enforce-version-bump`, `agent-instructions-lint`),
secret scanning en push protection. De standaardbranch is `main`.
