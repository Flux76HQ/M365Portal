# Chunk note s6a (T-A-230, T-A-232, T-A-233, T-A-234): open points, assumptions, risks

Written by the `s6a` worker (stream S6, early part) for S8's consolidation (`T-A-278`) and for the
workers of `T-A-231`, `T-A-235`, `T-A-236` and the S7 image job. There is no gate task in this range
(`G6` is `T-A-237`).

## Done, and how it was proven

| Task | Files | Proof |
|---|---|---|
| T-A-230 | `.env.example`, `.dockerignore`, `apps/server/test/deploy-files.test.ts` (part 1) | Test written first and seen red (`ENOENT .env.example`), then green. 55 tests: parity of `.env.example` with `ENV_VARIABLES` plus `HOST_PORT` (16 negative fixtures, among them the fixture schema with one more variable), `.env` ignored and `.env.example` tracked (asked of real `git check-ignore` in a throwaway repository, 2 negatives), `.dockerignore` evaluated with Docker's matching rules (9 negatives, 15 matcher cases) |
| T-A-232 | `docker-compose.yml`, `deploy-files.test.ts` (part 2) | Red first (`ENOENT docker-compose.yml`), then green. 37 structural tests (31 negative fixtures, among them "a file without `read_only`"), 9 tests of the YAML reader (8 negatives) and 12 tests that run `docker compose config` for no `.env`, `HOST_PORT=9090`, `PORT=9090`, both (different and equal values), an explicit `PUBLIC_BASE_URL`, `.env.example` copied unchanged, and `config -q` with and without `.env` |
| T-A-233 | `deploy/README.md`, `deploy/caddy/Caddyfile.example`, `deploy-files.test.ts` (part 3) | Red first (`ENOENT deploy/README.md`), then green: 23 tests (links and anchors resolve, every "N bytes" is a value of `LIMITS`, the required numbers are stated, 16 negative fixtures for the README and the Caddy example). `docs-contract.test.ts` and `limits-doc.test.ts` belong to S8 and do not exist yet, so they were **not run** |
| T-A-234 | `scripts/check_image_contents.py`, `scripts/check_image_size.py`, both `test_*.py` | Red first (`ModuleNotFoundError`), then green: 61 + 20 tests. 10 mutations of the scripts (rule switched off, ceiling changed, boundary `<=` to `<`, container not removed) each turn at least one test red. **Not run against a real image**: that is `T-A-236` |

Commands (live tree and a clean copy built from `git ls-files -co --exclude-standard`, frozen install
under the install lock): `pnpm --filter @m365portal/server exec vitest run test/deploy-files.test.ts
--maxWorkers=1` gives 136 passed, 1 skipped; `eslint test/deploy-files.test.ts --max-warnings 0`
and `tsc -p tsconfig.json --noEmit` in `apps/server` are clean; `python3 -m unittest discover -s
scripts` gives 117 tests OK (36 before); `prettier --check` is clean for every file of this chunk;
`packages/shared` `repo-conventions` and `single-implementation` (482 tests) and `tools/workspace-deps`
(31) stay green. No dependency was added: the Compose file is read by a small YAML reader inside the
test (it refuses anchors, tags, block scalars, flow mappings, tabs and duplicate keys), and Docker
itself is the second reader through `docker compose config`.

The one skipped test is conditional on purpose: "lets every COPY of the real Dockerfile through" runs
as soon as `Dockerfile` exists (`T-A-231`). Without the Compose plugin the 12 `docker compose config`
tests are skipped with a printed reason, and `REQUIRE_DOCKER=1` turns the missing plugin into a failure
(both behaviours were run).

## Decisions the next workers must know about

1. **`.env.example` format** (the parser in `deploy-files.test.ts` is the definition): `NAME=value`
   is an active line, `#NAME=value` (no space) is a variable left unset on purpose, `# prose` is a
   comment that must not look like an assignment. The first paragraph is the header and names
   `HOST_PORT` as Compose-only; `HOST_PORT` comes first, with "not read by the application". Every
   value is the schema default. **`PUBLIC_BASE_URL` is the one commented line**: Compose derives it
   from `HOST_PORT`, and an active line would break a change of `HOST_PORT` alone (every write would
   be refused, A-31). S8: the environment table of `docs/operations.md` can be built from this file.
