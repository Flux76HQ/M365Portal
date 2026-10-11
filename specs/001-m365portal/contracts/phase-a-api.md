# Contract: Phase A HTTP API

**Spec**: [../spec.md](../spec.md) (FR-A-020 to FR-A-027, FR-A-080 to FR-A-097, section 6.3 to 6.5) | **Plan**: [../plan.md](../plan.md) (PD-22, PD-24, PD-25) | **Data**: [../data-model.md](../data-model.md)

This is the contract of every HTTP route Phase A serves. The OpenAPI 3.1 document at `/api/v1/openapi.json` is generated from the same Zod route definitions (FR-A-021), so this file and that document must agree; `server/openapi.test.ts` fails on an undocumented or unregistered route, and `server/docs-contract.test.ts` checks that every route id below exists in the route table.

## Samenvatting (Nederlands)

Dit contract beschrijft alle HTTP-routes van fase A: gezondheid (`/healthz`, `/readyz`), de publieke basisgegevens (`/api/v1/me`, `/api/v1/csrf`, `/api/v1/openapi.json`), de huisstijl (lezen, uploaden, toepassen, resetten, exporteren, importeren) en de bestanden die daaruit volgen (`/branding/<hash>.png`, `/manifest.webmanifest`, favicon-doorverwijzingen). Elke route is of `public`, of vereist één permissie uit de catalogus; schrijfroutes vereisen bovendien Origin, CSRF-token en (voor concurrentie) `If-Match`. Fouten zijn altijd RFC 9457 `application/problem+json` met een stabiele `code` die de UI vertaalt. Sectie 8 legt vast welke Zod-schema's in `packages/shared` wonen (gedeeld door server en web) en welke alleen op de server of alleen in de web-app.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | API under `/api/v1`. Health at `/healthz` and `/readyz`; images at `/branding/`; PWA files at the root (FR-A-020). Task-text names `/api/v1/meta` and `/api/v1/session` are **not** created: `/api/v1/me` carries the meta fields and the actor/permission view, `/api/v1/session` is reserved for Phase B (PD-25) |
| Formats | JSON in and out, UTF-8, except the upload (`multipart/form-data`), images, the manifest and `robots.txt`. JSON write routes require `Content-Type: application/json`, otherwise 415 `unsupported_media_type` |
| Access vocabulary | `public` (no permission, every actor), or a permission from the catalogue (section 8.1). Anonymous holds no permission; the preview actor (only with `PREVIEW_MODE=true`) holds all. Declared once per route in `defineRoute` and exposed as `x-public` or `x-permission` |
| Write routes | Any method other than GET, HEAD, OPTIONS under `/api/v1`. They run Origin check, CSRF check, authorisation in that order (plan 8.3, 7.2). `GET /api/v1/branding/export` writes an audit entry and therefore also applies the `Sec-Fetch-Site` rule (absent, `same-origin` or `none` pass; `same-site` and `cross-site` give 403 `origin_not_allowed`, not audited). Without preview mode every one of them answers 403 `permission_denied` and the denial is audited (FR-A-033, FR-A-034) |
| CSRF | Header `X-CSRF-Token` from `GET /api/v1/csrf`; `Origin` equal to the origin of `PUBLIC_BASE_URL`; `Sec-Fetch-Site`, when present, `same-origin` |
| Optimistic concurrency | `ETag: "<revision>"` on `GET /api/v1/branding` and on every response carrying the branding. `PUT`, `DELETE` and non-dry-run import require `If-Match: "<revision>"` (strong, quoted integer): missing gives 428 `precondition_required`, stale 412 `branding_conflict`, malformed 422 `validation_failed` (pointer `header/If-Match`) |
| Request id | Every response carries `X-Request-Id`. An inbound `X-Request-Id` is used only if it matches `^[A-Za-z0-9-]{8,64}$`; otherwise a new one is generated. The id appears in problem bodies, logs and audit entries |
| Errors | `application/problem+json` (RFC 9457) with `type` (`urn:m365portal:problem:<code>`), `title`, `status`, `detail` (English, generic), `code`, `requestId`, and for validation `errors[]` of `{pointer, code}`. `pointer` is a JSON Pointer into the body, or `query/<name>` or `header/<name>`. When exactly the first validation error carries a specific registry code (`accent_invalid`, `org_name_invalid`, `asset_unknown`) that code is the problem `code`; `errors[]` always lists all. `origin_not_allowed` additionally carries `expectedOrigin` (the origin of `PUBLIC_BASE_URL`, which is public data also returned by `/api/v1/me`) and its English `detail` names the variable `PUBLIC_BASE_URL`, so a host port changed without it is diagnosable (FR-A-016, A-63). Stack traces, SQL, paths and secrets never appear. Exceptions: `/readyz` 503 returns its status document (`application/json`) |
| Unknown path or method | Unknown `/api/*` path: 404 `not_found` problem, never HTML. Known path, wrong method: 405 `method_not_allowed` with `Allow`. `OPTIONS` is not answered (405), and no `Access-Control-*` header is ever sent (FR-A-047) |
| Caching | `/api/*`, `/healthz`, `/readyz`: `Cache-Control: no-store`. `GET /api/v1/branding` therefore has an `ETag` for `If-Match` use but no `304` handling. Other classes in the "Cache" column below |
| Compression | Brotli or gzip for responses of at least 1 KiB, except `/api/v1/csrf` and images |
| Rate-limit classes | `read` (capacity 120, 2 per second), `write` (10, 0.5 per second), `upload` (3, 0.1 per second), `exempt`; per client address; excess gives 429 `rate_limited` with an integer `Retry-After`, not audited |
| Body limits | JSON 262,144 bytes; upload request 2,162,688 bytes (file 2,097,152); branding import 9,437,184 bytes (the largest request: whatever sits in front must allow at least this many bytes). Enforced while streaming: 413 `payload_too_large` |
| Security headers | Profile **other** (plan 8.1) on every API response; profile **html** on the shell and offline page; profile **worker** on `/sw.js` |
| Audit | "Audit" column: the `action` written on success. Denied writes are always audited with `action` = route id, `outcome = denied` |
| Degraded mode | Storage unusable: routes that need storage answer 503 `storage_unavailable`; `/healthz`, `/api/v1/me`, `/api/v1/csrf`, `/api/v1/openapi.json`, `/robots.txt`, `/sw.js`, static files, the shell and `/manifest.webmanifest` (in-memory defaults, no icons) still answer |

