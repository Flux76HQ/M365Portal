# Phase A re-read: deploy files, image checks, e2e, documentation and CI as built (`T-B-350`)

**Date**: 2026-10-12 | **Read**: `.env.example`, `docker-compose.yml`, `Dockerfile`, `deploy/`, `scripts/{image-smoke.ts,check_image_contents.py,check_image_size.py,test_workflows.py,bundle-budget*,bump_version.py}`, `.github/{dependabot.yml,workflows/*}`, `e2e/**`, `docs/**`, `README.md`, `apps/server/test/{deploy-files,docs-contract,limits-doc}.test.ts`, `tools/traceability/*` of the tree at `b13971d` plus the S-B1 edits already in it (`VERSION` 0.3.x) | **Against**: spec 13.1, seams XB30 to XB35 (`tasks.md` 1.5), Phase A task numbers T-A-230 to T-A-237, T-A-254 to T-A-256, T-A-270 to T-A-279, T-A-320 to T-A-334 | **Author**: the S-B7 worker of `T-B-350`. The server and shared side is `server-shared.md`; the web side is `web.md`.

## 0. Verdict

**PROCEED. The stop rule (PBR-03) did not trigger.** Every file a Phase B edit needs exists with the symbol the edit changes. Eight things differ from what the plan and `tasks.md` assume; none changes a requirement, each is decided in section 6 and carried by a named task.

1. `.env.example`, Compose and the deploy-files test were already half edited by S-B1 (24 variables, `PREVIEW_MODE*` gone from the variable list) but the Compose ports comment, a test and a negative still required `PREVIEW_MODE=true`; `T-B-351` finishes it (section 2).
2. The Compose secret cannot pass `APP_KEY` and `APP_KEY_FILE` together (the configuration refuses both), so the Compose file passes `APP_KEY_FILE: /run/secrets/app_key` and no longer passes `APP_KEY` (decision D-2).
3. `PUBLIC_BASE_URL=http://127.0.0.1:<port>` is invalid in Phase B (FR-B-103: http only on the host `localhost`). `image-smoke.ts` used the 127.0.0.1 origin, so the Phase A script cannot start a Phase B container at all (seen red on 2026-10-12, section 3).
4. `scripts/check_image_contents.py` finds development dependencies by reading the manifests of the repository: `msw` is already forbidden through `apps/server/package.json`, but `@mswjs/interceptors` is not named by any manifest, and the transitive packages of `@azure/msal-node` and `@peculiar/x509` are production packages that a manifest scan would never name. The ban list needed a static part (section 3).
5. `docker run` of the Phase B image needs `--network host` here and `docker build` needs `--network host --secret id=extra_ca,... --build-arg HTTPS_PROXY` (the G6 recipe); the plain `docker build -t m365portal:local .` of the `image.yml` remediation texts gives the label `unknown` (Phase A finding s6b-1, still open, section 5).
6. The Phase A e2e topology still names its instances `preview` and `anonymous` in nine places beyond the specs (section 4); `T-B-370` replaces them.
7. `docs-contract.test.ts` requires the heading `## Preview mode` in `docs/security.md` and a dependency row for every direct production dependency; the second is red since S-B1/S-B2 added the dependencies (`T-B-424` turns it green, `T-B-420` edits the preview rule).
8. `tools/traceability` reads the Phase A table form of the prefixes (`| \`server/\` | \`apps/server/test/\` |`); Phase B states them in one prose line and cites one control under `tools/`. Both are handled in `T-B-394` (section 6).

## 1. The interfaces Phase B uses, one row each

