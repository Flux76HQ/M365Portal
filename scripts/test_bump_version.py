"""Runs scripts/bump_version.py end to end in a throwaway git repository.

The first version of this script shadowed an imported function with a local
variable of the same name and crashed on every real run, while the tests that
existed only covered the path rules. So this exercises the script itself.
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


class BumpVersion(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="bump-test-"))
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        scripts = self.repo / "scripts"
        scripts.mkdir()
        for name in ("bump_version.py", "version_guard_paths.py"):
            shutil.copy(SCRIPTS / name, scripts / name)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "test@example.invalid")
        git(self.repo, "config", "user.name", "test")
        (self.repo / "VERSION").write_text("0.1.0", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")

    def run_bump(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "scripts/bump_version.py", *args],
            cwd=self.repo, capture_output=True, text=True, check=False,
        )

    def stage(self, relative: str) -> None:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x\n", encoding="utf-8")
        git(self.repo, "add", relative)

    def version(self) -> str:
        return (self.repo / "VERSION").read_text(encoding="utf-8")

    def test_protected_change_bumps_patch_by_default(self):
        self.stage("apps/server/src/index.ts")
        result = self.run_bump()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.version(), "0.1.1")

    def test_minor_and_major_parts(self):
        self.stage("apps/server/src/index.ts")
        self.assertEqual(self.run_bump("--part", "minor").returncode, 0)
        self.assertEqual(self.version(), "0.2.0")

    def test_docs_only_change_does_not_bump(self):
        self.stage("docs/guide.md")
        result = self.run_bump()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.version(), "0.1.0")

    def test_bump_is_idempotent_when_version_already_changed(self):
        self.stage("apps/server/src/index.ts")
        (self.repo / "VERSION").write_text("0.9.0", encoding="utf-8")
        git(self.repo, "add", "VERSION")
        self.assertEqual(self.run_bump().returncode, 0)
        self.assertEqual(self.version(), "0.9.0")


if __name__ == "__main__":
    unittest.main()
