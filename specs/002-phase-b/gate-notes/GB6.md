# Gate note GB6 (T-B-349): web

Verdict: **ready for GB6 review (local pass)**. Component tests cover the wizard statuses in both languages; browser behaviour is GB7 (pending CI).

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

## Tasks (evidence, `apps/web/test/` unless stated)

| Task | Evidence |
|---|---|
| T-B-290 re-read of Phase A web | `specs/002-phase-b/phase-a-reread/web.md` |
| T-B-291 i18n `loadNamespace`, lazy files | `shared/i18n.test.ts`, `lazy-namespaces.test.ts`, `locale-detection.test.ts` |
| T-B-292 message keys, T-B-293 and T-B-294 fragments | `shared/message-keys.test.ts`, `i18n-fragments.test.ts`, `i18n-catalogue.test.ts`, `pnpm i18n:check` |
| T-B-295 API client | `api.test.ts`, `navigation.test.ts`, `problem.test.ts` |
| T-B-296 boot re-check, session store | `boot-recheck.test.tsx`, `boot-data.test.ts`, `storage.test.ts` |
| T-B-297 root gate, `/signin`, `/no-access` | `signin.test.tsx`, `no-access.test.tsx`, `router.test.tsx` |
| T-B-298 shell | `persona-menu.test.tsx`, `session-timeout.test.tsx`, `step-up-dialog.test.tsx`, `shell.test.tsx` |
| T-B-299 service worker routing | `sw-routing.test.ts` |
| T-B-300 to T-B-302 wizard | `setup-wizard.test.tsx`, `setup-connect.test.tsx`, `setup-finish.test.tsx`, `setup-log.test.tsx`, `ms-url.test.ts` |
| T-B-303 `/settings/connection` | `connection-page.test.tsx` |
| T-B-304 `/settings/access` | `access-page.test.tsx` |
| T-B-305 break-glass pages | `break-glass.test.tsx` |
| T-B-306 Settings overview, nav by permission | `nav-gating.test.tsx`, `gating.test.tsx`, `routes-coverage.test.ts` |
| T-B-307 bundle budget | `pnpm bundle:check` within budget; namespaces lazy |

## Frozen interfaces

CB15: client route paths (`/setup`, `/signin`, `/no-access`, `/break-glass`, `/settings/connection`, `/settings/access`, `/settings/restore-access`), the catalogue namespaces and the `lib/api` 401/step-up behaviour.

## Seams applied

| Seam | Files | Lines |
|---|---|---|
| XB24 | `shared/src/i18n/index.ts`, `scripts/i18n-merge.ts`, three tests | 5 files +625 -28 |
| XB25 | `routes/__root.tsx`, `no-access.tsx`, `settings.tsx`, `routeTree.gen.ts` | 4 files +172 -14 |
| XB26 | `components/shell/*` | 5 files +84 -50 |
| XB27 | `lib/api.ts`, `lib/commands.ts`, `lib/storage.ts`, `boot/*` | 5 files +186 -27 |
| XB28 | `sw/routing.ts`, `test/sw-routing.test.ts` | +172 -4 |
| XB29 | `packages/shared/src/routes.ts` (the file lists client paths, so the edit was needed) | +14 -2 |

## Facts and deviations

- The stored default language reaches the browser through `GET /api/v1/me` as `defaultLanguage` only once the setup is `completed`.
- Two `eslint.config.js` roles (`log`, `region`) may carry `tabIndex` so that scrollable regions are keyboard reachable (axe `scrollable-region-focusable`, WCAG 2.1.1); every other non-interactive role is still refused.
- The wizard shows no group properties (`groupTypes`, `mailEnabled`, `securityEnabled`) in Phase B.

## Open points, risks, UNVERIFIED

- Screen readers and browsers other than Chromium are untested (owner, OV-14).
- UNVERIFIED: negatives (link allow-list, `ms-url`, service-worker caching, missing message key) seen red again.
