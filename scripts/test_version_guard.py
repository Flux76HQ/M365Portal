"""Tests for the version-bump guard's path rules.

A guard nobody has seen fail is an assumption with a green tick next to it, so
each test asserts both directions: a protected path demands a bump, and the
exemptions really are exempt.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from version_guard_paths import is_doc_only, is_protected, needs_bump  # noqa: E402


class ProtectedPaths(unittest.TestCase):
    def test_runtime_build_and_deploy_paths_are_protected(self):
        for path in (
            "apps/server/src/index.ts",
            "apps/web/src/main.tsx",
            "apps/web/src/locales/nl.json",
            "packages/shared/src/permissions.ts",
            "patches/@radix-ui__react-select@2.3.8.patch",
            "deploy/azure/main.bicep",
            "scripts/check_version_bump.py",
            ".github/workflows/ci.yml",
            "Dockerfile",
            ".dockerignore",
            "docker-compose.yml",
            "docker-compose.prod.yaml",
            ".env.example",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
        ):
            with self.subTest(path=path):
                self.assertTrue(needs_bump(path), f"{path} must require a VERSION bump")

    def test_documentation_is_exempt_even_inside_protected_paths(self):
        for path in ("README.md", "docs/architecture.md", "apps/server/README.md", "scripts/notes.txt"):
            with self.subTest(path=path):
                self.assertTrue(is_doc_only(path))
                self.assertFalse(needs_bump(path), f"{path} is documentation-only")

    def test_unprotected_non_doc_paths_do_not_require_a_bump(self):
        for path in ("specs/001-m365portal/spec.md", "e2e/tests/shell.spec.ts", ".gitignore", "VERSION"):
            with self.subTest(path=path):
                self.assertFalse(is_protected(path))

    def test_nested_lookalikes_are_not_protected(self):
        # Anchored patterns: a file merely *named* like a protected directory
        # elsewhere in the tree must not trigger the guard.
        for path in ("docs/apps/overview.png", "notes/Dockerfile", "docs/scripts/example.py"):
            with self.subTest(path=path):
                self.assertFalse(is_protected(path))


if __name__ == "__main__":
    unittest.main()
