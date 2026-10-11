# Chunk note s6b (T-A-231, T-A-235, T-A-236, T-A-237): open points, assumptions, risks

Written by the `s6b` worker. The gate note is `G6.md` (figures, R-06, hostile corpus, what runs where).

## Files

`Dockerfile`, `scripts/check_dockerfile_pins.py`, `scripts/test_check_dockerfile_pins.py` (16 tests), `scripts/image-smoke.ts`, `gate-notes/G6.md`, this note. No file of `apps/` or `packages/` was edited.

## Decisions

1. **Build args.** `VERSION` defaults to `unknown`; a value other than `unknown` must equal the `VERSION` file or the build fails (checked in a small layer after the install, so a bump does not reinstall). `REVISION` defaults to `unknown` and `CREATED` to `1970-01-01T00:00:00Z`; CI overrides both with `--label` (chunk-s7a). Without `--build-arg VERSION=...` the label says `unknown` on purpose, so the contents check and the smoke test fail loudly instead of shipping a wrong version.
2. **No `# syntax=` directive**, so a build never pulls the Dockerfile frontend (Docker Hub answered 429 for registry lookups during this work).
3. **Three problems found by the first real run of `check_image_contents.py`** (s6a-2 predicted a false positive; these were true positives): `@types/better-sqlite3` and `@types/node` (+ `undici-types`) in `node_modules/.pnpm` and the workspace link `.pnpm/node_modules/@m365portal/server`. Cause: `autoInstallPeers: true` in the lockfile plus the legacy deploy. The Dockerfile removes them after the copy. The workspace link is not dangling in the build stage (it resolves to `/src/apps/server`), so `find -xtype l -delete` alone did not remove it; it is deleted by name. The script `check_image_contents.py` needed **no change**.
4. **Pruning.** `better-sqlite3/{deps,src,binding.gyp}` and every prebuild except `linux-x64.node` / `linux-arm64.node` (from `TARGETARCH`; any other value fails the build) are removed in every copy of the package under `/app/node_modules`; the build fails if none was found or the kept prebuild is missing. Source maps are deleted from `dist` and `web` (`build.mjs` has `sourcemap: true`, s6a-1).
5. **`EXPOSE ${PORT}`** instead of a second literal: the literal-port guard (`repo-conventions` check 5) allows `8080` in the Dockerfile and expands the variable at build time (inspect shows `8080/tcp`).
6. **Smoke script has no image library.** It writes and reads PNGs itself (zlib + a 60-line reader, colour types 0/2/3/4/6, 8 bit) so the root `scripts/` package needs no dependency (`sharp` belongs to the server). The SVG loader check runs `sharp` inside the container instead. Constants come from `packages/shared/src/limits.ts` (`DEFAULT_PORT`, `LIMITS`), which keeps the literal-port guard green.
7. **Upload rate limit.** `POST /api/v1/branding/assets` has a burst of 3 and one token per 10 s per client; the script models that bucket and waits, otherwise later uploads get 429 and prove nothing (the first version of the check "passed" on 429s; the model fixed that and the large-upload check now demands 200/201 for both).
8. `/readyz` timing is counted from `State.StartedAt` (see G6), the `docker stop` limit of 10 s from the `docker stop` call.

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| s6b-1 | `.github/workflows/image.yml` remediation text and docs: say `docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .`; the plain command gives label `unknown` | S7 / S8 | `T-A-254`, `T-A-270` |
| s6b-2 | Remove the cause of the type packages in the production tree (`autoInstallPeers`); the Dockerfile workaround stays correct either way | S0 | optional |
| s6b-3 | The hostile corpus against the container exists only as a scratch harness (`scratchpad/s6b/hc/hostile-container.test.ts`, 90 lines, reuses `hostile-harness.ts`). If wanted in CI it belongs in S2's/S9's territory as a test guarded by `REQUIRE_DOCKER`/`SMOKE_IMAGE`; I did not add it | orchestrator | before G9 |
| s6b-4 | H-42 `body-9437185-bytes` saw a closed connection instead of the 413 once under load against the container (passed 4 of 4 afterwards). The 413-versus-reset race is inherent to answering before the 9 MiB body is read; if it shows up in CI, the runner (not the server) should accept `closed` as the harness already does for `cutOff` | S2 | if it recurs |
| s6b-5 | Smoke script bridge mode (`-p 127.0.0.1:PORT:PORT`) and arm64 were not executed | CI | `T-A-254` |
| s6b-6 | `docker compose up` was not run; the compose flags are exercised through `docker run` with the same options | CI | `T-A-254` |
| s6b-7 | Environment: the Docker daemon was NOT running when I started (the sandbox note said it was); I started it with the command in the task (`dockerd --iptables=false --bridge=none --ip-masq=false --storage-driver=vfs`, PID in `scratchpad/s6b/dockerd.pid`) and left it running. The vfs driver copies the image per container, and the disk filled up twice (shared with the other agents): `docker builder prune -af` and `docker image prune -f` freed it. Other agents' images (`m365probe:multistage`, `node:22-alpine`) were not touched | orchestrator | n/a |
| s6b-8 | `repo-conventions` check 10 is red because of `apps/server/src/db/migrate.ts:268` (an `eslint-disable` of a local rule), not from this stream | S1 | G-level |

## Assumptions and risks

- The `HTTPS_PROXY` build argument is a predefined Docker build argument (not stored in the image history); the Dockerfile has nothing sandbox-specific.
- `pnpm install` inside the build uses a BuildKit cache mount for the store; CI with `cache-from: type=gha` benefits, a cold cache works.
- The `VERSION` file changed three times while I was working (bumped by the orchestrator); every smoke run therefore needs a build made after the last bump.
- Risk: the `find ... -path '*/node_modules/better-sqlite3'` prune relies on the legacy deploy layout (`.pnpm/better-sqlite3@x/node_modules/better-sqlite3`); a different layout makes the build fail (`found=0`), not silently ship 26 MB.
