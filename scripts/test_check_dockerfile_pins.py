"""Tests for scripts/check_dockerfile_pins.py (FR-A-164, T-A-231; Phase D: FR-D-106, T-D-117).

Every FROM of a Dockerfile must carry a literal `@sha256:` digest and no `latest` tag. The negative
cases are the point: a floating tag, a missing digest and a digest on only one of two stages each
have to fail, and the real Dockerfile of the repository has to pass.

Phase D adds the pins of the Exchange runtime: when a Dockerfile installs PowerShell, the version of
PowerShell and of the Exchange Online module are exact (MAJOR.MINOR.PATCH), each download has a full
checksum that is verified in the same RUN, `Install-Module` carries `-RequiredVersion`, and PowerShell
is never installed from a package manager at whatever version the archive has today.
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


def exchange_dockerfile(**replace: str) -> str:
    """The shape of the Phase D stage, with room to plant one defect (the key is the text to replace)."""
    text = f"""FROM ubuntu:24.04@{DIGEST_B} AS pwsh-fetch
ARG TARGETARCH
ARG POWERSHELL_VERSION=7.6.6
ARG POWERSHELL_SHA256_AMD64={"a" * 64}
ARG POWERSHELL_SHA256_ARM64={"b" * 64}
ARG EXO_VERSION=3.10.1
ARG EXO_SHA512={"c" * 128}
RUN set -eu; \\
    curl --fail --location --output /tmp/powershell.tar.gz "https://github.com/PowerShell/PowerShell/releases/download/v${{POWERSHELL_VERSION}}/powershell-${{POWERSHELL_VERSION}}-linux-x64.tar.gz"; \\
    echo "${{POWERSHELL_SHA256_AMD64}}  /tmp/powershell.tar.gz" | sha256sum --check --strict -; \\
    tar --extract --gzip --file /tmp/powershell.tar.gz --directory /opt/microsoft/powershell/7
RUN set -eu; \\
    curl --fail --location --output /tmp/exo.nupkg "https://www.powershellgallery.com/api/v2/package/ExchangeOnlineManagement/${{EXO_VERSION}}"; \\
    echo "${{EXO_SHA512}}  /tmp/exo.nupkg" | sha512sum --check --strict -; \\
    unzip -q /tmp/exo.nupkg -d /usr/local/share/powershell/Modules/ExchangeOnlineManagement/${{EXO_VERSION}}