| Phase A interface | File and symbol (as built) | Same or differs | Phase B edit | Task |
|---|---|---|---|---|
| Compose structure | `docker-compose.yml`: one service `m365portal`, `read_only`, `tmpfs`, `cap_drop ALL`, `no-new-privileges`, `mem_limit 512m`, `pids_limit 128`, `stop_grace_period 15s`, healthcheck by Node script, named volume `data`; environment is a pass-through of every schema variable except `HOST` and `DATA_DIR` | Same | `secrets:` stanza (service and top level), `APP_KEY_FILE` set, `APP_KEY` not passed, loopback comment without `PREVIEW_MODE`, the `docker exec` commands in the header | `T-B-351` |
| `.env.example` parity | `deploy-files.test.ts` `assertEnvExampleParity`: exactly `ENV_VARIABLES` plus `HOST_PORT`, defaults equal the schema, commented lines count, no secret-looking value; there is no generator | Same | 14 new variables (already in by S-B1); comment for `APP_KEY` and `APP_KEY_FILE` says what Compose does; retired variables must not appear | `T-B-351` |
| Compose resolver | `deploy-files.test.ts` runs `docker compose config --format json` (skipped without the plugin, failure with `REQUIRE_DOCKER=1`) | Same | the default-copy test accepts `APP_KEY_FILE=/run/secrets/app_key` | `T-B-351` |
| Image smoke test | `scripts/image-smoke.ts` (full and skeleton mode, `SMOKE_NETWORK=host`, `SMOKE_REPORT`): image facts, run 1 (default port), Intl, SVG loader, upload and apply, hostile SVGs, two large uploads, `verify-audit`, restart, read-only `/data`, alternative port | Differs | no `PREVIEW_MODE`; `localhost` origin; the sealing key, the setup token, unlock, the cookie jar; CLI commands; certificate; restart persistence; start without the key; size; scrypt memory | `T-B-353` |
| Image contents check | `scripts/check_image_contents.py`: `APP_ROOT_ENTRIES`, `REQUIRED_FILES`, `SECRET_FILE`, `dev_packages()` read from manifests, `ALLOWED_PACKAGES` (empty), `check_listing`, `check_inspect` | Same, one gap | rules `test-hook`, `setup-token-file`, `database-file`; `TEST_TOOLING_PACKAGES`; `EXPECTED_TRANSITIVE` | `T-B-352` |
| Image size | `scripts/check_image_size.py` ceiling 400 MB = `LIMITS.imageSizeCeilingMegabytes` | Same | re-measured: 205.5 MB with the Phase B dependencies; nothing raised | `T-B-353` |
| Workflow tests | `scripts/test_workflows.py`: `EXACT_JOBS`, step lists per job, `DEPENDABOT_IGNORED`, `check_dependabot` | Same | three ignore rules (`>=8`, `>=7`, `>=3`); a test that no job was added | `T-B-354` |
| Dependabot | `.github/dependabot.yml`: npm over `/`, `/apps/*`, `/packages/*`, `/e2e`, docker, github-actions, weekly, grouped, seven ignore rules each with a reason comment | Same | three more ignore rules, each with a reason | `T-B-354` |
| Bundle budget | `scripts/bundle-budget.json` (ratchet) and `bundle-budget.test.ts` | Same | S-B6 part 2 did it in `d612ce8` (T-B-307 note in the file) | not this stream |
| Docs contract | `docs-contract.test.ts`: README links and both languages, operations sections and environment table, security sections and SVG allowlist, permissions panel catalogue (15) and Graph table (reason, phase, status, register id), architecture dependency table (name, reason, mark), ADR format (`# ADR-NNNN: title`, `Samenvatting (NL):`, five headings), spec/plan/tasks of Phase A | Same | all Phase B rules (section 5 of this file lists them) | `T-B-420` |
| Limits table | `limits-doc.test.ts` (row per spec 6.5 row; every `LIMITS` entry claimed by a row) | Same | Phase B rows were added to `docs/operations.md` and the row list by S-B1 (GB0); the "constrains" column is new | `T-B-420`, `T-B-422` |
| Traceability | `tools/traceability/{trace,phase-guard}.ts`: rows `FR-A-nnn`, prefix table of the Phase A spec, controls (test path, job, step, lint rule, command), no-Phase-B guard switched by `CURRENT_PHASE` (already `'B'`) | Differs (rows, prefixes, `tools/` controls, task titles) | `FR-B` rows, prose prefixes, `tools/` paths, titles only, no-Phase-C guard, report check | `T-B-394` |
| e2e config | `e2e/playwright.config.ts` (projects, `--no-sandbox`, `E2E_PORT`), `fixtures.ts` (fail on `pageerror`, `console.error`, `securitypolicyviolation`, 4xx/5xx, Microsoft hosts), `routes.ts` (client paths), `servers.ts` (instances `preview` with `PREVIEW_MODE`, `anonymous`), `global-setup.ts`, `global-teardown.ts`, `lighthouse/{run,judge}.mjs`, `media/make-readme-media.ts` | Differs (instance model) | topology replaced, support files added | `T-B-370` (another worker) |
| CI | `.github/workflows/{ci,image,version-guardrails,agent-instructions,codeql,visual-baselines}.yml`: jobs `quality`, `e2e`, `image`, `publish`, `enforce-version-bump`, `agent-instructions-lint`, `analyze` | Same | no new job; no new step needed (section 6, XB32) | `T-B-354` |

## 2. `rg -l "preview|PREVIEW_MODE"` over the deploy, e2e, docs, scripts and CI files

