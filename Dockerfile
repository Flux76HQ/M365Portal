# M365Portal image (FR-A-016, FR-A-160 to FR-A-165, plan 12.1; Phase D: FR-D-106, ADR 0180). Three
# stages, every `FROM` pinned by digest; the runtime is Ubuntu 24.04 LTS, because Microsoft documents
# PowerShell and the ExchangeOnlineManagement module for Ubuntu LTS (research R-D-03) and not for
# distroless. The Exchange worker is `pwsh` (version and SHA-256 pinned) plus the module (version and
# SHA-512 pinned), fetched in a stage of its own so that the runtime holds no `curl` and no `unzip`.
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
# The image runs as uid 65532 and writes only to /data (and a tmpfs /tmp when the root file system is
# read-only). It has a shell (Ubuntu) but no curl and no package manager use at run time. Re-resolve
# the digests with `docker buildx imagetools inspect <image:tag>` before bumping them (checked
# 2026-10-12 for node, 2026-10-13 for ubuntu). To bump PowerShell or the module, change the version
# AND the checksum together (`hashes.sha256` of the GitHub release; `PackageHash` of the gallery,
# base64 to hex); the build fails on a mismatch, and scripts/check_dockerfile_pins.py fails on an
# unpinned or half-pinned value.

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
# PowerShell and the Exchange Online module (FR-D-106, R-D-03). Nothing here reaches the runtime
# stage but the two directories it COPYs.
# ---------------------------------------------------------------------------------------------
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS pwsh-fetch

