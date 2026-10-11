"""Tests for scripts/check_image_contents.py (FR-A-164, FR-A-160 to FR-A-163, FR-A-165; T-A-234).

No Docker is needed. The checker works on two documents that Docker produces and that are rebuilt
here as fixtures: the listing of the image file system (`docker export`, a tar stream) and the
image configuration (`docker image inspect`). A fake `docker` program on PATH covers the live path.

Every rule has a negative case: a defect planted into the good fixture, which must be reported by
the rule that owns it and by no other, so a rule that silently stopped working is noticed. The
cases that the task names are `.env` and `node_modules/vitest`.
"""
import copy
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

import check_image_contents as contents
from check_image_contents import Entry

SCRIPTS = Path(__file__).resolve().parent
SCRIPT = SCRIPTS / "check_image_contents.py"
RUNTIME = (65532, 65532)


def directory(path: str, owner: tuple[int, int] = (0, 0)) -> Entry:
    return Entry(path=path, kind="dir", uid=owner[0], gid=owner[1])


def file(path: str, owner: tuple[int, int] = RUNTIME) -> Entry:
    return Entry(path=path, kind="file", uid=owner[0], gid=owner[1])


def good_entries() -> list[Entry]:
    """A listing shaped like the image of plan 12.1: base image paths, /app, an empty /data."""
    return [
        directory("etc"),
        file("etc/ssl/certs/ca-certificates.crt", (0, 0)),
        file("etc/ssl/certs/legacy.pem", (0, 0)),
        file("usr/share/doc/base/tests/readme", (0, 0)),
        file("nodejs/bin/node", (0, 0)),
        directory("tmp"),
        directory("data", RUNTIME),
        directory("app", RUNTIME),
        file("app/package.json"),
        directory("app/dist", RUNTIME),
        file("app/dist/index.js"),
        file("app/dist/healthcheck.js"),
        file("app/dist/cli.js"),
        directory("app/drizzle", RUNTIME),
        file("app/drizzle/0000_init.sql"),
        file("app/drizzle/meta/_journal.json"),
        directory("app/web", RUNTIME),
        file("app/web/index.html"),
        file("app/web/assets/index-abc123.js"),
        file("app/web/assets/index-abc123.js.br"),
        directory("app/node_modules", RUNTIME),
        file("app/node_modules/hono/package.json"),
        file("app/node_modules/zod/package.json"),
        # Third-party packages may ship tests, maps and lock files; they are not ours to remove.
        file("app/node_modules/zod/test/basic.test.js"),
        file("app/node_modules/zod/dist/index.js.map"),
        file("app/node_modules/better-sqlite3/package.json"),
        file("app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
        file("app/node_modules/.pnpm/hono@4.13.13/node_modules/hono/package.json"),
        file("app/node_modules/.pnpm/@img+sharp-linux-x64@0.35.5/node_modules/@img/sharp-linux-x64/package.json"),
    ]


def good_inspect() -> dict:
    """The part of `docker image inspect` that the checker reads, as the real image produces it."""
    prefix = "org.opencontainers.image."
    return {
        "Id": "sha256:" + "0" * 64,
        "Os": "linux",
        "Architecture": "amd64",
        "Size": 197_000_000,
        "Config": {
            "User": "65532:65532",
            "WorkingDir": "/app",
            "Entrypoint": ["/nodejs/bin/node"],
            "Cmd": ["dist/index.js"],
            "Env": [
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "NODE_ENV=production",
                "PORT=8080",
                "DATA_DIR=/data",
            ],
            "ExposedPorts": {"8080/tcp": {}},
            "Volumes": None,
            "Healthcheck": {
                "Test": ["CMD", "/nodejs/bin/node", "dist/healthcheck.js"],
                "Interval": 30_000_000_000,
                "Timeout": 5_000_000_000,
                "StartPeriod": 20_000_000_000,
                "Retries": 3,
            },
            "Labels": {
                prefix + "title": "M365Portal",
                prefix + "description": "Self-hosted panel for Microsoft 365 administration",
                prefix + "source": "https://github.com/Flux76HQ/M365Portal",
                prefix + "version": "0.3.1",
                prefix + "revision": "836d8c5a1b2c3d4e5f60718293a4b5c6d7e8f901",
                prefix + "created": "2026-10-10T21:42:00Z",
            },
        },
    }


def rules(findings: list[contents.Finding]) -> set[str]:
    return {finding.rule for finding in findings}


class GoodImage(unittest.TestCase):
    def test_the_good_listing_has_no_finding(self):
        self.assertEqual(contents.check_listing(good_entries(), set()), [])

    def test_the_good_configuration_has_no_finding(self):
        self.assertEqual(contents.check_inspect(good_inspect()), [])


class Listing(unittest.TestCase):
    """Each case plants one defect into the good listing."""

    def planted(self, *extra: Entry, drop: tuple[str, ...] = (), dev: frozenset = frozenset()):
        entries = [e for e in good_entries() if not any(e.path == d or e.path.startswith(d + "/") for d in drop)]
        return contents.check_listing(entries + list(extra), set(dev))

    def assertOnly(self, findings, rule: str, mentions: str):
        self.assertEqual(rules(findings), {rule}, [str(f) for f in findings])
        self.assertTrue(any(mentions in f.detail for f in findings), [str(f) for f in findings])

    # --- the two cases the task names ---------------------------------------------------------

    def test_a_dotenv_file_fails(self):
        self.assertOnly(self.planted(file("app/.env")), "env-file", "app/.env")

    def test_a_dev_dependency_fails(self):
        self.assertOnly(
            self.planted(file("app/node_modules/vitest/package.json"), dev=frozenset({"vitest"})),
            "dev-dependency", "vitest",
        )

    # --- environment files ------------------------------------------------------------------------

    def test_every_dotenv_variant_fails_anywhere_outside_node_modules(self):
        for path in (".env", "app/.env.production", "data/.env.local", "home/nonroot/.env", "app/web/.env.example"):
            with self.subTest(path=path):
                self.assertIn("env-file", rules(self.planted(file(path))))

    def test_a_dotenv_inside_a_third_party_package_is_not_ours(self):
        self.assertEqual(self.planted(file("app/node_modules/zod/.env")), [])

    def test_names_that_merely_contain_env_are_fine(self):
        for path in ("app/dist/environment.js", "app/dist/.environment", "app/dist/env.js"):
            with self.subTest(path=path):
                self.assertEqual(self.planted(file(path)), [])

    # --- version control ------------------------------------------------------------------------

    def test_git_data_fails_even_inside_node_modules(self):
        for path in (".git/HEAD", "app/.git/config", "app/node_modules/foo/.git/HEAD"):
            with self.subTest(path=path):
                self.assertIn("git-data", rules(self.planted(file(path))))

    def test_gitignore_like_names_are_not_git_data(self):
        self.assertEqual(self.planted(file("app/dist/.gitkeep")), [])

    # --- test files ----------------------------------------------------------------------------

    def test_test_files_fail(self):
        for path in (
            "app/dist/session.test.js",
            "app/dist/session.spec.js",
            "app/test/helpers.js",
            "app/tests/a.js",
            "app/dist/__tests__/a.js",
            "app/e2e/smoke.spec.ts",
            "app/web/coverage/lcov.info",
            "app/playwright-report/index.html",
            "app/test-results/.last-run.json",
        ):
            with self.subTest(path=path):
                self.assertIn("test-file", rules(self.planted(file(path))))

    def test_test_files_of_third_party_packages_and_the_base_image_are_not_ours(self):
        self.assertEqual(self.planted(file("app/node_modules/hono/test/a.test.js")), [])
        self.assertEqual(self.planted(file("usr/lib/x/tests/a.spec.js", (0, 0))), [])

    def test_a_file_called_latest_or_contest_is_not_a_test(self):
        for path in ("app/dist/contest.js", "app/dist/latest.js", "app/web/attest.html"):
            with self.subTest(path=path):
                self.assertEqual(self.planted(file(path)), [])

    # --- source maps and lock files -------------------------------------------------------------

    def test_source_maps_fail(self):
        for path in ("app/dist/index.js.map", "app/web/assets/index-abc123.js.map", "app/web/assets/x.css.map"):
            with self.subTest(path=path):
                self.assertIn("source-map", rules(self.planted(file(path))))

    def test_lock_files_fail(self):
        for path in ("app/pnpm-lock.yaml", "app/package-lock.json", "app/yarn.lock", "app/pnpm-workspace.yaml"):
            with self.subTest(path=path):
                self.assertIn("lock-file", rules(self.planted(file(path))))

    # --- secrets --------------------------------------------------------------------------------

    def test_key_material_and_credentials_fail(self):
        for path in ("app/server.pem", "app/certs/client.key", "app/client.pfx", "app/client.p12", "app/.npmrc", "home/nonroot/.netrc", "app/id_rsa", "app/id_ed25519.pub"):
            with self.subTest(path=path):
                self.assertIn("secret-file", rules(self.planted(file(path))))

    def test_pem_files_of_the_base_image_and_of_packages_are_fine(self):
        self.assertEqual(self.planted(file("app/node_modules/foo/cert.pem")), [])

    # --- development dependencies ------------------------------------------------------------------

    def test_a_dev_dependency_is_found_in_every_layout_pnpm_produces(self):
        dev = frozenset({"vitest", "@types/node", "typescript"})
        for path in (
            "app/node_modules/vitest/dist/index.js",
            "app/node_modules/@types/node/index.d.ts",
            "app/node_modules/.pnpm/vitest@5.0.3_@types+node@22.20.5/node_modules/vitest/package.json",
            "app/node_modules/.pnpm/@types+node@22.20.5/node_modules/@types/node/package.json",
            "app/node_modules/.pnpm/node_modules/typescript/lib/tsc.js",
        ):
            with self.subTest(path=path):
                self.assertIn("dev-dependency", rules(self.planted(file(path), dev=dev)))

    def test_a_package_that_only_looks_like_a_dev_dependency_is_fine(self):
        dev = frozenset({"vitest", "typescript"})
        for path in (
            "app/node_modules/vitest-like/package.json",
            "app/node_modules/not-typescript/package.json",
            "app/dist/vitest.js",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.planted(file(path), dev=dev), [])

    def test_a_workspace_package_must_be_inlined_not_shipped(self):
        self.assertEqual(rules(self.planted(file("app/node_modules/@m365portal/shared/package.json"))), {"workspace-package"})

    # --- the shape of /app ------------------------------------------------------------------------

    def test_only_the_allowed_entries_may_sit_in_app(self):
        for path in ("app/src/index.ts", "app/tsconfig.json", "app/VERSION", "app/Dockerfile", "app/docs/a.md"):
            with self.subTest(path=path):
                self.assertIn("app-contents", rules(self.planted(file(path))))

    def test_the_allowed_entries_are_the_ones_the_plan_names(self):
        self.assertEqual(
            contents.APP_ROOT_ENTRIES,
            frozenset({"node_modules", "package.json", "dist", "drizzle", "web"}),
        )

    def test_the_files_the_image_runs_must_exist(self):
        for missing in (
            "app/dist/index.js", "app/dist/healthcheck.js", "app/package.json",
            "app/web/index.html", "app/drizzle/meta/_journal.json",
        ):
            with self.subTest(missing=missing):
                findings = self.planted(drop=(missing,))
                self.assertOnly(findings, "required-file", missing)

    # --- /data ------------------------------------------------------------------------------------

    def test_data_must_exist_owned_by_the_runtime_user(self):
        self.assertOnly(self.planted(drop=("data",)), "data-dir", "data")
        wrong = [e for e in good_entries() if e.path != "data"] + [directory("data", (0, 0))]
        self.assertOnly(contents.check_listing(wrong, set()), "data-dir", "65532")

    def test_data_must_be_a_directory(self):
        wrong = [e for e in good_entries() if e.path != "data"] + [file("data")]
        self.assertOnly(contents.check_listing(wrong, set()), "data-dir", "directory")

    def test_data_must_be_empty(self):
        self.assertOnly(self.planted(file("data/m365portal.sqlite")), "data-dir", "empty")

    # --- paths are normalised -----------------------------------------------------------------------

    def test_leading_dot_slash_and_trailing_slash_do_not_hide_a_file(self):
        self.assertEqual(contents.normalise("./app/.env"), "app/.env")
        self.assertEqual(contents.normalise("/app/.env"), "app/.env")
        self.assertEqual(contents.normalise("app/dist/"), "app/dist")
        self.assertIn("env-file", rules(self.planted(Entry("./app/.env", "file", 65532, 65532))))


class Configuration(unittest.TestCase):
    def planted(self, change) -> list[contents.Finding]:
        inspect = copy.deepcopy(good_inspect())
        change(inspect["Config"])
        return contents.check_inspect(inspect)

    def assertOnly(self, findings, rule: str, mentions: str):
        self.assertEqual(rules(findings), {rule}, [str(f) for f in findings])
        self.assertTrue(any(mentions in f.detail for f in findings), [str(f) for f in findings])

    # --- user ----------------------------------------------------------------------------------------

    def test_the_user_must_be_65532_65532(self):
        for user in ("", "0", "root", "65532", "nonroot", "65532:0", "0:65532", "65533:65533"):
            with self.subTest(user=user):
                self.assertOnly(self.planted(lambda c, u=user: c.update(User=u)), "user", "65532:65532")

    def test_a_missing_user_is_root(self):
        self.assertOnly(self.planted(lambda c: c.pop("User")), "user", "65532:65532")

    # --- labels --------------------------------------------------------------------------------------

    def test_every_required_label_must_be_present_and_not_empty(self):
        for name in contents.REQUIRED_LABELS:
            key = contents.LABEL_PREFIX + name
            with self.subTest(label=name, state="missing"):
                self.assertOnly(self.planted(lambda c, k=key: c["Labels"].pop(k)), "labels", name)
            with self.subTest(label=name, state="empty"):
                self.assertOnly(self.planted(lambda c, k=key: c["Labels"].update({k: " "})), "labels", name)

    def test_no_labels_at_all_fails_once_per_label(self):
        findings = self.planted(lambda c: c.update(Labels=None))
        self.assertEqual(len(findings), len(contents.REQUIRED_LABELS))

    def test_the_licence_label_stays_out_until_the_owner_names_a_licence(self):
        findings = self.planted(lambda c: c["Labels"].update({contents.LABEL_PREFIX + "licenses": "MIT"}))
        self.assertOnly(findings, "labels", "licenses")

    def test_the_version_label_is_a_semantic_version(self):
        for value in ("0.3", "v0.3.1", "latest", "0.3.1-rc1", "unknown"):
            with self.subTest(value=value):
                key = contents.LABEL_PREFIX + "version"
                self.assertOnly(self.planted(lambda c, v=value: c["Labels"].update({key: v})), "labels", "version")

    def test_the_created_label_is_a_timestamp(self):
        key = contents.LABEL_PREFIX + "created"
        for value in ("yesterday", "2026-10-10", "1760131320"):
            with self.subTest(value=value):
                self.assertOnly(self.planted(lambda c, v=value: c["Labels"].update({key: v})), "labels", "created")
        for value in ("2026-10-10T21:42:00Z", "2026-10-10T21:42:00.123456789Z", "2026-10-10T21:42:00+02:00"):
            with self.subTest(value=value):
                self.assertEqual(self.planted(lambda c, v=value: c["Labels"].update({key: v})), [])

    # --- health check -----------------------------------------------------------------------------

    def test_the_healthcheck_runs_the_node_script_without_a_shell(self):
        self.assertOnly(self.planted(lambda c: c.pop("Healthcheck")), "healthcheck", "no health check")
        for test in (
            ["CMD-SHELL", "curl -f http://localhost:8080/readyz"],
            ["CMD", "curl", "-f", "http://localhost:8080/readyz"],
            ["CMD", "/bin/sh", "-c", "exit 0"],
            ["CMD", "/nodejs/bin/node", "-e", "process.exit(0)"],
            ["NONE"],
            [],
        ):
            with self.subTest(test=test):
                self.assertOnly(
                    self.planted(lambda c, t=test: c["Healthcheck"].update(Test=t)),
                    "healthcheck", "dist/healthcheck.js",
                )

    def test_the_healthcheck_has_an_interval_a_timeout_and_retries(self):
        for key in ("Interval", "Timeout", "Retries"):
            with self.subTest(key=key):
                self.assertOnly(self.planted(lambda c, k=key: c["Healthcheck"].pop(k)), "healthcheck", key)
            with self.subTest(key=key, value=0):
                self.assertOnly(self.planted(lambda c, k=key: c["Healthcheck"].update({k: 0})), "healthcheck", key)

    # --- port ------------------------------------------------------------------------------------------

    def test_the_exposed_port_is_the_port_the_process_listens_on(self):
        self.assertOnly(self.planted(lambda c: c.update(ExposedPorts={"9090/tcp": {}})), "port", "PORT")
        self.assertOnly(self.planted(lambda c: c.update(ExposedPorts=None)), "port", "exposed")
        self.assertOnly(
            self.planted(lambda c: c.update(ExposedPorts={"8080/tcp": {}, "8081/tcp": {}})), "port", "exactly one"
        )
        self.assertOnly(self.planted(lambda c: c.update(ExposedPorts={"8080/udp": {}})), "port", "tcp")

    def test_a_port_other_than_the_default_is_fine_when_both_agree(self):
        def change(config):
            config["Env"] = [e for e in config["Env"] if not e.startswith("PORT=")] + ["PORT=18080"]
            config["ExposedPorts"] = {"18080/tcp": {}}
        self.assertEqual(self.planted(change), [])

    def test_the_port_variable_is_in_the_unprivileged_range(self):
        for value in ("80", "1023", "0", "70000", "abc", ""):
            def change(config, v=value):
                config["Env"] = [e for e in config["Env"] if not e.startswith("PORT=")] + [f"PORT={v}"]
                config["ExposedPorts"] = {f"{v}/tcp": {}}
            with self.subTest(value=value):
                self.assertIn("port", rules(self.planted(change)))

    def test_a_missing_port_variable_fails(self):
        def change(config):
            config["Env"] = [e for e in config["Env"] if not e.startswith("PORT=")]
        self.assertOnly(self.planted(change), "port", "PORT")

    # --- environment, entry point, volume -----------------------------------------------------------------

    def test_the_image_runs_in_production_mode_with_data_in_data(self):
        def without(name):
            def change(config):
                config["Env"] = [e for e in config["Env"] if not e.startswith(name + "=")]
            return change
        self.assertOnly(self.planted(without("NODE_ENV")), "environment", "NODE_ENV=production")
        self.assertOnly(self.planted(without("DATA_DIR")), "environment", "DATA_DIR=/data")
        self.assertOnly(
            self.planted(lambda c: c["Env"].append("NODE_ENV=development")), "environment", "NODE_ENV=production"
        )

    def test_the_image_starts_the_server_bundle_with_the_node_of_the_base_image(self):
        self.assertOnly(self.planted(lambda c: c.update(Cmd=["dist/other.js"])), "entrypoint", "dist/index.js")
        self.assertOnly(self.planted(lambda c: c.update(Entrypoint=["/bin/sh"])), "entrypoint", "/nodejs/bin/node")
        self.assertOnly(self.planted(lambda c: c.update(WorkingDir="/")), "entrypoint", "/app")

    def test_a_declared_volume_fails_because_it_would_lose_data_silently(self):
        self.assertOnly(self.planted(lambda c: c.update(Volumes={"/data": {}})), "volume", "VOLUME")
        self.assertEqual(self.planted(lambda c: c.update(Volumes={})), [])

    def test_a_document_that_is_not_an_inspect_result_is_refused(self):
        for document in ({}, {"Config": None}, {"Config": []}):
            with self.subTest(document=document):
                self.assertEqual(rules(contents.check_inspect(document)), {"inspect"})


class DevelopmentPackages(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="image-contents-repo-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def manifest(self, relative: str, **blocks) -> None:
        path = self.root / relative / "package.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(blocks), encoding="utf-8")

    def test_dev_dependencies_of_every_workspace_and_the_web_dependencies_are_forbidden(self):
        self.manifest("", devDependencies={"eslint": "catalog:", "vitest": "catalog:"})
        self.manifest("apps/server", dependencies={"hono": "catalog:", "zod": "catalog:"},
                      devDependencies={"@m365portal/shared": "workspace:*", "tsx": "catalog:", "vitest": "catalog:"})
        self.manifest("apps/web", dependencies={"react": "catalog:"}, devDependencies={"vite": "catalog:"})
        self.manifest("packages/shared", dependencies={"zod": "catalog:"}, devDependencies={"typescript": "catalog:"})
        self.manifest("e2e", devDependencies={"@playwright/test": "catalog:"})
        found = contents.dev_packages(self.root)
        self.assertEqual(
            found,
            {"eslint", "vitest", "@m365portal/shared", "tsx", "react", "vite", "typescript", "@playwright/test"},
        )

    def test_a_production_dependency_of_the_server_is_never_forbidden(self):
        self.manifest("", devDependencies={"zod": "catalog:"})
        self.manifest("apps/server", dependencies={"zod": "catalog:"})
        self.manifest("packages/shared", devDependencies={"zod": "catalog:"})
        self.assertNotIn("zod", contents.dev_packages(self.root))

    def test_a_repository_without_manifests_gives_the_built_in_list(self):
        found = contents.dev_packages(self.root)
        for name in ("vitest", "typescript", "eslint", "prettier", "esbuild", "tsx", "drizzle-kit", "@playwright/test"):
            self.assertIn(name, found)

    def test_the_real_repository_forbids_what_it_should(self):
        found = contents.dev_packages(SCRIPTS.parent)
        for name in ("vitest", "typescript", "@m365portal/shared", "eslint", "drizzle-kit"):
            self.assertIn(name, found)
        for name in ("hono", "zod", "better-sqlite3", "sharp", "pino", "drizzle-orm", "@hono/node-server"):
            self.assertNotIn(name, found)


class TarListing(unittest.TestCase):
    """`docker export` is a tar stream; the reader turns it into entries."""

    def build(self, members: list[tuple[str, str, int, int]]) -> io.BytesIO:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, kind, uid, gid in members:
                info = tarfile.TarInfo(name)
                info.uid, info.gid = uid, gid
                if kind == "dir":
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                elif kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "elsewhere"
                    archive.addfile(info)
                else:
                    payload = b"x"
                    info.size = len(payload)
                    archive.addfile(info, io.BytesIO(payload))
        buffer.seek(0)
        return buffer

    def test_reads_paths_kinds_and_owners(self):
        buffer = self.build([
            ("data/", "dir", 65532, 65532),
            ("./app/dist/index.js", "file", 65532, 65532),
            ("usr/bin/node", "symlink", 0, 0),
        ])
        entries = contents.read_tar(buffer)
        self.assertEqual(
            [(e.path, e.kind, e.uid, e.gid) for e in entries],
            [("data", "dir", 65532, 65532), ("app/dist/index.js", "file", 65532, 65532), ("usr/bin/node", "symlink", 0, 0)],
        )

    def test_the_root_entry_is_skipped(self):
        self.assertEqual(contents.read_tar(self.build([("./", "dir", 0, 0), ("a", "file", 0, 0)])), [Entry("a", "file", 0, 0)])

    def test_a_stream_that_is_not_a_tar_is_an_error(self):
        with self.assertRaises(ValueError):
            contents.read_tar(io.BytesIO(b"this is not a tar archive" * 100))


class Command(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="image-contents-test-"))
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.repo = self.directory / "repo"
        (self.repo / "apps" / "server").mkdir(parents=True)
        (self.repo / "package.json").write_text(json.dumps({"devDependencies": {"vitest": "catalog:"}}), encoding="utf-8")
        (self.repo / "apps" / "server" / "package.json").write_text(json.dumps({"dependencies": {"hono": "catalog:"}}), encoding="utf-8")

    def tar_of(self, entries: list[Entry]) -> Path:
        path = self.directory / "image.tar"
        with tarfile.open(path, mode="w") as archive:
            for entry in entries:
                info = tarfile.TarInfo(entry.path + ("/" if entry.kind == "dir" else ""))
                info.uid, info.gid = entry.uid, entry.gid
                if entry.kind == "dir":
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                else:
                    info.size = 1
                    archive.addfile(info, io.BytesIO(b"x"))
        return path

    def inspect_file(self, inspect: dict | None = None) -> Path:
        path = self.directory / "inspect.json"
        path.write_text(json.dumps([inspect if inspect is not None else good_inspect()]), encoding="utf-8")
        return path

    def run_script(self, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--repo-root", str(self.repo), *args],
            capture_output=True, text=True, check=False, env=env,
        )

    def test_a_good_image_exits_zero(self):
        result = self.run_script("--tar", str(self.tar_of(good_entries())), "--inspect-json", str(self.inspect_file()))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK", result.stdout)

    def test_a_dotenv_in_the_image_exits_one_and_names_the_file(self):
        entries = good_entries() + [file("app/.env")]
        result = self.run_script("--tar", str(self.tar_of(entries)), "--inspect-json", str(self.inspect_file()))
        self.assertEqual(result.returncode, 1)
        self.assertIn("env-file", result.stderr)
        self.assertIn("app/.env", result.stderr)
        self.assertIn("FR-A-164", result.stderr)

    def test_vitest_in_the_image_exits_one(self):
        entries = good_entries() + [file("app/node_modules/vitest/package.json")]
        result = self.run_script("--tar", str(self.tar_of(entries)), "--inspect-json", str(self.inspect_file()))
        self.assertEqual(result.returncode, 1)
        self.assertIn("dev-dependency", result.stderr)
        self.assertIn("vitest", result.stderr)

    def test_a_wrong_user_exits_one(self):
        inspect = good_inspect()
        inspect["Config"]["User"] = "0"
        result = self.run_script("--tar", str(self.tar_of(good_entries())), "--inspect-json", str(self.inspect_file(inspect)))
        self.assertEqual(result.returncode, 1)
        self.assertIn("user", result.stderr)

    def test_every_problem_is_reported_not_just_the_first(self):
        inspect = good_inspect()
        inspect["Config"]["User"] = "0"
        entries = good_entries() + [file("app/.env"), file("app/dist/index.js.map")]
        result = self.run_script("--tar", str(self.tar_of(entries)), "--inspect-json", str(self.inspect_file(inspect)))
        self.assertEqual(result.returncode, 1)
        for rule in ("user", "env-file", "source-map"):
            self.assertIn(rule, result.stderr)

    def test_unreadable_input_is_an_error_not_a_pass(self):
        missing = self.run_script("--tar", str(self.directory / "nope.tar"), "--inspect-json", str(self.inspect_file()))
        self.assertEqual(missing.returncode, 2)
        not_tar = self.directory / "plain.txt"
        not_tar.write_text("hello", encoding="utf-8")
        self.assertEqual(self.run_script("--tar", str(not_tar), "--inspect-json", str(self.inspect_file())).returncode, 2)
        (self.directory / "bad.json").write_text("{", encoding="utf-8")
        self.assertEqual(
            self.run_script("--tar", str(self.tar_of(good_entries())), "--inspect-json", str(self.directory / "bad.json")).returncode, 2
        )

    # --- the live path, against a fake `docker` ---------------------------------------------------------

    def fake_docker(self, tar_path: Path, inspect: dict | None = None, daemon_down: bool = False) -> dict:
        calls = self.directory / "calls.log"
        bin_directory = self.directory / "bin"
        bin_directory.mkdir(exist_ok=True)
        program = bin_directory / "docker"
        body = f"""#!{sys.executable}
import sys
args = sys.argv[1:]
with open({str(calls)!r}, 'a') as log:
    log.write(' '.join(args) + '\\n')
if {daemon_down!r}:
    sys.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\\n')
    sys.exit(1)
if args[:2] == ['image', 'inspect']:
    print({json.dumps([inspect if inspect is not None else good_inspect()])!r})
elif args[0] == 'create':
    print('container-0123')
elif args[0] == 'export':
    sys.stdout.buffer.write(open({str(tar_path)!r}, 'rb').read())
elif args[0] == 'rm':
    pass
else:
    sys.stderr.write('unexpected ' + ' '.join(args)); sys.exit(9)
"""
        program.write_text(body, encoding="utf-8")
        program.chmod(program.stat().st_mode | stat.S_IXUSR)
        environment = dict(os.environ)
        environment["PATH"] = f"{bin_directory}{os.pathsep}{environment['PATH']}"
        return environment

    def calls(self) -> list[str]:
        return (self.directory / "calls.log").read_text(encoding="utf-8").splitlines()

    def test_the_live_path_inspects_creates_exports_and_always_cleans_up(self):
        environment = self.fake_docker(self.tar_of(good_entries()))
        result = self.run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls()
        self.assertIn("image inspect example:tag", calls)
        self.assertIn("create example:tag", calls)
        self.assertIn("export container-0123", calls)
        self.assertEqual(calls[-1], "rm -f container-0123")

    def test_the_live_path_cleans_up_when_the_image_fails_the_check(self):
        environment = self.fake_docker(self.tar_of(good_entries() + [file("app/.env")]))
        result = self.run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.calls()[-1], "rm -f container-0123")

    def test_the_default_image_is_the_local_build_tag(self):
        environment = self.fake_docker(self.tar_of(good_entries()))
        self.assertEqual(self.run_script(env=environment).returncode, 0)
        self.assertIn("image inspect m365portal:local", self.calls())

    def test_a_docker_that_cannot_reach_its_daemon_is_an_error(self):
        environment = self.fake_docker(self.tar_of(good_entries()), daemon_down=True)
        result = self.run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Cannot connect to the Docker daemon", result.stderr)

    def test_a_missing_docker_is_an_error(self):
        environment = dict(os.environ)
        environment["PATH"] = str(self.directory)
        result = self.run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 2)
        self.assertIn("docker", result.stderr)


if __name__ == "__main__":
    unittest.main()