The command of the task found 29 files. The word also matches the Appearance **live preview** (`pages.spec.ts`, `a11y.spec.ts`, `showcase.spec.ts`: preview of the logo and accent) and the e2e "preview instance"; the narrow pattern `PREVIEW_MODE|previewMode|preview actor|preview mode|features\.preview|kind: 'preview'|PreviewBanner|preview-banner|banner\.preview|Preview mode` separates them. Files that must change, with the task:

| File | What it holds | Task |
|---|---|---|
| `docker-compose.yml`, `.env.example` | the loopback comment (`PREVIEW_MODE=true publishes on 127.0.0.1 only`); the variables themselves were removed by S-B1 | `T-B-351` (done in this stream) |
| `apps/server/test/deploy-files.test.ts` | the ports-comment rule and its negative named `PREVIEW_MODE=true` | `T-B-351` (done) |
| `scripts/image-smoke.ts` | `-e PREVIEW_MODE=true`; branding as the preview actor; origin `http://127.0.0.1:<port>` | `T-B-353` (done) |
| `README.md`, `deploy/README.md` | "Reach the panel with `PREVIEW_MODE=true`" paragraphs (README lines 23 to 29, 47 to 55, 84, 85, 104, 114; deploy/README the loopback section) | `T-B-426`; `deploy/README.md` has no Phase B owner in `tasks.md` (finding F-3, section 7) |
| `docs/operations.md` | the two variable rows were replaced by S-B1; the loopback publishing paragraph and the proxy note about `Host` remain | `T-B-422` |
| `docs/security.md` | `## Preview mode`, `### Preview-modus`, risk R-08, the access-control row | `T-B-423`, with `T-B-420` editing the heading rule |
| `docs/open-points.md` | OD-03, OD-04, R-08, s1-fix-3, s1c-11 | `T-B-425` |
| `docs/adr/0011-actor-and-authorize-with-preview-resolver.md` | Phase A ADR; gets a "superseded in Phase B" note | `T-B-428` (new ADR 0151..0178 carry it; the note is a one-line edit of a Phase A ADR: finding F-4) |
| `docs/adr/0056-default-instance-lcp-decision-rule.md` | "preview instance" means the e2e instance | no change |
| `e2e/servers.ts`, `fixtures.ts`, `playwright.config.ts`, `pwa-helpers.ts`, `branding-helpers.ts`, `lighthouse/{run,judge}.mjs`, `lighthouse/judge.test.mjs`, `media/make-readme-media.ts`, `README.md` | instance names `preview` and `anonymous`, `PREVIEW_MODE=true`, `SHOWCASE=true` | `T-B-370` (topology), `make-readme-media.ts` with `T-B-426` |
| `e2e/tests/preview-banner.spec.ts` (7 tests) | the banner and `features.preview` | `T-B-376` (becomes `preview-removed.spec.ts`) |
| `e2e/tests/{branding (17), branding-persistence (4), branding-xss (5), offline (8), pages (15), showcase (5), a11y (13), no-external-requests (4), nav-gating (8)}.spec.ts` | `restart('preview')`, `start('preview')`, `INSTANCES = ['preview','anonymous']` | `T-B-371` (`a11y` by `T-B-378`, `no-external-requests` by `T-B-377`); the number in brackets is the test count the migration must not lower |

Input of `T-B-371`: the specs below hold the following numbers of `test(` calls today (counted 2026-10-12): `a11y 13, branding 17, branding-persistence 4, branding-xss 5, csp 7, dashboard 6, fixtures-selftest 6, forced-colors 9, headers 11, i18n-theme 16, keyboard 13, nav-gating 8, no-external-requests 4, no-flash 3, offline 8, pages 15, preview-banner 7, pwa 9, reduced-motion 4, responsive 13, shortcuts 8, showcase 5, smoke 1, visual 4` (196 in all, counted with a pattern: it misses `test.each` expansions, so the real number a migration must keep is read from the Playwright list).

## 3. What was run against the real image

The Docker daemon was not running (as in Phase A, s6b-7); it was started with `dockerd --iptables=false --bridge=none --ip-masq=false --storage-driver=vfs`. The image was built with `docker build --network host --secret id=extra_ca,src=/root/.ccr/ca-bundle.crt --build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg VERSION="$(cat VERSION)" -t m365portal:local .` (about 70 s, 205.5 MB).

