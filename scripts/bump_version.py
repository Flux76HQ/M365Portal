#!/usr/bin/env python3
import argparse
import re
import subprocess
import sys
from pathlib import Path

from version_guard_paths import needs_bump, normalize


def run_git(*args: str) -> str:
    result = subprocess.run(
        ["git", "--no-pager", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout


def parse_version(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value.strip())
    if not match:
        raise ValueError(f"Invalid VERSION format '{value}'. Expected MAJOR.MINOR.PATCH")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", choices=("patch", "minor", "major"), default="patch")
    args = parser.parse_args()

    version_path = Path("VERSION")
    if not version_path.exists():
        version_path.write_text("0.1.0", encoding="utf-8")
        print("Created VERSION at 0.1.0")
        return 0

    staged = [normalize(p) for p in run_git("diff", "--cached", "--name-only").splitlines() if p.strip()]
    working = [normalize(p) for p in run_git("diff", "--name-only").splitlines() if p.strip()]
    files = sorted(set(staged + working))

    bump_required = any(needs_bump(p) for p in files)
    if not bump_required:
        print("No protected non-doc changes detected. VERSION unchanged.")
        return 0

    if "VERSION" in files:
        print("VERSION already modified in this change set. Skipping bump.")
        return 0

    major, minor, patch = parse_version(version_path.read_text(encoding="utf-8").strip())
    if args.part == "major":
        major += 1
        minor = 0
        patch = 0
    elif args.part == "minor":
        minor += 1
        patch = 0
    else:
        patch += 1

    next_version = f"{major}.{minor}.{patch}"
    current = version_path.read_text(encoding="utf-8").strip()
    version_path.write_text(next_version, encoding="utf-8")
    print(f"VERSION bumped: {current} -> {next_version}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