## 2. Route index

| # | Route id | Method and path | Access | Class | Audit |
|---|---|---|---|---|---|
| R1 | `health.live` | `GET /healthz` | public | exempt | none |
| R2 | `health.ready` | `GET /readyz` | public | exempt | none |
| R3 | `meta.openapi` | `GET /api/v1/openapi.json` | public | read | none |
| R4 | `meta.me` | `GET /api/v1/me` | public | read | none |
| R5 | `meta.csrf` | `GET /api/v1/csrf` | public | read | none |
| R6 | `branding.get` | `GET /api/v1/branding` | public | read | none |
| R7 | `branding.asset.stage` | `POST /api/v1/branding/assets?slot=` | `settings:branding` | upload | `branding.asset.stage` |
| R8 | `branding.apply` | `PUT /api/v1/branding` | `settings:branding` | write | `branding.apply` |
| R9 | `branding.reset` | `DELETE /api/v1/branding` | `settings:branding` | write | `branding.reset` |
| R10 | `branding.export` | `GET /api/v1/branding/export` | `settings:branding` | read | `branding.export` |
| R11 | `branding.import` | `POST /api/v1/branding/import?dryRun=` | `settings:branding` | upload | `branding.import` |
| R12 | `assets.serve` | `GET /branding/{file}` | public; `settings:branding` for unreferenced assets | read | none |
| R13 | `pwa.manifest` | `GET /manifest.webmanifest` | public | read | none |
| R14 | `pwa.favicon` | `GET /favicon.ico` | public | read | none |
| R15 | `pwa.appleTouchIcon` | `GET /apple-touch-icon.png` | public | read | none |
| R16 | `meta.robots` | `GET /robots.txt` | public | read | none |
| R17 | `pwa.serviceWorker` | `GET /sw.js` | public | exempt | none |
| S1 | `static.assets` | `GET /assets/*` and `/offline.html`, `/offline.css`, `/offline.js` | public | exempt | none |
| S2 | `shell.html` | `GET /` and the SPA fallback for page navigations | public | read | none |
| S3 | `fallback.notFound` | any other path | public | read | none |

