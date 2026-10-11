# Security

> **Status:** Phase A. This document describes what exists in Phase A (no sign-in, no Microsoft
> connection yet). Sources: plan sections 8.1 to 8.10, the data model, the contract and the gate notes
> under [`specs/001-m365portal/gate-notes/`](../specs/001-m365portal/gate-notes/). Every statement about
> Microsoft comes from [`research-microsoft.md`](../specs/001-m365portal/research-microsoft.md) or is
> marked UNVERIFIED in [open-points.md](open-points.md). Nederlandse versie: zie
> [Nederlands](#nederlands).

**Server-side enforcement is the only enforcement.** The UI may hide or disable what an actor may not
do; it is never the control. Every API route goes through the central policy layer, deny by default.

## Threat model (STRIDE)

Surfaces of Phase A and the control for each letter. Controls are named by the module that holds them;
each has a test and, for the security properties, a fixture that fails on purpose.

| Surface | Spoofing | Tampering | Repudiation | Information disclosure | Denial of service | Elevation of privilege |
|---|---|---|---|---|---|---|
| API writes | Forged `Origin` or CSRF: origin and token checks. Spoofed `X-Forwarded-For`: `TRUST_PROXY` | Tampered body: Zod, size limits | Denials and changes are audited | Problems carry codes, no stacks, no paths | `write` bucket, body limits, timeouts | Deny by default; the route table check refuses a route without access |
| Preview mode | An exposed instance acts as administrator: remote guard, loopback `Host` and no forwarding headers (FR-A-036), a banner | n/a | The audit names the actor `preview` | n/a | n/a | By design all permissions, loopback only unless overridden; the documented command publishes the port on `127.0.0.1` |
| Logo upload | Type confusion: magic bytes, not names | SVG scripts and entities: allowlist rebuild, always rasterised | Upload outcomes are audited | Metadata dropped; no outbound connection from any stage | Pixel cap, element and expansion caps, 10 s kill, 2 plus 4 job slots, staging quota | Stored XSS: PNG only, `nosniff`, CSP `sandbox` on non-HTML |
| Audit store | n/a | Edits and deletes: three triggers plus the hash chain | Append-only; the head is logged | The client address is personal data (documented) | Bounded per client by the buckets (not globally: see the audit chain) | n/a |
| Migrations | n/a | An edited migration file: checksum guard | n/a | n/a | n/a | A newer schema than the application is refused |
| Shell and static files | Nonce reuse: a per-request nonce, a filled shell is never cached | Traversal: path guard, allow-list of file names | n/a | Organisation name reflected: escaped, one replacement pass | A name that is a bomb: 64 grapheme clusters and 256 bytes | XSS: CSP and Trusted Types |

Residual risks are in [open-points.md](open-points.md): PR-05 (sanitised SVG is still rasterised by
native code in a child process with the container's privileges), R-08 (preview mode), R-09 (audit
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
   and checked before the times. The Phase B binding of the token is the session id: in Phase A the
   `binding` is the empty string, in Phase B it is the id of the session, so a token cannot be carried
   from one session to another.
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

## Preview mode

Preview mode (`PREVIEW_MODE=true`) gives the preview actor all 15 permissions without sign-in, so that
the Phase A panel can be evaluated. The preview-mode risk: anyone who can reach the port administers the
branding. Controls, in layers:

- Start refuses `PREVIEW_MODE=true` with a non-loopback `PUBLIC_BASE_URL` host unless
  `PREVIEW_MODE_ALLOW_REMOTE=true`.
- Per request, the preview actor is resolved only when `Host` is loopback and the request carries none
  of `Forwarded`, `X-Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`, `CF-Connecting-IP`,
  `True-Client-IP`, `X-Client-IP`, `X-Envoy-External-Address`, `Fastly-Client-IP` or
  `X-Original-Forwarded-For` (presence counts, case ignored). Otherwise the actor is anonymous. A
  request can be downgraded by this rule but never chooses or upgrades its actor.
- A permanent banner, a start warning on stderr and in the log, and the posture line field
  `previewBoundary: host-detection-not-a-security-boundary`.

**Limit.** The `Host` and header rule prevents accidental exposure behind a proxy; it is not a security
boundary. A client that can reach the port directly can send `Host: localhost` and no forwarding header
and be the preview actor. The boundary is publishing the port on loopback only
(`127.0.0.1:<port>:<port>`). Preview mode is planned to be removed in Phase B (OD-03).

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
| Authentication | Not applicable yet: no sign-in in Phase A (Phase B) |
| Session management | Not applicable yet: no session or cookie in Phase A (Phase B) |
| Access control | Deny by default `authorize`, route table check, audited denials; actors limited to anonymous and preview |
| Validation, sanitisation and encoding | Zod on every route, escaped one-pass shell fill, SVG rebuild, strict import parser |
| Stored cryptography | No secret stored in Phase A; CSRF key in memory; hashes are SHA-256 |
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

### Preview-modus

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