| Check | Result |
|---|---|
| The unchanged Phase A `image-smoke.ts` against the Phase B image | **red for the right reason**: run 1 exits at start with `config_invalid: PUBLIC_BASE_URL must be https, or http with the host localhost` (the script used `http://127.0.0.1:<port>` and `PREVIEW_MODE=true`) |
| The Phase B `image-smoke.ts` (`SMOKE_NETWORK=host`) | 33 of 33 checks green, about 100 s; figures in the gate note input of section 8 |
| `scripts/check_image_contents.py m365portal:local` | OK, 11,023 paths: `msw`, `@mswjs/interceptors`, `fake-tenant`, `.env`, token, key and database files are absent; the transitive packages are present and allowed |
| `scripts/check_image_size.py m365portal:local` | 205.5 MB of 400 MB |

## 4. Conditional seams, decided

| Seam | Question | Decision | Evidence |
|---|---|---|---|
| XB30 `Dockerfile` | does the smoke test show a missing runtime file? | **No edit.** `libsodium-wrappers`, `@azure/msal-node`, `jose`, `@peculiar/x509` and `reflect-metadata` are present in the production `node_modules`; the CLI (`dist/cli.js`), the migration `0001_phase_b` and the snapshot load; the certificate is generated inside the image | smoke 33 of 33 |
| XB32 `ci.yml` | is a workflow step missing? | **No.** `Docs contract` runs `pnpm docs:check`, `Bundle budget`, `Dependency audit (production)` and `(all, high)`, `Python governance and deploy tests` already exist, and `image.yml` runs the smoke test, the size check and the contents check. No job is added. Open (not an edit): the remediation text of `image.yml` still says `docker build -t m365portal:local .` without the `VERSION` argument (s6b-1) | `test_workflows.py` 68 tests |
| XB35 | the docs-contract rules | listed in section 5 | |

## 5. Documentation contract: what exists and what `T-B-420` adds

Existing rules (kept): README links, both languages, demo GIF; operations sections, `chown 65532:65532`, single replica, merge queue, environment table equal to `ENV_VARIABLES` plus `HOST_PORT` and to `.env.example`, Dutch section, anchor `#limits-outside-the-repository`; security: STRIDE, CSRF/Origin, header table, upload pipeline, SVG allowlist equal to `SVG_ALLOWLIST`, audit chain and its truncation limit, the preview-mode risk wording, ASVS, client address as personal data; permissions: panel catalogue of 15 and the Graph table; architecture: dependency table (every direct production dependency of the four workspaces, with Reason and Mark) and the accessibility checklist; ADR format; Phase A spec, plan and tasks consistency. The dependency rule is red today (`libsodium-wrappers` and the others have no row): the "red docs-contract row" of the task.

Added by `T-B-420` (Phase B): the sections of spec 6.8 in both languages; the 15-permission role matrix equal to spec 6.9.4 parsed from the spec and not from the code; every UNVERIFIED row of `permissions.md` has a row in `open-points.md`; the limits table equals `LIMITS`; the 9,437,184-byte sentence; the reverse-proxy checklist; sovereign clouds; the key-compromise procedure; `SETUP_TOKEN` removal; the proxy restriction for `/api/v1/auth/break-glass`; STRIDE tables and ASVS V2, V3, V4, V6, V7, V8, V13; the six dependencies with a mark; ADR blocks 0101 to 0126 and 0151 to 0178; the Phase B README sections; every route id of the contract in the route table and conversely; the negative-control table of plan 14.6 names paths that exist.

## 6. Divergences and decisions

| # | Finding | Decision | Where |
|---|---|---|---|
| D-1 | `deploy-files.test.ts` forbids a ports comment without `PREVIEW_MODE=true` | rule replaced: the comment shows the loopback mapping `127.0.0.1:${HOST_PORT}:${PORT}`; neither file may name a retired variable (a negative for each) | `T-B-351` |
| D-2 | `APP_KEY` and `APP_KEY_FILE` are exclusive | Compose passes `APP_KEY_FILE: /run/secrets/app_key`; `APP_KEY` joins `HOST` and `DATA_DIR` in the "not passed on" list and `.env.example` says so for all three | `T-B-351` |
| D-3 | the Compose `secrets:` source file does not exist for an operator who copies the file without creating `secrets/app_key` | `docker compose config -q` passes (verified) and `docker compose up` stops with a clear message; the header of the Compose file gives the three commands. An existing Phase A deployment that keeps its own Compose file is unaffected | `T-B-351`; the PR statement is in section 8 |
| D-4 | the smoke test's origin | `http://localhost:<port>` for `PUBLIC_BASE_URL` and the `Origin` header, connections to `127.0.0.1` | `T-B-353` |
| D-5 | a break-glass sign-in cannot run in an unconfigured image (409 `setup_required` before a tenant is pinned) | the memory of the 128 MiB scrypt is measured with the same parameters in a 256 MB container; the verification itself is covered by `server/auth/break-glass.test.ts` | `T-B-353` |
| D-6 | image bans by manifest scan only | static `TEST_TOOLING_PACKAGES` and an `EXPECTED_TRANSITIVE` set, each entry a package of plan 4.2 | `T-B-352` |
| D-7 | traceability: Phase B prefix line and `tools/` controls | `parsePrefixTable` reads the prose line when the table is absent; a back-ticked path under `tools/`, `scripts/` or `eslint-rules/` is a test control | `T-B-394` |
| D-8 | the `preview` namespace of the Appearance live preview and the string `'preview'` in the audit read schema | allow-listed by exact path with a reason in the preview-removal scan; four entries | `T-B-393` |