R1 to R17 are documented in the OpenAPI document. S1 to S3 are registered through `defineFallback()`, appear in the route table (so the "every route declares access" check covers them) and are marked `openapi: false`; the OpenAPI test compares the documented set with the registered `defineRoute` set.

## 3. Health and metadata

### R1 `GET /healthz`

Liveness: answers 200 while the process runs, also in degraded mode. `Cache-Control: no-store`.

| Response | Schema |
|---|---|
| 200 | `HealthzResponse`: `{ status: "ok", version: string }` (`version` is the build-time constant from `VERSION`) |

### R2 `GET /readyz`

Readiness: database open, schema at the expected version, data directory writable (the last by a write-and-delete probe). The whole result is cached for 2 seconds, because the route is exempt from rate limiting. Used by the Docker `HEALTHCHECK` (A-34).

| Response | Schema |
|---|---|
| 200 | `ReadyzResponse`: `{ status: "ready", checks: [{ name: "data_dir" \| "database" \| "schema", ok: true }, ...] }` |
| 503 | `ReadyzResponse` with `status: "unavailable"`; each failing check has `ok: false` and `code`: `data_dir_not_writable`, `database_unavailable`, `database_corrupt` or `schema_newer_than_app`. Never raw error text |

### R3 `GET /api/v1/openapi.json`

200: the OpenAPI 3.1 document (`application/json`), built once at start from the route table. `info.version` is the application version, `servers` is `/`, each operation carries `x-route-id`, `x-permission` or `x-public`, `x-rate-limit` and, for audited routes, `x-audit`. `server/openapi.test.ts` validates the document against the OpenAPI 3.1 meta-schema with `@seriousme/openapi-schema-validator` 2.11.0 (the plan checked it accepts a generated 3.1 document and rejects an invalid `info`) and runs the negative case (an undocumented route fails).

### R4 `GET /api/v1/me`

The client's view of who it is and what it may do. Resolved on the server from configuration; nothing in the request selects the actor.

| Response | Schema |
|---|---|
| 200 | `MeResponse`: `{ actor: { kind: "anonymous" \| "preview", id: string, label: string }, permissions: Permission[], features: { showcase: boolean, preview: boolean }, version: string, publicOrigin: string, storageAvailable: boolean }` |

Anonymous: `permissions: []`. Preview: all 15 catalogue permissions and `features.preview: true`; `features.preview` is true only when this request resolved to the preview actor, which with `PREVIEW_MODE=true` also needs a loopback `Host` and no `Forwarded`, `X-Forwarded-*` or `X-Real-IP` header unless `PREVIEW_MODE_ALLOW_REMOTE=true` (FR-A-036); any other request is the anonymous actor. `publicOrigin` lets the UI explain `origin_not_allowed`. The same data is embedded in the HTML shell as the boot data block.

### R5 `GET /api/v1/csrf`

| Response | Schema |
|---|---|
| 200 | `CsrfResponse`: `{ token: string, expiresAt: IsoTimestamp }`; `no-store`; not compressed (BREACH shape) |

The token is the stateless HMAC token of plan 8.3 (TTL 8 hours). Cross-origin pages cannot read it (no CORS, CORP `same-origin`).

## 4. Branding

All branding routes need storage. Schemas are in section 8.

### R6 `GET /api/v1/branding`

| Response | Schema |
|---|---|
| 200 | `Branding` plus `ETag: "<revision>"` |
| 503 | `storage_unavailable` |

`Branding`: `revision`, `orgName`, `isDefaultName`, `accent` (as chosen), `tokens` (`light` and `dark` `AccentTokenSet`, each with `adjusted`), `logos` (`light`, `dark`, `compact`: `AssetRef` or `null`), `compactDerived`, `icons` (`favicon32`, `appleTouch180`, `pwa192`, `pwa512`, `maskable512`: `IconRef`), `monogram` (`initials`, `fallback`, `glyphs[]` with path data from the shared glyph table), `updatedAt`. No actor identity is exposed.

