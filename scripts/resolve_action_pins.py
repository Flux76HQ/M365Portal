#!/usr/bin/env python3
"""Resolve the commit SHA of the highest stable tag of every third-party action (FR-A-174, SA-01).

Workflows pin every third-party action by full commit SHA with the version in a trailing comment.
This script looks the SHAs up with `git ls-remote --tags` (public repositories need no token) and
prints the table of plan 12.3, so a pin can be re-resolved on the day it is written or bumped.

    python scripts/resolve_action_pins.py                 resolve the highest stable tag of each
    python scripts/resolve_action_pins.py --pinned        resolve the versions the workflows use
    python scripts/resolve_action_pins.py actions/checkout   one action

An annotated tag points at a tag object, not at a commit: the line `<sha> refs/tags/<tag>^{}` carries
the commit, and it wins over the tag object. Pre-releases and moving aliases such as `v4` are never
chosen. Exit status: 0 resolved, 1 a tag could not be resolved, 2 git could not be run.
"""
from __future__ import annotations

import argparse
import datetime
import re
import subprocess
import sys

# Repository to look the tags up in. codeql-action pins the `init`/`analyze` sub-actions through
# the same tag; actionlint is only a download script, pinned the same way.
ACTIONS: dict[str, str] = {
    "actions/checkout": "v7.0.1",
    "actions/setup-node": "v7.1.0",
    "actions/upload-artifact": "v7.0.2",
    "docker/setup-qemu-action": "v4.4.0",
    "docker/setup-buildx-action": "v4.4.1",
    "docker/login-action": "v4.6.0",
    "docker/metadata-action": "v6.2.0",
    "docker/build-push-action": "v7.4.0",
    "aquasecurity/trivy-action": "v0.36.0",
    "sigstore/cosign-installer": "v4.1.2",
    "actions/attest-build-provenance": "v4.2.2",
    "actions/attest-sbom": "v4.1.0",
    "github/codeql-action": "v4.38.3",
    "rhysd/actionlint": "v1.7.12",
}

STABLE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
LINE = re.compile(r"^([0-9a-f]{40})\trefs/tags/(.+)$")


class PinError(Exception):
    """A tag could not be resolved to a commit."""


def parse_ls_remote(text: str) -> dict[str, str]:
    """Map tag name to commit SHA; the peeled `^{}` commit beats the tag object."""
    tags: dict[str, str] = {}
    peeled: dict[str, str] = {}
    for line in text.splitlines():
        match = LINE.match(line.strip())
        if not match:
            continue
        sha, ref = match.groups()
        if ref.endswith("^{}"):
            peeled[ref[:-3]] = sha
        else:
            tags[ref] = sha
    tags.update(peeled)
    return tags


def version_key(tag: str) -> tuple[int, int, int]:
    match = STABLE.match(tag)
    if not match:
        raise PinError(f"not a stable version tag: {tag}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def highest_stable(tags: dict[str, str]) -> str:
    stable = [tag for tag in tags if STABLE.match(tag)]
    if not stable:
        raise PinError("no stable vX.Y.Z tag found")
    return max(stable, key=version_key)


def resolve_from_output(repo: str, text: str, wanted: str | None = None) -> tuple[str, str]:
    tags = parse_ls_remote(text)
    if wanted is not None:
        if wanted not in tags:
            raise PinError(f"{repo}: tag {wanted} not found")
        return wanted, tags[wanted]
    try:
        tag = highest_stable(tags)
    except PinError as error:
        raise PinError(f"{repo}: {error}") from error
    return tag, tags[tag]


def ls_remote(repo: str) -> str:
    try:
        done = subprocess.run(
            ["git", "ls-remote", "--tags", f"https://github.com/{repo}"],
            capture_output=True, text=True, check=False, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"cannot run git ls-remote for {repo}: {error}", file=sys.stderr)
        raise SystemExit(2) from error
    if done.returncode != 0:
        raise PinError(f"{repo}: git ls-remote failed: {done.stderr.strip()}")
    return done.stdout


def format_pin(repo: str, version: str, sha: str) -> str:
    return f"{repo}@{sha} # {version}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("actions", nargs="*", help="owner/repo (default: every action of plan 12.3)")
    parser.add_argument("--pinned", action="store_true",
                        help="resolve the version the table lists instead of the highest stable tag")
    args = parser.parse_args(argv)
    names = args.actions or list(ACTIONS)
    failed = False
    print(f"# resolved on {datetime.date.today().isoformat()}")
    for name in names:
        try:
            wanted = ACTIONS.get(name) if args.pinned else None
            version, sha = resolve_from_output(name, ls_remote(name), wanted)
        except PinError as error:
            print(f"ERROR {error}", file=sys.stderr)
            print("  remediation: check the repository name and that the tag exists upstream.",
                  file=sys.stderr)
            failed = True
            continue
        print(format_pin(name, version, sha))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
