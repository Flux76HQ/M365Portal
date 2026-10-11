# ADR-0055: Task-level decisions TA-01 to TA-10: fragments, wildcard exports, worker entries, seams

Samenvatting (NL): Beslissingen op taakniveau (TA-01 tot TA-10): catalogusfragmenten, wildcard-subpaden, worker-entry-conventie en naden.

## Status

Plan

Source: tasks.md section 5, rows TA-01 to TA-10.

## Context

Several streams edit the repository at the same time. The analyse pass of 2026-10-10 found places where two streams would edit one file (tasks.md section 5).

## Decision

TA-01: catalogues come from per-namespace fragments (`packages/shared/src/i18n/fragments/<namespace>.{en,nl}.json`) merged by `pnpm i18n:merge` into the committed `locales/en.json` and `locales/nl.json`; the catalogue checks run on the merged files. TA-02: the FR-A-030 control is split between `shared/permissions.test.ts` and `server/docs-contract.test.ts`. TA-05: `@m365portal/shared` exposes `./branding/*` and `./schemas/*` as wildcard subpaths without barrel files; barrels exist only for `./tokens` and `./i18n`. TA-06: `.env.example` parity with the configuration is asserted in `server/deploy-files.test.ts`. TA-09 (the worker-entry convention): `apps/server/build.mjs` bundles every `src/**/*-worker.ts` as `dist/<name>.js` besides `index`, `cli` and `healthcheck`, so the image worker needs no edit of S1's file. TA-10: the two governance workflows keep their names but their checkout action is pinned by commit SHA. The seams (tasks.md section 1.3) are the only places where a stream edits another stream's file, after the owner's gate: for example `src/modules.ts` takes one line per module (X1) and a route file replacement (X2).

## Consequences

A merge conflict in `locales/*.json` is resolved by regenerating (`pnpm i18n:merge`). A new `*-worker.ts` is bundled without a build change. A barrel that two streams append to is avoided by construction.

## Evidence

- Tasks.md section 5 (TA-01 to TA-10) and section 1.3 (seams).
- `G4a.md` (fragments and merge), `G1.md` (build outputs `dist/image-worker.js`), `G2.md` (seam X1: `src/modules.ts` gained one import), `G5.md` (seam X2: route file replaced, `routes:check` exit 0).
