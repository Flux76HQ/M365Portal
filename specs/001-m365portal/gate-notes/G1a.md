# Gate note G1a (T-A-020 to T-A-024): the shared contract of stream S1

**Date**: 2026-10-10. **Written by**: the `s1a` worker (S1 shared contract). **Gate**: G1a freezes `PERMISSIONS`, `LIMITS`, the problem registry and its messages, the common, health and meta schemas, and the server test helpers, for S2, S4, S6 and S8 (tasks.md section 2.2).

## 1. Verdict

All five tasks are done and verified by running commands, in the live tree and again in a clean copy (section 6). No test was skipped, weakened or left red. Two things are for the orchestrator to look at (section 7, points 1 and 2): the dependency change and the `pnpm-workspace.yaml` comments.

## 2. Tasks done, with evidence

| Task | Red first (reason) | Green | Negative fixture / mutation proof |
|---|---|---|---|
| T-A-020 permissions | `permissions.test.ts` failed at load: `PERMISSIONS` is not exported by the `export {};` stub | 46 tests | `assertBriefCatalogue` + 5 `expectGuardFails` fixtures (extra, missing, duplicated, reversed, upper case); 7 mutants (swap, add `users:write`, drop `rbac:manage`, not frozen, empty `anyOf` allowed, `every` for `some`, case-insensitive schema) all red |
| T-A-021 limits | `limits.test.ts` failed at load: `LIMITS` undefined | 23 tests | `assertSpecTable` + 6 `expectGuardFails` fixtures (wrong value, missing row, missing row in a group, extra row, slower rate class, string value); 7 mutants (import limit 8,454,148, write refill, extra constant, fractional value, not frozen, staging quota 33, SVG cap 10,000) all red |
| T-A-023 schemas (done before T-A-022, which imports `RequestIdSchema` and `OriginSchema` from it) | `schemas-common.test.ts`: 157 of 167 tests failed because every schema was `undefined`; later 20 more for `OriginSchema` | 187 tests | `assertNoTransform` + 3 fixtures; 13 mutants: 12 red (accent 8 digits, SHA upper case, request id 7, timestamp without ms / with offset, readyz completeness, readyz status consistency, check code optional, loose healthz, duplicate permissions, any-string origin, a smuggled `.transform`) and 1 equivalent survivor (see below), whose two stronger variants are red |
| T-A-022 problem registry | `error-codes.test.ts` failed at load: `PROBLEM_CODES` undefined | 157 tests | `assertGenericEnglish` + 12 sensitive samples, `assertFragmentMatchesRegistry` + 9 fixtures (missing code, extra key, empty, non-text, padding, markup, missing and stray placeholder, unsorted); 14 mutants (status changes, code removed or added, sensitive detail, unknown code not mapped, prototype lookup, wrong URN, `expectedOrigin` anywhere, loose object, 4 fragment edits) all red |
| T-A-024 server helpers | `helpers.test.ts` failed at load: `Cannot find module './helpers/fake-clock.js'` | 55 tests | 34 mutants of the helpers (clock, temp dirs, unwritable path, log capture, client, harness): 33 red, 1 equivalent (section 5, point 9) |

Mutation method: a copy of each package in the scratchpad, one edit per run, one test file per run, with a green baseline per package first. A first pass was thrown away because the copy lacked `tsconfig.base.json` and every run was red for that reason; the second pass requires `Tests N failed` in the output. Three mutants that failed to compile (a syntax error of mine) were rewritten and rerun. Surviving mutants and what was done: `AccentInputSchema` had its message code twice (on `z.string` and on `.regex`), so removing only the second changed nothing; removing the first, and both, is red (equivalent mutant, code kept). Two survivors showed real gaps in the test and were closed before this note: the loopback-only binding of `listen()` and the aliasing of `Date` objects handed out by `FakeClock.now()`.

## 3. Frozen interfaces

Import paths are `@m365portal/shared/<module>` (permissions, limits, problem, schemas/common, schemas/health, schemas/meta, testing) and, for the helpers, relative paths inside `apps/server/test/`.

