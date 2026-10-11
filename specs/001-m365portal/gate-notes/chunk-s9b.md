# Chunk s9b: e2e specs, part 2 (T-A-325 to T-A-329)

Status: five tasks done, one product defect open. Run of all 14 spec files, all projects, single worker, build 0.2.37 (dist rebuilt after the VERSION bump), 4.2 min: 141 passed, 18 skipped (projects that do not run a spec), 2 failed. The 2 failures are the same product defect (D-3), kept red on purpose. Lint, prettier and `tsc` of `e2e` are clean.

## Open points (product defects; apps/ code was not touched)

| # | Spec and steps | Observed | Expected | Owner |
|---|---|---|---|---|
| D-3 | `branding-xss.spec.ts` "D-3: ... is isolated in the sentence of the Reset dialog" (two RTL names). Save an Arabic or Hebrew organisation name, press "Reset to defaults". | The dialog's `[data-slot=confirm-object]` reads "Appearance of <name>" as one plain text node: no `<bdi>`, no `dir=auto`, no isolate marks (U+2066 to U+2069). The sidebar and preview mark are isolated (`<bdi>`). The same interpolation (`appearance.object`, `preview.paneLabel`, `preview.summary`) is plain text elsewhere. | E-07: an RTL name renders inside an isolating element so the surrounding UI is not reordered. | S5 (AppearanceForm / confirm dialog) |

Observations that are not defects: the dashboard's skeleton state cannot be reached in a browser (the root route loads `me` before any page renders; unit-tested in `web/dashboard.test.tsx`), so `dashboard.spec.ts` checks the skeleton primitive in the showcase and that no card is drawn while `me` is pending. Catalogue key `pwa.offline.saveDisabled` is not referenced by the app (the reason shown is `pwa.offline.title` plus `.description` in `#offline-state`).

## Harness changes (beside the Files lines)

- `playwright.config.ts`: **the `forced-colors` and `reduced-motion` projects of s9a never applied their option.** `forcedColors` and `reducedMotion` are context options, not Playwright 1.56 test options, so as `use` entries they were silently ignored (proved: the plain browser honours them, the runner did not). They are now `contextOptions`. Also `snapshotPathTemplate` so baselines are `visual.spec.ts-snapshots/<page>-<project>-chromium-linux.png`.
- New helpers: `e2e/branding-helpers.ts` (generated PNG/JPEG/SVG, Appearance fields, `restoreDefaults`, `save` that awaits the PUT), `e2e/pwa-helpers.ts` (reverse proxy in front of the preview instance that rewrites the version in `/sw.js`, the shell and `/api/v1/me`: Playwright cannot intercept the browser's own fetch of the worker script, proved with `context.route`).
- Rate limits are per client address and in memory (3 uploads per 30 s, 10 writes): branding specs restart the preview instance in `beforeEach` (fresh buckets, same DATA_DIR) and `restoreDefaults` in `afterEach`.

## Specs added (files, tests)

i18n-theme (15 across two projects), no-flash (6), forced-colors (9), reduced-motion (4), dashboard (6), pages (25), nav-gating (7), showcase (5), branding (23, incl. H-01/H-04/H-14 from `write-hostile.ts` with a local listener that must see zero connections), branding-xss (5 names x inert test + other places + RTL), branding-persistence (4), pwa (10), offline (8), visual (20 incl. 13 baselines + 4 theme proofs). 13 baselines committed (dashboard, appearance, design at desktop and mobile light/dark; ultrawide dashboard), generated with Chromium 141, `threshold: 0`, `maxDiffPixels: 0`, stable over 3 consecutive runs; the self-hosted Inter is asserted loaded and only `inter-latin-wght-normal*.woff2` fetched; version text masked. The owner reviews the baselines at the gate.

## Negative controls (dist edited, red seen, restored byte-identical to a backup; logs in scratchpad `s9b/ctl-*.log`)

| Guard | Break | Result |
|---|---|---|
| no-flash | `applyTheme` call removed from the boot script | 6 red |
| language | `n.lang` forced to `en` in the boot script | 3 red (nl cases) |
| forced colours | glass token in the forced-colours rule made translucent | red |
| reduced motion | `animation:none!important` removed | red |
| showcase gating | `showcase: true` in the server config | 5 red (showcase, nav-gating) |
| XSS | `escapeHtml` returns the text | 5 red |
| visual | `--radius-md` 6px to 7px | 3 red |
| SW API | API check removed and `/api` added to the cache-first pattern | red ("the worker answered an API request") |
| offline page | `/offline.html` renamed in the worker | red |
| SW update | `SKIP_WAITING` message type changed | red |
| persistence | spec wipes the DATA_DIR before the restart | red |
Not given a dedicated control: dashboard/pages text specs, conflict (needs a server edit), storage-blocked, reduced transparency scrim test (it has a translucent control inside the spec), 322-style counts. First attempts at two controls were wrong, not green guards: `?? true` on a value that is never undefined, and a cache pattern that could not match `/api/v1/me`; both were redone.

## Risks

- R-1 Baselines move with every visual change by any stream; a text change in the catalogue also breaks the English-string specs.
- R-2 `pwa.spec.ts` and `offline.spec.ts` stop and start the preview instance; they restore it in `afterEach` but must not run beside another run on the same `E2E_PORT`.
- R-3 Hygiene slip: I ran `pkill -f "playwright test"` twice early on; it only matched my own shell (exit 144) and no other agent's process was seen running afterwards, but I cannot prove nothing else was hit.
