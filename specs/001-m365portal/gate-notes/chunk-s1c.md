# Chunk note s1c (T-A-029 to T-A-034): open points, assumptions, risks

Written by the `s1c` worker for S8's consolidation (`T-A-278`). This chunk has no gate task (G1 is `T-A-046`), so this note is the whole record: what was done, what evidence exists, what the next S1 tasks must know, and what was not verified. The chunk started from nothing: no file of these six tasks existed in the tree.

## 1. Tasks and evidence

| Task | Files (all in S1's territory) | Tests |
|---|---|---|
| T-A-029 logging | `apps/server/src/logging/{logger,redact,request-logger}.ts`, `test/logging.test.ts` | TBD_LOGGING |
| T-A-030 rate limiting | `apps/server/src/http/rate-limit.ts`, `test/rate-limit.test.ts` | TBD_RATE |
| T-A-031 body limits, content type, Node options | `apps/server/src/http/{body-limit,content-type,server-options}.ts`, `test/body-limits.test.ts` | TBD_BODY |
| T-A-032 compression, cache headers | `apps/server/src/http/{compress,cache-headers}.ts`, `test/cache-headers.test.ts` | TBD_CACHE |
| T-A-033 policy layer, resolvers, preview mode | `apps/server/src/policy/{actor,authorize,resolvers,index}.ts`, `test/policy.test.ts`, `test/preview-mode.test.ts` | TBD_POLICY |
| T-A-034 Origin and CSRF | `apps/server/src/http/{origin,csrf}.ts`, `test/csrf.test.ts` | TBD_CSRF |
| Total | | TBD_TOTAL |

Dependency: `pino` 10.4.0 was added to `apps/server` through the install protocol (`flock`, `pnpm --filter @m365portal/server add pino@10.4.0`, exit 0; `pnpm-lock.yaml` keeps its 37 `libc:` lines). No other dependency was added.

Skipped, todo or only: none. No test was weakened.

Red first. For `T-A-029` the test file failed at load (`Cannot find module '../src/logging/logger.js'`) before any source existed. For `T-A-030`, `T-A-031` and `T-A-032` the three test files were written first, but the sources were written before the first run; the red state was then reproduced by moving the six source files aside and running the three files (all failed with `Cannot find module`), then moving them back. That shows the tests need the code, not that each assertion fails for the right reason one by one; the mutation pass (section 3) is the evidence for the assertions. For `T-A-033` and `T-A-034` the tests were run red before the sources existed (module not found), and the first green run exposed real defects of the sources and of the tests (listed in section 6, items 11 to 14).

Done-when checks, each by a command:

- `T-A-029`: `pino` is installed through the protocol; the reason row for S8 is open point s1c-1. The logger writes pino JSON, redacts by key at any depth, and the scripted series of `logging.test.ts` finds no canary, address or e-mail address in the request lines.
- `T-A-030`: `createRateLimiter({ now })` is a plain object over an injected clock; `rate-limit.test.ts` never waits.
- `T-A-031`: `body-limits.test.ts` scans `body-limit.ts`, `content-type.ts` and `server-options.ts` for any literal of the limits table and finds none.
- `T-A-032`: a route that sets its own `Cache-Control` keeps it (`/api/v1/own`, `/branding/referenced.png`).
- `T-A-033`: `Actor`, `Decision` and `authorize` have the shapes of plan 8.8; `resolveActor` is the only way to an actor.
- `T-A-034`: `validate(token, binding)` and `issue(binding)` take the binding; Phase B passes the session id.

## 2. Where it was run

TBD_RUN

## 3. Mutation pass

TBD_MUTATION

## 4. Interfaces the next S1 tasks use

Pipeline order that the tests of this chunk use in pairs and that `T-A-045` should keep (plan 7.2): `requestContext`, `securityHeaders`, `createRequestLogger`, `compress()`, `cacheHeaders()`, `rateLimit`, then per route: `bodyLimit`, `requireContentType`, `originAndCsrfGuard` (or `auditedReadGuard`), authorisation, validation, handler. `errorBoundary(createErrorHandler(...))` sits inside the request logger so the logged status is the status the client got.

- `logging/logger`: `createLogger({ level, destination?, now? })` returns a `Logger` with `trace`..`fatal(fields, message)` (the shape of `ErrorLogger`, so it is passed to `createErrorHandler` as it is) and `child(bindings)` (the bindings are redacted like any field; pino's own `child` would not do that, so the logger is a thin wrapper and not the pino instance); `logPosture(log, config, { storageWritable, schemaVersion })` writes the posture line of FR-A-015 once (call it at start, `T-A-045`). The default destination is standard output, synchronous. `now` is the clock for the `time` of each line. `logging/redact`: `redactDeep`, `redactFields`, `isSensitiveKey`, `REDACTED`. `logging/request-logger`: `createRequestLogger({ log, now?, routeOf? })`; `now` must be the clock `requestContext` got; `routeOf` lets the route table of `T-A-040` name the route (default: the first route registered for a method, from `hono/route`, else `unmatched`).
- `http/rate-limit`: `createRateLimiter({ now, rules?, maxClients? })` (`take(class, clientKey)` gives `{ allowed, remaining }` or `{ allowed: false, retryAfterSeconds }`; `size`), `classifyRequest({ method, path }, { isUpload? })` (`read`, `write`, `upload` or `exempt`), `rateLimit({ limiter, classOf? })`, `EXEMPT_PATHS`. The route table of `T-A-040` supplies `isUpload` (or its own `classOf`).
- `http/body-limit`: `bodyLimit(class | bytes)` with `BODY_LIMIT_BYTES` (`json`, `upload`, `import`). `http/content-type`: `requireContentType('json' | 'multipart')`, `contentTypeAllowed`, `requestHasBody`. `http/server-options`: `nodeServerOptions(overrides?)` for `serve({ serverOptions })`.
- `http/compress`: `compress()`, `chooseEncoding`, `COMPRESS_MIN_BYTES`. `http/cache-headers`: `cacheHeaders()`, `defaultCacheControl(path, status)`, `CACHE_CONTROL`, `brandingAssetCacheControl(referenced)` (for the branding route of S2), `replaceResponse(c, response)` (see item 14 of section 6: any middleware that swaps the response uses it).
- `policy`: `ANONYMOUS_ACTOR`, `PREVIEW_ACTOR`, `resolveActor(config, request)`, `createActorResolver(config)`, `authorize(actor, permission, resource?)`, `announcePreviewMode(config, { log, stderr })` (call at start, plan 7.1 step 2), `Actor`, `Decision`, `ResourceRef`, `ACTOR_KINDS`. `AppVariables` has no `actor` member yet: `T-A-040` adds it and sets it from `createActorResolver(config)(c.req.raw)`.
- `http/csrf`: `createCsrf({ now, key?, random?, ttlMs? })` gives `issue(binding)` (`{ token, expiresAt }`, the shape of `CsrfResponse`) and `validate(token, binding)`; `csrfGuard`. `http/origin`: `checkWriteOrigin`, `checkAuditedReadOrigin`, `originGuard`, `auditedReadGuard`, `originAndCsrfGuard({ expectedOrigin, csrf, binding?, onDenied? })`, `isWriteMethod`, `Denial`. `onDenied(c, { code, reason })` is awaited before the response exists and is the place for the audit entry of `T-A-041`: if it throws, the request fails closed through the error handler and the handler is never reached.
- Clocks: every module takes `now: () => number` (milliseconds) and nothing else; `FakeClock.nowMs` fits. For the server, `T-A-045` should pass `Date.now` to the CSRF generator (its times are epoch seconds) and `() => performance.now()` to the rate limiter (immune to a wall-clock step).

## 5. Assumptions

- No shared `Clock` interface: each consumer takes `now: () => number` (resolves s1a-5).
- The rate limiter, when its table is full, drops every idle bucket and then the least recently used one. Dropping several idle buckets at once is the same, for the client, as dropping one: an idle bucket records nothing. Class names do not contain `:`, so the table key `class:clientKey` is unambiguous.
- Rate class by method: `GET` and `HEAD` are `read`; every other method, `OPTIONS` included, is `write` (or `upload` where the route table says). An unknown path is rated like any other. `/assets/` needs at least one more character to be exempt; `/offline.*` is the three real files.
- The request body is read up to its limit, in full, before the handler (guard order for a chunked body: a 413 comes before a 415 or a 403). A declared `Content-Length` above the limit is refused without reading. A body that fails half way (the client went away) is a 422 `validation_failed` with the field code `body_unreadable`, not an `unhandled_error`.
- A JSON route takes `application/json` with no parameter or `charset=utf-8`; the upload takes `multipart/form-data` with a boundary of 1 to 70 characters of RFC 2046. A request with no body and no content type passes; "has a body" means a positive `Content-Length` or any `Transfer-Encoding`.
- `CONNECTIONS_CHECKING_INTERVAL_MS` is 5 s (Node's default of 30 s would let a slow client hold a socket for 45 s instead of 15). It is not in `LIMITS`; it is not a limit.
- Responses are compressed from 1 KiB, for `text/*`, `application/json`, `+json` and `application/javascript`. `Vary: Accept-Encoding` is on every response that could have been compressed, whether or not this client accepted a coding. A strong ETag becomes weak when the body is compressed; the ETag that `cacheHeaders` generates is weak from the start.
- Only a successful answer (2xx, 304) gets the cache rule of its path; every error and redirect is `no-store`, except the two icon redirects, which are `no-cache` (contract R14, R15). `/branding/<hash>.png` defaults to `private`; the branding route says `public` for a referenced asset.
- `Origin` is compared byte for byte with the origin of `PUBLIC_BASE_URL` (browsers send it lower case and serialised; an upper-case host is refused). `Sec-Fetch-Site` is compared exactly: `none` is refused on a write; an unknown or empty value is refused on a write and on an audited GET.
- A CSRF token carries seconds since the epoch; the signature is checked before the time; only the canonical base64url spelling of the signature is a signature. A clock that returns a value that is not a number makes `issue` and `validate` throw (a 500, loudly) instead of minting or accepting something.
- `isWriteMethod`, `Denial` and `OnDenied` live in `csrf.ts` and are re-exported by `origin.ts`, so that `origin.ts` can build on `csrf.ts` without a cycle.
- Preview: a `Host` of `localhost.` (one trailing dot) is loopback, because the one host normaliser drops it; `[::ffff:127.0.0.1]`, `127.1` and `0x7f.0.0.1` are not loopback (the answer errs towards anonymous). Any header whose name starts with `x-forwarded-` counts as a forwarding header, as does a header that is present and empty.
- The route label of the request line is `unmatched` for a path no method-specific route claimed. Health probes are logged at `debug`, a 5xx at `warn`, everything else at `info`. The method is written only if it is a plain upper-case token, otherwise `OTHER`.

## 6. Open points

| # | Point | Owner | When |
|---|---|---|---|
| s1c-1 | Reason row for `pino` 10.4.0 in `docs/architecture.md` (plan 5.3: structured JSON logs with redaction, D15) | S8 | `T-A-274` |
| s1c-2 | `VERSION` bump is needed at commit time (protected paths `apps/server/src/**`, `apps/server/test/**`, `pnpm-lock.yaml`). The comments of `pnpm-workspace.yaml` were already gone before this run (an earlier `pnpm add` removes them); restore them before the commit, `git diff pnpm-workspace.yaml` should then show only added catalog lines | orchestrator | commit |
| s1c-3 | `T-A-040` composes the guards per route in the order above; passes `isUpload` (or `classOf`) from the route table to `rateLimit`; adds `actor` to `AppVariables`; gives `rejectOptions` the real method list (s1b-3); passes a `routeOf` to the request logger if it wants the route id in the log instead of the path template | S1 | `T-A-040` |
| s1c-4 | `T-A-041` writes the audit entry in `onDenied` and lets an error escape to fail closed. `Denial.reason` values: `origin_missing`, `origin_null`, `origin_mismatch`, `sec_fetch_site`, `missing`, `malformed`, `bad_signature`, `expired`, `not_yet_valid`; the policy denial reason is `permission_missing` | S1 | `T-A-041` |
| s1c-5 | `T-A-042`: `GET /api/v1/csrf` answers `csrf.issue('')` (it is `no-store` by default and never compressed: it is on the compression exclusion list); `/robots.txt` gets its ETag from `cacheHeaders` | S1 | `T-A-042` |
| s1c-6 | `T-A-043`: precompressed siblings must set `Content-Encoding` (`compress` then leaves them alone) and `Vary: Accept-Encoding`; `/sw.js`, `/offline.*` and `/robots.txt` need no ETag from the static handler | S1 | `T-A-043` |
| s1c-7 | `T-A-045` wires: `createLogger({ level: config.logLevel })`, `logPosture`, `announcePreviewMode(config, { log, stderr: process.stderr })` (step 2), `serve({ serverOptions: nodeServerOptions() })`, and the clocks of section 4 | S1 | `T-A-045` |
| s1c-8 | `T-A-039` logs the audit head as `log.info({ seq, hash }, 'audit_head')`: neither key is redacted (tested) | S1 | `T-A-039` |
| s1c-9 | Decide whether the buffered request bodies need a global budget (risk R1) before Phase B adds more large routes | S1, owner | G1 |
| s1c-10 | `docs/security.md`: the CSRF design (token format, key per process, binding, leeway), the exact `Origin` rule and why, the audited-GET rule, the preview rule and that `Host` is forgeable, that `Connection: close` accompanies a 413; `docs/operations.md`: the Node-level 400, 408 and 431 (exception to FR-A-040) and the 5 s timeout check interval | S8 | `T-A-275`, `T-A-277` |
| s1c-11 | The first-person English texts of `PREVIEW_WARNING` (log and stderr) and the generic problem wording are mine and unreviewed by the owner | owner | phase report |
| s1c-12 | Red-first of `T-A-030` to `T-A-032` was reproduced by moving the sources away, not observed assertion by assertion (section 1) | n/a | recorded |
| s1c-13 | `.vitest/` (the default output directory of `vitest --reporter=json`) is not in `.gitignore`, and one such report of mine was swept into the snapshot commit `d2699d2` as `apps/server/.vitest/json/output.json`; it contained literal ports and turned check 5 of `repo-conventions` red in a clean copy. I deleted the file (the working tree shows it as deleted; the next snapshot records that). S0 should add `.vitest/` to `.gitignore`; other workers should pass `--outputFile` when they use the JSON reporter | S0, orchestrator | next snapshot |

Gotchas found on the way, for the other S1 tasks:

- 11. `local/no-string-built-sql` flags `someRegExp.exec(text)` on any receiver that is not a regular expression literal (it takes `exec` for a database call). Use `.test()` and `split`, or a literal receiver. The rule cannot be switched off (G0 defect D1).
- 12. `shared/single-implementation.test.ts` fails on a function or class declared in `apps/server/src` whose name contains `permission`/`Permission` (FR-A-008): hence `frozenSetOf` and `FrozenSet`, not `frozenPermissionSet`.
- 13. A guard that wraps another guard (`originAndCsrfGuard` calls two) must put the inner response in place itself: Hono takes a response from the return value of the outermost handler only, so `await next()` of the inner guard silently drops a returned `Response` ("Context is not finalized", a 500). The code and its test do this now.
- 14. Hono's `c.res = response` copies every header of the old response onto the new one (except `Content-Type`), so a stale `Content-Length` or `Content-Encoding` survives a swap. `replaceResponse` (in `cache-headers.ts`) sets the headers to exactly those of the new response and keeps every `Set-Cookie`; the sessions of Phase B depend on that. When the context has no response yet, `c.res` becomes the new response itself and shares its headers, which `replaceResponse` accounts for.
- 15. `@hono/node-server` replaces the global `Request` and `Response` the first time `getRequestListener` runs (`overrideGlobalObjects`), so every in-process test after the first `listen()` in a worker uses its classes. Both paths are exercised by this chunk's tests.
- 16. `new Request(url, { headers: { host } })` keeps the `Host` header (unlike a browser), a header value is trimmed by `Headers`, and a value outside Latin-1 throws: the preview matrix has no leading-space or full-width host for that reason.

## 7. Risks

- **R1. Buffered bodies.** `bodyLimit` reads a body up to its limit before authorisation, so that the guard order holds for chunked bodies. An unauthenticated client can make the server hold up to 9 MiB (import), 2 MiB (upload) or 256 KiB (JSON) per request, for at most the 60 s request timeout, limited by the `upload` and `write` buckets per client address (burst of 3 and 10). Many addresses multiply it. The memory held equals the bytes the attacker sent. A global budget (refuse with 503 above N bytes in flight) is the remedy if it matters; it is s1c-9.
- **R2. Compression buffers the response.** `compress` reads a compressible body whole; the largest is the branding export (about 8 MiB of base64). Brotli runs on the libuv pool, not on the event loop.
- **R3. Rate limiter memory and sweeps.** 10,000 buckets of three numbers is small. A flood of distinct client keys with no idle bucket makes each insertion drop the oldest bucket in constant time (the `noIdleBefore` bound); the full sweep runs when a bucket may have become idle. The worst case is a sweep of 10,000 entries per insertion.
- **R4. Keying on an IPv6 /64.** Clients behind one /64 (some mobile carriers and hosting networks) share a bucket; that is the price of not letting one subscriber rotate through its prefix.
- **R5. `TRUST_PROXY` mis-set** still decides everything the limiter and the preview rule know about the client (s1b risk); nothing in this chunk changes that.
- **R6. Preview mode's `Host` rule is not a boundary.** A non-browser client can write any `Host`. `docs/security.md`, the README and the phase report say so (FR-A-036); the boundary is publishing the port on loopback.
- **R7. Not verified in a real browser.** No Chromium run was made for this chunk: the CSRF flow, `Sec-Fetch-Site` values and compression are asserted with in-process requests and `node:http`/`fetch` over a socket. `T-A-322` (e2e) is the control for a browser.
