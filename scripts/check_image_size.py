#!/usr/bin/env python3
"""Fail when the built image is larger than the ceiling (FR-A-168).

The ceiling is one constant, CEILING_MEGABYTES, and it equals `imageSizeCeilingMegabytes` in
packages/shared/src/limits.ts (the single source of every limit; test_check_image_size.py compares
the two). A megabyte is 1,000,000 bytes, which is what `docker images` prints. The size is the
uncompressed size Docker reports for the image (`docker image inspect`, field `Size`), not what a
registry transfers.

    python scripts/check_image_size.py                      the local build, m365portal:local
    python scripts/check_image_size.py IMAGE                another image
    python scripts/check_image_size.py --inspect-json FILE  a saved `docker image inspect IMAGE`
    python scripts/check_image_size.py --size-bytes N       a number, for a quick check

Exit status: 0 within the ceiling, 1 over it, 2 when the size could not be determined (Docker
missing or not running, unreadable input). An unknown size is never a pass.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

DEFAULT_IMAGE = "m365portal:local"

# The one constant. Docker prints MB as 1,000,000 bytes.
CEILING_MEGABYTES = 600
MEGABYTE = 1_000_000
CEILING_BYTES = CEILING_MEGABYTES * MEGABYTE


def megabytes(size_bytes: int) -> str:
    return f"{size_bytes / MEGABYTE:.1f} MB"


def check(size_bytes: int) -> list[str]:
    """The problems with an image of this size; empty when it is within the ceiling."""
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes <= 0:
        raise ValueError(f"an image size must be a positive number of bytes, got {size_bytes!r}")
    if size_bytes <= CEILING_BYTES:
        return []
    return [
        f"the image is {megabytes(size_bytes)} uncompressed, over the ceiling of "
        f"{CEILING_MEGABYTES} MB (FR-A-168).\n"
        "  Find what grew:  docker history --no-trunc IMAGE   (largest layers first)\n"
        "  Usual causes:    a development dependency or a test, source map or lock file in /app; a\n"
        "                   second copy of node_modules; an unpruned native prebuild (better-sqlite3\n"
        "                   keeps one prebuild for TARGETARCH only); a new runtime dependency.\n"
        "  If the growth is deliberate and understood, raise the ceiling in the same pull request:\n"
        "  CEILING_MEGABYTES in scripts/check_image_size.py and imageSizeCeilingMegabytes in\n"
        "  packages/shared/src/limits.ts, and state the new value as a number in the pull request\n"
        "  description (AGENTS.md section 5)."
    ]


def size_from_inspect(document: object) -> int:
    """The `Size` of the first image of a `docker image inspect` result."""
    if not isinstance(document, list) or not document or not isinstance(document[0], dict):
        raise ValueError("expected the JSON array that `docker image inspect` prints")
    size = document[0].get("Size")
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise ValueError("the inspect document has no positive integer `Size`")
    return size


def inspect_image(image: str) -> object:
    """Ask Docker for the image. Raises RuntimeError with a message the operator can act on."""
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", image],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        raise RuntimeError("docker is not installed or not on PATH") from None
    if result.returncode != 0:
        detail = (result.stderr.strip() or result.stdout.strip() or "no output").splitlines()[0]
        raise RuntimeError(f"`docker image inspect {image}` failed: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"`docker image inspect {image}` printed no JSON: {error}") from None


def positive_integer(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number of bytes") from None
    if value <= 0:
        raise argparse.ArgumentTypeError("the size must be positive")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("image", nargs="?", default=DEFAULT_IMAGE, help=f"image to check (default {DEFAULT_IMAGE})")
    parser.add_argument("--inspect-json", metavar="FILE", help="a saved `docker image inspect` result")
    parser.add_argument("--size-bytes", type=positive_integer, metavar="N", help="the size in bytes")
    args = parser.parse_args(argv)

    try:
        if args.size_bytes is not None:
            size_bytes, subject = args.size_bytes, "the given size"
        elif args.inspect_json is not None:
            document = json.loads(Path(args.inspect_json).read_text(encoding="utf-8"))
            size_bytes, subject = size_from_inspect(document), args.inspect_json
        else:
            size_bytes, subject = size_from_inspect(inspect_image(args.image)), args.image
        problems = check(size_bytes)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"check_image_size: {error}", file=sys.stderr)
        return 2

    if problems:
        for problem in problems:
            print(f"check_image_size: FAILED for {subject}: {problem}", file=sys.stderr)
        return 1
    print(f"check_image_size: OK, {subject} is {megabytes(size_bytes)} (ceiling {CEILING_MEGABYTES} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
