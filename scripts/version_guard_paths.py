"""The single definition of which paths require a VERSION bump.

Both `check_version_bump.py` (CI and pre-commit) and `bump_version.py` import
this module, so the guard and the bumper can never disagree about what is
protected. Documentation-only files (`*.md`, `*.txt`) are exempt even inside a
protected path.
"""
import re

PROTECTED_PATTERNS = (
    # Runtime code
    re.compile(r"^apps/"),
    re.compile(r"^packages/"),
    # Build, deploy and CI surfaces
    re.compile(r"^deploy/"),
    re.compile(r"^scripts/"),
    re.compile(r"^\.github/workflows/"),
    re.compile(r"^\.github/copilot-instructions\.md$"),
    re.compile(r"^Dockerfile$"),
    re.compile(r"^\.dockerignore$"),
    re.compile(r"^docker-compose[^/]*\.ya?ml$"),
    re.compile(r"^\.env\.example$"),
    # Dependency graph: a lockfile or workspace change changes what ships
    re.compile(r"^package\.json$"),
    re.compile(r"^pnpm-lock\.yaml$"),
    re.compile(r"^pnpm-workspace\.yaml$"),
)


def normalize(path: str) -> str:
    return path.strip().replace("\\", "/")


def is_doc_only(path: str) -> bool:
    lowered = path.lower()
    return lowered.endswith(".md") or lowered.endswith(".txt")


def is_protected(path: str) -> bool:
    return any(pattern.search(path) for pattern in PROTECTED_PATTERNS)


def needs_bump(path: str) -> bool:
    """True when a change to this path must be accompanied by a VERSION bump."""
    return is_protected(path) and not is_doc_only(path)
