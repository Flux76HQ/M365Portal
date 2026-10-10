# CLAUDE.md — Claude Code entry point

> **Read [`AGENTS.md`](AGENTS.md) first. It is canonical.**
>
> The working conventions for this repository live there and apply to every AI
> client equally. Where this file and `AGENTS.md` disagree, `AGENTS.md` wins.

This file adds only what is specific to Claude Code, and deliberately restates no
rule from `AGENTS.md`.

## Claude-specific tooling

- No Claude skills or MCP servers are installed in this repository. The spec-kit
  prompts (`/speckit-*`) live in the `Flux76HQ/App-Guidance` repository; their
  output format is followed by hand here, and the results are kept under `specs/`.
- If a skill or an MCP server is added later, the counterparts for the other clients
  move with it in the same commit, and `scripts/check_agent_instructions.py`
  confirms it.
