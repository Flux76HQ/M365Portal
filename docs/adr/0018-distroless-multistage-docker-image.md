# ADR-0018: Multi-stage Docker build on a distroless Node 22 runtime, uid 65532 (D18)

Samenvatting (NL): Multi-stage Docker-build met een distroless Node 22-runtime, uid 65532, beide basisimages op digest.

## Status

Accepted

Source: plan section 6.1, row D18.

## Context

The image must be small, run as a non-root user and survive a read-only root filesystem with all capabilities dropped.

## Decision

Build on `node:22-bookworm-slim`, run on `gcr.io/distroless/nodejs22-debian12:nonroot`, both by digest. uid 65532; `/data` owned by 65532; `HEALTHCHECK` through a Node script; OCI labels; multi-arch in CI; a hardened Compose example; Bicep in Phase D. **Phase D may change the runtime base if it needs `pwsh`** (BC-10, OD-07): a distroless image has no shell and no PowerShell.

## Consequences

Builder (22.23.3) and runtime (22.22.0) Node patch versions differ. `pnpm deploy --prod` ships type packages through `autoInstallPeers`; the Dockerfile deletes them after the copy (`G6.md` open point 2). The arm64 build was never built or run here (PR-06).

## Evidence

- Plan 6.1 row D18; probe section 7.
- `G6.md`: clean build of 2026-10-11, 193.5 MB against the 400 MB ceiling; smoke 21 of 21; `docker stop` exit 0 in 81 to 114 ms; healthy with the default port and with `PORT=18080`; read-only rootfs with `--cap-drop ALL` works.
- Not verified: arm64, bridge networking, GHCR push (`G6.md`).
