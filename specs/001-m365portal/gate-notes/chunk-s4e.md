# Chunk s4e: open points, assumptions and risks (S4 finishing: D-3, T-A-331, T-A-173, T-A-174)

Status: **all four items done** (the D-3 fix, `T-A-331`, `T-A-173`, `T-A-174`). The evidence, the numbers and the frozen interfaces are in [`G4.md`](G4.md); this note lists what the owner and the next streams must know. **One target is not reached**: the mobile LCP of the default (non-preview) instance is 3.7 s (OP-1). Nothing was relaxed.

## 1. What was run

| Item | Result |
|---|---|
| Lighthouse 13.5.0, mobile and desktop, 3 runs, all 11 routes, the `preview` instance (`PREVIEW_MODE=true SHOWCASE=true`) of the production build served by `apps/server/dist` | Performance, Accessibility, Best Practices at least 99 on every first run; mobile LCP best of 3 at most 1.36 s; CLS at most 0.001; one run of 66 at 94 (`/design`, mobile) |
| The same on the default instance (`/` and `/users`) | mobile LCP 3.69 to 3.77 s, Performance 84 to 89: **not reached**; desktop 100 |
| Before the work (`/`, mobile) | Performance 76 to 80, LCP 3.50 to 3.56 s, TBT 271 to 385 ms |
| `pnpm bundle:check`, budget lowered to the new sizes | JS 246,245 to 236,359 B gzip, CSS 45,548 to 45,491 B, first load 274,588 to 268,408 B Brotli; budgets 237,500 / 45,500 / 269,000 |
| Web package: lint, typecheck, vitest | 0 problems, 0 errors, 1,152 of 1,152 (43 tests added) |
| `routes:check`, `i18n:check`, web build | green |
| Whole end-to-end suite on 0.2.39, one worker | 427 passed, 64 skipped, 7 failed: the 7 desktop and ultrawide visual baselines, one pixel column at the version mask (OP-2) |

## 2. Files

Changed or added (the orchestrator commits): `apps/web/index.html`, `vite.config.ts`, `build/plugins/{cn-tables,defer-entry,static-shell}.ts`; `src/main.tsx`, `src/boot/{static-shell,yield,stage-data,stage-react,stage-router,stage-ui}.ts`, `src/lib/{cn,cn-config,cn-tables.generated,isolate}.ts(x)`, `src/components/pages/staged.tsx`, `src/components/ui/confirm-dialog.tsx`, `src/features/branding/{AppearanceForm,LivePreview,use-unsaved-guard}.tsx`, `src/features/showcase/{Showcase,Specimen,TableSection}.tsx`, `src/routes/{design,settings.appearance}.tsx`, `src/styles/app.css`; tests `isolate`, `ui/cn-tables`, `static-shell`, `staged`, `appearance-route-loader`, `build-output`, `showcase`, `branding-form`, `branding/live-preview`; `scripts/bundle-budget.{ts,test.ts,json}`; `e2e/fixtures.ts` and `e2e/tests/{headers,pages,no-flash,branding,csp}.spec.ts`; this note and `G4.md`. No dependency was added or changed, no server file, no `VERSION`, no `tasks.md` tick.

## 3. Deviations from the Files lines (and why)

| File | Why |
|---|---|
| `scripts/bundle-budget.ts` and its test (S7), not "numbers only" | the deferred start takes the module script and the preload links out of the HTML, and the script read exactly those: without a change it would have failed with "no module script" or, worse, measured nothing. It now also reads the `m365-start` block (14 lines, 3 tests, one negative fixture). The numbers in `bundle-budget.json` are lowered as asked |
| `e2e/fixtures.ts`, `e2e/tests/{headers,pages,no-flash,branding,csp}.spec.ts` (S9) | each is a contract that moved, one assertion each: `#root` is not empty before the app starts (the static shell), the entry is named by the start block, with JavaScript off nothing is visible, the palette's combobox is looked for inside the dialog (the demo table's page-size select is a combobox that appears when the sample data arrives), `app.ready()` waits for a staged page. No assertion was weakened |
| `src/routes/settings.appearance.tsx` (S5 seam) | a `loader` that loads the shared branding code before the page renders (Performance 92 to 96 became 99 to 100) |
| `src/features/showcase/*`, `test/showcase.test.tsx` (S3) | the showcase mounts in parts and its table receives rows as a transition (Performance 85 to 90 became 94 to 99, CLS 0); five table tests wait for the rows, which now arrive one render after the table |
| `src/styles/app.css` | removed `-ms-overflow-style` and `-webkit-overflow-scrolling` from the Select viewport rule (55 B of CSS for browsers the app does not support) so the entry CSS fits its budget |
| `src/components/ui/confirm-dialog.tsx`, branding files (S3, S5) | D-3: an optional `objectContent` node, the helper, `aria-labelledby` for the preview pane |

## 4. Decisions and assumptions

| # | Decision |
|---|---|
| A-1 | The numbers are measured on the `preview` instance because every other end-to-end spec uses it and it is the only one where all routes show their page; the default instance is reported next to it, not hidden |
| A-2 | The static shell is a picture: `hidden` until its own inline script, `aria-hidden`, `inert`, no landmark and no control. The preview banner and the organisation name come from the embedded boot data, the language from `html[lang]` |
| A-3 | The application starts after two frames (timer fallback 1.5 s). The cost is a later start on slow networks; the gain is a paint that does not wait for the script (G4.md A-3) |
| A-4 | `cn` tables are compiled at build time from the sources' class names and the theme's utility names; the generated file is committed and byte-compared in a test |
| A-5 | zod's core stays in the first load: the boot data and the API answers are validated with the shared schemas; trading that safety check for 20 KB is the owner's call |
| A-6 | Tactic 7 is not applied (it would show a wrong "no access" page to an administrator in Phase B unless the shell reimplements the gating) |

## 5. Open points

See `G4.md` section 9 (OP-1 to OP-9). The ones with an owner now: **OP-1** (the mobile LCP of the default instance, plan 14.3: accept best plus 10 percent, or approve tactic 7 or a smaller entry), **OP-2** (7 baselines or a version-independent mask, S9), **OP-3** (docs and an ADR, S8), **OP-9** (`lighthouse@13.5.0` into `e2e`, `T-A-330`).

## 6. Risks

- R-1 The static shell can drift from the real shell; its text is bound to the catalogues by a build test, its pixels are not tested (I compared them by eye).
- R-2 TBT has about 100 ms of run-to-run spread; a route near 95 (`/design`, `/settings`) can fail a first run by chance.
- R-3 **Hygiene and process**: I ran `git checkout -- <path>` twice, on `test/build-output.test.ts` (a script of mine had overwritten it with another test file's text) and on `src/features/showcase/Showcase.tsx` (my own first attempt at staging); both only restored files I had changed from the last commit and I redid the edits; no other git state was touched, and I did not use `git add`, `commit` or `reset`. No `pkill`: the two servers I started (ports 18410 and 18411) were stopped by their recorded PIDs; the end-to-end runs used `E2E_PORT=18420` (and 18421).
- R-4 An earlier measurement set (`base`, `exp1`, `exp2`) ran while the server's version and the bundle's differed (the VERSION file was bumped under me), so the "Update available" toast was on screen; the LCP element is the banner either way, and the clean "before" runs are in `G4.md`.
