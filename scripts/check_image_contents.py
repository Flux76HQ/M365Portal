#!/usr/bin/env python3
"""Check what the built image holds and how it is configured (FR-A-164, FR-A-160 to FR-A-163, FR-A-165).

The image must hold no `.env` file, no `.git` data, no test files, no source maps, no lock files, no
key material and no development dependencies, only the production build output and the production
dependencies under /app, and an empty /data owned by 65532. Its configuration must say: user
65532:65532, the six OCI labels (and no `licenses` label until the owner names a licence), a health
check that runs the Node script without a shell, one exposed TCP port equal to PORT, and no VOLUME.

Two documents are read, both produced by Docker and both usable as saved files, so the checks run
(and are tested) without Docker:

    docker image inspect IMAGE            the configuration
    docker create IMAGE; docker export    the file system, a tar stream

    python scripts/check_image_contents.py                     the local build, m365portal:local
    python scripts/check_image_contents.py IMAGE               another image
    python scripts/check_image_contents.py --tar FILE --inspect-json FILE     saved documents

The rules look only at our own tree: files of the base image (/etc, /usr, ...) and of third-party
packages inside node_modules are not ours to remove, so a test fixture or a source map shipped by a
dependency is not a finding. Development dependencies and workspace packages are looked for inside
node_modules, by name.

Exit status: 0 clean, 1 findings (every one is printed), 2 when a document could not be read or
Docker could not be run. A document that cannot be read is never a pass.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterable

DEFAULT_IMAGE = "m365portal:local"

RUNTIME_ID = 65532
RUNTIME_USER = f"{RUNTIME_ID}:{RUNTIME_ID}"

APP_ROOT = "app"
DATA_ROOT = "data"

# What the Dockerfile copies into /app (plan 12.1): the production dependencies, the manifest, the
# server bundle, the migrations and the built web application. Anything else is a leak of the source
# tree. A deliberate change to the image layout changes this constant in the same pull request.
APP_ROOT_ENTRIES = frozenset({"node_modules", "package.json", "dist", "drizzle", "web"})

# Files the image runs: the server bundle, the health check script, the manifest, the shell
# template (a missing one is a broken build, plan 7.1 step 3) and the migration journal.
REQUIRED_FILES = (
    "app/package.json",
    "app/dist/index.js",
    "app/dist/healthcheck.js",
    "app/web/index.html",
    "app/drizzle/meta/_journal.json",
)

# Directories of the base image. They are not ours: the rules for our own tree skip them.
BASE_IMAGE_ROOTS = frozenset(
    {"etc", "usr", "lib", "lib64", "var", "nodejs", "bin", "sbin", "sys", "proc", "dev", "run"}
)

TEST_DIRECTORIES = frozenset(
    {"test", "tests", "__tests__", "e2e", "coverage", "playwright-report", "test-results", "blob-report"}
)
LOCK_FILES = frozenset(
    {"pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"}
)
SECRET_FILE = re.compile(
    r"^(?:\.npmrc|\.netrc|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.(?:pem|key|pfx|p12|jks|keystore)"
    r"|app[-_]key(?:\..*)?)$"
)
# Phase B (FR-B-706, FR-B-707): the fake tenant and its test hooks, the setup token file and a database
# never belong in the image. The token file is `setup-token` in the data directory (SETUP_TOKEN_FILE_NAME).
TEST_HOOK_NAME = re.compile(r"fake-tenant", re.I)
SETUP_TOKEN_FILE = re.compile(r"^setup-token(?:\.(?:txt|token|lock|tmp))?$")
DATABASE_FILE = re.compile(r".*\.(?:sqlite|sqlite3|db)(?:-wal|-shm|-journal)?$")

# The tools of development. The list is read from the package manifests of the repository; this one
# is the fallback when no manifest can be read.
BUILT_IN_DEV_PACKAGES = frozenset(
    {
        "vitest", "typescript", "typescript-eslint", "eslint", "@eslint/js", "prettier", "esbuild", "tsx",
        "drizzle-kit", "vite", "@playwright/test", "playwright", "@types/node", "happy-dom", "jsdom",
        "@testing-library/react", "@testing-library/dom", "@tailwindcss/vite", "tailwindcss",
    }
)
# Packages that arrive with the direct production dependencies of Phase B (plan 4.2) and are therefore
# expected in the image: @azure/msal-node brings @azure/msal-common and jsonwebtoken (a certificate
# path this product never configures) with its own tree, and @peculiar/x509 brings the ASN.1 subtree,
# tsyringe and tslib (reflect-metadata is its polyfill). A development manifest naming one of these
# does not make it a finding.
EXPECTED_TRANSITIVE = frozenset({
    "@azure/msal-common", "jsonwebtoken", "jws", "jwa", "ecdsa-sig-formatter", "buffer-equal-constant-time",
    "safe-buffer", "lodash.includes", "lodash.isboolean", "lodash.isinteger", "lodash.isnumber",
    "lodash.isplainobject", "lodash.isstring", "lodash.once", "ms", "semver",
    "@peculiar/asn1-cms", "@peculiar/asn1-csr", "@peculiar/asn1-ecc", "@peculiar/asn1-pkcs9",
    "@peculiar/asn1-rsa", "@peculiar/asn1-schema", "@peculiar/asn1-x509", "@peculiar/asn1-x509-post-quantum",
    "@peculiar/asn1-asym-key", "@peculiar/asn1-pfx", "@peculiar/asn1-pkcs8", "@peculiar/asn1-x509-attr",
    "@peculiar/utils", "asn1js", "pvtsutils", "pvutils", "tslib", "tsyringe", "reflect-metadata",
})
# Test tooling that must never reach the image, whether or not a manifest names it (FR-B-706): the
# HTTP simulation of the fake tenant and its interceptor.
TEST_TOOLING_PACKAGES = frozenset({"msw", "@mswjs/interceptors"})
# A name listed here is never reported. Empty: add one only with the reason, next to it.
ALLOWED_PACKAGES: frozenset[str] = frozenset()
WORKSPACE_SCOPE = "@m365portal/"

LABEL_PREFIX = "org.opencontainers.image."
REQUIRED_LABELS = ("title", "description", "source", "version", "revision", "created")
# FR-A-163: the licences label waits for the owner's decision (OD-01).
FORBIDDEN_LABELS = ("licenses",)
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")

HEALTHCHECK_TEST = ["CMD", "/nodejs/bin/node", "dist/healthcheck.js"]
ENTRYPOINT = ["/nodejs/bin/node"]
COMMAND = ["dist/index.js"]
WORKING_DIRECTORY = "/app"

REFERENCES = {
    "env-file": "FR-A-164",
    "git-data": "FR-A-164",
    "test-file": "FR-A-164",
    "source-map": "FR-A-164",
    "lock-file": "FR-A-164",
    "secret-file": "FR-A-164",
    "test-hook": "FR-B-706",
    "setup-token-file": "FR-B-706",
    "database-file": "FR-B-707",
    "dev-dependency": "FR-A-164",
    "workspace-package": "FR-A-164",
    "app-contents": "FR-A-160",
    "required-file": "FR-A-160",
    "data-dir": "FR-A-160",
    "user": "FR-A-160",
    "labels": "FR-A-163",
    "healthcheck": "FR-A-162",
    "port": "FR-A-165",
    "environment": "FR-A-160",
    "entrypoint": "FR-A-160",
    "volume": "FR-A-161",
    "inspect": "FR-A-160",
}


@dataclass(frozen=True)
class Entry:
    """One path of the image file system. `kind` is dir, file, symlink or other."""

    path: str
    kind: str
    uid: int
    gid: int


@dataclass(frozen=True)
class Finding:
    rule: str
    detail: str

    def __str__(self) -> str:
        return f"[{self.rule}] {self.detail} ({REFERENCES.get(self.rule, 'FR-A-164')})"


# ---------------------------------------------------------------------------------------------
# The file system
# ---------------------------------------------------------------------------------------------

def normalise(path: str) -> str:
    """`./app/.env`, `/app/.env` and `app/.env/` are the same path."""
    path = path.strip()
    while path.startswith("./"):
        path = path[2:]
    path = path.lstrip("/").rstrip("/")
    return "" if path == "." else path


def read_tar(stream: IO[bytes]) -> list[Entry]:
    """The entries of a tar stream such as `docker export` prints (no seeking needed)."""
    entries: list[Entry] = []
    try:
        with tarfile.open(fileobj=stream, mode="r|*") as archive:
            for member in archive:
                path = normalise(member.name)
                if path == "":
                    continue
                if member.isdir():
                    kind = "dir"
                elif member.issym():
                    kind = "symlink"
                elif member.isreg() or member.islnk():
                    kind = "file"
                else:
                    kind = "other"
                entries.append(Entry(path, kind, member.uid, member.gid))
    except tarfile.TarError as error:
        raise ValueError(f"not a readable tar archive: {error}") from None
    return entries


def package_names(parts: list[str]) -> set[str]:
    """The npm package names a path lies in: `node_modules/x`, `node_modules/@s/x` and the pnpm store."""
    names: set[str] = set()
    for index, part in enumerate(parts):
        if part != "node_modules" or index + 1 >= len(parts):
            continue
        following = parts[index + 1]
        if following == ".pnpm":
            if index + 2 < len(parts):
                # `vitest@5.0.3_...` or `@types+node@22.20.5`: the name is what precedes the version.
                match = re.match(r"^(@[^+/@]+\+[^@/]+|[^@/]+)@", parts[index + 2])
                if match:
                    names.add(match.group(1).replace("+", "/", 1))
        elif following.startswith("@"):
            if index + 2 < len(parts):
                names.add(f"{following}/{parts[index + 2]}")
        elif not following.startswith("."):
            names.add(following)
    return names


def check_listing(entries: Iterable[Entry], dev_packages: set[str]) -> list[Finding]:
    """The findings for a file system listing. `dev_packages` are names that must not be installed."""
    findings: list[Finding] = []
    seen: set[tuple[str, str]] = set()
    reported_paths: set[str] = set()

    def report(rule: str, path: str, why: str) -> None:
        key = (rule, path)
        if key not in seen:
            seen.add(key)
            findings.append(Finding(rule, f"{path}: {why}"))
            reported_paths.add(path)

    forbidden = (
        {name for name in dev_packages if not name.startswith(WORKSPACE_SCOPE)} | TEST_TOOLING_PACKAGES
    ) - ALLOWED_PACKAGES - (EXPECTED_TRANSITIVE - TEST_TOOLING_PACKAGES)
    listing = {normalise(entry.path): entry for entry in entries}
    listing.pop("", None)

    for path in sorted(listing):
        parts = path.split("/")
        basename = parts[-1]
        in_node_modules = "node_modules" in parts
        base_image = parts[0] in BASE_IMAGE_ROOTS
        ours = not in_node_modules and not base_image
        in_app = parts[0] == APP_ROOT and not in_node_modules

        if ".git" in parts:
            report("git-data", path, "version control data must not be in the image")
        if not in_node_modules and (basename == ".env" or basename.startswith(".env.")):
            report("env-file", path, "an environment file must not be in the image")
        if in_app:
            if re.search(r"\.(?:test|spec)\.", basename) or any(p in TEST_DIRECTORIES for p in parts[:-1]):
                report("test-file", path, "test files must not be in the image")
            elif basename in TEST_DIRECTORIES:
                report("test-file", path, "test output must not be in the image")
            if basename.endswith(".map"):
                report("source-map", path, "source maps must not be in the image")
            if basename in LOCK_FILES:
                report("lock-file", path, "lock files must not be in the image")
        if ours and SECRET_FILE.match(basename):
            report("secret-file", path, "key material or a credentials file must not be in the image")
        if ours and any(TEST_HOOK_NAME.search(part) for part in parts):
            report("test-hook", path, "the fake tenant is test code and must not be in the image")
        if ours and SETUP_TOKEN_FILE.match(basename):
            report("setup-token-file", path, "a setup token file must not be in the image")
        if ours and parts[0] != DATA_ROOT and DATABASE_FILE.match(basename):
            report("database-file", path, "a database file must not be in the image; the volume holds the data")
        if in_node_modules:
            for name in sorted(package_names(parts)):
                if name.startswith(WORKSPACE_SCOPE):
                    report("workspace-package", name, "a workspace package must be inlined by the build, never shipped")
                elif name in forbidden:
                    report("dev-dependency", name, f"a development dependency must not be installed (found at {path})")

    # The shape of /app: only what the Dockerfile copies. The top-level names are taken from every
    # path, so a listing without directory entries is judged the same way.
    top_level = {path.split("/")[1] for path in listing if path.startswith(APP_ROOT + "/")}
    for name in sorted(top_level - APP_ROOT_ENTRIES):
        path = f"{APP_ROOT}/{name}"
        if path not in reported_paths:
            report(
                "app-contents", path,
                f"/app holds only {', '.join(sorted(APP_ROOT_ENTRIES))} (APP_ROOT_ENTRIES in scripts/check_image_contents.py)",
            )
    for required in REQUIRED_FILES:
        if required not in listing:
            report("required-file", required, "the image cannot run without this file")

    # /data: present, a directory, owned by the runtime user, and empty.
    data = listing.get(DATA_ROOT)
    if data is None:
        report("data-dir", DATA_ROOT, f"/data does not exist; it must exist and be owned by {RUNTIME_USER}")
    else:
        if data.kind != "dir":
            report("data-dir", DATA_ROOT, "/data must be a directory")
        if (data.uid, data.gid) != (RUNTIME_ID, RUNTIME_ID):
            report(
                "data-dir", DATA_ROOT,
                f"/data is owned by {data.uid}:{data.gid}; it must be owned by {RUNTIME_USER}, "
                "or the container cannot write to a fresh volume",
            )
        for path in sorted(listing):
            if path.startswith(DATA_ROOT + "/"):
                report("data-dir", path, "/data must be empty in the image; the volume holds the data")
    return findings


# ---------------------------------------------------------------------------------------------
# The configuration
# ---------------------------------------------------------------------------------------------

def environment_of(config: dict) -> dict[str, str]:
    """`Env` as a mapping; when a name occurs twice the last one wins, as in Docker."""
    result: dict[str, str] = {}
    for item in config.get("Env") or []:
        if isinstance(item, str) and "=" in item:
            name, _, value = item.partition("=")
            result[name] = value
    return result


def check_inspect(document: object) -> list[Finding]:
    """The findings for the first image of a `docker image inspect` result (the image object)."""
    if isinstance(document, list):
        document = document[0] if document else None
    config = document.get("Config") if isinstance(document, dict) else None
    if not isinstance(config, dict):
        return [Finding("inspect", "the document has no Config object; it is not a `docker image inspect` result")]

    findings: list[Finding] = []

    def report(rule: str, detail: str) -> None:
        findings.append(Finding(rule, detail))

    user = config.get("User")
    if user != RUNTIME_USER:
        report("user", f'Config.User is {user!r}, it must be "{RUNTIME_USER}" (the Dockerfile says USER {RUNTIME_USER})')

    labels = config.get("Labels")
    labels = labels if isinstance(labels, dict) else {}
    for name in REQUIRED_LABELS:
        value = labels.get(LABEL_PREFIX + name)
        if not isinstance(value, str) or value.strip() == "":
            report("labels", f"label {LABEL_PREFIX}{name} is missing or empty")
        elif name == "version" and not SEMVER.match(value):
            report("labels", f"label {LABEL_PREFIX}version is {value!r}, it must be MAJOR.MINOR.PATCH")
        elif name == "created" and not RFC3339.match(value):
            report("labels", f"label {LABEL_PREFIX}created is {value!r}, it must be an RFC 3339 timestamp")
    for name in FORBIDDEN_LABELS:
        if LABEL_PREFIX + name in labels:
            report("labels", f"label {LABEL_PREFIX}{name} must not be set until the owner names a licence (OD-01)")

    healthcheck = config.get("Healthcheck")
    if not isinstance(healthcheck, dict):
        report("healthcheck", "the image has no health check (HEALTHCHECK)")
    else:
        if healthcheck.get("Test") != HEALTHCHECK_TEST:
            report(
                "healthcheck",
                f"Healthcheck.Test is {healthcheck.get('Test')!r}, it must be {HEALTHCHECK_TEST!r}: "
                "the Node script, no shell and no curl (the image has neither)",
            )
        for key in ("Interval", "Timeout", "Retries"):
            value = healthcheck.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                report("healthcheck", f"Healthcheck.{key} is missing or zero")

    environment = environment_of(config)
    port = environment.get("PORT")
    port_valid = port is not None and re.fullmatch(r"[1-9]\d{3,4}", port) is not None and 1024 <= int(port) <= 65535
    if not port_valid:
        report("port", f"the PORT variable is {port!r}, it must be set to a port from 1024 to 65535 (the container is unprivileged)")
    exposed = config.get("ExposedPorts")
    exposed = exposed if isinstance(exposed, dict) else {}
    if not exposed:
        report("port", "no port is exposed (EXPOSE)")
    elif len(exposed) != 1:
        report("port", f"exactly one port must be exposed, found {sorted(exposed)}")
    else:
        (declared,) = exposed
        if not str(declared).endswith("/tcp"):
            report("port", f"the exposed port {declared} must be tcp")
        elif port_valid and declared != f"{port}/tcp":
            report("port", f"the exposed port {declared} does not match PORT={port}")

    for name, wanted in (("NODE_ENV", "production"), ("DATA_DIR", "/data")):
        if environment.get(name) != wanted:
            report("environment", f"the image environment must set {name}={wanted}, found {environment.get(name)!r}")

    if config.get("Entrypoint") != ENTRYPOINT:
        report("entrypoint", f"Entrypoint is {config.get('Entrypoint')!r}, it must be {ENTRYPOINT!r} (the Node of the base image)")
    if config.get("Cmd") != COMMAND:
        report("entrypoint", f"Cmd is {config.get('Cmd')!r}, it must be {COMMAND!r}")
    if config.get("WorkingDir") != WORKING_DIRECTORY:
        report("entrypoint", f"WorkingDir is {config.get('WorkingDir')!r}, it must be {WORKING_DIRECTORY!r}")

    if config.get("Volumes"):
        report(
            "volume",
            f"the image declares VOLUME {sorted(config['Volumes'])}: an anonymous volume on a plain "
            "`docker run` would silently lose the data",
        )
    return findings


# ---------------------------------------------------------------------------------------------
# Which packages are development dependencies
# ---------------------------------------------------------------------------------------------

def read_manifest(path: Path) -> dict:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return document if isinstance(document, dict) else {}


def dev_packages(root: Path) -> set[str]:
    """Names that must not be installed in the image, read from the manifests of the repository.

    Every devDependency of every workspace, and the dependencies of the web application (Vite
    bundles them; the server image never needs them), minus the production dependencies of the
    server. Without readable manifests the built-in list applies.
    """
    manifests = [
        root / "package.json",
        *sorted((root / "apps").glob("*/package.json")),
        *sorted((root / "packages").glob("*/package.json")),
        root / "e2e" / "package.json",
    ]
    forbidden: set[str] = set()
    for path in manifests:
        document = read_manifest(path)
        forbidden |= set((document.get("devDependencies") or {}))
        if path == root / "apps" / "web" / "package.json":
            forbidden |= set((document.get("dependencies") or {}))
    if not forbidden:
        forbidden = set(BUILT_IN_DEV_PACKAGES)
    server_dependencies = set((read_manifest(root / "apps" / "server" / "package.json").get("dependencies") or {}))
    return forbidden - server_dependencies - ALLOWED_PACKAGES


# ---------------------------------------------------------------------------------------------
# Docker and the command line
# ---------------------------------------------------------------------------------------------

def run_docker(*args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["docker", *args], capture_output=True, check=False)
    except FileNotFoundError:
        raise RuntimeError("docker is not installed or not on PATH") from None


def docker_failure(result: subprocess.CompletedProcess, what: str) -> RuntimeError:
    text = (result.stderr or result.stdout or b"").decode("utf-8", "replace").strip()
    return RuntimeError(f"`{what}` failed: {text.splitlines()[0] if text else 'no output'}")


def inspect_image(image: str) -> object:
    result = run_docker("image", "inspect", image)
    if result.returncode != 0:
        raise docker_failure(result, f"docker image inspect {image}")
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise RuntimeError(f"`docker image inspect {image}` printed no JSON: {error}") from None


def export_image(image: str) -> list[Entry]:
    """The file system of an image: create a container (never started), export it, remove it."""
    created = run_docker("create", image)
    if created.returncode != 0:
        raise docker_failure(created, f"docker create {image}")
    container = created.stdout.decode("utf-8", "replace").strip()
    try:
        try:
            process = subprocess.Popen(["docker", "export", container], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except FileNotFoundError:
            raise RuntimeError("docker is not installed or not on PATH") from None
        assert process.stdout is not None
        try:
            entries = read_tar(process.stdout)
        finally:
            process.stdout.read()  # drain, so the exporter can finish
            error = process.stderr.read() if process.stderr else b""
            process.wait()
        if process.returncode != 0:
            text = error.decode("utf-8", "replace").strip()
            raise RuntimeError(f"`docker export` failed: {text.splitlines()[0] if text else 'no output'}")
        return entries
    finally:
        run_docker("rm", "-f", container)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("image", nargs="?", default=DEFAULT_IMAGE, help=f"image to check (default {DEFAULT_IMAGE})")
    parser.add_argument("--tar", metavar="FILE", help="a saved `docker export` of a container of the image")
    parser.add_argument("--inspect-json", metavar="FILE", help="a saved `docker image inspect` result")
    parser.add_argument(
        "--repo-root", metavar="DIR", type=Path, default=Path(__file__).resolve().parent.parent,
        help="repository whose package manifests name the development dependencies",
    )
    args = parser.parse_args(argv)

    try:
        if args.inspect_json is not None:
            document = json.loads(Path(args.inspect_json).read_text(encoding="utf-8"))
            subject = args.inspect_json
        else:
            document, subject = inspect_image(args.image), args.image
        if args.tar is not None:
            with open(args.tar, "rb") as stream:
                entries = read_tar(stream)
        else:
            entries = export_image(args.image)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"check_image_contents: {error}", file=sys.stderr)
        return 2

    findings = check_inspect(document) + check_listing(entries, dev_packages(args.repo_root))
    if findings:
        print(f"check_image_contents: FAILED for {subject}, {len(findings)} problem(s):", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print(f"check_image_contents: OK, {subject} holds nothing it should not ({len(entries)} paths checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
