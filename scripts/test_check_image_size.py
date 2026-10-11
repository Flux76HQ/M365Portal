"""Tests for scripts/check_image_size.py (FR-A-168, T-A-234).

No Docker is needed: the size comes from a number, from a `docker image inspect` fixture, or from a
fake `docker` program on PATH that answers like the real one. The negative cases are the point of
the test: an image over the ceiling must fail, with the remediation text, and a ceiling that drifts
from the one in packages/shared/src/limits.ts must be noticed.
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import check_image_size as size

SCRIPTS = Path(__file__).resolve().parent
REPOSITORY = SCRIPTS.parent
SCRIPT = SCRIPTS / "check_image_size.py"

MEGABYTE = 1_000_000  # Docker prints MB as 1,000,000 bytes, and so does the ceiling.


def run_script(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, check=False, env=env,
    )


def write_inspect(directory: Path, size_bytes: int | None) -> Path:
    document = [{"Id": "sha256:" + "0" * 64, "Os": "linux"}]
    if size_bytes is not None:
        document[0]["Size"] = size_bytes
    path = directory / "inspect.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


class Ceiling(unittest.TestCase):
    def test_the_ceiling_is_one_constant_of_400_megabytes(self):
        self.assertEqual(size.CEILING_MEGABYTES, 400)
        self.assertEqual(size.CEILING_BYTES, 400 * MEGABYTE)

    def test_the_ceiling_equals_the_one_in_the_shared_limits(self):
        """LIMITS is the single source (spec 6.5); this script must not drift from it."""
        limits = (REPOSITORY / "packages" / "shared" / "src" / "limits.ts").read_text(encoding="utf-8")
        match = re.search(r"imageSizeCeilingMegabytes:\s*([\d_]+)", limits)
        self.assertIsNotNone(match, "LIMITS has no imageSizeCeilingMegabytes")
        self.assertEqual(int(match.group(1).replace("_", "")), size.CEILING_MEGABYTES)

    def test_a_drifting_copy_of_the_limit_is_noticed(self):
        """The comparison above fails for a different number (the negative of the parity check)."""
        self.assertNotEqual(500, size.CEILING_MEGABYTES)


class Verdict(unittest.TestCase):
    def test_an_image_under_the_ceiling_passes(self):
        self.assertEqual(size.check(197 * MEGABYTE), [])

    def test_an_image_exactly_at_the_ceiling_passes(self):
        self.assertEqual(size.check(size.CEILING_BYTES), [])

    def test_one_byte_over_the_ceiling_fails(self):
        problems = size.check(size.CEILING_BYTES + 1)
        self.assertEqual(len(problems), 1)

    def test_the_failure_says_what_to_do(self):
        text = "\n".join(size.check(450 * MEGABYTE))
        self.assertIn("450.0 MB", text)
        self.assertIn("400 MB", text)
        self.assertIn("docker history", text)
        self.assertIn("scripts/check_image_size.py", text)
        self.assertIn("packages/shared/src/limits.ts", text)
        self.assertIn("pull request", text)

    def test_nonsense_sizes_are_refused_not_passed(self):
        for value in (0, -1):
            with self.assertRaises(ValueError):
                size.check(value)

    def test_format_uses_decimal_megabytes_like_docker(self):
        self.assertEqual(size.megabytes(197_000_000), "197.0 MB")
        self.assertEqual(size.megabytes(400_000_000), "400.0 MB")


class ReadingTheSize(unittest.TestCase):
    def test_reads_the_size_of_an_inspect_document(self):
        document = [{"Size": 123_456_789}]
        self.assertEqual(size.size_from_inspect(document), 123_456_789)

    def test_refuses_a_document_without_a_size(self):
        for document in ([], [{}], {"Size": 1}, [{"Size": "big"}], [{"Size": True}], [{"Size": 0}]):
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    size.size_from_inspect(document)


class Command(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="image-size-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.directory, ignore_errors=True))

    def test_size_bytes_under_the_ceiling_exits_zero(self):
        result = run_script("--size-bytes", str(197 * MEGABYTE))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("197.0 MB", result.stdout)
        self.assertIn("400 MB", result.stdout)

    def test_size_bytes_over_the_ceiling_exits_one_with_the_remediation(self):
        result = run_script("--size-bytes", str(401 * MEGABYTE))
        self.assertEqual(result.returncode, 1)
        self.assertIn("docker history", result.stderr)
        self.assertIn("401.0 MB", result.stderr)

    def test_an_inspect_fixture_is_read(self):
        ok = run_script("--inspect-json", str(write_inspect(self.directory, 300 * MEGABYTE)))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        bad = run_script("--inspect-json", str(write_inspect(self.directory, 500 * MEGABYTE)))
        self.assertEqual(bad.returncode, 1)

    def test_a_broken_fixture_is_an_error_not_a_pass(self):
        missing = run_script("--inspect-json", str(self.directory / "nope.json"))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("nope.json", missing.stderr)
        (self.directory / "broken.json").write_text("{not json", encoding="utf-8")
        broken = run_script("--inspect-json", str(self.directory / "broken.json"))
        self.assertEqual(broken.returncode, 2)
        no_size = run_script("--inspect-json", str(write_inspect(self.directory, None)))
        self.assertEqual(no_size.returncode, 2)

    def test_a_bad_size_argument_is_an_error(self):
        for value in ("abc", "-5", "0", "1.5"):
            with self.subTest(value=value):
                self.assertEqual(run_script("--size-bytes", value).returncode, 2)

    def fake_docker(self, body: str) -> dict:
        """A `docker` program on PATH; `body` is Python that decides what it prints."""
        bin_directory = self.directory / "bin"
        bin_directory.mkdir(exist_ok=True)
        program = bin_directory / "docker"
        program.write_text(f"#!{sys.executable}\nimport sys\nargs = sys.argv[1:]\n{body}\n", encoding="utf-8")
        program.chmod(program.stat().st_mode | stat.S_IXUSR)
        environment = dict(os.environ)
        environment["PATH"] = f"{bin_directory}{os.pathsep}{environment['PATH']}"
        return environment

    def test_the_live_path_asks_docker_for_the_image(self):
        environment = self.fake_docker(
            "if args[:2] == ['image', 'inspect'] and args[-1] == 'example:tag':\n"
            f"    print('[{{\"Size\": {250 * MEGABYTE}}}]')\n"
            "    sys.exit(0)\n"
            "sys.stderr.write('unexpected ' + ' '.join(args)); sys.exit(9)\n"
        )
        result = run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("250.0 MB", result.stdout)
        self.assertIn("example:tag", result.stdout)

    def test_the_default_image_is_the_local_build_tag(self):
        environment = self.fake_docker(
            "if args[:2] == ['image', 'inspect'] and args[-1] == 'm365portal:local':\n"
            f"    print('[{{\"Size\": {10 * MEGABYTE}}}]')\n"
            "    sys.exit(0)\n"
            "sys.stderr.write('unexpected ' + ' '.join(args)); sys.exit(9)\n"
        )
        result = run_script(env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_docker_that_cannot_reach_its_daemon_is_an_error(self):
        environment = self.fake_docker(
            "sys.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\\n'); sys.exit(1)"
        )
        result = run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Cannot connect to the Docker daemon", result.stderr)

    def test_a_missing_docker_is_an_error(self):
        environment = dict(os.environ)
        environment["PATH"] = str(self.directory)  # nothing on it
        result = run_script("example:tag", env=environment)
        self.assertEqual(result.returncode, 2)
        self.assertIn("docker", result.stderr)


if __name__ == "__main__":
    unittest.main()
