# Contract: Phase B HTTP API

**Spec**: [../spec.md](../spec.md) (FR-B-201 to FR-B-222, FR-B-301 to FR-B-316, FR-B-401 to FR-B-419, FR-B-501 to FR-B-523, FR-B-601 to FR-B-607, tables 6.9.3, 6.9.5, 6.9.7) | **Plan**: [../plan.md](../plan.md) (sections 6.3, 9, 10, 11, 12; PB-14, PB-15, PB-16; SB-03, SB-09, SB-18 to SB-20, SB-25) | **Data**: [../data-model.md](../data-model.md) | **Builds on**: [Phase A contract](../../001-m365portal/contracts/phase-a-api.md)

This is the contract of every route Phase B adds (P01 to P32), of the two Phase A routes that change (R4 changes shape, R5 changes its binding) and of the access rules that change for the other Phase A routes. The OpenAPI 3.1 document at `/api/v1/openapi.json` is generated from the same Zod route definitions; `server/openapi.test.ts` fails on an undocumented or unregistered route, and `server/docs-contract.test.ts` checks that every route id below exists in the route table. Conventions of the Phase A contract (section 1 there) apply unless this file says otherwise.

## Samenvatting (Nederlands)

Dit contract beschrijft de 32 routes die fase B toevoegt: aanmelden met Entra (`/auth/login`, `/auth/callback`, `/auth/logged-out` als browsernavigatie; uitloggen, overal uitloggen en break-glass onder `/api/v1/auth/`), de setup-poort en de wizard (`/api/v1/setup/*`: status, token ontgrendelen, omgeving controleren, handmatige modus, certificaat downloaden, groepen zoeken, afronden), de verbinding (`/api/v1/connection/*`: toestand, log, een run starten, de ene gecombineerde pollroute `runs/current?after=`, nu opnieuw proberen, annuleren, een bestaande applicatie overnemen, verifiëren) en de rechten (`/api/v1/rbac/*` en `/api/v1/me/access`). Voor elke route staat de toegangsvorm (openbaar, ingelogd, setup-actor, verbinding, een permissie met of zonder step-up), de snelheidsklasse, het auditbericht, de CSRF-/Origin-behandeling, de cacheheaders en de foutcodes. `GET /api/v1/me` krijgt rollen, sessie, setupstatus en `features.breakGlass` (zonder `preview`); een anonieme schrijfpoging geeft nu 401 met `WWW-Authenticate` in plaats van 403. Sectie 12 legt vast welke Zod-schema's in `packages/shared` wonen en sectie 13 welke keuzes dit contract vastlegt. Bij alle routes geldt: Microsoft-tekst wordt nooit doorgegeven, alleen codes en parameters.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base paths | JSON API under `/api/v1`. Browser navigations at the root: `/auth/login`, `/auth/callback`, `/auth/logged-out` (they set cookies and redirect; JSON cannot do that). UI routes in section 10 |
| Access vocabulary | `public`; `authenticated` (any user or break-glass session; the setup actor is **not** authenticated in this sense); `setup` (valid setup session and the state is not `completed`); `connection` (the setup actor while the state is not `completed`, a user holding `settings:connection` afterwards); a permission name; `stepUp` (FR-B-411: applies to user actors only, the setup actor and break-glass are exempt); `actorKinds` (restricts the kinds that may call, whatever they hold). Declared once per route in `defineRoute` and exposed in OpenAPI as `x-public`, `x-permission`, `x-access`, `x-step-up`, `x-actor-kinds`, `x-scoped`, `x-availability` |
| Resolution order in the wrapper | availability gate (404) -> rate limit -> body limit -> content type -> CSRF binding -> Origin -> CSRF -> actor resolution -> missing session 401 -> `actorKinds` 403 -> permission 403 -> `stepUp` 403 -> validation 422 -> handler (plan 6.3, 11.8). The gate comes before the rate limiter and consumes one token of the `read` bucket, exactly what the unknown-path fallback consumes, so a closed route is indistinguishable from an unknown path |
| 401 | No valid session: `unauthenticated`, header `WWW-Authenticate: Cookie realm="m365portal"` (the scheme token is ours, U42), body without tenant ids, step state or log lines. A session cookie that is present but unknown or expired: `session_expired`, the cookie is cleared in the same response. An unknown, malformed, duplicate or absent **setup** cookie is always `unauthenticated` (no oracle on cookie validity, nothing cleared) |
| 403 | An authenticated actor that lacks the permission or is of the wrong kind: `permission_denied`; the audit `reason_code` tells `permission_missing` and `scope_mismatch` apart. `step_up_required`, `escalation_denied`, `origin_not_allowed`, `csrf_invalid` as named. Phase A answered an anonymous write with 403; Phase B answers 401 |
| 404 | Unknown path, a closed availability gate (setup after `completed`, setup over plain http from a non-loopback `Host`, break-glass not configured) and an unknown resource id all answer the same `not_found` problem; for page navigations the shell renders Not-found with status 404. Byte-equal to an unknown path except `requestId` and `X-Request-Id` (FR-B-207, `server/setup/lock.test.ts`) |
| CSRF and Origin | Every method other than GET and HEAD under `/api/v1` needs `Origin` equal to the origin of `PUBLIC_BASE_URL` and header `X-CSRF-Token` from `GET /api/v1/csrf`. The token binding is computed from the cookies the browser sent, with no database read: SHA-256 hex of the session cookie value and of the setup cookie value, joined by `.` when both are present, empty when neither (SB-09). The `GET /auth/*` navigations carry no token (no state change besides the in-memory login transaction and cookies). `Sec-Fetch-Site`, when present, must be `same-origin` on writes; `GET /auth/callback` is the one exempt GET (SB-25) |
| Cookies | Spec table 6.9.3. Names `__Host-m365portal_session`, `__Host-m365portal_oidc`, `__Host-m365portal_setup` on https; `m365portal_session`, `m365portal_oidc`, `m365portal_setup` on `http://localhost`. `HttpOnly`, `Path=/`, no `Domain`, no `Expires`; `Secure` exactly when https; session and setup `SameSite=Strict`, transaction `SameSite=Lax; Max-Age=600`. `Set-Cookie` appears only on responses that set or clear one of them. Two cookies of the same name in a request count as absent (fail closed, one `cookie_duplicate` log line) |
| Caching | `Cache-Control: no-store` on `/auth/*`, `/api/v1/auth/*`, `/api/v1/setup/*`, `/api/v1/connection/*`, `/api/v1/me`, `/api/v1/me/access`, `/api/v1/rbac/*` and the shell HTML (FR-B-417). The service worker never caches or intercepts these (`pass`) |
| Session headers | Every response to a request that carried a valid user or break-glass session has `X-Session-Idle-Expires: <ISO-8601 UTC>` (the sliding idle deadline; for break-glass the absolute deadline, which does not slide). The web client reads it to schedule the two-minute warning (PB-16, SB-18). The polled routes P20 and P22 declare `slidesSession: false` (FR-B-420): they do not extend a user session's idle deadline, so the header they carry shows the unchanged deadline |
| Rate-limit classes | `auth` (capacity 10, refill 0.2 per second per client): `/auth/*` and `/api/v1/auth/*`; `setup` (same numbers): `GET /api/v1/setup/status` and `POST /api/v1/setup/unlock` only; `read` (120, 2 per second) and `write` (10, 0.5 per second) for everything else as in Phase A. The wizard polls `runs/current` at 1 request per second against `read` (PB-14). 429 `rate_limited` carries an integer `Retry-After` and is never audited |
| Body limits | JSON bodies 262,144 bytes; `unlock`, `logout`, `logout-all`, `break-glass` 4,096 bytes (413 `payload_too_large`). No Phase B route accepts a larger request; the largest request of the application stays the branding import (9,437,184 bytes) |
| Errors | RFC 9457 `application/problem+json` as in Phase A: `type` `urn:m365portal:problem:<code>`, `title`, `status`, `detail` (English, generic, never shown by the UI), `code`, `requestId`, `errors[]` of `{pointer, code}` for validation. **Microsoft text never appears**: only allow-listed codes and parameters. A wizard result code (section 6.2) is never the problem `code`; it travels in `errors[].code` or in the step state (CD-05) |
| Audit | "Audit" column: the `action` written on success. Every denial of a write route, and of a permissioned read by an authenticated actor, is audited with `action` = route id, `outcome` `denied`, `reason_code` and the request id and client address, before the response; if that append fails the answer is 503 `storage_unavailable` instead of the denial (FR-B-602). Anonymous reads answer 401 and are not audited. 429 is never audited. P12, P23 and P24 are control actions on in-memory process state and write no success entry (FR-B-601) |
| Idempotency and concurrency | Assignments are created and deleted, never edited: no `ETag` or `If-Match` is used by Phase B routes. A duplicate create is 409 `assignment_exists`; deleting an unknown id is 404. Wizard runs are exclusive (409 `setup_step_busy`) |
| Degraded mode | Storage unusable: routes that need storage answer 503 `storage_unavailable`; `/api/v1/me` and `/api/v1/csrf` answer as anonymous. Secrets unavailable (`APP_KEY` missing or invalid, certificate unreadable): `GET /auth/login` answers 303 to `/signin?error=secrets_unavailable`, Graph- and Exchange-backed routes answer 503 `secrets_unavailable`, break-glass and the Settings pages that need no Graph still work (plan 6.5) |
| Pagination | List routes take `limit` (1 to 200, default 100) and an opaque `cursor`; the response carries `nextCursor` or `null` (CD-10) |

## 2. Route index

Classes: `auth`, `setup`, `read`, `write` (section 1). "Gate" means the availability gate of plan 6.3 stage 1b. Audit "none" means no entry on success; denials of authenticated actors are audited as stated in section 1.

