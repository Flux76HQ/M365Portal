# ADR-0180: The runtime image moves from distroless to Ubuntu 24.04 with PowerShell and the Exchange Online module

Samenvatting (NL): De runtime-image verlaat distroless en wordt Ubuntu 24.04 (op digest) met PowerShell 7.6.6 en de module ExchangeOnlineManagement 3.10.1 op exacte versie, omdat Exchange Online voor distributielijsten en contacten alleen via PowerShell te beheren is (R-D-03). De image wordt groter: CI mat 538,2 MB (amd64) en de eigenaar besloot op 13-10-2026 tot een plafond van 600 MB (was 400 MB).

## Status

Accepted. Built in step D1 (T-D-117, spec FR-D-106, risk RD-02, option ODB-01 A). **Measured by CI and the size ceiling decided.** CI measured the image at 538.2 MB (amd64, run 38394173673) and on 2026-10-13 the owner decided that the ceiling becomes 600 MB (was 400 MB; ODD-10). The builder had no Docker daemon, so the figures that the first revision of this ADR gave as estimates are replaced below by the measured ones. arm64 and the memory of a long-running worker are not measured.

Source: `specs/004-phase-d/spec.md` FR-D-106, option ODB-01 A and risk RD-02, `specs/004-phase-d/research-microsoft-d.md` R-D-03, ADR-0018 (the decision this one replaces for the runtime stage).

## Context

Phase D writes distribution list members and mail contacts. The Exchange Online REST API for that is not documented for the cmdlets we need; the supported way is the `ExchangeOnlineManagement` module (3.10.x) on PowerShell 7.6 (Learn: PowerShell 7.6.0 or later on Ubuntu 24.04). A distroless Node image has no shell, no `glibc` extras, no `libicu`, and no package manager, and PowerShell cannot run in it. ADR-0018 chose distroless for size and attack surface; that choice cannot hold for D1.

## Decision

1. **Base.** The runtime stage is `ubuntu:24.04` pinned by digest (`FROM ubuntu:24.04@sha256:534baea6...`). Every `FROM` stays pinned by digest; `scripts/check_dockerfile_pins.py` fails the pull request otherwise. The build stage keeps its own pin.
2. **PowerShell.** Not from a package manager (no repository key, no moving version). A separate stage `pwsh-fetch` downloads the release tarball `powershell-7.6.6-linux-{x64,arm64}.tar.gz` from GitHub releases and verifies a SHA-256 written into the Dockerfile as `ARG POWERSHELL_SHA256_AMD64` / `ARG POWERSHELL_SHA256_ARM64` in the same `RUN`. The runtime copies only `/opt/microsoft/powershell/7`.
3. **Module.** The `ExchangeOnlineManagement` 3.10.1 package is fetched from the PowerShell Gallery as a `.nupkg`, verified against `ARG EXO_SHA512` in the same `RUN`, unpacked into the module path, and stripped of what Linux does not use (the `netFramework` folder). `Install-Module` is not used; if it ever is, `-RequiredVersion` is mandatory (checked by the pin script).
4. **Still the same container.** Non-root (uid 65532, user `nonroot`), read-only root file system, `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`. The entry point stays `/nodejs/bin/node` and the command `dist/index.js`, so compose files, the health check and the smoke test do not change. The worker script ships at `dist/exchange/worker-script.ps1`.
5. **Runtime libraries** come from the Ubuntu archive with `apt-get install --no-install-recommends` in the runtime stage (`ca-certificates libgcc-s1 libgssapi-krb5-2 libicu74 libssl3t64 libstdc++6 zlib1g`). They are **not pinned by version**: the base digest pins the archive state at the time the digest was resolved, `apt-get update` then fetches the current state of the `noble` pocket. This is a gap, recorded in the gate note. The alternative (a snapshot mirror, or copying the libraries from the build stage by digest) was not chosen for D1.
6. **Telemetry off.** `POWERSHELL_TELEMETRY_OPTOUT=1` and `DOTNET_CLI_TELEMETRY_OPTOUT=1` are image `ENV`, and `scripts/check_image_contents.py` checks them.
7. **No seccomp profile in D1.** The plan did not require one; the container keeps Docker's default profile. Revisit if the owner's hardening review asks for it.
8. **Checks.** `scripts/check_dockerfile_pins.py` (exact versions, full-length checksums, a checksum in the same `RUN` as each download, no PowerShell from a package manager), `scripts/check_image_contents.py` (pwsh, the module manifest and the worker script present; no other module version; no `netFramework`), `scripts/image-smoke.ts` (a worker ping inside the restricted container), and the arm64 step of `.github/workflows/image.yml` (the same ping, `continue-on-error`).

## Consequences

- **Size.** The distroless image measured 193.5 MB at gate G6 (Phase A, `specs/001-m365portal/gate-notes/G6.md`) against the old ceiling of 400 MB. Known additions: PowerShell about 180 MB and the module about 40 MB after removing `netFramework` (both measured as unpacked components), plus the Ubuntu base and the runtime libraries. **Measured by CI: 538.2 MB** (amd64, run 38394173673), inside the range that was estimated before the build (500 to 550 MB). That was over the old ceiling of 400 MB, so only the size check failed in that run (the container smoke test passed 33 of 34).
- **Ceiling decision.** The ceiling is the owner's number (RD-02). On 2026-10-13 the owner decided: **600 MB** (`LIMITS.imageSizeCeilingMegabytes` in `packages/shared/src/limits.ts` and `CEILING_MEGABYTES` in `scripts/check_image_size.py`, compared by a test), a margin of 61.8 MB over the measured size. It was 400 MB for the distroless image.
- **Start time.** `pwsh` starts lazily on the first Exchange call, not with the server (FR-D-104). The first call pays the PowerShell start and the module import. Measured by CI (amd64, inside the restricted container): `/readyz` answered 200 after 1,184 ms; the Exchange worker answered a ping in 1,473 ms (module 3.10.1, PowerShell 7.6.6); resident memory 148 MB idle and 173 MB at the peak during two concurrent largest uploads; `docker stop` exited 0 in 152 ms. Not measured: the memory of a long-running worker (U84).
- **Attack surface.** A shell and a package database are now in the image. There is no `curl`, `unzip` or compiler in the runtime stage (they stay in `pwsh-fetch`), and the user cannot write outside `/data` and `/tmp`.
- **Supply chain.** Two downloads (PowerShell release, Gallery package) are verified by checksum written in the repository, so a changed upstream file fails the build. A bump is a deliberate edit of three ARGs and the module version constants, which `check_image_contents.py` compares.
- **arm64.** The arm64 archive has its own checksum; whether PowerShell and the module start under QEMU is not proven and arm64 was not measured (the CI step is `continue-on-error`).

## Evidence

- `scripts/test_check_dockerfile_pins.py` (29 tests, negatives for floating versions, short checksums, a download without a checksum, `Install-Module` without `-RequiredVersion`, PowerShell from `apt`), `scripts/test_check_image_contents.py` (79 tests).
- `apps/server/test/exchange/real-pwsh.test.ts` ran the real worker script on PowerShell 7 (not in the image) and passed 10 tests, including the tmpfs hand-over file with mode 0600 removed again.
- Not verified: `docker build`, `pnpm image:smoke`, `check_image_size.py`, the arm64 ping and any size or time figure. They need a Docker daemon and are listed in `specs/004-phase-d/gate-notes/GD1-server-a.md`.