### R7 `POST /api/v1/branding/assets?slot=logoLight|logoDark|compact`

Stages one image: runs the pipeline of plan 8.5 and stores the processed PNG, unreferenced.

| Item | Rule |
|---|---|
| Request | `Content-Type: multipart/form-data` with exactly one part named `file`. Query `UploadAssetQuery`: `slot` |
| Size | Request body at most 2,162,688 bytes (cut off while streaming, also without `Content-Length`), file at most 2,097,152 bytes (413 `payload_too_large` once the part is parsed: a file one byte over still fits inside the envelope) |
| Ignored | The client's file name and the part's media type are never read or stored |
| 201 / 200 | `UploadAssetResponse`: `{ asset: StagedAsset, warnings: UploadWarning[] }`; 201 when the processed bytes are new, 200 when identical bytes were staged before (`asset.created` says which) |
| Errors | 403 `permission_denied`, `origin_not_allowed`, `csrf_invalid` (audited); 409 `staging_quota_exceeded`; 413 `payload_too_large`; 415 `unsupported_media_type` (not multipart) or `image_type_unsupported`; 422 `validation_failed` (not exactly one `file` part, malformed multipart), `image_empty`, `image_corrupt`, `image_pixels_exceeded`, `image_processing_timeout`, `svg_not_wellformed`, `svg_doctype_forbidden`, `svg_text_unsupported`, `svg_too_complex`; 429 `image_processing_busy` (with `Retry-After`) or `rate_limited`; 503 `storage_unavailable`, `storage_busy`, `shutting_down` |
| Audit | `branding.asset.stage`, outcome `success` or `rejected`; `denied` for authorisation failures |
| Warnings | `svg_content_removed` (with `categories`), `animation_flattened` |

### R8 `PUT /api/v1/branding`

Applies the full branding (replacement semantics). The server derives the compact variant (when none is supplied) and all icons, writes them atomically, then commits the change and its audit entry in one transaction (plan section 11).

| Item | Rule |
|---|---|
| Request | `ApplyBrandingRequest` (strict, unknown keys rejected): `{ orgName, accent, logos: { light: Sha256Hex \| null, dark: Sha256Hex \| null, compact: Sha256Hex \| null } }`; header `If-Match` required |
| Normalisation | `orgName` NFC, trimmed, whitespace collapsed, 1 to 64 grapheme clusters and at most 256 bytes, bidi and invisible controls refused; `accent` `#rgb` or `#rrggbb` in any case, stored lowercase `#rrggbb` |
| 200 | `Branding` with the new revision and `ETag` |
| Errors | 403 (audited); 412 `branding_conflict`; 413; 415; 422 `org_name_invalid`, `accent_invalid`, `asset_unknown` (a hash that is not registered), `validation_failed` (an asset too large for its slot); 428 `precondition_required`; 429; 503 |
| Audit | `branding.apply` (`success`); a failure while deriving variants leaves the previous branding in force and writes nothing |

### R9 `DELETE /api/v1/branding`

Resets to defaults (name "M365Portal", the default accent, monogram icons, no logos). No body; `If-Match` required. 200 `Branding` at the new revision. Retired assets become unreferenced and keep 24 hours, so the UI's Undo can re-apply the previous values. Audit `branding.reset`. Errors as R8 without the body ones.

### R10 `GET /api/v1/branding/export`

200 `BrandingExport` as `application/json` with `Content-Disposition: attachment; filename="m365portal-branding-YYYYMMDD.json"` and `Cache-Control: no-store`. Contains the stored master PNGs as base64 (explicit compact only). A denied export (403) is not audited because it is a read (PA-15), and a cross-site request is refused before any audit entry or export is made (403 `origin_not_allowed`). Audit `branding.export` on success.

### R11 `POST /api/v1/branding/import?dryRun=true|false`

