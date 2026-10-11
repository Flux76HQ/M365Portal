# ADR-0004: ESLint flat config, typed typescript-eslint, strict TypeScript (D4)

Samenvatting (NL): ESLint (flat config) met typed regels en strikt TypeScript; ESLint 10 in plaats van 9.

## Status

Adjusted

Source: plan section 6.1, row D4.

## Context

The spec assumed ESLint 9.39.x (A-28). pnpm flags that line as unsupported (SA-02) and the jsx-a11y plugin has no ESLint 10 release.

## Decision

ESLint flat config with typed typescript-eslint, `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks` and Prettier; TypeScript strict everywhere through one `tsconfig.base.json`. The adjustment: **ESLint 10.12.0** and TypeScript 6.0.3 (see the catalog in `pnpm-workspace.yaml`), with a forced peer for the unmaintained jsx-a11y plugin.

## Consequences

Revisit when jsx-a11y ships an ESLint 10 release or typescript-eslint supports TypeScript 7. `--max-warnings 0` is the gate.

## Evidence

- Plan 6.1 row D4; probe P1 to P3; spec A-28 and BC-16.
- Versions read from `pnpm-workspace.yaml` (eslint 10.12.0, typescript 6.0.3, eslint-plugin-jsx-a11y 6.10.2).
- Stream gate notes record `eslint . --max-warnings 0` and `tsc` clean on their territories (for example `G1.md`, `G5.md`).