ARG TARGETARCH
# PowerShell 7.6 is the LTS line that module 3.10.x needs (Learn: PowerShell 7.6.0 or later on Ubuntu 24.04).
ARG POWERSHELL_VERSION=7.6.6
ARG POWERSHELL_SHA256_AMD64=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc
ARG POWERSHELL_SHA256_ARM64=924829e54c983648f6f1419a2dc7f9433c861b2fb5bd57736ff096c24f133729
# Two .NET libraries that PowerShell 7.6.6 and the module 3.10.1 ship in an affected version (CVE-2026-84008 for
# Pkcs; CVE-2026-96958, -96959 and -96960 for Xml; fixed in 10.0.13). They are replaced by the 10.0.13 builds from
# nuget.org, pinned by SHA-512 (the hashes equal the packageHash of the nuget.org catalog). Remove the block that
# uses them, and these three ARGs, when a PowerShell and a module with 10.0.13 or later are pinned.
ARG DOTNET_FIX_VERSION=10.0.13
ARG PKCS_SHA512=287ebdda7d50947e352c62c28add71012c60f50124cbd558f0d383bfa83357f7941c55d54ef4432c9cacb0c19a3314bd59f217c899d22e0c5e23c3fcf9d74b8a
ARG XML_SHA512=11bc9f42b385c9f35366412d912283fbe6c5eb02f0a0a4f8906aeb5d5f250876aa2d0af03eec66f5c18e9d7cd7c42039cfb9990fa0b9c2661224ffd67735e1e5
ARG EXO_VERSION=3.10.1
ARG EXO_SHA512=68f973f2dfc629df7a7910fa63c7ae4d01708cab7376b688df6df1d18d68a39c456bc09041ec6eefabd527d516ec5c41c67cd5479601c084ff2b38f63e75a8eb

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl openssl unzip \
 && rm -rf /var/lib/apt/lists/*

# Behind a TLS-inspecting proxy the same optional BuildKit secret as above is the CA bundle for curl.
RUN --mount=type=secret,id=extra_ca \
    set -eu; \
    if [ -s /run/secrets/extra_ca ]; then export CURL_CA_BUNDLE=/run/secrets/extra_ca; fi; \
    case "${TARGETARCH}" in \
      amd64) arch=x64;   sha="${POWERSHELL_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${POWERSHELL_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH '${TARGETARCH}': expected amd64 or arm64" >&2; exit 1 ;; \
    esac; \
    curl --fail --silent --show-error --location --retry 3 \
      --output /tmp/powershell.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-${arch}.tar.gz"; \
    echo "${sha}  /tmp/powershell.tar.gz" | sha256sum --check --strict -; \
    mkdir -p /opt/microsoft/powershell/7; \
    tar --extract --gzip --file /tmp/powershell.tar.gz --directory /opt/microsoft/powershell/7; \
    chmod 0755 /opt/microsoft/powershell/7/pwsh; \
    rm /tmp/powershell.tar.gz

# The module is a NuGet package (a zip). It is unpacked into the shared module path of PowerShell on
# Linux; the Windows PowerShell assemblies (netFramework) are not used by pwsh and are left out.
RUN --mount=type=secret,id=extra_ca \
    set -eu; \
    if [ -s /run/secrets/extra_ca ]; then export CURL_CA_BUNDLE=/run/secrets/extra_ca; fi; \
    curl --fail --silent --show-error --location --retry 3 \
      --output /tmp/exo.nupkg \
      "https://www.powershellgallery.com/api/v2/package/ExchangeOnlineManagement/${EXO_VERSION}"; \
    echo "${EXO_SHA512}  /tmp/exo.nupkg" | sha512sum --check --strict -; \
    module="/usr/local/share/powershell/Modules/ExchangeOnlineManagement/${EXO_VERSION}"; \
    mkdir -p "${module}"; \
    unzip -q /tmp/exo.nupkg -d "${module}"; \
    rm -rf "${module:?}/_rels" "${module:?}/package" "${module:?}/netFramework" "${module:?}/[Content_Types].xml" "${module:?}"/*.nuspec; \
    test -f "${module}/ExchangeOnlineManagement.psd1"; \
    rm /tmp/exo.nupkg

# Fixed System.Security.Cryptography.Pkcs and .Xml (10.0.13). PowerShell loads ITS OWN copies of both, and the module
# carries a Pkcs copy as well: scripts/patch-dotnet-libraries.sh replaces them and keeps the deps.json files truthful.
# The build fails when PowerShell or the module no longer ships the versions the script expects.
COPY --chmod=0755 scripts/patch-dotnet-libraries.sh /tmp/patch-dotnet-libraries.sh
RUN --mount=type=secret,id=extra_ca \
    set -eu; \
    if [ -s /run/secrets/extra_ca ]; then export CURL_CA_BUNDLE=/run/secrets/extra_ca; fi; \
    for package in pkcs xml; do \
      case "${package}" in pkcs) sha="${PKCS_SHA512}" ;; xml) sha="${XML_SHA512}" ;; esac; \
      curl --fail --silent --show-error --location --retry 3 \
        --output "/tmp/${package}.nupkg" \
        "https://api.nuget.org/v3-flatcontainer/system.security.cryptography.${package}/${DOTNET_FIX_VERSION}/system.security.cryptography.${package}.${DOTNET_FIX_VERSION}.nupkg"; \
      echo "${sha}  /tmp/${package}.nupkg" | sha512sum --check --strict -; \
    done; \
    /tmp/patch-dotnet-libraries.sh "${DOTNET_FIX_VERSION}" /tmp/pkcs.nupkg /tmp/xml.nupkg \
      /opt/microsoft/powershell/7 \
      "/usr/local/share/powershell/Modules/ExchangeOnlineManagement/${EXO_VERSION}/netCore"; \
    rm /tmp/pkcs.nupkg /tmp/xml.nupkg /tmp/patch-dotnet-libraries.sh

# ---------------------------------------------------------------------------------------------
# Runtime stage: Ubuntu 24.04 LTS, glibc, non-root. Node comes from the build stage's image, at the
# path the distroless image had (/nodejs/bin/node), so the entry point, the health check and the
# `docker exec` command of the documentation stay as they were.
# ---------------------------------------------------------------------------------------------
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

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

# What Node (glibc, libstdc++) and .NET need on Ubuntu 24.04 (Learn, .NET on Ubuntu): ICU, OpenSSL 3,
# Kerberos, zlib and the CA bundle. The packages are the Ubuntu archive's current versions (the base
# image is pinned by digest, the archive is not): Trivy and Dependabot cover them. The user 65532 is
# created by name `nonroot`, no home directory (the worker gets one under /tmp), no login shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libgcc-s1 libgssapi-krb5-2 libicu74 libssl3t64 libstdc++6 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 nonroot \
 && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin nonroot

COPY --from=build /usr/local/bin/node /nodejs/bin/node
COPY --from=pwsh-fetch /opt/microsoft/powershell/7 /opt/microsoft/powershell/7
COPY --from=pwsh-fetch /usr/local/share/powershell/Modules /usr/local/share/powershell/Modules

# /app holds the bundle (dist/), the migrations (drizzle/) and the web output (web/) side by side;
# the server looks for all three relative to dist/. dist/exchange/worker-script.ps1 is the Exchange
# worker. A named volume on /data inherits this owner.
COPY --from=build --chown=65532:65532 /app /app
COPY --from=build --chown=65532:65532 /data /data

WORKDIR /app
ENV NODE_ENV=production PORT=9300 DATA_DIR=/data \
    POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
USER 65532:65532
EXPOSE ${PORT}

# Exec form, no shell: the script asks /readyz on 127.0.0.1:$PORT, so an unusable volume shows as
# unhealthy. Compose repeats it (docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/healthcheck.js"]

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/index.js"]