| Item | Rule |
|---|---|
| Request | `Content-Type: application/json`, body at most 9,437,184 bytes, a `BrandingExport` document. `If-Match` required unless `dryRun=true` |
| Validation | Strict schema (unknown, duplicate, `__proto__` and `constructor` keys rejected; depth bounded); `schemaVersion` must be 1; each image is base64, at most 2,097,152 bytes decoded, and goes through the **complete** pipeline of R7; apply is all or nothing |
| 200 | `ImportResult`: `{ dryRun, applied, orgName, accent, images: { logoLight, logoDark, compact: ImportedImageSummary \| null }, branding: Branding \| null }` (`branding` is null for a dry run, which stores nothing) |
| Errors | 403 (audited); 412; 413 `payload_too_large`; 415; 422 `import_invalid` (with `errors[]` pointers such as `/images/logoLight`), `import_unsupported_version`, and any image code of R7; 428; 429; 503 |
| Audit | `branding.import` for accepted (`success`, `dryRun` in detail) and rejected (`rejected`) imports |

## 5. Branding files and PWA files

### R12 `GET /branding/{file}`

`file` must match `^[0-9a-f]{64}\.png$` and exist in the registry; anything else (path tricks, NUL, uppercase, wrong length, `.png.exe`, encoded traversal) is 404 `not_found` (E-27, H-43).

| Response | Detail |
|---|---|
| 200 | `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`, `ETag: "<hash>"`, `Cross-Origin-Resource-Policy: same-origin`. Referenced assets: `Cache-Control: public, max-age=31536000, immutable`. Unreferenced assets (only for an actor holding `settings:branding`): `private, max-age=31536000, immutable` |
| 304 | On a matching `If-None-Match` |
| 404 | `not_found` problem: invalid name, unknown hash, missing file, or an unreferenced asset requested without `settings:branding` (indistinguishable on purpose) |

### R13 `GET /manifest.webmanifest`

200 `WebManifest` as `application/manifest+json`, `Cache-Control: no-cache`, `ETag` from the revision. `name` is the organisation name, `short_name` its first 12 grapheme clusters, `theme_color` the effective light accent, `background_color` the light page surface, `display: "standalone"`, `start_url`, `scope` and `id` `/`, icons 192, 512 and maskable 512 (`purpose: "maskable"`). The name is serialised as JSON data, never concatenated into text. In degraded mode: defaults, no icons.

### R14 and R15 `GET /favicon.ico`, `GET /apple-touch-icon.png`

307 redirect to `/branding/<hash>.png` of the current favicon 32 or apple-touch 180 icon, `Cache-Control: no-cache`; 404 in degraded mode. The shell also links the hashed URLs directly; these paths exist for browsers and crawlers that request them by convention.

### R16 `GET /robots.txt`

200 `text/plain`: `User-agent: *` and `Disallow: /`. No AI-specific promise is made (baseline section 14 does not apply).

### R17 `GET /sw.js` and S1 static files

`/sw.js`: `text/javascript`, `Cache-Control: no-cache`, header profile **worker** (`default-src 'none'; connect-src 'self'; frame-ancestors 'none'`, COEP `require-corp`, CORP `same-origin`): the generic profile would break every navigation (plan V-04). `/assets/*`: hashed build output, `public, max-age=31536000, immutable`, precompressed siblings served with `Vary: Accept-Encoding`. `/offline.html|css|js`: `no-cache`, profile html without nonces. No directory listing, no dotfiles, traversal-safe (FR-A-048); an unknown asset path is a 404 problem, never `index.html`.

### S2 `GET /` and the SPA fallback

A GET or HEAD whose `Accept` includes `text/html`, outside `/api`, `/branding` and `/assets`, and without a file extension, returns the shell: 200, `Cache-Control: no-store`, profile html with a fresh nonce. The body is the Vite output with placeholders filled in one pass: nonce, escaped `<title>`, token CSS, icon links, `theme-color`, and the boot data block (`Branding` and `MeResponse`). Unknown page paths receive the shell with 200 and the client renders Not-found (PA-14).

## 6. Problem codes

Stable machine codes; each has a Dutch and an English message under the catalogue key `problem.<code>` (FR-A-112). The registry lives in `packages/shared/src/problem.ts`. Codes added to the spec's list by this plan, or by the clientError amendment, are marked **new** (SA-06).

