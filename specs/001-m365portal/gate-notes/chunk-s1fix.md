# Chunk s1fix: fixes for the independent security review of the built server (stream S1)

Four findings, each test first, then the root cause.

## 1. Migration and foreign key check are atomic (`apps/server/src/db/migrate.ts`)

- Cause: the stock Drizzle migrator issues its own `BEGIN ... COMMIT`, so `PRAGMA foreign_key_check`
  could only run after the migration and its `__drizzle_migrations` row were committed. The next start
  saw a current schema and passed.
- Fix: `applyPending` no longer calls the stock migrator. With `foreign_keys = OFF` (outside any
  transaction, as stack-probe P12 requires) it opens ONE transaction, creates the bookkeeping table
  with the same DDL, runs the pending statements (`readMigrationFiles`, same hash and `created_at`),
  runs `foreign_key_check` INSIDE the transaction and commits only when it is empty. A violation rolls
  back migration, tables and rows; the error is still `migration_foreign_key_check_failed`, exit 1.
  A first install is rolled back to an empty database too.
- Tests (`test/migrations.test.ts`): synthetic migration `CREATE TABLE p; CREATE TABLE c REFERENCES p;
  INSERT INTO c VALUES (5)`: two consecutive starts both refuse, applied rows and tables unchanged,
  no open transaction, foreign keys back ON; same for a first install. The existing table-rebuild,
  upgrade, rollback and single-migrator-scan tests still pass.

## 2. `verify-audit` (`src/audit/chain.ts`, `src/cli.ts`)

- `ok` is now false when any append-only trigger is missing (it was `true` with `triggersMissing`
  non-empty). The CLI exit code follows `ok`.
- New optional `--expect-seq <n>` / `--expect-hash <64 hex>` (library: `expectSeq`, `expectHash`):
  the newest row must be that seq and hash, otherwise `{"ok":false,"anchorMismatch":true,...}`, exit 1.
- CAVEAT (for docs/security.md, the docs stream picks it up): the hash chain alone cannot detect rows
  deleted from the END of the log when the append-only triggers were dropped; nothing after the last row
  refers to it. Only a head recorded elsewhere detects it: use the `audit_head` log line (FR-A-074) or
  a value written down earlier as `--expect-seq` / `--expect-hash`. The anchor does not help against
  someone who recomputes the whole chain and also controls the place where the head was recorded. The
  caveat is in the CLI usage text (printed on a usage error), in the header comment of `cli.ts` and of
  `chain.ts`.
- Tests (`test/audit.test.ts`): updated expectations (ok false with missing triggers), library and CLI
  anchor tests (truncated tail detected, intact head passes), malformed `--expect-hash` is a usage error.

## 3. Parser-level errors (`src/http/client-error.ts`, installed in `src/start.ts`)

- A `clientError` listener answers 400 (malformed), 431 (headers or request target too large; the
  `HPE_HEADER_OVERFLOW` case) and 408 (request timeout) with `application/problem+json`, the `other`
  security-header profile (CSP, nosniff, CORP, Permissions-Policy, Referrer-Policy, X-Robots-Tag), no
  `Server`/`X-Powered-By`, `Cache-Control: no-store`, a fresh `X-Request-Id` (also in the body),
  `Content-Length` and `Connection: close`, then closes the socket. A socket that is not writable or
  already carries a response is destroyed. No HSTS (the scheme of an unparsed request is unknown).
- Tests: `test/body-limits.test.ts` (the old "documented exception" tests now assert the full profile
  for 400, 431 for headers and for the request target, and 408), `test/lifecycle.test.ts` (the started
  server has the handler).
- OPEN POINT (contract): `bad_request` (400), `request_header_fields_too_large` (431) and
  `request_timeout` (408) are NOT in the problem registry (31 codes, contract section 6, with
  `error-codes.test.ts` counting them and a catalogue message per code). I did not widen the registry;
  the body is shaped like a Problem (`type` `urn:m365portal:problem:<code>`, title, status, detail,
  code, requestId) and passes `ProblemSchema` because unknown codes skip the status check. If the
  orchestrator wants them registered, that is a contract amendment (registry, nl/en fragments,
  OpenAPI, spec 6.4).

## 4. Preview actor detection (`src/policy/resolvers.ts`, `src/config/posture.ts`)

- Any of `Forwarded`, `X-Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`, `CF-Connecting-IP`,
  `True-Client-IP`, `X-Client-IP`, `X-Envoy-External-Address`, `Fastly-Client-IP`,
  `X-Original-Forwarded-For` makes a loopback-Host request anonymous. Presence counts, case ignored.
  The statement that Host-based detection is not a security boundary stays, and is now also in the start
  warning (full header list, "any client that can reach the port can omit them").
- The posture line carries `previewBoundary: "host-detection-not-a-security-boundary"` when preview mode
  is on (absent when off, so the off-mode line is unchanged).
- Tests (`test/preview-mode.test.ts`): one case per header through `FORWARDING_HEADERS` (actor,
  `carriesForwardingHeader`, the guard fixtures); `via` and `x-forwarded` removed from the "resembles
  but is not" list. `test/logging.test.ts`: the posture field.
- Residual (unchanged by design): a non-browser client that is not behind a proxy can still send
  `Host: localhost` and no headers and be the preview actor. The boundary is publishing the port on
  loopback only.

## Not in scope, documented here for the docs stream

Anonymous denied writes are audited, so an unauthenticated client can make the audit table grow without
bound (disk fill). Not fixed in this chunk; the orchestrator documents it.

## Assumptions and risks

- `applyPending` re-implements the stock migrator's loop (about 20 lines) to get the in-transaction
  check. Bookkeeping DDL, `hash`, `created_at` and the "apply by position" rule are the ones the
  runner already verifies (`verifyApplied` after the fact, the checksum tests). If Drizzle changes its
  bookkeeping table, `verifyApplied` and the upgrade tests fail loudly.
- Files changed: `src/db/migrate.ts`, `src/cli.ts`, `src/audit/chain.ts`, `src/http/client-error.ts`
  (new), `src/start.ts`, `src/policy/resolvers.ts`, `src/config/posture.ts`; tests `migrations`,
  `audit`, `body-limits`, `preview-mode`, `logging`, `lifecycle`. Nothing in `packages/shared` or `apps/web`.
- Changed S1 protected paths: the orchestrator bumps VERSION.