| # | Route id | Method and path | Access | Class | Audit on success | Notes |
|---|---|---|---|---|---|---|
| P01 | `auth.login` | `GET /auth/login?returnTo=&prompt=&purpose=` | public | auth | none | 303 to Entra; navigation |
| P02 | `auth.callback` | `GET /auth/callback` | public | auth | `auth.signin` or `auth.stepup` from the validation step on | 200 interstitial or 303; exempt from `Sec-Fetch-Site` (SB-25) |
| P03 | `auth.loggedOut` | `GET /auth/logged-out` | public | auth | none | 303 to `/signin?signedout=1` |
| P04 | `auth.logout` | `POST /api/v1/auth/logout` | authenticated | auth | `auth.signout` (`breakglass.signout` for break-glass) | |
| P05 | `auth.logoutAll` | `POST /api/v1/auth/logout-all` | authenticated, `actorKinds: ['user']` | auth | `auth.signout` | |
| P06 | `auth.breakGlass` | `POST /api/v1/auth/break-glass` | public; Gate (404 unless configured) | auth | `breakglass.signin` | |
| P07 | `meta.me` | `GET /api/v1/me` | public | read | none | shape changes (section 4) |
| P08 | `meta.csrf` | `GET /api/v1/csrf` | public | read | none | binding changes, shape does not |
| P09 | `me.access` | `GET /api/v1/me/access` | authenticated | read | none | "Mijn toegang" |
| P10 | `setup.status` | `GET /api/v1/setup/status` | public; Gate | setup | none | |
| P11 | `setup.unlock` | `POST /api/v1/setup/unlock` | public; Gate | setup | `setup.unlock` | |
| P12 | `setup.session.end` | `DELETE /api/v1/setup/session` | setup | write | none | |
| P13 | `setup.state` | `GET /api/v1/setup/state` | setup | read | none | |
| P14 | `setup.environment` | `POST /api/v1/setup/environment` | setup | write | `setup.step.run` | |
| P15 | `setup.manual` | `PUT /api/v1/setup/manual` | setup | write | `setup.step.run` | body carries `tenantId` (SB-20) |
| P16 | `setup.certificate` | `GET /api/v1/setup/certificate.cer` | setup | read | none | public certificate only |
| P17 | `setup.groups` | `GET /api/v1/setup/groups?q=` | setup | read | none | |
| P18 | `setup.finish` | `POST /api/v1/setup/finish` | setup | write | `setup.step.run` (+ `rbac.assignment.create` as actor `setup`) | |
| P19 | `connection.get` | `GET /api/v1/connection` | connection | read | none | |
| P20 | `connection.log` | `GET /api/v1/connection/log?after=&limit=` | connection | read | none | history paging |
| P21 | `connection.runs.start` | `POST /api/v1/connection/runs` | connection, stepUp | write | `setup.step.run` (wizard), `connection.repair` (after completion) | |
| P22 | `connection.runs.current` | `GET /api/v1/connection/runs/current?after=` | connection | read | none | the one polled channel (SB-19) |
| P23 | `connection.runs.retryNow` | `POST /api/v1/connection/runs/current/retry-now` | connection, stepUp | write | none | |
| P24 | `connection.runs.cancel` | `POST /api/v1/connection/runs/current/cancel` | connection, stepUp | write | none | |
| P25 | `connection.adopt` | `POST /api/v1/connection/adopt` | connection, stepUp | write | `setup.object.change` | |
| P26 | `connection.verify` | `POST /api/v1/connection/verify` | connection, stepUp | write | `connection.verify` | returns the Proof |
| P27 | `rbac.roles.list` | `GET /api/v1/rbac/roles` | `rbac:manage` | read | none | |
| P28 | `rbac.assignments.list` | `GET /api/v1/rbac/assignments` | `rbac:manage` | read | none | |
| P29 | `rbac.assignments.create` | `POST /api/v1/rbac/assignments` | `rbac:manage`, stepUp, `actorKinds: ['user']` | write | `rbac.assignment.create` | SB-03 |
| P30 | `rbac.assignments.delete` | `DELETE /api/v1/rbac/assignments/{id}` | `rbac:manage`, stepUp, `actorKinds: ['user']` | write | `rbac.assignment.delete` | SB-03 |
| P31 | `rbac.effective` | `GET /api/v1/rbac/effective?principal=` | `rbac:manage` | read | none | |
| P32 | `rbac.restoreOwner` | `POST /api/v1/rbac/restore-owner` | `rbac:manage`, `actorKinds: ['break_glass']` | write | `rbac.owner.restore` | the only path that bypasses `canGrant` |

After the state is `completed`, every `/api/v1/setup/*` route (P10 to P18, `status` and `unlock` included) answers the standard 404 (FR-B-207), and `connection` access means `settings:connection` held by a signed-in user. Phase A routes R1 to R17 keep their ids; their access changes are in section 8.

`defineRoute` additions that this table relies on: `availability: 'setupOpen' | 'breakGlass'` (the gate), `actorKinds`, `access.setup`, `access.connection`, `access.authenticated`, `secFetch: 'cross-site-allowed'` (P02 only). The route-table test fails on a route without an access declaration, on a permission with a resource type that declares neither `scoped` nor `unscopedReason` (every permission-gated Phase B route declares `unscopedReason`, because the permissions they need are global-only), on `secFetch: 'cross-site-allowed'` anywhere but P02, and on an `/api/v1/setup/*` or `/api/v1/connection/*` route without the gate or the setup/connection access.

## 3. Sign-in, sign-out and break-glass (P01 to P06)

### P01 `GET /auth/login`

Starts a login transaction (in memory, lifetime 600 s, 1,000 in total, 20 per client address, oldest evicted) and redirects to Entra.

| Item | Rule |
|---|---|
| Query | `LoginQuery`: `returnTo` (string, at most 256 characters; sanitised by `safeReturnTo`, never rejected: anything unsafe becomes `/`), `prompt` (`login` or `select_account`; any other value dropped), `purpose` (`signin` default, or `stepup`; any other value is `signin`) |
| `safeReturnTo` | Must start with a single `/`, contain no `//`, `\`, control character or scheme, be at most 256 characters and not begin with `/api/` or `/setup`; otherwise `/` |
| Success | `303`, `Location: https://login.microsoftonline.com/<pinned tid>/oauth2/v2.0/authorize?...` with exactly `client_id`, `response_type=code`, `redirect_uri`, `response_mode=query`, `scope=openid profile`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256` and optionally `prompt`; `Set-Cookie`: OIDC transaction cookie; `Cache-Control: no-store`. No `max_age`, `claims`, `login_hint` or `offline_access` |
| Step-up (`purpose=stepup`) | Needs a valid **user** session; the transaction stores the SHA-256 of the current session id and the request carries `prompt=login`. Without such a session (none, expired, break-glass, setup only): `303 /signin?error=session_expired&returnTo=<sanitised>` (CD-01) |
| Refusals (all `303` to `/signin?error=<code>`, `no-store`, no transaction created) | `setup_required` (state is `unconfigured` or `in_progress`, or no pinned tenant; plan SB-22) and `secrets_unavailable` |
| Rate class, audit | `auth`; none. CSRF and Origin: none (GET) |

### P02 `GET /auth/callback`

Receives `?code=&state=` (or `?error=&error_description=`) from Entra. Processing order and stop rules are FR-B-403; the table gives the observable results.

| Result | Status and headers | Audited |
|---|---|---|
| Success | `200 text/html; charset=utf-8`, header profile **html** with a nonce, body with `<meta http-equiv="refresh" content="0;url=<safe returnTo>">` and a visible link; `Set-Cookie`: session (new random id), OIDC cookie cleared; `Cache-Control: no-store`. Never a `303` (FR-B-412, U39) | `auth.signin` success (and `setup.complete` in the same transaction when the designated first Owner completes setup); `auth.stepup` success for `purpose=stepup` |
| Failure before the ID token is validated | `303 /signin?error=<code>` (`cookies_missing_or_expired`, `access_denied`, `interaction_required`, `consent_required`, `admin_approval_required`, `assignment_required`, `conditional_access_blocked`, `temporarily_unavailable`, `signin_failed`, `setup_required`, `secrets_unavailable`); the OIDC cookie is cleared whenever it was read; `no-store` | no (unauthenticated, attacker-reachable volume; B-24) |
| Failure from ID-token validation on | `303 /signin?error=signin_failed`, `mfa_required`, `amr_missing` or (step-up) `stepup_failed` | `auth.signin` / `auth.stepup` `denied` with `reason` and `check` |
| No effective permission | `303 /no-access?reason=no_role&ref=<request id>`; no session is created | `auth.signin` denied (`no_role`) |
| Only group-derived grants could exist and Graph failed | `303 /no-access?reason=graph_unavailable&ref=<request id>` | `auth.signin` denied (`graph_unavailable`) |

| Item | Rule |
|---|---|
| Query | Unknown parameters (for example `session_state`) are ignored. The query string is never logged. `error_description` is read only to extract the `AADSTS` number with a strict pattern; the text is dropped |
| `Sec-Fetch-Site` | Not enforced: Entra's redirect is a cross-site top-level navigation by design (SB-25). The protections are `state` (constant-time compare), `nonce`, PKCE (S256), the single-use transaction and its Lax cookie |
| Rate class | `auth`. Origin and CSRF: none (GET) |
| Side effects | One `BEGIN IMMEDIATE` transaction: upsert `app_user`, insert the hashed session, evict sessions beyond 10 per principal, and (state `awaiting_first_signin` and the designated `oid`) flip the state to `completed`; the token file is unlinked after the commit. The access token of the response is discarded unread, no refresh token exists, the ID token is not stored (FR-B-418) |

### P03 `GET /auth/logged-out`

The registered post-logout redirect target. `303 /signin?signedout=1`, `no-store`, no cookie change, no audit. Class `auth`.

### P04 `POST /api/v1/auth/logout`

| Item | Rule |
|---|---|
| Access | `authenticated` (user or break-glass). Origin and CSRF required. Body: `{}` (at most 4,096 bytes; `LogoutRequest` is the empty strict object) |
| Order | The session row is deleted first, then the cookie is cleared, then the audit entry is written (`auth.signout`, or `breakglass.signout`, detail `scope: current`, `sessions: 1`) |
| 200 | `LogoutResponse`: `{ redirect: string }`. For a user session `redirect` is `https://login.microsoftonline.com/<tid>/oauth2/v2.0/logout?post_logout_redirect_uri=<origin>/auth/logged-out` (a registered redirect URI). For a break-glass session, which has no Entra session, it is the local path `/signin?signedout=1` (CD-02). The client navigates only to those two shapes |
| Errors | 401 `unauthenticated` (no session; nothing to end), 403 `origin_not_allowed`, `csrf_invalid`, 413, 415, 422 `validation_failed` (a non-empty body), 429 |