| Code | Status | Typical source | Retry-After |
|---|---|---|---|
| `permission_denied` | 403 | authorisation | |
| `origin_not_allowed` | 403 | Origin or `Sec-Fetch-Site` check; carries `expectedOrigin` | |
| `csrf_invalid` | 403 | CSRF token check | |
| `not_found` | 404 | unknown path, asset or hostile name | |
| `method_not_allowed` | 405 | wrong method on a known path | `Allow` header |
| `branding_conflict` | 412 | stale `If-Match` | |
| `payload_too_large` | 413 | body limit | |
| `unsupported_media_type` | 415 | wrong request content type | |
| `image_type_unsupported` | 415 | not PNG, JPEG or SVG by content | |
| `validation_failed` | 422 | Zod request validation | |
| `accent_invalid` | 422 | accent input | |
| `org_name_invalid` | 422 | organisation name rules | |
| `asset_unknown` | 422 | unregistered hash in apply | |
| `image_corrupt` | 422 | decode failure | |
| `image_pixels_exceeded` | 422 | more than 16,777,216 pixels | |
| `image_empty` | 422 | empty body, or nothing renderable after sanitising | |
| `image_processing_timeout` | 422 | job over 10 seconds | |
| `svg_not_wellformed` | 422 | not UTF-8, malformed XML, no size information | |
| `svg_doctype_forbidden` | 422 | DOCTYPE or ENTITY present | |
| `svg_text_unsupported` | 422 | `<text>` or `<tspan>` | |
| `svg_too_complex` | 422 | over 10,000 elements, depth over 64, reference cycle | |
| `import_invalid` | 422 | import schema or content failure | |
| `import_unsupported_version` | 422 | `schemaVersion` other than 1 | |
| `precondition_required` | 428 | missing `If-Match` | |
| `rate_limited` | 429 | token bucket | integer seconds |
| `image_processing_busy` | 429 | 2 jobs running and 4 queued | integer seconds |
| `staging_quota_exceeded` (**new**) | 409 | 32 unreferenced files or 32 MiB | |
| `internal_error` | 500 | unhandled error, generic body | |
| `storage_unavailable` | 503 | read-only, full or I/O error; degraded mode | |
| `storage_busy` | 503 | `SQLITE_BUSY` | 1 |
| `shutting_down` (**new**) | 503 | request or job aborted by shutdown | 5 |
| `bad_request` (**new**) | 400 | the HTTP parser rejected the request before routing (Node `clientError`) | |
| `request_timeout` (**new**) | 408 | the request was not received in time (Node `clientError`) | |
| `request_header_fields_too_large` (**new**) | 431 | request line or headers over the parser limit (Node `clientError`) | |

Warning codes (successful upload): `svg_content_removed` (with `categories`: `script`, `event_handler`, `external_reference`, `foreign_object`, `style`, `animation`, `filter`, `unknown_element`, `unknown_attribute`, `processing_instruction`, `unresolved_reference`), `animation_flattened`. Readiness failure codes: `data_dir_not_writable`, `database_unavailable`, `database_corrupt`, `schema_newer_than_app`. Start-up failure codes (logged, not HTTP): `config_invalid`, `migration_checksum_mismatch`, `schema_newer_than_app`.

## 7. Examples (illustrative, abbreviated)

```http
PUT /api/v1/branding HTTP/1.1
Origin: http://localhost:9300
X-CSRF-Token: v1.1760000000.1760028800.Q3x1...fA.7bK...Zk
If-Match: "3"
Content-Type: application/json

{ "orgName": "Acme Vereniging", "accent": "#0078D4",
  "logos": { "light": "9f2c...e1", "dark": null, "compact": null } }
```

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json
X-Request-Id: 0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c

{ "type": "urn:m365portal:problem:branding_conflict", "title": "Branding was changed by someone else",
  "status": 412, "detail": "The branding revision does not match If-Match.",
  "code": "branding_conflict", "requestId": "0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c" }
```

```json
{ "status": "unavailable",
  "checks": [ { "name": "data_dir", "ok": false, "code": "data_dir_not_writable" },
              { "name": "database", "ok": false, "code": "database_unavailable" },
              { "name": "schema", "ok": true } ] }
