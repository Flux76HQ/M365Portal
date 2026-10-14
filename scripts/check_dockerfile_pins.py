#!/usr/bin/env python3
"""Fail when a FROM line of the Dockerfile is not pinned by digest (FR-A-164, plan 12.1).

Every `FROM` carries a literal `@sha256:<64 hex>` digest and no `latest` tag, so a rebuild cannot
silently pick up a different base image; Dependabot proposes the bumps. Exempt are `FROM scratch`
and `FROM <earlier stage name>`. An image name built from a variable cannot be checked and fails.

    python scripts/check_dockerfile_pins.py [DOCKERFILE ...]    default: ./Dockerfile of the repository

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


def check(text: str) -> list[str]:
    """The problems found in the text of a Dockerfile; empty when every FROM is pinned."""
    problems: list[str] = []
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