### P05 `POST /api/v1/auth/logout-all`

As P04, but deletes **every** session of the same `(tid, oid)` (no other principal), then clears the cookie. `actorKinds: ['user']`: a break-glass session gets 403 `permission_denied`. 200 `LogoutAllResponse`: `{ redirect: string, sessionsEnded: integer }` (at least 1). Audit `auth.signout`, detail `scope: all`, `sessions: n`. The Entra `end_session_endpoint` ends the Microsoft session of this browser only; front-channel and back-channel logout are not registered (U29).

### P06 `POST /api/v1/auth/break-glass`

| Item | Rule |
|---|---|
| Availability | Gate: `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` must both be configured, otherwise the standard 404. Needs a pinned tenant: before that, 409 `setup_required` |
| Access, CSRF | `public`. Origin and an anonymous-binding CSRF token required. Body at most 4,096 bytes |
| Request | `BreakGlassRequest` (strict): `username` (string, 1 to 256 bytes), `password` (string, 1 to 1,024 bytes) |
| Work | Behind a one-slot queue (1 running, 2 waiting; more: 429 `break_glass_locked`). Always the same work: the username digest is compared with `timingSafeEqual` and the password is derived against the configured salt, or against a dummy hash of the same parameters when the username differs. At most 128 MiB per verification (SB-04) |
| 200 | `BreakGlassResponse`: `{ redirect: "/settings/restore-access" }`; `Set-Cookie`: session of kind `break_glass` (absolute 30 minutes, not sliding, holds exactly `rbac:manage`); a `warn` log line `break_glass_signin` without the username |
| Errors | 401 `unauthenticated` for every credential failure (unknown user and wrong password are indistinguishable; the generic body carries the `WWW-Authenticate` challenge; CD-11). 429 `break_glass_locked` with integer `Retry-After`: 5 failures per client in 15 minutes, 20 per hour overall, or a full queue. 404 gate. 409 `setup_required`. 403 `origin_not_allowed`, `csrf_invalid`. 413, 415, 422 `validation_failed`, 429 `rate_limited` |
| Audit | `breakglass.signin` `success`; `denied` with `reason` `invalid_credentials` for each failure inside the rate bound (actor `anonymous`; the username is never recorded). Attempts refused by a lock or a full queue are 429 and not audited (CD-08) |

## 4. Session, identity and CSRF (P07 to P09)

### P07 `GET /api/v1/me`

The client's view of who it is and what it may do; resolved on the server from the cookies only (nothing in the request selects the actor). A valid session slides its idle deadline like any request. The same data is embedded in the HTML shell as the boot data block.

| Response | Schema |
|---|---|
| 200 | `MeResponse` (below), `Cache-Control: no-store` |

```ts
MeResponse = {
  actor:   { kind: 'anonymous' | 'user' | 'setup' | 'break_glass', id: string, label: string },
  permissions: Permission[],             // held anywhere, any scope (route-level gate); sorted
  roles:   { key: string }[],            // distinct roles of the active assignments, direct or through a group; [] for setup and break_glass
  session: { expiresAt: IsoTimestamp, idleExpiresAt: IsoTimestamp, mfa: boolean,
             stepUpValidUntil: IsoTimestamp | null, groupsStale: boolean } | null,
  setup:   { state: 'unconfigured' | 'in_progress' | 'awaiting_first_signin' | 'completed' },
  features:{ showcase: boolean, breakGlass: boolean },
  adminConsentUrl: string | null,         // tenant-wide consent link of FR-B-419; null until a tenant is pinned (TB-14)
  version: string, publicOrigin: string, storageAvailable: boolean
}
```

- `actor.id` is the `oid` for `user`, `setup` for the setup actor, `break_glass` for break-glass, empty for anonymous. `label` is the display-name label (UPN label when there is no name), `Setup`, `Break-glass` or empty; labels never select or authorise anything (FR-B-406). Setup: `permissions` are exactly `settings:branding` and `settings:connection`. Break-glass: exactly `rbac:manage`.
- `session` is non-null for `user` and `break_glass`; for break-glass `idleExpiresAt` equals `expiresAt`. It is null for anonymous and for the setup actor (its timeouts are in `GET /api/v1/setup/state`).
- `features.breakGlass` is true when both break-glass variables are configured (SB-18); the UI uses it to show or hide `/break-glass`. `features.preview` and the actor kind `preview` no longer exist (FR-B-102). `adminConsentUrl` is built from the pinned tenant id, the application id and the registered callback URI, all of which every authorize redirect already reveals; the sign-in page shows it only for `consent_required` and `admin_approval_required` (TB-14).
- Storage unusable: answers as anonymous with `storageAvailable: false` (Phase A); `setup.state` is the value loaded at start, or `unconfigured` when none was loaded.

### P08 `GET /api/v1/csrf`

`CsrfResponse`: `{ token: string, expiresAt: IsoTimestamp }`, unchanged. The token format stays Phase A's `v1.<iat>.<exp>.<nonce>.<mac>`; the **binding** inside the MAC changes as described in section 1. After any rotation (sign-in, step-up, unlock, logout) the old token fails with `csrf_invalid` and the client fetches a new one once.

### P09 `GET /api/v1/me/access`

"Mijn toegang". Access `authenticated` (a user or break-glass session; the setup actor gets 401). Read-only.

```ts
MyAccessResponse = {
  principal:   { kind: 'user' | 'break_glass', id: string, label: string },
  assignments: { id: Guid, role: { key: string, builtin: boolean },
                 origin: { type: 'direct' } | { type: 'group', groupId: Guid, groupName: string | null },
                 scope: ScopeItem[],               // [] = unscoped
                 expiresAt: IsoTimestamp | null }[],
  grants:      { permission: Permission, qualifier: 'full' | 'basic', scope: 'all' | ScopeItem[] }[],
  groupsStale: boolean, groupsResolvedAt: IsoTimestamp | null
}
```

`groupName` is best effort from the 60-second Graph cache and is `null` when unavailable. A break-glass session returns `assignments: []` and the single grant `rbac:manage`, `full`, `all`.

## 5. Setup gate and wizard (P10 to P18)

While the state is not `completed` these routes are served; afterwards every one of them answers the standard 404. Over a plain-http `PUBLIC_BASE_URL` they also answer 404 to a request whose `Host` is not loopback (`localhost`, `127.0.0.0/8`, `[::1]`) or that carries `Forwarded`, `X-Forwarded-*` or `X-Real-IP` (FR-B-206; accident protection, not a security boundary: the token is). Setup-only routes need the setup actor: a valid `m365portal_setup` cookie obtained through `unlock`.

```ts
SetupState   = 'unconfigured' | 'in_progress' | 'awaiting_first_signin' | 'completed'
StepKey      = 'environment' | 'connect' | 'configure' | 'verify' | 'finish'
StepStatus   = 'pending' | 'running' | 'waiting' | 'succeeded' | 'warning' | 'failed' | 'skipped'
Params       = Record<string, string | number | boolean>       // names, ids, counts; never free text, at most 8 entries, strings at most 256 bytes
```

### P10 `GET /api/v1/setup/status`

Class `setup`. Public, but behind the gate.

| Response | Schema |
|---|---|
| 200 | `SetupStatusResponse`: `{ state: SetupState, tokenRequired: boolean }` and nothing else. `tokenRequired` is true unless the request already carries a valid setup session (CD-03). `no-store` |

### P11 `POST /api/v1/setup/unlock`