## 7. Findings for other streams (not edited by this task)

| # | Finding | Owner |
|---|---|---|
| F-1 | `deploy/README.md` and `deploy/caddy/Caddyfile.example` carry the Phase A reverse-proxy notes; `deploy-files.test.ts` pins their numbers. The Phase B proxy checklist (preserve `Host`, forward cookies, restrict `/api/v1/auth/break-glass`) belongs there as well as in `docs/operations.md` | no task owns `deploy/`; proposed to `T-B-422` |
| F-2 | `image.yml` remediation texts omit the `VERSION` build argument (Phase A s6b-1) | a workflow edit, conditional XB32 |
| F-3 | the root `README.md` media (`pnpm media`) are produced with `PREVIEW_MODE=true` by `e2e/media/make-readme-media.ts` | `T-B-370` and `T-B-426` |
| F-4 | `docs/adr/0011-...` should say "superseded by Phase B (ADR 0151..)" | `T-B-428` |
| F-5 | the Docker bridge case of the smoke test (CI) is UNVERIFIED here: the script connects to `127.0.0.1:<published port>` with `Origin: http://localhost:<port>`; the setup gate keys on the `Host` header, so it should work, but only `--network host` ran | owner / first CI run |

## 8. Input for `T-B-999` and the gate notes

- Verified command lines (U34 resolved): `docker run --rm -i $IMAGE dist/cli.js generate-app-key`; `docker run --rm -i $IMAGE dist/cli.js hash-password` (password on standard input); `docker exec <container> /nodejs/bin/node dist/cli.js setup-token`. The first form listed in `tasks.md` (`docker run ... IMAGE dist/cli.js <command>`) passed; the `--entrypoint /nodejs/bin/node` form was not needed. The report text `node /app/dist/cli.js` works too (workdir is `/app`).
- Smoke figures (local, 2026-10-12, `--network host`): `/readyz` 200 after 1.6 to 2.2 s; idle RSS 157 to 160 MB; peak RSS 165 to 166 MB after two concurrent 4096-pixel uploads; scrypt `N=131072 r=8 p=1` 444 to 500 ms with peak RSS 173 MB inside a 256 MB container; certificate RSA 2048 valid 360.0 days; image 205.5 MB.
- The statement AGENTS.md demands for the pull request (T-B-351): `APP_KEY` (no default; required once a certificate exists; for `docker run`) or `APP_KEY_FILE` (set by Compose to `/run/secrets/app_key`; the operator creates `secrets/app_key` with `docker run --rm $IMAGE dist/cli.js generate-app-key > secrets/app_key`); `SETUP_TOKEN` (optional, 24 to 128 characters; unset: the file `/data/setup-token`); `BOOTSTRAP_CLIENT_ID`, `SETUP_PROPAGATION_TIMEOUT_SECONDS` 900, `SESSION_IDLE_TIMEOUT_MINUTES` 30, `SESSION_ABSOLUTE_TIMEOUT_HOURS` 8, `GROUP_CACHE_TTL_SECONDS` 300, `AUTH_REQUIRE_MFA` true, `AUTH_MFA_AMR_VALUES` `mfa,multipleauthn`, `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` (both or neither), `APP_KEY_PREVIOUS` and `APP_KEY_PREVIOUS_FILE` (only during rotation): defaults are in `.env.example`, none must be added by hand except the key. The Compose mapping lines: `secrets: [app_key]` on the service, `APP_KEY_FILE: /run/secrets/app_key` in `environment`, and the top-level `secrets: app_key: file: ./secrets/app_key`. `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` can be removed from an existing `.env` (ignored with one warning). An existing Phase A deployment that keeps its own Compose file and `.env` keeps working untouched, except that it starts `unconfigured` (the panel answers the setup gate, and the former open administration is gone). Adopting the new Compose file needs the key file once.
