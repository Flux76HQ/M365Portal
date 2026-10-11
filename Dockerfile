# M365Portal image (FR-A-016, FR-A-160 to FR-A-165, plan 12.1). Two stages, both pinned by digest.
#
#   docker build --build-arg VERSION="$(cat VERSION)" -t m365portal:local .
#
# VERSION is the only build argument CI passes (revision and created arrive as --label). When it is
# given it must equal the VERSION file or the build fails; when it is left out the image still
# builds, but its version label says "unknown" and `scripts/check_image_contents.py` and the
# container smoke test refuse it, so pass it.
#
# Behind a TLS-inspecting proxy, mount the proxy CA as the optional BuildKit secret `extra_ca`:
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.crt ...
# It is exported as NODE_EXTRA_CA_CERTS for the install step only and never enters a layer.
#
# The image has no shell and no curl, runs as uid 65532 and writes only to /data (and a tmpfs /tmp
# when the root file system is read-only). Re-resolve the digests with
# `docker buildx imagetools inspect <image:tag>` before bumping them (checked 2026-10-11).

# ---------------------------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

ARG TARGETARCH
ARG VERSION=unknown

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true

WORKDIR /src
RUN corepack enable

# Manifests, lockfile, settings and the pnpm patch first, so the install layer is cached until a
# dependency changes. patches/ must be here: the frozen install applies it (@radix-ui/react-select).
# Every workspace manifest is needed, e2e/ included, so that the frozen lockfile matches.
COPY VERSION package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY e2e/package.json ./e2e/

RUN --mount=type=secret,id=extra_ca \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile \
      --filter "@m365portal/server..." --filter "@m365portal/web..."

# Not part of the install layer above, so a version bump does not reinstall anything.
RUN if [ "${VERSION}" != "unknown" ] && [ "${VERSION}" != "$(tr -d '[:space:]' < VERSION)" ]; then \
      echo "VERSION build argument (${VERSION}) differs from the VERSION file ($(cat VERSION))" >&2; exit 1; \
    fi

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm --filter @m365portal/web build \
 && pnpm --filter @m365portal/server build

# The production tree of the server: `pnpm deploy` is blocked in pnpm 10 without --legacy, and it
# copies the whole package directory, so only the pieces named below go to /app.
RUN --mount=type=secret,id=extra_ca \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @m365portal/server deploy --prod --legacy /out

RUN set -eu; \
    mkdir -p /app /data; \
    cp -R /out/node_modules /out/package.json /app/; \
    cp -R apps/server/dist /app/dist; \
    cp -R apps/server/drizzle /app/drizzle; \
    cp -R apps/web/dist /app/web; \
    find /app/dist /app/web -name '*.map' -type f -delete; \
    case "${TARGETARCH}" in \
      amd64) keep=linux-x64.node ;; \
      arm64) keep=linux-arm64.node ;; \
      *) echo "unsupported TARGETARCH '${TARGETARCH}': expected amd64 or arm64" >&2; exit 1 ;; \
    esac; \
    found=0; \
    for sqlite in $(find /app/node_modules -type d -path '*/node_modules/better-sqlite3'); do \
      found=1; \
      rm -rf "${sqlite}/deps" "${sqlite}/src" "${sqlite}/binding.gyp"; \
      find "${sqlite}/prebuilds" -type f ! -name "${keep}" -delete; \
      test -f "${sqlite}/prebuilds/${keep}"; \
    done; \
    test "${found}" = 1; \
    : "autoInstallPeers installs the optional peers of drizzle-orm and sharp (@types/better-sqlite3," ; \
    : "@types/node, undici-types): type declarations nothing loads at runtime. pnpm also leaves a link" ; \
    : "to the workspace package itself (it resolves to /src here, and to nothing in the runtime image)." ; \
    : "Remove both, and whatever link is left dangling."; \
    rm -rf /app/node_modules/.pnpm/@types+* /app/node_modules/.pnpm/undici-types@* \
           /app/node_modules/.pnpm/node_modules/@types /app/node_modules/.pnpm/node_modules/undici-types \
           /app/node_modules/.pnpm/node_modules/@m365portal; \
    find /app/node_modules -xtype l -delete

# ---------------------------------------------------------------------------------------------
# Runtime stage: distroless, glibc, non-root. No shell, no package manager, no curl.
# ---------------------------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

ARG VERSION=unknown
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z

# No `licenses` label until the owner names a licence (FR-A-163, OD-01).
LABEL org.opencontainers.image.title="M365Portal" \
      org.opencontainers.image.description="Self-hosted web panel for managing a Microsoft 365 tenant" \
      org.opencontainers.image.source="https://github.com/Flux76HQ/M365Portal" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# /app holds the bundle (dist/), the migrations (drizzle/) and the web output (web/) side by side;
# the server looks for all three relative to dist/. A named volume on /data inherits this owner.
COPY --from=build --chown=65532:65532 /app /app
COPY --from=build --chown=65532:65532 /data /data

WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
USER 65532:65532
EXPOSE ${PORT}

# Exec form, no shell: the script asks /readyz on 127.0.0.1:$PORT, so an unusable volume shows as
# unhealthy. Compose repeats it (docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/healthcheck.js"]

CMD ["dist/index.js"]