2. **Compose passes on every schema variable except `HOST` and `DATA_DIR`.** Settings without a
   default use the bare form (`TRUST_PROXY:`), which Compose fills from `.env` and omits when unset,
   so the application's own default is the only default (checked with Compose v5.6.0). `PORT` and
   `PUBLIC_BASE_URL` carry the defaults FR-A-016 prescribes. `HOST` and `DATA_DIR` are fixed by the
   image (`DATA_DIR` must match the volume, `HOST` must stay `0.0.0.0` for a published port); both
   are listed in `.env.example` with the sentence "docker-compose.yml does not pass this variable
   on", and the test enforces that sentence. The test also fails when `.env.example` lists a variable
   that Compose silently ignores.
3. **Quote style.** Prettier (`singleQuote`) rewrites the YAML, so the mapping is written
   `- '${HOST_PORT:-8080}:${PORT:-8080}'`. The value is the one of FR-A-016; only the quotes differ
   from the task text. Anything that greps `docker-compose.yml` for the double-quoted form fails
   `format:check` if it forces it.
4. **`.dockerignore` and `e2e`.** `e2e` is excluded as `T-A-230` says, but `!e2e/package.json` is
   re-included: plan 12.1 has the build copy every workspace manifest (the workspace lists `e2e`) so
   the frozen lockfile install matches. `**/` prefixes are needed because Docker matches from the
   context root. `VERSION` is not excluded. `.env.example` is excluded with `.env*` (the image has no
   use for it). `T-A-231`: no `COPY` of `docs`, `specs`, `.github`, `.git`, `e2e/**` other than the
   manifest, or any `.env*`; the conditional test tells you when it does.
5. **Image contents rules** (`check_image_contents.py`; constants at the top of the script are the
   places to change deliberately): `/app` may hold only `node_modules package.json dist drizzle web`;
   `app/package.json`, `app/dist/index.js`, `app/dist/healthcheck.js`, `app/web/index.html` and
   `app/drizzle/meta/_journal.json` must exist; `/data` exists, is a directory owned by 65532:65532
   and is empty; `Config.User` is exactly `65532:65532`; the six OCI labels are present, `version`
   is `MAJOR.MINOR.PATCH`, `created` is RFC 3339, and `org.opencontainers.image.licenses` is
   **absent** (FR-A-163 until OD-01); `Healthcheck.Test` is exactly `["CMD", "/nodejs/bin/node",
   "dist/healthcheck.js"]` with interval, timeout and retries set; exactly one exposed `tcp` port
   equal to the `PORT` variable (1024 to 65535, no literal port in the script); `NODE_ENV=production`,
   `DATA_DIR=/data`, `Entrypoint ["/nodejs/bin/node"]`, `Cmd ["dist/index.js"]`, `WorkingDir /app`, no
   `Volumes`. The "own tree" rules (test files, source maps, lock files, key material) skip the base
   image directories and `node_modules`. Development dependencies are the `devDependencies` of every
   workspace manifest plus the web dependencies, minus the server's production dependencies, found by
   name under `node_modules` (also in the pnpm store layout); `@m365portal/*` is reported separately
   as a workspace package that must have been inlined.
6. **Image size**: `CEILING_MEGABYTES = 400` in `check_image_size.py`, megabytes of 1,000,000 bytes (as
   `docker images` prints), compared with `Size` of `docker image inspect`. A Python test compares
   the constant with `imageSizeCeilingMegabytes` in `packages/shared/src/limits.ts`, so the two
   cannot drift. The failure text names `docker history` and both files to change.
