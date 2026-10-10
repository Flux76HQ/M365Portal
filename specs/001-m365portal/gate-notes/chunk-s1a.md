# Chunk note s1a (T-A-020 to T-A-024): open points, assumptions, risks

Written by the `s1a` worker for S8's consolidation (`T-A-278`). The full evidence, frozen interfaces and test counts are in [`G1a.md`](G1a.md); this note lists only what a later reader has to act on or keep in mind.

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| s1a-1 | Reason row for `zod` 4.6.5 in `docs/architecture.md` (shared package, prod dependency; plan 5.2 has the wording) | S8 | `T-A-274` |
| s1a-2 | `git diff pnpm-workspace.yaml` must show only `zod: 4.6.5` in the catalog; `pnpm add` removes the file's comments, they were restored by hand inside the install lock | orchestrator | before the commit |
| s1a-3 | `VERSION` bump is needed at commit time for the protected paths touched (`packages/shared/src/**`, `apps/server/test/**`) | orchestrator | commit |
| s1a-4 | The Dutch text of the 32 `problem.*` messages is mine and unreviewed by the owner; the English `title` and `detail` strings likewise | owner | phase report |
| s1a-5 | Production `Clock` interface does not exist; `FakeClock` has `now(): Date`, `nowMs()`, `iso()` | S1 (`T-A-030`, `T-A-034`) | when the first consumer is written |
| s1a-6 | The retry hints (`storage_busy` 1 s, `shutting_down` 5 s) of contract section 6 are not in the registry | S1 (`T-A-027`) | that task |
| s1a-7 | `docs/permissions.md` must list the 15 names of `PERMISSIONS`; `docs/operations.md` limits table must match the nested `LIMITS` (rates as `refillIntervalMs`, `refillPerSecond()` gives the per-second figure) | S8 | `T-A-270`, `T-A-276`, `T-A-277` |
| s1a-8 | `hasAnyPermission(held, [])` is false; S4's gating and command registry must treat "no requirement" separately | S4 | `T-A-166`, `T-A-168` |
| s1a-9 | `problem.unknown` needs `{code}` and `{requestId}`; `rate_limited` and `image_processing_busy` need `{seconds}`; `origin_not_allowed` needs `{origin}` | S4 | `T-A-165` (`lib/problem`) and the error boundary |
| s1a-10 | Pino as the destination of `LogCapture`: unverified until pino is installed | S1 | `T-A-029` |
| s1a-11 | A socket test cannot spoof `Host` through `fetch`; use in-process requests, or `node:http` | S1 | `T-A-028`, `T-A-033` |

## Assumptions

- Deny by default for an empty `anyOf`; rates stored as intervals; `ProblemSchema.code` lenient; `ReadyzResponseSchema` needs all three checks; no pairing of readiness check and failure code; `MeResponseSchema` checks shape, not policy facts (details in `G1a.md` section 5).
- In-process requests simulate the socket peer in the shape `@hono/node-server`'s `getConnInfo` reads; if `T-A-026` reads it differently, `peerBindings` in `apps/server/test/helpers/test-app.ts` changes with it.
- `OriginSchema` is an addition to `schemas/common` beyond the contract list of section 8.1 (two schemas need the same rule); nothing is removed or renamed.

## Risks

- Strict response schemas (`z.strictObject`) mean a new member in a response is a schema change in the same commit (Phase B will add some to `MeResponse`).
- `LIMITS` is deep-frozen: code that must be tested with a smaller limit has to take the limit as a parameter. Design `T-A-030` (rate limiter) and `T-A-031` (body limit) that way.
- `error-codes.test.ts` parses two specification documents; a reformatted table makes it fail until the extraction is adjusted (the message says which table and how many rows it found).
- Temporary directories of the helpers are removed with Vitest's `onTestFinished`; a helper used from `beforeAll` or a script is not removed automatically and needs `remove()`.
