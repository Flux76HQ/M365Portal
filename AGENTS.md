# AGENTS.md — Working conventions for AI agents

Working conventions for **any** AI coding agent operating in this repository —
Claude Code, GitHub Copilot, OpenAI Codex / ChatGPT, or anything else. This file
is **canonical**: when a client-specific file disagrees with it, this file wins.

This project adopts the Flux76 baseline in
[`project-baseline.md`](https://github.com/Flux76HQ/App-Guidance/blob/main/shared/guidelines/project-baseline.md)
(repository `Flux76HQ/App-Guidance`). That baseline is enforceable and remains
the source of truth for *what* is required; this file says how to *work* here and
records where this project makes a deliberate choice of its own.

## Client surfaces

| Client | Entry file it reads automatically | Client-specific extras |
|---|---|---|
| OpenAI Codex / ChatGPT | `AGENTS.md` (this file) | none |
| Claude Code | [`CLAUDE.md`](CLAUDE.md) | none in this repository |
| GitHub Copilot | [`.github/copilot-instructions.md`](.github/copilot-instructions.md) | none |

`CLAUDE.md` and `.github/copilot-instructions.md` are deliberately thin. Do not copy
rules from here into them: a rule stated twice drifts, and the stale copy looks as
authoritative as the current one. `agent-instructions-lint` fails the pull request
when it happens.

## About this repository

**M365Portal** is a self-hosted web panel with which an administrator manages a
Microsoft 365 tenant (users, groups, distribution lists, mail contacts) under a
panel-owned RBAC model. It ships as **one Docker image, one container**: a Node.js
22 process (Hono) that serves the API and the built React frontend. The product
brief is [`docs/build-prompt.md`](docs/build-prompt.md); the spec, plan and tasks
live under [`specs/`](specs/).

It is built in **four phases** (A foundation, B wizard + auth + RBAC foundation,
C users and groups, D distribution lists, contacts, RBAC admin UI, audit,
hardening). Phase boundaries are part of the product brief — see §1.

## 1. Before you change code

- Read this file, then the baseline linked above, then the active
  [`specs/`](specs/) folder. Work **spec-first**: change the spec, then the plan and
  tasks, then the code.
- **Stop after each phase.** Never continue into the next phase on your own
  initiative. Close a phase with the report the brief prescribes (summary, test
  results, a step list to try it yourself, open points, and the question whether
  to continue) and wait for explicit approval. Feedback is processed first.
- **Do not invent Microsoft APIs, permissions or cmdlet parameters.** Verify every
  one against Microsoft Learn. What could not be verified is listed in
  [`docs/open-points.md`](docs/open-points.md) with the date and what was tried.
- **Server-side enforcement is the only enforcement.** The UI may hide or disable
  what a user may not do; it is never the control. Every API route goes through the
  central policy layer, deny by default.
- Prefer small, tested steps. A change without a test for its failure path is not
  finished.

## 2. Versioning discipline

- The `VERSION` file (`MAJOR.MINOR.PATCH`) is the single source of truth. The
  Docker build and `/healthz` read it; `package.json` versions are not authoritative.
- Changes touching runtime, build, deploy or CI surfaces **must** bump it. The
  protected paths are defined once, in
  [`scripts/version_guard_paths.py`](scripts/version_guard_paths.py).
- Documentation-only edits (`*.md`, `*.txt`) are exempt.
- Bump idempotently with `python scripts/bump_version.py` (patch by default).

## 3. Local enforcement and CI controls

- Activate hooks once per clone: `python scripts/setup_hooks.py`
  (sets `core.hooksPath` to `.githooks/`). The pre-commit hook stays fast: version
  guard plus agent-instruction lint. Heavier gates run in CI.
- Every MUST rule needs an automated enforcement point (CI or hook). A control has
  to be findable on the pull request under the name a document cites it by; do not
  rename a job without renaming its citations.
- CI jobs on every pull request:

  | Job name | What it checks |
  |---|---|
  | `enforce-version-bump` | `VERSION` increased when a protected path changed |
  | `agent-instructions-lint` | this file stays canonical and unduplicated |
  | `quality` | lint, typecheck, unit and integration tests, translation catalogues |
  | `e2e` | Playwright end-to-end, accessibility (axe) and visual regression |
  | `image` | Docker build, container smoke test, Trivy scan, SBOM |

## 4. Secrets and configuration hygiene

- Never commit `.env` or real secrets; only `.env.example` is tracked, with
  placeholders only. Keep it complete.
- Secrets, tokens, certificates and private keys never appear in logs, error pages
  or fixtures. Tests use generated throwaway values.
- Configuration is environment variables plus the `/data` volume, nothing else.
- Rotate sensitive keys before public releases.

## 5. Documentation contract

Every change keeps these current (baseline §6): local setup and run/stop, health
endpoints, deploy/update flow, backup/restore, runtime architecture, and **the limits
that live outside the repository** — the largest request the app accepts, stated as
a number, plus the note that whatever sits in front must allow at least that much.

- UI and documentation are written in **Dutch and English** from day one. Code,
  identifiers, commit messages and code comments are English.
- A translation catalogue is checked on its *values*, not only on its key set
  (baseline §12).
- Record major decisions as ADRs under `docs/adr/`; keep rationale next to the change.

## 6. Branding

The product brand is user-defined at runtime (organisation name, logo, accent
colour); there is no fixed product palette to hardcode. Components consume design
tokens, never raw hex values. Company surfaces use the Flux76 brand from the
baseline repository.

## 7. Reuse strategy

Reuse proven patterns first, then adapt; mark reused items **reuse / adapt /
replace**. Keep dependencies few and justified in `docs/architecture.md`; the image
stays small.

## 8. Git and pull request workflow

- Develop on a feature branch; never commit directly to the integration branch.
  This repository's integration branch is not yet decided by the owner — until it
  is, work lands on the branch the session was given.
- Write clear commit messages in English, as a small reviewable series per phase.
  Agents commit; they do not open or merge a pull request unless the owner asks.
- Push with `git push -u origin <branch-name>`.
- Check a branch's pull request state before pushing follow-up work to it: a merged
  pull request cannot carry new commits.

## 9. Commit checklist

- [ ] Non-doc changes to protected paths include a `VERSION` bump.
- [ ] No secrets or `.env` files are staged.
- [ ] Operational docs are updated when relevant, in both languages.
- [ ] Tests cover the change, including its failure path.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.

---

## Deployment-file changes must be spelled out in the PR

When a change touches a **Compose file** or `.env.example`, the PR body states, in
one place, exactly what the operator has to change in their own files: the exact
variable name, its default and whether it must be added by hand; the exact Compose
mapping line; and whether an existing deployment keeps working untouched. "No
deployment-file changes in this PR" is a fine answer when true; silence is not.

A pull request that raises a size, rate or timeout limit states the new value as a
**number**, never as one proxy's setting — see
[`docs/operations.md`](docs/operations.md#limits-outside-the-repository).
