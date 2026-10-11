# Chunk webfix1: D-1 and D-2 from chunk-s9a (FR-A-153, E-19)

Status: both defects fixed; `responsive.spec.ts` green in all projects.

## Changes (apps/web)
- D-1 `components/data-table/DataTable.tsx` (Toolbar): search form `min-w-0 max-w-full`; the field wrapper is `w-64 min-w-0 shrink` and the input `w-full` (was fixed `w-64`); filter wrappers `w-48 max-w-full`. The toolbar already wrapped (`flex-wrap`). Buttons keep their sizes (24 px minimum), DOM and tab order unchanged. Page-size and column picker were not overflowing and are unchanged.
- D-2 `components/shell/SearchTrigger.tsx`: the trigger shrinks (`shrink`) and its 224 px minimum width now starts at `lg` (1024 px) instead of `sm` (640 px). Between 640 and 1023 px it is as wide as icon plus label (label still visible, same accessible name). Right cluster, switchers and Persona are unchanged and all stay reachable.

## Tests
- Added class-level guards (happy-dom has no layout): `test/shell.test.tsx` (search trigger shrink classes) and `test/DataTable.test.tsx` ("toolbar at 320 px"). The e2e spec is the layout proof. I did not run the new unit tests red against the old classes (the sources were edited first); the old classes (`w-64` on the input, `sm:min-w-56`) are asserted absent.

## Verification
- Rebuilt web and server dist (VERSION unchanged by me).
- `e2e/tests/responsive.spec.ts`, all projects, 1 worker, port 4173: 44 passed, 44 skipped (projects not running it), 0 failed.
- `e2e/tests/a11y.spec.ts` (all routes, light and dark projects): 126 passed, 2 skipped, 0 failed.
- Vitest shell, DataTable, showcase, nav-gating: 164 passed.

## Open points and risks
- Not run: whole e2e suite, lint/tsc/prettier on the touched files (run in the orchestrator gate).
- At 640-1023 px the search trigger no longer has the wide look; accepted per the task (collapse less important control).
