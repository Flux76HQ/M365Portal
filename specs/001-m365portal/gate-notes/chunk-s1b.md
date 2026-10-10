# Chunk note s1b (T-A-025 to T-A-028): open points, assumptions, risks

Written by the `s1b` worker for S8's consolidation (`T-A-278`). This chunk has no gate task (G1 is `T-A-046`), so this note is the whole record: what was done, what evidence exists, what the next S1 tasks must know, and what was not verified.

The chunk was interrupted by a usage limit and resumed. The first run left `T-A-025` to `T-A-027` complete (sources and tests) and the two test files of `T-A-028` written without their sources; a snapshot commit (`06f9e50`) holds that state. This run re-verified all four tasks, finished `T-A-028`, and ran a mutation pass over all four (section 3).

## 1. Tasks and evidence

| Task | Files (all in S1's territory) | Tests (live tree, single worker) |
|---|---|---|
| T-A-025 configuration | `apps/server/src/config/{env,load,posture,index}.ts`, `apps/server/test/config.test.ts`; `src/listen.ts` and `test/listen.test.ts` are gone (replaced) | `config.test.ts` 306 |
| T-A-026 request context, trust proxy | `apps/server/src/http/{request-context,trust-proxy,client-key}.ts`, `test/trust-proxy.test.ts`, `test/api-conventions.test.ts` (request id part) | 108 and 47 |
| T-A-027 problems, error handler, SQLite mapping | `apps/server/src/http/{problem,error-handler}.ts`, `src/db/errors.ts`, `test/problem.test.ts`, `test/no-leak.test.ts` | 168 and 26 |
| T-A-028 security headers | `apps/server/src/http/{security-headers,csp,permissions-policy,hsts}.ts`, `test/security-headers.test.ts`, `test/hsts.test.ts` | 124 and 79 |
| Total | | 858 of the 922 in the server package (the other 64 are `helpers`, `app` and `version`) |

Skipped, todo or only: none. No test was weakened; this run only added tests and one source simplification (section 3, item 2).

Red first. For `T-A-028` it was observed in this run: both test files failed at load with `Cannot find module '../src/http/hsts.js'` and `'../src/http/csp.js'`, then 201 tests passed once the four modules existed. For `T-A-025` to `T-A-027` the red state happened in the interrupted run and could not be observed again (the sources were already in the snapshot). The mutation pass is the substitute evidence that those tests fail when the code is wrong.

Done-when checks, each by a command:

- `T-A-025`: `EnvSchema`, `ENV_VARIABLES` and `ENV_VARIABLE_NAMES`, `readPosture`, `isLoopbackHost`, `normalizeHost` exist and are tested; the process spawned with `PORT` and `HSTS_MAX_AGE` set to a canary exits 1 before listening and its stderr holds names and fixed messages only (`config.test.ts`, "refuses to start in a process of its own").
- `T-A-026`: `X-Request-Id` is on every response type including a plain `Response`, an immutable `Response.redirect`, a guard's early response, the 404 and the error response (`api-conventions.test.ts`).
- `T-A-027`: an unhandled error is a generic 500 `internal_error` with a request id; the canary thrown as message, cause (an `Error`, plain data and text), name, code, own properties and non-`Error` values appears in neither response nor log (`no-leak.test.ts`, 14 routes).
- `T-A-028`: every response type of the fixture app (JSON, HTML, HEAD, offline page, `/sw.js`, script, style, image, robots, redirect, immutable redirect, 404, 405, 413, 429, two 500s, handlers that set forbidden headers, a page that sets its own security headers, CORS preflight, `OPTIONS`) is run through the headers guard over http and over https. HSTS is asserted in both directions (section 4 of this note lists the table).

## 2. Where it was run

| Where | Commands | Result |
|---|---|---|
| Live tree | `tsc -p apps/server`, `eslint src test --max-warnings 0`, `prettier --check apps/server/src apps/server/test`, `vitest run` (server, one worker) | all green, 922 tests in 10 files |
| Live tree | `packages/shared`: `repo-conventions`, `single-implementation`, `exports`, `guard-helper` | green (511 tests). The first run of `repo-conventions` was red: check 5 found the literal port `8080` in a comment at `env.ts:81` (FR-A-016); fixed, the comment now uses another port |
| Clean copy (`git ls-files -co --exclude-standard`, `pnpm install --frozen-lockfile` under the lock: exit 0) | server `typecheck`, `lint`, `test` (922), `build`; shared `repo-conventions`, `single-implementation`, `exports`, `guard-helper` (511); root `tools/workspace-deps` (31); `prettier --check apps/server` | all exit 0 |
| Chromium 141.0.7390.37 (Playwright's, a scratch script, not a project test) | the real `securityHeaders` pipeline behind a Node `http` server | see section 5 |

Not run: web package, root `pnpm test`, e2e, `routes:check` (outside this territory). Nothing here calls a Microsoft API.

Re-run recipe:

```text
pnpm --filter @m365portal/server exec vitest run test/config.test.ts test/trust-proxy.test.ts test/api-conventions.test.ts test/problem.test.ts test/no-leak.test.ts test/security-headers.test.ts test/hsts.test.ts
```

## 3. Mutation pass

Method: a copy of `apps/server` in the scratchpad (the real `node_modules` linked), one edit per run, only the test files that guard the edited file, a green baseline first, and a mutant counts as killed only when the run exits non-zero with failed tests or failed suites. First pass: 245 mutants (T-A-025: 59, T-A-026: 45, T-A-027: 77, T-A-028: 64). 221 were killed at once. The 24 survivors were each looked at:

1. **Real gaps in the tests, closed with new tests (16).** A zone id in a bracketed `Host` (`[fe80::1%25eth0]`), the 63 and 253 character limits of a name, replacement of a message that is not ours in `loadConfig`, the RFC 5952 rule that `::` never stands for one group, each of the five zero groups of the IPv4-mapped form, `X-Request-Id` on a plain `Response`, an immutable redirect and a guard's response (a mutant that wrote the header before `next()` survived), the direct `errors[]` cap, a registry code that is not a validation code must not be promoted, the 64/65 character boundary of an error code, the 86,400 s boundary of `Retry-After`, a request id in the context that the schema refuses, a canary in a `cause` that is plain data (an `Error` as cause stringifies to `{}`, so the first canary could not show a leak), the 30 frame cap, and a message that names a SQLite code is not a code.
2. **Redundant code, removed (2).** The special case that rewrote an IPv4-mapped IPv6 range of `TRUST_PROXY` (`::ffff:10.0.0.0/104`) into an IPv4 range was unobservable: Node's block list matches the IPv4 address against the mapped range by itself. Five test cases (`/104`, `/105`, `/96`, an address outside, and a `/112` IPv6 range that only looks similar) now pin that behaviour, and the special case is deleted.
3. **Equivalent mutants (5).** `PRINTABLE_ASCII` widened (the DNS label class still refuses non-ASCII); three branches of `normalizeIp` that `isIP` makes unreachable (an IPv4 tail above 255, a second `::`, an empty `::`); the nonce handed to `headersForProfile` for profiles that ignore it.
4. **An invalid mutant (1).** My first "shared nonce" edit only added an unused variable; the two proper versions (nonce kept across requests, nonce redrawn on every call) are killed.

Every survivor that can be killed (the 17 with a fix or a proper mutant) was re-run after its fix and is killed; the 5 equivalents cannot be, and the 2 removed lines no longer exist. A second full pass over the final tree was started and stopped after 15 mutants (all killed) to leave the four shared CPUs to the other streams; the re-runs above are the evidence for the rest.

## 4. Interfaces the next S1 tasks use

Pipeline order that the tests use and that `T-A-045` should keep (plan 7.2): `requestContext({ config })`, `securityHeaders({ config })`, `rejectOptions(allowFor?)`, `errorBoundary(handler)`, then `app.onError(handler)` and `app.notFound(notFoundHandler)`. `securityHeaders` must wrap the error boundary or the responses it produces lose their headers; `requestContext` is outermost so the id exists for every body.

- `config`: `loadConfig(env)` (never throws; `{ ok, config }` or `{ ok: false, issues }`), `loadConfigOrThrow`, `formatConfigIssues`, `ConfigError`, `EnvSchema`, `ENV_VARIABLES` (name and default text, for `deploy-files.test.ts`), `ENV_VARIABLE_NAMES`, `ENV_MESSAGES`, `readPosture(config)` (`preview`, `trustProxy`, `hsts`, `showcase` as modes, no values), `isLoopbackHost`, `normalizeHost`. `AppConfig` is deep-frozen: `port`, `host`, `dataDir`, `publicOrigin`, `publicHost`, `publicIsHttps`, `trustProxy`, `previewMode`, `previewModeAllowRemote`, `showcase`, `logLevel`, `hsts { maxAgeSeconds, includeSubDomains, preload }`.
- `http/request-context`: sets `requestId`, `client { address, key }`, `scheme`, `startedAtMs`, writes `X-Request-Id` after the handler; `setResponseHeaders(c, headers)` (a value of `undefined` removes a header; it rewraps a finished response, so an immutable `Response.redirect` is fine); `resolveRequestId`, `peerAddressOf`.
- `http/trust-proxy`, `http/client-key`: `createForwardingResolver`, `effectiveScheme`, `requestHost(request)` (the one `Host` normaliser for HSTS and the preview rule), `normalizeIp`, `clientKeyOf` (IPv4 or IPv6 /64, `UNKNOWN_CLIENT_KEY`).
- `http/problem`: `problemResponse(c, code, details?)` (typed: a code that needs `expectedOrigin`, `allow` or `retryAfterSeconds` cannot be raised without it), `problemResponseFor`, `ProblemError`, `describeProblem`, `buildProblem`, `validationProblemResponse` (the `defaultHook` of the validators, takes `{ target, error }`), `RETRY_AFTER_SECONDS` (`storage_busy` 1, `shutting_down` 5: closes s1a-6), `MAX_FIELD_ERRORS` (50).
- `http/error-handler`: `createErrorHandler({ log, onStorageFailure? })` (the logger needs `error(fields, message)` and `warn(fields, message)`, the pino shape; `onStorageFailure` is how readiness hears of `corrupt`), `errorBoundary`, `notFoundHandler`, `describeError`. `db/errors`: `classifyStorageError(error)` gives `{ kind: 'unavailable' | 'busy' | 'corrupt', code }`, looks through `cause`, never reads a message.
- `http/security-headers`: `securityHeaders({ config })`, `rejectOptions(allowFor?)`, `profileOf(path, contentType)`, `headersForProfile`. It sets `c.get('nonce')()` (drawn on first use, one value per request). `http/csp`: `buildCsp({ nonce, https })`, `createNonce`, `WORKER_CSP`, `OTHER_CSP`. `http/permissions-policy`: `FEATURE_POLICY`, `DISABLED_FEATURES`. `http/hsts`: `hstsHeaderValue({ config, https, host })`.

The HSTS table in `hsts.test.ts` (both directions, 80 rows plus the pipeline cases): https gives plain `max-age=<HSTS_MAX_AGE>` on every host, including an alias, an IP address, `localhost.`, a malformed `Host` and a missing one; `includeSubDomains` only with `HSTS_INCLUDE_SUBDOMAINS=true` and only when the normalised `Host` equals the host of `PUBLIC_BASE_URL` (upper case, a trailing dot and a port are normalised); `preload` only with its flag, `includeSubDomains` and a year of `max-age` on that same host; nothing over http, not even with every opt-in, and not for a forged `X-Forwarded-Proto` from an untrusted peer. Eight wrong implementations (always `includeSubDomains`, always `includeSubDomains` and preload, ignores the host, compares the raw `Host`, drops the header for other hosts, sends it over http, sends none without a `Host`, ignores `HSTS_MAX_AGE`) fail the table on purpose.

## 5. Chromium check of the headers (evidence, not a project test)

A scratch script served a page through the real pipeline and drove Playwright's Chromium 141.0.7390.37 (the version of plan Appendix A). Results: the page loaded (200), the nonce-carrying inline script ran and no violation was reported for the nonce `<style>`; the service worker registered through `trustedTypes.createPolicy('m365portal-sw', ...)` under the worker profile; after the reload the worker controlled the page and the page loaded again (200) and a `fetch` through the worker answered 200 (plan V-04 holds with the implemented headers); `Permissions-Policy` has 46 entries (45 disabled features and `clipboard-write=(self)`) and **no console message mentioned it**; a second Trusted Types policy and an `innerHTML` assignment were refused, which is the policy working. The only console errors and violation events were those two deliberate probes. Firefox and Safari were not run.

## 6. Open points

| # | Point | Owner | When |
|---|---|---|---|
| s1b-1 | `VERSION` bump is needed at commit time (protected paths `apps/server/src/**`, `apps/server/test/**`) | orchestrator | commit |
| s1b-2 | `zod` 4.6.5 is a runtime dependency of the server (it was added to `apps/server/package.json` and the catalog in the interrupted run); it needs its reason row in `docs/architecture.md` (plan 5.3, "external in the bundle so there is one instance"). No dependency was added in this run | S8 | `T-A-274` |
| s1b-3 | `T-A-040` must give `rejectOptions` the route table's method list, so `Allow` on an `OPTIONS` answer is the real one; without it the answer is `GET, HEAD` for every path | S1 | `T-A-040` |
| s1b-4 | `T-A-043`: a page that renders the shell calls `c.get('nonce')()` exactly once per request and uses that value in the template (C8); an HTML response that never asks (the offline page) gets the policy without nonce tokens. `/sw.js` is the worker profile by path alone, whatever its `Content-Type`; a path `/sw.js/` or `/sw.js.map` is `other` | S1 | `T-A-043` |
| s1b-5 | `T-A-029`: the logger passed to `createErrorHandler` needs the pino call shape (`error(fields, message)`, `warn(fields, message)`); the test helper `capture-logger.ts` has the same shape. Whether pino accepts `LogCapture` as destination (s1a-10) is still unverified | S1 | `T-A-029` |
| s1b-6 | `T-A-044` wires `onStorageFailure` to the readiness state (`corrupt` gives `database_corrupt`) | S1 | `T-A-044` |
| s1b-7 | `docs/security.md` has to state: the three header profiles and why `/sw.js` has its own (V-04); the HSTS rules (plain on every https host, flags only on the declared host, why); the Permissions-Policy source and that Firefox and Safari are not verified; that the one documented exception to FR-A-040 is the response Node writes itself (`T-A-031`); that `TRUST_PROXY` must be set when TLS ends at a proxy and `PUBLIC_BASE_URL` is http, or no HSTS is sent; the preview rule (`T-A-033`) | S8 | `T-A-275` |
| s1b-8 | `.env.example` and `docs/operations.md` must say that `HSTS_INCLUDE_SUBDOMAINS` and `HSTS_PRELOAD` apply to the host of `PUBLIC_BASE_URL` only, and that `HSTS_PRELOAD=true` is refused at start without `HSTS_INCLUDE_SUBDOMAINS=true` and a `HSTS_MAX_AGE` of at least 31,536,000. `deploy-files.test.ts` compares the variable list with `ENV_VARIABLES` (TA-06) | S6, S8 | `T-A-230`, `T-A-277` |
| s1b-9 | Red-first for `T-A-025` to `T-A-027` was not observed again (section 1) | n/a | recorded |

## 7. Assumptions

- An empty value is invalid for every variable, not only `PORT` (FR-A-016 says so for `PORT`; the same rule everywhere keeps the schema uniform). An unset variable takes its default.
- `HOST` is a host name or an IP address; it is not resolved. An internationalised name has to be written as punycode (the host normaliser accepts printable ASCII only).
- A `PUBLIC_BASE_URL` with a trailing dot (`https://panel.example.com.`) is accepted and its host is stored without the dot, so `Host: panel.example.com.` and `Host: panel.example.com` are the same host for HSTS.
- The HSTS comparison ignores the port: the declared host with another port is still the declared host.
- A response is the html profile because its `Content-Type` is `text/html` (parameters and case ignored); the profile follows the response, so a 404 problem is always `other`.
- `Access-Control-*` is removed by prefix and `Server` and `X-Powered-By` by name from every response, whatever set them (FR-A-040, FR-A-047).
- `X-Request-Id` is written after the handler, so it replaces one that a handler set.
- `hstsHeaderValue` compares the host it is given as it is: the caller normalises with `requestHost`. This is deliberate and has a negative fixture (a rule that compares the raw `Host` fails the table).
- An unhandled error is logged by name, system code and stack frames only; the message and the `cause` are never logged, so an operator sees less than usual (FR-A-023 wins over convenience).
- The Dutch wording of configuration messages is not needed: they are English, fixed texts printed to stderr before the server starts.

## 8. Risks

- **Response rewrapping.** `setResponseHeaders` rewraps a finished response through `c.header` so that immutable responses can be changed. That is Hono 4.13 behaviour covered by the immutable-redirect cases; a Hono upgrade is covered by the same tests.
- **Headers after `next()`.** The security headers are written on the response that comes back. A response written straight to the Node socket (`c.env.outgoing`) would bypass them; nothing in Phase A does that.
- **Node block-list behaviour.** IPv4-mapped IPv6 ranges in `TRUST_PROXY` rely on Node matching IPv4 peers against them. The test cases pin it; a Node upgrade that changes it turns them red, and the special case can be put back.
- **`TRUST_PROXY=1` without a proxy.** A client that reaches the app directly can then choose its own address and scheme. The default is `none`; `docs/security.md` has to say so (s1b-7).
- **`style-src` without `unsafe-inline`** blocks inline style attributes (BC-06). The Chromium check ran a nonce `<style>` only; the e2e fixture (`T-A-322`) is the control for the real shell and for every library.
- **Spoofed `Host` over a socket.** `fetch` cannot set `Host`, so the HSTS and preview matrices run in process (s1a-11); the Chromium check used a real socket but only the default host.
