# Security

> **Status:** Phase B. This document describes what exists in Phase B (the setup wizard, the Microsoft
> connection, sign-in with Entra, sessions and roles); the Phase A material below stays valid and the Phase B
> material follows it. Phase A, which had no sign-in and no Microsoft connection, is the base. Sources: plan sections 8.1 to 8.10, the data model, the contract and the gate notes
> under [`specs/001-m365portal/gate-notes/`](../specs/001-m365portal/gate-notes/). Every statement about
> Microsoft comes from [`research-microsoft.md`](../specs/001-m365portal/research-microsoft.md) or is
> marked UNVERIFIED in [open-points.md](open-points.md). Nederlandse versie: zie
> [Nederlands](#nederlands).

**Server-side enforcement is the only enforcement.** The UI may hide or disable what an actor may not
do; it is never the control. Every API route goes through the central policy layer, deny by default.

## Threat model (STRIDE)

Surfaces of Phase A and the control for each letter (the Phase B surfaces have their own tables below). Controls are named by the module that holds them;
each has a test and, for the security properties, a fixture that fails on purpose.

| Surface | Spoofing | Tampering | Repudiation | Information disclosure | Denial of service | Elevation of privilege |
|---|---|---|---|---|---|---|
| API writes | Forged `Origin` or CSRF: origin and token checks. Spoofed `X-Forwarded-For`: `TRUST_PROXY` | Tampered body: Zod, size limits | Denials and changes are audited | Problems carry codes, no stacks, no paths | `write` bucket, body limits, timeouts | Deny by default; the route table check refuses a route without access |
| Logo upload | Type confusion: magic bytes, not names | SVG scripts and entities: allowlist rebuild, always rasterised | Upload outcomes are audited | Metadata dropped; no outbound connection from any stage | Pixel cap, element and expansion caps, 10 s kill, 2 plus 4 job slots, staging quota | Stored XSS: PNG only, `nosniff`, CSP `sandbox` on non-HTML |
| Audit store | n/a | Edits and deletes: three triggers plus the hash chain | Append-only; the head is logged | The client address is personal data (documented) | Bounded per client by the buckets (not globally: see the audit chain) | n/a |
| Migrations | n/a | An edited migration file: checksum guard | n/a | n/a | n/a | A newer schema than the application is refused |
| Shell and static files | Nonce reuse: a per-request nonce, a filled shell is never cached | Traversal: path guard, allow-list of file names | n/a | Organisation name reflected: escaped, one replacement pass | A name that is a bomb: 64 grapheme clusters and 256 bytes | XSS: CSP and Trusted Types |

Residual risks are in [open-points.md](open-points.md): PR-05 (sanitised SVG is still rasterised by
native code in a child process with the container's privileges), R-08 (preview mode, closed in Phase B), R-09 (audit
growth), R-14 (in-memory state does not work across replicas).

## Origin and CSRF

For every request under `/api/v1` with a method other than GET, HEAD or OPTIONS:

1. `Origin` must be present and equal the serialised origin of `PUBLIC_BASE_URL`, byte for byte. The
   `Host` header is never used for this. `Origin: null` fails.
2. If `Sec-Fetch-Site` is present it must be `same-origin` (`none` is refused on a write; an unknown or
   empty value is refused). A write with neither `Origin` nor `Sec-Fetch-Site` fails.
3. `X-CSRF-Token` must validate. Format `v1.<iat>.<exp>.<nonce>.<mac>` with base64url fields;
   `mac = HMAC-SHA-256(key, "v1." + iat + "." + exp + "." + nonce + "." + binding)`; the 32-byte key is
   random per process and lives in memory; lifetime 8 hours; accepted while `iat` is at most 5 minutes
   in the future and `exp` plus 60 seconds has not passed; the signature is compared in constant time
   and checked before the times. The Phase B binding of the token is computed from the cookies the browser presented: in Phase A the
   `binding` is the empty string, in Phase B it is the SHA-256 of the session cookie and of the setup cookie
   (joined by `.` when both are present), so a token cannot be carried from one session to another.
4. Failure answers 403 `origin_not_allowed` or `csrf_invalid`, is audited with the reason, and says no
   more than the code. `origin_not_allowed` names the expected origin and the variable `PUBLIC_BASE_URL`,
   so a host port changed without it is diagnosable from the error alone.
5. A GET that writes an audit entry (`branding.export`) runs only the `Sec-Fetch-Site` part (absent,
   `same-origin` or `none` pass; `same-site` and `cross-site` give 403 `origin_not_allowed`, not
   audited), so a cross-site image or form cannot make the server write audit rows or assemble an
   export (the audited-GET rule, FR-A-044).

The client keeps the token in memory, fetches `GET /api/v1/csrf` before the first write, and on
`csrf_invalid` fetches a new one and retries once. The key is per process: a restart invalidates
outstanding tokens, which the client handles by the same retry. A cross-site request learns nothing
about permissions because Origin and CSRF are judged before authorisation.

## Security headers

Every response carries a profile chosen by the response, not the request path alone: **html** (the
shell and the offline page), **worker** (`/sw.js`) and **other** (API, images, health, errors, manifest,
robots, static assets). A 404 for an HTML request is always `other`. Headers are set after the handler,
on every response including errors.

| Header | html | worker (`/sw.js`) | other |
|---|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; script-src 'self' 'nonce-<n>'; style-src 'self' 'nonce-<n>'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types m365portal-sw`, plus `upgrade-insecure-requests` only over https. The offline page uses the same policy without nonce tokens | `default-src 'none'; connect-src 'self'; frame-ancestors 'none'` | `default-src 'none'; frame-ancestors 'none'; sandbox` |
| `Strict-Transport-Security` | only over https (below) | same | same |
| `Cross-Origin-Opener-Policy` | `same-origin` | n/a | n/a |
| `Cross-Origin-Embedder-Policy` | `require-corp` | `require-corp` | n/a |
| `Cross-Origin-Resource-Policy` | `same-origin` | `same-origin` | `same-origin` |
| `Referrer-Policy` | `no-referrer` | `no-referrer` | `no-referrer` |
| `Permissions-Policy` | the curated list | same | same |
| `X-Content-Type-Options` | `nosniff` | `nosniff` | `nosniff` |
| `X-Frame-Options` | `DENY` | n/a | n/a |
| `X-Robots-Tag` | `noindex, nofollow` | same | same |
| `Cache-Control` | `no-store` (offline page `no-cache`) | `no-cache` | per route |
| `Server`, `X-Powered-By`, `Access-Control-*` | never | never | never |

- **Why `/sw.js` has its own profile (V-04).** With the generic `sandbox` policy a registered service
  worker makes every navigation fail; the worker needs `connect-src 'self'` and the COEP that the pages
  have. Confirmed in Chromium 141 only; other browsers are UNVERIFIED.
- **Nonce and caching.** The nonce is 16 random bytes per request, written into the shell in one
  replacement pass together with the other placeholders. A filled HTML shell is never cached (it would
  reuse a nonce), hence `no-store`, and nothing in front may cache HTML.
- **The one exception to "headers on every response" (FR-A-040).** Responses that Node writes itself
  before routing (400, 408, 431 from the `clientError` handler) carry the `other` profile, a fresh
  request id and `Connection: close`, but no HSTS, because the scheme of an unparsed request is unknown.
  `bad_request`, `request_timeout` and `request_header_fields_too_large` are registered (34 codes since amendment 1); their bodies are problem-shaped.
- **413 and `Connection: close`.** A 413 is answered with `Connection: close`. A denied write is recorded with the method, the route template and the permission asked for, and never with a body, a header value or a path.
- **Conditional requests.** The branding documents carry a strong quoted `ETag` and `Cache-Control: no-store, no-transform`; `no-transform` stops the compression layer from weakening the tag, which would make the client's own `If-Match` fail (422 `invalid_etag`). An export whose master file is gone answers 500 `internal_error` on purpose and writes one audit row with outcome `error`.
- **Trusted Types.** Exactly one web module creates the policy `m365portal-sw` (it accepts only
  `/sw.js`); lint forbids a second one. The e2e fixture fails on any `securitypolicyviolation`, page
  error, `console.error` or console warning that mentions `Permissions-Policy`.
- **Permissions-Policy.** The 45 feature names Chromium 141.0.7390.37 recognises, each disabled with an
  empty allow-list, plus `clipboard-write=(self)`. A name the browser does not know logs a console
  warning, which the e2e fixture turns into a failure, so a browser upgrade that drops a name is
  noticed. Firefox and Safari ignore or warn on unknown names: UNVERIFIED. The list is a constant in
  `apps/server/src/http/permissions-policy.ts`; a test compares it with plan Appendix A.
- **Static files** are an allow-list: every path segment matches `[A-Za-z0-9_-][A-Za-z0-9._-]*`, the
  file has an extension, is a regular file whose real path lies inside the web root, and `index.html`
  is never served raw. The shell is served only to a GET or HEAD whose `Accept` contains `text/html`.

### HSTS

Baseline section 13 says `includeSubDomains` is a promise about hosts the operator may not own. The
decisions (BC-01, FR-A-043):

- Plain `max-age` (default 31,536,000 seconds, override `HSTS_MAX_AGE`) is sent on **every https
  response, on any host**: it is a statement about the host being asked.
- `includeSubDomains` (`HSTS_INCLUDE_SUBDOMAINS=true`) and `preload` (`HSTS_PRELOAD=true`) are operator
  opt-ins and are sent **only on the host of `PUBLIC_BASE_URL`**; an alias, an IP address, an internal
  name or a request without `Host` gets plain `max-age`. `preload` is sent only with
  `includeSubDomains` and a `max-age` of at least 31,536,000, and the configuration refuses to start
  otherwise.
- Over http nothing is sent. "https" is `PUBLIC_BASE_URL` being https, or a trusted proxy reporting
  `X-Forwarded-Proto: https`. If TLS ends at a proxy and `PUBLIC_BASE_URL` is http, set `TRUST_PROXY`,
  or no HSTS is sent.
- A proxy that rewrites `Host` loses the flags (the narrow, reversible side). Preserve `Host`.
- Whether the opt-ins are needed for a top grade at the public scanners was not verified (scanner rules
  were not read).

The only producer of the theme CSS that the server writes into the nonce-carrying `<style>` is `renderTokenCss`: every colour is validated as `#rrggbb` first and the output has a closed character set.

## Rate limiting and TRUST_PROXY

Token buckets per class and client address: `read` 120 and 2 per second, `write` 10 and 0.5 per second,
`upload` 3 and 0.1 per second (the numbers are in [operations.md](operations.md#limits-outside-the-repository)).
The client key is the IPv4 address or the IPv6 /64 prefix. `TRUST_PROXY=none` uses the socket peer and
ignores `X-Forwarded-*`; a hop count N trusts N proxies; a list trusts only peers inside it. A
mis-set value lets a client forge its address and slip past the limiter (`TRUST_PROXY=1` without a proxy
is the typical mistake). A 429 is not audited. The limiter and the CSRF key live in memory: one replica
only.

## Upload pipeline

`POST /api/v1/branding/assets` and the branding import. No stage makes a network connection. The image
worker is a **child process** (not a worker thread: a terminated thread leaves the native libvips job
running, V-19) that receives bytes over IPC, returns bytes, opens no files, starts with an empty
environment, runs under Node's permission model and is killed with SIGKILL after 10 seconds.

| # | Stage | Limit | Failure |
|---|---|---|---|
| 1 | `upload` bucket, then `settings:branding` | 3 burst, 0.1 per second | 429, 403 (audited) |
| 2 | Content type `multipart/form-data`; body limit while streaming | 2,162,688 bytes | 415, 413 |
| 3 | Parse in memory; exactly one part `file`; file size; file name and part type are never read | 2,097,152 bytes | 422, 413 |
| 4 | Staging quota (checked read-only before the write, again under the lock) | 32 files, 32 MiB | 409 `staging_quota_exceeded` |
| 5 | Job slot | 2 running, 4 queued | 429 `image_processing_busy` |
| 6 | Magic-byte sniff: PNG, JPEG, SVG (UTF-8, first element `svg` in the SVG namespace); all else refused | | 415 `image_type_unsupported`, 422 `image_empty` |
| 7a | Raster: header, pixel cap, decode with `failOn: 'warning'`, auto-orient, convert to sRGB, first frame only, resize inside the slot bound without enlargement, encode PNG, drop all metadata | 16,777,216 pixels | 422 `image_pixels_exceeded`, `image_corrupt` |
| 7b | SVG: allowlist rebuild (next section), then rasterise to the same bounds | 10,000 elements, depth 64, 100,000 expanded instances, 10 s | 422 `svg_*`, `image_empty`, `image_processing_timeout` |
| 8 | Self-check of the output: a PNG chunk walk allows `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` and the benign `sRGB`, `gAMA`, `pHYs`; never text or profile chunks; the logo luminance is computed | | 500 (a bug, audited as `error`) |
| 9 | SHA-256 of the bytes, atomic write to `.tmp/` then rename, registry upsert in one transaction, audit entry | | 503 on storage failure |

Identical bytes converge on one file and one row. The branding import parses its JSON with a
single-pass scanner that refuses repeated keys, `__proto__`, `constructor`, `prototype` and depth over
8, decodes the body as strict UTF-8 (a byte order mark is refused), and treats `schemaVersion` 2 or more
as `import_unsupported_version`. A dry run is audited.

## SVG allowlist

The sanitiser builds a **new** document from the elements and attributes below; everything else is
dropped with its subtree and reported by category (`script`, `event_handler`, `external_reference`,
`foreign_object`, `style`, `filter`, `animation`, `unknown_element`, `unknown_attribute`). Names match
case-sensitively, as XML does, and an element counts only in the SVG namespace. Because the result is
rasterised and discarded, the allowlist protects the rasteriser, not browsers. The table equals
`SVG_ALLOWLIST` in `apps/server/src/branding/pipeline/svg/allowlist.ts`; `docs-contract.test.ts` fails
when they differ.

| Kind | Names |
|---|---|
| Elements | `svg`, `g`, `defs`, `title`, `desc`, `symbol`, `use`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask` |
| geometry | `x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `rx`, `ry`, `x1`, `y1`, `x2`, `y2`, `fx`, `fy`, `points`, `d` |
| viewport | `viewBox`, `preserveAspectRatio` |
| transform | `transform`, `gradientTransform` |
| presentation | `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray`, `stroke-dashoffset`, `stroke-opacity`, `opacity`, `stop-color`, `stop-opacity`, `offset`, `clip-path`, `clip-rule`, `mask`, `display`, `visibility` |
| units | `gradientUnits`, `spreadMethod`, `clipPathUnits`, `maskUnits`, `maskContentUnits` |
| identity | `id` |
| reference | `href` |

Rules around the table: `use` and `href` (also written `xlink:href`) accept only an internal `#id`;
`id` matches `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`; a `style` attribute is converted (declarations are
parsed and allow-listed by property and value; a backslash, comment or `!important` drops the
declaration); numbers are finite and at most 1,000,000 in magnitude; colours are hex, `rgb()`,
`rgba()`, `hsl()`, a named colour, `none`, `currentColor` or `url(#id)` with an optional fallback; path
data passes a strict tokenizer (commands `MmLlHhVvCcSsQqTtAaZz`, at most 50,000 segments).
`url(#id)` and `#id` must resolve inside the document; the reference graph is checked for cycles and
for transitive expansion above 100,000 instances (`svg_too_complex`). A DOCTYPE is refused
(`svg_doctype_forbidden`), live text is refused (`svg_text_unsupported`: there are no fonts in the
image), and the root gets explicit `width` and `height` from the `viewBox`, so the declared size of the
input is never used. Containers `<a>` and `<switch>` are not supported (recorded limitation).

## Audit chain

`audit_log` is append-only and hash-chained. Three triggers in the first migration refuse `UPDATE`,
refuse `DELETE`, and refuse an `INSERT` whose `seq` is not the head plus one or whose `prev_hash` is not
the hash of the head. Each entry's hash is `SHA-256(prev_hash || canonical(entry))` over a fixed set of
keys (the `detail` is hashed as its stored text, so any byte change shows). `audit/writer.ts` is the
only inserter; it appends synchronously inside `BEGIN IMMEDIATE`, in the same transaction as the change
it records, and logs `{seq, hash}` after the commit as the `audit_head` line. A denial whose audit entry
cannot be written answers 503, not 403 (fail closed). 429 responses are never audited; denied writes
are, with the reason code and the route id.

`node dist/cli.js verify-audit [--from N] [--to M] [--expect-seq N] [--expect-hash HEX]` opens the
database read-only and prints one JSON line. Exit 0: the chain verifies and all three triggers exist.
Exit 1: the chain is broken (`firstBadSeq`), a trigger is missing, or the anchor does not match
(`anchorMismatch`). Exit 2: it could not check.

**What it cannot see (tamper evidence, not tamper proofing).**

- **Tail truncation.** Nothing after the last row refers to it, so rows deleted from the END of the log
  (after the triggers were dropped) leave a valid shorter chain. Only a head recorded elsewhere detects
  it: record the newest `seq` and `hash` (the `audit_head` log line, or a value written down earlier)
  and pass them as `--expect-seq` and `--expect-hash`. A run without the anchor says `ok` for a
  truncated tail.
- **A recomputed chain.** Someone who can write the database file can drop the triggers, edit rows and
  recompute every later hash. The anchor does not help if that person also controls the place where
  the head was recorded. The append-only triggers are no defence against someone who can write the file.
- A deleted row in the middle is reported as `firstBadSeq` of the row after the gap.

**Growth.** Anonymous denied writes are audited, so an unauthenticated client can make the table grow
without bound within the rate limit of each address; many source addresses multiply it. A global cap on
denial rows is an open decision (R-09, OD-10, retention in Phase D); see
[operations.md](operations.md#retention-and-audit-growth).

**Personal data.** The client address exists only in the audit table (and its backups) and is personal
data; logs never carry it. Backups have the same protection as the live database.

## Preview mode (removed in Phase B)

Phase A had a preview mode that gave an unauthenticated visitor all 15 permissions so that the panel could be
evaluated. The preview-mode risk (R-08, OD-03) is closed: `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE`
were removed in Phase B, the actor kinds are `anonymous`, `user`, `setup` and `break_glass`, and a
repository guard fails on any reintroduction of the name. Anonymous writes now answer 401 instead of 403. An
existing `.env` that still sets the old variables gets one warning at start and is otherwise ignored.

## Phase B threat model (STRIDE)

Phase B adds eight surfaces. A cell names the threat and the control that answers it; the controls are
tested, and the security properties have fixtures that fail on purpose (the negative controls of the plan,
section 14.6).

| Surface | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Setup gate (unconfigured panel) | a stranger opens `/setup`: one-time token, constant-time compare, per-client and global lock | token in URL: accepted only in a POST body | unlock locks audited once | token never in logs, shell, OpenAPI; `Cache-Control: no-store` | lock flooding by many clients: global lock is the accepted cost; counters bounded | wizard grants tenant admin: token + Entra administrator both needed |
| Wizard and bootstrap token | a phisher shows a fake device code: only the allow-listed `https` host is rendered as a link | partial writes: idempotent sub-actions, full-list credential PATCH | every object change audited in the same transaction | bootstrap token memory only, discarded before probes | runaway retries: bounded windows and tries | bootstrap holds `RoleManagement.ReadWrite.Directory` only for the run |
| Sign-in | login CSRF and token substitution: `state`, `nonce`, PKCE, transaction cookie | forged ID token: signature, issuer, tenant, audience, algorithm, nonce, header checks | sign-in and every denial audited from token validation on | no token retained; `no-store`; code never logged | transaction floods: caps and rate class `auth` | user without a role gets no session |
| Sessions | stolen cookie: `HttpOnly`, `Strict`, hashed at rest, idle and absolute timeouts | rotation prevents fixation | sign-out and revocation audited | only the hash stored, no IP or agent | per-principal cap of 10 | step-up for role changes |
| RBAC and policy | spoofed actor: actor from the cookie only | role tampering: immutable built-ins by trigger | role and assignment changes and every 403 audited | `me` exposes only the actor's own data | assignment and group limits | no privilege escalation, last Owner protected, scope enforced server-side, fail closed |
| Secrets | key theft from backup: key not in `/data` | blob swap: AD binds row, purpose, key id | rotation audited | sealed blob only; redacted holder | missing key: degraded, not crash | key never leaves `secrets/` |
| Break-glass | brute force: scrypt, 5 per 15 minutes, 20 per hour, one-slot queue | no input but the credential pair, size-limited and validated | every use audited and logged loudly | username never logged | memory-bound verification (128 MiB) | restore-Owner only, no other write |
| Microsoft clients | host confusion: fixed origins, `redirect: 'error'`, GUID-validated paths | injection into OData: escaped literals | calls counted | tokens opaque wrappers, never logged | throttling: bounded retry, `Retry-After` honoured | runtime app never holds `FORBIDDEN_APP_ROLES` |

## First-run takeover

An unconfigured panel is the one moment when the product is open to whoever reaches the port. The controls
are layered. The setup token is 32 random bytes (or a validated `SETUP_TOKEN`), compared in constant time,
accepted only in a POST body, never logged and never in a URL, the shell or the OpenAPI document. Failures
are bounded per client and globally; the cost is that an attacker can lock the unlock for an hour (RB-17).
Over plain http the setup routes answer 404 to a non-loopback `Host` and to any request that carries a
forwarding header, so a panel exposed by mistake looks like a panel that is not there, and so DNS rebinding
against a `localhost` panel finds nothing: the loopback `Host` rule gives the rebinding page a 404, the
cookies are host-bound, and writes need an Origin and a token anyway. After the lock `/setup` answers 404
for ever (a restart does not reopen it). `setup-reopen` is the only way back, needs `--confirm`, refuses
while `SETUP_TOKEN` is set in the environment (a variable that may be known from compose files, tickets or
shell history would otherwise govern again), and blocks sign-in until the wizard has finished. The wizard
itself needs an Entra administrator as well as the token, and it asks the operator to confirm who becomes
Owner (`confirmOwnerOid`). A host administrator can read the token file; host compromise is out of scope.

## Cookies and the CSRF binding

There are three cookies, all `HttpOnly`, `Path=/`, without `Domain`, with 256-bit random values: the session
cookie (`Strict`), the OIDC transaction cookie (`Lax`, 10 minutes, because the callback is a cross-site
navigation) and the setup cookie (`Strict`). On https they carry the `__Host-` prefix and `Secure`. On
`http://localhost` the plain names are used and `Secure` is omitted: that is the trade-off of a local trial
(ODB-15, BC-03). Cookies are not isolated by port, so another application on `localhost` can read and
overwrite them; use https for anything but your own computer. The authorize request uses
`response_mode=query` and the callback answers a 200 interstitial instead of a 303 so that the `Strict` cookie
reaches the first paint. A cross-site entry drops the `Strict` cookie; the web app re-checks `/api/v1/me`
once at boot (PB-15).

The combined CSRF binding (SB-09, FR-B-408) is the SHA-256 of the session cookie value and of the setup cookie
value, joined by `.` when both are present, computed from the cookies as sent without a database read. An
Owner who reopened setup holds both cookies, so one binding serves both route families. A token for another
binding fails with `csrf_invalid`; after a rotation the client fetches a new one once. Origin and CSRF are
judged before authorisation, so a cross-site request learns nothing about permissions.

## Sessions and step-up

A session id is 256 random bits; only its SHA-256 is stored, with no IP address and no user agent, and no
Microsoft token is retained. Sign-in and step-up issue a new id (no fixation). The defaults are 30 minutes
idle and 8 hours absolute, at most 10 sessions per person, and "sign out everywhere". The polled wizard and
connection routes do not slide the session, so a forgotten tab cannot keep a session alive. A write that
needs the step-up window (10 minutes) requires a recent sign-in with credentials (`prompt=login`), a fresh
`auth_time`, the same `oid` and the MFA policy again; Entra documents neither `max_age` nor an ID-token
`claims` request, and `prompt=login` does not force MFA, so a step-up without MFA ends in `mfa_required` or
`amr_missing` and not in a loop. Revocation of group-derived rights follows the group cache
(`GROUP_CACHE_TTL_SECONDS`, 300) and Graph's own consistency; direct assignments revoke at once. An Entra
group cannot be bound to a role that holds `rbac:manage` or `settings:connection` (FR-B-515, ODB-16).

## Control from the Entra side and the blast radius

The panel's power is the power of one application identity at Microsoft. The service principal holds the
Entra role Exchange Administrator (the default, B-03), which is broad: the Exchange Administrator blast
radius is every Exchange Online task, and the panel's RBAC is the only thing that narrows it. Outside the
panel, control sits with other people. Group owners, a Groups Administrator or a dynamic rule control who
is in an Entra group that is bound to a panel role; the guard against binding privileged roles to groups
exists for this reason. Application owners and credential holders of the runtime application can add
credentials to it at any time and then act as the application, outside the panel's RBAC and audit
(RB-18); the wizard shows foreign owners and credentials, refuses to adopt an application with a client
secret without an acknowledgement (FR-B-318, FR-B-319, ODB-18), and the runtime application never holds
`FORBIDDEN_APP_ROLES`. Review the owners and the credentials of the application in Entra regularly.

## The certificate: a self-signed trade-off

The application authenticates to Entra with a certificate instead of a client secret. The certificate is
self-signed: Learn advises a CA certificate for production, and a self-hosted panel has no CA, so the
trade-off is accepted. The private key never leaves the process: it is sealed in the database with
`APP_KEY`, has no export method and is opened only to sign an assertion. Microsoft limits a credential to
one year; the panel creates 360 days and shows banners at 60 and 14 days.

## Key compromise

`APP_KEY` seals the private key of the certificate. A leak of the key alone is harmless without the
database, and a leak of the database alone is sealed. If both leak, rotate the key, delete older copies of
`/data` and every `pre-rotate-*` backup, and renew the certificate: rotating `APP_KEY` does not renew the
certificate, because it re-seals the same private key. The procedure is in
[operations.md](operations.md#key-compromise-a-leaked-or-compromised-key). An `-e APP_KEY=...` value is
visible in `docker inspect` to anyone who can read the container configuration: prefer a Docker secret,
`APP_KEY_FILE` or a platform secret. Break-glass is a second place where a secret matters: its scrypt hash
sits in the environment, the password is at least 14 characters, and the route should be restricted by
address at the reverse proxy.

## Break-glass without a second factor

Break-glass bypasses Conditional Access and MFA by design: its password plus any enabled account in the
tenant, a B2B guest included, restores an Owner. The controls are a memory-capped scrypt verification (one at
a time), 5 attempts per 15 minutes and 20 per hour, equal work for an unknown user, a 30-minute session that
does not slide, restore-Owner as the only action, refusal of a disabled account, and an audit entry and a loud
log line for every use. A second factor and an in-app address allow-list are Phase D (ODB-17). Until then the
proxy restriction in operations.md is the control.

## Why the response headers did not change

Phase B adds pages and cookies but no new kind of content: the Content-Security-Policy, Trusted Types, the
frame, referrer and permissions headers are unchanged, and the headers on the new routes are the same
function of the same table. The Microsoft sign-in page is reached by a top-level redirect, so no
`form-action` or `frame-src` entry for Microsoft is needed. `Cache-Control: no-store` is added on the
sign-in, setup and session routes.

## Device code flow and manual mode

The wizard's sign-in uses the device code flow. Anyone can phish a device code of the same Microsoft client
outside the panel. Outside the wizard window, block the device code flow with a Conditional Access policy
and use manual mode, the checklist alternative, when you next need the wizard (research §5.6). Inside the
panel the code exists only for the setup actor, one run at a time, for 15 minutes, with an allow-listed
https link host.

## What the simulation cannot prove

The test suite runs the whole product against a simulated tenant that the tests built from Microsoft Learn.
The simulation cannot prove that Entra behaves as Learn says (an unverified claim has a register row), that
browsers treat the `SameSite` redirect chain as designed, or that the real tenant accepts what the wizard
sends. The owner-verified ledger OV-01 to OV-23 in [open-points.md](open-points.md) lists what only the owner
can check; no automated control covers those items.

## Application verification (ASVS level 2), Phase B rows

| ASVS chapter | Phase B status |
|---|---|
| V2 Authentication | Authorization code flow with PKCE, `state`, `nonce` and a certificate assertion; ID-token checks of algorithm, issuer, `tid`, audience and nonce (fixtures F-02 to F-45); MFA through `amr`; break-glass with scrypt |
| V3 Session management | Server-side sessions, hashed ids, rotation, idle and absolute timeouts, sign-out everywhere, step-up, `__Host-` cookies on https |
| V4 Access control | Deny by default, immutable built-in roles, scopes enforced per resource type, last-Owner protection, no privileged role for groups, fail-closed policy layer |
| V6 Stored cryptography | XChaCha20-Poly1305 with a per-purpose subkey and associated data, random nonces, a known-answer vector, rotation, constant-time comparisons |
| V7 Error handling and logging | Problem codes without Microsoft text, redacted logs with canary tests, audit of every write and authenticated denial in the same transaction |
| V8 Data protection | Tokens are never retained, the certificate key is sealed, backups are sealed, `Cache-Control: no-store` on session routes |
| V13 API and web service | Route table with access and audit declarations, OpenAPI generated from it, strict content types, Origin and CSRF, body limits |

The mapping to individual controls (the ASVS version is U18) is completed in Phase D (FR-D-006).

## Attack review of the design

The analysis pass of 2026-10-10 attacked one surface per row, named the control that already stood, the gap
it found and what was done. Residual risks are accepted and listed below.

| # | Attack | Existing control | Gap found | Fix or decision | Residual |
|---|---|---|---|---|---|
| 1 | First-run takeover of `/setup` | Setup token (32 random bytes, or a validated `SETUP_TOKEN`), constant-time compare, per-client and global lock, 404 after the lock, loopback guard over plain http, token only in a POST body, never logged (FR-B-203 to FR-B-207) | After `setup-reopen` a `SETUP_TOKEN` still set in the environment governs again, although it may be known (compose files, tickets, shell history) | FR-B-223: the CLI refuses while the variable is set; a warning at start; EB-37 | The global lock can be used to deny unlocking (RB-17); a host administrator can read the token file (host compromise is out of scope) |
| 2 | Device-code phishing and consent abuse | A device code exists only for the setup actor, one run at a time (lease), 15-minute life, link host allow-list, Entra `message` never rendered, consent on behalf of the organisation left off, three scopes, token in memory and discarded before the probes (FR-B-214, FR-B-215) | Nothing made the operator confirm who becomes Owner; the panel cannot stop phishing of the same Microsoft client outside itself | `confirmOwnerOid` on finish (FR-B-219 h); `docs/security.md` advises blocking device code flow by Conditional Access outside the wizard window and using manual mode then (research §5.6) | Entra-side phishing is outside the panel; the holder of the setup token is trusted |
| 3 | Bootstrap token handling | FR-B-215: one object, no cache plugin, four discard triggers, canary lifecycle test | none | Covered | Memory residue after `memzero` in a garbage-collected runtime, core dumps and swap: documented |
| 4 | CSRF, login CSRF, session fixation | Origin plus a token bound to the presented cookies; single-use state, nonce and Lax transaction cookie; a new session id at sign-in and step-up; `__Host-` names; fixtures F-28 to F-33 | none | Covered | Plain cookie names and shared cookies across ports on `http://localhost` (ODB-15) |
| 5 | Open redirect through `returnTo` | `safeReturnTo` (single leading `/`, no `//`, `\`, control character or scheme, 256 characters, not `/api/` or `/setup`); logout URL built by the server and checked by the client | The hostile table was server-side only; the web sign-in page also reads `returnTo` from its own URL | FR-B-402: the page applies the same function; `web/signin.test.tsx` hostile table | none |
| 6 | ID-token gaps: algorithm confusion, `tid`, `aud`, `iss`, nonce replay, clock skew | `RS256` only, `jku`, `x5u`, `jwk`, `crit` refused, `aud` a string, `iat` bounded, exact issuer, pinned `tid`, single-use nonce, 60 s tolerance, F-02 to F-27 with mutant validators (plan 8.6.5, V-B07) | none | Covered | The tolerance is ours (U33, U35) |
| 7 | PKCE downgrade | S256 only, exact authorize parameter list, verifier of 32 random bytes, `authorize-request.test.ts` | none | Covered | none |
| 8 | Cookie scoping | No `Domain`, `Path=/`, `__Host-` on https, Strict, duplicate cookies fail closed | none | Covered | Another application on `localhost` can read the plain cookies |
| 9 | Session store theft | Only SHA-256 of a 256-bit id stored, no IP or agent, no token retained (FR-B-407, FR-B-418) | A tab polling the wizard or connection page kept a user session alive indefinitely, defeating the idle timeout | FR-B-420 (`slidesSession: false` on the polled routes) | none |
| 10 | RBAC escalation by granting | `canGrant` on create and delete, early and again inside `BEGIN IMMEDIATE`; `actorKinds: ['user']` on both routes; only break-glass restores an Owner | none for the API | Covered | The gap between `authorize` and a later Graph write (Phase C and D) is closed by the capability-branded arguments of 11.9, not by a lock |
| 11 | Group-based roles | `checkMemberGroups`, token groups ignored, hidden and deleted groups fail closed (FR-B-507) | An Entra group bound to `owner` (or any role holding `rbac:manage` or `settings:connection`) makes whoever controls the group (group owners, Groups Administrator, a dynamic rule) a panel Owner with no panel audit entry | FR-B-515 and `GROUP_FORBIDDEN_PERMISSIONS`; EB-38; ODB-16 | The *Beheerder* group of the wizard stays allowed: that role holds neither permission |
| 12 | Expiry races and last-Owner races | Memo with the earliest expiry, epoch triggers, `BEGIN IMMEDIATE` plus triggers, 100 repetitions of the concurrent test | none | Covered | An Owner deleted in Entra still counts as an Owner (break-glass recovers) |
| 13 | Scope bypass through bulk, search and export paths | `visibleScopes` for lists, search, bulk and exports, capability-branded arguments, `policy_not_applied` (11.8, 11.9) | A route could return user attributes in another shape and so widen a `basic` grant | 11.9 and spec 13.3: every response with user attributes passes `projectUser`; the Phase C route-table guard is named | Phase C and D routes do not exist yet |
| 14 | Break-glass abuse | Memory-capped scrypt, one at a time, 5 per 15 minutes and 20 per hour, equal work for an unknown user, 30-minute non-sliding session, `rbac:manage` only, restore-Owner only, every use audited and logged | The spec's N range exceeded the memory cap (SB-04, now applied); no password floor; restore accepted a disabled account; password plus any enabled account (a B2B guest included) restores an Owner | FR-B-521, FR-B-110 (14 characters), FR-B-523 (disabled refused); ODB-17 (second factor, address allow-list, `Member`-only) and the proxy restriction in `docs/operations.md` | No second factor until Phase D; the route and `features.breakGlass` reveal that break-glass exists |
| 15 | Audit gaps | Every write and every authenticated denial in the same transaction, 503 when the denial entry cannot be written | Three control actions (P12, P23, P24) wrote nothing and the rule said every write is audited | FR-B-601 states the exemption list and the coverage test pins it | Pre-validation callback failures are unaudited by design (B-24) |
| 16 | Log leakage of tokens, certificates, `APP_KEY` | Canaries in `no-leak.test.ts`, redacting holder, typed errors without Microsoft text, key never in `/readyz` | `-e APP_KEY` is visible in `docker inspect` | `docs/security.md` and README prefer a Docker secret or `APP_KEY_FILE` | Anyone who can read the container environment can read `-e` values |
| 17 | Nonce reuse and associated data | 24 random bytes per seal, associated data binds purpose, row id and key id, known-answer vector | No test that nonces differ | FR-B-105 control: 10,000 seals of one plaintext give 10,000 distinct nonces | none |
| 18 | Private key in backups | Sealed blobs only, `APP_KEY` not under `/data`, `pre-rotate-*` useless without the old key | Rotating a possibly exposed `APP_KEY` re-seals the same private key | FR-B-109 and `docs/operations.md`: renew the certificate and delete older copies | A leaked key together with an older copy of `/data` |
| 19 | SSRF through the wizard | Fixed origins, `redirect: 'error'`, GUID or escaped path segments, `verification_uri` allow-list, discovery host check, Graph `nextLink` same-origin rule | The Exchange `nextLink` had no origin rule and the tenant hint no pattern | FR-B-317 and `server/integrations/url-discipline.test.ts` | none |
| 20 | Wizard step replay | Preconditions per step, one runner lease, idempotent sub-actions, setup CSRF | A replayed `finish` was not refused; nothing named the Owner | State `in_progress` precondition and `confirmOwnerOid` (FR-B-219 h) | none |
| 21 | Adopting a pre-created application | Install tag, ambiguity stop, explicit confirmation | An application someone pre-created with a client secret or foreign owners would receive the permissions the wizard grants, and its owner could add credentials later | FR-B-318 (inspection, refusal, acknowledgement), FR-B-319 (foreign credentials stay visible), ODB-18 | An Application Administrator can always add credentials: the blast radius is documented |
| 22 | A request assigns an arbitrary directory role to the runtime application | The role was "a setting" and a free GUID in the contract; the bootstrap token holds `RoleManagement.ReadWrite.Directory` | Any template id, a privileged one included, could be named | `EXCHANGE_ROLES` (two keys) in FR-B-308 and the contract, CD-14 | none |
| 23 | DNS rebinding against a localhost panel | Setup routes answer 404 to a non-loopback `Host`; cookies are host-bound, so a rebinding page sees only anonymous data; writes need Origin and a token | none | Covered; written up in `docs/security.md` | none |
| 24 | Denial of service on the emergency paths and on sign-in | Bounded counters, a rate class `auth`, a queue for break-glass, 20 login transactions per client | Global bounds can be exhausted by an attacker, and a flood from many addresses can evict in-flight login transactions (1,000 in total) | RB-17; a container restart resets the counters; the proxy can restrict both routes | Accepted |
| 25 | Information disclosure through public routes | `GET /api/v1/me` and the authorize redirect show only what a visitor already sees (state, tenant and application ids, whether break-glass is on) | none worth a change | Accepted | An attacker learns that break-glass exists |

## Accepted risks

- RB-17: an attacker can keep the break-glass route or the setup unlock locked, because the failure bounds
  are global (20 and 30 per hour); a restart resets the counters, and the reverse proxy can restrict both
  routes by address.
- RB-18: whoever controls an Entra group, owns the application or holds one of its credentials gains power
  outside the panel's RBAC and audit; the blast radius is documented above.
- Memory residue: a key or token can stay in the memory of a garbage-collected runtime after it is wiped, and
  in core dumps or swap.
- The gap between `authorize` and a later write (Phases C and D) is closed by capability-branded arguments
  and not by a lock.
- The existence of break-glass is visible: the route and `features.breakGlass` show that it exists.
- Plain cookie names and cookies shared across ports on `http://localhost` (ODB-15).
- The clock tolerance of the ID token is ours (U33, U35); the self-signed certificate (above); a global lock
  can deny unlocking (RB-17); R-08 (preview mode) is closed.

## Errors, logging and leaks

Problem bodies carry `type`, English `title` and `detail`, `status`, `code`, `requestId` and, for
validation, `errors[]`; the UI maps the code to a translated message. SQLite errors map by their code
(read-only, full, I/O and cannot-open to 503 `storage_unavailable`; busy and locked to 503
`storage_busy` with `Retry-After: 1`; corrupt and not-a-database to 503 plus `/readyz` `database_corrupt`,
no automatic repair). Logs are JSON on stdout with deep redaction; a request line holds the request id,
method, route template, status and duration only: no query string, body, address, e-mail address or
organisation name. An unhandled error is logged by name, code and stack frames, never its message or
cause. A test throws a canary secret inside a handler and greps the response and the log.

## Supply chain: what is wired and what only runs on GitHub

Wired and run locally: pinned actions by commit SHA with the version in a comment
(`scripts/resolve_action_pins.py`, `scripts/test_workflows.py`), `actionlint`, the Dockerfile pin check
(digests of both base images), the image contents and size checks, `pnpm audit --prod`, `pnpm audit`
at high level, a frozen lockfile with exact versions, Dependabot configuration with reasoned ignore
rules, and the version guard.

Only runs on GitHub, never run here: the workflows themselves, CodeQL, Dependabot, Trivy (image and
secret scan), the SBOM, cosign signing (public repositories only), build provenance attestations, the
GHCR push, the arm64 build and QEMU smoke, and secret scanning and push protection (repository
settings). The first run of each is a risk (PR-12), listed in the open points. Claim at most SLSA v1.0
Build Level 2.

## Known limitations of the repository guards

The ESLint rules and the repository scans are a first line of defence against, for example, raw colours,
literal UI text, string-built SQL, direct storage access and a second implementation of a shared rule.
An adversarial review (`chunk-g0-guard-review.md`, accepted as known limitations, not fixed in Phase A)
found evasions; none is exploitable by a user of the product, they are ways a developer could slip a
violation past a syntactic check. The backstops are the Trusted Types CSP checked in e2e, the
boot-time route table check, the server-side policy layer and code review. The register (ids
GR-1 to GR-23, severity as the review rated it) is in [open-points.md](open-points.md#guard-limitations).
In short: a nested or narrowed ESLint configuration, `describe.skip` or a vitest `exclude`, a script
that was hollowed out, and an `eslint-disable` of a non-local rule without a reason pass the guards;
the UI-string rule follows only simple `const` literals and not component props; the SQL rule misses
indirect calls; the colour scans miss percent-encoded hex in data URIs; the single-implementation scan
matches function names, so look-alikes under other names pass and a few legitimate names are flagged;
the file walker ignores symlinks.

## Application verification (ASVS)

Target: OWASP ASVS **level 2**. The ASVS text was not read for this task, so no control identifier is
copied here and the version to map against (4.0.3 or 5.0) is not fixed: that is UNVERIFIED (U18 in
[open-points.md](open-points.md)). The mapping is therefore kept at chapter level and the status of a
chapter is what Phase A does, not a claim of conformance.

| Chapter (topic) | Phase A status |
|---|---|
| Architecture and threat modelling | STRIDE model above; ADRs in `docs/adr/` |
| Authentication | Not applicable in Phase A; Phase B: see the ASVS level 2 table of Phase B below |
| Session management | Not applicable in Phase A; Phase B: see the ASVS level 2 table of Phase B below |
| Access control | Deny by default `authorize`, route table check, audited denials; Phase B adds roles, scopes and the policy layer |
| Validation, sanitisation and encoding | Zod on every route, escaped one-pass shell fill, SVG rebuild, strict import parser |
| Stored cryptography | No secret stored in Phase A (Phase B seals the certificate key); CSRF key in memory; hashes are SHA-256 |
| Error handling and logging | Problem codes, redacted logs, no personal data in logs, hash-chained audit |
| Data protection | Client address classified as personal data; 0700/0600 permissions; backups follow the same rule |
| Communications | HSTS rules, `upgrade-insecure-requests`, plain HTTP only behind an operator-supplied TLS terminator |
| Malicious code and supply chain | Pinned actions and base images, audit, SBOM and signing on GitHub only |
| Business logic | Staging quota, single-row branding with revision checks (`If-Match`) |
| Files and resources | Upload pipeline above |
| API and web service | OpenAPI generated from the routes; strict content types; Origin and CSRF |
| Configuration | Environment schema that names variables and never echoes values; hardened Compose example |

The mapping to individual controls is completed in Phase D (FR-D-006).

## Nederlands

Dit document beschrijft wat er in Fase A bestaat (nog geen aanmelding en geen Microsoft-koppeling).
Servergerichte afdwinging is de enige afdwinging: de UI mag verbergen wat niet mag, maar is nooit de
controle.

### Dreigingsmodel

De STRIDE-tabel hierboven beschrijft per oppervlak (API-schrijfacties, preview-modus, logo-upload,
auditopslag, migraties, shell en statische bestanden) de maatregel tegen vervalsing, manipulatie,
ontkenning, informatielek, denial of service en rechtenverhoging. Restrisico's staan in
[open-points.md](open-points.md): PR-05, R-08, R-09 en R-14.

### Origin en CSRF

Elke schrijfactie onder `/api/v1` moet een `Origin` hebben die byte voor byte gelijk is aan de oorsprong
van `PUBLIC_BASE_URL` (nooit `Host`), een toegestane `Sec-Fetch-Site` en een geldig `X-CSRF-Token`
(HMAC-SHA-256, 8 uur, sleutel per proces in het geheugen). In Fase A is de binding van het token leeg; in
Fase B is het de sessie-id. Een GET die een auditregel schrijft (het exporteren van de branding) past
alleen de `Sec-Fetch-Site`-regel toe, zodat een cross-site verzoek geen auditregels kan laten schrijven.

### Beveiligingsheaders

Drie profielen: html (schil en offline-pagina, CSP met nonce, Trusted Types, COOP en COEP), worker
(`/sw.js`, een eigen profiel omdat het generieke `sandbox`-beleid elke navigatie breekt zodra de worker
geregistreerd is) en overig (API, afbeeldingen, health, fouten). Een ingevulde HTML-schil wordt nooit
gecachet (de nonce is per verzoek). De enige uitzondering zijn de antwoorden die Node zelf schrijft (400,
408, 431). De Permissions-Policy is geverifieerd in Chromium 141; Firefox en Safari zijn niet geverifieerd.

HSTS: gewone `max-age` op elke https-respons; `includeSubDomains` en `preload` alleen als de operator ze
aanzet en alleen op de host van `PUBLIC_BASE_URL`; over http wordt niets gestuurd. Laat een proxy de
`Host`-header ongewijzigd door.

### Uploadpijplijn en SVG-lijst

Negen stappen (rate limit en recht, groottegrens, parsen, quotum, wachtrij, magic bytes, verwerking,
zelfcontrole van de uitvoer, opslag). De beeldverwerking draait in een kindproces dat na 10 seconden met
SIGKILL wordt gestopt. SVG wordt opnieuw opgebouwd uit de toegestane elementen en attributen in de
tabel hierboven (gelijk aan `SVG_ALLOWLIST`) en daarna altijd naar PNG gerasterd.

### Auditketen en de beperking

De audittabel is append-only met drie triggers en een hash-keten. `verify-audit` ziet **niet** dat rijen
aan het EINDE van het log zijn verwijderd (afkappen van de staart): bewaar daarom de nieuwste `seq` en
`hash` (de logregel `audit_head`) en geef ze mee als `--expect-seq` en `--expect-hash`. Wie het
databasebestand kan schrijven kan de triggers laten vallen en de hele keten herberekenen; dit is
sporen-bewijs, geen manipulatiebescherming. Anonieme geweigerde schrijfacties worden ook gelogd en kunnen
de tabel dus laten groeien. Het clientadres in het auditlog is persoonsgegeven.

### Fase B: STRIDE, aanvalsbeoordeling en aanvaarde risico's

Fase B voegt acht oppervlakken toe: de installatiepoort, de wizard met het bootstrap-token, aanmelden,
sessies, RBAC en beleid, geheimen, break-glass en de Microsoft-clients. De STRIDE-tabellen en de aanvalsbeoordeling
van 25 punten staan in het Engelse deel hierboven. Belangrijkste punten: het setup-token en de 404 op `/setup`
na de eerste aanmelding van de Eigenaar; cookies met `__Host-` via https en gedeeld over poorten op
`http://localhost`; een CSRF-binding op beide cookies; sessies met gehashte id's, time-outs en een extra
verificatie; `APP_KEY` versleutelt de certificaatsleutel en roteren vernieuwt het certificaat niet; break-glass
zonder tweede factor (ODB-17) met de beperking op de reverse proxy. De ASVS-rijen V2, V3, V4, V6, V7, V8 en V13
staan in de tabel van Fase B. Het preview-risico R-08 is gesloten doordat de previewmodus is verwijderd.

### Preview-modus (verwijderd in Fase B)

Risico: wie de poort kan bereiken beheert het uiterlijk. De regel op `Host` en doorstuurheaders voorkomt
onbedoelde blootstelling achter een proxy, maar is geen beveiligingsgrens: de grens is de poort alleen op
loopback publiceren (`127.0.0.1`). Preview-modus verdwijnt naar verwachting in Fase B (OD-03).

### Bekende beperkingen van de bewakers

De lint-regels en repositorycontroles zijn een eerste verdedigingslinie; een adversarial review vond
omzeilingen (register GR-1 tot GR-23 in open-points.md), geaccepteerd als bekende beperking.
Vangnetten: Trusted Types in e2e, de routetabelcontrole bij het opstarten, de beleidslaag en review.

### ASVS

Doel is ASVS niveau 2. De ASVS-tekst is voor deze taak niet gelezen; daarom staat de mapping op
hoofdstukniveau en is de versie ONGEVERIFIEERD (U18). De volledige mapping volgt in Fase D.
