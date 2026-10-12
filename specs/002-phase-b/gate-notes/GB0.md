# Gate note GB0 (S-B1, Platform): T-B-002 to T-B-014, T-B-015, T-B-024

Verdict: ready for GB0 review. Open points are listed at the end.

## Commands run

- `pnpm --filter @m365portal/shared lint`, `typecheck`, `test`: green (232 tests).
- `pnpm --filter @m365portal/server lint`: one finding, in foreign code (`src/http/csrf.ts:110`, rule no-decode-microsoft-tokens, owned by S-B2). Nothing of S-B1 remains.
- `pnpm --filter @m365portal/server typecheck`: green. `test`: 58 files, 4,833 passed, 1 todo; the two Phase A tests that failed (`logging.test` schemaVersion, `branding/module.test` appModules) were updated in the same task.
- `pnpm schema:check`: ok. `pnpm --filter @m365portal/server build`: ok. `prettier --check`: ok.
- `python3 scripts/check_version_bump.py --base-ref HEAD`: passes (VERSION is 0.3.0).

## Tasks

T-B-002 shared limits and exports map; T-B-003 problem codes (53) with nl/en fragments; T-B-004 cookie names; T-B-005 redirect URIs;
T-B-006 scrypt hash format; T-B-007 node version; T-B-008 common schemas; T-B-009 config (24 variables, SecretText, derived);
T-B-010 check macros and `phase-b.ts` (17 tables); T-B-011 migration `0001_phase_b` (9 indexes, 29 triggers, 4 seeds), snapshot and parity;
T-B-012 audit actions, actor kinds, detail keys (64); T-B-013 audit integration; T-B-014 module availability and five stub modules.
T-B-015 (`secrets/app-key.ts`) and T-B-024 (rate-limit classes) were done as dependencies.

## Frozen interfaces

CB1 limits and problem codes, CB2 `AppModule.availability` and `appModules` order (branding, secrets, setup, connection, auth, rbac),
CB3 audit (`AUDIT_ACTIONS`, `AUDIT_DETAIL_KEYS`, six actor kinds), CB4 config (`AppConfig` fields, `SecretText`, `deriveRedirects`).

## Seams and extra edits

XB1 to XB5 and XB8 to XB11 applied. Extra: `http/rate-limit.ts` (partial rules), `start.ts` (removed-variable announcement), `app.ts`
(`assertModuleAvailability`), `.env.example`, `docker-compose.yml`, `docs/operations.md` rows, Phase A tests that broke
(limits, error-codes, config, deploy-files, logging, branding helpers, limits-doc).

## Control-name sync

Snapshot file `schema-snapshots/0001-phase_b.sql`; table export `rbacRoleGrant` (SQL name `rbac_role_permission`); `drizzle.config.ts` unchanged;
engines range read from the root `package.json`. Journal `when` exceeds 1791669383026.

## Deviations and open points

- Phase A preview mode is kept alive transitionally (`config/legacy-preview.ts`, optional `previewMode` fields) until T-B-240; the variables are announced as removed.
- `phase-b.ts` has one narrowly justified eslint-disable for `sql.raw` in the CHECK helper (constants only).
- Foreign: `src/http/csrf.ts:110` lint error (S-B2).
- UNVERIFIED: mutation checks of the T-B-009 and T-B-012 negatives were not repeated after the final lint edits.