### C1 `permissions`
- `PERMISSIONS`: frozen readonly tuple of the 15 permissions of brief 2a, in the brief order. `Permission`: the union. `PermissionSchema` (`z.enum`, id `Permission`, case-sensitive).
- `hasAnyPermission(held: ReadonlySet<Permission> | readonly Permission[], anyOf: readonly Permission[]): boolean`. **Deny by default**: an empty `held` is false, and an **empty `anyOf` is false** ("any of nothing"). A caller with no requirement (a public page, a command without `anyOf`) must say so itself and not call this function with `[]`. S4 (`requirePermission`, `visibleCommands`) must read this.

### C3 `limits`
- `DEFAULT_PORT = 8080` (unchanged). `LIMITS` is deep-frozen, every leaf a safe integer, the unit in the name:

| Path | Value |
|---|---|
| `body.jsonBytes`, `body.logoFileBytes`, `body.uploadRequestBytes`, `body.importRequestBytes` | 262,144; 2,097,152; 2,162,688; 9,437,184 |
| `image.inputPixels`, `image.svgElements`, `image.svgDepth`, `image.svgExpandedInstances` | 16,777,216; 10,000; 64; 100,000 |
| `image.logoMasterPx`, `image.compactMasterPx`, `image.concurrentJobs`, `image.queuedJobs`, `image.jobTimeBudgetMs` | 512; 128; 2; 4; 10,000 |
| `staging.quotaFiles`, `staging.quotaBytes`, `staging.retentionMs` | 32; 33,554,432; 86,400,000 |
| `http.headerBytes`, `http.headersTimeoutMs`, `http.requestTimeoutMs`, `http.keepAliveTimeoutMs` | 16,384; 15,000; 60,000; 65,000 |
| `rateLimit.read`, `.write`, `.upload` | `{ capacity, refillIntervalMs }` = 120 and 500; 10 and 2,000; 3 and 10,000 |
| `trackedClients`, `csrfTokenLifetimeMs`, `preMigrationBackupsKept`, `shutdownDrainMs`, `auditDetailBytes` | 10,000; 28,800,000; 3; 10,000; 4,096 |
| `orgName.maxGraphemes`, `orgName.maxBytes`, `hstsMaxAgeSeconds`, `imageSizeCeilingMegabytes` | 64; 256; 31,536,000; 400 |

- `RateLimitClass` (`'read' | 'write' | 'upload'`) and `refillPerSecond(rateClass)` (2, 0.5, 0.1 exactly). The task text says "all values are safe integers", and 0.5 and 0.1 per second are not, so a rate is stored as the time to earn one token.
- `LIMITS` contains exactly the rows of spec 6.5 and nothing else (a test fails on an extra constant). S8's `limits-doc.test.ts` can walk the object.

### C2 `problem`
- `PROBLEM_CODES`: deep-frozen, 31 codes, each `{ status, title, detail }` (English, generic, never sensitive; `origin_not_allowed` names `PUBLIC_BASE_URL`). Types `ProblemCode`, `ProblemStatus`, `ProblemMessageKey` (`problem.${ProblemCode}` or `problem.unknown`). `PROBLEM_TYPE_PREFIX`.
- `isProblemCode(value)`, `problemType(code)` (`urn:m365portal:problem:<code>`), `problemMessageKey(code: string)` (unknown, empty and prototype names such as `constructor` give `problem.unknown`).
- `ProblemCodeSchema` (enum of the registry), `ProblemFieldErrorSchema` (`{ pointer, code }`; pointer is `""`, `/json/pointer`, `query/<name>` or `header/<name>`), `ProblemSchema` (strict: `type`, `title`, `status`, `detail`, optional `instance`, `code`, `requestId`, optional `errors[]`, optional `expectedOrigin` for `origin_not_allowed` only). `Problem`, `ProblemFieldError` types.
- `ProblemSchema.code` is a lower-case word string, **not** limited to the registry, so a client can read a problem from a newer server; for a known code the `status` must be the registry's, and `type` must be the URN of `code`.
- Fragments `packages/shared/src/i18n/fragments/problem.{en,nl}.json`: 32 flat keys each (`problem.<code>` for the 31 codes and `problem.unknown`), sorted with the default `Array.prototype.sort`, all Latin script. Placeholders: `{origin}` in `origin_not_allowed`; `{seconds}` in `rate_limited` and `image_processing_busy` (written as "{seconds} s", so no plural forms are needed); `{code}` and `{requestId}` in `problem.unknown` (FR-A-112, E-20). No message contains a number from the limits table.