"""
    for old, new in replace.items():
        assert old in text, old
        text = text.replace(old, new)
    return text


class ExchangeRuntimePins(unittest.TestCase):
    def problems(self, text: str) -> list[str]:
        return pins.check(text)

    def test_the_good_shape_passes(self):
        self.assertEqual(self.problems(exchange_dockerfile()), [])

    def test_a_dockerfile_without_powershell_needs_none_of_it(self):
        self.assertEqual(pins.check(GOOD), [])

    def test_an_unpinned_from_in_the_stage_still_fails(self):
        problems = self.problems(exchange_dockerfile(**{f"ubuntu:24.04@{DIGEST_B}": "ubuntu:24.04"}))
        self.assertEqual(len(problems), 1)
        self.assertIn("digest", problems[0])

    def test_a_floating_or_ranged_version_fails(self):
        for bad in ("latest", "7", "7.6", "^7.6.6", "~7.6.6", "7.6.*", ">=7.6.6", "7.6.6-preview", ""):
            for name in ("POWERSHELL_VERSION", "EXO_VERSION"):
                with self.subTest(name=name, bad=bad):
                    good = "7.6.6" if name == "POWERSHELL_VERSION" else "3.10.1"
                    problems = self.problems(exchange_dockerfile(**{f"ARG {name}={good}": f"ARG {name}={bad}"}))
                    self.assertTrue(any(name in problem for problem in problems), problems)

    def test_a_missing_version_argument_fails(self):
        for name, good in (("POWERSHELL_VERSION", "7.6.6"), ("EXO_VERSION", "3.10.1")):
            with self.subTest(name=name):
                problems = self.problems(exchange_dockerfile(**{f"ARG {name}={good}\n": ""}))
                self.assertTrue(any(name in problem for problem in problems), problems)

    def test_a_short_or_malformed_checksum_fails(self):
        for name, length in (("POWERSHELL_SHA256_AMD64", 64), ("POWERSHELL_SHA256_ARM64", 64), ("EXO_SHA512", 128)):
            fill = {"POWERSHELL_SHA256_AMD64": "a", "POWERSHELL_SHA256_ARM64": "b", "EXO_SHA512": "c"}[name]
            for bad in (fill * (length - 1), fill * (length + 1), "g" * length, fill.upper() * length, ""):
                with self.subTest(name=name, bad=bad[:8]):
                    problems = self.problems(
                        exchange_dockerfile(**{f"ARG {name}={fill * length}": f"ARG {name}={bad}"})
                    )
                    self.assertTrue(any(name in problem for problem in problems), problems)

    def test_a_download_without_a_checksum_check_in_the_same_run_fails(self):
        text = exchange_dockerfile(
            **{'    echo "${POWERSHELL_SHA256_AMD64}  /tmp/powershell.tar.gz" | sha256sum --check --strict -; \\\n': ""}
        )
        problems = self.problems(text)
        self.assertTrue(any("checksum" in problem for problem in problems), problems)

    def test_a_checksum_in_another_run_does_not_count(self):
        text = exchange_dockerfile(
            **{'    echo "${EXO_SHA512}  /tmp/exo.nupkg" | sha512sum --check --strict -; \\\n': "RUN true\n"}
        )
        self.assertTrue(any("checksum" in problem for problem in self.problems(text)))

    def test_install_module_needs_a_required_version(self):
        base = exchange_dockerfile()
        good = base + "RUN pwsh -Command Install-Module ExchangeOnlineManagement -RequiredVersion 3.10.1 -Force\n"
        self.assertEqual(self.problems(good), [])
        for bad in (
            "RUN pwsh -Command Install-Module ExchangeOnlineManagement -Force\n",
            "RUN pwsh -Command Install-Module -Name ExchangeOnlineManagement -MinimumVersion 3.0.0\n",
            "RUN pwsh -Command Install-Module ExchangeOnlineManagement -AllowPrerelease\n",
        ):
            with self.subTest(bad=bad):
                self.assertTrue(
                    any("Install-Module" in problem for problem in self.problems(base + bad)),
                    self.problems(base + bad),
                )

    def test_powershell_from_a_package_manager_fails(self):
        base = exchange_dockerfile()
        for bad in (
            "RUN apt-get install -y powershell\n",
            "RUN apt-get update && apt-get install -y --no-install-recommends curl powershell-lts\n",
            "RUN apt install powershell=7.6.6-1.deb\n",
            "RUN dnf install -y powershell\n",
        ):
            with self.subTest(bad=bad):
                self.assertTrue(
                    any("package manager" in problem for problem in self.problems(base + bad)),
                    self.problems(base + bad),
                )

    def test_packages_that_only_look_like_powershell_are_fine(self):
        base = exchange_dockerfile()
        self.assertEqual(self.problems(base + "RUN apt-get install -y --no-install-recommends ca-certificates libicu74\n"), [])

    def test_the_versions_of_the_dockerfile_are_the_ones_the_image_check_expects(self):
        import check_image_contents as contents

        text = (REPOSITORY / "Dockerfile").read_text(encoding="utf-8")
        values = pins.exchange_arguments(text)
        self.assertEqual(values["POWERSHELL_VERSION"], contents.POWERSHELL_VERSION)
        self.assertEqual(values["EXO_VERSION"], contents.EXCHANGE_MODULE_VERSION)

    def test_the_real_dockerfile_passes_with_every_pin_present(self):
        text = (REPOSITORY / "Dockerfile").read_text(encoding="utf-8")
        self.assertEqual(pins.check(text), [])
        values = pins.exchange_arguments(text)
        self.assertEqual(
            sorted(values),
            ["EXO_SHA512", "EXO_VERSION", "POWERSHELL_SHA256_AMD64", "POWERSHELL_SHA256_ARM64", "POWERSHELL_VERSION"],
        )


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
