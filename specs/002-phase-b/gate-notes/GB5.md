# Gate note GB5 (T-B-289): RBAC and policy

Verdict: **ready for GB5 review (local pass)**. The property tests (`rbac-covers.property.test.ts`, `rbac-effective.test.ts`) and the concurrency test run inside `pnpm test`; the 100x repetition of the concurrency test and the 20,000-case/20 s timing were not measured separately (UNVERIFIED).

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, HEAD `e27ddf5`, working tree clean (`git status --short` empty), 2026-10-12, Node v22.22.0, pnpm 10.28.0. The commands were run on this tree, not on a fresh clone (`pnpm install --frozen-lockfile` on a clean copy: UNVERIFIED, CI does it).

| Command | Result | Time |
|---|---|---|
| `pnpm lint` (routes generate, eslint `--max-warnings 0`) | green | 186 s |
| `pnpm typecheck` | green | 46 s |
| `pnpm test` | green: shared 45 files / 3,532 tests; web 63 / 1,740; server 185 / 8,179; tools 15 / 1,113 (1 skipped); e2e unit 165 | 485 s |
| `pnpm build` | green | 7 s |
| `pnpm schema:check`, `routes:check`, `i18n:check`, `tokens:check` | green | 2, 2, 8, 1 s |
| `pnpm bundle:check` | within budget (initial JS 244,665 B gzip, first load 276,206 B brotli; the ratchet was skipped, no base ref) | 3 s |
| `python3 -m unittest discover -s scripts` | 223 tests OK | 4 s |
| `docker compose config -q` | exit 0 | 7 s |
| `pnpm format:check` | **red**: Prettier 3.9.10 reports 100 files (apps/web/src 39, apps/web/test 24, apps/server/test 19, packages/shared/test 7, apps/server/src 5, others 6). Not fixed here (application code); `pnpm format` is a whitespace-only fix the orchestrator must run and commit | 34 s |
| Not run in this sandbox | `pnpm e2e`, `pnpm lighthouse`, `pnpm image:smoke`, `pnpm audit`, actionlint, arm64, cosign, SLSA, CodeQL, Trivy; the "seen red once more" reruns of the negative controls (UNVERIFIED unless a line below says otherwise) | |

## Tasks (evidence)

| Task | Evidence |
|---|---|
| T-B-230 to T-B-236 shared half | see GB1 |
| T-B-237 wrapper, T-B-240 to T-B-243 policy, T-B-244 to T-B-246 | see GB2 |
| T-B-238 repository, built-in check, templates | `rbac/builtin-roles.test.ts`, `rbac/templates.test.ts`, `migrations.phase-b.test.ts` (29 triggers) |
| T-B-239 grants memo, epoch, expiry | `rbac/epoch.test.ts`, `rbac/expiry.test.ts` |
| T-B-247 membership resolution | `rbac/membership.test.ts`, `rbac/overage.test.ts` |
| T-B-248 assignment service and validation | `rbac/validation.test.ts`, `rbac/limits.test.ts`, `rbac/group-privileged.test.ts` |
| T-B-249 anti-escalation, last Owner | `rbac/escalation.test.ts`, `rbac/last-owner.test.ts`, `rbac/last-owner.concurrency.test.ts` (worker processes) |
| T-B-250 routes P27 to P31 and audit | `rbac/assignments-api.test.ts`, `rbac/audit-rbac.test.ts`, `rbac/default-deny.test.ts` |
| T-B-251 `me/access` | `rbac/my-access.test.ts` |
| T-B-252 restore-owner | `rbac/restore-owner.test.ts` |
| T-B-253 module wiring | `rbac/module.test.ts` |
| T-B-254 label functions | `rbac-labels.test.ts` (shared) |

Phase A server tests migrated to signed-in actors (XB21: 30 files touched, +1,982 -153: `test/helpers/*`, `helpers.test.ts`, `test/branding/*`); no test deleted. A per-file test count was not recorded (UNVERIFIED); the server suite is green with 8,179 tests.

## Decisions

- Grant scope literal is lower case `'all'`.
- A role holding `rbac:manage` or `settings:connection` cannot be bound to a group (ODB-16).
- `POST /api/v1/rbac/restore-owner` accepts a break-glass session only (an Owner gets 403 `permission_denied`); the user object id is checked against Graph (`confirmUnverified` accepts an id Graph could not answer for); it is the one path that skips `canGrant`.

## Seams applied

| Seam | Lines |
|---|---|
| XB6 `permissions.ts` (`PERMISSION_RESOURCE`) + test | 2 files +101 -3 |
| XB15, XB16, XB17, XB21 | see GB2 |

## Control-name changes

Table export `rbacRoleGrant` (SQL `rbac_role_permission`); route ids lower case (GB2).

## Open points, assumptions, risks, UNVERIFIED

- U36, U37, U38 (group properties with `GroupMember.Read.All` only, `$filter` without `ConsistencyLevel`, `checkMemberGroups` with an unknown id): open; OV-16, OV-19. The group picker shows the display name only, so a U36 failure is not visible in the panel in Phase B.
- OV-08 (more than 200 groups) depends on a tenant shape the owner may not have.
- Risk RB-13 (stale grants memo): covered by `epoch.test.ts`; revocation delay of group-derived rights is `GROUP_CACHE_TTL_SECONDS` (ODB-10).
- UNVERIFIED: negatives (broken `covers`, ignored expiry, stale memo, missing trigger, forgetful scoped handler) seen red again.