### Schemas (`schemas/common`, `schemas/health`, `schemas/meta`)
- `common`: `Sha256HexSchema`, `HexColorSchema` (lower-case `#rrggbb`), `AccentInputSchema` (every failure has the message `accent_invalid`; returns its input unchanged), `IsoTimestampSchema` (`z.iso.datetime({ precision: 3 })`), `RequestIdSchema`, and **one extra**, `OriginSchema` (serialised http or https origin; used by `MeResponse.publicOrigin` and `Problem.expectedOrigin`).
- `health`: `HealthzResponseSchema`, `ReadinessCheckSchema` (a failing check has exactly one failure code, a passing check has none), `ReadyzResponseSchema` (the three checks `data_dir`, `database`, `schema` each exactly once; `status` is `ready` exactly when every check passes), plus the constants `READINESS_CHECK_NAMES`, `READINESS_FAILURE_CODES` and their types.
- `meta`: `ActorSummarySchema`, `FeaturesSchema`, `MeResponseSchema` (permissions listed once each), `CsrfResponseSchema` (token opaque: 1 to 512 characters of `[A-Za-z0-9._-]`).
- All response schemas are `z.strictObject`; every exported schema has `.meta({ id })` equal to its name without `Schema`; no transform, pipe or coercion (checked by `z.toJSONSchema` in both directions and by a source guard).

### Server test helpers (`apps/server/test/helpers/`)
- `createFakeClock(start?)` / `FakeClock`: `now(): Date` (a new Date each call), `nowMs()`, `iso()`, `set(instant)`, `advance(ms)`, `stepBack(ms)`. `advance` and `stepBack` refuse negative and non-finite steps. Default start `2026-10-10T12:00:00.000Z` (`FAKE_CLOCK_START`).
- `createTempDataDir(prefix?)` -> `{ path, remove() }` (0700, below `os.tmpdir()`, removed when the current test ends, also by `remove()`); `withTempDataDir(fn)`; `afterCurrentTest(fn)` (Vitest `onTestFinished`, a no-op outside a test).
- `unwritableDataDir()` -> `{ path, remove() }`: a path below a regular file, so creating anything there fails with `ENOTDIR` even for root.
- `createLogCapture()` -> `LogCapture` (a `Writable`; usable as the destination of a logger): `lines()` (complete lines parsed as JSON objects, throws naming the line for a non-JSON line), `text()`, `clear()`.
- `createHttpClient({ fetch, baseUrl, origin, headers? })` / `HttpClient`: `get/post/put/patch/delete/request`, `csrfToken({ refresh? })`. Writes carry `Origin` and an `X-CSRF-Token` fetched from `GET /api/v1/csrf` (validated with `CsrfResponseSchema`, fetched once, kept). Per request: `json`, `body`, `headers`, `origin` (string or `null`), `csrf` (`'auto' | 'none' | { token }`), `host` (string or `null`). Never retries. `readJson(response)`.
- `createTestApp({ buildApp, stop?, env?, publicOrigin?, clock?, dataDir? })` -> `TestApp` = context (`dataDir`, `clock`, `logs`, `env`, `publicOrigin`) + `app`, `client` (in process), `clientFor({ headers?, peer? })`, `listen({ serverOptions? })` (real HTTP on `127.0.0.1`, port 0; returns `{ origin, port, server, client, close() }`), `close()`. `buildApp(context)` may be asynchronous and may return any object with `fetch(request, env?)`. `env` defaults: `DATA_DIR`, `PUBLIC_BASE_URL`, `HOST`. `publicOrigin` defaults to `http://localhost:<DEFAULT_PORT>`.