```

## 8. Zod schemas and the package boundary

Naming: the schema constant ends in `Schema`; the OpenAPI component id (`.meta({ id })`) and the inferred TypeScript type drop the suffix. Every schema that appears in a route lives in `packages/shared` so the server, the web app and the OpenAPI document cannot disagree.

### 8.1 `packages/shared` (used by server and web)

| File | Schemas and constants |
|---|---|
| `permissions.ts` | `PERMISSIONS` (the 15 permissions of brief section 2a, one typed list), `PermissionSchema`, `hasAnyPermission` |
| `problem.ts` | `PROBLEM_CODES` with status and title, `ProblemCodeSchema`, `ProblemFieldErrorSchema`, `ProblemSchema` (RFC 9457 members plus `code`, `requestId`, optional `errors[]` and, for `origin_not_allowed` only, `expectedOrigin`), `problemType(code)`, `problemMessageKey(code)` |
| `limits.ts` | The constants of spec section 6.5, the staging quota and the SVG expansion cap included (single source; mirrored to `docs/operations.md`) |
| `schemas/common.ts` | `Sha256HexSchema`, `HexColorSchema` (output, lowercase `#rrggbb`), `AccentInputSchema` (`#rgb` or `#rrggbb`, any case), `IsoTimestampSchema`, `RequestIdSchema` |
| `schemas/health.ts` | `HealthzResponseSchema`, `ReadinessCheckSchema`, `ReadyzResponseSchema` |
| `schemas/meta.ts` | `ActorSummarySchema`, `FeaturesSchema`, `MeResponseSchema`, `CsrfResponseSchema` |
| `schemas/branding.ts` | `AccentTokenSetSchema`, `ThemeTokensSchema`, `AssetRefSchema`, `IconRefSchema`, `IconSetSchema`, `MonogramGlyphSchema`, `MonogramSchema`, `BrandingSchema`, `ApplyBrandingRequestSchema`, `IfMatchHeaderSchema` |
| `schemas/assets.ts` | `AssetSlotSchema`, `UploadAssetQuerySchema`, `StagedAssetSchema`, `UploadWarningSchema`, `UploadAssetResponseSchema` |
| `schemas/export-import.ts` | `Base64PngSchema`, `BrandingExportSchema`, `ImportQuerySchema`, `ImportedImageSummarySchema`, `ImportResultSchema` |
| `schemas/manifest.ts` | `WebManifestSchema` |
| `branding/*.ts` | Not schemas but the single implementations the schemas call: `normalizeOrgName`, `normalizeAccent`, `deriveAccentTokens`, `deriveInitials`, `monogramGlyphs`, `logoPlateFor` (FR-A-008) |

Field-level rules that live in the schemas: `orgName` input is a string whose refinement message is `org_name_invalid`; `accent` input matches `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$` with message `accent_invalid`; `Sha256HexSchema` is `^[0-9a-f]{64}$`; `AssetRefSchema` is `{ hash, url, width, height, luminance }` with `url` equal to `/branding/<hash>.png`; `BrandingExportSchema` is strict with `schemaVersion: z.literal(1)`; `Base64PngSchema` is canonical base64 without whitespace. A transform is never used in a route schema, because transforms cannot be expressed in OpenAPI; normalisation happens in the service through the shared normalisers.

### 8.2 Server only (`apps/server`)

`EnvSchema` (configuration, parity-tested with `.env.example`), the image-job message types (`ImageJobRequest`, `ImageJobResult`), `AuditEntryInputSchema` and the audit `detail` allow-list, the internal `RouteDefinition` type of `defineRoute`.

### 8.3 Web only (`apps/web`)

`AppearanceFormSchema` (derived with `.pick()` and `.extend()` from `ApplyBrandingRequestSchema` plus file-slot state), `TableSearchSchema` (DataTable query state in the URL), the command-registry types. Web code imports the shared schemas lazily (Appearance route chunk) and the shared **types** everywhere with `import type`.

### 8.4 OpenAPI generation rules

`getOpenAPI31Document` over the registered `defineRoute` definitions; component ids from `.meta({ id })`; every route lists its success response and the problem responses it can produce using the shared `Problem` component; a route's `x-permission` or `x-public`, `x-rate-limit` and `x-audit` come from the same definition that enforces them, so the document cannot claim a permission the code does not check (plan V-12, PD-22).
