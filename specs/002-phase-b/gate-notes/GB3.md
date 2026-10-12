# Gate note GB3 (T-B-229): sign-in

Verdict: **ready for GB3 review (local pass)**. The 45 fixtures are green; the real-token behaviour remains with the owner (OV-07, OV-09, OV-11, OV-12, OV-14, OV-16).

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

| Task | Evidence (`apps/server/test/auth/` unless stated) |
|---|---|
| T-B-181 cookie helpers | `cookies.test.ts`, `headers.test.ts` |
| T-B-182 login transactions, `GET /auth/login` | `routes.test.ts`, `return-to.test.ts`, `replay.test.ts` |
| T-B-183 principal, identity key | `principal.test.ts`, `identity-key.test.ts` |
| T-B-184 session store, rotation, limits | `session-store.test.ts`, `sessions.test.ts`, `rotation.test.ts` |
| T-B-185 MFA gate | `mfa.test.ts`, `mfa-check.test.ts`, `mfa-config.test.ts` |
| T-B-186 callback, F-01 to F-45 | `callback.test.ts`, `no-token-retained.test.ts`, `no-leak.test.ts` (canaries for code, state, ID token) |
| T-B-187 interstitial | `interstitial.test.ts` |
| T-B-188 administrator-consent link | `consent-link.test.ts` |
| T-B-189 revalidation | `revalidate.test.ts` |
| T-B-190 sign-out, sign out everywhere | `logout.test.ts` |
| T-B-191 step-up | `step-up.test.ts` |
| T-B-192, T-B-193 break-glass | `break-glass.test.ts`, `break-glass-session.test.ts` |
| T-B-194 `GET /api/v1/me`, idle header | `me.test.ts` |
| T-B-195 rate-limit classes, cache headers | `rate-limit.test.ts`, `cache-headers.test.ts` |
| T-B-196 auth module wiring | `authorize-request.test.ts`, `setup-hook.test.ts` |

## Decisions taken while building (also in `docs/open-points.md`)

- Step-up without MFA answers explicit `mfa_required` or `amr_missing` (FR-B-411), not `stepup_failed`.
- The F-45 fixture uses 250 short `groups` entries (with `_claim_names` and `hasgroups`), enough to pass the 200-entry limit and small enough for the fake's header size.
- Audit rows of requests without a user principal use the actor ids `anonymous` and `break-glass`.
- Revalidation guard: `http/route.ts`.

## Frozen interfaces

CB12 sign-in half: login/callback/logout/step-up routes, session store and `completeSetupInTx` hook (used by T-B-141), `MeResponse`, cookie names, `X-Session-Idle-Expires`.

## Seams applied

| Seam | Files | Lines |
|---|---|---|
| XB7 | `packages/shared/src/schemas/meta.ts` | +66 -13 |
| XB18 | `http/rate-limit.ts`, `http/cache-headers.ts`, two tests | 4 files +366 -7 |
| XB19 | `routes/meta.ts`, `branding/module.ts` (boot data with the real actor; `features.breakGlass`) | 2 files +29 -51 |

## Control-name changes

Cookie names and `Set-Cookie` discipline as in `shared/cookie-names.test.ts`; route ids as in GB2.

## Open points, assumptions, risks, UNVERIFIED

- U13 and U27 (`max_age` / `claims`): not used; step-up is `prompt=login` plus fresh `auth_time`, same identity (OV-07).
- U29 (logout with a primary refresh token), U30 (consent for OIDC-only scopes), U33 and U35 (clock tolerance, `alg`), U39 (SameSite through redirect chains, `http://localhost`), U42 (`Cookie` scheme in `WWW-Authenticate`): open, owner-verified items OV-07, OV-09, OV-12, OV-14. U40 closed (option names pinned by `jwks-cache.test.ts`).
- Risk: a tenant without any MFA policy cannot produce `amr=mfa`; `AUTH_REQUIRE_MFA=false` is the documented switch (ODB-04).
- UNVERIFIED: interstitial-303 and validator-mutant negatives seen red again.