Class `setup`, body at most 4,096 bytes, Origin and CSRF required (anonymous binding, or the setup cookie's hash when one is sent). Order: gate, rate class, Origin and CSRF, body parse, **lock check**, compare, bookkeeping.

| Item | Rule |
|---|---|
| Request | `UnlockRequest` (strict): `{ token: string }`, 1 to 256 characters. The token is accepted nowhere else: not in a query string, not in a header |
| Compare | `timingSafeEqual(sha256(input), sha256(expected))`; expected = `SETUP_TOKEN`, else the content of `${DATA_DIR}/setup-token` |
| 200 | `UnlockResponse`: `{ state: 'in_progress' }`; `Set-Cookie`: setup session (256-bit id, idle 60 minutes sliding, absolute 8 hours, at most 5 live sessions, oldest evicted); state edge `unconfigured` -> `in_progress` on the first success. `no-store` |
| Errors | 401 `setup_token_invalid`; 429 `setup_token_locked` with integer `Retry-After` (5 failures per client in 15 minutes lock that client for 15 minutes; 30 failures per hour lock everyone for 15 minutes; a correct token is refused during a lock); 404 gate; 403 `origin_not_allowed`, `csrf_invalid`; 413; 415; 422 `validation_failed`; 429 `rate_limited` |
| Audit | `setup.unlock` `success` on success. When a lock **starts**: one entry, `denied`, `reason` `setup_token_locked`, `lockScope` `client` or `global`, and the log event `setup_unlock_locked`. Single failures inside the bound are not audited |

### P12 `DELETE /api/v1/setup/session`

Access `setup`. Ends the setup session at once, clears the cookie, and clears the bootstrap object when this was the last live setup session. `204`. Errors: 401, 403 (Origin, CSRF), 404 gate, 429.

### P13 `GET /api/v1/setup/state`

Access `setup`. Everything the wizard shows when it loads; afterwards the UI polls P22.

```ts
SetupStateResponse = {
  state: SetupState, mode: 'automatic' | 'manual', defaultLanguage: 'nl' | 'en' | null,
  steps: StepState[],                       // always the five steps in registry order (section 6.1)
  tenant:      { proposedTenantId: Guid | null, tenantId: Guid | null, name: string | null, initialDomain: string | null },
  application: { appId: Guid, objectId: Guid | null, displayName: string } | null,
  certificate: { thumbprintSha1: string, notAfter: IsoTimestamp, state: 'pending' | 'active' } | null,
  designatedOwner: { oid: Guid, upnLabel: string | null, nameLabel: string | null } | null,
  exchangeEnabled: boolean, proof: Proof | null,
  publicBaseUrl: string,                    // the origin, so the environment step can show what it checks
  session: { idleExpiresAt: IsoTimestamp, absoluteExpiresAt: IsoTimestamp }
}
```

`tenantId` is non-null only after verification V2 pinned it; `proposedTenantId` is the tenant learned at `connect` or typed in manual mode. No secret and no Microsoft free text appears.

### P14 `POST /api/v1/setup/environment`

Access `setup`; class `write`; body `{}`. Runs the six checks of FR-B-213 (at most about 10 seconds) and stores the step rows.

| Response | Schema |
|---|---|
| 200 | `EnvironmentResult`: `{ ranAt: IsoTimestamp, status: 'ok' \| 'warning' \| 'failed', blocking: boolean, checks: EnvironmentCheck[] }`; `EnvironmentCheck` = `{ key: 'public_base_url' \| 'data_dir' \| 'app_key' \| 'node_version' \| 'network' \| 'time_skew', status: 'ok' \| 'warn' \| 'fail', code: ResultCode \| null, remedyKey: string \| null, params: Params }` |

`blocking` is true when any check is `fail`; a blocking result prevents step 2 (`setup_step_not_ready` on the run request). Errors: 409 `setup_step_busy` (a run is active), 401, 403, 404, 429, 503 `storage_unavailable`. Audit `setup.step.run` (`step: environment`, `status`, `codes`).

### P15 `PUT /api/v1/setup/manual`

Manual provisioning mode (FR-B-218). Access `setup`; class `write`. The certificate must exist (generated at the start of manual mode); the operator has done the portal tasks of the checklist.

| Item | Rule |
|---|---|
| Request | `ManualRequest` (strict): `{ applicationClientId: Guid, tenantId: Guid, firstOwner: { kind: 'oid' \| 'upn', value: string } }`; `value` is a GUID for `oid` and 3 to 256 characters for `upn` (SB-20) |
| Effect | Stores `mode = manual`, `tenant_connection.app_id` and `setup_state.proposed_tenant_id`; resolves the first Owner with the app-only `GET /users/{id or userPrincipalName}` (a UPN is resolved to an `oid`; the `oid` is what is stored as `designated_owner_oid`) |
| 200 | `ManualResponse`: `{ mode: 'manual', applicationClientId: Guid, tenantId: Guid, designatedOwner: { oid: Guid, upnLabel: string \| null, nameLabel: string \| null } }` |
| Errors | 409 `setup_step_not_ready` (no certificate yet), 409 `tenant_mismatch` (a tenant is already pinned and differs), 409 `setup_step_busy`, 422 `validation_failed`, 422 `principal_unknown` (the first Owner does not exist), 503 `graph_unavailable` (the app could not obtain a token yet or Graph failed; `Retry-After: 30`; the operator repeats "Controleren"), 503 `secrets_unavailable`, 401, 403, 404, 429 |
| Audit | `setup.step.run` (`step: connect`, `subAction: manual_inputs`, `mode: manual`) |

### P16 `GET /api/v1/setup/certificate.cer`

Access `setup`; class `read`. The public certificate of the `pending` (else `active`) certificate: `200`, `Content-Type: application/x-x509-ca-cert`, DER body, `Content-Disposition: attachment; filename="m365portal-<first 8 hex of the SHA-1 thumbprint>.cer"`, `no-store`. No private material is ever in the body. In manual mode it exists from the start of step 2; before the certificate exists: 409 `setup_step_not_ready`. Errors: 401, 404 gate, 429. No audit (public data).

### P17 `GET /api/v1/setup/groups?q=`

Access `setup`; class `read`. Searches Entra groups for the optional *Beheerder* group (app-only, `GraphClient.searchGroups`).

| Item | Rule |
|---|---|
| Query | `GroupSearchQuery`: `q` (string, trimmed, 1 to 64 code points; escaped for the OData `startswith` filter by the client) |
| 200 | `GroupSearchResponse`: `{ groups: { id: Guid, displayName: string }[] }`, at most 25 entries (CD-09) |
| Errors | 409 `setup_step_not_ready` (verification has not succeeded, so no app-only token exists), 422 `validation_failed`, 503 `graph_unavailable` (`Retry-After: 30`), 503 `graph_throttled` (`Retry-After` from Graph), 503 `secrets_unavailable`, 401, 404, 429 |

### P18 `POST /api/v1/setup/finish`

Access `setup`; class `write`. Ends the wizard (state edge `in_progress` -> `awaiting_first_signin`).

| Item | Rule |
|---|---|
| Request | `FinishRequest` (strict): `{ confirmOwnerOid: Guid, language?: 'nl' \| 'en', beheerderGroupId?: Guid \| null }`. `confirmOwnerOid` must equal the designated first Owner (`designatedOwner.oid` of P13): the wizard shows that person's label and asks for confirmation (FR-B-219 h). Branding is saved beforehand through the Phase A routes with the setup actor's `settings:branding`; skipping it is allowed |
| Preconditions | The state is `in_progress` (a replayed finish changes nothing: 409 `setup_step_not_ready`); steps `environment`, `connect`, `configure`, `verify` each `succeeded` or `warning` (manual mode: its own subset), a designated first Owner known, no run active |
| Effect | One transaction: insert the `owner` assignment for `designated_owner_oid` (`source: wizard`, `created_by: setup`) if absent, the optional `admin` assignment for the group, store the language, set the state and write the audit entries. The bootstrap object has already been discarded |
| 200 | `FinishResponse`: `{ state: 'awaiting_first_signin', designatedOwner: { oid: Guid, upnLabel: string \| null, nameLabel: string \| null }, signinUrl: '/auth/login?returnTo=%2F' }` |
| Errors | 409 `setup_step_not_ready` (with `errors[]` `{pointer: '/', code: 'owner_missing'}` when no Owner is known), 409 `setup_step_busy`, 422 `validation_failed` (with `errors[]` `{pointer: '/beheerderGroupId', code: 'group_unknown'}` when Graph answers 404 for the group, or `{pointer: '/confirmOwnerOid', code: 'owner_changed'}` when it differs from the designated Owner; CD-05), 503 `graph_unavailable` (the group could not be checked), 401, 403, 404, 429, 503 `storage_unavailable` |
| Audit | `setup.step.run` (`step: finish`); `rbac.assignment.create` with actor `setup`, `source: wizard`, for each assignment created (SB-21) |

The state becomes `completed` only in the sign-in callback (P02) of the designated `oid`; if that person never signs in the state stays open (documented, B-09).

## 6. Connection and runs (P19 to P26)

Access `connection`. While the state is not `completed` the caller is the setup actor; afterwards a signed-in user holding `settings:connection`, and the routes marked stepUp need a step-up within 10 minutes (the setup actor is exempt). Class `read` for GETs, `write` for POSTs. Wizard calls and these routes share one runner: at most one run at a time (`runner_lease`).

### 6.1 Shared types

```ts
ResultCode = (the wizard result codes of section 6.2)           // registry in packages/shared/src/setup/results.ts
SubActionState = { key: string, status: StepStatus, attempt: integer, startedAt: IsoTimestamp | null, finishedAt: IsoTimestamp | null,
                   errorCode: ResultCode | null, hint: { key: string, params: Params } | null,
                   waiting: { attempt: integer, max: integer, nextAttemptAt: IsoTimestamp } | null, manual: boolean }
StepState      = { step: StepKey, status: StepStatus, subActions: SubActionState[] }      // status = aggregate(subActions) (plan 9.4)
LogLine        = { seq: integer, ts: IsoTimestamp, step: StepKey, level: 'info' | 'warn' | 'error', messageKey: string, params: Params }
RunStatus      = { id: Guid, kind: 'setup' | 'repair', mode: 'continue' | 'reconcile', steps: ('connect' | 'configure' | 'verify')[],
                   status: 'running' | 'waiting' | 'succeeded' | 'warning' | 'failed' | 'cancelled',
                   startedAt: IsoTimestamp, finishedAt: IsoTimestamp | null, cancelRequested: boolean }
DeviceCodePanel= { userCode: string, verificationUri: string | null, expiresAt: IsoTimestamp, intervalSeconds: integer,
                   state: 'waiting_for_user' | 'signed_in' | 'expired' | 'declined' | 'cancelled' | 'blocked' }
AdoptionPrompt = { kind: 'application', candidate: { objectId: Guid, appId: Guid, displayName: string,
                    foreign: { keyCredentials: integer, owners: integer, servicePrincipalKeyCredentials: integer, servicePrincipalOwners: integer } },
                    requiresAcknowledgement: boolean }       // true when any foreign count is above 0 (FR-B-318); a password credential never reaches the prompt: the step ends `application_untrusted`
ProofItem      = { key: 'application' | 'service_principal' | 'certificate' | 'graph_roles' | 'exchange_roles' | 'entra_role'
                      | 'check_v1' | 'check_v2' | 'check_v3' | 'check_v4' | 'check_v5' | 'check_v6',
                   status: 'ok' | 'warning' | 'failed' | 'not_checked', at: IsoTimestamp | null, params: Params }
Proof          = { generatedAt: IsoTimestamp, mode: 'automatic' | 'manual', items: ProofItem[] }     // stored form is at most 51,200 bytes
```

`verificationUri` is present only for an `https` URI whose host is in the allow-list (`microsoft.com`, `www.microsoft.com`, `login.microsoft.com`, `login.microsoftonline.com`; U43); otherwise `null` and the UI shows the code and the instruction without a link. The `message` text of the device-code response is never forwarded. `userCode` is shown, the device code itself never leaves the server.

### 6.2 Wizard result codes

These are the values of `errorCode`, of proof `params.code` and of `errors[].code` (never of a problem `code`). For the `environment` step the status column is the check status of FR-B-213 (`fail`, `warn`); the step status derived from it is `failed` or `warning`. Each has a catalogue message and a remedy key in `nl` and `en`; Microsoft free text is neither stored nor shown, only the `AADSTS` number where the table says so.

| Step | Code | Status | Meaning |
|---|---|---|---|
| environment | `public_base_url_invalid`, `data_dir_not_writable`, `app_key_missing`, `app_key_invalid` | fail | FR-B-213 |
| environment | `network_unreachable` | fail | login or Graph host unreachable (params: host names) |
| environment | `network_exchange_unreachable`, `node_version_unsupported`, `time_skew_warning` | warn | FR-B-213 |
| environment | `time_skew_excessive` | fail | skew over 300 s (U35) |
| connect | `device_code_expired`, `device_code_declined`, `device_code_cancelled` | failed | EB-03 |
| connect | `device_code_blocked` | failed | `AADSTS53003`; offers manual mode (EB-04) |
| connect | `consent_required`, `admin_approval_required`, `assignment_required` | failed | `AADSTS65001`; `AADSTS90093` and `AADSTS90094`; `AADSTS50105` |
| connect | `bootstrap_role_insufficient` | failed | the first delegated call answered 403 (EB-05) |
| connect | `tenant_mismatch`, `bootstrap_failed` | failed | FR-B-216; any other error, with the `AADSTS` number |
| configure | `app_role_missing` | failed | FR-B-302 |
| configure | `application_ambiguous` | failed | several matches (FR-B-304) |
| configure | `application_adoption_required` | waiting | one match without our install tag; needs P25 |
| configure | `application_untrusted` | failed | a password credential on the candidate or its service principal, or credentials that cannot be read (FR-B-318) |
| configure | `policy_refused`, `thumbprint_mismatch`, `forbidden_permission_present` | failed | EB-10, FR-B-306, FR-B-307 |
| configure | `replication_timeout`, `graph_error` | failed | window exhausted; permanent Graph error (the allow-listed Graph error code is a param) |
| configure | `exchange_service_principal_missing` | skipped | EB-08 |
| verify | `token_unavailable`, `organization_mismatch`, `users_unreadable`, `drift_detected` | failed | V1, V2, V3, V4 |
| verify | `exchange_not_ready`, `exchange_unavailable`, `optional_claim_missing` | warning | V5, V6 (EB-09) |
| verify | `foreign_credential_present` | warning | V4: password or foreign key credentials on the runtime application or its service principal (FR-B-319) |
| verify | `not_checked` | skipped | V4 and V6 in manual mode |
| finish | `owner_missing`, `group_unknown`, `owner_changed` | failed | FR-B-219 (`owner_changed`: `confirmOwnerOid` differs from the designated Owner, an `errors[]` code of 422 `validation_failed`) |

### P19 `GET /api/v1/connection`

```ts
ConnectionResponse = {
  state: SetupState, mode: 'automatic' | 'manual',
  tenant: { tenantId: Guid, name: string | null, initialDomain: string | null } | null,       // null until pinned
  application: { appId: Guid, objectId: Guid | null, displayName: string } | null,
  certificate: { thumbprintSha1: string, notAfter: IsoTimestamp, daysLeft: integer, level: 'ok' | 'warning' | 'critical' | 'expired' } | null,
  pendingCertificate: { thumbprintSha1: string, notAfter: IsoTimestamp } | null,
  exchange: { enabled: boolean }, permissionSetVersion: integer, redirectUris: string[],
  secrets: { status: 'ok' | 'app_key_missing' | 'app_key_invalid' | 'certificate_unreadable' | 'no_certificate' },
  proof: Proof | null, verifiedAt: IsoTimestamp | null, runActive: boolean
}
```

`level` is `warning` at 60 days or fewer, `critical` at 14 or fewer, `expired` at 0 or fewer (FR-B-111). Errors: 401, 403 `permission_denied` (audited for a signed-in user without `settings:connection`), 404 gate, 429, 503.

### P20 `GET /api/v1/connection/log?after=&limit=`

History paging. Declares `slidesSession: false` (FR-B-420). Query `LogQuery`: `after` (integer >= 0, default 0), `limit` (1 to 200, default 100). 200 `LogPage`: `{ lines: LogLine[], lastSeq: integer, hasMore: boolean, truncated: boolean }`; `truncated` is true when lines after `after` were already trimmed (only the newest 1,000 are kept). Rows are in `seq` order. Errors as P19.

### P21 `POST /api/v1/connection/runs`

Starts a background run in the same process and answers at once.

| Item | Rule |
|---|---|
| Request | `StartRunRequest` (strict): `{ steps: ('connect' \| 'configure' \| 'verify')[] \| 'repair', mode: 'continue' \| 'reconcile', tenantHint?: string, applicationName?: string, exchangeRole?: 'exchange_administrator' \| 'exchange_recipient_administrator' }`. `steps` is a non-empty ordered subset without repeats, or the word `repair` (which requires `mode: reconcile`). `tenantHint`: a lower-case tenant GUID or a DNS name (labels of letters, digits and hyphens, 1 to 63 characters, at most 253 in total), never `common`, `consumers` or `organizations` (the authority is the hint or `organizations`; FR-B-317). `applicationName`: 3 to 64 characters, NFC, through the organisation-name normaliser (FR-B-303). `exchangeRole`: a key of the constant `EXCHANGE_ROLES` (default `exchange_administrator`, FR-B-308); a GUID or any other value is 422 `validation_failed`, so no other directory role can be assigned to the runtime application |
| Modes | `continue` skips sub-actions already `succeeded` or `skipped`; `reconcile` visits every sub-action read-first (repair, and the idempotency test) |
| Preconditions | `connect` needs `environment` without `failed`; `configure` needs `connect` succeeded and, in automatic mode, a live bootstrap object; `verify` needs `configure` succeeded or warning; `repair` needs the pinned tenant and either a fresh device-code sign-in on that tenant or the manual inputs |
| 202 | `RunStatus`; `Location: /api/v1/connection/runs/current`. The run continues in the background; progress comes from P22 |
| Errors | 409 `setup_step_busy` (lease held by another run, browser or process), 409 `setup_step_not_ready` (a precondition step has not succeeded), 409 `tenant_mismatch` (repair against another tenant; the bootstrap token is discarded), 422 `validation_failed`, 503 `secrets_unavailable` (the certificate cannot be generated or opened), 401, 403 `permission_denied`, `step_up_required`, `origin_not_allowed`, `csrf_invalid`, 404 gate, 413, 415, 429, 503 `storage_unavailable` |
| Audit | `setup.step.run` per sub-action result while the state is not `completed`; `connection.repair` (`subAction`, `drift`, `status`, `codes`) afterwards; `setup.object.change` for every tenant-changing call, in the same transaction as its `setup_object` row; `secrets.certificate.create` when a certificate is generated |

### P22 `GET /api/v1/connection/runs/current?after=`

The one polled channel (SB-19); it declares `slidesSession: false` (FR-B-420), so polling does not keep a user session alive. The UI calls it once per second while a run is active or the device code is shown (every 2 seconds in a hidden tab) and after every action. It carries the run, the step states, the device-code panel and the new log lines together, so the polling load is one request per second against the `read` bucket.

```ts
RunSnapshot = {
  serverTime: IsoTimestamp,
  run: RunStatus | null,                        // the current run, else the most recent one of this process; null when none has started since the process began (the persisted step rows still show earlier results)
  steps: StepState[],                           // the five steps, always
  deviceCode: DeviceCodePanel | null,
  adoption: AdoptionPrompt | null,
  log: { lines: LogLine[], lastSeq: integer, hasMore: boolean, truncated: boolean }
}
```

Query `after` (integer >= 0, default 0): lines with `seq > after`, at most 200 (`hasMore` says there are more; the client asks again at once with `lastSeq`). With no run the answer is **200 with `run: null`**, not 404 (CD-04): a 404 would be indistinguishable from a closed gate and would trip the e2e rule on unexpected 4xx. Errors as P19.

### P23 `POST /api/v1/connection/runs/current/retry-now`

Wakes the current wait immediately; the attempt counts. Body `{}`. 202 `RunStatus`. Errors: 409 `setup_step_not_ready` (no run, or none is waiting; CD-04), 401, 403, 404, 429.

### P24 `POST /api/v1/connection/runs/current/cancel`

Sets the cancel flag; the runner stops at its next checkpoint (between calls and during waits), cancels a pending device-code acquisition, returns `running` and `waiting` rows to `pending`, discards the bootstrap object and releases the lease. The call in flight completes and its answer is recorded. Body `{}`. 202 `RunStatus` (`cancelRequested: true`). Errors: 409 `setup_step_not_ready` (no run), 401, 403, 404, 429.

### P25 `POST /api/v1/connection/adopt`

Explicit confirmation to adopt an existing application that has the wizard's name but not our install tag (EB-06). Only valid while the current run is waiting with `application_adoption_required`.

| Item | Rule |
|---|---|
| Request | `AdoptRequest` (strict): `{ kind: 'application', objectId: Guid, confirm: true, acknowledgeForeign?: boolean }`; `objectId` must equal the candidate in the current `AdoptionPrompt`; `acknowledgeForeign: true` is required when the prompt says `requiresAcknowledgement` (FR-B-318) |
| 200 | `RunStatus` (the run continues) |
| Errors | 409 `setup_step_not_ready` (nothing to adopt), 422 `validation_failed` (`confirm` is not `true`, `objectId` differs from the candidate (pointer `/objectId`), or `acknowledgeForeign` is missing when required (pointer `/acknowledgeForeign`)), 401, 403, 404, 429 |
| Audit | `setup.object.change` with `kind: application`, `op: adopt`, `confirmed: true`, `objectId`, `appId`, `name` |

### P26 `POST /api/v1/connection/verify`

Re-runs the app-only checks V1, V2 (comparison only; it never changes the pinned tenant), V3 and V5 with fresh tokens in one request (budget 60 seconds, no waiting loop) and replaces the app-only items of the stored proof. The delegated checks V4 and V6 need a fresh bootstrap and keep their previous values.

| Item | Rule |
|---|---|
| Request | `{}` |
| 200 | `Proof` (section 6.1). Individual failed items are results, not errors: the status is 200 either way |
| Errors | 409 `setup_step_busy` (a run is active), 409 `setup_step_not_ready` (not connected: no pinned tenant or no active certificate), 503 `secrets_unavailable`, 503 `graph_throttled` (`Retry-After` from Graph, when the 60-second budget cannot cover the wait), 401, 403, 404, 429 |
| Audit | `connection.verify` `success` when no item is `failed`, `error` otherwise; detail `checks`, `codes` |

## 7. Access control and RBAC (P27 to P32)

Access `rbac:manage` (global-only permission, so no scope applies). Reads need no step-up; creating and deleting need it for user actors. Of the RBAC routes a break-glass session reaches P27, P28, P31 and P32 only; P29 and P30 declare `actorKinds: ['user']`, which makes FR-B-523 ("no other write route accepts break-glass") true even for a custom role that holds only `rbac:manage` (SB-03).

```ts
Guid, IsoTimestamp                                   // lower-case GUID; UTC ISO-8601 with milliseconds
ScopeItem = { target: 'user' | 'group' | 'distributionList' | 'contact',
              match: { by: 'id', id: Guid } | { by: 'prefix', attr: 'displayName' | 'alias' | 'mail', value: string } | { by: 'department', value: string } }
            // the combinations are the SCOPE_MATRIX of plan 11.3; value: NFC, trimmed, 1 to 64 code points
Assignment = { id: Guid, principalType: 'user' | 'group', principalId: Guid, role: { key: string, builtin: boolean },
               scope: ScopeItem[], expiresAt: IsoTimestamp | null, source: 'wizard' | 'api' | 'break_glass',
               createdAt: IsoTimestamp, createdBy: string }
Grant      = { permission: Permission, qualifier: 'full' | 'basic', scope: 'all' | ScopeItem[] }
```

### P27 `GET /api/v1/rbac/roles`

200 `RoleListResponse`: `{ roles: { key: string, builtin: boolean, assignable: boolean, permissions: { permission: Permission, qualifier: 'full' \| 'basic' }[] }[], templates: { key: string, permissions: { permission: Permission, qualifier: 'full' \| 'basic' }[], scopeTarget: ScopeItem['target'] \| null }[] }`. Role display names come from the catalogue by key; templates are not assignable. Errors: 401, 403, 429, 503.

### P28 `GET /api/v1/rbac/assignments`

Query `AssignmentListQuery`: `principalId` (Guid, optional), `role` (role key, optional), `limit`, `cursor`. 200 `AssignmentListResponse`: `{ assignments: Assignment[], unresolvable: Guid[], total: integer, nextCursor: string | null }`. `unresolvable` lists group ids that Graph rejected during the last membership refresh (FR-B-507, U38). Ordering: `createdAt` then `id`. Errors: 401, 403, 422, 429, 503.

### P29 `POST /api/v1/rbac/assignments`

| Item | Rule |
|---|---|
| Request | `CreateAssignmentRequest` (strict): `{ principalType: 'user' \| 'group', principalId: Guid, role: string, scope?: ScopeItem[], expiresAt?: IsoTimestamp \| null }`; at most 50 scope items |
| Validation order | Zod -> role exists and is assignable -> `owner` takes no scope and no expiry -> a group principal with a role that holds `rbac:manage` or `settings:connection` is refused (422 `assignment_invalid`, `errors[]` code `privileged_role_group`; FR-B-515) -> every scope target is used by one of the role's permissions, and global-only roles take no scope (`assignment_invalid`) -> `expiresAt` in the future and at most 730 days ahead -> **early `canGrant`** (403 `escalation_denied` before any Graph traffic) -> the principal exists (`GraphClient.getUser` or `getGroup`) -> `BEGIN IMMEDIATE`: reload the actor's grants, `canGrant` again, count limits (5,000 assignments, 100 roles, 200 distinct bound groups, 50 scope items), insert, audit |
| 201 | `Assignment`; `Location: /api/v1/rbac/assignments/{id}` |
| Errors | 403 `escalation_denied` (audited as denied with the reason), 403 `permission_denied`, `step_up_required`, 409 `assignment_exists` (same principal, role and scope set), 422 `assignment_invalid`, 422 `principal_unknown`, 422 `validation_failed`, 503 `graph_unavailable` (`Retry-After: 30`), 503 `graph_throttled`, 401, 403 Origin/CSRF, 413, 415, 429 |
| Audit | `rbac.assignment.create`: `principalType`, `principalId`, `role`, `scopeTargets`, `scopeItems`, `expiresAt`, `source: api` |

### P30 `DELETE /api/v1/rbac/assignments/{id}`

`id` is a GUID path parameter (an invalid value is the standard 404). Requires `canGrant` for the assignment being removed (nobody removes what they could not grant). The last-Owner rule runs inside `BEGIN IMMEDIATE`, with the SQL trigger as backstop mapping to the same error. `204`. Errors: 404 `not_found`, 403 `escalation_denied`, 409 `last_owner_protected` (audited as denied with the reason), 403 `permission_denied`, `step_up_required`, 401, 403 Origin/CSRF, 429. Audit `rbac.assignment.delete`: `principalType`, `principalId`, `role`, `reason` (`revoked`).

### P31 `GET /api/v1/rbac/effective?principal=`

Query `EffectiveQuery`: `principal` (Guid, required), `principalType` (`user` default, or `group`). 200 `EffectiveResponse`: `{ principal: { type, id, label: string | null }, assignments: { assignment: Assignment, origin: { type: 'direct' } | { type: 'group', groupId: Guid } }[], grants: Grant[], groupsResolved: boolean, resolvedAt: IsoTimestamp | null }`. For a user, group memberships come from the cache when the user's `groups_resolved_at` is within the TTL, otherwise from a live `checkMemberGroups` that is **not** written to the cache (CD-06); when Graph fails the answer is 200 with direct assignments only and `groupsResolved: false`. A group principal yields only its own assignments. Expired assignments are excluded. Errors: 401, 403, 422 `validation_failed`, 429, 503.

### P32 `POST /api/v1/rbac/restore-owner`

The break-glass recovery path (FR-B-523). `actorKinds: ['break_glass']`: any other actor, an Owner included, gets 403 `permission_denied` (audited). It is the only path that skips `canGrant`.

| Item | Rule |
|---|---|
| Request | `RestoreOwnerRequest` (strict): `{ userId: Guid, confirmUnverified?: boolean }` |
| Effect | `GraphClient.getUser(userId)`: null -> 422 `principal_unknown`; `accountEnabled` false -> 422 `principal_unknown` with `errors[]` code `principal_disabled` (FR-B-523); Graph unavailable -> 503 `graph_unavailable` unless `confirmUnverified: true` (the operator accepts the id as typed; `graphChecked: false` in the audit). Then one transaction inserts the `owner` assignment (`principal_type user`, `source: break_glass`, `created_by: break-glass`) |
| 201 | `Assignment` |
| Errors | 409 `assignment_exists` (the user already holds `owner`), 422 `principal_unknown`, 422 `validation_failed`, 503 `graph_unavailable`, 403 `permission_denied`, 401, 403 Origin/CSRF, 429 |
| Audit | `rbac.owner.restore`: `assignmentId`, `graphChecked` |

## 8. Changes to Phase A routes

| Route | Change |
|---|---|
| R1 `/healthz`, R3 `/api/v1/openapi.json`, R13 to R17 | None in behaviour. The OpenAPI document gains the Phase B operations and the `x-*` extensions of section 1 |
| R2 `GET /readyz` | `ReadyzResponse.checks[].name` gains `secrets` with failure codes `app_key_missing`, `app_key_invalid`, `certificate_unreadable`. The check can fail readiness only when the state is `completed` or a certificate exists (FR-B-108; with state not `completed` and a missing key the wizard's `app_key` check reports it and `/readyz` stays 200). Never a key or raw error text |
| R4 `GET /api/v1/me` (P07) | New `MeResponse` (section 4). Removed: `features.preview`, actor kind `preview`. Added: actor kinds `user`, `setup`, `break_glass`, `roles`, `session`, `setup`, `features.breakGlass` |
| R5 `GET /api/v1/csrf` (P08) | Shape unchanged; the binding is computed from the cookies as sent (SB-09) |
| R6 `GET /api/v1/branding` | Public, unchanged |
| R7 to R11 branding writes and export | Permission `settings:branding`, unchanged, but who holds it changes: users through role assignments (*Eigenaar* and *Beheerder*), and the setup actor (SB-01, so the wizard's Appearance step can run). **An anonymous caller now gets 401 `unauthenticated`** with `WWW-Authenticate: Cookie realm="m365portal"` (was 403 `permission_denied`); a signed-in caller without the permission gets 403 and an audit entry with `reason_code` `permission_missing`. R10 still applies the `Sec-Fetch-Site` rule (a GET that audits) |
| R12 `GET /branding/{file}` | Unreferenced assets are served to any actor holding `settings:branding`, including the setup actor |
| S2 shell and SPA fallback | While the state is not `completed`, an HTML navigation to a panel page is answered `303 /setup`, except `/setup*`, `/signin`, `/no-access` (SB-26) and static assets, and except a request that carries a valid user session (SB-14). The boot data embeds the real `MeResponse`. `Cache-Control: no-store` as before. After `completed`, `/setup` and `/setup/*` render Not-found with status 404 |
| All Phase A write routes | `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` no longer exist (a warning `preview_mode_removed` is logged if either is set; it has no effect). Nothing grants permissions by `Host` any more |

`X-Session-Idle-Expires`, the new 401 behaviour and the new denial reasons apply to every route, Phase A included.

## 9. Codes

### 9.1 Problem codes

Phase A codes are unchanged (`permission_denied`, `origin_not_allowed`, `csrf_invalid`, `not_found`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`, `validation_failed`, `rate_limited`, `internal_error`, `storage_unavailable`, `storage_busy`, `shutting_down`). `permission_denied` now covers a missing permission, a scope mismatch and a wrong actor kind alike; the audit `reason_code` tells them apart. Registry: `packages/shared/src/problem.ts`; messages `problem.<code>` in `nl` and `en`; the UI never shows `detail`.

| Code | Status | Raised by | `Retry-After` |
|---|---|---|---|
| `unauthenticated` | 401 | every non-public route without a valid session or setup session; carries `WWW-Authenticate: Cookie realm="m365portal"`; also every failed break-glass attempt (P06) | |
| `session_expired` | 401 | unknown or expired session cookie on a non-public route; the cookie is cleared | |
| `step_up_required` | 403 | P21, P23 to P26, P29, P30 for a user actor without a step-up in the last 10 minutes | |
| `escalation_denied` | 403 | P29, P30: `canGrant` is false | |
| `last_owner_protected` | 409 | P30 (and any change that would leave no user-principal `owner`) | |
| `setup_token_invalid` | 401 | P11 | |
| `setup_token_locked` | 429 | P11 | integer seconds |
| `setup_step_busy` | 409 | P14, P15, P18, P21, P26: the runner lease is held | |
| `setup_step_not_ready` | 409 | P14 to P18, P21 to P26: a precondition step has not succeeded, or no run exists | |
| `setup_required` | 409 | P06; sign-in start and callback (as a redirect code) | |
| `secrets_unavailable` | 503 | P15, P17, P21, P26: `APP_KEY` missing or invalid, certificate unreadable | |
| `policy_not_applied` | 500 | a scoped route that returned 2xx without applying scope (none in Phase B; the test-only module proves the net); audited as `error` | |
| `principal_unknown` | 422 | P15, P29, P32 | |
| `assignment_exists` | 409 | P29, P32 | |
| `assignment_invalid` | 422 | P29: role not assignable, scope target unused by the role, expiry out of range, `owner` with scope or expiry, a privileged role for a group (`errors[]` code `privileged_role_group`) | |
| `break_glass_locked` | 429 | P06 | integer seconds |
| `graph_unavailable` | 503 | P15, P17, P18, P29, P32 | 30 |
| `graph_throttled` | 503 | any Graph-backed route when Graph asks for a wait over 60 seconds | value from Graph |
| `tenant_mismatch` | 409 | P15, P21 | |

### 9.2 Sign-in error codes and no-access reasons

`/signin?error=<code>` accepts only the allow-list below; any other value renders `signin_failed`. `/no-access?reason=<reason>&ref=<request id>` accepts `no_role` and `graph_unavailable` (anything else renders `no_role`); `ref` is shown only when it matches `^[A-Za-z0-9-]{8,64}$`.

| Code | Raised by | Audited |
|---|---|---|
| `signin_failed` | any token, state or exchange failure that must not say which check failed | from ID-token validation on |
| `cookies_missing_or_expired` | no live transaction | no |
| `access_denied`, `interaction_required` | `error` parameter from Entra | no |
| `consent_required`, `admin_approval_required`, `assignment_required` | `AADSTS65001`; `AADSTS90093` and `AADSTS90094`; `AADSTS50105` | no |
| `conditional_access_blocked` | `AADSTS53003` | no |
| `temporarily_unavailable` | token endpoint or key endpoint unavailable | no |
| `mfa_required`, `amr_missing` | FR-B-405 | yes |
| `stepup_failed` | step-up callback failed a check of FR-B-411 | yes |
| `secrets_unavailable`, `setup_required` | login start (FR-B-402) | no |
| `session_expired` | the web app redirects after a 401 `session_expired`; P01 with `purpose=stepup` and no user session | no |
| no-access `no_role` | principal without an active grant | yes |
| no-access `graph_unavailable` | only group-derived grants could exist and Graph failed | yes |

For `consent_required` and `admin_approval_required` the sign-in page also shows the tenant-wide consent link built from the registered callback URI (FR-B-419; effect UNVERIFIED, U30, owner-verified OV-12). The `reason` and `check` values written to the audit entries of `auth.signin` and `auth.stepup` come from the registries of plan 8.6.5 and spec Appendix C (`size`, `format`, `header`, `alg`, `tenant`, `issuer`, `kid`, `signature`, `expired`, `not_before`, `audience`, `issued_at`, `version`, `oid`, `nonce`, `state`, `keys_unavailable`, and the step-up checks); the user never sees them.

### 9.3 No-access behaviour

| Situation | Server | UI |
|---|---|---|
| Valid sign-in, no effective permission | No session is created. `303 /no-access?reason=no_role&ref=<request id>`; audit `auth.signin` denied (`no_role`) | Page with the organisation mark and name, a translated explanation, the reference id, "Sign in again" (`prompt=login`) and "Use another account" (`prompt=select_account`); no data, no session |
| Only group-derived grants could exist and Graph failed | `303 /no-access?reason=graph_unavailable&ref=...`; audit `auth.signin` denied | Same page, reason variant. Nothing is retried automatically |
| Signed in, lacks the permission for a page or action | API: 403 `permission_denied` (audited with `permission_missing` or `scope_mismatch`); no session change | The in-place No-access content (Phase A) at the same URL; navigation and command palette hide what the actor cannot use |
| Rights disappear during a session (assignment expiry or revocation, group removal) | The session stays valid; the next request computes empty or smaller grants (the epoch and the earliest expiry invalidate the memo at once); `GET /api/v1/me` reports `permissions: []` | The shell shows the No-access content; the persona menu still offers Sign out |
| Account disabled or deleted in Entra | At the next revalidation all sessions of the principal are deleted (audit `auth.session.revoked`, `reason: account_disabled`); the request answers 401 `unauthenticated` | Redirect to `/signin?returnTo=` |
| Graph down at revalidation | Direct assignments keep applying, group-derived grants are dropped once the TTL passed, `groupsStale` is set; retried no more often than every 30 s | A notice that group-based access may be incomplete |

## 10. UI routes (single-page application, served by the shell fallback)

| Path | Status and content | Gate |
|---|---|---|
| `/setup`, `/setup/*` | Token form, or the wizard when `GET /api/v1/setup/state` succeeds. **404 once the state is `completed`** (the shell renders Not-found), and 404 over plain http from a non-loopback `Host` | none in the client; the server decides |
| `/signin` | Sign-in page; query `error` (allow-list of 9.2), `returnTo`, `signedout=1`. A visitor who already has a session is sent to `returnTo` | public |
| `/no-access` | Query `reason`, `ref` (9.2); no data | none |
| `/break-glass` | Username and password form with red warning text; **404 unless `features.breakGlass`** | Not-found unless configured |
| `/settings/connection` | State, certificate expiry, proof list, log, "Herstel verbinding" | `settings:connection` |
| `/settings/access` | "Mijn toegang" | any signed-in actor (user or break-glass) |
| `/settings/restore-access` | "Eigenaar herstellen" | actor kind `break_glass` |

An anonymous visitor of a gated route is replaced (history `replace`) to `/signin?returnTo=<path>`; a signed-in actor without the permission sees the in-place No-access content. On boot, when the embedded actor is anonymous and `setup.state` is not `unconfigured`, the client sends one `GET /api/v1/me` before any gating redirect, because a cross-site navigation does not carry the `SameSite=Strict` cookie (PB-15); the wait is capped at 800 ms.

## 11. Examples (illustrative, abbreviated)

Start of a sign-in and the redirect to Entra.

```http
GET /auth/login?returnTo=%2Fusers HTTP/1.1
Host: panel.example.org

HTTP/1.1 303 See Other
Location: https://login.microsoftonline.com/6c1f0d3e-0000-4000-8000-000000000001/oauth2/v2.0/authorize?client_id=0b9c...&response_type=code&redirect_uri=https%3A%2F%2Fpanel.example.org%2Fauth%2Fcallback&response_mode=query&scope=openid%20profile&state=Zk3...&nonce=Qp9...&code_challenge=E9Me...&code_challenge_method=S256
Set-Cookie: __Host-m365portal_oidc=Hq2...; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax
Cache-Control: no-store
```

The callback interstitial after a successful sign-in (never a 303).

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Set-Cookie: __Host-m365portal_session=Vb7...; Path=/; Secure; HttpOnly; SameSite=Strict
Set-Cookie: __Host-m365portal_oidc=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; ...nonce-Gx1...

<!doctype html><meta http-equiv="refresh" content="0;url=/users"><a href="/users">Doorgaan</a>
```

Unlocking setup, wrong token, then a lock.

```http
POST /api/v1/setup/unlock HTTP/1.1
Origin: http://localhost:9300
X-CSRF-Token: v1.1760000000.1760028800.Q3x1...fA.7bK...Zk
Content-Type: application/json

{ "token": "not-the-token" }

HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json

{ "type": "urn:m365portal:problem:setup_token_invalid", "title": "The setup token is not valid", "status": 401,
  "detail": "The token does not match.", "code": "setup_token_invalid", "requestId": "0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c" }

HTTP/1.1 429 Too Many Requests
Retry-After: 897
Content-Type: application/problem+json

{ "type": "urn:m365portal:problem:setup_token_locked", "status": 429, "code": "setup_token_locked", "requestId": "..." }
```

One poll while the wizard waits for Microsoft to replicate.

```http
GET /api/v1/connection/runs/current?after=41 HTTP/1.1
Cookie: m365portal_setup=Ur4...

HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
```
```json
{ "serverTime": "2026-10-10T12:00:07.120Z",
  "run": { "id": "5d0f6b0e-3c1a-4a4e-9b57-0e5a9a1a7c10", "kind": "setup", "mode": "continue", "steps": ["connect", "configure", "verify"],
           "status": "waiting", "startedAt": "2026-10-10T11:58:02.004Z", "finishedAt": null, "cancelRequested": false },
  "steps": [ { "step": "environment", "status": "succeeded", "subActions": [] },
             { "step": "connect", "status": "succeeded", "subActions": [] },
             { "step": "configure", "status": "running", "subActions": [
               { "key": "graph_permissions", "status": "waiting", "attempt": 3, "startedAt": "2026-10-10T11:59:40.000Z", "finishedAt": null,
                 "errorCode": null, "hint": null, "waiting": { "attempt": 3, "max": 12, "nextAttemptAt": "2026-10-10T12:00:15.000Z" }, "manual": false } ] },
             { "step": "verify", "status": "pending", "subActions": [] },
             { "step": "finish", "status": "pending", "subActions": [] } ],
  "deviceCode": null, "adoption": null,
  "log": { "lines": [ { "seq": 42, "ts": "2026-10-10T12:00:01.000Z", "step": "configure", "level": "info",
                        "messageKey": "setup.log.waiting_replication", "params": { "attempt": 3, "max": 12, "seconds": 14 } } ],
           "lastSeq": 42, "hasMore": false, "truncated": false } }
```

An escalation attempt.

```http
POST /api/v1/rbac/assignments HTTP/1.1
Origin: https://panel.example.org
X-CSRF-Token: v1....
Content-Type: application/json

{ "principalType": "user", "principalId": "8e0c2b8e-0000-4000-8000-0000000000aa", "role": "owner" }

HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{ "type": "urn:m365portal:problem:escalation_denied", "title": "You cannot grant more than you hold", "status": 403,
  "detail": "The requested role exceeds the caller's permissions.", "code": "escalation_denied", "requestId": "..." }
```

An unauthenticated API call.

```http
GET /api/v1/rbac/roles HTTP/1.1

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Cookie realm="m365portal"
Cache-Control: no-store
Content-Type: application/problem+json

{ "type": "urn:m365portal:problem:unauthenticated", "title": "Sign in required", "status": 401, "detail": "No valid session.",
  "code": "unauthenticated", "requestId": "..." }
```

## 12. Zod schemas and the package boundary

Naming and rules of Phase A section 8 apply: the constant ends in `Schema`; the OpenAPI component id and the inferred type drop the suffix; every schema that appears in a route lives in `packages/shared`; no transform in a route schema; request schemas are `.strict()`; normalisation happens in the services through the shared normalisers.

### 12.1 `packages/shared` (used by server and web)

| File | Schemas and constants |
|---|---|
| `schemas/common.ts` (extended) | `GuidSchema` (lower-case canonical), `ParamsSchema` (scalar map, at most 8 entries, strings at most 256 bytes), `CursorSchema`, `PageQuerySchema` |
| `schemas/meta.ts` (changed) | `ActorSummarySchema`, `RoleRefSchema`, `SessionSummarySchema`, `SetupSummarySchema`, `FeaturesSchema`, `MeResponseSchema`, `CsrfResponseSchema` (unchanged) |
| `schemas/auth.ts` | `LoginQuerySchema`, `LogoutRequestSchema`, `LogoutResponseSchema`, `LogoutAllResponseSchema`, `BreakGlassRequestSchema`, `BreakGlassResponseSchema`, `SigninErrorCodeSchema` (from `SIGNIN_ERROR_CODES`), `NoAccessReasonSchema`, `MyAccessResponseSchema` |
| `schemas/setup.ts` | `SetupStateSchema`, `StepKeySchema`, `StepStatusSchema`, `SetupStatusResponseSchema`, `UnlockRequestSchema`, `UnlockResponseSchema`, `SetupStateResponseSchema`, `EnvironmentCheckSchema`, `EnvironmentResultSchema`, `ManualRequestSchema`, `ManualResponseSchema`, `GroupSearchQuerySchema`, `GroupSearchResponseSchema`, `FinishRequestSchema`, `FinishResponseSchema` |
| `schemas/connection.ts` | `ResultCodeSchema` (from `SETUP_RESULT_CODES`), `SubActionStateSchema`, `StepStateSchema`, `LogLineSchema`, `LogQuerySchema`, `LogPageSchema`, `RunStatusSchema`, `DeviceCodePanelSchema`, `AdoptionPromptSchema`, `RunSnapshotSchema`, `StartRunRequestSchema`, `AdoptRequestSchema`, `ProofItemSchema`, `ProofSchema` (also the validator of the stored `tenant_connection.proof`, at most 51,200 bytes), `ConnectionResponseSchema` |
| `schemas/rbac.ts` | `ScopeItemSchema` (validated against `SCOPE_MATRIX`), `GrantSchema`, `AssignmentSchema`, `RoleSchema`, `RoleTemplateSchema`, `RoleListResponseSchema`, `AssignmentListQuerySchema`, `AssignmentListResponseSchema`, `CreateAssignmentRequestSchema`, `EffectiveQuerySchema`, `EffectiveResponseSchema`, `RestoreOwnerRequestSchema` |
| `permissions.ts`, `problem.ts`, `limits.ts` | Extended: the 19 new problem codes with status and title; the Phase B limits of spec 6.9.2 |
| `setup/` | `STEPS` and sub-action keys, `SETUP_RESULT_CODES`, `LOG_KEYS`, `buildDesiredState`, `aggregate`, backoff schedule, `isAllowedVerificationUri`, `EXCHANGE_ROLES` (FR-B-308), `SETUP_STEP_DETAIL` (closed key list) |
| `auth/` | `cookieNames`, `serializeCookie`, `redirectUris`, `authorizeRedirectUri`, `safeReturnTo`, `evaluateAmr`, `SIGNIN_ERROR_CODES`, `NO_ACCESS_REASONS`, `SIGNIN_CHECKS` |
| `rbac/` | `BUILTIN_ROLES`, `TEMPLATES`, `PERMISSION_RESOURCE`, `SCOPE_MATRIX`, `normalizeScopeItem`, `canonicalScopeKey`, `matchScope`, `computeGrants`, `covers`, `canGrantCore`, `projectUser`, `GROUP_FORBIDDEN_PERMISSIONS` (FR-B-515), `roleLabelKey`, `permissionLabelKey`, `scopeItemText`, `qualifierLabelKey`, `originText`, `principalLabel` (FR-B-716) (FR-B-713: one implementation each, source scan) |

### 12.2 Server only (`apps/server`)

`EnvSchema` (extended with table 6.9.1, parity-tested with `.env.example`), the audit allow-list (`audit/allowlist.ts`, data-model section 10), `SessionRowSchema`, the login transaction type, `IdTokenClaimsSchema` and `ValidatedIdToken`, Graph and Exchange DTO schemas (allow-lists that drop unknown fields), `StepDetailSchema` and `LogParamsSchema` (secret-free writers), `RouteDefinition` additions (`availability`, `actorKinds`, `secFetch`, access kinds).

### 12.3 Web only (`apps/web`)

`TokenFormSchema`, `ManualFormSchema` (derived from `ManualRequestSchema` with `.pick()` and `.extend()`), `AssignmentFormSchema` (Phase D screen, derived from `CreateAssignmentRequestSchema`), the `StepUpDialog` state types. Web code imports shared schemas lazily in the route chunks (`setup`, `connection`) and shared types everywhere with `import type`.

### 12.4 OpenAPI rules

As Phase A 8.4, plus: every operation lists its success response and the problem responses it can produce through the shared `Problem` component; `x-access`, `x-step-up`, `x-actor-kinds`, `x-availability` and `x-audit` come from the definition that enforces them; P01 to P03 are documented with their redirect and HTML responses; the document never contains a token, a cookie value or the setup token (`server/no-leak.test.ts`).

### 12.5 Controls for this file

| Control | What it proves |
|---|---|
| `server/openapi.test.ts` | The documented set equals the registered set (P01 to P32 included) and validates against the OpenAPI 3.1 meta-schema |
| `server/route-table.test.ts` | Every route declares access; the exemption lists (`secFetch`, `availability`) are exactly as stated; setup and connection routes carry the gate |
| `server/policy-matrix.test.ts`, `server/api-conventions.test.ts` | 401 versus 403 versus 404 per route and actor kind; `WWW-Authenticate` on every 401 |
| `server/setup/gate.test.ts`, `server/setup/lock.test.ts` | The setup and connection routes before and after `completed`; the 404 is byte-equal to an unknown path |
| `server/auth/callback.test.ts`, `server/auth/interstitial.test.ts`, `server/auth/headers.test.ts` | P01 to P03 against the 45 fixtures; the interstitial is a 200; cookie attributes and `Set-Cookie` discipline |
| `server/audit-b-coverage.test.ts`, `server/audit-denials.test.ts` | Every route's audit declaration and every denial |
| `server/docs-contract.test.ts` | Every route id of this file exists in the route table and conversely |
| `shared/schemas-meta.test.ts`, `shared/schemas-setup.test.ts`, `shared/error-codes.test.ts` | Schema shapes, registries, and that every code has a message in both catalogues |

## 13. Decisions taken in this file

| ID | Decision | Revisit when |
|---|---|---|
| CD-01 | `GET /auth/login?purpose=stepup` without a valid user session redirects to `/signin?error=session_expired&returnTo=...` instead of silently becoming a normal sign-in (a normal sign-in does not set `step_up_at`) | Never |
| CD-02 | The logout `redirect` is the Entra URL for user sessions and the local path `/signin?signedout=1` for break-glass sessions; the client accepts exactly those two shapes | Never |
| CD-03 | `tokenRequired` is true unless the request already carries a valid setup session | A deployment mode without a token is ever added (not planned) |
| CD-04 | `GET .../runs/current` with no run is 200 with `run: null`; retry-now and cancel with no run are 409 `setup_step_not_ready` | Never |
| CD-05 | Wizard result codes are never the problem `code`; they travel in `errors[].code` and in step states | Never |
| CD-06 | `GET /rbac/effective` resolves group membership live without writing the cache when the user's cached resolution is stale; on a Graph failure it answers 200 with `groupsResolved: false` | A Phase D "view as" screen needs the cache |
| CD-07 | A closed gate, an unknown id and an unknown path are the same 404; an unknown or malformed setup cookie is 401 `unauthenticated` without clearing | Never |
| CD-08 | Break-glass attempts refused by a lock or a full queue are 429 and not audited; failures inside the bound are | An incident review asks for lock events (then a single entry at lock start, as `setup.unlock`) |
| CD-09 | Group search returns at most 25 groups | The wizard UI needs paging |
| CD-10 | List routes take `limit` (1 to 200, default 100) and an opaque `cursor`, and return `nextCursor` | Phase D lists need sorting |
| CD-11 | Break-glass credential failures are 401 `unauthenticated` with the challenge header, identical for an unknown user and a wrong password (FR-B-521 names only the 429 lock; a 403 would say "signed in but not allowed") | Never |
| CD-12 | `POST /connection/verify` returns the full `Proof` (so the settings page needs no second read); the stored proof is replaced for the app-only items only | Never |
| CD-13 | An `AdoptionPrompt` carries the counts of foreign key credentials and owners and `requiresAcknowledgement`; a password credential ends the step with `application_untrusted` instead of a prompt (FR-B-318, ODB-18) | The owner test (OV-03) |
| CD-14 | `exchangeRole` is a key of `EXCHANGE_ROLES`, never a free GUID, so a request cannot assign an arbitrary directory role to the runtime application (FR-B-308) | A third role is added to the constant with evidence |
| CD-15 | `FinishRequest` names the person who becomes Owner (`confirmOwnerOid`); a replayed finish is 409 (FR-B-219 h) | Never |
| CD-16 | A group principal never receives a role holding `rbac:manage` or `settings:connection`; the refusal is `assignment_invalid` with `errors[]` code `privileged_role_group` (FR-B-515, ODB-16) | The owner overturns ODB-16 |
