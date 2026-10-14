"""Tests for scripts/check_dockerfile_pins.py (FR-A-164, T-A-231).

Every FROM of a Dockerfile must carry a literal `@sha256:` digest and no `latest` tag. The negative
cases are the point: a floating tag, a missing digest and a digest on only one of two stages each
have to fail, and the real Dockerfile of the repository has to pass.
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import check_dockerfile_pins as pins

SCRIPTS = Path(__file__).resolve().parent
REPOSITORY = SCRIPTS.parent
SCRIPT = SCRIPTS / "check_dockerfile_pins.py"

DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64

GOOD = f"""# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@{DIGEST_A} AS build
RUN echo build
FROM gcr.io/distroless/nodejs22-debian12:nonroot@{DIGEST_B}
COPY --from=build /out /app
"""


class CheckTest(unittest.TestCase):
    def test_accepts_two_pinned_stages(self):
        self.assertEqual(pins.check(GOOD), [])

    def test_accepts_platform_flag_and_stage_reference_and_scratch(self):
        text = (
            f"FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@{DIGEST_A} AS build\n"
            "FROM build AS again\n"
            "FROM scratch\n"
        )
        self.assertEqual(pins.check(text), [])

    def test_ignores_from_inside_comments_and_run_lines(self):
        text = f"# FROM node:latest\nFROM node:22@{DIGEST_A}\nRUN echo FROM node:latest\n"
        self.assertEqual(pins.check(text), [])

    def test_floating_tag_fails(self):
        text = GOOD.replace(f"node:22-bookworm-slim@{DIGEST_A}", "node:22-bookworm-slim")
        problems = pins.check(text)
        self.assertEqual(len(problems), 1)
        self.assertIn("digest", problems[0])
        self.assertIn("line 2", problems[0])

    def test_latest_tag_fails_even_with_a_digest(self):
        text = GOOD.replace("nodejs22-debian12:nonroot", "nodejs22-debian12:latest")
        problems = pins.check(text)
        self.assertEqual(len(problems), 1)
        self.assertIn("latest", problems[0])

    def test_missing_tag_and_digest_fails(self):
        problems = pins.check("FROM node\n")
        self.assertEqual(len(problems), 1)

    def test_digest_on_only_one_of_two_stages_fails(self):
        for victim in ("build", "runtime"):
            with self.subTest(victim=victim):
                text = GOOD
                if victim == "build":
                    text = text.replace(f"@{DIGEST_A}", "")
                else:
                    text = text.replace(f"@{DIGEST_B}", "")
                problems = pins.check(text)
                self.assertEqual(len(problems), 1)

    def test_short_or_malformed_digest_fails(self):
        for bad in ("sha256:abc", "sha256:" + "g" * 64, "sha1:" + "a" * 40, "sha256:" + "A" * 64):
            with self.subTest(bad=bad):
                text = GOOD.replace(DIGEST_A, bad)
                self.assertEqual(len(pins.check(text)), 1)

    def test_variable_image_name_fails(self):
        for image in ("${BASE}", "$BASE", f"node:${{TAG}}@{DIGEST_A}"):
            with self.subTest(image=image):
                self.assertEqual(len(pins.check(f"FROM {image}\n")), 1)

    def test_line_continuation_is_joined(self):
        text = f"FROM --platform=$BUILDPLATFORM \\\n    node:22@{DIGEST_A} AS build\n"
        self.assertEqual(pins.check(text), [])

    def test_no_from_at_all_fails(self):
        self.assertEqual(len(pins.check("RUN echo hi\n")), 1)

    def test_every_problem_is_reported(self):
        problems = pins.check("FROM node:latest\nFROM debian\n")
        self.assertEqual(len(problems), 2)


class ScriptTest(unittest.TestCase):
    def run_script(self, *args: str):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
        )

    def test_real_dockerfile_passes(self):
        result = self.run_script(str(REPOSITORY / "Dockerfile"))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_default_path_is_the_repository_dockerfile(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_file_exits_one_with_the_finding_on_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Dockerfile"
            path.write_text("FROM node:latest\n", encoding="utf-8")
            result = self.run_script(str(path))
        self.assertEqual(result.returncode, 1)
        self.assertIn("FROM", result.stderr)

    def test_missing_file_exits_two(self):
        result = self.run_script("/nonexistent/Dockerfile")
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