## 4. Test counts

| File | Tests |
|---|---|
| `packages/shared/test/permissions.test.ts` | 46 |
| `packages/shared/test/limits.test.ts` | 23 |
| `packages/shared/test/error-codes.test.ts` | 157 |
| `packages/shared/test/schemas-common.test.ts` | 187 |
| `apps/server/test/helpers.test.ts` | 55 |
| Total new | 468 |

Skipped, todo or only: none.

## 5. Assumptions

1. **`hasAnyPermission` with an empty `anyOf` is false** (section 3). The task text says "truth table including the empty set" without saying which; deny by default was chosen.
2. **`LIMITS` is nested and stores rates as an interval** (section 3), because "all values are safe integers" and the spec's 0.5 and 0.1 per second cannot both hold otherwise.
3. **`problem.unknown` takes `{code}` and `{requestId}`.** FR-A-112 asks for "a generic message with the code and request id" and the task lists placeholders for 31 codes only.
4. **`ProblemSchema.code` is lenient** (an unknown code from a newer server still parses) while `ProblemCodeSchema` is strict.
5. **`ReadyzResponseSchema` requires all three checks.** The contract example always lists all three, also in failure.
6. **No pairing of check name and failure code** (for example `database` with `database_corrupt`): the lifecycle task (T-A-04x) decides which check reports which code. `READINESS_FAILURE_CODES` is the allowed set.
7. **`MeResponseSchema` checks shape only**, not that `anonymous` has no permissions or that `features.preview` follows the actor kind. Those are policy facts, tested by T-A-033 and T-A-042.
8. **The peer of an in-process request** is simulated through the second argument of `fetch` in the shape `@hono/node-server`'s `getConnInfo` reads (`env.incoming.socket.remoteAddress`). If T-A-026 reads the peer another way, `peerBindings` in `test-app.ts` changes (S1 owns both).
9. **Equivalent mutant**: `createTestApp` writes `options.dataDir ?? ownDirectory?.path`; swapping the operands is unobservable because `ownDirectory` exists only when `options.dataDir` is undefined.
10. The registry's `detail` and `title` strings, the Dutch and English messages and the wording of the remedies are my text; the owner has not reviewed the Dutch.

## 6. What was run, and where

| Where | Commands | Result |
|---|---|---|
| Live tree | the five test files above; `eslint --max-warnings 0` on every file of this chunk; `prettier --check`; `tsc -p` of shared and server; `vitest run` of `repo-conventions`, `single-implementation`, `exports`, `guard-helper`, `index` (513 tests); `tools/workspace-deps` (31 tests) | all green |
| Clean copy (`git ls-files -co --exclude-standard`, `pnpm install --frozen-lockfile` against the changed lockfile: exit 0) | shared: the five S0 test files plus mine, 9 files, 925 tests (at that time `permissions` had 45); server: `test` 87 tests in 4 files; `typecheck`, `lint` and `build` of server; `typecheck` and `lint` of shared | all exit 0 |

Not run: `pnpm build`/`lint`/`typecheck` for the web package, root `pnpm test`, e2e, `routes:check` (outside this territory). Nothing here calls a Microsoft API.

Re-run recipe:

```text
pnpm --filter @m365portal/shared exec vitest run test/permissions.test.ts test/limits.test.ts test/error-codes.test.ts test/schemas-common.test.ts
pnpm --filter @m365portal/server exec vitest run test/helpers.test.ts
```

## 7. Open points and decisions for the orchestrator

