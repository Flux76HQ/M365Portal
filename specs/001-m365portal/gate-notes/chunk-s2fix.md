# Chunk s2fix: fixes after the adversarial review of the branding upload pipeline (S2)

Territory: `apps/server/src/branding`, `apps/server/test/branding`. Nothing in `src/db`, `policy` or `http` was touched.

## 1. SVG sniff window removed (FR-A-085, plan 8.5 stage 6)
- Test first (`sniff.test.ts`, replaces the "limited window" test): `<!--` + 100,000 bytes + `-->`, 105,000 spaces, 70,000 newlines after an XML declaration and a 1.9 MB comment all sniff as `svg`; a long prolog without a root, or with text before the root, is still `image_type_unsupported`. It failed on `image_type_unsupported` before the fix.
- Fix: `SNIFF_WINDOW_BYTES` is gone; the scan covers the whole body (at most 2 MiB, the file cap is enforced earlier). The attribute regex (`matchAll` with `[ \t\r\n]*=` backtracking) was replaced by a forward-only scanner (`attributeValue`), so a megabyte of name or whitespace cannot go quadratic. Quadratic-attack test now uses 1-2 MB inputs (`<`x2,000,000, a 1 MB name plus 1 MB whitespace, `a ` x500,000, 2 MB of whitespace) with a 1.5 s budget for all of them. Other format sniffing unchanged.

## 2. Retired masters and the staging quota (I-5)
- Test first: `audit-branding.test.ts` (40 upload-and-apply cycles never get a 409; the previous master keeps its 24 h, the one before it is expired; Undo re-apply keeps the master referenced), `asset-store.test.ts` (refusal sentence for files and for bytes), `branding-api.test.ts` (409 detail over HTTP).
- Rule: Undo goes back ONE change. At every apply, the masters retired by the PREVIOUS apply lose their 24 h (`unreferenced_at` set to now - 24 h - 1 ms; the hourly sweeper deletes row and file) unless this apply references them again. They are told apart from waiting uploads by carrying exactly `branding.updated_at` of the previous apply and having been created before it (`repository.ts`: `expireRetiredAssets`, `retainedUsage`). No schema change. Consequence: at most 3 files (light, dark, compact master) are ever the Undo target and count toward the quota; 34+ cycles cannot exhaust it.
- Residual risk: an upload whose timer was refreshed (re-upload of identical bytes) in the very same millisecond as an apply is mistaken for a retired master and expires at the next apply (the administrator uploads again). Not reachable with real request spacing; recorded.
- 409 detail now names the part that is full, numbers only (no names, hashes, paths): `The file limit of the staging quota is full: 32 of 32 files. 29 uploaded images are waiting to be applied and 3 are kept for 24 hours so the last change can be undone.` or `The size limit of the staging quota is full: <used> of <max> bytes are in use and this image needs <n>. ...`. The `code`, status and the catalogue keys are unchanged. The route builds the body from `describeProblem` and replaces only `detail` (no change to `src/http`).

### Wording changes the orchestrator must carry (I-5 and decision s2e-2)
- data-model I-5: replace "At most 32 rows and 32 MiB with `unreferenced_at IS NOT NULL`" by: "At most 32 files and 32 MiB of WAITING assets: rows whose `unreferenced_at` lies within the last 24 hours. This includes the masters retired by the most recent apply (the Undo target, at most 3 files); the masters retired by any earlier apply, and all server-derived variants, are retired already expired and do not count."
- Spec / data-model text that says "retired assets keep 24 hours": add "... but only those retired by the latest change; the next change ends the Undo of the one before it". Also `routes/branding.ts` reset description ("Retired assets keep 24 hours, so Undo can re-apply them") is still true for the latest change.
- s2e decision 2: "retired uploaded masters keep their 24 h" becomes "the masters of the latest apply keep their 24 h (Undo); older retired masters expire at the next apply".
- FR for the 409 (spec 6.4 `staging_quota_exceeded`): the `detail` is specific (file limit or size limit, waiting vs kept for Undo), not the generic registry sentence.

## 3. Audit of the request-cap 413
- The 413 of the REQUEST cap (2,162,689-byte upload, 9,437,185-byte import) is answered by the body-limit guard in `src/http` (S1) before the route handler exists; it has no slot, no parsed file and no audit path, and `denial-audit.ts` states 413 is not audited. Handing over would need an S1 change (`body-limit.ts` / `route.ts` hook), outside this stream. Decision: document and pin.
- Pinned: new test in `upload-pipeline.test.ts` (request of exactly 2,162,689 bytes over a socket: 413 `payload_too_large`, no audit row, nothing staged); the import test in `export-import.test.ts` already asserts the audit count is unchanged for 9,437,185 bytes. The file-level 413 (2,097,153 bytes in a request that fits) stays audited as `rejected`.
- Open point for S1/orchestrator: if the audit of the request cap is wanted, an `onBodyLimit` hook in the route wrapper is needed; then flip these two assertions.

## Not in scope (recorded)
- SVG containers `<a>` and `<switch>`: documented limitation, unchanged.
- Import `schemaVersion` 1.0 acceptance: nit, unchanged.

## Evidence
- `pnpm --filter` equivalent in `apps/server`: `vitest run test/branding --no-file-parallelism --maxWorkers=1` -> 19 files, 950 tests passed (includes the hostile corpus over HTTP against the freshly built `dist` server: 44 fixtures plus the shape test, 44 of 44). eslint on `src/branding test/branding` clean; `tsc --noEmit` clean for the server package.
- Tests added or changed: sniff 1 replaced (+ attack list enlarged), audit-branding +2, asset-store +2, upload-pipeline +1; branding-api 1 strengthened. Hostile corpus count unchanged (44).
- Not verified: one earlier full-folder run failed en masse in about 5 ms per test while another stream was editing; the same files passed alone and in the final run.
