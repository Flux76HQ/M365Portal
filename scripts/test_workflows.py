"""Static tests of the GitHub Actions workflows (FR-A-170 to FR-A-176, T-A-251; plan Appendix C).

Nothing here runs a workflow: GitHub Actions cannot be executed outside GitHub. The checks parse
`.github/workflows/*.yml` and assert the properties a reviewer would otherwise have to remember:
job and step names the documents cite, SHA pins with a version comment, least-privilege
permissions, the release gate of plan 12.4, the conditional cosign step, the Trivy settings, the
Trivy ignore-entry format, remediation hints, and concurrency.

Every check is a function that returns a list of problems. The real workflows must give an empty
list; the negative fixtures at the bottom mutate a copy of them (or of a text) and must give a
non-empty list, so a check nobody has seen fail cannot slip in (AGENTS.md section 9, baseline
section 2).
"""
from __future__ import annotations

import copy
import datetime
import re
import unittest
from pathlib import Path
from typing import Any

import yaml

REPOSITORY = Path(__file__).resolve().parent.parent
WORKFLOWS = REPOSITORY / ".github" / "workflows"

# Plan Appendix C. The steps listed must appear in this order; a workflow may add steps between
# them (hint steps, setup steps) but may not drop, rename or reorder one.
REQUIRED_STEPS: dict[tuple[str, str], list[str]] = {
    ("ci.yml", "quality"): [
        "Checkout", "Enable corepack", "Setup Node", "Install (frozen lockfile)",
        "Generate route tree", "Route tree freshness", "Lint", "Typecheck",
        "Unit and integration tests", "i18n catalogue checks", "Schema snapshot check",
        "Schema drift check", "Build", "Bundle budget", "Docs contract",
        "Dependency audit (production)", "Dependency audit (all, high)", "Secret scan",
        "Workflow lint", "Python governance and deploy tests",
    ],
    ("ci.yml", "e2e"): [
        "Checkout", "Enable corepack", "Setup Node", "Install (frozen lockfile)",
        "Generate route tree", "Build", "Install Playwright browser",
        "Playwright (e2e, axe, visual)", "Lighthouse", "Upload artefacts",
    ],
    ("image.yml", "image"): [
        "Checkout", "Read version", "Set up Buildx", "Build image (amd64)",
        "Container smoke test", "Image size budget", "Image contents check",
        "Compose config check", "Trivy image scan", "Trivy secret scan",
        "Generate CycloneDX SBOM", "Upload SBOM",
    ],
    ("image.yml", "publish"): [
        "Checkout", "Read version", "Decide release tag", "Create release tag",
        "Set up QEMU", "Set up Buildx", "Log in to GHCR", "Docker metadata", "Build and push",
        "Smoke test arm64 image", "Install cosign", "Sign image (public repositories)",
        "Attest build provenance", "Generate CycloneDX SBOM from digest", "Attest SBOM",
        "Verify signature and attestations", "Create GitHub release",
    ],
    ("codeql.yml", "analyze"): ["Checkout", "Initialize CodeQL", "Analyze"],
}
EXACT_JOBS = {"ci.yml": {"quality", "e2e"}, "image.yml": {"image", "publish"},
              "codeql.yml": {"analyze"}}
GOVERNANCE_JOBS = {"version-guardrails.yml": "enforce-version-bump",
                   "agent-instructions.yml": "agent-instructions-lint"}

# Check steps that must print a remediation hint when they fail (plan section 2, "CI guardrails").
CHECK_STEPS: dict[tuple[str, str], list[str]] = {
    ("ci.yml", "quality"): [
        "Route tree freshness", "Lint", "Typecheck", "Unit and integration tests",
        "i18n catalogue checks", "Schema snapshot check", "Schema drift check", "Build",
        "Bundle budget", "Docs contract", "Dependency audit (production)",
        "Dependency audit (all, high)", "Secret scan", "Workflow lint",
        "Python governance and deploy tests",
    ],
    ("ci.yml", "e2e"): ["Playwright (e2e, axe, visual)", "Lighthouse"],
    ("image.yml", "image"): [
        "Container smoke test", "Image size budget", "Image contents check",
        "Compose config check", "Trivy image scan", "Trivy secret scan",
    ],
    ("image.yml", "publish"): ["Verify signature and attestations"],
}

# The only jobs that may hold write scopes, and the scopes they may hold (FR-A-174).
WRITE_SCOPES = {"contents", "packages", "id-token", "attestations", "security-events"}
ALLOWED_WRITES: dict[tuple[str, str], set[str]] = {
    ("image.yml", "publish"): {"contents", "packages", "id-token", "attestations"},
    ("codeql.yml", "analyze"): {"security-events"},
}

PIN_USES = re.compile(r"^[\w.-]+/[\w.-]+(/[\w./-]+)?@[0-9a-f]{40}$")
PIN_LINE = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<ref>\S+)(?P<rest>.*)$")
VERSION_COMMENT = re.compile(r"^\s+#\s*v\d+\.\d+\.\d+\s*$")
EXPIRY = re.compile(r"\bexp:(\d{4}-\d{2}-\d{2})\b")
VERSION_TAG_LINE = re.compile(r"type=raw,value=v")
ENABLE_GATE = re.compile(
    r"^\s*type=raw,value=v\$\{\{\s*steps\.version\.outputs\.version\s*\}\},"
    r"enable=\$\{\{\s*steps\.release_tag\.outputs\.created\s*==\s*'true'\s*\}\}\s*$")