7. **Command lines** (for `T-A-235`, `T-A-236`, `T-A-254`): `python scripts/check_image_contents.py
   [IMAGE]` and `python scripts/check_image_size.py [IMAGE]`, default `m365portal:local`; offline
   forms `--tar FILE --inspect-json FILE` and `--inspect-json FILE` / `--size-bytes N`. Exit 0 clean,
   1 findings (all printed to stderr, each with its rule and FR), 2 when Docker or an input could not
   be read (never a pass). The contents script creates a container with `docker create` (never
   started), reads `docker export` as a stream and always runs `docker rm -f`.
8. **Caddy example.** Written after the directive names were checked against Caddy's own
   documentation on 2026-10-10 (sources: the website repository of `reverse_proxy`, `request_body`
   and `automatic-https`; `max_size` against the go-humanize source: a bare number is bytes, `MB` is
   1,000,000 and `MiB` 1,048,576). The facts used: `request_body { max_size }`; `reverse_proxy` with
   `transport http { keepalive <duration> }` (default 2m, and the documentation itself warns about
   502 when it exceeds the upstream's keep-alive timeout); `Host` passed through by default;
   `X-Forwarded-*` set by Caddy and ignored from clients unless `trusted_proxies`; automatic HTTPS for
   a public DNS name with ports 80 and 443 open. The example uses `max_size 9437184` and
   `keepalive 60s` (below the panel's 65 s).

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| s6a-1 | `Dockerfile` must satisfy the contents rules above. Known collision: `apps/server/build.mjs` has `sourcemap: true`, so `dist/index.js.map` exists unless the Dockerfile deletes `*.map` from `dist` and `web` before copying (a `.map` in `/app` fails the check). `WORKDIR /app`, `ENV NODE_ENV=production PORT=8080 DATA_DIR=/data`, `USER 65532:65532`, `EXPOSE`, the six labels, `HEALTHCHECK` with the exact exec form, `CMD ["dist/index.js"]`, no `VOLUME`, `/data` created and chowned. If the layout differs on purpose, change the constants of the script in the same change | T-A-231 worker | now |
| s6a-2 | `check_image_contents.py` and `check_image_size.py` were **never run against a real image or a real `docker export`**; the Docker daemon was not running in this sandbox, so the live path was tested against a fake `docker` program on PATH and the stream reader against tar files built with `tarfile`. Expect to adjust a rule at the first real run (a third-party package that ships a `.env` file or a development tool name is the likely false positive; `ALLOWED_PACKAGES` exists for that, empty, with a reason next to every entry) | T-A-236 | the first real run |
| s6a-3 | The size ceiling is still the initial 400 MB; FR-A-168 says it is recorded after the first build (probe: 197 MB). Record the real figure in the G6 note and recalibrate both constants together | T-A-236 / T-A-237 | after the first build |
| s6a-4 | `docs/operations.md` must keep the heading "Limits outside the repository" (the anchor `limits-outside-the-repository` is cited by AGENTS.md and linked from `deploy/README.md`; the part-3 test checks the link). Its environment table should equal `.env.example` (HOST_PORT included) and its limits table `LIMITS`; its Dutch section and the deploy notes should agree on the numbers | S8 | `T-A-270`, `T-A-276`, `T-A-277` |
| s6a-5 | `docs-contract.test.ts` and `limits-doc.test.ts` have not seen `deploy/README.md` or `deploy/caddy/Caddyfile.example`. The README writes the largest request as "at least 9,437,184 bytes" in English and "9437184 bytes" in the Dutch section (no thousands separators, so one pattern `\d[\d,]*` reads both); the Caddy file has `max_size 9437184` and the grouped form in a comment. Align the extraction with that, or tell this stream what format is wanted | S8 | `T-A-270` |
| s6a-6 | `docker compose config` with a nested default (`${PUBLIC_BASE_URL:-http://localhost:${HOST_PORT:-8080}}`) was proven with Compose v5.6.0 only (PA-16: UNVERIFIED for older v2 plugins). CI sets `REQUIRE_DOCKER=1` so the runner's plugin decides; the `image` job and the quality job need Docker available for these tests | S7 (`T-A-252`, `T-A-254`) | workflows |
| s6a-7 | `REQUIRE_DOCKER=1` has to be set in the CI job that runs `apps/server` tests (otherwise the 12 compose tests are skipped silently apart from one console warning), and `git` must be on PATH there (3 tests ask it about `.gitignore`) | S7 | `T-A-252` |
| s6a-8 | Caddy was not run (not installed here, not part of the sandbox): the example is verified for directive names and documented behaviour, not executed. If an owner wants it proven, run `caddy validate --config deploy/caddy/Caddyfile.example` with a real name substituted. No UNVERIFIED row was added to `docs/open-points.md` because the file exists; S8 may add one for the behaviour | S8 / owner | optional |
| s6a-9 | The Dutch text of `deploy/README.md` is mine and unreviewed by the owner | owner | phase report |
| s6a-10 | `VERSION` has to be bumped by the orchestrator at commit time: `.env.example`, `.dockerignore`, `docker-compose.yml`, `deploy/`, `scripts/` and `apps/` are protected paths | orchestrator | commit |

## Assumptions

- A named volume is initialised from the image's `/data` (content and ownership 65532) on first use, so
  `read_only: true` works with `data:/data` without a `chown`; a bind mount needs `chown 65532:65532`
  (docs). `tmpfs: [/tmp]` is mode 1777 and writable by 65532. Not run here (no daemon): `T-A-236`.
- `Config.User` of the built image is the literal `65532:65532` because the Dockerfile writes both
  ids (the base image alone would report `65532`).
- The first Docker health check runs after one interval (30 s), so `docker compose ps` shows
  "healthy" after about half a minute, not after the 20 s start period.
- `deploy/` and `docs/` are exempt from the stray-port check of `repo-conventions` (they are prose),
  so the README and Caddy example may write `8080`; the scripts and the YAML do not.

## Risks

- `.dockerignore` is a contract with the Dockerfile: a `COPY` of an excluded path fails the build with
  "not found". The conditional test goes live with the Dockerfile and catches it before a build does.
- The `.env.example` parser is strict by design (a line `# NAME=value` is refused as ambiguous). A
  maintainer who writes prose starting with a variable name and an equals sign gets a clear message,
  but gets it.
- Compose reads the shell environment before `.env`: an exported `PORT` or `HOST_PORT` on the Docker
  host overrides the file. The part-2 tests run Compose with a clean environment on purpose, so they
  do not depend on the machine.
- The YAML reader of the test is deliberately small; a Compose feature outside its subset (anchors,
  long-form ports, a mapping inside a list) is refused with a line number, not misread.
- A third-party package that ships `.git` data or a name in the development list would fail the
  contents check (see s6a-2).

## Text for the pull request (AGENTS.md, "Deployment-file changes must be spelled out")

This change adds `.env.example` and `docker-compose.yml` for the first time, so no existing
deployment is affected.

- Operator-facing variable: `HOST_PORT`, default `8080`, Compose only (the application never reads
  it); it is in `.env.example` and is optional. `PUBLIC_BASE_URL` follows it automatically as long as
  `.env` leaves `PUBLIC_BASE_URL` unset (it is deliberately a commented line in `.env.example`).
- Exact Compose mapping line: `- '${HOST_PORT:-8080}:${PORT:-8080}'`; `PORT` is passed on as
  `${PORT:-8080}` and `PUBLIC_BASE_URL` as `${PUBLIC_BASE_URL:-http://localhost:${HOST_PORT:-8080}}`.
- No existing deployment keeps or loses anything: there was none. A new Compose deployment works with
  no `.env` at all.
- Limits stated as numbers: the largest request the application accepts is 9,437,184 bytes, so
  whatever sits in front must allow at least that; the application's keep-alive is 65 s, so a proxy
  must idle its upstream connections shorter than that; `docker stop` must allow at least 10 s (the
  Compose file asks for 15 s). No limit was raised.