1. **Dependency.** `zod@4.6.5` was added to `@m365portal/shared` (`dependencies`, `catalog:`) through the install protocol; lockfile and catalog gained only the zod entries (`git diff pnpm-lock.yaml pnpm-workspace.yaml`). `docs/architecture.md` needs its reason row (plan 5.2 has the text); the server will list `zod` as an external dependency itself when its own code imports it (plan 4.3).
2. **`pnpm add` drops the comments of `pnpm-workspace.yaml` and re-quotes one key.** Inside the same lock I restored the file from the version before the add and inserted only `  zod: 4.6.5` into the catalog. `git diff pnpm-workspace.yaml` must show that one line and nothing else; if another stream ran `pnpm add` afterwards and the comments are gone again, restore them as `tools/INSTALL-PROTOCOL.md` says. pnpm also wrote the new `dependencies` block of `packages/shared/package.json` after `devDependencies`; cosmetic, not hand-edited because of the protocol.
3. **VERSION.** The files of this chunk are protected paths (`packages/`, `apps/`), so the pre-commit hook will ask for the bump at commit time (G0 note, decision 1). I did not touch `VERSION`.
4. **No production `Clock` type exists yet.** `FakeClock` offers `now(): Date`, `nowMs()` and `iso()`. The first task that needs an injected clock in `src` (T-A-030, T-A-034) defines the interface; if it needs another shape, change `fake-clock.ts` in the same commit (S1 owns both).
5. **`Host` over a real socket.** `fetch` (undici) ignores a `Host` header set by the caller, so `listen()` clients cannot spoof `Host`. The preview-mode and HSTS matrices (T-A-028, T-A-033) run in process, where the client sets `Host` freely. A test that needs a spoofed `Host` on a socket must use `node:http`.
6. **`LIMITS` is frozen.** A test that wants a shorter timeout or a smaller body limit cannot change it; the code under test (T-A-030, T-A-031, T-A-0xx) must take its limits as parameters with `LIMITS` as the default. Planned for those tasks, noted here so the design does not discover it late.
7. **`error-codes.test.ts` reads two documents**: `specs/001-m365portal/contracts/phase-a-api.md` section 6 and `spec.md` section 6.4 (it extracts the code and status of each row and expects 31). A reformatted table makes it fail on purpose, with the row count in the message. This is the control that the registry equals the documents (FR-A-022).
8. **For S4 (`i18n-fragments.test.ts`, translator, error boundary)**: keys are sorted with the default code-unit order; the translator must be given `{origin}`, `{seconds}`, `{code}`, `{requestId}` as listed above; a code the registry does not know must go through `problemMessageKey`, which returns `problem.unknown`.
9. **For S8**: `docs/permissions.md` must list the 15 names of `PERMISSIONS` (TA-02); `docs/operations.md` limits table is compared with the nested `LIMITS`; the contract's `retry-after` column (`storage_busy` 1, `shutting_down` 5) is **not** in the registry; T-A-027 owns those two numbers.
10. **Out-of-territory observation (not fixed)**: while this chunk was being written, `packages/shared/test/accent.property.test.ts` (S3, red first) made `tsc -p packages/shared` fail with TS2305 until S3 implemented `branding/accent.ts` and `contrast.ts`; at the end of this chunk the live `tsc` was green again.
11. **Not verified**: pino accepting `LogCapture` as its destination (pino is installed by T-A-029; any `Writable` is a documented destination); the shape of the real `buildApp(deps)` (T-A-045); that `Sec-Fetch-Site` is not needed by the client for the CSRF matrix (the helper omits it unless a test sets it as a header).

## 8. Risks

- **R1. Strict response schemas.** `ProblemSchema`, `MeResponseSchema`, `HealthzResponseSchema` and the rest reject unknown members on purpose (it is how tests show that no stack, SQL or path leaks). Phase B adds members to `MeResponse` (a user actor, roles); that is a schema change in the same commit as the server change, not a surprise.
- **R2. English-only checks on the Dutch text.** `error-codes.test.ts` rejects a few English and Dutch stop words and identical en/nl values; it cannot judge Dutch quality. The Dutch messages need the owner's review.
- **R3. Static messages and limits.** The messages avoid numbers from the limits table so they cannot drift; if a later message names a limit, it must take it as a placeholder.
- **R4. The helpers are tested by their own file only.** Their value is that every later server test passes through them; a defect shows up as many red tests elsewhere. The mutation proof in section 2 is the evidence that the helper tests notice a broken helper.