def load(name: str) -> dict[str, Any]:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def raw(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    # YAML 1.1 reads the bare key `on` as the boolean True.
    value = workflow.get("on", workflow.get(True))
    if isinstance(value, str):
        return {value: None}
    if isinstance(value, list):
        return {item: None for item in value}
    return value or {}


def steps_of(workflow: dict[str, Any], job: str) -> list[dict[str, Any]]:
    return workflow["jobs"][job]["steps"]


def step_named(workflow: dict[str, Any], job: str, name: str) -> dict[str, Any] | None:
    return next((s for s in steps_of(workflow, job) if s.get("name") == name), None)


def index_of(workflow: dict[str, Any], job: str, name: str) -> int:
    for position, step in enumerate(steps_of(workflow, job)):
        if step.get("name") == name:
            return position
    return -1


def text_of(step: dict[str, Any] | None) -> str:
    """Everything executable or conditional in a step, for substring rules."""
    if step is None:
        return ""
    return "\n".join(str(step.get(key, "")) for key in ("if", "run", "with", "env", "uses"))


# ---------------------------------------------------------------------------------------------
# Checks. Each returns a list of problems; empty means the rule holds.
# ---------------------------------------------------------------------------------------------

def check_names(file: str, workflow: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    expected_jobs = EXACT_JOBS.get(file)
    if expected_jobs is not None and set(workflow.get("jobs", {})) != expected_jobs:
        problems.append(f"{file}: jobs are {sorted(workflow.get('jobs', {}))}, expected "
                        f"{sorted(expected_jobs)}")
    for (wanted_file, job), names in REQUIRED_STEPS.items():
        if wanted_file != file or job not in workflow.get("jobs", {}):
            continue
        actual = [s.get("name") for s in steps_of(workflow, job)]
        position = 0
        for name in names:
            try:
                position = actual.index(name, position) + 1
            except ValueError:
                where = "out of order" if name in actual else "missing"
                problems.append(f"{file} job {job}: step {name!r} is {where}")
    return problems


def check_governance_names(workflows: dict[str, dict[str, Any]]) -> list[str]:
    problems = []
    for file, job in GOVERNANCE_JOBS.items():
        if file not in workflows:
            problems.append(f"{file} is missing (FR-A-175)")
        elif job not in workflows[file].get("jobs", {}):
            problems.append(f"{file}: job {job!r} is missing or renamed (FR-A-175)")
    return problems


def check_pins(file: str, text: str) -> list[str]:
    """Every third-party `uses:` is `owner/repo[/path]@<40 hex>` plus a `# vX.Y.Z` comment."""
    problems = []
    for number, line in enumerate(text.splitlines(), start=1):
        match = PIN_LINE.match(line)
        if not match:
            continue
        ref = match.group("ref")
        if ref.startswith("./") or ref.startswith("docker://"):
            problems.append(f"{file}:{number}: local and docker:// actions are not allowed: {ref}")
            continue
        if not PIN_USES.match(ref):
            problems.append(f"{file}:{number}: {ref} is not pinned by a full commit SHA")
        elif not VERSION_COMMENT.match(match.group("rest")):
            problems.append(f"{file}:{number}: {ref} lacks a trailing '# vX.Y.Z' comment")
    return problems


def check_permissions(file: str, workflow: dict[str, Any]) -> list[str]:
    problems = []
    if workflow.get("permissions") != {"contents": "read"}:
        problems.append(f"{file}: workflow-level permissions must be exactly "
                        f"{{contents: read}}, found {workflow.get('permissions')!r}")
    for name, job in workflow.get("jobs", {}).items():
        permissions = job.get("permissions")
        if permissions is None:
            continue
        if not isinstance(permissions, dict):
            problems.append(f"{file} job {name}: permissions must be a mapping, found "
                            f"{permissions!r}")
            continue
        allowed = ALLOWED_WRITES.get((file, name), set())
        for scope, level in permissions.items():
            if level == "write" and scope not in allowed:
                problems.append(f"{file} job {name}: write access to {scope} is not allowed")
            if level == "write" and scope not in WRITE_SCOPES:
                problems.append(f"{file} job {name}: unknown write scope {scope}")
    for (wanted_file, name), allowed in ALLOWED_WRITES.items():
        if wanted_file != file or name not in workflow.get("jobs", {}):
            continue
        held = {k for k, v in (workflow["jobs"][name].get("permissions") or {}).items()
                if v == "write"}
        if held != allowed:
            problems.append(f"{file} job {name}: write scopes are {sorted(held)}, expected "
                            f"{sorted(allowed)}")
    return problems


def check_publish_trigger(workflow: dict[str, Any]) -> list[str]:
    problems = []
    on = triggers(workflow)
    if "push" not in on or "workflow_dispatch" not in on:
        problems.append("image.yml must trigger on push and workflow_dispatch")
    if "pull_request_target" in on:
        problems.append("image.yml must not use pull_request_target")
    if "pull_request" in on and "image" not in workflow["jobs"]:
        problems.append("image.yml: pull requests need the image job")
    publish = workflow["jobs"].get("publish", {})
    condition = str(publish.get("if", ""))
    if not condition:
        problems.append("publish has no job-level condition, so it would run for pull requests")
    if "pull_request" in condition and "!=" not in condition:
        problems.append("publish condition enables pull_request")
    for needle in ("push", "workflow_dispatch", "refs/heads/main"):
        if needle not in condition:
            problems.append(f"publish condition does not mention {needle}")
    if publish.get("needs") != "image" and publish.get("needs") != ["image"]:
        problems.append("publish must need the image job")
    return problems


def check_release_gate(workflow: dict[str, Any]) -> list[str]:
    """Plan 12.4: tag decision and creation before the build; version tag only by their output."""
    problems = []
    job = "publish"
    decide = index_of(workflow, job, "Decide release tag")
    create = index_of(workflow, job, "Create release tag")
    meta = index_of(workflow, job, "Docker metadata")
    build = index_of(workflow, job, "Build and push")
    release = index_of(workflow, job, "Create GitHub release")
    if not (-1 < decide < create < meta < build):
        problems.append("publish: the order must be Decide release tag, Create release tag, "
                        "Docker metadata, Build and push")
    if build > -1 and release > -1 and release < build:
        problems.append("publish: the release is created before the image is pushed")

    decide_step = step_named(workflow, job, "Decide release tag")
    create_step = step_named(workflow, job, "Create release tag")
    meta_step = step_named(workflow, job, "Docker metadata")
    build_step = step_named(workflow, job, "Build and push")
    release_step = step_named(workflow, job, "Create GitHub release")
    if decide_step is None or create_step is None or meta_step is None or build_step is None:
        return problems + ["publish: release gate steps are missing"]

    if decide_step.get("id") != "decide_tag":
        problems.append("Decide release tag needs id decide_tag")
    if create_step.get("id") != "release_tag":
        problems.append("Create release tag needs id release_tag")
    decide_text = text_of(decide_step)
    if "::notice::" not in decide_text:
        problems.append("Decide release tag must say why the version tag is not written "
                        "(::notice::)")
    if "matching-refs" not in decide_text and "git/ref" not in decide_text:
        problems.append("Decide release tag must ask the Git refs API")
    if re.search(r"steps\.decide_tag\.outputs\.exists\s*==\s*'false'", str(create_step.get("if"))) is None:
        problems.append("Create release tag must run only when decide_tag reports exists == 'false'")
    create_text = str(create_step.get("run", ""))
    if "git/refs" not in create_text or "refs/tags/" not in create_text:
        problems.append("Create release tag must create refs/tags/<tag> through the refs API")
    for forbidden in ("--force", "-f force", "force=", "PATCH", "git push", "git tag", "--delete",
                      "-X DELETE"):
        if forbidden in create_text or forbidden in decide_text:
            problems.append(f"the tag steps must never overwrite or delete a tag ({forbidden})")
    if "created=true" not in create_text:
        problems.append("Create release tag must record created=true")

    if meta_step.get("if"):
        problems.append("Docker metadata must not be conditional: the tag list decides")
    tags = str((meta_step.get("with") or {}).get("tags", ""))
    version_lines = [ln for ln in tags.splitlines() if VERSION_TAG_LINE.search(ln)]
    if len(version_lines) != 1:
        problems.append(f"Docker metadata must list the version tag exactly once, found "
                        f"{len(version_lines)}")
    for line in version_lines:
        if not ENABLE_GATE.match(line):
            problems.append("the version image tag must be enabled only by "
                            "steps.release_tag.outputs.created == 'true': " + line.strip())
    if re.search(r"type=(ref|semver|pep440)", tags):
        problems.append("Docker metadata must not derive tags from refs or versions")
    if str((meta_step.get("with") or {}).get("flavor", "")).find("latest=false") < 0:
        problems.append("Docker metadata needs flavor latest=false (the latest tag is explicit)")

    build_with = build_step.get("with") or {}
    if build_with.get("tags") != "${{ steps.meta.outputs.tags }}":
        problems.append("Build and push must take its tags only from steps.meta.outputs.tags")
    if meta_step.get("id") != "meta":
        problems.append("Docker metadata needs id meta")
    if build_step.get("id") != "build":
        problems.append("Build and push needs id build")
    if build_with.get("platforms") != "linux/amd64,linux/arm64":
        problems.append("Build and push must build linux/amd64,linux/arm64")
    if build_with.get("provenance") not in (False, "false") or \
            build_with.get("sbom") not in (False, "false"):
        problems.append("Build and push must set provenance: false and sbom: false")
    if build_with.get("push") not in (True, "true"):
        problems.append("Build and push must push")

    if release_step is not None and re.search(
            r"steps\.release_tag\.outputs\.created\s*==\s*'true'", str(release_step.get("if"))) is None:
        problems.append("Create GitHub release must run only when this run created the tag")

    # No condition anywhere may enable the version tag for an existing tag.
    whole = str(workflow["jobs"][job])
    if re.search(r"exists\s*==\s*'true'[^\n]*(version|v\$\{\{)", whole):
        problems.append("a condition enables the version tag for an existing tag")
    return problems


def check_cosign(workflow: dict[str, Any]) -> list[str]:
    problems = []
    for name in ("Install cosign", "Sign image (public repositories)"):
        step = step_named(workflow, "publish", name)
        if step is None:
            problems.append(f"publish: {name!r} is missing")
        elif "github.event.repository.private == false" not in str(step.get("if", "")):
            problems.append(f"publish: {name!r} must be conditioned on a public repository")
    sign = step_named(workflow, "publish", "Sign image (public repositories)")
    if sign is not None and "cosign sign" not in str(sign.get("run", "")):
        problems.append("publish: the sign step must run cosign sign")
    return problems


def trivy_steps(workflow: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    found = []
    for job_name, job in workflow.get("jobs", {}).items():
        for step in job.get("steps", []):
            if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@"):
                found.append((job_name, step))
    return found


def check_trivy(file: str, workflow: dict[str, Any]) -> list[str]:
    problems = []
    for job, step in trivy_steps(workflow):
        name = step.get("name")
        inputs = step.get("with") or {}
        label = f"{file} job {job} step {name!r}"
        if inputs.get("format") == "cyclonedx":
            if inputs.get("scan-type", "image") != "image" or not inputs.get("output"):
                problems.append(f"{label}: the SBOM step needs scan-type image and an output")
            continue
        if str(inputs.get("exit-code")) != "1":
            problems.append(f"{label}: exit-code must be '1' so a finding fails the job")
        if "trivyignores" in inputs:
            ignore = REPOSITORY / str(inputs["trivyignores"])
            if not ignore.exists():
                problems.append(f"{label}: trivyignores file {inputs['trivyignores']} is missing")
            else:
                problems += [f"{inputs['trivyignores']}: {p}"
                             for p in check_trivy_ignore(ignore.read_text(encoding="utf-8"))]
        if inputs.get("scanners") == "secret":
            continue
        if inputs.get("scanners") != "vuln":
            problems.append(f"{label}: scanners must be 'vuln' or 'secret'")
        if str(inputs.get("ignore-unfixed")).lower() != "true":
            problems.append(f"{label}: ignore-unfixed must be true")
        if inputs.get("severity") != "HIGH,CRITICAL":
            problems.append(f"{label}: severity must be HIGH,CRITICAL")
    return problems


def check_trivy_ignore(text: str, today: datetime.date | None = None) -> list[str]:
    """FR-A-176. Format accepted here: a `# reason` comment line directly above each entry, and
    `exp:YYYY-MM-DD` after the identifier on the entry line (Trivy's .trivyignore syntax; the
    syntax is verified against Trivy's documentation when the first entry is added)."""
    problems = []
    previous_is_reason = False
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            previous_is_reason = False
            continue
        if stripped.startswith("#"):
            previous_is_reason = len(stripped.lstrip("# ").strip()) >= 5
            continue
        if not previous_is_reason:
            problems.append(f"line {number}: ignore entry without a reason comment above it")
        match = EXPIRY.search(stripped)
        if not match:
            problems.append(f"line {number}: ignore entry without an exp:YYYY-MM-DD expiry")
        else:
            try:
                expiry = datetime.date.fromisoformat(match.group(1))
            except ValueError:
                problems.append(f"line {number}: expiry {match.group(1)} is not a date")
            else:
                if expiry < (today or datetime.date.today()):
                    problems.append(f"line {number}: ignore entry expired on {expiry}")
        previous_is_reason = False
    return problems


def has_hint(step: dict[str, Any] | None) -> bool:
    return step is not None and "::error::" in str(step.get("run", "")) \
        and "Remediation" in str(step.get("run", ""))


def check_remediation(file: str, workflow: dict[str, Any]) -> list[str]:
    """A failing check step prints how to fix it: inline for `run:` steps, in a following
    `if: failure()` step for `uses:` steps (an action cannot be wrapped)."""
    problems = []
    for (wanted_file, job), names in CHECK_STEPS.items():
        if wanted_file != file or job not in workflow.get("jobs", {}):
            continue
        steps = steps_of(workflow, job)
        for name in names:
            position = index_of(workflow, job, name)
            if position < 0:
                continue  # a missing step is reported by check_names
            step = steps[position]
            if "run" in step:
                if not has_hint(step):
                    problems.append(f"{file} job {job}: {name!r} prints no remediation hint "
                                    f"(::error:: ... Remediation)")
                continue
            step_id = step.get("id")
            following = steps[position + 1] if position + 1 < len(steps) else None
            ok = (step_id and following is not None and has_hint(following)
                  and re.search(rf"steps\.{step_id}\.outcome\s*==\s*'failure'",
                                str(following.get("if", ""))) is not None
                  and "failure()" in str(following.get("if", "")))
            if not ok:
                problems.append(f"{file} job {job}: {name!r} needs an id and a following "
                                f"if: failure() hint step")
    return problems


def check_concurrency(file: str, workflow: dict[str, Any]) -> list[str]:
    concurrency = workflow.get("concurrency")
    if not isinstance(concurrency, dict) or "group" not in concurrency:
        return [f"{file}: concurrency with a group is required"]
    cancel = concurrency.get("cancel-in-progress")
    if not isinstance(cancel, str) or "pull_request" not in cancel:
        return [f"{file}: cancel-in-progress must be an expression that is true only for pull "
                f"requests (a literal true would cancel a publish run), found {cancel!r}"]
    return []


def check_secrets_not_in_pr_job(workflow: dict[str, Any]) -> list[str]:
    """The `image` job runs for fork pull requests: no secrets, no registry login, no push."""
    problems = []
    for step in steps_of(workflow, "image"):
        text = str(step)
        if "secrets." in text.replace("secrets.GITHUB_TOKEN", ""):
            problems.append(f"image: step {step.get('name')!r} reads a secret")
        if str(step.get("uses", "")).startswith("docker/login-action"):
            problems.append("image: must not log in to a registry")
        if (step.get("with") or {}).get("push") in (True, "true"):
            problems.append(f"image: step {step.get('name')!r} pushes")
    if "permissions" in workflow["jobs"]["image"]:
        problems.append("image: must use the workflow's read-only permissions")
    return problems


def check_e2e_artefacts(workflow: dict[str, Any]) -> list[str]:
    step = step_named(workflow, "e2e", "Upload artefacts")
    if step is None:
        return []
    problems = []
    if "always()" not in str(step.get("if", "")):
        problems.append("e2e: Upload artefacts must run with if: always()")
    install = step_named(workflow, "e2e", "Install Playwright browser")
    if install is not None and "playwright install --with-deps chromium" not in str(install.get("run")):
        problems.append("e2e: Install Playwright browser must run playwright install --with-deps "
                        "chromium")
    return problems


def check_triggers_ci(workflow: dict[str, Any]) -> list[str]:
    on = triggers(workflow)
    problems = []
    if "pull_request" not in on:
        problems.append("ci.yml must run on pull requests")
    if (on.get("push") or {}).get("branches") != ["main"]:
        problems.append("ci.yml must run on pushes to main only")
    return problems


def check_header_date(file: str, text: str) -> list[str]:
    if not re.search(r"^#.*[Aa]ction pins re-resolved on \d{4}-\d{2}-\d{2}", text, re.M):
        return [f"{file}: the header comment must say 'Action pins re-resolved on YYYY-MM-DD' "
                f"(T-A-250)"]
    return []



DEPENDABOT = REPOSITORY / ".github" / "dependabot.yml"
# Majors Dependabot must not propose, each with its reason as a comment (T-A-256, plan 5.6).
DEPENDABOT_IGNORED = {
    "typescript": ">=6.1", "eslint": ">=11", "@playwright/test": None, "playwright-core": None,
    "@axe-core/playwright": None, "drizzle-orm": None, "drizzle-kit": None,
    # Phase B (T-B-354, plan 4.2): the majors of the three libraries on the sign-in and secrets
    # path are a reviewed upgrade, not a weekly group pull request.
    "@azure/msal-node": ">=8", "jose": ">=7", "@peculiar/x509": ">=3",
}


def check_codeql_triggers(workflow: dict[str, Any]) -> list[str]:
    on = triggers(workflow)
    problems = []
    if "pull_request" not in on:
        problems.append("codeql.yml must run on pull requests")
    if (on.get("push") or {}).get("branches") != ["main"]:
        problems.append("codeql.yml must run on pushes to main only")
    if not on.get("schedule"):
        problems.append("codeql.yml must run weekly (schedule)")
    steps = steps_of(workflow, "analyze")
    init = next((s for s in steps if s.get("name") == "Initialize CodeQL"), {})
    languages = str((init.get("with") or {}).get("languages", ""))
    if "javascript-typescript" not in languages:
        problems.append("codeql.yml must analyze javascript-typescript")
    return problems


def check_dependabot(text: str) -> list[str]:
    """Ecosystems, schedule, grouping and the ignore rules, each ignore with a reason comment."""
    config = yaml.safe_load(text)
    problems = []
    if not isinstance(config, dict) or config.get("version") != 2:
        return ["dependabot.yml: version 2 is required"]
    updates = config.get("updates") or []
    ecosystems = {u.get("package-ecosystem") for u in updates}
    for wanted in ("npm", "docker", "github-actions"):
        if wanted not in ecosystems:
            problems.append(f"dependabot.yml: ecosystem {wanted} is missing")
    for update in updates:
        name = update.get("package-ecosystem")
        if (update.get("schedule") or {}).get("interval") != "weekly":
            problems.append(f"dependabot.yml: {name} must be updated weekly")
        if not update.get("groups"):
            problems.append(f"dependabot.yml: {name} updates must be grouped")
    npm = [u for u in updates if u.get("package-ecosystem") == "npm"]
    if npm:
        directories = set()
        for update in npm:
            directories.update(update.get("directories") or [update.get("directory")])
        for wanted in ("/", "/apps/*", "/packages/*", "/e2e"):
            if wanted not in directories:
                problems.append(f"dependabot.yml: npm must cover {wanted}")
    ignored = {}
    for update in npm:
        for rule in update.get("ignore") or []:
            ignored[rule.get("dependency-name")] = (
                rule.get("versions") or rule.get("update-types"))
    for name, versions in DEPENDABOT_IGNORED.items():
        if name not in ignored:
            problems.append(f"dependabot.yml: major updates of {name} must be ignored")
        elif versions is None and ignored[name] != ["version-update:semver-major"]:
            problems.append(f"dependabot.yml: {name} must ignore semver-major updates, found "
                            f"{ignored[name]!r}")
        elif versions is not None and ignored[name] != [versions]:
            problems.append(f"dependabot.yml: {name} must ignore {versions!r}, found "
                            f"{ignored[name]!r}")
        if name in ignored and not re.search(
                rf"^\s*#.*\S.*\n(?:\s*#.*\n)*\s*-\s*dependency-name:\s*[\"']?{re.escape(name)}"
                rf"[\"']?\s*$", text, re.M):
            problems.append(f"dependabot.yml: the ignore rule for {name} has no reason comment")
    return problems


def check_visual_baselines(workflow: dict[str, Any], text: str) -> list[str]:
    problems = []
    on = triggers(workflow)
    if set(on) != {"workflow_dispatch"}:
        problems.append(f"visual-baselines.yml: only workflow_dispatch may trigger it, found "
                        f"{sorted(on)}")
    if workflow.get("permissions") != {"contents": "read"}:
        problems.append("visual-baselines.yml: permissions must be exactly {contents: read}")
    for job_name, job in workflow.get("jobs", {}).items():
        if job.get("permissions") is not None:
            problems.append(f"visual-baselines.yml job {job_name}: no job-level permissions")
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    for forbidden in ("git push", "git commit", "git add", "gh pr", "secrets.", "contents: write",
                      "stefanzweifel", "peter-evans", "auto-commit"):
        if forbidden in code:
            problems.append(f"visual-baselines.yml: must not commit or push ({forbidden!r})")
    steps = [s for job in workflow.get("jobs", {}).values() for s in job.get("steps", [])]
    if not any("visual.spec.ts" in str(s.get("run")) and "--update-snapshots" in str(s.get("run"))
               for s in steps):
        problems.append("visual-baselines.yml: must run 'playwright test visual.spec.ts "
                        "--update-snapshots'")
    if not any(str(s.get("uses", "")).startswith("actions/upload-artifact@") for s in steps):
        problems.append("visual-baselines.yml: must upload the PNGs as an artefact")
    if not any("playwright install" in str(s.get("run")) for s in steps):
        problems.append("visual-baselines.yml: must install the pinned Playwright Chromium")
    return problems

# ---------------------------------------------------------------------------------------------
# Tests on the real workflows.
# ---------------------------------------------------------------------------------------------

class RealWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = sorted(p.name for p in WORKFLOWS.glob("*.yml"))
        cls.workflows = {name: load(name) for name in cls.files}

    def assertClean(self, problems):
        self.assertEqual(problems, [], "\n" + "\n".join(problems))

    def test_workflow_files_exist(self):
        for name in ("ci.yml", "image.yml", "agent-instructions.yml", "version-guardrails.yml"):
            self.assertIn(name, self.files)

    def test_job_and_step_names_of_appendix_c(self):
        for file in ("ci.yml", "image.yml"):
            self.assertClean(check_names(file, self.workflows[file]))

    def test_codeql_names_and_permissions(self):
        self.assertClean(check_names("codeql.yml", self.workflows["codeql.yml"]))

    def test_governance_jobs_keep_names_and_files(self):
        self.assertClean(check_governance_names(self.workflows))

    def test_every_action_is_pinned_by_sha_with_version_comment(self):
        for file in self.files:
            self.assertClean(check_pins(file, raw(file)))

    def test_header_comment_records_the_pin_date(self):
        for file in self.files:
            self.assertClean(check_header_date(file, raw(file)))

    def test_permissions_are_least_privilege(self):
        for file in self.files:
            self.assertClean(check_permissions(file, self.workflows[file]))

    def test_publish_never_runs_for_pull_requests(self):
        self.assertClean(check_publish_trigger(self.workflows["image.yml"]))

    def test_release_gate_order_and_version_tag_condition(self):
        self.assertClean(check_release_gate(self.workflows["image.yml"]))

    def test_cosign_only_for_public_repositories(self):
        self.assertClean(check_cosign(self.workflows["image.yml"]))

    def test_trivy_settings(self):
        for file in ("ci.yml", "image.yml"):
            self.assertClean(check_trivy(file, self.workflows[file]))

    def test_trivy_ignore_file_if_present_has_reasons_and_expiry(self):
        ignore = REPOSITORY / ".trivyignore"
        if ignore.exists():
            self.assertClean(check_trivy_ignore(ignore.read_text(encoding="utf-8")))

    def test_check_steps_print_remediation(self):
        for file in ("ci.yml", "image.yml"):
            self.assertClean(check_remediation(file, self.workflows[file]))

    def test_concurrency_cancels_only_superseded_pull_request_runs(self):
        for file in ("ci.yml", "image.yml"):
            self.assertClean(check_concurrency(file, self.workflows[file]))

    def test_pull_request_image_job_has_no_secrets_and_no_push(self):
        self.assertClean(check_secrets_not_in_pr_job(self.workflows["image.yml"]))

    def test_e2e_artefacts_and_browser_install(self):
        self.assertClean(check_e2e_artefacts(self.workflows["ci.yml"]))

    def test_ci_triggers(self):
        self.assertClean(check_triggers_ci(self.workflows["ci.yml"]))

    def test_codeql_triggers(self):
        self.assertClean(check_codeql_triggers(self.workflows["codeql.yml"]))

    def test_dependabot_config(self):
        self.assertClean(check_dependabot(DEPENDABOT.read_text(encoding="utf-8")))

    def test_visual_baselines_workflow(self):
        self.assertClean(check_visual_baselines(self.workflows["visual-baselines.yml"],
                                                raw("visual-baselines.yml")))

    def test_bundle_budget_script_is_wired(self):
        package = (REPOSITORY / "package.json").read_text(encoding="utf-8")
        self.assertIn('"bundle:check": "tsx scripts/bundle-budget.ts"', package)

    def test_sbom_is_cyclonedx(self):
        for job, step in trivy_steps(self.workflows["image.yml"]):
            if "SBOM" in str(step.get("name")):
                self.assertEqual((step.get("with") or {}).get("format"), "cyclonedx")


# ---------------------------------------------------------------------------------------------
# Negative fixtures: each guard must fail on purpose (baseline section 2).
# ---------------------------------------------------------------------------------------------

SHA = "0123456789abcdef0123456789abcdef01234567"


class NegativeFixtureTests(unittest.TestCase):
    """The mutated input is built from the real files, so a rename of a real step keeps the
    fixtures honest. A fixture that stops failing means its guard stopped working."""

    def image(self):
        return copy.deepcopy(load("image.yml"))

    def ci(self):
        return copy.deepcopy(load("ci.yml"))

    def test_floating_tag_fails(self):
        self.assertTrue(check_pins("x.yml", "      - uses: actions/checkout@v4\n"))
        self.assertTrue(check_pins("x.yml", "      - uses: actions/checkout@main\n"))

    def test_sha_without_version_comment_fails(self):
        self.assertTrue(check_pins("x.yml", f"      - uses: actions/checkout@{SHA}\n"))
        self.assertTrue(check_pins("x.yml", f"      - uses: actions/checkout@{SHA} # latest\n"))

    def test_short_sha_fails(self):
        self.assertTrue(check_pins("x.yml", "      - uses: actions/checkout@0123abc # v1.0.0\n"))

    def test_local_action_and_docker_reference_fail(self):
        self.assertTrue(check_pins("x.yml", "      - uses: ./local\n"))
        self.assertTrue(check_pins("x.yml", "      - uses: docker://alpine:3\n"))

    def test_correct_pin_passes(self):
        self.assertEqual(check_pins("x.yml", f"      - uses: actions/checkout@{SHA} # v7.0.1\n"), [])
        self.assertEqual(
            check_pins("x.yml", f"        uses: github/codeql-action/init@{SHA} # v4.38.3\n"), [])

    def test_renamed_job_fails(self):
        workflow = self.ci()
        workflow["jobs"]["quality-gate"] = workflow["jobs"].pop("quality")
        self.assertTrue(check_names("ci.yml", workflow))

    def test_renamed_step_fails(self):
        workflow = self.ci()
        step_named(workflow, "quality", "Lint")["name"] = "Run lint"
        self.assertTrue(check_names("ci.yml", workflow))

    def test_reordered_step_fails(self):
        workflow = self.image()
        steps = workflow["jobs"]["publish"]["steps"]
        a = index_of(workflow, "publish", "Create release tag")
        b = index_of(workflow, "publish", "Build and push")
        steps[a], steps[b] = steps[b], steps[a]
        self.assertTrue(check_names("image.yml", workflow))
        self.assertTrue(check_release_gate(workflow))

    def test_renamed_governance_job_fails(self):
        workflows = {"version-guardrails.yml": {"jobs": {"guard": {}}},
                     "agent-instructions.yml": {"jobs": {"agent-instructions-lint": {}}}}
        self.assertTrue(check_governance_names(workflows))

    def test_workflow_level_write_permission_fails(self):
        workflow = self.image()
        workflow["permissions"] = {"contents": "write"}
        self.assertTrue(check_permissions("image.yml", workflow))
        workflow["permissions"] = "write-all"
        self.assertTrue(check_permissions("image.yml", workflow))

    def test_write_scope_on_the_wrong_job_fails(self):
        workflow = self.image()
        workflow["jobs"]["image"]["permissions"] = {"packages": "write"}
        self.assertTrue(check_permissions("image.yml", workflow))

    def test_missing_write_scope_on_publish_fails(self):
        workflow = self.image()
        del workflow["jobs"]["publish"]["permissions"]["id-token"]
        self.assertTrue(check_permissions("image.yml", workflow))

    def test_pull_request_condition_on_publish_fails(self):
        workflow = self.image()
        workflow["jobs"]["publish"]["if"] = "github.event_name == 'pull_request'"
        self.assertTrue(check_publish_trigger(workflow))
        del workflow["jobs"]["publish"]["if"]
        self.assertTrue(check_publish_trigger(workflow))

    def test_version_tag_without_gate_fails(self):
        workflow = self.image()
        meta = step_named(workflow, "publish", "Docker metadata")
        meta["with"]["tags"] = meta["with"]["tags"].replace(
            ",enable=${{ steps.release_tag.outputs.created == 'true' }}", "")
        self.assertTrue(check_release_gate(workflow))

    def test_version_tag_enabled_for_existing_tag_fails(self):
        workflow = self.image()
        meta = step_named(workflow, "publish", "Docker metadata")
        meta["with"]["tags"] = meta["with"]["tags"].replace(
            "steps.release_tag.outputs.created == 'true'",
            "steps.release_tag.outputs.created == 'true' || steps.decide_tag.outputs.exists == 'true'")
        self.assertTrue(check_release_gate(workflow))

    def test_tag_creation_after_build_fails(self):
        workflow = self.image()
        steps = workflow["jobs"]["publish"]["steps"]
        step = steps.pop(index_of(workflow, "publish", "Create release tag"))
        steps.append(step)
        self.assertTrue(check_release_gate(workflow))

    def test_forced_tag_write_fails(self):
        workflow = self.image()
        create = step_named(workflow, "publish", "Create release tag")
        create["run"] += "\ngh api -X PATCH repos/x/git/refs/tags/v1 -f force=true\n"
        self.assertTrue(check_release_gate(workflow))

    def test_unconditional_tag_creation_fails(self):
        workflow = self.image()
        del step_named(workflow, "publish", "Create release tag")["if"]
        self.assertTrue(check_release_gate(workflow))

    def test_build_tags_not_from_metadata_fail(self):
        workflow = self.image()
        step_named(workflow, "publish", "Build and push")["with"]["tags"] = "ghcr.io/x/y:v1.0.0"
        self.assertTrue(check_release_gate(workflow))

    def test_unconditional_cosign_fails(self):
        workflow = self.image()
        del step_named(workflow, "publish", "Sign image (public repositories)")["if"]
        self.assertTrue(check_cosign(workflow))

    def test_trivy_without_ignore_unfixed_fails(self):
        workflow = self.image()
        for _, step in trivy_steps(workflow):
            if step["name"] == "Trivy image scan":
                step["with"]["ignore-unfixed"] = False
        self.assertTrue(check_trivy("image.yml", workflow))

    def test_trivy_wrong_severity_fails(self):
        workflow = self.image()
        for _, step in trivy_steps(workflow):
            if step["name"] == "Trivy image scan":
                step["with"]["severity"] = "CRITICAL"
        self.assertTrue(check_trivy("image.yml", workflow))

    def test_trivy_that_never_fails_the_job_fails(self):
        workflow = self.image()
        for _, step in trivy_steps(workflow):
            if step["name"] == "Trivy image scan":
                step["with"]["exit-code"] = "0"
        self.assertTrue(check_trivy("image.yml", workflow))

    def test_ignore_entry_without_expiry_fails(self):
        self.assertTrue(check_trivy_ignore("# accepted until fixed upstream\nCVE-2024-0001\n"))

    def test_ignore_entry_without_reason_fails(self):
        self.assertTrue(check_trivy_ignore("CVE-2024-0001 exp:2999-01-01\n"))

    def test_ignore_entry_with_expired_date_or_bad_date_fails(self):
        today = datetime.date(2026, 10, 11)
        self.assertTrue(check_trivy_ignore("# reason given here\nCVE-1 exp:2026-01-01\n", today))
        self.assertTrue(check_trivy_ignore("# reason given here\nCVE-1 exp:2026-13-45\n", today))

    def test_complete_ignore_entry_passes(self):
        today = datetime.date(2026, 10, 11)
        text = "# no fix upstream, not reachable\nCVE-2024-0001 exp:2027-01-01\n"
        self.assertEqual(check_trivy_ignore(text, today), [])

    def test_step_without_remediation_fails(self):
        workflow = self.ci()
        step_named(workflow, "quality", "Lint")["run"] = "pnpm lint"
        self.assertTrue(check_remediation("ci.yml", workflow))

    def test_action_step_without_hint_step_fails(self):
        workflow = self.image()
        steps = workflow["jobs"]["image"]["steps"]
        position = index_of(workflow, "image", "Trivy image scan")
        del steps[position + 1]
        self.assertTrue(check_remediation("image.yml", workflow))

    def test_hint_step_not_tied_to_the_outcome_fails(self):
        workflow = self.image()
        steps = workflow["jobs"]["image"]["steps"]
        position = index_of(workflow, "image", "Trivy image scan")
        steps[position + 1]["if"] = "always()"
        self.assertTrue(check_remediation("image.yml", workflow))

    def test_literal_cancel_in_progress_fails(self):
        workflow = self.image()
        workflow["concurrency"]["cancel-in-progress"] = True
        self.assertTrue(check_concurrency("image.yml", workflow))
        del workflow["concurrency"]
        self.assertTrue(check_concurrency("image.yml", workflow))

    def test_registry_login_in_pull_request_job_fails(self):
        workflow = self.image()
        workflow["jobs"]["image"]["steps"].append(
            {"name": "Log in", "uses": f"docker/login-action@{SHA}"})
        self.assertTrue(check_secrets_not_in_pr_job(workflow))

    def test_artefact_upload_without_always_fails(self):
        workflow = self.ci()
        step_named(workflow, "e2e", "Upload artefacts")["if"] = "failure()"
        self.assertTrue(check_e2e_artefacts(workflow))

    def test_missing_pin_date_header_fails(self):
        self.assertTrue(check_header_date("x.yml", "name: x\n"))


    def test_codeql_without_schedule_fails(self):
        workflow = copy.deepcopy(load("codeql.yml"))
        del workflow[True]["schedule"]
        self.assertTrue(check_codeql_triggers(workflow))

    def test_codeql_write_on_workflow_level_fails(self):
        workflow = copy.deepcopy(load("codeql.yml"))
        workflow["permissions"] = {"contents": "read", "security-events": "write"}
        self.assertTrue(check_permissions("codeql.yml", workflow))

    def test_dependabot_without_docker_fails(self):
        text = DEPENDABOT.read_text(encoding="utf-8").replace("package-ecosystem: docker",
                                                              "package-ecosystem: pip")
        self.assertTrue(check_dependabot(text))

    def test_dependabot_ignore_without_reason_fails(self):
        text = re.sub(r"^\s*#.*\n", "", DEPENDABOT.read_text(encoding="utf-8"), flags=re.M)
        self.assertTrue(check_dependabot(text))

    def test_dependabot_without_typescript_ignore_fails(self):
        text = DEPENDABOT.read_text(encoding="utf-8").replace("dependency-name: typescript",
                                                              "dependency-name: tsx")
        self.assertTrue(check_dependabot(text))

    def test_dependabot_without_phase_b_majors_ignore_fails(self):
        for name in ("@azure/msal-node", "jose", "@peculiar/x509"):
            text = DEPENDABOT.read_text(encoding="utf-8").replace(
                f"dependency-name: \"{name}\"", "dependency-name: \"other\"").replace(
                f"dependency-name: {name}", "dependency-name: other")
            self.assertTrue(check_dependabot(text), name)

    def test_dependabot_wrong_phase_b_range_fails(self):
        text = DEPENDABOT.read_text(encoding="utf-8").replace('- ">=7"', '- ">=9"')
        self.assertTrue(check_dependabot(text))

    def test_dependabot_groups_the_rest_weekly(self):
        config = yaml.safe_load(DEPENDABOT.read_text(encoding="utf-8"))
        for update in config["updates"]:
            self.assertEqual(update["schedule"]["interval"], "weekly")
            self.assertTrue(update["groups"])

    def test_no_new_workflow_job_in_phase_b(self):
        jobs = {}
        for name in ("ci.yml", "image.yml", "version-guardrails.yml", "agent-instructions.yml",
                     "codeql.yml"):
            jobs[name] = set(load(name)["jobs"])
        flat = set().union(*jobs.values())
        self.assertEqual(flat, {"quality", "e2e", "image", "publish", "enforce-version-bump",
                                "agent-instructions-lint", "analyze"})

    def test_visual_baselines_with_push_trigger_fails(self):
        workflow = copy.deepcopy(load("visual-baselines.yml"))
        workflow[True]["push"] = {"branches": ["main"]}
        self.assertTrue(check_visual_baselines(workflow, raw("visual-baselines.yml")))

    def test_visual_baselines_that_commits_fails(self):
        text = raw("visual-baselines.yml") + "      - run: git commit -am baselines\n"
        self.assertTrue(check_visual_baselines(load("visual-baselines.yml"), text))

    def test_visual_baselines_write_permission_fails(self):
        workflow = copy.deepcopy(load("visual-baselines.yml"))
        workflow["permissions"] = {"contents": "write"}
        self.assertTrue(check_visual_baselines(workflow, raw("visual-baselines.yml")))


if __name__ == "__main__":
    unittest.main()
