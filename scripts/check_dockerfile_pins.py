#!/usr/bin/env python3
"""Fail when a FROM line of the Dockerfile is not pinned by digest (FR-A-164, plan 12.1).

Every `FROM` carries a literal `@sha256:<64 hex>` digest and no `latest` tag, so a rebuild cannot
silently pick up a different base image; Dependabot proposes the bumps. Exempt are `FROM scratch`
and `FROM <earlier stage name>`. An image name built from a variable cannot be checked and fails.

    python scripts/check_dockerfile_pins.py [DOCKERFILE ...]    default: ./Dockerfile of the repository

Phase D (FR-D-106): a Dockerfile that installs PowerShell also pins the Exchange runtime: exact
MAJOR.MINOR.PATCH versions (POWERSHELL_VERSION, EXO_VERSION), full-length lowercase checksums, a
checksum verified in the same RUN as each download, `Install-Module` with `-RequiredVersion`, and no
PowerShell from a package manager.

Exit status: 0 all pinned, 1 findings (each with its line number), 2 a file could not be read.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parent.parent
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")


def logical_lines(text: str):
    """(line number, text) of each instruction, backslash continuations joined, comments dropped."""
    buffer: list[str] = []
    start = 0
    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if not buffer and (not stripped or stripped.startswith("#")):
            continue
        if not buffer:
            start = number
        if stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            buffer.append(stripped[:-1].strip())
            continue
        buffer.append(stripped)
        yield start, " ".join(part for part in buffer if part)
        buffer = []
    if buffer:
        yield start, " ".join(part for part in buffer if part)


SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
EXCHANGE_ARGUMENTS = {
    "POWERSHELL_VERSION": SEMVER,
    "POWERSHELL_SHA256_AMD64": re.compile(r"^[0-9a-f]{64}$"),
    "POWERSHELL_SHA256_ARM64": re.compile(r"^[0-9a-f]{64}$"),
    "EXO_VERSION": SEMVER,
    "EXO_SHA512": re.compile(r"^[0-9a-f]{128}$"),
}
DOWNLOAD = re.compile(r"\b(curl|wget)\b")
CHECKSUM = re.compile(r"\bsha(256|512)sum\b[^;&|]*--check\b|\bsha(256|512)sum\b[^;&|]*\s-c\b")
PACKAGE_INSTALL = re.compile(r"\b(?:apt-get|apt|dnf|yum|microdnf|apk|zypper)\b[^&;|]*?\b(?:install|add)\b([^&;|]*)")


def exchange_arguments(text: str) -> dict[str, str]:
    """The values of the ARG lines that pin the Exchange runtime (first occurrence of each)."""
    found: dict[str, str] = {}
    for _, line in logical_lines(text):
        words = line.split(None, 1)
        if len(words) == 2 and words[0].upper() == "ARG" and "=" in words[1]:
            name, value = words[1].split("=", 1)
            if name in EXCHANGE_ARGUMENTS and name not in found:
                found[name] = value.strip().strip('"')
    return found


def check_exchange(text: str) -> list[str]:
    """The pins of the Exchange runtime; nothing is asked of a Dockerfile that does not use PowerShell."""
    lines = list(logical_lines(text))
    if not any("powershell" in line.lower() for _, line in lines):
        return []
    problems: list[str] = []
    values = exchange_arguments(text)
    for name, shape in EXCHANGE_ARGUMENTS.items():
        if name not in values:
            problems.append(f"ARG {name} is missing: pin it (Exchange runtime, FR-D-106)")
        elif not shape.match(values[name]):
            problems.append(f"ARG {name}={values[name]!r} is not an exact pin of the expected shape")
    for number, line in lines:
        words = line.split(None, 1)
        if not words or words[0].upper() != "RUN":
            continue
        if DOWNLOAD.search(line) and re.search(r"https?://", line) and not CHECKSUM.search(line):
            problems.append(f"line {number}: a download without a checksum verified in the same RUN")
        if re.search(r"\bInstall-Module\b", line) and "-RequiredVersion" not in line:
            problems.append(f"line {number}: Install-Module without -RequiredVersion")
        for match in PACKAGE_INSTALL.finditer(line):
            if any(re.match(r"^powershell", token, re.I) for token in match.group(1).split()):
                problems.append(f"line {number}: PowerShell from a package manager; use the pinned, checksummed archive")
    return problems


def check(text: str) -> list[str]:
    """The problems found in the text of a Dockerfile; empty when every FROM is pinned."""
    problems: list[str] = check_exchange(text)
    stages: set[str] = set()
    seen_from = False
    for number, line in logical_lines(text):
        words = line.split()
        if not words or words[0].upper() != "FROM":
            continue
        seen_from = True
        arguments = [word for word in words[1:] if not word.startswith("--")]
        if not arguments:
            problems.append(f"line {number}: FROM without an image")
            continue
        image = arguments[0]
        if len(arguments) >= 3 and arguments[1].upper() == "AS":
            stages.add(arguments[2].lower())
        if image == "scratch" or image.lower() in stages:
            continue
        if "$" in image:
            problems.append(f"line {number}: FROM {image} is built from a variable; write the image and its digest literally")
        elif not DIGEST.search(image):
            problems.append(
                f"line {number}: FROM {image} has no literal @sha256:<64 hex> digest. "
                "Resolve it with `docker buildx imagetools inspect <image:tag>` and write "
                "image:tag@sha256:... (plan 12.1)"
            )
        else:
            name = image.split("@", 1)[0]
            tag = name.rsplit(":", 1)[1] if ":" in name.rsplit("/", 1)[-1] else ""
            if tag == "latest":
                problems.append(f"line {number}: FROM {image} uses the floating tag latest; name a version tag")
    if not seen_from:
        problems.append("no FROM line found: this does not look like a Dockerfile")
    return problems


def main(argv: list[str]) -> int:
    paths = [Path(argument) for argument in argv] or [REPOSITORY / "Dockerfile"]
    failed = False
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            print(f"check_dockerfile_pins: cannot read {path}: {error}", file=sys.stderr)
            return 2
        for problem in check(text):
            failed = True
            print(f"{path}: {problem}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
