# Chunk s9a: e2e harness and specs, part 1 (T-A-320 to T-A-324)

Status: five tasks done. Full run on the current build (VERSION 0.2.35), single worker, all projects: 288 passed (6 of them are expected failures of the fixture self-test), 3 failed, 46 skipped (projects that do not run a spec), 5.7 min. The 3 failures are product defects (below), not spec problems.

## Open points (product defects found by the specs; apps/ code was not touched)

| # | Spec and steps | Observed | Expected | Owner |
|---|---|---|---|---|
| D-1 | `responsive.spec.ts` "320 CSS px, /design". Preview instance, viewport 320 by 640, open `/design`. | Page is 353 px wide. The DataTable toolbar form `role=search` "Search sample people" (class `flex items-center gap-2`) is 337 px wide and its "Search" button ends at x=353. | No horizontal scroll at 320 px on any route (FR-A-153). The search field must shrink (`min-w-0`) or the toolbar must wrap. | S3 (DataTable toolbar) or S4 (showcase) |
| D-2 | `responsive.spec.ts` "every width" and "landscape phone". Any route, viewport width 768 to 844 px (iPad portrait, iPhone landscape 844 by 390). | `document.documentElement.scrollWidth` is 845 at every width from 768 to 844 (77 px of sideways scroll at 768). The header's right cluster (`div.ms-auto.flex.shrink-0`, 340 px, ends with the Persona) ends at x=845 when the sidebar (256 px) is shown; from 860 px it fits. | No sideways scroll at any width (FR-A-153, E-19). The header cluster must be able to shrink or the sidebar must collapse earlier. | S4 (Header) |

Both fail with the offending elements in the message. They stay red until fixed; no `test.fail`/skip was used.

## Harness (T-A-320)

- `global-setup.ts` and `global-teardown.ts` start and stop the two instances; the state (pids, `DATA_DIR`s) is a JSON file in `m365portal-e2e-*` (path in `E2E_STATE_FILE`). `global-setup.ts` and `servers.ts`, `axe-waivers.ts` are extra files beside the Files line (the stop/start helper needs the server to be owned by the runner, not by Playwright's `webServer`). The old `webServer` and the exit hook of the config are gone.
- Literal ports: the repo-conventions guard allows `4173`/`4174` only in `playwright.config.ts`; it sets `E2E_PORT ??= DEFAULT_PORT` and everything else reads `E2E_PORT`.
- Browser origin is `http://localhost:<port>` (not 127.0.0.1): `PUBLIC_BASE_URL` must match and preview mode needs a loopback Host.
- `SPEC_PROJECTS` in the config maps spec files to projects (default: `desktop-light`). It already lists `visual`, `i18n-theme`, `forced-colors`, `reduced-motion` for the next chunk (T-A-325, T-A-329); that chunk adds only spec files.
- `guard.take(kind)` / `guard.allowResponse(...)` let a spec provoke or expect what the fixture otherwise fails on.
- Service worker: default is `allow` (real); `headers.spec.ts` uses `serviceWorkers: 'block'` because the runner cannot read a body or the network headers of a response a worker answered.
- CI: the `html` reporter is on when `CI` is set (the workflow uploads `e2e/playwright-report/`).
- `lighthouse` and `sharp` were NOT added to `e2e/package.json` (T-A-330 and T-A-332 add them with their first use, per the install protocol). Added: `@axe-core/playwright` 4.13.0 (catalog pin) and `@m365portal/shared` (workspace).

## Decisions and traps

- Dark: the stored theme choice is written before the first navigation and the computed background is asserted (P19). A project with `colorScheme: 'dark'` and no stored choice would also be dark through `system`, so the control sets a contradicting stored choice.
- Focus ring: the primary button's outline colour is transitioned from `currentColor`; the focus test waits for `getAnimations()` before it measures (otherwise 1.09:1 white-on-white is read mid-transition). Not a defect.
- `eval` is exempt from CSP when it runs inside a CDP `evaluate`; the CSP spec runs it from a timer callback.
- Modal dialogs hide the page behind them from the accessibility tree: assertions about the table behind the column picker use `includeHidden`.
- Radix Select needs the highlighted option to be focused before the next key; the specs wait for it.
- 200 % zoom is a 640 CSS px viewport (rem media queries do not move when a script changes the root font size).
- Target size excludes inline links, the clipped 1 by 1 px skip link while hidden, and tab panels (not pointer targets).
- The Appearance keyboard test saves and then resets the preview instance's branding (leaves it at the defaults).

## Negative controls (each seen red, then restored; logs in the scratchpad `s9a/ctl-*.log`)

| Guard | Break | Result |
|---|---|---|
| fixture guard | console.error not recorded (and 5 other kinds, by the paired test.fail tests) | self-test "detects" red |
| headers | `X-Content-Type-Options` removed from `apps/server/dist/index.js` | headers.spec red (HTML, sw.js, API, ...) |
| csp | inline `<script>` without nonce in the shell | all "zero violations" tests red |
| no-external | `<img src=https://...>` / `preconnect` / second font preload in the shell | 3 specs red |
| preview banner | preview instance without PREVIEW_MODE; anonymous with it | both directions red |
| a11y | `<button></button>` in the shell body | axe red on every route |
| a11y dark | stored theme `light` in the dark project | "dark theme paints a dark body" red |
| waivers | expired waiver in `axe-waivers.json` | a11y.spec fails at load (+ guard negatives with `expectGuardFails`) |
| routes coverage | `/audit` removed from `e2e/routes.ts` | vitest red (+ 3 negative fixtures) |
| focus indicator | `:focus-visible{outline:none}` | red |
| sticky header | `scroll-padding-block-start:0` | red (10 covered stops) |
| skip link | `tabIndex` removed from `main` | red |
| dialog | focus restore removed; trap/loop removed | red |
| sort | `aria-sort` removed | red |
| shortcuts | typing guard removed; switch ignored; `/` remapped | red |
| ultrawide | `max-w-content` none | red |
| 320 px | min-width 500 on the content | red |
| target size | buttons 12 px high | red |

## Risks

- R-1 The specs read English strings of the catalogue; a changed English text needs the spec updated (by design, a text change is a visible change).
- R-2 `/design` is walked by axe, the target-size and the focus tests; if the showcase grows, those tests grow with it (Tab stop cap 90, Shift+Tab cap 160).
- R-3 Radix Select and cmdk are timing sensitive; the specs wait on focus and `aria-activedescendant`, never on sleeps.
